BEGIN;

-- HON Champions Club foundation (Milestone 1): school-owned referral codes, HQ-recorded
-- referral attribution, guarded qualification states and a versioned program policy.
-- Recordkeeping only. No credit, free month, lifetime membership, prize, payment, refund,
-- message, provider, Action Engine execution or external effect exists in this migration.
-- financial_rewards_enabled is pinned to false by constraint until billing integration and
-- explicit owner approval land in a later reviewed migration.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Champions Club foundation requires a trusted migration owner';
  END IF;
END $$;

INSERT INTO hon.permissions(code, description, is_sensitive, is_staff_assignable)
VALUES ('champions.participate','HON Champions Club participation: own school referral code and referral status; no financial reward authority',false,true);
INSERT INTO hon.role_permissions(role_id, organization_id, permission_code)
SELECT id, organization_id, 'champions.participate' FROM hon.roles WHERE is_system_role AND code = 'OWNER' ON CONFLICT DO NOTHING;

-- Versioned program terms. A policy can be PUBLISHED only when every owner decision is set;
-- an undecided term keeps it DRAFT, and QUALIFIED is impossible without a PUBLISHED policy.
CREATE TABLE hon.champions_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version integer NOT NULL UNIQUE CHECK (policy_version > 0),
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  attribution_window_days integer CHECK (attribution_window_days BETWEEN 1 AND 730),
  refund_window_days integer CHECK (refund_window_days BETWEEN 0 AND 365),
  minimum_paid_days integer CHECK (minimum_paid_days BETWEEN 0 AND 730),
  minimum_paid_invoices integer CHECK (minimum_paid_invoices BETWEEN 0 AND 24),
  payment_verification_source text NOT NULL DEFAULT 'UNDECIDED'
    CHECK (payment_verification_source IN ('UNDECIDED','HON_BILLING','HQ_OWNER_ATTESTATION')),
  welcome_credit_minor integer CHECK (welcome_credit_minor BETWEEN 0 AND 100000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  terms_reference text CHECK (terms_reference IS NULL OR (length(terms_reference) BETWEEN 1 AND 500 AND btrim(terms_reference) = terms_reference)),
  financial_rewards_enabled boolean NOT NULL DEFAULT false CHECK (financial_rewards_enabled = false),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  published_at timestamptz,
  retired_at timestamptz,
  CHECK (status = 'DRAFT' OR (attribution_window_days IS NOT NULL AND refund_window_days IS NOT NULL
    AND minimum_paid_days IS NOT NULL AND minimum_paid_invoices IS NOT NULL AND welcome_credit_minor IS NOT NULL
    AND payment_verification_source <> 'UNDECIDED' AND terms_reference IS NOT NULL
    AND published_by_principal_id IS NOT NULL AND published_at IS NOT NULL)),
  CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX champions_one_published_policy ON hon.champions_policies((true)) WHERE status = 'PUBLISHED';

-- School-owned referral identity. One ACTIVE code per school; codes are server-generated.
CREATE TABLE hon.champions_referral_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-HJ-NP-Z2-9]{10}$'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX champions_one_active_code_per_school ON hon.champions_referral_codes(school_id) WHERE status = 'ACTIVE';

-- One attribution per referred organization (duplicate prevention). The referred
-- organization can never be the referrer organization (self-referral prevention).
CREATE TABLE hon.champions_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_code_id uuid NOT NULL,
  referrer_organization_id uuid NOT NULL,
  referrer_school_id uuid NOT NULL,
  referred_organization_id uuid NOT NULL UNIQUE REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','QUALIFIED','REJECTED','REFUNDED','REVERSED')),
  state_reason text NOT NULL DEFAULT 'CAPTURED' CHECK (state_reason IN ('CAPTURED','QUALIFICATION_VERIFIED',
    'DUPLICATE_ACCOUNT','SELF_REFERRAL','FRAUD_SUSPECTED','NOT_ELIGIBLE','ATTRIBUTION_EXPIRED','DISPUTE_RESOLVED',
    'REFUND_ISSUED','PAYMENT_REVERSED','SUBSCRIPTION_CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  captured_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  qualified_policy_id uuid REFERENCES hon.champions_policies(id) ON DELETE RESTRICT,
  qualified_at timestamptz,
  qualification_evidence jsonb,
  decided_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  FOREIGN KEY (referral_code_id, referrer_organization_id, referrer_school_id)
    REFERENCES hon.champions_referral_codes(id, organization_id, school_id) ON DELETE RESTRICT,
  CHECK (referrer_organization_id <> referred_organization_id),
  CHECK ((qualified_policy_id IS NULL) = (qualified_at IS NULL)),
  CHECK (state <> 'QUALIFIED' OR (qualified_policy_id IS NOT NULL AND qualification_evidence IS NOT NULL)),
  CHECK ((state = 'PENDING') = (decided_at IS NULL AND decided_by_principal_id IS NULL))
);
CREATE INDEX champions_attributions_referrer ON hon.champions_attributions(referrer_school_id, state);

CREATE TABLE hon.champions_attribution_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_id uuid NOT NULL REFERENCES hon.champions_attributions(id) ON DELETE RESTRICT,
  from_state text CHECK (from_state IN ('PENDING','QUALIFIED','REJECTED','REFUNDED','REVERSED')),
  to_state text NOT NULL CHECK (to_state IN ('PENDING','QUALIFIED','REJECTED','REFUNDED','REVERSED')),
  version integer NOT NULL CHECK (version > 0),
  state_reason text NOT NULL,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  UNIQUE (attribution_id, version)
);

