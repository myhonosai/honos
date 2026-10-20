BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'CRM lead registration recovery requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'CRM lead registration recovery requires a restricted runtime';
  END IF;
END $$;

-- Private, read-only, actor-independent "is this source-bound DRAFT exactly current"
-- check. It mirrors the 0163 conditions except the creator filter, returns only
-- true/false and is never granted to the runtime. Callers must already hold the
-- 0163 SHARE lock set and have verified their own authority. 0163 is unchanged
-- and remains the only creator-owned confirmation.
CREATE FUNCTION hon.crm_adult_membership_draft_is_current(selected_student uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
  org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
  relation record; final_relation record; source hon.crm_adult_membership_draft_sources%ROWTYPE;
  start_at timestamptz; end_at timestamptz; field text; value text; instant timestamptz;
BEGIN
  IF selected_student IS NULL OR org IS NULL OR school IS NULL THEN RETURN false; END IF;
  BEGIN
    SELECT * INTO relation FROM hon.crm_adult_membership_relation(selected_student);
  EXCEPTION WHEN SQLSTATE 'P0002' THEN RETURN false;
  END;
  SELECT * INTO source FROM hon.crm_adult_membership_draft_sources x
    WHERE x.conversion_id=relation.conversion_id AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND OR jsonb_typeof(source.receipt) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(source.receipt) k)
      IS DISTINCT FROM ARRAY['membershipId','planCode','recordedAt','state','termEndsAt','termStartedAt']
    OR source.receipt->>'membershipId' IS DISTINCT FROM source.membership_id::text
    OR source.receipt->>'state' IS DISTINCT FROM 'DRAFT'
    OR jsonb_typeof(source.receipt->'planCode') IS DISTINCT FROM 'string'
    OR source.receipt->>'recordedAt' IS DISTINCT FROM to_char(source.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RETURN false;
  END IF;
  FOREACH field IN ARRAY ARRAY['termStartedAt','termEndsAt'] LOOP
    IF jsonb_typeof(source.receipt->field)='null' THEN instant:=NULL;
    ELSIF jsonb_typeof(source.receipt->field)='string' THEN
      value:=source.receipt->>field;
      IF length(value)<>24 OR value !~ '^(19|[2-9][0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN false; END IF;
      BEGIN instant:=value::timestamptz; EXCEPTION WHEN OTHERS THEN RETURN false; END;
      IF to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>value THEN RETURN false; END IF;
    ELSE RETURN false; END IF;
    IF field='termStartedAt' THEN start_at:=instant; ELSE end_at:=instant; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.memberships m
      WHERE m.id=source.membership_id AND m.organization_id=org AND m.school_id=school
        AND m.state='DRAFT' AND m.version=1 AND m.billing_account_id=relation.account_id AND m.participant_person_id=relation.person_id
        AND m.plan_code=source.receipt->>'planCode' AND m.term_started_at IS NOT DISTINCT FROM start_at AND m.term_ends_at IS NOT DISTINCT FROM end_at)
    OR EXISTS(SELECT 1 FROM hon.membership_payment_schedules x WHERE x.membership_id=source.membership_id)
    OR EXISTS(SELECT 1 FROM hon.invoices x WHERE x.membership_id=source.membership_id)
    OR (SELECT count(*) FROM hon.memberships x WHERE x.organization_id=org AND x.school_id=school AND x.participant_person_id=relation.person_id)<>1 THEN
    RETURN false;
  END IF;
  BEGIN
    SELECT * INTO final_relation FROM hon.crm_adult_membership_relation(selected_student);
  EXCEPTION WHEN SQLSTATE 'P0002' THEN RETURN false;
  END;
  RETURN final_relation IS NOT DISTINCT FROM relation;
END $$;

