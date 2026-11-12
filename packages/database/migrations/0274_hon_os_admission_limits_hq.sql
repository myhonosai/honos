BEGIN;

-- HQ control for the HON OS sign-up and trial admission limits (migration 0274, allocated 2026-11-12). Source only; both
-- programs stay CLOSED. 0273 kept the limits in a singleton only the migration owner could change, and a refusal left no
-- trace, so a burst of verified accounts could fill every seat with no one at HQ seeing it. This replaces the singleton with:
-- 1. Versioned limits (hon.hon_os_admission_limit_versions): append-only, the latest version is in force. Version 1 is the
--    0273 default (30/hour, 200/day each). The HQ owner records a new version with a reason through
--    set_hon_os_admission_limits (idempotent, expected-version checked, audited with an outbox event); every earlier
--    version stays readable. The migration owner can still append an owner-recorded version (no actor) for recovery.
-- 2. Cap-hit evidence (hon.hon_os_admission_refusals): one row per kind per UTC hour counting refusals. A refusal rolls
--    back its own transaction, so the API records it afterwards through record_hon_os_admission_refusal, which counts it
--    only while the limit is actually reached at that moment (a runtime caller cannot invent a cap hit).
-- 3. One HQ read (read_hon_os_admission_status, HQ owner or HQ billing reader): limits in force, the last 50 versions,
--    the current hour/day usage against each limit, whether each is full now, and refusals per hour for 7 days.
-- 4. Time indexes for the admission counts (#260 review P3).
-- Lock order for a change: IAM share locks -> request claim -> 'hon_os.admission_limits' mutex. Admission triggers take only
-- their own admission lock and read the latest version, so a change applies to the next admission after it commits.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.hon_os_admission_limits') IS NULL THEN RAISE EXCEPTION 'Apply sign-up abuse protection migration 0273 first'; END IF;
END $$;

CREATE TABLE hon.hon_os_admission_limit_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE CHECK (version BETWEEN 1 AND 999999999),
  signups_per_hour integer NOT NULL CHECK (signups_per_hour BETWEEN 1 AND 10000),
  signups_per_day integer NOT NULL CHECK (signups_per_day BETWEEN 1 AND 100000),
  trials_per_hour integer NOT NULL CHECK (trials_per_hour BETWEEN 1 AND 10000),
  trials_per_day integer NOT NULL CHECK (trials_per_day BETWEEN 1 AND 100000),
  reason text CHECK (reason IS NULL OR (reason=btrim(reason) AND length(reason) BETWEEN 10 AND 500)),
  actor_principal_id uuid REFERENCES hon.principals(id),
  idempotency_key uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (signups_per_hour<=signups_per_day AND trials_per_hour<=trials_per_day),
  -- An HQ change carries its actor, key and reason; an owner-recorded version (the default, or a recovery) carries none.
  CHECK ((actor_principal_id IS NULL AND idempotency_key IS NULL) OR (actor_principal_id IS NOT NULL AND idempotency_key IS NOT NULL AND reason IS NOT NULL)),
  -- Linked to its saas_request by the insert guard and the deferred evidence check, not a foreign key, so request cleanup in
  -- disposable proofs is never blocked by an immutable version row.
  UNIQUE (actor_principal_id, idempotency_key)
);
INSERT INTO hon.hon_os_admission_limit_versions(version,signups_per_hour,signups_per_day,trials_per_hour,trials_per_day,reason,recorded_at)
  SELECT 1,signups_per_hour,signups_per_day,trials_per_hour,trials_per_day,'Default limits from migration 0273',recorded_at FROM hon.hon_os_admission_limits;

