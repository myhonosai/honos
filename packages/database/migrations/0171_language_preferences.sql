BEGIN;

-- Interface language persistence (English, Korean, Spanish) for Codex's localization.
-- - A personal preference belongs to the verified user (hon.users, resolved from the authenticated identity
--   subject, never a browser-supplied id). It follows the user across sessions, devices, schools and
--   organizations, and only that user can change it.
-- - A school default applies to people at that school who have no personal preference. Only staff holding
--   settings.language.manage at that exact school can change it; every change is audited. Changing it never
--   touches anyone's personal preference.
-- - Effective language: personal preference > the default of the school named in the request (only when the
--   user belongs to that school) > English. A school default is never guessed for a multi-school user.
-- - Independent of appearance, timezone and currency. No AI, credits, payments or messages.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Language preferences require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'Language preferences require a restricted runtime';
  END IF;
END $$;

INSERT INTO hon.permissions(code, description, is_sensitive, is_staff_assignable)
VALUES ('settings.language.manage','Set the default interface language for new users at this school; never changes personal preferences',false,true);
INSERT INTO hon.role_permissions(role_id, organization_id, permission_code)
SELECT id, organization_id, 'settings.language.manage' FROM hon.roles WHERE is_system_role AND code = 'OWNER' ON CONFLICT DO NOTHING;

CREATE TABLE hon.user_language_preferences (
  user_id uuid PRIMARY KEY REFERENCES hon.users(id) ON DELETE RESTRICT,
  language text NOT NULL CHECK (language IN ('en','ko','es')),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (updated_at >= created_at)
);
CREATE TABLE hon.school_language_defaults (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  language text NOT NULL CHECK (language IN ('en','ko','es')),
  version integer NOT NULL CHECK (version > 0),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);
-- Idempotency receipts and append-only change history (personal and school).
CREATE TABLE hon.language_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('PERSONAL','SCHOOL_DEFAULT')),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_principal_id, idempotency_key)
);
CREATE TABLE hon.language_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('PERSONAL','SCHOOL_DEFAULT')),
  user_id uuid REFERENCES hon.users(id) ON DELETE RESTRICT,
  organization_id uuid REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  prior_language text CHECK (prior_language IN ('en','ko','es')),
  next_language text NOT NULL CHECK (next_language IN ('en','ko','es')),
  version integer NOT NULL CHECK (version > 0),
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (actor_principal_id, idempotency_key) REFERENCES hon.language_requests(actor_principal_id, idempotency_key) ON DELETE RESTRICT,
  UNIQUE (actor_principal_id, idempotency_key),
  CHECK ((scope = 'PERSONAL') = (user_id IS NOT NULL AND organization_id IS NULL AND school_id IS NULL)),
  CHECK ((scope = 'SCHOOL_DEFAULT') = (user_id IS NULL AND organization_id IS NOT NULL AND school_id IS NOT NULL))
);

CREATE FUNCTION hon.guard_language_records() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  -- Only the two current-value tables may change, and only by one version step with the same identity.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('user_language_preferences','school_language_defaults') THEN
    IF (to_jsonb(NEW) ->> 'version')::integer = (to_jsonb(OLD) ->> 'version')::integer + 1
      AND to_jsonb(NEW) ->> 'created_at' = to_jsonb(OLD) ->> 'created_at'
      AND (to_jsonb(NEW) ->> 'updated_at')::timestamptz >= (to_jsonb(OLD) ->> 'updated_at')::timestamptz
      AND to_jsonb(NEW) ->> 'user_id' IS NOT DISTINCT FROM to_jsonb(OLD) ->> 'user_id'
      AND to_jsonb(NEW) ->> 'school_id' IS NOT DISTINCT FROM to_jsonb(OLD) ->> 'school_id'
      AND to_jsonb(NEW) ->> 'organization_id' IS NOT DISTINCT FROM to_jsonb(OLD) ->> 'organization_id' THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_LANGUAGE_RECORD' USING ERRCODE = '42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['user_language_preferences','school_language_defaults','language_requests','language_audit'] LOOP
    EXECUTE format('CREATE TRIGGER language_guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_language_records()',t);
    EXECUTE format('CREATE TRIGGER language_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_language_records()',t);
  END LOOP;
