BEGIN;
-- Open HON OS self-serve sign-up and free trials (migration 0710, allocated 2026-11-28).
-- Owner decision (David, 2026-11-28): open sign-up and the free trial for real schools; sign-up and trial terms approved as
-- written (card cmsg_01SJwdNE4ei8wHJs194vLQUiB1Rx8d5piWu6xjZLgKYCfm); the trial is 14 days (published by HQ as a campaign).
-- Until now the programs knew only CLOSED and TEST_MODE, and only the migration owner could change them. This adds:
-- 1. Program status OPEN, for real use. hon_os_signup_open()/hon_os_trial_open() admit TEST_MODE or OPEN. A registration or
--    trial records the program status it was admitted under (TEST_MODE or OPEN), set by a BEFORE INSERT trigger from the
--    program row, so no runtime caller chooses it.
-- 2. An HQ switch: set_hon_os_programs (HQ OWNER only, idempotent, expected-version checked, audited with an outbox event)
--    sets each program CLOSED or OPEN (never TEST_MODE) with a reason. Every change is an append-only version
--    (hon.hon_os_program_versions); version 1 records the state at migration time. Both programs stay as they are here
--    (CLOSED on live): deploying this opens nothing. HQ opens them with one tap.
-- 3. Sign-up terms v2, status FINAL: the owner-approved wording (its sha256 is the document digest; the web shows the same
--    text). The current terms are the newest FINAL version (the newest draft only while no FINAL exists), so after this
--    migration a sign-up must accept v2.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.set_hon_os_admission_limits(text,jsonb,uuid,uuid,uuid)') IS NULL THEN RAISE EXCEPTION 'Apply admission limits migration 0274 first'; END IF;
END $$;

-- ---------- 1. OPEN status ----------
ALTER TABLE hon.hon_os_signup_program DROP CONSTRAINT hon_os_signup_program_status_check;
ALTER TABLE hon.hon_os_signup_program ADD CONSTRAINT hon_os_signup_program_status_check CHECK (status IN ('CLOSED','TEST_MODE','OPEN'));
ALTER TABLE hon.hon_os_trial_program DROP CONSTRAINT hon_os_trial_program_status_check;
ALTER TABLE hon.hon_os_trial_program ADD CONSTRAINT hon_os_trial_program_status_check CHECK (status IN ('CLOSED','TEST_MODE','OPEN'));
ALTER TABLE hon.hon_os_school_registrations DROP CONSTRAINT hon_os_school_registrations_program_status_check;
ALTER TABLE hon.hon_os_school_registrations ADD CONSTRAINT hon_os_school_registrations_program_status_check CHECK (program_status IN ('TEST_MODE','OPEN'));
ALTER TABLE hon.hon_os_trial_enrollments DROP CONSTRAINT hon_os_trial_enrollments_program_status_check;
ALTER TABLE hon.hon_os_trial_enrollments ADD CONSTRAINT hon_os_trial_enrollments_program_status_check CHECK (program_status IN ('TEST_MODE','OPEN'));

CREATE OR REPLACE FUNCTION hon.hon_os_signup_open() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.hon_os_signup_program WHERE program_id=1 AND status IN ('TEST_MODE','OPEN'))
$$;
CREATE OR REPLACE FUNCTION hon.hon_os_trial_open() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.hon_os_trial_program WHERE program_id=1 AND status IN ('TEST_MODE','OPEN'))
$$;
CREATE FUNCTION hon.hon_os_signup_status() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT status FROM hon.hon_os_signup_program WHERE program_id=1),'CLOSED')
$$;
CREATE FUNCTION hon.hon_os_trial_status() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT status FROM hon.hon_os_trial_program WHERE program_id=1),'CLOSED')
$$;

