BEGIN;

-- Parent/Eian message history is deliberately observation-only. The current
-- provider-neutral queue records DRAFT/QUEUED/CANCELLED, but no delivery or
-- recipient-receipt evidence. A QUEUED item is not proof that a family received
-- it, so this projection must return an explicit unavailable state rather than
-- inventing delivered/received content from queue intent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Trusted parent message-history migration owner required';
  END IF;
END $$;

ALTER TABLE hon.communication_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.communication_messages FORCE ROW LEVEL SECURITY;

CREATE FUNCTION hon.read_parent_message_history(p_subject text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_scope record;
  v_scope_count integer;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject THEN
    RAISE EXCEPTION 'PARENT_MESSAGE_HISTORY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- Canonical shared resolver proves one active HUMAN_USER and one live,
  -- explicit family grant. It intentionally has no staff, HQ, school, family,
  -- child, recipient, date, channel, campaign, or message selector.
  SELECT count(*) INTO v_scope_count FROM hon.resolve_parent_journey_scopes(p_subject);
  IF v_scope_count <> 1 THEN
    RAISE EXCEPTION 'PARENT_MESSAGE_HISTORY_SCOPE_AMBIGUOUS' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_scope FROM hon.resolve_parent_journey_scopes(p_subject);
  IF v_scope.access_level NOT IN ('PRIMARY_GUARDIAN'::hon.family_access_level, 'SECONDARY_GUARDIAN'::hon.family_access_level) THEN
    RAISE EXCEPTION 'PARENT_MESSAGE_HISTORY_GUARDIAN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM hon.families AS family
    WHERE family.id = v_scope.family_id
      AND family.organization_id = v_scope.organization_id
      AND family.school_id = v_scope.school_id
      AND family.status = 'ACTIVE'::hon.membership_status
  ) THEN
    RAISE EXCEPTION 'PARENT_MESSAGE_HISTORY_FAMILY_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;

  -- No message row is read. Neither the queue nor consent evidence can prove a
  -- school message reached this guardian or a current child, and this read must
  -- never disclose draft, queued, cancelled, scheduled, recipient, sender,
  -- delivery/provider, consent, campaign, broadcast, staff, or internal data.

  -- Recheck the same live family grant before returning even the unavailable
  -- state: revoked or newly ambiguous access must conceal the response.
  SELECT count(*) INTO v_scope_count FROM hon.resolve_parent_journey_scopes(p_subject);
  IF v_scope_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM hon.resolve_parent_journey_scopes(p_subject) AS current_scope
    WHERE current_scope.principal_id = v_scope.principal_id
      AND current_scope.organization_id = v_scope.organization_id
      AND current_scope.school_id = v_scope.school_id
      AND current_scope.family_id = v_scope.family_id
      AND current_scope.access_level = v_scope.access_level
  ) THEN
    RAISE EXCEPTION 'PARENT_MESSAGE_HISTORY_SCOPE_CHANGED' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'generatedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'accessLevel', v_scope.access_level::text,
    'messages', jsonb_build_object(
      'status', 'UNAVAILABLE',
      'reason', 'RECEIPT_EVIDENCE_UNAVAILABLE',
      'items', '[]'::jsonb,
      'limited', false
    )
  );
END;
$$;

COMMENT ON FUNCTION hon.read_parent_message_history(text) IS
  'Read-only parent/Eian message-history boundary. Resolves exactly one live guardian family from verified subject and, because the existing provider-neutral queue has no delivery/recipient-receipt fact, returns only an explicit unavailable state. Never returns message content, ids, contact data, consent, recipient/sender/staff/provider/delivery metadata, drafts, queued/cancelled records, campaigns, broadcasts, notes, child/family/school identifiers, or any non-family data; never sends, replies, queues, mutates or calls providers/AI/actions/voice/automation/payments.';

REVOKE ALL ON FUNCTION hon.read_parent_message_history(text) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'hon_runtime') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_parent_message_history(text) FROM %I', role_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    -- The parent reader calls this fixed projection only. This migration adds no
    -- direct source-table grant and uses no mutable queue/consent function.
    GRANT EXECUTE ON FUNCTION hon.read_parent_message_history(text) TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
