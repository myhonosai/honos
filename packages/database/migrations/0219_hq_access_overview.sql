BEGIN;

-- B-HQ-1 HQ access overview (number proposed; owner allocates). One read-only HQ projection of every organization's
-- access standing: entitlement, B6A state, open D9 exception, subscription, open checkout, latest school-owner
-- invitation and the advisory exception-grant eligibility. It writes nothing, takes no lock and changes no command:
-- every grant, revoke and payment path still re-decides in the database.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ access overview requires a trusted migration owner';
  END IF;
END $$;

-- Exception-policy readiness exactly as hon.saas_require_exception_policy() decides it, without its advisory lock.
CREATE FUNCTION hon.saas_exception_policy_ready() RETURNS hon.saas_exception_policy_decisions
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE p hon.saas_exception_policy_decisions%ROWTYPE;
BEGIN
  SELECT * INTO p FROM hon.saas_exception_policy_decisions ORDER BY revision DESC LIMIT 1;
  IF p.id IS NULL OR p.status <> 'APPROVED' OR p.valid_from > clock_timestamp() OR p.valid_until <= clock_timestamp()
    OR p.terms_version IS DISTINCT FROM (SELECT max(policy_version) FROM hon.saas_access_policy_terms) THEN
    RETURN NULL;
  END IF;
  RETURN p;
END $$;

