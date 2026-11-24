BEGIN;
-- 0243 communication delivery and provider receipts (B-COM-1, docs/architecture/COMMUNICATION_DELIVERY.md).
-- A human-queued message (0047) is delivered by a dedicated worker login through three fixed functions.
-- No provider credential, address copy, message-body copy or raw provider payload is stored. Recipient
-- unsubscribe and spam reports record the person's consent as OPTED_OUT with source RECIPIENT.

-- Recipient-originated consent changes (unsubscribe link, spam report, STOP reply). Used only at run time
-- by plpgsql bodies below, so adding the value in this transaction is safe.
ALTER TYPE hon.communication_consent_source ADD VALUE IF NOT EXISTS 'RECIPIENT';

-- The fixed actor for delivery evidence and recipient-originated consent changes.
INSERT INTO hon.principals (id, principal_type, user_id, display_name, is_active)
VALUES ('00000000-0000-4000-8000-00000000c043', 'INTEGRATION', NULL, 'HON communication delivery', true)
ON CONFLICT (id) DO NOTHING;

CREATE TYPE hon.communication_delivery_status AS ENUM (
  'PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'BOUNCED', 'FAILED', 'SUPPRESSED', 'UNKNOWN'
);
CREATE TYPE hon.communication_delivery_event_type AS ENUM (
  'SENT', 'DELIVERED', 'DEFERRED', 'BOUNCED', 'DROPPED', 'UNDELIVERED', 'FAILED', 'UNSUBSCRIBED', 'SPAM_REPORT'
);
REVOKE USAGE ON TYPE hon.communication_delivery_status, hon.communication_delivery_event_type FROM PUBLIC;

