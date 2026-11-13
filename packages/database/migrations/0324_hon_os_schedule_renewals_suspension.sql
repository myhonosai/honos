BEGIN;

-- 0324: renewals, failed payments, grace, suspension and restore on the schedule path (David's suspension policy of
-- 2026-11-02, recorded as access terms v2 in 0192). TEST provider only; HON never charges or retries a card.
--   * Grace: a recurring plan keeps full access for 7 days after its last paid period ends (0235). During that time the
--     school's access standing reports the payment issue with the due date and the grace end (OWNER_NOTIFIED_IN_APP).
--   * Suspension after grace: a worker command, per binding, suspends an ACTIVE recurring plan whose grace has passed
--     with no later paid period: entitlement SUSPENDED and an APPLIED PAST_DUE_SUSPENSION naming the terms, the binding
--     and the last paid period. That opens the 0192 verified-owner read-only window (90 days). Billing stays ACTIVE so
--     the school can still pay. Safe to repeat. A lifetime plan is never past due.
--   * Restore: the verified payment of the overdue period (the one starting where the last paid period ended) restores
--     access at once: entitlement ACTIVE to that period's end plus grace, SCHEDULE_ACCESS_RESTORED recorded; the owner
--     window ends with the entitlement version. A payment that leaves a gap stays in HQ review.
--   * Terms v2 is still PROPOSED in the database; each suspension records the version it applied. The paid-access
--     program stays INACTIVE, so nothing here runs for a real school.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS schedule renewals require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS schedule renewals require a restricted runtime';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.saas_access_policy_terms WHERE policy_version=2 AND grace_days=7 AND owner_read_only_days=90) THEN
    RAISE EXCEPTION 'access terms v2 drifted';
  END IF;
END $$;

-- ---------- access transitions: schedule suspension and restore ----------
ALTER TABLE hon.saas_access_transitions DROP CONSTRAINT saas_access_transitions_kind_check;
ALTER TABLE hon.saas_access_transitions ADD CONSTRAINT saas_access_transitions_kind_check CHECK (kind IN ('AWAITING_FIRST_PAYMENT',
  'FIRST_PAYMENT_ACTIVATION','PAST_DUE_SUSPENSION','SCHEDULE_FIRST_PAYMENT_ACTIVATION','SCHEDULE_RENEWAL_EXTENSION','SCHEDULE_REFUND_ENDED',
  'SCHEDULE_ACCESS_RESTORED'));
-- Schedule kinds always name their binding and paid period; a past-due suspension names them when it came from a binding.
ALTER TABLE hon.saas_access_transitions DROP CONSTRAINT saas_access_transitions_schedule_check;
ALTER TABLE hon.saas_access_transitions ADD CONSTRAINT saas_access_transitions_schedule_check CHECK (
  CASE WHEN kind IN ('SCHEDULE_FIRST_PAYMENT_ACTIVATION','SCHEDULE_RENEWAL_EXTENSION','SCHEDULE_REFUND_ENDED','SCHEDULE_ACCESS_RESTORED')
    THEN binding_id IS NOT NULL AND paid_period_id IS NOT NULL
    WHEN kind = 'PAST_DUE_SUSPENSION' THEN (binding_id IS NULL) = (paid_period_id IS NULL)
    ELSE binding_id IS NULL AND paid_period_id IS NULL END);
-- A suspension names the period it followed, which already applied to access; each period still applies once otherwise.
DROP INDEX hon.saas_access_one_applied_per_paid_period;
CREATE UNIQUE INDEX saas_access_one_applied_per_paid_period ON hon.saas_access_transitions (paid_period_id)
  WHERE outcome = 'APPLIED' AND paid_period_id IS NOT NULL AND kind NOT IN ('SCHEDULE_REFUND_ENDED','PAST_DUE_SUSPENSION');
CREATE UNIQUE INDEX saas_access_one_suspension_per_paid_period ON hon.saas_access_transitions (paid_period_id)
  WHERE kind = 'PAST_DUE_SUSPENSION' AND outcome = 'APPLIED' AND paid_period_id IS NOT NULL;

-- The suspension command's audit action and outbox event.
DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_action_code_check';
  ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
  EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR action_code IN (''saas.access.past_due_suspension''))';
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_outbox'::regclass AND conname='saas_outbox_event_type_check';
  ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
  EXECUTE 'ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR event_type IN (''saas.access.suspended''))';
