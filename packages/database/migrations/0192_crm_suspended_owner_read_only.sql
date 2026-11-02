BEGIN;

-- Owner CRM suspension policy (owner direction 2026-11-02 01:52Z). Migration number 0192 allocated by the owner on
-- 2026-11-02 (next free number on main); later pending migrations take the next free number when each merges.
-- - Proposed paid-access terms version 2. A failed renewal gets a 7-day grace period that starts on the renewal's
--   scheduled due date (the end of the last paid period). Normal authorized access continues during grace, and the
--   owner is shown the payment issue in the app. After grace, operational CRM and staff CRM access are suspended. The
--   verified school owner keeps restricted read-only access to historical CRM lead and trial records for 90 days from
--   the effective suspension date. After that, CRM is locked and billing recovery and support stay open. Data is never
--   deleted. Version 1 is kept; both versions remain PROPOSED, and the paid-access program stays INACTIVE.
-- - One access authority. organization_entitlements remains the only entitlement record. The effective suspension date
--   is an APPLIED PAST_DUE_SUSPENSION access transition, bound to the exact entitlement version it produced. Any later
--   entitlement change (restoration, a different suspension, an HQ change) ends the owner window. Nothing in this
--   migration writes that transition: the past-due suspension writer belongs to the program activation work and needs
--   separate owner approval.
-- - The owner read-only authority is server-side. It checks the HUMAN_USER identity, the live system OWNER role at the
--   exact school, an ACTIVE organization and school, the transaction's own tenant, and the window against the database
--   clock. It audits every granted read. It never permits a mutation: every CRM write path still requires an
--   entitlement in effect.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
END $$;

-- ---------- proposed terms version 2 ----------
-- Adding nullable columns and replacing CHECK constraints rewrites no row: version 1 stays byte-for-byte as recorded,
-- and the immutability triggers still refuse any UPDATE or DELETE.
ALTER TABLE hon.saas_access_policy_terms
  ADD COLUMN grace_basis text CHECK (grace_basis IN ('FAILED_RENEWAL_DUE_DATE')),
  ADD COLUMN grace_notice text CHECK (grace_notice IN ('OWNER_NOTIFIED_IN_APP')),
  ADD COLUMN owner_read_only_days integer CHECK (owner_read_only_days BETWEEN 1 AND 365),
  ADD COLUMN owner_read_only_scope text CHECK (owner_read_only_scope IN ('VERIFIED_OWNER_HISTORICAL_CRM_LEADS_AND_TRIALS')),
  ADD COLUMN after_read_only_effect text CHECK (after_read_only_effect IN ('CRM_LOCKED_BILLING_RECOVERY_AND_SUPPORT_OPEN'));
ALTER TABLE hon.saas_access_policy_terms DROP CONSTRAINT saas_access_policy_terms_suspended_effect_check;
ALTER TABLE hon.saas_access_policy_terms ADD CONSTRAINT saas_access_policy_terms_suspended_effect_check CHECK (suspended_effect IN (
  'STAFF_READ_ONLY_BILLING_OPEN_FAMILY_FEATURES_CONTINUE', 'STAFF_CRM_OFF_OWNER_CRM_READ_ONLY_BILLING_OPEN'));
-- Version 2 has no separate restricted stage: suspension follows grace directly (restrict = suspend = grace).
ALTER TABLE hon.saas_access_policy_terms DROP CONSTRAINT saas_access_policy_terms_check;
ALTER TABLE hon.saas_access_policy_terms ADD CONSTRAINT saas_access_policy_terms_check
  CHECK (restrict_after_days >= grace_days AND suspend_after_days >= restrict_after_days AND suspend_after_days <= 90);
ALTER TABLE hon.saas_access_policy_terms ADD CONSTRAINT saas_access_policy_terms_owner_window_check CHECK (
  policy_version = 1 OR (grace_basis IS NOT NULL AND grace_notice IS NOT NULL AND owner_read_only_days IS NOT NULL
    AND owner_read_only_scope IS NOT NULL AND after_read_only_effect IS NOT NULL));

