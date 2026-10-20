BEGIN;

-- One canonical lock order for the Owner Launch, CRM registration, adult CRM
-- membership DRAFT, conventional billing-account/membership commands and their
-- confirmation reads (PR #41 lock-order audit; additive, no earlier migration is
-- rewritten). Every command in this family acquires, in this order:
--   1. its idempotency key (row-level IN_PROGRESS reservation) where it has one;
--   2. IAM/entitlement tables in SHARE mode only;
--   3. person/registration/CRM/billing domain tables in the fixed order
--      people, student_profiles, families, family_members, conversions, crm_leads,
--      enrollments, registration receipts, billing_accounts, memberships,
--      DRAFT sources, payment schedules, invoices;
--   4. append-only audit/outbox evidence last.
-- Three bodies deviated and could form wait cycles:
-- * draft_crm_adult_membership (0168) held SHARE ROW EXCLUSIVE on all of
--   idempotency_records and then on IAM tables; Owner Launch DRAFT holds IAM in
--   SHARE and then inserts its idempotency row (reported cycle). It also row-
--   locked billing account and membership rows after their table locks.
-- * register_crm_lead_person (0160) and the DRAFT took IAM tables in SHARE ROW
--   EXCLUSIVE in a different order than Owner Launch's SHARE locks.
-- * read_owner_launch_membership_draft (0139) took SHARE on audit_events and
--   registration receipts before people/student_profiles, while every writer
--   holds people/student_profiles and appends audit evidence last.
-- Bodies below are the previous ones verbatim except for those lock statements,
-- the DRAFT's reservation moving ahead of its table locks (replacing its later
-- insert) and the redundant row locks becoming plain reads. Authorization
-- checks, RLS, uniqueness, idempotency fingerprints and replay, receipts, audit,
-- outbox and rollback behaviour are unchanged. CREATE OR REPLACE keeps each
-- function's owner, SECURITY DEFINER posture and exact ACL.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Canonical lock-order migration requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.draft_crm_adult_membership(text,jsonb,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.register_crm_lead_person(text,uuid,jsonb,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.read_owner_launch_membership_draft(text)') IS NULL THEN
    RAISE EXCEPTION 'Canonical lock-order migration requires 0139, 0160 and 0168';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.register_crm_lead_person(subject text,selected_lead uuid,p jsonb,key uuid,request uuid,correlation uuid)
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
  -- Canonical order (0169): IAM/entitlement tables in SHARE (blocks grant and
  -- entitlement writers, never other readers), then CRM domain tables in
  -- SHARE ROW EXCLUSIVE in the fixed people-first order.
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  LOCK TABLE hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions IN SHARE ROW EXCLUSIVE MODE;
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

CREATE OR REPLACE FUNCTION hon.draft_crm_adult_membership(subject text,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; relation record; final_relation record;
  selected uuid; start_at timestamptz; end_at timestamptz; value text; field text; fp text;
  prior hon.idempotency_records%ROWTYPE; source hon.crm_adult_membership_draft_sources%ROWTYPE; membership hon.memberships%ROWTYPE;
  result_receipt jsonb; instant timestamptz; reserved boolean;
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
  -- Canonical lock order (0169), shared with every conventional command:
  -- 1. the idempotency key: a row-level IN_PROGRESS reservation (ROW EXCLUSIVE,
  --    like the billing-account and membership commands), never a table lock;
  -- 2. IAM/entitlement tables in SHARE: blocks grant/entitlement writers through
  --    commit but never another reader (Owner Launch and the confirmations take
  --    the same tables in SHARE);
  -- 3. CRM/billing domain tables in SHARE ROW EXCLUSIVE, people first, which
  --    serializes registration, account inserts, source reuse and memberships;
  -- 4. append-only evidence (audit, outbox) last.
  -- Rows are read without FOR UPDATE where the table lock already freezes them,
  -- so a row lock never waits behind a session the table lock is blocking.
  -- No client-selectable lock/function path; bounded service lock/statement timeout.
  fp:=encode(sha256(convert_to(jsonb_build_object('command','crm.adult.membership.draft','input',p || jsonb_build_object('studentProfileId',selected))::text,'UTF8')),'hex');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key::text,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  LOCK TABLE hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts,hon.memberships,hon.crm_adult_membership_draft_sources IN SHARE ROW EXCLUSIVE MODE;
  IF hon.require_crm_adult_membership_actor(subject) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO relation FROM hon.crm_adult_membership_relation(selected);
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    SELECT * INTO source FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id AND x.organization_id=org AND x.school_id=school;
    IF NOT FOUND OR source.actor_principal_id<>actor OR source.idempotency_key<>key OR source.request_fingerprint<>fp
      OR prior.status<>'COMPLETED' OR prior.response_body IS DISTINCT FROM source.receipt THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
    -- Stored receipt is historical DRAFT creation, not a claim of current state.
    PERFORM 1 FROM hon.memberships m WHERE m.id=source.membership_id AND m.organization_id=org AND m.school_id=school
      AND m.billing_account_id=relation.account_id AND m.participant_person_id=relation.person_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    PERFORM hon.require_crm_adult_membership_actor(subject);
    RETURN jsonb_build_object('receipt',source.receipt,'replayed',true);
  END IF;
  IF EXISTS(SELECT 1 FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id)
    OR EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=relation.person_id) THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
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

