BEGIN;

-- Secure HQ school provisioning (owner decision D9).
-- - Provisioning: hon.provision_school_from_hq no longer creates an ACTIVE entitlement. A new school gets its
--   organization, school, OWNER role and the provisioner's grant exactly as before, but its entitlement is held
--   SUSPENDED (the requested tier is a placeholder), so every status-gated function refuses it. It has no access
--   state: it reads as PROVISIONED with no capabilities, and grants no AI credits. While paid access is ACTIVE, the
--   HQ owner places it awaiting its first payment (B6A) and it buys HON OS through the D7 path.
-- - Exceptions: hon.grant_saas_access_exception lets an HQ owner (never an operator, support user, school owner,
--   AI agent or staff member) give one school time-limited free access for internal testing, a product
--   demonstration or an approved pilot. Each exception names the school, a purpose and reason, a scope (Core or
--   Complete capabilities; never AI credits), a start and a mandatory expiry within the access policy's
--   exception_max_days (90 in terms v1), and is idempotent, audited and immutable apart from its one ending.
--   The entitlement window carries the expiry, so access ends at the expiry by itself; HQ can revoke at any time,
--   and closing expired exceptions also suspends the entitlement row.
-- - Boundaries: an exception is only for an organization with no access in effect, no access state (awaiting or
--   paid), no live subscription, no unresolved checkout and no other live exception. While one is live, HON OS
--   checkout is refused (SAAS_ACCESS_EXCEPTION_ACTIVE) and an HQ tier transition cannot widen its scope.
-- - Unchanged: existing entitlements, legacy subscriptions, renewals, lifetime rights, D7 registration and
--   activation, D8 legacy sales closure. Paid access stays pinned INACTIVE (0170). Nothing here is deployed.
-- Number: 0179 is reserved for E1b-2 and 0180 for E1c.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Secure HQ provisioning requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'Secure HQ provisioning requires a restricted runtime';
  END IF;
END $$;

-- ---------- vocabularies ----------
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (action_code IN ('saas.catalog.draft','saas.catalog.publish',
  'saas.founder.reserve','saas.founder.release','saas.subscription.record','saas.subscription.command',
  'saas.invoice.draft','saas.invoice.command','saas.payment.evidence',
  'saas.credits.program','saas.credits.cost_evidence','saas.credits.pricing_draft','saas.credits.pricing_publish',
  'saas.credits.allowance','saas.credits.reserve','saas.credits.settle','saas.credits.resolve',
  'saas.refund.request','saas.refund.decide','saas.rewards.fulfillment','saas.rewards.apply','saas.rewards.credit_apply','saas.rewards.alert_resolve',
  'saas.payments.program','saas.checkout.create','saas.checkout.attach','saas.checkout.cancel','saas.checkout.sweep','saas.provider.event',
  'saas.access.await','saas.access.retry',
  'saas.offers.draft','saas.offers.revise','saas.offers.discard','saas.offers.publish','saas.offers.stop_sales',
  'saas.checkout.create_hon_os','saas.access.initialize',
  'saas.access.exception_grant','saas.access.exception_revoke','saas.access.exception_close'));
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (entity_type IN ('CATALOG','FOUNDER_RESERVATION','SUBSCRIPTION',
  'INVOICE','PAYMENT_EVIDENCE','CREDIT_PROGRAM','COST_EVIDENCE','PRICING','ALLOWANCE','CREDIT_RESERVATION','REFUND_REQUEST','REWARD_FULFILLMENT',
  'REWARD_APPLICATION','REFERRAL_ALERT','PAYMENT_PROGRAM','CHECKOUT','PROVIDER_EVENT','ACCESS_STATE','OFFER_SET','OFFER','ACCESS_EXCEPTION'));
ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (event_type IN ('saas.catalog.drafted','saas.catalog.published',
  'saas.founder.reserved','saas.founder.released','saas.subscription.recorded','saas.subscription.changed',
  'saas.invoice.drafted','saas.invoice.changed','saas.payment.evidence_recorded',
  'saas.credits.program_changed','saas.credits.cost_recorded','saas.credits.pricing_drafted','saas.credits.pricing_published',
  'saas.credits.allowance_changed','saas.credits.reserved','saas.credits.settled','saas.credits.resolved',
  'saas.refund.requested','saas.refund.decided','saas.rewards.fulfillment_changed','saas.rewards.applied','saas.rewards.credit_applied',
  'saas.rewards.alert_resolved','saas.payments.program_changed','saas.checkout.created','saas.checkout.changed','saas.checkouts.swept',
  'saas.provider.event_recorded','saas.access.awaiting','saas.access.retried',
  'saas.offers.drafted','saas.offers.revised','saas.offers.discarded','saas.offers.published','saas.offers.sales_stopped',
  'saas.access.initialized','saas.access.exception_granted','saas.access.exception_ended','saas.access.exceptions_closed'));

