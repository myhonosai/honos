BEGIN;

-- 0429 (allocated by the coordinator 2026-11-17): AI team group chat. The school Dashboard's team chat asks HON and
-- the read-only analysis specialists (Claire, Alex, Jordan, Lena) in one conversation, one turn each, through the
-- unchanged turn and spend path. This migration lets HON read what that team answered, so the person can ask HON to
-- turn a team round into one plan. Spec: docs/architecture/HON_TEAM_CHAT.md.
--
-- 1. prepare_hon_reply (0284 body plus this change only): HON's history is the last 6 turns (was 3). An earlier
--    COMPLETED answer from Claire, Alex, Jordan or Lena is included as 'answer' (first 900 characters), next to the
--    existing 'delegatedTo', only while hon.hon_reply_source_allowed says this human may see it now. Maya's answers (one
--    named student's 0259 row) and the draft specialists' work (Marcus, Chad, Kai) never reach HON as text.
-- 2. The permissions those included answers used are stored on HON's invocation (source_permissions), re-checked at
--    the live clock before anything leaves prepare (a lapse BLOCKS with SOURCE_ACCESS_REFUSED, nothing reserved or
--    sent), and hon.hon_reply_source_allowed conceals HON's answer later if any of them lapses (the 0260 rule).
-- 3. available_sources marks 'specialistResults' when team answers were included ("Based on: Specialist results").
-- 4. The source_permissions check admits HON rows with the three analysis permissions only (never Maya's retention or
--    tuition permissions).
-- Unchanged: S4 (budget lock first, HQ pause, access decision, reserve/settle, UNKNOWN), budgets, plans, analysts' own
-- turns (still no history), suggestions, continuations and C3b group summaries. No new table, grant or provider.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON team chat answers require a trusted migration owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'hon.hon_reply_invocations'::regclass
                 AND conname = 'hon_reply_invocations_source_permissions_closed') THEN
    RAISE EXCEPTION 'Apply migration 0284 first';
  END IF;
END $$;

ALTER TABLE hon.hon_reply_invocations DROP CONSTRAINT hon_reply_invocations_source_permissions_closed;
ALTER TABLE hon.hon_reply_invocations ADD CONSTRAINT hon_reply_invocations_source_permissions_closed
  CHECK (source_permissions <@ ARRAY['reporting.view', 'schedule.session.manage', 'marketing.campaign.read', 'retention.review.read',
                                     'billing.invoice.payment.record', 'billing.invoice.issue', 'billing.invoice.create']::text[]
         AND (specialist IN ('hon', 'alex', 'jordan', 'lena', 'maya') OR cardinality(source_permissions) = 0)
         AND (specialist = 'maya' OR NOT source_permissions && ARRAY['retention.review.read', 'billing.invoice.payment.record',
                                                                     'billing.invoice.issue', 'billing.invoice.create']::text[]));

