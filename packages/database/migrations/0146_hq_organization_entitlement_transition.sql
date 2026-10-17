BEGIN;

-- Non-commercial current-row transition only. No Essential conversion or effect.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ entitlement transition requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')) THEN
    RAISE EXCEPTION 'HQ entitlement transition requires a restricted runtime';
  END IF;
END $$;
ALTER TABLE hon.organization_entitlements ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

-- Global HQ evidence is separate from school-visible audit and deliverable outbox.
CREATE TABLE hon.hq_entitlement_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (actor_principal_id,idempotency_key),
  CHECK ((status = 'IN_PROGRESS' AND response_body IS NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND response_body IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE TABLE hon.hq_entitlement_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL, request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  action_code text NOT NULL CHECK (action_code = 'hq.entitlement.transition'),
  prior_state jsonb NOT NULL, next_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (actor_principal_id,idempotency_key) REFERENCES hon.hq_entitlement_requests(actor_principal_id,idempotency_key) ON DELETE RESTRICT,
  UNIQUE (actor_principal_id,idempotency_key)
);
CREATE TABLE hon.hq_entitlement_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id uuid NOT NULL UNIQUE REFERENCES hon.hq_entitlement_audit(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type = 'hq.organization.entitlement.changed'),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  payload jsonb NOT NULL, occurred_at timestamptz NOT NULL
);
CREATE FUNCTION hon.guard_hq_entitlement_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_TABLE_NAME = 'hq_entitlement_requests' AND TG_OP = 'UPDATE' THEN
    IF OLD.status = 'IN_PROGRESS' AND NEW.status = 'COMPLETED'
    AND NEW.response_body IS NOT NULL AND NEW.completed_at IS NOT NULL
    AND (to_jsonb(NEW) - ARRAY['status','response_body','completed_at']) = (to_jsonb(OLD) - ARRAY['status','response_body','completed_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_HQ_ENTITLEMENT_EVIDENCE' USING ERRCODE = '42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_entitlement_requests','hq_entitlement_audit','hq_entitlement_outbox'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE TRIGGER hq_entitlement_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_entitlement_evidence()',t);
    EXECUTE format('CREATE TRIGGER hq_entitlement_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_entitlement_evidence()',t);
  END LOOP;
END $$;

-- Private helper: external subject is verified by the API, never an actor UUID.
-- HQ onboarding may also grant a school role to this same human; that does not
-- authorize this command. No tenant, family, delegated or action context is accepted.
CREATE FUNCTION hon.require_hq_entitlement_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['app.hon_organization_id','app.hon_school_id','app.hon_family_id',
      'app.hon_principal_id','app.hon_principal_type','app.hon_source','app.hon_action_request_id','app.hon_delegated_by_principal_id']) setting
      WHERE nullif(current_setting(setting,true),'') IS NOT NULL) THEN
    RAISE EXCEPTION 'HQ_ENTITLEMENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND p.is_active AND p.principal_type = 'HUMAN_USER'
    AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p.id
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (g.hq_role = 'HON_HQ_OWNER' OR (g.hq_role = 'HON_HQ_OPERATOR' AND 'hq.entitlement.manage' = ANY(g.permission_codes))))
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'HQ_ENTITLEMENT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.transition_organization_entitlement_from_hq(
  p_subject text, p_organization_id uuid, p_target text, p_expected_version integer,
  p_key uuid, p_fingerprint text, p_request_id uuid, p_correlation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; prior hon.organization_entitlements%ROWTYPE;
  receipt hon.hq_entitlement_requests%ROWTYPE; result jsonb; prior_fact jsonb; next_fact jsonb;
  effective timestamptz; audit_id uuid; fingerprint text;