-- Read-only recovery of the connected adult CRM workflow after navigation,
-- refresh or session loss. The only selector is one lead id, scoped to the
-- verified current school; every other fact is re-derived here from the
-- immutable conversion (0160), the adult relation (0162), the creator-owned
-- current-DRAFT confirmation (0163) and, for another staff member's DRAFT, the
-- private yes/no check above. The stored registration response is returned only
-- as a historical receipt; a DRAFT is reported only from a current observation. No DML: no audit, outbox, idempotency or record.
CREATE FUNCTION hon.read_crm_lead_registration_recovery(subject text,selected_lead uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
  org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
  lead hon.crm_leads%ROWTYPE; c hon.crm_lead_registration_conversions%ROWTYPE; s hon.student_profiles%ROWTYPE;
  relation record; accounts integer; current_draft jsonb; state text; result jsonb;
BEGIN
  IF selected_lead IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  -- Registration authority (crm.lead.read, crm.lead.register, student.profile.manage) and
  -- adult DRAFT authority (billing.membership.create) for the same direct human, school and entitlement.
  actor:=hon.require_crm_lead_registration_actor(subject,'ADULT');
  IF hon.require_crm_adult_membership_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_LEAD_REGISTRATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- Canonical order (0169): IAM, then domain tables people-first, all SHARE, as the 0163 confirmation.
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements,hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts,hon.memberships,hon.crm_adult_membership_draft_sources,hon.membership_payment_schedules,hon.invoices IN SHARE MODE;
  actor:=hon.require_crm_lead_registration_actor(subject,'ADULT');
  IF hon.require_crm_adult_membership_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_LEAD_REGISTRATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO lead FROM hon.crm_leads l WHERE l.id=selected_lead AND l.organization_id=org AND l.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_LEAD_REGISTRATION_RECOVERY_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO c FROM hon.crm_lead_registration_conversions x WHERE x.source_lead_id=lead.id AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN
    -- Mirrors the registration command's non-writing ambiguity outcome; no match is disclosed.
    state:=CASE WHEN EXISTS(SELECT 1 FROM hon.student_profiles x WHERE x.organization_id=org AND x.school_id=school AND x.person_id=lead.primary_person_id)
      OR EXISTS(SELECT 1 FROM hon.family_members x WHERE x.organization_id=org AND x.school_id=school AND x.person_id=lead.primary_person_id)
      THEN 'NEEDS_STAFF_REVIEW' ELSE 'NOT_REGISTERED' END;
    result:=jsonb_build_object('leadId',lead.id,'workflowState',state);
  ELSE
    SELECT * INTO s FROM hon.student_profiles x WHERE x.id=c.resulting_student_profile_id AND x.organization_id=org AND x.school_id=school;
    -- Guardian/child, malformed, drifted or ambiguous conversions are a staff-review outcome only.
    IF c.registration_path IS DISTINCT FROM 'ADULT' OR c.family_id IS NOT NULL
      OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(c.response) k)
        IS DISTINCT FROM ARRAY['familyId','leadId','outcome','recordedAt','registrationPath','sourceContactPersonId','studentProfileId']
      OR c.response->>'outcome' IS DISTINCT FROM 'REGISTERED' OR c.response->>'registrationPath' IS DISTINCT FROM 'ADULT'
      OR c.response->>'leadId' IS DISTINCT FROM c.source_lead_id::text
      OR c.response->>'sourceContactPersonId' IS DISTINCT FROM c.original_contact_person_id::text
      OR c.response->>'studentProfileId' IS DISTINCT FROM c.resulting_student_profile_id::text
      OR c.response->'familyId' IS DISTINCT FROM 'null'::jsonb
      OR c.response->>'recordedAt' IS DISTINCT FROM to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR lead.primary_person_id IS DISTINCT FROM c.original_contact_person_id
      OR s.id IS NULL OR s.status<>'ACTIVE' OR s.person_id<>c.original_contact_person_id OR s.primary_family_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM hon.family_members x WHERE x.organization_id=org AND x.school_id=school AND x.person_id=c.original_contact_person_id)
      OR (SELECT count(*) FROM hon.student_profiles x WHERE x.organization_id=org AND x.school_id=school AND x.person_id=c.original_contact_person_id)<>1
      OR (SELECT count(*) FROM hon.crm_lead_registration_conversions x WHERE x.organization_id=org AND x.school_id=school AND x.resulting_student_profile_id=c.resulting_student_profile_id)<>1 THEN
      state:='NEEDS_STAFF_REVIEW';
    ELSE
      SELECT count(*) INTO accounts FROM hon.billing_accounts a WHERE a.organization_id=org AND a.school_id=school AND a.responsible_person_id=c.original_contact_person_id;
      IF accounts=0 THEN
        state:=CASE WHEN EXISTS(SELECT 1 FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=c.id)
          OR EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=c.original_contact_person_id)
          THEN 'NEEDS_STAFF_REVIEW' ELSE 'BILLING_ACCOUNT_REQUIRED' END;
      ELSIF accounts<>1 THEN state:='NEEDS_STAFF_REVIEW';
      ELSE
        BEGIN
          SELECT * INTO relation FROM hon.crm_adult_membership_relation(c.resulting_student_profile_id);
        EXCEPTION WHEN SQLSTATE 'P0002' THEN state:='NEEDS_STAFF_REVIEW';
        END;
        IF state IS NULL AND NOT EXISTS(SELECT 1 FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=c.id) THEN
          state:=CASE WHEN EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=c.original_contact_person_id)
            THEN 'NEEDS_STAFF_REVIEW' ELSE 'READY_FOR_DRAFT' END;
        ELSIF state IS NULL AND EXISTS(SELECT 1 FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=c.id AND x.actor_principal_id=actor) THEN
          -- Creator: the unchanged creator-owned 0163 confirmation; any drift or lifecycle change is unavailable.
          BEGIN
            current_draft:=hon.read_crm_adult_membership_draft_confirmation(subject,c.resulting_student_profile_id);
            state:='CURRENT_DRAFT';
          EXCEPTION WHEN SQLSTATE 'P0002' THEN state:='NEEDS_STAFF_REVIEW';
          END;
        ELSIF state IS NULL THEN
          -- Another staff member's DRAFT: a yes/no current-state check only. No receipt, membership id or creator.
          IF hon.crm_adult_membership_draft_is_current(c.resulting_student_profile_id) THEN
            current_draft:=jsonb_build_object('state','RECORDED_DRAFT');
            state:='CURRENT_DRAFT_BY_OTHER_STAFF';
          ELSE state:='NEEDS_STAFF_REVIEW';
          END IF;
        END IF;
      END IF;
    END IF;
    result:=jsonb_build_object('leadId',lead.id,'workflowState',state);
    IF state IN ('BILLING_ACCOUNT_REQUIRED','READY_FOR_DRAFT','CURRENT_DRAFT','CURRENT_DRAFT_BY_OTHER_STAFF') THEN
      result:=result || jsonb_build_object('historicalRegistrationReceipt',c.response);
    END IF;
    IF state IN ('READY_FOR_DRAFT','CURRENT_DRAFT','CURRENT_DRAFT_BY_OTHER_STAFF') THEN
      result:=result || jsonb_build_object('billingAccount',jsonb_build_object('classification','CANONICAL','currency',relation.currency));
    END IF;
    IF state IN ('CURRENT_DRAFT','CURRENT_DRAFT_BY_OTHER_STAFF') THEN result:=result || jsonb_build_object('currentMembershipDraft',current_draft); END IF;
  END IF;
  actor:=hon.require_crm_lead_registration_actor(subject,'ADULT');
  IF hon.require_crm_adult_membership_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_LEAD_REGISTRATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

COMMENT ON FUNCTION hon.read_crm_lead_registration_recovery(text,uuid) IS
'Direct HUMAN_UI read-only recovery of one current-school CRM lead''s adult registration workflow state. Returns a historical registration receipt; a current DRAFT via the creator-owned 0163 confirmation for its creator, or only a yes/no current state for other staff. Creates no record, audit, outbox, idempotency, billing, payment, activation, guardian/child, provider, AI or automation effect.';

REVOKE ALL ON FUNCTION hon.crm_adult_membership_draft_is_current(uuid),hon.read_crm_lead_registration_recovery(text,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.crm_adult_membership_draft_is_current(uuid),hon.read_crm_lead_registration_recovery(text,uuid) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_crm_lead_registration_recovery(text,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