-- The admitted program status comes from the program row, never from the writer.
CREATE FUNCTION hon.stamp_hon_os_signup_program_status() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  NEW.program_status:=hon.hon_os_signup_status();
  IF NEW.program_status NOT IN ('TEST_MODE','OPEN') THEN RAISE EXCEPTION 'SIGNUP_CLOSED' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION hon.stamp_hon_os_trial_program_status() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  NEW.program_status:=hon.hon_os_trial_status();
  IF NEW.program_status NOT IN ('TEST_MODE','OPEN') THEN RAISE EXCEPTION 'TRIAL_CLOSED' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER program_status_stamp BEFORE INSERT ON hon.hon_os_school_registrations FOR EACH ROW EXECUTE FUNCTION hon.stamp_hon_os_signup_program_status();
CREATE TRIGGER program_status_stamp BEFORE INSERT ON hon.hon_os_trial_enrollments FOR EACH ROW EXECUTE FUNCTION hon.stamp_hon_os_trial_program_status();

-- ---------- 3. terms v2 (FINAL) ----------
ALTER TABLE hon.hon_os_signup_terms_versions DROP CONSTRAINT hon_os_signup_terms_versions_status_check;
ALTER TABLE hon.hon_os_signup_terms_versions ADD CONSTRAINT hon_os_signup_terms_versions_status_check CHECK (status IN ('TEST_ONLY_DRAFT','FINAL'));
-- The digest is sha256 of the approved text (apps/web/src/components/hon-os-start/terms-text.ts holds the same text; a web test pins the digest).
INSERT INTO hon.hon_os_signup_terms_versions(version,status,title,document_digest,recorded_at)
  SELECT 2,'FINAL','HON OS sign-up and free trial terms','1e7ad73b54f574e333071c37883f2eb313a05e4063860547df7575615a303fdb',clock_timestamp()
  WHERE NOT EXISTS (SELECT 1 FROM hon.hon_os_signup_terms_versions WHERE version=2);
CREATE FUNCTION hon.hon_os_signup_terms_current() RETURNS hon.hon_os_signup_terms_versions LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT t FROM hon.hon_os_signup_terms_versions t ORDER BY (t.status='FINAL') DESC, t.version DESC LIMIT 1
$$;
-- register_hon_os_school (0241) accepts the newest version, which is v2 now; this guard keeps that true if a draft is ever
-- added above a FINAL version: a registration must accept the current terms.
CREATE FUNCTION hon.guard_hon_os_signup_current_terms() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NEW.terms_version_id IS DISTINCT FROM (hon.hon_os_signup_terms_current()).id THEN RAISE EXCEPTION 'SIGNUP_TERMS_CHANGED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER current_terms BEFORE INSERT ON hon.hon_os_school_registrations FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_os_signup_current_terms();

-- ---------- 2. HQ switch ----------
CREATE TABLE hon.hon_os_program_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE CHECK (version BETWEEN 1 AND 999999999),
  signup_status text NOT NULL CHECK (signup_status IN ('CLOSED','TEST_MODE','OPEN')),
  trial_status text NOT NULL CHECK (trial_status IN ('CLOSED','TEST_MODE','OPEN')),
  reason text CHECK (reason IS NULL OR (reason=btrim(reason) AND length(reason) BETWEEN 10 AND 500)),
  actor_principal_id uuid REFERENCES hon.principals(id),
  idempotency_key uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- An HQ change carries its actor, key and reason and never sets TEST_MODE; an owner-recorded version carries no actor.
  CHECK ((actor_principal_id IS NULL AND idempotency_key IS NULL)
    OR (actor_principal_id IS NOT NULL AND idempotency_key IS NOT NULL AND reason IS NOT NULL
      AND signup_status IN ('CLOSED','OPEN') AND trial_status IN ('CLOSED','OPEN'))),
  UNIQUE (actor_principal_id, idempotency_key)
);
INSERT INTO hon.hon_os_program_versions(version,signup_status,trial_status,reason,recorded_at)
  VALUES (1,hon.hon_os_signup_status(),hon.hon_os_trial_status(),'Program state at migration 0710',clock_timestamp());