-- Private idempotency, audit and inert outbox evidence (same posture as HQ entitlement).
CREATE TABLE hon.champions_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  operation text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (actor_principal_id, idempotency_key),
  CHECK ((status = 'IN_PROGRESS' AND response_body IS NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND response_body IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE TABLE hon.champions_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL, request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('champions.code.issue','champions.policy.draft','champions.policy.publish',
    'champions.attribution.capture','champions.attribution.decide')),
  entity_type text NOT NULL CHECK (entity_type IN ('REFERRAL_CODE','POLICY','ATTRIBUTION')),
  entity_id uuid NOT NULL,
  organization_id uuid REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  prior_state jsonb, next_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (actor_principal_id, idempotency_key) REFERENCES hon.champions_requests(actor_principal_id, idempotency_key) ON DELETE RESTRICT,
  UNIQUE (actor_principal_id, idempotency_key)
);
CREATE TABLE hon.champions_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id uuid NOT NULL UNIQUE REFERENCES hon.champions_audit(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('champions.referral_code.issued','champions.policy.drafted','champions.policy.published',
    'champions.attribution.captured','champions.attribution.decided')),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK (payload->'internalOnly' = 'true'::jsonb AND payload->'executionAllowed' = 'false'::jsonb),
  occurred_at timestamptz NOT NULL
);

-- Evidence is append-only; requests may only complete once.
CREATE FUNCTION hon.guard_champions_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_TABLE_NAME = 'champions_requests' AND TG_OP = 'UPDATE' THEN
    IF OLD.status = 'IN_PROGRESS' AND NEW.status = 'COMPLETED'
      AND NEW.response_body IS NOT NULL AND NEW.completed_at IS NOT NULL
      AND (to_jsonb(NEW) - ARRAY['status','response_body','completed_at']) = (to_jsonb(OLD) - ARRAY['status','response_body','completed_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_CHAMPIONS_EVIDENCE' USING ERRCODE = '42501';
END $$;

-- Mutable records allow only their documented transitions; nothing is ever deleted.
CREATE FUNCTION hon.guard_champions_records() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE before_row jsonb; after_row jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_CHAMPIONS_RECORD' USING ERRCODE = '42501'; END IF;
  before_row := to_jsonb(OLD); after_row := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'champions_policies' THEN
    IF (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED'
        AND (after_row - ARRAY['status','published_by_principal_id','published_at']) = (before_row - ARRAY['status','published_by_principal_id','published_at']))
      OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'
        AND (after_row - ARRAY['status','retired_at']) = (before_row - ARRAY['status','retired_at'])) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'champions_referral_codes' THEN
    IF OLD.status = 'ACTIVE' AND NEW.status = 'REVOKED'
      AND (after_row - ARRAY['status','revoked_at']) = (before_row - ARRAY['status','revoked_at']) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'champions_attributions' THEN
    IF NEW.version = OLD.version + 1
      AND (after_row - ARRAY['state','state_reason','version','qualified_policy_id','qualified_at','qualification_evidence','decided_by_principal_id','decided_at'])
        = (before_row - ARRAY['state','state_reason','version','qualified_policy_id','qualified_at','qualification_evidence','decided_by_principal_id','decided_at'])
      AND ((OLD.state = 'PENDING' AND NEW.state IN ('QUALIFIED','REJECTED','REFUNDED'))
        OR (OLD.state = 'QUALIFIED' AND NEW.state IN ('REFUNDED','REVERSED')))
      AND (NEW.state = 'QUALIFIED' OR (NEW.qualified_policy_id IS NOT DISTINCT FROM OLD.qualified_policy_id
        AND NEW.qualified_at IS NOT DISTINCT FROM OLD.qualified_at AND NEW.qualification_evidence IS NOT DISTINCT FROM OLD.qualification_evidence)) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['champions_attribution_history','champions_requests','champions_audit','champions_outbox'] LOOP
    EXECUTE format('CREATE TRIGGER champions_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_champions_evidence()',t);
    EXECUTE format('CREATE TRIGGER champions_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_champions_evidence()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['champions_policies','champions_referral_codes','champions_attributions'] LOOP
    EXECUTE format('CREATE TRIGGER champions_guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_champions_records()',t);
    EXECUTE format('CREATE TRIGGER champions_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_champions_records()',t);
  END LOOP;
END $$;

-- ---------- authority ----------
-- Rejects any tenant, family, principal, delegated or Action Engine context: these commands
-- are direct-human only and resolve their own actor from the verified external subject.
CREATE FUNCTION hon.champions_refuse_context() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['app.hon_organization_id','app.hon_school_id','app.hon_family_id',
      'app.hon_principal_id','app.hon_principal_type','app.hon_source','app.hon_action_request_id','app.hon_delegated_by_principal_id']) setting
      WHERE nullif(current_setting(setting,true),'') IS NOT NULL) THEN
    RAISE EXCEPTION 'CHAMPIONS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
