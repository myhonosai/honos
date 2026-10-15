BEGIN;

-- Supabase development role compatibility. Production provisioning applies the
-- same least-privilege grant through its role-management process.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE hon.principal_interface_preferences TO hon_runtime';
  END IF;
END;
$$;

COMMIT;