CREATE FUNCTION hon.hon_os_programs_now() RETURNS hon.hon_os_program_versions LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT v FROM hon.hon_os_program_versions v ORDER BY v.version DESC LIMIT 1
$$;
CREATE FUNCTION hon.hon_os_programs_json(v hon.hon_os_program_versions) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('versionId',v.id,'version',v.version,'signup',v.signup_status,'trial',v.trial_status,'reason',v.reason,
    'recordedBy',CASE WHEN v.actor_principal_id IS NULL THEN 'MIGRATION_OWNER' ELSE 'HQ_OWNER' END,
    'actorPrincipalId',v.actor_principal_id,'recordedAt',hon.saas_ts(v.recorded_at));
$$;
CREATE FUNCTION hon.guard_hon_os_program_version_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hon_os.programs',0));
  IF NEW.version<>coalesce((SELECT max(version) FROM hon.hon_os_program_versions),0)+1 THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF NEW.actor_principal_id IS NOT NULL THEN
    SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=NEW.actor_principal_id;
    PERFORM hon.require_saas_hq_actor(subject,true);
    IF NOT EXISTS (SELECT 1 FROM hon.saas_requests r WHERE r.actor_principal_id=NEW.actor_principal_id AND r.idempotency_key=NEW.idempotency_key
      AND r.operation='saas.signup_programs.set' AND r.status='IN_PROGRESS') THEN RAISE EXCEPTION 'PROGRAM_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION hon.verify_hon_os_program_version_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE data jsonb:=hon.hon_os_programs_json(NEW);
BEGIN
  IF NEW.actor_principal_id IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.saas_requests r JOIN hon.saas_audit a USING(actor_principal_id,idempotency_key) JOIN hon.saas_outbox o ON o.audit_id=a.id
    WHERE r.actor_principal_id=NEW.actor_principal_id AND r.idempotency_key=NEW.idempotency_key AND r.status='COMPLETED' AND r.operation='saas.signup_programs.set'
      AND r.response_body->'programs'=data AND a.action_code='saas.signup_programs.set' AND a.entity_type='SIGNUP_PROGRAMS' AND a.entity_id=NEW.id
      AND a.organization_id IS NULL AND a.next_state=data AND o.event_type='saas.signup_programs.set')
    OR hon.hon_os_signup_status()<>NEW.signup_status OR hon.hon_os_trial_status()<>NEW.trial_status
  THEN RAISE EXCEPTION 'PROGRAM_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER program_version_authority BEFORE INSERT ON hon.hon_os_program_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_os_program_version_insert();
