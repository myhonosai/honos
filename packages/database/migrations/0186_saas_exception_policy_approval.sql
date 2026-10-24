BEGIN;

-- D10: exception-only governance. NO approved/proposed decision is seeded. Paid-access terms, programs,
-- existing entitlements and exceptions remain untouched. 0179/0180 remain reserved.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
END $$;

CREATE TABLE hon.saas_exception_policy_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision integer NOT NULL UNIQUE CHECK (revision BETWEEN 1 AND 999999999),
  status text NOT NULL CHECK (status IN ('PROPOSED','APPROVED','WITHDRAWN','REVOKED')),
  terms_version integer NOT NULL REFERENCES hon.saas_access_policy_terms(policy_version) ON DELETE RESTRICT,
  max_days integer NOT NULL CHECK (max_days BETWEEN 1 AND 90),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK (isfinite(valid_until)),
  reason text NOT NULL CHECK (reason=btrim(reason) AND length(reason) BETWEEN 10 AND 500),
  confirmation text,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  CHECK (isfinite(valid_from) AND valid_until>valid_from),
  CHECK ((status='APPROVED' AND confirmation IS NOT NULL AND confirmation='APPROVE_ACCESS_EXCEPTION_POLICY_ONLY') OR (status<>'APPROVED' AND confirmation IS NULL)),
  FOREIGN KEY(actor_principal_id,idempotency_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key) ON DELETE RESTRICT,
  UNIQUE(actor_principal_id,idempotency_key)
);
CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.saas_exception_policy_decisions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_exception_policy_decisions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- NULL is retained only for pre-D10 historical records. The INSERT guard requires a binding on every new row.
ALTER TABLE hon.saas_access_exceptions ADD COLUMN policy_approval_id uuid REFERENCES hon.saas_exception_policy_decisions(id) ON DELETE RESTRICT;

