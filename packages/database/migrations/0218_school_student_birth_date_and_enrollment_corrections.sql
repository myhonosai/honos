BEGIN;

-- B-CRM-1b (proposed number 0218; the owner allocates the final number). Two linked changes:
--  1. A school can correct a student's birth date through one fixed SECURITY DEFINER command (the runtime role has
--     no UPDATE on hon.student_profiles). Making a known minor an adult removes the guardian-of-record requirement
--     at membership activation (0177 D3), so that crossing needs a school OWNER and every change carries a reason.
--  2. Owner decision 2026-11-07: a name or birth date correction of a CRM guardian/child enrolled child carries into
--     that enrollment. The 0176 child snapshot stays immutable; an append-only, audited correction records the new
--     identity and hon.crm_guardian_child_child_relation compares against the latest correction (else the snapshot).
--     Before this, a 0217 name edit sent the enrollment to NEEDS_STAFF_REVIEW with no way forward but reverting it.
-- No entitlement, billing, credit, AI, consent, membership or family effect.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.update_school_person(text,jsonb,uuid)') IS NULL
    OR to_regprocedure('hon.crm_guardian_child_child_relation(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Student birth date and enrollment corrections require 0176 and 0217'; END IF;
END $$;

CREATE TABLE hon.crm_guardian_child_identity_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  student_profile_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>=1),
  -- Same rules as the 0176 snapshot, so a corrected identity is never weaker than a captured one.
  given_name text NOT NULL CHECK (length(given_name) BETWEEN 1 AND 100 AND btrim(given_name)=given_name
    AND given_name !~ '[[:cntrl:]<>]' AND regexp_replace(given_name,'[^[:alnum:]]','','g')<>''),
  family_name text NOT NULL CHECK (length(family_name) BETWEEN 1 AND 100 AND btrim(family_name)=family_name
    AND family_name !~ '[[:cntrl:]<>]' AND regexp_replace(family_name,'[^[:alnum:]]','','g')<>''),
  birth_date date NOT NULL CHECK (isfinite(birth_date) AND birth_date>=date '1900-01-01'),
  prior_given_name text NOT NULL,
  prior_family_name text NOT NULL,
  prior_birth_date date NOT NULL,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (student_profile_id,version),
  FOREIGN KEY (student_profile_id,organization_id,school_id)
    REFERENCES hon.crm_guardian_child_enrolled_children(student_profile_id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.crm_guardian_child_identity_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_guardian_child_identity_corrections FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.crm_guardian_child_identity_corrections FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.crm_guardian_child_identity_corrections FROM %I',r);
  END LOOP;
END $$;
CREATE TRIGGER crm_guardian_child_identity_corrections_immutable BEFORE UPDATE OR DELETE ON hon.crm_guardian_child_identity_corrections
  FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_guardian_child_enrollment_history();
CREATE TRIGGER crm_guardian_child_identity_corrections_no_truncate BEFORE TRUNCATE ON hon.crm_guardian_child_identity_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_crm_guardian_child_enrollment_history();

-- Exact-key receipts of the two person commands (Manus P2-165-3). Their own table and uuid keys, so no other
-- command's free-text Idempotency-Key (for example activation, 0177, which reserves its key in hon.idempotency_records
-- before taking the people/student SHARE locks) can ever occupy a person command's reservation while that command
-- holds the people/student write locks. Only the two definers below write it, always after those locks. A receipt
-- is reserved IN_PROGRESS and completed once with its response; it is never deleted or changed afterwards.
CREATE TABLE hon.school_person_command_receipts (
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  command text NOT NULL CHECK (command IN ('people.update','people.birth_date')),
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,command,idempotency_key),
  CHECK ((status='COMPLETED')=(response_body IS NOT NULL AND completed_at IS NOT NULL))
);
ALTER TABLE hon.school_person_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_person_command_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.school_person_command_receipts FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.school_person_command_receipts FROM %I',r);
  END LOOP;
END $$;
CREATE FUNCTION hon.guard_school_person_command_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status='IN_PROGRESS' AND NEW.status='COMPLETED'
    AND (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.command,NEW.idempotency_key,NEW.request_fingerprint,NEW.created_at)
      IS NOT DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.command,OLD.idempotency_key,OLD.request_fingerprint,OLD.created_at) THEN
    RETURN NEW; END IF;
  RAISE EXCEPTION 'SCHOOL_PERSON_COMMAND_RECEIPT_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER school_person_command_receipts_complete_once BEFORE UPDATE OR DELETE ON hon.school_person_command_receipts
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_person_command_receipt();
CREATE TRIGGER school_person_command_receipts_no_truncate BEFORE TRUNCATE ON hon.school_person_command_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_person_command_receipt();

