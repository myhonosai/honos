BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'CRM lead registration requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'CRM lead registration requires a restricted runtime';
  END IF;
END $$;

-- This permission authorizes only an explicit direct-human registration review.
-- It is deliberately distinct from closing a lead, scheduling a trial, family
-- management, or any membership/billing action.
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
VALUES ('crm.lead.register','Direct human registration from one known CRM lead after bounded review; not enrollment, membership, billing, payment, consent, booking, attendance, or conversion automation',true,true)
ON CONFLICT(code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT id,organization_id,'crm.lead.register' FROM hon.roles WHERE is_system_role AND code='OWNER'
ON CONFLICT DO NOTHING;

-- Immutable source-preserving evidence only. The lead and appointment records
-- are referenced, never mutated. One lead cannot be silently registered twice.
CREATE TABLE hon.crm_lead_registration_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  source_lead_id uuid NOT NULL,
  original_contact_person_id uuid NOT NULL,
  registration_path text NOT NULL CHECK (registration_path IN ('ADULT','GUARDIAN_CHILD')),
  resulting_student_profile_id uuid NOT NULL,
  family_id uuid,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response)='object'),
  version integer NOT NULL DEFAULT 1 CHECK(version=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,school_id,actor_principal_id,idempotency_key),
  UNIQUE(source_lead_id),
  UNIQUE(id,organization_id,school_id),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(source_lead_id,organization_id,school_id) REFERENCES hon.crm_leads(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(original_contact_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(resulting_student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id) ON DELETE RESTRICT,
  CHECK ((registration_path='ADULT' AND family_id IS NULL) OR (registration_path='GUARDIAN_CHILD' AND family_id IS NOT NULL))
);
ALTER TABLE hon.crm_lead_registration_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_lead_registration_conversions FORCE ROW LEVEL SECURITY;
CREATE FUNCTION hon.guard_crm_lead_registration_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_CRM_LEAD_REGISTRATION' USING ERRCODE='42501'; END $$;
CREATE TRIGGER crm_lead_registration_immutable BEFORE UPDATE OR DELETE ON hon.crm_lead_registration_conversions
FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_lead_registration_history();
CREATE TRIGGER crm_lead_registration_no_truncate BEFORE TRUNCATE ON hon.crm_lead_registration_conversions
FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_crm_lead_registration_history();

CREATE FUNCTION hon.crm_lead_registration_has_permission(actor uuid,org uuid,school uuid,permission text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT permission IN ('crm.lead.read','crm.lead.register','student.profile.manage','people.create','family.create','family.member.manage')
    AND hon.staff_member_eligible(actor,org,school) AND EXISTS (
      SELECT 1 FROM hon.principal_role_grants g
      JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
      JOIN hon.permissions p ON p.code=rp.permission_code
      WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school
        AND p.code=permission AND p.is_staff_assignable
        AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
    )
$$;

-- A selected school remains an untrusted selector. This resolver verifies one
-- live human/principal/school tuple; the fixed command independently rechecks.
CREATE FUNCTION hon.resolve_crm_lead_registration_scope(subject text,selected_school uuid)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT DISTINCT p.id,s.organization_id,s.id
  FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  JOIN hon.schools s ON s.id=selected_school
  WHERE u.external_subject=subject AND length(subject) BETWEEN 1 AND 200 AND btrim(subject)=subject
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND hon.crm_lead_registration_has_permission(p.id,s.organization_id,s.id,'crm.lead.read')
    AND hon.crm_lead_registration_has_permission(p.id,s.organization_id,s.id,'crm.lead.register')
    AND hon.crm_lead_registration_has_permission(p.id,s.organization_id,s.id,'student.profile.manage')
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id AND h.effective_from<=clock_timestamp() AND (h.effective_until IS NULL OR h.effective_until>clock_timestamp()))
    AND NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND EXISTS (SELECT 1 FROM hon.organizations o WHERE o.id=s.organization_id AND o.status='ACTIVE')
    AND s.status='ACTIVE'
    AND EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=s.organization_id AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
$$;

CREATE FUNCTION hon.require_crm_lead_registration_actor(subject text,path text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
BEGIN
  IF path NOT IN ('ADULT','GUARDIAN_CHILD')
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM hon.resolve_crm_lead_registration_scope(subject,hon.current_school_id()) s
      WHERE s.principal_id=actor AND s.organization_id=hon.current_organization_id()) THEN
    RAISE EXCEPTION 'CRM_LEAD_REGISTRATION_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF path='GUARDIAN_CHILD' AND (
      NOT hon.crm_lead_registration_has_permission(actor,hon.current_organization_id(),hon.current_school_id(),'people.create')
      OR NOT hon.crm_lead_registration_has_permission(actor,hon.current_organization_id(),hon.current_school_id(),'family.create')
      OR NOT hon.crm_lead_registration_has_permission(actor,hon.current_organization_id(),hon.current_school_id(),'family.member.manage')) THEN
    RAISE EXCEPTION 'CRM_LEAD_REGISTRATION_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.register_crm_lead_person(subject text,selected_lead uuid,p jsonb,key uuid,request uuid,correlation uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
  lead hon.crm_leads%ROWTYPE; prior hon.crm_lead_registration_conversions%ROWTYPE;
  path text; birth date; child_birth date; child uuid; student uuid; family uuid; instant timestamptz;
  guardian_member uuid; child_member uuid; result jsonb; fp text; normalized_given text; normalized_family text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected_lead IS NULL OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['registrationPath','confirmation']
    OR jsonb_typeof(p->'registrationPath') IS DISTINCT FROM 'string' OR p->>'registrationPath' NOT IN ('ADULT','GUARDIAN_CHILD')
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('registrationPath','birthDate','childGivenName','childFamilyName','childBirthDate','confirmation')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  path:=p->>'registrationPath';
  IF path='ADULT' AND (NOT p ? 'birthDate' OR jsonb_typeof(p->'birthDate') IS DISTINCT FROM 'string' OR p->>'birthDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR p ? 'childGivenName' OR p ? 'childFamilyName' OR p ? 'childBirthDate') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF path='GUARDIAN_CHILD' AND (p ? 'birthDate' OR NOT p ?& ARRAY['childGivenName','childFamilyName','childBirthDate']
      OR jsonb_typeof(p->'childGivenName') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'childFamilyName') IS DISTINCT FROM 'string'
      OR length(p->>'childGivenName') NOT BETWEEN 1 AND 100 OR length(p->>'childFamilyName') NOT BETWEEN 1 AND 100
      OR btrim(p->>'childGivenName')<>p->>'childGivenName' OR btrim(p->>'childFamilyName')<>p->>'childFamilyName'
      OR p->>'childGivenName' ~ '[[:cntrl:]<>]' OR p->>'childFamilyName' ~ '[[:cntrl:]<>]'
      OR regexp_replace(p->>'childGivenName','[^[:alnum:]]','','g')='' OR regexp_replace(p->>'childFamilyName','[^[:alnum:]]','','g')=''
      OR jsonb_typeof(p->'childBirthDate') IS DISTINCT FROM 'string' OR p->>'childBirthDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  IF path='ADULT' THEN birth:=(p->>'birthDate')::date; IF NOT isfinite(birth) OR birth<date '1900-01-01' OR birth>(clock_timestamp() AT TIME ZONE 'UTC')::date THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF; END IF;
  IF path='GUARDIAN_CHILD' THEN child_birth:=(p->>'childBirthDate')::date; IF NOT isfinite(child_birth) OR child_birth<date '1900-01-01' OR child_birth>(clock_timestamp() AT TIME ZONE 'UTC')::date THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF; END IF;
  actor:=hon.require_crm_lead_registration_actor(subject,path);
  -- Serialize authorization, lead, family/person ambiguity, and source-use checks.
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements,hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions IN SHARE ROW EXCLUSIVE MODE;
  actor:=hon.require_crm_lead_registration_actor(subject,path);
  SELECT * INTO lead FROM hon.crm_leads WHERE id=selected_lead AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_LEAD_REGISTRATION_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','crm.lead.register','leadId',selected_lead,'input',p)::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.crm_lead_registration_conversions WHERE organization_id=org AND school_id=school AND actor_principal_id=actor AND idempotency_key=key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    PERFORM hon.require_crm_lead_registration_actor(subject,path);
    RETURN jsonb_build_object('result',prior.response,'replayed',true);
  END IF;
  -- A terminal WON or completed TRIAL unlocks a human review only; it proves no identity, consent, eligibility, membership, or payment fact.
  IF lead.status<>'WON' AND NOT EXISTS (SELECT 1 FROM hon.crm_appointments a WHERE a.organization_id=org AND a.school_id=school AND a.crm_lead_id=lead.id AND a.appointment_type='TRIAL' AND a.status='COMPLETED') THEN
    RAISE EXCEPTION 'CRM_LEAD_REGISTRATION_UNAVAILABLE' USING ERRCODE='P0002';
  END IF;
  -- A conversion, student profile, or any current family relation is a bounded non-writing staff-review outcome.
  IF EXISTS(SELECT 1 FROM hon.crm_lead_registration_conversions c WHERE c.source_lead_id=lead.id)
    OR EXISTS(SELECT 1 FROM hon.student_profiles s WHERE s.organization_id=org AND s.school_id=school AND s.person_id=lead.primary_person_id)
    OR EXISTS(SELECT 1 FROM hon.family_members m WHERE m.organization_id=org AND m.school_id=school AND m.person_id=lead.primary_person_id) THEN
    RETURN jsonb_build_object('result',jsonb_build_object('outcome','NEEDS_STAFF_REVIEW'),'replayed',false);
  END IF;
  IF path='GUARDIAN_CHILD' THEN
    normalized_given:=lower(regexp_replace(p->>'childGivenName','[^[:alnum:]]','','g'));
    normalized_family:=lower(regexp_replace(p->>'childFamilyName','[^[:alnum:]]','','g'));
    IF EXISTS(SELECT 1 FROM hon.people x LEFT JOIN hon.student_profiles s ON s.person_id=x.id AND s.organization_id=x.organization_id AND s.school_id=x.school_id
      WHERE x.organization_id=org AND x.school_id=school AND (
        (lower(regexp_replace(x.given_name,'[^[:alnum:]]','','g'))=normalized_given AND lower(regexp_replace(x.family_name,'[^[:alnum:]]','','g'))=normalized_family)
        OR (s.birth_date=child_birth AND lower(regexp_replace(x.family_name,'[^[:alnum:]]','','g'))=normalized_family))) THEN
      RETURN jsonb_build_object('result',jsonb_build_object('outcome','NEEDS_STAFF_REVIEW'),'replayed',false);
    END IF;
  END IF;
  IF path='ADULT' THEN
    INSERT INTO hon.student_profiles(organization_id,school_id,person_id,birth_date) VALUES(org,school,lead.primary_person_id,birth) RETURNING id INTO student;
    family:=NULL;
  ELSE
    INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES(org,school,p->>'childGivenName',p->>'childFamilyName') RETURNING id INTO child;
    INSERT INTO hon.families(organization_id,school_id,display_name) VALUES(org,school,'CRM registration family') RETURNING id INTO family;
    INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES(org,school,family,lead.primary_person_id,'GUARDIAN',false) RETURNING id INTO guardian_member;
    INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES(org,school,family,child,'STUDENT',false) RETURNING id INTO child_member;
    INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES(org,school,child,family,child_birth) RETURNING id INTO student;
  END IF;
  instant:=clock_timestamp();
  result:=jsonb_build_object('outcome','REGISTERED','leadId',lead.id,'sourceContactPersonId',lead.primary_person_id,'registrationPath',path,'studentProfileId',student,'familyId',family,'recordedAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO hon.crm_lead_registration_conversions(organization_id,school_id,source_lead_id,original_contact_person_id,registration_path,resulting_student_profile_id,family_id,actor_principal_id,idempotency_key,fingerprint,response,created_at)
  VALUES(org,school,lead.id,lead.primary_person_id,path,student,family,actor,key,fp,result,instant);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
  VALUES(org,school,actor,'HUMAN_UI','crm.lead.register','CRM_LEAD_REGISTRATION',lead.id,NULL,result,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
  VALUES(org,school,'crm.lead.registration_recorded',1,'CRM_LEAD',lead.id,lead.version,correlation,request,result || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  PERFORM hon.require_crm_lead_registration_actor(subject,path);
  RETURN jsonb_build_object('result',result,'replayed',false);
END $$;

COMMENT ON FUNCTION hon.register_crm_lead_person(text,uuid,jsonb,uuid,uuid,uuid) IS
'Direct HUMAN_UI only. Creates only a bounded student profile or distinct guardian-child family relation; preserves CRM lead/trial attribution and creates no enrollment, membership, billing, payment, consent, booking, attendance, notification, provider, AI, action-engine, or automation work.';

REVOKE ALL ON TABLE hon.crm_lead_registration_conversions FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_crm_lead_registration_history(),hon.crm_lead_registration_has_permission(uuid,uuid,uuid,text),hon.require_crm_lead_registration_actor(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.resolve_crm_lead_registration_scope(text,uuid),hon.register_crm_lead_person(text,uuid,jsonb,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','hon_runtime') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.crm_lead_registration_conversions FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_crm_lead_registration_history(),hon.crm_lead_registration_has_permission(uuid,uuid,uuid,text),hon.require_crm_lead_registration_actor(text,text),hon.resolve_crm_lead_registration_scope(text,uuid),hon.register_crm_lead_person(text,uuid,jsonb,uuid,uuid,uuid) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.resolve_crm_lead_registration_scope(text,uuid),hon.register_crm_lead_person(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