END $$;

-- HQ owner, or HQ operator with hq.champions.manage. Owner-only operations are financially
-- consequential (publish terms, qualify, refund, reverse). Family identities are refused.
CREATE FUNCTION hon.require_champions_hq_actor(p_subject text, p_owner_only boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid;
BEGIN
  PERFORM hon.champions_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject OR p_owner_only IS NULL THEN
    RAISE EXCEPTION 'CHAMPIONS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND p.is_active AND p.principal_type = 'HUMAN_USER'
    AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p.id
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (g.hq_role = 'HON_HQ_OWNER'
        OR (NOT p_owner_only AND g.hq_role = 'HON_HQ_OPERATOR' AND 'hq.champions.manage' = ANY(g.permission_codes))))
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'CHAMPIONS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

-- School staff with champions.participate at the exact school, an active school entitlement,
-- and no family, HQ, parent, student or platform role. Mirrors the CRM close resolver.
CREATE FUNCTION hon.require_champions_school_actor(p_subject text, p_school uuid)
RETURNS TABLE (principal_id uuid, organization_id uuid, school_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  PERFORM hon.champions_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject OR p_school IS NULL THEN
    RAISE EXCEPTION 'CHAMPIONS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT DISTINCT p.id, s.organization_id, s.id FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  JOIN hon.schools s ON s.id = p_school
  WHERE u.external_subject = p_subject AND p.is_active
    AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1
    AND hon.staff_member_eligible(p.id, s.organization_id, s.id)
    AND EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id = r.id AND rp.organization_id = r.organization_id
      JOIN hon.permissions perm ON perm.code = rp.permission_code
      WHERE g.principal_id = p.id AND g.organization_id = s.organization_id AND g.school_id = s.id
        AND perm.code = 'champions.participate' AND perm.is_staff_assignable
        AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id = s.id)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()))
    AND NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
      WHERE g.principal_id = p.id AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id = s.organization_id
      AND e.status = 'ACTIVE' AND e.tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND e.effective_from <= clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until > clock_timestamp()));
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
END $$;

