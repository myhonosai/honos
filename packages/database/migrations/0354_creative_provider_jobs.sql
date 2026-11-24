BEGIN;

-- C1 (0354): asynchronous creative provider jobs, per-school daily caps and the HQ per-provider daily spend guard.
-- docs/architecture/CREATIVE_PROVIDER_JOBS.md (piece C1 of CREATIVE_AI_IMAGE_VIDEO_PROVIDERS.md). Provider-free: nothing
-- here calls a provider, holds a key, charges a card or activates a program.
--
-- Real image and video providers answer with a job id and finish minutes later. A provider job ties one CS1 generation
-- (0216) to one provider job id. The API asks for a submission PERMIT first: the per-provider daily limit the human HQ
-- owner set must have room for the job's worst case (its reserved credits x 10,000 micro-USD, 1 credit = $0.01, an
-- upper bound because published rates are above provider cost). No limit row = no real submission. The worker
-- (hon_communication_worker, no table access) polls submitted jobs under a lease and records the result for the
-- generation's own requester through the unchanged 0216 rules (validation, CW1 settle, evidence actor, assets). A job
-- with no answer by its 30-minute deadline is recorded UNKNOWN for the HQ owner and is never resent. A requester who
-- is no longer a usable single-principal human leaves the reservation RESERVED for the existing CW1 HQ resolution.
--
-- Daily caps (proposal, HQ editable per school): 50 images, 12 videos, 10 avatar videos per UTC day, counted on
-- generations that were not refunded (NOT_SENT / PROVIDER_FAILED), checked on insert under the school's wallet lock.
-- avatar.create keeps only its own 12-avatar limit (0276).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON creative provider jobs require a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.record_creative_generation_result(text,uuid,jsonb)') IS NULL
    OR to_regprocedure('hon.create_creative_generation(text,uuid,jsonb,jsonb,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.saas_creative_evidence_actor(text,uuid)') IS NULL
    OR to_regprocedure('hon.require_saas_hq_actor(text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'HON creative provider jobs require Creative Studio generations (0216) and the CW1 wallet (0202)';
  END IF;
END $$;

-- ---------- HQ limits ----------
CREATE TABLE hon.creative_provider_daily_limits (
  provider_id text PRIMARY KEY REFERENCES hon.hq_ai_provider_connections(provider_id) ON DELETE RESTRICT,
  daily_limit_micros bigint NOT NULL CHECK (daily_limit_micros BETWEEN 0 AND 10000000000),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 10 AND 500),
  version integer NOT NULL CHECK (version >= 1),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE hon.creative_school_daily_caps (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  images integer NOT NULL CHECK (images BETWEEN 0 AND 1000),
  videos integer NOT NULL CHECK (videos BETWEEN 0 AND 1000),
  avatar_videos integer NOT NULL CHECK (avatar_videos BETWEEN 0 AND 1000),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 10 AND 500),
  version integer NOT NULL CHECK (version >= 1),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);
