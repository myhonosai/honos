BEGIN;

-- 0283 HON prospects and their consent (HQ-COMM PR E1, docs/architecture/HQ_COMMUNICATIONS.md §4.8). HON's own prospects:
-- people who asked about, signed up for or tried HON OS; never a school's leads. HQ marketing people (an HQ owner, or an HQ
-- operator holding hq.marketing.manage) add, correct, archive and read prospects, and see their contact details. Consent
-- is append-only, per channel (EMAIL, SMS) and purpose (SERVICE, MARKETING), and tied to the exact address it was given
-- for: a changed email or phone starts with no consent. HQ can record an opt-out for anyone, and an email SERVICE opt-in
-- for someone who asked HON a question; it can never record a marketing or texting opt-in on someone's behalf (those come
-- only from the person: the sign-up form with its disclosure version, or their own text). Nothing here sends a message,
-- contacts a provider or touches schools, billing or entitlements; sending to prospects is PR E2.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ prospects require a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.require_hq_marketing_actor(text,boolean)') IS NULL OR to_regprocedure('hon.guard_hq_communication_evidence()') IS NULL THEN
    RAISE EXCEPTION 'Apply HQ marketing (0252) and HQ communications (0281) first';
  END IF;
END $$;

CREATE TABLE hon.hq_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL CHECK (full_name = btrim(full_name) AND length(full_name) BETWEEN 1 AND 120 AND full_name !~ '[[:cntrl:]<>]'),
  school_name text CHECK (school_name = btrim(school_name) AND length(school_name) BETWEEN 1 AND 160 AND school_name !~ '[[:cntrl:]<>]'),
  email text CHECK (email ~ '^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$'),
  phone_e164 text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  source text NOT NULL CHECK (source IN ('PUBLIC_SIGN_UP','TRIAL','HQ_ENTERED','IMPORT','INBOUND_TEXT')),
  campaign_id uuid REFERENCES hon.hq_marketing_campaigns(id),
  status text NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_by uuid REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL),
  CHECK ((source IN ('HQ_ENTERED','IMPORT')) = (created_by IS NOT NULL)),
  CHECK (updated_at >= created_at),
  -- Stored at millisecond precision so the list orders and pages on the raw column, which the index serves.
  CHECK (created_at = date_trunc('milliseconds', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
);
-- One prospect per address, archived or not, so a person is never added twice under the same email or phone.
CREATE UNIQUE INDEX hq_prospects_email ON hon.hq_prospects (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX hq_prospects_phone ON hon.hq_prospects (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX hq_prospects_created ON hon.hq_prospects (created_at DESC, id DESC);

CREATE TABLE hon.hq_prospect_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES hon.hq_prospects(id),
  channel text NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  purpose text NOT NULL CHECK (purpose IN ('SERVICE','MARKETING')),
  status text NOT NULL CHECK (status IN ('OPTED_IN','OPTED_OUT')),
  source text NOT NULL CHECK (source IN ('SIGN_UP_FORM','HQ_RECORDED','RECIPIENT')),
  -- The email or phone this answer was given for. Consent never carries over to a changed address.
  address text NOT NULL CHECK (address ~ '^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$' OR address ~ '^\+[1-9][0-9]{7,14}$'),
  disclosure_version text CHECK (disclosure_version ~ '^[a-z0-9][a-z0-9.-]{0,39}$'),
  note text CHECK (note = btrim(note) AND length(note) BETWEEN 3 AND 300 AND note !~ '[[:cntrl:]<>]'),
  recorded_by uuid REFERENCES hon.principals(id),
  captured_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  CHECK ((channel = 'EMAIL') = (address ~ '@')),
  -- HQ records only with who and why; and only an opt-out, or an email service opt-in (the person asked HON something).
  CHECK ((source = 'HQ_RECORDED') = (recorded_by IS NOT NULL)),
  CHECK (source <> 'HQ_RECORDED' OR note IS NOT NULL),
  CHECK (source <> 'HQ_RECORDED' OR status = 'OPTED_OUT' OR (channel = 'EMAIL' AND purpose = 'SERVICE')),
  -- A sign-up opt-in names the exact disclosure text the person saw.
  CHECK (source <> 'SIGN_UP_FORM' OR status = 'OPTED_OUT' OR disclosure_version IS NOT NULL),
  CHECK (captured_at <= recorded_at)
);
CREATE INDEX hq_prospect_consents_current ON hon.hq_prospect_consents (prospect_id, channel, purpose, captured_at DESC, recorded_at DESC, id DESC);

CREATE TABLE hon.hq_prospect_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('CREATE','UPDATE','CONSENT')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  prospect_id uuid NOT NULL REFERENCES hon.hq_prospects(id),
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (actor_principal_id, idempotency_key)
);

-- A prospect changes only by a version bump; who added it, when and from where never change. Nothing is ever deleted.
CREATE FUNCTION hon.guard_hq_prospect() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND NEW.id = OLD.id AND NEW.source = OLD.source
    AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by AND NEW.created_at = OLD.created_at AND NEW.updated_at >= OLD.updated_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HQ_PROSPECT_RECORD_GUARDED' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_prospects FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_prospect();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_prospect_consents FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_prospect_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_evidence();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_prospects','hq_prospect_consents','hq_prospect_requests'] LOOP
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_communication_evidence()', t);
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
  END LOOP;
