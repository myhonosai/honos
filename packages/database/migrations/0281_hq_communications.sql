BEGIN;

-- 0281 HQ texting and email to school owners (HQ-COMM PR A, docs/architecture/HQ_COMMUNICATIONS.md). HON HQ writes one
-- message to the current owners of one school about SUPPORT, BILLING, ONBOARDING or ACCOUNT matters; a human HQ person
-- drafts, queues or cancels it, with the HQ permission of its purpose. Only the HQ owner sets or retires the HQ sender
-- (one email from-address; one Twilio Messaging Service SID with MMS Converter confirmed and the public number people
-- text back). The 0243 communication worker
-- delivers through four fixed functions of its own; HQ never reads a recipient address and no address, body copy,
-- credential or raw provider payload is stored outside the message itself. Nothing here sends a message by itself:
-- delivery needs the worker, a READY provider and the deployment send switches (HON_EMAIL_SEND_APPROVED,
-- HON_SMS_SEND_APPROVED). Texts go only to a person who turned HQ texts on themselves (OPTED_IN SMS preference) and has a
-- confirmed phone, which arrive with 0282: until then SMS deliveries are suppressed with CONSENT_MISSING.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ communications require a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.claim_communication_deliveries(text[],integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'Apply communication delivery migration 0243 first';
  END IF;
END $$;

-- The fixed actor for HQ delivery evidence and recipient-originated HQ opt-outs.
INSERT INTO hon.principals (id, principal_type, user_id, display_name, is_active)
VALUES ('00000000-0000-4000-8000-00000000c281', 'INTEGRATION', NULL, 'HON HQ communication delivery', true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE hon.hq_communication_senders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  status text NOT NULL CHECK (status IN ('ACTIVE','RETIRED')),
  email_from text CHECK (email_from ~ '^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$'),
  email_display_name text CHECK (email_display_name = btrim(email_display_name) AND length(email_display_name) BETWEEN 1 AND 80),
  sms_service_sid text CHECK (sms_service_sid ~ '^MG[0-9a-f]{32}$'),
  -- The public number people text (codes, STOP, HELP). Inbound texts are matched by the Messaging Service SID, not this.
  sms_reply_number text CHECK (sms_reply_number ~ '^\+[1-9][0-9]{7,14}$'),
  a2p_state text CHECK (a2p_state IN ('NOT_REGISTERED','PENDING','REGISTERED_SERVICE','REGISTERED_MARKETING')),
  mms_converter_confirmed boolean,
  created_by uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL,
  retired_by uuid REFERENCES hon.principals(id),
  retired_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (channel <> 'EMAIL' OR (email_from IS NOT NULL AND email_display_name IS NOT NULL AND sms_service_sid IS NULL AND sms_reply_number IS NULL
    AND a2p_state IS NULL AND mms_converter_confirmed IS NULL)),
  -- Long texts go out as one MMS only when the Messaging Service has MMS Converter on, so it is required.
  CHECK (channel <> 'SMS' OR (sms_service_sid IS NOT NULL AND sms_reply_number IS NOT NULL AND a2p_state IS NOT NULL AND mms_converter_confirmed IS TRUE
    AND email_from IS NULL AND email_display_name IS NULL)),
  CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL AND retired_by IS NOT NULL))
);
CREATE UNIQUE INDEX hq_communication_senders_one_active ON hon.hq_communication_senders (channel) WHERE status = 'ACTIVE';

