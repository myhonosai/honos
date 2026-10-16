BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Owner launch membership requires trusted migration owner'; END IF;
END $$;

-- Existing permissions/models only. Future HQ OWNER provisioning already selects
-- canonical permissions; bootstrap current system OWNER roles, never custom roles.
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
WHERE r.is_system_role AND r.code='OWNER' AND p.code IN('billing.account.create','billing.membership.create')
ON CONFLICT DO NOTHING;

CREATE FUNCTION hon.draft_owner_launch_membership(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
 actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); registration uuid;
 receipt record; account hon.billing_accounts%ROWTYPE; membership hon.memberships%ROWTYPE;
 account_count integer; previous_count integer; prior record; previous jsonb; result jsonb; payload jsonb;
 starts timestamptz; ends timestamptz; fp text; created_account boolean:=false; replay boolean:=false; field text;
BEGIN
 actor:=hon.lock_owner_launch_actor(p_subject);
 IF NOT hon.principal_has_school_permission(actor,org,school,'billing.membership.create')
 OR NOT hon.principal_has_school_permission(actor,org,school,'billing.account.create') THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
 OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
 OR (SELECT count(*) FROM jsonb_object_keys(p_input))<>6
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('registrationId','expectedReceiptVersion','planCode','termStartedAt','termEndsAt','currency'))
 OR jsonb_typeof(p_input->'registrationId') IS DISTINCT FROM 'string'
 OR p_input->>'registrationId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR jsonb_typeof(p_input->'expectedReceiptVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedReceiptVersion' !~ '^[1-9][0-9]{0,8}$'
 OR jsonb_typeof(p_input->'planCode') IS DISTINCT FROM 'string' OR length(p_input->>'planCode') NOT BETWEEN 1 AND 80
 OR btrim(p_input->>'planCode')<>p_input->>'planCode' OR p_input->>'planCode' ~ '[[:cntrl:]<>]'
 OR jsonb_typeof(p_input->'currency') IS DISTINCT FROM 'string' OR NOT (p_input->>'currency'=ANY(ARRAY['AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT','BGN','BHD','BIF','BMD','BND','BOB','BRL','BSD','BTN','BWP','BYN','BZD','CAD','CDF','CHF','CLP','CNY','COP','CRC','CUC','CUP','CVE','CZK','DJF','DKK','DOP','DZD','EGP','ERN','ETB','EUR','FJD','FKP','GBP','GEL','GHS','GIP','GMD','GNF','GTQ','GYD','HKD','HNL','HRK','HTG','HUF','IDR','ILS','INR','IQD','IRR','ISK','JMD','JOD','JPY','KES','KGS','KHR','KMF','KPW','KRW','KWD','KYD','KZT','LAK','LBP','LKR','LRD','LSL','LYD','MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR','MVR','MWK','MXN','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','OMR','PAB','PEN','PGK','PHP','PKR','PLN','PYG','QAR','RON','RSD','RUB','RWF','SAR','SBD','SCR','SDG','SEK','SGD','SHP','SLE','SLL','SOS','SRD','SSP','STN','SVC','SYP','SZL','THB','TJS','TMT','TND','TOP','TRY','TTD','TWD','TZS','UAH','UGX','USD','UYU','UZS','VES','VND','VUV','WST','XAF','XCD','XCG','XDR','XOF','XPF','XSU','YER','ZAR','ZMW','ZWG','ZWL'])) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF (p_input->>'expectedReceiptVersion')::integer<>1 THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_STALE' USING ERRCODE='40001'; END IF;
 FOREACH field IN ARRAY ARRAY['termStartedAt','termEndsAt'] LOOP
  IF jsonb_typeof(p_input->field) IS DISTINCT FROM 'string' OR p_input->>field !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?(Z|[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00))$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
 starts:=(p_input->>'termStartedAt')::timestamptz; ends:=(p_input->>'termEndsAt')::timestamptz;
 IF NOT isfinite(starts) OR NOT isfinite(ends) OR ends<=starts
 OR starts<timestamptz '0001-01-01 00:00:00+00' OR ends>=timestamptz '10000-01-01 00:00:00+00' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 registration:=(p_input->>'registrationId')::uuid;

 -- Immutable receipt is the sole selector. Share locks retain the current exact
 -- composite enrollment/profile/person relation throughout the command.
 SELECT r.id registration_id,sp.person_id payer,sp.person_id participant INTO receipt
 FROM hon.student_registration_receipts r
 JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.organization_id=r.organization_id AND sp.school_id=r.school_id
 JOIN hon.people person ON person.id=sp.person_id AND person.organization_id=r.organization_id AND person.school_id=r.school_id
 JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=r.student_profile_id AND e.program_id=r.program_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
 WHERE r.id=registration AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
 FOR SHARE OF r,sp,person,e;
 IF NOT FOUND THEN
  SELECT r.id registration_id,r.guardian_person_id payer,r.child_person_id participant INTO receipt
  FROM hon.guardian_child_registration_receipts r
  JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.person_id=r.child_person_id AND sp.primary_family_id=r.family_id AND sp.organization_id=r.organization_id AND sp.school_id=r.school_id
  JOIN hon.people child ON child.id=r.child_person_id AND child.organization_id=r.organization_id AND child.school_id=r.school_id
  JOIN hon.people guardian ON guardian.id=r.guardian_person_id AND guardian.organization_id=r.organization_id AND guardian.school_id=r.school_id
  JOIN hon.family_members gm ON gm.id=r.guardian_member_id AND gm.family_id=r.family_id AND gm.person_id=r.guardian_person_id AND gm.member_role='GUARDIAN' AND gm.organization_id=r.organization_id AND gm.school_id=r.school_id
  JOIN hon.family_members cm ON cm.id=r.child_member_id AND cm.family_id=r.family_id AND cm.person_id=r.child_person_id AND cm.member_role='STUDENT' AND cm.organization_id=r.organization_id AND cm.school_id=r.school_id
  JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=r.student_profile_id AND e.program_id=r.program_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
  WHERE r.id=registration AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
  FOR SHARE OF r,sp,child,guardian,gm,cm,e;
 END IF;
 IF receipt.registration_id IS NULL THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;

 -- Bounded manual setup: canonical table locks prevent account multiplicity
 -- phantoms and serialize generic billing inserts as well as owner requests.
 -- No advisory-only lock can protect against existing generic account writers.
 LOCK TABLE hon.billing_accounts,hon.memberships IN SHARE ROW EXCLUSIVE MODE;
 PERFORM hon.require_owner_launch_actor(p_subject);
 SELECT count(*)::integer INTO account_count FROM hon.billing_accounts WHERE organization_id=org AND school_id=school AND responsible_person_id=receipt.payer;
 IF account_count>1 THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
 SELECT * INTO account FROM hon.billing_accounts WHERE organization_id=org AND school_id=school AND responsible_person_id=receipt.payer FOR SHARE;
 IF account.id IS NOT NULL AND account.currency::text<>p_input->>'currency' THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_NEEDS_STAFF' USING ERRCODE='22023'; END IF;

 fp:=encode(sha256(convert_to(jsonb_build_object('operation','owner-launch-membership-draft','input',p_input)::text,'UTF8')),'hex');
 INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
 VALUES(org,school,actor,p_key,fp,'IN_PROGRESS',now()+interval '24 hours') ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING;
 SELECT request_fingerprint,status,response_body INTO prior FROM hon.idempotency_records
 WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
 IF prior.request_fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
 IF prior.status NOT IN('IN_PROGRESS','COMPLETED') THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='23505'; END IF;

 -- Reuse append-only canonical audit evidence as the receipt link, never a
 -- parallel membership table. New keys for this receipt cannot create a second
 -- membership or silently change the declared plan/term/currency.
 SELECT count(*)::integer INTO previous_count FROM hon.audit_events
 WHERE organization_id=org AND school_id=school AND actor_principal_id=actor AND action_code='billing.membership.create' AND entity_type='MEMBERSHIP'
 AND next_state->>'operation'='OWNER_LAUNCH_MEMBERSHIP_DRAFT' AND next_state->>'registrationId'=registration::text;
 IF previous_count>1 THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
 SELECT next_state-'operation' INTO previous FROM hon.audit_events
 WHERE organization_id=org AND school_id=school AND actor_principal_id=actor AND action_code='billing.membership.create' AND entity_type='MEMBERSHIP'
 AND next_state->>'operation'='OWNER_LAUNCH_MEMBERSHIP_DRAFT' AND next_state->>'registrationId'=registration::text;
 IF previous IS NOT NULL THEN
  IF previous->>'planCode'<>p_input->>'planCode' OR previous->>'currency'<>p_input->>'currency'
  OR (previous->>'termStartedAt')::timestamptz<>starts OR (previous->>'termEndsAt')::timestamptz<>ends THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_CONFLICT' USING ERRCODE='23505'; END IF;
  SELECT * INTO membership FROM hon.memberships WHERE id=(previous->>'membershipId')::uuid AND organization_id=org AND school_id=school FOR SHARE;
  IF membership.id IS NULL OR membership.state<>'DRAFT' OR membership.billing_account_id IS DISTINCT FROM account.id OR membership.participant_person_id<>receipt.participant
  OR membership.plan_code<>p_input->>'planCode' OR membership.term_started_at IS DISTINCT FROM starts OR membership.term_ends_at IS DISTINCT FROM ends
  OR EXISTS(SELECT 1 FROM hon.membership_payment_schedules s WHERE s.membership_id=membership.id) THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
  IF prior.status='COMPLETED' AND prior.response_body IS DISTINCT FROM previous THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
  result:=previous; replay:=true;
 ELSE
  IF prior.status='COMPLETED' THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
  IF account.id IS NULL THEN
   INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency) VALUES(org,school,receipt.payer,p_input->>'currency') RETURNING * INTO account;
   created_account:=true;
   payload:=jsonb_build_object('billingAccountId',account.id,'currency',account.currency::text,'operation','OWNER_LAUNCH_MEMBERSHIP_DRAFT');
   INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
   VALUES(org,school,actor,'HUMAN_UI','billing.account.create','BILLING_ACCOUNT',account.id,NULL,payload,'SUCCEEDED',p_request,p_correlation);
   INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
   VALUES(org,school,'billing.account.created',1,'BILLING_ACCOUNT',account.id,account.version,p_correlation,p_request,payload);
  END IF;
  INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
  VALUES(org,school,account.id,receipt.participant,p_input->>'planCode','DRAFT',starts,ends) RETURNING * INTO membership;
  result:=jsonb_build_object('registrationId',registration,'membershipId',membership.id,'state','DRAFT','membershipVersion',membership.version,
   'planCode',membership.plan_code,'termStartedAt',to_char(starts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'termEndsAt',to_char(ends AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'currency',account.currency::text,
   'billingAccountCreated',created_account,'recordedAt',to_char(membership.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  payload:=result||jsonb_build_object('operation','OWNER_LAUNCH_MEMBERSHIP_DRAFT');
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
  VALUES(org,school,actor,'HUMAN_UI','billing.membership.create','MEMBERSHIP',membership.id,NULL,payload,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
  VALUES(org,school,'billing.membership.drafted',1,'MEMBERSHIP',membership.id,membership.version,p_correlation,p_request,payload);
 END IF;
 IF prior.status='IN_PROGRESS' THEN
 UPDATE hon.idempotency_records SET status='COMPLETED',response_status=CASE WHEN replay THEN 200 ELSE 201 END,response_body=result
 WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 END IF;
 PERFORM hon.require_owner_launch_actor(p_subject);
 IF NOT hon.principal_has_school_permission(actor,org,school,'billing.membership.create')
 OR NOT hon.principal_has_school_permission(actor,org,school,'billing.account.create') THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN result||jsonb_build_object('replayed',replay);
END $$;
DO $$ DECLARE r text; BEGIN
 REVOKE ALL ON FUNCTION hon.draft_owner_launch_membership(text,jsonb,text,uuid,uuid) FROM PUBLIC;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.draft_owner_launch_membership(text,jsonb,text,uuid,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.draft_owner_launch_membership(text,jsonb,text,uuid,uuid) TO hon_runtime; END IF;
END $$;
COMMIT;