-- ---------- HQ-owner access exceptions ----------
CREATE TABLE hon.saas_access_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('INTERNAL_TESTING','PRODUCT_DEMONSTRATION','APPROVED_PILOT')),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 10 AND 500),
  scope_tier text NOT NULL CHECK (scope_tier IN ('CORE','COMPLETE')),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  max_days integer NOT NULL CHECK (max_days BETWEEN 1 AND 90),
  prior_entitlement jsonb NOT NULL,
  granted_entitlement jsonb NOT NULL,
  granted_entitlement_version integer NOT NULL CHECK (granted_entitlement_version > 1),
  granted_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('GRANTED','ENDED')),
  end_reason text CHECK (end_reason IN ('REVOKED','EXPIRED','SUPERSEDED')),
  end_note text CHECK (end_note = btrim(end_note) AND length(end_note) BETWEEN 10 AND 500),
  end_entitlement jsonb,
  ended_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  ended_at timestamptz,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  CHECK (expires_at > starts_at AND expires_at <= starts_at + make_interval(days => max_days)),
  CHECK ((status = 'GRANTED') = (end_reason IS NULL AND end_entitlement IS NULL AND ended_by_principal_id IS NULL AND ended_at IS NULL)),
  CHECK (end_note IS NULL OR end_reason = 'REVOKED'),
  CHECK (end_reason IS DISTINCT FROM 'REVOKED' OR end_note IS NOT NULL)
);
-- At most one open exception per organization; a lapsed or superseded one is closed before the next is granted.
CREATE UNIQUE INDEX saas_access_exceptions_one_open ON hon.saas_access_exceptions (organization_id) WHERE status = 'GRANTED';

-- Immutable apart from its one ending (GRANTED -> ENDED), which may set only the ending columns.
CREATE FUNCTION hon.guard_saas_access_exceptions() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'GRANTED' AND NEW.status = 'ENDED'
    AND (to_jsonb(NEW) - ARRAY['status','end_reason','end_note','end_entitlement','ended_by_principal_id','ended_at'])
      = (to_jsonb(OLD) - ARRAY['status','end_reason','end_note','end_entitlement','ended_by_principal_id','ended_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER saas_guarded BEFORE UPDATE OR DELETE ON hon.saas_access_exceptions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_access_exceptions();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_access_exceptions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_access_exceptions();

-- Database-level authority: a new exception must name a current HON HQ owner (an active, sole human principal with a
-- live HON_HQ_OWNER grant and no family access), match the latest policy terms' authority and maximum, and describe
-- exactly the entitlement row as it now stands. A forged grantor or a row written around the command is refused.
CREATE FUNCTION hon.guard_saas_access_exception_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE t hon.saas_access_policy_terms%ROWTYPE;
BEGIN
  SELECT * INTO t FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1;
  IF NEW.status <> 'GRANTED' OR t.policy_version IS DISTINCT FROM NEW.policy_version OR t.exception_authority IS DISTINCT FROM 'HQ_OWNER'
    OR t.exception_max_days IS DISTINCT FROM NEW.max_days
    OR NOT EXISTS (SELECT 1 FROM hon.principals p JOIN hon.users u ON u.id = p.user_id
      WHERE p.id = NEW.granted_by_principal_id AND p.is_active AND p.principal_type = 'HUMAN_USER'
        AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1
        AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p.id AND g.hq_role = 'HON_HQ_OWNER'
          AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp()))
        AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
          AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp())))
    OR NOT EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id = NEW.organization_id
      AND e.version = NEW.granted_entitlement_version AND e.status = 'ACTIVE' AND e.tier::text = NEW.scope_tier
      AND e.effective_from = NEW.starts_at AND e.effective_until = NEW.expires_at) THEN
    RAISE EXCEPTION 'SAAS_EXCEPTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saas_exception_authority BEFORE INSERT ON hon.saas_access_exceptions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_access_exception_grant();

-- An exception is live while it is open, unexpired and still describes the entitlement (nothing replaced it since).
CREATE FUNCTION hon.saas_access_exception_live(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.saas_access_exceptions x JOIN hon.organization_entitlements e ON e.organization_id = x.organization_id
    WHERE x.organization_id = p_org AND x.status = 'GRANTED' AND x.expires_at > clock_timestamp()
      AND e.version = x.granted_entitlement_version AND e.status = 'ACTIVE')
$$;

