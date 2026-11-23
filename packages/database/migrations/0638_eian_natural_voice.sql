BEGIN;

-- Eian natural voice, E-V2 (0638). Eian's answers in the HON Family app can be read aloud in one fixed child voice made by
-- a speech provider instead of the phone's built-in voice. Spec: docs/architecture/PARENT_EIAN_NATURAL_VOICE.md.
-- Owner: David asked for a voice that matches Eian's picture (2026-11-21 04:09Z), chose "Yes, plan it with exact costs"
-- (04:15Z) and picked sample 8 (2026-11-22 06:51Z). That builds the path; a paid call still needs the provider key, the
-- paid-call approval flag, the new natural-voice approval flag and a deploy.
--   V1  Scope and gate: exactly Eian's (hon.eian_scope, hon.eian_access, the 4-argument S4 spend decision, the
--       organization ceiling). The client sends no family, school or organization selector.
--   V2  A clip is one spoken answer. HON stores a digest of the text and its length, never the words or the sound.
--   V3  Limits (hon.eian_speech_limits): 1,500 characters and 20,000 provider microunits per clip; 20 new clips per
--       guardian per rolling 10 minutes; 60 clips per family per UTC day. Replays never count. The daily family limit is
--       for speech only; Eian AI questions keep the owner's "no limit or cap" (D3).
--   V4  Spend: one credit per started 1,000 characters, reserved under the organization budget lock before the call and
--       settled to the measured characters. The clip joins every shared S4 function as the agent EIAN_SPEECH: committed
--       credits, open holds, school committed cost, the HQ UNKNOWN queue, resolve, late expense and the HQ usage read.
--   V5  A speech clip has no route plan: the provider and model are fixed here, so no HQ routing policy applies to it.
--   V6  Runtime gets EXECUTE on five entry points and no table privilege.

CREATE FUNCTION hon.eian_speech_limits() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('maxCharacters',1500,'maxProviderCostMicrounits',20000,'burst',20,'dailyClips',60,
    'providerId','OPENROUTER','modelId','fish-audio/drama-3')
$$;

CREATE TABLE hon.eian_speech_clips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
  family_id uuid NOT NULL REFERENCES hon.families(id),
  requested_by uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key = btrim(idempotency_key) AND idempotency_key !~ '[[:cntrl:]]'),
  text_digest text NOT NULL CHECK (text_digest ~ '^[a-f0-9]{64}$'),
  characters integer NOT NULL CHECK (characters BETWEEN 1 AND 1500),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED', 'SENDING', 'COMPLETED', 'FAILED', 'UNKNOWN')),
  reason text CHECK (reason IS NULL OR reason ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  reserved_credits integer NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  held_at timestamptz,
  usage_id uuid UNIQUE REFERENCES hon.ai_usage_ledger(id),
  provider_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (requested_by, idempotency_key),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id),
  CHECK (status <> 'SENDING' OR reserved_credits > 0)
);
CREATE INDEX eian_speech_clips_hold_idx ON hon.eian_speech_clips (organization_id) WHERE reserved_credits > 0;
CREATE INDEX eian_speech_clips_requester_idx ON hon.eian_speech_clips (requested_by, created_at DESC);
CREATE INDEX eian_speech_clips_family_idx ON hon.eian_speech_clips (family_id, created_at DESC);
ALTER TABLE hon.eian_speech_clips ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.eian_speech_clips FORCE ROW LEVEL SECURITY;

-- The same S4 guards as every agent caller (0474:264-269).
CREATE TRIGGER ai_spend_start_guard BEFORE INSERT ON hon.eian_speech_clips FOR EACH ROW EXECUTE FUNCTION hon.ai_spend_start_guard();
CREATE TRIGGER ai_spend_reserve_guard BEFORE UPDATE OF reserved_credits ON hon.eian_speech_clips
  FOR EACH ROW WHEN (NEW.reserved_credits > OLD.reserved_credits) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER ai_spend_reserve_guard_insert BEFORE INSERT ON hon.eian_speech_clips
  FOR EACH ROW WHEN (NEW.reserved_credits > 0) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER zz_ai_hold_origin BEFORE INSERT OR UPDATE ON hon.eian_speech_clips FOR EACH ROW EXECUTE FUNCTION hon.ai_stamp_hold_origin();

-- Why a new clip could not be made now, or NULL. Closed reasons only; never a ceiling, spend, provider or model.
CREATE FUNCTION hon.eian_speech_unavailable_reason(p_org uuid, p_school uuid, p_ready boolean) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE at timestamptz := clock_timestamp();
BEGIN
  IF NOT hon.hon_reply_complete_live(p_org) THEN RETURN 'NOT_INCLUDED'; END IF;
  IF hon.ai_spend_allowed(p_org, p_school, at, 'AGENT_INFERENCE') IS NOT NULL THEN RETURN 'PAUSED'; END IF;
  IF NOT coalesce(p_ready, false) THEN RETURN 'NOT_CONFIGURED'; END IF;
  IF hon.ai_org_committed_credits(p_org, at) + ((hon.eian_speech_limits()->>'maxCharacters')::integer + 999) / 1000 > hon.ai_org_ceiling(p_org, at) THEN
    RETURN 'BUDGET_REACHED';
  END IF;
  RETURN NULL;
END $$;

