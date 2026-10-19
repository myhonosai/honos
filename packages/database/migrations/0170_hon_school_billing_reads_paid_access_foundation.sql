BEGIN;

-- HON Subscription Billing B5.1: school-owner billing reads, plus the INACTIVE B6 paid-access foundation.
-- - A school's own staff holding the new billing.hon.view permission at that exact school (never an HQ,
--   family, support or platform identity, and never an HQ financial permission) read their organization's
--   HON subscription billing: issued invoices with lines, settlement, payment evidence (provider-verified
--   versus HQ-recorded) and refund records; subscription terms and history; the current entitlement and
--   how it was provisioned; verified payment standing; and the premium AI allowance. Billing is
--   organization-level, so every authorized school of a multi-school organization sees the same records.
-- - Drafts, HQ notes, internal references and other organizations are never visible. HON SaaS billing
--   stays separate from school-to-family membership billing (no family billing table is read).
-- - Nothing here writes anything. organization_entitlements stays the only access authority and the
--   reads never infer access from a payment.
-- - B6 foundation, inert: the paid-access program can only be INACTIVE (a CHECK, not a flag), the
--   recommended paid-access terms are recorded as PROPOSED only, and the HQ readiness read evaluates
--   those terms as a dry run with enforcement NONE. No function here can change an entitlement.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON school billing reads require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON school billing reads require a restricted runtime';
  END IF;
END $$;

-- ---------- owner decisions ----------
ALTER TABLE hon.saas_policy_decisions DROP CONSTRAINT saas_policy_decisions_policy_code_check;
ALTER TABLE hon.saas_policy_decisions ADD CONSTRAINT saas_policy_decisions_policy_code_check CHECK (policy_code IN ('ANNUAL_BILLING','TAXES',
  'PRORATION','PLAN_CHANGE_TIMING','CANCELLATION_TIMING','REFUND_EXECUTION','PAYMENT_PROVIDER','FOUNDER_SLOT_RETURN','CREDIT_ROLLOVER',
  'TOP_UP_PRICING','REFUND_GUARANTEE','FOUNDER_PROGRAM','FOUNDER_RESERVATION_HOLD','FOUNDER_ALLOWANCE','PLAN_ALLOWANCES','PREMIUM_OPERATIONS',
  'SUSPENDED_ALLOWANCE','PAYMENT_ATTESTATION','ZERO_DOLLAR_INVOICE','REWARD_CLAWBACK','CHAMPIONS_REWARD_LADDER','PAID_ACCESS'));
INSERT INTO hon.saas_policy_decisions(policy_code, status, blocks) VALUES
  ('PAID_ACCESS','UNDECIDED','A payment never grants, restricts, suspends or ends access');
INSERT INTO hon.saas_policy_records(policy_code, version, status, decision_code, summary, blocks, source_reference, recorded_at) VALUES
  ('PAYMENT_PROVIDER',4,'DECIDED','STRIPE_TEST_MODE_ONLY',
    'Stripe is approved as HON''s initial payment provider, beginning with test mode only.',
    'Live mode, live charges and refunds stay unavailable; the program can only be DISABLED or TEST_MODE.','OWNER_DIRECTION_2026_10_19_B5_APPROVAL',clock_timestamp()),
  ('PAID_ACCESS',2,'PROPOSED','HON_RECOMMENDED_TERMS_V1',
    'Recommended paid-access terms (saas_access_policy_terms version 1) are proposed for owner review; none is approved.',
    'The paid-access program can only be INACTIVE; payment-driven entitlement changes need owner approval and a reviewed migration.','CLAUDE_B6_PROPOSAL_2026_10_19',clock_timestamp());

-- ---------- school billing permission ----------
INSERT INTO hon.permissions(code, description, is_sensitive, is_staff_assignable)
VALUES ('billing.hon.view','View the organization''s HON subscription invoices, payment evidence, refunds, entitlement and AI allowance; read-only',true,true);
INSERT INTO hon.role_permissions(role_id, organization_id, permission_code)
SELECT id, organization_id, 'billing.hon.view' FROM hon.roles WHERE is_system_role AND code = 'OWNER' ON CONFLICT DO NOTHING;

