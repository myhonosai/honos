BEGIN;

-- 0704 HQ "Buy a number" (coordinator-allocated 2026-11-28; spec docs/architecture/HQ_TEXTING_NUMBER.md). Owner ask
-- (David, 2026-11-28 01:19Z): a button in HQ that buys HQ's texting number and sets up its Messaging Service.
--   HN1  Only the HQ owner (0281 'OWNER'), as a direct human, starts, finishes or reads number orders. The owner is
--        proved again before each function returns.
--   HN2  An order is started only when HQ has no ACTIVE SMS sender and no other order is BUYING. Starting again for
--        the same number while it is BUYING returns that order (resume); any other number is refused.
--   HN3  The price kept is the API's own fresh Twilio quote. Nothing here calls Twilio: the API buys on HON's parent
--        account, reading before every create, and then records the outcome here.
--   HN4  READY needs the number (PN...) and Messaging Service (MG...) SIDs and makes the HQ SMS sender in the same
--        transaction (A2P NOT_REGISTERED, MMS Converter on). FAILED is recorded only when nothing was bought (no number
--        SID). A lost or partial outcome leaves the order BUYING, and the owner's "Finish setup" re-runs it.
--   HN5  Orders are evidence: never deleted; only a BUYING order changes, once, to READY or FAILED.
--   HN6  Forced RLS, no policies, no table privileges; the runtime gains EXECUTE on three functions only.
-- Nothing here sends, charges or calls an outside service. Live texting stays behind HON_SMS_SEND_APPROVED.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.require_hq_communication_actor(text,text)') IS NULL OR to_regprocedure('hon.hq_communication_sender_json(hon.hq_communication_senders)') IS NULL
    OR to_regprocedure('hon.hq_communication_person_json(uuid)') IS NULL OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL
    OR to_regprocedure('hon.saas_fingerprint(text[])') IS NULL THEN
    RAISE EXCEPTION '0704 requires 0281'; END IF;
END $$;