CREATE CONSTRAINT TRIGGER program_version_evidence AFTER INSERT ON hon.hon_os_program_versions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hon.verify_hon_os_program_version_evidence();
CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.hon_os_program_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.hon_os_program_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- HQ owner only. p: {expectedVersion, signup, trial, reason}; signup and trial are CLOSED or OPEN.
CREATE FUNCTION hon.set_hon_os_programs(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; replay jsonb; prior hon.hon_os_program_versions; made hon.hon_os_program_versions; at timestamptz;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  IF NOT hon.saas_trial_keys(p,ARRAY['expectedVersion','signup','trial','reason'])
    OR NOT hon.saas_trial_uint(p->'expectedVersion',1,999999998)
    OR jsonb_typeof(p->'signup') IS DISTINCT FROM 'string' OR p->>'signup' NOT IN ('CLOSED','OPEN')
    OR jsonb_typeof(p->'trial') IS DISTINCT FROM 'string' OR p->>'trial' NOT IN ('CLOSED','OPEN')
    OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string' OR p->>'reason'<>btrim(p->>'reason') OR length(p->>'reason') NOT BETWEEN 10 AND 500
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  actor:=hon.require_saas_hq_actor(p_subject,true);
  LOCK TABLE hon.users,hon.principals,hon.hq_operator_grants,hon.family_access_grants IN SHARE MODE;
  actor:=hon.require_saas_hq_actor(p_subject,true);
  replay:=hon.saas_claim_request(actor,p_key,'saas.signup_programs.set',hon.saas_fingerprint(ARRAY['saas.signup_programs.set',p::text]),p_request,p_correlation);
  IF replay IS NOT NULL THEN PERFORM hon.require_saas_hq_actor(p_subject,true); RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon_os.programs',0));
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  prior:=hon.hon_os_programs_now();
  IF prior.version<>(p->>'expectedVersion')::int THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  at:=clock_timestamp();
  UPDATE hon.hon_os_signup_program SET status=p->>'signup',recorded_at=at WHERE program_id=1;
  UPDATE hon.hon_os_trial_program SET status=p->>'trial',recorded_at=at WHERE program_id=1;
  INSERT INTO hon.hon_os_program_versions(version,signup_status,trial_status,reason,actor_principal_id,idempotency_key,recorded_at)
    VALUES (prior.version+1,p->>'signup',p->>'trial',p->>'reason',actor,p_key,at) RETURNING * INTO made;
  RETURN hon.saas_record(actor,p_key,'saas.signup_programs.set','saas.signup_programs.set','SIGNUP_PROGRAMS',made.id,NULL,
    hon.hon_os_programs_json(prior),hon.hon_os_programs_json(made),jsonb_build_object('programs',hon.hon_os_programs_json(made)),at);
END $$;

-- HQ owner or HQ billing reader. Changes nothing.
CREATE FUNCTION hon.read_hon_os_programs(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,false);
  RETURN jsonb_build_object('programs',hon.hon_os_programs_json(hon.hon_os_programs_now()),
    'history',(SELECT coalesce(jsonb_agg(hon.hon_os_programs_json(v) ORDER BY v.version DESC),'[]') FROM
      (SELECT * FROM hon.hon_os_program_versions ORDER BY version DESC LIMIT 50) v),
    'current',jsonb_build_object('signup',hon.hon_os_signup_status(),'trial',hon.hon_os_trial_status()),
    'terms',hon.hon_os_signup_terms_json(hon.hon_os_signup_terms_current()),
    'asOf',hon.saas_ts(clock_timestamp()));
END $$;

-- ---------- owner-facing reads report the real status ----------
CREATE OR REPLACE FUNCTION hon.read_hon_os_registration(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r hon.hon_os_school_registrations%ROWTYPE; t hon.hon_os_signup_terms_versions%ROWTYPE; actor uuid; eligibility text;
BEGIN
  IF p_subject IS NULL OR length(p_subject)>2048 THEN RAISE EXCEPTION 'SIGNUP_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.saas_refuse_context();
  t:=hon.hon_os_signup_terms_current();
  SELECT * INTO r FROM hon.hon_os_school_registrations WHERE subject=p_subject;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.is_active AND p.principal_type='HUMAN_USER'
    WHERE u.external_subject=p_subject LIMIT 1;
  eligibility:=CASE WHEN r.id IS NOT NULL THEN 'ALREADY_REGISTERED'
    WHEN p_subject NOT LIKE 'oidc:%' THEN 'VERIFIED_SIGN_IN_REQUIRED'
    WHEN actor IS NOT NULL AND (EXISTS (SELECT 1 FROM hon.principal_role_grants g WHERE g.principal_id=actor AND g.revoked_at IS NULL
        AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
      OR EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=actor)
      OR EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=actor AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp())))
      THEN 'HAS_OTHER_ACCESS'
    ELSE 'ELIGIBLE' END;
  RETURN jsonb_build_object('signupStatus',hon.hon_os_signup_status(),
    'terms',hon.hon_os_signup_terms_json(t),'eligibility',eligibility,
    'registration',CASE WHEN r.id IS NULL THEN NULL ELSE hon.hon_os_registration_json(r) END);
END $$;