-- What the app uses: the natural voice, or the phone's own voice with a closed reason. p_ready is the server's readiness.
CREATE FUNCTION hon.read_eian_speech_status(p_subject text, p_ready boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; why text;
BEGIN
  SELECT * INTO STRICT sc FROM hon.eian_scope(p_subject);
  why := hon.eian_speech_unavailable_reason(sc.organization_id, sc.school_id, p_ready);
  RETURN jsonb_build_object('voice', CASE WHEN why IS NULL THEN 'NATURAL' ELSE 'PHONE' END, 'reason', why);
END $$;

-- Begins one clip for one key. The API passes the sha256 of the exact text it will speak and its length; the words never
-- reach the database. A replay returns the same clip and never counts toward a limit.
CREATE FUNCTION hon.begin_eian_speech(p_subject text, p_key text, p_digest text, p_characters integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; live record; lim jsonb := hon.eian_speech_limits(); c hon.eian_speech_clips%ROWTYPE; n integer;
BEGIN
  SELECT * INTO STRICT sc FROM hon.eian_scope(p_subject);
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_key <> btrim(p_key) OR p_key ~ '[[:cntrl:]]'
     OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'
     OR p_characters IS NULL OR p_characters NOT BETWEEN 1 AND (lim->>'maxCharacters')::integer THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
  END IF;
  -- One key, one clip: replays and races under a key resolve to one row.
  PERFORM pg_advisory_xact_lock(hashtextextended('eian.speech:' || sc.principal_id::text || ':' || p_key, 0));
  SELECT * INTO c FROM hon.eian_speech_clips WHERE requested_by = sc.principal_id AND idempotency_key = p_key;
  IF FOUND THEN
    IF c.text_digest <> p_digest OR c.characters <> p_characters OR c.family_id <> sc.family_id THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('clipId', c.id, 'status', c.status, 'replayed', true);
  END IF;
  IF NOT hon.eian_access(p_subject) OR hon.ai_spend_allowed(sc.organization_id, sc.school_id, clock_timestamp(), 'AGENT_INFERENCE') IS NOT NULL THEN
    RAISE EXCEPTION 'EIAN_SPEECH_UNAVAILABLE' USING ERRCODE = '55000';
  END IF;
  -- Limits, counted under locks so parallel requests cannot all pass. Lock order: family day, then guardian burst.
  PERFORM pg_advisory_xact_lock(hashtextextended('eian.speech.day:' || sc.family_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('eian.speech.burst:' || sc.principal_id::text, 0));
  SELECT count(*) INTO n FROM hon.eian_speech_clips WHERE requested_by = sc.principal_id AND created_at > clock_timestamp() - interval '10 minutes';
  IF n >= (lim->>'burst')::integer THEN RAISE EXCEPTION 'EIAN_SPEECH_BUSY' USING ERRCODE = '54000'; END IF;
  -- The family's day: every clip that was sent or may still be sent. A clip refused before any call does not count.
  SELECT count(*) INTO n FROM hon.eian_speech_clips WHERE family_id = sc.family_id
    AND created_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    AND status NOT IN ('BLOCKED', 'CONFIGURATION_REQUIRED');
  IF n >= (lim->>'dailyClips')::integer THEN RAISE EXCEPTION 'EIAN_SPEECH_DAILY_LIMIT' USING ERRCODE = '54000'; END IF;
  INSERT INTO hon.eian_speech_clips (organization_id, school_id, family_id, requested_by, idempotency_key, text_digest, characters)
    VALUES (sc.organization_id, sc.school_id, sc.family_id, sc.principal_id, p_key, p_digest, p_characters)
    RETURNING * INTO c;
  -- Scope again after every lock and write of the command.
  SELECT * INTO STRICT live FROM hon.eian_scope(p_subject);
  IF live.principal_id IS DISTINCT FROM sc.principal_id OR live.family_id IS DISTINCT FROM sc.family_id THEN
    RAISE EXCEPTION 'EIAN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('clipId', c.id, 'status', c.status, 'replayed', false);
END $$;

-- Moves a pending clip to SENDING (with its reservation) or records why it cannot be sent, then returns the fixed
-- provider input. The organization budget lock is taken first, as in every S4 prepare. Order of refusals: scope,
-- access, S4 spend decision, provider readiness, organization ceiling. A refusal reserves nothing and calls nothing.
CREATE FUNCTION hon.prepare_eian_speech(p_subject text, p_clip uuid, p_ready boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id());
  sc record; live record; lim jsonb := hon.eian_speech_limits(); c hon.eian_speech_clips%ROWTYPE; why text; credits integer;
BEGIN
  SELECT * INTO STRICT sc FROM hon.eian_scope(p_subject);
  SELECT * INTO c FROM hon.eian_speech_clips WHERE id = p_clip AND requested_by = sc.principal_id AND family_id = sc.family_id
    AND organization_id = sc.organization_id AND school_id = sc.school_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EIAN_SPEECH_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF c.status <> 'PENDING' THEN RETURN NULL; END IF;
  credits := (c.characters + 999) / 1000;
  IF NOT hon.eian_access(p_subject) THEN why := 'AI_ACCESS_REFUSED'; END IF;
  IF why IS NULL THEN why := hon.ai_spend_allowed(c.organization_id, c.school_id, clock_timestamp(), 'AGENT_INFERENCE'); END IF;
  IF why IS NULL AND NOT coalesce(p_ready, false) THEN why := 'CONFIGURATION_REQUIRED'; END IF;
  -- ai.budget:<org> is already held (first declaration above).
  IF why IS NULL AND hon.ai_org_committed_credits(c.organization_id, clock_timestamp()) + credits > hon.ai_org_ceiling(c.organization_id, clock_timestamp()) THEN
    why := 'CUSTOMER_BUDGET_EXCEEDED';
  END IF;
  -- Final live-clock revalidation before anything is reserved.
  SELECT * INTO live FROM hon.eian_scope(p_subject);
  IF why IS NULL AND (live.family_id IS DISTINCT FROM c.family_id OR live.principal_id IS DISTINCT FROM c.requested_by) THEN why := 'AI_ACCESS_REFUSED'; END IF;
  UPDATE hon.eian_speech_clips SET
    status = CASE WHEN why IS NULL THEN 'SENDING' WHEN why = 'CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,
    reason = why, reserved_credits = CASE WHEN why IS NULL THEN credits ELSE 0 END, updated_at = clock_timestamp()
  WHERE id = c.id;
  IF why IS NOT NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('providerId', lim->>'providerId', 'modelId', lim->>'modelId', 'providerRequestId', c.provider_request_id,
    'textDigest', c.text_digest, 'characters', c.characters, 'maxCostMicrounits', (lim->>'maxProviderCostMicrounits')::bigint);
END $$;

-- A provider outcome without a result. PRE_SEND and FAILED release the hold; UNKNOWN keeps it for the HQ queue (S4-d).
CREATE FUNCTION hon.fail_eian_speech(p_subject text, p_clip uuid, p_outcome text, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); c hon.eian_speech_clips%ROWTYPE;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('PRE_SEND', 'FAILED', 'UNKNOWN')
     OR p_reason IS NULL OR p_reason NOT IN ('CONFIGURATION_REQUIRED', 'UNSUPPORTED_PROVIDER', 'INVALID_REQUEST', 'PROVIDER_REJECTED', 'PROVIDER_UNKNOWN', 'PROVIDER_UNAVAILABLE')
     OR (p_reason = 'PROVIDER_UNAVAILABLE' AND p_outcome <> 'FAILED') THEN
    RAISE EXCEPTION 'INVALID_EIAN_SPEECH_OUTCOME' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM hon.eian_speech_clips WHERE id = p_clip AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND OR c.status <> 'SENDING' THEN RAISE EXCEPTION 'EIAN_SPEECH_OUTCOME_REPLAY' USING ERRCODE = '40001'; END IF;
  UPDATE hon.eian_speech_clips SET status = CASE WHEN p_outcome = 'PRE_SEND' THEN 'CONFIGURATION_REQUIRED' ELSE p_outcome END,
    reason = p_reason, reserved_credits = CASE WHEN p_outcome = 'UNKNOWN' THEN reserved_credits ELSE 0 END, updated_at = clock_timestamp()
  WHERE id = c.id;
END $$;

-- S4-a for speech: evidence-only actor (succeeds after a lapse); exactly one ledger row per call; the hold is released.
-- Unlike a text answer, the sound has already been played when this runs: the provider publishes a clip's cost a few
-- seconds after the audio, so the API returns the audio while the clip is still SENDING (its hold still counts against
-- the budget) and records the provider-reported cost here afterwards. If that never happens the hold stays, goes stale
-- and reaches the HQ UNKNOWN queue like any other call. A cost above the per-clip maximum, or a different length than
-- the clip, is recorded (the provider charged it) and the clip is FAILED for the record.
CREATE FUNCTION hon.record_eian_speech_result(p_subject text, p_clip uuid, p_result jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); c hon.eian_speech_clips%ROWTYPE; lim jsonb := hon.eian_speech_limits();
  uid uuid; credits integer; over boolean; outcome text;
BEGIN
  SELECT * INTO c FROM hon.eian_speech_clips WHERE id = p_clip AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND OR c.status <> 'SENDING' OR c.usage_id IS NOT NULL THEN RAISE EXCEPTION 'EIAN_SPEECH_OUTCOME_REPLAY' USING ERRCODE = '40001'; END IF;
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_result) k), ARRAY[]::text[]) <> ARRAY['characters', 'providerCostMicrounits']
     OR jsonb_typeof(p_result->'characters') <> 'number' OR (p_result->>'characters') !~ '^[1-9][0-9]{0,5}$'
     OR jsonb_typeof(p_result->'providerCostMicrounits') <> 'number' OR (p_result->>'providerCostMicrounits') !~ '^(0|[1-9][0-9]{0,9})$' THEN
    RAISE EXCEPTION 'INVALID_EIAN_SPEECH_RESULT' USING ERRCODE = '22023';
  END IF;
  credits := ((p_result->>'characters')::integer + 999) / 1000;
  over := (p_result->>'characters')::integer <> c.characters OR credits > c.reserved_credits
    OR (p_result->>'providerCostMicrounits')::bigint > (lim->>'maxProviderCostMicrounits')::bigint;
  INSERT INTO hon.ai_usage_ledger(organization_id, school_id, initiator_principal_id, provider_code, model_code, modality,
      input_units, output_units, provider_cost_microunits, customer_credits, correlation_id, source_invocation_id, spend_class)
    VALUES (c.organization_id, c.school_id, actor, lim->>'providerId', lim->>'modelId', 'VOICE_OUTPUT',
      (p_result->>'characters')::bigint, 0, (p_result->>'providerCostMicrounits')::bigint, credits,
      coalesce(nullif(current_setting('app.hon_request_id', true), '')::uuid, gen_random_uuid()), c.id, 'AGENT_INFERENCE')
    RETURNING id INTO uid;
  outcome := CASE WHEN over THEN 'FAILED' ELSE 'COMPLETED' END;
  UPDATE hon.eian_speech_clips SET usage_id = uid, reserved_credits = 0, status = outcome,
    reason = CASE WHEN outcome = 'FAILED' THEN 'RESULT_BUDGET_EXCEEDED' END,
    updated_at = clock_timestamp()
  WHERE id = c.id;
  RETURN outcome;