END $$;

-- The binding's suspension that is in force now: the latest applied past-due suspension of the binding that produced the
-- entitlement's current SUSPENDED version. NULL when none is in force.
CREATE FUNCTION hon.saas_schedule_current_suspension(p_binding uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT t.id FROM hon.saas_access_transitions t JOIN hon.organization_entitlements e ON e.organization_id = t.organization_id
  WHERE t.binding_id = p_binding AND t.kind = 'PAST_DUE_SUSPENSION' AND t.outcome = 'APPLIED' AND e.status = 'SUSPENDED'
    AND (t.next_entitlement->>'version')::integer = e.version
  ORDER BY t.occurred_at DESC, t.id DESC LIMIT 1
$$;

-- ---------- worker: suspend one past-due plan after grace ----------
-- The database decides from its own clock and records; the worker only names a binding. Refuses anything not past due.
CREATE FUNCTION hon.record_saas_schedule_past_due_suspension(p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; org uuid; b hon.saas_schedule_bindings%ROWTYPE; ent hon.organization_entitlements%ROWTYPE;
  st hon.saas_access_states%ROWTYPE; last_period uuid; terms integer; key uuid; replay jsonb; prior jsonb; nxt jsonb;
  at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  IF p_binding IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.saas_refuse_context(); PERFORM hon.saas_schedule_payment_program();
  actor := hon.saas_payment_actor();
  SELECT organization_id INTO org FROM hon.saas_schedule_bindings WHERE id = p_binding;
  IF org IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  -- Canonical order: organization -> binding row -> entitlement -> access state.
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||org::text,0));
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id = p_binding FOR UPDATE;
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = org FOR UPDATE;
  SELECT * INTO st FROM hon.saas_access_states WHERE organization_id = org FOR UPDATE;
  SELECT id INTO last_period FROM hon.saas_schedule_paid_periods WHERE binding_id = b.id AND covered_ends_at = st.paid_through
    ORDER BY recorded_at DESC, id DESC LIMIT 1;
  IF last_period IS NULL THEN RAISE EXCEPTION 'SAAS_SCHEDULE_NOT_PAST_DUE' USING ERRCODE = '23514'; END IF;
  -- One deterministic key per lapsed period: a repeat run returns the first result.
  key := md5('saas.access.past_due_suspension:'||last_period::text)::uuid;
  replay := hon.saas_claim_request(actor, key, 'saas.access.past_due_suspension',
    hon.saas_fingerprint(ARRAY['saas.access.past_due_suspension', b.id::text, last_period::text]), key, key);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF b.status <> 'ACTIVE' OR b.requirements->>'billingInterval' NOT IN ('MONTHLY','ANNUAL')
    OR st.state IS DISTINCT FROM 'PAYMENT_ACTIVE' OR st.activation_source IS DISTINCT FROM 'SCHEDULE_BINDING' OR st.binding_id IS DISTINCT FROM b.id
    OR NOT isfinite(st.paid_through) OR at < st.paid_through + hon.saas_schedule_access_grace()
    OR ent.organization_id IS NULL OR ent.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'SAAS_SCHEDULE_NOT_PAST_DUE' USING ERRCODE = '23514';
  END IF;
  SELECT policy_version INTO terms FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1;
  prior := hon.saas_entitlement_json(org);
  UPDATE hon.organization_entitlements SET status = 'SUSPENDED', version = version + 1, updated_at = at
    WHERE organization_id = org AND version = ent.version;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  nxt := hon.saas_entitlement_json(org);
  INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, policy_version,
      prior_entitlement, next_entitlement, actor_principal_id, occurred_at)
    VALUES (org, 'PAST_DUE_SUSPENSION', 'APPLIED', 'RENEWAL_UNPAID_AFTER_GRACE', b.id, last_period, terms, prior, nxt, actor, at);
  result := jsonb_build_object('bindingId', b.id, 'outcome', 'SUSPENDED', 'paidThrough', hon.saas_ts(st.paid_through),
    'graceEndedAt', hon.saas_ts(st.paid_through + hon.saas_schedule_access_grace()), 'suspendedAt', hon.saas_ts(at),
    'ownerReadOnlyUntil', hon.saas_ts(at + make_interval(days => (SELECT owner_read_only_days FROM hon.saas_access_policy_terms WHERE policy_version = terms))),
    'policyVersion', terms);
  RETURN hon.saas_record(actor, key, 'saas.access.past_due_suspension', 'saas.access.suspended', 'ACCESS_STATE', org, org,
    prior, nxt, result, at);