CREATE OR REPLACE FUNCTION hon.read_hon_os_trial(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r hon.hon_os_school_registrations%ROWTYPE; t hon.hon_os_trial_enrollments%ROWTYPE; offer jsonb; at timestamptz:=clock_timestamp();
BEGIN
  IF p_subject IS NULL OR length(p_subject)>2048 THEN RAISE EXCEPTION 'TRIAL_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.saas_refuse_context();
  SELECT * INTO r FROM hon.hon_os_school_registrations WHERE subject=p_subject;
  IF r.id IS NOT NULL THEN SELECT * INTO t FROM hon.hon_os_trial_enrollments WHERE organization_id=r.organization_id; END IF;
  IF r.id IS NOT NULL AND t.id IS NULL THEN
    -- The newest eligible public campaign that still has room.
    SELECT o INTO offer FROM (SELECT hon.hon_os_trial_campaign_offer(c.campaign_id,at) o FROM (SELECT DISTINCT campaign_id FROM hon.saas_trial_publications) c) z
      WHERE o IS NOT NULL AND (SELECT count(*) FROM hon.hon_os_trial_enrollments e WHERE e.campaign_id=(o->>'campaignId')::uuid)<(o->>'maximumEnrollments')::integer
      ORDER BY o->>'enrollmentClosesAt', o->>'campaignId' LIMIT 1;
  END IF;
  RETURN jsonb_build_object('trialStatus',hon.hon_os_trial_status(),
    'schoolId',r.school_id,
    'available',CASE WHEN offer IS NULL OR NOT hon.hon_os_trial_open() THEN NULL
      ELSE jsonb_build_object('campaignId',offer->'campaignId','name',offer->'name','durationDays',offer->'durationDays',
        'automaticCharge',false,'paymentMethodRequired',false,'aiIncluded',jsonb_typeof(offer->'promotionalBudget')='object',
        'aiCredits',CASE WHEN jsonb_typeof(offer->'promotionalBudget')='object' THEN jsonb_build_object(
          'credits',(offer->'promotionalBudget'->>'creditsPerEnrollment')::integer,'dailyCap',(offer->'promotionalBudget'->>'dailyCreditCap')::integer,
          'perRequestCap',(offer->'promotionalBudget'->>'perRequestCreditCap')::integer,
          'expiryDays',(offer->'promotionalBudget'->>'creditExpiryDays')::integer) END) END,
    'trial',CASE WHEN t.id IS NULL THEN NULL ELSE hon.hon_os_trial_json(t) END);
END $$;

DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_action_code_check';
  ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
  EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR action_code IN (''saas.signup_programs.set''))';
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_entity_type_check';
  ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
  EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR entity_type IN (''SIGNUP_PROGRAMS''))';
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_outbox'::regclass AND conname='saas_outbox_event_type_check';
  ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
  EXECUTE 'ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR event_type IN (''saas.signup_programs.set''))';
END $$;

DO $$ DECLARE f text; r text; BEGIN
  ALTER TABLE hon.hon_os_program_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.hon_os_program_versions FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON hon.hon_os_program_versions FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.hon_os_program_versions FROM %I',r); END LOOP;
  FOREACH f IN ARRAY ARRAY['hon_os_signup_open()','hon_os_trial_open()','hon_os_signup_status()','hon_os_trial_status()',
    'stamp_hon_os_signup_program_status()','stamp_hon_os_trial_program_status()','hon_os_signup_terms_current()','guard_hon_os_signup_current_terms()',
    'hon_os_programs_now()','hon_os_programs_json(hon.hon_os_program_versions)','guard_hon_os_program_version_insert()',
    'verify_hon_os_program_version_evidence()','set_hon_os_programs(text,jsonb,uuid,uuid,uuid)','read_hon_os_programs(text)',
    'read_hon_os_registration(text)','read_hon_os_trial(text)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.set_hon_os_programs(text,jsonb,uuid,uuid,uuid),hon.read_hon_os_programs(text),
      hon.read_hon_os_registration(text),hon.read_hon_os_trial(text) TO hon_runtime;
  END IF;
END $$;
COMMIT;
