BEGIN;

-- `0122` introduced bearer-bearing kiosk function parameters. The canonical
-- runtime-role script already disables parameter logging, but an ordinary
-- migration replay must also reconcile that non-secret runtime posture.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Kiosk runtime logging reconciliation requires a trusted migration owner';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    ALTER ROLE hon_runtime SET log_parameter_max_length = 0;
    ALTER ROLE hon_runtime SET log_parameter_max_length_on_error = 0;
  END IF;
END $$;

COMMIT;
