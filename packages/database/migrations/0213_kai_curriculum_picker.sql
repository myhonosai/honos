BEGIN;

-- K1b: closed read for the Kai (Teaching & Curriculum) delegation picker.
-- Lists only the PUBLISHED curricula of the caller's own school: exactly the
-- set hon.begin_teaching_request accepts. The caller must pass the same
-- teaching-assistant actor check as every other Kai entry point (signed-in
-- human HUMAN_UI session, teaching.studio.read, active COMPLETE entitlement).
-- Returns ids, names and versions only: no description, ranks, students,
-- prompts or usage. It creates no AI, provider, Action Engine or write path.

CREATE OR REPLACE FUNCTION hon.list_teaching_assistant_curricula(p_subject text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid := hon.require_teaching_assistant_actor(p_subject, false);
  v_items jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'TEACHING_ASSISTANT_SCOPE_DENIED' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', rows.id, 'name', rows.name, 'version', rows.version) ORDER BY rows.name, rows.id), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT c.id, c.name, c.version
    FROM hon.curricula c
    WHERE c.organization_id = hon.current_organization_id()
      AND c.school_id = hon.current_school_id()
      AND c.lifecycle = 'PUBLISHED'
    ORDER BY c.name, c.id
    LIMIT 200
  ) AS rows;
  RETURN jsonb_build_object('items', v_items);
END;
$$;

DO $$
DECLARE v_role text;
BEGIN
  REVOKE ALL ON FUNCTION hon.list_teaching_assistant_curricula(text) FROM PUBLIC;
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.list_teaching_assistant_curricula(text) FROM %I', v_role);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.list_teaching_assistant_curricula(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
