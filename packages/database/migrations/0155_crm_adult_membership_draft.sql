BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Adult CRM membership draft requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Adult CRM membership draft requires a restricted runtime';
  END IF;
END $$;

-- Immutable provenance, not a parallel membership model. This lifetime unique
-- source prevents distinct keys/actors from drafting this conversion again,
-- including after subsequent separately governed membership lifecycle changes.
CREATE TABLE hon.crm_adult_membership_draft_sources (
  conversion_id uuid PRIMARY KEY,
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
  FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.crm_adult_membership_draft_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_adult_membership_draft_sources FORCE ROW LEVEL SECURITY;
CREATE FUNCTION hon.guard_crm_adult_membership_draft_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_CRM_ADULT_MEMBERSHIP_DRAFT_SOURCE' USING ERRCODE='42501'; END $$;
CREATE TRIGGER crm_adult_membership_source_immutable BEFORE UPDATE OR DELETE ON hon.crm_adult_membership_draft_sources FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_adult_membership_draft_source();
CREATE TRIGGER crm_adult_membership_source_no_truncate BEFORE TRUNCATE ON hon.crm_adult_membership_draft_sources FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_crm_adult_membership_draft_source();

-- Private identity proof, independent of controller and generic membership API.
CREATE FUNCTION hon.require_crm_adult_membership_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions permission ON permission.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND permission.code='billing.membership.create' AND permission.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- Private exact relation proof. REGISTERED is the immutable conversion response
-- outcome (0153 has no status column). No match/count/reason escapes this helper.
CREATE FUNCTION hon.crm_adult_membership_relation(selected_student uuid)
RETURNS TABLE(conversion_id uuid,person_id uuid,account_id uuid,student_display_name text,currency text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); c hon.crm_lead_registration_conversions%ROWTYPE;
  s hon.student_profiles%ROWTYPE; account hon.billing_accounts%ROWTYPE; label text;
BEGIN
  IF selected_student IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM hon.crm_lead_registration_conversions x WHERE x.organization_id=org AND x.school_id=school AND x.resulting_student_profile_id=selected_student)<>1 THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO c FROM hon.crm_lead_registration_conversions x WHERE x.organization_id=org AND x.school_id=school AND x.resulting_student_profile_id=selected_student;
  IF c.registration_path IS DISTINCT FROM 'ADULT' OR c.family_id IS NOT NULL
    OR c.response->>'outcome' IS DISTINCT FROM 'REGISTERED' OR c.response->>'registrationPath' IS DISTINCT FROM 'ADULT'
    OR c.response->>'studentProfileId' IS DISTINCT FROM selected_student::text
    OR c.response->>'sourceContactPersonId' IS DISTINCT FROM c.original_contact_person_id::text
    OR c.response->>'leadId' IS DISTINCT FROM c.source_lead_id::text
    OR c.response->'familyId' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO s FROM hon.student_profiles x WHERE x.id=selected_student AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND OR s.status<>'ACTIVE' OR s.person_id<>c.original_contact_person_id OR s.primary_family_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM hon.family_members f WHERE f.organization_id=org AND f.school_id=school AND f.person_id=c.original_contact_person_id)
    OR NOT EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.id=c.source_lead_id AND l.organization_id=org AND l.school_id=school AND l.primary_person_id=c.original_contact_person_id)
    OR (SELECT count(*) FROM hon.student_profiles x WHERE x.organization_id=org AND x.school_id=school AND x.person_id=c.original_contact_person_id)<>1 THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF (SELECT count(*) FROM hon.billing_accounts a WHERE a.organization_id=org AND a.school_id=school AND a.responsible_person_id=c.original_contact_person_id)<>1 THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO account FROM hon.billing_accounts a WHERE a.organization_id=org AND a.school_id=school AND a.responsible_person_id=c.original_contact_person_id;
  SELECT btrim(concat_ws(' ',p.given_name,p.family_name)) INTO label FROM hon.people p WHERE p.id=c.original_contact_person_id AND p.organization_id=org AND p.school_id=school;
  IF NOT FOUND OR account.account_classification IS DISTINCT FROM 'CANONICAL' OR account.currency::text !~ '^[A-Z]{3}$'
    OR label IS NULL OR length(label) NOT BETWEEN 1 AND 201 OR label ~ '[[:cntrl:]<>]' THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN QUERY SELECT c.id,c.original_contact_person_id,account.id,label,account.currency::text;