INSERT INTO hon.saas_access_policy_terms (policy_version, status, new_school_access, first_payment, grace_days, restrict_after_days,
  suspend_after_days, restricted_effect, suspended_effect, reactivation, cancellation_timing, refund_effect, dispute_effect,
  founder_price_rule, lifetime_rule, exception_max_days, exception_authority, data_deletion, recorded_at,
  grace_basis, grace_notice, owner_read_only_days, owner_read_only_scope, after_read_only_effect)
VALUES (2, 'PROPOSED', 'NONE_UNTIL_FIRST_PAYMENT', 'ACTIVATE_ON_VERIFIED_PAYMENT', 7, 7, 7,
  'PREMIUM_AI_SUSPENDED', 'STAFF_CRM_OFF_OWNER_CRM_READ_ONLY_BILLING_OPEN', 'IMMEDIATE_ON_VERIFIED_PAYMENT',
  'END_OF_PAID_PERIOD', 'END_ACCESS_AT_VERIFIED_REFUND', 'SUSPEND_PENDING_HQ_REVIEW', 'KEPT_WHILE_CONTINUOUSLY_PAID_INCLUDING_GRACE',
  'NEVER_PAST_DUE_ENDS_ONLY_ON_REFUND_OR_LOST_DISPUTE', 90, 'HQ_OWNER', 'NEVER', clock_timestamp(),
  'FAILED_RENEWAL_DUE_DATE', 'OWNER_NOTIFIED_IN_APP', 90, 'VERIFIED_OWNER_HISTORICAL_CRM_LEADS_AND_TRIALS',
  'CRM_LOCKED_BILLING_RECOVERY_AND_SUPPORT_OPEN');

-- ---------- effective suspension evidence ----------
ALTER TABLE hon.saas_access_transitions ADD COLUMN policy_version integer REFERENCES hon.saas_access_policy_terms(policy_version) ON DELETE RESTRICT;
ALTER TABLE hon.saas_access_transitions DROP CONSTRAINT saas_access_transitions_kind_check;
ALTER TABLE hon.saas_access_transitions ADD CONSTRAINT saas_access_transitions_kind_check
  CHECK (kind IN ('AWAITING_FIRST_PAYMENT','FIRST_PAYMENT_ACTIVATION','PAST_DUE_SUSPENSION'));
-- A past-due suspension names the terms it applied and the SUSPENDED entitlement version it produced (and, from its
-- writer, the subscription it concerns); occurred_at is the effective suspension date.
ALTER TABLE hon.saas_access_transitions ADD CONSTRAINT saas_access_transitions_past_due_check CHECK (
  kind <> 'PAST_DUE_SUSPENSION' OR (policy_version IS NOT NULL
    AND (outcome <> 'APPLIED' OR (next_entitlement->>'status' = 'SUSPENDED' AND (next_entitlement->>'version') ~ '^[1-9][0-9]{0,9}$'))));

-- The owner read-only window of an organization, if one is open or recorded: the applied past-due suspension that
-- produced the entitlement's current SUSPENDED version, under terms that define an owner window. Any later entitlement
-- change moves the version on and ends the window. No row means there is no owner read-only access.
CREATE FUNCTION hon.crm_owner_read_only_window(p_org uuid)
RETURNS TABLE (suspended_at timestamptz, read_only_until timestamptz, policy_version integer, entitlement_version integer)
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT t.occurred_at, t.occurred_at + make_interval(days => terms.owner_read_only_days), terms.policy_version, e.version
  FROM hon.organization_entitlements e
  JOIN hon.saas_access_transitions t ON t.organization_id = e.organization_id AND t.kind = 'PAST_DUE_SUSPENSION' AND t.outcome = 'APPLIED'
    AND t.next_entitlement->>'status' = 'SUSPENDED' AND (t.next_entitlement->>'version')::integer = e.version
  JOIN hon.saas_access_policy_terms terms ON terms.policy_version = t.policy_version AND terms.owner_read_only_days IS NOT NULL
  WHERE e.organization_id = p_org AND e.status = 'SUSPENDED'
  ORDER BY t.occurred_at DESC, t.id DESC LIMIT 1
