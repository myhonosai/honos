BEGIN;

-- 0715 HQ prospects pipeline board (docs/architecture/HQ_PROSPECT_PIPELINE.md). HON's own prospects move through stages
-- HQ edits (seeded Lead, Contacted, Demo booked), like a school's lead board, and close as WON (became a school) or LOST
-- (not interested). The board also lists real customer schools in two fixed, read-only columns from their real status:
-- Active school (school and organization ACTIVE) and Inactive school (either SUSPENDED or ARCHIVED). Nothing here changes a
-- school, sends a message, contacts a provider or touches billing or entitlements. HQ owner or hq.marketing.manage only.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ prospect pipeline requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.create_hq_prospect(text,jsonb,uuid)') IS NULL OR to_regprocedure('hon.require_hq_marketing_actor(text,boolean)') IS NULL
    OR to_regclass('hon.hon_os_trial_enrollments') IS NULL THEN
    RAISE EXCEPTION 'Apply HQ prospects (0283), HQ marketing (0252) and trial runtime (0246) first';
  END IF;
END $$;

-- One board; its version guards whole-pipeline stage saves.
CREATE TABLE hon.hq_prospect_pipeline (
  id smallint PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 999999999),
  updated_at timestamptz NOT NULL
);

CREATE TABLE hon.hq_prospect_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 60 AND name !~ '[[:cntrl:]\u007F-\u009F​-‏‪-‮⁠-⁯﻿<>]'),
  color text NOT NULL CHECK (color IN ('BLUE','SKY','CYAN','VIOLET','GREEN','RED','AMBER','SLATE')),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 20),
  hidden boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (updated_at >= created_at),
  UNIQUE (position) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX hq_prospect_stages_name ON hon.hq_prospect_stages (lower(name));

-- Every stage save and prospect move, once per (person, key); the saved answer is replayed.
CREATE TABLE hon.hq_prospect_board_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('MOVE','STAGES')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  prospect_id uuid REFERENCES hon.hq_prospects(id),
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  CHECK ((operation = 'MOVE') = (prospect_id IS NOT NULL)),
  PRIMARY KEY (actor_principal_id, idempotency_key)
);

INSERT INTO hon.hq_prospect_pipeline VALUES (1, 1, clock_timestamp());
INSERT INTO hon.hq_prospect_stages (name, color, position, hidden, created_at, updated_at) VALUES
  ('Lead', 'BLUE', 1, false, clock_timestamp(), clock_timestamp()),
  ('Contacted', 'AMBER', 2, false, clock_timestamp(), clock_timestamp()),
  ('Demo booked', 'VIOLET', 3, false, clock_timestamp(), clock_timestamp());

ALTER TABLE hon.hq_prospects ADD COLUMN stage_id uuid REFERENCES hon.hq_prospect_stages(id),
  ADD COLUMN closed_outcome text CHECK (closed_outcome IN ('WON','LOST'));

-- Open prospects always sit in a stage; a closed outcome belongs only to an archived prospect. Every insert and restore
-- (sign-up, HQ add, import, update) lands in the first visible stage when none is given; a restore clears the outcome.
CREATE FUNCTION hon.hq_prospect_stage_defaults() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF NEW.status = 'ACTIVE' THEN
    NEW.closed_outcome := NULL;
    IF NEW.stage_id IS NULL THEN
      SELECT id INTO NEW.stage_id FROM hon.hq_prospect_stages WHERE NOT hidden ORDER BY position LIMIT 1;
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Named after 'guarded' so the 0283 guard sees the row as the command wrote it.
CREATE TRIGGER stage_defaults BEFORE INSERT OR UPDATE ON hon.hq_prospects FOR EACH ROW EXECUTE FUNCTION hon.hq_prospect_stage_defaults();

-- Backfill: the 0283 guard allows an update only as a version bump.
UPDATE hon.hq_prospects SET version = version + 1, updated_at = greatest(updated_at, clock_timestamp())
WHERE status = 'ACTIVE' AND stage_id IS NULL;