CREATE FUNCTION hon.saas_access_exception_json(x hon.saas_access_exceptions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('exceptionId',x.id,'organizationId',x.organization_id,'schoolId',x.school_id,'purpose',x.purpose,'reason',x.reason,
    'scopeTier',x.scope_tier,'capabilities',to_jsonb(hon.saas_plan_capabilities(x.scope_tier)),'aiCredits','NONE',
    'startsAt',hon.saas_ts(x.starts_at),'expiresAt',hon.saas_ts(x.expires_at),'policyVersion',x.policy_version,'maxDays',x.max_days,
    'status',x.status,
    'lifecycle',CASE WHEN x.status = 'ENDED' THEN x.end_reason
      WHEN NOT EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id = x.organization_id
        AND e.version = x.granted_entitlement_version AND e.status = 'ACTIVE') THEN 'SUPERSEDED'
      WHEN clock_timestamp() < x.starts_at THEN 'SCHEDULED' WHEN clock_timestamp() >= x.expires_at THEN 'EXPIRED' ELSE 'IN_EFFECT' END,
    'grantedByPrincipalId',x.granted_by_principal_id,'grantedAt',hon.saas_ts(x.granted_at),
    'priorEntitlement',x.prior_entitlement,'grantedEntitlement',x.granted_entitlement,
    'endReason',x.end_reason,'endNote',x.end_note,'endEntitlement',x.end_entitlement,
    'endedByPrincipalId',x.ended_by_principal_id,'endedAt',hon.saas_ts(x.ended_at))
$$;

