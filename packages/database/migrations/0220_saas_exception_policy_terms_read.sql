BEGIN;

-- D10-UI (proposed 0220): the HQ exception-policy read also names the current access terms the next decision must cite
-- and whether this reader may decide. Read-only: no table, grant, trigger or decision rule changes. The decision command
-- (0186) still re-checks the HQ owner, revision, terms version and maximum length on every write.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Exception-policy read requires a trusted migration owner';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.read_saas_exception_policy(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE history jsonb; p jsonb; state text; at timestamptz:=clock_timestamp(); actor uuid; is_owner boolean; t hon.saas_access_policy_terms%ROWTYPE;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject,false);
  is_owner := EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = actor AND g.hq_role = 'HON_HQ_OWNER'
    AND g.effective_from <= at AND (g.effective_until IS NULL OR g.effective_until > at));
  SELECT * INTO t FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1;
  SELECT coalesce(jsonb_agg(hon.saas_exception_policy_json(x) ORDER BY revision DESC),'[]'::jsonb) INTO history
    FROM hon.saas_exception_policy_decisions x WHERE x.id IN (SELECT id FROM hon.saas_exception_policy_decisions ORDER BY revision DESC LIMIT 100);
  p:=history->0;
  state:=CASE WHEN p IS NULL THEN 'ABSENT' WHEN p->>'status'<>'APPROVED' THEN p->>'status'
    WHEN (p->>'termsVersion')::int IS DISTINCT FROM t.policy_version THEN 'SUPERSEDED'
    WHEN (p->>'validFrom')::timestamptz>at THEN 'SCHEDULED' WHEN (p->>'validUntil')::timestamptz<=at THEN 'EXPIRED' ELSE 'ACTIVE' END;
  RETURN jsonb_build_object('scope','ACCESS_EXCEPTIONS_ONLY','current',p,'effectiveStatus',state,'history',history,'historyLimit',100,'asOf',hon.saas_ts(at),
    'termsStatus',t.status,
    'terms',jsonb_build_object('policyVersion',t.policy_version,'exceptionMaxDays',t.exception_max_days,'exceptionAuthority',t.exception_authority),
    'viewer',jsonb_build_object('canDecide',is_owner),
    'paidAccessProgram',(SELECT status FROM hon.saas_access_program),'aiCreditProgram',(SELECT status FROM hon.saas_credit_program));
END $$;

COMMIT;