-- The identity an enrolled child is held to: the latest correction, else the immutable 0176 snapshot.
CREATE FUNCTION hon.crm_guardian_child_current_identity(p_student uuid,p_org uuid,p_school uuid)
RETURNS TABLE(given_name text,family_name text,birth_date date)
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT x.given_name,x.family_name,x.birth_date FROM (
    SELECT c.given_name,c.family_name,c.birth_date,c.version FROM hon.crm_guardian_child_identity_corrections c
      WHERE c.student_profile_id=p_student AND c.organization_id=p_org AND c.school_id=p_school
    UNION ALL
    SELECT e.given_name,e.family_name,e.birth_date,0 FROM hon.crm_guardian_child_enrolled_children e
      WHERE e.student_profile_id=p_student AND e.organization_id=p_org AND e.school_id=p_school
  ) x ORDER BY x.version DESC LIMIT 1
$$;

-- Called by the two governed edit commands after their write, inside their transaction (they hold the hon.people
-- write lock, which every CRM guardian/child command and activation takes in SHARE or SHARE ROW EXCLUSIVE before
-- reading the child relation, so a correction and an enrollment step never interleave).
-- Field mask (Manus P1-165-1): the caller passes only the values it was authorized to change and did change
-- (NULL = not changed by this command). The next correction is the held identity with exactly those fields replaced.
-- Any other difference between the live record and the held identity (a change made outside these commands) is never
-- adopted: it stays visible to the child relation, so the enrollment stays in staff review. Returns whether a
-- correction was appended.
CREATE FUNCTION hon.record_crm_guardian_child_identity_correction(p_person uuid,p_org uuid,p_school uuid,p_actor uuid,p_request uuid,
  p_given text,p_family text,p_birth date)
RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE e hon.crm_guardian_child_enrolled_children%ROWTYPE; held record; v_given text; v_family text; v_birth date; n integer;
BEGIN
  IF p_given IS NULL AND p_family IS NULL AND p_birth IS NULL THEN RETURN false; END IF;
  SELECT * INTO e FROM hon.crm_guardian_child_enrolled_children x WHERE x.child_person_id=p_person AND x.organization_id=p_org AND x.school_id=p_school;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO held FROM hon.crm_guardian_child_current_identity(e.student_profile_id,p_org,p_school);
  v_given:=coalesce(p_given,held.given_name); v_family:=coalesce(p_family,held.family_name); v_birth:=coalesce(p_birth,held.birth_date);
  IF v_given=held.given_name AND v_family=held.family_name AND v_birth=held.birth_date THEN RETURN false; END IF;
  -- A corrected name keeps the 0176 rules (refused as invalid input rather than a generic constraint error).
  IF v_birth<date '1900-01-01'
    OR length(v_given) NOT BETWEEN 1 AND 100 OR v_given ~ '[[:cntrl:]<>]' OR regexp_replace(v_given,'[^[:alnum:]]','','g')=''
    OR length(v_family) NOT BETWEEN 1 AND 100 OR v_family ~ '[[:cntrl:]<>]' OR regexp_replace(v_family,'[^[:alnum:]]','','g')='' THEN
    RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT coalesce(max(c.version),0)+1 INTO n FROM hon.crm_guardian_child_identity_corrections c WHERE c.student_profile_id=e.student_profile_id;
  INSERT INTO hon.crm_guardian_child_identity_corrections(organization_id,school_id,student_profile_id,version,given_name,family_name,birth_date,
      prior_given_name,prior_family_name,prior_birth_date,actor_principal_id,request_id)
    VALUES(p_org,p_school,e.student_profile_id,n,v_given,v_family,v_birth,
      held.given_name,held.family_name,held.birth_date,p_actor,p_request);
  RETURN true;
END $$;