CREATE TABLE hon.communication_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  message_id uuid NOT NULL,
  channel hon.communication_message_channel NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  status hon.communication_delivery_status NOT NULL DEFAULT 'PENDING',
  hold_reason text CHECK (hold_reason IN ('SCHEDULED', 'QUIET_HOURS', 'SCHOOL_INACTIVE', 'RETRY_WAIT')),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider text CHECK (provider IN ('FAKE', 'SENDGRID', 'TWILIO')),
  provider_message_id text CHECK (provider_message_id ~ '^[A-Za-z0-9._:@<>+=-]{1,200}$'),
  sent_as text CHECK (sent_as IN ('EMAIL', 'SMS', 'MMS')),
  segments integer CHECK (segments BETWEEN 1 AND 100),
  encoding text CHECK (encoding IN ('GSM7', 'UCS2')),
  provider_cost_microunits bigint CHECK (provider_cost_microunits BETWEEN 0 AND 1000000000),
  failure_code text CHECK (failure_code IN (
    'CONSENT_MISSING', 'ADDRESS_MISSING', 'LEASE_EXPIRED', 'PROVIDER_UNKNOWN', 'PROVIDER_REJECTED',
    'INVALID_ADDRESS', 'RETRIES_EXHAUSTED', 'BOUNCED', 'DROPPED', 'UNDELIVERED', 'PROVIDER_FAILED'
  )),
  accepted_at timestamptz,
  final_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (message_id, organization_id, school_id)
    REFERENCES hon.communication_messages(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (message_id),
  UNIQUE (id, organization_id, school_id),
  UNIQUE (provider, provider_message_id),
  CHECK ((status = 'SENDING') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (hold_reason IS NULL OR status = 'PENDING'),
  CHECK (status NOT IN ('ACCEPTED', 'DELIVERED') OR (provider IS NOT NULL AND provider_message_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK (status NOT IN ('SUPPRESSED', 'FAILED', 'UNKNOWN', 'BOUNCED') OR failure_code IS NOT NULL)
);
CREATE INDEX communication_deliveries_due_idx
  ON hon.communication_deliveries (status, channel, next_attempt_at) WHERE status IN ('PENDING', 'SENDING');
CREATE INDEX communication_deliveries_scope_idx
  ON hon.communication_deliveries (organization_id, school_id, created_at DESC);

CREATE TABLE hon.communication_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('FAKE', 'SENDGRID', 'TWILIO')),
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^[A-Za-z0-9._:@<>+=-]{1,200}$'),
  event_type hon.communication_delivery_event_type NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (delivery_id, organization_id, school_id)
    REFERENCES hon.communication_deliveries(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX communication_delivery_events_delivery_idx
  ON hon.communication_delivery_events (organization_id, school_id, delivery_id, occurred_at, id);

ALTER TABLE hon.communication_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.communication_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_deliveries_tenant_isolation ON hon.communication_deliveries
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
ALTER TABLE hon.communication_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.communication_delivery_events FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_delivery_events_tenant_isolation ON hon.communication_delivery_events
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

-- Delivery evidence: one audit row and one outbox event per transition, actor = the fixed principal.
CREATE FUNCTION hon.communication_delivery_evidence(
  p_delivery hon.communication_deliveries, p_prior_status text, p_action text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_request uuid := gen_random_uuid();
  v_state jsonb := jsonb_build_object(
    'communicationDeliveryId', p_delivery.id, 'communicationMessageId', p_delivery.message_id,
    'channel', p_delivery.channel::text, 'status', p_delivery.status::text, 'holdReason', p_delivery.hold_reason,
    'attempt', p_delivery.attempt_count, 'provider', p_delivery.provider, 'sentAs', p_delivery.sent_as,
    'segments', p_delivery.segments, 'failureCode', p_delivery.failure_code, 'version', p_delivery.version);
BEGIN
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (p_delivery.organization_id, p_delivery.school_id, '00000000-0000-4000-8000-00000000c043', 'INTEGRATION', p_action,
    'COMMUNICATION_DELIVERY', p_delivery.id,
    CASE WHEN p_prior_status IS NULL THEN NULL ELSE jsonb_build_object('status', p_prior_status) END,
    v_state, 'SUCCEEDED', v_request, v_request, now());
  INSERT INTO hon.outbox_events (id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
    aggregate_version, correlation_id, causation_id, payload)
  VALUES (gen_random_uuid(), p_delivery.organization_id, p_delivery.school_id, 'communication.delivery.' || lower(p_delivery.status::text), 1,
    'COMMUNICATION_DELIVERY', p_delivery.id, p_delivery.version, v_request, v_request, v_state);
END;
$$;

-- Records a recipient-originated opt-out for one person and channel (unsubscribe, spam report, STOP).
CREATE FUNCTION hon.communication_record_recipient_opt_out(
  p_organization_id uuid, p_school_id uuid, p_person_id uuid, p_channel text, p_captured_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_prior hon.communication_consents;
  v_next hon.communication_consents;
  v_request uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_prior FROM hon.communication_consents
  WHERE organization_id = p_organization_id AND school_id = p_school_id AND person_id = p_person_id
    AND channel = p_channel::hon.communication_consent_channel
  FOR UPDATE;
  IF FOUND AND v_prior.status = 'OPTED_OUT' THEN RETURN false; END IF;
  IF FOUND THEN
    UPDATE hon.communication_consents
    SET status = 'OPTED_OUT', source = 'RECIPIENT', captured_at = p_captured_at, version = version + 1,
        updated_by_principal_id = '00000000-0000-4000-8000-00000000c043', updated_at = now()
    WHERE id = v_prior.id RETURNING * INTO v_next;
  ELSE
    INSERT INTO hon.communication_consents (organization_id, school_id, person_id, channel, status, source, captured_at,
      updated_by_principal_id)
    VALUES (p_organization_id, p_school_id, p_person_id, p_channel::hon.communication_consent_channel, 'OPTED_OUT', 'RECIPIENT',
      p_captured_at, '00000000-0000-4000-8000-00000000c043')
    RETURNING * INTO v_next;
  END IF;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (p_organization_id, p_school_id, '00000000-0000-4000-8000-00000000c043', 'INTEGRATION',
    'communication.consent.recipient_opt_out', 'COMMUNICATION_CONSENT', v_next.id,
    CASE WHEN v_prior.id IS NULL THEN NULL ELSE jsonb_build_object('status', v_prior.status::text, 'source', v_prior.source::text, 'version', v_prior.version) END,
    jsonb_build_object('personId', p_person_id, 'channel', p_channel, 'status', 'OPTED_OUT', 'source', 'RECIPIENT', 'version', v_next.version),
    'SUCCEEDED', v_request, v_request, now());
  INSERT INTO hon.outbox_events (id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
    aggregate_version, correlation_id, causation_id, payload)
  VALUES (gen_random_uuid(), p_organization_id, p_school_id, 'communication.consent.recorded', 1, 'COMMUNICATION_CONSENT', v_next.id,
    v_next.version, v_request, v_request,
    jsonb_build_object('personId', p_person_id, 'channel', p_channel, 'status', 'OPTED_OUT', 'source', 'RECIPIENT'));
  RETURN true;
END;
$$;

-- Reconciles expired SENDING leases to UNKNOWN. A provider may have accepted the message, so it is never retried.
CREATE FUNCTION hon.reconcile_expired_communication_leases(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_row hon.communication_deliveries;
  v_count integer := 0;
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'HON communication lease reconciliation limit must be between 1 and 100.' USING ERRCODE = '22023';
  END IF;
  FOR v_row IN
    SELECT * FROM hon.communication_deliveries
    WHERE status = 'SENDING' AND lease_expires_at <= now()
    ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT p_limit
  LOOP
    UPDATE hon.communication_deliveries
    SET status = 'UNKNOWN', failure_code = 'LEASE_EXPIRED', lease_token = NULL, lease_expires_at = NULL,
        final_at = now(), version = version + 1, updated_at = now()
    WHERE id = v_row.id RETURNING * INTO v_row;
    PERFORM hon.communication_delivery_evidence(v_row, 'SENDING', 'communication.delivery.lease_expired');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE FUNCTION hon.claim_communication_deliveries(
  p_channels text[], p_limit integer, p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  delivery_id uuid, lease_token uuid, organization_id uuid, school_id uuid, message_id uuid,
  channel text, recipient_address text, content text, school_name text, attempt integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon
AS $$
#variable_conflict use_column
DECLARE
  v_message record;
  v_delivery hon.communication_deliveries;
  v_ctx record;
  v_local timestamp;
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

  -- Every due QUEUED message on a claimed channel gets exactly one delivery record.
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

    -- Texts are not sent between 21:00 and 08:00 school time; they wait for 08:00.
    IF v_delivery.channel = 'SMS' THEN
      v_local := now() AT TIME ZONE v_ctx.timezone;
      IF v_local::time >= time '21:00' OR v_local::time < time '08:00' THEN
        -- Evidence only when the hold starts, not on every dispatcher pass during the night.
        IF v_delivery.hold_reason IS DISTINCT FROM 'QUIET_HOURS' THEN
          UPDATE hon.communication_deliveries
          SET hold_reason = 'QUIET_HOURS',
              next_attempt_at = (date_trunc('day', v_local)
                + CASE WHEN v_local::time >= time '21:00' THEN interval '1 day' ELSE interval '0' END
                + interval '8 hours') AT TIME ZONE v_ctx.timezone,
              version = version + 1, updated_at = now()
          WHERE id = v_delivery.id RETURNING * INTO v_delivery;
          PERFORM hon.communication_delivery_evidence(v_delivery, v_prior, 'communication.delivery.held');
        ELSE
          UPDATE hon.communication_deliveries
          SET next_attempt_at = (date_trunc('day', v_local)
                + CASE WHEN v_local::time >= time '21:00' THEN interval '1 day' ELSE interval '0' END
                + interval '8 hours') AT TIME ZONE v_ctx.timezone
          WHERE id = v_delivery.id;
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
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE FUNCTION hon.record_communication_send_result(
  p_delivery_id uuid, p_lease_token uuid, p_outcome text, p_provider text, p_provider_message_id text,
  p_sent_as text, p_segments integer, p_encoding text, p_failure_code text, p_retry_after_seconds integer
)
RETURNS TABLE (status text, accepted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon
AS $$
#variable_conflict use_column
DECLARE
  v_row hon.communication_deliveries;
  v_prior text;
BEGIN
  IF p_outcome NOT IN ('ACCEPTED', 'RETRYABLE', 'FAILED', 'UNKNOWN') THEN
    RAISE EXCEPTION 'HON communication send outcome is invalid.' USING ERRCODE = '22023';
  END IF;
  IF p_provider NOT IN ('FAKE', 'SENDGRID', 'TWILIO') THEN
    RAISE EXCEPTION 'HON communication provider is invalid.' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'ACCEPTED' AND (p_provider_message_id IS NULL OR p_sent_as IS NULL) THEN
    RAISE EXCEPTION 'HON accepted communication needs a provider message id and sent-as.' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'FAILED' AND p_failure_code NOT IN ('PROVIDER_REJECTED', 'INVALID_ADDRESS', 'PROVIDER_FAILED') THEN
    RAISE EXCEPTION 'HON failed communication needs a closed failure code.' USING ERRCODE = '22023';
  END IF;
  IF p_retry_after_seconds IS NOT NULL AND (p_retry_after_seconds < 30 OR p_retry_after_seconds > 86400) THEN
    RAISE EXCEPTION 'HON communication retry delay must be between 30 seconds and one day.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM hon.communication_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HON communication delivery was not found.' USING ERRCODE = 'P0002';
  END IF;
  v_prior := v_row.status::text;
  -- A stale or expired lease cannot report anything: the outcome crossed an unknown boundary.
  IF v_row.status <> 'SENDING' OR v_row.lease_token IS DISTINCT FROM p_lease_token OR v_row.lease_expires_at <= now() THEN
    IF v_row.status = 'SENDING' AND v_row.lease_token = p_lease_token THEN
      UPDATE hon.communication_deliveries
      SET status = 'UNKNOWN', failure_code = 'LEASE_EXPIRED', lease_token = NULL, lease_expires_at = NULL,
          final_at = now(), version = version + 1, updated_at = now()
      WHERE id = v_row.id RETURNING * INTO v_row;
      PERFORM hon.communication_delivery_evidence(v_row, v_prior, 'communication.delivery.lease_expired');
    END IF;
    status := v_row.status::text; accepted := false; RETURN NEXT; RETURN;
  END IF;

  IF p_outcome = 'ACCEPTED' THEN
    UPDATE hon.communication_deliveries
    SET status = 'ACCEPTED', provider = p_provider, provider_message_id = p_provider_message_id, sent_as = p_sent_as,
        segments = p_segments, encoding = p_encoding, accepted_at = now(), lease_token = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = now()
    WHERE id = v_row.id RETURNING * INTO v_row;
  ELSIF p_outcome = 'RETRYABLE' AND v_row.attempt_count < 5 THEN
    UPDATE hon.communication_deliveries
    SET status = 'PENDING', hold_reason = 'RETRY_WAIT', provider = p_provider, lease_token = NULL, lease_expires_at = NULL,
        next_attempt_at = now() + make_interval(secs => coalesce(p_retry_after_seconds, 60 * power(2, v_row.attempt_count)::integer)),
        version = version + 1, updated_at = now()
    WHERE id = v_row.id RETURNING * INTO v_row;
  ELSIF p_outcome IN ('RETRYABLE', 'FAILED') THEN
    UPDATE hon.communication_deliveries
    SET status = 'FAILED', provider = p_provider,
        failure_code = CASE WHEN p_outcome = 'RETRYABLE' THEN 'RETRIES_EXHAUSTED' ELSE p_failure_code END,
        lease_token = NULL, lease_expires_at = NULL, final_at = now(), version = version + 1, updated_at = now()
    WHERE id = v_row.id RETURNING * INTO v_row;
  ELSE
    UPDATE hon.communication_deliveries
    SET status = 'UNKNOWN', provider = p_provider, failure_code = 'PROVIDER_UNKNOWN', lease_token = NULL, lease_expires_at = NULL,
        final_at = now(), version = version + 1, updated_at = now()
    WHERE id = v_row.id RETURNING * INTO v_row;
  END IF;
  PERFORM hon.communication_delivery_evidence(v_row, v_prior, 'communication.delivery.' || lower(p_outcome));
  status := v_row.status::text;
  accepted := true;
  RETURN NEXT;
END;
$$;

-- Applies one verified provider receipt. Idempotent per (provider, event id). Status moves only forward.
CREATE FUNCTION hon.record_communication_provider_event(
  p_provider text, p_provider_event_id text, p_provider_message_id text, p_hon_delivery_id uuid,
  p_event_type text, p_occurred_at timestamptz, p_provider_cost_microunits bigint
)
RETURNS TABLE (outcome text, delivery_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon
AS $$
#variable_conflict use_column
DECLARE
  v_row hon.communication_deliveries;
  v_prior text;
  v_next hon.communication_delivery_status;
  v_failure text;
  v_person uuid;
  v_rank_prior integer;
  v_rank_next integer;
BEGIN
  IF p_provider NOT IN ('FAKE', 'SENDGRID', 'TWILIO') THEN
    RAISE EXCEPTION 'HON communication provider is invalid.' USING ERRCODE = '22023';
  END IF;
  IF p_event_type NOT IN ('SENT', 'DELIVERED', 'DEFERRED', 'BOUNCED', 'DROPPED', 'UNDELIVERED', 'FAILED', 'UNSUBSCRIBED', 'SPAM_REPORT') THEN
    RAISE EXCEPTION 'HON communication event type is invalid.' USING ERRCODE = '22023';
  END IF;
  IF p_occurred_at IS NULL OR p_occurred_at > now() + interval '10 minutes' OR p_occurred_at < now() - interval '30 days' THEN
    RAISE EXCEPTION 'HON communication event time is out of range.' USING ERRCODE = '22023';
  END IF;
  IF p_provider_cost_microunits IS NOT NULL AND (p_provider_cost_microunits < 0 OR p_provider_cost_microunits > 1000000000) THEN
    RAISE EXCEPTION 'HON communication provider cost is out of range.' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM hon.communication_delivery_events e WHERE e.provider = p_provider AND e.provider_event_id = p_provider_event_id) THEN
    outcome := 'REPLAYED';
    SELECT d.status::text INTO delivery_status FROM hon.communication_delivery_events e
      JOIN hon.communication_deliveries d ON d.id = e.delivery_id
      WHERE e.provider = p_provider AND e.provider_event_id = p_provider_event_id;
    RETURN NEXT; RETURN;
  END IF;

  -- Match by the provider's message id; a HON delivery id (from provider custom args) may resolve an UNKNOWN send
  -- of the same provider whose answer was lost, and must agree with the provider message id when both exist.
  SELECT * INTO v_row FROM hon.communication_deliveries d
  WHERE d.provider = p_provider AND d.provider_message_id = p_provider_message_id
  FOR UPDATE;
  IF NOT FOUND AND p_hon_delivery_id IS NOT NULL THEN
    SELECT * INTO v_row FROM hon.communication_deliveries d
    WHERE d.id = p_hon_delivery_id AND d.provider_message_id IS NULL AND d.status IN ('UNKNOWN', 'SENDING')
      AND (d.provider IS NULL OR d.provider = p_provider)
    FOR UPDATE;
  END IF;
  IF NOT FOUND OR (p_hon_delivery_id IS NOT NULL AND v_row.id <> p_hon_delivery_id) THEN
    outcome := 'UNMATCHED'; delivery_status := NULL; RETURN NEXT; RETURN;
  END IF;

  INSERT INTO hon.communication_delivery_events (organization_id, school_id, delivery_id, provider, provider_event_id, event_type, occurred_at)
  VALUES (v_row.organization_id, v_row.school_id, v_row.id, p_provider, p_provider_event_id, p_event_type::hon.communication_delivery_event_type, p_occurred_at);

  v_prior := v_row.status::text;
  v_next := CASE p_event_type
    WHEN 'DELIVERED' THEN 'DELIVERED' WHEN 'BOUNCED' THEN 'BOUNCED' WHEN 'DROPPED' THEN 'FAILED'
    WHEN 'UNDELIVERED' THEN 'FAILED' WHEN 'FAILED' THEN 'FAILED' WHEN 'SENT' THEN 'ACCEPTED'
    ELSE NULL END;
  v_failure := CASE p_event_type WHEN 'BOUNCED' THEN 'BOUNCED' WHEN 'DROPPED' THEN 'DROPPED'
    WHEN 'UNDELIVERED' THEN 'UNDELIVERED' WHEN 'FAILED' THEN 'PROVIDER_FAILED' ELSE NULL END;
  v_rank_prior := CASE v_row.status WHEN 'SENDING' THEN 0 WHEN 'UNKNOWN' THEN 0 WHEN 'ACCEPTED' THEN 1 ELSE 2 END;
  v_rank_next := CASE v_next WHEN 'ACCEPTED' THEN 1 ELSE 2 END;

  IF v_next IS NOT NULL AND v_rank_next > v_rank_prior AND v_row.status NOT IN ('PENDING', 'SUPPRESSED') THEN
    UPDATE hon.communication_deliveries
    SET status = v_next, provider = p_provider, provider_message_id = coalesce(provider_message_id, p_provider_message_id),
        accepted_at = coalesce(accepted_at, p_occurred_at), failure_code = v_failure,
        final_at = CASE WHEN v_rank_next = 2 THEN now() ELSE NULL END,
        lease_token = NULL, lease_expires_at = NULL,
        provider_cost_microunits = coalesce(p_provider_cost_microunits, provider_cost_microunits),
        version = version + 1, updated_at = now()
    WHERE id = v_row.id RETURNING * INTO v_row;
    PERFORM hon.communication_delivery_evidence(v_row, v_prior, 'communication.delivery.receipt');
  ELSIF p_provider_cost_microunits IS NOT NULL THEN
    UPDATE hon.communication_deliveries SET provider_cost_microunits = p_provider_cost_microunits, updated_at = now()
    WHERE id = v_row.id RETURNING * INTO v_row;
  END IF;

  IF p_event_type IN ('UNSUBSCRIBED', 'SPAM_REPORT') THEN
    SELECT message.recipient_person_id INTO v_person FROM hon.communication_messages message WHERE message.id = v_row.message_id;
    PERFORM hon.communication_record_recipient_opt_out(v_row.organization_id, v_row.school_id, v_person, v_row.channel::text, p_occurred_at);
  END IF;

  outcome := 'RECORDED';
  delivery_status := v_row.status::text;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION hon.communication_delivery_evidence(hon.communication_deliveries, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.communication_record_recipient_opt_out(uuid, uuid, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.reconcile_expired_communication_leases(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.claim_communication_deliveries(text[], integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.record_communication_send_result(uuid, uuid, text, text, text, text, integer, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.record_communication_provider_event(text, text, text, uuid, text, timestamptz, bigint) FROM PUBLIC;

-- School staff read delivery status through RLS only; runtime never writes deliveries or calls worker functions.
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.communication_deliveries, hon.communication_delivery_events FROM %I', r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.communication_delivery_evidence(hon.communication_deliveries, text, text), '
      || 'hon.communication_record_recipient_opt_out(uuid, uuid, uuid, text, timestamptz), '
      || 'hon.reconcile_expired_communication_leases(integer), hon.claim_communication_deliveries(text[], integer, integer), '
      || 'hon.record_communication_send_result(uuid, uuid, text, text, text, text, integer, text, text, integer), '
      || 'hon.record_communication_provider_event(text, text, text, uuid, text, timestamptz, bigint) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT SELECT ON TABLE hon.communication_deliveries, hon.communication_delivery_events TO hon_runtime;
    GRANT USAGE ON TYPE hon.communication_delivery_status, hon.communication_delivery_event_type TO hon_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.claim_communication_deliveries(text[], integer, integer),
      hon.reconcile_expired_communication_leases(integer),
      hon.record_communication_send_result(uuid, uuid, text, text, text, text, integer, text, text, integer),
      hon.record_communication_provider_event(text, text, text, uuid, text, timestamptz, bigint)
      TO hon_communication_worker;
  END IF;
END;
$$;
COMMIT;