-- ---------- B6 foundation: inert program and proposed terms ----------
CREATE TABLE hon.saas_access_program (
  program_id smallint PRIMARY KEY CHECK (program_id = 1),
  -- Activation is a reviewed migration after owner approval, never a runtime switch.
  status text NOT NULL CHECK (status = 'INACTIVE'),
  mutations_enabled boolean NOT NULL DEFAULT false CHECK (mutations_enabled = false),
  policy_version integer,
  recorded_at timestamptz NOT NULL
);
INSERT INTO hon.saas_access_program(program_id, status, recorded_at) VALUES (1, 'INACTIVE', clock_timestamp());

CREATE TABLE hon.saas_access_policy_terms (
  policy_version integer PRIMARY KEY CHECK (policy_version > 0),
  status text NOT NULL CHECK (status = 'PROPOSED'),
  new_school_access text NOT NULL CHECK (new_school_access IN ('NONE_UNTIL_FIRST_PAYMENT')),
  first_payment text NOT NULL CHECK (first_payment IN ('ACTIVATE_ON_VERIFIED_PAYMENT')),
  grace_days integer NOT NULL CHECK (grace_days BETWEEN 0 AND 30),
  restrict_after_days integer NOT NULL,
  suspend_after_days integer NOT NULL,
  restricted_effect text NOT NULL CHECK (restricted_effect IN ('PREMIUM_AI_SUSPENDED')),
  suspended_effect text NOT NULL CHECK (suspended_effect IN ('STAFF_READ_ONLY_BILLING_OPEN_FAMILY_FEATURES_CONTINUE')),
  reactivation text NOT NULL CHECK (reactivation IN ('IMMEDIATE_ON_VERIFIED_PAYMENT')),
  cancellation_timing text NOT NULL CHECK (cancellation_timing IN ('END_OF_PAID_PERIOD')),
  refund_effect text NOT NULL CHECK (refund_effect IN ('END_ACCESS_AT_VERIFIED_REFUND')),
  dispute_effect text NOT NULL CHECK (dispute_effect IN ('SUSPEND_PENDING_HQ_REVIEW')),
  founder_price_rule text NOT NULL CHECK (founder_price_rule IN ('KEPT_WHILE_CONTINUOUSLY_PAID_INCLUDING_GRACE')),
  lifetime_rule text NOT NULL CHECK (lifetime_rule IN ('NEVER_PAST_DUE_ENDS_ONLY_ON_REFUND_OR_LOST_DISPUTE')),
  exception_max_days integer NOT NULL CHECK (exception_max_days BETWEEN 1 AND 90),
  exception_authority text NOT NULL CHECK (exception_authority IN ('HQ_OWNER')),
  data_deletion text NOT NULL CHECK (data_deletion = 'NEVER'),
  recorded_at timestamptz NOT NULL,
  CHECK (restrict_after_days >= grace_days AND suspend_after_days > restrict_after_days AND suspend_after_days <= 90)
);
INSERT INTO hon.saas_access_policy_terms VALUES (1,'PROPOSED','NONE_UNTIL_FIRST_PAYMENT','ACTIVATE_ON_VERIFIED_PAYMENT',7,7,21,
  'PREMIUM_AI_SUSPENDED','STAFF_READ_ONLY_BILLING_OPEN_FAMILY_FEATURES_CONTINUE','IMMEDIATE_ON_VERIFIED_PAYMENT','END_OF_PAID_PERIOD',
  'END_ACCESS_AT_VERIFIED_REFUND','SUSPEND_PENDING_HQ_REVIEW','KEPT_WHILE_CONTINUOUSLY_PAID_INCLUDING_GRACE',
  'NEVER_PAST_DUE_ENDS_ONLY_ON_REFUND_OR_LOST_DISPUTE',90,'HQ_OWNER','NEVER',clock_timestamp());

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_access_program','saas_access_policy_terms'] LOOP
    EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  END LOOP;
END $$;

-- ---------- school billing viewer ----------
-- Same identity rules as the B5 purchaser (one active principal, eligible staff at the exact school,
-- no family or platform role), with the read-only billing permission. It deliberately does not require
-- an active entitlement: a school whose access lapsed can still see its own billing.
CREATE FUNCTION hon.require_saas_school_billing_viewer(p_subject text, p_school uuid)
RETURNS TABLE (principal_id uuid, organization_id uuid, school_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject OR p_school IS NULL THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
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
        AND perm.code = 'billing.hon.view' AND perm.is_staff_assignable
        AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id = s.id)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()))
    AND NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
      WHERE g.principal_id = p.id AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)');
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
END $$;