-- Append-only HQ command log: audit and idempotency for both commands.
CREATE TABLE hon.creative_limit_commands (
  command_key uuid PRIMARY KEY,
  command_kind text NOT NULL CHECK (command_kind IN ('PROVIDER_DAILY_LIMIT','SCHOOL_DAILY_CAPS')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 64),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  reason text NOT NULL,
  prior_version integer NOT NULL CHECK (prior_version >= 0),
  resulting_version integer NOT NULL CHECK (resulting_version = prior_version + 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION hon.guard_creative_limit_commands() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'CREATIVE_LIMIT_COMMAND_IMMUTABLE' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER creative_limit_commands_immutable BEFORE UPDATE OR DELETE ON hon.creative_limit_commands
  FOR EACH ROW EXECUTE FUNCTION hon.guard_creative_limit_commands();
CREATE TRIGGER creative_limit_commands_no_truncate BEFORE TRUNCATE ON hon.creative_limit_commands
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_creative_limit_commands();
-- Limit rows change only by a version step and are never deleted.
CREATE FUNCTION hon.guard_creative_limit_rows() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND
     (to_jsonb(NEW)->>'provider_id') IS NOT DISTINCT FROM (to_jsonb(OLD)->>'provider_id')
     AND (to_jsonb(NEW)->>'school_id') IS NOT DISTINCT FROM (to_jsonb(OLD)->>'school_id')
     AND (to_jsonb(NEW)->>'organization_id') IS NOT DISTINCT FROM (to_jsonb(OLD)->>'organization_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CREATIVE_LIMIT_ROW_GUARDED' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER creative_provider_daily_limits_guarded BEFORE UPDATE OR DELETE ON hon.creative_provider_daily_limits
  FOR EACH ROW EXECUTE FUNCTION hon.guard_creative_limit_rows();
CREATE TRIGGER creative_school_daily_caps_guarded BEFORE UPDATE OR DELETE ON hon.creative_school_daily_caps
  FOR EACH ROW EXECUTE FUNCTION hon.guard_creative_limit_rows();
CREATE TRIGGER creative_provider_daily_limits_no_truncate BEFORE TRUNCATE ON hon.creative_provider_daily_limits
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_creative_limit_commands();
CREATE TRIGGER creative_school_daily_caps_no_truncate BEFORE TRUNCATE ON hon.creative_school_daily_caps
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_creative_limit_commands();

-- ---------- provider jobs ----------
CREATE TABLE hon.creative_provider_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL UNIQUE,
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  provider_id text NOT NULL REFERENCES hon.hq_ai_provider_connections(provider_id) ON DELETE RESTRICT,
  provider_job_id text CHECK (provider_job_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'),
  status text NOT NULL CHECK (status IN ('PERMITTED','SUBMITTED','RECORDED','TIMED_OUT','REQUESTER_UNAVAILABLE','RESOLVED_ELSEWHERE')),
  worst_case_micros bigint NOT NULL CHECK (worst_case_micros > 0),
  permitted_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  submitted_at timestamptz,
  next_poll_at timestamptz,
  poll_count integer NOT NULL DEFAULT 0 CHECK (poll_count BETWEEN 0 AND 100000),
  lease_token uuid,
  lease_expires_at timestamptz,
  closed_at timestamptz,
  -- Integration source of the close: the requester's own API request, the worker's leased poll, or the deadline sweep.
  closed_by text CHECK (closed_by IN ('REQUESTER','WORKER','DEADLINE')),
  -- The provider's final answer when it could not be recorded (requester gone, or the reservation finished elsewhere):
  -- kept as evidence for the HQ resolution so paid output is never lost. Same closed shape as a 0216 outcome.
  provider_result jsonb CHECK (provider_result IS NULL OR jsonb_typeof(provider_result) = 'object'),
  version integer NOT NULL CHECK (version >= 1),
  UNIQUE (provider_id, provider_job_id),
  FOREIGN KEY (generation_id, school_id) REFERENCES hon.creative_generations(id, school_id) ON DELETE RESTRICT,
  CHECK (deadline_at = permitted_at + interval '30 minutes'),
  CHECK (status <> 'PERMITTED' OR (provider_job_id IS NULL AND submitted_at IS NULL AND next_poll_at IS NULL)),
  CHECK (status <> 'SUBMITTED' OR (provider_job_id IS NOT NULL AND submitted_at IS NOT NULL AND next_poll_at IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (lease_token IS NULL OR status = 'SUBMITTED'),
  CHECK ((closed_at IS NULL) = (status IN ('PERMITTED','SUBMITTED'))),
  CHECK ((closed_by IS NULL) = (closed_at IS NULL)),
  CHECK (provider_result IS NULL OR status IN ('REQUESTER_UNAVAILABLE','RESOLVED_ELSEWHERE'))
);
CREATE INDEX creative_provider_jobs_open ON hon.creative_provider_jobs (deadline_at) WHERE status IN ('PERMITTED','SUBMITTED');
CREATE INDEX creative_provider_jobs_due ON hon.creative_provider_jobs (next_poll_at) WHERE status = 'SUBMITTED';
CREATE INDEX creative_provider_jobs_day ON hon.creative_provider_jobs (provider_id, permitted_at);

-- Forward-only moves; identity, provider, cost bound and timing never change; a provider job id is set once.
CREATE FUNCTION hon.guard_creative_provider_job() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE fixed text[] := ARRAY['id','generation_id','school_id','organization_id','provider_id','worst_case_micros','permitted_at','deadline_at'];
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1
    AND (to_jsonb(NEW) - ARRAY['provider_job_id','status','submitted_at','next_poll_at','poll_count','lease_token','lease_expires_at','closed_at','closed_by','provider_result','version'])
      = (to_jsonb(OLD) - ARRAY['provider_job_id','status','submitted_at','next_poll_at','poll_count','lease_token','lease_expires_at','closed_at','closed_by','provider_result','version'])
    AND (OLD.provider_job_id IS NULL OR NEW.provider_job_id = OLD.provider_job_id)
    AND (OLD.submitted_at IS NULL OR NEW.submitted_at = OLD.submitted_at)
    AND NEW.poll_count >= OLD.poll_count
    AND (  (OLD.status = 'PERMITTED' AND NEW.status IN ('SUBMITTED','RECORDED','TIMED_OUT','REQUESTER_UNAVAILABLE','RESOLVED_ELSEWHERE'))
        OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('SUBMITTED','RECORDED','TIMED_OUT','REQUESTER_UNAVAILABLE','RESOLVED_ELSEWHERE'))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER creative_provider_job_guarded BEFORE UPDATE OR DELETE ON hon.creative_provider_jobs FOR EACH ROW EXECUTE FUNCTION hon.guard_creative_provider_job();
CREATE TRIGGER creative_provider_job_no_truncate BEFORE TRUNCATE ON hon.creative_provider_jobs FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_creative_limit_commands();

-- ---------- real provider results ----------
-- Assets recorded through a provider job are PROVIDER results; the synchronous synthetic path stays SYNTHETIC.
DO $$ DECLARE c text; BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'hon.creative_generation_assets'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%origin%SYNTHETIC%';
  IF c IS NULL THEN RAISE EXCEPTION 'creative_generation_assets origin check not found'; END IF;
  EXECUTE format('ALTER TABLE hon.creative_generation_assets DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE hon.creative_generation_assets ADD CONSTRAINT creative_generation_assets_origin CHECK (origin IN ('SYNTHETIC','PROVIDER'));

-- ---------- daily caps on generations ----------
CREATE FUNCTION hon.creative_cap_class(p_operation text, p_media text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  -- avatar.create has its own 12-avatar limit (0276) and is not counted here (NULL = no daily class).
  SELECT CASE WHEN p_operation = 'avatar.create' THEN NULL WHEN p_media = 'VIDEO' AND p_operation LIKE 'avatar.%' THEN 'AVATAR_VIDEO'
    WHEN p_media = 'VIDEO' THEN 'VIDEO' ELSE 'IMAGE' END
$$;
CREATE FUNCTION hon.creative_utc_day(p_at timestamptz) RETURNS tstzrange LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT tstzrange(date_trunc('day', p_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', (date_trunc('day', p_at AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC', '[)')
$$;
CREATE FUNCTION hon.creative_school_daily_cap(p_school uuid, p_class text) RETURNS integer LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce((SELECT CASE p_class WHEN 'IMAGE' THEN c.images WHEN 'VIDEO' THEN c.videos ELSE c.avatar_videos END
    FROM hon.creative_school_daily_caps c WHERE c.school_id = p_school), CASE p_class WHEN 'IMAGE' THEN 50 WHEN 'VIDEO' THEN 12 ELSE 10 END)
$$;
-- Every generation path (generic, avatar, avatar video, later ones) inserts through create_creative_generation after the
-- CW1 reserve took the school's wallet lock, so this count and the insert are serialized per school.
CREATE FUNCTION hon.guard_creative_generation_daily_cap() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE cls text := hon.creative_cap_class(NEW.operation_code, NEW.media_kind); used integer; day tstzrange := hon.creative_utc_day(NEW.created_at);
BEGIN
  IF cls IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) INTO used FROM hon.creative_generations g
   WHERE g.school_id = NEW.school_id AND g.created_at >= lower(day) AND g.created_at < upper(day)
     AND g.phase NOT IN ('NOT_SENT','PROVIDER_FAILED') AND hon.creative_cap_class(g.operation_code, g.media_kind) = cls;
  IF used >= hon.creative_school_daily_cap(NEW.school_id, cls) THEN
    RAISE EXCEPTION 'CREATIVE_DAILY_LIMIT_REACHED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER creative_generation_daily_cap BEFORE INSERT ON hon.creative_generations FOR EACH ROW EXECUTE FUNCTION hon.guard_creative_generation_daily_cap();

-- ---------- the provider spend guard ----------
-- Today's (UTC) committed cost for one provider: recorded cost where the reservation has one, otherwise the job's
-- worst case (open jobs, unknown and unrecorded costs all count at their worst case).
CREATE FUNCTION hon.creative_provider_committed_micros(p_provider text, p_at timestamptz) RETURNS bigint LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce(sum(CASE WHEN r.cost_status = 'RECORDED' THEN coalesce(r.provider_cost_microunits, j.worst_case_micros) ELSE j.worst_case_micros END), 0)::bigint
    FROM hon.creative_provider_jobs j
    JOIN hon.creative_generations g ON g.id = j.generation_id AND g.school_id = j.school_id
    JOIN hon.saas_creative_reservations r ON r.id = g.reservation_id AND r.school_id = g.school_id
   WHERE j.provider_id = p_provider AND j.permitted_at >= lower(hon.creative_utc_day(p_at)) AND j.permitted_at < upper(hon.creative_utc_day(p_at))
$$;

CREATE FUNCTION hon.creative_provider_job_json(j hon.creative_provider_jobs) RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('jobId', j.id, 'generationId', j.generation_id, 'status', j.status, 'submitted', j.provider_job_id IS NOT NULL,
    'deadlineAt', hon.saas_ts(j.deadline_at))
$$;

-- PERMIT (runtime, the generation's own requester): before anything is sent. The provider limit row lock serializes
-- permits per provider, so concurrent schools can never pass the limit together.
CREATE FUNCTION hon.begin_creative_provider_submission(p_subject text, p_generation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE g hon.creative_generations%ROWTYPE; r hon.saas_creative_reservations%ROWTYPE; j hon.creative_provider_jobs%ROWTYPE;
  lim hon.creative_provider_daily_limits%ROWTYPE; at timestamptz; worst bigint; again record; why text; e jsonb;
BEGIN
  IF p_generation IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO g FROM hon.creative_generations WHERE id = p_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.saas_creative_evidence_actor(p_subject, g.requested_by_principal_id);
  -- A permit is the last decision before money leaves HON, so everything the create decided is decided again at the
  -- live clock, under the creative pause gate (shared; an HQ pause waits for it): the requester's exact-school
  -- authority, the S4 / per-school CREATIVE_MEDIA spend decision and creative eligibility. Only a fresh generation
  -- (created within 120 seconds, the 0216 INTERRUPTED window) can be permitted, so an abandoned one never reaches a
  -- provider later; it is recorded INTERRUPTED instead.
  PERFORM hon.saas_creative_pause_gate(g.organization_id);
  SELECT * INTO again FROM hon.require_saas_school_actor(p_subject, g.school_id) LIMIT 1;
  IF again.principal_id IS DISTINCT FROM g.requested_by_principal_id THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  at := clock_timestamp();
  IF at > g.created_at + interval '120 seconds' THEN RAISE EXCEPTION 'CREATIVE_GENERATION_STALE' USING ERRCODE = '40001'; END IF;
  why := hon.ai_spend_allowed(g.organization_id, g.school_id, at, 'CREATIVE_MEDIA');
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || why USING ERRCODE = '23514'; END IF;
  e := hon.saas_creative_eligibility(g.school_id, at);
  IF NOT (e->>'eligible')::boolean THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || (e->>'reason') USING ERRCODE = '23514'; END IF;
  SELECT * INTO r FROM hon.saas_creative_reservations WHERE id = g.reservation_id AND school_id = g.school_id;
  SELECT * INTO lim FROM hon.creative_provider_daily_limits WHERE provider_id = r.provider_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREATIVE_PROVIDER_LIMIT_NOT_SET' USING ERRCODE = '23514'; END IF;
  SELECT * INTO j FROM hon.creative_provider_jobs WHERE generation_id = g.id;
  IF FOUND THEN
    IF j.status IN ('PERMITTED','SUBMITTED') THEN RETURN hon.creative_provider_job_json(j) || jsonb_build_object('replayed', true); END IF;
    RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001';
  END IF;
  IF g.phase <> 'SUBMITTING' OR r.status <> 'RESERVED' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp(); worst := r.reserved_credits::bigint * 10000;
  IF hon.creative_provider_committed_micros(r.provider_id, at) + worst > lim.daily_limit_micros THEN
    RAISE EXCEPTION 'CREATIVE_PROVIDER_DAILY_LIMIT' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.creative_provider_jobs(generation_id, school_id, organization_id, provider_id, status, worst_case_micros, permitted_at, deadline_at, version)
    VALUES (g.id, g.school_id, g.organization_id, r.provider_id, 'PERMITTED', worst, at, at + interval '30 minutes', 1) RETURNING * INTO j;
  RETURN hon.creative_provider_job_json(j) || jsonb_build_object('replayed', false);
END $$;

-- SUBMITTED (runtime, requester): the provider answered with its job id. The same id again is a replay.
CREATE FUNCTION hon.record_creative_provider_submission(p_subject text, p_generation uuid, p_provider_job_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE g hon.creative_generations%ROWTYPE; j hon.creative_provider_jobs%ROWTYPE; at timestamptz := clock_timestamp();
BEGIN
  IF p_generation IS NULL OR p_provider_job_id IS NULL OR p_provider_job_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO g FROM hon.creative_generations WHERE id = p_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.saas_creative_evidence_actor(p_subject, g.requested_by_principal_id);
  SELECT * INTO j FROM hon.creative_provider_jobs WHERE generation_id = g.id AND school_id = g.school_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF j.provider_job_id IS NOT NULL THEN
    IF j.provider_job_id = p_provider_job_id THEN RETURN hon.creative_provider_job_json(j) || jsonb_build_object('replayed', true); END IF;
    RAISE EXCEPTION 'CREATIVE_PROVIDER_JOB_MISMATCH' USING ERRCODE = '40001';
  END IF;
  IF j.status <> 'PERMITTED' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  IF EXISTS (SELECT 1 FROM hon.creative_provider_jobs x WHERE x.provider_id = j.provider_id AND x.provider_job_id = p_provider_job_id) THEN
    RAISE EXCEPTION 'CREATIVE_PROVIDER_JOB_MISMATCH' USING ERRCODE = '40001';
  END IF;
  UPDATE hon.creative_provider_jobs SET status = 'SUBMITTED', provider_job_id = p_provider_job_id, submitted_at = at,
      next_poll_at = at + interval '10 seconds', version = version + 1
    WHERE id = j.id RETURNING * INTO j;
  RETURN hon.creative_provider_job_json(j) || jsonb_build_object('replayed', false);
END $$;

-- ---------- recording (0216 body, now aware of provider jobs) ----------
CREATE FUNCTION hon.creative_record_generation_result(p_subject text, p_generation uuid, p jsonb, p_job_status text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE g hon.creative_generations%ROWTYPE; outcome text; reason text; v integer; body jsonb; receipt jsonb; a jsonb; i integer := 0; n integer;
  at timestamptz; next_phase text; updated hon.creative_generations%ROWTYPE; job hon.creative_provider_jobs%ROWTYPE;
BEGIN
  IF p_job_status IS NOT NULL AND p_job_status NOT IN ('RECORDED','TIMED_OUT') THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF p_generation IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['assets','failureReason','finalUnits','outcome','providerCostMicrounits'] THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  outcome := p->>'outcome'; reason := p->>'failureReason';
  IF NOT coalesce(CASE outcome
      WHEN 'SUCCEEDED' THEN jsonb_typeof(p->'finalUnits') = 'number' AND (p->>'finalUnits') ~ '^[1-9][0-9]{0,3}$'
        AND jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'
        AND jsonb_typeof(p->'assets') = 'array' AND jsonb_array_length(p->'assets') BETWEEN 1 AND 8 AND jsonb_typeof(p->'failureReason') = 'null'
      WHEN 'FAILED' THEN jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'assets') = 'null' AND reason = 'PROVIDER_REJECTED'
        AND (jsonb_typeof(p->'providerCostMicrounits') = 'null' OR (jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'))
      WHEN 'NOT_SENT' THEN jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'assets') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null'
        AND reason IN ('PROVIDER_NOT_CONNECTED','INVALID_REQUEST')
      WHEN 'UNKNOWN' THEN jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'assets') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null'
        AND reason IN ('PROVIDER_UNKNOWN','UNVERIFIED_RESULT','INTERRUPTED')
      ELSE false END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO g FROM hon.creative_generations WHERE id = p_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.saas_creative_evidence_actor(p_subject, g.requested_by_principal_id);
  IF g.phase <> 'SUBMITTING' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  -- 0354: a generation with a provider job. Once SUBMITTED only the worker (p_job_status set) records it; while still
  -- PERMITTED the requester may record NOT_SENT, FAILED or UNKNOWN (only the API knows what the submit did), never
  -- SUCCEEDED or INTERRUPTED. A runtime record never creates or skips a job.
  SELECT * INTO job FROM hon.creative_provider_jobs WHERE generation_id = g.id AND school_id = g.school_id FOR UPDATE;
  IF FOUND THEN
    IF job.status NOT IN ('PERMITTED','SUBMITTED') THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
    IF p_job_status IS NULL AND (job.status = 'SUBMITTED' OR outcome = 'SUCCEEDED' OR reason = 'INTERRUPTED') THEN
      RAISE EXCEPTION 'CREATIVE_GENERATION_HAS_PROVIDER_JOB' USING ERRCODE = '40001';
    END IF;
  ELSIF p_job_status IS NOT NULL THEN
    RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002';
  ELSIF outcome = 'SUCCEEDED' AND NOT EXISTS (SELECT 1 FROM hon.saas_creative_reservations x WHERE x.id = g.reservation_id AND x.school_id = g.school_id
      AND x.model_code ~ '^synthetic-') THEN
    -- A real provider result is recorded only through a provider job, so the HQ daily provider limit can never be
    -- skipped. The synchronous path stays for the server's synthetic runtimes (model codes synthetic-*).
    RAISE EXCEPTION 'CREATIVE_PROVIDER_PERMIT_REQUIRED' USING ERRCODE = '40001';
  END IF;
  IF reason = 'INTERRUPTED' AND clock_timestamp() < g.created_at + interval '120 seconds' THEN
    RAISE EXCEPTION 'CREATIVE_GENERATION_IN_PROGRESS' USING ERRCODE = '40001';
  END IF;
  IF outcome = 'SUCCEEDED' THEN
    n := (p->>'finalUnits')::integer;
    IF n > g.units OR (g.media_kind = 'VIDEO' AND jsonb_array_length(p->'assets') <> 1) THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
    FOR a IN SELECT x FROM jsonb_array_elements(p->'assets') x LOOP
      IF jsonb_typeof(a) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a) k) IS DISTINCT FROM ARRAY['durationSeconds','height','mediaType','providerAssetReference','width']
        OR coalesce(a->>'mediaType', '') NOT IN (CASE g.media_kind WHEN 'IMAGE' THEN 'image/png' ELSE 'video/mp4' END, CASE g.media_kind WHEN 'IMAGE' THEN 'image/webp' ELSE 'video/mp4' END)
        OR coalesce(jsonb_typeof(a->'width'), '') <> 'number' OR (a->>'width') !~ '^[1-9][0-9]{0,3}$' OR (a->>'width')::integer > 8192
        OR coalesce(jsonb_typeof(a->'height'), '') <> 'number' OR (a->>'height') !~ '^[1-9][0-9]{0,3}$' OR (a->>'height')::integer > 8192
        OR (g.media_kind = 'IMAGE' AND jsonb_typeof(a->'durationSeconds') <> 'null')
        OR (g.media_kind = 'VIDEO' AND NOT (jsonb_typeof(a->'durationSeconds') = 'number' AND (a->>'durationSeconds') ~ '^[1-9][0-9]{0,2}$' AND (a->>'durationSeconds')::integer <= 600))
        OR coalesce(jsonb_typeof(a->'providerAssetReference'), '') <> 'string' OR (a->>'providerAssetReference') !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$' THEN
        RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
      END IF;
    END LOOP;
    body := jsonb_build_object('outcome', 'SUCCEEDED', 'finalUnits', n, 'providerCostMicrounits', p->'providerCostMicrounits');
    next_phase := 'RESULT_RECORDED';
  ELSIF outcome = 'FAILED' THEN
    body := jsonb_build_object('outcome', 'FAILED', 'finalUnits', NULL, 'providerCostMicrounits', p->'providerCostMicrounits'); next_phase := 'PROVIDER_FAILED';
  ELSIF outcome = 'NOT_SENT' THEN
    -- The provider never received the request, so its cost is a known zero (not a guess).
    body := jsonb_build_object('outcome', 'FAILED', 'finalUnits', NULL, 'providerCostMicrounits', 0); next_phase := 'NOT_SENT';
  ELSE
    body := jsonb_build_object('outcome', 'UNKNOWN', 'finalUnits', NULL, 'providerCostMicrounits', NULL); next_phase := 'PROVIDER_UNKNOWN';
  END IF;
  SELECT version INTO v FROM hon.saas_creative_reservations WHERE id = g.reservation_id AND school_id = g.school_id;
  -- The CW1 settle takes the wallet lock and the reservation row lock and refuses anything but RESERVED, so a second
  -- record (or one after an HQ resolution) is refused before the generation row is touched.
  receipt := hon.settle_saas_creative_credits(p_subject, g.reservation_id, body || jsonb_build_object('expectedVersion', v),
    md5('creative.generation.result:' || g.id::text)::uuid, gen_random_uuid(), gen_random_uuid());
  IF (receipt->>'replayed')::boolean THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp();
  UPDATE hon.creative_generations SET phase = next_phase, failure_reason = CASE WHEN outcome = 'SUCCEEDED' THEN NULL ELSE reason END,
      version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = g.id AND phase = 'SUBMITTING' RETURNING * INTO updated;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  IF job.id IS NOT NULL THEN
    UPDATE hon.creative_provider_jobs SET status = coalesce(p_job_status, 'RECORDED'), lease_token = NULL, lease_expires_at = NULL,
        closed_at = at, closed_by = CASE WHEN p_job_status IS NULL THEN 'REQUESTER' WHEN p_job_status = 'TIMED_OUT' THEN 'DEADLINE' ELSE 'WORKER' END,
        version = version + 1
      WHERE id = job.id AND status IN ('PERMITTED','SUBMITTED');
    IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  END IF;
  IF outcome = 'SUCCEEDED' THEN
    FOR a IN SELECT x FROM jsonb_array_elements(p->'assets') x LOOP
      i := i + 1;
      INSERT INTO hon.creative_generation_assets(generation_id, school_id, ordinal, media_type, width, height, duration_seconds, origin, provider_asset_reference, created_at)
        VALUES (g.id, g.school_id, i, a->>'mediaType', (a->>'width')::integer, (a->>'height')::integer, (a->>'durationSeconds')::integer,
          CASE WHEN p_job_status IS NULL THEN 'SYNTHETIC' ELSE 'PROVIDER' END,
          a->>'providerAssetReference', at);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('generation', hon.creative_generation_json(updated), 'balance', receipt->'balance', 'replayed', false);
END $$;


-- The runtime entry point keeps its 0216 signature: the requester records with no job status.
CREATE OR REPLACE FUNCTION hon.record_creative_generation_result(p_subject text, p_generation uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  RETURN hon.creative_record_generation_result(p_subject, p_generation, p, NULL);
END $$;

-- The requester's subject, for the worker to record through the 0216 rules (evidence actor: the same single-principal
-- active human who reserved). NULL when that person is no longer usable.
CREATE FUNCTION hon.creative_requester_subject(p_principal uuid) RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT u.external_subject FROM hon.principals p JOIN hon.users u ON u.id = p.user_id
   WHERE p.id = p_principal AND p.principal_type = 'HUMAN_USER' AND p.is_active
     AND (SELECT count(*) FROM hon.principals o WHERE o.user_id = u.id AND o.is_active) = 1
$$;

-- Close one open job through the 0216 rules with the given outcome. A requester who is no longer usable, or a reservation
-- already finished elsewhere (an HQ resolution, possibly racing this close), closes the job without settling anything and
-- keeps the provider's answer on the job as evidence for HQ. Any other refusal propagates (nothing is hidden).
CREATE FUNCTION hon.creative_close_provider_job(j hon.creative_provider_jobs, p jsonb, p_status text) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE g hon.creative_generations%ROWTYPE; r_status text; subject text; final text;
BEGIN
  SELECT * INTO g FROM hon.creative_generations WHERE id = j.generation_id AND school_id = j.school_id;
  SELECT status INTO r_status FROM hon.saas_creative_reservations WHERE id = g.reservation_id AND school_id = g.school_id;
  subject := hon.creative_requester_subject(g.requested_by_principal_id);
  IF g.phase <> 'SUBMITTING' OR r_status <> 'RESERVED' THEN final := 'RESOLVED_ELSEWHERE';
  ELSIF subject IS NULL THEN final := 'REQUESTER_UNAVAILABLE';
  ELSE
    BEGIN
      PERFORM hon.creative_record_generation_result(subject, g.id, p, p_status);
      RETURN p_status;
    EXCEPTION WHEN serialization_failure THEN
      SELECT status INTO r_status FROM hon.saas_creative_reservations WHERE id = g.reservation_id AND school_id = g.school_id;
      IF r_status = 'RESERVED' THEN RAISE; END IF;
      final := 'RESOLVED_ELSEWHERE';
    END;
  END IF;
  UPDATE hon.creative_provider_jobs SET status = final, lease_token = NULL, lease_expires_at = NULL, closed_at = clock_timestamp(),
      closed_by = CASE WHEN p_status = 'TIMED_OUT' THEN 'DEADLINE' ELSE 'WORKER' END, provider_result = p, version = version + 1
    WHERE id = j.id AND status IN ('PERMITTED','SUBMITTED');
  RETURN final;
END $$;

-- ---------- worker (hon_communication_worker) ----------
-- CLAIM: first every open job past its deadline is recorded UNKNOWN (TIMED_OUT, never resent); then up to p_limit due
-- SUBMITTED jobs are leased. Polling is read-only at the provider, so an expired lease is simply claimable again.
CREATE FUNCTION hon.claim_creative_provider_jobs(p_limit integer, p_lease_seconds integer)
RETURNS TABLE(job_id uuid, lease_token uuid, provider_id text, provider_job_id text, model_code text, operation_code text, media_kind text,
  units integer, format text, poll_count integer, deadline_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE j hon.creative_provider_jobs%ROWTYPE; at timestamptz := clock_timestamp(); token uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  FOR j IN SELECT * FROM hon.creative_provider_jobs x WHERE x.status IN ('PERMITTED','SUBMITTED') AND x.deadline_at <= at
      AND (x.lease_expires_at IS NULL OR x.lease_expires_at <= at) ORDER BY x.deadline_at, x.id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
    -- One job's refusal never blocks the sweep or the leases: it is left for the next claim.
    BEGIN
      PERFORM hon.creative_close_provider_job(j, jsonb_build_object('outcome','UNKNOWN','finalUnits',NULL,'providerCostMicrounits',NULL,
        'failureReason','PROVIDER_UNKNOWN','assets',NULL), 'TIMED_OUT');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  FOR j IN SELECT * FROM hon.creative_provider_jobs x WHERE x.status = 'SUBMITTED' AND x.next_poll_at <= at AND x.deadline_at > at
      AND (x.lease_expires_at IS NULL OR x.lease_expires_at <= at) ORDER BY x.next_poll_at, x.id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    token := gen_random_uuid();
    UPDATE hon.creative_provider_jobs x SET lease_token = token, lease_expires_at = at + make_interval(secs => p_lease_seconds), version = x.version + 1
      WHERE x.id = j.id;
    SELECT j.id, token, j.provider_id, j.provider_job_id, r.model_code, g.operation_code, g.media_kind, g.units, g.format, j.poll_count, j.deadline_at
      INTO job_id, lease_token, provider_id, provider_job_id, model_code, operation_code, media_kind, units, format, poll_count, deadline_at
      FROM hon.creative_generations g JOIN hon.saas_creative_reservations r ON r.id = g.reservation_id AND r.school_id = g.school_id
     WHERE g.id = j.generation_id AND g.school_id = j.school_id;
    RETURN NEXT;
  END LOOP;
END $$;

CREATE FUNCTION hon.creative_leased_job(p_job uuid, p_lease uuid) RETURNS hon.creative_provider_jobs
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE j hon.creative_provider_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM hon.creative_provider_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND OR j.status <> 'SUBMITTED' OR j.lease_token IS DISTINCT FROM p_lease OR j.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'CREATIVE_JOB_LEASE_LOST' USING ERRCODE = '40001';
  END IF;
  RETURN j;
END $$;

-- POLL: the provider says the job is still running. Release the lease; back off 10, 20, 40, then every 60 seconds.
CREATE FUNCTION hon.record_creative_provider_job_poll(p_job uuid, p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE j hon.creative_provider_jobs%ROWTYPE; at timestamptz := clock_timestamp();
BEGIN
  IF p_job IS NULL OR p_lease IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  j := hon.creative_leased_job(p_job, p_lease);
  UPDATE hon.creative_provider_jobs SET poll_count = poll_count + 1, lease_token = NULL, lease_expires_at = NULL,
      next_poll_at = at + make_interval(secs => CASE WHEN j.poll_count = 0 THEN 20 WHEN j.poll_count = 1 THEN 40 ELSE 60 END), version = version + 1
    WHERE id = j.id RETURNING * INTO j;
  RETURN jsonb_build_object('status', j.status, 'nextPollAt', hon.saas_ts(j.next_poll_at));
END $$;

-- RESULT: the provider's final answer (SUCCEEDED, FAILED or UNKNOWN; never NOT_SENT or INTERRUPTED: it was sent).
CREATE FUNCTION hon.record_creative_provider_job_result(p_job uuid, p_lease uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE j hon.creative_provider_jobs%ROWTYPE;
BEGIN
  IF p_job IS NULL OR p_lease IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR coalesce(p->>'outcome', '') NOT IN ('SUCCEEDED','FAILED','UNKNOWN')
    OR coalesce(p->>'failureReason', '') = 'INTERRUPTED' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  j := hon.creative_leased_job(p_job, p_lease);
  RETURN jsonb_build_object('status', hon.creative_close_provider_job(j, p, 'RECORDED'));
END $$;

-- ---------- HQ owner commands and read ----------
CREATE FUNCTION hon.creative_limit_reason_ok(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_typeof(p->'reason') = 'string' AND (p->>'reason') = btrim(p->>'reason') AND length(p->>'reason') BETWEEN 10 AND 500
    AND jsonb_typeof(p->'expectedVersion') = 'number' AND (p->>'expectedVersion') ~ '^[0-9]{1,9}$'
$$;

CREATE FUNCTION hon.command_creative_provider_daily_limit(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; v_provider text; v_limit bigint; v_reason text; v_expected integer; fp text; cur integer; cmd hon.creative_limit_commands%ROWTYPE;
  l hon.creative_provider_daily_limits%ROWTYPE;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k), ARRAY[]::text[]) <> ARRAY['dailyLimitMicros','expectedVersion','providerId','reason']
     OR coalesce(p_input->>'providerId', '') NOT IN ('HIGGSFIELD','HEYGEN') OR jsonb_typeof(p_input->'providerId') <> 'string'
     OR jsonb_typeof(p_input->'dailyLimitMicros') <> 'number' OR (p_input->>'dailyLimitMicros') !~ '^[0-9]{1,11}$' OR (p_input->>'dailyLimitMicros')::bigint > 10000000000
     OR NOT hon.creative_limit_reason_ok(p_input) THEN
    RAISE EXCEPTION 'INVALID_CREATIVE_LIMIT' USING ERRCODE = '22023';
  END IF;
  v_provider := p_input->>'providerId'; v_limit := (p_input->>'dailyLimitMicros')::bigint; v_reason := p_input->>'reason'; v_expected := (p_input->>'expectedVersion')::integer;
  IF NOT EXISTS (SELECT 1 FROM hon.hq_ai_provider_connections WHERE provider_id = v_provider) THEN RAISE EXCEPTION 'CREATIVE_PROVIDER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  fp := encode(sha256(convert_to(jsonb_build_object('k','PROVIDER','p',v_provider,'l',v_limit,'r',v_reason,'v',v_expected,'by',actor)::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('creative.limit.key:' || p_key::text, 0));
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT * INTO cmd FROM hon.creative_limit_commands WHERE command_key = p_key;
  IF FOUND THEN
    IF cmd.fingerprint <> fp THEN RAISE EXCEPTION 'CREATIVE_LIMIT_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('providerId', cmd.target, 'dailyLimitMicros', (cmd.settings->>'dailyLimitMicros')::bigint, 'version', cmd.resulting_version, 'replayed', true);
  END IF;
  SELECT * INTO l FROM hon.creative_provider_daily_limits WHERE provider_id = v_provider FOR UPDATE;
  cur := CASE WHEN FOUND THEN l.version ELSE 0 END;
  IF cur <> v_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF cur = 0 THEN
    INSERT INTO hon.creative_provider_daily_limits(provider_id, daily_limit_micros, reason, version, updated_by_principal_id) VALUES (v_provider, v_limit, v_reason, 1, actor);
  ELSE
    UPDATE hon.creative_provider_daily_limits SET daily_limit_micros = v_limit, reason = v_reason, version = version + 1, updated_by_principal_id = actor,
      updated_at = clock_timestamp() WHERE provider_id = v_provider;
  END IF;
  INSERT INTO hon.creative_limit_commands(command_key, command_kind, fingerprint, actor_principal_id, target, settings, reason, prior_version, resulting_version)
    VALUES (p_key, 'PROVIDER_DAILY_LIMIT', fp, actor, v_provider, jsonb_build_object('dailyLimitMicros', v_limit), v_reason, cur, cur + 1);
  RETURN jsonb_build_object('providerId', v_provider, 'dailyLimitMicros', v_limit, 'version', cur + 1, 'replayed', false);
END $$;

CREATE FUNCTION hon.command_creative_school_daily_caps(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; v_school uuid; v_org uuid; v_reason text; v_expected integer; fp text; cur integer; cmd hon.creative_limit_commands%ROWTYPE;
  l hon.creative_school_daily_caps%ROWTYPE; caps jsonb;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k), ARRAY[]::text[]) <> ARRAY['avatarVideos','expectedVersion','images','reason','schoolId','videos']
     OR jsonb_typeof(p_input->'schoolId') <> 'string' OR (p_input->>'schoolId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['images','videos','avatarVideos']) c WHERE jsonb_typeof(p_input->c) IS DISTINCT FROM 'number'
       OR (p_input->>c) !~ '^[0-9]{1,4}$' OR (p_input->>c)::integer > 1000)
     OR NOT hon.creative_limit_reason_ok(p_input) THEN
    RAISE EXCEPTION 'INVALID_CREATIVE_LIMIT' USING ERRCODE = '22023';
  END IF;
  v_school := (p_input->>'schoolId')::uuid; v_reason := p_input->>'reason'; v_expected := (p_input->>'expectedVersion')::integer;
  caps := jsonb_build_object('images', (p_input->>'images')::integer, 'videos', (p_input->>'videos')::integer, 'avatarVideos', (p_input->>'avatarVideos')::integer);
  SELECT organization_id INTO v_org FROM hon.schools WHERE id = v_school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREATIVE_SCHOOL_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  fp := encode(sha256(convert_to(jsonb_build_object('k','SCHOOL','s',v_school,'c',caps,'r',v_reason,'v',v_expected,'by',actor)::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('creative.limit.key:' || p_key::text, 0));
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT * INTO cmd FROM hon.creative_limit_commands WHERE command_key = p_key;
  IF FOUND THEN
    IF cmd.fingerprint <> fp THEN RAISE EXCEPTION 'CREATIVE_LIMIT_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('schoolId', cmd.target::uuid) || cmd.settings || jsonb_build_object('version', cmd.resulting_version, 'replayed', true);
  END IF;
  SELECT * INTO l FROM hon.creative_school_daily_caps WHERE school_id = v_school FOR UPDATE;
  cur := CASE WHEN FOUND THEN l.version ELSE 0 END;
  IF cur <> v_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF cur = 0 THEN
    INSERT INTO hon.creative_school_daily_caps(school_id, organization_id, images, videos, avatar_videos, reason, version, updated_by_principal_id)
      VALUES (v_school, v_org, (caps->>'images')::integer, (caps->>'videos')::integer, (caps->>'avatarVideos')::integer, v_reason, 1, actor);
  ELSE
    UPDATE hon.creative_school_daily_caps SET images = (caps->>'images')::integer, videos = (caps->>'videos')::integer, avatar_videos = (caps->>'avatarVideos')::integer,
      reason = v_reason, version = version + 1, updated_by_principal_id = actor, updated_at = clock_timestamp() WHERE school_id = v_school;
  END IF;
  INSERT INTO hon.creative_limit_commands(command_key, command_kind, fingerprint, actor_principal_id, target, settings, reason, prior_version, resulting_version)
    VALUES (p_key, 'SCHOOL_DAILY_CAPS', fp, actor, v_school::text, caps, v_reason, cur, cur + 1);
  RETURN jsonb_build_object('schoolId', v_school) || caps || jsonb_build_object('version', cur + 1, 'replayed', false);
END $$;

-- HQ read (owner or billing operator): each creative provider with its limit and today's committed cost and open jobs,
-- the default school caps and every school override.
CREATE FUNCTION hon.read_creative_limits_from_hq(p_subject text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.require_saas_hq_actor(p_subject, false); at timestamptz := clock_timestamp();
BEGIN
  RETURN jsonb_build_object(
    'providers', (SELECT coalesce(jsonb_agg(jsonb_build_object('providerId', p.id,
        'dailyLimitMicros', l.daily_limit_micros, 'version', coalesce(l.version, 0), 'reason', l.reason,
        'committedTodayMicros', hon.creative_provider_committed_micros(p.id, at),
        'openJobs', (SELECT count(*) FROM hon.creative_provider_jobs j WHERE j.provider_id = p.id AND j.status IN ('PERMITTED','SUBMITTED')),
        -- Open past the deadline: the claim sweep could not close them (its refusal is skipped so the others proceed).
        -- Safe on spend (their worst case stays committed) but listed so HQ sees them.
        'overdueJobs', (SELECT count(*) FROM hon.creative_provider_jobs j WHERE j.provider_id = p.id AND j.status IN ('PERMITTED','SUBMITTED')
          AND j.deadline_at <= at))
      ORDER BY p.id), '[]'::jsonb)
      FROM unnest(ARRAY['HEYGEN','HIGGSFIELD']) p(id) LEFT JOIN hon.creative_provider_daily_limits l ON l.provider_id = p.id),
    -- Jobs whose requester was gone when the result came: the reservation is still RESERVED and the HQ owner resolves it
    -- with evidence through the existing CW1 command (resolve_saas_creative_reservation_from_hq accepts RESERVED).
    'requesterUnavailable', (SELECT coalesce(jsonb_agg(jsonb_build_object('jobId', x.id, 'schoolId', x.school_id, 'reservationId', x.reservation_id,
        'providerId', x.provider_id, 'closedAt', hon.saas_ts(x.closed_at), 'providerResult', x.provider_result) ORDER BY x.closed_at, x.id), '[]'::jsonb)
      FROM (SELECT j.id, j.school_id, g.reservation_id, j.provider_id, j.closed_at, j.provider_result FROM hon.creative_provider_jobs j
          JOIN hon.creative_generations g ON g.id = j.generation_id AND g.school_id = j.school_id
          JOIN hon.saas_creative_reservations r ON r.id = g.reservation_id AND r.school_id = g.school_id
         WHERE j.status = 'REQUESTER_UNAVAILABLE' AND r.status = 'RESERVED' ORDER BY j.closed_at, j.id LIMIT 100) x),
    'defaultSchoolCaps', jsonb_build_object('images', 50, 'videos', 12, 'avatarVideos', 10),
    'schoolCaps', (SELECT coalesce(jsonb_agg(jsonb_build_object('schoolId', c.school_id, 'images', c.images, 'videos', c.videos,
        'avatarVideos', c.avatar_videos, 'reason', c.reason, 'version', c.version) ORDER BY c.school_id), '[]'::jsonb)
      FROM (SELECT * FROM hon.creative_school_daily_caps ORDER BY school_id LIMIT 500) c),
    'day', jsonb_build_object('start', hon.saas_ts(lower(hon.creative_utc_day(at))), 'end', hon.saas_ts(upper(hon.creative_utc_day(at)))));
END $$;

-- ---------- ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['creative_provider_daily_limits','creative_school_daily_caps','creative_limit_commands','creative_provider_jobs'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE', t, r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE', col, t);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace
      AND p.proname IN ('guard_creative_limit_commands','guard_creative_limit_rows','guard_creative_provider_job','creative_cap_class','creative_utc_day',
        'creative_school_daily_cap','guard_creative_generation_daily_cap','creative_provider_committed_micros','creative_provider_job_json',
        'begin_creative_provider_submission','record_creative_provider_submission','creative_record_generation_result','record_creative_generation_result',
        'creative_requester_subject','creative_close_provider_job','claim_creative_provider_jobs','creative_leased_job','record_creative_provider_job_poll',
        'record_creative_provider_job_result','creative_limit_reason_ok','command_creative_provider_daily_limit','command_creative_school_daily_caps',
        'read_creative_limits_from_hq') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.record_creative_generation_result(text,uuid,jsonb), hon.begin_creative_provider_submission(text,uuid),
      hon.record_creative_provider_submission(text,uuid,text), hon.command_creative_provider_daily_limit(text,jsonb,uuid),
      hon.command_creative_school_daily_caps(text,jsonb,uuid), hon.read_creative_limits_from_hq(text) TO hon_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.claim_creative_provider_jobs(integer,integer), hon.record_creative_provider_job_poll(uuid,uuid),
      hon.record_creative_provider_job_result(uuid,uuid,jsonb) TO hon_communication_worker;
  END IF;
END $$;

COMMIT;