END $$;

CREATE FUNCTION hon.read_crm_adult_membership_preparation(subject text,selected_student uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE relation record; result jsonb;
BEGIN
  PERFORM hon.require_crm_adult_membership_actor(subject);
  SELECT * INTO relation FROM hon.crm_adult_membership_relation(selected_student);
  -- Already consumed sources are unavailable without membership match disclosure.
  IF EXISTS(SELECT 1 FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id())
    OR EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=hon.current_organization_id() AND m.school_id=hon.current_school_id() AND m.participant_person_id=relation.person_id) THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  result:=jsonb_build_object('studentDisplayName',relation.student_display_name,'currency',relation.currency,'readiness','READY_FOR_DRAFT');
  PERFORM hon.require_crm_adult_membership_actor(subject);
  RETURN result;
END $$;

CREATE FUNCTION hon.draft_crm_adult_membership(subject text,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; relation record; final_relation record;
  selected uuid; start_at timestamptz; end_at timestamptz; value text; field text; fp text;
  prior hon.idempotency_records%ROWTYPE; source hon.crm_adult_membership_draft_sources%ROWTYPE; membership hon.memberships%ROWTYPE;
  result_receipt jsonb; instant timestamptz;
BEGIN
  actor:=hon.require_crm_adult_membership_actor(subject);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['studentProfileId','planCode','confirmation']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('studentProfileId','planCode','termStartedAt','termEndsAt','confirmation'))
    OR jsonb_typeof(p->'studentProfileId') IS DISTINCT FROM 'string' OR p->>'studentProfileId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR jsonb_typeof(p->'planCode') IS DISTINCT FROM 'string' OR length(p->>'planCode') NOT BETWEEN 1 AND 80
    OR btrim(p->>'planCode')<>p->>'planCode' OR p->>'planCode' ~ '[[:cntrl:]<>]'
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' THEN
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
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements,hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts,hon.memberships,hon.crm_adult_membership_draft_sources,hon.idempotency_records IN SHARE ROW EXCLUSIVE MODE;
  actor:=hon.require_crm_adult_membership_actor(subject);
  SELECT * INTO relation FROM hon.crm_adult_membership_relation(selected);
  PERFORM 1 FROM hon.crm_lead_registration_conversions WHERE id=relation.conversion_id AND organization_id=org AND school_id=school FOR UPDATE;
  PERFORM 1 FROM hon.billing_accounts WHERE id=relation.account_id AND organization_id=org AND school_id=school FOR UPDATE;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','crm.adult.membership.draft','input',p || jsonb_build_object('studentProfileId',selected))::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
  IF FOUND THEN
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    SELECT * INTO source FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id AND x.organization_id=org AND x.school_id=school FOR UPDATE;
    IF NOT FOUND OR source.actor_principal_id<>actor OR source.idempotency_key<>key OR source.request_fingerprint<>fp
      OR prior.status<>'COMPLETED' OR prior.response_body IS DISTINCT FROM source.receipt THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
    -- Stored receipt is historical DRAFT creation, not a claim of current state.
    PERFORM 1 FROM hon.memberships m WHERE m.id=source.membership_id AND m.organization_id=org AND m.school_id=school
      AND m.billing_account_id=relation.account_id AND m.participant_person_id=relation.person_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    PERFORM hon.require_crm_adult_membership_actor(subject);
    RETURN jsonb_build_object('receipt',source.receipt,'replayed',true);
  END IF;
  IF EXISTS(SELECT 1 FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id)
    OR EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=relation.person_id) THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key::text,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours');
  INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
    VALUES(org,school,relation.account_id,relation.person_id,p->>'planCode','DRAFT',start_at,end_at) RETURNING * INTO membership;
  instant:=clock_timestamp();
  result_receipt:=jsonb_build_object('membershipId',membership.id,'state','DRAFT','planCode',membership.plan_code,
    'termStartedAt',p->>'termStartedAt','termEndsAt',p->>'termEndsAt','recordedAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO hon.crm_adult_membership_draft_sources(conversion_id,organization_id,school_id,membership_id,actor_principal_id,idempotency_key,request_fingerprint,receipt,created_at)
    VALUES(relation.conversion_id,org,school,membership.id,actor,key,fp,result_receipt,instant);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership.create','MEMBERSHIP',membership.id,NULL,result_receipt,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership.drafted',1,'MEMBERSHIP',membership.id,membership.version,correlation,request,result_receipt || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result_receipt
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text;
  -- Final relation and authority rechecks include all post-insert evidence.
  SELECT * INTO final_relation FROM hon.crm_adult_membership_relation(selected);
  IF final_relation IS DISTINCT FROM relation OR membership.state<>'DRAFT'
    OR NOT EXISTS(SELECT 1 FROM hon.memberships m WHERE m.id=membership.id AND m.organization_id=org AND m.school_id=school AND m.state='DRAFT'
      AND m.billing_account_id=relation.account_id AND m.participant_person_id=relation.person_id AND m.plan_code=p->>'planCode'
      AND m.term_started_at IS NOT DISTINCT FROM start_at AND m.term_ends_at IS NOT DISTINCT FROM end_at)
    OR EXISTS(SELECT 1 FROM hon.membership_payment_schedules s WHERE s.membership_id=membership.id)
    OR NOT EXISTS(SELECT 1 FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id
      AND x.organization_id=org AND x.school_id=school AND x.membership_id=membership.id AND x.actor_principal_id=actor
      AND x.idempotency_key=key AND x.request_fingerprint=fp AND x.receipt=result_receipt)
    OR NOT EXISTS(SELECT 1 FROM hon.idempotency_records x WHERE x.organization_id=org AND x.school_id=school AND x.principal_id=actor
      AND x.idempotency_key=key::text AND x.request_fingerprint=fp AND x.status='COMPLETED' AND x.response_status=200 AND x.response_body=result_receipt)
    OR (SELECT count(*) FROM hon.audit_events x WHERE x.organization_id=org AND x.school_id=school AND x.entity_id=membership.id
      AND x.actor_principal_id=actor AND x.source='HUMAN_UI' AND x.action_code='billing.membership.create' AND x.next_state=result_receipt
      AND x.request_id=request AND x.correlation_id=correlation AND x.action_request_id IS NULL AND x.result='SUCCEEDED')<>1
    OR (SELECT count(*) FROM hon.outbox_events x WHERE x.organization_id=org AND x.school_id=school AND x.aggregate_id=membership.id
      AND x.event_type='billing.membership.drafted' AND x.aggregate_version=membership.version AND x.causation_id=request AND x.correlation_id=correlation
      AND x.payload=result_receipt || jsonb_build_object('executionAllowed',false,'humanOnly',true))<>1
    OR (SELECT count(*) FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=relation.person_id)<>1 THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.require_crm_adult_membership_actor(subject);
  RETURN jsonb_build_object('receipt',result_receipt,'replayed',false);
END $$;

COMMENT ON FUNCTION hon.draft_crm_adult_membership(text,jsonb,uuid,uuid,uuid) IS
'Only direct HUMAN_UI adult CRM REGISTERED conversion to one historical DRAFT creation receipt. No account creation, family inference, schedule, amount, auto-renew, invoice, payment, agreement, provider, communication, activation, automation, Action Engine, AI or owner-launch invocation.';

ALTER TABLE hon.people FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.student_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.billing_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.memberships FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.crm_adult_membership_draft_sources FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_crm_adult_membership_draft_source(),hon.require_crm_adult_membership_actor(text),hon.crm_adult_membership_relation(uuid),hon.read_crm_adult_membership_preparation(text,uuid),hon.draft_crm_adult_membership(text,jsonb,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.crm_adult_membership_draft_sources FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_crm_adult_membership_draft_source(),hon.require_crm_adult_membership_actor(text),hon.crm_adult_membership_relation(uuid),hon.read_crm_adult_membership_preparation(text,uuid),hon.draft_crm_adult_membership(text,jsonb,uuid,uuid,uuid) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_crm_adult_membership_preparation(text,uuid),hon.draft_crm_adult_membership(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
