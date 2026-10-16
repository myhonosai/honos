BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Owner launch booking confirmation requires trusted migration owner'; END IF;
END $$;

-- A bounded confirmation, NOT a roster or booking command. The ordinary tenant
-- transaction is necessary for the existing lock-based live launch scope. SHARE
-- locks prevent evidence/relation phantoms; no row, audit, fact or retry is written.
CREATE FUNCTION hon.read_owner_launch_first_class_booking_context(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
 actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
 launch jsonb; registration record; relation record; saved_booking jsonb; current_booking record;
 relation_count integer; is_child boolean:=false; result jsonb;
 unavailable constant jsonb:='{"state":"BOOKING_UNAVAILABLE","context":null}'::jsonb;
 empty_result constant jsonb:='{"state":"NO_RECORDED_BOOKING","context":null}'::jsonb;
BEGIN
 actor:=hon.lock_owner_launch_actor(p_subject);
 IF NOT hon.principal_has_school_permission(actor,org,school,'schedule.booking.manage') THEN RAISE EXCEPTION 'BOOKING_FORBIDDEN' USING ERRCODE='42501'; END IF;
 -- Lock canonical source rows before selecting. Never use the booking command's
 -- FOR UPDATE/capacity decision or a read-only transaction that cannot lock IAM.
 LOCK TABLE hon.idempotency_records,hon.programs,hon.class_sessions,hon.class_bookings,
 hon.people,hon.student_profiles,hon.families,hon.family_members,hon.student_curriculum_enrollments,
 hon.student_registration_receipts,hon.guardian_child_registration_receipts,hon.audit_events IN SHARE MODE;
 PERFORM hon.require_owner_launch_actor(p_subject);
 launch:=hon.read_owner_launch(p_subject);
 result:=unavailable;
 <<confirmation>> BEGIN
  -- Reuse the current launch's saved program/class, then inspect immutable
  -- receipts BEFORE family permission filtering. Revocation must not hide a
  -- child receipt and accidentally substitute an adult/no-booking result.
  WITH receipts AS (
   SELECT r.id,r.student_profile_id,r.enrollment_id,r.program_id,r.class_session_id,r.receipt,false child
   FROM hon.student_registration_receipts r WHERE r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
   AND r.program_id::text=launch->'program'->>'id' AND r.class_session_id::text=launch->'classSession'->>'id'
   AND r.id=(SELECT x.id FROM hon.student_registration_receipts x WHERE x.organization_id=org AND x.school_id=school AND x.actor_principal_id=actor AND x.program_id=r.program_id AND x.class_session_id=r.class_session_id ORDER BY x.created_at DESC,x.id DESC LIMIT 1)
   UNION ALL
   SELECT r.id,r.student_profile_id,r.enrollment_id,r.program_id,r.class_session_id,r.receipt,true
   FROM hon.guardian_child_registration_receipts r WHERE r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
   AND r.program_id::text=launch->'program'->>'id' AND r.class_session_id::text=launch->'classSession'->>'id'
   AND r.id=(SELECT x.id FROM hon.guardian_child_registration_receipts x WHERE x.organization_id=org AND x.school_id=school AND x.actor_principal_id=actor AND x.program_id=r.program_id AND x.class_session_id=r.class_session_id ORDER BY x.created_at DESC,x.id DESC LIMIT 1)
  ) SELECT count(*)::integer,bool_or(child) INTO relation_count,is_child FROM receipts;
  IF is_child THEN PERFORM hon.require_owner_launch_family_actor(p_subject); END IF;
  IF relation_count=0 THEN
   -- A lost current class/program composite must not masquerade as no booking.
   IF launch->'classSession'='null'::jsonb AND (
    EXISTS(SELECT 1 FROM hon.student_registration_receipts r WHERE r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor AND r.program_id::text=launch->'program'->>'id')
    OR EXISTS(SELECT 1 FROM hon.guardian_child_registration_receipts r WHERE r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor AND r.program_id::text=launch->'program'->>'id')
   ) THEN EXIT confirmation; END IF;
   result:=empty_result; EXIT confirmation;
  END IF;
  IF relation_count<>1 THEN EXIT confirmation; END IF;
  -- Exactly one current variant. Never fall back to a prior or foreign receipt.
  SELECT r.id,r.student_profile_id,r.enrollment_id,r.program_id,r.class_session_id,r.receipt,false child INTO registration
  FROM hon.student_registration_receipts r WHERE r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
  AND r.id::text=launch->'registration'->>'registrationId';
  IF NOT FOUND THEN
   SELECT r.id,r.student_profile_id,r.enrollment_id,r.program_id,r.class_session_id,r.receipt,true child INTO registration
   FROM hon.guardian_child_registration_receipts r WHERE r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
   AND r.id::text=launch->'guardianChildRegistration'->>'registrationId';
  END IF;
  IF registration.id IS NULL OR registration.receipt->>'status' IS DISTINCT FROM 'REGISTERED_NO_BOOKING'
  OR registration.receipt->>'registrationId' IS DISTINCT FROM registration.id::text
  OR registration.receipt->>'studentProfileId' IS DISTINCT FROM registration.student_profile_id::text
  OR registration.receipt->>'enrollmentId' IS DISTINCT FROM registration.enrollment_id::text
  OR registration.receipt->>'programId' IS DISTINCT FROM registration.program_id::text
  OR registration.receipt->>'classSessionId' IS DISTINCT FROM registration.class_session_id::text THEN EXIT confirmation; END IF;
  WITH relations AS (
   SELECT sp.id student_id,p.given_name,p.family_name FROM hon.student_registration_receipts r
   JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.primary_family_id IS NULL AND sp.organization_id=org AND sp.school_id=school
   JOIN hon.people p ON p.id=sp.person_id AND p.organization_id=org AND p.school_id=school
   JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=sp.id AND e.program_id=r.program_id AND e.organization_id=org AND e.school_id=school
   WHERE NOT registration.child AND r.id=registration.id AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
   UNION ALL
   SELECT sp.id,c.given_name,c.family_name FROM hon.guardian_child_registration_receipts r
   JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.person_id=r.child_person_id AND sp.primary_family_id=r.family_id AND sp.organization_id=org AND sp.school_id=school
   JOIN hon.people c ON c.id=r.child_person_id AND c.organization_id=org AND c.school_id=school
   JOIN hon.people g ON g.id=r.guardian_person_id AND g.organization_id=org AND g.school_id=school
   JOIN hon.families f ON f.id=r.family_id AND f.organization_id=org AND f.school_id=school
   JOIN hon.family_members gm ON gm.id=r.guardian_member_id AND gm.family_id=r.family_id AND gm.person_id=r.guardian_person_id AND gm.member_role='GUARDIAN' AND gm.organization_id=org AND gm.school_id=school
   JOIN hon.family_members cm ON cm.id=r.child_member_id AND cm.family_id=r.family_id AND cm.person_id=r.child_person_id AND cm.member_role='STUDENT' AND cm.organization_id=org AND cm.school_id=school
   JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=sp.id AND e.program_id=r.program_id AND e.organization_id=org AND e.school_id=school
   WHERE registration.child AND r.id=registration.id AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
   AND r.receipt->>'familyId'=r.family_id::text AND r.receipt->>'registrationKind'='NEW_CHILD_WITH_NEW_GUARDIAN'
  ) SELECT student_id,left(btrim(regexp_replace(concat_ws(' ',given_name,family_name),'[[:cntrl:]<>]','','g')),160) display_name INTO relation
  FROM relations WHERE (SELECT count(*) FROM relations)=1;
  IF relation.student_id IS NULL OR nullif(relation.display_name,'') IS NULL THEN EXIT confirmation; END IF;
  -- The owner wrapper's completed response is the ONLY booking locator. Identical
  -- same/new-key replays collapse; different relations are unavailable. Neither
  -- a generic booking nor a prior class/student match can provide a fallback.
  SELECT count(*)::integer INTO relation_count FROM (
   SELECT DISTINCT i.response_body FROM hon.idempotency_records i
   WHERE i.organization_id=org AND i.school_id=school AND i.principal_id=actor AND i.status='COMPLETED'
   AND i.response_body->>'registrationId'=registration.id::text AND i.response_body ? 'bookingId'
  ) receipts;
  IF relation_count=0 THEN result:=empty_result; EXIT confirmation; END IF;
  IF relation_count<>1 THEN EXIT confirmation; END IF;
  SELECT DISTINCT i.response_body INTO saved_booking FROM hon.idempotency_records i
  WHERE i.organization_id=org AND i.school_id=school AND i.principal_id=actor AND i.status='COMPLETED'
  AND i.response_body->>'registrationId'=registration.id::text AND i.response_body ? 'bookingId';
  IF jsonb_typeof(saved_booking) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(saved_booking))<>6
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(saved_booking) k WHERE k NOT IN('registrationId','bookingId','classSessionId','status','bookingVersion','recordedAt'))
  OR jsonb_typeof(saved_booking->'bookingId') IS DISTINCT FROM 'string'
  OR saved_booking->>'bookingId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR jsonb_typeof(saved_booking->'bookingVersion') IS DISTINCT FROM 'number' OR saved_booking->>'bookingVersion' !~ '^[1-9][0-9]{0,8}$'
  OR jsonb_typeof(saved_booking->'recordedAt') IS DISTINCT FROM 'string'
  OR saved_booking->>'classSessionId' IS DISTINCT FROM registration.class_session_id::text
  OR saved_booking->>'status' NOT IN('BOOKED','WAITLISTED') THEN EXIT confirmation; END IF;
  SELECT b.id,b.booking_kind,b.status,b.version,b.created_at,s.id session_id,s.name,s.starts_at,s.ends_at,s.status session_status,s.capacity,s.booking_policy
  INTO current_booking FROM hon.class_bookings b
  JOIN hon.class_sessions s ON s.id=b.class_session_id AND s.organization_id=org AND s.school_id=school AND s.program_id=registration.program_id
  JOIN hon.programs p ON p.id=s.program_id AND p.organization_id=org AND p.school_id=school
  WHERE b.id::text=saved_booking->>'bookingId' AND b.organization_id=org AND b.school_id=school
  AND b.class_session_id=registration.class_session_id AND b.student_profile_id=relation.student_id AND b.booking_kind='REGULAR' AND b.source='STAFF'
  AND to_jsonb(b.version)=saved_booking->'bookingVersion' AND b.status::text=saved_booking->>'status'
  AND to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=saved_booking->>'recordedAt'
  AND (SELECT count(*) FROM hon.class_bookings x WHERE x.organization_id=org AND x.school_id=school AND x.class_session_id=s.id AND x.student_profile_id=relation.student_id)=1
  AND (SELECT count(*) FROM hon.audit_events a WHERE a.organization_id=org AND a.school_id=school AND a.entity_type='CLASS_BOOKING' AND a.entity_id=b.id AND a.action_code='schedule.booking.create')=1
  AND EXISTS(SELECT 1 FROM hon.audit_events a WHERE a.organization_id=org AND a.school_id=school AND a.entity_type='CLASS_BOOKING' AND a.entity_id=b.id AND a.action_code='schedule.booking.create' AND a.source='HUMAN_UI' AND a.result='SUCCEEDED' AND a.prior_state IS NULL AND a.action_request_id IS NULL
   AND a.next_state->>'classBookingId'=b.id::text AND a.next_state->>'classSessionId'=s.id::text AND a.next_state->>'studentProfileId'=relation.student_id::text AND a.next_state->>'bookingKind'='REGULAR');
  IF current_booking.id IS NULL OR nullif(btrim(regexp_replace(current_booking.name,'[[:cntrl:]<>]','','g')),'') IS NULL THEN EXIT confirmation; END IF;
  result:=jsonb_build_object('state','RECORDED_BOOKING','context',jsonb_build_object(
   'registrationId',registration.id,'student',jsonb_build_object('studentProfileId',relation.student_id,'displayName',relation.display_name),
   'classSession',jsonb_build_object('id',current_booking.session_id,'name',left(btrim(regexp_replace(current_booking.name,'[[:cntrl:]<>]','','g')),160),
    'startsAt',to_char(current_booking.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'endsAt',to_char(current_booking.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'status',current_booking.session_status,'capacity',current_booking.capacity,'bookingPolicy',current_booking.booking_policy),
   'booking',jsonb_build_object('id',current_booking.id,'bookingKind',current_booking.booking_kind,'status',current_booking.status,'version',current_booking.version,
    'recordedAt',to_char(current_booking.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
 END confirmation;
 -- Recheck clock-time expiry even on no-recorded/unavailable branches after locks.
 PERFORM hon.require_owner_launch_actor(p_subject);
 IF is_child THEN PERFORM hon.require_owner_launch_family_actor(p_subject); END IF;
 IF NOT hon.principal_has_school_permission(actor,org,school,'schedule.booking.manage') THEN RAISE EXCEPTION 'BOOKING_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN result;
END $$;
DO $$ DECLARE r text; BEGIN
 REVOKE ALL ON FUNCTION hon.read_owner_launch_first_class_booking_context(text) FROM PUBLIC;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.read_owner_launch_first_class_booking_context(text) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.read_owner_launch_first_class_booking_context(text) TO hon_runtime; END IF;
END $$;
COMMIT;