-- 0176 relation, unchanged except that names and birth date are compared with the identity the child is held to
-- (latest correction, else snapshot), and the display name follows it.
CREATE OR REPLACE FUNCTION hon.crm_guardian_child_child_relation(selected_student uuid)
RETURNS TABLE(student_profile_id uuid,child_person_id uuid,child_member_id uuid,family_id uuid,lead_id uuid,conversion_id uuid,
  display_name text,origin text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); e hon.crm_guardian_child_enrolled_children%ROWTYPE; held record;
BEGIN
  IF selected_student IS NULL OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO e FROM hon.crm_guardian_child_enrolled_children x WHERE x.student_profile_id=selected_student AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO held FROM hon.crm_guardian_child_current_identity(e.student_profile_id,org,school);
  IF NOT EXISTS(SELECT 1 FROM hon.student_profiles s WHERE s.id=e.student_profile_id AND s.organization_id=org AND s.school_id=school AND s.status='ACTIVE'
      AND s.person_id=e.child_person_id AND s.primary_family_id=e.family_id AND s.birth_date=held.birth_date)
    OR NOT EXISTS(SELECT 1 FROM hon.people p WHERE p.id=e.child_person_id AND p.organization_id=org AND p.school_id=school
      AND p.given_name=held.given_name AND p.family_name=held.family_name)
    OR NOT EXISTS(SELECT 1 FROM hon.family_members m WHERE m.id=e.child_member_id AND m.organization_id=org AND m.school_id=school
      AND m.family_id=e.family_id AND m.person_id=e.child_person_id AND m.member_role='STUDENT' AND NOT m.is_billing_contact)
    OR (SELECT count(*) FROM hon.family_members m WHERE m.organization_id=org AND m.school_id=school AND m.person_id=e.child_person_id)<>1 THEN
    RAISE EXCEPTION 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN QUERY SELECT e.student_profile_id,e.child_person_id,e.child_member_id,e.family_id,e.source_lead_id,e.conversion_id,
    btrim(concat_ws(' ',held.given_name,held.family_name)),e.origin;
END $$;


