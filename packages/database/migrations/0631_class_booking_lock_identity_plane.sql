BEGIN;

-- 0631 Class booking lock identity-plane checks (coordinator-allocated 2026-11-22; launch-readiness review P2 "booking
-- authority and lifecycle", docs/architecture/CLASS_BOOKING_IDENTITY_PLANE.md).
-- Owner request (David, 2026-11-22): fix the review's findings before more features.
-- 0147 class-session discovery refuses HQ operators, principals with an active family access grant, users with any
-- other active principal, and principals holding a family/HQ/platform-shaped role anywhere. The 0118 booking lock
-- refused none of these, so a mixed identity that also held schedule.booking.manage could book sessions it could not
-- discover. Every caller of the lock (the staff booking API and owner-launch first booking, last replaced in 0538) gets the
-- same identity plane as discovery.
--   BL1  The user has exactly one active principal of any type (0118 counted HUMAN_USER only).
--   BL2  No HQ operator grant, no active family access grant, no active mixed-role grant; the granting role itself is
--        not family/HQ/platform shaped. Checked on both sides of the session row lock, as before.
--   BL3  Signature, return shape, definer posture, search path, lock order and ACL are unchanged.
-- Nothing here changes data, grants, sends, charges or calls an outside service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.lock_class_booking_session(text,uuid)') IS NULL OR to_regclass('hon.hq_operator_grants') IS NULL
    OR to_regclass('hon.family_access_grants') IS NULL THEN RAISE EXCEPTION '0631 requires 0118 and the identity-plane tables'; END IF;
END $$;

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

-- CREATE OR REPLACE keeps the existing ACL; restate it so a drifted grant cannot survive.
DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.lock_class_booking_session(text,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.lock_class_booking_session(text,uuid) FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.lock_class_booking_session(text,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
