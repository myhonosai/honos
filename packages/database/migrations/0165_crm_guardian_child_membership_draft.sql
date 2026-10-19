BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Guardian-child CRM membership draft requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Guardian-child CRM membership draft requires a restricted runtime';
  END IF;
END $$;

-- Lifetime immutable linkage, not a parallel membership model. Source first is
-- necessary for the BEFORE INSERT guard; the scoped membership FK is deferred.
CREATE TABLE hon.crm_guardian_child_membership_draft_sources (
  conversion_id uuid PRIMARY KEY,
  designation_id uuid NOT NULL UNIQUE,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  membership_id uuid NOT NULL UNIQUE,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,school_id,actor_principal_id,idempotency_key),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(conversion_id,organization_id,school_id) REFERENCES hon.crm_lead_registration_conversions(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(designation_id,organization_id,school_id) REFERENCES hon.crm_guardian_child_payer_designations(id,organization_id,school_id) ON DELETE RESTRICT,
  CONSTRAINT crm_guardian_child_draft_membership_fk FOREIGN KEY(membership_id,organization_id,school_id)
    REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE hon.crm_guardian_child_membership_draft_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_guardian_child_membership_draft_sources FORCE ROW LEVEL SECURITY;
CREATE FUNCTION hon.guard_crm_guardian_child_membership_draft_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_SOURCE' USING ERRCODE='42501'; END $$;
CREATE TRIGGER crm_guardian_child_membership_source_immutable BEFORE UPDATE OR DELETE ON hon.crm_guardian_child_membership_draft_sources FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_guardian_child_membership_draft_source();
CREATE TRIGGER crm_guardian_child_membership_source_no_truncate BEFORE TRUNCATE ON hon.crm_guardian_child_membership_draft_sources FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_crm_guardian_child_membership_draft_source();

-- Private source evidence is unforgeable by runtime and client roles. A generic
-- insert for this CRM child is denied even if it knows every public identifier.
CREATE FUNCTION hon.guard_crm_guardian_child_membership_insert() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE source hon.crm_guardian_child_membership_draft_sources%ROWTYPE;
  designation hon.crm_guardian_child_payer_designations%ROWTYPE; current_facts jsonb; actor uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.crm_lead_registration_conversions c
      JOIN hon.student_profiles s ON s.id=c.resulting_student_profile_id AND s.organization_id=c.organization_id AND s.school_id=c.school_id
      WHERE c.organization_id=NEW.organization_id AND c.school_id=NEW.school_id AND c.registration_path='GUARDIAN_CHILD' AND s.person_id=NEW.participant_person_id)
    AND NOT EXISTS(SELECT 1 FROM hon.crm_guardian_child_payer_designations d WHERE d.organization_id=NEW.organization_id AND d.school_id=NEW.school_id AND d.child_person_id=NEW.participant_person_id) THEN
    RETURN NEW;
  END IF;
  actor:=hon.require_crm_guardian_child_membership_actor(current_setting('app.hon_external_subject',true));
  SELECT * INTO source FROM hon.crm_guardian_child_membership_draft_sources x
    WHERE x.membership_id=NEW.id AND x.organization_id=NEW.organization_id AND x.school_id=NEW.school_id AND x.actor_principal_id=actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO designation FROM hon.crm_guardian_child_payer_designations d WHERE d.id=source.designation_id
    AND d.conversion_id=source.conversion_id AND d.organization_id=NEW.organization_id AND d.school_id=NEW.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  current_facts:=hon.crm_guardian_child_designated_relation(designation.student_profile_id);
  IF NEW.organization_id IS DISTINCT FROM hon.current_organization_id() OR NEW.school_id IS DISTINCT FROM hon.current_school_id()
    OR current_facts->>'designation_id' IS DISTINCT FROM designation.id::text
    OR NEW.state IS DISTINCT FROM 'DRAFT'::hon.membership_state OR NEW.version<>1
    OR NEW.billing_account_id<>designation.billing_account_id OR NEW.participant_person_id<>designation.child_person_id
    OR source.receipt IS DISTINCT FROM jsonb_build_object('membershipId',NEW.id,'state','DRAFT','planCode',NEW.plan_code,
      'termStartedAt',CASE WHEN NEW.term_started_at IS NULL THEN NULL ELSE to_char(NEW.term_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'termEndsAt',CASE WHEN NEW.term_ends_at IS NULL THEN NULL ELSE to_char(NEW.term_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'recordedAt',to_char(source.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    OR NEW.created_at IS DISTINCT FROM source.created_at
    OR NOT EXISTS(SELECT 1 FROM hon.idempotency_records i WHERE i.organization_id=NEW.organization_id AND i.school_id=NEW.school_id AND i.principal_id=actor
      AND i.idempotency_key=source.idempotency_key::text AND i.request_fingerprint=source.request_fingerprint AND i.status='IN_PROGRESS')
    OR EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=NEW.organization_id AND m.school_id=NEW.school_id AND m.participant_person_id=NEW.participant_person_id) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_guardian_child_membership_source_required BEFORE INSERT ON hon.memberships FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_guardian_child_membership_insert();

CREATE FUNCTION hon.read_crm_guardian_child_membership_preparation(subject text,selected_student uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE relation record; result jsonb;
BEGIN
  PERFORM hon.require_crm_guardian_child_membership_actor(subject);
  PERFORM hon.require_crm_guardian_child_membership_actor(subject);
  PERFORM hon.crm_guardian_child_designated_relation(selected_student);
  SELECT * INTO relation FROM hon.crm_guardian_child_membership_relation(selected_student);
  -- Already consumed sources are unavailable without membership match disclosure.
  IF EXISTS(SELECT 1 FROM hon.crm_guardian_child_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id())
    OR EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=hon.current_organization_id() AND m.school_id=hon.current_school_id() AND m.participant_person_id=relation.child_person_id) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  result:=jsonb_build_object('studentDisplayName',relation.student_display_name,'guardianDisplayName',relation.guardian_display_name,'currency',relation.currency,'readiness','READY_FOR_DRAFT');
  PERFORM hon.require_crm_guardian_child_membership_actor(subject);
  RETURN result;
END $$;

CREATE FUNCTION hon.draft_crm_guardian_child_membership(subject text,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid; relation record; final_relation record;
  selected uuid; start_at timestamptz; end_at timestamptz; value text; field text; fp text;
  prior hon.idempotency_records%ROWTYPE; source hon.crm_guardian_child_membership_draft_sources%ROWTYPE; membership hon.memberships%ROWTYPE;
  result_receipt jsonb; instant timestamptz; membership_uuid uuid; designation_uuid uuid; designated_facts jsonb;
BEGIN
  actor:=hon.require_crm_guardian_child_membership_actor(subject);
  org:=hon.current_organization_id(); school:=hon.current_school_id();
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['studentProfileId','planCode','confirmation']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('studentProfileId','planCode','termStartedAt','termEndsAt','confirmation'))
    OR jsonb_typeof(p->'studentProfileId') IS DISTINCT FROM 'string' OR p->>'studentProfileId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR jsonb_typeof(p->'planCode') IS DISTINCT FROM 'string' OR length(p->>'planCode') NOT BETWEEN 1 AND 80
    OR btrim(p->>'planCode')<>p->>'planCode' OR p->>'planCode' ~ '[[:cntrl:]<>]'
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_CRM_MEMBERSHIP_DRAFT' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  selected:=(p->>'studentProfileId')::uuid;
  FOREACH field IN ARRAY ARRAY['termStartedAt','termEndsAt'] LOOP
    IF p ? field THEN
      value:=p->>field;
      IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' OR length(value)<>24 OR value !~ '^(19|[2-9][0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        OR to_char(value::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>value THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
      IF field='termStartedAt' THEN start_at:=value::timestamptz; ELSE end_at:=value::timestamptz; END IF;
    END IF;
  END LOOP;
  IF start_at IS NOT NULL AND end_at IS NOT NULL AND end_at<=start_at THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  -- Fixed lock order stabilizes live grants, phantom conversions, family and
  -- additional account inserts, source reuse and generic membership races. No
  -- client-selectable lock/function path; bounded service lock/statement timeout.
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements,hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts,hon.memberships,hon.crm_guardian_child_payer_designations,hon.crm_guardian_child_membership_draft_sources,hon.idempotency_records,hon.membership_payment_schedules,hon.invoices IN SHARE ROW EXCLUSIVE MODE;
  actor:=hon.require_crm_guardian_child_membership_actor(subject);
  designated_facts:=hon.crm_guardian_child_designated_relation(selected);
  designation_uuid:=(designated_facts->>'designation_id')::uuid;
  SELECT * INTO relation FROM hon.crm_guardian_child_membership_relation(selected);
  PERFORM 1 FROM hon.crm_lead_registration_conversions WHERE id=relation.conversion_id AND organization_id=org AND school_id=school FOR UPDATE;
  PERFORM 1 FROM hon.billing_accounts WHERE id=relation.account_id AND organization_id=org AND school_id=school FOR UPDATE;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','crm.guardian_child.membership.draft','input',p || jsonb_build_object('studentProfileId',selected))::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
  IF FOUND THEN
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    SELECT * INTO source FROM hon.crm_guardian_child_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id AND x.organization_id=org AND x.school_id=school FOR UPDATE;
    IF NOT FOUND OR source.actor_principal_id<>actor OR source.designation_id<>designation_uuid OR source.idempotency_key<>key OR source.request_fingerprint<>fp
      OR prior.status<>'COMPLETED' OR prior.response_body IS DISTINCT FROM source.receipt THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
    -- Stored receipt is historical DRAFT creation, not a claim of current state.
    PERFORM 1 FROM hon.memberships m WHERE m.id=source.membership_id AND m.organization_id=org AND m.school_id=school
      AND m.billing_account_id=relation.account_id AND m.participant_person_id=relation.child_person_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    PERFORM hon.require_crm_guardian_child_membership_actor(subject);
    RETURN jsonb_build_object('receipt',source.receipt,'replayed',true);
  END IF;
  IF EXISTS(SELECT 1 FROM hon.crm_guardian_child_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id)
    OR EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=relation.child_person_id) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key::text,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours');
  instant:=clock_timestamp(); membership_uuid:=gen_random_uuid();
  result_receipt:=jsonb_build_object('membershipId',membership_uuid,'state','DRAFT','planCode',p->>'planCode',
    'termStartedAt',p->>'termStartedAt','termEndsAt',p->>'termEndsAt','recordedAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO hon.crm_guardian_child_membership_draft_sources(conversion_id,designation_id,organization_id,school_id,membership_id,actor_principal_id,idempotency_key,request_fingerprint,receipt,created_at)
    VALUES(relation.conversion_id,designation_uuid,org,school,membership_uuid,actor,key,fp,result_receipt,instant);
  INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at,created_at)
    VALUES(membership_uuid,org,school,relation.account_id,relation.child_person_id,p->>'planCode','DRAFT',start_at,end_at,instant) RETURNING * INTO membership;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership.create','MEMBERSHIP',membership.id,NULL,result_receipt,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership.drafted',1,'MEMBERSHIP',membership.id,membership.version,correlation,request,result_receipt || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result_receipt
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text;
  -- Final relation and authority rechecks include all post-insert evidence.
  SELECT * INTO final_relation FROM hon.crm_guardian_child_membership_relation(selected);
  IF final_relation IS DISTINCT FROM relation OR hon.crm_guardian_child_designated_relation(selected) IS DISTINCT FROM designated_facts OR membership.state<>'DRAFT' OR membership.version<>1
    OR NOT EXISTS(SELECT 1 FROM hon.memberships m WHERE m.id=membership.id AND m.organization_id=org AND m.school_id=school AND m.state='DRAFT'
      AND m.billing_account_id=relation.account_id AND m.participant_person_id=relation.child_person_id AND m.plan_code=p->>'planCode'
      AND m.version=1 AND m.created_at=instant AND m.term_started_at IS NOT DISTINCT FROM start_at AND m.term_ends_at IS NOT DISTINCT FROM end_at)
    OR EXISTS(SELECT 1 FROM hon.membership_payment_schedules s WHERE s.membership_id=membership.id)
    OR EXISTS(SELECT 1 FROM hon.invoices i WHERE i.membership_id=membership.id)
    OR NOT EXISTS(SELECT 1 FROM hon.crm_guardian_child_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id
      AND x.designation_id=designation_uuid AND x.organization_id=org AND x.school_id=school AND x.membership_id=membership.id AND x.actor_principal_id=actor
      AND x.idempotency_key=key AND x.request_fingerprint=fp AND x.receipt=result_receipt)
    OR NOT EXISTS(SELECT 1 FROM hon.idempotency_records x WHERE x.organization_id=org AND x.school_id=school AND x.principal_id=actor
      AND x.idempotency_key=key::text AND x.request_fingerprint=fp AND x.status='COMPLETED' AND x.response_status=200 AND x.response_body=result_receipt)
    OR (SELECT count(*) FROM hon.audit_events x WHERE x.organization_id=org AND x.school_id=school AND x.entity_id=membership.id
      AND x.actor_principal_id=actor AND x.source='HUMAN_UI' AND x.action_code='billing.membership.create' AND x.next_state=result_receipt
      AND x.request_id=request AND x.correlation_id=correlation AND x.action_request_id IS NULL AND x.result='SUCCEEDED')<>1
    OR (SELECT count(*) FROM hon.outbox_events x WHERE x.organization_id=org AND x.school_id=school AND x.aggregate_id=membership.id
      AND x.event_type='billing.membership.drafted' AND x.aggregate_version=membership.version AND x.causation_id=request AND x.correlation_id=correlation
      AND x.schema_version=1 AND x.payload=result_receipt || jsonb_build_object('executionAllowed',false,'humanOnly',true))<>1
    OR (SELECT count(*) FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=relation.child_person_id)<>1 THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.require_crm_guardian_child_membership_actor(subject);
  RETURN jsonb_build_object('receipt',result_receipt,'replayed',false);
END $$;

ALTER TABLE hon.people FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.student_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.billing_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.memberships FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.crm_guardian_child_membership_draft_sources FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_crm_guardian_child_membership_draft_source(),hon.guard_crm_guardian_child_membership_insert(),hon.read_crm_guardian_child_membership_preparation(text,uuid),hon.draft_crm_guardian_child_membership(text,jsonb,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.crm_guardian_child_membership_draft_sources FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_crm_guardian_child_membership_draft_source(),hon.guard_crm_guardian_child_membership_insert(),hon.read_crm_guardian_child_membership_preparation(text,uuid),hon.draft_crm_guardian_child_membership(text,jsonb,uuid,uuid,uuid) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_crm_guardian_child_membership_preparation(text,uuid),hon.draft_crm_guardian_child_membership(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
