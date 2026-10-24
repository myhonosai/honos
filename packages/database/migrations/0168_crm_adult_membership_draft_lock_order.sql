BEGIN;

-- Additive lock-order correction for 0162's adult CRM membership DRAFT command.
-- 0162 took SHARE ROW EXCLUSIVE on billing_accounts/memberships before
-- idempotency_records, while the conventional billing-account and membership
-- commands hold ROW EXCLUSIVE on idempotency_records (their reservation insert)
-- before locking billing_accounts or inserting memberships. Opposite arrival
-- orders could therefore deadlock. The body below is 0162's verbatim except
-- that idempotency_records is locked first; the same tables are locked in the
-- same mode, and no authorization, uniqueness, receipt or effect changes.
-- CREATE OR REPLACE keeps the owner, SECURITY DEFINER posture and exact ACL.
-- 0162 itself is not rewritten.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Adult CRM membership draft lock-order migration requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.draft_crm_adult_membership(text,jsonb,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Adult CRM membership draft lock-order migration requires 0162';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.draft_crm_adult_membership(subject text,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
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
  -- idempotency_records is taken first: every conventional command (billing
  -- account create, membership create, ...) reserves its idempotency row before
  -- writing domain tables, so this order cannot form a wait cycle with them.
  LOCK TABLE hon.idempotency_records IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements,hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts,hon.memberships,hon.crm_adult_membership_draft_sources IN SHARE ROW EXCLUSIVE MODE;
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

COMMIT;
