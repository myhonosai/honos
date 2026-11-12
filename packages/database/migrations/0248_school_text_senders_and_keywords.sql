BEGIN;
-- 0248 school texting numbers and inbound STOP/START/HELP (docs/architecture/COMMUNICATION_DELIVERY.md §5).
-- A school sends texts only from its own ACTIVE sender (Twilio Messaging Service + number), set by a human HON HQ
-- owner. Inbound keywords to that number record the sender's text consent for that school only. Nothing here
-- creates a Twilio number, registration or message.

CREATE TABLE hon.school_text_senders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'TWILIO' CHECK (provider = 'TWILIO'),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  messaging_service_sid text NOT NULL CHECK (messaging_service_sid ~ '^MG[0-9a-f]{32}$'),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  -- Long texts rely on the Messaging Service's MMS Converter (3+ pieces go as one MMS). HON cannot change a
  -- Twilio service itself, so the HQ owner confirms it is on; a sender cannot be ACTIVE without that.
  mms_converter_confirmed boolean NOT NULL DEFAULT false,
  set_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (school_id),
  UNIQUE (phone_e164),
  CONSTRAINT school_text_senders_active_needs_mms_converter CHECK (status <> 'ACTIVE' OR mms_converter_confirmed)
);
ALTER TABLE hon.school_text_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_text_senders FORCE ROW LEVEL SECURITY;
CREATE POLICY school_text_senders_tenant_isolation ON hon.school_text_senders
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

-- One row per inbound keyword message (idempotent per provider message). The sender's number is not stored.
CREATE TABLE hon.inbound_text_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  provider_message_id text NOT NULL UNIQUE CHECK (provider_message_id ~ '^SM[0-9a-f]{32}$|^MM[0-9a-f]{32}$'),
  keyword text NOT NULL CHECK (keyword IN ('STOP', 'START', 'HELP')),
  people_matched integer NOT NULL CHECK (people_matched BETWEEN 0 AND 1000),
  consents_changed integer NOT NULL CHECK (consents_changed BETWEEN 0 AND 1000),
  received_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.inbound_text_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.inbound_text_keywords FORCE ROW LEVEL SECURITY;
CREATE POLICY inbound_text_keywords_tenant_isolation ON hon.inbound_text_keywords
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

-- Texts wait (SENDER_NOT_READY) until the school has an ACTIVE sender.
ALTER TABLE hon.communication_deliveries DROP CONSTRAINT communication_deliveries_hold_reason_check;
ALTER TABLE hon.communication_deliveries ADD CONSTRAINT communication_deliveries_hold_reason_check
  CHECK (hold_reason IN ('SCHEDULED', 'QUIET_HOURS', 'SCHOOL_INACTIVE', 'RETRY_WAIT', 'SENDER_NOT_READY'));