-- ---------- idempotency and evidence helpers (private) ----------
CREATE FUNCTION hon.champions_claim_request(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text,
  p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE receipt hon.champions_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL OR p_request IS NULL OR p_correlation IS NULL THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'CHAMPIONS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO receipt FROM hon.champions_requests r WHERE r.actor_principal_id = p_actor AND r.idempotency_key = p_key FOR UPDATE;
  IF FOUND THEN
    IF receipt.operation <> p_operation OR receipt.request_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'CHAMPIONS_KEY_REUSED' USING ERRCODE = '23505';
    END IF;
    IF receipt.status <> 'COMPLETED' THEN RAISE EXCEPTION 'CHAMPIONS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03'; END IF;
    RETURN receipt.response_body || jsonb_build_object('replayed', true);
  END IF;
  INSERT INTO hon.champions_requests(actor_principal_id,idempotency_key,operation,request_fingerprint,request_id,correlation_id,status)
    VALUES (p_actor,p_key,p_operation,p_fingerprint,p_request,p_correlation,'IN_PROGRESS');
  RETURN NULL;
END $$;

CREATE FUNCTION hon.champions_record(p_actor uuid, p_key uuid, p_action text, p_event text, p_entity_type text, p_entity uuid,
  p_organization uuid, p_prior jsonb, p_next jsonb, p_response jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE receipt hon.champions_requests%ROWTYPE; audit uuid;
BEGIN
  SELECT * INTO receipt FROM hon.champions_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  INSERT INTO hon.champions_audit(actor_principal_id,idempotency_key,request_id,correlation_id,action_code,entity_type,entity_id,organization_id,prior_state,next_state,occurred_at)
    VALUES (p_actor,p_key,receipt.request_id,receipt.correlation_id,p_action,p_entity_type,p_entity,p_organization,p_prior,p_next,p_at)
    RETURNING id INTO audit;
  INSERT INTO hon.champions_outbox(audit_id,event_type,request_id,correlation_id,payload,occurred_at)
    VALUES (audit,p_event,receipt.request_id,receipt.correlation_id,
      jsonb_build_object('entityType',p_entity_type,'entityId',p_entity,'next',p_next,'internalOnly',true,'executionAllowed',false),p_at);
  UPDATE hon.champions_requests SET status = 'COMPLETED', response_body = p_response, completed_at = p_at
    WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  RETURN p_response || jsonb_build_object('replayed', false);
END $$;

CREATE FUNCTION hon.champions_fingerprint(p_parts text[]) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT encode(sha256(convert_to(array_to_string(p_parts, chr(31), ''), 'UTF8')), 'hex')
$$;

CREATE FUNCTION hon.champions_ts(p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

CREATE FUNCTION hon.champions_policy_json(p hon.champions_policies) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('policyId',p.id,'policyVersion',p.policy_version,'status',p.status,
    'attributionWindowDays',p.attribution_window_days,'refundWindowDays',p.refund_window_days,
    'minimumPaidDays',p.minimum_paid_days,'minimumPaidInvoices',p.minimum_paid_invoices,
    'paymentVerificationSource',p.payment_verification_source,'welcomeCreditMinor',p.welcome_credit_minor,
    'currency',p.currency,'termsReference',p.terms_reference,'financialRewards','DISABLED',
    'createdAt',hon.champions_ts(p.created_at),'publishedAt',CASE WHEN p.published_at IS NULL THEN NULL ELSE hon.champions_ts(p.published_at) END)
$$;

-- ---------- school commands ----------
-- Ensures the school has one ACTIVE server-generated code. Issuing never grants anything:
-- a visit or click using the code records nothing and qualifies nothing.
CREATE FUNCTION hon.issue_champions_referral_code(p_subject text, p_school uuid, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; replay jsonb; existing hon.champions_referral_codes%ROWTYPE; new_code text; bytes bytea;
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i integer; attempt integer := 0; at timestamptz; result jsonb; created boolean := false;
BEGIN
  SELECT * INTO scope FROM hon.require_champions_school_actor(p_subject, p_school) LIMIT 1;
  LOCK TABLE hon.users, hon.principals, hon.principal_role_grants, hon.roles, hon.role_permissions, hon.permissions,
    hon.family_access_grants, hon.hq_operator_grants, hon.organization_entitlements IN SHARE MODE;
  SELECT * INTO scope FROM hon.require_champions_school_actor(p_subject, p_school) LIMIT 1;
  replay := hon.champions_claim_request(scope.principal_id, p_key, 'champions.code.issue',
    hon.champions_fingerprint(ARRAY['champions.code.issue', p_school::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('champions.code:' || p_school::text, 0));
  at := clock_timestamp();
  SELECT * INTO existing FROM hon.champions_referral_codes c WHERE c.school_id = p_school AND c.status = 'ACTIVE';
  IF NOT FOUND THEN
    LOOP
      attempt := attempt + 1;
      -- Core gen_random_uuid() (no extension): bytes 0-5 of each UUID are fully random; 256 % 32 = 0 keeps it uniform.
      bytes := substring(uuid_send(gen_random_uuid()) FROM 1 FOR 5) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 5); new_code := '';
      FOR i IN 0..9 LOOP new_code := new_code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1); END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM hon.champions_referral_codes WHERE code = new_code);
      IF attempt >= 5 THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
    END LOOP;
    INSERT INTO hon.champions_referral_codes(organization_id,school_id,code,created_by_principal_id,created_at)
      VALUES (scope.organization_id, p_school, new_code, scope.principal_id, at) RETURNING * INTO existing;
    created := true;
  END IF;
  result := jsonb_build_object('schoolId',p_school,'code',existing.code,'status',existing.status,
    'issuedAt',hon.champions_ts(existing.created_at),'created',created);
  RETURN hon.champions_record(scope.principal_id, p_key, 'champions.code.issue', 'champions.referral_code.issued', 'REFERRAL_CODE',
    existing.id, scope.organization_id, NULL, jsonb_build_object('code',existing.code,'status',existing.status,'created',created), result, at);
END $$;

-- Read-only school participation view: own code, program status and own referral counts.
-- No referred-school identity is exposed to the referring school.
CREATE FUNCTION hon.read_champions_school_view(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; code_row hon.champions_referral_codes%ROWTYPE; published hon.champions_policies%ROWTYPE; counts jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_champions_school_actor(p_subject, p_school) LIMIT 1;
  SELECT * INTO code_row FROM hon.champions_referral_codes c WHERE c.school_id = p_school AND c.status = 'ACTIVE';
  SELECT * INTO published FROM hon.champions_policies p WHERE p.status = 'PUBLISHED';
  SELECT jsonb_build_object(
      'pending', count(*) FILTER (WHERE state = 'PENDING'), 'qualified', count(*) FILTER (WHERE state = 'QUALIFIED'),
      'rejected', count(*) FILTER (WHERE state = 'REJECTED'), 'refunded', count(*) FILTER (WHERE state = 'REFUNDED'),
      'reversed', count(*) FILTER (WHERE state = 'REVERSED'))
    INTO counts FROM hon.champions_attributions a WHERE a.referrer_school_id = p_school AND a.referrer_organization_id = scope.organization_id;
  RETURN jsonb_build_object(
    'schoolId', p_school,
    'referralCode', CASE WHEN code_row.id IS NULL THEN NULL ELSE jsonb_build_object('code',code_row.code,'status',code_row.status,'issuedAt',hon.champions_ts(code_row.created_at)) END,
    'program', CASE WHEN published.id IS NULL THEN jsonb_build_object('status','POLICY_UNDECIDED','policyVersion',NULL,'financialRewards','DISABLED')
      ELSE jsonb_build_object('status','PUBLISHED','policyVersion',published.policy_version,'financialRewards','DISABLED') END,
    'referrals', counts);
END $$;

-- ---------- HQ commands ----------
CREATE FUNCTION hon.read_champions_program_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE published jsonb; drafts jsonb;
BEGIN
  PERFORM hon.require_champions_hq_actor(p_subject, false);
  SELECT hon.champions_policy_json(p) INTO published FROM hon.champions_policies p WHERE p.status = 'PUBLISHED';
  SELECT coalesce(jsonb_agg(hon.champions_policy_json(p) ORDER BY p.policy_version DESC), '[]'::jsonb) INTO drafts
    FROM (SELECT * FROM hon.champions_policies WHERE status = 'DRAFT' ORDER BY policy_version DESC LIMIT 10) p;
  RETURN jsonb_build_object('published', published, 'drafts', drafts, 'financialRewards', 'DISABLED');
END $$;

-- Drafts are immutable; revising terms means creating a new draft version.
CREATE FUNCTION hon.create_champions_policy_draft(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; created hon.champions_policies%ROWTYPE; next_version integer; at timestamptz; result jsonb;
  allowed constant text[] := ARRAY['attributionWindowDays','refundWindowDays','minimumPaidDays','minimumPaidInvoices',
    'paymentVerificationSource','welcomeCreditMinor','termsReference'];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k <> ALL(allowed))
    OR (SELECT count(*) FROM jsonb_object_keys(p)) <> cardinality(allowed)
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['attributionWindowDays','refundWindowDays','minimumPaidDays','minimumPaidInvoices','welcomeCreditMinor']) k
      WHERE jsonb_typeof(p->k) NOT IN ('number','null') OR (jsonb_typeof(p->k) = 'number' AND (p->>k) !~ '^[0-9]{1,6}$'))
    OR jsonb_typeof(p->'paymentVerificationSource') <> 'string' OR jsonb_typeof(p->'termsReference') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_champions_hq_actor(p_subject, false);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_champions_hq_actor(p_subject, false);
  replay := hon.champions_claim_request(actor, p_key, 'champions.policy.draft',
    hon.champions_fingerprint(ARRAY['champions.policy.draft', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  LOCK TABLE hon.champions_policies IN SHARE ROW EXCLUSIVE MODE;
  SELECT coalesce(max(policy_version), 0) + 1 INTO next_version FROM hon.champions_policies;
  at := clock_timestamp();
  INSERT INTO hon.champions_policies(policy_version,status,attribution_window_days,refund_window_days,minimum_paid_days,
      minimum_paid_invoices,payment_verification_source,welcome_credit_minor,terms_reference,created_by_principal_id,created_at)
    VALUES (next_version,'DRAFT',(p->>'attributionWindowDays')::integer,(p->>'refundWindowDays')::integer,(p->>'minimumPaidDays')::integer,
      (p->>'minimumPaidInvoices')::integer,p->>'paymentVerificationSource',(p->>'welcomeCreditMinor')::integer,p->>'termsReference',actor,at)
    RETURNING * INTO created;
  result := jsonb_build_object('policy', hon.champions_policy_json(created));
  RETURN hon.champions_record(actor, p_key, 'champions.policy.draft', 'champions.policy.drafted', 'POLICY', created.id, NULL,
    NULL, hon.champions_policy_json(created), result, at);
END $$;

-- HQ owner only. The draft must be complete; the previous published version is retired and
-- applies to no future qualification. Publishing still enables no financial reward.
CREATE FUNCTION hon.publish_champions_policy(p_subject text, p_policy uuid, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; draft hon.champions_policies%ROWTYPE; prior hon.champions_policies%ROWTYPE; at timestamptz; result jsonb;
BEGIN
  IF p_policy IS NULL THEN RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023'; END IF;
  actor := hon.require_champions_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_champions_hq_actor(p_subject, true);
  replay := hon.champions_claim_request(actor, p_key, 'champions.policy.publish',
    hon.champions_fingerprint(ARRAY['champions.policy.publish', p_policy::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  LOCK TABLE hon.champions_policies IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO draft FROM hon.champions_policies WHERE id = p_policy FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF draft.status <> 'DRAFT' THEN RAISE EXCEPTION 'CHAMPIONS_POLICY_NOT_DRAFT' USING ERRCODE = '40001'; END IF;
  IF draft.attribution_window_days IS NULL OR draft.refund_window_days IS NULL OR draft.minimum_paid_days IS NULL
    OR draft.minimum_paid_invoices IS NULL OR draft.welcome_credit_minor IS NULL OR draft.payment_verification_source = 'UNDECIDED'
    OR draft.terms_reference IS NULL THEN
    RAISE EXCEPTION 'CHAMPIONS_POLICY_UNDECIDED' USING ERRCODE = '23514';
  END IF;
  at := clock_timestamp();
  SELECT * INTO prior FROM hon.champions_policies WHERE status = 'PUBLISHED' FOR UPDATE;
  IF FOUND THEN UPDATE hon.champions_policies SET status = 'RETIRED', retired_at = at WHERE id = prior.id; END IF;
  UPDATE hon.champions_policies SET status = 'PUBLISHED', published_by_principal_id = actor, published_at = at
    WHERE id = p_policy RETURNING * INTO draft;
  result := jsonb_build_object('policy', hon.champions_policy_json(draft),
    'retiredPolicyId', CASE WHEN prior.id IS NULL THEN NULL ELSE to_jsonb(prior.id) END);
  RETURN hon.champions_record(actor, p_key, 'champions.policy.publish', 'champions.policy.published', 'POLICY', draft.id, NULL,
    CASE WHEN prior.id IS NULL THEN NULL ELSE hon.champions_policy_json(prior) END, hon.champions_policy_json(draft), result, at);
END $$;

CREATE FUNCTION hon.champions_attribution_json(a hon.champions_attributions) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('attributionId',a.id,'state',a.state,'stateReason',a.state_reason,'version',a.version,
    'referrerOrganizationId',a.referrer_organization_id,'referrerSchoolId',a.referrer_school_id,
    'referrerSchoolName',(SELECT s.name FROM hon.schools s WHERE s.id = a.referrer_school_id),
    'referredOrganizationId',a.referred_organization_id,
    'referredOrganizationName',(SELECT o.display_name FROM hon.organizations o WHERE o.id = a.referred_organization_id),
    'capturedAt',hon.champions_ts(a.captured_at),
    'qualifiedPolicyVersion',(SELECT p.policy_version FROM hon.champions_policies p WHERE p.id = a.qualified_policy_id),
    'qualifiedAt',CASE WHEN a.qualified_at IS NULL THEN NULL ELSE hon.champions_ts(a.qualified_at) END,
    'decidedAt',CASE WHEN a.decided_at IS NULL THEN NULL ELSE hon.champions_ts(a.decided_at) END)
$$;

-- The same human (one user identity) may not appear on both sides of a referral. Any role
-- grant counts, revoked or not. Checked at capture and again at qualification, because a
-- newly provisioned organization usually has no staff grants yet when it is captured.
CREATE FUNCTION hon.champions_orgs_share_user(p_referrer uuid, p_referred uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.principal_role_grants g1 JOIN hon.principals p1 ON p1.id = g1.principal_id
    JOIN hon.principals p2 ON p2.user_id = p1.user_id JOIN hon.principal_role_grants g2 ON g2.principal_id = p2.id
    WHERE g1.organization_id = p_referrer AND g2.organization_id = p_referred)
$$;

-- Records that a newly provisioned organization was referred by a school's code. Never
-- triggered by a URL alone: an HQ human records it against an existing organization.
CREATE FUNCTION hon.capture_champions_attribution(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; code_row hon.champions_referral_codes%ROWTYPE; referred hon.organizations%ROWTYPE;
  created hon.champions_attributions%ROWTYPE; referred_id uuid; at timestamptz; result jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['referralCode','referredOrganizationId']
    OR jsonb_typeof(p->'referralCode') <> 'string' OR (p->>'referralCode') !~ '^[A-HJ-NP-Z2-9]{10}$'
    OR jsonb_typeof(p->'referredOrganizationId') <> 'string'
    OR (p->>'referredOrganizationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  referred_id := (p->>'referredOrganizationId')::uuid;
  actor := hon.require_champions_hq_actor(p_subject, false);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants, hon.principal_role_grants IN SHARE MODE;
  actor := hon.require_champions_hq_actor(p_subject, false);
  replay := hon.champions_claim_request(actor, p_key, 'champions.attribution.capture',
    hon.champions_fingerprint(ARRAY['champions.attribution.capture', p->>'referralCode', referred_id::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO code_row FROM hon.champions_referral_codes c WHERE c.code = p->>'referralCode' FOR SHARE;
  SELECT * INTO referred FROM hon.organizations o WHERE o.id = referred_id FOR SHARE;
  IF code_row.id IS NULL OR referred.id IS NULL THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF code_row.status <> 'ACTIVE' OR referred.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'CHAMPIONS_ATTRIBUTION_NOT_ELIGIBLE' USING ERRCODE = '23514';
  END IF;
  IF code_row.organization_id = referred_id OR hon.champions_orgs_share_user(code_row.organization_id, referred_id) THEN
    RAISE EXCEPTION 'CHAMPIONS_SELF_REFERRAL' USING ERRCODE = '23514';
  END IF;
  -- No retroactive attribution of organizations that existed before the code was issued.
  IF referred.created_at < code_row.created_at THEN
    RAISE EXCEPTION 'CHAMPIONS_ATTRIBUTION_NOT_ELIGIBLE' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.champions_attributions WHERE referred_organization_id = referred_id) THEN
    RAISE EXCEPTION 'CHAMPIONS_DUPLICATE_ATTRIBUTION' USING ERRCODE = '23P01';
  END IF;
  at := clock_timestamp();
  INSERT INTO hon.champions_attributions(referral_code_id,referrer_organization_id,referrer_school_id,referred_organization_id,
      captured_by_principal_id,captured_at)
    VALUES (code_row.id, code_row.organization_id, code_row.school_id, referred_id, actor, at) RETURNING * INTO created;
  INSERT INTO hon.champions_attribution_history(attribution_id,from_state,to_state,version,state_reason,actor_principal_id,occurred_at)
    VALUES (created.id, NULL, 'PENDING', 1, 'CAPTURED', actor, at);
  result := jsonb_build_object('attribution', hon.champions_attribution_json(created));
  RETURN hon.champions_record(actor, p_key, 'champions.attribution.capture', 'champions.attribution.captured', 'ATTRIBUTION',
    created.id, code_row.organization_id, NULL, jsonb_build_object('state','PENDING','version',1), result, at);
END $$;

-- Decisions: REJECT (HQ operator or owner); QUALIFY, REFUND and REVERSE (HQ owner only).
-- QUALIFY requires a PUBLISHED policy, an unexpired attribution window, an elapsed refund
-- window and minimum paid period, and payment evidence from the policy's verification source.
-- HON_BILLING has no authoritative source yet, so it fails closed.
CREATE FUNCTION hon.decide_champions_attribution(p_subject text, p_attribution uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; decision text; reason text; expected integer; prior hon.champions_attributions%ROWTYPE;
  updated hon.champions_attributions%ROWTYPE; policy hon.champions_policies%ROWTYPE; evidence jsonb := NULL; target text;
  first_paid timestamptz; paid_invoices integer; at timestamptz; result jsonb; keys text[];
BEGIN
  IF p_attribution IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(p) k;
  decision := p->>'decision'; reason := p->>'reasonCode';
  IF jsonb_typeof(p->'decision') <> 'string' OR jsonb_typeof(p->'reasonCode') <> 'string'
    OR jsonb_typeof(p->'expectedVersion') <> 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR NOT ((decision = 'QUALIFY' AND keys = ARRAY['decision','evidence','expectedVersion','reasonCode'])
      OR (decision IN ('REJECT','REFUND','REVERSE') AND keys = ARRAY['decision','expectedVersion','reasonCode']))
    OR NOT ((decision = 'QUALIFY' AND reason = 'QUALIFICATION_VERIFIED')
      OR (decision = 'REJECT' AND reason IN ('DUPLICATE_ACCOUNT','SELF_REFERRAL','FRAUD_SUSPECTED','NOT_ELIGIBLE','ATTRIBUTION_EXPIRED','DISPUTE_RESOLVED'))
      OR (decision = 'REFUND' AND reason = 'REFUND_ISSUED')
      OR (decision = 'REVERSE' AND reason IN ('PAYMENT_REVERSED','SUBSCRIPTION_CANCELLED','FRAUD_SUSPECTED','DISPUTE_RESOLVED'))) THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  expected := (p->>'expectedVersion')::integer;
  IF decision = 'QUALIFY' THEN
    IF jsonb_typeof(p->'evidence') <> 'object'
      OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p->'evidence') k) IS DISTINCT FROM ARRAY['firstPaidAt','paidInvoiceCount','reference']
      OR jsonb_typeof(p->'evidence'->'reference') <> 'string' OR length(p->'evidence'->>'reference') NOT BETWEEN 1 AND 200
      OR btrim(p->'evidence'->>'reference') <> p->'evidence'->>'reference'
      OR jsonb_typeof(p->'evidence'->'paidInvoiceCount') <> 'number' OR (p->'evidence'->>'paidInvoiceCount') !~ '^[0-9]{1,3}$'
      OR jsonb_typeof(p->'evidence'->'firstPaidAt') <> 'string'
      OR (p->'evidence'->>'firstPaidAt') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
      RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
    END IF;
    first_paid := (p->'evidence'->>'firstPaidAt')::timestamptz;
    paid_invoices := (p->'evidence'->>'paidInvoiceCount')::integer;
  END IF;
  target := CASE decision WHEN 'QUALIFY' THEN 'QUALIFIED' WHEN 'REJECT' THEN 'REJECTED' WHEN 'REFUND' THEN 'REFUNDED' ELSE 'REVERSED' END;
  actor := hon.require_champions_hq_actor(p_subject, decision <> 'REJECT');
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants, hon.principal_role_grants IN SHARE MODE;
  actor := hon.require_champions_hq_actor(p_subject, decision <> 'REJECT');
  replay := hon.champions_claim_request(actor, p_key, 'champions.attribution.decide',
    hon.champions_fingerprint(ARRAY['champions.attribution.decide', p_attribution::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO prior FROM hon.champions_attributions WHERE id = p_attribution FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF prior.version <> expected THEN RAISE EXCEPTION 'CHAMPIONS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF NOT ((prior.state = 'PENDING' AND target IN ('QUALIFIED','REJECTED','REFUNDED'))
    OR (prior.state = 'QUALIFIED' AND target IN ('REFUNDED','REVERSED'))) THEN
    RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001';
  END IF;
  at := clock_timestamp();
  IF target = 'QUALIFIED' THEN
    SELECT * INTO policy FROM hon.champions_policies WHERE status = 'PUBLISHED' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_POLICY_UNDECIDED' USING ERRCODE = '23514'; END IF;
    IF policy.payment_verification_source <> 'HQ_OWNER_ATTESTATION' THEN
      RAISE EXCEPTION 'CHAMPIONS_PAYMENT_SOURCE_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
    IF at > prior.captured_at + make_interval(days => policy.attribution_window_days) THEN
      RAISE EXCEPTION 'CHAMPIONS_ATTRIBUTION_EXPIRED' USING ERRCODE = '23514';
    END IF;
    IF first_paid > at OR first_paid < prior.captured_at - interval '1 day'
      OR at < first_paid + make_interval(days => greatest(policy.refund_window_days, policy.minimum_paid_days))
      OR paid_invoices < policy.minimum_paid_invoices THEN
      RAISE EXCEPTION 'CHAMPIONS_QUALIFICATION_NOT_MET' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM hon.organizations o JOIN hon.organization_entitlements e ON e.organization_id = o.id
      WHERE o.id = prior.referred_organization_id AND o.status = 'ACTIVE' AND e.status = 'ACTIVE'
        AND e.effective_from <= at AND (e.effective_until IS NULL OR e.effective_until > at)) THEN
      RAISE EXCEPTION 'CHAMPIONS_QUALIFICATION_NOT_MET' USING ERRCODE = '23514';
    END IF;
    IF hon.champions_orgs_share_user(prior.referrer_organization_id, prior.referred_organization_id) THEN
      RAISE EXCEPTION 'CHAMPIONS_SELF_REFERRAL' USING ERRCODE = '23514';
    END IF;
    evidence := jsonb_build_object('source','HQ_OWNER_ATTESTATION','reference',p->'evidence'->>'reference',
      'paidInvoiceCount',paid_invoices,'firstPaidAt',hon.champions_ts(first_paid));
    UPDATE hon.champions_attributions SET state = target, state_reason = reason, version = version + 1,
      qualified_policy_id = policy.id, qualified_at = at, qualification_evidence = evidence,
      decided_by_principal_id = actor, decided_at = at
      WHERE id = p_attribution AND version = expected RETURNING * INTO updated;
  ELSE
    UPDATE hon.champions_attributions SET state = target, state_reason = reason, version = version + 1,
      decided_by_principal_id = actor, decided_at = at
      WHERE id = p_attribution AND version = expected RETURNING * INTO updated;
  END IF;
  IF updated.id IS NULL THEN RAISE EXCEPTION 'CHAMPIONS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  INSERT INTO hon.champions_attribution_history(attribution_id,from_state,to_state,version,state_reason,actor_principal_id,occurred_at)
    VALUES (updated.id, prior.state, updated.state, updated.version, reason, actor, at);
  result := jsonb_build_object('attribution', hon.champions_attribution_json(updated));
  RETURN hon.champions_record(actor, p_key, 'champions.attribution.decide', 'champions.attribution.decided', 'ATTRIBUTION',
    updated.id, updated.referrer_organization_id, jsonb_build_object('state',prior.state,'version',prior.version),
    jsonb_build_object('state',updated.state,'stateReason',reason,'version',updated.version), result, at);
END $$;

CREATE FUNCTION hon.read_champions_attributions_from_hq(p_subject text, p_state text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE rows jsonb;
BEGIN
  IF p_state IS NOT NULL AND p_state NOT IN ('PENDING','QUALIFIED','REJECTED','REFUNDED','REVERSED') THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.require_champions_hq_actor(p_subject, false);
  SELECT coalesce(jsonb_agg(hon.champions_attribution_json(a) ORDER BY a.captured_at DESC, a.id), '[]'::jsonb) INTO rows
    FROM (SELECT * FROM hon.champions_attributions WHERE p_state IS NULL OR state = p_state
      ORDER BY captured_at DESC, id LIMIT 100) a;
  RETURN jsonb_build_object('attributions', rows, 'limit', 100);
END $$;

-- ---------- RLS and ACL: private tables, function-only runtime access ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['champions_policies','champions_referral_codes','champions_attributions','champions_attribution_history',
      'champions_requests','champions_audit','champions_outbox'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE',col,t);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_champions_evidence()','hon.guard_champions_records()','hon.champions_refuse_context()',
      'hon.require_champions_hq_actor(text,boolean)','hon.require_champions_school_actor(text,uuid)',
      'hon.champions_claim_request(uuid,uuid,text,text,uuid,uuid)',
      'hon.champions_record(uuid,uuid,text,text,text,uuid,uuid,jsonb,jsonb,jsonb,timestamptz)',
      'hon.champions_fingerprint(text[])','hon.champions_ts(timestamptz)','hon.champions_policy_json(hon.champions_policies)',
      'hon.champions_attribution_json(hon.champions_attributions)','hon.champions_orgs_share_user(uuid,uuid)',
      'hon.issue_champions_referral_code(text,uuid,uuid,uuid,uuid)','hon.read_champions_school_view(text,uuid)',
      'hon.read_champions_program_from_hq(text)','hon.create_champions_policy_draft(text,jsonb,uuid,uuid,uuid)',
      'hon.publish_champions_policy(text,uuid,uuid,uuid,uuid)','hon.capture_champions_attribution(text,jsonb,uuid,uuid,uuid)',
      'hon.decide_champions_attribution(text,uuid,jsonb,uuid,uuid,uuid)','hon.read_champions_attributions_from_hq(text,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.issue_champions_referral_code(text,uuid,uuid,uuid,uuid), hon.read_champions_school_view(text,uuid),
      hon.read_champions_program_from_hq(text), hon.create_champions_policy_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_champions_policy(text,uuid,uuid,uuid,uuid), hon.capture_champions_attribution(text,jsonb,uuid,uuid,uuid),
      hon.decide_champions_attribution(text,uuid,jsonb,uuid,uuid,uuid), hon.read_champions_attributions_from_hq(text,text)
      TO hon_runtime;
  END IF;
END $$;

COMMIT;