CREATE FUNCTION hon.saas_exception_policy_json(p hon.saas_exception_policy_decisions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('approvalId',p.id,'revision',p.revision,'status',p.status,'termsVersion',p.terms_version,
    'maxDays',p.max_days,'validFrom',hon.saas_ts(p.valid_from),'validUntil',hon.saas_ts(p.valid_until),
    'reason',p.reason,'actorPrincipalId',p.actor_principal_id,'recordedAt',hon.saas_ts(p.recorded_at))
$$;

-- Lock order: IAM -> request -> organization/entitlement if applicable -> policy. Policy commands never
-- acquire organization/entitlement locks. Latest decision wins; there is no fallback to an old approval.
CREATE FUNCTION hon.saas_require_exception_policy() RETURNS hon.saas_exception_policy_decisions
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE p hon.saas_exception_policy_decisions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.access.exception.policy',0));
  SELECT * INTO p FROM hon.saas_exception_policy_decisions ORDER BY revision DESC LIMIT 1;
  IF p.id IS NULL OR p.status<>'APPROVED' OR p.valid_from>clock_timestamp() OR p.valid_until<=clock_timestamp()
    OR p.terms_version IS DISTINCT FROM (SELECT max(policy_version) FROM hon.saas_access_policy_terms) THEN
    RAISE EXCEPTION 'SAAS_EXCEPTION_POLICY_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN p;
END $$;

CREATE FUNCTION hon.guard_saas_exception_policy_decision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE subject text; actor uuid; t hon.saas_access_policy_terms%ROWTYPE; latest integer;
BEGIN
  SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=NEW.actor_principal_id;
  actor:=hon.require_saas_hq_actor(subject,true);
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.access.exception.policy',0));
  PERFORM hon.require_saas_hq_actor(subject,true);
  SELECT coalesce(max(revision),0) INTO latest FROM hon.saas_exception_policy_decisions;
  SELECT * INTO t FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1;
  IF actor IS DISTINCT FROM NEW.actor_principal_id OR NEW.revision<>latest+1 OR NEW.terms_version IS DISTINCT FROM t.policy_version
    OR t.exception_authority IS DISTINCT FROM 'HQ_OWNER' OR NEW.max_days>t.exception_max_days
    OR NOT EXISTS(SELECT 1 FROM hon.saas_requests r WHERE r.actor_principal_id=actor AND r.idempotency_key=NEW.idempotency_key
      AND r.operation='saas.access.exception_policy' AND r.status='IN_PROGRESS') THEN
    RAISE EXCEPTION 'SAAS_EXCEPTION_POLICY_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saas_exception_policy_authority BEFORE INSERT ON hon.saas_exception_policy_decisions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_exception_policy_decision();

CREATE FUNCTION hon.verify_saas_exception_policy_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject text; data jsonb;
BEGIN
  SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=NEW.actor_principal_id;
  PERFORM hon.require_saas_hq_actor(subject,true);
  IF NEW.status='APPROVED' AND NEW.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'SAAS_EXCEPTION_POLICY_WINDOW_INVALID' USING ERRCODE='23514'; END IF;
  data:=hon.saas_exception_policy_json(NEW);
  IF NOT EXISTS(SELECT 1 FROM hon.saas_requests r JOIN hon.saas_audit a USING(actor_principal_id,idempotency_key)
    JOIN hon.saas_outbox o ON o.audit_id=a.id
    WHERE r.actor_principal_id=NEW.actor_principal_id AND r.idempotency_key=NEW.idempotency_key AND r.status='COMPLETED'
      AND r.operation='saas.access.exception_policy' AND r.response_body->'policy'=data
      AND a.action_code='saas.access.exception_policy' AND a.entity_id=NEW.id AND a.next_state=data
      AND o.event_type='saas.access.exception_policy_decided') THEN
    RAISE EXCEPTION 'SAAS_EXCEPTION_POLICY_EVIDENCE_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER saas_exception_policy_evidence AFTER INSERT ON hon.saas_exception_policy_decisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_exception_policy_evidence();

CREATE FUNCTION hon.verify_saas_exception_policy_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE p hon.saas_exception_policy_decisions%ROWTYPE; subject text;
BEGIN
  p:=hon.saas_require_exception_policy();
  SELECT u.external_subject INTO subject FROM hon.principals x JOIN hon.users u ON u.id=x.user_id WHERE x.id=NEW.granted_by_principal_id;
  PERFORM hon.require_saas_hq_actor(subject,true);
  IF NEW.policy_approval_id IS DISTINCT FROM p.id OR NOT EXISTS (
    SELECT 1 FROM hon.saas_requests r JOIN hon.saas_audit a USING(actor_principal_id,idempotency_key)
    JOIN hon.saas_outbox o ON o.audit_id=a.id
    WHERE r.actor_principal_id=NEW.granted_by_principal_id AND r.status='COMPLETED' AND r.operation='saas.access.exception_grant'
      AND a.entity_id=NEW.id AND a.organization_id=NEW.organization_id AND a.action_code='saas.access.exception_grant'
      AND a.next_state=NEW.granted_entitlement AND o.event_type='saas.access.exception_granted'
      AND r.response_body->'exception'->>'exceptionId'=NEW.id::text
      AND r.response_body->'exception'->'governingPolicy'->>'approvalId'=p.id::text
      AND r.response_body->'exception'->>'maxDays'=NEW.max_days::text) THEN
    RAISE EXCEPTION 'SAAS_EXCEPTION_POLICY_EVIDENCE_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER saas_exception_policy_binding AFTER INSERT ON hon.saas_access_exceptions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_exception_policy_binding();

CREATE FUNCTION hon.decide_saas_exception_policy(p_subject text,p_input jsonb,p_key uuid,p_request_id uuid,p_correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; replay jsonb; prior_policy hon.saas_exception_policy_decisions%ROWTYPE; made hon.saas_exception_policy_decisions%ROWTYPE;
  expected integer; decision text; t hon.saas_access_policy_terms%ROWTYPE; v_from timestamptz; v_until timestamptz; v_days integer; v_terms integer;
  ts constant text:='^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SAAS_EXCEPTION_POLICY_ISOLATION_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR jsonb_typeof(p_input->'decision') IS DISTINCT FROM 'string'
    OR (p_input->>'decision') NOT IN ('PROPOSED','APPROVED','WITHDRAWN','REVOKED')
    OR jsonb_typeof(p_input->'expectedRevision') IS DISTINCT FROM 'number' OR (p_input->>'expectedRevision') !~ '^(0|[1-9][0-9]{0,8})$'
    OR jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR (p_input->>'reason')<>btrim(p_input->>'reason')
    OR length(p_input->>'reason') NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  decision:=p_input->>'decision'; expected:=(p_input->>'expectedRevision')::integer;
  IF decision IN ('PROPOSED','APPROVED') THEN
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) <> CASE WHEN decision='APPROVED'
      THEN ARRAY['confirmation','decision','expectedRevision','maxDays','reason','termsVersion','validFrom','validUntil']
      ELSE ARRAY['decision','expectedRevision','maxDays','reason','termsVersion','validFrom','validUntil'] END
      OR jsonb_typeof(p_input->'termsVersion') IS DISTINCT FROM 'number' OR (p_input->>'termsVersion') !~ '^[1-9][0-9]{0,5}$'
      OR jsonb_typeof(p_input->'maxDays') IS DISTINCT FROM 'number' OR (p_input->>'maxDays') !~ '^([1-9]|[1-8][0-9]|90)$'
      OR jsonb_typeof(p_input->'validFrom') IS DISTINCT FROM 'string' OR (p_input->>'validFrom') !~ ts
      OR jsonb_typeof(p_input->'validUntil') IS DISTINCT FROM 'string' OR (p_input->>'validUntil') !~ ts
      OR (decision='APPROVED' AND p_input->>'confirmation' IS DISTINCT FROM 'APPROVE_ACCESS_EXCEPTION_POLICY_ONLY') THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';
    END IF;
    v_from:=(p_input->>'validFrom')::timestamptz; v_until:=(p_input->>'validUntil')::timestamptz;
    v_days:=(p_input->>'maxDays')::integer; v_terms:=(p_input->>'termsVersion')::integer;
  ELSIF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k)<>ARRAY['decision','expectedRevision','reason'] THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_saas_hq_actor(p_subject,true);
  LOCK TABLE hon.users,hon.principals,hon.hq_operator_grants,hon.family_access_grants IN SHARE MODE;
  actor:=hon.require_saas_hq_actor(p_subject,true);
  replay:=hon.saas_claim_request(actor,p_key,'saas.access.exception_policy',hon.saas_fingerprint(ARRAY['access.exception.policy',p_input::text]),p_request_id,p_correlation_id);
  IF replay IS NOT NULL THEN PERFORM hon.require_saas_hq_actor(p_subject,true); RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.access.exception.policy',0));
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  SELECT * INTO prior_policy FROM hon.saas_exception_policy_decisions ORDER BY revision DESC LIMIT 1;
  IF expected<>coalesce(prior_policy.revision,0) THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF decision IN ('WITHDRAWN','REVOKED') THEN
    IF prior_policy.id IS NULL OR prior_policy.status NOT IN ('PROPOSED','APPROVED') THEN RAISE EXCEPTION 'SAAS_EXCEPTION_POLICY_REQUIRED' USING ERRCODE='23514'; END IF;
    v_from:=prior_policy.valid_from; v_until:=prior_policy.valid_until; v_days:=prior_policy.max_days; v_terms:=prior_policy.terms_version;
  ELSE
    IF v_until<=v_from OR v_until<=clock_timestamp() THEN RAISE EXCEPTION 'SAAS_EXCEPTION_POLICY_WINDOW_INVALID' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT * INTO t FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1;
  IF t.policy_version IS DISTINCT FROM v_terms OR t.exception_authority IS DISTINCT FROM 'HQ_OWNER' OR v_days>t.exception_max_days THEN
    RAISE EXCEPTION 'SAAS_EXCEPTION_POLICY_LIMIT' USING ERRCODE='23514';
  END IF;
  INSERT INTO hon.saas_exception_policy_decisions(revision,status,terms_version,max_days,valid_from,valid_until,reason,confirmation,actor_principal_id,idempotency_key,recorded_at)
    VALUES(expected+1,decision,v_terms,v_days,v_from,v_until,p_input->>'reason',p_input->>'confirmation',actor,p_key,clock_timestamp()) RETURNING * INTO made;
  replay:=hon.saas_record(actor,p_key,'saas.access.exception_policy','saas.access.exception_policy_decided','ACCESS_EXCEPTION_POLICY',made.id,NULL,
    CASE WHEN prior_policy.id IS NULL THEN NULL ELSE hon.saas_exception_policy_json(prior_policy) END,hon.saas_exception_policy_json(made),
    jsonb_build_object('policy',hon.saas_exception_policy_json(made)),clock_timestamp());
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  RETURN replay;
END $$;