END $$;

-- ---------- identity and scope ----------
-- The verified user behind an identity subject: exactly one active human principal, no tenant/action context.
CREATE FUNCTION hon.language_actor(p_subject text) RETURNS TABLE (user_id uuid, principal_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['app.hon_organization_id','app.hon_school_id','app.hon_family_id',
      'app.hon_principal_id','app.hon_principal_type','app.hon_source','app.hon_action_request_id','app.hon_delegated_by_principal_id']) setting
      WHERE nullif(current_setting(setting,true),'') IS NOT NULL)
    OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject THEN
    RAISE EXCEPTION 'LANGUAGE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT u.id, p.id FROM hon.users u JOIN hon.principals p ON p.user_id = u.id AND p.is_active AND p.principal_type = 'HUMAN_USER'
    WHERE u.external_subject = p_subject
      AND (SELECT count(*) FROM hon.principals x WHERE x.user_id = u.id AND x.is_active) = 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'LANGUAGE_FORBIDDEN' USING ERRCODE = '42501'; END IF;
END $$;

-- Whether a principal currently belongs to a school: eligible staff there, or an active family grant there.
CREATE FUNCTION hon.language_school_member(p_principal uuid, p_school uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.schools s JOIN hon.organizations o ON o.id = s.organization_id
    WHERE s.id = p_school AND s.status = 'ACTIVE' AND o.status = 'ACTIVE'
      AND (hon.staff_member_eligible(p_principal, s.organization_id, s.id)
        OR EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p_principal AND f.school_id = s.id
          AND f.organization_id = s.organization_id AND f.effective_from <= clock_timestamp()
          AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()))))
$$;

-- settings.language.manage at the exact school, through a staff (never family or platform) role.
CREATE FUNCTION hon.language_school_manager(p_principal uuid, p_school uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.schools s WHERE s.id = p_school AND hon.staff_member_eligible(p_principal, s.organization_id, s.id)
    AND EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id = r.id AND rp.organization_id = r.organization_id
      JOIN hon.permissions perm ON perm.code = rp.permission_code
      WHERE g.principal_id = p_principal AND g.organization_id = s.organization_id AND g.school_id = s.id
        AND perm.code = 'settings.language.manage' AND perm.is_staff_assignable
        AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id = s.id)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p_principal
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp())))
$$;