END $$;

-- ---- S4 enumerations: the speech clip joins every shared spend function, as 0474 did for EIAN and 0550 for TEXT_PROPOSAL ----
-- 0550 body plus Eian speech clips.
CREATE OR REPLACE FUNCTION hon.ai_org_committed_credits(p_org uuid, p_at timestamptz) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  -- Agent-inference ledger credits in the window plus every agent hold that counts (hon.ai_hold_counts), across all
  -- seven agent callers (three specialists, the HON reply, parent Eian turns, the shared text proposals and Eian speech clips) and all schools of the organization. Callers hold ai.budget:<org> (hon.ai_budget_lock) and evaluate
  -- this in a statement that starts after the lock (READ COMMITTED), so every earlier committed hold is visible.
  -- A hold's time is its immutable held_at (stamped when the hold was taken), never the mutable updated_at.
  WITH w AS (SELECT hon.ai_spend_window(p_org, p_at) AS r)
  SELECT (SELECT coalesce(sum(u.customer_credits),0) FROM hon.ai_usage_ledger u, w
           WHERE u.organization_id=p_org AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=lower(w.r) AND u.occurred_at<upper(w.r))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.marketing_ai_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.teaching_ai_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.chad_follow_up_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.hon_reply_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.eian_turns i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.ai_text_proposals i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.eian_speech_clips i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at));