-- Access facts of one organization at one instant (the caller passes the same instant for every organization, so the
-- summary, the status, the exception lifecycle and the blockers never disagree). Internal helper: never granted.
-- The lifecycle rule is hon.saas_access_exception_json's (0186) and "live" is hon.saas_access_exception_live's (0185).
CREATE FUNCTION hon.saas_access_overview_facts(p_org uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE e hon.organization_entitlements%ROWTYPE; x hon.saas_access_exceptions%ROWTYPE; st text; in_effect boolean; lifecycle text;
BEGIN
  SELECT * INTO e FROM hon.organization_entitlements WHERE organization_id = p_org;
  SELECT state INTO st FROM hon.saas_access_states WHERE organization_id = p_org;
  SELECT * INTO x FROM hon.saas_access_exceptions WHERE organization_id = p_org AND status = 'GRANTED';
  in_effect := e.organization_id IS NOT NULL AND e.status = 'ACTIVE' AND e.effective_from <= p_at AND (e.effective_until IS NULL OR e.effective_until > p_at);
  lifecycle := CASE WHEN x.id IS NULL THEN NULL
    WHEN e.organization_id IS NULL OR e.version <> x.granted_entitlement_version OR e.status <> 'ACTIVE' THEN 'SUPERSEDED'
    WHEN p_at < x.starts_at THEN 'SCHEDULED' WHEN p_at >= x.expires_at THEN 'EXPIRED' ELSE 'IN_EFFECT' END;
  RETURN jsonb_build_object('inEffect', in_effect, 'lifecycle', lifecycle, 'state', st,
    'status', CASE
      WHEN st = 'AWAITING_FIRST_PAYMENT' THEN 'AWAITING_FIRST_PAYMENT'
      WHEN lifecycle = 'IN_EFFECT' AND in_effect THEN 'EXCEPTION_IN_EFFECT'
      WHEN lifecycle = 'SCHEDULED' THEN 'EXCEPTION_SCHEDULED'
      WHEN in_effect AND st = 'PAYMENT_ACTIVE' THEN 'PAID_ACCESS'
      WHEN in_effect THEN 'PROVISIONED_ACCESS'
      ELSE 'NO_ACCESS' END);
END $$;

-- One organization's row at p_at. Internal helper: never granted to any runtime role.
CREATE FUNCTION hon.saas_access_overview_row(p_org uuid, p_policy_ready boolean, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE o hon.organizations%ROWTYPE; e hon.organization_entitlements%ROWTYPE; f jsonb; ent jsonb; lifecycle text;
  x hon.saas_access_exceptions%ROWTYPE; s hon.saas_subscriptions%ROWTYPE; open_checkout boolean; inv hon.school_owner_invitations%ROWTYPE;
  blockers text[] := ARRAY[]::text[]; active_schools integer;
BEGIN
  SELECT * INTO o FROM hon.organizations WHERE id = p_org;
  SELECT * INTO e FROM hon.organization_entitlements WHERE organization_id = p_org;
  f := hon.saas_access_overview_facts(p_org, p_at);
  lifecycle := f->>'lifecycle';
  -- The canonical entitlement view (hon.saas_entitlement_json), judged at the same instant as every other fact.
  ent := CASE WHEN e.organization_id IS NULL THEN NULL ELSE jsonb_build_object('tier', e.tier::text, 'status', e.status::text,
    'effectiveFrom', hon.saas_ts(e.effective_from), 'effectiveUntil', hon.saas_ts(e.effective_until), 'version', e.version,
    'inEffect', (f->>'inEffect')::boolean) END;
  SELECT * INTO x FROM hon.saas_access_exceptions WHERE organization_id = p_org AND status = 'GRANTED';
  SELECT * INTO s FROM hon.saas_subscriptions WHERE organization_id = p_org AND status <> 'VOIDED' ORDER BY created_at DESC, id LIMIT 1;
  open_checkout := EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE organization_id = p_org AND status IN ('CREATED','OPEN','PAID_NEEDS_REVIEW'));
  -- Owner onboarding: an accepted invitation at any of the organization's schools wins; otherwise the latest invitation.
  SELECT * INTO inv FROM hon.school_owner_invitations WHERE organization_id = p_org
    ORDER BY (status = 'ACCEPTED') DESC, CASE WHEN status = 'ACCEPTED' THEN accepted_at END DESC NULLS LAST, created_at DESC, id DESC LIMIT 1;
  SELECT count(*) INTO active_schools FROM hon.schools WHERE organization_id = p_org AND status = 'ACTIVE';

  -- Mirrors, in order, the refusals of hon.grant_saas_access_exception (0186). Advisory: the command decides again.
  IF o.status::text <> 'ACTIVE' THEN blockers := array_append(blockers, 'ORGANIZATION_NOT_ACTIVE'); END IF;
  IF active_schools = 0 THEN blockers := array_append(blockers, 'NO_ACTIVE_SCHOOL'); END IF;
  IF e.organization_id IS NULL THEN blockers := array_append(blockers, 'NO_ENTITLEMENT'); END IF;
  IF NOT p_policy_ready THEN blockers := array_append(blockers, 'EXCEPTION_POLICY_REQUIRED'); END IF;
  IF lifecycle IN ('SCHEDULED','IN_EFFECT') THEN blockers := array_append(blockers, 'ACCESS_EXCEPTION_ACTIVE'); END IF;
  IF (f->>'inEffect')::boolean THEN blockers := array_append(blockers, 'ENTITLEMENT_IN_EFFECT'); END IF;
  IF f->>'state' IS NOT NULL THEN blockers := array_append(blockers, 'ACCESS_STATE_EXISTS'); END IF;
  IF s.id IS NOT NULL THEN blockers := array_append(blockers, 'SUBSCRIPTION_EXISTS'); END IF;
  IF open_checkout THEN blockers := array_append(blockers, 'CHECKOUT_OPEN'); END IF;

  RETURN jsonb_build_object(
    'organizationId', o.id,
    'organizationDisplayName', left(o.display_name, 300),
    'organizationStatus', o.status::text,
    'createdAt', hon.saas_ts(o.created_at),
    'schools', (SELECT coalesce(jsonb_agg(jsonb_build_object('schoolId', sc.id, 'schoolDisplayName', left(sc.name, 300), 'schoolStatus', sc.status::text)
        ORDER BY sc.created_at, sc.id), '[]'::jsonb)
      FROM (SELECT * FROM hon.schools WHERE organization_id = p_org ORDER BY created_at, id LIMIT 10) sc),
    'schoolCount', (SELECT count(*) FROM hon.schools WHERE organization_id = p_org),
    'entitlement', ent,
    'accessState', CASE WHEN f->>'state' IS NOT NULL THEN f->>'state' WHEN ent IS NULL THEN 'NONE' ELSE 'PROVISIONED' END,
    'accessStatus', f->>'status',
    'currentException', CASE WHEN x.id IS NULL THEN NULL ELSE jsonb_build_object('exceptionId', x.id, 'schoolId', x.school_id,
      'purpose', x.purpose, 'scopeTier', x.scope_tier, 'startsAt', hon.saas_ts(x.starts_at), 'expiresAt', hon.saas_ts(x.expires_at),
      'lifecycle', lifecycle, 'revocable', lifecycle IN ('IN_EFFECT','SCHEDULED')) END,
    'subscription', CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('subscriptionId', s.id, 'status', s.status,
      'planCode', s.plan_code, 'billingInterval', s.billing_interval) END,
    'openCheckout', open_checkout,
    'ownerOnboarding', jsonb_build_object(
      'status', CASE WHEN inv.id IS NULL THEN 'NOT_INVITED' WHEN inv.status = 'PENDING' AND inv.expires_at <= p_at THEN 'EXPIRED' ELSE inv.status END,
      'invitedAt', hon.saas_ts(inv.created_at), 'expiresAt', hon.saas_ts(inv.expires_at), 'acceptedAt', hon.saas_ts(inv.accepted_at)),
    'exceptionGrant', jsonb_build_object('eligible', cardinality(blockers) = 0, 'blockers', to_jsonb(blockers),
      'expectedEntitlementVersion', e.version));
END $$;

CREATE FUNCTION hon.read_saas_access_overview_from_hq(p_subject text, p_status text, p_after_created_at timestamptz, p_after_org uuid,
  p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; v_policy hon.saas_exception_policy_decisions%ROWTYPE; ready boolean; v_rows jsonb; page jsonb; summary jsonb; is_owner boolean;
  at timestamptz := clock_timestamp();
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR ((p_after_created_at IS NULL) <> (p_after_org IS NULL))
    OR (p_status IS NOT NULL AND p_status NOT IN ('AWAITING_FIRST_PAYMENT','EXCEPTION_IN_EFFECT','EXCEPTION_SCHEDULED','PAID_ACCESS',
      'PROVISIONED_ACCESS','NO_ACCESS')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  -- HQ owner, or HQ operator with hq.billing.manage (the same reader rule as every SaaS HQ read).
  actor := hon.require_saas_hq_actor(p_subject, false);
  is_owner := EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = actor AND g.hq_role = 'HON_HQ_OWNER'
    AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp()));
  v_policy := hon.saas_exception_policy_ready();
  ready := v_policy.id IS NOT NULL;

  -- Summary and filter use the light per-organization facts; full rows are built only for the page.
  WITH r AS (
    SELECT date_trunc('milliseconds', o.created_at) AS k, o.id, hon.saas_access_overview_facts(o.id, at) ->> 'status' AS st FROM hon.organizations o
  )
  SELECT (SELECT jsonb_object_agg(k, coalesce(c.n, 0)) FROM unnest(ARRAY['AWAITING_FIRST_PAYMENT','EXCEPTION_IN_EFFECT','EXCEPTION_SCHEDULED',
      'PAID_ACCESS','PROVISIONED_ACCESS','NO_ACCESS']) k
      LEFT JOIN (SELECT r.st, count(*) n FROM r GROUP BY 1) c ON c.st = k) || jsonb_build_object('total', (SELECT count(*) FROM r)),
    (SELECT coalesce(jsonb_agg(hon.saas_access_overview_row(p.id, ready, at) ORDER BY p.k, p.id), '[]'::jsonb) FROM (
      SELECT r.k, r.id FROM r WHERE (p_status IS NULL OR r.st = p_status)
        AND (p_after_created_at IS NULL OR (r.k, r.id) > (p_after_created_at, p_after_org))
      ORDER BY r.k, r.id LIMIT p_limit + 1) p)
  INTO summary, v_rows;

  page := CASE WHEN jsonb_array_length(v_rows) > p_limit THEN v_rows - p_limit ELSE v_rows END;
  RETURN jsonb_build_object(
    'viewer', jsonb_build_object('canGrantAndRevokeExceptions', is_owner),
    'paidAccessProgram', CASE WHEN hon.saas_access_program_active() THEN 'ACTIVE' ELSE 'INACTIVE' END,
    'exceptionPolicy', jsonb_build_object('ready', ready, 'maxDays', v_policy.max_days, 'validUntil', hon.saas_ts(v_policy.valid_until),
      'maxScheduleAheadDays', 30),
    'summary', summary,
    'organizations', page,
    'limit', p_limit,
    'nextCursor', CASE WHEN jsonb_array_length(v_rows) > p_limit THEN jsonb_build_object('createdAt', page->-1->'createdAt',
      'organizationId', page->-1->'organizationId') ELSE NULL END,
    'asOf', hon.saas_ts(at));
END $$;

COMMENT ON FUNCTION hon.read_saas_access_overview_from_hq(text,text,timestamptz,uuid,integer) IS
  'B-HQ-1: read-only HQ overview of every organization''s access standing and advisory D9 exception eligibility. Writes nothing.';

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.saas_exception_policy_ready()','hon.saas_access_overview_facts(uuid,timestamptz)','hon.saas_access_overview_row(uuid,boolean,timestamptz)',
    'hon.read_saas_access_overview_from_hq(text,text,timestamptz,uuid,integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_access_overview_from_hq(text,text,timestamptz,uuid,integer) TO hon_runtime;
  END IF;
END $$;

COMMIT;