-- HQ owner sets or disables a school's sender. Human HON HQ owner only; audited in the school's scope.
CREATE FUNCTION hon.set_school_text_sender_from_hq(
  p_subject text, p_school uuid, p_phone_e164 text, p_messaging_service_sid text, p_status text, p_mms_converter_confirmed boolean,
  p_expected_version integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; s hon.schools%ROWTYPE; prior hon.school_text_senders; next hon.school_text_senders; req uuid := gen_random_uuid();
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_school IS NULL OR p_status NOT IN ('ACTIVE', 'DISABLED') OR p_phone_e164 IS NULL OR p_messaging_service_sid IS NULL
    OR p_mms_converter_confirmed IS NULL THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'ACTIVE' AND NOT p_mms_converter_confirmed THEN
    RAISE EXCEPTION 'MMS_CONVERTER_NOT_CONFIRMED' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO s FROM hon.schools WHERE id = p_school;
  IF s.id IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO prior FROM hon.school_text_senders WHERE school_id = p_school FOR UPDATE;
  IF prior.id IS NULL THEN
    IF p_expected_version IS NOT NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    INSERT INTO hon.school_text_senders (organization_id, school_id, phone_e164, messaging_service_sid, status, mms_converter_confirmed, set_by_principal_id)
    VALUES (s.organization_id, s.id, p_phone_e164, p_messaging_service_sid, p_status, p_mms_converter_confirmed, actor) RETURNING * INTO next;
  ELSE
    IF p_expected_version IS DISTINCT FROM prior.version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    UPDATE hon.school_text_senders SET phone_e164 = p_phone_e164, messaging_service_sid = p_messaging_service_sid, status = p_status,
      mms_converter_confirmed = p_mms_converter_confirmed, set_by_principal_id = actor, version = version + 1, updated_at = now()
    WHERE id = prior.id RETURNING * INTO next;
  END IF;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (s.organization_id, s.id, actor, 'HON_HQ', 'communication.text_sender.set', 'SCHOOL_TEXT_SENDER', next.id,
    CASE WHEN prior.id IS NULL THEN NULL ELSE jsonb_build_object('phone', prior.phone_e164, 'status', prior.status, 'version', prior.version) END,
    jsonb_build_object('phone', next.phone_e164, 'status', next.status, 'mmsConverterConfirmed', next.mms_converter_confirmed, 'version', next.version), 'SUCCEEDED', req, req, now());
  -- Authority is checked again after the lock and the write, so a grant that ended meanwhile aborts the change.
  PERFORM hon.require_saas_hq_actor(p_subject, true);
  RETURN jsonb_build_object('schoolId', next.school_id, 'phoneE164', next.phone_e164, 'status', next.status, 'mmsConverterConfirmed', next.mms_converter_confirmed,
    'version', next.version, 'updatedAt', next.updated_at);
END $$;

-- Claim v2: as 0243, plus SMS needs the school's ACTIVE sender, whose service SID and number are returned for the send.
DROP FUNCTION hon.claim_communication_deliveries(text[], integer, integer);
CREATE FUNCTION hon.claim_communication_deliveries(
  p_channels text[], p_limit integer, p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  delivery_id uuid, lease_token uuid, organization_id uuid, school_id uuid, message_id uuid,
  channel text, recipient_address text, content text, school_name text, attempt integer,
  sender_address text, sender_service_id text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon
AS $$
#variable_conflict use_column
DECLARE
  v_message record;
  v_delivery hon.communication_deliveries;
  v_ctx record;
  v_sender hon.school_text_senders;
  v_local timestamp;
  v_wake timestamptz;
  v_prior text;
  v_token uuid;
  v_address text;
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'HON communication claim limit must be between 1 and 100.' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds < 15 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'HON communication lease must be between 15 and 300 seconds.' USING ERRCODE = '22023';
  END IF;
  IF p_channels IS NULL OR cardinality(p_channels) < 1 OR NOT (p_channels <@ ARRAY['EMAIL', 'SMS']) THEN
    RAISE EXCEPTION 'HON communication claim channels must be EMAIL and/or SMS.' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.reconcile_expired_communication_leases(p_limit);

  FOR v_message IN
    SELECT message.id, message.organization_id, message.school_id, message.channel
    FROM hon.communication_messages message
    WHERE message.lifecycle = 'QUEUED' AND message.channel::text = ANY (p_channels)
      AND (message.scheduled_at IS NULL OR message.scheduled_at <= now())
      AND NOT EXISTS (SELECT 1 FROM hon.communication_deliveries d WHERE d.message_id = message.id)
    ORDER BY message.updated_at, message.id
    FOR UPDATE OF message SKIP LOCKED
    LIMIT p_limit
  LOOP
    INSERT INTO hon.communication_deliveries (organization_id, school_id, message_id, channel)
    VALUES (v_message.organization_id, v_message.school_id, v_message.id, v_message.channel)
    ON CONFLICT (message_id) DO NOTHING
    RETURNING * INTO v_delivery;
    IF v_delivery.id IS NOT NULL THEN
      PERFORM hon.communication_delivery_evidence(v_delivery, NULL, 'communication.delivery.created');
    END IF;
  END LOOP;

  FOR v_delivery IN
    SELECT d.* FROM hon.communication_deliveries d
    WHERE d.status = 'PENDING' AND d.channel::text = ANY (p_channels) AND d.next_attempt_at <= now()
    ORDER BY d.next_attempt_at, d.id
    FOR UPDATE OF d SKIP LOCKED
    LIMIT p_limit
  LOOP
    v_prior := v_delivery.status::text;
    SELECT message.content, message.recipient_person_id, message.lifecycle::text AS lifecycle,
           school.name AS school_name, school.timezone, school.status::text AS school_status,
           organization.status::text AS organization_status,
           person.email::text AS email, person.phone_e164,
           consent.status::text AS consent_status
    INTO v_ctx
    FROM hon.communication_messages message
    JOIN hon.schools school ON school.id = message.school_id AND school.organization_id = message.organization_id
    JOIN hon.organizations organization ON organization.id = message.organization_id
    JOIN hon.people person ON person.id = message.recipient_person_id
      AND person.organization_id = message.organization_id AND person.school_id = message.school_id
    LEFT JOIN hon.communication_consents consent ON consent.person_id = message.recipient_person_id
      AND consent.organization_id = message.organization_id AND consent.school_id = message.school_id
      AND consent.channel::text = message.channel::text
    WHERE message.id = v_delivery.message_id;

    IF v_ctx.school_status <> 'ACTIVE' OR v_ctx.organization_status <> 'ACTIVE' THEN
      IF v_delivery.hold_reason IS DISTINCT FROM 'SCHOOL_INACTIVE' THEN
        UPDATE hon.communication_deliveries SET hold_reason = 'SCHOOL_INACTIVE', next_attempt_at = now() + interval '1 hour',
          version = version + 1, updated_at = now() WHERE id = v_delivery.id RETURNING * INTO v_delivery;
        PERFORM hon.communication_delivery_evidence(v_delivery, v_prior, 'communication.delivery.held');
      ELSE
        UPDATE hon.communication_deliveries SET next_attempt_at = now() + interval '1 hour' WHERE id = v_delivery.id;
      END IF;
      CONTINUE;
    END IF;

    v_address := CASE v_delivery.channel WHEN 'EMAIL' THEN v_ctx.email ELSE v_ctx.phone_e164 END;
    IF v_ctx.lifecycle <> 'QUEUED' OR v_ctx.consent_status IS DISTINCT FROM 'OPTED_IN' OR v_address IS NULL OR btrim(v_address) = '' THEN
      UPDATE hon.communication_deliveries
      SET status = 'SUPPRESSED', hold_reason = NULL,
          failure_code = CASE WHEN v_ctx.lifecycle = 'QUEUED' AND v_ctx.consent_status = 'OPTED_IN' THEN 'ADDRESS_MISSING' ELSE 'CONSENT_MISSING' END,
          final_at = now(), version = version + 1, updated_at = now()
      WHERE id = v_delivery.id RETURNING * INTO v_delivery;
      PERFORM hon.communication_delivery_evidence(v_delivery, v_prior, 'communication.delivery.suppressed');
      CONTINUE;
    END IF;

    v_sender := NULL;
    IF v_delivery.channel = 'SMS' THEN
      SELECT * INTO v_sender FROM hon.school_text_senders sender
      WHERE sender.school_id = v_delivery.school_id AND sender.organization_id = v_delivery.organization_id AND sender.status = 'ACTIVE';
      IF v_sender.id IS NULL THEN
        IF v_delivery.hold_reason IS DISTINCT FROM 'SENDER_NOT_READY' THEN
          UPDATE hon.communication_deliveries SET hold_reason = 'SENDER_NOT_READY', next_attempt_at = now() + interval '1 hour',
            version = version + 1, updated_at = now() WHERE id = v_delivery.id RETURNING * INTO v_delivery;
          PERFORM hon.communication_delivery_evidence(v_delivery, v_prior, 'communication.delivery.held');
        ELSE
          UPDATE hon.communication_deliveries SET next_attempt_at = now() + interval '1 hour' WHERE id = v_delivery.id;
        END IF;
        CONTINUE;
      END IF;

      v_local := now() AT TIME ZONE v_ctx.timezone;
      IF v_local::time >= time '21:00' OR v_local::time < time '08:00' THEN
        v_wake := (date_trunc('day', v_local)
          + CASE WHEN v_local::time >= time '21:00' THEN interval '1 day' ELSE interval '0' END
          + interval '8 hours') AT TIME ZONE v_ctx.timezone;
        IF v_delivery.hold_reason IS DISTINCT FROM 'QUIET_HOURS' THEN
          UPDATE hon.communication_deliveries SET hold_reason = 'QUIET_HOURS', next_attempt_at = v_wake, version = version + 1, updated_at = now()
          WHERE id = v_delivery.id RETURNING * INTO v_delivery;
          PERFORM hon.communication_delivery_evidence(v_delivery, v_prior, 'communication.delivery.held');
        ELSE
          UPDATE hon.communication_deliveries SET next_attempt_at = v_wake WHERE id = v_delivery.id;
        END IF;
        CONTINUE;
      END IF;
    END IF;

    v_token := gen_random_uuid();
    UPDATE hon.communication_deliveries
    SET status = 'SENDING', hold_reason = NULL, attempt_count = attempt_count + 1, lease_token = v_token,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds), version = version + 1, updated_at = now()
    WHERE id = v_delivery.id RETURNING * INTO v_delivery;
    PERFORM hon.communication_delivery_evidence(v_delivery, v_prior, 'communication.delivery.leased');

    delivery_id := v_delivery.id;
    lease_token := v_token;
    organization_id := v_delivery.organization_id;
    school_id := v_delivery.school_id;
    message_id := v_delivery.message_id;
    channel := v_delivery.channel::text;
    recipient_address := v_address;
    content := v_ctx.content;
    school_name := v_ctx.school_name;
    attempt := v_delivery.attempt_count;
    sender_address := v_sender.phone_e164;
    sender_service_id := v_sender.messaging_service_sid;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Inbound STOP/START/HELP to a school's ACTIVE number. Routing is the receiving number only; the sender's number
-- matches people of that one school. STOP opts every match out of texts. START re-opens only consent the person
-- withdrew by text themselves (source RECIPIENT), never a staff-recorded opt-out. HELP changes nothing.
CREATE FUNCTION hon.record_inbound_text_keyword(
  p_to_e164 text, p_from_e164 text, p_keyword text, p_provider_message_id text, p_received_at timestamptz
) RETURNS TABLE (outcome text, school_name text, consents_changed integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE v_sender hon.school_text_senders; v_school_name text; v_person record; v_matched integer := 0; v_changed integer := 0;
  v_consent hon.communication_consents; v_req uuid;
BEGIN
  IF p_keyword NOT IN ('STOP', 'START', 'HELP') OR p_from_e164 !~ '^\+[1-9][0-9]{7,14}$' OR p_to_e164 !~ '^\+[1-9][0-9]{7,14}$'
     OR p_received_at IS NULL OR p_received_at > now() + interval '10 minutes' OR p_received_at < now() - interval '7 days' THEN
    RAISE EXCEPTION 'HON inbound text keyword is invalid.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.inbound_text_keywords k WHERE k.provider_message_id = p_provider_message_id) THEN
    SELECT 'REPLAYED', s.name, k.consents_changed INTO outcome, school_name, consents_changed
    FROM hon.inbound_text_keywords k JOIN hon.schools s ON s.id = k.school_id WHERE k.provider_message_id = p_provider_message_id;
    RETURN NEXT; RETURN;
  END IF;
  -- STOP is honored for any recorded school number, even a DISABLED one; START and HELP need an ACTIVE sender.
  SELECT * INTO v_sender FROM hon.school_text_senders sender WHERE sender.phone_e164 = p_to_e164;
  IF v_sender.id IS NULL OR (v_sender.status <> 'ACTIVE' AND p_keyword <> 'STOP') THEN outcome := 'UNROUTED'; school_name := NULL; consents_changed := 0; RETURN NEXT; RETURN; END IF;
  SELECT s.name INTO v_school_name FROM hon.schools s WHERE s.id = v_sender.school_id;

  FOR v_person IN
    SELECT p.id FROM hon.people p WHERE p.organization_id = v_sender.organization_id AND p.school_id = v_sender.school_id
      AND p.phone_e164 = p_from_e164 ORDER BY p.id LIMIT 1000
  LOOP
    v_matched := v_matched + 1;
    IF p_keyword = 'STOP' THEN
      IF hon.communication_record_recipient_opt_out(v_sender.organization_id, v_sender.school_id, v_person.id, 'SMS', p_received_at) THEN
        v_changed := v_changed + 1;
      END IF;
    ELSIF p_keyword = 'START' THEN
      SELECT * INTO v_consent FROM hon.communication_consents c
      WHERE c.person_id = v_person.id AND c.channel = 'SMS' AND c.status = 'OPTED_OUT' AND c.source = 'RECIPIENT' FOR UPDATE;
      IF v_consent.id IS NOT NULL THEN
        UPDATE hon.communication_consents SET status = 'OPTED_IN', captured_at = p_received_at, version = version + 1,
          updated_by_principal_id = '00000000-0000-4000-8000-00000000c043', updated_at = now()
        WHERE id = v_consent.id RETURNING * INTO v_consent;
        v_req := gen_random_uuid();
        INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
          prior_state, next_state, result, request_id, correlation_id, occurred_at)
        VALUES (v_sender.organization_id, v_sender.school_id, '00000000-0000-4000-8000-00000000c043', 'INTEGRATION',
          'communication.consent.recipient_opt_in', 'COMMUNICATION_CONSENT', v_consent.id,
          jsonb_build_object('status', 'OPTED_OUT', 'source', 'RECIPIENT', 'version', v_consent.version - 1),
          jsonb_build_object('personId', v_person.id, 'channel', 'SMS', 'status', 'OPTED_IN', 'source', 'RECIPIENT', 'version', v_consent.version),
          'SUCCEEDED', v_req, v_req, now());
        INSERT INTO hon.outbox_events (id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
          aggregate_version, correlation_id, causation_id, payload)
        VALUES (gen_random_uuid(), v_sender.organization_id, v_sender.school_id, 'communication.consent.recorded', 1, 'COMMUNICATION_CONSENT',
          v_consent.id, v_consent.version, v_req, v_req,
          jsonb_build_object('personId', v_person.id, 'channel', 'SMS', 'status', 'OPTED_IN', 'source', 'RECIPIENT'));
        v_changed := v_changed + 1;
      END IF;
      v_consent := NULL;
    END IF;
  END LOOP;

  INSERT INTO hon.inbound_text_keywords (organization_id, school_id, provider_message_id, keyword, people_matched, consents_changed, received_at)
  VALUES (v_sender.organization_id, v_sender.school_id, p_provider_message_id, p_keyword, v_matched, v_changed, p_received_at);
  outcome := 'RECORDED'; school_name := v_school_name; consents_changed := v_changed;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION hon.set_school_text_sender_from_hq(text, uuid, text, text, text, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.claim_communication_deliveries(text[], integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.record_inbound_text_keyword(text, text, text, text, timestamptz) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.school_text_senders, hon.inbound_text_keywords FROM %I', r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.claim_communication_deliveries(text[], integer, integer), '
      || 'hon.record_inbound_text_keyword(text, text, text, text, timestamptz) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT SELECT ON TABLE hon.school_text_senders, hon.inbound_text_keywords TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.set_school_text_sender_from_hq(text, uuid, text, text, text, boolean, integer) TO hon_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.claim_communication_deliveries(text[], integer, integer),
      hon.record_inbound_text_keyword(text, text, text, text, timestamptz) TO hon_communication_worker;
  END IF;
END;
$$;
COMMIT;