$$;

-- 0550 body plus Eian speech clips.
CREATE OR REPLACE FUNCTION hon.ai_school_committed_cost_micros(p_org uuid, p_school uuid, p_at timestamptz) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH w AS (SELECT hon.ai_spend_window(p_org, p_at) AS r)
  SELECT (SELECT coalesce(sum(u.provider_cost_microunits),0) FROM hon.ai_usage_ledger u, w
           WHERE u.organization_id=p_org AND u.school_id=p_school AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=lower(w.r) AND u.occurred_at<upper(w.r))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.marketing_ai_invocations i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.teaching_ai_invocations i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.chad_follow_up_invocations i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.hon_reply_invocations i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.eian_turns i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.ai_text_proposals i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       -- A speech clip has no plan: its hold counts at the fixed per-clip maximum.
       + (SELECT coalesce(sum((hon.eian_speech_limits()->>'maxProviderCostMicrounits')::bigint),0) FROM hon.eian_speech_clips i CROSS JOIN w
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at));
$$;

-- 0550 body plus Eian speech clips (no plan: the fixed per-clip maximum).
CREATE OR REPLACE FUNCTION hon.ai_org_open_agent_holds(p_org uuid)
RETURNS TABLE(held_at timestamptz, status text, reserved_credits bigint, max_provider_cost_microunits bigint)
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.marketing_ai_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.teaching_ai_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.chad_follow_up_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.hon_reply_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.eian_turns i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.ai_text_proposals i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, (hon.eian_speech_limits()->>'maxProviderCostMicrounits')::bigint FROM hon.eian_speech_clips i WHERE i.organization_id=p_org AND i.reserved_credits>0;
$$;