CREATE FUNCTION hon.read_saas_exception_policy(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE history jsonb; p jsonb; state text; at timestamptz:=clock_timestamp();
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,false);
  SELECT coalesce(jsonb_agg(hon.saas_exception_policy_json(x) ORDER BY revision DESC),'[]'::jsonb) INTO history
    FROM hon.saas_exception_policy_decisions x WHERE x.id IN (SELECT id FROM hon.saas_exception_policy_decisions ORDER BY revision DESC LIMIT 100);
  p:=history->0;
  state:=CASE WHEN p IS NULL THEN 'ABSENT' WHEN p->>'status'<>'APPROVED' THEN p->>'status'
    WHEN (p->>'termsVersion')::int IS DISTINCT FROM (SELECT max(policy_version) FROM hon.saas_access_policy_terms) THEN 'SUPERSEDED'
    WHEN (p->>'validFrom')::timestamptz>at THEN 'SCHEDULED' WHEN (p->>'validUntil')::timestamptz<=at THEN 'EXPIRED' ELSE 'ACTIVE' END;
  RETURN jsonb_build_object('scope','ACCESS_EXCEPTIONS_ONLY','current',p,'effectiveStatus',state,'history',history,'historyLimit',100,'asOf',hon.saas_ts(at),
    'termsStatus',(SELECT status FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1),
    'paidAccessProgram',(SELECT status FROM hon.saas_access_program),'aiCreditProgram',(SELECT status FROM hon.saas_credit_program));
