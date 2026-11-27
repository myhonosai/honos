BEGIN;

-- HQ Plan builder piece 3: a school sees which features its plan includes (David chose "Locked, with an Upgrade button",
-- 2026-11-26). The school's plan is the HQ plan assignment (0676). When HQ assigned a published HON OS offer, the plan's
-- features are that offer's capability list (0697); a feature left out is LOCKED. With no assignment, a removed one or a
-- custom plan, nothing is locked: no school loses a feature it uses today, and the entitlement tier is not consulted.
-- - One private helper computes the list; one read lets any eligible staff member of the exact school see it (HQ during a
--   logged 0696 support visit too, through hon.staff_member_eligible).
-- - Display only. Nothing here refuses a feature's own commands, sells, charges, grants credits or changes an entitlement
--   or hon.saas_organization_access. Server refusal of locked features is a separate reviewed change.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School plan features require a trusted migration owner';
  END IF;
END $$;

CREATE FUNCTION hon.school_plan_features(p_org uuid, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE cur hon.hq_school_plan_assignments%ROWTYPE; every text[] := hon.saas_plan_capabilities('COMPLETE'); included text[];
BEGIN
  cur := hon.hq_school_plan_current(p_org);
  IF cur.action = 'ASSIGN' AND cur.source = 'OFFER' AND cur.school_id = p_school THEN
    SELECT o.capabilities INTO included FROM hon.saas_offer_set_offers o WHERE o.id = cur.offer_id;
  END IF;
  IF included IS NULL THEN
    RETURN jsonb_build_object('source', CASE WHEN cur.action = 'ASSIGN' THEN cur.source ELSE 'NONE' END,
      'planName', CASE WHEN cur.action = 'ASSIGN' THEN cur.plan_name END,
      'included', to_jsonb(every), 'locked', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object('source', 'OFFER', 'planName', cur.plan_name,
    'included', to_jsonb(ARRAY(SELECT c FROM unnest(every) WITH ORDINALITY AS x(c, n) WHERE c = ANY(included) ORDER BY n)),
    'locked', to_jsonb(ARRAY(SELECT c FROM unnest(every) WITH ORDINALITY AS x(c, n) WHERE NOT c = ANY(included) ORDER BY n)));
END $$;

CREATE FUNCTION hon.read_school_plan_features(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; org uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject OR p_school IS NULL THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id, s.organization_id INTO actor, org FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
    JOIN hon.schools s ON s.id = p_school
  WHERE u.external_subject = p_subject AND p.is_active AND hon.staff_member_eligible(p.id, s.organization_id, s.id)
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id)
  LIMIT 1;
  IF actor IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object('schoolId', p_school) || hon.school_plan_features(org, p_school)
    || jsonb_build_object('asOf', hon.saas_ts(clock_timestamp()));
END $$;

DO $$ DECLARE r text; f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.school_plan_features(uuid,uuid)','hon.read_school_plan_features(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role',
        'hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_plan_features(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