-- Ends one open exception (row already locked by the caller, under the organization lock). The entitlement is
-- suspended only while it is still the one the exception granted: a later paid or HQ change is never undone.
CREATE FUNCTION hon.saas_end_access_exception(p_exception uuid, p_reason text, p_note text, p_actor uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE x hon.saas_access_exceptions%ROWTYPE; ent hon.organization_entitlements%ROWTYPE; matches boolean; v_reason text := p_reason;
BEGIN
  SELECT * INTO x FROM hon.saas_access_exceptions WHERE id = p_exception AND status = 'GRANTED';
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = x.organization_id FOR UPDATE;
  matches := ent.version = x.granted_entitlement_version AND ent.status = 'ACTIVE';
  IF matches THEN
    UPDATE hon.organization_entitlements SET status = 'SUSPENDED', version = version + 1, updated_at = p_at
      WHERE organization_id = x.organization_id AND version = ent.version;
  ELSIF v_reason = 'EXPIRED' THEN
    v_reason := 'SUPERSEDED';
  END IF;
  UPDATE hon.saas_access_exceptions SET status = 'ENDED', end_reason = v_reason, end_note = p_note,
      end_entitlement = hon.saas_entitlement_json(x.organization_id), ended_by_principal_id = p_actor, ended_at = p_at
    WHERE id = x.id;
  RETURN jsonb_build_object('entitlementSuspended', matches);
END $$;

-- ---------- HQ owner: grant ----------
CREATE FUNCTION hon.grant_saas_access_exception(p_subject text, p_org uuid, p_input jsonb, p_key uuid, p_request_id uuid,
  p_correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; fp text; replay jsonb; at timestamptz := clock_timestamp(); ts constant text := '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
  v_school uuid; v_starts timestamptz; v_expires timestamptz; v_expected integer; t hon.saas_access_policy_terms%ROWTYPE;
  ent hon.organization_entitlements%ROWTYPE; prior jsonb; nxt jsonb; open_x hon.saas_access_exceptions%ROWTYPE; v_id uuid;
BEGIN
  IF p_org IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k)
      <> ARRAY['expectedEntitlementVersion','expiresAt','purpose','reason','schoolId','scopeTier','startsAt']
    OR jsonb_typeof(p_input->'expectedEntitlementVersion') <> 'number' OR (p_input->>'expectedEntitlementVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'schoolId') <> 'string' OR (p_input->>'schoolId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'purpose') <> 'string' OR (p_input->>'purpose') NOT IN ('INTERNAL_TESTING','PRODUCT_DEMONSTRATION','APPROVED_PILOT')
    OR jsonb_typeof(p_input->'reason') <> 'string' OR (p_input->>'reason') <> btrim(p_input->>'reason') OR length(p_input->>'reason') NOT BETWEEN 10 AND 500
    OR jsonb_typeof(p_input->'scopeTier') <> 'string' OR (p_input->>'scopeTier') NOT IN ('CORE','COMPLETE')
    OR jsonb_typeof(p_input->'startsAt') <> 'string' OR (p_input->>'startsAt') !~ ts
    OR jsonb_typeof(p_input->'expiresAt') <> 'string' OR (p_input->>'expiresAt') !~ ts THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_school := (p_input->>'schoolId')::uuid; v_starts := (p_input->>'startsAt')::timestamptz; v_expires := (p_input->>'expiresAt')::timestamptz;
  v_expected := (p_input->>'expectedEntitlementVersion')::integer;
  -- HQ owner only: operators, support, school owners, AI/delegated contexts and staff are refused here.
  actor := hon.require_saas_hq_actor(p_subject, true);
  fp := hon.saas_fingerprint(ARRAY['access.exception.grant', p_org::text, v_school::text, p_input->>'purpose', p_input->>'reason',
    p_input->>'scopeTier', p_input->>'startsAt', p_input->>'expiresAt', v_expected::text]);
  replay := hon.saas_claim_request(actor, p_key, 'saas.access.exception_grant', fp, p_request_id, p_correlation_id);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || p_org::text, 0));
  PERFORM 1 FROM hon.organizations WHERE id = p_org AND status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM hon.schools WHERE id = v_school AND organization_id = p_org AND status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF ent.version <> v_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  SELECT * INTO t FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1;
  IF t.exception_authority IS DISTINCT FROM 'HQ_OWNER' OR t.exception_max_days IS NULL THEN RAISE EXCEPTION 'SAAS_POLICY_UNDECIDED' USING ERRCODE = '23514'; END IF;
  IF v_starts < at - interval '5 minutes' OR v_starts > at + interval '30 days' OR v_expires <= v_starts OR v_expires <= at THEN
    RAISE EXCEPTION 'SAAS_EXCEPTION_WINDOW_INVALID' USING ERRCODE = '23514';
  END IF;
  IF v_expires > v_starts + make_interval(days => t.exception_max_days) THEN RAISE EXCEPTION 'SAAS_EXCEPTION_TOO_LONG' USING ERRCODE = '23514'; END IF;
  -- Never over access the organization already has, paid, awaiting or legacy: existing customers are untouched.
  IF hon.saas_access_exception_live(p_org) THEN RAISE EXCEPTION 'SAAS_ACCESS_EXCEPTION_ACTIVE' USING ERRCODE = '23514'; END IF;
  IF ent.status = 'ACTIVE' AND ent.effective_from <= at AND (ent.effective_until IS NULL OR ent.effective_until > at) THEN
    RAISE EXCEPTION 'SAAS_ENTITLEMENT_IN_EFFECT' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_access_states WHERE organization_id = p_org) THEN RAISE EXCEPTION 'SAAS_ACCESS_STATE_EXISTS' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_subscriptions WHERE organization_id = p_org AND status <> 'VOIDED') THEN
    RAISE EXCEPTION 'SAAS_SUBSCRIPTION_EXISTS' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE organization_id = p_org AND status IN ('CREATED','OPEN','PAID_NEEDS_REVIEW')) THEN
    RAISE EXCEPTION 'SAAS_CHECKOUT_OPEN' USING ERRCODE = '23514';
  END IF;
  -- A previous exception that lapsed or was replaced is closed first (its entitlement is suspended if still its own).
  SELECT * INTO open_x FROM hon.saas_access_exceptions WHERE organization_id = p_org AND status = 'GRANTED' FOR UPDATE;
  IF FOUND THEN
    PERFORM hon.saas_end_access_exception(open_x.id, 'EXPIRED', NULL, actor, at);
    SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = p_org;
  END IF;
  prior := hon.saas_entitlement_json(p_org);
  UPDATE hon.organization_entitlements SET tier = (p_input->>'scopeTier')::hon.plan_tier, status = 'ACTIVE', effective_from = v_starts,
      effective_until = v_expires, version = version + 1, updated_at = at
    WHERE organization_id = p_org AND version = ent.version;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  nxt := hon.saas_entitlement_json(p_org);
  INSERT INTO hon.saas_access_exceptions(organization_id, school_id, purpose, reason, scope_tier, starts_at, expires_at, policy_version, max_days,
      prior_entitlement, granted_entitlement, granted_entitlement_version, granted_by_principal_id, granted_at, status)
    VALUES (p_org, v_school, p_input->>'purpose', p_input->>'reason', p_input->>'scopeTier', v_starts, v_expires, t.policy_version,
      t.exception_max_days, prior, nxt, ent.version + 1, actor, at, 'GRANTED')
    RETURNING id INTO v_id;
  RETURN hon.saas_record(actor, p_key, 'saas.access.exception_grant', 'saas.access.exception_granted', 'ACCESS_EXCEPTION', v_id, p_org, prior, nxt,
    jsonb_build_object('exception', (SELECT hon.saas_access_exception_json(x) FROM hon.saas_access_exceptions x WHERE x.id = v_id),
      'access', hon.saas_organization_access(p_org)), at);
END $$;