CREATE TABLE hon.hq_number_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+1[2-9][0-9]{9}$'),
  locality text CHECK (locality = btrim(locality) AND length(locality) BETWEEN 1 AND 80),
  region text CHECK (region ~ '^[A-Z]{2}$'),
  monthly_price_microunits integer NOT NULL CHECK (monthly_price_microunits BETWEEN 0 AND 100000000),
  status text NOT NULL CHECK (status IN ('BUYING','READY','FAILED')),
  number_sid text CHECK (number_sid ~ '^PN[0-9a-f]{32}$'),
  service_sid text CHECK (service_sid ~ '^MG[0-9a-f]{32}$'),
  failure_code text CHECK (failure_code ~ '^[A-Z_]{3,60}$'),
  sender_id uuid REFERENCES hon.hq_communication_senders(id),
  idempotency_key uuid NOT NULL UNIQUE,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  requested_by uuid NOT NULL REFERENCES hon.principals(id),
  requested_at timestamptz NOT NULL,
  finished_by uuid REFERENCES hon.principals(id),
  finished_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (status <> 'BUYING' OR (number_sid IS NULL AND service_sid IS NULL AND failure_code IS NULL AND sender_id IS NULL
    AND finished_by IS NULL AND finished_at IS NULL)),
  CHECK (status <> 'READY' OR (number_sid IS NOT NULL AND service_sid IS NOT NULL AND failure_code IS NULL AND sender_id IS NOT NULL
    AND finished_by IS NOT NULL AND finished_at IS NOT NULL)),
  CHECK (status <> 'FAILED' OR (number_sid IS NULL AND service_sid IS NULL AND failure_code IS NOT NULL AND sender_id IS NULL
    AND finished_by IS NOT NULL AND finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX hq_number_orders_one_buying ON hon.hq_number_orders ((true)) WHERE status = 'BUYING';
CREATE INDEX hq_number_orders_time ON hon.hq_number_orders (requested_at DESC, id DESC);

-- HN5: never deleted or truncated; only BUYING -> READY|FAILED, keeping who asked, what and at what price.
CREATE FUNCTION hon.guard_hq_number_order() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'HQ_NUMBER_ORDER_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF OLD.status <> 'BUYING' OR NEW.status NOT IN ('READY','FAILED') OR NEW.version <> OLD.version + 1
    OR (NEW.id, NEW.phone_e164, NEW.locality, NEW.region, NEW.monthly_price_microunits, NEW.idempotency_key, NEW.fingerprint, NEW.requested_by, NEW.requested_at)
      IS DISTINCT FROM (OLD.id, OLD.phone_e164, OLD.locality, OLD.region, OLD.monthly_price_microunits, OLD.idempotency_key, OLD.fingerprint, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'HQ_NUMBER_ORDER_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_number_orders FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_number_order();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_number_orders FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_number_order();
ALTER TABLE hon.hq_number_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_number_orders FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.hq_number_orders FROM PUBLIC;

CREATE FUNCTION hon.hq_number_order_json(o hon.hq_number_orders) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('orderId', o.id, 'phoneE164', o.phone_e164, 'locality', o.locality, 'region', o.region,
    'monthlyPriceMicrounits', o.monthly_price_microunits, 'status', o.status, 'numberSid', o.number_sid, 'serviceSid', o.service_sid,
    'failureCode', o.failure_code, 'senderId', o.sender_id, 'requestedBy', hon.hq_communication_person_json(o.requested_by),
    'requestedAt', hon.saas_ts(o.requested_at), 'finishedAt', CASE WHEN o.finished_at IS NULL THEN NULL ELSE hon.saas_ts(o.finished_at) END,
    'version', o.version)
$$;

-- START: {phoneE164, locality|null, region|null, monthlyPriceMicrounits}
CREATE FUNCTION hon.start_hq_number_order(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; o hon.hq_number_orders%ROWTYPE; fp text; at timestamptz := clock_timestamp(); result jsonb; v_phone text;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, 'OWNER');
  PERFORM hon.hq_communication_keys(p_input, ARRAY['locality','monthlyPriceMicrounits','phoneE164','region']);
  v_phone := p_input->>'phoneE164';
  IF p_key IS NULL OR jsonb_typeof(p_input->'phoneE164') IS DISTINCT FROM 'string' OR v_phone !~ '^\+1[2-9][0-9]{9}$'
    OR jsonb_typeof(p_input->'monthlyPriceMicrounits') IS DISTINCT FROM 'number'
    OR (p_input->>'monthlyPriceMicrounits') !~ '^[0-9]{1,9}$' OR (p_input->>'monthlyPriceMicrounits')::bigint > 100000000
    OR jsonb_typeof(p_input->'locality') NOT IN ('string','null') OR jsonb_typeof(p_input->'region') NOT IN ('string','null')
    OR (jsonb_typeof(p_input->'locality') = 'string' AND ((p_input->>'locality') <> btrim(p_input->>'locality')
      OR length(p_input->>'locality') NOT BETWEEN 1 AND 80 OR (p_input->>'locality') ~ '[[:cntrl:]<>]'))
    OR (jsonb_typeof(p_input->'region') = 'string' AND (p_input->>'region') !~ '^[A-Z]{2}$') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  fp := hon.saas_fingerprint(ARRAY['hq.number.order.start', p_input::text]);
  PERFORM pg_advisory_xact_lock(hashtextextended('hq-number-order', 0));
  SELECT * INTO o FROM hon.hq_number_orders WHERE idempotency_key = p_key;
  IF FOUND THEN
    IF o.fingerprint <> fp OR o.requested_by <> actor THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    result := jsonb_build_object('order', hon.hq_number_order_json(o), 'replayed', true);
    PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
    RETURN result;
  END IF;
  SELECT * INTO o FROM hon.hq_number_orders WHERE status = 'BUYING';
  IF FOUND THEN
    -- HN2: the same number resumes its open order; anything else waits for it.
    IF o.phone_e164 <> v_phone THEN RAISE EXCEPTION 'HQ_NUMBER_ORDER_OPEN' USING ERRCODE = '23514'; END IF;
    result := jsonb_build_object('order', hon.hq_number_order_json(o), 'replayed', true);
    PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
    RETURN result;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hq-communication-sender:SMS', 0));
  IF EXISTS (SELECT 1 FROM hon.hq_communication_senders WHERE channel = 'SMS' AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'HQ_SENDER_EXISTS' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.hq_number_orders (phone_e164, locality, region, monthly_price_microunits, status, idempotency_key, fingerprint, requested_by, requested_at)
  VALUES (v_phone, p_input->>'locality', p_input->>'region', (p_input->>'monthlyPriceMicrounits')::integer, 'BUYING', p_key, fp, actor, at)
  RETURNING * INTO o;
  result := jsonb_build_object('order', hon.hq_number_order_json(o), 'replayed', false);
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result;
END $$;

-- FINISH: {outcome: READY|FAILED, numberSid, serviceSid, failureCode}. A repeat of the same finish returns the order.
CREATE FUNCTION hon.finish_hq_number_order(p_subject text, p_order uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; o hon.hq_number_orders%ROWTYPE; s hon.hq_communication_senders%ROWTYPE; at timestamptz := clock_timestamp(); result jsonb;
  v_out text; v_number text; v_service text; v_code text;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, 'OWNER');
  PERFORM hon.hq_communication_keys(p_input, ARRAY['failureCode','numberSid','outcome','serviceSid']);
  v_out := p_input->>'outcome'; v_number := p_input->>'numberSid'; v_service := p_input->>'serviceSid'; v_code := p_input->>'failureCode';
  IF p_order IS NULL OR jsonb_typeof(p_input->'outcome') IS DISTINCT FROM 'string' OR v_out NOT IN ('READY','FAILED')
    OR (v_out = 'READY' AND (jsonb_typeof(p_input->'numberSid') IS DISTINCT FROM 'string' OR v_number !~ '^PN[0-9a-f]{32}$'
      OR jsonb_typeof(p_input->'serviceSid') IS DISTINCT FROM 'string' OR v_service !~ '^MG[0-9a-f]{32}$' OR jsonb_typeof(p_input->'failureCode') <> 'null'))
    OR (v_out = 'FAILED' AND (jsonb_typeof(p_input->'failureCode') IS DISTINCT FROM 'string' OR v_code !~ '^[A-Z_]{3,60}$'
      OR jsonb_typeof(p_input->'numberSid') <> 'null' OR jsonb_typeof(p_input->'serviceSid') <> 'null')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hq-number-order', 0));
  SELECT * INTO o FROM hon.hq_number_orders WHERE id = p_order FOR UPDATE;
  IF o.id IS NULL THEN RAISE EXCEPTION 'HQ_NUMBER_ORDER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF o.status <> 'BUYING' THEN
    IF o.status = v_out AND o.number_sid IS NOT DISTINCT FROM v_number AND o.service_sid IS NOT DISTINCT FROM v_service
      AND o.failure_code IS NOT DISTINCT FROM v_code THEN
      result := jsonb_build_object('order', hon.hq_number_order_json(o), 'replayed', true);
      PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
      RETURN result;
    END IF;
    RAISE EXCEPTION 'HQ_NUMBER_ORDER_FINISHED' USING ERRCODE = '23514';
  END IF;
  IF v_out = 'READY' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hq-communication-sender:SMS', 0));
    IF EXISTS (SELECT 1 FROM hon.hq_communication_senders WHERE channel = 'SMS' AND status = 'ACTIVE') THEN
      RAISE EXCEPTION 'HQ_SENDER_EXISTS' USING ERRCODE = '23514';
    END IF;
    INSERT INTO hon.hq_communication_senders (channel, status, sms_service_sid, sms_reply_number, a2p_state, mms_converter_confirmed, created_by, created_at)
    VALUES ('SMS', 'ACTIVE', v_service, o.phone_e164, 'NOT_REGISTERED', true, actor, at) RETURNING * INTO s;
    UPDATE hon.hq_number_orders SET status = 'READY', number_sid = v_number, service_sid = v_service, sender_id = s.id,
      finished_by = actor, finished_at = at, version = version + 1 WHERE id = o.id RETURNING * INTO o;
  ELSE
    UPDATE hon.hq_number_orders SET status = 'FAILED', failure_code = v_code, finished_by = actor, finished_at = at, version = version + 1
    WHERE id = o.id RETURNING * INTO o;
  END IF;
  result := jsonb_build_object('order', hon.hq_number_order_json(o), 'replayed', false,
    'sender', CASE WHEN s.id IS NULL THEN NULL ELSE hon.hq_communication_sender_json(s) END);
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result;
END $$;

CREATE FUNCTION hon.read_hq_number_orders(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; v_rows jsonb; result jsonb;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, 'OWNER');
  SELECT coalesce(jsonb_agg(hon.hq_number_order_json(x) ORDER BY x.requested_at DESC, x.id DESC), '[]'::jsonb) INTO v_rows
  FROM (SELECT * FROM hon.hq_number_orders ORDER BY requested_at DESC, id DESC LIMIT 10) x;
  result := jsonb_build_object('orders', v_rows,
    'hasActiveSmsSender', EXISTS (SELECT 1 FROM hon.hq_communication_senders WHERE channel = 'SMS' AND status = 'ACTIVE'),
    'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result;
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.hq_number_orders FROM %I', r);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_hq_number_order()','hon.hq_number_order_json(hon.hq_number_orders)','hon.start_hq_number_order(text,jsonb,uuid)',
    'hon.finish_hq_number_order(text,uuid,jsonb)','hon.read_hq_number_orders(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.start_hq_number_order(text,jsonb,uuid), hon.finish_hq_number_order(text,uuid,jsonb),
      hon.read_hq_number_orders(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