-- The family read is 0176's body with one change: a child's displayName is the held (latest corrected, else
-- snapshot) identity, so a governed name correction shows on the enrollment it carried into. No other change.
CREATE OR REPLACE FUNCTION hon.read_crm_guardian_child_enrollment(subject text,selected_lead uuid) RETURNS jsonb
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
          'displayName',(SELECT btrim(concat_ws(' ',i.given_name,i.family_name)) FROM hon.crm_guardian_child_current_identity(enrolled.student_profile_id,org,school) i),'origin',enrolled.origin,'workflowState',child_state)
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
-- A live system OWNER grant at this exact school, by the clock.
CREATE FUNCTION hon.school_person_is_owner(p_actor uuid,p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
    JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id
    WHERE g.principal_id=p_actor AND g.school_id=p_school AND r.code='OWNER' AND r.is_system_role AND g.revoked_at IS NULL
      AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
$$;

-- Read shape: the student object now carries its own version (the birth date command's expectedVersion).
CREATE OR REPLACE FUNCTION hon.school_person_json(p_person uuid,p_subject text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('personId',x.id,'schoolId',x.school_id,'givenName',x.given_name,'familyName',x.family_name,
    'email',x.email::text,'phoneE164',x.phone_e164,'version',x.version,'updatedAt',hon.saas_ts(x.updated_at),
    'student',(SELECT jsonb_build_object('birthDate',to_char(sp.birth_date,'YYYY-MM-DD'),'status',sp.status::text,'version',sp.version)
      FROM hon.student_profiles sp WHERE sp.person_id=x.id AND sp.organization_id=x.organization_id AND sp.school_id=x.school_id),
    'consents',jsonb_build_object(
      'EMAIL',coalesce((SELECT c.status::text FROM hon.communication_consents c WHERE c.person_id=x.id AND c.channel='EMAIL'),'NOT_RECORDED'),
      'SMS',coalesce((SELECT c.status::text FROM hon.communication_consents c WHERE c.person_id=x.id AND c.channel='SMS'),'NOT_RECORDED')),
    'canEdit',hon.school_person_actor(p_subject,x.school_id,true) IS NOT NULL)
  FROM hon.people x WHERE x.id=p_person
$$;

-- 0217 command, unchanged except:
--  * after a name change, carry exactly the changed name fields into an enrolled CRM child's enrollment (audited);
--  * exact-key receipts live in hon.school_person_command_receipts (Manus P2-165-3) and are checked first (P2-165-4).
--    A genuine completed 0217 receipt under hon.idempotency_records 'people.update:<key>' (identified by its
--    person-edit result shape) still replays exactly as saved for the same request and refuses any other request
--    (Manus P2-165-2, P2-165-5); a row there without that provenance is another command's key and is ignored.
CREATE OR REPLACE FUNCTION hon.update_school_person(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_school uuid; v_org uuid; v_person uuid; v_version integer; fp text; prior hon.idempotency_records%ROWTYPE;
  rec hon.school_person_command_receipts%ROWTYPE; cur hon.people%ROWTYPE; nxt hon.people%ROWTYPE; v_given text; v_family text; v_email text; v_phone text;
  changed text[]:=ARRAY[]::text[]; v_consent text; before jsonb; result jsonb; v_request uuid:=gen_random_uuid(); corrected boolean:=false;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF p_subject IS NULL OR p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['email','expectedVersion','familyName','givenName','personId','phoneE164','schoolId']
    OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string' OR p_input->>'schoolId' !~ uuid_re
    OR jsonb_typeof(p_input->'personId') IS DISTINCT FROM 'string' OR p_input->>'personId' !~ uuid_re
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'givenName') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'familyName') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'email') NOT IN ('string','null') OR jsonb_typeof(p_input->'phoneE164') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  v_given:=btrim(p_input->>'givenName'); v_family:=btrim(p_input->>'familyName');
  v_email:=lower(btrim(p_input->>'email')); v_phone:=p_input->>'phoneE164';
  IF length(v_given) NOT BETWEEN 1 AND 120 OR length(v_family) NOT BETWEEN 1 AND 120
    OR v_given ~ '[[:cntrl:]]' OR v_family ~ '[[:cntrl:]]'
    OR (v_email IS NOT NULL AND (length(v_email) NOT BETWEEN 3 AND 320 OR v_email !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'))
    OR (v_phone IS NOT NULL AND v_phone !~ '^\+[1-9][0-9]{1,14}$') THEN
    RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid; v_person:=(p_input->>'personId')::uuid; v_version:=(p_input->>'expectedVersion')::integer;

  actor:=hon.school_person_actor(p_subject,v_school,true);
  IF actor IS NULL THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- Same table order as the CRM registration/DRAFT flows (0160-0176 lock hon.people before hon.idempotency_records in
  -- SHARE ROW EXCLUSIVE): take the people write lock first. The receipt reservation that follows is in this command's
  -- own table, which no other command touches.
  LOCK TABLE hon.people IN ROW EXCLUSIVE MODE;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=v_school;
  fp:=encode(sha256(convert_to('PERSON_UPDATE:'||jsonb_build_object('schoolId',v_school,'personId',v_person,'expectedVersion',v_version,
    'givenName',v_given,'familyName',v_family,'email',v_email,'phoneE164',v_phone)::text,'UTF8')),'hex');
  -- Own receipt first (Manus P2-165-4): an existing receipt for this key in this command's table always decides.
  INSERT INTO hon.school_person_command_receipts(organization_id,school_id,principal_id,command,idempotency_key,request_fingerprint)
    VALUES(v_org,v_school,actor,'people.update',p_key,fp)
    ON CONFLICT (organization_id,school_id,principal_id,command,idempotency_key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO rec FROM hon.school_person_command_receipts WHERE organization_id=v_org AND school_id=v_school AND principal_id=actor
      AND command='people.update' AND idempotency_key=p_key FOR UPDATE;
    IF rec.request_fingerprint<>fp THEN RAISE EXCEPTION 'PERSON_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    IF rec.status<>'COMPLETED' THEN RAISE EXCEPTION 'PERSON_BUSY' USING ERRCODE='55P03'; END IF;
    IF hon.school_person_actor(p_subject,v_school,true) IS NULL THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN rec.response_body;
  END IF;
  -- Newly reserved. A row under the old 0217 key text 'people.update:<key>' is a genuine 0217 person-edit receipt
  -- only by its provenance (Manus P2-165-5): COMPLETED, HTTP 200 and a response that is exactly a person-edit result
  -- ({person, changedFields}, which only this command ever builds; activation and every other command store their
  -- own server-built shapes). A genuine receipt has consumed the key: the exact request replays its saved body (and
  -- completes this reservation with it, so later retries read it first); any other request is a key reuse and is
  -- refused before any version or change check, as 0217 did. A row without that provenance is another command's
  -- free-text key and is ignored (Manus P2-165-4). Plain read of committed rows: never waits on another transaction.
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=v_org AND school_id=v_school AND principal_id=actor
    AND idempotency_key='people.update:'||p_key::text;
  IF FOUND AND prior.status='COMPLETED' AND prior.response_status=200 AND jsonb_typeof(prior.response_body)='object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(prior.response_body) k)=ARRAY['changedFields','person']
    AND jsonb_typeof(prior.response_body->'person')='object' AND jsonb_typeof(prior.response_body->'changedFields')='array' THEN
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'PERSON_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    UPDATE hon.school_person_command_receipts SET status='COMPLETED',response_body=prior.response_body,completed_at=clock_timestamp()
      WHERE organization_id=v_org AND school_id=v_school AND principal_id=actor AND command='people.update' AND idempotency_key=p_key;
    IF hon.school_person_actor(p_subject,v_school,true) IS NULL THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN prior.response_body;
  END IF;

  -- Exact school only. NO KEY UPDATE: does not block family/student/consent inserts that hold KEY SHARE on the person.
  SELECT * INTO cur FROM hon.people WHERE id=v_person AND organization_id=v_org AND school_id=v_school FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERSON_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF cur.version<>v_version THEN RAISE EXCEPTION 'PERSON_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF cur.given_name IS DISTINCT FROM v_given THEN changed:=array_append(changed,'givenName'); END IF;
  IF cur.family_name IS DISTINCT FROM v_family THEN changed:=array_append(changed,'familyName'); END IF;
  IF lower(cur.email::text) IS DISTINCT FROM v_email THEN changed:=array_append(changed,'email'); END IF;
  IF cur.phone_e164 IS DISTINCT FROM v_phone THEN changed:=array_append(changed,'phoneE164'); END IF;
  IF cardinality(changed)=0 THEN RAISE EXCEPTION 'PERSON_UNCHANGED' USING ERRCODE='22023'; END IF;
  -- Consent records a channel, not an address: never carry an opt-in to a new or cleared address. Serialize with the
  -- canonical consent writer (communication-consent.service.ts): the same per person/channel transaction advisory
  -- lock, taken for each affected channel in a fixed order (EMAIL, then SMS) and held to commit, then the channel's consent row
  -- read FOR SHARE whatever its status. A consent capture that is in flight for the old address finishes first and is then seen; a
  -- first-time insert cannot slip past because the advisory lock, not a row lock, is the serialization point.
  -- The consent writer never waits on the person row (its FK check takes KEY SHARE, which NO KEY UPDATE allows),
  -- so person row -> advisory cannot invert.
  IF 'email'=ANY(changed) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_person::text||':'||'EMAIL',0));
    SELECT status::text INTO v_consent FROM hon.communication_consents WHERE person_id=v_person AND channel='EMAIL' FOR SHARE;
    IF v_consent='OPTED_IN' THEN
      RAISE EXCEPTION 'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;
  IF 'phoneE164'=ANY(changed) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_person::text||':'||'SMS',0));
    SELECT status::text INTO v_consent FROM hon.communication_consents WHERE person_id=v_person AND channel='SMS' FOR SHARE;
    IF v_consent='OPTED_IN' THEN
      RAISE EXCEPTION 'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;

  before:=jsonb_build_object('givenName',cur.given_name,'familyName',cur.family_name,'email',cur.email::text,'phoneE164',cur.phone_e164,'version',cur.version);
  -- A case-only email difference is not a change (citext); keep the stored spelling then.
  UPDATE hon.people SET given_name=v_given,family_name=v_family,email=CASE WHEN 'email'=ANY(changed) THEN v_email ELSE cur.email END,phone_e164=v_phone,version=cur.version+1,updated_at=clock_timestamp()
    WHERE id=v_person RETURNING * INTO nxt;
  IF 'givenName'=ANY(changed) OR 'familyName'=ANY(changed) THEN
    corrected:=hon.record_crm_guardian_child_identity_correction(v_person,v_org,v_school,actor,v_request,
      CASE WHEN 'givenName'=ANY(changed) THEN nxt.given_name END,CASE WHEN 'familyName'=ANY(changed) THEN nxt.family_name END,NULL);
  END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,occurred_at)
    VALUES(v_org,v_school,actor,'HUMAN_UI','people.update','PERSON',v_person,before,
      jsonb_build_object('givenName',nxt.given_name,'familyName',nxt.family_name,'email',nxt.email::text,'phoneE164',nxt.phone_e164,'version',nxt.version,
        'changedFields',to_jsonb(changed),'enrollmentCorrected',corrected),
      'SUCCEEDED',v_request,v_request,clock_timestamp());
  -- Outbox carries ids, version and field names only: never a contact value.
  INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(gen_random_uuid(),v_org,v_school,'people.person.updated',1,'PERSON',v_person,nxt.version,v_request,v_request,
      jsonb_build_object('personId',v_person,'version',nxt.version,'changedFields',to_jsonb(changed)));
  result:=jsonb_build_object('person',hon.school_person_json(v_person,p_subject),'changedFields',to_jsonb(changed));
  UPDATE hon.school_person_command_receipts SET status='COMPLETED',response_body=result,completed_at=clock_timestamp()
    WHERE organization_id=v_org AND school_id=v_school AND principal_id=actor AND command='people.update' AND idempotency_key=p_key;
  -- Decide authority after the last write: a grant revoked or expired, or paid access ended, while this command
  -- waited on a lock commits nothing.
  IF hon.school_person_actor(p_subject,v_school,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Input: exactly schoolId, personId, expectedVersion (the student profile's version), birthDate (YYYY-MM-DD), reason.
-- Order: authority -> people then student_profiles write locks (CRM/activation order) -> receipt reservation (own table) ->
-- student row lock -> version -> unchanged -> date range -> minor-to-adult owner rule -> update -> enrollment correction ->
-- audit -> outbox -> completion -> authority (and the owner rule) decided again.
CREATE FUNCTION hon.update_school_student_birth_date(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_school uuid; v_org uuid; v_person uuid; v_version integer; v_birth date; v_reason text; fp text;
  rec hon.school_person_command_receipts%ROWTYPE; sp hon.student_profiles%ROWTYPE; today date; tz text; crossing boolean:=false;
  corrected boolean; result jsonb; v_request uuid:=gen_random_uuid(); nxt_version integer;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF p_subject IS NULL OR p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['birthDate','expectedVersion','personId','reason','schoolId']
    OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string' OR p_input->>'schoolId' !~ uuid_re
    OR jsonb_typeof(p_input->'personId') IS DISTINCT FROM 'string' OR p_input->>'personId' !~ uuid_re
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'birthDate') IS DISTINCT FROM 'string' OR p_input->>'birthDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  BEGIN v_birth:=(p_input->>'birthDate')::date; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END;
  v_reason:=btrim(p_input->>'reason');
  IF to_char(v_birth,'YYYY-MM-DD')<>p_input->>'birthDate' OR v_birth<date '1900-01-01'
    OR length(v_reason) NOT BETWEEN 1 AND 300 OR v_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid; v_person:=(p_input->>'personId')::uuid; v_version:=(p_input->>'expectedVersion')::integer;

  actor:=hon.school_person_actor(p_subject,v_school,true);
  IF actor IS NULL THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- people then student_profiles first: the CRM flows (0160-0176) and activation (0177) take these two in this order
  -- before any later table. The receipt is reserved in this command's own table, never in hon.idempotency_records, so
  -- an activation holding a reservation there can never make this command wait while it holds these locks.
  LOCK TABLE hon.people IN ROW EXCLUSIVE MODE;
  LOCK TABLE hon.student_profiles IN ROW EXCLUSIVE MODE;
  SELECT organization_id,timezone INTO v_org,tz FROM hon.schools WHERE id=v_school;
  fp:=encode(sha256(convert_to('STUDENT_BIRTH_DATE_UPDATE:'||jsonb_build_object('schoolId',v_school,'personId',v_person,'expectedVersion',v_version,
    'birthDate',to_char(v_birth,'YYYY-MM-DD'),'reason',v_reason)::text,'UTF8')),'hex');
  INSERT INTO hon.school_person_command_receipts(organization_id,school_id,principal_id,command,idempotency_key,request_fingerprint)
    VALUES(v_org,v_school,actor,'people.birth_date',p_key,fp)
    ON CONFLICT (organization_id,school_id,principal_id,command,idempotency_key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO rec FROM hon.school_person_command_receipts WHERE organization_id=v_org AND school_id=v_school AND principal_id=actor
      AND command='people.birth_date' AND idempotency_key=p_key FOR UPDATE;
    IF rec.request_fingerprint<>fp THEN RAISE EXCEPTION 'PERSON_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    IF rec.status<>'COMPLETED' THEN RAISE EXCEPTION 'PERSON_BUSY' USING ERRCODE='55P03'; END IF;
    IF hon.school_person_actor(p_subject,v_school,true) IS NULL THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN rec.response_body;
  END IF;

  -- Exact school; a person without a student profile here is unavailable for this command.
  SELECT s.* INTO sp FROM hon.student_profiles s JOIN hon.people p ON p.id=s.person_id AND p.organization_id=s.organization_id AND p.school_id=s.school_id
    WHERE s.person_id=v_person AND s.organization_id=v_org AND s.school_id=v_school FOR NO KEY UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERSON_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF sp.version<>v_version THEN RAISE EXCEPTION 'PERSON_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF sp.birth_date IS NOT DISTINCT FROM v_birth THEN RAISE EXCEPTION 'PERSON_UNCHANGED' USING ERRCODE='22023'; END IF;
  today:=(clock_timestamp() AT TIME ZONE tz)::date;
  IF v_birth>today THEN RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  -- A known minor becoming an adult removes the guardian-of-record requirement (0177 D3): only a school OWNER.
  crossing:=sp.birth_date IS NOT NULL AND (sp.birth_date+interval '18 years')::date>today AND (v_birth+interval '18 years')::date<=today;
  IF crossing AND NOT hon.school_person_is_owner(actor,v_school) THEN
    RAISE EXCEPTION 'PERSON_BIRTH_DATE_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;

  UPDATE hon.student_profiles SET birth_date=v_birth,version=sp.version+1,updated_at=clock_timestamp() WHERE id=sp.id
    RETURNING version INTO nxt_version;
  corrected:=hon.record_crm_guardian_child_identity_correction(v_person,v_org,v_school,actor,v_request,NULL,NULL,v_birth);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,occurred_at)
    VALUES(v_org,v_school,actor,'HUMAN_UI','people.student.birth_date.update','STUDENT_PROFILE',sp.id,
      jsonb_build_object('personId',v_person,'birthDate',to_char(sp.birth_date,'YYYY-MM-DD'),'version',sp.version),
      jsonb_build_object('personId',v_person,'birthDate',to_char(v_birth,'YYYY-MM-DD'),'version',nxt_version,'reason',v_reason,
        'minorToAdult',crossing,'enrollmentCorrected',corrected),
      'SUCCEEDED',v_request,v_request,clock_timestamp());
  -- Outbox carries ids, version and the field name only: never the birth date.
  INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(gen_random_uuid(),v_org,v_school,'people.student.updated',1,'STUDENT_PROFILE',sp.id,nxt_version,v_request,v_request,
      jsonb_build_object('personId',v_person,'studentProfileId',sp.id,'version',nxt_version,'changedFields',jsonb_build_array('birthDate')));
  result:=jsonb_build_object('person',hon.school_person_json(v_person,p_subject),'changedFields',jsonb_build_array('birthDate'),'enrollmentCorrected',corrected);
  UPDATE hon.school_person_command_receipts SET status='COMPLETED',response_body=result,completed_at=clock_timestamp()
    WHERE organization_id=v_org AND school_id=v_school AND principal_id=actor AND command='people.birth_date' AND idempotency_key=p_key;
  -- Decide authority (and the owner rule) after the last write.
  IF hon.school_person_actor(p_subject,v_school,true) IS DISTINCT FROM actor
    OR (crossing AND NOT hon.school_person_is_owner(actor,v_school)) THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Deny first, then exactly the entry points for the runtime role (0217's two plus the birth date command).
DO $$ DECLARE f regprocedure; r text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.crm_guardian_child_current_identity(uuid,uuid,uuid)','hon.record_crm_guardian_child_identity_correction(uuid,uuid,uuid,uuid,uuid,text,text,date)',
    'hon.guard_school_person_command_receipt()',
    'hon.school_person_is_owner(uuid,uuid)','hon.update_school_student_birth_date(text,jsonb,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.update_school_student_birth_date(text,jsonb,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
