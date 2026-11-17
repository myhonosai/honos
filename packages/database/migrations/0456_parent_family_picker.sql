BEGIN;

-- Parent school and family picker (0456, coordinator-allocated 2026-11-17). The owner asked (2026-11-17) that a parent linked
-- to more than one family, at two schools or as two households at one school, picks which one to view and switches without
-- signing out. Spec: docs/architecture/PARENT_FAMILY_PICKER.md.
--   F1  The choices are exactly the parent's live family scopes: 0071 hon.resolve_parent_family_scope over every school where
--       the parent has a live grant (one active HUMAN_USER principal, a live grant, an ACTIVE family, school and organization).
--       The browser only names one of them; nothing else it sends is used.
--   F2  The choice is kept per sign-in user. hon.resolve_parent_journey_scopes (0087) returns the chosen scope while it is still
--       live and the parent has more than one. With one live scope it returns that one, as before. With several and no live
--       choice it still returns two, so every parent read and command refuses exactly as today until the parent picks.
--   F3  hon.parent_class_booking_scope (0329, 0330) and hon.face_checkin_family_scope (0443) counted grants themselves; they
--       now take the one scope the resolver gives, so class booking, family messages, account bookings and face check-in
--       follow the same choice. Their other checks are unchanged, and every command still checks its scope again after its
--       locks and writes, so a switch made in another tab during a command makes that command refuse and roll back.
--   F4  Family invitations (0205) no longer refuse a parent who already has a family at another organization. A second grant
--       to the same family, staff and HQ accounts, and accounts with more than one principal are still refused.
--   F5  Choosing writes one audit event at the chosen school. No outbox event, message, charge or AI.
-- The runtime gains no table privilege: two SECURITY DEFINER entry points take only the signed-in subject and a closed body.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Parent family picker requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Parent family picker requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.resolve_parent_family_scope(text,uuid)') IS NULL OR to_regprocedure('hon.resolve_parent_journey_scopes(text)') IS NULL
    OR to_regprocedure('hon.parent_class_booking_scope(text,boolean)') IS NULL OR to_regprocedure('hon.face_checkin_family_scope(text,boolean)') IS NULL
    OR to_regprocedure('hon.school_family_acceptor_conflict(text,text,hon.school_family_access_invitations)') IS NULL THEN
    RAISE EXCEPTION 'Parent family picker requires 0071, 0087, 0205, 0330 and 0443';
  END IF;
END $$;

-- F2: the family each sign-in user last chose. One row per user; private, forced RLS, no runtime privilege.
CREATE TABLE hon.parent_family_selections (
  user_id uuid PRIMARY KEY REFERENCES hon.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id) ON DELETE CASCADE
);
ALTER TABLE hon.parent_family_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.parent_family_selections FORCE ROW LEVEL SECURITY;
COMMENT ON TABLE hon.parent_family_selections IS '0456 the family a parent chose to view when linked to more than one. Private; the live grants still decide access.';

-- F1: every live family scope of the signed-in parent, at most 20, in a stable order.
CREATE FUNCTION hon.parent_live_family_scopes(subject text)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid, access_level hon.family_access_level)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH candidate_schools AS (
    SELECT DISTINCT g.school_id
    FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    JOIN hon.family_access_grants g ON g.principal_id=p.id
    WHERE u.external_subject=subject AND length(subject) BETWEEN 1 AND 200
      AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
  )
  SELECT s.principal_id,s.organization_id,s.school_id,s.family_id,s.access_level
  FROM candidate_schools c CROSS JOIN LATERAL hon.resolve_parent_family_scope(subject,c.school_id) s
  ORDER BY s.school_id,s.family_id LIMIT 20;
$$;

-- F2: the chosen live scope when there are several, the only one when there is one, and two (ambiguous) otherwise.
CREATE OR REPLACE FUNCTION hon.resolve_parent_journey_scopes(subject text)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid, access_level hon.family_access_level)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH live AS MATERIALIZED (SELECT * FROM hon.parent_live_family_scopes(subject)),
  chosen AS MATERIALIZED (
    SELECT l.* FROM live l
    JOIN hon.users u ON u.external_subject=subject
    JOIN hon.parent_family_selections c ON c.user_id=u.id
      AND c.organization_id=l.organization_id AND c.school_id=l.school_id AND c.family_id=l.family_id)
  SELECT c.principal_id,c.organization_id,c.school_id,c.family_id,c.access_level FROM chosen c WHERE (SELECT count(*) FROM live)>1
  UNION ALL
  SELECT f.principal_id,f.organization_id,f.school_id,f.family_id,f.access_level
  FROM (SELECT l.* FROM live l ORDER BY l.school_id,l.family_id LIMIT 2) f
  WHERE (SELECT count(*) FROM live)<=1 OR NOT EXISTS (SELECT 1 FROM chosen);
