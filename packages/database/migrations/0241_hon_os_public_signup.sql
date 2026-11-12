BEGIN;

-- HON OS public sign-up (B-ID-5). A verified OIDC identity creates its own owner account, organization and school,
-- REGISTERED with no access, without HQ. Owner decision OD-2: registration is decoupled from the paid-access program.
-- - Program: hon.hon_os_signup_program is CLOSED. Only the migration owner of a disposable or private test database
--   can set TEST_MODE; there is no LIVE value and no runtime write path. Opening real sign-up needs a reviewed migration.
-- - Identity: subject and verified email come only from the HON-signed OIDC session. Never merge by email.
-- - Effects: organization, entitlement COMPLETE held SUSPENDED, school, system OWNER role, the owner grant and one
--   immutable registration record (verified email, terms version, acceptance time). No access state, subscription,
--   checkout, credit allowance, AI or provider effect. The 0183 initializer stays private and unused.
-- - Concurrency: the 0191 school-account authority envelope (advisory lock + NOWAIT IAM locks) serializes every
--   account writer; one registration per identity is also enforced by unique keys.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS public sign-up requires a restricted runtime'; END IF;
END $$;

-- ---------- program (closed by default; TEST_MODE only in a test database) ----------
CREATE TABLE hon.hon_os_signup_program (
  program_id smallint PRIMARY KEY CHECK (program_id=1),
  status text NOT NULL CHECK (status IN ('CLOSED','TEST_MODE')),
  recorded_at timestamptz NOT NULL
);
INSERT INTO hon.hon_os_signup_program VALUES (1,'CLOSED',clock_timestamp());
CREATE FUNCTION hon.guard_hon_os_signup_program() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.program_id=OLD.program_id THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'SIGNUP_PROGRAM_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hon_os_signup_program FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_os_signup_program();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hon_os_signup_program FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hon_os_signup_program();