END $$;

-- ---------- worker: which plans are past due now (ids only; the command rechecks everything under its locks) ----------
CREATE FUNCTION hon.list_saas_schedule_past_due_bindings(p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.saas_refuse_context();
  RETURN jsonb_build_object('bindingIds', coalesce((SELECT jsonb_agg(x.id ORDER BY x.paid_through, x.id) FROM (
    SELECT b.id, st.paid_through FROM hon.saas_schedule_bindings b
      JOIN hon.saas_access_states st ON st.binding_id = b.id AND st.state = 'PAYMENT_ACTIVE' AND st.activation_source = 'SCHEDULE_BINDING'
      JOIN hon.organization_entitlements e ON e.organization_id = b.organization_id AND e.status = 'ACTIVE'
    WHERE b.status = 'ACTIVE' AND b.requirements->>'billingInterval' IN ('MONTHLY','ANNUAL') AND isfinite(st.paid_through)
      AND clock_timestamp() >= st.paid_through + hon.saas_schedule_access_grace()
    ORDER BY st.paid_through, b.id LIMIT p_limit) x), '[]'::jsonb));
END $$;

-- ---------- renewal hook (0235 body plus restore after suspension) ----------
CREATE OR REPLACE FUNCTION hon.saas_schedule_after_paid_period(p_binding uuid, p_period uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); b hon.saas_schedule_bindings%ROWTYPE; per hon.saas_schedule_paid_periods%ROWTYPE;
  ent hon.organization_entitlements%ROWTYPE; st hon.saas_access_states%ROWTYPE; prior jsonb; nxt jsonb; new_until timestamptz;
BEGIN
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id = p_binding;
  SELECT * INTO per FROM hon.saas_schedule_paid_periods WHERE id = p_period AND binding_id = p_binding;
  IF b.id IS NULL OR per.id IS NULL THEN RAISE EXCEPTION 'SAAS_ACCESS_HOOK_INPUT'; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.saas_access_transitions t WHERE t.binding_id = b.id AND t.kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION'
      AND t.outcome = 'APPLIED') THEN
    -- An open access review waits for the HQ-owner retry, which uses the latest period; later payments still count.
    IF EXISTS (SELECT 1 FROM hon.saas_access_transitions t WHERE t.binding_id = b.id AND t.kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION'
        AND t.outcome = 'NEEDS_REVIEW') THEN
      RETURN jsonb_build_object('accessActivation','NEEDS_REVIEW','accessGranted',false,'reason','ACTIVATION_PENDING');
    END IF;
    RETURN hon.saas_schedule_activate_access(b.id, per.id, p_at);
  END IF;
  -- Renewal: extend the same binding's access window forward; a late earlier period never shortens it.
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = b.organization_id FOR UPDATE;
  SELECT * INTO st FROM hon.saas_access_states WHERE organization_id = b.organization_id FOR UPDATE;
  -- Paid access switched off after activation: the payment stands, the window is not extended, HQ reviews.
  IF NOT hon.saas_access_program_active() THEN
    INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
        prior_entitlement, actor_principal_id, occurred_at)
      VALUES (b.organization_id, 'SCHEDULE_RENEWAL_EXTENSION', 'NEEDS_REVIEW', 'ACCESS_PROGRAM_INACTIVE', b.id, per.id, per.provider_event_id,
        hon.saas_entitlement_json(b.organization_id), actor, p_at);
    RETURN jsonb_build_object('accessActivation','NEEDS_REVIEW','accessGranted',false,'reason','ACCESS_PROGRAM_INACTIVE');
  END IF;
  -- 0324: a school suspended after grace is restored by the verified payment of its overdue period (terms v2,
  -- IMMEDIATE_ON_VERIFIED_PAYMENT): the period that starts where the last paid period ended. Any other period stays in
  -- review. The suspension is current only while it produced the entitlement's present version.
  IF st.state = 'PAYMENT_ACTIVE' AND st.binding_id = b.id AND ent.status = 'SUSPENDED' AND hon.saas_schedule_current_suspension(b.id) IS NOT NULL THEN
    IF per.covered_starts_at > st.paid_through + interval '1 day' OR per.covered_ends_at <= st.paid_through THEN
      INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
          prior_entitlement, actor_principal_id, occurred_at)
        VALUES (b.organization_id, 'SCHEDULE_ACCESS_RESTORED', 'NEEDS_REVIEW', 'PAID_PERIOD_GAP', b.id, per.id, per.provider_event_id,
          hon.saas_entitlement_json(b.organization_id), actor, p_at);
      RETURN jsonb_build_object('accessActivation','NEEDS_REVIEW','accessGranted',false,'reason','PAID_PERIOD_GAP');
    END IF;
    prior := hon.saas_entitlement_json(b.organization_id);
    UPDATE hon.organization_entitlements SET status = 'ACTIVE', effective_until = per.covered_ends_at + hon.saas_schedule_access_grace(),
        version = version + 1, updated_at = p_at
      WHERE organization_id = b.organization_id AND version = ent.version;
    IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT'; END IF;
    nxt := hon.saas_entitlement_json(b.organization_id);
    UPDATE hon.saas_access_states SET paid_through = per.covered_ends_at, version = version + 1, changed_by_principal_id = actor, updated_at = p_at
      WHERE organization_id = b.organization_id AND version = st.version;
    IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT'; END IF;
    INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
        prior_entitlement, next_entitlement, actor_principal_id, occurred_at)
      VALUES (b.organization_id, 'SCHEDULE_ACCESS_RESTORED', 'APPLIED', 'OVERDUE_PERIOD_PAID', b.id, per.id, per.provider_event_id,
        prior, nxt, actor, p_at);
    RETURN jsonb_build_object('accessActivation','EXTENDED','accessGranted',true);
  END IF;
  IF st.state IS DISTINCT FROM 'PAYMENT_ACTIVE' OR st.binding_id IS DISTINCT FROM b.id OR ent.organization_id IS NULL OR ent.status <> 'ACTIVE' THEN
    -- The payment stands; HQ reviews why this organization's access no longer follows the binding.
    INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
        prior_entitlement, actor_principal_id, occurred_at)
      VALUES (b.organization_id, 'SCHEDULE_RENEWAL_EXTENSION', 'NEEDS_REVIEW', 'ACCESS_STATE_NOT_ELIGIBLE', b.id, per.id, per.provider_event_id,
        hon.saas_entitlement_json(b.organization_id), actor, p_at);
    RETURN jsonb_build_object('accessActivation','NEEDS_REVIEW','accessGranted',false,'reason','ACCESS_STATE_NOT_ELIGIBLE');
  END IF;
  IF per.covered_ends_at <= st.paid_through THEN
    RETURN jsonb_build_object('accessActivation','NOT_ATTEMPTED','accessGranted',false,'reason','ALREADY_COVERED');
  END IF;
  -- Paid periods are contiguous; a period that starts after the current window has lapsed is reviewed, never bridged.
  IF per.covered_starts_at > st.paid_through + hon.saas_schedule_access_grace() THEN
    INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
        prior_entitlement, actor_principal_id, occurred_at)
      VALUES (b.organization_id, 'SCHEDULE_RENEWAL_EXTENSION', 'NEEDS_REVIEW', 'PAID_PERIOD_GAP', b.id, per.id, per.provider_event_id,
        hon.saas_entitlement_json(b.organization_id), actor, p_at);
    RETURN jsonb_build_object('accessActivation','NEEDS_REVIEW','accessGranted',false,'reason','PAID_PERIOD_GAP');
  END IF;
  prior := hon.saas_entitlement_json(b.organization_id);
  new_until := greatest(coalesce(ent.effective_until, '-infinity'::timestamptz), per.covered_ends_at + hon.saas_schedule_access_grace());
  UPDATE hon.organization_entitlements SET effective_until = new_until, version = version + 1, updated_at = p_at
    WHERE organization_id = b.organization_id AND version = ent.version;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT'; END IF;
  nxt := hon.saas_entitlement_json(b.organization_id);
  UPDATE hon.saas_access_states SET paid_through = per.covered_ends_at, version = version + 1, changed_by_principal_id = actor, updated_at = p_at
    WHERE organization_id = b.organization_id AND version = st.version;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT'; END IF;
  INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
      prior_entitlement, next_entitlement, actor_principal_id, occurred_at)
    VALUES (b.organization_id, 'SCHEDULE_RENEWAL_EXTENSION', 'APPLIED', 'RENEWAL_PAYMENT_VERIFIED', b.id, per.id, per.provider_event_id,
      prior, nxt, actor, p_at);
  RETURN jsonb_build_object('accessActivation','EXTENDED','accessGranted',true);