$$;

-- ---------- verified-owner CRM read-only authority ----------
-- Called inside the CRM read's tenant transaction, after the caller re-resolved exact-school authority. Returns the
-- open window and records an audit event; refuses (42501) for anyone or anything else. The read itself stays under the
-- caller's forced-RLS tenant scope, so another school's or organization's records are never reachable.
CREATE FUNCTION hon.authorize_crm_owner_read_only(p_subject text, p_school uuid, p_resource text, p_request_id uuid, p_correlation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_principal uuid; v_org uuid; w record; v_now timestamptz := clock_timestamp();
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject OR p_school IS NULL
    OR p_resource IS NULL OR p_resource NOT IN ('LEAD_LIST','TRIAL_LIST','TRIAL_DETAIL') OR p_request_id IS NULL OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'CRM_OWNER_READ_ONLY_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;
  -- Bound to the transaction's own tenant: the exact school and organization the caller's RLS scope was set to.
  SELECT s.organization_id INTO v_org FROM hon.schools s JOIN hon.organizations o ON o.id = s.organization_id
  WHERE s.id = p_school AND s.status = 'ACTIVE' AND o.status = 'ACTIVE'
    AND s.id = hon.current_school_id() AND s.organization_id = hon.current_organization_id();
  IF v_org IS NULL THEN RAISE EXCEPTION 'CRM_OWNER_READ_ONLY_UNAVAILABLE' USING ERRCODE = '42501'; END IF;
  -- The verified school owner: the one active HUMAN_USER principal of the signed subject, holding a live grant of the
  -- organization's system OWNER role at this exact school, with no family or platform role and no family access.
  SELECT p.id INTO v_principal FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND p.principal_type = 'HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.principal_type = 'HUMAN_USER' AND other.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
      WHERE g.principal_id = p.id AND g.organization_id = v_org AND g.school_id = p_school
        AND r.code = 'OWNER' AND r.is_system_role
        AND g.revoked_at IS NULL AND g.effective_from <= v_now AND (g.effective_until IS NULL OR g.effective_until > v_now))
    AND NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
      WHERE g.principal_id = p.id AND g.revoked_at IS NULL AND g.effective_from <= v_now
        AND (g.effective_until IS NULL OR g.effective_until > v_now)
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= v_now AND (f.effective_until IS NULL OR f.effective_until > v_now));
  IF v_principal IS NULL THEN RAISE EXCEPTION 'CRM_OWNER_READ_ONLY_UNAVAILABLE' USING ERRCODE = '42501'; END IF;
  SELECT * INTO w FROM hon.crm_owner_read_only_window(v_org);
  IF w.suspended_at IS NULL THEN RAISE EXCEPTION 'CRM_OWNER_READ_ONLY_UNAVAILABLE' USING ERRCODE = '42501'; END IF;
  -- Expiry is enforced here against the database clock, never by the caller.
  IF v_now >= w.read_only_until THEN RAISE EXCEPTION 'CRM_OWNER_READ_ONLY_EXPIRED' USING ERRCODE = '42501'; END IF;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (v_org, p_school, v_principal, 'HUMAN_UI', 'crm.owner_read_only.access', 'CRM_OWNER_READ_ONLY_ACCESS', NULL, NULL,
    jsonb_build_object('resource', p_resource, 'suspendedAt', hon.saas_ts(w.suspended_at), 'readOnlyUntil', hon.saas_ts(w.read_only_until),
      'policyVersion', w.policy_version, 'entitlementVersion', w.entitlement_version),
    'SUCCEEDED', p_request_id, p_correlation_id, v_now);
  RETURN jsonb_build_object('principalId', v_principal, 'organizationId', v_org, 'schoolId', p_school, 'mode', 'OWNER_READ_ONLY',
    'suspendedAt', hon.saas_ts(w.suspended_at), 'readOnlyUntil', hon.saas_ts(w.read_only_until), 'policyVersion', w.policy_version);
