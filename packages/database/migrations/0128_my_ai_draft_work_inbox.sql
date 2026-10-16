BEGIN;

-- Read-only, current-requester inbox projections for the three implemented AI
-- drafting assistants. These projections deliberately expose state and trusted
-- HON references only; they do not expose prompts, drafts, provider model IDs,
-- raw provider responses, usage ledger rows, customer PII, or Action payloads.
-- The exact actor/Complete/permission resolver from each source slice is used
-- again at read time. No caller-provided school, organization, agent, or status
-- selector is accepted.
CREATE OR REPLACE FUNCTION hon.list_my_marketing_invocations(p_subject text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid := hon.marketing_owner(p_subject);
  v_result jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', rows.id,
    'agentKey', 'marcus',
    'schoolId', rows.school_id,
    'sourceRecordId', rows.campaign_id,
    'workItemId', rows.work_item_id,
    'status', CASE WHEN rows.status = 'SENDING' AND rows.updated_at < clock_timestamp() - interval '5 minutes' THEN 'UNKNOWN' ELSE rows.status END,
    'reason', rows.reason,
    'actionRequestId', rows.action_request_id,
    'updatedAt', rows.updated_at
  ) ORDER BY rows.updated_at DESC, rows.id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT id, school_id, campaign_id, work_item_id, status, reason, action_request_id, updated_at
    FROM hon.marketing_ai_invocations
    WHERE organization_id = hon.current_organization_id()
      AND school_id = hon.current_school_id()
      AND requested_by = v_actor
    ORDER BY updated_at DESC, id DESC
    LIMIT 20
  ) AS rows;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION hon.list_my_teaching_invocations(p_subject text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid := hon.require_teaching_assistant_actor(p_subject, false);
  v_result jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', rows.id,
    'agentKey', 'claire',
    'schoolId', rows.school_id,
    'sourceRecordId', rows.curriculum_id,
    'workItemId', rows.work_item_id,
    'status', CASE WHEN rows.status = 'SENDING' AND rows.updated_at < clock_timestamp() - interval '5 minutes' THEN 'UNKNOWN' ELSE rows.status END,
    'reason', rows.reason,
    'actionRequestId', rows.action_request_id,
    'updatedAt', rows.updated_at
  ) ORDER BY rows.updated_at DESC, rows.id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT id, school_id, curriculum_id, work_item_id, status, reason, action_request_id, updated_at
    FROM hon.teaching_ai_invocations
    WHERE organization_id = hon.current_organization_id()
      AND school_id = hon.current_school_id()
      AND requested_by = v_actor
    ORDER BY updated_at DESC, id DESC
    LIMIT 20
  ) AS rows;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION hon.list_my_chad_follow_up_invocations(p_subject text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid := hon.require_chad_follow_up_actor(p_subject);
  v_result jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', rows.id,
    'agentKey', 'chad',
    'schoolId', rows.school_id,
    'sourceRecordId', rows.lead_id,
    'workItemId', rows.work_item_id,
    'status', CASE WHEN rows.status = 'SENDING' AND rows.updated_at < clock_timestamp() - interval '5 minutes' THEN 'UNKNOWN' ELSE rows.status END,
    'reason', rows.reason,
    'actionRequestId', rows.action_request_id,
    'updatedAt', rows.updated_at
  ) ORDER BY rows.updated_at DESC, rows.id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT id, school_id, lead_id, work_item_id, status, reason, action_request_id, updated_at
    FROM hon.chad_follow_up_invocations
    WHERE organization_id = hon.current_organization_id()
      AND school_id = hon.current_school_id()
      AND requested_by = v_actor
    ORDER BY updated_at DESC, id DESC
    LIMIT 20
  ) AS rows;
  RETURN v_result;
END;
$$;

-- Explicit deny-first grants. The inbox is a presentation of existing durable
-- work; it creates no new AI, Action Engine, provider, delivery, or mutation path.
DO $$
DECLARE
  v_signature regprocedure;
  v_role text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'hon.list_my_marketing_invocations(text)'::regprocedure,
    'hon.list_my_teaching_invocations(text)'::regprocedure,
    'hon.list_my_chad_follow_up_invocations(text)'::regprocedure
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
    FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_signature, v_role);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION
      hon.list_my_marketing_invocations(text),
      hon.list_my_teaching_invocations(text),
      hon.list_my_chad_follow_up_invocations(text)
    TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