-- ---------- school-facing projections (allow-lists: no HQ notes, internal references or actors) ----------
CREATE FUNCTION hon.saas_school_evidence_json(e hon.saas_payment_evidence) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('evidenceId',e.id,'kind',e.kind,'source',e.source,'providerVerified',e.source = 'PROVIDER_VERIFIED',
    'providerMode',e.provider_mode,'amountMinor',e.amount_minor,'currency',e.currency,'occurredAt',hon.saas_ts(e.occurred_at),
    'relatedEvidenceId',e.related_evidence_id,'recordedAt',hon.saas_ts(e.recorded_at))
$$;

CREATE FUNCTION hon.saas_school_refund_json(r hon.saas_refund_requests) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('refundRequestId',r.id,'invoiceId',r.invoice_id,
    'invoiceNumber',(SELECT i.invoice_number FROM hon.saas_invoices i WHERE i.id = r.invoice_id),'offerKind',r.offer_kind,
    'firstPaidAt',hon.saas_ts(r.first_paid_at),'windowEndsAt',hon.saas_ts(r.window_ends_at),'requestReceivedAt',hon.saas_ts(r.request_received_at),
    'requestedAmountMinor',r.requested_amount_minor,'approvedAmountMinor',r.approved_amount_minor,'evidenceStrength',r.evidence_strength,
    'status',r.status,'statusReason',r.status_reason,'execution','UNAVAILABLE',
    'refundEvidencedMinor',(SELECT f.refunded_minor FROM hon.saas_invoice_facts(NULL, r.invoice_id) f),
    'createdAt',hon.saas_ts(r.created_at),'decidedAt',hon.saas_ts(r.decided_at))
$$;