$$;

-- F3: the booking and message scope takes the one resolved scope (the rest is the 0330 body).
CREATE OR REPLACE FUNCTION hon.parent_class_booking_scope(subject text, guardian boolean)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid, access_level text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; cur_school uuid; cur_family uuid; r record;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT count(*),min(x.school_id::text)::uuid,min(x.family_id::text)::uuid INTO n,cur_school,cur_family FROM hon.resolve_parent_journey_scopes(subject) x;
  IF n<>1 THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id pid,g.organization_id org,g.school_id school,g.family_id fam,g.access_level::text lvl INTO r
  FROM hon.users u
  JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
  JOIN hon.family_access_grants g ON g.principal_id=p.id
  JOIN hon.families f ON f.id=g.family_id AND f.organization_id=g.organization_id AND f.school_id=g.school_id AND f.status='ACTIVE'
  WHERE u.external_subject=subject AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
    AND g.school_id=cur_school AND g.family_id=cur_family
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
  ORDER BY CASE g.access_level WHEN 'PRIMARY_GUARDIAN' THEN 3 WHEN 'SECONDARY_GUARDIAN' THEN 2 ELSE 1 END DESC, g.effective_from DESC
  LIMIT 1;
  IF r.pid IS NULL
    OR r.pid::text IS DISTINCT FROM current_setting('app.hon_principal_id',true)
    OR r.org IS DISTINCT FROM hon.current_organization_id() OR r.school IS DISTINCT FROM hon.current_school_id()
    OR NOT EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=r.org AND o.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=r.school AND s.organization_id=r.org AND s.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=r.org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    OR (guardian AND r.lvl NOT IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN')) THEN
    RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT r.pid,r.org,r.school,r.fam,r.lvl;
END $$;


-- F3: face check-in takes the same one resolved scope (the rest is the 0443 body).
CREATE OR REPLACE FUNCTION hon.face_checkin_family_scope(p_subject text,p_guardian boolean)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid,family_id uuid,access_level text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; cur_school uuid; cur_family uuid; r record;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT count(*),min(x.school_id::text)::uuid,min(x.family_id::text)::uuid INTO n,cur_school,cur_family FROM hon.resolve_parent_journey_scopes(p_subject) x;
  IF n<>1 THEN RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id pid,g.organization_id org,g.school_id school,g.family_id fam,g.access_level::text lvl INTO r FROM hon.users u
    JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    JOIN hon.family_access_grants g ON g.principal_id=p.id
  WHERE u.external_subject=p_subject AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
    AND g.school_id=cur_school AND g.family_id=cur_family
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
  ORDER BY CASE g.access_level WHEN 'PRIMARY_GUARDIAN' THEN 3 WHEN 'SECONDARY_GUARDIAN' THEN 2 ELSE 1 END DESC,g.effective_from DESC LIMIT 1;
  IF r.pid IS NULL OR r.pid::text IS DISTINCT FROM current_setting('app.hon_principal_id',true)
    OR r.org IS DISTINCT FROM hon.current_organization_id() OR r.school IS DISTINCT FROM hon.current_school_id()
    OR NOT EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=r.org AND o.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=r.school AND s.organization_id=r.org AND s.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=r.org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    OR (p_guardian AND r.lvl NOT IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN')) THEN
    RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT r.pid,r.org,r.school,r.fam,r.lvl;
END $$;


-- F4: a parent may hold families at more than one organization; the rest of the 0205 acceptor rule is unchanged.
CREATE OR REPLACE FUNCTION hon.school_family_acceptor_conflict(p_subject text,p_verified_email text,i hon.school_family_access_invitations) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE v_user uuid; actor uuid;
BEGIN
  SELECT id INTO v_user FROM hon.users WHERE external_subject=p_subject;
  IF v_user IS NULL THEN RETURN EXISTS(SELECT 1 FROM hon.users WHERE lower(email::text)=p_verified_email); END IF;
  SELECT id INTO actor FROM hon.principals WHERE user_id=v_user AND is_active AND principal_type='HUMAN_USER';
  RETURN actor IS NULL OR actor=i.created_by
    OR (SELECT count(*) FROM hon.principals WHERE user_id=v_user AND is_active)<>1
    OR NOT EXISTS(SELECT 1 FROM hon.users WHERE id=v_user AND lower(email::text)=p_verified_email)
    OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor AND (effective_until IS NULL OR effective_until>clock_timestamp()))
    OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id=actor AND revoked_at IS NULL
      AND (effective_until IS NULL OR effective_until>clock_timestamp()))
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor
      AND (effective_until IS NULL OR effective_until>clock_timestamp())
      AND family_id=i.family_id);