ALTER TABLE hon.ai_unknown_resolutions DROP CONSTRAINT ai_unknown_resolutions_agent_check;
ALTER TABLE hon.ai_unknown_resolutions ADD CONSTRAINT ai_unknown_resolutions_agent_check CHECK (agent IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY','EIAN','TEXT_PROPOSAL','EIAN_SPEECH'));
ALTER TABLE hon.ai_late_provider_expenses DROP CONSTRAINT ai_late_provider_expenses_agent_check;
ALTER TABLE hon.ai_late_provider_expenses ADD CONSTRAINT ai_late_provider_expenses_agent_check CHECK (agent IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY','EIAN','TEXT_PROPOSAL','EIAN_SPEECH'));

-- 0550 body plus EIAN_SPEECH.
CREATE OR REPLACE FUNCTION hon.read_ai_unknown_invocations_from_hq(p_subject text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_saas_hq_actor(p_subject, false); at timestamptz := clock_timestamp();
BEGIN
  RETURN jsonb_build_object(
    'open', coalesce((SELECT jsonb_agg(jsonb_build_object('agent',o.agent,'invocationId',o.id,'organizationId',o.organization_id,'schoolId',o.school_id,
        'status',o.status,'reservedCredits',o.reserved_credits,'heldAt',CASE WHEN o.held_at IS NULL THEN NULL ELSE hon.saas_ts(o.held_at) END,
        'countsAgainstCurrentWindow',coalesce(o.held_at <@ hon.ai_spend_window(o.organization_id, at), true)) ORDER BY o.held_at NULLS FIRST, o.id)
      FROM (SELECT * FROM (
          SELECT 'MARKETING' agent,id,organization_id,school_id,status,reserved_credits,held_at FROM hon.marketing_ai_invocations
          UNION ALL SELECT 'TEACHING',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.teaching_ai_invocations
          UNION ALL SELECT 'CHAD_FOLLOW_UP',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.chad_follow_up_invocations
          UNION ALL SELECT 'HON_REPLY',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.hon_reply_invocations
          UNION ALL SELECT 'EIAN',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.eian_turns
          UNION ALL SELECT 'TEXT_PROPOSAL',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.ai_text_proposals
          UNION ALL SELECT 'EIAN_SPEECH',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.eian_speech_clips) a
        WHERE a.reserved_credits > 0 AND (a.status = 'UNKNOWN' OR (a.status = 'SENDING' AND a.held_at <= at - hon.ai_sending_stale_after()))
        ORDER BY a.held_at NULLS FIRST, a.id LIMIT 200) o), '[]'::jsonb),
    'resolved', coalesce((SELECT jsonb_agg((hon.ai_unknown_receipt(s.x, false) - 'replayed') || jsonb_build_object('reason',(s.x).reason,'evidence',(s.x).evidence,
        'resolvedByPrincipalId',(s.x).resolved_by_principal_id,'priorStatus',(s.x).prior_status,'heldAt',CASE WHEN (s.x).held_at IS NULL THEN NULL ELSE hon.saas_ts((s.x).held_at) END,
        'lateProviderExpense',(SELECT jsonb_build_object('expenseId',l.id,'providerCostMicrounits',l.provider_cost_microunits,
          'occurredAt',hon.saas_ts(l.occurred_at),'recordedAt',hon.saas_ts(l.recorded_at)) FROM hon.ai_late_provider_expenses l WHERE l.resolution_id=(s.x).id)) ORDER BY (s.x).resolved_at DESC, (s.x).id)
      FROM (SELECT x FROM hon.ai_unknown_resolutions x ORDER BY x.resolved_at DESC, x.id LIMIT 100) s), '[]'::jsonb),
    'staleAfterSeconds', extract(epoch FROM hon.ai_sending_stale_after())::integer,
    'asOf', hon.saas_ts(at));
END $$;

-- 0550 body plus EIAN_SPEECH. For a speech clip, inputTokens carries the characters spoken and outputTokens is 0.
CREATE OR REPLACE FUNCTION hon.ai_unknown_validate(p_agent text, p_input jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE e jsonb := p_input->'evidence'; d text := p_input->>'decision';
  nonneg CONSTANT text := '^(0|[1-9][0-9]{0,11})$'; ref CONSTANT text := '^[A-Za-z0-9._:-]{1,200}$';
BEGIN
  IF p_agent IS NULL OR p_agent NOT IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY','EIAN','TEXT_PROPOSAL','EIAN_SPEECH') OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
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

-- 0550 body plus EIAN_SPEECH (hon.eian_speech_clips): the same locks, checks, ledger, audit and outbox writes. The only
-- difference is where the provider, model and modality come from, because a speech clip has no plan row.
CREATE OR REPLACE FUNCTION hon.resolve_ai_unknown_invocation(p_subject text, p_agent text, p_id uuid, p_input jsonb, p_key uuid, p_request_id uuid, p_correlation_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; tbl text; fp text; r hon.ai_unknown_resolutions%ROWTYPE; e jsonb; d text;
  v_org uuid; v_school uuid; v_requester uuid; v_work uuid; v_plan uuid; v_status text; v_reserved integer; v_usage uuid; v_held timestamptz;
  p hon.ai_invocation_plans%ROWTYPE; uid uuid; credits bigint; receipt jsonb;
  speech boolean := p_agent IS NOT DISTINCT FROM 'EIAN_SPEECH'; v_provider text; v_model text; v_modality hon.ai_modality;
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
  tbl := CASE p_agent WHEN 'MARKETING' THEN 'marketing_ai_invocations' WHEN 'TEACHING' THEN 'teaching_ai_invocations'
    WHEN 'CHAD_FOLLOW_UP' THEN 'chad_follow_up_invocations' WHEN 'HON_REPLY' THEN 'hon_reply_invocations' WHEN 'EIAN' THEN 'eian_turns'
    WHEN 'TEXT_PROPOSAL' THEN 'ai_text_proposals' WHEN 'EIAN_SPEECH' THEN 'eian_speech_clips' END;
  IF tbl IS NULL THEN RAISE EXCEPTION 'INVALID_AI_UNKNOWN_RESOLUTION' USING ERRCODE='22023'; END IF;
  -- The invocation row is the only row lock taken; no budget lock is needed because a resolution only releases holds.
  -- A speech clip has no work item and no plan; its provider, model and unit come from hon.eian_speech_limits().
  IF speech THEN
    SELECT organization_id,school_id,requested_by,status,reserved_credits,usage_id,held_at INTO v_org, v_school, v_requester, v_status, v_reserved, v_usage, v_held
      FROM hon.eian_speech_clips WHERE id=p_id FOR UPDATE;
  ELSE
    EXECUTE format('SELECT organization_id,school_id,requested_by,work_item_id,plan_id,status,reserved_credits,usage_id,held_at FROM hon.%I WHERE id=$1 FOR UPDATE', tbl)
      INTO v_org, v_school, v_requester, v_work, v_plan, v_status, v_reserved, v_usage, v_held USING p_id;
  END IF;
  -- The invocation row lock can wait behind a recording or another resolution: check authority again after it.
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'AI_UNKNOWN_INVOCATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_usage IS NOT NULL OR v_reserved IS NULL OR v_reserved <= 0 OR (v_plan IS NULL AND NOT speech) OR v_status IS NULL OR v_status NOT IN ('UNKNOWN','SENDING') THEN
    RAISE EXCEPTION 'AI_UNKNOWN_NOT_RESOLVABLE' USING ERRCODE='23514';
  END IF;
  -- (Manus delta review P2) No trustworthy original hold time: fail closed for every decision and status. A missing
  -- held_at can prove neither staleness (a SENDING call may still be in flight) nor the window, and the UNKNOWN status of
  -- such a row may itself have been inferred from the mutable updated_at. The hold keeps counting (ai_hold_counts) and
  -- is never released here; no ledger row, resolution, audit or outbox row is written.
  IF v_held IS NULL THEN RAISE EXCEPTION 'AI_UNKNOWN_ORIGIN_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  -- A SENDING hold is resolvable only once its immutable origin proves it stale (never from updated_at).
  IF v_status = 'SENDING' AND NOT (v_held <= clock_timestamp() - hon.ai_sending_stale_after()) THEN
    RAISE EXCEPTION 'AI_UNKNOWN_NOT_RESOLVABLE' USING ERRCODE='23514';
  END IF;
  IF speech THEN
    v_provider := hon.eian_speech_limits()->>'providerId'; v_model := hon.eian_speech_limits()->>'modelId'; v_modality := 'VOICE_OUTPUT';
  ELSE
    SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id = v_plan;
    v_provider := p.provider_id; v_model := p.model_id; v_modality := 'TEXT';
  END IF;
  IF d = 'RECORD_PROVIDER_COST' THEN
    credits := ((e->>'inputTokens')::bigint + (e->>'outputTokens')::bigint + 999) / 1000;
    INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,
        provider_cost_microunits,customer_credits,correlation_id,source_invocation_id,spend_class,occurred_at)
      VALUES (v_org,v_school,v_requester,v_work,v_provider,v_model,v_modality,(e->>'inputTokens')::bigint,(e->>'outputTokens')::bigint,
        (e->>'providerCostMicrounits')::bigint,credits,p_correlation_id,p_id,'AGENT_INFERENCE',v_held)
      RETURNING id INTO uid;
  ELSIF d = 'WRITE_OFF' THEN
    INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,
        provider_cost_microunits,customer_credits,correlation_id,source_invocation_id,spend_class,occurred_at)
      VALUES (v_org,v_school,v_requester,v_work,v_provider,v_model,v_modality,0,0,(e->>'estimatedProviderCostMicrounits')::bigint,0,p_correlation_id,p_id,'AGENT_INFERENCE',v_held)
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

-- 0550 body plus EIAN_SPEECH.
CREATE OR REPLACE FUNCTION hon.record_ai_late_provider_expense(p_subject text, p_agent text, p_id uuid, p_input jsonb, p_key uuid, p_request_id uuid, p_correlation_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; e jsonb := p_input->'evidence'; r hon.ai_unknown_resolutions%ROWTYPE; x hon.ai_late_provider_expenses%ROWTYPE;
  wl hon.ai_usage_ledger%ROWTYPE; receipt jsonb;
  nonneg CONSTANT text := '^(0|[1-9][0-9]{0,11})$'; ref CONSTANT text := '^[A-Za-z0-9._:-]{1,200}$';
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_id IS NULL OR p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL OR p_agent IS NULL OR p_agent NOT IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY','EIAN','TEXT_PROPOSAL','EIAN_SPEECH')
     OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k), ARRAY[]::text[]) <> ARRAY['evidence','reason']
     OR jsonb_typeof(p_input->'reason') <> 'string' OR (p_input->>'reason') <> btrim(p_input->>'reason') OR length(p_input->>'reason') NOT BETWEEN 10 AND 500
     OR jsonb_typeof(e) <> 'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k), ARRAY[]::text[]) <> ARRAY['inputTokens','outputTokens','providerCostMicrounits','providerGenerationId']
     OR jsonb_typeof(e->'providerGenerationId') <> 'string' OR (e->>'providerGenerationId') !~ ref
     OR jsonb_typeof(e->'inputTokens') <> 'number' OR (e->>'inputTokens') !~ nonneg OR (e->>'inputTokens')::bigint > 100000000
     OR jsonb_typeof(e->'outputTokens') <> 'number' OR (e->>'outputTokens') !~ nonneg OR (e->>'outputTokens')::bigint > 100000000
     OR jsonb_typeof(e->'providerCostMicrounits') <> 'number' OR (e->>'providerCostMicrounits') !~ nonneg THEN
    RAISE EXCEPTION 'INVALID_AI_LATE_PROVIDER_EXPENSE' USING ERRCODE='22023';
  END IF;
  fp := encode(sha256(convert_to(jsonb_build_object('agent',p_agent,'id',p_id,'input',p_input,'by',actor)::text,'UTF8')),'hex');
  -- Same authority pattern as the resolution: shared lock on the authority tables, then rechecks after every wait.
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- Lock order: key, then the call (one late expense per written-off call; replays and races resolve to one row).
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.late.key:' || p_key::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.late:' || p_agent || ':' || p_id::text, 0));
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO x FROM hon.ai_late_provider_expenses WHERE expense_key = p_key;
  IF FOUND THEN
    IF x.expense_fingerprint <> fp THEN RAISE EXCEPTION 'AI_LATE_EXPENSE_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN hon.ai_late_expense_receipt(x, true);
  END IF;
  SELECT * INTO r FROM hon.ai_unknown_resolutions WHERE agent = p_agent AND invocation_id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_UNKNOWN_INVOCATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF r.decision <> 'WRITE_OFF' THEN RAISE EXCEPTION 'AI_LATE_EXPENSE_NOT_WRITTEN_OFF' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM hon.ai_late_provider_expenses WHERE resolution_id = r.id) THEN RAISE EXCEPTION 'AI_LATE_EXPENSE_ALREADY_RECORDED' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM hon.ai_late_provider_expenses WHERE provider_generation_id = e->>'providerGenerationId') THEN
    RAISE EXCEPTION 'AI_LATE_EXPENSE_DUPLICATE_GENERATION' USING ERRCODE='23514';
  END IF;
  -- The WRITE_OFF ledger row (zero customer credits, estimated cost) is read, never changed, and no second row is written.
  SELECT * INTO STRICT wl FROM hon.ai_usage_ledger WHERE id = r.ledger_entry_id;
  INSERT INTO hon.ai_late_provider_expenses(resolution_id,agent,invocation_id,organization_id,school_id,provider_generation_id,input_units,output_units,
      provider_cost_microunits,estimated_provider_cost_microunits,provider_code,model_code,occurred_at,reason,expense_key,expense_fingerprint,recorded_by_principal_id)
    VALUES (r.id,p_agent,p_id,r.organization_id,r.school_id,e->>'providerGenerationId',(e->>'inputTokens')::bigint,(e->>'outputTokens')::bigint,
      (e->>'providerCostMicrounits')::bigint,wl.provider_cost_microunits,wl.provider_code,wl.model_code,r.held_at,p_input->>'reason',p_key,fp,actor) RETURNING * INTO x;
  receipt := hon.ai_late_expense_receipt(x, false);
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
    VALUES (r.organization_id, r.school_id, actor, 'HON_HQ', 'hq.ai.late_provider_expense.record', 'AI_INVOCATION', p_id,
      jsonb_build_object('resolutionId',r.id,'decision',r.decision,'estimatedProviderCostMicrounits',wl.provider_cost_microunits), receipt - 'replayed', 'SUCCEEDED', p_request_id, p_correlation_id, now());
  INSERT INTO hon.outbox_events (organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
    VALUES (r.organization_id, r.school_id, 'ai.late_provider_expense.recorded', 1, 'AI_INVOCATION', p_id, 2, p_correlation_id, p_request_id, receipt - 'replayed');
  RETURN receipt;
END $$;

-- 0550 body plus Eian speech clips: ledger rows and late expenses count under EIAN_SPEECH; open holds count.
CREATE OR REPLACE FUNCTION hon.read_ai_school_usage_from_hq(p_subject text, p_from timestamptz, p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_saas_hq_actor(p_subject, false); at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '92 days' OR p_to > at + interval '1 day' THEN
    RAISE EXCEPTION 'INVALID_AI_USAGE_RANGE' USING ERRCODE='22023';
  END IF;
  WITH rows AS (
    SELECT u.organization_id, u.school_id, u.spend_class, u.customer_credits, u.provider_cost_microunits,
      CASE WHEN u.spend_class <> 'AGENT_INFERENCE' THEN NULL
           WHEN u.source_invocation_id IS NULL THEN 'UNATTRIBUTED'
           WHEN EXISTS (SELECT 1 FROM hon.marketing_ai_invocations i WHERE i.id = u.source_invocation_id) THEN 'MARKETING'
           WHEN EXISTS (SELECT 1 FROM hon.teaching_ai_invocations i WHERE i.id = u.source_invocation_id) THEN 'TEACHING'
           WHEN EXISTS (SELECT 1 FROM hon.chad_follow_up_invocations i WHERE i.id = u.source_invocation_id) THEN 'CHAD_FOLLOW_UP'
           -- 0267 and this migration: every analysis specialist shares HON's reply table; each counts under its own agent.
           WHEN EXISTS (SELECT 1 FROM hon.hon_reply_invocations i WHERE i.id = u.source_invocation_id)
             THEN (SELECT hon.ai_usage_reply_agent(i.specialist) FROM hon.hon_reply_invocations i WHERE i.id = u.source_invocation_id)
           -- 0474: parent Eian turns count under their own agent.
           WHEN EXISTS (SELECT 1 FROM hon.eian_turns i WHERE i.id = u.source_invocation_id) THEN 'EIAN'
           -- 0550: each shared text proposal counts under its kind's own usage label.
           WHEN EXISTS (SELECT 1 FROM hon.ai_text_proposals i WHERE i.id = u.source_invocation_id)
             THEN (SELECT k.usage_agent FROM hon.ai_text_proposals i JOIN hon.ai_text_kinds k ON k.kind = i.kind WHERE i.id = u.source_invocation_id)
           -- 0638: Eian speech clips count under their own agent.
           WHEN EXISTS (SELECT 1 FROM hon.eian_speech_clips i WHERE i.id = u.source_invocation_id) THEN 'EIAN_SPEECH'
           ELSE 'UNATTRIBUTED' END AS agent,
      EXISTS (SELECT 1 FROM hon.ai_unknown_resolutions r WHERE r.ledger_entry_id = u.id AND r.decision = 'WRITE_OFF') AS write_off,
      EXISTS (SELECT 1 FROM hon.ai_unknown_resolutions r JOIN hon.ai_late_provider_expenses l ON l.resolution_id = r.id
              WHERE r.ledger_entry_id = u.id AND r.decision = 'WRITE_OFF') AS superseded,
      false AS late
    FROM hon.ai_usage_ledger u
    WHERE u.occurred_at >= p_from AND u.occurred_at < p_to
    UNION ALL
    -- Late actuals: provider expense evidence only (no ledger row, no customer credits), in their original window.
    SELECT l.organization_id, l.school_id, 'AGENT_INFERENCE', 0, l.provider_cost_microunits,
      CASE WHEN l.agent = 'HON_REPLY'
           THEN coalesce((SELECT hon.ai_usage_reply_agent(i.specialist) FROM hon.hon_reply_invocations i WHERE i.id = l.invocation_id), 'HON_REPLY')
           WHEN l.agent = 'TEXT_PROPOSAL'
           THEN coalesce((SELECT k.usage_agent FROM hon.ai_text_proposals i JOIN hon.ai_text_kinds k ON k.kind = i.kind WHERE i.id = l.invocation_id), 'TEXT_PROPOSAL')
           ELSE l.agent END, false, false, true
    FROM hon.ai_late_provider_expenses l
    WHERE l.occurred_at >= p_from AND l.occurred_at < p_to
  ), totals AS (
    SELECT organization_id, school_id, spend_class, agent, sum(customer_credits)::bigint credits,
      coalesce(sum(provider_cost_microunits) FILTER (WHERE NOT write_off AND NOT late), 0)::bigint cost,
      coalesce(sum(provider_cost_microunits) FILTER (WHERE write_off), 0)::bigint estimate,
      count(*) FILTER (WHERE NOT late)::bigint entries, count(*) FILTER (WHERE write_off)::bigint write_offs,
      coalesce(sum(provider_cost_microunits) FILTER (WHERE late), 0)::bigint late_cost, count(*) FILTER (WHERE late)::bigint late_entries,
      coalesce(sum(provider_cost_microunits) FILTER (WHERE superseded), 0)::bigint superseded
    FROM rows GROUP BY organization_id, school_id, spend_class, agent
  ), classes AS (
    SELECT organization_id, school_id, spend_class AS k, sum(credits) credits, sum(cost) cost, sum(estimate) estimate,
      sum(entries) entries, sum(write_offs) write_offs, sum(late_cost) late_cost, sum(late_entries) late_entries, sum(superseded) superseded,
      jsonb_build_object('credits', sum(credits), 'providerReportedCostMicrounits', sum(cost), 'estimatedWriteOffCostMicrounits', sum(estimate),
        'entries', sum(entries), 'writeOffEntries', sum(write_offs),
        'lateProviderCostMicrounits', sum(late_cost), 'lateProviderExpenseEntries', sum(late_entries), 'supersededWriteOffEstimateMicrounits', sum(superseded),
        -- Aggregates are computed for every class group regardless of the CASE, so the per-agent aggregate skips rows
        -- without an agent (CREATIVE_MEDIA, HQ_INTERNAL); otherwise a NULL key fails the whole read.
        'byAgent', CASE WHEN spend_class = 'AGENT_INFERENCE'
          THEN jsonb_object_agg(agent, jsonb_build_object('credits', credits, 'providerReportedCostMicrounits', cost,
              'estimatedWriteOffCostMicrounits', estimate, 'entries', entries, 'writeOffEntries', write_offs,
              'lateProviderCostMicrounits', late_cost, 'lateProviderExpenseEntries', late_entries, 'supersededWriteOffEstimateMicrounits', superseded))
            FILTER (WHERE agent IS NOT NULL)
          ELSE NULL END) AS v
    FROM totals GROUP BY organization_id, school_id, spend_class
  ), unresolved AS (
    -- (Manus delta review P2) Calls whose outcome is still unknown, per school: UNKNOWN, or SENDING past the stale limit
    -- by the immutable held_at, with a hold (the HQ UNKNOWN queue predicate). Current state, not range-scoped, like the
    -- per-school count it feeds. They have no ledger row and no known cost, so they add no amount anywhere.
    SELECT h.organization_id, h.school_id, count(*)::bigint n FROM (
        SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.marketing_ai_invocations
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.teaching_ai_invocations
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.chad_follow_up_invocations
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.hon_reply_invocations
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.eian_turns
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.ai_text_proposals
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.eian_speech_clips) h
      WHERE h.reserved_credits > 0 AND (h.status = 'UNKNOWN' OR (h.status = 'SENDING' AND h.held_at <= at - hon.ai_sending_stale_after()))
      GROUP BY h.organization_id, h.school_id
  ), school_keys AS (
    -- A school is listed when it has ledger or late-expense rows in the range, or unresolved calls now. A school with
    -- neither is not listed (zero activity). Each school appears once.
    SELECT organization_id, school_id FROM classes UNION SELECT organization_id, school_id FROM unresolved
  ), schools AS (
    SELECT s.organization_id, s.school_id,
      jsonb_build_object('organizationId', s.organization_id, 'schoolId', s.school_id,
        'providerReportedCostMicrounits', coalesce(sum(c.cost), 0), 'estimatedWriteOffCostMicrounits', coalesce(sum(c.estimate), 0),
        'entries', coalesce(sum(c.entries), 0), 'writeOffEntries', coalesce(sum(c.write_offs), 0),
        'lateProviderCostMicrounits', coalesce(sum(c.late_cost), 0), 'lateProviderExpenseEntries', coalesce(sum(c.late_entries), 0),
        'supersededWriteOffEstimateMicrounits', coalesce(sum(c.superseded), 0),
        'unreconciledInvocations', coalesce(max(u.n), 0),
        'byClass', coalesce(jsonb_object_agg(c.k, c.v) FILTER (WHERE c.k IS NOT NULL), '{}'::jsonb)) AS j,
      coalesce(sum(c.cost), 0) AS cost, coalesce(sum(c.estimate), 0) AS estimate, coalesce(max(u.n), 0) AS unresolved
    FROM school_keys s
    LEFT JOIN classes c ON c.organization_id = s.organization_id AND c.school_id = s.school_id
    LEFT JOIN unresolved u ON u.organization_id = s.organization_id AND u.school_id = s.school_id
    GROUP BY s.organization_id, s.school_id
  ), limited AS (
    SELECT * FROM schools ORDER BY cost DESC, estimate DESC, unresolved DESC, organization_id, school_id LIMIT 500
  ), orgs AS (
    SELECT DISTINCT organization_id FROM limited
  )
  SELECT jsonb_build_object(
    'from', hon.saas_ts(p_from), 'to', hon.saas_ts(p_to), 'asOf', hon.saas_ts(at),
    'truncated', (SELECT count(*) FROM schools) > 500,
    'schools', coalesce((SELECT jsonb_agg(l.j ORDER BY l.cost DESC, l.estimate DESC, l.unresolved DESC, l.organization_id, l.school_id) FROM limited l), '[]'::jsonb),
    'organizations', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'organizationId', o.organization_id,
        'agentWindowStart', hon.saas_ts(lower(w.r)), 'agentWindowEnd', hon.saas_ts(upper(w.r)),
        'agentCommittedCredits', hon.ai_org_committed_credits(o.organization_id, at),
        'agentCeilingCredits', hon.ai_org_display_ceiling(o.organization_id, at),
        'openUnknownHolds', (SELECT count(*) FROM (
            SELECT status, held_at, reserved_credits FROM hon.marketing_ai_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.teaching_ai_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.chad_follow_up_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.hon_reply_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.eian_turns WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.ai_text_proposals WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.eian_speech_clips WHERE organization_id = o.organization_id) h
          WHERE h.reserved_credits > 0 AND (h.status = 'UNKNOWN' OR (h.status = 'SENDING' AND h.held_at <= at - hon.ai_sending_stale_after()))),
        'aiPaused', EXISTS (SELECT 1 FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND (p.organization_id = o.organization_id OR p.organization_id IS NULL)))
        ORDER BY o.organization_id)
      FROM orgs o CROSS JOIN LATERAL (SELECT hon.ai_spend_window(o.organization_id, at) AS r) w), '[]'::jsonb),
    'providerCostUnit', 'MICROUNITS_USD')
  INTO result;
  RETURN result;
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.eian_speech_limits()','hon.eian_speech_unavailable_reason(uuid,uuid,boolean)',
      'hon.read_eian_speech_status(text,boolean)','hon.begin_eian_speech(text,text,text,integer)','hon.prepare_eian_speech(text,uuid,boolean)',
      'hon.fail_eian_speech(text,uuid,text,text)','hon.record_eian_speech_result(text,uuid,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.eian_speech_clips FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.eian_speech_clips FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_eian_speech_status(text,boolean), hon.begin_eian_speech(text,text,text,integer),
      hon.prepare_eian_speech(text,uuid,boolean), hon.fail_eian_speech(text,uuid,text,text), hon.record_eian_speech_result(text,uuid,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