CREATE FUNCTION hon.saas_school_invoice_json(p_invoice uuid, p_detail boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('invoiceId',i.id,'invoiceNumber',i.invoice_number,'subscriptionId',i.subscription_id,'kind',i.kind,
    'periodIndex',i.period_index,
    'servicePeriod',jsonb_build_object('startsAt',hon.saas_ts(i.service_period_start),'endsAt',hon.saas_ts(i.service_period_end)),
    'planCode',i.plan_code,'offerKind',i.offer_kind,'description',i.description,'currency',i.currency,'status',i.status,
    'subtotalMinor',i.subtotal_minor,'taxStatus',i.tax_status,'taxMinor',i.tax_minor,'totalMinor',i.total_minor,
    'settlement',jsonb_build_object('receivedMinor',f.received_minor,'refundedMinor',f.refunded_minor,'chargedBackMinor',f.charged_back_minor,
      'netMinor',f.net_minor,'verifiedNetMinor',f.verified_net_minor,
      'balanceMinor',CASE WHEN i.status = 'ISSUED' THEN greatest(i.total_minor - f.net_minor, 0) END,
      'state',CASE WHEN i.status = 'VOID' THEN 'VOID'
        WHEN f.verified_net_minor >= i.total_minor THEN 'PAID_VERIFIED' WHEN f.net_minor >= i.total_minor THEN 'PAID_ATTESTED'
        WHEN f.net_minor > 0 THEN 'PARTIALLY_PAID' WHEN f.received_minor > 0 THEN 'REVERSED' ELSE 'UNPAID' END),
    'paymentVerification',CASE WHEN i.status = 'VOID' OR f.net_minor < i.total_minor THEN 'NONE'
      WHEN f.verified_net_minor >= i.total_minor THEN 'PROVIDER_VERIFIED' ELSE 'HQ_RECORDED' END,
    'collection','DISABLED','issuedAt',hon.saas_ts(i.issued_at),'voidedAt',hon.saas_ts(i.voided_at),'voidReason',i.void_reason)
    || CASE WHEN p_detail THEN jsonb_build_object(
      'lines',(SELECT coalesce(jsonb_agg(jsonb_build_object('lineNumber',l.line_number,'lineKind',l.line_kind,'description',l.description,
          'amountMinor',l.amount_minor) ORDER BY l.line_number), '[]'::jsonb) FROM hon.saas_invoice_lines l WHERE l.invoice_id = i.id),
      'evidence',(SELECT coalesce(jsonb_agg(hon.saas_school_evidence_json(e) ORDER BY e.recorded_at, e.id), '[]'::jsonb)
        FROM hon.saas_payment_evidence e WHERE e.invoice_id = i.id),
      'refunds',(SELECT coalesce(jsonb_agg(hon.saas_school_refund_json(r) ORDER BY r.created_at, r.id), '[]'::jsonb)
        FROM hon.saas_refund_requests r WHERE r.invoice_id = i.id))
      ELSE '{}'::jsonb END
  FROM hon.saas_invoices i CROSS JOIN LATERAL hon.saas_invoice_facts(NULL, i.id) f
  WHERE i.id = p_invoice AND i.status IN ('ISSUED','VOID') AND i.issued_at IS NOT NULL
$$;

-- ---------- school reads ----------
-- Keyset pagination over (issued_at to the millisecond, id): both are immutable once issued, so pages never skip or
-- repeat. The key uses the same millisecond precision the cursor carries (hon.saas_ts), so rows issued within one
-- millisecond are ordered by id instead of being lost between pages.
CREATE FUNCTION hon.read_saas_school_invoices(p_subject text, p_school uuid, p_status text, p_kind text,
  p_before_issued_at timestamptz, p_before_id uuid, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; ids uuid[]; rows jsonb; last_issued timestamptz; more boolean;
BEGIN
  IF (p_status IS NOT NULL AND p_status NOT IN ('ISSUED','VOID')) OR (p_kind IS NOT NULL AND p_kind NOT IN ('SUBSCRIPTION_PERIOD','LIFETIME_PURCHASE'))
    OR ((p_before_issued_at IS NULL) <> (p_before_id IS NULL)) OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO scope FROM hon.require_saas_school_billing_viewer(p_subject, p_school) LIMIT 1;
  SELECT array_agg(x.id ORDER BY x.issued_ms DESC, x.id DESC) INTO ids FROM (
    SELECT i.id, date_trunc('milliseconds', i.issued_at) issued_ms FROM hon.saas_invoices i
    WHERE i.organization_id = scope.organization_id AND i.status IN ('ISSUED','VOID') AND i.issued_at IS NOT NULL
      AND (p_status IS NULL OR i.status = p_status) AND (p_kind IS NULL OR i.kind = p_kind)
      AND (p_before_issued_at IS NULL OR (date_trunc('milliseconds', i.issued_at), i.id) < (date_trunc('milliseconds', p_before_issued_at), p_before_id))
    ORDER BY date_trunc('milliseconds', i.issued_at) DESC, i.id DESC LIMIT p_limit + 1) x;
  more := coalesce(array_length(ids, 1), 0) > p_limit;
  IF more THEN ids := ids[1:p_limit]; END IF;
  SELECT coalesce(jsonb_agg(hon.saas_school_invoice_json(u.id, false) ORDER BY u.n), '[]'::jsonb) INTO rows
    FROM unnest(coalesce(ids, ARRAY[]::uuid[])) WITH ORDINALITY u(id, n);
  IF more THEN SELECT i.issued_at INTO last_issued FROM hon.saas_invoices i WHERE i.id = ids[p_limit]; END IF;
  RETURN jsonb_build_object('schoolId', p_school, 'organizationId', scope.organization_id, 'billingScope', 'ORGANIZATION',
    'invoices', rows, 'limit', p_limit,
    'nextCursor', CASE WHEN more THEN jsonb_build_object('issuedAt', hon.saas_ts(last_issued), 'invoiceId', ids[p_limit]) END);
END $$;

CREATE FUNCTION hon.read_saas_school_invoice(p_subject text, p_school uuid, p_invoice uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; data jsonb;
BEGIN
  IF p_invoice IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO scope FROM hon.require_saas_school_billing_viewer(p_subject, p_school) LIMIT 1;
  -- Another organization's invoice and a missing one are indistinguishable.
  IF NOT EXISTS (SELECT 1 FROM hon.saas_invoices i WHERE i.id = p_invoice AND i.organization_id = scope.organization_id) THEN
    RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;
  data := hon.saas_school_invoice_json(p_invoice, true);
  IF data IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('schoolId', p_school, 'organizationId', scope.organization_id) || data;
END $$;

-- Current entitlement, as recorded (the only access authority).
CREATE FUNCTION hon.saas_entitlement_json(p_organization uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('tier',e.tier::text,'status',e.status::text,'effectiveFrom',hon.saas_ts(e.effective_from),
    'effectiveUntil',hon.saas_ts(e.effective_until),'version',e.version,
    'inEffect',e.status = 'ACTIVE' AND e.effective_from <= clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until > clock_timestamp()))
  FROM hon.organization_entitlements e WHERE e.organization_id = p_organization
$$;

-- Observed billing condition from existing B1/B2/B5 records only (no new source of truth).
CREATE FUNCTION hon.saas_access_condition(p_organization uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE s hon.saas_subscriptions%ROWTYPE; pay jsonb; ent jsonb; since timestamptz;
BEGIN
  ent := hon.saas_entitlement_json(p_organization);
  SELECT * INTO s FROM hon.saas_subscriptions WHERE organization_id = p_organization AND status <> 'VOIDED';
  IF s.id IS NULL THEN
    RETURN jsonb_build_object('entitlement', ent, 'subscriptionStatus', NULL, 'paymentStatus', 'NOT_BILLED', 'paymentVerification', 'NONE',
      'paidThroughAt', NULL, 'unpaidSince', NULL, 'billingInterval', NULL, 'planMatchesEntitlement', NULL);
  END IF;
  pay := hon.saas_subscription_payment(s);
  IF pay->>'paymentStatus' IN ('DUE','PAST_DUE') THEN
    since := coalesce((pay->>'paidThroughAt')::timestamptz, s.current_period_start, s.service_started_at);
  END IF;
  RETURN jsonb_build_object('entitlement', ent, 'subscriptionStatus', s.status, 'paymentStatus', pay->>'paymentStatus',
    'paymentVerification', pay->>'paymentVerification', 'paidThroughAt', pay->>'paidThroughAt', 'unpaidSince', hon.saas_ts(since),
    'billingInterval', s.billing_interval, 'planMatchesEntitlement', (ent->>'tier') = s.plan_code);
END $$;

CREATE FUNCTION hon.read_saas_school_billing_account(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; s hon.saas_subscriptions%ROWTYPE; cond jsonb; ent jsonb; per record; v_allowance uuid; allowance jsonb;
  bal jsonb; v_program text; v_planned integer; v_state text; v_activation text; v_alignment text; history jsonb; subs jsonb; refunds jsonb;
  standing jsonb; in_effect boolean; paid boolean;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_billing_viewer(p_subject, p_school) LIMIT 1;
  cond := hon.saas_access_condition(scope.organization_id);
  ent := cond->'entitlement';
  in_effect := coalesce((ent->>'inEffect')::boolean, false);
  SELECT * INTO s FROM hon.saas_subscriptions WHERE organization_id = scope.organization_id AND status <> 'VOIDED';
  paid := cond->>'paymentStatus' = 'PAID';
  v_alignment := CASE WHEN s.id IS NULL THEN 'NO_SUBSCRIPTION' WHEN s.status <> 'IN_SERVICE' THEN 'SUBSCRIPTION_NOT_IN_SERVICE'
    WHEN (cond->>'planMatchesEntitlement')::boolean THEN 'ALIGNED' ELSE 'PLAN_MISMATCH' END;
  -- Readiness is read from the entitlement; a payment alone never makes an account ready.
  v_activation := CASE WHEN in_effect AND v_alignment IN ('ALIGNED','NO_SUBSCRIPTION') THEN 'READY'
    WHEN paid THEN 'PENDING_ACCOUNT_ACTIVATION' ELSE 'UNAVAILABLE' END;

  v_program := (SELECT status FROM hon.saas_credit_program WHERE program_id = 1);
  IF s.id IS NOT NULL THEN
    v_planned := (SELECT p.planned_monthly_premium_credits FROM hon.saas_catalog_plans p WHERE p.catalog_id = s.catalog_id AND p.plan_code = s.plan_code);
    IF s.status = 'IN_SERVICE' THEN
      SELECT * INTO per FROM hon.saas_allowance_period(s, clock_timestamp());
      SELECT a.id INTO v_allowance FROM hon.saas_credit_allowances a WHERE a.subscription_id = s.id AND a.period_index = per.period_index;
    END IF;
  END IF;
  IF v_allowance IS NOT NULL THEN
    allowance := hon.saas_allowance_json(v_allowance); bal := allowance->'balance';
  END IF;
  v_state := CASE WHEN NOT in_effect THEN 'ACCESS_NOT_ACTIVE' WHEN s.id IS NULL THEN 'NO_SUBSCRIPTION'
    WHEN s.status = 'SUSPENDED' THEN 'SUSPENDED' WHEN s.status <> 'IN_SERVICE' THEN 'SUBSCRIPTION_NOT_IN_SERVICE'
    WHEN v_program <> 'ACTIVE' THEN 'PROGRAM_INACTIVE' WHEN v_allowance IS NULL THEN 'NOT_YET_OPENED'
    WHEN allowance->>'status' <> 'OPEN' THEN 'PERIOD_CLOSED' WHEN (bal->>'availableCredits')::int = 0 THEN 'EXHAUSTED' ELSE 'AVAILABLE' END;

  SELECT coalesce(jsonb_agg(jsonb_build_object('version',h.version,'status',h.status,'statusReason',h.status_reason,'periodIndex',h.period_index,
      'periodStart',hon.saas_ts(h.current_period_start),'periodEnd',hon.saas_ts(h.current_period_end),'occurredAt',hon.saas_ts(h.occurred_at))
      ORDER BY h.version), '[]'::jsonb) INTO history
    FROM hon.saas_subscription_history h WHERE h.subscription_id = s.id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('subscriptionId',x.id,'source',x.source,
      'catalogVersion',(SELECT c.catalog_version FROM hon.saas_catalog_versions c WHERE c.id = x.catalog_id),
      'planCode',x.plan_code,'offerKind',x.offer_kind,'billingInterval',x.billing_interval,'priceMinor',x.price_minor,'currency',x.currency,
      'status',x.status,'statusReason',x.status_reason,'serviceStartedAt',hon.saas_ts(x.service_started_at),'createdAt',hon.saas_ts(x.created_at))
      ORDER BY x.created_at DESC, x.id), '[]'::jsonb) INTO subs
    FROM (SELECT * FROM hon.saas_subscriptions WHERE organization_id = scope.organization_id ORDER BY created_at DESC, id LIMIT 20) x;
  SELECT coalesce(jsonb_agg(hon.saas_school_refund_json(r) ORDER BY r.created_at DESC, r.id), '[]'::jsonb) INTO refunds
    FROM (SELECT * FROM hon.saas_refund_requests WHERE organization_id = scope.organization_id ORDER BY created_at DESC, id LIMIT 50) r;
  standing := hon.saas_payment_standing(scope.organization_id);

  RETURN jsonb_build_object('schoolId', p_school, 'organizationId', scope.organization_id,
    'organizationName', (SELECT o.display_name FROM hon.organizations o WHERE o.id = scope.organization_id),
    'billingScope', 'ORGANIZATION',
    'schoolCount', (SELECT count(*)::int FROM hon.schools sc WHERE sc.organization_id = scope.organization_id AND sc.status = 'ACTIVE'),
    'entitlement', ent,
    'access', jsonb_build_object('source', CASE WHEN ent IS NULL THEN 'NONE' ELSE 'PROVISIONED' END, 'paymentActivated', false,
      'paidAccessProgram', (SELECT status FROM hon.saas_access_program WHERE program_id = 1), 'activation', v_activation, 'alignment', v_alignment),
    'subscription', CASE WHEN s.id IS NULL THEN NULL ELSE hon.saas_subscription_json(s) - 'organizationName' END,
    'subscriptionHistory', history, 'subscriptions', subs,
    'payment', jsonb_build_object('status', cond->>'paymentStatus', 'verification', cond->>'paymentVerification',
      'paidThroughAt', cond->>'paidThroughAt', 'unpaidSince', cond->>'unpaidSince',
      'verified', standing->'verified', 'recorded', standing->'recorded', 'evidenceCounts', standing->'evidence',
      'providerVerification', standing->>'providerVerification'),
    'allowance', jsonb_build_object('state', v_state, 'programStatus', v_program, 'plannedMonthlyCredits', v_planned,
      'period', CASE WHEN allowance IS NULL THEN NULL ELSE jsonb_build_object('index', (allowance->>'periodIndex')::int,
        'startsAt', allowance->>'periodStart', 'endsAt', allowance->>'periodEnd') END,
      'basis', allowance->>'allowanceBasis',
      'grantedCredits', (bal->>'allowanceCredits')::int, 'consumedCredits', (bal->>'consumedCredits')::int,
      'reservedCredits', (bal->>'heldCredits')::int, 'remainingCredits', (bal->>'availableCredits')::int, 'usedPercent', (bal->>'usedPercent')::int,
      'suspensionPolicy', 'UNDECIDED', 'topUps', 'UNAVAILABLE'),
    'refunds', refunds, 'cardDataStored', false, 'asOf', hon.saas_ts(clock_timestamp()));
END $$;

-- ---------- B6 dry run (HQ only; enforcement NONE) ----------
-- What the PROPOSED terms would say about an organization today. Nothing reads this to enforce.
CREATE FUNCTION hon.saas_access_shadow(p_organization uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE t hon.saas_access_policy_terms%ROWTYPE; c jsonb; s hon.saas_subscriptions%ROWTYPE; days integer; v_state text; v_reason text;
BEGIN
  SELECT * INTO t FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1;
  c := hon.saas_access_condition(p_organization);
  SELECT * INTO s FROM hon.saas_subscriptions WHERE organization_id = p_organization AND status <> 'VOIDED';
  IF c->>'unpaidSince' IS NOT NULL THEN days := greatest(floor(extract(epoch FROM clock_timestamp() - (c->>'unpaidSince')::timestamptz) / 86400)::int, 0); END IF;
  days := coalesce(days, 0);
  SELECT z.st, z.rs INTO v_state, v_reason FROM (SELECT
    CASE WHEN s.id IS NULL THEN CASE WHEN coalesce((c->'entitlement'->>'inEffect')::boolean, false) THEN 'ACTIVE' ELSE 'NO_ACCESS' END
      WHEN s.source = 'LEGACY_ENTITLEMENT' THEN 'ACTIVE'
      WHEN s.status = 'PENDING_ACTIVATION' THEN 'AWAITING_FIRST_PAYMENT'
      WHEN c->>'paymentStatus' = 'DISPUTED' THEN 'SUSPENDED'
      WHEN c->>'paymentStatus' = 'REFUNDED' THEN 'ENDED'
      WHEN c->>'paymentStatus' IN ('PAID','NOT_BILLED') THEN 'ACTIVE'
      WHEN days <= t.grace_days THEN 'PAST_DUE_GRACE'
      WHEN days <= t.suspend_after_days THEN 'RESTRICTED'
      ELSE 'SUSPENDED' END st,
    CASE WHEN s.id IS NULL THEN 'PROVISIONED_WITHOUT_SUBSCRIPTION' WHEN s.source = 'LEGACY_ENTITLEMENT' THEN 'LEGACY_ENTITLEMENT'
      WHEN s.status = 'PENDING_ACTIVATION' THEN 'NO_VERIFIED_FIRST_PAYMENT'
      WHEN c->>'paymentStatus' = 'DISPUTED' THEN 'DISPUTE_OPEN' WHEN c->>'paymentStatus' = 'REFUNDED' THEN 'REFUNDED'
      WHEN c->>'paymentStatus' = 'PAID' THEN 'PAID' WHEN c->>'paymentStatus' = 'NOT_BILLED' THEN 'NOT_YET_INVOICED'
      ELSE 'UNPAID_' || (c->>'paymentStatus') END rs) z;
  RETURN jsonb_build_object('policyVersion', t.policy_version, 'policyStatus', t.status, 'wouldBeState', v_state, 'reason', v_reason,
    'daysUnpaid', CASE WHEN c->>'unpaidSince' IS NULL THEN NULL ELSE days END, 'graceDays', t.grace_days, 'restrictAfterDays', t.restrict_after_days, 'suspendAfterDays', t.suspend_after_days,
    'premiumAiWouldBeSuspended', v_state IN ('RESTRICTED','SUSPENDED','ENDED','AWAITING_FIRST_PAYMENT','NO_ACCESS'),
    'condition', c, 'enforcement', 'NONE');
END $$;

CREATE FUNCTION hon.read_saas_access_readiness_from_hq(p_subject text, p_organization uuid) RETURNS jsonb
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
      'exceptionAuthority', t.exception_authority, 'dataDeletion', t.data_deletion),
    'dryRun', hon.saas_access_shadow(p_organization), 'asOf', hon.saas_ts(clock_timestamp()));
END $$;

COMMENT ON FUNCTION hon.read_saas_school_billing_account(text,uuid) IS
  'School billing.hon.view read of its organization''s HON plan, entitlement, payment standing and AI allowance. Read-only; never infers access from payment.';
COMMENT ON FUNCTION hon.read_saas_access_readiness_from_hq(text,uuid) IS
  'HQ dry run of PROPOSED paid-access terms. Enforcement NONE; the paid-access program can only be INACTIVE.';

-- ---------- ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_access_program','saas_access_policy_terms'] LOOP
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
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname ~ 'saas' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_catalog_from_hq(text), hon.create_saas_catalog_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_saas_catalog(text,uuid,uuid,uuid,uuid), hon.read_saas_founder_reservations_from_hq(text,text),
      hon.reserve_saas_founder_offer(text,jsonb,uuid,uuid,uuid), hon.release_saas_founder_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_subscriptions_from_hq(text,text), hon.read_saas_organization_subscription_from_hq(text,uuid),
      hon.record_saas_subscription(text,jsonb,uuid,uuid,uuid), hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_invoices_from_hq(text,text), hon.read_saas_invoice_from_hq(text,uuid), hon.read_saas_payment_standing_from_hq(text,uuid),
      hon.create_saas_invoice_draft(text,jsonb,uuid,uuid,uuid), hon.command_saas_invoice(text,uuid,jsonb,uuid,uuid,uuid),
      hon.record_saas_payment_evidence(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_credit_program_from_hq(text), hon.read_saas_organization_credits_from_hq(text,uuid),
      hon.set_saas_credit_program(text,jsonb,uuid,uuid,uuid), hon.record_saas_provider_cost_evidence(text,jsonb,uuid,uuid,uuid),
      hon.create_saas_pricing_draft(text,jsonb,uuid,uuid,uuid), hon.publish_saas_pricing(text,uuid,uuid,uuid,uuid),
      hon.command_saas_credit_allowance(text,jsonb,uuid,uuid,uuid), hon.read_saas_school_credits(text,uuid),
      hon.estimate_saas_premium_operation(text,uuid,text,integer), hon.reserve_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid),
      hon.settle_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_credit_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_refund_eligibility_from_hq(text,uuid,timestamptz), hon.read_saas_refund_requests_from_hq(text,text),
      hon.read_saas_refund_reserve_from_hq(text), hon.create_saas_refund_request(text,jsonb,uuid,uuid,uuid),
      hon.decide_saas_refund_request(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_reward_preview_from_hq(text,uuid),
      hon.read_saas_referral_alerts_from_hq(text,text), hon.set_saas_reward_fulfillment(text,jsonb,uuid,uuid,uuid),
      hon.apply_saas_referral_reward(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_credit_application_preview(text,uuid),
      hon.apply_saas_account_credit(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_referral_alert(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_payments_from_hq(text), hon.read_saas_school_plan_options(text,uuid), hon.set_saas_payment_program(text,jsonb,uuid,uuid,uuid),
      hon.create_saas_checkout_from_school(text,uuid,jsonb,uuid,uuid,uuid), hon.create_saas_checkout_from_hq(text,jsonb,uuid,uuid,uuid),
      hon.attach_saas_checkout_session(text,uuid,jsonb,uuid,uuid,uuid), hon.cancel_saas_checkout(text,uuid,jsonb,uuid,uuid,uuid),
      hon.sweep_saas_checkouts(text,uuid,uuid,uuid), hon.ingest_saas_provider_event(jsonb,text),
      hon.read_saas_school_invoices(text,uuid,text,text,timestamptz,uuid,integer), hon.read_saas_school_invoice(text,uuid,uuid),
      hon.read_saas_school_billing_account(text,uuid), hon.read_saas_access_readiness_from_hq(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