CREATE OR REPLACE FUNCTION hon.read_owner_launch_membership_draft(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
 actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
 creation hon.audit_events%ROWTYPE; relation record; current_draft record;
 relation_count integer; registration uuid; result jsonb;
 unavailable constant jsonb:='{"state":"DRAFT_UNAVAILABLE","receipt":null}'::jsonb;
BEGIN
 actor:=hon.lock_owner_launch_actor(p_subject);
 IF NOT hon.principal_has_school_permission(actor,org,school,'billing.membership.create')
 OR NOT hon.principal_has_school_permission(actor,org,school,'billing.account.create') THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 -- Prevent relation/evidence phantoms and concurrent drift for the duration of
 -- this bounded read. Same tables and mode as 0139, in the canonical order
 -- (0169): person/registration tables, then billing_accounts and memberships
 -- (the draft writer's order), then append-only audit evidence last, so a
 -- writer that already holds a domain lock can always append its audit row.
 LOCK TABLE hon.people,hon.student_profiles,hon.families,hon.family_members,hon.student_curriculum_enrollments,
 hon.student_registration_receipts,hon.guardian_child_registration_receipts,
 hon.billing_accounts,hon.memberships,hon.membership_payment_schedules,hon.invoices,hon.audit_events IN SHARE MODE;
 PERFORM hon.require_owner_launch_actor(p_subject);
 SELECT count(*)::integer INTO relation_count FROM hon.audit_events
 WHERE organization_id=org AND school_id=school AND actor_principal_id=actor
 AND next_state->>'operation'='OWNER_LAUNCH_MEMBERSHIP_DRAFT' AND entity_type='MEMBERSHIP';
 IF relation_count=0 THEN RETURN jsonb_build_object('state','NO_RECORDED_DRAFT','receipt',NULL); END IF;
 IF relation_count<>1 THEN RETURN unavailable; END IF;
 SELECT * INTO creation FROM hon.audit_events
 WHERE organization_id=org AND school_id=school AND actor_principal_id=actor
 AND next_state->>'operation'='OWNER_LAUNCH_MEMBERSHIP_DRAFT' AND entity_type='MEMBERSHIP';
 IF creation.action_code<>'billing.membership.create' OR creation.source<>'HUMAN_UI' OR creation.result<>'SUCCEEDED'
 OR creation.prior_state IS NOT NULL OR jsonb_typeof(creation.next_state) IS DISTINCT FROM 'object'
 OR creation.next_state->>'state' IS DISTINCT FROM 'DRAFT'
 OR creation.next_state->>'membershipId' IS DISTINCT FROM creation.entity_id::text
 OR jsonb_typeof(creation.next_state->'registrationId') IS DISTINCT FROM 'string'
 OR creation.next_state->>'registrationId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 THEN RETURN unavailable; END IF;
 registration:=(creation.next_state->>'registrationId')::uuid;
 -- Re-derive adult or explicit guardian/child payer and participant solely from
 -- this actor's immutable receipt and its current same-school composite links.
 WITH receipt_relations AS (
  SELECT r.id registration_id,sp.person_id payer,sp.person_id participant,false child
  FROM hon.student_registration_receipts r
  JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.organization_id=r.organization_id AND sp.school_id=r.school_id
  JOIN hon.people p ON p.id=sp.person_id AND p.organization_id=r.organization_id AND p.school_id=r.school_id
  JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=r.student_profile_id AND e.program_id=r.program_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
  WHERE r.id=registration AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
  UNION ALL
  SELECT r.id,r.guardian_person_id,r.child_person_id,true
  FROM hon.guardian_child_registration_receipts r
  JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.person_id=r.child_person_id AND sp.primary_family_id=r.family_id AND sp.organization_id=r.organization_id AND sp.school_id=r.school_id
  JOIN hon.people c ON c.id=r.child_person_id AND c.organization_id=r.organization_id AND c.school_id=r.school_id
  JOIN hon.people g ON g.id=r.guardian_person_id AND g.organization_id=r.organization_id AND g.school_id=r.school_id
  JOIN hon.families f ON f.id=r.family_id AND f.organization_id=r.organization_id AND f.school_id=r.school_id
  JOIN hon.family_members gm ON gm.id=r.guardian_member_id AND gm.family_id=r.family_id AND gm.person_id=r.guardian_person_id AND gm.member_role='GUARDIAN' AND gm.organization_id=r.organization_id AND gm.school_id=r.school_id
  JOIN hon.family_members cm ON cm.id=r.child_member_id AND cm.family_id=r.family_id AND cm.person_id=r.child_person_id AND cm.member_role='STUDENT' AND cm.organization_id=r.organization_id AND cm.school_id=r.school_id
  JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=r.student_profile_id AND e.program_id=r.program_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
  WHERE r.id=registration AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
 ), exact_relation AS (
  SELECT * FROM receipt_relations WHERE (SELECT count(*) FROM receipt_relations)=1
 ) SELECT * INTO relation FROM exact_relation;
 IF relation.registration_id IS NULL THEN RETURN unavailable; END IF;
 IF relation.child THEN PERFORM hon.require_owner_launch_family_actor(p_subject); END IF;
 -- Only the audit-bound canonical ID is examined. No account, person, plan,
 -- latest DRAFT or generic membership fallback can supply another record.
 SELECT m.id,m.version,m.plan_code,m.term_started_at,m.term_ends_at,m.created_at,a.currency::text currency
 INTO current_draft FROM hon.memberships m
 JOIN hon.billing_accounts a ON a.id=m.billing_account_id AND a.organization_id=org AND a.school_id=school AND a.responsible_person_id=relation.payer
 WHERE m.id=creation.entity_id AND m.organization_id=org AND m.school_id=school AND m.state='DRAFT'
 AND m.participant_person_id=relation.participant
 AND (SELECT count(*) FROM hon.billing_accounts x WHERE x.organization_id=org AND x.school_id=school AND x.responsible_person_id=relation.payer)=1
 AND to_jsonb(m.version)=creation.next_state->'membershipVersion'
 AND m.plan_code=creation.next_state->>'planCode' AND a.currency::text=creation.next_state->>'currency'
 AND to_char(m.term_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=creation.next_state->>'termStartedAt'
 AND to_char(m.term_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=creation.next_state->>'termEndsAt'
 AND to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=creation.next_state->>'recordedAt'
 AND NOT EXISTS(SELECT 1 FROM hon.membership_payment_schedules s WHERE s.membership_id=m.id)
 AND NOT EXISTS(SELECT 1 FROM hon.invoices i WHERE i.membership_id=m.id);
 IF current_draft.id IS NULL THEN RETURN unavailable; END IF;
 result:=jsonb_build_object('state','RECORDED_DRAFT','receipt',jsonb_build_object(
  'registrationId',registration,'membershipId',current_draft.id,'state','DRAFT','membershipVersion',current_draft.version,
  'planCode',current_draft.plan_code,'termStartedAt',to_char(current_draft.term_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'termEndsAt',to_char(current_draft.term_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'currency',current_draft.currency,
  'recordedAt',to_char(current_draft.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 PERFORM hon.require_owner_launch_actor(p_subject);
 IF relation.child THEN PERFORM hon.require_owner_launch_family_actor(p_subject); END IF;
 IF NOT hon.principal_has_school_permission(actor,org,school,'billing.membership.create')
 OR NOT hon.principal_has_school_permission(actor,org,school,'billing.account.create') THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN result;
END $$;

COMMIT;