END $$;

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
  'saas.access.exception_grant','saas.access.exception_revoke','saas.access.exception_close','saas.access.exception_policy'));

ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (entity_type IN ('CATALOG','FOUNDER_RESERVATION','SUBSCRIPTION',
  'INVOICE','PAYMENT_EVIDENCE','CREDIT_PROGRAM','COST_EVIDENCE','PRICING','ALLOWANCE','CREDIT_RESERVATION','REFUND_REQUEST','REWARD_FULFILLMENT',
  'REWARD_APPLICATION','REFERRAL_ALERT','PAYMENT_PROGRAM','CHECKOUT','PROVIDER_EVENT','ACCESS_STATE','OFFER_SET','OFFER','ACCESS_EXCEPTION','ACCESS_EXCEPTION_POLICY'));

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
  'saas.access.initialized','saas.access.exception_granted','saas.access.exception_ended','saas.access.exceptions_closed','saas.access.exception_policy_decided'));

CREATE OR REPLACE FUNCTION hon.grant_saas_access_exception(p_subject text, p_org uuid, p_input jsonb, p_key uuid, p_request_id uuid,
  p_correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; fp text; replay jsonb; at timestamptz; ts constant text := '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
  v_school uuid; v_starts timestamptz; v_expires timestamptz; v_expected integer; t hon.saas_access_policy_terms%ROWTYPE;
  approved_policy hon.saas_exception_policy_decisions%ROWTYPE; ent hon.organization_entitlements%ROWTYPE; prior jsonb; nxt jsonb; open_x hon.saas_access_exceptions%ROWTYPE; v_id uuid; result jsonb;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SAAS_EXCEPTION_POLICY_ISOLATION_REQUIRED' USING ERRCODE='22023'; END IF;
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
  -- Authority holds through the mutation: the shared lock stops any user, principal, HQ grant or family grant change
  -- until this transaction ends, and the rechecks after every wait refuse an owner whose grant lapsed by the clock.
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  fp := hon.saas_fingerprint(ARRAY['access.exception.grant', p_org::text, v_school::text, p_input->>'purpose', p_input->>'reason',
    p_input->>'scopeTier', p_input->>'startsAt', p_input->>'expiresAt', v_expected::text]);
  replay := hon.saas_claim_request(actor, p_key, 'saas.access.exception_grant', fp, p_request_id, p_correlation_id);
  IF replay IS NOT NULL THEN PERFORM hon.require_saas_hq_actor(p_subject,true); RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || p_org::text, 0));
  PERFORM 1 FROM hon.organizations WHERE id = p_org AND status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM hon.schools WHERE id = v_school AND organization_id = p_org AND status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, true);
  approved_policy := hon.saas_require_exception_policy();
  PERFORM hon.require_saas_hq_actor(p_subject, true);
  at := clock_timestamp();
  IF ent.version <> v_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  SELECT * INTO t FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1;
  IF t.exception_authority IS DISTINCT FROM 'HQ_OWNER' OR t.exception_max_days IS NULL THEN RAISE EXCEPTION 'SAAS_POLICY_UNDECIDED' USING ERRCODE = '23514'; END IF;
  IF v_starts < at - interval '5 minutes' OR v_starts > at + interval '30 days' OR v_expires <= v_starts OR v_expires <= at THEN
    RAISE EXCEPTION 'SAAS_EXCEPTION_WINDOW_INVALID' USING ERRCODE = '23514';
  END IF;
  IF v_expires > v_starts + make_interval(days => approved_policy.max_days) THEN RAISE EXCEPTION 'SAAS_EXCEPTION_TOO_LONG' USING ERRCODE = '23514'; END IF;
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
      prior_entitlement, granted_entitlement, granted_entitlement_version, granted_by_principal_id, granted_at, status, policy_approval_id)
    VALUES (p_org, v_school, p_input->>'purpose', p_input->>'reason', p_input->>'scopeTier', v_starts, v_expires, t.policy_version,
      approved_policy.max_days, prior, nxt, ent.version + 1, actor, at, 'GRANTED', approved_policy.id)
    RETURNING id INTO v_id;
  result := hon.saas_record(actor, p_key, 'saas.access.exception_grant', 'saas.access.exception_granted', 'ACCESS_EXCEPTION', v_id, p_org, prior, nxt,
    jsonb_build_object('exception', (SELECT hon.saas_access_exception_json(x) FROM hon.saas_access_exceptions x WHERE x.id = v_id),
      'access', hon.saas_organization_access(p_org)), at);
  PERFORM hon.require_saas_hq_actor(p_subject, true);
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION hon.guard_saas_access_exception_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE t hon.saas_access_policy_terms%ROWTYPE; approved_policy hon.saas_exception_policy_decisions%ROWTYPE;
BEGIN
  approved_policy := hon.saas_require_exception_policy();
  SELECT * INTO t FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1;
  IF NEW.status <> 'GRANTED' OR t.policy_version IS DISTINCT FROM NEW.policy_version OR t.exception_authority IS DISTINCT FROM 'HQ_OWNER'
    OR approved_policy.max_days IS DISTINCT FROM NEW.max_days
    OR approved_policy.id IS DISTINCT FROM NEW.policy_approval_id OR approved_policy.terms_version IS DISTINCT FROM NEW.policy_version
    OR NEW.starts_at < clock_timestamp() - interval '5 minutes' OR NEW.starts_at > clock_timestamp() + interval '30 days'
    OR NEW.expires_at <= clock_timestamp() OR NEW.granted_at < approved_policy.recorded_at
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

