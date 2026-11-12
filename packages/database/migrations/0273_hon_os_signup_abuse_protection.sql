BEGIN;

-- HON OS self-serve sign-up and free-trial abuse protection (migration 0273, allocated 2026-11-12). Source only; both
-- programs stay CLOSED. Self-hosted: no captcha, reputation or paid service, and no IP address is stored or trusted.
-- What already holds (0241/0246): an OIDC identity with an IdP-verified email, one school per identity ever, one trial
-- per organization ever, campaign capacity, a per-subject API rate limit and human-command/origin checks.
-- This adds, in the database where no client can skip it:
-- 1. Admission limits: at most N new school registrations (and N trial starts) per rolling hour and per rolling day
--    across all of HON OS. Counted under one admission lock per kind at the moment of insert, so concurrent requests
--    cannot overshoot. A refusal (SIGNUP_CAPACITY_REACHED / TRIAL_CAPACITY_REACHED) writes nothing and is safe to retry
--    later. Defaults 30 per hour / 200 per day each; only the migration owner can change them (no runtime path).
-- 2. Disposable email domains: a sign-up whose verified email is at a listed domain (or a subdomain of one) is refused
--    as SIGNUP_EMAIL_DOMAIN_NOT_ACCEPTED with no effects. The seeded list is a small set of well-known throwaway mail
--    services; the migration owner can add rows. HON never contacts these services.
-- Both are triggers on the evidence tables, so register_hon_os_school and start_hon_os_trial are unchanged and a refusal
-- rolls back every write of the same transaction.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.start_hon_os_trial(text,jsonb,uuid)') IS NULL THEN RAISE EXCEPTION 'Apply free-trial migration 0246 first'; END IF;
END $$;

CREATE TABLE hon.hon_os_admission_limits (
  limit_id smallint PRIMARY KEY CHECK (limit_id=1),
  signups_per_hour integer NOT NULL CHECK (signups_per_hour BETWEEN 1 AND 10000),
  signups_per_day integer NOT NULL CHECK (signups_per_day BETWEEN 1 AND 100000),
  trials_per_hour integer NOT NULL CHECK (trials_per_hour BETWEEN 1 AND 10000),
  trials_per_day integer NOT NULL CHECK (trials_per_day BETWEEN 1 AND 100000),
  recorded_at timestamptz NOT NULL,
  CHECK (signups_per_hour<=signups_per_day AND trials_per_hour<=trials_per_day)
);
INSERT INTO hon.hon_os_admission_limits VALUES (1,30,200,30,200,clock_timestamp());
CREATE FUNCTION hon.guard_hon_os_admission_limits() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.limit_id=OLD.limit_id THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'ADMISSION_LIMITS_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hon_os_admission_limits FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_os_admission_limits();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hon_os_admission_limits FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hon_os_admission_limits();

CREATE TABLE hon.hon_os_signup_blocked_email_domains (
  domain text PRIMARY KEY CHECK (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND length(domain)<=253),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO hon.hon_os_signup_blocked_email_domains(domain) VALUES
  ('mailinator.com'),('guerrillamail.com'),('guerrillamail.net'),('guerrillamail.org'),('sharklasers.com'),('grr.la'),
  ('10minutemail.com'),('10minutemail.net'),('temp-mail.org'),('tempmail.com'),('tempmailo.com'),('tempail.com'),
  ('yopmail.com'),('yopmail.net'),('trashmail.com'),('trashmail.de'),('throwawaymail.com'),('getnada.com'),('nada.email'),
  ('maildrop.cc'),('dispostable.com'),('mintemail.com'),('mohmal.com'),('emailondeck.com'),('fakeinbox.com'),
  ('spamgourmet.com'),('mailnesia.com'),('mytemp.email'),('tempr.email'),('discard.email'),('mailcatch.com'),
  ('burnermail.io'),('moakt.com'),('emailfake.com'),('fakemail.net'),('33mail.com');

-- The verified email's domain, or any parent of it, is on the list.
CREATE FUNCTION hon.hon_os_email_domain_blocked(p_email text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.hon_os_signup_blocked_email_domains b, (SELECT lower(split_part(p_email,'@',2)) d) x
    WHERE x.d=b.domain OR right(x.d,length(b.domain)+1)='.'||b.domain);
$$;

CREATE FUNCTION hon.guard_hon_os_signup_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE l hon.hon_os_admission_limits%ROWTYPE; at timestamptz:=clock_timestamp();
BEGIN
  IF hon.hon_os_email_domain_blocked(NEW.verified_email) THEN RAISE EXCEPTION 'SIGNUP_EMAIL_DOMAIN_NOT_ACCEPTED' USING ERRCODE='23514'; END IF;
  -- One admission lock for every new registration: the count below includes every committed earlier one.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon_os.signup_admission',0));
  SELECT * INTO STRICT l FROM hon.hon_os_admission_limits WHERE limit_id=1;
  IF (SELECT count(*) FROM hon.hon_os_school_registrations WHERE registered_at>at-interval '1 hour')>=l.signups_per_hour
    OR (SELECT count(*) FROM hon.hon_os_school_registrations WHERE registered_at>at-interval '1 day')>=l.signups_per_day THEN
    RAISE EXCEPTION 'SIGNUP_CAPACITY_REACHED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admission BEFORE INSERT ON hon.hon_os_school_registrations FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_os_signup_admission();

CREATE FUNCTION hon.guard_hon_os_trial_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE l hon.hon_os_admission_limits%ROWTYPE; at timestamptz:=clock_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hon_os.trial_admission',0));
  SELECT * INTO STRICT l FROM hon.hon_os_admission_limits WHERE limit_id=1;
  IF (SELECT count(*) FROM hon.hon_os_trial_enrollments WHERE starts_at>at-interval '1 hour')>=l.trials_per_hour
    OR (SELECT count(*) FROM hon.hon_os_trial_enrollments WHERE starts_at>at-interval '1 day')>=l.trials_per_day THEN
    RAISE EXCEPTION 'TRIAL_CAPACITY_REACHED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admission BEFORE INSERT ON hon.hon_os_trial_enrollments FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_os_trial_admission();

DO $$ DECLARE t text; f text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['hon_os_admission_limits','hon_os_signup_blocked_email_domains'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['guard_hon_os_admission_limits()','hon_os_email_domain_blocked(text)','guard_hon_os_signup_admission()','guard_hon_os_trial_admission()'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
END $$;
COMMIT;