END $$;

-- The picker read: the live choices with school and family names, which one is current, and whether the parent must choose.
CREATE FUNCTION hon.read_parent_family_choices(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE cur_n integer; cur_school uuid; cur_family uuid; result jsonb;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject THEN
    RAISE EXCEPTION 'PARENT_FAMILY_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT count(*),min(x.school_id::text)::uuid,min(x.family_id::text)::uuid INTO cur_n,cur_school,cur_family FROM hon.resolve_parent_journey_scopes(subject) x;
  IF cur_n<>1 THEN cur_school:=NULL; cur_family:=NULL; END IF;
  SELECT jsonb_build_object('choices',coalesce(jsonb_agg(jsonb_build_object('schoolId',l.school_id,'schoolName',s.name,'familyId',l.family_id,
      'familyName',f.display_name,'accessLevel',l.access_level::text,'current',coalesce(l.school_id=cur_school AND l.family_id=cur_family,false))
      ORDER BY s.name,s.id,f.display_name,f.id),'[]'::jsonb),'needsChoice',count(*)>1 AND cur_family IS NULL)
    INTO result
    FROM hon.parent_live_family_scopes(subject) l JOIN hon.schools s ON s.id=l.school_id AND s.organization_id=l.organization_id
    JOIN hon.families f ON f.id=l.family_id AND f.organization_id=l.organization_id AND f.school_id=l.school_id;
  RETURN result;
END $$;

-- The picker command: choose one of the live choices. Same-request replays are harmless (the same row results); a switch in
-- another tab simply wins last. The chosen scope is checked again after the write.
CREATE FUNCTION hon.select_parent_family(subject text, p jsonb, request uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_school uuid; v_family uuid; v_user uuid; s record; prior hon.parent_family_selections; nxt hon.parent_family_selections;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject OR request IS NULL
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'PARENT_FAMILY_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p IS NULL OR jsonb_typeof(p)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['familyId','schoolId']
    OR jsonb_typeof(p->'schoolId') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'familyId') IS DISTINCT FROM 'string'
    OR p->>'schoolId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p->>'familyId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  v_school:=(p->>'schoolId')::uuid; v_family:=(p->>'familyId')::uuid;
  -- One user row lock serializes two tabs of the same parent.
  SELECT u.id INTO v_user FROM hon.users u WHERE u.external_subject=subject FOR UPDATE;
  SELECT l.* INTO s FROM hon.parent_live_family_scopes(subject) l WHERE l.school_id=v_school AND l.family_id=v_family;
  IF v_user IS NULL OR s.principal_id IS NULL THEN RAISE EXCEPTION 'PARENT_FAMILY_NOT_AVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO prior FROM hon.parent_family_selections WHERE user_id=v_user FOR UPDATE;
  IF prior.user_id IS NULL THEN
    INSERT INTO hon.parent_family_selections(user_id,organization_id,school_id,family_id) VALUES(v_user,s.organization_id,v_school,v_family) RETURNING * INTO nxt;
  ELSIF prior.organization_id IS DISTINCT FROM s.organization_id OR prior.school_id IS DISTINCT FROM v_school OR prior.family_id IS DISTINCT FROM v_family THEN
    UPDATE hon.parent_family_selections SET organization_id=s.organization_id,school_id=v_school,family_id=v_family,version=version+1,selected_at=clock_timestamp()
      WHERE user_id=v_user RETURNING * INTO nxt;
  END IF;
  IF nxt.user_id IS NOT NULL THEN
    -- The audit names only the chosen family; an earlier choice may belong to another organization, so it is never named.
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
      VALUES(s.organization_id,v_school,s.principal_id,'HUMAN_UI','PARENT_FAMILY_SELECTED','FAMILY',v_family,NULL,jsonb_build_object('version',nxt.version),'SUCCEEDED',request,request);
  END IF;
  -- Authority is checked again after the lock and write: the chosen family must be the one every parent path now resolves.
  IF NOT EXISTS(SELECT 1 FROM hon.resolve_parent_journey_scopes(subject) r WHERE r.school_id=v_school AND r.family_id=v_family AND r.principal_id=s.principal_id)
    OR (SELECT count(*) FROM hon.resolve_parent_journey_scopes(subject))<>1 THEN
    RAISE EXCEPTION 'PARENT_FAMILY_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN hon.read_parent_family_choices(subject);
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.parent_live_family_scopes(text)','hon.read_parent_family_choices(text)','hon.select_parent_family(text,jsonb,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.parent_family_selections FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.parent_family_selections FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_parent_family_choices(text) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.select_parent_family(text,jsonb,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