CREATE OR REPLACE FUNCTION hon.saas_access_exception_json(x hon.saas_access_exceptions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('exceptionId',x.id,'organizationId',x.organization_id,'schoolId',x.school_id,'purpose',x.purpose,'reason',x.reason,
    'scopeTier',x.scope_tier,'capabilities',to_jsonb(hon.saas_plan_capabilities(x.scope_tier)),'aiCredits','NONE',
    'governingPolicy',(SELECT jsonb_build_object('approvalId',p.id,'revision',p.revision,'termsVersion',p.terms_version,'maxDays',p.max_days) FROM hon.saas_exception_policy_decisions p WHERE p.id=x.policy_approval_id),
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


DO $$ DECLARE r text; c text; f text; BEGIN
  ALTER TABLE hon.saas_exception_policy_decisions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE hon.saas_exception_policy_decisions FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE hon.saas_exception_policy_decisions FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.saas_exception_policy_decisions FROM %I',r);
  END LOOP;
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid='hon.saas_exception_policy_decisions'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.saas_exception_policy_decisions FROM PUBLIC',c);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.saas_exception_policy_decisions FROM %I',c,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_saas_exception_policy_decision()','hon.verify_saas_exception_policy_evidence()','hon.verify_saas_exception_policy_binding()','hon.saas_exception_policy_json(hon.saas_exception_policy_decisions)','hon.saas_require_exception_policy()','hon.decide_saas_exception_policy(text,jsonb,uuid,uuid,uuid)','hon.read_saas_exception_policy(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.decide_saas_exception_policy(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_saas_exception_policy(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