END $$;

-- ---------- school access standing (0192 body plus schedule-billed schools) ----------
CREATE OR REPLACE FUNCTION hon.read_saas_school_access_standing(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; t hon.saas_access_policy_terms%ROWTYPE; c jsonb; w record; in_effect boolean; v_state text;
  v_grace_ends timestamptz; v_now timestamptz := clock_timestamp(); st hon.saas_access_states%ROWTYPE;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_billing_viewer(p_subject, p_school) LIMIT 1;
  SELECT * INTO t FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1;
  c := hon.saas_access_condition(scope.organization_id);
  -- 0324: a school paid through a schedule binding is due when its last paid period ends (a lifetime plan never is).
  SELECT * INTO st FROM hon.saas_access_states WHERE organization_id = scope.organization_id;
  IF st.activation_source = 'SCHEDULE_BINDING' THEN
    c := c || jsonb_build_object('paymentStatus', CASE WHEN v_now < st.paid_through THEN 'PAID' ELSE 'PAST_DUE' END,
      'unpaidSince', CASE WHEN v_now >= st.paid_through THEN hon.saas_ts(st.paid_through) END);
  END IF;
  in_effect := coalesce((c->'entitlement'->>'inEffect')::boolean, false);
  IF c->>'paymentStatus' IN ('DUE','PAST_DUE') AND c->>'unpaidSince' IS NOT NULL THEN
    v_grace_ends := (c->>'unpaidSince')::timestamptz + make_interval(days => t.grace_days);
  END IF;
  SELECT * INTO w FROM hon.crm_owner_read_only_window(scope.organization_id);
  v_state := CASE
    WHEN in_effect AND v_grace_ends IS NOT NULL AND v_now < v_grace_ends THEN 'PAYMENT_ISSUE_GRACE'
    WHEN in_effect AND v_grace_ends IS NOT NULL THEN 'PAYMENT_ISSUE_GRACE_ENDED'
    WHEN in_effect THEN 'IN_GOOD_STANDING'
    WHEN w.suspended_at IS NOT NULL AND v_now < w.read_only_until THEN 'SUSPENDED_OWNER_READ_ONLY'
    WHEN w.suspended_at IS NOT NULL THEN 'CRM_LOCKED_BILLING_RECOVERY_OPEN'
    ELSE 'NO_ACCESS' END;
  RETURN jsonb_build_object('schoolId', p_school, 'organizationId', scope.organization_id, 'state', v_state,
    'paymentIssue', v_grace_ends IS NOT NULL OR w.suspended_at IS NOT NULL,
    'paymentStatus', c->>'paymentStatus', 'renewalDueAt', CASE WHEN v_grace_ends IS NOT NULL THEN c->>'unpaidSince' END,
    'graceEndsAt', hon.saas_ts(v_grace_ends),
    'suspendedAt', hon.saas_ts(w.suspended_at), 'ownerReadOnlyUntil', hon.saas_ts(w.read_only_until),
    'billingRecoveryOpen', true, 'dataDeletion', 'NEVER',
    'policyVersion', t.policy_version, 'policyStatus', t.status,
    'paidAccessProgram', CASE WHEN hon.saas_access_program_active() THEN 'ACTIVE' ELSE 'INACTIVE' END,
    'asOf', hon.saas_ts(v_now));
END $$;

-- ---------- ACLs ----------
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.saas_schedule_current_suspension(uuid)','hon.record_saas_schedule_past_due_suspension(uuid)',
    'hon.list_saas_schedule_past_due_bindings(integer)','hon.saas_schedule_after_paid_period(uuid,uuid,timestamp with time zone)',
    'hon.read_saas_school_access_standing(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.record_saas_schedule_past_due_suspension(uuid),hon.list_saas_schedule_past_due_bindings(integer),
      hon.read_saas_school_access_standing(text,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
