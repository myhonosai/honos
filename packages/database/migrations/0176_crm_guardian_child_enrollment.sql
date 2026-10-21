BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Guardian/child CRM enrollment requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Guardian/child CRM enrollment requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.register_crm_lead_person(text,uuid,jsonb,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.require_crm_adult_membership_actor(text)') IS NULL
    OR to_regprocedure('hon.membership_plan_version_summary(uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'Guardian/child CRM enrollment requires 0160, 0162, 0169 and 0175';
  END IF;
END $$;

-- Guardian/child CRM enrollment from one verified GUARDIAN_CHILD registration (0160/0169) to one plan-bound
-- membership DRAFT per child. Ported from the unique behaviour of PR #27 (0164-0167) onto the 0169 canonical
-- lock order and the 0175 plan catalog, and extended to more than one child under the same verified guardian:
--   registration (unchanged) -> immutable child snapshot (captured here, no backfill)
--   -> optional additional children under the same verified family
--   -> separately created canonical billing account for the guardian (existing billing-account command)
--   -> explicit direct-human payer designation of that guardian for the family
--   -> one plan-bound DRAFT per child, bound to the exact published plan version
-- Nothing here creates a payment schedule, invoice, payment, agreement, consent, provider call, communication,
-- activation, Action Engine/AI or automation effect. Payer responsibility and family relationships are never
-- inferred from lead contact data: the guardian relation is the staff-attested GUARDIAN_CHILD registration, the
-- account is a separate staff command, and the payer designation is a third explicit staff attestation.
-- Any drift, extra family member, second family, competing billing contact or pre-existing membership is a
-- non-writing NEEDS_STAFF_REVIEW / unavailable outcome; records are never merged or relinked.

-- Every child enrolled under one guardian/child CRM family, with its conversion-time identity snapshot and lead
-- attribution. CRM_REGISTRATION rows are captured inside the 0160/0169 registration transaction; ADDITIONAL_CHILD
-- rows are written by the direct-human additional-child command. Rows are never changed or deleted.
CREATE TABLE hon.crm_guardian_child_enrolled_children (
  student_profile_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  conversion_id uuid NOT NULL,
  source_lead_id uuid NOT NULL,
  guardian_person_id uuid NOT NULL,
  family_id uuid NOT NULL,
  child_person_id uuid NOT NULL UNIQUE,
  child_member_id uuid NOT NULL UNIQUE,
  origin text NOT NULL CHECK (origin IN ('CRM_REGISTRATION','ADDITIONAL_CHILD')),
  given_name text NOT NULL CHECK (length(given_name) BETWEEN 1 AND 100 AND btrim(given_name)=given_name
    AND given_name !~ '[[:cntrl:]<>]' AND regexp_replace(given_name,'[^[:alnum:]]','','g')<>''),
  family_name text NOT NULL CHECK (length(family_name) BETWEEN 1 AND 100 AND btrim(family_name)=family_name
    AND family_name !~ '[[:cntrl:]<>]' AND regexp_replace(family_name,'[^[:alnum:]]','','g')<>''),
  birth_date date NOT NULL CHECK (isfinite(birth_date) AND birth_date>=date '1900-01-01'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid,
  request_fingerprint text CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  receipt jsonb CHECK (jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (child_person_id<>guardian_person_id),
  CHECK ((origin='CRM_REGISTRATION' AND idempotency_key IS NULL AND request_fingerprint IS NULL AND receipt IS NULL)
    OR (origin='ADDITIONAL_CHILD' AND idempotency_key IS NOT NULL AND request_fingerprint IS NOT NULL AND receipt IS NOT NULL)),
  UNIQUE(student_profile_id,organization_id,school_id),
  UNIQUE(organization_id,school_id,actor_principal_id,idempotency_key),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(conversion_id,organization_id,school_id) REFERENCES hon.crm_lead_registration_conversions(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(source_lead_id,organization_id,school_id) REFERENCES hon.crm_leads(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(guardian_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(child_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(child_member_id,organization_id,school_id) REFERENCES hon.family_members(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX crm_guardian_child_registration_child_once ON hon.crm_guardian_child_enrolled_children(conversion_id) WHERE origin='CRM_REGISTRATION';
CREATE INDEX crm_guardian_child_enrolled_children_family_idx ON hon.crm_guardian_child_enrolled_children(organization_id,school_id,family_id);

-- Immutable operational payer designation: the family's source guardian is the responsible payer through that
-- guardian's one canonical billing account. Not legal guardianship, consent, payment authorization or an agreement.
-- The family_members.is_billing_contact projection is set alongside it but is never the authority.
CREATE TABLE hon.crm_guardian_child_payer_designations (
  family_id uuid PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  conversion_id uuid NOT NULL UNIQUE,
  guardian_person_id uuid NOT NULL,
  guardian_member_id uuid NOT NULL,
  billing_account_id uuid NOT NULL,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,organization_id,school_id),
  UNIQUE(organization_id,school_id,actor_principal_id,idempotency_key),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(conversion_id,organization_id,school_id) REFERENCES hon.crm_lead_registration_conversions(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(guardian_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(guardian_member_id,organization_id,school_id) REFERENCES hon.family_members(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(billing_account_id,organization_id,school_id) REFERENCES hon.billing_accounts(id,organization_id,school_id) ON DELETE RESTRICT
);

-- Lifetime one-DRAFT-per-child provenance, not a parallel membership model. Plan binding lives in the 0175
-- membership_plan_selections row written in the same transaction.
CREATE TABLE hon.crm_guardian_child_membership_draft_sources (
  student_profile_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  designation_id uuid NOT NULL,
  membership_id uuid NOT NULL UNIQUE,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,school_id,actor_principal_id,idempotency_key),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(student_profile_id,organization_id,school_id) REFERENCES hon.crm_guardian_child_enrolled_children(student_profile_id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(designation_id,organization_id,school_id) REFERENCES hon.crm_guardian_child_payer_designations(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT
);

ALTER TABLE hon.crm_guardian_child_enrolled_children ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_guardian_child_enrolled_children FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_guardian_child_payer_designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_guardian_child_payer_designations FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_guardian_child_membership_draft_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_guardian_child_membership_draft_sources FORCE ROW LEVEL SECURITY;

CREATE FUNCTION hon.guard_crm_guardian_child_enrollment_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_CRM_GUARDIAN_CHILD_ENROLLMENT' USING ERRCODE='42501'; END $$;
CREATE TRIGGER crm_guardian_child_enrolled_children_immutable BEFORE UPDATE OR DELETE ON hon.crm_guardian_child_enrolled_children FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_guardian_child_enrollment_history();
CREATE TRIGGER crm_guardian_child_enrolled_children_no_truncate BEFORE TRUNCATE ON hon.crm_guardian_child_enrolled_children FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_crm_guardian_child_enrollment_history();
CREATE TRIGGER crm_guardian_child_payer_designation_immutable BEFORE UPDATE OR DELETE ON hon.crm_guardian_child_payer_designations FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_guardian_child_enrollment_history();
CREATE TRIGGER crm_guardian_child_payer_designation_no_truncate BEFORE TRUNCATE ON hon.crm_guardian_child_payer_designations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_crm_guardian_child_enrollment_history();
CREATE TRIGGER crm_guardian_child_membership_source_immutable BEFORE UPDATE OR DELETE ON hon.crm_guardian_child_membership_draft_sources FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_guardian_child_enrollment_history();
CREATE TRIGGER crm_guardian_child_membership_source_no_truncate BEFORE TRUNCATE ON hon.crm_guardian_child_membership_draft_sources FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_crm_guardian_child_enrollment_history();

-- Captures the registration child's identity inside the unchanged 0169 registration transaction, after the fresh
-- graph and the conversion exist and before its audit/outbox rows (it takes no table lock). Conversions created
-- before this migration get no snapshot and stay a staff-review outcome: current mutable people/profile data
-- never establishes provenance for a historical conversion.
CREATE FUNCTION hon.capture_crm_guardian_child_registration_child() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s hon.student_profiles%ROWTYPE; child hon.people%ROWTYPE; member hon.family_members%ROWTYPE;
BEGIN
  IF NEW.registration_path IS DISTINCT FROM 'GUARDIAN_CHILD' THEN RETURN NEW; END IF;
  SELECT * INTO s FROM hon.student_profiles x WHERE x.id=NEW.resulting_student_profile_id AND x.organization_id=NEW.organization_id AND x.school_id=NEW.school_id;
  IF NOT FOUND OR NEW.family_id IS NULL OR s.primary_family_id IS DISTINCT FROM NEW.family_id OR s.person_id=NEW.original_contact_person_id
    OR s.birth_date IS NULL OR s.created_at<>transaction_timestamp() THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_REGISTRATION_SNAPSHOT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO child FROM hon.people x WHERE x.id=s.person_id AND x.organization_id=NEW.organization_id AND x.school_id=NEW.school_id AND x.created_at=transaction_timestamp();
  SELECT * INTO member FROM hon.family_members x WHERE x.family_id=NEW.family_id AND x.person_id=s.person_id AND x.organization_id=NEW.organization_id
    AND x.school_id=NEW.school_id AND x.member_role='STUDENT' AND x.created_at=transaction_timestamp();
  IF child.id IS NULL OR member.id IS NULL OR NOT EXISTS(SELECT 1 FROM hon.family_members x WHERE x.family_id=NEW.family_id AND x.person_id=NEW.original_contact_person_id
      AND x.organization_id=NEW.organization_id AND x.school_id=NEW.school_id AND x.member_role='GUARDIAN' AND x.created_at=transaction_timestamp()) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_REGISTRATION_SNAPSHOT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  INSERT INTO hon.crm_guardian_child_enrolled_children(student_profile_id,organization_id,school_id,conversion_id,source_lead_id,guardian_person_id,family_id,
      child_person_id,child_member_id,origin,given_name,family_name,birth_date,actor_principal_id,created_at)
    VALUES(s.id,NEW.organization_id,NEW.school_id,NEW.id,NEW.source_lead_id,NEW.original_contact_person_id,NEW.family_id,
      child.id,member.id,'CRM_REGISTRATION',child.given_name,child.family_name,s.birth_date,NEW.actor_principal_id,NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER crm_guardian_child_registration_child_capture AFTER INSERT ON hon.crm_lead_registration_conversions
FOR EACH ROW EXECUTE FUNCTION hon.capture_crm_guardian_child_registration_child();

-- Private identity proof: the GUARDIAN_CHILD registration actor (0160: crm.lead.read, crm.lead.register,
-- student.profile.manage, people.create, family.create, family.member.manage) that is also the adult DRAFT actor
-- (0162: billing.membership.create), for the same direct human, school and live entitlement.
CREATE FUNCTION hon.require_crm_guardian_child_enrollment_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
  IF subject IS NULL OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  actor:=hon.require_crm_lead_registration_actor(subject,'GUARDIAN_CHILD');
  IF actor IS NULL OR hon.require_crm_adult_membership_actor(subject) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- Private exact family proof for one current-school lead. Raises P0002 for anything that is not exactly one
-- verified guardian/child family: wrong path or malformed conversion, lead contact drift, a pre-0176 conversion
-- without a snapshot, an inactive family, a second guardian or any member that is not a recorded child, a guardian
-- or child in another family, a competing billing contact. The guardian's canonical account may be absent
-- (account_id NULL); ADDITIONAL accounts are never selected.
CREATE FUNCTION hon.crm_guardian_child_family_relation(selected_lead uuid)
RETURNS TABLE(conversion_id uuid,lead_id uuid,family_id uuid,guardian_person_id uuid,guardian_member_id uuid,guardian_display_name text,
  account_id uuid,currency text,child_count integer,registration_receipt jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
  l hon.crm_leads%ROWTYPE; c hon.crm_lead_registration_conversions%ROWTYPE; f hon.families%ROWTYPE; gm hon.family_members%ROWTYPE;
  account hon.billing_accounts%ROWTYPE; label text; children integer;
BEGIN
  IF selected_lead IS NULL OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO l FROM hon.crm_leads x WHERE x.id=selected_lead AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO c FROM hon.crm_lead_registration_conversions x WHERE x.source_lead_id=l.id AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND OR c.registration_path IS DISTINCT FROM 'GUARDIAN_CHILD' OR c.family_id IS NULL OR c.version<>1
    OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(c.response) k)
      IS DISTINCT FROM ARRAY['familyId','leadId','outcome','recordedAt','registrationPath','sourceContactPersonId','studentProfileId']
    OR c.response->>'outcome' IS DISTINCT FROM 'REGISTERED' OR c.response->>'registrationPath' IS DISTINCT FROM 'GUARDIAN_CHILD'
    OR c.response->>'leadId' IS DISTINCT FROM c.source_lead_id::text
    OR c.response->>'sourceContactPersonId' IS DISTINCT FROM c.original_contact_person_id::text
    OR c.response->>'studentProfileId' IS DISTINCT FROM c.resulting_student_profile_id::text
    OR c.response->>'familyId' IS DISTINCT FROM c.family_id::text
    OR c.response->>'recordedAt' IS DISTINCT FROM to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR l.primary_person_id IS DISTINCT FROM c.original_contact_person_id
    OR (SELECT count(*) FROM hon.crm_lead_registration_conversions x WHERE x.organization_id=org AND x.school_id=school AND x.resulting_student_profile_id=c.resulting_student_profile_id)<>1
    OR NOT EXISTS(SELECT 1 FROM hon.crm_guardian_child_enrolled_children e WHERE e.conversion_id=c.id AND e.origin='CRM_REGISTRATION'
      AND e.student_profile_id=c.resulting_student_profile_id AND e.family_id=c.family_id AND e.source_lead_id=l.id
      AND e.guardian_person_id=c.original_contact_person_id AND e.organization_id=org AND e.school_id=school) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO f FROM hon.families x WHERE x.id=c.family_id AND x.organization_id=org AND x.school_id=school AND x.status='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO gm FROM hon.family_members x WHERE x.family_id=f.id AND x.person_id=c.original_contact_person_id AND x.organization_id=org AND x.school_id=school AND x.member_role='GUARDIAN';
  SELECT count(*) INTO children FROM hon.crm_guardian_child_enrolled_children e WHERE e.family_id=f.id AND e.organization_id=org AND e.school_id=school;
  IF gm.id IS NULL
    OR (SELECT count(*) FROM hon.family_members x WHERE x.family_id=f.id AND x.organization_id=org AND x.school_id=school)<>children+1
    OR EXISTS(SELECT 1 FROM hon.family_members x WHERE x.family_id=f.id AND x.organization_id=org AND x.school_id=school AND x.id<>gm.id
      AND (x.member_role<>'STUDENT' OR x.is_billing_contact OR NOT EXISTS(SELECT 1 FROM hon.crm_guardian_child_enrolled_children e
        WHERE e.family_id=f.id AND e.child_member_id=x.id AND e.child_person_id=x.person_id AND e.conversion_id=c.id AND e.guardian_person_id=gm.person_id)))
    OR EXISTS(SELECT 1 FROM hon.crm_guardian_child_enrolled_children e WHERE e.family_id=f.id AND e.organization_id=org AND e.school_id=school
      AND (e.conversion_id<>c.id OR e.source_lead_id<>l.id OR e.guardian_person_id<>gm.person_id))
    OR (SELECT count(*) FROM hon.family_members x WHERE x.organization_id=org AND x.school_id=school AND x.person_id=gm.person_id)<>1 THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT btrim(concat_ws(' ',p.given_name,p.family_name)) INTO label FROM hon.people p WHERE p.id=gm.person_id AND p.organization_id=org AND p.school_id=school;
  IF label IS NULL OR length(label) NOT BETWEEN 1 AND 201 OR label ~ '[[:cntrl:]<>]' THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO account FROM hon.billing_accounts a WHERE a.organization_id=org AND a.school_id=school AND a.responsible_person_id=gm.person_id AND a.account_classification='CANONICAL';
  IF account.id IS NOT NULL AND account.currency::text !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN QUERY SELECT c.id,l.id,f.id,gm.person_id,gm.id,label,account.id,account.currency::text,children,c.response;
END $$;

-- Private exact child proof: the immutable enrolled-child snapshot still matches the current child person,
-- profile and family membership. Family-level facts are proven separately by the family relation.
CREATE FUNCTION hon.crm_guardian_child_child_relation(selected_student uuid)
RETURNS TABLE(student_profile_id uuid,child_person_id uuid,child_member_id uuid,family_id uuid,lead_id uuid,conversion_id uuid,
  display_name text,origin text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); e hon.crm_guardian_child_enrolled_children%ROWTYPE;
BEGIN
  IF selected_student IS NULL OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO e FROM hon.crm_guardian_child_enrolled_children x WHERE x.student_profile_id=selected_student AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND
    OR NOT EXISTS(SELECT 1 FROM hon.student_profiles s WHERE s.id=e.student_profile_id AND s.organization_id=org AND s.school_id=school AND s.status='ACTIVE'
      AND s.person_id=e.child_person_id AND s.primary_family_id=e.family_id AND s.birth_date=e.birth_date)
    OR NOT EXISTS(SELECT 1 FROM hon.people p WHERE p.id=e.child_person_id AND p.organization_id=org AND p.school_id=school
      AND p.given_name=e.given_name AND p.family_name=e.family_name)
    OR NOT EXISTS(SELECT 1 FROM hon.family_members m WHERE m.id=e.child_member_id AND m.organization_id=org AND m.school_id=school
      AND m.family_id=e.family_id AND m.person_id=e.child_person_id AND m.member_role='STUDENT' AND NOT m.is_billing_contact)
    OR (SELECT count(*) FROM hon.family_members m WHERE m.organization_id=org AND m.school_id=school AND m.person_id=e.child_person_id)<>1 THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN QUERY SELECT e.student_profile_id,e.child_person_id,e.child_member_id,e.family_id,e.source_lead_id,e.conversion_id,
    btrim(concat_ws(' ',e.given_name,e.family_name)),e.origin;
END $$;

-- Private: the family's designation id when it is exactly current (same conversion, guardian, guardian member and
-- the guardian's current canonical account; projection still set), otherwise NULL. Callers hold their locks and have
-- already proven the family relation passed in.
CREATE FUNCTION hon.crm_guardian_child_current_designation(selected_family uuid,selected_conversion uuid,guardian uuid,guardian_member uuid,account uuid) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT d.id FROM hon.crm_guardian_child_payer_designations d
  WHERE d.family_id=selected_family AND d.organization_id=hon.current_organization_id() AND d.school_id=hon.current_school_id()
    AND d.conversion_id=selected_conversion AND d.guardian_person_id=guardian AND d.guardian_member_id=guardian_member AND d.billing_account_id=account
    AND EXISTS(SELECT 1 FROM hon.family_members m WHERE m.id=guardian_member AND m.organization_id=d.organization_id AND m.school_id=d.school_id AND m.is_billing_contact)
$$;

-- Private actor-independent "is this child's source-bound DRAFT exactly current" check, returning the source row's
-- creator, stored receipt and bound plan version, or NULL. Mirrors the 0163 conditions. Never granted to the runtime.
CREATE FUNCTION hon.crm_guardian_child_membership_draft_current(selected_student uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); child record; family record;
  source hon.crm_guardian_child_membership_draft_sources%ROWTYPE; selection hon.membership_plan_selections%ROWTYPE;
  start_at timestamptz; end_at timestamptz; field text; value text; instant timestamptz;
BEGIN
  BEGIN
    SELECT * INTO child FROM hon.crm_guardian_child_child_relation(selected_student);
    SELECT * INTO family FROM hon.crm_guardian_child_family_relation(child.lead_id);
  EXCEPTION WHEN SQLSTATE 'P0002' OR SQLSTATE '22023' THEN RETURN NULL;
  END;
  IF family.family_id IS DISTINCT FROM child.family_id OR family.account_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO source FROM hon.crm_guardian_child_membership_draft_sources x WHERE x.student_profile_id=selected_student AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND OR source.family_id<>family.family_id
    OR source.designation_id IS DISTINCT FROM hon.crm_guardian_child_current_designation(family.family_id,family.conversion_id,family.guardian_person_id,family.guardian_member_id,family.account_id)
    OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(source.receipt) k)
      IS DISTINCT FROM ARRAY['membershipId','planCode','recordedAt','state','termEndsAt','termStartedAt']
    OR source.receipt->>'membershipId' IS DISTINCT FROM source.membership_id::text OR source.receipt->>'state' IS DISTINCT FROM 'DRAFT'
    OR jsonb_typeof(source.receipt->'planCode') IS DISTINCT FROM 'string'
    OR source.receipt->>'recordedAt' IS DISTINCT FROM to_char(source.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RETURN NULL; END IF;
  FOREACH field IN ARRAY ARRAY['termStartedAt','termEndsAt'] LOOP
    IF jsonb_typeof(source.receipt->field)='null' THEN instant:=NULL;
    ELSIF jsonb_typeof(source.receipt->field)='string' THEN
      value:=source.receipt->>field;
      IF length(value)<>24 OR value !~ '^(19|[2-9][0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN NULL; END IF;
      BEGIN instant:=value::timestamptz; EXCEPTION WHEN OTHERS THEN RETURN NULL; END;
      IF to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>value THEN RETURN NULL; END IF;
    ELSE RETURN NULL; END IF;
    IF field='termStartedAt' THEN start_at:=instant; ELSE end_at:=instant; END IF;
  END LOOP;
  SELECT * INTO selection FROM hon.membership_plan_selections x WHERE x.membership_id=source.membership_id AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND OR selection.actor_principal_id<>source.actor_principal_id
    OR NOT EXISTS(SELECT 1 FROM hon.memberships m WHERE m.id=source.membership_id AND m.organization_id=org AND m.school_id=school
      AND m.state='DRAFT' AND m.version=1 AND m.billing_account_id=family.account_id AND m.participant_person_id=child.child_person_id
      AND m.plan_code=source.receipt->>'planCode' AND m.term_started_at IS NOT DISTINCT FROM start_at AND m.term_ends_at IS NOT DISTINCT FROM end_at)
    OR EXISTS(SELECT 1 FROM hon.membership_payment_schedules x WHERE x.membership_id=source.membership_id)
    OR EXISTS(SELECT 1 FROM hon.invoices x WHERE x.membership_id=source.membership_id)
    OR (SELECT count(*) FROM hon.memberships x WHERE x.organization_id=org AND x.school_id=school AND x.participant_person_id=child.child_person_id)<>1 THEN
    RETURN NULL; END IF;
  RETURN jsonb_build_object('actor',source.actor_principal_id,'receipt',source.receipt,'planId',selection.plan_id,'planVersion',selection.plan_version);
END $$;

-- Read-only recovery of one current-school lead's guardian/child enrollment after navigation, refresh or session
-- loss: family state plus one state per enrolled child. Lead id is the only selector. A child's DRAFT receipt and
-- plan terms are shown only to the staff member who created it; other staff see a yes/no current state. No DML.
CREATE FUNCTION hon.read_crm_guardian_child_enrollment(subject text,selected_lead uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
  lead hon.crm_leads%ROWTYPE; c hon.crm_lead_registration_conversions%ROWTYPE; family record; child record;
  enrolled hon.crm_guardian_child_enrolled_children%ROWTYPE; designation hon.crm_guardian_child_payer_designations%ROWTYPE;
  current_designation uuid; current_draft jsonb; state text; child_state text; child_draft jsonb; children jsonb:='[]'::jsonb; result jsonb;
BEGIN
  IF selected_lead IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_crm_guardian_child_enrollment_actor(subject);
  -- Canonical order (0169/0176): IAM, then domain tables people-first, all SHARE.
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements,
    hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts,hon.memberships,
    hon.crm_guardian_child_enrolled_children,hon.crm_guardian_child_payer_designations,hon.crm_guardian_child_membership_draft_sources,hon.membership_payment_schedules,hon.invoices IN SHARE MODE;
  IF hon.require_crm_guardian_child_enrollment_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO lead FROM hon.crm_leads l WHERE l.id=selected_lead AND l.organization_id=org AND l.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO c FROM hon.crm_lead_registration_conversions x WHERE x.source_lead_id=lead.id AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN
    -- Same non-writing ambiguity rule as the registration command and the 0174 adult recovery.
    state:=CASE WHEN EXISTS(SELECT 1 FROM hon.student_profiles x WHERE x.organization_id=org AND x.school_id=school AND x.person_id=lead.primary_person_id)
      OR EXISTS(SELECT 1 FROM hon.family_members x WHERE x.organization_id=org AND x.school_id=school AND x.person_id=lead.primary_person_id)
      THEN 'NEEDS_STAFF_REVIEW' ELSE 'NOT_REGISTERED' END;
    result:=jsonb_build_object('leadId',lead.id,'workflowState',state);
  ELSIF c.registration_path='ADULT' THEN
    -- The adult workflow has its own recovery (0174); nothing about it is disclosed here.
    result:=jsonb_build_object('leadId',lead.id,'workflowState','ADULT_REGISTRATION');
  ELSE
    BEGIN
      SELECT * INTO family FROM hon.crm_guardian_child_family_relation(lead.id);
    EXCEPTION WHEN SQLSTATE 'P0002' THEN state:='NEEDS_STAFF_REVIEW';
    END;
    IF state IS NULL THEN
      SELECT * INTO designation FROM hon.crm_guardian_child_payer_designations d WHERE d.family_id=family.family_id AND d.organization_id=org AND d.school_id=school;
      current_designation:=CASE WHEN family.account_id IS NULL THEN NULL
        ELSE hon.crm_guardian_child_current_designation(family.family_id,family.conversion_id,family.guardian_person_id,family.guardian_member_id,family.account_id) END;
      state:=CASE WHEN designation.id IS NOT NULL AND current_designation IS DISTINCT FROM designation.id THEN 'NEEDS_STAFF_REVIEW'
        WHEN designation.id IS NOT NULL THEN 'PAYER_DESIGNATED'
        WHEN family.account_id IS NULL THEN 'BILLING_ACCOUNT_REQUIRED'
        ELSE 'PAYER_DESIGNATION_REQUIRED' END;
    END IF;
    result:=jsonb_build_object('leadId',lead.id,'workflowState',state);
    IF state<>'NEEDS_STAFF_REVIEW' THEN
      FOR enrolled IN SELECT * FROM hon.crm_guardian_child_enrolled_children e WHERE e.family_id=family.family_id AND e.organization_id=org AND e.school_id=school
        ORDER BY e.created_at,e.student_profile_id LOOP
        child_state:=NULL; child_draft:=NULL;
        BEGIN
          SELECT * INTO child FROM hon.crm_guardian_child_child_relation(enrolled.student_profile_id);
        EXCEPTION WHEN SQLSTATE 'P0002' THEN child_state:='NEEDS_STAFF_REVIEW';
        END;
        IF child_state IS NULL AND state<>'PAYER_DESIGNATED' THEN
          child_state:=CASE WHEN EXISTS(SELECT 1 FROM hon.crm_guardian_child_membership_draft_sources x WHERE x.student_profile_id=enrolled.student_profile_id)
            OR EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=enrolled.child_person_id)
            THEN 'NEEDS_STAFF_REVIEW' ELSE 'AWAITING_PAYER_DESIGNATION' END;
        ELSIF child_state IS NULL AND NOT EXISTS(SELECT 1 FROM hon.crm_guardian_child_membership_draft_sources x WHERE x.student_profile_id=enrolled.student_profile_id) THEN
          child_state:=CASE WHEN EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=enrolled.child_person_id)
            THEN 'NEEDS_STAFF_REVIEW' ELSE 'READY_FOR_DRAFT' END;
        ELSIF child_state IS NULL THEN
          current_draft:=hon.crm_guardian_child_membership_draft_current(enrolled.student_profile_id);
          IF current_draft IS NULL THEN child_state:='NEEDS_STAFF_REVIEW';
          ELSIF (current_draft->>'actor')::uuid=actor THEN
            child_state:='CURRENT_DRAFT';
            child_draft:=jsonb_build_object('state','RECORDED_DRAFT','receipt',current_draft->'receipt',
              'plan',hon.membership_plan_version_summary((current_draft->>'planId')::uuid,(current_draft->>'planVersion')::integer));
          ELSE
            child_state:='CURRENT_DRAFT_BY_OTHER_STAFF'; child_draft:=jsonb_build_object('state','RECORDED_DRAFT');
          END IF;
        END IF;
        children:=children || jsonb_build_array(jsonb_build_object('studentProfileId',enrolled.student_profile_id,
          'displayName',btrim(concat_ws(' ',enrolled.given_name,enrolled.family_name)),'origin',enrolled.origin,'workflowState',child_state)
          || CASE WHEN child_draft IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('currentMembershipDraft',child_draft) END);
      END LOOP;
      result:=result || jsonb_build_object('historicalRegistrationReceipt',family.registration_receipt,
        'guardian',jsonb_build_object('displayName',family.guardian_display_name),'children',children);
      IF family.account_id IS NOT NULL THEN result:=result || jsonb_build_object('billingAccount',jsonb_build_object('classification','CANONICAL','currency',family.currency)); END IF;
      IF state='PAYER_DESIGNATED' THEN result:=result || jsonb_build_object('payerDesignation',designation.receipt); END IF;
    END IF;
  END IF;
  IF hon.require_crm_guardian_child_enrollment_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Explicit direct-human payer designation of the family's source guardian. Requires the guardian's existing
-- canonical billing account (created separately through the billing-account command; never created here).
CREATE FUNCTION hon.designate_crm_guardian_child_payer(subject text,selected_lead uuid,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; family record; final_family record;
  fp text; reserved boolean; prior hon.idempotency_records%ROWTYPE; designation hon.crm_guardian_child_payer_designations%ROWTYPE;
  result_receipt jsonb; instant timestamptz;
BEGIN
  actor:=hon.require_crm_guardian_child_enrollment_actor(subject);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected_lead IS NULL OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR (SELECT array_agg(k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['confirmation']
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_PAYER_DESIGNATION' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','crm.guardian_child.payer.designate','leadId',selected_lead,'input',p)::text,'UTF8')),'hex');
  -- Canonical order (0169/0176): key reservation; IAM SHARE; people ... billing_accounts SHARE ROW EXCLUSIVE;
  -- the designation table SHARE ROW EXCLUSIVE; evidence last.
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key::text,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  LOCK TABLE hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts,hon.crm_guardian_child_payer_designations IN SHARE ROW EXCLUSIVE MODE;
  IF hon.require_crm_guardian_child_enrollment_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- A reused key is refused before any domain fact is evaluated or disclosed.
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  END IF;
  SELECT * INTO family FROM hon.crm_guardian_child_family_relation(selected_lead);
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    SELECT * INTO designation FROM hon.crm_guardian_child_payer_designations d WHERE d.family_id=family.family_id AND d.organization_id=org AND d.school_id=school;
    IF NOT FOUND OR designation.actor_principal_id<>actor OR designation.idempotency_key<>key OR designation.request_fingerprint<>fp
      OR prior.status<>'COMPLETED' OR prior.response_body IS DISTINCT FROM jsonb_build_object('receipt',designation.receipt) THEN
      RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
    -- Historical designation receipt; the recovery read reports whether it is still current.
    IF hon.require_crm_guardian_child_enrollment_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',designation.receipt,'replayed',true);
  END IF;
  IF EXISTS(SELECT 1 FROM hon.crm_guardian_child_payer_designations d WHERE d.family_id=family.family_id OR d.conversion_id=family.conversion_id) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF family.account_id IS NULL THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_BILLING_ACCOUNT_REQUIRED' USING ERRCODE='P0002'; END IF;
  instant:=clock_timestamp();
  result_receipt:=jsonb_build_object('state','PAYER_DESIGNATED','guardianDisplayName',family.guardian_display_name,'currency',family.currency,
    'recordedAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO hon.crm_guardian_child_payer_designations(family_id,organization_id,school_id,conversion_id,guardian_person_id,guardian_member_id,billing_account_id,
      actor_principal_id,idempotency_key,request_fingerprint,receipt,created_at)
    VALUES(family.family_id,org,school,family.conversion_id,family.guardian_person_id,family.guardian_member_id,family.account_id,actor,key,fp,result_receipt,instant)
    RETURNING * INTO designation;
  UPDATE hon.family_members SET is_billing_contact=true WHERE id=family.guardian_member_id AND organization_id=org AND school_id=school
    AND family_id=family.family_id AND person_id=family.guardian_person_id AND member_role='GUARDIAN';
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.guardian_payer.designate','CRM_GUARDIAN_CHILD_PAYER_DESIGNATION',designation.id,NULL,result_receipt,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.guardian_payer.designated',1,'CRM_GUARDIAN_CHILD_PAYER_DESIGNATION',designation.id,1,correlation,request,result_receipt || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=jsonb_build_object('receipt',result_receipt)
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text;
  SELECT * INTO final_family FROM hon.crm_guardian_child_family_relation(selected_lead);
  IF final_family IS DISTINCT FROM family
    OR hon.crm_guardian_child_current_designation(family.family_id,family.conversion_id,family.guardian_person_id,family.guardian_member_id,family.account_id) IS DISTINCT FROM designation.id THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
  IF hon.require_crm_guardian_child_enrollment_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result_receipt,'replayed',false);
END $$;

-- Direct-human registration of another child under the same verified guardian/child family. Creates exactly one
-- child person, one STUDENT family member and one student profile, with the family's lead attribution. A possible
-- existing record (same normalized name, or same birth date and family name, anywhere in the school) is a
-- non-writing NEEDS_STAFF_REVIEW outcome: nothing is linked or merged.
CREATE FUNCTION hon.add_crm_guardian_child_additional_child(subject text,selected_lead uuid,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; family record; final_family record; child record;
  fp text; reserved boolean; prior hon.idempotency_records%ROWTYPE; enrolled hon.crm_guardian_child_enrolled_children%ROWTYPE;
  child_birth date; normalized_given text; normalized_family text; person uuid; member uuid; student uuid; result_receipt jsonb; instant timestamptz;
BEGIN
  actor:=hon.require_crm_guardian_child_enrollment_actor(subject);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected_lead IS NULL OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['childBirthDate','childFamilyName','childGivenName','confirmation']
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_ADDITION'
    OR jsonb_typeof(p->'childGivenName') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'childFamilyName') IS DISTINCT FROM 'string'
    OR length(p->>'childGivenName') NOT BETWEEN 1 AND 100 OR length(p->>'childFamilyName') NOT BETWEEN 1 AND 100
    OR btrim(p->>'childGivenName')<>p->>'childGivenName' OR btrim(p->>'childFamilyName')<>p->>'childFamilyName'
    OR p->>'childGivenName' ~ '[[:cntrl:]<>]' OR p->>'childFamilyName' ~ '[[:cntrl:]<>]'
    OR regexp_replace(p->>'childGivenName','[^[:alnum:]]','','g')='' OR regexp_replace(p->>'childFamilyName','[^[:alnum:]]','','g')=''
    OR jsonb_typeof(p->'childBirthDate') IS DISTINCT FROM 'string' OR p->>'childBirthDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  child_birth:=(p->>'childBirthDate')::date;
  IF NOT isfinite(child_birth) OR child_birth<date '1900-01-01' OR child_birth>(clock_timestamp() AT TIME ZONE 'UTC')::date
    OR to_char(child_birth,'YYYY-MM-DD')<>p->>'childBirthDate' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','crm.guardian_child.child.add','leadId',selected_lead,'input',p)::text,'UTF8')),'hex');
  -- Canonical order (0169/0176): key reservation; IAM SHARE; exactly the 0169 registration set (people ...
  -- conversions) SHARE ROW EXCLUSIVE, which also serializes the school-wide existing-record check against
  -- registration; the enrolled-children table SHARE ROW EXCLUSIVE; evidence last.
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key::text,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  LOCK TABLE hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_guardian_child_enrolled_children IN SHARE ROW EXCLUSIVE MODE;
  IF hon.require_crm_guardian_child_enrollment_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- A reused key is refused before any domain fact is evaluated or disclosed.
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  END IF;
  SELECT * INTO family FROM hon.crm_guardian_child_family_relation(selected_lead);
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    SELECT * INTO enrolled FROM hon.crm_guardian_child_enrolled_children e WHERE e.organization_id=org AND e.school_id=school AND e.actor_principal_id=actor
      AND e.idempotency_key=key AND e.origin='ADDITIONAL_CHILD';
    IF NOT FOUND OR enrolled.request_fingerprint<>fp OR enrolled.family_id<>family.family_id
      OR prior.status<>'COMPLETED' OR prior.response_body IS DISTINCT FROM jsonb_build_object('result',enrolled.receipt) THEN
      RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
    IF hon.require_crm_guardian_child_enrollment_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('result',enrolled.receipt,'replayed',true);
  END IF;
  IF family.child_count>=10 THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_LIMIT' USING ERRCODE='P0002'; END IF;
  normalized_given:=lower(regexp_replace(p->>'childGivenName','[^[:alnum:]]','','g'));
  normalized_family:=lower(regexp_replace(p->>'childFamilyName','[^[:alnum:]]','','g'));
  IF EXISTS(SELECT 1 FROM hon.people x LEFT JOIN hon.student_profiles s ON s.person_id=x.id AND s.organization_id=x.organization_id AND s.school_id=x.school_id
    WHERE x.organization_id=org AND x.school_id=school AND (
      (lower(regexp_replace(x.given_name,'[^[:alnum:]]','','g'))=normalized_given AND lower(regexp_replace(x.family_name,'[^[:alnum:]]','','g'))=normalized_family)
      OR (s.birth_date=child_birth AND lower(regexp_replace(x.family_name,'[^[:alnum:]]','','g'))=normalized_family))) THEN
    -- Rolls back the key reservation with everything else: no record of any kind.
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_NEEDS_STAFF_REVIEW' USING ERRCODE='P0001'; END IF;
  INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES(org,school,p->>'childGivenName',p->>'childFamilyName') RETURNING id INTO person;
  INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES(org,school,family.family_id,person,'STUDENT',false) RETURNING id INTO member;
  INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES(org,school,person,family.family_id,child_birth) RETURNING id INTO student;
  instant:=clock_timestamp();
  result_receipt:=jsonb_build_object('outcome','CHILD_ADDED','leadId',family.lead_id,'studentProfileId',student,
    'childDisplayName',btrim(concat_ws(' ',p->>'childGivenName',p->>'childFamilyName')),'recordedAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO hon.crm_guardian_child_enrolled_children(student_profile_id,organization_id,school_id,conversion_id,source_lead_id,guardian_person_id,family_id,
      child_person_id,child_member_id,origin,given_name,family_name,birth_date,actor_principal_id,idempotency_key,request_fingerprint,receipt,created_at)
    VALUES(student,org,school,family.conversion_id,family.lead_id,family.guardian_person_id,family.family_id,person,member,'ADDITIONAL_CHILD',
      p->>'childGivenName',p->>'childFamilyName',child_birth,actor,key,fp,result_receipt,instant);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','crm.guardian_child.child.add','CRM_GUARDIAN_CHILD_ENROLLED_CHILD',student,NULL,result_receipt,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'crm.guardian_child.child_added',1,'CRM_GUARDIAN_CHILD_ENROLLED_CHILD',student,1,correlation,request,result_receipt || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=jsonb_build_object('result',result_receipt)
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text;
  SELECT * INTO final_family FROM hon.crm_guardian_child_family_relation(selected_lead);
  SELECT * INTO child FROM hon.crm_guardian_child_child_relation(student);
  IF final_family.family_id IS DISTINCT FROM family.family_id OR final_family.child_count<>family.child_count+1
    OR child.family_id IS DISTINCT FROM family.family_id OR child.child_person_id IS DISTINCT FROM person THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
  IF hon.require_crm_guardian_child_enrollment_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('result',result_receipt,'replayed',false);
END $$;

-- One plan-bound DRAFT for one enrolled child, billed to the family's designated guardian through that guardian's
-- canonical account. Same plan rules, receipt shape and response shape as the 0175 adult DRAFT from plan.
CREATE FUNCTION hon.draft_crm_guardian_child_membership_from_plan(subject text,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; child record; family record; final_child record; final_family record;
  selected uuid; selected_plan uuid; selected_version integer; start_at timestamptz; end_at timestamptz; value text; fp text; reserved boolean; designation uuid;
  prior hon.idempotency_records%ROWTYPE; source hon.crm_guardian_child_membership_draft_sources%ROWTYPE; membership hon.memberships%ROWTYPE;
  plan hon.membership_plans%ROWTYPE; terms hon.membership_plan_versions%ROWTYPE; selection hon.membership_plan_selections%ROWTYPE;
  plan_summary jsonb; result_receipt jsonb; response jsonb; binding jsonb; instant timestamptz;
BEGIN
  actor:=hon.require_crm_guardian_child_enrollment_actor(subject);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['studentProfileId','membershipPlanId','membershipPlanVersion','confirmation']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('studentProfileId','membershipPlanId','membershipPlanVersion','termStartedAt','confirmation'))
    OR jsonb_typeof(p->'studentProfileId') IS DISTINCT FROM 'string' OR p->>'studentProfileId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR jsonb_typeof(p->'membershipPlanId') IS DISTINCT FROM 'string' OR p->>'membershipPlanId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR jsonb_typeof(p->'membershipPlanVersion') IS DISTINCT FROM 'number' OR (p->'membershipPlanVersion')::text !~ '^[1-9][0-9]{0,5}$'
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  selected:=(p->>'studentProfileId')::uuid; selected_plan:=(p->>'membershipPlanId')::uuid; selected_version:=(p->>'membershipPlanVersion')::integer;
  IF p ? 'termStartedAt' THEN
    value:=p->>'termStartedAt';
    IF jsonb_typeof(p->'termStartedAt') IS DISTINCT FROM 'string' OR length(value)<>24 OR value !~ '^(19|[2-9][0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      OR to_char(value::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>value THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    start_at:=value::timestamptz;
  END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','crm.guardian_child.membership.draft.from_plan','input',
    p || jsonb_build_object('studentProfileId',selected,'membershipPlanId',selected_plan))::text,'UTF8')),'hex');
  -- Canonical order (0169/0176): key reservation; IAM SHARE; the 0169 DRAFT set people ... memberships SHARE ROW
  -- EXCLUSIVE; enrolled children and designations SHARE (read only); child DRAFT sources SHARE ROW EXCLUSIVE; plan
  -- head and versions SHARE (as 0175); the selection row insert; evidence last.
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key::text,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  LOCK TABLE hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts,hon.memberships IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE hon.crm_guardian_child_enrolled_children,hon.crm_guardian_child_payer_designations IN SHARE MODE;
  LOCK TABLE hon.crm_guardian_child_membership_draft_sources IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE hon.membership_plans,hon.membership_plan_versions IN SHARE MODE;
  IF hon.require_crm_guardian_child_enrollment_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- A reused key is refused before any domain fact is evaluated or disclosed.
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  END IF;
  SELECT * INTO child FROM hon.crm_guardian_child_child_relation(selected);
  SELECT * INTO family FROM hon.crm_guardian_child_family_relation(child.lead_id);
  IF family.family_id IS DISTINCT FROM child.family_id OR family.conversion_id IS DISTINCT FROM child.conversion_id THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    SELECT * INTO source FROM hon.crm_guardian_child_membership_draft_sources x WHERE x.student_profile_id=selected AND x.organization_id=org AND x.school_id=school;
    IF NOT FOUND OR source.actor_principal_id<>actor OR source.idempotency_key<>key OR source.request_fingerprint<>fp
      OR prior.status<>'COMPLETED' OR prior.response_body->'receipt' IS DISTINCT FROM source.receipt THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
    SELECT * INTO selection FROM hon.membership_plan_selections x WHERE x.membership_id=source.membership_id AND x.organization_id=org AND x.school_id=school;
    IF NOT FOUND OR selection.plan_id<>selected_plan OR selection.plan_version<>selected_version OR selection.actor_principal_id<>actor
      OR prior.response_body->'plan' IS DISTINCT FROM hon.membership_plan_version_summary(selected_plan,selected_version) THEN
      RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
    -- Historical DRAFT creation and the immutable plan terms it used; not current state.
    PERFORM 1 FROM hon.memberships m WHERE m.id=source.membership_id AND m.organization_id=org AND m.school_id=school AND m.participant_person_id=child.child_person_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    IF hon.require_crm_guardian_child_enrollment_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',source.receipt,'plan',prior.response_body->'plan','replayed',true);
  END IF;
  designation:=CASE WHEN family.account_id IS NULL THEN NULL
    ELSE hon.crm_guardian_child_current_designation(family.family_id,family.conversion_id,family.guardian_person_id,family.guardian_member_id,family.account_id) END;
  IF designation IS NULL THEN
    IF EXISTS(SELECT 1 FROM hon.crm_guardian_child_payer_designations d WHERE d.family_id=family.family_id) THEN
      RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_REQUIRED' USING ERRCODE='P0002'; END IF;
  IF EXISTS(SELECT 1 FROM hon.crm_guardian_child_membership_draft_sources x WHERE x.student_profile_id=selected)
    OR EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=child.child_person_id) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  -- Server-verified plan: current school, exactly the current version, available, open program, account currency.
  SELECT * INTO plan FROM hon.membership_plans x WHERE x.id=selected_plan AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF plan.current_version<>selected_version THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_VERSION_STALE' USING ERRCODE='40001'; END IF;
  SELECT * INTO terms FROM hon.membership_plan_versions v WHERE v.plan_id=plan.id AND v.version=plan.current_version AND v.organization_id=org AND v.school_id=school;
  IF NOT FOUND OR terms.availability<>'AVAILABLE'
    OR (terms.program_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hon.programs g WHERE g.id=terms.program_id AND g.organization_id=org AND g.school_id=school AND g.status NOT IN ('CANCELLED','COMPLETED'))) THEN
    RAISE EXCEPTION 'MEMBERSHIP_PLAN_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF terms.currency::text IS DISTINCT FROM family.currency THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_CURRENCY_MISMATCH' USING ERRCODE='22023'; END IF;
  -- 0175 term rule: a fixed term ends exactly termMonths after its start (UTC calendar months, end-of-month clamped).
  IF start_at IS NOT NULL AND terms.term_kind='FIXED_MONTHS' THEN
    end_at:=((start_at AT TIME ZONE 'UTC')+make_interval(months=>terms.term_months)) AT TIME ZONE 'UTC';
  END IF;
  INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
    VALUES(org,school,family.account_id,child.child_person_id,plan.plan_code,'DRAFT',start_at,end_at) RETURNING * INTO membership;
  instant:=clock_timestamp();
  result_receipt:=jsonb_build_object('membershipId',membership.id,'state','DRAFT','planCode',membership.plan_code,
    'termStartedAt',CASE WHEN start_at IS NULL THEN NULL ELSE to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'termEndsAt',CASE WHEN end_at IS NULL THEN NULL ELSE to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'recordedAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO hon.crm_guardian_child_membership_draft_sources(student_profile_id,organization_id,school_id,family_id,designation_id,membership_id,actor_principal_id,
      idempotency_key,request_fingerprint,receipt,created_at)
    VALUES(selected,org,school,family.family_id,designation,membership.id,actor,key,fp,result_receipt,instant);
  INSERT INTO hon.membership_plan_selections(membership_id,organization_id,school_id,plan_id,plan_version,actor_principal_id,created_at)
    VALUES(membership.id,org,school,plan.id,plan.current_version,actor,instant);
  plan_summary:=hon.membership_plan_version_summary(plan.id,plan.current_version);
  binding:=jsonb_build_object('membershipPlanId',plan.id,'membershipPlanVersion',plan.current_version);
  response:=jsonb_build_object('receipt',result_receipt,'plan',plan_summary);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership.create','MEMBERSHIP',membership.id,NULL,result_receipt || binding,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership.drafted',1,'MEMBERSHIP',membership.id,membership.version,correlation,request,result_receipt || binding || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=response
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text;
  -- Final relation, designation, plan and authority rechecks include all post-insert evidence.
  SELECT * INTO final_child FROM hon.crm_guardian_child_child_relation(selected);
  SELECT * INTO final_family FROM hon.crm_guardian_child_family_relation(child.lead_id);
  IF final_child IS DISTINCT FROM child OR final_family IS DISTINCT FROM family OR plan_summary IS NULL
    OR hon.crm_guardian_child_current_designation(family.family_id,family.conversion_id,family.guardian_person_id,family.guardian_member_id,family.account_id) IS DISTINCT FROM designation
    OR hon.crm_guardian_child_membership_draft_current(selected)->'receipt' IS DISTINCT FROM result_receipt
    OR NOT EXISTS(SELECT 1 FROM hon.membership_plans x WHERE x.id=plan.id AND x.current_version=selected_version) THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT' USING ERRCODE='40001'; END IF;
  IF hon.require_crm_guardian_child_enrollment_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result_receipt,'plan',plan_summary,'replayed',false);
END $$;

COMMENT ON FUNCTION hon.read_crm_guardian_child_enrollment(text,uuid) IS
'Direct HUMAN_UI read-only recovery of one current-school CRM lead''s guardian/child enrollment: family state and one state per enrolled child. A child DRAFT receipt and plan only for its creator; a yes/no current state for other staff. No record, audit, outbox, idempotency, billing, payment, activation, provider, AI or automation effect.';
COMMENT ON FUNCTION hon.designate_crm_guardian_child_payer(text,uuid,jsonb,uuid,uuid,uuid) IS
'Direct HUMAN_UI designation of a verified guardian/child family''s source guardian as payer through that guardian''s existing canonical billing account. No account creation, consent, agreement, payment authorization, schedule, invoice, provider, communication, AI or automation effect.';
COMMENT ON FUNCTION hon.add_crm_guardian_child_additional_child(text,uuid,jsonb,uuid,uuid,uuid) IS
'Direct HUMAN_UI registration of one additional child under a verified guardian/child CRM family, keeping the family''s lead attribution. Possible existing records are a non-writing staff-review outcome; nothing is linked or merged. No membership, billing, payment, consent, booking, communication, AI or automation effect.';
COMMENT ON FUNCTION hon.draft_crm_guardian_child_membership_from_plan(text,jsonb,uuid,uuid,uuid) IS
'Direct HUMAN_UI DRAFT of one membership for one enrolled guardian/child CRM child, billed to the family''s designated guardian payer and bound to the exact current published school membership plan version. No schedule, invoice, payment, discount, agreement, provider, communication, activation, automation, Action Engine or AI effect.';

REVOKE ALL ON TABLE hon.crm_guardian_child_enrolled_children,hon.crm_guardian_child_payer_designations,hon.crm_guardian_child_membership_draft_sources FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_crm_guardian_child_enrollment_history(),hon.capture_crm_guardian_child_registration_child(),
  hon.require_crm_guardian_child_enrollment_actor(text),hon.crm_guardian_child_family_relation(uuid),hon.crm_guardian_child_child_relation(uuid),
  hon.crm_guardian_child_current_designation(uuid,uuid,uuid,uuid,uuid),hon.crm_guardian_child_membership_draft_current(uuid),
  hon.read_crm_guardian_child_enrollment(text,uuid),hon.designate_crm_guardian_child_payer(text,uuid,jsonb,uuid,uuid,uuid),
  hon.add_crm_guardian_child_additional_child(text,uuid,jsonb,uuid,uuid,uuid),hon.draft_crm_guardian_child_membership_from_plan(text,jsonb,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; col text; t text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.crm_guardian_child_enrolled_children,hon.crm_guardian_child_payer_designations,hon.crm_guardian_child_membership_draft_sources FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_crm_guardian_child_enrollment_history(),hon.capture_crm_guardian_child_registration_child(),
      hon.require_crm_guardian_child_enrollment_actor(text),hon.crm_guardian_child_family_relation(uuid),hon.crm_guardian_child_child_relation(uuid),
      hon.crm_guardian_child_current_designation(uuid,uuid,uuid,uuid,uuid),hon.crm_guardian_child_membership_draft_current(uuid),
      hon.read_crm_guardian_child_enrollment(text,uuid),hon.designate_crm_guardian_child_payer(text,uuid,jsonb,uuid,uuid,uuid),
      hon.add_crm_guardian_child_additional_child(text,uuid,jsonb,uuid,uuid,uuid),hon.draft_crm_guardian_child_membership_from_plan(text,jsonb,uuid,uuid,uuid) FROM %I',r);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['crm_guardian_child_enrolled_children','crm_guardian_child_payer_designations','crm_guardian_child_membership_draft_sources'] LOOP
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_crm_guardian_child_enrollment(text,uuid),hon.designate_crm_guardian_child_payer(text,uuid,jsonb,uuid,uuid,uuid),
      hon.add_crm_guardian_child_additional_child(text,uuid,jsonb,uuid,uuid,uuid),hon.draft_crm_guardian_child_membership_from_plan(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
