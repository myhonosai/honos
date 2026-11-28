BEGIN;

-- 0698 HQ inbox: owners' text replies come back to HQ (coordinator-allocated 2026-11-26; spec
-- /mnt/project-files/hq-inbox/SPEC.md, piece B). Owner decision (David, 2026-11-26 07:44Z, card "Should HQ Texts and email
-- work like the school CRM inbox?"): "Yes, make it an inbox like school".
--   IR1  An ordinary text (not STOP/START/HELP or a code) to the active HQ Messaging Service, from a phone an owner
--        confirmed for HQ texts, is kept as a reply when that person was sent an HQ text (accepted by the provider) in
--        the 30 days before it and still owns that message's school. It joins that message's conversation (its school,
--        organization and purpose). Anything else is recorded as before and its body is not kept.
--   IR2  Each provider event is recorded once (0282's replay rule); a replay changes nothing and sends no auto-reply.
--        A reply never gets an automatic answer.
--   IR3  Who reads: the HQ people of 0281, only for the purposes they hold (a reply has its message's purpose). The
--        reader is proved again before returning. No address is ever returned: the sender is the owner's display name.
--   IR4  Replies are evidence: never updated or deleted. Forced RLS with no policies; the runtime gains only EXECUTE on
--        hon.read_hq_replies. The inbound function stays the communication worker's (013).
--   IR5  Email replies are not part of this migration (they need an inbound mail route; later piece).
-- Nothing here sends, charges or calls an outside service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.record_hq_inbound_text(text,text,text,text,text,timestamptz)') IS NULL
    OR to_regprocedure('hon.require_hq_communication_actor(text,text)') IS NULL OR to_regprocedure('hon.hq_message_owner_recipients(uuid)') IS NULL
    OR to_regprocedure('hon.hq_communication_person_json(uuid)') IS NULL OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL THEN
    RAISE EXCEPTION '0698 requires 0281 and 0282'; END IF;
END $$;

CREATE TABLE hon.hq_inbound_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('FAKE','TWILIO')),
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  message_id uuid NOT NULL REFERENCES hon.hq_messages(id),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  from_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 1600 AND body = btrim(body)),
  received_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  -- One reply per provider event; its hon.hq_inbound_texts row (outcome REPLY_RECORDED) is written in the same call.
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX hq_inbound_replies_school ON hon.hq_inbound_replies (school_id, received_at DESC, id DESC);
CREATE INDEX hq_inbound_replies_time ON hon.hq_inbound_replies (received_at DESC, id DESC);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_inbound_replies FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_inbound_replies FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_communication_evidence();
ALTER TABLE hon.hq_inbound_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_inbound_replies FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.hq_inbound_replies FROM PUBLIC;

-- A kept reply is its own outcome.
ALTER TABLE hon.hq_inbound_texts DROP CONSTRAINT hq_inbound_texts_outcome_check;
ALTER TABLE hon.hq_inbound_texts ADD CONSTRAINT hq_inbound_texts_outcome_check
  CHECK (outcome IN ('OPTED_OUT','OPTED_IN','HELP','CONFIRMED','CODE_WRONG','PHONE_IN_USE','NO_MATCH','NOT_HQ','IGNORED','REPLY_RECORDED'));

-- ---------- inbound: 0282 unchanged except IR1 (same signature, so the worker's grant stays) ----------
CREATE OR REPLACE FUNCTION hon.record_hq_inbound_text(p_provider text, p_event_id text, p_from text, p_to_service text, p_body text, p_received_at timestamptz)
RETURNS TABLE (outcome text, reply text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE prior hon.hq_inbound_texts%ROWTYPE; v_reply_message uuid; v_reply_principal uuid; v_reply hon.hq_messages%ROWTYPE; v_word text; v_kind text; v_out text; v_user uuid; r hon.hq_contact_phones%ROWTYPE; v_match hon.hq_contact_phones%ROWTYPE;
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
  ELSIF v_kind = 'OTHER' AND btrim(p_body) <> '' THEN
    -- 0698: an ordinary reply from a confirmed owner phone joins the conversation of the newest HQ text that person was
    -- sent in the 30 days before it, while they still own that school. Anything else changes nothing.
    SELECT ph.user_id INTO v_user FROM hon.hq_contact_phones ph WHERE ph.phone_e164 = p_from AND ph.status = 'CONFIRMED';
    IF v_user IS NULL THEN v_out := 'NO_MATCH';
    ELSE
      SELECT d.message_id, d.recipient_principal_id INTO v_reply_message, v_reply_principal
      FROM hon.hq_message_deliveries d JOIN hon.principals p ON p.id = d.recipient_principal_id
      WHERE p.user_id = v_user AND d.channel = 'SMS' AND d.status IN ('ACCEPTED','DELIVERED')
        AND d.accepted_at IS NOT NULL AND d.accepted_at <= v_when AND d.accepted_at > v_when - interval '30 days'
      ORDER BY d.accepted_at DESC, d.id DESC LIMIT 1;
      IF v_reply_message IS NOT NULL THEN SELECT * INTO v_reply FROM hon.hq_messages WHERE id = v_reply_message; END IF;
      IF v_reply.id IS NULL OR NOT EXISTS (SELECT 1 FROM hon.hq_message_owner_recipients(v_reply.school_id) o WHERE o.principal_id = v_reply_principal) THEN
        v_out := 'IGNORED';
      ELSE
        INSERT INTO hon.hq_inbound_replies (provider, provider_event_id, message_id, organization_id, school_id, from_principal_id, body, received_at, recorded_at)
        VALUES (p_provider, p_event_id, v_reply.id, v_reply.organization_id, v_reply.school_id, v_reply_principal, btrim(p_body), v_when, at);
        v_out := 'REPLY_RECORDED';
      END IF;
    END IF;
  ELSE
    v_out := 'IGNORED';
  END IF;
  INSERT INTO hon.hq_inbound_texts VALUES (p_provider, p_event_id, v_kind, v_out, v_user, p_received_at, at);
  outcome := v_out; replayed := false; reply := hon.hq_inbound_reply(v_out);
  RETURN NEXT;
END $$;

-- ---------- read ----------
CREATE FUNCTION hon.hq_inbound_reply_json(r hon.hq_inbound_replies) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('replyId', r.id, 'messageId', r.message_id, 'organizationId', r.organization_id,
    'organizationDisplayName', left((SELECT o.display_name FROM hon.organizations o WHERE o.id = r.organization_id), 300),
    'schoolId', r.school_id, 'schoolDisplayName', left((SELECT s.name FROM hon.schools s WHERE s.id = r.school_id), 300),
    'purpose', (SELECT m.purpose FROM hon.hq_messages m WHERE m.id = r.message_id), 'channel', 'SMS',
    'from', hon.hq_communication_person_json(r.from_principal_id), 'body', r.body, 'receivedAt', hon.saas_ts(r.received_at))
$$;

-- The newest owner replies the reader may see (only purposes they hold), for one school or all, newest first.
CREATE FUNCTION hon.read_hq_replies(p_subject text, p_school uuid, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; purposes text[]; v_rows jsonb; result jsonb;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, NULL);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  purposes := hon.hq_communication_purposes(actor);
  SELECT coalesce(jsonb_agg(hon.hq_inbound_reply_json(x) ORDER BY x.received_at DESC, x.id DESC), '[]'::jsonb) INTO v_rows FROM (
    SELECT r.* FROM hon.hq_inbound_replies r JOIN hon.hq_messages m ON m.id = r.message_id
    WHERE m.purpose = ANY(purposes) AND (p_school IS NULL OR r.school_id = p_school)
    ORDER BY r.received_at DESC, r.id DESC LIMIT p_limit) x;
  result := jsonb_build_object('replies', v_rows, 'limit', p_limit, 'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_communication_actor(p_subject, NULL);
  RETURN result;
END $$;

DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.hq_inbound_replies FROM %I', r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.hq_inbound_reply_json(hon.hq_inbound_replies) FROM %I', r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_hq_replies(text,uuid,integer) FROM %I', r);
  END LOOP;
  REVOKE ALL ON FUNCTION hon.hq_inbound_reply_json(hon.hq_inbound_replies) FROM PUBLIC;
  REVOKE ALL ON FUNCTION hon.read_hq_replies(text,uuid,integer) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_hq_replies(text,uuid,integer) TO hon_runtime;
  END IF;
END $$;

COMMIT;