END $$;

-- ---------- helpers ----------
CREATE FUNCTION hon.hq_prospect_claim(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prior hon.hq_prospect_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-prospect:' || p_actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO prior FROM hon.hq_prospect_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.operation <> p_operation OR prior.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  RETURN prior.response || jsonb_build_object('replayed', true);
END $$;

-- The current answer per channel and purpose: the latest row for the prospect's current address, or null.
CREATE FUNCTION hon.hq_prospect_consent_now(p hon.hq_prospects, p_channel text, p_purpose text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('status', c.status, 'source', c.source, 'capturedAt', hon.saas_ts(c.captured_at))
  FROM hon.hq_prospect_consents c
  WHERE c.prospect_id = p.id AND c.channel = p_channel AND c.purpose = p_purpose
    AND c.address = CASE p_channel WHEN 'EMAIL' THEN p.email ELSE p.phone_e164 END
  ORDER BY c.captured_at DESC, c.recorded_at DESC, c.id DESC LIMIT 1
$$;

CREATE FUNCTION hon.hq_prospect_json(p hon.hq_prospects) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('prospectId', p.id, 'fullName', p.full_name, 'schoolName', p.school_name, 'email', p.email, 'phone', p.phone_e164,
    'source', p.source, 'campaign', (SELECT jsonb_build_object('campaignId', c.id, 'code', c.code, 'name', c.name)
      FROM hon.hq_marketing_campaigns c WHERE c.id = p.campaign_id),
    'status', p.status,
    'consent', jsonb_build_object(
      'EMAIL', jsonb_build_object('SERVICE', hon.hq_prospect_consent_now(p, 'EMAIL', 'SERVICE'), 'MARKETING', hon.hq_prospect_consent_now(p, 'EMAIL', 'MARKETING')),
      'SMS', jsonb_build_object('SERVICE', hon.hq_prospect_consent_now(p, 'SMS', 'SERVICE'), 'MARKETING', hon.hq_prospect_consent_now(p, 'SMS', 'MARKETING'))),
    'createdBy', CASE WHEN p.created_by IS NOT NULL THEN hon.hq_marketing_person_json(p.created_by) END,
    'createdAt', hon.saas_ts(p.created_at), 'updatedAt', hon.saas_ts(p.updated_at), 'version', p.version)
$$;

-- {fullName, schoolName, email, phone, campaignId}: validated and normalized fields (email lower-cased by the client).
CREATE FUNCTION hon.hq_prospect_fields(p_input jsonb) RETURNS hon.hq_prospects
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE r hon.hq_prospects%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_input->'fullName') IS DISTINCT FROM 'string' OR (p_input->>'fullName') <> btrim(p_input->>'fullName')
    OR length(p_input->>'fullName') NOT BETWEEN 1 AND 120 OR (p_input->>'fullName') ~ '[[:cntrl:]<>]'
    OR (jsonb_typeof(p_input->'schoolName') <> 'null' AND (jsonb_typeof(p_input->'schoolName') IS DISTINCT FROM 'string'
      OR (p_input->>'schoolName') <> btrim(p_input->>'schoolName') OR length(p_input->>'schoolName') NOT BETWEEN 1 AND 160
      OR (p_input->>'schoolName') ~ '[[:cntrl:]<>]'))
    OR (jsonb_typeof(p_input->'email') <> 'null' AND (jsonb_typeof(p_input->'email') IS DISTINCT FROM 'string'
      OR (p_input->>'email') !~ '^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$'))
    OR (jsonb_typeof(p_input->'phone') <> 'null' AND (jsonb_typeof(p_input->'phone') IS DISTINCT FROM 'string'
      OR (p_input->>'phone') !~ '^\+[1-9][0-9]{7,14}$'))
    OR (jsonb_typeof(p_input->'email') = 'null' AND jsonb_typeof(p_input->'phone') = 'null') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  r.full_name := p_input->>'fullName'; r.school_name := p_input->>'schoolName'; r.email := p_input->>'email'; r.phone_e164 := p_input->>'phone';
  r.campaign_id := hon.hq_communication_uuid(p_input, 'campaignId', true);
  IF r.campaign_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hon.hq_marketing_campaigns c WHERE c.id = r.campaign_id) THEN
    RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;
  RETURN r;
