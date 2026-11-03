BEGIN;
-- S4-d UNKNOWN outcome resolution (AI-8, KF-AI8). Owner decision AI-D3 (2026-10-31): a human HQ owner resolves
-- an UNKNOWN provider outcome with provider evidence; no automatic retry, release or refund. Build authorized
-- 2026-11-01. Schools never pay money for agent credits, so resolving only releases a hold; no money moves.
--
-- 1. Window-scoped counting. An UNKNOWN hold, or a SENDING hold older than the stale limit (the provider answered
--    but nothing could be recorded), counts against its organization only in the budget window in which it was
--    held. After that window it stops limiting the school but stays in the HQ queue until resolved. A fresh SENDING
--    hold (a call in flight) always counts, so a call that crosses a window boundary is never double-allowed.
-- 2. hon.resolve_ai_unknown_invocation: human HQ owner only; RECORD_PROVIDER_COST writes exactly one ledger row in
--    the ORIGINAL window, NO_PROVIDER_CHARGE writes none, WRITE_OFF writes a zero-credit row with the best-known
--    cost. Each releases the hold, is idempotent per key, and writes an immutable resolution, an audit row and an
--    inert outbox event.
-- 3. hon.read_ai_unknown_invocations_from_hq: the HQ queue (open items and recent resolutions).

-- A SENDING hold older than this is treated as an UNKNOWN outcome for counting and resolution. Provider calls time
-- out in seconds; an hour leaves a wide margin before a live call could be mistaken for a lost one.
CREATE FUNCTION hon.ai_sending_stale_after() RETURNS interval LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT interval '1 hour';
$$;

-- Whether one agent hold counts against the organization budget at p_at.
CREATE FUNCTION hon.ai_hold_counts(p_status text, p_held_at timestamptz, p_window tstzrange, p_at timestamptz) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE
    WHEN p_status = 'SENDING' AND p_held_at > p_at - hon.ai_sending_stale_after() THEN true   -- in flight
    WHEN p_status IN ('UNKNOWN','SENDING') THEN p_held_at <@ p_window                        -- lost outcome: its window only
    ELSE true                                                                                -- any other hold: always (fail closed)
  END;
$$;

CREATE OR REPLACE FUNCTION hon.ai_org_committed_credits(p_org uuid, p_at timestamptz) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  -- Agent-inference ledger credits in the window plus every agent hold that counts (hon.ai_hold_counts), across all
  -- three agents and all schools of the organization. Callers hold ai.budget:<org> (hon.ai_budget_lock) and evaluate
  -- this in a statement that starts after the lock (READ COMMITTED), so every earlier committed hold is visible.
  -- A hold's time is its row's updated_at: prepare sets SENDING and fail_* sets UNKNOWN in the same call.
  WITH w AS (SELECT hon.ai_spend_window(p_org, p_at) AS r)
  SELECT (SELECT coalesce(sum(u.customer_credits),0) FROM hon.ai_usage_ledger u, w
           WHERE u.organization_id=p_org AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=lower(w.r) AND u.occurred_at<upper(w.r))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.marketing_ai_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.updated_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.teaching_ai_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.updated_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.chad_follow_up_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.updated_at,w.r,p_at));
$$;

-- Immutable resolution record: one per invocation; the evidence HQ entered; the ledger row it wrote, if any.
CREATE TABLE hon.ai_unknown_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL CHECK (agent IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP')),
  invocation_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  prior_status text NOT NULL CHECK (prior_status IN ('UNKNOWN','SENDING')),
  held_at timestamptz NOT NULL,
  released_credits integer NOT NULL CHECK (released_credits > 0),
  decision text NOT NULL CHECK (decision IN ('RECORD_PROVIDER_COST','NO_PROVIDER_CHARGE','WRITE_OFF')),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 10 AND 500),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  ledger_entry_id uuid UNIQUE REFERENCES hon.ai_usage_ledger(id) ON DELETE RESTRICT,
  resolution_key uuid NOT NULL UNIQUE,
  resolution_fingerprint text NOT NULL,
  resolved_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (agent, invocation_id),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  CHECK ((decision = 'NO_PROVIDER_CHARGE') = (ledger_entry_id IS NULL))
);
ALTER TABLE hon.ai_unknown_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_unknown_resolutions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.ai_unknown_resolutions FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.ai_unknown_resolutions FROM %I', r);
  END LOOP;
