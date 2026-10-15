BEGIN;

CREATE TYPE hon.outbox_delivery_outcome AS ENUM ('PUBLISHING', 'PUBLISHED', 'RETRYABLE_FAILURE', 'UNKNOWN');
REVOKE USAGE ON TYPE hon.outbox_delivery_outcome FROM PUBLIC;

ALTER TABLE hon.outbox_events
  ADD CONSTRAINT outbox_events_id_tenant_unique UNIQUE (id, organization_id, school_id);

CREATE TABLE hon.outbox_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  outbox_event_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  lease_token uuid NOT NULL,
  outcome hon.outbox_delivery_outcome NOT NULL DEFAULT 'PUBLISHING',
  failure_details jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (outbox_event_id, organization_id, school_id) REFERENCES hon.outbox_events(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (outbox_event_id, attempt_number),
  UNIQUE (outbox_event_id, lease_token)
);

ALTER TABLE hon.outbox_events
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz;

CREATE INDEX outbox_events_claim_idx
  ON hon.outbox_events (status, next_attempt_at, occurred_at)
  WHERE status IN ('PENDING', 'FAILED');

ALTER TABLE hon.outbox_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.outbox_delivery_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY outbox_delivery_attempts_tenant_isolation ON hon.outbox_delivery_attempts
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

-- The worker receives individual leased events only through this fixed function.
-- It cannot enumerate direct tenant tables or alter arbitrary event records.
CREATE OR REPLACE FUNCTION hon.claim_outbox_delivery_batch(
  p_limit integer,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  event_id uuid,
  organization_id uuid,
  school_id uuid,
  event_type text,
  schema_version integer,
  aggregate_type text,
  aggregate_id uuid,
  aggregate_version integer,
  correlation_id uuid,
  causation_id uuid,
  payload jsonb,
  attempt_number integer,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_event RECORD;
  v_lease_token uuid;
  v_lease_expires_at timestamptz;
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'HON outbox delivery batch limit must be between 1 and 100.' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds < 15 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'HON outbox delivery lease must be between 15 and 300 seconds.' USING ERRCODE = '22023';
  END IF;

  FOR v_event IN
    SELECT id
    FROM hon.outbox_events
    WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= now()
    ORDER BY occurred_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    v_lease_token := gen_random_uuid();
    v_lease_expires_at := now() + make_interval(secs => p_lease_seconds);
    UPDATE hon.outbox_events
    SET status = 'PUBLISHING',
        attempt_count = attempt_count + 1,
        lease_token = v_lease_token,
        lease_expires_at = v_lease_expires_at,
        last_error = NULL
    WHERE id = v_event.id
    RETURNING * INTO v_event;

    INSERT INTO hon.outbox_delivery_attempts (
      organization_id, school_id, outbox_event_id, attempt_number, lease_token, outcome
    ) VALUES (
      v_event.organization_id, v_event.school_id, v_event.id, v_event.attempt_count, v_lease_token, 'PUBLISHING'
    );

    event_id := v_event.id;
    organization_id := v_event.organization_id;
    school_id := v_event.school_id;
    event_type := v_event.event_type;
    schema_version := v_event.schema_version;
    aggregate_type := v_event.aggregate_type;
    aggregate_id := v_event.aggregate_id;
    aggregate_version := v_event.aggregate_version;
    correlation_id := v_event.correlation_id;
    causation_id := v_event.causation_id;
    payload := v_event.payload;
    attempt_number := v_event.attempt_count;
    lease_token := v_lease_token;
    lease_expires_at := v_lease_expires_at;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- UNKNOWN never becomes success. It dead-letters the event with the original
-- event identifier, preserving the evidence needed for operator reconciliation.
CREATE OR REPLACE FUNCTION hon.record_outbox_delivery_result(
  p_event_id uuid,
  p_lease_token uuid,
  p_outcome hon.outbox_delivery_outcome,
  p_failure_details jsonb DEFAULT NULL,
  p_retry_after_seconds integer DEFAULT 60
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_event hon.outbox_events%ROWTYPE;
  v_target_status hon.outbox_status;
BEGIN
  IF p_outcome = 'PUBLISHING' THEN
    RAISE EXCEPTION 'HON outbox delivery must record a final outcome.' USING ERRCODE = '22023';
  END IF;
  IF p_retry_after_seconds < 15 OR p_retry_after_seconds > 86400 THEN
    RAISE EXCEPTION 'HON outbox retry delay must be between 15 and 86400 seconds.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_event
  FROM hon.outbox_events
  WHERE id = p_event_id AND status = 'PUBLISHING' AND lease_token = p_lease_token
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HON outbox delivery lease is missing, stale, or already finalized.' USING ERRCODE = 'P0002';
  END IF;

  v_target_status := CASE p_outcome
    WHEN 'PUBLISHED' THEN 'PUBLISHED'::hon.outbox_status
    WHEN 'RETRYABLE_FAILURE' THEN 'FAILED'::hon.outbox_status
    WHEN 'UNKNOWN' THEN 'DEAD_LETTER'::hon.outbox_status
  END;

  UPDATE hon.outbox_events
  SET status = v_target_status,
      next_attempt_at = CASE WHEN p_outcome = 'RETRYABLE_FAILURE' THEN now() + make_interval(secs => p_retry_after_seconds) ELSE next_attempt_at END,
      published_at = CASE WHEN p_outcome = 'PUBLISHED' THEN now() ELSE published_at END,
      last_error = CASE
        WHEN p_outcome = 'PUBLISHED' THEN NULL
        WHEN p_outcome = 'UNKNOWN' THEN coalesce(p_failure_details, '{}'::jsonb) || jsonb_build_object('classification', 'UNKNOWN_DELIVERY_OUTCOME', 'eventId', p_event_id)
        ELSE coalesce(p_failure_details, '{}'::jsonb)
      END,
      lease_token = NULL,
      lease_expires_at = NULL
  WHERE id = p_event_id;

  UPDATE hon.outbox_delivery_attempts
  SET outcome = p_outcome,
      failure_details = CASE WHEN p_outcome = 'PUBLISHED' THEN NULL ELSE p_failure_details END,
      completed_at = now()
  WHERE outbox_event_id = p_event_id AND lease_token = p_lease_token;
END;
$$;

REVOKE ALL ON FUNCTION hon.claim_outbox_delivery_batch(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.record_outbox_delivery_result(uuid, uuid, hon.outbox_delivery_outcome, jsonb, integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_outbox_worker') THEN
    GRANT USAGE ON TYPE hon.outbox_delivery_outcome TO hon_outbox_worker;
    GRANT EXECUTE ON FUNCTION hon.claim_outbox_delivery_batch(integer, integer) TO hon_outbox_worker;
    GRANT EXECUTE ON FUNCTION hon.record_outbox_delivery_result(uuid, uuid, hon.outbox_delivery_outcome, jsonb, integer) TO hon_outbox_worker;
  END IF;
END;
$$;

COMMIT;
