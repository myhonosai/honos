BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Guardian-child CRM payer designation requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Guardian-child CRM payer designation requires a restricted runtime';
  END IF;
END $$;

-- Private immutable operational provenance; the family-member Boolean alone is
-- never authority. No legal consent, payment authorization or execution capability.
CREATE TABLE hon.crm_guardian_child_payer_designations (
  conversion_id uuid PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  student_profile_id uuid NOT NULL,
  guardian_person_id uuid NOT NULL,
  child_person_id uuid NOT NULL,
  family_id uuid NOT NULL,
  guardian_member_id uuid NOT NULL,
  child_member_id uuid NOT NULL,
  billing_account_id uuid NOT NULL,
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (guardian_person_id<>child_person_id AND guardian_member_id<>child_member_id),
  UNIQUE(id,organization_id,school_id),
  UNIQUE(organization_id,school_id,actor_principal_id,idempotency_key),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(conversion_id,organization_id,school_id) REFERENCES hon.crm_lead_registration_conversions(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(guardian_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(child_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(guardian_member_id,organization_id,school_id) REFERENCES hon.family_members(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(child_member_id,organization_id,school_id) REFERENCES hon.family_members(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(billing_account_id,organization_id,school_id) REFERENCES hon.billing_accounts(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.crm_guardian_child_payer_designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_guardian_child_payer_designations FORCE ROW LEVEL SECURITY;
CREATE FUNCTION hon.guard_crm_guardian_child_payer_designation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_CRM_GUARDIAN_CHILD_PAYER_DESIGNATION' USING ERRCODE='42501'; END $$;
CREATE TRIGGER crm_guardian_child_payer_immutable BEFORE UPDATE OR DELETE ON hon.crm_guardian_child_payer_designations FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_guardian_child_payer_designation();
CREATE TRIGGER crm_guardian_child_payer_no_truncate BEFORE TRUNCATE ON hon.crm_guardian_child_payer_designations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_crm_guardian_child_payer_designation();

CREATE FUNCTION hon.require_crm_guardian_child_membership_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid; requested_actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  BEGIN
    org:=hon.current_organization_id(); school:=hon.current_school_id();
    requested_actor:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501';
  END;
  IF org IS NULL OR school IS NULL OR requested_actor IS NULL
    OR org::text IS DISTINCT FROM current_setting('app.hon_organization_id',true)
    OR school::text IS DISTINCT FROM current_setting('app.hon_school_id',true) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=requested_actor AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['billing.membership.create','family.member.manage']) needed(code)
      WHERE NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
        JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions permission ON permission.code=rp.permission_code
        WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
          AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
          AND (r.management_school_id IS NULL OR r.management_school_id=school)
          AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
          AND permission.code=needed.code AND permission.is_staff_assignable))
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- One exact current graph. Extra ADDITIONAL accounts are irrelevant and never
-- selected. Snapshot versions make later graph/account drift fail closed.
CREATE FUNCTION hon.crm_guardian_child_membership_relation(selected_student uuid)
RETURNS TABLE(conversion_id uuid,student_profile_id uuid,guardian_person_id uuid,child_person_id uuid,family_id uuid,
  guardian_member_id uuid,child_member_id uuid,account_id uuid,student_display_name text,guardian_display_name text,currency text,
  conversion_version integer,student_version integer,child_version integer,guardian_version integer,family_version integer,account_version integer,
  birth_date date,source_lead_id uuid,source_response jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); c hon.crm_lead_registration_conversions%ROWTYPE;
  s hon.student_profiles%ROWTYPE; account hon.billing_accounts%ROWTYPE; f hon.families%ROWTYPE;
  guardian hon.people%ROWTYPE; child hon.people%ROWTYPE; gm hon.family_members%ROWTYPE; cm hon.family_members%ROWTYPE;
  child_label text; guardian_label text;
BEGIN
  IF selected_student IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM hon.crm_lead_registration_conversions x WHERE x.organization_id=org AND x.school_id=school AND x.resulting_student_profile_id=selected_student)<>1 THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO c FROM hon.crm_lead_registration_conversions x WHERE x.organization_id=org AND x.school_id=school AND x.resulting_student_profile_id=selected_student;
  IF c.registration_path IS DISTINCT FROM 'GUARDIAN_CHILD' OR c.family_id IS NULL OR c.version<>1
    OR c.response->>'outcome' IS DISTINCT FROM 'REGISTERED' OR c.response->>'registrationPath' IS DISTINCT FROM 'GUARDIAN_CHILD'
    OR c.response->>'studentProfileId' IS DISTINCT FROM selected_student::text
    OR c.response->>'sourceContactPersonId' IS DISTINCT FROM c.original_contact_person_id::text
    OR c.response->>'leadId' IS DISTINCT FROM c.source_lead_id::text OR c.response->>'familyId' IS DISTINCT FROM c.family_id::text
    OR c.response->>'recordedAt' IS DISTINCT FROM to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR NOT c.response ?& ARRAY['outcome','registrationPath','studentProfileId','sourceContactPersonId','leadId','familyId','recordedAt']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(c.response) k WHERE k NOT IN ('outcome','registrationPath','studentProfileId','sourceContactPersonId','leadId','familyId','recordedAt')) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO s FROM hon.student_profiles x WHERE x.id=selected_student AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND OR s.status<>'ACTIVE' OR s.person_id=c.original_contact_person_id OR s.primary_family_id IS DISTINCT FROM c.family_id
    OR NOT EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.id=c.source_lead_id AND l.organization_id=org AND l.school_id=school AND l.primary_person_id=c.original_contact_person_id) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO f FROM hon.families x WHERE x.id=c.family_id AND x.organization_id=org AND x.school_id=school AND x.status='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO gm FROM hon.family_members x WHERE x.family_id=f.id AND x.person_id=c.original_contact_person_id AND x.organization_id=org AND x.school_id=school AND x.member_role='GUARDIAN';
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO cm FROM hon.family_members x WHERE x.family_id=f.id AND x.person_id=s.person_id AND x.organization_id=org AND x.school_id=school AND x.member_role='STUDENT' AND NOT x.is_billing_contact;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM hon.family_members x WHERE x.family_id=f.id AND x.organization_id=org AND x.school_id=school AND x.member_role='GUARDIAN' AND x.is_billing_contact AND x.id<>gm.id) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF (SELECT count(*) FROM hon.billing_accounts a WHERE a.organization_id=org AND a.school_id=school AND a.responsible_person_id=c.original_contact_person_id AND a.account_classification='CANONICAL')<>1 THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO account FROM hon.billing_accounts a WHERE a.organization_id=org AND a.school_id=school AND a.responsible_person_id=c.original_contact_person_id AND a.account_classification='CANONICAL';
  SELECT * INTO guardian FROM hon.people x WHERE x.id=c.original_contact_person_id AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO child FROM hon.people x WHERE x.id=s.person_id AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  child_label:=btrim(concat_ws(' ',child.given_name,child.family_name)); guardian_label:=btrim(concat_ws(' ',guardian.given_name,guardian.family_name));
  IF account.currency::text !~ '^[A-Z]{3}$' OR length(child_label) NOT BETWEEN 1 AND 201 OR child_label ~ '[[:cntrl:]<>]'
    OR length(guardian_label) NOT BETWEEN 1 AND 201 OR guardian_label ~ '[[:cntrl:]<>]' THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN QUERY SELECT c.id,s.id,guardian.id,child.id,f.id,gm.id,cm.id,account.id,child_label,guardian_label,account.currency::text,
    c.version,s.version,child.version,guardian.version,f.version,account.version,s.birth_date,c.source_lead_id,c.response;
