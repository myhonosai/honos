BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'Booking lock requires trusted migration owner';
 END IF;
END $$;

-- Only the four exact session decision facts cross this lock-only boundary.
-- Runtime intentionally has no class_sessions UPDATE privilege, even for locks.
CREATE FUNCTION hon.lock_class_booking_session(p_subject text,p_session uuid)
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
   AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
   AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
   AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
   AND EXISTS(SELECT 1 FROM hon.principal_role_grants g
    JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
    JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
    WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school
     AND rp.permission_code='schedule.booking.manage' AND g.revoked_at IS NULL
     AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
     AND (r.management_school_id IS NULL OR r.management_school_id=school))
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

-- 0117 read_classpass called a FOR SHARE authorization helper, which is illegal
-- in READ ONLY transactions. Keep its exact authority checks without row locks;
-- the projection and checks share a read-only statement snapshot, with no writes.
CREATE FUNCTION hon.require_classpass_read_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
 IF p_subject IS NULL OR p_subject=''
  OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
  OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
  OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501';
 END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
 WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true) AND p.principal_type='HUMAN_USER' AND p.is_active
  AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
  AND EXISTS(SELECT 1 FROM hon.organizations WHERE id=org AND status='ACTIVE')
  AND EXISTS(SELECT 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE')
  AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=p.id)
  AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=p.id AND organization_id=org AND school_id=school
   AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()))
  AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
   JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
   WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND rp.permission_code='classpass.read'
    AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
    AND (r.management_school_id IS NULL OR r.management_school_id=school))
  AND EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND status='ACTIVE' AND tier IN('ESSENTIAL','CORE','COMPLETE')
   AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()));
 IF actor IS NULL THEN RAISE EXCEPTION 'CLASSPASS_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;

CREATE OR REPLACE FUNCTION hon.read_classpass(p_subject text,p_kind text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
 PERFORM hon.require_classpass_read_actor(p_subject);
 IF p_kind='PRODUCT' THEN
  SELECT jsonb_build_object('id',id,'programId',program_id,'name',name,'allowedUses',allowed_uses,'validityDays',validity_days,'allowedBookingPolicy',allowed_booking_policy,'status',status,'version',version) INTO result
  FROM hon.classpass_products WHERE id=p_id AND organization_id=org AND school_id=school;
 ELSIF p_kind='PASS' THEN
  SELECT jsonb_build_object('id',id,'productId',product_id,'studentProfileId',student_profile_id,'programId',program_id,'issuanceKind',issuance_kind,'productVersion',product_version,'productName',product_name,
   'allowedUses',allowed_uses,'remainingUses',remaining_uses,'validityDays',validity_days,'allowedBookingPolicy',allowed_booking_policy,'programVersion',program_version,'programName',program_name,
   'minimumAgeMonths',minimum_age_months,'maximumAgeMonths',maximum_age_months,'issuedAt',issued_at,'expiresAt',expires_at,'status',status,'version',version,'expired',expires_at<=clock_timestamp(),
   'ledger',coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'kind',l.kind,'useDelta',l.use_delta,'classBookingId',l.class_booking_id,'reversesLedgerId',l.reverses_ledger_id,'passVersion',l.pass_version,'recordedAt',l.recorded_at) ORDER BY l.pass_version)
    FROM hon.classpass_ledger l WHERE l.pass_id=p.id AND l.organization_id=org AND l.school_id=school),'[]'::jsonb)) INTO result
  FROM hon.classpass_passes p WHERE id=p_id AND organization_id=org AND school_id=school;
 ELSIF p_kind='BOOKING' THEN
  SELECT jsonb_build_object('id',id,'classSessionId',class_session_id,'studentProfileId',student_profile_id,'passId',classpass_id,'bookingKind',booking_kind,'status',status,'version',version) INTO result
  FROM hon.class_bookings WHERE id=p_id AND organization_id=org AND school_id=school AND booking_kind='CLASS_PASS';
 ELSE RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF result IS NULL THEN RAISE EXCEPTION 'CLASSPASS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 RETURN result || jsonb_build_object('paymentProviderOutcome','UNAVAILABLE','attendanceOutcome','NOT_RECORDED_BY_CLASSPASS','parentProjection','UNAVAILABLE');
END $$;

REVOKE ALL ON FUNCTION hon.lock_class_booking_session(text,uuid),hon.require_classpass_read_actor(text),hon.read_classpass(text,text,uuid) FROM PUBLIC;
DO $$ DECLARE r text; a text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.lock_class_booking_session(text,uuid),hon.require_classpass_read_actor(text),hon.read_classpass(text,text,uuid) FROM %I',r);
  -- Reconcile accidental table AND column UPDATE grants, never add them.
  EXECUTE format('REVOKE UPDATE ON hon.class_sessions FROM %I',r);
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid='hon.class_sessions'::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE UPDATE (%I) ON hon.class_sessions FROM %I',a,r);
  END LOOP;
 END LOOP;
 REVOKE UPDATE ON hon.class_sessions FROM PUBLIC;
 FOR a IN SELECT attname FROM pg_attribute WHERE attrelid='hon.class_sessions'::regclass AND attnum>0 AND NOT attisdropped LOOP
  EXECUTE format('REVOKE UPDATE (%I) ON hon.class_sessions FROM PUBLIC',a);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.lock_class_booking_session(text,uuid),hon.read_classpass(text,text,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