BEGIN
  IF p_organization_id IS NULL OR p_target IS NULL OR p_target NOT IN ('CORE','COMPLETE')
    OR p_expected_version IS NULL OR p_expected_version NOT BETWEEN 1 AND 2147483646
    OR p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_HQ_ENTITLEMENT_INPUT' USING ERRCODE = '22023';
  END IF;
  fingerprint := encode(sha256(convert_to('hq.entitlement.transition:' || p_organization_id::text || ':' || p_target || ':' || p_expected_version::text,'UTF8')),'hex');
  IF p_fingerprint IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'INVALID_HQ_ENTITLEMENT_FINGERPRINT' USING ERRCODE = '22023'; END IF;
  actor := hon.require_hq_entitlement_actor(p_subject);
  -- Protect grant/identity/family phantoms and revocation through commit. Clock
  -- rechecks after all waits also reject expiry during a blocked transaction.
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_hq_entitlement_actor(p_subject);
  IF NOT pg_try_advisory_xact_lock(hashtextextended(actor::text || ':' || p_key::text,0)) THEN
    RAISE EXCEPTION 'HQ_ENTITLEMENT_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  PERFORM 1 FROM hon.organizations o WHERE o.id = p_organization_id AND o.status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HQ_ENTITLEMENT_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO prior FROM hon.organization_entitlements e WHERE e.organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HQ_ENTITLEMENT_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.require_hq_entitlement_actor(p_subject);
  IF prior.tier NOT IN ('CORE','COMPLETE') OR prior.status <> 'ACTIVE'
    OR prior.effective_from > clock_timestamp() OR (prior.effective_until IS NOT NULL AND prior.effective_until <= clock_timestamp()) THEN
    RAISE EXCEPTION 'HQ_ENTITLEMENT_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO receipt FROM hon.hq_entitlement_requests r WHERE r.actor_principal_id = actor AND r.idempotency_key = p_key FOR UPDATE;
  IF FOUND THEN
    IF receipt.request_fingerprint <> fingerprint THEN RAISE EXCEPTION 'HQ_ENTITLEMENT_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    IF receipt.status <> 'COMPLETED' OR receipt.response_body IS NULL THEN RAISE EXCEPTION 'HQ_ENTITLEMENT_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03'; END IF;
    PERFORM hon.require_hq_entitlement_actor(p_subject);
    RETURN receipt.response_body || jsonb_build_object('replayed',true);
  END IF;
  IF prior.version <> p_expected_version OR prior.tier::text = p_target THEN
    RAISE EXCEPTION 'HQ_ENTITLEMENT_VERSION_OR_TARGET_CONFLICT' USING ERRCODE = '40001';
  END IF;
  effective := clock_timestamp();
  IF prior.effective_until IS NOT NULL AND prior.effective_until <= effective THEN
    RAISE EXCEPTION 'HQ_ENTITLEMENT_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO hon.hq_entitlement_requests(actor_principal_id,idempotency_key,request_fingerprint,request_id,correlation_id,status)
    VALUES(actor,p_key,fingerprint,p_request_id,p_correlation_id,'IN_PROGRESS');
  UPDATE hon.organization_entitlements SET tier = p_target::hon.plan_tier, version = version + 1,
    effective_from = effective, updated_at = effective
    WHERE organization_id = p_organization_id AND version = p_expected_version AND tier = prior.tier;
  IF NOT FOUND THEN RAISE EXCEPTION 'HQ_ENTITLEMENT_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  prior_fact := jsonb_build_object('organizationId',p_organization_id,'tier',prior.tier::text,'version',prior.version,
    'effectiveFrom',to_char(prior.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  next_fact := jsonb_build_object('organizationId',p_organization_id,'tier',p_target,'version',prior.version+1,
    'effectiveFrom',to_char(effective AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  result := jsonb_build_object('organizationId',p_organization_id,'priorTier',prior.tier::text,'targetTier',p_target,
    'version',prior.version+1,'effectiveFrom',next_fact->>'effectiveFrom','replayed',false);
  INSERT INTO hon.hq_entitlement_audit(organization_id,actor_principal_id,idempotency_key,request_id,correlation_id,action_code,prior_state,next_state,occurred_at)
    VALUES(p_organization_id,actor,p_key,p_request_id,p_correlation_id,'hq.entitlement.transition',prior_fact,next_fact,effective) RETURNING id INTO audit_id;
  INSERT INTO hon.hq_entitlement_outbox(audit_id,event_type,request_id,correlation_id,payload,occurred_at)
    VALUES(audit_id,'hq.organization.entitlement.changed',p_request_id,p_correlation_id,
      jsonb_build_object('prior',prior_fact,'next',next_fact,'internalOnly',true,'executionAllowed',false),effective);
  UPDATE hon.hq_entitlement_requests SET status = 'COMPLETED',response_body = result,completed_at = effective
    WHERE actor_principal_id = actor AND idempotency_key = p_key;
  PERFORM hon.require_hq_entitlement_actor(p_subject);
  RETURN result;
END $$;
COMMENT ON FUNCTION hon.transition_organization_entitlement_from_hq(text,uuid,text,integer,uuid,text,uuid,uuid) IS
  'HQ direct human current CORE <-> COMPLETE recordkeeping only. Legacy ESSENTIAL untouched. Private inert evidence; no commercial, credit, provider or execution effects.';

DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['organization_entitlements','hq_entitlement_requests','hq_entitlement_audit','hq_entitlement_outbox'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I CASCADE',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_hq_entitlement_evidence()','hon.require_hq_entitlement_actor(text)',
    'hon.transition_organization_entitlement_from_hq(text,uuid,text,integer,uuid,text,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.transition_organization_entitlement_from_hq(text,uuid,text,integer,uuid,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
