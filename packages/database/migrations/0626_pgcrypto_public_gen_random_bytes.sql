BEGIN;

-- 0626 pgcrypto's gen_random_bytes is reachable from "public" on every HON database (deploy fix, 2026-11-26).
--   0628 creates hon.school_media_new_token() as a LANGUAGE sql function with search_path=pg_catalog,public, so
--   PostgreSQL resolves gen_random_bytes(integer) in pg_catalog or public when the function is created. On a plain
--   PostgreSQL (CI, local proofs) 0001 installs pgcrypto in "public". On Supabase, pgcrypto is preinstalled in the
--   "extensions" schema, so 0628 failed there with "function gen_random_bytes(integer) does not exist" and rolled back
--   (live migrate run 45672656391; 0620-0627 had applied).
--   Migration history is append-only, so 0628 is not edited. This file sorts before 0628 and the migrator applies
--   pending files in name order, so it runs first on any database that has not applied 0628 yet.
--   Where public.gen_random_bytes(integer) already exists (plain PostgreSQL) this does nothing. Where pgcrypto lives in
--   "extensions" it adds a thin public wrapper around extensions.gen_random_bytes. The wrapper returns random bytes
--   only, reads no data, and is executable by its owner alone: every caller in HON is a SECURITY DEFINER function owned
--   by the migration owner. No PUBLIC, platform (anon, authenticated, service_role) or hon_runtime grant.
DO $$
DECLARE r text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('public.gen_random_bytes(integer)') IS NOT NULL THEN RETURN; END IF;
  IF to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
    RAISE EXCEPTION '0626 requires pgcrypto in the public or extensions schema'; END IF;
  CREATE FUNCTION public.gen_random_bytes(integer) RETURNS bytea
    LANGUAGE sql VOLATILE STRICT PARALLEL SAFE SET search_path=pg_catalog
    AS 'SELECT extensions.gen_random_bytes($1)';
  REVOKE ALL ON FUNCTION public.gen_random_bytes(integer) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','hon_runtime'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.gen_random_bytes(integer) FROM %I',r);
    END IF;
  END LOOP;
  COMMENT ON FUNCTION public.gen_random_bytes(integer) IS
    'HON 0626: owner-only wrapper around extensions.gen_random_bytes, for databases where pgcrypto is not in public.';
END $$;

COMMIT;