CREATE TABLE hon.hon_os_admission_refusals (
  kind text NOT NULL CHECK (kind IN ('SIGNUP','TRIAL')),
  hour_start timestamptz NOT NULL CHECK (hour_start=date_trunc('hour',hour_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  refused_count integer NOT NULL CHECK (refused_count BETWEEN 1 AND 2000000000),
  first_refused_at timestamptz NOT NULL,
  last_refused_at timestamptz NOT NULL,
  PRIMARY KEY (kind, hour_start),
  CHECK (first_refused_at<=last_refused_at AND first_refused_at>=hour_start AND last_refused_at<hour_start+interval '1 hour')
);

CREATE INDEX hon_os_school_registrations_registered_at_idx ON hon.hon_os_school_registrations (registered_at);
CREATE INDEX hon_os_trial_enrollments_starts_at_idx ON hon.hon_os_trial_enrollments (starts_at);

CREATE FUNCTION hon.hon_os_admission_limits_now() RETURNS hon.hon_os_admission_limit_versions
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT * FROM hon.hon_os_admission_limit_versions ORDER BY version DESC LIMIT 1;
$$;

-- Usage now against the limits in force, for one kind. Shared by the admission triggers, the refusal record and the HQ read.
CREATE FUNCTION hon.hon_os_admission_usage(p_kind text, p_at timestamptz,
  OUT last_hour bigint, OUT last_day bigint, OUT per_hour integer, OUT per_day integer)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE l hon.hon_os_admission_limit_versions;
BEGIN
  l:=hon.hon_os_admission_limits_now();
  IF l.id IS NULL THEN RAISE EXCEPTION 'ADMISSION_LIMITS_MISSING' USING ERRCODE='P0002'; END IF;
  IF p_kind='SIGNUP' THEN
    SELECT count(*) FILTER (WHERE registered_at>p_at-interval '1 hour'),count(*) INTO last_hour,last_day
      FROM hon.hon_os_school_registrations WHERE registered_at>p_at-interval '1 day';
    per_hour:=l.signups_per_hour; per_day:=l.signups_per_day;
  ELSIF p_kind='TRIAL' THEN
    SELECT count(*) FILTER (WHERE starts_at>p_at-interval '1 hour'),count(*) INTO last_hour,last_day
      FROM hon.hon_os_trial_enrollments WHERE starts_at>p_at-interval '1 day';
    per_hour:=l.trials_per_hour; per_day:=l.trials_per_day;
  ELSE RAISE EXCEPTION 'INVALID_ADMISSION_KIND' USING ERRCODE='22023'; END IF;
END $$;

-- 0273 triggers, now reading the latest version (domain check and lock order unchanged).
CREATE OR REPLACE FUNCTION hon.guard_hon_os_signup_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE u record;
BEGIN
  IF hon.hon_os_email_domain_blocked(NEW.verified_email) THEN RAISE EXCEPTION 'SIGNUP_EMAIL_DOMAIN_NOT_ACCEPTED' USING ERRCODE='23514'; END IF;
  -- One admission lock for every new registration: the count below includes every committed earlier one.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon_os.signup_admission',0));
  u:=hon.hon_os_admission_usage('SIGNUP',clock_timestamp());
  IF u.last_hour>=u.per_hour OR u.last_day>=u.per_day THEN RAISE EXCEPTION 'SIGNUP_CAPACITY_REACHED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hon.guard_hon_os_trial_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE u record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hon_os.trial_admission',0));
  u:=hon.hon_os_admission_usage('TRIAL',clock_timestamp());
  IF u.last_hour>=u.per_hour OR u.last_day>=u.per_day THEN RAISE EXCEPTION 'TRIAL_CAPACITY_REACHED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

DROP TABLE hon.hon_os_admission_limits;
DROP FUNCTION hon.guard_hon_os_admission_limits();

CREATE FUNCTION hon.hon_os_admission_limits_json(v hon.hon_os_admission_limit_versions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('versionId',v.id,'version',v.version,'signupsPerHour',v.signups_per_hour,'signupsPerDay',v.signups_per_day,
    'trialsPerHour',v.trials_per_hour,'trialsPerDay',v.trials_per_day,'reason',v.reason,
    'recordedBy',CASE WHEN v.actor_principal_id IS NULL THEN 'MIGRATION_OWNER' ELSE 'HQ_OWNER' END,
    'actorPrincipalId',v.actor_principal_id,'recordedAt',hon.saas_ts(v.recorded_at));
$$;

-- Appends only the next version; an HQ version must be written inside its own claimed request.
CREATE FUNCTION hon.guard_hon_os_admission_limit_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hon_os.admission_limits',0));
  IF NEW.version<>coalesce((SELECT max(version) FROM hon.hon_os_admission_limit_versions),0)+1 THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF NEW.actor_principal_id IS NOT NULL THEN
    SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=NEW.actor_principal_id;
    PERFORM hon.require_saas_hq_actor(subject,true);
    IF NOT EXISTS (SELECT 1 FROM hon.saas_requests r WHERE r.actor_principal_id=NEW.actor_principal_id AND r.idempotency_key=NEW.idempotency_key
      AND r.operation='saas.admission.limits_set' AND r.status='IN_PROGRESS') THEN RAISE EXCEPTION 'ADMISSION_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION hon.verify_hon_os_admission_limit_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE data jsonb:=hon.hon_os_admission_limits_json(NEW);
BEGIN
  IF NEW.actor_principal_id IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.saas_requests r JOIN hon.saas_audit a USING(actor_principal_id,idempotency_key) JOIN hon.saas_outbox o ON o.audit_id=a.id
    WHERE r.actor_principal_id=NEW.actor_principal_id AND r.idempotency_key=NEW.idempotency_key AND r.status='COMPLETED' AND r.operation='saas.admission.limits_set'
      AND r.response_body->'limits'=data AND a.action_code='saas.admission.limits_set' AND a.entity_type='ADMISSION_LIMITS' AND a.entity_id=NEW.id
      AND a.organization_id IS NULL AND a.next_state=data AND o.event_type='saas.admission.limits_set')
  THEN RAISE EXCEPTION 'ADMISSION_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER admission_limit_authority BEFORE INSERT ON hon.hon_os_admission_limit_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_os_admission_limit_insert();