-- ---------- sign-up terms versions (immutable) ----------
-- v1 is a TEST-ONLY draft reference so the flow can be exercised; it is not legal terms. Real sign-up needs an
-- owner-approved version added by a later migration (the CHECK allows no other status today).
CREATE TABLE hon.hon_os_signup_terms_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE CHECK (version BETWEEN 1 AND 9999),
  status text NOT NULL CHECK (status='TEST_ONLY_DRAFT'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  document_digest text NOT NULL CHECK (document_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hon_os_signup_terms_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hon_os_signup_terms_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_account_evidence();
INSERT INTO hon.hon_os_signup_terms_versions(version,status,title,document_digest,recorded_at)
  VALUES (1,'TEST_ONLY_DRAFT','HON OS sign-up terms (test-only draft, not legal terms)',
    encode(sha256(convert_to('HON OS sign-up terms v1: TEST-ONLY DRAFT. Not legal terms. No payment is taken at sign-up.','UTF8')),'hex'),
    clock_timestamp());

-- ---------- registration record (immutable, one per identity, organization and school) ----------
CREATE TABLE hon.hon_os_school_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES hon.organizations(id),
  school_id uuid NOT NULL UNIQUE,
  owner_principal_id uuid NOT NULL UNIQUE REFERENCES hon.principals(id),
  owner_grant_id uuid NOT NULL UNIQUE REFERENCES hon.principal_role_grants(id),
  subject text NOT NULL UNIQUE CHECK (subject LIKE 'oidc:%' AND length(subject) <= 2048),
  verified_email text NOT NULL CHECK (verified_email=lower(btrim(verified_email)) AND length(verified_email) BETWEEN 3 AND 254),
  terms_version_id uuid NOT NULL REFERENCES hon.hon_os_signup_terms_versions(id),
  terms_accepted_at timestamptz NOT NULL,
  program_status text NOT NULL CHECK (program_status='TEST_MODE'),
  idempotency_key uuid NOT NULL,
  registered_at timestamptz NOT NULL CHECK (registered_at=terms_accepted_at),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  FOREIGN KEY (subject,idempotency_key) REFERENCES hon.school_account_requests(subject,idempotency_key)
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hon_os_school_registrations FOR EACH ROW EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hon_os_school_registrations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_account_evidence();

CREATE FUNCTION hon.hon_os_signup_open() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.hon_os_signup_program WHERE program_id=1 AND status='TEST_MODE')
$$;
CREATE FUNCTION hon.hon_os_signup_terms_json(t hon.hon_os_signup_terms_versions) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('termsVersionId',t.id,'version',t.version,'status',t.status,'title',t.title,
    'documentDigest',t.document_digest) END
$$;
-- The registration as the owner sees it. Lifecycle is REGISTERED until the trial runtime (D11-B) adds TRIAL states.
CREATE FUNCTION hon.hon_os_registration_json(r hon.hon_os_school_registrations) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('registrationId',r.id,'organizationId',r.organization_id,'schoolId',r.school_id,
    'schoolName',s.name,'timezone',s.timezone,'registeredAt',hon.saas_ts(r.registered_at),'lifecycle','REGISTERED',
    'accessGranted',false,'billingActivated',false,'aiCreditsGranted',false)
  FROM hon.schools s WHERE s.id=r.school_id
$$;
-- A name the owner typed: trimmed, 1-120 characters, no control characters.
CREATE FUNCTION hon.hon_os_signup_name_valid(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_typeof(v)='string' AND length(v#>>'{}') BETWEEN 1 AND 120 AND btrim(v#>>'{}')=v#>>'{}'
    AND (v#>>'{}') !~ '[[:cntrl:]]', false)
$$;
-- Slug from the school name (unique per organization, and the organization is new): lowercase a-z0-9 words.
CREATE FUNCTION hon.hon_os_signup_slug(p_name text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(nullif(left(btrim(regexp_replace(lower(p_name),'[^a-z0-9]+','-','g'),'-'),48),''),'school')
$$;

-- ---------- sign-up (runtime entry point) ----------
CREATE FUNCTION hon.register_hon_os_school(p_subject text,p_verified_email text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE prior hon.school_account_requests%ROWTYPE; fp text; at timestamptz; v_user uuid; actor uuid; v_org uuid; v_school uuid;
  v_role uuid; v_grant uuid; v_terms hon.hon_os_signup_terms_versions%ROWTYPE; v_slug text; r hon.hon_os_school_registrations%ROWTYPE; result jsonb;
BEGIN
  IF p_key IS NULL OR p_subject IS NULL OR length(p_subject)>2048 OR p_subject NOT LIKE 'oidc:%' OR btrim(p_subject)<>p_subject
    OR p_verified_email IS NULL OR p_verified_email<>lower(btrim(p_verified_email)) OR length(p_verified_email) NOT BETWEEN 3 AND 254
    OR p_verified_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k)
      IS DISTINCT FROM ARRAY['confirmation','legalName','ownerName','schoolName','termsVersionId','timezone']
    OR p_input->>'confirmation' IS DISTINCT FROM 'CREATE_HON_OS_SCHOOL_ACCOUNT' OR jsonb_typeof(p_input->'confirmation')<>'string'
    OR NOT hon.hon_os_signup_name_valid(p_input->'ownerName') OR NOT hon.hon_os_signup_name_valid(p_input->'schoolName')
    OR NOT hon.hon_os_signup_name_valid(p_input->'legalName')
    OR jsonb_typeof(p_input->'timezone') IS DISTINCT FROM 'string' OR length(p_input->>'timezone')>64
    OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=p_input->>'timezone' AND name !~ '^(posix|right)/')
    OR jsonb_typeof(p_input->'termsVersionId') IS DISTINCT FROM 'string'
    OR p_input->>'termsVersionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'SIGNUP_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT hon.hon_os_signup_open() THEN RAISE EXCEPTION 'SIGNUP_CLOSED' USING ERRCODE='55000'; END IF;
  -- Every account writer (owner/staff/family invitations, ownership, sign-up) shares one envelope.
  PERFORM hon.lock_school_account_authority();
  fp:=encode(sha256(convert_to('SIGNUP:'||p_verified_email||':'||p_input::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.school_account_requests WHERE subject=p_subject AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'SIGNUP_KEY_REUSED' USING ERRCODE='23505'; END IF;
    -- A replay returns the current view of the same registration (never a different one).
    SELECT * INTO r FROM hon.hon_os_school_registrations WHERE subject=p_subject AND idempotency_key=p_key;
    IF NOT FOUND THEN RAISE EXCEPTION 'SIGNUP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    RETURN hon.hon_os_registration_json(r);
  END IF;
  IF NOT hon.hon_os_signup_open() THEN RAISE EXCEPTION 'SIGNUP_CLOSED' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM hon.hon_os_school_registrations WHERE subject=p_subject) THEN
    RAISE EXCEPTION 'SIGNUP_ALREADY_REGISTERED' USING ERRCODE='23505'; END IF;
  SELECT * INTO v_terms FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1;
  IF v_terms.id IS NULL OR v_terms.id::text<>p_input->>'termsVersionId' THEN RAISE EXCEPTION 'SIGNUP_TERMS_CHANGED' USING ERRCODE='23514'; END IF;
  at:=clock_timestamp();
  SELECT id INTO v_user FROM hon.users WHERE external_subject=p_subject;
  IF v_user IS NULL THEN
    -- Never merge by email: another identity already using this email goes to review.
    IF EXISTS (SELECT 1 FROM hon.users WHERE lower(email::text)=p_verified_email) THEN
      RAISE EXCEPTION 'SIGNUP_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
    INSERT INTO hon.users(external_subject,email,display_name,created_at,updated_at)
      VALUES (p_subject,p_verified_email,p_input->>'ownerName',at,at) RETURNING id INTO v_user;
    INSERT INTO hon.principals(principal_type,user_id,display_name) VALUES ('HUMAN_USER',v_user,p_input->>'ownerName') RETURNING id INTO actor;
  ELSE
    SELECT id INTO actor FROM hon.principals WHERE user_id=v_user AND is_active AND principal_type='HUMAN_USER';
    IF actor IS NULL OR (SELECT count(*) FROM hon.principals WHERE user_id=v_user AND is_active)<>1
      OR NOT EXISTS (SELECT 1 FROM hon.users WHERE id=v_user AND lower(email::text)=p_verified_email) THEN
      RAISE EXCEPTION 'SIGNUP_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
    -- One school per identity for now (OD-12 open): no school, HQ or family access of any kind, current or ended.
    IF EXISTS (SELECT 1 FROM hon.principal_role_grants g WHERE g.principal_id=actor AND g.revoked_at IS NULL
        AND (g.effective_until IS NULL OR g.effective_until>at))
      OR EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=actor)
      OR EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=actor AND (f.effective_until IS NULL OR f.effective_until>at)) THEN
      RAISE EXCEPTION 'SIGNUP_OWNER_NOT_ELIGIBLE' USING ERRCODE='23514'; END IF;
  END IF;
  INSERT INTO hon.organizations(legal_name,display_name,created_at,updated_at) VALUES (p_input->>'legalName',p_input->>'schoolName',at,at) RETURNING id INTO v_org;
  -- No access before a trial or a verified payment: the entitlement is held SUSPENDED.
  INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from,updated_at) VALUES (v_org,'COMPLETE','SUSPENDED',at,at);
  v_slug:=hon.hon_os_signup_slug(p_input->>'schoolName');
  INSERT INTO hon.schools(organization_id,name,slug,timezone,created_at,updated_at) VALUES (v_org,p_input->>'schoolName',v_slug,p_input->>'timezone',at,at)
    RETURNING id INTO v_school;
  -- The same OWNER role HQ provisioning and 0183 create.
  INSERT INTO hon.roles(organization_id,code,name,is_system_role) VALUES (v_org,'OWNER','School Owner',true) RETURNING id INTO v_role;
  INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT v_role,v_org,perm.code FROM hon.permissions perm;
  INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from)
    VALUES (v_org,v_school,actor,v_role,actor,at) RETURNING id INTO v_grant;
  -- The receipt is re-derived from the registration on replay, so the request row stores no copy.
  INSERT INTO hon.school_account_requests VALUES (p_subject,p_key,fp,'{}'::jsonb);
  INSERT INTO hon.hon_os_school_registrations(organization_id,school_id,owner_principal_id,owner_grant_id,subject,verified_email,terms_version_id,
      terms_accepted_at,program_status,idempotency_key,registered_at)
    VALUES (v_org,v_school,actor,v_grant,p_subject,p_verified_email,v_terms.id,at,'TEST_MODE',p_key,at) RETURNING * INTO r;
  result:=hon.hon_os_registration_json(r);
  -- Decision point after every durable write: a program closed by now aborts everything.
  IF NOT hon.hon_os_signup_open() THEN RAISE EXCEPTION 'SIGNUP_CLOSED' USING ERRCODE='55000'; END IF;
  RETURN result;
END $$;

-- ---------- read (runtime entry point) ----------
CREATE FUNCTION hon.read_hon_os_registration(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r hon.hon_os_school_registrations%ROWTYPE; t hon.hon_os_signup_terms_versions%ROWTYPE; actor uuid; eligibility text;
BEGIN
  IF p_subject IS NULL OR length(p_subject)>2048 THEN RAISE EXCEPTION 'SIGNUP_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.saas_refuse_context();
  SELECT * INTO t FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1;
  SELECT * INTO r FROM hon.hon_os_school_registrations WHERE subject=p_subject;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.is_active AND p.principal_type='HUMAN_USER'
    WHERE u.external_subject=p_subject LIMIT 1;
  eligibility:=CASE WHEN r.id IS NOT NULL THEN 'ALREADY_REGISTERED'
    WHEN p_subject NOT LIKE 'oidc:%' THEN 'VERIFIED_SIGN_IN_REQUIRED'
    WHEN actor IS NOT NULL AND (EXISTS (SELECT 1 FROM hon.principal_role_grants g WHERE g.principal_id=actor AND g.revoked_at IS NULL
        AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
      OR EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=actor)
      OR EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=actor AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp())))
      THEN 'HAS_OTHER_ACCESS'
    ELSE 'ELIGIBLE' END;
  RETURN jsonb_build_object('signupStatus',CASE WHEN hon.hon_os_signup_open() THEN 'TEST_MODE' ELSE 'CLOSED' END,
    'terms',hon.hon_os_signup_terms_json(t),'eligibility',eligibility,
    'registration',CASE WHEN r.id IS NULL THEN NULL ELSE hon.hon_os_registration_json(r) END);
END $$;

DO $$ DECLARE t text; r text; f text; c text; BEGIN
  FOREACH t IN ARRAY ARRAY['hon_os_signup_program','hon_os_signup_terms_versions','hon_os_school_registrations'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['guard_hon_os_signup_program()','hon_os_signup_open()','hon_os_signup_terms_json(hon.hon_os_signup_terms_versions)',
    'hon_os_registration_json(hon.hon_os_school_registrations)','hon_os_signup_name_valid(jsonb)','hon_os_signup_slug(text)',
    'register_hon_os_school(text,text,jsonb,uuid)','read_hon_os_registration(text)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.register_hon_os_school(text,text,jsonb,uuid),hon.read_hon_os_registration(text) TO hon_runtime;
  END IF;
END $$;
COMMIT;
