BEGIN;
-- 0249 missed-call text-back (docs/architecture/COMMUNICATION_DELIVERY.md §5b). A call to a school's ACTIVE
-- number is forwarded to the school's own phone; when nobody answers, HON records the missed call for staff
-- follow-up and, if the HQ owner switched it on, sends the caller one short reply with opt-out wording.
-- At most one reply per caller per school per 24 hours, never to a number the school holds as opted out.

ALTER TABLE hon.school_text_senders
  ADD COLUMN forward_phone_e164 text CHECK (forward_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  ADD COLUMN missed_call_text_back boolean NOT NULL DEFAULT false;

CREATE TABLE hon.missed_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  provider_call_id text NOT NULL UNIQUE CHECK (provider_call_id ~ '^CA[0-9a-f]{32}$'),
  caller_e164 text NOT NULL CHECK (caller_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  dial_status text NOT NULL CHECK (dial_status IN ('no-answer', 'busy', 'failed', 'canceled', 'no-forward')),
  text_back_status text NOT NULL CHECK (text_back_status IN (
    'OFF', 'OPTED_OUT', 'RECENTLY_SENT', 'PENDING', 'SENDING', 'ACCEPTED', 'FAILED', 'UNKNOWN')),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_message_id text CHECK (provider_message_id ~ '^(?:SM|MM)[0-9a-f]{32}$|^fake-[0-9a-f-]{36}-[0-9]$'),
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  CHECK ((text_back_status = 'SENDING') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX missed_calls_scope_idx ON hon.missed_calls (organization_id, school_id, received_at DESC, id);
CREATE INDEX missed_calls_due_idx ON hon.missed_calls (text_back_status, next_attempt_at) WHERE text_back_status IN ('PENDING', 'SENDING');
CREATE INDEX missed_calls_caller_idx ON hon.missed_calls (school_id, caller_e164, received_at DESC);
ALTER TABLE hon.missed_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.missed_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY missed_calls_tenant_isolation ON hon.missed_calls
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

-- HQ owner sets the forwarding phone and the text-back switch on an existing sender.
CREATE FUNCTION hon.set_school_missed_call_settings_from_hq(
  p_subject text, p_school uuid, p_forward_phone_e164 text, p_text_back boolean, p_expected_version integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; prior hon.school_text_senders; next hon.school_text_senders; req uuid := gen_random_uuid();
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_school IS NULL OR p_text_back IS NULL OR p_expected_version IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO prior FROM hon.school_text_senders WHERE school_id = p_school FOR UPDATE;
  IF prior.id IS NULL THEN RAISE EXCEPTION 'HQ_TEXT_SENDER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF prior.version <> p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF p_forward_phone_e164 IS NOT NULL AND p_forward_phone_e164 = prior.phone_e164 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  UPDATE hon.school_text_senders SET forward_phone_e164 = p_forward_phone_e164, missed_call_text_back = p_text_back,
    set_by_principal_id = actor, version = version + 1, updated_at = now()
  WHERE id = prior.id RETURNING * INTO next;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (next.organization_id, next.school_id, actor, 'HON_HQ', 'communication.missed_call_settings.set', 'SCHOOL_TEXT_SENDER', next.id,
    jsonb_build_object('forwardSet', prior.forward_phone_e164 IS NOT NULL, 'textBack', prior.missed_call_text_back, 'version', prior.version),
    jsonb_build_object('forwardSet', next.forward_phone_e164 IS NOT NULL, 'textBack', next.missed_call_text_back, 'version', next.version),
    'SUCCEEDED', req, req, now());
  RETURN jsonb_build_object('schoolId', next.school_id, 'forwardSet', next.forward_phone_e164 IS NOT NULL,
    'missedCallTextBack', next.missed_call_text_back, 'version', next.version);
END $$;

-- Voice routing for one incoming call: the forwarding phone of the ACTIVE sender on the called number, or nothing.
CREATE FUNCTION hon.read_missed_call_route(p_to_e164 text)
RETURNS TABLE (routed boolean, forward_phone_e164 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT true, sender.forward_phone_e164 FROM hon.school_text_senders sender
  WHERE sender.phone_e164 = p_to_e164 AND sender.status = 'ACTIVE'
  UNION ALL SELECT false, NULL WHERE NOT EXISTS (
    SELECT 1 FROM hon.school_text_senders sender WHERE sender.phone_e164 = p_to_e164 AND sender.status = 'ACTIVE')
$$;

CREATE FUNCTION hon.record_missed_call(
  p_to_e164 text, p_from_e164 text, p_call_id text, p_dial_status text, p_received_at timestamptz
) RETURNS TABLE (outcome text, text_back_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE v_sender hon.school_text_senders; v_status text; v_row hon.missed_calls; v_req uuid := gen_random_uuid();
BEGIN
  IF p_dial_status NOT IN ('no-answer', 'busy', 'failed', 'canceled', 'no-forward') OR p_to_e164 !~ '^\+[1-9][0-9]{7,14}$'
     OR p_from_e164 !~ '^\+[1-9][0-9]{7,14}$' OR p_received_at IS NULL OR p_received_at > now() + interval '10 minutes'
     OR p_received_at < now() - interval '1 day' THEN
    RAISE EXCEPTION 'HON missed call is invalid.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM hon.missed_calls m WHERE m.provider_call_id = p_call_id;
  IF v_row.id IS NOT NULL THEN outcome := 'REPLAYED'; text_back_status := v_row.text_back_status; RETURN NEXT; RETURN; END IF;
  SELECT * INTO v_sender FROM hon.school_text_senders sender WHERE sender.phone_e164 = p_to_e164 AND sender.status = 'ACTIVE' FOR SHARE;
  IF v_sender.id IS NULL THEN outcome := 'UNROUTED'; text_back_status := NULL; RETURN NEXT; RETURN; END IF;
  -- One reply per caller per school per day; serialize concurrent calls from the same caller.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.missed_call:' || v_sender.school_id::text || ':' || p_from_e164, 0));
  v_status := CASE
    WHEN NOT v_sender.missed_call_text_back THEN 'OFF'
    WHEN EXISTS (SELECT 1 FROM hon.people p JOIN hon.communication_consents c ON c.person_id = p.id AND c.channel = 'SMS' AND c.status = 'OPTED_OUT'
      WHERE p.school_id = v_sender.school_id AND p.organization_id = v_sender.organization_id AND p.phone_e164 = p_from_e164) THEN 'OPTED_OUT'
    WHEN EXISTS (SELECT 1 FROM hon.missed_calls m WHERE m.school_id = v_sender.school_id AND m.caller_e164 = p_from_e164
      AND m.received_at > p_received_at - interval '24 hours' AND m.text_back_status IN ('PENDING', 'SENDING', 'ACCEPTED', 'UNKNOWN')) THEN 'RECENTLY_SENT'
    ELSE 'PENDING' END;
  INSERT INTO hon.missed_calls (organization_id, school_id, provider_call_id, caller_e164, dial_status, text_back_status, received_at)
  VALUES (v_sender.organization_id, v_sender.school_id, p_call_id, p_from_e164, p_dial_status, v_status, p_received_at)
  ON CONFLICT (provider_call_id) DO NOTHING RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN
    SELECT 'REPLAYED', m.text_back_status INTO outcome, text_back_status FROM hon.missed_calls m WHERE m.provider_call_id = p_call_id;
    RETURN NEXT; RETURN;
  END IF;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (v_row.organization_id, v_row.school_id, '00000000-0000-4000-8000-00000000c043', 'INTEGRATION', 'communication.missed_call.recorded',
    'MISSED_CALL', v_row.id, NULL, jsonb_build_object('dialStatus', v_row.dial_status, 'textBack', v_row.text_back_status), 'SUCCEEDED', v_req, v_req, now());
  INSERT INTO hon.outbox_events (id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
    aggregate_version, correlation_id, causation_id, payload)
  VALUES (gen_random_uuid(), v_row.organization_id, v_row.school_id, 'communication.missed_call.recorded', 1, 'MISSED_CALL', v_row.id, 1,
    v_req, v_req, jsonb_build_object('missedCallId', v_row.id, 'textBack', v_row.text_back_status));
  outcome := 'RECORDED'; text_back_status := v_row.text_back_status;
  RETURN NEXT;
END $$;

-- Leases due text-backs. Quiet hours (21:00-08:00 school time) wait for 08:00; a disabled sender or switch ends as OFF.
CREATE FUNCTION hon.claim_missed_call_text_backs(p_limit integer, p_lease_seconds integer DEFAULT 60)
RETURNS TABLE (missed_call_id uuid, lease_token uuid, organization_id uuid, school_id uuid, caller_e164 text, school_name text, language text,
  sender_service_id text, attempt integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE v_row hon.missed_calls; v_ctx record; v_local timestamp; v_token uuid;
BEGIN
  IF p_limit < 1 OR p_limit > 100 OR p_lease_seconds < 15 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'HON missed-call claim bounds are invalid.' USING ERRCODE = '22023';
  END IF;
  UPDATE hon.missed_calls SET text_back_status = 'UNKNOWN', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE text_back_status = 'SENDING' AND lease_expires_at <= now();
  FOR v_row IN
    SELECT m.* FROM hon.missed_calls m WHERE m.text_back_status = 'PENDING' AND m.next_attempt_at <= now()
    ORDER BY m.next_attempt_at, m.id FOR UPDATE OF m SKIP LOCKED LIMIT p_limit
  LOOP
    SELECT school.name, school.timezone, school.status::text AS school_status, organization.status::text AS organization_status,
      sender.status AS sender_status, sender.missed_call_text_back, sender.messaging_service_sid, coalesce(lang.language, 'en') AS language
    INTO v_ctx
    FROM hon.schools school JOIN hon.organizations organization ON organization.id = school.organization_id
    LEFT JOIN hon.school_text_senders sender ON sender.school_id = school.id
    LEFT JOIN hon.school_language_defaults lang ON lang.school_id = school.id
    WHERE school.id = v_row.school_id;
    IF v_ctx.sender_status IS DISTINCT FROM 'ACTIVE' OR NOT coalesce(v_ctx.missed_call_text_back, false)
       OR v_ctx.school_status <> 'ACTIVE' OR v_ctx.organization_status <> 'ACTIVE'
       OR v_row.received_at < now() - interval '24 hours' THEN
      UPDATE hon.missed_calls SET text_back_status = 'OFF', updated_at = now() WHERE id = v_row.id;
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM hon.people p JOIN hon.communication_consents c ON c.person_id = p.id AND c.channel = 'SMS' AND c.status = 'OPTED_OUT'
      WHERE p.school_id = v_row.school_id AND p.organization_id = v_row.organization_id AND p.phone_e164 = v_row.caller_e164) THEN
      UPDATE hon.missed_calls SET text_back_status = 'OPTED_OUT', updated_at = now() WHERE id = v_row.id;
      CONTINUE;
    END IF;
    v_local := now() AT TIME ZONE v_ctx.timezone;
    IF v_local::time >= time '21:00' OR v_local::time < time '08:00' THEN
      UPDATE hon.missed_calls SET next_attempt_at = (date_trunc('day', v_local)
        + CASE WHEN v_local::time >= time '21:00' THEN interval '1 day' ELSE interval '0' END + interval '8 hours') AT TIME ZONE v_ctx.timezone
      WHERE id = v_row.id;
      CONTINUE;
    END IF;
    v_token := gen_random_uuid();
    UPDATE hon.missed_calls SET text_back_status = 'SENDING', lease_token = v_token, lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempt_count = attempt_count + 1, updated_at = now()
    WHERE id = v_row.id RETURNING * INTO v_row;
    missed_call_id := v_row.id; lease_token := v_token; organization_id := v_row.organization_id; school_id := v_row.school_id; caller_e164 := v_row.caller_e164;
    school_name := v_ctx.name; language := v_ctx.language; sender_service_id := v_ctx.messaging_service_sid; attempt := v_row.attempt_count;
    RETURN NEXT;
  END LOOP;
END $$;

CREATE FUNCTION hon.record_missed_call_text_back_result(
  p_missed_call_id uuid, p_lease_token uuid, p_outcome text, p_provider_message_id text
) RETURNS TABLE (text_back_status text, accepted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE v_row hon.missed_calls;
BEGIN
  IF p_outcome NOT IN ('ACCEPTED', 'RETRYABLE', 'FAILED', 'UNKNOWN') OR (p_outcome = 'ACCEPTED' AND p_provider_message_id IS NULL) THEN
    RAISE EXCEPTION 'HON missed-call result is invalid.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM hon.missed_calls WHERE id = p_missed_call_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'HON missed call was not found.' USING ERRCODE = 'P0002'; END IF;
  IF v_row.text_back_status <> 'SENDING' OR v_row.lease_token IS DISTINCT FROM p_lease_token OR v_row.lease_expires_at <= now() THEN
    IF v_row.text_back_status = 'SENDING' AND v_row.lease_token = p_lease_token THEN
      UPDATE hon.missed_calls SET text_back_status = 'UNKNOWN', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = v_row.id RETURNING * INTO v_row;
    END IF;
    text_back_status := v_row.text_back_status; accepted := false; RETURN NEXT; RETURN;
  END IF;
  UPDATE hon.missed_calls SET
    text_back_status = CASE p_outcome WHEN 'ACCEPTED' THEN 'ACCEPTED' WHEN 'RETRYABLE' THEN CASE WHEN attempt_count < 3 THEN 'PENDING' ELSE 'FAILED' END
      WHEN 'FAILED' THEN 'FAILED' ELSE 'UNKNOWN' END,
    provider_message_id = CASE WHEN p_outcome = 'ACCEPTED' THEN p_provider_message_id ELSE provider_message_id END,
    next_attempt_at = CASE WHEN p_outcome = 'RETRYABLE' THEN now() + interval '2 minutes' * power(2, attempt_count) ELSE next_attempt_at END,
    lease_token = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE id = v_row.id RETURNING * INTO v_row;
  text_back_status := v_row.text_back_status; accepted := true; RETURN NEXT;
END $$;

-- School staff list of recent missed calls (newest first) to call back. Caller numbers are shown to the school only.
CREATE FUNCTION hon.read_school_missed_calls(p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, hon AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'callerE164', m.caller_e164, 'dialStatus', m.dial_status,
    'textBack', m.text_back_status, 'receivedAt', m.received_at) ORDER BY m.received_at DESC, m.id DESC), '[]'::jsonb)
  FROM (SELECT * FROM hon.missed_calls ORDER BY received_at DESC, id DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 100)) m
$$;

REVOKE ALL ON FUNCTION hon.set_school_missed_call_settings_from_hq(text, uuid, text, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.read_missed_call_route(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.record_missed_call(text, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.claim_missed_call_text_backs(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.record_missed_call_text_back_result(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.read_school_missed_calls(integer) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.missed_calls FROM %I', r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_missed_call_route(text), hon.record_missed_call(text, text, text, text, timestamptz), '
      || 'hon.claim_missed_call_text_backs(integer, integer), hon.record_missed_call_text_back_result(uuid, uuid, text, text) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT SELECT ON TABLE hon.missed_calls TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.set_school_missed_call_settings_from_hq(text, uuid, text, boolean, integer), hon.read_school_missed_calls(integer) TO hon_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.read_missed_call_route(text), hon.record_missed_call(text, text, text, text, timestamptz),
      hon.claim_missed_call_text_backs(integer, integer), hon.record_missed_call_text_back_result(uuid, uuid, text, text) TO hon_communication_worker;
  END IF;
END;
$$;
COMMIT;