END $$;
CREATE FUNCTION hon.guard_ai_unknown_resolutions() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  RAISE EXCEPTION 'AI_UNKNOWN_RESOLUTION_IMMUTABLE' USING ERRCODE='55000';
END $$;
CREATE TRIGGER ai_unknown_resolutions_immutable BEFORE UPDATE OR DELETE ON hon.ai_unknown_resolutions FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_unknown_resolutions();
CREATE TRIGGER ai_unknown_resolutions_no_truncate BEFORE TRUNCATE ON hon.ai_unknown_resolutions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_unknown_resolutions();

CREATE FUNCTION hon.ai_unknown_receipt(r hon.ai_unknown_resolutions, p_replayed boolean) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('resolutionId',r.id,'agent',r.agent,'invocationId',r.invocation_id,'organizationId',r.organization_id,'schoolId',r.school_id,
    'decision',r.decision,'releasedCredits',r.released_credits,'ledgerEntryId',r.ledger_entry_id,
    'customerCredits',(SELECT u.customer_credits FROM hon.ai_usage_ledger u WHERE u.id=r.ledger_entry_id),
    'resolvedAt',hon.saas_ts(r.resolved_at),'replayed',p_replayed);
$$;

-- Validates the closed resolution input. Returns NULL when valid, else raises 22023.
CREATE FUNCTION hon.ai_unknown_validate(p_agent text, p_input jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE e jsonb := p_input->'evidence'; d text := p_input->>'decision';
  nonneg CONSTANT text := '^(0|[1-9][0-9]{0,11})$'; ref CONSTANT text := '^[A-Za-z0-9._:-]{1,200}$';
BEGIN
  IF p_agent IS NULL OR p_agent NOT IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP') OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k), ARRAY[]::text[]) <> ARRAY['decision','evidence','reason']
     OR jsonb_typeof(p_input->'decision') <> 'string' OR d NOT IN ('RECORD_PROVIDER_COST','NO_PROVIDER_CHARGE','WRITE_OFF')
     OR jsonb_typeof(p_input->'reason') <> 'string' OR (p_input->>'reason') <> btrim(p_input->>'reason') OR length(p_input->>'reason') NOT BETWEEN 10 AND 500
     OR jsonb_typeof(e) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_AI_UNKNOWN_RESOLUTION' USING ERRCODE='22023';
  END IF;
  IF d = 'RECORD_PROVIDER_COST' AND NOT (
       coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k), ARRAY[]::text[]) = ARRAY['inputTokens','outputTokens','providerCostMicrounits','providerGenerationId']
       AND jsonb_typeof(e->'providerGenerationId') = 'string' AND (e->>'providerGenerationId') ~ ref
       AND jsonb_typeof(e->'inputTokens') = 'number' AND (e->>'inputTokens') ~ nonneg AND (e->>'inputTokens')::bigint <= 100000000
       AND jsonb_typeof(e->'outputTokens') = 'number' AND (e->>'outputTokens') ~ nonneg AND (e->>'outputTokens')::bigint <= 100000000
       AND jsonb_typeof(e->'providerCostMicrounits') = 'number' AND (e->>'providerCostMicrounits') ~ nonneg) THEN
    RAISE EXCEPTION 'INVALID_AI_UNKNOWN_RESOLUTION' USING ERRCODE='22023';
  END IF;
  IF d = 'NO_PROVIDER_CHARGE' AND NOT (
       coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k), ARRAY[]::text[]) = ARRAY['providerLookupReference']
       AND jsonb_typeof(e->'providerLookupReference') = 'string' AND (e->>'providerLookupReference') ~ ref) THEN
    RAISE EXCEPTION 'INVALID_AI_UNKNOWN_RESOLUTION' USING ERRCODE='22023';
  END IF;
  IF d = 'WRITE_OFF' AND NOT (
       coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k), ARRAY[]::text[]) = ARRAY['estimatedProviderCostMicrounits']
       AND jsonb_typeof(e->'estimatedProviderCostMicrounits') = 'number' AND (e->>'estimatedProviderCostMicrounits') ~ nonneg) THEN
    RAISE EXCEPTION 'INVALID_AI_UNKNOWN_RESOLUTION' USING ERRCODE='22023';
  END IF;
END $$;