CREATE FUNCTION hon.language_ts(p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN p_at IS NULL THEN NULL ELSE to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
$$;

CREATE FUNCTION hon.language_preference_json(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('language', p.language, 'version', p.version, 'updatedAt', hon.language_ts(p.updated_at))
  FROM hon.user_language_preferences p WHERE p.user_id = p_user
$$;

CREATE FUNCTION hon.language_school_json(p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('schoolId', s.id, 'organizationId', s.organization_id,
    'defaultLanguage', coalesce(d.language, 'en'), 'source', CASE WHEN d.school_id IS NULL THEN 'SYSTEM_DEFAULT' ELSE 'SCHOOL' END,
    'version', coalesce(d.version, 0), 'updatedAt', hon.language_ts(d.updated_at))
  FROM hon.schools s LEFT JOIN hon.school_language_defaults d ON d.school_id = s.id WHERE s.id = p_school
$$;

-- ---------- reads ----------
CREATE FUNCTION hon.read_my_language_preference(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; pref jsonb; school jsonb;
BEGIN
  SELECT * INTO actor FROM hon.language_actor(p_subject) LIMIT 1;
  pref := hon.language_preference_json(actor.user_id);
  IF p_school IS NOT NULL THEN
    -- Naming a school the user does not belong to is refused (no other school's settings are disclosed).
    IF NOT hon.language_school_member(actor.principal_id, p_school) THEN RAISE EXCEPTION 'LANGUAGE_FORBIDDEN' USING ERRCODE = '42501'; END IF;
    school := hon.language_school_json(p_school);
  END IF;
  RETURN jsonb_build_object('preference', pref, 'schoolDefault', school,
    'effective', jsonb_build_object(
      'language', coalesce(pref->>'language', school->>'defaultLanguage', 'en'),
      'source', CASE WHEN pref IS NOT NULL THEN 'PERSONAL' WHEN school->>'source' = 'SCHOOL' THEN 'SCHOOL_DEFAULT' ELSE 'SYSTEM_DEFAULT' END),
    'supportedLanguages', jsonb_build_array('en','ko','es'));
END $$;

CREATE FUNCTION hon.read_school_language_default(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record;
BEGIN
  IF p_school IS NULL THEN RAISE EXCEPTION 'INVALID_LANGUAGE_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO actor FROM hon.language_actor(p_subject) LIMIT 1;
  IF NOT hon.language_school_member(actor.principal_id, p_school) THEN RAISE EXCEPTION 'LANGUAGE_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN hon.language_school_json(p_school) || jsonb_build_object('canManage', hon.language_school_manager(actor.principal_id, p_school),
    'supportedLanguages', jsonb_build_array('en','ko','es'));
END $$;

-- ---------- commands (idempotent, version-checked, audited) ----------
CREATE FUNCTION hon.language_input(p_input jsonb) RETURNS TABLE (language text, expected_version integer)
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) <> ARRAY['expectedVersion','language']
    OR jsonb_typeof(p_input->'language') <> 'string' OR p_input->>'language' NOT IN ('en','ko','es')
    OR jsonb_typeof(p_input->'expectedVersion') <> 'number' OR (p_input->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$' THEN
    RAISE EXCEPTION 'INVALID_LANGUAGE_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT p_input->>'language', (p_input->>'expectedVersion')::integer;
END $$;

CREATE FUNCTION hon.language_replay(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE r hon.language_requests%ROWTYPE;
BEGIN
  -- Serializes retries of one key; a different request under a used key is refused.
  PERFORM pg_advisory_xact_lock(hashtextextended('language:' || p_actor::text || ':' || p_key::text, 0));
  SELECT * INTO r FROM hon.language_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.operation <> p_operation OR r.request_fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'LANGUAGE_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  RETURN r.response_body || jsonb_build_object('replayed', true);
END $$;

CREATE FUNCTION hon.set_my_language_preference(p_subject text, p_input jsonb, p_key uuid, p_request_id uuid, p_correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; inp record; fp text; replay jsonb; cur hon.user_language_preferences%ROWTYPE; at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  IF p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL THEN RAISE EXCEPTION 'INVALID_LANGUAGE_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO inp FROM hon.language_input(p_input);
  SELECT * INTO actor FROM hon.language_actor(p_subject) LIMIT 1;
  fp := encode(sha256(convert_to('personal:' || inp.language || ':' || inp.expected_version, 'UTF8')), 'hex');
  replay := hon.language_replay(actor.principal_id, p_key, 'PERSONAL', fp);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO cur FROM hon.user_language_preferences WHERE user_id = actor.user_id FOR UPDATE;
  IF coalesce(cur.version, 0) <> inp.expected_version THEN RAISE EXCEPTION 'LANGUAGE_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF cur.user_id IS NULL THEN
    INSERT INTO hon.user_language_preferences(user_id, language, version, created_at, updated_at) VALUES (actor.user_id, inp.language, 1, at, at)
      ON CONFLICT (user_id) DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'LANGUAGE_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  ELSE
    UPDATE hon.user_language_preferences SET language = inp.language, version = version + 1, updated_at = at WHERE user_id = actor.user_id;
  END IF;
  result := jsonb_build_object('preference', hon.language_preference_json(actor.user_id), 'replayed', false);
  INSERT INTO hon.language_requests VALUES (actor.principal_id, p_key, 'PERSONAL', fp, result - 'replayed', at);
  INSERT INTO hon.language_audit(scope, user_id, actor_principal_id, idempotency_key, request_id, correlation_id, prior_language, next_language, version, occurred_at)
    VALUES ('PERSONAL', actor.user_id, actor.principal_id, p_key, p_request_id, p_correlation_id, cur.language, inp.language, coalesce(cur.version, 0) + 1, at);
  RETURN result;
END $$;

CREATE FUNCTION hon.set_school_language_default(p_subject text, p_school uuid, p_input jsonb, p_key uuid, p_request_id uuid, p_correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; inp record; fp text; replay jsonb; cur hon.school_language_defaults%ROWTYPE; v_org uuid; at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  IF p_school IS NULL OR p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL THEN RAISE EXCEPTION 'INVALID_LANGUAGE_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO inp FROM hon.language_input(p_input);
  SELECT * INTO actor FROM hon.language_actor(p_subject) LIMIT 1;
  IF NOT hon.language_school_manager(actor.principal_id, p_school) THEN RAISE EXCEPTION 'LANGUAGE_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  fp := encode(sha256(convert_to('school:' || p_school::text || ':' || inp.language || ':' || inp.expected_version, 'UTF8')), 'hex');
  replay := hon.language_replay(actor.principal_id, p_key, 'SCHOOL_DEFAULT', fp);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id = p_school FOR SHARE;
  SELECT * INTO cur FROM hon.school_language_defaults WHERE school_id = p_school FOR UPDATE;
  IF coalesce(cur.version, 0) <> inp.expected_version THEN RAISE EXCEPTION 'LANGUAGE_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF cur.school_id IS NULL THEN
    INSERT INTO hon.school_language_defaults(school_id, organization_id, language, version, updated_by_principal_id, created_at, updated_at)
      VALUES (p_school, v_org, inp.language, 1, actor.principal_id, at, at) ON CONFLICT (school_id) DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'LANGUAGE_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  ELSE
    UPDATE hon.school_language_defaults SET language = inp.language, version = version + 1, updated_by_principal_id = actor.principal_id, updated_at = at
      WHERE school_id = p_school;
  END IF;
  -- Re-check authority after the waits (a revoked grant during a blocked transaction is refused).
  IF NOT hon.language_school_manager(actor.principal_id, p_school) THEN RAISE EXCEPTION 'LANGUAGE_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  result := jsonb_build_object('schoolDefault', hon.language_school_json(p_school), 'replayed', false);
  INSERT INTO hon.language_requests VALUES (actor.principal_id, p_key, 'SCHOOL_DEFAULT', fp, result - 'replayed', at);
  INSERT INTO hon.language_audit(scope, organization_id, school_id, actor_principal_id, idempotency_key, request_id, correlation_id, prior_language, next_language, version, occurred_at)
    VALUES ('SCHOOL_DEFAULT', v_org, p_school, actor.principal_id, p_key, p_request_id, p_correlation_id, cur.language, inp.language, coalesce(cur.version, 0) + 1, at);
  RETURN result;
END $$;

-- ---------- ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['user_language_preferences','school_language_defaults','language_requests','language_audit'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname IN ('guard_language_records',
      'language_actor','language_school_member','language_school_manager','language_ts','language_preference_json','language_school_json',
      'read_my_language_preference','read_school_language_default','language_input','language_replay','set_my_language_preference',
      'set_school_language_default') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_my_language_preference(text,uuid), hon.set_my_language_preference(text,jsonb,uuid,uuid,uuid),
      hon.read_school_language_default(text,uuid), hon.set_school_language_default(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
