BEGIN;

-- 0645 Class session minimum duration (coordinator-allocated 2026-11-22; launch-readiness review [25]).
-- Owner request (David, 2026-11-22): fix the review's findings before more features.
-- 0032 only required ends_at > starts_at. Sessions publish their times at UTC millisecond precision, so a positive
-- sub-millisecond session could publish equal startsAt and endsAt, and the strict read contract then rejects the whole
-- page it is on.
--   MD1  Every class session lasts at least one minute. Every HON writer already meets this: recurring series and the
--        calendar move use 5-600 minutes, demo data uses whole class lengths, and the staff create API now refuses less
--        than a minute with a 400 before it reaches the database.
--   MD2  The check is validated against existing rows. If any stored session is shorter than a minute, this migration
--        fails and rolls back with nothing changed, and that row must be corrected first.
-- Nothing here changes data, grants, sends, charges or calls an outside service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.class_sessions') IS NULL THEN RAISE EXCEPTION '0645 requires 0032'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='hon.class_sessions'::regclass AND conname='class_sessions_minimum_duration') THEN
    RAISE EXCEPTION 'class_sessions_minimum_duration already exists'; END IF;
END $$;

ALTER TABLE hon.class_sessions ADD CONSTRAINT class_sessions_minimum_duration CHECK (ends_at - starts_at >= interval '1 minute');
COMMIT;
