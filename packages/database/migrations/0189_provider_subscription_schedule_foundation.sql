BEGIN;

-- Commercial B1: inert acceptance-to-generation lineage ONLY. No provider or payable checkout.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
  AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
END $$;

CREATE TABLE hon.saas_subscription_generations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), acceptance_id uuid NOT NULL UNIQUE REFERENCES hon.saas_price_acceptances(id),
 organization_id uuid NOT NULL REFERENCES hon.organizations(id), school_id uuid NOT NULL REFERENCES hon.schools(id),
 acceptance_snapshot jsonb NOT NULL CHECK(jsonb_typeof(acceptance_snapshot)='object'),
 generation_digest text NOT NULL CHECK(generation_digest ~ '^[0-9a-f]{64}$'),
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), idempotency_key uuid NOT NULL,
 recorded_at timestamptz NOT NULL,
 FOREIGN KEY(actor_principal_id,idempotency_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key),
 UNIQUE(actor_principal_id,idempotency_key)
);

-- Use the established IAM order, but never wait holding a partial table-lock prefix.
-- Provisioning writes organization -> school -> role -> grants; a waiting broad SHARE
-- acquisition in the opposite direction could otherwise create an inherited A2/D9 cycle.
-- NOWAIT aborts the complete command before its request claim; explicit exact retry only.
CREATE FUNCTION hon.saas_generation_lock_authority() RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
 LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.family_access_grants,hon.hq_operator_grants,
  hon.roles,hon.role_permissions,hon.permissions,hon.organizations,hon.schools IN SHARE MODE NOWAIT;
END $$;