END $$;

CREATE FUNCTION hon.crm_guardian_child_designated_relation(selected_student uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE relation record; designation hon.crm_guardian_child_payer_designations%ROWTYPE;
BEGIN
  SELECT * INTO relation FROM hon.crm_guardian_child_membership_relation(selected_student);
  SELECT * INTO designation FROM hon.crm_guardian_child_payer_designations x WHERE x.conversion_id=relation.conversion_id
    AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND OR designation.facts IS DISTINCT FROM to_jsonb(relation)
    OR designation.student_profile_id<>relation.student_profile_id OR designation.guardian_person_id<>relation.guardian_person_id
    OR designation.child_person_id<>relation.child_person_id OR designation.family_id<>relation.family_id
    OR designation.guardian_member_id<>relation.guardian_member_id OR designation.child_member_id<>relation.child_member_id
    OR designation.billing_account_id<>relation.account_id
    OR designation.receipt IS DISTINCT FROM jsonb_build_object('studentDisplayName',relation.student_display_name,'guardianDisplayName',relation.guardian_display_name,
      'currency',relation.currency,'state','PAYER_DESIGNATED','recordedAt',to_char(designation.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    OR NOT EXISTS(SELECT 1 FROM hon.family_members x WHERE x.id=relation.guardian_member_id AND x.organization_id=hon.current_organization_id()
      AND x.school_id=hon.current_school_id() AND x.is_billing_contact) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN to_jsonb(relation) || jsonb_build_object('designation_id',designation.id);
END $$;

CREATE FUNCTION hon.read_crm_guardian_child_payer_designation_preparation(subject text,selected_student uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE relation record;
BEGIN
  PERFORM hon.require_crm_guardian_child_membership_actor(subject);
  PERFORM hon.require_crm_guardian_child_membership_actor(subject);
  SELECT * INTO relation FROM hon.crm_guardian_child_membership_relation(selected_student);
  IF EXISTS(SELECT 1 FROM hon.crm_guardian_child_payer_designations x WHERE x.conversion_id=relation.conversion_id)
    OR EXISTS(SELECT 1 FROM hon.memberships x WHERE x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id() AND x.participant_person_id=relation.child_person_id) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  PERFORM hon.require_crm_guardian_child_membership_actor(subject);
  RETURN jsonb_build_object('studentDisplayName',relation.student_display_name,'guardianDisplayName',relation.guardian_display_name,'currency',relation.currency,'readiness','READY_FOR_PAYER_DESIGNATION');
END $$;

CREATE FUNCTION hon.designate_crm_guardian_child_payer(subject text,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid; school uuid; selected uuid; relation record; final_relation record; fp text; instant timestamptz;
  designation hon.crm_guardian_child_payer_designations%ROWTYPE; prior hon.idempotency_records%ROWTYPE; result_receipt jsonb;
BEGIN
  actor:=hon.require_crm_guardian_child_membership_actor(subject); org:=hon.current_organization_id(); school:=hon.current_school_id();
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['studentProfileId','confirmation']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('studentProfileId','confirmation'))
    OR jsonb_typeof(p->'studentProfileId') IS DISTINCT FROM 'string' OR p->>'studentProfileId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_PAYER_DESIGNATION' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  selected:=(p->>'studentProfileId')::uuid;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements,hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts,hon.memberships,hon.crm_guardian_child_payer_designations,hon.idempotency_records IN SHARE ROW EXCLUSIVE MODE;
  actor:=hon.require_crm_guardian_child_membership_actor(subject);
  fp:=encode(sha256(convert_to(jsonb_build_object('command','crm.guardian_child.payer.designate','input',p || jsonb_build_object('studentProfileId',selected))::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
  IF FOUND THEN
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    SELECT * INTO designation FROM hon.crm_guardian_child_payer_designations x WHERE x.organization_id=org AND x.school_id=school
      AND x.student_profile_id=selected AND x.actor_principal_id=actor AND x.idempotency_key=key AND x.request_fingerprint=fp;
    IF NOT FOUND OR prior.status<>'COMPLETED' OR prior.response_status<>200 OR prior.response_body IS DISTINCT FROM designation.receipt THEN
      RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
    IF hon.crm_guardian_child_designated_relation(selected)->>'designation_id' IS DISTINCT FROM designation.id::text THEN
      RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    PERFORM hon.require_crm_guardian_child_membership_actor(subject);
    RETURN jsonb_build_object('receipt',designation.receipt,'replayed',true);
  END IF;
  SELECT * INTO relation FROM hon.crm_guardian_child_membership_relation(selected);
  IF EXISTS(SELECT 1 FROM hon.crm_guardian_child_payer_designations x WHERE x.conversion_id=relation.conversion_id)
    OR EXISTS(SELECT 1 FROM hon.memberships x WHERE x.organization_id=org AND x.school_id=school AND x.participant_person_id=relation.child_person_id) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  instant:=clock_timestamp();
  result_receipt:=jsonb_build_object('studentDisplayName',relation.student_display_name,'guardianDisplayName',relation.guardian_display_name,'currency',relation.currency,
    'state','PAYER_DESIGNATED','recordedAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key::text,fp,'IN_PROGRESS',instant+interval '24 hours');
  INSERT INTO hon.crm_guardian_child_payer_designations(conversion_id,organization_id,school_id,student_profile_id,guardian_person_id,child_person_id,family_id,guardian_member_id,child_member_id,billing_account_id,facts,actor_principal_id,idempotency_key,request_fingerprint,receipt,created_at)
    VALUES(relation.conversion_id,org,school,selected,relation.guardian_person_id,relation.child_person_id,relation.family_id,relation.guardian_member_id,relation.child_member_id,relation.account_id,to_jsonb(relation),actor,key,fp,result_receipt,instant)
    RETURNING * INTO designation;
  UPDATE hon.family_members SET is_billing_contact=true WHERE id=relation.guardian_member_id AND organization_id=org AND school_id=school
    AND family_id=relation.family_id AND person_id=relation.guardian_person_id AND member_role='GUARDIAN';
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.guardian_payer.designate','CRM_GUARDIAN_CHILD_PAYER_DESIGNATION',designation.id,NULL,result_receipt,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.guardian_payer.designated',1,'CRM_GUARDIAN_CHILD_PAYER_DESIGNATION',designation.id,1,correlation,request,result_receipt || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result_receipt WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text;
  SELECT * INTO final_relation FROM hon.crm_guardian_child_membership_relation(selected);
  IF final_relation IS DISTINCT FROM relation OR hon.crm_guardian_child_designated_relation(selected) IS DISTINCT FROM to_jsonb(relation) || jsonb_build_object('designation_id',designation.id)
    OR NOT EXISTS(SELECT 1 FROM hon.crm_guardian_child_payer_designations x WHERE x.id=designation.id AND x.conversion_id=relation.conversion_id
      AND x.organization_id=org AND x.school_id=school AND x.actor_principal_id=actor AND x.idempotency_key=key
      AND x.request_fingerprint=fp AND x.receipt=result_receipt AND x.created_at=instant)
    OR NOT EXISTS(SELECT 1 FROM hon.idempotency_records x WHERE x.organization_id=org AND x.school_id=school AND x.principal_id=actor AND x.idempotency_key=key::text
      AND x.request_fingerprint=fp AND x.status='COMPLETED' AND x.response_status=200 AND x.response_body=result_receipt)
    OR (SELECT count(*) FROM hon.audit_events x WHERE x.organization_id=org AND x.school_id=school AND x.entity_id=designation.id AND x.actor_principal_id=actor
      AND x.source='HUMAN_UI' AND x.action_code='billing.guardian_payer.designate' AND x.next_state=result_receipt AND x.request_id=request AND x.correlation_id=correlation AND x.action_request_id IS NULL AND x.result='SUCCEEDED')<>1
    OR (SELECT count(*) FROM hon.outbox_events x WHERE x.organization_id=org AND x.school_id=school AND x.aggregate_id=designation.id AND x.event_type='billing.guardian_payer.designated'
      AND x.schema_version=1 AND x.aggregate_version=1 AND x.causation_id=request AND x.correlation_id=correlation AND x.payload=result_receipt || jsonb_build_object('executionAllowed',false,'humanOnly',true))<>1 THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.require_crm_guardian_child_membership_actor(subject);
  RETURN jsonb_build_object('receipt',result_receipt,'replayed',false);
END $$;

REVOKE ALL ON TABLE hon.crm_guardian_child_payer_designations FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_crm_guardian_child_payer_designation(),hon.require_crm_guardian_child_membership_actor(text),hon.crm_guardian_child_membership_relation(uuid),hon.crm_guardian_child_designated_relation(uuid),hon.read_crm_guardian_child_payer_designation_preparation(text,uuid),hon.designate_crm_guardian_child_payer(text,jsonb,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.crm_guardian_child_payer_designations FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_crm_guardian_child_payer_designation(),hon.require_crm_guardian_child_membership_actor(text),hon.crm_guardian_child_membership_relation(uuid),hon.crm_guardian_child_designated_relation(uuid),hon.read_crm_guardian_child_payer_designation_preparation(text,uuid),hon.designate_crm_guardian_child_payer(text,jsonb,uuid,uuid,uuid) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_crm_guardian_child_payer_designation_preparation(text,uuid),hon.designate_crm_guardian_child_payer(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