CREATE CONSTRAINT TRIGGER admission_limit_evidence AFTER INSERT ON hon.hon_os_admission_limit_versions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hon.verify_hon_os_admission_limit_evidence();
CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.hon_os_admission_limit_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.hon_os_admission_limit_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- HQ owner only. p: {expectedVersion, signupsPerHour, signupsPerDay, trialsPerHour, trialsPerDay, reason}.
CREATE FUNCTION hon.set_hon_os_admission_limits(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; replay jsonb; prior hon.hon_os_admission_limit_versions; made hon.hon_os_admission_limit_versions;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  IF NOT hon.saas_trial_keys(p,ARRAY['expectedVersion','signupsPerHour','signupsPerDay','trialsPerHour','trialsPerDay','reason'])
    OR NOT hon.saas_trial_uint(p->'expectedVersion',1,999999998)
    OR NOT hon.saas_trial_uint(p->'signupsPerHour',1,10000) OR NOT hon.saas_trial_uint(p->'signupsPerDay',1,100000)
    OR NOT hon.saas_trial_uint(p->'trialsPerHour',1,10000) OR NOT hon.saas_trial_uint(p->'trialsPerDay',1,100000)
    OR (p->>'signupsPerHour')::int>(p->>'signupsPerDay')::int OR (p->>'trialsPerHour')::int>(p->>'trialsPerDay')::int
    OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string' OR p->>'reason'<>btrim(p->>'reason') OR length(p->>'reason') NOT BETWEEN 10 AND 500
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  actor:=hon.require_saas_hq_actor(p_subject,true);
  LOCK TABLE hon.users,hon.principals,hon.hq_operator_grants,hon.family_access_grants IN SHARE MODE;
  actor:=hon.require_saas_hq_actor(p_subject,true);
  replay:=hon.saas_claim_request(actor,p_key,'saas.admission.limits_set',hon.saas_fingerprint(ARRAY['saas.admission.limits_set',p::text]),p_request,p_correlation);
  IF replay IS NOT NULL THEN PERFORM hon.require_saas_hq_actor(p_subject,true); RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon_os.admission_limits',0));
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  prior:=hon.hon_os_admission_limits_now();
  IF prior.version<>(p->>'expectedVersion')::int THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.hon_os_admission_limit_versions(version,signups_per_hour,signups_per_day,trials_per_hour,trials_per_day,reason,actor_principal_id,idempotency_key,recorded_at)
    VALUES (prior.version+1,(p->>'signupsPerHour')::int,(p->>'signupsPerDay')::int,(p->>'trialsPerHour')::int,(p->>'trialsPerDay')::int,p->>'reason',actor,p_key,clock_timestamp())
    RETURNING * INTO made;
  RETURN hon.saas_record(actor,p_key,'saas.admission.limits_set','saas.admission.limits_set','ADMISSION_LIMITS',made.id,NULL,
    hon.hon_os_admission_limits_json(prior),hon.hon_os_admission_limits_json(made),jsonb_build_object('limits',hon.hon_os_admission_limits_json(made)),clock_timestamp());
END $$;

-- Called by the API after a CAPACITY_REACHED refusal, in its own transaction. Counts it only while the limit is reached now.
CREATE FUNCTION hon.record_hon_os_admission_refusal(p_kind text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE at timestamptz:=clock_timestamp(); u record; hour timestamptz;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('SIGNUP','TRIAL') THEN RAISE EXCEPTION 'INVALID_ADMISSION_KIND' USING ERRCODE='22023'; END IF;
  u:=hon.hon_os_admission_usage(p_kind,at);
  IF u.last_hour<u.per_hour AND u.last_day<u.per_day THEN RETURN false; END IF;
  hour:=date_trunc('hour',at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  INSERT INTO hon.hon_os_admission_refusals AS r(kind,hour_start,refused_count,first_refused_at,last_refused_at) VALUES (p_kind,hour,1,at,at)
    ON CONFLICT (kind,hour_start) DO UPDATE SET refused_count=least(r.refused_count+1,2000000000),last_refused_at=greatest(r.last_refused_at,EXCLUDED.last_refused_at);
  RETURN true;
END $$;

-- HQ owner or HQ billing reader. Changes nothing.
CREATE FUNCTION hon.read_hon_os_admission_status(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE at timestamptz:=clock_timestamp(); s record; t record;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,false);
  s:=hon.hon_os_admission_usage('SIGNUP',at); t:=hon.hon_os_admission_usage('TRIAL',at);
  RETURN jsonb_build_object(
    'limits',hon.hon_os_admission_limits_json(hon.hon_os_admission_limits_now()),
    'history',(SELECT coalesce(jsonb_agg(hon.hon_os_admission_limits_json(v) ORDER BY v.version DESC),'[]') FROM
      (SELECT * FROM hon.hon_os_admission_limit_versions ORDER BY version DESC LIMIT 50) v),
    'historyHasMore',(SELECT count(*)>50 FROM hon.hon_os_admission_limit_versions),
    'usage',jsonb_build_object(
      'signups',jsonb_build_object('lastHour',s.last_hour,'lastDay',s.last_day,'perHour',s.per_hour,'perDay',s.per_day,'full',s.last_hour>=s.per_hour OR s.last_day>=s.per_day),
      'trials',jsonb_build_object('lastHour',t.last_hour,'lastDay',t.last_day,'perHour',t.per_hour,'perDay',t.per_day,'full',t.last_hour>=t.per_hour OR t.last_day>=t.per_day)),
    'refusals',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',r.kind,'hourStart',hon.saas_ts(r.hour_start),'count',r.refused_count,
      'firstAt',hon.saas_ts(r.first_refused_at),'lastAt',hon.saas_ts(r.last_refused_at)) ORDER BY r.hour_start DESC,r.kind),'[]')
      FROM hon.hon_os_admission_refusals r WHERE r.hour_start>at-interval '7 days'),
    'programs',jsonb_build_object('signup',(SELECT status FROM hon.hon_os_signup_program),'trial',(SELECT status FROM hon.hon_os_trial_program)),
    'blockedEmailDomains',(SELECT count(*) FROM hon.hon_os_signup_blocked_email_domains),
    'asOf',hon.saas_ts(at));
END $$;

DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_action_code_check';
  ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
  EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR action_code IN (''saas.admission.limits_set''))';
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_entity_type_check';
  ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
  EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR entity_type IN (''ADMISSION_LIMITS''))';
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_outbox'::regclass AND conname='saas_outbox_event_type_check';
  ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
  EXECUTE 'ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR event_type IN (''saas.admission.limits_set''))';
END $$;

DO $$ DECLARE t text; f text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['hon_os_admission_limit_versions','hon_os_admission_refusals'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon_os_admission_limits_now()','hon_os_admission_usage(text,timestamp with time zone)','hon_os_admission_limits_json(hon.hon_os_admission_limit_versions)',
    'guard_hon_os_admission_limit_insert()','verify_hon_os_admission_limit_evidence()','set_hon_os_admission_limits(text,jsonb,uuid,uuid,uuid)',
    'record_hon_os_admission_refusal(text)','read_hon_os_admission_status(text)','guard_hon_os_signup_admission()','guard_hon_os_trial_admission()'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.set_hon_os_admission_limits(text,jsonb,uuid,uuid,uuid),hon.record_hon_os_admission_refusal(text),hon.read_hon_os_admission_status(text) TO hon_runtime;
  END IF;
END $$;
COMMIT;