CREATE FUNCTION hon.resolve_ai_unknown_invocation(p_subject text, p_agent text, p_id uuid, p_input jsonb, p_key uuid, p_request_id uuid, p_correlation_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; tbl text; fp text; r hon.ai_unknown_resolutions%ROWTYPE; e jsonb; d text;
  v_org uuid; v_school uuid; v_requester uuid; v_work uuid; v_plan uuid; v_status text; v_reserved integer; v_usage uuid; v_held timestamptz;
  p hon.ai_invocation_plans%ROWTYPE; uid uuid; credits bigint; receipt jsonb;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_id IS NULL OR p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL THEN RAISE EXCEPTION 'INVALID_AI_UNKNOWN_RESOLUTION' USING ERRCODE='22023'; END IF;
  PERFORM hon.ai_unknown_validate(p_agent, p_input);
  d := p_input->>'decision'; e := p_input->'evidence';
  fp := encode(sha256(convert_to(jsonb_build_object('agent',p_agent,'id',p_id,'input',p_input,'by',actor)::text,'UTF8')),'hex');
  -- Authority holds through the mutation (the D9/0185 pattern): the shared lock stops any user, principal, HQ grant
  -- or family grant change until this transaction ends, and authority is checked again after every wait, so an owner
  -- revoked or expired while this command waited is refused before any replay, ledger, audit or outbox write.
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- Replays and concurrent attempts with one key resolve to one row.
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.unknown:' || p_key::text, 0));
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM hon.ai_unknown_resolutions WHERE resolution_key = p_key;
  IF FOUND THEN
    IF r.resolution_fingerprint <> fp THEN RAISE EXCEPTION 'AI_UNKNOWN_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN hon.ai_unknown_receipt(r, true);
  END IF;
  tbl := CASE p_agent WHEN 'MARKETING' THEN 'marketing_ai_invocations' WHEN 'TEACHING' THEN 'teaching_ai_invocations' ELSE 'chad_follow_up_invocations' END;
  -- The invocation row is the only row lock taken; no budget lock is needed because a resolution only releases holds.
  EXECUTE format('SELECT organization_id,school_id,requested_by,work_item_id,plan_id,status,reserved_credits,usage_id,updated_at FROM hon.%I WHERE id=$1 FOR UPDATE', tbl)
    INTO v_org, v_school, v_requester, v_work, v_plan, v_status, v_reserved, v_usage, v_held USING p_id;
  -- The invocation row lock can wait behind a recording or another resolution: check authority again after it.
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'AI_UNKNOWN_INVOCATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_usage IS NOT NULL OR v_reserved IS NULL OR v_reserved <= 0 OR v_plan IS NULL
     OR NOT (v_status = 'UNKNOWN' OR (v_status = 'SENDING' AND v_held <= clock_timestamp() - hon.ai_sending_stale_after())) THEN
    RAISE EXCEPTION 'AI_UNKNOWN_NOT_RESOLVABLE' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id = v_plan;
  IF d = 'RECORD_PROVIDER_COST' THEN
    credits := ((e->>'inputTokens')::bigint + (e->>'outputTokens')::bigint + 999) / 1000;
    INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,
        provider_cost_microunits,customer_credits,correlation_id,source_invocation_id,spend_class,occurred_at)
      VALUES (v_org,v_school,v_requester,v_work,p.provider_id,p.model_id,'TEXT',(e->>'inputTokens')::bigint,(e->>'outputTokens')::bigint,
        (e->>'providerCostMicrounits')::bigint,credits,p_correlation_id,p_id,'AGENT_INFERENCE',v_held)
      RETURNING id INTO uid;
  ELSIF d = 'WRITE_OFF' THEN
    INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,
        provider_cost_microunits,customer_credits,correlation_id,source_invocation_id,spend_class,occurred_at)
      VALUES (v_org,v_school,v_requester,v_work,p.provider_id,p.model_id,'TEXT',0,0,(e->>'estimatedProviderCostMicrounits')::bigint,0,p_correlation_id,p_id,'AGENT_INFERENCE',v_held)
      RETURNING id INTO uid;
  END IF;
  EXECUTE format('UPDATE hon.%I SET status=''UNKNOWN'',reason=''PROVIDER_UNKNOWN'',reserved_credits=0,usage_id=$2,updated_at=clock_timestamp() WHERE id=$1', tbl) USING p_id, uid;
  INSERT INTO hon.ai_unknown_resolutions(agent,invocation_id,organization_id,school_id,prior_status,held_at,released_credits,decision,reason,evidence,ledger_entry_id,
      resolution_key,resolution_fingerprint,resolved_by_principal_id)
    VALUES (p_agent,p_id,v_org,v_school,v_status,v_held,v_reserved,d,p_input->>'reason',e,uid,p_key,fp,actor) RETURNING * INTO r;
  receipt := hon.ai_unknown_receipt(r, false);
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
    VALUES (v_org, v_school, actor, 'HON_HQ', 'hq.ai.unknown_invocation.resolve', 'AI_INVOCATION', p_id,
      jsonb_build_object('agent',p_agent,'status',v_status,'reservedCredits',v_reserved,'heldAt',hon.saas_ts(v_held)), receipt - 'replayed', 'SUCCEEDED', p_request_id, p_correlation_id, now());
  -- Inert: no consumer exists for this event type. It is evidence for later reconciliation reporting.
  INSERT INTO hon.outbox_events (organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
    VALUES (v_org, v_school, 'ai.unknown_invocation.resolved', 1, 'AI_INVOCATION', p_id, 1, p_correlation_id, p_request_id, receipt - 'replayed');
  RETURN receipt;
END $$;

-- HQ queue: open lost outcomes (UNKNOWN, or SENDING past the stale limit) and the latest resolutions.
CREATE FUNCTION hon.read_ai_unknown_invocations_from_hq(p_subject text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_saas_hq_actor(p_subject, false); at timestamptz := clock_timestamp();
BEGIN
  RETURN jsonb_build_object(
    'open', coalesce((SELECT jsonb_agg(jsonb_build_object('agent',o.agent,'invocationId',o.id,'organizationId',o.organization_id,'schoolId',o.school_id,
        'status',o.status,'reservedCredits',o.reserved_credits,'heldAt',hon.saas_ts(o.updated_at),
        'countsAgainstCurrentWindow',o.updated_at <@ hon.ai_spend_window(o.organization_id, at)) ORDER BY o.updated_at, o.id)
      FROM (SELECT * FROM (
          SELECT 'MARKETING' agent,id,organization_id,school_id,status,reserved_credits,updated_at FROM hon.marketing_ai_invocations
          UNION ALL SELECT 'TEACHING',id,organization_id,school_id,status,reserved_credits,updated_at FROM hon.teaching_ai_invocations
          UNION ALL SELECT 'CHAD_FOLLOW_UP',id,organization_id,school_id,status,reserved_credits,updated_at FROM hon.chad_follow_up_invocations) a
        WHERE a.reserved_credits > 0 AND (a.status = 'UNKNOWN' OR (a.status = 'SENDING' AND a.updated_at <= at - hon.ai_sending_stale_after()))
        ORDER BY a.updated_at, a.id LIMIT 200) o), '[]'::jsonb),
    'resolved', coalesce((SELECT jsonb_agg((hon.ai_unknown_receipt(s.x, false) - 'replayed') || jsonb_build_object('reason',(s.x).reason,'evidence',(s.x).evidence,
        'resolvedByPrincipalId',(s.x).resolved_by_principal_id,'priorStatus',(s.x).prior_status,'heldAt',hon.saas_ts((s.x).held_at)) ORDER BY (s.x).resolved_at DESC, (s.x).id)
      FROM (SELECT x FROM hon.ai_unknown_resolutions x ORDER BY x.resolved_at DESC, x.id LIMIT 100) s), '[]'::jsonb),
    'staleAfterSeconds', extract(epoch FROM hon.ai_sending_stale_after())::integer,
    'asOf', hon.saas_ts(at));
END $$;

DO $$ DECLARE f regprocedure; r text; BEGIN
 FOREACH f IN ARRAY ARRAY['hon.ai_sending_stale_after()'::regprocedure,'hon.ai_hold_counts(text,timestamptz,tstzrange,timestamptz)'::regprocedure,
  'hon.ai_org_committed_credits(uuid,timestamptz)'::regprocedure,'hon.guard_ai_unknown_resolutions()'::regprocedure,
  'hon.ai_unknown_receipt(hon.ai_unknown_resolutions,boolean)'::regprocedure,'hon.ai_unknown_validate(text,jsonb)'::regprocedure,
  'hon.resolve_ai_unknown_invocation(text,text,uuid,jsonb,uuid,uuid,uuid)'::regprocedure,'hon.read_ai_unknown_invocations_from_hq(text)'::regprocedure] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.resolve_ai_unknown_invocation(text,text,uuid,jsonb,uuid,uuid,uuid), hon.read_ai_unknown_invocations_from_hq(text) TO hon_runtime;
 END IF;
END $$;
COMMIT;