END $$;

-- Serializes changes to one address, so two requests can never both take the same email or phone.
CREATE FUNCTION hon.hq_prospect_address_locks(p_email text, p_phone text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF p_email IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('hq-prospect-address:' || p_email, 0)); END IF;
  IF p_phone IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('hq-prospect-address:' || p_phone, 0)); END IF;
END $$;

CREATE FUNCTION hon.hq_prospect_address_taken(p_email text, p_phone text, p_except uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.hq_prospects x WHERE x.id IS DISTINCT FROM p_except
    AND ((p_email IS NOT NULL AND x.email = p_email) OR (p_phone IS NOT NULL AND x.phone_e164 = p_phone)))
$$;

-- ---------- commands (HQ marketing write authority, checked before and after) ----------
-- CREATE: {fullName, schoolName, email, phone, campaignId, source}; source HQ_ENTERED or IMPORT.
CREATE FUNCTION hon.create_hq_prospect(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; f hon.hq_prospects%ROWTYPE; p hon.hq_prospects%ROWTYPE; fp text; at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, true);
  PERFORM hon.hq_communication_keys(p_input, ARRAY['campaignId','email','fullName','phone','schoolName','source']);
  IF jsonb_typeof(p_input->'source') IS DISTINCT FROM 'string' OR (p_input->>'source') NOT IN ('HQ_ENTERED','IMPORT') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  f := hon.hq_prospect_fields(p_input);
  fp := hon.saas_fingerprint(ARRAY['hq.prospect.create', p_input::text]);
  replay := hon.hq_prospect_claim(actor, p_key, 'CREATE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_marketing_actor(p_subject, true); RETURN replay; END IF;
  PERFORM hon.hq_prospect_address_locks(f.email, f.phone_e164);
  IF hon.hq_prospect_address_taken(f.email, f.phone_e164, NULL) THEN RAISE EXCEPTION 'HQ_PROSPECT_EXISTS' USING ERRCODE = '23514'; END IF;
  INSERT INTO hon.hq_prospects (full_name, school_name, email, phone_e164, source, campaign_id, status, created_by, created_at, updated_at)
  VALUES (f.full_name, f.school_name, f.email, f.phone_e164, p_input->>'source', f.campaign_id, 'ACTIVE', actor,
    date_trunc('milliseconds', at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', at) RETURNING * INTO p;
  result := jsonb_build_object('operation', 'CREATE', 'prospect', hon.hq_prospect_json(p));
  INSERT INTO hon.hq_prospect_requests VALUES (actor, p_key, 'CREATE', fp, p.id, result, at);
  PERFORM hon.require_hq_marketing_actor(p_subject, true);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- UPDATE: {expectedVersion, fullName, schoolName, email, phone, campaignId, status}. An archived prospect can only be restored.
CREATE FUNCTION hon.update_hq_prospect(p_subject text, p_prospect uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; f hon.hq_prospects%ROWTYPE; p hon.hq_prospects%ROWTYPE; fp text; v_status text; v_expected integer;
  at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, true);
  IF p_prospect IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.hq_communication_keys(p_input, ARRAY['campaignId','email','expectedVersion','fullName','phone','schoolName','status']);
  v_status := p_input->>'status';
  IF jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR v_status NOT IN ('ACTIVE','ARCHIVED')
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := (p_input->>'expectedVersion')::integer;
  f := hon.hq_prospect_fields(p_input);
  fp := hon.saas_fingerprint(ARRAY['hq.prospect.update', p_prospect::text, p_input::text]);
  replay := hon.hq_prospect_claim(actor, p_key, 'UPDATE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_marketing_actor(p_subject, true); RETURN replay; END IF;
  PERFORM hon.hq_prospect_address_locks(f.email, f.phone_e164);
  SELECT * INTO p FROM hon.hq_prospects WHERE id = p_prospect FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF p.version <> v_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF p.full_name = f.full_name AND p.school_name IS NOT DISTINCT FROM f.school_name AND p.email IS NOT DISTINCT FROM f.email
    AND p.phone_e164 IS NOT DISTINCT FROM f.phone_e164 AND p.campaign_id IS NOT DISTINCT FROM f.campaign_id AND p.status = v_status THEN
    RAISE EXCEPTION 'HQ_PROSPECT_NO_CHANGE' USING ERRCODE = '23514';
  END IF;
  IF p.status = 'ARCHIVED' AND v_status = 'ARCHIVED' THEN RAISE EXCEPTION 'HQ_PROSPECT_ARCHIVED' USING ERRCODE = '23514'; END IF;
  IF hon.hq_prospect_address_taken(f.email, f.phone_e164, p.id) THEN RAISE EXCEPTION 'HQ_PROSPECT_EXISTS' USING ERRCODE = '23514'; END IF;
  UPDATE hon.hq_prospects SET full_name = f.full_name, school_name = f.school_name, email = f.email, phone_e164 = f.phone_e164,
    campaign_id = f.campaign_id, status = v_status, updated_at = at, version = version + 1 WHERE id = p.id RETURNING * INTO p;
  result := jsonb_build_object('operation', 'UPDATE', 'prospect', hon.hq_prospect_json(p));
  INSERT INTO hon.hq_prospect_requests VALUES (actor, p_key, 'UPDATE', fp, p.id, result, at);
  PERFORM hon.require_hq_marketing_actor(p_subject, true);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- CONSENT: {expectedVersion, channel, purpose, status, note}. Recorded by HQ for the prospect's current address, with a note
-- saying how HON learned it. HQ may record any opt-out, and an email SERVICE opt-in; never a marketing or texting opt-in.
CREATE FUNCTION hon.record_hq_prospect_consent(p_subject text, p_prospect uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; p hon.hq_prospects%ROWTYPE; fp text; v_channel text; v_purpose text; v_status text; v_note text; v_address text;
  v_now jsonb; at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, true);
  IF p_prospect IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.hq_communication_keys(p_input, ARRAY['channel','expectedVersion','note','purpose','status']);
  v_channel := p_input->>'channel'; v_purpose := p_input->>'purpose'; v_status := p_input->>'status'; v_note := p_input->>'note';
  IF jsonb_typeof(p_input->'channel') IS DISTINCT FROM 'string' OR v_channel NOT IN ('EMAIL','SMS')
    OR jsonb_typeof(p_input->'purpose') IS DISTINCT FROM 'string' OR v_purpose NOT IN ('SERVICE','MARKETING')
    OR jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR v_status NOT IN ('OPTED_IN','OPTED_OUT')
    OR jsonb_typeof(p_input->'note') IS DISTINCT FROM 'string' OR v_note <> btrim(v_note) OR length(v_note) NOT BETWEEN 3 AND 300
    OR v_note ~ '[[:cntrl:]<>]'
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  fp := hon.saas_fingerprint(ARRAY['hq.prospect.consent', p_prospect::text, p_input::text]);
  replay := hon.hq_prospect_claim(actor, p_key, 'CONSENT', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_marketing_actor(p_subject, true); RETURN replay; END IF;
  SELECT * INTO p FROM hon.hq_prospects WHERE id = p_prospect FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF p.version <> (p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF v_status = 'OPTED_IN' AND NOT (v_channel = 'EMAIL' AND v_purpose = 'SERVICE') THEN
    RAISE EXCEPTION 'HQ_CONSENT_NOT_ALLOWED' USING ERRCODE = '23514';
  END IF;
  IF p.status = 'ARCHIVED' AND v_status = 'OPTED_IN' THEN RAISE EXCEPTION 'HQ_PROSPECT_ARCHIVED' USING ERRCODE = '23514'; END IF;
  v_address := CASE v_channel WHEN 'EMAIL' THEN p.email ELSE p.phone_e164 END;
  IF v_address IS NULL THEN RAISE EXCEPTION 'HQ_PROSPECT_NO_ADDRESS' USING ERRCODE = '23514'; END IF;
  v_now := hon.hq_prospect_consent_now(p, v_channel, v_purpose);
  IF v_now->>'status' = v_status THEN RAISE EXCEPTION 'HQ_CONSENT_NO_CHANGE' USING ERRCODE = '23514'; END IF;
  INSERT INTO hon.hq_prospect_consents (prospect_id, channel, purpose, status, source, address, note, recorded_by, captured_at, recorded_at)
  VALUES (p.id, v_channel, v_purpose, v_status, 'HQ_RECORDED', v_address, v_note, actor, at, at);
  UPDATE hon.hq_prospects SET updated_at = at, version = version + 1 WHERE id = p.id RETURNING * INTO p;
  result := jsonb_build_object('operation', 'CONSENT', 'prospect', hon.hq_prospect_json(p));
  INSERT INTO hon.hq_prospect_requests VALUES (actor, p_key, 'CONSENT', fp, p.id, result, at);
  PERFORM hon.require_hq_marketing_actor(p_subject, true);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- reads (HQ marketing write authority: contact details are shown) ----------
CREATE FUNCTION hon.read_hq_prospects(p_subject text, p_status text, p_campaign uuid, p_cursor_at timestamptz, p_cursor_id uuid, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; v_rows jsonb; n integer; v_last hon.hq_prospects%ROWTYPE; result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, true);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR (p_cursor_at IS NULL) <> (p_cursor_id IS NULL)
    OR (p_status IS NOT NULL AND p_status NOT IN ('ACTIVE','ARCHIVED')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(jsonb_agg(hon.hq_prospect_json(x) ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb), count(*)
  INTO v_rows, n FROM (SELECT * FROM hon.hq_prospects p
    WHERE (p_status IS NULL OR p.status = p_status) AND (p_campaign IS NULL OR p.campaign_id = p_campaign)
      AND (p_cursor_at IS NULL OR (p.created_at, p.id) < (p_cursor_at, p_cursor_id))
    ORDER BY p.created_at DESC, p.id DESC LIMIT p_limit) x;
  IF n = p_limit THEN SELECT * INTO v_last FROM hon.hq_prospects WHERE id = (v_rows->(n - 1)->>'prospectId')::uuid; END IF;
  result := jsonb_build_object('prospects', v_rows, 'limit', p_limit,
    'nextCursor', CASE WHEN n = p_limit THEN jsonb_build_object('createdAt', hon.saas_ts(v_last.created_at), 'prospectId', v_last.id) END,
    'viewer', hon.hq_marketing_person_json(actor), 'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_marketing_actor(p_subject, true);
  RETURN result;
END $$;

CREATE FUNCTION hon.read_hq_prospect(p_subject text, p_prospect uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; p hon.hq_prospects%ROWTYPE; result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, true);
  IF p_prospect IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO p FROM hon.hq_prospects WHERE id = p_prospect;
  IF p.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  result := jsonb_build_object('prospect', hon.hq_prospect_json(p),
    'consentHistory', coalesce((SELECT jsonb_agg(jsonb_build_object('channel', c.channel, 'purpose', c.purpose, 'status', c.status, 'source', c.source,
        'address', c.address, 'current', coalesce(c.address = CASE c.channel WHEN 'EMAIL' THEN p.email ELSE p.phone_e164 END, false),
        'disclosureVersion', c.disclosure_version, 'note', c.note,
        'recordedBy', CASE WHEN c.recorded_by IS NOT NULL THEN hon.hq_marketing_person_json(c.recorded_by) END,
        'capturedAt', hon.saas_ts(c.captured_at)) ORDER BY c.captured_at DESC, c.recorded_at DESC, c.id DESC)
      FROM (SELECT * FROM hon.hq_prospect_consents WHERE prospect_id = p.id ORDER BY captured_at DESC, recorded_at DESC, id DESC LIMIT 100) c), '[]'::jsonb),
    'viewer', hon.hq_marketing_person_json(actor), 'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_marketing_actor(p_subject, true);
  RETURN result;
END $$;

-- ---------- privileges ----------
DO $$ DECLARE r text; t text; f text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker','hon_outbox_worker') LOOP
    FOREACH t IN ARRAY ARRAY['hq_prospects','hq_prospect_consents','hq_prospect_requests'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['guard_hq_prospect()','hq_prospect_claim(uuid,uuid,text,text)','hq_prospect_consent_now(hon.hq_prospects,text,text)',
    'hq_prospect_json(hon.hq_prospects)','hq_prospect_fields(jsonb)','hq_prospect_address_locks(text,text)','hq_prospect_address_taken(text,text,uuid)',
    'create_hq_prospect(text,jsonb,uuid)','update_hq_prospect(text,uuid,jsonb,uuid)','record_hq_prospect_consent(text,uuid,jsonb,uuid)',
    'read_hq_prospects(text,text,uuid,timestamptz,uuid,integer)','read_hq_prospect(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker','hon_outbox_worker') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_hq_prospect(text,jsonb,uuid), hon.update_hq_prospect(text,uuid,jsonb,uuid),
      hon.record_hq_prospect_consent(text,uuid,jsonb,uuid), hon.read_hq_prospects(text,text,uuid,timestamptz,uuid,integer),
      hon.read_hq_prospect(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
