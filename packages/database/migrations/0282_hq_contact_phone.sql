BEGIN;

-- 0282 Texts from HON HQ: a person's own phone and their consent (HQ-COMM PR C, docs/architecture/HQ_COMMUNICATIONS.md).
-- A signed-in person adds their own mobile number and gets a six-digit code on screen. They confirm the number by texting
-- that code from the phone to the HQ number, which is also their own request to get HQ texts (mobile-originated opt-in):
-- HON never sends a code. STOP from that phone turns HQ texts off, START turns them back on, HELP gets the fixed reply; the
-- person can also switch HQ texts off or remove the number on screen. Only the person sees their number; HQ reads never
-- carry it. The 0243 communication worker records inbound texts through one fixed function. hq_contact_sms_address (0281)
-- now returns the confirmed number, so the 0281 claim can send an HQ text only to a confirmed number whose owner opted in.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ contact phones require a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.claim_hq_message_deliveries(text[],integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'Apply HQ communications migration 0281 first';
  END IF;
END $$;

-- One number per person. PENDING holds a salted hash of the on-screen code (never the code), its expiry and wrong tries.
-- A number can be CONFIRMED for one person only. REMOVED keeps the row (and its version) with no number.
CREATE TABLE hon.hq_contact_phones (
  user_id uuid PRIMARY KEY REFERENCES hon.users(id),
  status text NOT NULL CHECK (status IN ('PENDING','CONFIRMED','REMOVED')),
  phone_e164 text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  code_salt bytea, code_hash bytea, code_expires_at timestamptz,
  wrong_codes integer NOT NULL DEFAULT 0 CHECK (wrong_codes BETWEEN 0 AND 5),
  codes_issued_on date, codes_issued integer NOT NULL DEFAULT 0 CHECK (codes_issued BETWEEN 0 AND 5),
  confirmed_at timestamptz, confirmed_event text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((status = 'REMOVED') = (phone_e164 IS NULL)),
  CHECK ((status = 'PENDING') = (code_hash IS NOT NULL AND code_salt IS NOT NULL AND code_expires_at IS NOT NULL)),
  CHECK ((status = 'CONFIRMED') = (confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX hq_contact_phones_confirmed ON hon.hq_contact_phones (phone_e164) WHERE status = 'CONFIRMED';
CREATE INDEX hq_contact_phones_pending ON hon.hq_contact_phones (phone_e164) WHERE status = 'PENDING';

-- Every inbound text the worker reported, once per provider event: what it was and what it changed. No body is kept.
CREATE TABLE hon.hq_inbound_texts (
  provider text NOT NULL CHECK (provider IN ('FAKE','TWILIO')),
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  keyword text NOT NULL CHECK (keyword IN ('STOP','START','HELP','CODE','OTHER')),
  outcome text NOT NULL CHECK (outcome IN ('OPTED_OUT','OPTED_IN','HELP','CONFIRMED','CODE_WRONG','PHONE_IN_USE','NO_MATCH','NOT_HQ','IGNORED')),
  user_id uuid REFERENCES hon.users(id),
  received_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL,
  PRIMARY KEY (provider, provider_event_id)
);

CREATE TABLE hon.hq_contact_requests (
  user_id uuid NOT NULL REFERENCES hon.users(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('PHONE_START','TEXTING','PHONE_REMOVE')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE FUNCTION hon.guard_hq_contact_phone() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND NEW.user_id = OLD.user_id AND NEW.created_at = OLD.created_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'HQ_COMMUNICATION_RECORD_IMMUTABLE' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_contact_phones FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_contact_phone();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_inbound_texts FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_contact_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_evidence();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_contact_phones','hq_inbound_texts','hq_contact_requests'] LOOP
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_communication_evidence()', t);
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
  END LOOP;
END $$;

-- ---------- helpers ----------
-- The signed-in person: an active user with an active human principal. Their own settings need nothing else.
CREATE FUNCTION hon.require_hq_contact_self(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE v_user uuid;
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT u.id INTO v_user FROM hon.users u WHERE u.external_subject = p_subject
    AND EXISTS (SELECT 1 FROM hon.principals p WHERE p.user_id = u.id AND p.is_active AND p.principal_type = 'HUMAN_USER');
  IF v_user IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN v_user;
END $$;

CREATE FUNCTION hon.hq_contact_claim(p_user uuid, p_key uuid, p_operation text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prior hon.hq_contact_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-contact:' || p_user::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO prior FROM hon.hq_contact_requests WHERE user_id = p_user AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.operation <> p_operation OR prior.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  RETURN prior.response || jsonb_build_object('replayed', true);
END $$;

-- The row for the person, locked; created REMOVED (no number) the first time.
CREATE FUNCTION hon.hq_contact_phone_lock(p_user uuid) RETURNS hon.hq_contact_phones
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE r hon.hq_contact_phones%ROWTYPE;
BEGIN
  INSERT INTO hon.hq_contact_phones (user_id, status, created_at, updated_at) VALUES (p_user, 'REMOVED', clock_timestamp(), clock_timestamp())
  ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO r FROM hon.hq_contact_phones WHERE user_id = p_user FOR UPDATE;
  RETURN r;
END $$;

CREATE FUNCTION hon.hq_contact_texting_on(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.hq_contact_phones ph JOIN hon.hq_contact_preferences c ON c.user_id = ph.user_id AND c.channel = 'SMS'
    WHERE ph.user_id = p_user AND ph.status = 'CONFIRMED' AND c.status = 'OPTED_IN')
$$;

-- Only the person themselves ever gets their number back.
CREATE FUNCTION hon.hq_contact_json(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object(
    'status', coalesce(ph.status, 'REMOVED'), 'phone', ph.phone_e164,
    'codeExpiresAt', CASE WHEN ph.status = 'PENDING' THEN hon.saas_ts(ph.code_expires_at) END,
    'codeExpired', coalesce(ph.status = 'PENDING' AND ph.code_expires_at <= clock_timestamp(), false),
    'wrongCodes', coalesce(ph.wrong_codes, 0), 'codesLeftToday',
      5 - CASE WHEN ph.codes_issued_on = (clock_timestamp() AT TIME ZONE 'UTC')::date THEN ph.codes_issued ELSE 0 END,
    'confirmedAt', CASE WHEN ph.status = 'CONFIRMED' THEN hon.saas_ts(ph.confirmed_at) END,
    'textingOn', hon.hq_contact_texting_on(p_user),
    'stoppedByReply', coalesce(ph.status = 'CONFIRMED' AND EXISTS (SELECT 1 FROM hon.hq_contact_preferences c WHERE c.user_id = p_user AND c.channel = 'SMS'
      AND c.status = 'OPTED_OUT' AND c.source = 'RECIPIENT'), false),
    'version', coalesce(ph.version, 0),
    'hqNumber', (SELECT jsonb_build_object('ready', true, 'a2pState', s.a2p_state, 'number', s.sms_reply_number) FROM hon.hq_communication_senders s WHERE s.channel = 'SMS' AND s.status = 'ACTIVE'))
  FROM (SELECT p_user AS id) x LEFT JOIN hon.hq_contact_phones ph ON ph.user_id = x.id
$$;

CREATE FUNCTION hon.hq_contact_set_preference(p_user uuid, p_status text, p_source text, p_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  INSERT INTO hon.hq_contact_preferences (user_id, channel, status, source, captured_at) VALUES (p_user, 'SMS', p_status, p_source, p_at)
  ON CONFLICT (user_id, channel) DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source, captured_at = EXCLUDED.captured_at,
    version = hon.hq_contact_preferences.version + 1
  -- An older event (a retried webhook) never overwrites a newer choice.
  WHERE hon.hq_contact_preferences.status <> EXCLUDED.status AND EXCLUDED.captured_at >= hon.hq_contact_preferences.captured_at;
END $$;

-- 0281's address seam: the confirmed number only. The 0281 claim still requires the person's own SMS opt-in.
CREATE OR REPLACE FUNCTION hon.hq_contact_sms_address(p_user uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT ph.phone_e164 FROM hon.hq_contact_phones ph WHERE ph.user_id = p_user AND ph.status = 'CONFIRMED'
$$;

-- ---------- the person's own commands ----------
CREATE FUNCTION hon.read_my_hq_contact(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_user uuid; result jsonb;
BEGIN
  v_user := hon.require_hq_contact_self(p_subject);
  result := jsonb_build_object('contact', hon.hq_contact_json(v_user), 'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_contact_self(p_subject);
  RETURN result;
END $$;

-- {phone, expectedVersion}: starts (or restarts) confirming a number and returns the code once. A replay never returns
-- the code again (`code` null): start again for a new one. Up to 5 codes a day; each lasts 15 minutes.
CREATE FUNCTION hon.start_my_hq_phone(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_user uuid; replay jsonb; fp text; r hon.hq_contact_phones%ROWTYPE; v_phone text; v_expected integer; v_code text; v_salt bytea;
  at timestamptz := clock_timestamp(); v_day date := (clock_timestamp() AT TIME ZONE 'UTC')::date; v_issued integer; result jsonb;
BEGIN
  v_user := hon.require_hq_contact_self(p_subject);
  PERFORM hon.hq_communication_keys(p_input, ARRAY['phone','expectedVersion']);
  v_phone := p_input->>'phone';
  IF jsonb_typeof(p_input->'phone') IS DISTINCT FROM 'string' OR v_phone !~ '^\+[1-9][0-9]{7,14}$'
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := (p_input->>'expectedVersion')::integer;
  fp := hon.saas_fingerprint(ARRAY['hq.contact.phone.start', p_input::text]);
  replay := hon.hq_contact_claim(v_user, p_key, 'PHONE_START', fp);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.hq_communication_senders s WHERE s.channel = 'SMS' AND s.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'HQ_TEXTING_UNAVAILABLE' USING ERRCODE = '23514';
  END IF;
  r := hon.hq_contact_phone_lock(v_user);
  IF (CASE WHEN r.version = 1 AND r.status = 'REMOVED' AND r.codes_issued_on IS NULL THEN 0 ELSE r.version END) <> v_expected THEN
    RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF r.status = 'CONFIRMED' AND r.phone_e164 = v_phone THEN RAISE EXCEPTION 'HQ_PHONE_ALREADY_CONFIRMED' USING ERRCODE = '23514'; END IF;
  -- Whether this number is confirmed to someone else is never told here (that would let anyone look numbers up); a code
  -- texted from a number that is already someone else's confirms nothing (PHONE_IN_USE at the inbound text).
  v_issued := CASE WHEN r.codes_issued_on = v_day THEN r.codes_issued ELSE 0 END;
  IF v_issued >= 5 THEN RAISE EXCEPTION 'HQ_PHONE_CODE_LIMIT' USING ERRCODE = '23514'; END IF;
  -- Built-in randomness only (gen_random_uuid is cryptographically random), so no extension schema is needed.
  v_code := lpad(((('x' || left(replace(gen_random_uuid()::text, '-', ''), 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
  v_salt := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  -- A different (or first) number replaces whatever was there; a confirmed number stays off until the new one is confirmed.
  IF r.status = 'CONFIRMED' THEN PERFORM hon.hq_contact_set_preference(v_user, 'OPTED_OUT', 'USER', at); END IF;
  UPDATE hon.hq_contact_phones SET status = 'PENDING', phone_e164 = v_phone, code_salt = v_salt,
    code_hash = sha256(v_salt || convert_to(v_code, 'UTF8')), code_expires_at = at + interval '15 minutes', wrong_codes = 0,
    codes_issued_on = v_day, codes_issued = v_issued + 1, confirmed_at = NULL, confirmed_event = NULL, updated_at = at, version = version + 1
  WHERE user_id = v_user;
  result := jsonb_build_object('operation', 'PHONE_START', 'contact', hon.hq_contact_json(v_user));
  INSERT INTO hon.hq_contact_requests VALUES (v_user, p_key, 'PHONE_START', fp, result || jsonb_build_object('code', NULL), at);
  PERFORM hon.require_hq_contact_self(p_subject);
  RETURN result || jsonb_build_object('code', v_code, 'replayed', false);
END $$;

-- {enabled, expectedVersion}: the person's own HQ texts switch. Turning it on needs a confirmed number.
CREATE FUNCTION hon.set_my_hq_texting(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_user uuid; replay jsonb; fp text; r hon.hq_contact_phones%ROWTYPE; v_on boolean; at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  v_user := hon.require_hq_contact_self(p_subject);
  PERFORM hon.hq_communication_keys(p_input, ARRAY['enabled','expectedVersion']);
  IF jsonb_typeof(p_input->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number'
    OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_on := (p_input->>'enabled')::boolean;
  fp := hon.saas_fingerprint(ARRAY['hq.contact.texting', p_input::text]);
  replay := hon.hq_contact_claim(v_user, p_key, 'TEXTING', fp);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  r := hon.hq_contact_phone_lock(v_user);
  IF r.version <> (p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF r.status <> 'CONFIRMED' THEN RAISE EXCEPTION 'HQ_PHONE_NOT_CONFIRMED' USING ERRCODE = '23514'; END IF;
  IF hon.hq_contact_texting_on(v_user) = v_on THEN RAISE EXCEPTION 'HQ_TEXTING_NO_CHANGE' USING ERRCODE = '23514'; END IF;
  -- STOP from the handset is also held by the carrier and Twilio; only START from that phone undoes it.
  IF v_on AND EXISTS (SELECT 1 FROM hon.hq_contact_preferences c WHERE c.user_id = v_user AND c.channel = 'SMS' AND c.status = 'OPTED_OUT'
      AND c.source = 'RECIPIENT') THEN
    RAISE EXCEPTION 'HQ_TEXTING_STOPPED_BY_REPLY' USING ERRCODE = '23514';
  END IF;
  PERFORM hon.hq_contact_set_preference(v_user, CASE WHEN v_on THEN 'OPTED_IN' ELSE 'OPTED_OUT' END, 'USER', at);
  UPDATE hon.hq_contact_phones SET updated_at = at, version = version + 1 WHERE user_id = v_user;
  result := jsonb_build_object('operation', 'TEXTING', 'contact', hon.hq_contact_json(v_user));
  INSERT INTO hon.hq_contact_requests VALUES (v_user, p_key, 'TEXTING', fp, result, at);
  PERFORM hon.require_hq_contact_self(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- {expectedVersion}: removes the number (pending or confirmed) and turns HQ texts off.
CREATE FUNCTION hon.remove_my_hq_phone(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_user uuid; replay jsonb; fp text; r hon.hq_contact_phones%ROWTYPE; at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  v_user := hon.require_hq_contact_self(p_subject);
  PERFORM hon.hq_communication_expected(p_input);
  fp := hon.saas_fingerprint(ARRAY['hq.contact.phone.remove', p_input::text]);
  replay := hon.hq_contact_claim(v_user, p_key, 'PHONE_REMOVE', fp);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  r := hon.hq_contact_phone_lock(v_user);
  IF r.version <> (p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF r.status = 'REMOVED' THEN RAISE EXCEPTION 'HQ_PHONE_NONE' USING ERRCODE = '23514'; END IF;
  IF r.status = 'CONFIRMED' THEN PERFORM hon.hq_contact_set_preference(v_user, 'OPTED_OUT', 'USER', at); END IF;
  UPDATE hon.hq_contact_phones SET status = 'REMOVED', phone_e164 = NULL, code_salt = NULL, code_hash = NULL, code_expires_at = NULL, wrong_codes = 0,
    confirmed_at = NULL, confirmed_event = NULL, updated_at = at, version = version + 1 WHERE user_id = v_user;
  result := jsonb_build_object('operation', 'PHONE_REMOVE', 'contact', hon.hq_contact_json(v_user));
  INSERT INTO hon.hq_contact_requests VALUES (v_user, p_key, 'PHONE_REMOVE', fp, result, at);
  PERFORM hon.require_hq_contact_self(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- worker: an inbound text to the HQ number ----------
CREATE FUNCTION hon.hq_inbound_reply(p_outcome text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_outcome WHEN 'OPTED_OUT' THEN 'STOPPED' WHEN 'OPTED_IN' THEN 'STARTED' WHEN 'HELP' THEN 'HELP' WHEN 'CONFIRMED' THEN 'CONFIRMED'
    WHEN 'CODE_WRONG' THEN 'CODE_WRONG' WHEN 'PHONE_IN_USE' THEN 'CODE_WRONG' ELSE NULL END
$$;

-- Records one inbound text once per provider event and says what to reply: STOP/START/HELP keywords for a confirmed
-- number, or a confirmation code from a pending number. Texts to any number other than the active HQ Messaging Service
-- are NOT_HQ (the school path handles them). The body is never stored. `reply` is the fixed reply kind for the webhook.
CREATE FUNCTION hon.record_hq_inbound_text(p_provider text, p_event_id text, p_from text, p_to_service text, p_body text, p_received_at timestamptz)
RETURNS TABLE (outcome text, reply text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE prior hon.hq_inbound_texts%ROWTYPE; v_word text; v_kind text; v_out text; v_user uuid; r hon.hq_contact_phones%ROWTYPE; v_match hon.hq_contact_phones%ROWTYPE;
  v_tried integer := 0; at timestamptz := clock_timestamp(); v_when timestamptz;
BEGIN
  IF p_provider NOT IN ('FAKE','TWILIO') OR p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 200 OR p_received_at IS NULL
    OR p_body IS NULL OR length(p_body) > 1600 OR p_from IS NULL OR p_to_service IS NULL THEN
    RAISE EXCEPTION 'HQ inbound text is not valid.' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hq-inbound:' || p_provider || ':' || p_event_id, 0));
  -- When the person sent it (never later than now): a code sent in time still counts if the webhook is late, and an
  -- older STOP/START never overwrites a newer choice.
  v_when := least(p_received_at, at);
  SELECT * INTO prior FROM hon.hq_inbound_texts WHERE provider = p_provider AND provider_event_id = p_event_id;
  IF FOUND THEN
    outcome := prior.outcome; replayed := true; reply := hon.hq_inbound_reply(prior.outcome);
    RETURN NEXT; RETURN;
  END IF;
  v_word := upper(regexp_replace(btrim(p_body), '\s+', ' ', 'g'));
  v_kind := CASE WHEN v_word IN ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','OPTOUT','REVOKE') THEN 'STOP'
    WHEN v_word IN ('START','YES','UNSTOP','OPTIN') THEN 'START' WHEN v_word IN ('HELP','INFO') THEN 'HELP'
    WHEN v_word ~ '^(HON )?[0-9]{6}$' THEN 'CODE' ELSE 'OTHER' END;
  IF NOT EXISTS (SELECT 1 FROM hon.hq_communication_senders s WHERE s.channel = 'SMS' AND s.status = 'ACTIVE' AND s.sms_service_sid = p_to_service) THEN
    v_out := 'NOT_HQ';
  ELSIF v_kind = 'HELP' THEN
    v_out := 'HELP';
  ELSE
    -- One inbound text per phone at a time, so two codes for the same number can never both confirm.
    PERFORM pg_advisory_xact_lock(hashtextextended('hq-contact-phone:' || p_from, 0));
  END IF;
  IF v_out IS NOT NULL THEN
    NULL;
  ELSIF v_kind IN ('STOP','START') THEN
    SELECT ph.user_id INTO v_user FROM hon.hq_contact_phones ph WHERE ph.phone_e164 = p_from AND ph.status = 'CONFIRMED' FOR UPDATE;
    IF v_user IS NULL THEN v_out := 'NO_MATCH';
    ELSIF EXISTS (SELECT 1 FROM hon.hq_contact_preferences c WHERE c.user_id = v_user AND c.channel = 'SMS' AND c.captured_at > v_when) THEN
      v_out := 'IGNORED';  -- sent before the person's latest choice (a late or retried webhook): it changes nothing
    ELSE
      PERFORM hon.hq_contact_set_preference(v_user, CASE WHEN v_kind = 'STOP' THEN 'OPTED_OUT' ELSE 'OPTED_IN' END, 'RECIPIENT', v_when);
      UPDATE hon.hq_contact_phones SET updated_at = at, version = version + 1 WHERE user_id = v_user;
      v_out := CASE WHEN v_kind = 'STOP' THEN 'OPTED_OUT' ELSE 'OPTED_IN' END;
    END IF;
  ELSIF v_kind = 'CODE' THEN
    -- Every unexpired pending row for this number is tried, so someone else adding the same number cannot block the
    -- person who holds the phone. One try is counted per text, on each row it was tried against.
    FOR r IN SELECT * FROM hon.hq_contact_phones ph WHERE ph.phone_e164 = p_from AND ph.status = 'PENDING' AND ph.code_expires_at > v_when
        AND ph.wrong_codes < 5 ORDER BY ph.user_id FOR UPDATE LOOP
      v_tried := v_tried + 1;
      IF r.code_hash = sha256(r.code_salt || convert_to(right(v_word, 6), 'UTF8')) THEN v_match := r; EXIT; END IF;
    END LOOP;
    IF v_tried = 0 THEN v_out := 'NO_MATCH';
    ELSIF v_match.user_id IS NULL THEN
      UPDATE hon.hq_contact_phones SET wrong_codes = wrong_codes + 1, updated_at = at, version = version + 1
      WHERE phone_e164 = p_from AND status = 'PENDING' AND code_expires_at > v_when AND wrong_codes < 5;
      v_out := 'CODE_WRONG'; v_user := CASE WHEN v_tried = 1 THEN r.user_id END;
    ELSIF EXISTS (SELECT 1 FROM hon.hq_contact_phones x WHERE x.phone_e164 = p_from AND x.status = 'CONFIRMED' AND x.user_id <> v_match.user_id) THEN
      v_out := 'PHONE_IN_USE'; v_user := v_match.user_id;
    ELSE
      UPDATE hon.hq_contact_phones SET status = 'CONFIRMED', code_salt = NULL, code_hash = NULL, code_expires_at = NULL, wrong_codes = 0,
        confirmed_at = at, confirmed_event = p_provider || ':' || p_event_id, updated_at = at, version = version + 1 WHERE user_id = v_match.user_id;
      -- Texting the code is the person's own request for HQ texts.
      PERFORM hon.hq_contact_set_preference(v_match.user_id, 'OPTED_IN', 'RECIPIENT', v_when);
      v_out := 'CONFIRMED'; v_user := v_match.user_id;
    END IF;
  ELSE
    v_out := 'IGNORED';
  END IF;
  INSERT INTO hon.hq_inbound_texts VALUES (p_provider, p_event_id, v_kind, v_out, v_user, p_received_at, at);
  outcome := v_out; replayed := false; reply := hon.hq_inbound_reply(v_out);
  RETURN NEXT;
END $$;

-- ---------- privileges ----------
DO $$ DECLARE r text; t text; f text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker','hon_outbox_worker') LOOP
    FOREACH t IN ARRAY ARRAY['hq_contact_phones','hq_inbound_texts','hq_contact_requests'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['guard_hq_contact_phone()','require_hq_contact_self(text)','hq_contact_claim(uuid,uuid,text,text)',
    'hq_contact_phone_lock(uuid)','hq_contact_texting_on(uuid)','hq_contact_json(uuid)','hq_contact_set_preference(uuid,text,text,timestamptz)',
    'hq_contact_sms_address(uuid)','read_my_hq_contact(text)','start_my_hq_phone(text,jsonb,uuid)','set_my_hq_texting(text,jsonb,uuid)',
    'remove_my_hq_phone(text,jsonb,uuid)','hq_inbound_reply(text)','record_hq_inbound_text(text,text,text,text,text,timestamptz)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker','hon_outbox_worker') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_my_hq_contact(text), hon.start_my_hq_phone(text,jsonb,uuid), hon.set_my_hq_texting(text,jsonb,uuid),
      hon.remove_my_hq_phone(text,jsonb,uuid) TO hon_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.record_hq_inbound_text(text,text,text,text,text,timestamptz) TO hon_communication_worker;
  END IF;
END $$;

COMMIT;
