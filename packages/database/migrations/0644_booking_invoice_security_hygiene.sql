BEGIN;

-- 0644 Booking and invoice security hygiene (coordinator-allocated 2026-11-22; launch-readiness review P3 carries from the
-- P2 fixes 0630 and 0631). Owner request (David, 2026-11-22): fix the review's findings before more features.
-- This is a security fix: like 0629-0632 it may be applied before its queue turn when the independent reviewer agrees.
--   H1  Owner-launch first booking (last replaced in 0538) refused CANCELLED classes but still booked a new student into
--       a COMPLETED one, which the staff booking API refuses. It now refuses COMPLETED too, after the idempotency check,
--       so an exact retry of a booking already made still returns its stored receipt.
--   H2  The canonical booking lock (0631) accepted schedule.booking.manage from any role_permissions row. It now also
--       requires the permission to be staff assignable, the same rule 0147 class discovery applies.
--   H3  The 0630 invoice INSERT guard trusted any superuser or BYPASSRLS writer. Supabase's service_role has BYPASSRLS,
--       so a service-key client could insert an invoice already PAID. The guard now names the platform API roles and the
--       HON runtime/worker roles as never trusted, whatever their attributes; the migration owner and functions it owns
--       are unchanged.
--   Signatures, return shapes, definer posture, search paths, lock order and ACLs are unchanged (ACLs restated).
-- Nothing here changes data, grants, sends, charges or calls an outside service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.book_owner_launch_first_class(text,jsonb,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.lock_class_booking_session(text,uuid)') IS NULL
    OR to_regprocedure('hon.guard_invoice_insert_status()') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='hon.permissions'::regclass AND attname='is_staff_assignable' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0644 requires 0538, 0630 and 0631'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='schedule.booking.manage' AND is_staff_assignable) THEN
    RAISE EXCEPTION '0644 expects schedule.booking.manage to be staff assignable (0059)'; END IF;
END $$;

-- H1
CREATE OR REPLACE FUNCTION hon.book_owner_launch_first_class(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
 actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
 registration uuid; class_version integer; class_program uuid; class_status text; expected_class_version integer; expected_receipt_version integer;
 receipt record; locked record; prior record; existing hon.class_bookings%ROWTYPE; booking hon.class_bookings%ROWTYPE;
 seats integer; decision hon.class_booking_status; fp bytea; key_digest bytea; result jsonb; payload jsonb;
BEGIN
 actor:=hon.lock_owner_launch_actor(p_subject);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
 OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('registrationId','expectedReceiptVersion','expectedClassSessionVersion'))
 OR jsonb_typeof(p_input->'registrationId') IS DISTINCT FROM 'string'
 OR (p_input->>'registrationId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR jsonb_typeof(p_input->'expectedReceiptVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedReceiptVersion' !~ '^[1-9][0-9]{0,8}$'
 OR jsonb_typeof(p_input->'expectedClassSessionVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedClassSessionVersion' !~ '^[1-9][0-9]{0,8}$' THEN
  RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
 END IF;
 registration:=(p_input->>'registrationId')::uuid;
 expected_receipt_version:=(p_input->>'expectedReceiptVersion')::integer;
 expected_class_version:=(p_input->>'expectedClassSessionVersion')::integer;
 -- Existing registration receipts are immutable; version 1 is the only valid
 -- receipt version. Keep this explicit expected version so an eventual receipt
 -- evolution cannot be silently accepted by this command.
 IF expected_receipt_version<>1 THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_STALE' USING ERRCODE='40001'; END IF;

 -- The receipt is the sole selector and must be owned by this current live actor.
 -- Both receipt variants are checked independently, then linked back to current
 -- same-school profile, program-only enrollment and exact class/program context.
 SELECT r.id AS registration_id,r.student_profile_id,r.program_id,r.class_session_id
 INTO receipt
 FROM hon.student_registration_receipts r
 JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.organization_id=r.organization_id AND sp.school_id=r.school_id
 JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=r.student_profile_id AND e.program_id=r.program_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
 WHERE r.id=registration AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
  AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
 FOR SHARE OF r,sp,e;
 IF NOT FOUND THEN
 SELECT r.id AS registration_id,r.student_profile_id,r.program_id,r.class_session_id
 INTO receipt
 FROM hon.guardian_child_registration_receipts r
 JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.organization_id=r.organization_id AND sp.school_id=r.school_id
 JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=r.student_profile_id AND e.program_id=r.program_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
  WHERE r.id=registration AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
   AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
  FOR SHARE OF r,sp,e;
 END IF;
 IF receipt.registration_id IS NULL THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;

 -- Reuse the canonical human booking lock. It independently rechecks exact
 -- schedule.booking.manage/tier/direct-human authority and serializes every
 -- capacity decision on this same class session; UI or receipt IDs are never
 -- substitutes for that authority.
 SELECT * INTO locked FROM hon.lock_class_booking_session(p_subject,receipt.class_session_id);
 IF locked.id IS NULL THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 SELECT s.version,s.program_id,s.status INTO class_version,class_program,class_status
 FROM hon.class_sessions s WHERE s.id=receipt.class_session_id AND s.organization_id=org AND s.school_id=school;
 IF class_version IS NULL OR class_program<>receipt.program_id THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 IF class_version<>expected_class_version THEN RAISE EXCEPTION 'OWNER_LAUNCH_CLASS_STALE' USING ERRCODE='40001'; END IF;
 IF class_status='CANCELLED' THEN RAISE EXCEPTION 'OWNER_LAUNCH_BOOKING_UNAVAILABLE' USING ERRCODE='22023'; END IF;

 fp:=sha256(convert_to(p_input::text,'UTF8')); key_digest:=sha256(convert_to(p_key,'UTF8'));
 INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
 VALUES(org,school,actor,p_key,encode(fp,'hex'),'IN_PROGRESS',now()+interval '24 hours')
 ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING;
 SELECT request_fingerprint,status,response_body INTO prior FROM hon.idempotency_records
 WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
 IF prior.request_fingerprint IS DISTINCT FROM encode(fp,'hex') THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
 IF prior.status='COMPLETED' AND prior.response_body IS NOT NULL THEN
  PERFORM hon.require_owner_launch_actor(p_subject);
  RETURN prior.response_body || jsonb_build_object('replayed',true);
 END IF;
 IF prior.status<>'IN_PROGRESS' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='23505'; END IF;
 -- 0644 H1: a finished class takes no new booking (staff API parity); the exact stored replay above still answers.
 IF class_status='COMPLETED' THEN RAISE EXCEPTION 'OWNER_LAUNCH_BOOKING_UNAVAILABLE' USING ERRCODE='22023'; END IF;

 SELECT * INTO existing FROM hon.class_bookings
 WHERE organization_id=org AND school_id=school AND class_session_id=receipt.class_session_id AND student_profile_id=receipt.student_profile_id FOR SHARE;
 IF existing.id IS NOT NULL THEN
  IF existing.booking_kind<>'REGULAR' OR existing.status NOT IN('BOOKED','WAITLISTED') THEN RAISE EXCEPTION 'OWNER_LAUNCH_BOOKING_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  booking:=existing;
 ELSE
  seats:=hon.walkin_session_taken(receipt.class_session_id); -- 0538: bookings plus kiosk trial visitors
  decision:=CASE WHEN locked.booking_policy='WALK_IN' OR seats<locked.capacity THEN 'BOOKED'::hon.class_booking_status ELSE 'WAITLISTED'::hon.class_booking_status END;
  INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source)
  VALUES(org,school,receipt.class_session_id,receipt.student_profile_id,'REGULAR',decision,'STAFF') RETURNING * INTO booking;
 END IF;

 result:=jsonb_build_object('registrationId',receipt.registration_id,'bookingId',booking.id,'classSessionId',booking.class_session_id,
  'status',booking.status::text,'bookingVersion',booking.version,
  'recordedAt',to_char(booking.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 payload:=jsonb_build_object('classBookingId',booking.id,'classSessionId',booking.class_session_id,'studentProfileId',booking.student_profile_id,
  'bookingKind',booking.booking_kind,'status',booking.status::text,'source',booking.source,'sessionCapacity',locked.capacity,
  'bookingPolicy',locked.booking_policy,'activeSeatCount',seats+CASE WHEN booking.status='BOOKED' AND existing.id IS NULL THEN 1 ELSE 0 END,
  'bookedAt',booking.booked_at,'version',booking.version,'operation','CREATED');
 IF existing.id IS NULL THEN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,action_request_id,occurred_at)
  VALUES(org,school,actor,'HUMAN_UI','schedule.booking.create','CLASS_BOOKING',booking.id,NULL,payload,'SUCCEEDED',p_request,p_correlation,NULL,now());
  INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
  VALUES(gen_random_uuid(),org,school,'class.booking.created',1,'CLASS_BOOKING',booking.id,booking.version,p_correlation,p_request,payload);
 END IF;
 UPDATE hon.idempotency_records SET status='COMPLETED',response_status=CASE WHEN existing.id IS NULL THEN 201 ELSE 200 END,response_body=result
 WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 PERFORM hon.require_owner_launch_actor(p_subject);
 RETURN result || jsonb_build_object('replayed',existing.id IS NOT NULL);
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.book_owner_launch_first_class(text,jsonb,text,uuid,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.book_owner_launch_first_class(text,jsonb,text,uuid,uuid) FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.book_owner_launch_first_class(text,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

-- H2
CREATE OR REPLACE FUNCTION hon.lock_class_booking_session(p_subject text,p_session uuid)
RETURNS TABLE(id uuid,capacity integer,booking_policy text,status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid; facts record; phase integer;
BEGIN
 IF nullif(current_setting('app.hon_organization_id',true),'') IS NULL
  OR nullif(current_setting('app.hon_school_id',true),'') IS NULL
  OR p_subject IS NULL OR p_subject=''
  OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
  OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
  OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501';
 END IF;
 BEGIN
  org:=hon.current_organization_id(); school:=hon.current_school_id();
 EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'BOOKING_FORBIDDEN' USING ERRCODE='42501';
 END;
 IF org::text IS DISTINCT FROM current_setting('app.hon_organization_id',true)
  OR school::text IS DISTINCT FROM current_setting('app.hon_school_id',true) THEN
  RAISE EXCEPTION 'BOOKING_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 -- Fresh READ COMMITTED statements on both sides of the possibly blocking lock
 -- catch committed revocations as well as wall-clock grant/entitlement expiry.
 FOR phase IN 1..2 LOOP
  SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
  WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true)
   AND p.principal_type='HUMAN_USER' AND p.is_active
   -- BL1: no other active principal of any type for this user (the 0147 discovery rule).
   AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
   AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
   AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
   -- BL2: never an HQ, family/delegated, parent, student or mixed identity, exactly as 0147 discovery refuses.
   AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants hq WHERE hq.principal_id=p.id)
   AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants fa WHERE fa.principal_id=p.id
    AND fa.effective_from<=clock_timestamp() AND (fa.effective_until IS NULL OR fa.effective_until>clock_timestamp()))
   AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants mg
    JOIN hon.roles mr ON mr.id=mg.role_id AND mr.organization_id=mg.organization_id
    WHERE mg.principal_id=p.id AND mg.revoked_at IS NULL
     AND mg.effective_from<=clock_timestamp() AND (mg.effective_until IS NULL OR mg.effective_until>clock_timestamp())
     AND mr.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
   AND EXISTS(SELECT 1 FROM hon.principal_role_grants g
    JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
    JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
    -- 0644 H2: only a staff-assignable permission row confers booking authority (the 0147 discovery rule).
    JOIN hon.permissions pm ON pm.code=rp.permission_code AND pm.is_staff_assignable
    WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school
     AND rp.permission_code='schedule.booking.manage' AND g.revoked_at IS NULL
     AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
     AND (r.management_school_id IS NULL OR r.management_school_id=school)
     AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
   AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
    AND e.tier IN('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp()
    AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'BOOKING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF phase=1 THEN
   SELECT s.id,s.capacity,s.booking_policy,s.status::text INTO facts FROM hon.class_sessions s
   WHERE s.id=p_session AND s.organization_id=org AND s.school_id=school FOR UPDATE OF s;
   -- A foreign-school ID is indistinguishable from an absent session.
   IF NOT FOUND THEN RETURN; END IF;
  END IF;
 END LOOP;
 RETURN QUERY SELECT facts.id,facts.capacity,facts.booking_policy,facts.status;
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.lock_class_booking_session(text,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.lock_class_booking_session(text,uuid) FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.lock_class_booking_session(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- H3
CREATE OR REPLACE FUNCTION hon.guard_invoice_insert_status() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  -- Not SECURITY DEFINER: current_user is the role actually writing the row (a definer function's owner when one inserts).
  -- 0644: platform API roles and HON runtime/worker roles are never trusted, even with BYPASSRLS (Supabase service_role).
  -- The HON roles are written as one exact pattern so this body is byte-identical wherever it is installed.
  IF NEW.status<>'DRAFT' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('service_role','anon','authenticated','authenticator')
    AND rolname !~ '^hon_(runtime|outbox_worker|communication_worker|automation_worker)$') THEN
    RAISE EXCEPTION 'INVOICE_INSERT_STATUS_GUARD' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.guard_invoice_insert_status() FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_invoice_insert_status() FROM %I',r); END LOOP;
END $$;
COMMIT;