ALTER TABLE hon.hq_prospects ADD CONSTRAINT hq_prospects_stage_open CHECK (status <> 'ACTIVE' OR stage_id IS NOT NULL),
  ADD CONSTRAINT hq_prospects_outcome_closed CHECK (closed_outcome IS NULL OR status = 'ARCHIVED');
CREATE INDEX hq_prospects_stage ON hon.hq_prospects (stage_id) WHERE status = 'ACTIVE';

-- Stages are never deleted (hidden instead); requests are evidence.
CREATE FUNCTION hon.guard_hq_prospect_stage() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id = OLD.id AND NEW.created_at = OLD.created_at AND NEW.updated_at >= OLD.updated_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'HQ_PROSPECT_STAGE_GUARDED' USING ERRCODE = '42501';
END $$;
CREATE FUNCTION hon.guard_hq_prospect_pipeline() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id = OLD.id AND NEW.version = OLD.version + 1 AND NEW.updated_at >= OLD.updated_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'HQ_PROSPECT_PIPELINE_GUARDED' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_prospect_stages FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_prospect_stage();
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_prospect_pipeline FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_prospect_pipeline();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_prospect_board_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_evidence();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_prospect_pipeline','hq_prospect_stages','hq_prospect_board_requests'] LOOP
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_communication_evidence()', t);
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
  END LOOP;
END $$;

-- ---------- helpers ----------
CREATE FUNCTION hon.hq_prospect_board_claim(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prior hon.hq_prospect_board_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-prospect-board:' || p_actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO prior FROM hon.hq_prospect_board_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.operation <> p_operation OR prior.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  RETURN prior.response || jsonb_build_object('replayed', true);
END $$;

CREATE FUNCTION hon.hq_prospect_stages_json() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('stageId', s.id, 'name', s.name, 'color', s.color, 'position', s.position, 'hidden', s.hidden,
    'openCount', (SELECT count(*) FROM hon.hq_prospects p WHERE p.status = 'ACTIVE' AND p.stage_id = s.id)) ORDER BY s.position), '[]'::jsonb)
  FROM hon.hq_prospect_stages s
$$;

-- An answer of 'opted out' on either texting purpose hides the card's Text link (HON itself sends nothing from the board).
CREATE FUNCTION hon.hq_prospect_card_json(p hon.hq_prospects) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('prospectId', p.id, 'fullName', p.full_name, 'schoolName', p.school_name, 'email', p.email, 'phone', p.phone_e164,
    'source', p.source, 'stageId', p.stage_id, 'status', p.status, 'closedOutcome', p.closed_outcome,
    'textOptedOut', coalesce(hon.hq_prospect_consent_now(p, 'SMS', 'SERVICE')->>'status' = 'OPTED_OUT', false)
      OR coalesce(hon.hq_prospect_consent_now(p, 'SMS', 'MARKETING')->>'status' = 'OPTED_OUT', false),
    'createdAt', hon.saas_ts(p.created_at), 'version', p.version)
$$;