-- 0284 body plus the 0429 team answers (see header 1-3).
CREATE OR REPLACE FUNCTION hon.prepare_hon_reply(p_subject text, p_turn uuid, p_plan uuid, p_ready boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id());
  actor uuid := hon.hon_conversation_actor(p_subject); lim jsonb;
  i hon.hon_reply_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; t hon.hon_conversation_turns%ROWTYPE;
  why text; school_facts jsonb; history jsonb; facts jsonb; continuation jsonb; has_reporting boolean; derived boolean := false;
  prior hon.hon_reply_invocations%ROWTYPE; grp jsonb; notes jsonb;
  -- 0260: Alex, Jordan and Lena read their own facts through hon.read_specialist_school_facts.
  analyst boolean; spec jsonb; spec_perms text[] := '{}'; metrics jsonb;
  -- 0429: what the team (Claire, Alex, Jordan, Lena) answered earlier in this conversation, and the permissions it used.
  team_perms text[] := '{}'; team_answers integer := 0;
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF i.status <> 'PENDING' THEN RETURN NULL; END IF;
  lim := hon.hon_reply_limits(i.reply_mode);
  -- Every row this prepare writes is locked before any decision (work item first, as the planner does), so no wait can
  -- fall between the authority checks below and the provider input leaving this function.
  PERFORM 1 FROM hon.work_items WHERE id = i.work_item_id FOR UPDATE;
  -- The row locks can wait behind a concurrent resend: conversation authority is held and checked again first.
  PERFORM hon.hon_conversation_hold_actor(p_subject, actor);
  -- After every wait above: the live-clock access gate (Complete at clock_timestamp(), not the transaction start).
  IF NOT hon.hon_reply_access(p_subject) THEN why := 'AI_ACCESS_REFUSED'; END IF;
  has_reporting := hon.principal_has_school_permission(actor, i.organization_id, i.school_id, 'reporting.view');
  -- A continuation of a reporting-derived answer needs that source authority now; otherwise nothing is reserved.
  IF why IS NULL AND i.continues_turn_id IS NOT NULL THEN
    SELECT * INTO prior FROM hon.hon_reply_invocations WHERE turn_id = i.continues_turn_id AND status = 'COMPLETED';
    IF NOT FOUND OR (prior.used_reporting AND NOT has_reporting) THEN why := 'SOURCE_ACCESS_REFUSED'; END IF;
  END IF;
  -- K2: Claire analyses reporting facts only; without reporting.view now nothing is reserved or sent.
  IF why IS NULL AND i.specialist = 'claire' AND NOT has_reporting THEN why := 'SOURCE_ACCESS_REFUSED'; END IF;
  -- 0260: Alex, Jordan and Lena need their own capability now (0212 binding); without it nothing is reserved or sent.
  analyst := i.specialist NOT IN ('hon', 'claire');
  IF why IS NULL AND analyst
     AND NOT hon.principal_has_school_permission(actor, i.organization_id, i.school_id, hon.ai_agent_capability_permission(i.specialist)) THEN
    why := 'SOURCE_ACCESS_REFUSED';
  END IF;
  -- C3b: a group summary needs its group still summarizable for this human now; otherwise nothing is reserved.
  IF why IS NULL AND i.summarizes_turn_id IS NOT NULL
     AND hon.hon_orchestration_summary_facts(p_subject, i.conversation_id, actor, i.summarizes_turn_id) IS NULL THEN
    why := 'GROUP_NOT_SUMMARIZABLE';
  END IF;
  IF why IS NULL THEN why := hon.ai_spend_allowed(i.organization_id, clock_timestamp(), 'AGENT_INFERENCE'); END IF;
  IF why IS NULL THEN
    IF p_plan IS NULL THEN why := 'NO_ELIGIBLE_ROUTE';
    ELSE
      SELECT * INTO p FROM hon.ai_invocation_plans WHERE id = p_plan AND organization_id = i.organization_id AND school_id = i.school_id
        AND work_item_id = i.work_item_id AND agent_key = i.specialist AND task_class = lim->>'taskClass' AND input_budget = (lim->>'inputBudget')::integer
        AND output_budget = (lim->>'outputBudget')::integer AND max_provider_cost_microunits = (lim->>'maxProviderCostMicrounits')::bigint;
      IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_PLAN_SWAP' USING ERRCODE = '42501'; END IF;
      IF p.provider_id <> 'OPENROUTER' THEN why := 'UNSUPPORTED_PROVIDER'; ELSIF NOT p_ready THEN why := 'CONFIGURATION_REQUIRED'; END IF;
    END IF;
  END IF;
  -- ai.budget:<org> is already held (first declaration above).
  IF why IS NULL AND hon.ai_org_committed_credits(i.organization_id, clock_timestamp()) + p.customer_credit_estimate
                     > hon.ai_org_ceiling(i.organization_id, clock_timestamp()) THEN
    why := 'CUSTOMER_BUDGET_EXCEEDED';
  END IF;
  UPDATE hon.hon_reply_invocations SET plan_id = p.id,
    status = CASE WHEN why IS NULL THEN 'SENDING' WHEN why = 'CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,
    reason = why, reserved_credits = CASE WHEN why IS NULL THEN p.customer_credit_estimate ELSE 0 END, updated_at = clock_timestamp()
  WHERE id = i.id;
  UPDATE hon.work_items SET status = CASE WHEN why IS NULL THEN 'WORKING' ELSE 'NEEDS_ATTENTION' END, version = version + 1, updated_at = clock_timestamp()
  WHERE id = i.work_item_id;
  IF why IS NOT NULL THEN RETURN NULL; END IF;
  -- Authorized school context only (see header). The Command Center projection re-checks reporting.view itself.
  IF has_reporting AND NOT analyst THEN
    BEGIN
      school_facts := hon.read_school_command_center(p_subject, i.organization_id, i.school_id)->'metrics';
    -- A refused fresh read means no reporting authority for this whole context: no protected history either.
    EXCEPTION WHEN insufficient_privilege THEN school_facts := NULL; has_reporting := false;
    END;
    metrics := school_facts;
  ELSIF analyst THEN
    -- 0260: the specialist's own aggregate facts, read fresh; the reader re-checks every permission it uses and names
    -- them (sourcePermissions), so the answer is concealed later if any of them lapses.
    BEGIN
      spec := hon.read_specialist_school_facts(p_subject, i.specialist, i.organization_id, i.school_id,
        (SELECT x.delegation FROM hon.hon_conversation_turns x WHERE x.id = i.turn_id));
    EXCEPTION WHEN insufficient_privilege THEN spec := NULL;
    END;
    school_facts := spec->'facts';
    spec_perms := coalesce(ARRAY(SELECT jsonb_array_elements_text(spec->'sourcePermissions')), '{}');
    metrics := school_facts->'commandCenter';
  END IF;
  SELECT * INTO STRICT t FROM hon.hon_conversation_turns WHERE id = i.turn_id;
  -- K2/0260: an analysis specialist gets its facts and the question only (no conversation history).
  IF i.specialist = 'hon' THEN
  -- 0429 (team chat): the last 6 turns (was 3). An earlier answer from Claire, Alex, Jordan or Lena is included (as
  -- 'answer' with 'delegatedTo' naming who gave it) only while it may be shown to this human now
  -- (hon.hon_reply_source_allowed: every permission its facts used is still held), so HON can turn a team round into one
  -- plan. Maya's answers (one named student's record) and draft specialists' work never reach HON as text.
  SELECT coalesce(jsonb_agg(z.h ORDER BY z.seq), '[]'::jsonb) INTO history FROM (
    SELECT x.seq, jsonb_strip_nulls(jsonb_build_object('question', left(x.text, 400),
        -- A reporting-derived earlier answer is reused only while this human still holds reporting.view.
        -- 0429: an earlier HON answer (a team plan) is also reused only while hon_reply_source_allowed shows it.
        'answer', CASE WHEN x.agent_key = 'hon' AND (NOT r.used_reporting OR has_reporting) AND hon.hon_reply_source_allowed(r) THEN left(r.reply_text, 600)
                       WHEN x.agent_key IN ('claire', 'alex', 'jordan', 'lena') AND r.specialist = x.agent_key AND hon.hon_reply_source_allowed(r)
                       THEN left(r.reply_text, 900) END,
      -- Owner blueprint: a legacy 'claire' teaching delegate (no reply row) is Kai; a K2 Claire analysis is Claire's.
        'delegatedTo', CASE WHEN x.agent_key = 'claire' AND NOT EXISTS (SELECT 1 FROM hon.hon_reply_invocations c WHERE c.turn_id = x.id) THEN 'kai'
                            WHEN x.agent_key <> 'hon' THEN x.agent_key END)) h
    FROM hon.hon_conversation_turns x
    LEFT JOIN hon.hon_reply_invocations r ON r.turn_id = x.id AND r.status = 'COMPLETED'
    WHERE x.conversation_id = t.conversation_id AND x.seq < t.seq
    ORDER BY x.seq DESC LIMIT 6) z;
  SELECT coalesce(bool_or(r.used_reporting AND has_reporting), false),
         coalesce(array_agg(DISTINCT q.p) FILTER (WHERE q.p IS NOT NULL), '{}'),
         count(DISTINCT r.id) FILTER (WHERE r.specialist <> 'hon')
    INTO derived, team_perms, team_answers FROM (
    SELECT x.id FROM hon.hon_conversation_turns x WHERE x.conversation_id = t.conversation_id AND x.seq < t.seq ORDER BY x.seq DESC LIMIT 6) z
    JOIN hon.hon_reply_invocations r ON r.turn_id = z.id AND r.status = 'COMPLETED'
      AND r.specialist IN ('hon', 'claire', 'alex', 'jordan', 'lena') AND hon.hon_reply_source_allowed(r)
      AND (r.specialist <> 'hon' OR NOT r.used_reporting OR has_reporting)
    -- Every row's permissions, HON's too: a plan built on an earlier plan inherits what that plan depended on.
    LEFT JOIN LATERAL unnest(r.source_permissions) q(p) ON true;
  END IF;
  -- A continuation also gets the answer's original question and the end of the part already given (data only).
  IF i.continues_turn_id IS NOT NULL THEN
    WITH RECURSIVE chain AS (
      SELECT r.turn_id, r.continues_turn_id FROM hon.hon_reply_invocations r WHERE r.turn_id = i.continues_turn_id
      UNION ALL
      SELECT r.turn_id, r.continues_turn_id FROM hon.hon_reply_invocations r JOIN chain c ON r.turn_id = c.continues_turn_id)
    SELECT jsonb_build_object('step', i.step, 'maxSteps', hon.hon_reply_max_steps(),
        'originalQuestion', (SELECT left(x.text, 2000) FROM chain c JOIN hon.hon_conversation_turns x ON x.id = c.turn_id WHERE c.continues_turn_id IS NULL),
        'previousAnswerEnd', (SELECT right(r.reply_text, 2500) FROM hon.hon_reply_invocations r WHERE r.turn_id = i.continues_turn_id AND r.status = 'COMPLETED'))
      INTO continuation;
    derived := derived OR prior.used_reporting;
  END IF;
  -- C3b: the group's recorded outcomes, read last (a source answer derived from reporting makes the context derived).
  IF i.summarizes_turn_id IS NOT NULL THEN
    grp := hon.hon_orchestration_summary_facts(p_subject, i.conversation_id, actor, i.summarizes_turn_id);
    derived := derived OR coalesce((SELECT r.used_reporting FROM hon.hon_reply_invocations r WHERE r.turn_id = i.summarizes_turn_id), false);
  END IF;
  -- Final live-clock revalidation before any context leaves prepare: access (Complete at clock_timestamp()) and, when the
  -- context carries reporting-derived material, reporting.view. A lapse here releases the reservation and sends nothing.
  why := CASE WHEN NOT hon.hon_reply_access(p_subject) THEN 'AI_ACCESS_REFUSED'
    WHEN i.summarizes_turn_id IS NOT NULL AND grp IS NULL THEN 'GROUP_NOT_SUMMARIZABLE'
    WHEN i.specialist = 'claire' AND school_facts IS NULL THEN 'SOURCE_ACCESS_REFUSED'
    WHEN analyst AND (spec IS NULL OR cardinality(spec_perms) = 0 OR EXISTS (SELECT 1 FROM unnest(spec_perms) q
      WHERE NOT hon.principal_has_school_permission(actor, i.organization_id, i.school_id, q))) THEN 'SOURCE_ACCESS_REFUSED'
    WHEN NOT analyst AND (school_facts IS NOT NULL OR derived) AND NOT hon.principal_has_school_permission(actor, i.organization_id, i.school_id, 'reporting.view') THEN 'SOURCE_ACCESS_REFUSED'
    -- 0429: every permission the included team answers used, re-checked at the live clock.
    WHEN NOT analyst AND EXISTS (SELECT 1 FROM unnest(team_perms) q
      WHERE NOT hon.principal_has_school_permission(actor, i.organization_id, i.school_id, q)) THEN 'SOURCE_ACCESS_REFUSED' END;
  IF why IS NOT NULL THEN
    UPDATE hon.hon_reply_invocations SET status = 'BLOCKED', reason = why, reserved_credits = 0, updated_at = clock_timestamp() WHERE id = i.id;
    UPDATE hon.work_items SET status = 'NEEDS_ATTENTION', version = version + 1, updated_at = clock_timestamp() WHERE id = i.work_item_id;
    RETURN NULL;
  END IF;
  -- 0255: the school's saved notes (newest first) for HON answers only; Claire keeps metrics only.
  IF i.specialist = 'hon' THEN
    SELECT nullif(coalesce(jsonb_agg(n.body ORDER BY n.created_at DESC, n.id), '[]'::jsonb), '[]'::jsonb) INTO notes
    FROM hon.hon_school_notes n WHERE n.organization_id = i.organization_id AND n.school_id = i.school_id AND n.deleted_at IS NULL;
  END IF;
  facts := jsonb_strip_nulls(jsonb_build_object('school', coalesce(school_facts, jsonb_build_object('availability', 'NOT_AUTHORIZED')), 'history', history,
    'continuation', continuation, 'group', grp, 'schoolNotes', notes));
  -- 0254: the closed fact areas this context actually carries, for "Based on": AVAILABLE metrics (in the closed key
  -- order), the earlier conversation (history or a continuation) and recorded specialist results (a group).
  UPDATE hon.hon_reply_invocations SET available_sources = ARRAY(
      SELECT k FROM unnest(hon.hon_reply_source_keys()) WITH ORDINALITY s(k, n)
      WHERE (k NOT IN ('conversation', 'specialistResults') AND metrics->k->>'availability' = 'AVAILABLE')
         OR (k = 'conversation' AND (jsonb_array_length(coalesce(history, '[]'::jsonb)) > 0 OR continuation IS NOT NULL))
         OR (k = 'specialistResults' AND (grp IS NOT NULL OR team_answers > 0))
         OR (k = 'schoolNotes' AND notes IS NOT NULL)
      ORDER BY n)
  WHERE id = i.id;
  UPDATE hon.hon_reply_invocations SET used_reporting = CASE WHEN analyst THEN 'reporting.view' = ANY (spec_perms) ELSE school_facts IS NOT NULL OR derived END,
    -- 0429: HON's answer is concealed later if any permission behind the team answers it used lapses.
    source_permissions = CASE WHEN analyst THEN spec_perms ELSE team_perms END, context_digest = encode(sha256(convert_to(jsonb_build_object('question', t.text, 'facts', facts)::text, 'UTF8')), 'hex')
  WHERE id = i.id;
  RETURN jsonb_build_object('providerId', p.provider_id, 'modelId', p.model_id, 'providerRequestId', i.provider_request_id,
    'specialist', i.specialist, 'replyMode', i.reply_mode, 'step', i.step, 'question', t.text, 'facts', facts::text, 'inputBudget', p.input_budget, 'outputBudget', p.output_budget,
    'maxCostMicrounits', p.max_provider_cost_microunits);
END $$;


COMMIT;
