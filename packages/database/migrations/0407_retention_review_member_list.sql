BEGIN;

-- 0407 (owner 2026-11-16, "these ids don't make sense"): staff open retention review signals by picking a member by
-- name at their own signed-in school instead of typing a membership UUID. One read-only definer entry point,
-- authorized exactly like hon.read_retention_review_signals (0097/0123): lock_retention_review_actor before the read
-- and require_retention_review_actor after it (direct HUMAN_USER/HUMAN_UI session, retention review permission at
-- the current school, live entitlement, never HQ operators or family/student roles).
-- This replaces the earlier "no school-wide list" rule for this page only by the owner's newer instruction. Each row
-- is the membership id, the participant's name, its state and term end. No payer, contact, schedule, amount, signal
-- or note leaves the database here. Nothing writes. At most 200 rows, current school only.
-- (Renewal reviews need billing.membership.read, so that page uses the existing 0220 school membership list.)

CREATE FUNCTION hon.list_retention_review_members(p_subject text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_org uuid := hon.current_organization_id();
  v_school uuid := hon.current_school_id();
  v_items jsonb;
BEGIN
  PERFORM hon.lock_retention_review_actor(p_subject);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('membershipId', rows.id, 'displayName', rows.name, 'state', rows.state,
           'termEndsAt', CASE WHEN rows.term_ends_at IS NULL OR NOT isfinite(rows.term_ends_at) THEN NULL ELSE to_char(rows.term_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END)
           ORDER BY rows.name, rows.id), '[]'::jsonb) INTO v_items
    FROM (SELECT m.id, m.state::text AS state, m.term_ends_at,
                 left(COALESCE(NULLIF(btrim(concat_ws(' ', btrim(p.given_name), btrim(p.family_name))), ''), 'Member'), 120) AS name
            FROM hon.memberships AS m
            JOIN hon.people AS p ON p.id = m.participant_person_id AND p.organization_id = m.organization_id AND p.school_id = m.school_id
           WHERE m.organization_id = v_org AND m.school_id = v_school
             AND m.state IN ('ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'EXPIRED')
           ORDER BY 4, m.id
           LIMIT 200) AS rows;
  -- Authority is decided again after the read, as hon.read_retention_review_signals does.
  PERFORM hon.require_retention_review_actor(p_subject);
  RETURN jsonb_build_object('items', v_items);
END;
$$;

DO $$
DECLARE v_role text;
BEGIN
  REVOKE ALL ON FUNCTION hon.list_retention_review_members(text) FROM PUBLIC;
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role', 'hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.list_retention_review_members(text) FROM %I', v_role);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.list_retention_review_members(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