CREATE FUNCTION hon.saas_generation_content(p_id uuid,p_acceptance uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE a hon.saas_price_acceptances%ROWTYPE; s hon.saas_price_schedules%ROWTYPE;
BEGIN
 SELECT * INTO a FROM hon.saas_price_acceptances WHERE id=p_acceptance;
 SELECT * INTO s FROM hon.saas_price_schedules WHERE id=a.schedule_id;
 IF a.id IS NULL OR s.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 IF a.schedule_digest<>s.schedule_digest OR a.disclosure_version<>s.disclosure_version OR a.disclosure_text<>s.disclosure_text
  OR a.confirmation<>'ACCEPT_INITIAL_AND_SCHEDULED_RENEWAL_PRICES' OR a.founder_allocation_id IS NOT NULL
  OR s.terms->>'offerKind' NOT IN ('REGULAR_MONTHLY','REGULAR_ANNUAL')
  OR a.acceptance_digest<>hon.saas_hon_os_digest(jsonb_build_object('organizationId',a.organization_id,'schoolId',a.school_id,'scheduleId',s.id,'scheduleDigest',s.schedule_digest))
  THEN RAISE EXCEPTION 'SAAS_GENERATION_ACCEPTANCE_INVALID' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('schemaVersion',1,'generationId',p_id,'organizationId',a.organization_id,'schoolId',a.school_id,
  'acceptance',hon.saas_price_acceptance_json(a),'provider',jsonb_build_object('identity','UNCONFIGURED','mode','TEST',
   'generationReference',p_id,'accountReference',NULL,'subscriptionReference',NULL,'scheduleReference',NULL,'bindingStatus','NOT_BOUND'));
END $$;

CREATE FUNCTION hon.saas_generation_json(p hon.saas_subscription_generations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('generationId',p.id,'organizationId',p.organization_id,'schoolId',p.school_id,
  'acceptance',p.acceptance_snapshot,'generationDigest',p.generation_digest,'actorPrincipalId',p.actor_principal_id,
  'idempotencyKey',p.idempotency_key,'recordedAt',hon.saas_ts(p.recorded_at),
  'provider',jsonb_build_object('identity','UNCONFIGURED','mode','TEST','generationReference',p.id,'accountReference',NULL,
   'subscriptionReference',NULL,'scheduleReference',NULL,'bindingStatus','NOT_BOUND'),
  'checkoutAvailable',false,'billingEnabled',false,'accessGranted',false,'paidPeriodEvidence','NOT_IMPLEMENTED_B2')
$$;

CREATE FUNCTION hon.saas_generation_available(p_acceptance uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE s hon.saas_price_schedules%ROWTYPE; o hon.saas_offer_set_offers%ROWTYPE;
BEGIN
 SELECT ps.* INTO s FROM hon.saas_price_acceptances a JOIN hon.saas_price_schedules ps ON ps.id=a.schedule_id WHERE a.id=p_acceptance;
 SELECT * INTO o FROM hon.saas_offer_set_offers WHERE id=s.offer_id;
 IF o.id IS NULL OR NOT hon.saas_hon_os_offer_on_sale(o,clock_timestamp())
  THEN RAISE EXCEPTION 'SAAS_OFFER_NOT_AVAILABLE' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION hon.record_saas_subscription_generation(p_subject text,p_school uuid,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor record; replay jsonb; a hon.saas_price_acceptances%ROWTYPE; created hon.saas_subscription_generations%ROWTYPE;
 new_id uuid:=gen_random_uuid(); content jsonb; at timestamptz;
BEGIN
 IF NOT hon.saas_trial_keys(p,ARRAY['acceptanceId','acceptanceDigest','confirmation'])
  OR coalesce(p->>'acceptanceId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR coalesce(p->>'acceptanceDigest','') !~ '^[0-9a-f]{64}$'
  OR p->>'confirmation' IS DISTINCT FROM 'RECORD_SUBSCRIPTION_GENERATION_ONLY_NO_BILLING'
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
 PERFORM hon.saas_generation_lock_authority(); SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
 replay:=hon.saas_claim_request(actor.principal_id,p_key,'saas.subscription_generation.record',
  hon.saas_fingerprint(ARRAY['saas.subscription_generation.record',p_school::text,p::text]),p_request,p_correlation);
 IF replay IS NOT NULL THEN PERFORM hon.require_saas_school_purchaser(p_subject,p_school); RETURN replay; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('saas.offer_sets',0));
 LOCK TABLE hon.saas_offer_sets,hon.saas_offer_sales_stops IN SHARE MODE;
 SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
 SELECT * INTO a FROM hon.saas_price_acceptances WHERE id=(p->>'acceptanceId')::uuid AND organization_id=actor.organization_id AND school_id=p_school;
 IF a.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 IF a.acceptance_digest IS DISTINCT FROM p->>'acceptanceDigest' THEN RAISE EXCEPTION 'SAAS_GENERATION_ACCEPTANCE_STALE' USING ERRCODE='40001'; END IF;
 content:=hon.saas_generation_content(new_id,a.id);
 PERFORM hon.saas_generation_available(a.id);
 IF EXISTS(SELECT 1 FROM hon.saas_subscription_generations WHERE acceptance_id=a.id)
  THEN RAISE EXCEPTION 'SAAS_GENERATION_EXISTS' USING ERRCODE='40001'; END IF;
 at:=clock_timestamp();
 INSERT INTO hon.saas_subscription_generations(id,acceptance_id,organization_id,school_id,acceptance_snapshot,generation_digest,actor_principal_id,idempotency_key,recorded_at)
 VALUES(new_id,a.id,actor.organization_id,p_school,content->'acceptance',hon.saas_hon_os_digest(content),actor.principal_id,p_key,at) RETURNING * INTO created;
 RETURN hon.saas_record(actor.principal_id,p_key,'saas.subscription_generation.record','saas.subscription_generation.recorded',
  'SUBSCRIPTION_GENERATION',created.id,actor.organization_id,NULL,hon.saas_generation_json(created),
  jsonb_build_object('generation',hon.saas_generation_json(created)),at);
END $$;

CREATE FUNCTION hon.read_saas_subscription_generation(p_subject text,p_school uuid,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor record; g hon.saas_subscription_generations%ROWTYPE;
BEGIN
 SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
 SELECT * INTO g FROM hon.saas_subscription_generations WHERE id=p_id AND organization_id=actor.organization_id AND school_id=p_school;
 IF g.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 RETURN hon.saas_generation_json(g);
END $$;
CREATE FUNCTION hon.read_saas_subscription_generation_from_hq(p_subject text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE g hon.saas_subscription_generations%ROWTYPE;
BEGIN
 PERFORM hon.require_saas_hq_actor(p_subject,false);
 SELECT * INTO g FROM hon.saas_subscription_generations WHERE id=p_id;
 IF g.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 RETURN hon.saas_generation_json(g);
END $$;

CREATE FUNCTION hon.guard_saas_generation_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject text; actor record; content jsonb; a hon.saas_price_acceptances%ROWTYPE;
BEGIN
 SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=NEW.actor_principal_id;
 SELECT * INTO actor FROM hon.require_saas_school_purchaser(subject,NEW.school_id);
 SELECT * INTO a FROM hon.saas_price_acceptances WHERE id=NEW.acceptance_id;
 content:=hon.saas_generation_content(NEW.id,NEW.acceptance_id);
 PERFORM hon.saas_generation_available(NEW.acceptance_id);
 IF actor.principal_id<>NEW.actor_principal_id OR actor.organization_id<>NEW.organization_id
  OR a.organization_id<>NEW.organization_id OR a.school_id<>NEW.school_id
  OR NEW.acceptance_snapshot IS DISTINCT FROM content->'acceptance'
  OR NEW.generation_digest<>hon.saas_hon_os_digest(content) OR NEW.recorded_at<a.accepted_at OR NEW.recorded_at>clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM hon.saas_requests WHERE actor_principal_id=NEW.actor_principal_id AND idempotency_key=NEW.idempotency_key
   AND operation='saas.subscription_generation.record' AND status='IN_PROGRESS')
  THEN RAISE EXCEPTION 'SAAS_GENERATION_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION hon.verify_saas_generation_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject text; data jsonb;
BEGIN
 SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=NEW.actor_principal_id;
 PERFORM hon.require_saas_school_purchaser(subject,NEW.school_id);
 PERFORM hon.saas_generation_available(NEW.acceptance_id);
 data:=hon.saas_generation_json(NEW);
 IF NOT EXISTS(SELECT 1 FROM hon.saas_requests r JOIN hon.saas_audit a USING(actor_principal_id,idempotency_key) JOIN hon.saas_outbox o ON o.audit_id=a.id
  WHERE r.actor_principal_id=NEW.actor_principal_id AND r.idempotency_key=NEW.idempotency_key AND r.status='COMPLETED'
   AND r.operation='saas.subscription_generation.record' AND r.response_body->'generation'=data
   AND a.action_code=r.operation AND a.entity_type='SUBSCRIPTION_GENERATION' AND a.entity_id=NEW.id
   AND a.organization_id=NEW.organization_id AND a.next_state=data AND o.event_type='saas.subscription_generation.recorded'
   AND o.payload->>'executionAllowed'='false')
  THEN RAISE EXCEPTION 'SAAS_GENERATION_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

ALTER TABLE hon.saas_subscription_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.saas_subscription_generations FORCE ROW LEVEL SECURITY;
CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.saas_subscription_generations FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_subscription_generations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER saas_generation_authority BEFORE INSERT ON hon.saas_subscription_generations FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_generation_insert();
CREATE CONSTRAINT TRIGGER saas_generation_evidence AFTER INSERT ON hon.saas_subscription_generations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_generation_evidence();

DO $$ DECLARE def text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_action_code_check';
 ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
 EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR action_code=''saas.subscription_generation.record'')';
 SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_entity_type_check';
 ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
 EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR entity_type=''SUBSCRIPTION_GENERATION'')';
 SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_outbox'::regclass AND conname='saas_outbox_event_type_check';
 ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
 EXECUTE 'ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR event_type=''saas.subscription_generation.recorded'')';
END $$;

DO $$ DECLARE r text;c text;f text; BEGIN
 REVOKE ALL ON TABLE hon.saas_subscription_generations FROM PUBLIC;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.saas_subscription_generations FROM %I',r); END LOOP;
 FOR c IN SELECT attname FROM pg_attribute WHERE attrelid='hon.saas_subscription_generations'::regclass AND attnum>0 AND NOT attisdropped LOOP
  EXECUTE format('REVOKE ALL (%I) ON hon.saas_subscription_generations FROM PUBLIC',c);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.saas_subscription_generations FROM %I',c,r); END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['hon.saas_generation_lock_authority()','hon.saas_generation_content(uuid,uuid)','hon.saas_generation_json(hon.saas_subscription_generations)',
  'hon.saas_generation_available(uuid)','hon.record_saas_subscription_generation(text,uuid,jsonb,uuid,uuid,uuid)',
  'hon.read_saas_subscription_generation(text,uuid,uuid)','hon.read_saas_subscription_generation_from_hq(text,uuid)',
  'hon.guard_saas_generation_insert()','hon.verify_saas_generation_evidence()'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.record_saas_subscription_generation(text,uuid,jsonb,uuid,uuid,uuid),
   hon.read_saas_subscription_generation(text,uuid,uuid),hon.read_saas_subscription_generation_from_hq(text,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