-- ---------- read ----------
-- Stages, open prospects (at most 2000, newest first), closed counts, and customer schools by real status. A school shows
-- only its names, plan tier, status, trial end and start date.
CREATE FUNCTION hon.read_hq_prospect_board(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; v_prospects jsonb; n integer; result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, true);
  SELECT coalesce(jsonb_agg(hon.hq_prospect_card_json(x) ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb), count(*) INTO v_prospects, n
  FROM (SELECT * FROM hon.hq_prospects WHERE status = 'ACTIVE' ORDER BY created_at DESC, id DESC LIMIT 2000) x;
  result := jsonb_build_object(
    'pipelineVersion', (SELECT version FROM hon.hq_prospect_pipeline WHERE id = 1),
    'stages', hon.hq_prospect_stages_json(),
    'prospects', v_prospects,
    'truncated', n = 2000 AND (SELECT count(*) FROM hon.hq_prospects WHERE status = 'ACTIVE') > 2000,
    'closed', jsonb_build_object(
      'won', (SELECT count(*) FROM hon.hq_prospects WHERE status = 'ARCHIVED' AND closed_outcome = 'WON'),
      'lost', (SELECT count(*) FROM hon.hq_prospects WHERE status = 'ARCHIVED' AND closed_outcome = 'LOST')),
    'schools', (SELECT coalesce(jsonb_agg(jsonb_build_object('schoolId', r.id, 'schoolName', r.name, 'organizationName', r.org_name,
        'status', r.status, 'tier', r.tier, 'trialEndsAt', CASE WHEN r.trial_ends IS NOT NULL THEN hon.saas_ts(r.trial_ends) END,
        'createdAt', hon.saas_ts(r.created_at)) ORDER BY r.created_at DESC, r.id), '[]'::jsonb)
      FROM (SELECT s.id, s.name, o.display_name AS org_name, s.created_at,
          CASE WHEN 'ARCHIVED' IN (s.status::text, o.status::text) THEN 'ARCHIVED'
               WHEN 'SUSPENDED' IN (s.status::text, o.status::text) THEN 'SUSPENDED' ELSE 'ACTIVE' END AS status,
          (SELECT e.tier::text FROM hon.organization_entitlements e WHERE e.organization_id = o.id AND e.status = 'ACTIVE'
             AND e.effective_from <= clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until > clock_timestamp())
           ORDER BY e.effective_from DESC, e.tier LIMIT 1) AS tier,
          (SELECT t.ends_at FROM hon.hon_os_trial_enrollments t WHERE t.school_id = s.id AND t.starts_at <= clock_timestamp()
             AND t.ends_at > clock_timestamp() LIMIT 1) AS trial_ends
        FROM hon.schools s JOIN hon.organizations o ON o.id = s.organization_id
        WHERE s.status::text IN ('ACTIVE','SUSPENDED','ARCHIVED') AND o.status::text IN ('ACTIVE','SUSPENDED','ARCHIVED')) r),
    'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_marketing_actor(p_subject, true);
  RETURN result;
END $$;

-- ---------- commands ----------
-- MOVE: {expectedVersion, stageId, outcome}; exactly one of stageId (a visible stage; re-opens a closed prospect) or
-- outcome (WON or LOST; closes an open prospect).
CREATE FUNCTION hon.move_hq_prospect_stage(p_subject text, p_prospect uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; p hon.hq_prospects%ROWTYPE; fp text; v_stage uuid; v_outcome text; at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, true);
  IF p_prospect IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.hq_communication_keys(p_input, ARRAY['expectedVersion','outcome','stageId']);
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR (jsonb_typeof(p_input->'outcome') <> 'null' AND (jsonb_typeof(p_input->'outcome') IS DISTINCT FROM 'string' OR (p_input->>'outcome') NOT IN ('WON','LOST')))
    OR ((jsonb_typeof(p_input->'outcome') = 'null') = (jsonb_typeof(p_input->'stageId') = 'null')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_stage := hon.hq_communication_uuid(p_input, 'stageId', true);
  v_outcome := p_input->>'outcome';
  fp := hon.saas_fingerprint(ARRAY['hq.prospect.stage.move', p_prospect::text, p_input::text]);
  replay := hon.hq_prospect_board_claim(actor, p_key, 'MOVE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_marketing_actor(p_subject, true); RETURN replay; END IF;
  SELECT * INTO p FROM hon.hq_prospects WHERE id = p_prospect FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF p.version <> (p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF v_stage IS NOT NULL THEN
    PERFORM 1 FROM hon.hq_prospect_stages WHERE id = v_stage AND NOT hidden FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'HQ_PROSPECT_STAGE_UNAVAILABLE' USING ERRCODE = '23514'; END IF;
    IF p.status = 'ACTIVE' AND p.stage_id = v_stage THEN RAISE EXCEPTION 'HQ_PROSPECT_NO_CHANGE' USING ERRCODE = '23514'; END IF;
    UPDATE hon.hq_prospects SET stage_id = v_stage, status = 'ACTIVE', closed_outcome = NULL, updated_at = at, version = version + 1
    WHERE id = p.id RETURNING * INTO p;
  ELSE
    IF p.status <> 'ACTIVE' THEN RAISE EXCEPTION 'HQ_PROSPECT_ARCHIVED' USING ERRCODE = '23514'; END IF;
    UPDATE hon.hq_prospects SET status = 'ARCHIVED', closed_outcome = v_outcome, updated_at = at, version = version + 1
    WHERE id = p.id RETURNING * INTO p;
  END IF;
  result := jsonb_build_object('operation', 'MOVE', 'prospect', hon.hq_prospect_card_json(p));
  INSERT INTO hon.hq_prospect_board_requests VALUES (actor, p_key, 'MOVE', fp, p.id, result, at);
  PERFORM hon.require_hq_marketing_actor(p_subject, true);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- STAGES: {expectedVersion, stages: [{id|null, name, color, hidden}] in board order, moves: [{fromStageId, toStageId}]}.
-- Every existing stage is listed once (nothing is deleted); at least one stays visible; names are unique; a stage that
-- becomes hidden while holding open prospects names one visible existing stage to receive them, and only those move.
CREATE FUNCTION hon.save_hq_prospect_stages(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; fp text; v_version integer; s jsonb; m jsonb; i integer := 0; v_id uuid; v_ids uuid[] := ARRAY[]::uuid[];
  v_names text[] := ARRAY[]::text[]; v_hidden boolean; v_from uuid; v_to uuid; v_need uuid[]; v_moved uuid[] := ARRAY[]::uuid[];
  at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, true);
  PERFORM hon.hq_communication_keys(p_input, ARRAY['expectedVersion','moves','stages']);
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'stages') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'stages') NOT BETWEEN 1 AND 20
    OR jsonb_typeof(p_input->'moves') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'moves') > 20 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  fp := hon.saas_fingerprint(ARRAY['hq.prospect.stages.save', p_input::text]);
  replay := hon.hq_prospect_board_claim(actor, p_key, 'STAGES', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_marketing_actor(p_subject, true); RETURN replay; END IF;
  SELECT version INTO v_version FROM hon.hq_prospect_pipeline WHERE id = 1 FOR UPDATE;
  IF v_version <> (p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  PERFORM 1 FROM hon.hq_prospect_stages FOR UPDATE;

  -- Shape of every stage entry.
  FOR s IN SELECT value FROM jsonb_array_elements(p_input->'stages') LOOP
    PERFORM hon.hq_communication_keys(s, ARRAY['color','hidden','id','name']);
    IF jsonb_typeof(s->'name') IS DISTINCT FROM 'string' OR (s->>'name') <> btrim(s->>'name') OR length(s->>'name') NOT BETWEEN 1 AND 60
      OR (s->>'name') ~ '[[:cntrl:]\u007F-\u009F​-‏‪-‮⁠-⁯﻿<>]'
      OR jsonb_typeof(s->'color') IS DISTINCT FROM 'string' OR (s->>'color') NOT IN ('BLUE','SKY','CYAN','VIOLET','GREEN','RED','AMBER','SLATE')
      OR jsonb_typeof(s->'hidden') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
    END IF;
    v_id := hon.hq_communication_uuid(s, 'id', true);
    IF v_id IS NOT NULL THEN
      IF v_id = ANY(v_ids) OR NOT EXISTS (SELECT 1 FROM hon.hq_prospect_stages WHERE id = v_id) THEN
        RAISE EXCEPTION 'HQ_PROSPECT_STAGES_INVALID' USING ERRCODE = '23514';
      END IF;
      v_ids := v_ids || v_id;
    END IF;
    IF lower(s->>'name') = ANY(v_names) THEN RAISE EXCEPTION 'HQ_PROSPECT_STAGE_NAME_TAKEN' USING ERRCODE = '23514'; END IF;
    v_names := v_names || lower(s->>'name');
  END LOOP;
  IF EXISTS (SELECT 1 FROM hon.hq_prospect_stages WHERE NOT (id = ANY(v_ids))) THEN RAISE EXCEPTION 'HQ_PROSPECT_STAGES_INVALID' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_input->'stages') e WHERE NOT (e.value->>'hidden')::boolean) THEN
    RAISE EXCEPTION 'HQ_PROSPECT_STAGE_VISIBLE_REQUIRED' USING ERRCODE = '23514';
  END IF;

  -- Stages that hide while holding open prospects, and their moves.
  SELECT coalesce(array_agg(st.id), ARRAY[]::uuid[]) INTO v_need FROM hon.hq_prospect_stages st
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(p_input->'stages') e WHERE (e.value->>'id')::uuid = st.id AND (e.value->>'hidden')::boolean)
    AND EXISTS (SELECT 1 FROM hon.hq_prospects p WHERE p.status = 'ACTIVE' AND p.stage_id = st.id);
  FOR m IN SELECT value FROM jsonb_array_elements(p_input->'moves') LOOP
    PERFORM hon.hq_communication_keys(m, ARRAY['fromStageId','toStageId']);
    v_from := hon.hq_communication_uuid(m, 'fromStageId', false); v_to := hon.hq_communication_uuid(m, 'toStageId', false);
    IF NOT (v_from = ANY(v_need)) OR v_from = ANY(v_moved)
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_input->'stages') e WHERE (e.value->>'id')::uuid = v_to AND NOT (e.value->>'hidden')::boolean) THEN
      RAISE EXCEPTION 'HQ_PROSPECT_STAGE_MOVE_INVALID' USING ERRCODE = '23514';
    END IF;
    v_moved := v_moved || v_from;
  END LOOP;
  IF cardinality(v_moved) <> cardinality(v_need) THEN RAISE EXCEPTION 'HQ_PROSPECT_STAGE_MOVE_REQUIRED' USING ERRCODE = '23514'; END IF;

  -- Write: names freed first (unique by name), positions in board order (unique deferred to commit).
  UPDATE hon.hq_prospect_stages SET name = id::text, updated_at = at;
  FOR s IN SELECT value FROM jsonb_array_elements(p_input->'stages') LOOP
    i := i + 1; v_id := hon.hq_communication_uuid(s, 'id', true); v_hidden := (s->>'hidden')::boolean;
    IF v_id IS NULL THEN
      INSERT INTO hon.hq_prospect_stages (name, color, position, hidden, created_at, updated_at) VALUES (s->>'name', s->>'color', i, v_hidden, at, at);
    ELSE
      UPDATE hon.hq_prospect_stages SET name = s->>'name', color = s->>'color', position = i, hidden = v_hidden, updated_at = at WHERE id = v_id;
    END IF;
  END LOOP;
  FOR m IN SELECT value FROM jsonb_array_elements(p_input->'moves') LOOP
    UPDATE hon.hq_prospects SET stage_id = (m->>'toStageId')::uuid, updated_at = greatest(updated_at, at), version = version + 1
    WHERE status = 'ACTIVE' AND stage_id = (m->>'fromStageId')::uuid;
  END LOOP;
  SET CONSTRAINTS hq_prospect_stages_position_key IMMEDIATE;
  UPDATE hon.hq_prospect_pipeline SET version = version + 1, updated_at = greatest(updated_at, at) WHERE id = 1 RETURNING version INTO v_version;
  result := jsonb_build_object('operation', 'STAGES', 'pipelineVersion', v_version, 'stages', hon.hq_prospect_stages_json());
  INSERT INTO hon.hq_prospect_board_requests VALUES (actor, p_key, 'STAGES', fp, NULL, result, at);
  PERFORM hon.require_hq_marketing_actor(p_subject, true);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- privileges ----------
DO $$ DECLARE r text; t text; f text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker','hon_outbox_worker') LOOP
    FOREACH t IN ARRAY ARRAY['hq_prospect_pipeline','hq_prospect_stages','hq_prospect_board_requests'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hq_prospect_stage_defaults()','guard_hq_prospect_stage()','guard_hq_prospect_pipeline()',
    'hq_prospect_board_claim(uuid,uuid,text,text)','hq_prospect_stages_json()','hq_prospect_card_json(hon.hq_prospects)',
    'read_hq_prospect_board(text)','move_hq_prospect_stage(text,uuid,jsonb,uuid)','save_hq_prospect_stages(text,jsonb,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker','hon_outbox_worker') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_hq_prospect_board(text), hon.move_hq_prospect_stage(text,uuid,jsonb,uuid),
      hon.save_hq_prospect_stages(text,jsonb,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
