BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Adult CRM membership draft confirmation requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Adult CRM membership draft confirmation requires a restricted runtime';
  END IF;
END $$;

-- This is an explicit current-state confirmation, not idempotency replay and not
-- a directory. It follows only the immutable adult conversion-to-membership
-- source link recorded by 0161 and returns nothing if that exact DRAFT drifted.
CREATE FUNCTION hon.read_crm_adult_membership_draft_confirmation(subject text,selected_student uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
  org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
  relation record; final_relation record; source hon.crm_adult_membership_draft_sources%ROWTYPE;
  membership hon.memberships%ROWTYPE; start_at timestamptz; end_at timestamptz;
  source_start text; source_end text; source_recorded text; recorded_at timestamptz;
BEGIN
  actor:=hon.require_crm_adult_membership_actor(subject);
  IF selected_student IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  -- Matching the DRAFT writer's authorization/relation lock set prevents a
  -- current confirmation from returning stale success after a concurrent change.
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements,hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts,hon.memberships,hon.crm_adult_membership_draft_sources,hon.membership_payment_schedules,hon.invoices IN SHARE MODE;
  actor:=hon.require_crm_adult_membership_actor(subject);
  SELECT * INTO relation FROM hon.crm_adult_membership_relation(selected_student);
  SELECT * INTO source FROM hon.crm_adult_membership_draft_sources x
    WHERE x.conversion_id=relation.conversion_id AND x.organization_id=org AND x.school_id=school AND x.actor_principal_id=actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF jsonb_typeof(source.receipt) IS DISTINCT FROM 'object'
    OR NOT source.receipt ?& ARRAY['membershipId','state','planCode','termStartedAt','termEndsAt','recordedAt']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(source.receipt) k WHERE k NOT IN ('membershipId','state','planCode','termStartedAt','termEndsAt','recordedAt')) THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002';
  END IF;
  IF jsonb_typeof(source.receipt->'membershipId') IS DISTINCT FROM 'string'
    OR source.receipt->>'membershipId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR source.receipt->>'membershipId' IS DISTINCT FROM source.membership_id::text
    OR source.receipt->>'state' IS DISTINCT FROM 'DRAFT'
    OR jsonb_typeof(source.receipt->'planCode') IS DISTINCT FROM 'string'
    OR length(source.receipt->>'planCode') NOT BETWEEN 1 AND 80
    OR btrim(source.receipt->>'planCode')<>source.receipt->>'planCode'
    OR source.receipt->>'planCode' ~ '[[:cntrl:]<>]' THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002';
  END IF;
  IF jsonb_typeof(source.receipt->'termStartedAt')='null' THEN start_at:=NULL;
  ELSIF jsonb_typeof(source.receipt->'termStartedAt')='string' THEN
    source_start:=source.receipt->>'termStartedAt';
    IF length(source_start)<>24 OR source_start !~ '^(19|[2-9][0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    BEGIN start_at:=source_start::timestamptz; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END;
    IF to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>source_start THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  ELSE RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF jsonb_typeof(source.receipt->'termEndsAt')='null' THEN end_at:=NULL;
  ELSIF jsonb_typeof(source.receipt->'termEndsAt')='string' THEN
    source_end:=source.receipt->>'termEndsAt';
    IF length(source_end)<>24 OR source_end !~ '^(19|[2-9][0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    BEGIN end_at:=source_end::timestamptz; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END;
    IF to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>source_end THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  ELSE RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF start_at IS NOT NULL AND end_at IS NOT NULL AND end_at<=start_at THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF jsonb_typeof(source.receipt->'recordedAt') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  source_recorded:=source.receipt->>'recordedAt';
  IF length(source_recorded)<>24 OR source_recorded !~ '^(19|[2-9][0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  BEGIN recorded_at:=source_recorded::timestamptz; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END;
  IF to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>source_recorded
    OR to_char(source.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>source_recorded THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO membership FROM hon.memberships m
    WHERE m.id=source.membership_id AND m.organization_id=org AND m.school_id=school
      AND m.state='DRAFT' AND m.version=1 AND m.billing_account_id=relation.account_id AND m.participant_person_id=relation.person_id
      AND m.plan_code=source.receipt->>'planCode' AND m.term_started_at IS NOT DISTINCT FROM start_at AND m.term_ends_at IS NOT DISTINCT FROM end_at
    FOR SHARE;
  IF NOT FOUND
    OR EXISTS(SELECT 1 FROM hon.membership_payment_schedules x WHERE x.membership_id=source.membership_id)
    OR EXISTS(SELECT 1 FROM hon.invoices x WHERE x.membership_id=source.membership_id)
    OR (SELECT count(*) FROM hon.memberships x WHERE x.organization_id=org AND x.school_id=school AND x.participant_person_id=relation.person_id)<>1 THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002';
  END IF;
  SELECT * INTO final_relation FROM hon.crm_adult_membership_relation(selected_student);
  IF final_relation IS DISTINCT FROM relation THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  PERFORM hon.require_crm_adult_membership_actor(subject);
  RETURN jsonb_build_object('state','RECORDED_DRAFT','receipt',jsonb_build_object(
    'membershipId',membership.id,'state','DRAFT','planCode',membership.plan_code,
    'termStartedAt',CASE WHEN membership.term_started_at IS NULL THEN NULL ELSE to_char(membership.term_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'termEndsAt',CASE WHEN membership.term_ends_at IS NULL THEN NULL ELSE to_char(membership.term_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'recordedAt',source_recorded));
END $$;

COMMENT ON FUNCTION hon.read_crm_adult_membership_draft_confirmation(text,uuid) IS
'Explicit direct-human creator-owned current DRAFT confirmation from one immutable adult CRM conversion source. It is read-only, source-bound, has no generic membership fallback, and never activates or creates billing/payment/provider/automation work.';

REVOKE ALL ON FUNCTION hon.read_crm_adult_membership_draft_confirmation(text,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_crm_adult_membership_draft_confirmation(text,uuid) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_crm_adult_membership_draft_confirmation(text,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