END $$;

-- ---------- in-app access standing (billing.hon.view; never refused for a lapsed school) ----------
-- What the owner is shown about a payment issue: grace end during a failed renewal, the read-only window after
-- suspension, or the lock with billing recovery open. Reads existing records only; enforcement is not changed here.
CREATE FUNCTION hon.read_saas_school_access_standing(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; t hon.saas_access_policy_terms%ROWTYPE; c jsonb; w record; in_effect boolean; v_state text;
  v_grace_ends timestamptz; v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_billing_viewer(p_subject, p_school) LIMIT 1;
  SELECT * INTO t FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1;
  c := hon.saas_access_condition(scope.organization_id);
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

-- The HQ dry run reports the version 2 fields (same body as 0170 plus the new terms).
CREATE OR REPLACE FUNCTION hon.read_saas_access_readiness_from_hq(p_subject text, p_organization uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE prog hon.saas_access_program%ROWTYPE; t hon.saas_access_policy_terms%ROWTYPE;
BEGIN
  IF p_organization IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  IF NOT EXISTS (SELECT 1 FROM hon.organizations o WHERE o.id = p_organization) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO prog FROM hon.saas_access_program WHERE program_id = 1;
  SELECT * INTO t FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1;
  RETURN jsonb_build_object('organizationId', p_organization,
    'program', jsonb_build_object('status', prog.status, 'mutationsEnabled', prog.mutations_enabled, 'activation', 'REVIEWED_MIGRATION_AFTER_OWNER_APPROVAL'),
    'proposedTerms', jsonb_build_object('policyVersion', t.policy_version, 'status', t.status, 'newSchoolAccess', t.new_school_access,
      'firstPayment', t.first_payment, 'graceDays', t.grace_days, 'restrictAfterDays', t.restrict_after_days, 'suspendAfterDays', t.suspend_after_days,
      'restrictedEffect', t.restricted_effect, 'suspendedEffect', t.suspended_effect, 'reactivation', t.reactivation,
      'cancellationTiming', t.cancellation_timing, 'refundEffect', t.refund_effect, 'disputeEffect', t.dispute_effect,
      'founderPriceRule', t.founder_price_rule, 'lifetimeRule', t.lifetime_rule, 'exceptionMaxDays', t.exception_max_days,
      'exceptionAuthority', t.exception_authority, 'dataDeletion', t.data_deletion,
      'graceBasis', t.grace_basis, 'graceNotice', t.grace_notice, 'ownerReadOnlyDays', t.owner_read_only_days,
      'ownerReadOnlyScope', t.owner_read_only_scope, 'afterReadOnlyEffect', t.after_read_only_effect),
    'dryRun', hon.saas_access_shadow(p_organization), 'asOf', hon.saas_ts(clock_timestamp()));
END $$;

-- ---------- ACL ----------
DO $$ DECLARE f text; r text; BEGIN
  FOREACH f IN ARRAY ARRAY['crm_owner_read_only_window(uuid)','authorize_crm_owner_read_only(text,uuid,text,uuid,uuid)',
    'read_saas_school_access_standing(text,uuid)','read_saas_access_readiness_from_hq(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.authorize_crm_owner_read_only(text,uuid,text,uuid,uuid), hon.read_saas_school_access_standing(text,uuid),
      hon.read_saas_access_readiness_from_hq(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMENT ON FUNCTION hon.authorize_crm_owner_read_only(text,uuid,text,uuid,uuid) IS
  'Verified-owner CRM read-only authority during a past-due suspension window (terms v2: 90 days). Audits each granted read; never permits a mutation.';
COMMENT ON FUNCTION hon.read_saas_school_access_standing(text,uuid) IS
  'billing.hon.view in-app access standing: payment-issue grace, owner read-only window, or CRM lock with billing recovery open. Read-only.';

COMMIT;