-- ---------- HQ owner: revoke ----------
CREATE FUNCTION hon.revoke_saas_access_exception(p_subject text, p_exception uuid, p_input jsonb, p_key uuid, p_request_id uuid,
  p_correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; fp text; replay jsonb; at timestamptz := clock_timestamp(); v_org uuid; x hon.saas_access_exceptions%ROWTYPE; prior jsonb; ended jsonb;
BEGIN
  IF p_exception IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) <> ARRAY['reason']
    OR jsonb_typeof(p_input->'reason') <> 'string' OR (p_input->>'reason') <> btrim(p_input->>'reason') OR length(p_input->>'reason') NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  fp := hon.saas_fingerprint(ARRAY['access.exception.revoke', p_exception::text, p_input->>'reason']);
  replay := hon.saas_claim_request(actor, p_key, 'saas.access.exception_revoke', fp, p_request_id, p_correlation_id);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT organization_id INTO v_org FROM hon.saas_access_exceptions WHERE id = p_exception;
  IF v_org IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || v_org::text, 0));
  SELECT * INTO x FROM hon.saas_access_exceptions WHERE id = p_exception FOR UPDATE;
  IF x.status <> 'GRANTED' THEN RAISE EXCEPTION 'SAAS_EXCEPTION_ENDED' USING ERRCODE = '23514'; END IF;
  prior := hon.saas_entitlement_json(v_org);
  ended := hon.saas_end_access_exception(x.id, 'REVOKED', p_input->>'reason', actor, at);
  RETURN hon.saas_record(actor, p_key, 'saas.access.exception_revoke', 'saas.access.exception_ended', 'ACCESS_EXCEPTION', x.id, v_org, prior,
    hon.saas_entitlement_json(v_org),
    jsonb_build_object('exception', (SELECT hon.saas_access_exception_json(e) FROM hon.saas_access_exceptions e WHERE e.id = x.id),
      'entitlementSuspended', ended->'entitlementSuspended', 'access', hon.saas_organization_access(v_org)), at);
END $$;

-- ---------- HQ (owner or billing operator): close lapsed exceptions ----------
-- Removing access that already lapsed grants nothing, so a billing operator may run it too. At most 200 per call.
CREATE FUNCTION hon.close_expired_saas_access_exceptions(p_subject text, p_key uuid, p_request_id uuid, p_correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; at timestamptz := clock_timestamp(); r record; x hon.saas_access_exceptions%ROWTYPE; closed jsonb := '[]'::jsonb;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, false);
  replay := hon.saas_claim_request(actor, p_key, 'saas.access.exception_close', hon.saas_fingerprint(ARRAY['access.exception.close']),
    p_request_id, p_correlation_id);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  FOR r IN SELECT id, organization_id FROM hon.saas_access_exceptions WHERE status = 'GRANTED' ORDER BY organization_id LIMIT 200 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || r.organization_id::text, 0));
    SELECT * INTO x FROM hon.saas_access_exceptions WHERE id = r.id AND status = 'GRANTED' FOR UPDATE;
    CONTINUE WHEN NOT FOUND OR hon.saas_access_exception_live(r.organization_id);
    PERFORM hon.saas_end_access_exception(x.id, 'EXPIRED', NULL, actor, at);
    closed := closed || jsonb_build_array((SELECT hon.saas_access_exception_json(e) FROM hon.saas_access_exceptions e WHERE e.id = x.id));
  END LOOP;
  RETURN hon.saas_record(actor, p_key, 'saas.access.exception_close', 'saas.access.exceptions_closed', 'ACCESS_EXCEPTION',
    '00000000-0000-4000-8000-000000000185'::uuid, NULL, NULL, jsonb_build_object('closed', jsonb_array_length(closed)),
    jsonb_build_object('closed', closed, 'asOf', hon.saas_ts(at)), at);
END $$;

