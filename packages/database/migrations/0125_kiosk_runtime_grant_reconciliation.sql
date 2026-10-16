BEGIN;

-- `0122` is applied history. Its initial fresh-role posture is represented in
-- infra/postgres/010_supabase_hon_runtime.sql, but an ordinary migration replay
-- did not grant the four reviewed function boundaries to an existing runtime
-- role. Reconcile that exact least-privilege posture here; do not grant tables,
-- helper functions, ownership, role membership or broader schema access.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Kiosk runtime reconciliation requires a trusted migration owner';
  END IF;
END $$;

DO $$
DECLARE
  runtime_role text;
  signature text;
BEGIN
  FOR runtime_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    FOREACH signature IN ARRAY ARRAY[
      'manage_kiosk_terminal(text,text,uuid,uuid,text)',
      'provision_kiosk_claim(text,uuid,uuid,uuid,text)',
      'submit_kiosk_handoff(text,text)',
      'read_kiosk_handoff(text,uuid)',
      'lock_kiosk_actor(text,text)',
      'kiosk_secret_valid(text)',
      'guard_kiosk_transition()'
    ] LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM %I', signature, runtime_role);
    END LOOP;
  END LOOP;

  FOREACH signature IN ARRAY ARRAY[
    'manage_kiosk_terminal(text,text,uuid,uuid,text)',
    'provision_kiosk_claim(text,uuid,uuid,uuid,text)',
    'submit_kiosk_handoff(text,text)',
    'read_kiosk_handoff(text,uuid)',
    'lock_kiosk_actor(text,text)',
    'kiosk_secret_valid(text)',
    'guard_kiosk_transition()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM PUBLIC', signature);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM hon_runtime', signature);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION
      hon.manage_kiosk_terminal(text,text,uuid,uuid,text),
      hon.provision_kiosk_claim(text,uuid,uuid,uuid,text),
      hon.submit_kiosk_handoff(text,text),
      hon.read_kiosk_handoff(text,uuid)
    TO hon_runtime;
  END IF;
END $$;

COMMIT;