CREATE TABLE hon.hq_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id),
  school_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('SUPPORT','BILLING','ONBOARDING','ACCOUNT')),
  channel text NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  content text NOT NULL CHECK (content = btrim(content) AND length(content) >= 1
    AND length(content) <= CASE channel WHEN 'SMS' THEN 1600 ELSE 4000 END),
  support_case_id uuid REFERENCES hon.hq_support_cases(id),
  status text NOT NULL CHECK (status IN ('DRAFT','QUEUED','CANCELLED')),
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count BETWEEN 0 AND 100),
  created_by uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL,
  queued_by uuid REFERENCES hon.principals(id),
  queued_at timestamptz,
  cancelled_by uuid REFERENCES hon.principals(id),
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id),
  UNIQUE (id, organization_id, school_id),
  CHECK ((queued_at IS NULL) = (queued_by IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  CHECK (status = 'DRAFT' OR status = 'CANCELLED' OR queued_at IS NOT NULL),
  CHECK (updated_at >= created_at)
);
CREATE INDEX hq_messages_created_idx ON hon.hq_messages (created_at DESC, id DESC);
CREATE INDEX hq_messages_school_idx ON hon.hq_messages (school_id, created_at DESC);

CREATE TABLE hon.hq_message_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  message_id uuid NOT NULL,
  recipient_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  channel text NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  status hon.communication_delivery_status NOT NULL DEFAULT 'PENDING',
  hold_reason text CHECK (hold_reason IN ('QUIET_HOURS','NO_SENDER','RETRY_WAIT')),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  lease_token uuid,
  lease_expires_at timestamptz,
  sender_id uuid REFERENCES hon.hq_communication_senders(id),
  provider text CHECK (provider IN ('FAKE','SENDGRID','TWILIO')),
  provider_message_id text CHECK (provider_message_id ~ '^[A-Za-z0-9._:@<>+=-]{1,200}$'),
  sent_as text CHECK (sent_as IN ('EMAIL','SMS','MMS')),
  segments integer CHECK (segments BETWEEN 1 AND 100),
  encoding text CHECK (encoding IN ('GSM7','UCS2')),
  provider_cost_microunits bigint CHECK (provider_cost_microunits BETWEEN 0 AND 1000000000),
  failure_code text CHECK (failure_code IN (
    'CONSENT_MISSING','ADDRESS_MISSING','RECIPIENT_REMOVED','CANCELLED','LEASE_EXPIRED','PROVIDER_UNKNOWN','PROVIDER_REJECTED',
    'INVALID_ADDRESS','RETRIES_EXHAUSTED','BOUNCED','DROPPED','UNDELIVERED','PROVIDER_FAILED')),
  accepted_at timestamptz,
  final_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (message_id, organization_id, school_id) REFERENCES hon.hq_messages(id, organization_id, school_id),
  UNIQUE (message_id, recipient_principal_id),
  UNIQUE (provider, provider_message_id),
  CHECK ((status = 'SENDING') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (hold_reason IS NULL OR status = 'PENDING'),
  CHECK (status NOT IN ('ACCEPTED','DELIVERED') OR (provider IS NOT NULL AND provider_message_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK (status NOT IN ('SUPPRESSED','FAILED','UNKNOWN','BOUNCED') OR failure_code IS NOT NULL)
);
CREATE INDEX hq_message_deliveries_due_idx ON hon.hq_message_deliveries (status, channel, next_attempt_at) WHERE status IN ('PENDING','SENDING');

CREATE TABLE hon.hq_message_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES hon.hq_message_deliveries(id),
  provider text NOT NULL CHECK (provider IN ('FAKE','SENDGRID','TWILIO')),
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^[A-Za-z0-9._:@<>+=-]{1,200}$'),
  event_type hon.communication_delivery_event_type NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX hq_message_delivery_events_delivery_idx ON hon.hq_message_delivery_events (delivery_id, occurred_at, id);

-- A person's choice about messages from HQ, per channel. Recipient unsubscribe, spam report or STOP writes OPTED_OUT.
CREATE TABLE hon.hq_contact_preferences (
  user_id uuid NOT NULL REFERENCES hon.users(id),
  channel text NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  status text NOT NULL CHECK (status IN ('OPTED_IN','OPTED_OUT')),
  source text NOT NULL CHECK (source IN ('RECIPIENT','USER')),
  captured_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (user_id, channel)
);

CREATE TABLE hon.hq_communication_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('SENDER_SET','SENDER_RETIRE','CREATE','QUEUE','CANCEL')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (actor_principal_id, idempotency_key)
);

-- ---------- immutability ----------
CREATE FUNCTION hon.guard_hq_communication_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN RAISE EXCEPTION 'HQ_COMMUNICATION_RECORD_IMMUTABLE' USING ERRCODE = '42501'; END $$;
-- A message changes only by a version bump of its lifecycle fields; content, purpose and recipients never change.
CREATE FUNCTION hon.guard_hq_message() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND OLD.status <> 'CANCELLED'
    AND (to_jsonb(NEW) - ARRAY['status','recipient_count','queued_by','queued_at','cancelled_by','cancelled_at','updated_at','version'])
      = (to_jsonb(OLD) - ARRAY['status','recipient_count','queued_by','queued_at','cancelled_by','cancelled_at','updated_at','version']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HQ_COMMUNICATION_RECORD_IMMUTABLE' USING ERRCODE = '42501';
END $$;
-- A sender is only ever retired, never edited or deleted.
CREATE FUNCTION hon.guard_hq_communication_sender() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED' AND NEW.version = OLD.version + 1
    AND (to_jsonb(NEW) - ARRAY['status','retired_by','retired_at','version']) = (to_jsonb(OLD) - ARRAY['status','retired_by','retired_at','version']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HQ_COMMUNICATION_RECORD_IMMUTABLE' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_communication_senders FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_sender();
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_messages FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_message();
CREATE TRIGGER no_delete BEFORE DELETE ON hon.hq_message_deliveries FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_message_delivery_events FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_evidence();
CREATE TRIGGER no_delete BEFORE DELETE ON hon.hq_contact_preferences FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_communication_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_evidence();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_communication_senders','hq_messages','hq_message_deliveries','hq_message_delivery_events','hq_contact_preferences','hq_communication_requests'] LOOP
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_communication_evidence()', t);
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
  END LOOP;
END $$;

-- ---------- authority ----------
-- The purposes a principal may message about now: every purpose for a current HQ owner; for a current HQ operator or HQ
-- support grant, SUPPORT and ACCOUNT with hq.support.manage, BILLING with hq.billing.manage, ONBOARDING with
-- hq.onboarding.manage. Only an active human who is the only active principal of their user, with no live family access.
CREATE FUNCTION hon.hq_communication_purposes(p_principal uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce(array_agg(DISTINCT x.purpose ORDER BY x.purpose), ARRAY[]::text[]) FROM (
    SELECT unnest(CASE WHEN g.hq_role = 'HON_HQ_OWNER' THEN ARRAY['ACCOUNT','BILLING','ONBOARDING','SUPPORT']
      WHEN g.hq_role IN ('HON_HQ_OPERATOR','HON_HQ_SUPPORT') THEN
        (CASE WHEN 'hq.support.manage' = ANY(g.permission_codes) THEN ARRAY['ACCOUNT','SUPPORT'] ELSE ARRAY[]::text[] END)
        || (CASE WHEN 'hq.billing.manage' = ANY(g.permission_codes) THEN ARRAY['BILLING'] ELSE ARRAY[]::text[] END)
        || (CASE WHEN 'hq.onboarding.manage' = ANY(g.permission_codes) THEN ARRAY['ONBOARDING'] ELSE ARRAY[]::text[] END)
      ELSE ARRAY[]::text[] END) AS purpose
    FROM hon.hq_operator_grants g JOIN hon.principals p ON p.id = g.principal_id
    WHERE g.principal_id = p_principal AND p.is_active AND p.principal_type = 'HUMAN_USER'
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (SELECT count(*) FROM hon.principals o WHERE o.user_id = p.user_id AND o.is_active) = 1
      AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
        AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()))) x
$$;

CREATE FUNCTION hon.hq_communication_is_owner(p_principal uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p_principal AND g.hq_role = 'HON_HQ_OWNER'
    AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp()))
  AND cardinality(hon.hq_communication_purposes(p_principal)) = 4
$$;

-- p_need: NULL = any HQ messaging purpose; 'OWNER' = the HQ owner only; otherwise that purpose.
CREATE FUNCTION hon.require_hq_communication_actor(p_subject text, p_need text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; purposes text[];
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND p.is_active AND p.principal_type = 'HUMAN_USER' LIMIT 1;
  purposes := CASE WHEN actor IS NULL THEN ARRAY[]::text[] ELSE hon.hq_communication_purposes(actor) END;
  IF cardinality(purposes) = 0
    OR (p_need = 'OWNER' AND NOT hon.hq_communication_is_owner(actor))
    OR (p_need IS NOT NULL AND p_need <> 'OWNER' AND NOT p_need = ANY(purposes)) THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END $$;

-- The current non-HQ owners of a school: unrevoked, started, unended OWNER system-role grants of active human principals
-- that are the only active principal of their user. School or organization suspension does not remove owners, so HQ can
-- still reach a suspended school about billing or access.
CREATE FUNCTION hon.hq_message_owner_recipients(p_school uuid) RETURNS TABLE (principal_id uuid, user_id uuid)
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT DISTINCT p.id, p.user_id FROM hon.principal_role_grants g
  JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id AND r.code = 'OWNER' AND r.is_system_role
  JOIN hon.principals p ON p.id = g.principal_id
  WHERE g.school_id = p_school AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp()
    AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
    AND p.is_active AND p.principal_type = 'HUMAN_USER'
    AND (SELECT count(*) FROM hon.principals o WHERE o.user_id = p.user_id AND o.is_active) = 1
    AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id = p.id)
$$;

-- The confirmed phone a user gave for HQ texts. 0282 replaces this body; until then no user has one.
CREATE FUNCTION hon.hq_contact_sms_address(p_user uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$ SELECT NULL::text $$;

-- ---------- projections ----------
CREATE FUNCTION hon.hq_communication_person_json(p_principal uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN p_principal IS NULL THEN NULL ELSE (SELECT jsonb_build_object('principalId', p.id,
    'displayName', left(coalesce(nullif(btrim(u.display_name), ''), 'Team member'), 120))
    FROM hon.principals p JOIN hon.users u ON u.id = p.user_id WHERE p.id = p_principal) END
$$;

CREATE FUNCTION hon.hq_communication_sender_json(s hon.hq_communication_senders) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('senderId', s.id, 'channel', s.channel, 'status', s.status,
    'emailFrom', s.email_from, 'emailDisplayName', s.email_display_name, 'smsServiceSid', s.sms_service_sid, 'smsReplyNumber', s.sms_reply_number, 'a2pState', s.a2p_state,
    'mmsConverterConfirmed', s.mms_converter_confirmed, 'createdBy', hon.hq_communication_person_json(s.created_by),
    'createdAt', hon.saas_ts(s.created_at), 'version', s.version) END
$$;

CREATE FUNCTION hon.hq_message_json(m hon.hq_messages) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('messageId', m.id, 'organizationId', m.organization_id,
    'organizationDisplayName', left((SELECT o.display_name FROM hon.organizations o WHERE o.id = m.organization_id), 300),
    'schoolId', m.school_id, 'schoolDisplayName', left((SELECT s.name FROM hon.schools s WHERE s.id = m.school_id), 300),
    'purpose', m.purpose, 'channel', m.channel, 'content', m.content, 'supportCaseId', m.support_case_id, 'status', m.status,
    'recipientCount', m.recipient_count, 'createdBy', hon.hq_communication_person_json(m.created_by), 'createdAt', hon.saas_ts(m.created_at),
    'queuedAt', hon.saas_ts(m.queued_at), 'cancelledAt', hon.saas_ts(m.cancelled_at), 'updatedAt', hon.saas_ts(m.updated_at),
    'version', m.version,
    'deliverySummary', (SELECT jsonb_build_object(
      'pending', count(*) FILTER (WHERE d.status IN ('PENDING','SENDING')), 'accepted', count(*) FILTER (WHERE d.status = 'ACCEPTED'),
      'delivered', count(*) FILTER (WHERE d.status = 'DELIVERED'), 'suppressed', count(*) FILTER (WHERE d.status = 'SUPPRESSED'),
      'failed', count(*) FILTER (WHERE d.status IN ('FAILED','BOUNCED')), 'unknown', count(*) FILTER (WHERE d.status = 'UNKNOWN'))
      FROM hon.hq_message_deliveries d WHERE d.message_id = m.id))
$$;

-- No address, provider message id or cost: HQ sees status, pieces and why.
CREATE FUNCTION hon.hq_message_delivery_json(d hon.hq_message_deliveries) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('deliveryId', d.id, 'recipient', hon.hq_communication_person_json(d.recipient_principal_id),
    'status', d.status::text, 'holdReason', d.hold_reason, 'attempt', d.attempt_count, 'provider', d.provider, 'sentAs', d.sent_as,
    'segments', d.segments, 'failureCode', d.failure_code, 'acceptedAt', hon.saas_ts(d.accepted_at), 'finalAt', hon.saas_ts(d.final_at),
    'updatedAt', hon.saas_ts(d.updated_at))
$$;

-- ---------- helpers ----------
CREATE FUNCTION hon.hq_communication_claim(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prior hon.hq_communication_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-communication:' || p_actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO prior FROM hon.hq_communication_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.operation <> p_operation OR prior.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  RETURN prior.response || jsonb_build_object('replayed', true);
END $$;

CREATE FUNCTION hon.hq_communication_keys(p_input jsonb, p_keys text[]) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(p_keys) k) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
END $$;

CREATE FUNCTION hon.hq_communication_uuid(p_input jsonb, p_key text, p_nullable boolean) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF p_nullable AND jsonb_typeof(p_input->p_key) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_input->p_key) IS DISTINCT FROM 'string'
    OR (p_input->>p_key) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN (p_input->>p_key)::uuid;
END $$;

CREATE FUNCTION hon.hq_communication_expected(p_input jsonb) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  PERFORM hon.hq_communication_keys(p_input, ARRAY['expectedVersion']);
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN (p_input->>'expectedVersion')::integer;
END $$;

CREATE FUNCTION hon.hq_message_lock(p_message uuid, p_expected integer) RETURNS hon.hq_messages
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE m hon.hq_messages%ROWTYPE;
BEGIN
  SELECT * INTO m FROM hon.hq_messages WHERE id = p_message FOR UPDATE;
  IF m.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN m;
END $$;

-- One audit row per delivery transition (actor = the fixed HQ delivery principal).
CREATE FUNCTION hon.hq_message_delivery_evidence(p_delivery hon.hq_message_deliveries, p_prior_status text, p_action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_request uuid := gen_random_uuid();
BEGIN
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (p_delivery.organization_id, p_delivery.school_id, '00000000-0000-4000-8000-00000000c281', 'INTEGRATION', p_action,
    'HQ_MESSAGE_DELIVERY', p_delivery.id,
    CASE WHEN p_prior_status IS NULL THEN NULL ELSE jsonb_build_object('status', p_prior_status) END,
    jsonb_build_object('hqMessageDeliveryId', p_delivery.id, 'hqMessageId', p_delivery.message_id, 'channel', p_delivery.channel,
      'status', p_delivery.status::text, 'holdReason', p_delivery.hold_reason, 'attempt', p_delivery.attempt_count,
      'provider', p_delivery.provider, 'sentAs', p_delivery.sent_as, 'segments', p_delivery.segments,
      'failureCode', p_delivery.failure_code, 'version', p_delivery.version),
    'SUCCEEDED', v_request, v_request, now());
END $$;

CREATE FUNCTION hon.hq_contact_record_opt_out(p_user uuid, p_channel text, p_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  INSERT INTO hon.hq_contact_preferences (user_id, channel, status, source, captured_at)
  VALUES (p_user, p_channel, 'OPTED_OUT', 'RECIPIENT', p_at)
  ON CONFLICT (user_id, channel) DO UPDATE SET status = 'OPTED_OUT', source = 'RECIPIENT', captured_at = EXCLUDED.captured_at,
    version = hon.hq_contact_preferences.version + 1
  WHERE hon.hq_contact_preferences.status <> 'OPTED_OUT';
END $$;

-- ---------- sender commands (HQ owner only) ----------
-- SET: {channel, emailFrom, emailDisplayName, smsServiceSid, smsReplyNumber, a2pState, mmsConverterConfirmed}
CREATE FUNCTION hon.set_hq_communication_sender(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; s hon.hq_communication_senders%ROWTYPE; fp text; at timestamptz := clock_timestamp(); result jsonb; ch text;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, 'OWNER');
  PERFORM hon.hq_communication_keys(p_input, ARRAY['a2pState','channel','emailDisplayName','emailFrom','mmsConverterConfirmed','smsReplyNumber','smsServiceSid']);
  ch := p_input->>'channel';
  IF jsonb_typeof(p_input->'channel') IS DISTINCT FROM 'string' OR ch NOT IN ('EMAIL','SMS') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF ch = 'EMAIL' AND (jsonb_typeof(p_input->'emailFrom') IS DISTINCT FROM 'string'
      OR (p_input->>'emailFrom') !~ '^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$'
      OR jsonb_typeof(p_input->'emailDisplayName') IS DISTINCT FROM 'string'
      OR (p_input->>'emailDisplayName') <> btrim(p_input->>'emailDisplayName') OR length(p_input->>'emailDisplayName') NOT BETWEEN 1 AND 80
      OR (p_input->>'emailDisplayName') ~ '[[:cntrl:]<>]'
      OR jsonb_typeof(p_input->'smsServiceSid') <> 'null' OR jsonb_typeof(p_input->'smsReplyNumber') <> 'null' OR jsonb_typeof(p_input->'a2pState') <> 'null'
      OR jsonb_typeof(p_input->'mmsConverterConfirmed') <> 'null') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF ch = 'SMS' AND (jsonb_typeof(p_input->'smsServiceSid') IS DISTINCT FROM 'string' OR (p_input->>'smsServiceSid') !~ '^MG[0-9a-f]{32}$'
      OR jsonb_typeof(p_input->'smsReplyNumber') IS DISTINCT FROM 'string' OR (p_input->>'smsReplyNumber') !~ '^\+[1-9][0-9]{7,14}$'
      OR jsonb_typeof(p_input->'a2pState') IS DISTINCT FROM 'string'
      OR (p_input->>'a2pState') NOT IN ('NOT_REGISTERED','PENDING','REGISTERED_SERVICE','REGISTERED_MARKETING')
      OR (p_input->'mmsConverterConfirmed') IS DISTINCT FROM 'true'::jsonb
      OR jsonb_typeof(p_input->'emailFrom') <> 'null' OR jsonb_typeof(p_input->'emailDisplayName') <> 'null') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  fp := hon.saas_fingerprint(ARRAY['hq.communication.sender.set', p_input::text]);
  replay := hon.hq_communication_claim(actor, p_key, 'SENDER_SET', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER'); RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hq-communication-sender:' || ch, 0));
  IF EXISTS (SELECT 1 FROM hon.hq_communication_senders WHERE channel = ch AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'HQ_SENDER_EXISTS' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.hq_communication_senders (channel, status, email_from, email_display_name, sms_service_sid, sms_reply_number, a2p_state,
    mms_converter_confirmed, created_by, created_at)
  VALUES (ch, 'ACTIVE', p_input->>'emailFrom', p_input->>'emailDisplayName', p_input->>'smsServiceSid', p_input->>'smsReplyNumber', p_input->>'a2pState',
    CASE WHEN ch = 'SMS' THEN true END, actor, at)
  RETURNING * INTO s;
  result := jsonb_build_object('operation', 'SENDER_SET', 'sender', hon.hq_communication_sender_json(s));
  INSERT INTO hon.hq_communication_requests VALUES (actor, p_key, 'SENDER_SET', fp, result, at);
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result || jsonb_build_object('replayed', false);
END $$;

CREATE FUNCTION hon.retire_hq_communication_sender(p_subject text, p_sender uuid, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; s hon.hq_communication_senders%ROWTYPE; fp text; at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, 'OWNER');
  IF p_sender IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  fp := hon.saas_fingerprint(ARRAY['hq.communication.sender.retire', p_sender::text]);
  replay := hon.hq_communication_claim(actor, p_key, 'SENDER_RETIRE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER'); RETURN replay; END IF;
  SELECT * INTO s FROM hon.hq_communication_senders WHERE id = p_sender FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF s.status <> 'ACTIVE' THEN RAISE EXCEPTION 'HQ_SENDER_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  UPDATE hon.hq_communication_senders SET status = 'RETIRED', retired_by = actor, retired_at = at, version = version + 1
  WHERE id = s.id RETURNING * INTO s;
  result := jsonb_build_object('operation', 'SENDER_RETIRE', 'sender', hon.hq_communication_sender_json(s));
  INSERT INTO hon.hq_communication_requests VALUES (actor, p_key, 'SENDER_RETIRE', fp, result, at);
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- message commands ----------
-- CREATE: {organizationId, schoolId, purpose, channel, content, supportCaseId|null}
CREATE FUNCTION hon.create_hq_message(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; m hon.hq_messages%ROWTYPE; fp text; at timestamptz := clock_timestamp(); result jsonb;
  v_org uuid; v_school uuid; v_case uuid; v_purpose text; v_channel text; v_content text;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, NULL);
  PERFORM hon.hq_communication_keys(p_input, ARRAY['channel','content','organizationId','purpose','schoolId','supportCaseId']);
  v_org := hon.hq_communication_uuid(p_input, 'organizationId', false);
  v_school := hon.hq_communication_uuid(p_input, 'schoolId', false);
  v_case := hon.hq_communication_uuid(p_input, 'supportCaseId', true);
  v_purpose := p_input->>'purpose'; v_channel := p_input->>'channel'; v_content := p_input->>'content';
  IF jsonb_typeof(p_input->'purpose') IS DISTINCT FROM 'string' OR v_purpose NOT IN ('SUPPORT','BILLING','ONBOARDING','ACCOUNT')
    OR jsonb_typeof(p_input->'channel') IS DISTINCT FROM 'string' OR v_channel NOT IN ('EMAIL','SMS') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.require_hq_communication_actor(p_subject, v_purpose);
  -- Whole text, trimmed, no control characters other than line breaks and tabs. Nothing is ever cut short.
  IF jsonb_typeof(p_input->'content') IS DISTINCT FROM 'string' OR v_content <> btrim(v_content) OR length(v_content) < 1
    OR length(v_content) > (ARRAY[1600, 4000])[1 + (v_channel = 'EMAIL')::integer]
    OR v_content ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  fp := hon.saas_fingerprint(ARRAY['hq.communication.create', p_input::text]);
  replay := hon.hq_communication_claim(actor, p_key, 'CREATE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_communication_actor(p_subject, v_purpose); RETURN replay; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.schools WHERE id = v_school AND organization_id = v_org)
    OR (v_case IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hon.hq_support_cases c WHERE c.id = v_case AND c.organization_id = v_org AND c.school_id = v_school)) THEN
    RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO hon.hq_messages (organization_id, school_id, purpose, channel, content, support_case_id, status, created_by, created_at, updated_at)
  VALUES (v_org, v_school, v_purpose, v_channel, v_content, v_case, 'DRAFT', actor, at, at) RETURNING * INTO m;
  result := jsonb_build_object('operation', 'CREATE', 'message', hon.hq_message_json(m));
  INSERT INTO hon.hq_communication_requests VALUES (actor, p_key, 'CREATE', fp, result, at);
  PERFORM hon.require_hq_communication_actor(p_subject, v_purpose);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- QUEUE: {expectedVersion}. One delivery per current non-HQ owner of the school.
CREATE FUNCTION hon.queue_hq_message(p_subject text, p_message uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; m hon.hq_messages%ROWTYPE; d hon.hq_message_deliveries%ROWTYPE; fp text; at timestamptz := clock_timestamp();
  result jsonb; v_expected integer; n integer := 0; rcp record;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, NULL);
  IF p_message IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  v_expected := hon.hq_communication_expected(p_input);
  fp := hon.saas_fingerprint(ARRAY['hq.communication.queue', p_message::text, p_input::text]);
  replay := hon.hq_communication_claim(actor, p_key, 'QUEUE', fp);
  m := hon.hq_message_lock(p_message, v_expected);
  PERFORM hon.require_hq_communication_actor(p_subject, m.purpose);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF m.version <> v_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF m.status <> 'DRAFT' THEN RAISE EXCEPTION 'HQ_MESSAGE_NOT_DRAFT' USING ERRCODE = '23514'; END IF;
  FOR rcp IN SELECT * FROM hon.hq_message_owner_recipients(m.school_id) ORDER BY principal_id LIMIT 100 LOOP
    INSERT INTO hon.hq_message_deliveries (organization_id, school_id, message_id, recipient_principal_id, channel)
    VALUES (m.organization_id, m.school_id, m.id, rcp.principal_id, m.channel) RETURNING * INTO d;
    PERFORM hon.hq_message_delivery_evidence(d, NULL, 'hq.communication.delivery.created');
    n := n + 1;
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'HQ_MESSAGE_NO_RECIPIENTS' USING ERRCODE = '23514'; END IF;
  UPDATE hon.hq_messages SET status = 'QUEUED', recipient_count = n, queued_by = actor, queued_at = at, updated_at = at, version = version + 1
  WHERE id = m.id RETURNING * INTO m;
  result := jsonb_build_object('operation', 'QUEUE', 'message', hon.hq_message_json(m));
  INSERT INTO hon.hq_communication_requests VALUES (actor, p_key, 'QUEUE', fp, result, at);
  PERFORM hon.require_hq_communication_actor(p_subject, m.purpose);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- CANCEL: {expectedVersion}. Only while no delivery has been handed to a provider.
CREATE FUNCTION hon.cancel_hq_message(p_subject text, p_message uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; m hon.hq_messages%ROWTYPE; d hon.hq_message_deliveries%ROWTYPE; fp text; at timestamptz := clock_timestamp();
  result jsonb; v_expected integer;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, NULL);
  IF p_message IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  v_expected := hon.hq_communication_expected(p_input);
  fp := hon.saas_fingerprint(ARRAY['hq.communication.cancel', p_message::text, p_input::text]);
  replay := hon.hq_communication_claim(actor, p_key, 'CANCEL', fp);
  m := hon.hq_message_lock(p_message, v_expected);
  PERFORM hon.require_hq_communication_actor(p_subject, m.purpose);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF m.version <> v_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  -- Lock every delivery first (waiting out any claim in flight), then check: a row a worker is moving to
  -- SENDING is seen as SENDING here, and a claim that starts after this lock skips the locked rows.
  PERFORM 1 FROM hon.hq_message_deliveries x WHERE x.message_id = m.id ORDER BY x.id FOR UPDATE;
  IF m.status = 'CANCELLED' OR EXISTS (SELECT 1 FROM hon.hq_message_deliveries x WHERE x.message_id = m.id
      AND x.status NOT IN ('PENDING','SUPPRESSED')) THEN
    RAISE EXCEPTION 'HQ_MESSAGE_NOT_CANCELLABLE' USING ERRCODE = '23514';
  END IF;
  FOR d IN SELECT * FROM hon.hq_message_deliveries x WHERE x.message_id = m.id AND x.status = 'PENDING' ORDER BY x.id FOR UPDATE LOOP
    UPDATE hon.hq_message_deliveries SET status = 'SUPPRESSED', hold_reason = NULL, failure_code = 'CANCELLED', final_at = at,
      version = version + 1, updated_at = at WHERE id = d.id RETURNING * INTO d;
    PERFORM hon.hq_message_delivery_evidence(d, 'PENDING', 'hq.communication.delivery.cancelled');
  END LOOP;
  UPDATE hon.hq_messages SET status = 'CANCELLED', cancelled_by = actor, cancelled_at = at, updated_at = at, version = version + 1
  WHERE id = m.id RETURNING * INTO m;
  result := jsonb_build_object('operation', 'CANCEL', 'message', hon.hq_message_json(m));
  INSERT INTO hon.hq_communication_requests VALUES (actor, p_key, 'CANCEL', fp, result, at);
  PERFORM hon.require_hq_communication_actor(p_subject, m.purpose);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- reads ----------
-- The senders, and a page of messages the reader may see (only purposes they hold), newest first.
CREATE FUNCTION hon.read_hq_communications(p_subject text, p_school uuid, p_cursor_at timestamptz, p_cursor_id uuid, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; purposes text[]; v_rows jsonb; n integer; v_last hon.hq_messages%ROWTYPE; result jsonb; at timestamptz := clock_timestamp();
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, NULL);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR (p_cursor_at IS NULL) <> (p_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  purposes := hon.hq_communication_purposes(actor);
  WITH page AS (
    SELECT m AS r, date_trunc('milliseconds', m.created_at) AS created_at, m.id FROM hon.hq_messages m
    WHERE m.purpose = ANY(purposes) AND (p_school IS NULL OR m.school_id = p_school)
      -- Order at the millisecond the API shows, so the cursor never skips a row (as in 0203).
      AND (p_cursor_at IS NULL OR (date_trunc('milliseconds', m.created_at), m.id) < (p_cursor_at, p_cursor_id))
    ORDER BY date_trunc('milliseconds', m.created_at) DESC, m.id DESC LIMIT p_limit)
  SELECT coalesce(jsonb_agg(hon.hq_message_json(page.r) ORDER BY page.created_at DESC, page.id DESC), '[]'::jsonb), count(*) INTO v_rows, n FROM page;
  IF n = p_limit THEN SELECT * INTO v_last FROM hon.hq_messages WHERE id = (v_rows->(n - 1)->>'messageId')::uuid; END IF;
  result := jsonb_build_object(
    'senders', jsonb_build_object(
      'EMAIL', (SELECT hon.hq_communication_sender_json(s) FROM hon.hq_communication_senders s WHERE s.channel = 'EMAIL' AND s.status = 'ACTIVE'),
      'SMS', (SELECT hon.hq_communication_sender_json(s) FROM hon.hq_communication_senders s WHERE s.channel = 'SMS' AND s.status = 'ACTIVE')),
    'messages', v_rows, 'limit', p_limit,
    'nextCursor', CASE WHEN n = p_limit THEN jsonb_build_object('createdAt', hon.saas_ts(v_last.created_at), 'messageId', v_last.id) END,
    'viewer', hon.hq_communication_person_json(actor) || jsonb_build_object('purposes', to_jsonb(purposes),
      'canManageSenders', hon.hq_communication_is_owner(actor)),
    'asOf', hon.saas_ts(at));
  PERFORM hon.require_hq_communication_actor(p_subject, NULL);
  RETURN result;
END $$;

CREATE FUNCTION hon.read_hq_message(p_subject text, p_message uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; m hon.hq_messages%ROWTYPE; result jsonb;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, NULL);
  IF p_message IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO m FROM hon.hq_messages WHERE id = p_message;
  IF m.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.require_hq_communication_actor(p_subject, m.purpose);
  result := jsonb_build_object('message', hon.hq_message_json(m),
    'deliveries', (SELECT coalesce(jsonb_agg(hon.hq_message_delivery_json(d) ORDER BY d.created_at, d.id), '[]'::jsonb)
      FROM hon.hq_message_deliveries d WHERE d.message_id = m.id),
    'viewer', hon.hq_communication_person_json(actor), 'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_communication_actor(p_subject, m.purpose);
  RETURN result;
END $$;

-- ---------- worker ----------
CREATE FUNCTION hon.reconcile_expired_hq_message_leases(p_limit integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_row hon.hq_message_deliveries; v_count integer := 0;
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'HQ message lease reconciliation limit must be between 1 and 100.' USING ERRCODE = '22023';
  END IF;
  FOR v_row IN SELECT * FROM hon.hq_message_deliveries WHERE status = 'SENDING' AND lease_expires_at <= now()
    ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT p_limit LOOP
    UPDATE hon.hq_message_deliveries SET status = 'UNKNOWN', failure_code = 'LEASE_EXPIRED', lease_token = NULL, lease_expires_at = NULL,
      final_at = now(), version = version + 1, updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
    PERFORM hon.hq_message_delivery_evidence(v_row, 'SENDING', 'hq.communication.delivery.lease_expired');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- Leases due HQ deliveries. Re-checks, at send time: the message is still queued, the recipient is still a current owner,
-- they have not opted out of HQ messages on this channel, an address exists, an HQ sender is active, the attempt limit
-- and (for texts) quiet hours 21:00-08:00 school time.
CREATE FUNCTION hon.claim_hq_message_deliveries(p_channels text[], p_limit integer, p_lease_seconds integer DEFAULT 60)
RETURNS TABLE (delivery_id uuid, lease_token uuid, organization_id uuid, school_id uuid, message_id uuid, channel text,
  recipient_address text, content text, sender_ref text, sender_name text, attempt integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE v_delivery hon.hq_message_deliveries; v_message hon.hq_messages; v_sender hon.hq_communication_senders; v_prior text;
  v_user uuid; v_address text; v_zone text; v_local timestamp; v_wake timestamptz; v_token uuid; v_fail text;
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'HQ message claim limit must be between 1 and 100.' USING ERRCODE = '22023'; END IF;
  IF p_lease_seconds < 15 OR p_lease_seconds > 300 THEN RAISE EXCEPTION 'HQ message lease must be between 15 and 300 seconds.' USING ERRCODE = '22023'; END IF;
  IF p_channels IS NULL OR cardinality(p_channels) < 1 OR NOT (p_channels <@ ARRAY['EMAIL','SMS']) THEN
    RAISE EXCEPTION 'HQ message claim channels must be EMAIL and/or SMS.' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.reconcile_expired_hq_message_leases(p_limit);
  FOR v_delivery IN SELECT d.* FROM hon.hq_message_deliveries d
    WHERE d.status = 'PENDING' AND d.channel = ANY (p_channels) AND d.next_attempt_at <= now()
    ORDER BY d.next_attempt_at, d.id FOR UPDATE OF d SKIP LOCKED LIMIT p_limit LOOP
    v_prior := v_delivery.status::text;
    SELECT * INTO v_message FROM hon.hq_messages WHERE id = v_delivery.message_id;
    SELECT p.user_id INTO v_user FROM hon.principals p WHERE p.id = v_delivery.recipient_principal_id;
    v_fail := NULL;
    IF v_message.status <> 'QUEUED' THEN v_fail := 'CANCELLED';
    ELSIF v_delivery.attempt_count >= 5 THEN v_fail := 'RETRIES_EXHAUSTED';
    ELSIF NOT EXISTS (SELECT 1 FROM hon.hq_message_owner_recipients(v_delivery.school_id) r WHERE r.principal_id = v_delivery.recipient_principal_id) THEN
      v_fail := 'RECIPIENT_REMOVED';
    -- An email opt-out does not stop BILLING or ACCOUNT notices (owner decision 2026-11-12): they are required notices about the
    -- school's own HON account. Support and onboarding email, and every text, honor the opt-out.
    ELSIF EXISTS (SELECT 1 FROM hon.hq_contact_preferences c WHERE c.user_id = v_user AND c.channel = v_delivery.channel AND c.status = 'OPTED_OUT')
        AND NOT (v_delivery.channel = 'EMAIL' AND v_message.purpose IN ('BILLING','ACCOUNT'))
      -- Texts also need the person's own HQ texting opt-in (recorded by 0282 after they confirm their phone).
      OR (v_delivery.channel = 'SMS' AND NOT EXISTS (SELECT 1 FROM hon.hq_contact_preferences c WHERE c.user_id = v_user
        AND c.channel = 'SMS' AND c.status = 'OPTED_IN')) THEN
      v_fail := 'CONSENT_MISSING';
    ELSE
      v_address := CASE v_delivery.channel WHEN 'EMAIL' THEN (SELECT u.email::text FROM hon.users u WHERE u.id = v_user)
        ELSE hon.hq_contact_sms_address(v_user) END;
      IF v_address IS NULL OR btrim(v_address) = '' THEN v_fail := 'ADDRESS_MISSING'; END IF;
    END IF;
    IF v_fail IS NOT NULL THEN
      UPDATE hon.hq_message_deliveries SET status = CASE WHEN v_fail = 'RETRIES_EXHAUSTED' THEN 'FAILED' ELSE 'SUPPRESSED' END::hon.communication_delivery_status,
        hold_reason = NULL, failure_code = v_fail, final_at = now(), version = version + 1, updated_at = now()
      WHERE id = v_delivery.id RETURNING * INTO v_delivery;
      PERFORM hon.hq_message_delivery_evidence(v_delivery, v_prior, 'hq.communication.delivery.' || lower(v_delivery.status::text));
      CONTINUE;
    END IF;

    v_sender := NULL;
    SELECT * INTO v_sender FROM hon.hq_communication_senders s WHERE s.channel = v_delivery.channel AND s.status = 'ACTIVE';
    IF v_sender.id IS NULL THEN
      IF v_delivery.hold_reason IS DISTINCT FROM 'NO_SENDER' THEN
        UPDATE hon.hq_message_deliveries SET hold_reason = 'NO_SENDER', next_attempt_at = now() + interval '1 hour', version = version + 1,
          updated_at = now() WHERE id = v_delivery.id RETURNING * INTO v_delivery;
        PERFORM hon.hq_message_delivery_evidence(v_delivery, v_prior, 'hq.communication.delivery.held');
      ELSE
        UPDATE hon.hq_message_deliveries SET next_attempt_at = now() + interval '1 hour' WHERE id = v_delivery.id;
      END IF;
      CONTINUE;
    END IF;

    IF v_delivery.channel = 'SMS' THEN
      SELECT s.timezone INTO v_zone FROM hon.schools s WHERE s.id = v_delivery.school_id;
      v_local := now() AT TIME ZONE v_zone;
      IF v_local::time >= time '21:00' OR v_local::time < time '08:00' THEN
        v_wake := (date_trunc('day', v_local) + CASE WHEN v_local::time >= time '21:00' THEN interval '1 day' ELSE interval '0' END
          + interval '8 hours') AT TIME ZONE v_zone;
        IF v_delivery.hold_reason IS DISTINCT FROM 'QUIET_HOURS' THEN
          UPDATE hon.hq_message_deliveries SET hold_reason = 'QUIET_HOURS', next_attempt_at = v_wake, version = version + 1, updated_at = now()
          WHERE id = v_delivery.id RETURNING * INTO v_delivery;
          PERFORM hon.hq_message_delivery_evidence(v_delivery, v_prior, 'hq.communication.delivery.held');
        ELSE
          UPDATE hon.hq_message_deliveries SET next_attempt_at = v_wake WHERE id = v_delivery.id;
        END IF;
        CONTINUE;
      END IF;
    END IF;

    v_token := gen_random_uuid();
    UPDATE hon.hq_message_deliveries SET status = 'SENDING', hold_reason = NULL, attempt_count = attempt_count + 1, lease_token = v_token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds), sender_id = v_sender.id, version = version + 1, updated_at = now()
    WHERE id = v_delivery.id RETURNING * INTO v_delivery;
    PERFORM hon.hq_message_delivery_evidence(v_delivery, v_prior, 'hq.communication.delivery.leased');
    delivery_id := v_delivery.id; lease_token := v_token; organization_id := v_delivery.organization_id; school_id := v_delivery.school_id;
    message_id := v_delivery.message_id; channel := v_delivery.channel; recipient_address := v_address; content := v_message.content;
    sender_ref := CASE v_delivery.channel WHEN 'EMAIL' THEN v_sender.email_from ELSE v_sender.sms_service_sid END;
    sender_name := coalesce(v_sender.email_display_name, 'HON OS'); attempt := v_delivery.attempt_count;
    RETURN NEXT;
  END LOOP;
END $$;

CREATE FUNCTION hon.record_hq_message_send_result(
  p_delivery_id uuid, p_lease_token uuid, p_outcome text, p_provider text, p_provider_message_id text,
  p_sent_as text, p_segments integer, p_encoding text, p_failure_code text, p_retry_after_seconds integer)
RETURNS TABLE (status text, accepted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE v_row hon.hq_message_deliveries; v_prior text;
BEGIN
  IF p_outcome NOT IN ('ACCEPTED','RETRYABLE','FAILED','UNKNOWN') THEN RAISE EXCEPTION 'HQ message send outcome is invalid.' USING ERRCODE = '22023'; END IF;
  IF p_provider NOT IN ('FAKE','SENDGRID','TWILIO') THEN RAISE EXCEPTION 'HQ message provider is invalid.' USING ERRCODE = '22023'; END IF;
  IF p_outcome = 'ACCEPTED' AND (p_provider_message_id IS NULL OR p_sent_as IS NULL) THEN
    RAISE EXCEPTION 'HQ accepted message needs a provider message id and sent-as.' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'FAILED' AND p_failure_code NOT IN ('PROVIDER_REJECTED','INVALID_ADDRESS','PROVIDER_FAILED') THEN
    RAISE EXCEPTION 'HQ failed message needs a closed failure code.' USING ERRCODE = '22023';
  END IF;
  IF p_retry_after_seconds IS NOT NULL AND (p_retry_after_seconds < 30 OR p_retry_after_seconds > 86400) THEN
    RAISE EXCEPTION 'HQ message retry delay must be between 30 seconds and one day.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM hon.hq_message_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HQ message delivery was not found.' USING ERRCODE = 'P0002'; END IF;
  v_prior := v_row.status::text;
  IF v_row.status <> 'SENDING' OR v_row.lease_token IS DISTINCT FROM p_lease_token OR v_row.lease_expires_at <= now() THEN
    IF v_row.status = 'SENDING' AND v_row.lease_token = p_lease_token THEN
      UPDATE hon.hq_message_deliveries SET status = 'UNKNOWN', failure_code = 'LEASE_EXPIRED', lease_token = NULL, lease_expires_at = NULL,
        final_at = now(), version = version + 1, updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
      PERFORM hon.hq_message_delivery_evidence(v_row, v_prior, 'hq.communication.delivery.lease_expired');
    END IF;
    status := v_row.status::text; accepted := false; RETURN NEXT; RETURN;
  END IF;
  IF p_outcome = 'ACCEPTED' THEN
    UPDATE hon.hq_message_deliveries SET status = 'ACCEPTED', provider = p_provider, provider_message_id = p_provider_message_id, sent_as = p_sent_as,
      segments = p_segments, encoding = p_encoding, accepted_at = now(), lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = now()
    WHERE id = v_row.id RETURNING * INTO v_row;
  ELSIF p_outcome = 'RETRYABLE' AND v_row.attempt_count < 5 THEN
    UPDATE hon.hq_message_deliveries SET status = 'PENDING', hold_reason = 'RETRY_WAIT', provider = p_provider, lease_token = NULL, lease_expires_at = NULL,
      next_attempt_at = now() + make_interval(secs => coalesce(p_retry_after_seconds, 60 * power(2, v_row.attempt_count)::integer)),
      version = version + 1, updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
  ELSIF p_outcome IN ('RETRYABLE','FAILED') THEN
    UPDATE hon.hq_message_deliveries SET status = 'FAILED', provider = p_provider,
      failure_code = CASE WHEN p_outcome = 'RETRYABLE' THEN 'RETRIES_EXHAUSTED' ELSE p_failure_code END,
      lease_token = NULL, lease_expires_at = NULL, final_at = now(), version = version + 1, updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
  ELSE
    UPDATE hon.hq_message_deliveries SET status = 'UNKNOWN', provider = p_provider, failure_code = 'PROVIDER_UNKNOWN', lease_token = NULL,
      lease_expires_at = NULL, final_at = now(), version = version + 1, updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
  END IF;
  PERFORM hon.hq_message_delivery_evidence(v_row, v_prior, 'hq.communication.delivery.' || lower(p_outcome));
  status := v_row.status::text; accepted := true; RETURN NEXT;
END $$;

-- Applies one verified provider receipt for an HQ send. Idempotent per (provider, event id); status moves only forward.
CREATE FUNCTION hon.record_hq_message_provider_event(
  p_provider text, p_provider_event_id text, p_provider_message_id text, p_hon_delivery_id uuid,
  p_event_type text, p_occurred_at timestamptz, p_provider_cost_microunits bigint)
RETURNS TABLE (outcome text, delivery_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE v_row hon.hq_message_deliveries; v_prior text; v_next hon.communication_delivery_status; v_failure text; v_user uuid;
  v_rank_prior integer; v_rank_next integer;
BEGIN
  IF p_provider NOT IN ('FAKE','SENDGRID','TWILIO') THEN RAISE EXCEPTION 'HQ message provider is invalid.' USING ERRCODE = '22023'; END IF;
  IF p_event_type NOT IN ('SENT','DELIVERED','DEFERRED','BOUNCED','DROPPED','UNDELIVERED','FAILED','UNSUBSCRIBED','SPAM_REPORT') THEN
    RAISE EXCEPTION 'HQ message event type is invalid.' USING ERRCODE = '22023';
  END IF;
  IF p_occurred_at IS NULL OR p_occurred_at > now() + interval '10 minutes' OR p_occurred_at < now() - interval '30 days' THEN
    RAISE EXCEPTION 'HQ message event time is out of range.' USING ERRCODE = '22023';
  END IF;
  IF p_provider_cost_microunits IS NOT NULL AND (p_provider_cost_microunits < 0 OR p_provider_cost_microunits > 1000000000) THEN
    RAISE EXCEPTION 'HQ message provider cost is out of range.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.hq_message_delivery_events e WHERE e.provider = p_provider AND e.provider_event_id = p_provider_event_id) THEN
    outcome := 'REPLAYED';
    SELECT d.status::text INTO delivery_status FROM hon.hq_message_delivery_events e JOIN hon.hq_message_deliveries d ON d.id = e.delivery_id
      WHERE e.provider = p_provider AND e.provider_event_id = p_provider_event_id;
    RETURN NEXT; RETURN;
  END IF;
  SELECT * INTO v_row FROM hon.hq_message_deliveries d WHERE d.provider = p_provider AND d.provider_message_id = p_provider_message_id FOR UPDATE;
  IF NOT FOUND AND p_hon_delivery_id IS NOT NULL THEN
    SELECT * INTO v_row FROM hon.hq_message_deliveries d
    WHERE d.id = p_hon_delivery_id AND d.provider_message_id IS NULL AND d.status IN ('UNKNOWN','SENDING') AND (d.provider IS NULL OR d.provider = p_provider)
    FOR UPDATE;
  END IF;
  IF NOT FOUND OR (p_hon_delivery_id IS NOT NULL AND v_row.id <> p_hon_delivery_id) THEN
    outcome := 'UNMATCHED'; delivery_status := NULL; RETURN NEXT; RETURN;
  END IF;
  INSERT INTO hon.hq_message_delivery_events (delivery_id, provider, provider_event_id, event_type, occurred_at)
  VALUES (v_row.id, p_provider, p_provider_event_id, p_event_type::hon.communication_delivery_event_type, p_occurred_at);
  v_prior := v_row.status::text;
  v_next := CASE p_event_type WHEN 'DELIVERED' THEN 'DELIVERED' WHEN 'BOUNCED' THEN 'BOUNCED' WHEN 'DROPPED' THEN 'FAILED'
    WHEN 'UNDELIVERED' THEN 'FAILED' WHEN 'FAILED' THEN 'FAILED' WHEN 'SENT' THEN 'ACCEPTED' ELSE NULL END;
  v_failure := CASE p_event_type WHEN 'BOUNCED' THEN 'BOUNCED' WHEN 'DROPPED' THEN 'DROPPED' WHEN 'UNDELIVERED' THEN 'UNDELIVERED'
    WHEN 'FAILED' THEN 'PROVIDER_FAILED' ELSE NULL END;
  v_rank_prior := CASE v_row.status WHEN 'SENDING' THEN 0 WHEN 'UNKNOWN' THEN 0 WHEN 'ACCEPTED' THEN 1 ELSE 2 END;
  v_rank_next := CASE v_next WHEN 'ACCEPTED' THEN 1 ELSE 2 END;
  IF v_next IS NOT NULL AND v_rank_next > v_rank_prior AND v_row.status NOT IN ('PENDING','SUPPRESSED') THEN
    UPDATE hon.hq_message_deliveries SET status = v_next, provider = p_provider, provider_message_id = coalesce(provider_message_id, p_provider_message_id),
      accepted_at = coalesce(accepted_at, p_occurred_at), failure_code = v_failure, final_at = CASE WHEN v_rank_next = 2 THEN now() ELSE NULL END,
      lease_token = NULL, lease_expires_at = NULL, provider_cost_microunits = coalesce(p_provider_cost_microunits, provider_cost_microunits),
      version = version + 1, updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
    PERFORM hon.hq_message_delivery_evidence(v_row, v_prior, 'hq.communication.delivery.receipt');
  ELSIF p_provider_cost_microunits IS NOT NULL THEN
    UPDATE hon.hq_message_deliveries SET provider_cost_microunits = p_provider_cost_microunits, updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
  END IF;
  IF p_event_type IN ('UNSUBSCRIBED','SPAM_REPORT') THEN
    SELECT p.user_id INTO v_user FROM hon.principals p WHERE p.id = v_row.recipient_principal_id;
    PERFORM hon.hq_contact_record_opt_out(v_user, v_row.channel, p_occurred_at);
  END IF;
  outcome := 'RECORDED'; delivery_status := v_row.status::text; RETURN NEXT;
END $$;

-- ---------- privileges ----------
DO $$ DECLARE r text; t text; f text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker','hon_outbox_worker') LOOP
    FOREACH t IN ARRAY ARRAY['hq_communication_senders','hq_messages','hq_message_deliveries','hq_message_delivery_events','hq_contact_preferences','hq_communication_requests'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['guard_hq_communication_evidence()','guard_hq_message()','guard_hq_communication_sender()',
    'hq_communication_purposes(uuid)','hq_communication_is_owner(uuid)','require_hq_communication_actor(text,text)',
    'hq_message_owner_recipients(uuid)','hq_contact_sms_address(uuid)','hq_communication_person_json(uuid)',
    'hq_communication_sender_json(hon.hq_communication_senders)','hq_message_json(hon.hq_messages)','hq_message_delivery_json(hon.hq_message_deliveries)',
    'hq_communication_claim(uuid,uuid,text,text)','hq_communication_keys(jsonb,text[])','hq_communication_uuid(jsonb,text,boolean)',
    'hq_communication_expected(jsonb)','hq_message_lock(uuid,integer)','hq_message_delivery_evidence(hon.hq_message_deliveries,text,text)',
    'hq_contact_record_opt_out(uuid,text,timestamptz)',
    'set_hq_communication_sender(text,jsonb,uuid)','retire_hq_communication_sender(text,uuid,uuid)','create_hq_message(text,jsonb,uuid)',
    'queue_hq_message(text,uuid,jsonb,uuid)','cancel_hq_message(text,uuid,jsonb,uuid)','read_hq_communications(text,uuid,timestamptz,uuid,integer)',
    'read_hq_message(text,uuid)','reconcile_expired_hq_message_leases(integer)','claim_hq_message_deliveries(text[],integer,integer)',
    'record_hq_message_send_result(uuid,uuid,text,text,text,text,integer,text,text,integer)',
    'record_hq_message_provider_event(text,text,text,uuid,text,timestamptz,bigint)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker','hon_outbox_worker') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.set_hq_communication_sender(text,jsonb,uuid), hon.retire_hq_communication_sender(text,uuid,uuid),
      hon.create_hq_message(text,jsonb,uuid), hon.queue_hq_message(text,uuid,jsonb,uuid), hon.cancel_hq_message(text,uuid,jsonb,uuid),
      hon.read_hq_communications(text,uuid,timestamptz,uuid,integer), hon.read_hq_message(text,uuid) TO hon_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.reconcile_expired_hq_message_leases(integer), hon.claim_hq_message_deliveries(text[],integer,integer),
      hon.record_hq_message_send_result(uuid,uuid,text,text,text,text,integer,text,text,integer),
      hon.record_hq_message_provider_event(text,text,text,uuid,text,timestamptz,bigint) TO hon_communication_worker;
  END IF;
END $$;

COMMIT;