-- ---------- HQ read ----------
CREATE FUNCTION hon.read_saas_access_exceptions_from_hq(p_subject text, p_org uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  IF NOT EXISTS (SELECT 1 FROM hon.organizations WHERE id = p_org) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('organizationId', p_org, 'access', hon.saas_organization_access(p_org),
    'exceptions', (SELECT coalesce(jsonb_agg(hon.saas_access_exception_json(x) ORDER BY x.granted_at DESC, x.id), '[]'::jsonb)
      FROM (SELECT * FROM hon.saas_access_exceptions WHERE organization_id = p_org ORDER BY granted_at DESC, id LIMIT 50) x),
    'asOf', hon.saas_ts(clock_timestamp()));
END $$;

-- ---------- replaced functions ----------
-- Provisioning (0022 body): the only change is the SUSPENDED entitlement and the response's access facts.
CREATE OR REPLACE FUNCTION hon.provision_school_from_hq(
  p_external_subject text,
  p_legal_name text,
  p_display_name text,
  p_school_name text,
  p_school_slug text,
  p_timezone text,
  p_initial_tier hon.plan_tier,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_request_id uuid,
  p_correlation_id uuid
)
RETURNS TABLE (
  organization_id uuid,
  school_id uuid,
  owner_role_id uuid,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor_principal_id uuid;
  v_request_id uuid;
  v_prior_fingerprint text;
  v_prior_status text;
  v_prior_response jsonb;
  v_organization_id uuid;
  v_school_id uuid;
  v_owner_role_id uuid;
  v_response jsonb;
BEGIN
  IF btrim(p_legal_name) = '' OR btrim(p_display_name) = '' OR btrim(p_school_name) = ''
    OR btrim(p_school_slug) = '' OR btrim(p_timezone) = '' OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'HON HQ tenant provisioning requires non-blank organization, school, timezone, and idempotency fields.' USING ERRCODE = 'P0001';
  END IF;

  SELECT principal.id INTO v_actor_principal_id
  FROM hon.users AS app_user
  JOIN hon.principals AS principal ON principal.user_id = app_user.id AND principal.principal_type = 'HUMAN_USER' AND principal.is_active = true
  JOIN hon.hq_operator_grants AS hq_grant ON hq_grant.principal_id = principal.id
    AND hq_grant.effective_from <= now() AND (hq_grant.effective_until IS NULL OR hq_grant.effective_until > now())
  WHERE app_user.external_subject = p_external_subject
    AND (hq_grant.hq_role = 'HON_HQ_OWNER' OR 'hq.onboarding.manage' = ANY (hq_grant.permission_codes))
  LIMIT 1;
  IF v_actor_principal_id IS NULL THEN
    RAISE EXCEPTION 'HON HQ tenant provisioning is not authorized for this account.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO hon.hq_onboarding_requests (actor_principal_id, idempotency_key, request_fingerprint, status)
  VALUES (v_actor_principal_id, p_idempotency_key, p_request_fingerprint, 'IN_PROGRESS')
  ON CONFLICT (actor_principal_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_request_id;
  IF v_request_id IS NULL THEN
    SELECT request_fingerprint, status, response_body INTO v_prior_fingerprint, v_prior_status, v_prior_response
    FROM hon.hq_onboarding_requests
    WHERE actor_principal_id = v_actor_principal_id AND idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF v_prior_fingerprint <> p_request_fingerprint THEN
      RAISE EXCEPTION 'HON HQ idempotency key was already used for a different tenant-provisioning request.' USING ERRCODE = '23505';
    END IF;
    IF v_prior_status = 'COMPLETED' AND v_prior_response IS NOT NULL THEN
      RETURN QUERY SELECT (v_prior_response->>'organizationId')::uuid, (v_prior_response->>'schoolId')::uuid, (v_prior_response->>'ownerRoleId')::uuid, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Matching HON HQ tenant-provisioning request is still in progress.' USING ERRCODE = '55P03';
  END IF;

  INSERT INTO hon.organizations (legal_name, display_name)
  VALUES (btrim(p_legal_name), btrim(p_display_name))
  RETURNING id INTO v_organization_id;
  -- D9: provisioning grants no operating access. The entitlement row exists (the requested tier is a placeholder)
  -- but is held SUSPENDED, so every status-gated function refuses it. Access comes only from the verified
  -- first payment (B6A/D7) or an explicit HQ-owner exception (hon.grant_saas_access_exception).
  INSERT INTO hon.organization_entitlements (organization_id, tier, status)
  VALUES (v_organization_id, p_initial_tier, 'SUSPENDED');
  INSERT INTO hon.schools (organization_id, name, slug, timezone)
  VALUES (v_organization_id, btrim(p_school_name), lower(btrim(p_school_slug)), btrim(p_timezone))
  RETURNING id INTO v_school_id;
  INSERT INTO hon.roles (organization_id, code, name, is_system_role)
  VALUES (v_organization_id, 'OWNER', 'School Owner', true)
  RETURNING id INTO v_owner_role_id;
  INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
  SELECT v_owner_role_id, v_organization_id, permission.code FROM hon.permissions AS permission;
  INSERT INTO hon.principal_role_grants (organization_id, school_id, principal_id, role_id, granted_by_principal_id)
  VALUES (v_organization_id, v_school_id, v_actor_principal_id, v_owner_role_id, v_actor_principal_id);

  v_response := jsonb_build_object('organizationId', v_organization_id, 'schoolId', v_school_id, 'ownerRoleId', v_owner_role_id, 'tier', p_initial_tier::text,
    'entitlementStatus', 'SUSPENDED', 'access', 'NONE');
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (v_organization_id, v_school_id, v_actor_principal_id, 'HON_HQ', 'hq.organization.provision', 'ORGANIZATION', v_organization_id, NULL, v_response, 'SUCCEEDED', p_request_id, p_correlation_id, now());
  INSERT INTO hon.outbox_events (organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
  VALUES (v_organization_id, v_school_id, 'organization.provisioned', 1, 'ORGANIZATION', v_organization_id, 1, p_correlation_id, p_request_id, v_response);
  UPDATE hon.hq_onboarding_requests SET status = 'COMPLETED', response_body = v_response, completed_at = now() WHERE id = v_request_id;
  RETURN QUERY SELECT v_organization_id, v_school_id, v_owner_role_id, false;
END;
$$;

-- HQ tier transition (0146 body): refused while an exception is live.
CREATE OR REPLACE FUNCTION hon.transition_organization_entitlement_from_hq(
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
    OR prior.effective_from > clock_timestamp() OR (prior.effective_until IS NOT NULL AND prior.effective_until <= clock_timestamp())
    -- D9: an HQ-owner exception fixes its own scope; an operator tier change can never widen it.
    OR hon.saas_access_exception_live(p_organization_id) THEN
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

-- HON OS purchase refusal (0183 body): refused while an exception is live.
CREATE OR REPLACE FUNCTION hon.saas_hon_os_refusal(p_org uuid, o hon.saas_offer_set_offers, p_at timestamptz) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE ent hon.organization_entitlements%ROWTYPE; v_set hon.saas_offer_sets%ROWTYPE; used jsonb; awaiting boolean;
BEGIN
  SELECT * INTO v_set FROM hon.saas_offer_sets WHERE id = o.set_id;
  IF o.id IS NULL OR v_set.status IS DISTINCT FROM 'PUBLISHED' OR NOT hon.saas_hon_os_offer_on_sale(o, p_at) THEN RETURN 'SAAS_OFFER_NOT_AVAILABLE'; END IF;
  IF hon.saas_hon_os_recurring(o) IS NULL THEN RETURN 'SAAS_OFFER_TERMS_UNSUPPORTED'; END IF;
  SELECT * INTO ent FROM hon.organization_entitlements e WHERE e.organization_id = p_org;
  -- D7: awaiting its first payment (only while paid access is ACTIVE), the held entitlement is not required to be
  -- active; the verified payment activates it. Otherwise the 0182 rule: an ACTIVE COMPLETE entitlement in effect.
  -- D9: free access under an HQ-owner exception is never a purchase basis; HQ revokes it (or it ends) first.
  IF hon.saas_access_exception_live(p_org) THEN RETURN 'SAAS_ACCESS_EXCEPTION_ACTIVE'; END IF;
  awaiting := hon.saas_access_program_active() AND hon.saas_awaiting_first_payment(p_org);
  IF ent.organization_id IS NULL OR NOT awaiting AND (ent.status <> 'ACTIVE' OR ent.effective_from > p_at
      OR (ent.effective_until IS NOT NULL AND ent.effective_until <= p_at) OR hon.saas_awaiting_first_payment(p_org)) THEN
    RETURN 'SAAS_ENTITLEMENT_NOT_ACTIVE';
  END IF;
  IF NOT awaiting AND ent.tier::text <> 'COMPLETE' THEN RETURN 'SAAS_ENTITLEMENT_MISMATCH'; END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_subscriptions s WHERE s.organization_id = p_org AND s.status <> 'VOIDED') THEN RETURN 'SAAS_SUBSCRIPTION_EXISTS'; END IF;
  IF o.eligibility = 'NEW_ORGANIZATIONS_ONLY' AND EXISTS (SELECT 1 FROM hon.saas_payment_evidence e
      WHERE e.organization_id = p_org AND e.kind = 'PAYMENT_RECEIVED') THEN
    RETURN 'SAAS_OFFER_NOT_ELIGIBLE';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_checkout_sessions c WHERE c.organization_id = p_org AND c.status IN ('CREATED','OPEN') AND c.expires_at > p_at) THEN
    RETURN 'SAAS_CHECKOUT_OPEN';
  END IF;
  IF o.sale_limit IS NOT NULL AND hon.saas_hon_os_offer_usage(o.id, p_at, NULL) >= o.sale_limit THEN RETURN 'SAAS_OFFER_SOLD_OUT'; END IF;
  IF o.founder THEN
    used := hon.saas_hon_os_founder_usage(p_at, NULL);
    IF (used->>'allocated')::integer + (used->>'held')::integer >= coalesce(v_set.founder_total_limit, 0) THEN RETURN 'SAAS_FOUNDER_SOLD_OUT'; END IF;
  END IF;
  RETURN NULL;
END $$;

-- HON OS offers read (0182 body): the new refusal reads as NOT_ELIGIBLE_ENTITLEMENT, never ELIGIBLE.
CREATE OR REPLACE FUNCTION hon.read_saas_hon_os_offers_for_school(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; at timestamptz := clock_timestamp(); pub hon.saas_offer_sets%ROWTYPE; chk hon.saas_checkout_sessions%ROWTYPE;
  sub hon.saas_subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  SELECT * INTO pub FROM hon.saas_offer_sets WHERE status = 'PUBLISHED';
  SELECT * INTO chk FROM hon.saas_checkout_sessions WHERE organization_id = actor.organization_id AND hon_os_offer_id IS NOT NULL
    ORDER BY created_at DESC, id LIMIT 1;
  SELECT * INTO sub FROM hon.saas_subscriptions WHERE organization_id = actor.organization_id AND status <> 'VOIDED' AND source = 'HON_OS_OFFER';
  RETURN jsonb_build_object('schoolId',p_school,'product',hon.saas_hon_os_product_json(),'offerSetVersion',pub.set_version,
    'termsReference',pub.terms_reference,
    -- Eligibility is the server's purchase decision for this organization now; the client never re-derives it.
    'offers',(SELECT coalesce(jsonb_agg((hon.saas_offer_json(o) - ARRAY['salesStop','salesOpensAt','position','saleLimit'])
        || jsonb_build_object('recurringBilling',hon.saas_hon_os_recurring(o),'eligibility',CASE r.refusal
          WHEN 'SAAS_OFFER_TERMS_UNSUPPORTED' THEN 'NOT_AVAILABLE_TERMS'
          WHEN 'SAAS_ENTITLEMENT_NOT_ACTIVE' THEN 'NOT_ELIGIBLE_ENTITLEMENT' WHEN 'SAAS_ACCESS_EXCEPTION_ACTIVE' THEN 'NOT_ELIGIBLE_ENTITLEMENT' WHEN 'SAAS_ENTITLEMENT_MISMATCH' THEN 'NOT_ELIGIBLE_ENTITLEMENT'
          WHEN 'SAAS_SUBSCRIPTION_EXISTS' THEN 'NOT_ELIGIBLE_EXISTING_SUBSCRIPTION' WHEN 'SAAS_OFFER_NOT_ELIGIBLE' THEN 'NOT_ELIGIBLE_PRIOR_PURCHASE'
          WHEN 'SAAS_CHECKOUT_OPEN' THEN 'CHECKOUT_IN_PROGRESS' WHEN 'SAAS_OFFER_SOLD_OUT' THEN 'SOLD_OUT'
          WHEN 'SAAS_FOUNDER_SOLD_OUT' THEN 'FOUNDER_SOLD_OUT' WHEN 'SAAS_OFFER_NOT_AVAILABLE' THEN 'NOT_AVAILABLE' ELSE 'ELIGIBLE' END)
      ORDER BY o.position),'[]'::jsonb)
      FROM hon.saas_offer_set_offers o CROSS JOIN LATERAL (SELECT hon.saas_hon_os_refusal(actor.organization_id, o, at) refusal) r
      WHERE o.set_id = pub.id AND hon.saas_hon_os_offer_on_sale(o, at)),
    'purchase',CASE WHEN (SELECT status FROM hon.saas_payment_program WHERE program_id = 1) = 'TEST_MODE' THEN 'TEST_MODE' ELSE 'UNAVAILABLE' END,
    'checkout',CASE WHEN chk.id IS NULL THEN NULL ELSE hon.saas_checkout_json(chk) END,
    'purchased',CASE WHEN sub.id IS NULL THEN NULL ELSE jsonb_build_object('subscriptionId',sub.id,'offerId',sub.hon_os_offer_id,
      'offerKind',sub.offer_kind,'displayName',sub.accepted_offer->>'displayName','priceMinor',sub.price_minor,
      'recurringBilling',sub.accepted_offer->>'recurringBilling','offerSetVersion',(sub.accepted_offer->>'offerSetVersion')::integer,
      'acceptedOfferDigest',sub.accepted_offer_digest,'status',sub.status,'serviceStartedAt',hon.saas_ts(sub.service_started_at)) END,
    'paidAccessProgram',CASE WHEN hon.saas_access_program_active() THEN 'ACTIVE' ELSE 'INACTIVE' END,
    'chargesEnabled',false);
END $$;

-- ---------- grants ----------
DO $$ DECLARE r text; col text; f text; BEGIN
  ALTER TABLE hon.saas_access_exceptions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE hon.saas_access_exceptions FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE hon.saas_access_exceptions FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.saas_access_exceptions FROM %I',r);
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='hon.saas_access_exceptions'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.saas_access_exceptions FROM PUBLIC',col);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.saas_access_exceptions FROM %I',col,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_saas_access_exceptions()','hon.guard_saas_access_exception_grant()','hon.saas_access_exception_live(uuid)',
    'hon.saas_access_exception_json(hon.saas_access_exceptions)','hon.saas_end_access_exception(uuid,text,text,uuid,timestamp with time zone)',
    'hon.grant_saas_access_exception(text,uuid,jsonb,uuid,uuid,uuid)','hon.revoke_saas_access_exception(text,uuid,jsonb,uuid,uuid,uuid)',
    'hon.close_expired_saas_access_exceptions(text,uuid,uuid,uuid)','hon.read_saas_access_exceptions_from_hq(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.grant_saas_access_exception(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.revoke_saas_access_exception(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.close_expired_saas_access_exceptions(text,uuid,uuid,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_saas_access_exceptions_from_hq(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
