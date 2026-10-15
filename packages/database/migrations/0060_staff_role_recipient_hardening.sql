BEGIN;

-- Reconcile the reviewed allowlist with ACTUAL permission definitions. Unknown
-- future permissions still default false; none of these grants any actor a role.
UPDATE hon.permissions SET is_staff_assignable=true WHERE code IN (
  'settings.interface_theme.read','settings.interface_theme.update',
  'student.profile.manage','testing.manage','work_item.create'
);

-- Role edits change every recipient's effective authority. Validate and lock all
-- still-relevant recipients, not only the role row. The closed command has already
-- locked its organization and checked old/new permission subsets before UPDATE.
CREATE FUNCTION hon.guard_staff_custom_role_recipients()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_actor uuid; v_grant record;
BEGIN
  IF OLD.management_school_id IS NOT NULL
    AND current_setting('app.hon_source',true) = 'HUMAN_UI' THEN
    v_actor := nullif(current_setting('app.hon_principal_id',true),'')::uuid;
    IF v_actor IS NULL THEN RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
    FOR v_grant IN SELECT g.principal_id,u.external_subject FROM hon.principal_role_grants g
      JOIN hon.principals p ON p.id=g.principal_id JOIN hon.users u ON u.id=p.user_id
      WHERE g.role_id=OLD.id AND g.organization_id=OLD.organization_id AND g.revoked_at IS NULL
        AND (g.effective_until IS NULL OR g.effective_until>statement_timestamp())
      ORDER BY g.id FOR UPDATE OF g
    LOOP
      PERFORM hon.resolve_staff_role_target(v_grant.principal_id,v_grant.external_subject,v_actor);
    END LOOP;
    IF EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id
      WHERE g.role_id=OLD.id AND g.revoked_at IS NULL AND (g.effective_until IS NULL OR g.effective_until>statement_timestamp())
        AND p.principal_type <> 'HUMAN_USER') THEN
      RAISE EXCEPTION 'STAFF_ROLE_TARGET_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_custom_role_recipient_guard BEFORE UPDATE ON hon.roles
  FOR EACH ROW EXECUTE FUNCTION hon.guard_staff_custom_role_recipients();
REVOKE ALL ON FUNCTION hon.guard_staff_custom_role_recipients() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    REVOKE ALL ON FUNCTION hon.guard_staff_custom_role_recipients() FROM hon_runtime;
  END IF;
END $$;

COMMIT;
