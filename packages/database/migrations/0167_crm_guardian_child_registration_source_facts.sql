BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Guardian-child CRM registration source facts require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Guardian-child CRM registration source facts require a restricted runtime';
  END IF;
END $$;

-- No backfill: only new conversions can acquire original facts. Current mutable
-- people/profile data can never establish provenance for a historical conversion.
CREATE TABLE hon.crm_guardian_child_registration_source_facts (
  conversion_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  student_profile_id uuid NOT NULL,
  child_person_id uuid NOT NULL,
  family_id uuid NOT NULL,
  given_name text NOT NULL CHECK (length(given_name) BETWEEN 1 AND 100 AND btrim(given_name)=given_name
    AND given_name !~ '[[:cntrl:]<>]' AND regexp_replace(given_name,'[^[:alnum:]]','','g')<>''),
  family_name text NOT NULL CHECK (length(family_name) BETWEEN 1 AND 100 AND btrim(family_name)=family_name
    AND family_name !~ '[[:cntrl:]<>]' AND regexp_replace(family_name,'[^[:alnum:]]','','g')<>''),
  birth_date date NOT NULL CHECK (isfinite(birth_date) AND birth_date>=date '1900-01-01'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(conversion_id,organization_id,school_id) REFERENCES hon.crm_lead_registration_conversions(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(child_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.crm_guardian_child_registration_source_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_guardian_child_registration_source_facts FORCE ROW LEVEL SECURITY;
CREATE FUNCTION hon.guard_crm_guardian_child_registration_source_facts() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_CRM_GUARDIAN_CHILD_REGISTRATION_SOURCE_FACTS' USING ERRCODE='42501'; END $$;
CREATE TRIGGER crm_guardian_child_registration_facts_immutable BEFORE UPDATE OR DELETE ON hon.crm_guardian_child_registration_source_facts FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_guardian_child_registration_source_facts();
CREATE TRIGGER crm_guardian_child_registration_facts_no_truncate BEFORE TRUNCATE ON hon.crm_guardian_child_registration_source_facts FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_crm_guardian_child_registration_source_facts();

-- Runs inside 0160's registration transaction, after the exact fresh child graph
-- and conversion exist but before commit/audit/outbox. The canonical graph uses
-- transaction-time created_at defaults (also valid inside savepoints). No client-supplied facts,
-- account lookup, payer designation or adult-path behavior is introduced.
CREATE FUNCTION hon.capture_crm_guardian_child_registration_source_facts() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s hon.student_profiles%ROWTYPE; child hon.people%ROWTYPE; f hon.families%ROWTYPE;
BEGIN
  IF NEW.registration_path IS DISTINCT FROM 'GUARDIAN_CHILD' THEN RETURN NEW; END IF;
  IF NEW.family_id IS NULL OR NEW.version<>1 OR jsonb_typeof(NEW.response) IS DISTINCT FROM 'object'
    OR NEW.response->>'outcome' IS DISTINCT FROM 'REGISTERED' OR NEW.response->>'registrationPath' IS DISTINCT FROM 'GUARDIAN_CHILD'
    OR NEW.response->>'studentProfileId' IS DISTINCT FROM NEW.resulting_student_profile_id::text
    OR NEW.response->>'sourceContactPersonId' IS DISTINCT FROM NEW.original_contact_person_id::text
    OR NEW.response->>'leadId' IS DISTINCT FROM NEW.source_lead_id::text OR NEW.response->>'familyId' IS DISTINCT FROM NEW.family_id::text
    OR NEW.response->>'recordedAt' IS DISTINCT FROM to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR NOT NEW.response ?& ARRAY['outcome','registrationPath','studentProfileId','sourceContactPersonId','leadId','familyId','recordedAt']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.response) k WHERE k NOT IN ('outcome','registrationPath','studentProfileId','sourceContactPersonId','leadId','familyId','recordedAt'))
    OR NOT EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.id=NEW.source_lead_id AND l.organization_id=NEW.organization_id
      AND l.school_id=NEW.school_id AND l.primary_person_id=NEW.original_contact_person_id) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO s FROM hon.student_profiles x WHERE x.id=NEW.resulting_student_profile_id AND x.organization_id=NEW.organization_id
    AND x.school_id=NEW.school_id AND x.created_at=transaction_timestamp();
  IF NOT FOUND OR s.status<>'ACTIVE' OR s.version<>1 OR s.person_id=NEW.original_contact_person_id
    OR s.primary_family_id IS DISTINCT FROM NEW.family_id OR s.birth_date IS NULL OR NOT isfinite(s.birth_date)
    OR s.birth_date<date '1900-01-01' OR s.birth_date>(clock_timestamp() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO child FROM hon.people x WHERE x.id=s.person_id AND x.organization_id=NEW.organization_id
    AND x.school_id=NEW.school_id AND x.created_at=transaction_timestamp();
  IF NOT FOUND OR child.version<>1 OR length(child.given_name) NOT BETWEEN 1 AND 100 OR length(child.family_name) NOT BETWEEN 1 AND 100
    OR btrim(child.given_name)<>child.given_name OR btrim(child.family_name)<>child.family_name
    OR child.given_name ~ '[[:cntrl:]<>]' OR child.family_name ~ '[[:cntrl:]<>]'
    OR regexp_replace(child.given_name,'[^[:alnum:]]','','g')='' OR regexp_replace(child.family_name,'[^[:alnum:]]','','g')='' THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO f FROM hon.families x WHERE x.id=NEW.family_id AND x.organization_id=NEW.organization_id
    AND x.school_id=NEW.school_id AND x.created_at=transaction_timestamp();
  IF NOT FOUND OR f.status<>'ACTIVE' OR f.version<>1
    OR (SELECT count(*) FROM hon.family_members x WHERE x.family_id=f.id AND x.organization_id=NEW.organization_id AND x.school_id=NEW.school_id)<>2
    OR NOT EXISTS(SELECT 1 FROM hon.family_members x WHERE x.family_id=f.id AND x.organization_id=NEW.organization_id AND x.school_id=NEW.school_id
      AND x.person_id=NEW.original_contact_person_id AND x.member_role='GUARDIAN' AND NOT x.is_billing_contact AND x.created_at=transaction_timestamp())
    OR NOT EXISTS(SELECT 1 FROM hon.family_members x WHERE x.family_id=f.id AND x.organization_id=NEW.organization_id AND x.school_id=NEW.school_id
      AND x.person_id=child.id AND x.member_role='STUDENT' AND NOT x.is_billing_contact AND x.created_at=transaction_timestamp()) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  INSERT INTO hon.crm_guardian_child_registration_source_facts(conversion_id,organization_id,school_id,student_profile_id,child_person_id,family_id,given_name,family_name,birth_date,created_at)
    VALUES(NEW.id,NEW.organization_id,NEW.school_id,s.id,child.id,f.id,child.given_name,child.family_name,s.birth_date,NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER crm_guardian_child_registration_facts_capture AFTER INSERT ON hon.crm_lead_registration_conversions FOR EACH ROW EXECUTE FUNCTION hon.capture_crm_guardian_child_registration_source_facts();

-- Same signature and existing policies; additionally require original immutable
-- registration facts at every preparation/designation/DRAFT/current confirmation.
CREATE OR REPLACE FUNCTION hon.crm_guardian_child_membership_relation(selected_student uuid)
RETURNS TABLE(conversion_id uuid,student_profile_id uuid,guardian_person_id uuid,child_person_id uuid,family_id uuid,
  guardian_member_id uuid,child_member_id uuid,account_id uuid,student_display_name text,guardian_display_name text,currency text,
  conversion_version integer,student_version integer,child_version integer,guardian_version integer,family_version integer,account_version integer,
  birth_date date,source_lead_id uuid,source_response jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); c hon.crm_lead_registration_conversions%ROWTYPE;
  s hon.student_profiles%ROWTYPE; account hon.billing_accounts%ROWTYPE; f hon.families%ROWTYPE;
  guardian hon.people%ROWTYPE; child hon.people%ROWTYPE; gm hon.family_members%ROWTYPE; cm hon.family_members%ROWTYPE;
  child_label text; guardian_label text; original hon.crm_guardian_child_registration_source_facts%ROWTYPE;
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
  SELECT * INTO original FROM hon.crm_guardian_child_registration_source_facts x WHERE x.conversion_id=c.id
    AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND OR original.student_profile_id IS DISTINCT FROM selected_student OR original.family_id IS DISTINCT FROM c.family_id
    OR original.created_at IS DISTINCT FROM c.created_at THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO s FROM hon.student_profiles x WHERE x.id=selected_student AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND OR s.person_id IS DISTINCT FROM original.child_person_id OR s.birth_date IS DISTINCT FROM original.birth_date
    OR s.status<>'ACTIVE' OR s.person_id=c.original_contact_person_id OR s.primary_family_id IS DISTINCT FROM c.family_id
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
  IF child.given_name IS DISTINCT FROM original.given_name OR child.family_name IS DISTINCT FROM original.family_name THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  child_label:=btrim(concat_ws(' ',child.given_name,child.family_name)); guardian_label:=btrim(concat_ws(' ',guardian.given_name,guardian.family_name));
  IF account.currency::text !~ '^[A-Z]{3}$' OR length(child_label) NOT BETWEEN 1 AND 201 OR child_label ~ '[[:cntrl:]<>]'
    OR length(guardian_label) NOT BETWEEN 1 AND 201 OR guardian_label ~ '[[:cntrl:]<>]' THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN QUERY SELECT c.id,s.id,guardian.id,child.id,f.id,gm.id,cm.id,account.id,child_label,guardian_label,account.currency::text,
    c.version,s.version,child.version,guardian.version,f.version,account.version,s.birth_date,c.source_lead_id,c.response;
END $$;

REVOKE ALL ON TABLE hon.crm_guardian_child_registration_source_facts FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_crm_guardian_child_registration_source_facts(),hon.capture_crm_guardian_child_registration_source_facts(),hon.crm_guardian_child_membership_relation(uuid) FROM PUBLIC;
DO $$ DECLARE r text; col text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.crm_guardian_child_registration_source_facts FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_crm_guardian_child_registration_source_facts(),hon.capture_crm_guardian_child_registration_source_facts(),hon.crm_guardian_child_membership_relation(uuid) FROM %I',r);
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='hon.crm_guardian_child_registration_source_facts'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.crm_guardian_child_registration_source_facts FROM PUBLIC',col);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.crm_guardian_child_registration_source_facts FROM %I',col,r);
    END LOOP;
  END LOOP;
END $$;
COMMIT;
