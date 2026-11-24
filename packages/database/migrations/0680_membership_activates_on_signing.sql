BEGIN;

-- A membership becomes active when its agreement is signed (0680, coordinator-allocated 2026-11-24, merges after 0679).
-- Owner decision (David, 2026-11-22 09:03Z, decision card "When should a new membership become active?"): "When signed, or
-- staff start it". Staff Start already exists (the 0177 preview and confirm, on the contact card since 0624). This adds the
-- other half: when a guardian signs the school's current agreement for a child, in the parent portal (0463) or from a
-- signing link (0499), each of that child's DRAFT memberships that the 0177 gate would start with nothing left for staff
-- to decide is started, in the same transaction as the signature.
--
-- * WHEN: a deferred constraint trigger on hon.membership_agreement_signatures runs at commit, after the signing function
--   has finished, including its own final checks. A signing that rolls back starts nothing.
-- * WHAT IS EVALUATED: the unchanged 0177 hon.evaluate_membership_activation, under the 0177 lock order. A DRAFT starts
--   only with no blocks, no overridable warning, and no warning other than START_DATE_IN_FUTURE (the membership is then
--   ACTIVE and SCHEDULED until its start day).
-- * DATES: the start the staff member chose is kept when it is today or later. A membership never starts before it was
--   signed: when the planned start has passed, it starts on the signing day in the school timezone and a fixed term is
--   recounted from that day (recorded as an adjusted date with its reason). A DRAFT whose end comes from the DRAFT itself
--   rather than its plan is left for staff when its start has passed.
-- * LEFT FOR STAFF: anything else (a missing birth date, an identity review, a free-text plan, an existing schedule or
--   invoice, a past end date, an overlap in the same program, a lock conflict) leaves the DRAFT as it was, and the reason
--   codes are recorded. Staff then use Start on the contact card as before. A signing never fails because of this step.
-- * EVIDENCE: the 0177 decision row (basis AGREEMENT_SIGNED, the signature id, the signer principal as actor, and the
--   agreement no longer listed as not evaluated), the initial effective period, the DRAFT->ACTIVE change, an audit row and
--   the usual billing.membership.activated outbox event, so a school's "membership activated" automations behave as for a
--   staff start. Every outcome, started or left for staff, is one immutable row in hon.membership_signing_activations.
-- * Nothing is charged, scheduled, invoiced, refunded or sent here, and no provider is called. Audit, outbox and outcome
--   rows carry identifiers and codes only. No client role gains any privilege: the trigger function is SECURITY DEFINER
--   and nothing new is granted.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION '0680 requires a restricted runtime'; END IF;
  IF to_regprocedure('hon.evaluate_membership_activation(uuid,boolean,date,date)') IS NULL
    OR to_regprocedure('hon.sign_family_membership_agreement(text,jsonb,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.sign_membership_agreement_link(text,jsonb,uuid)') IS NULL
    OR to_regprocedure('hon.start_person_membership(text,jsonb,text,uuid,uuid)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='hon.membership_agreement_signatures'::regclass AND attname='link_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0680 requires 0177, 0463, 0499 and 0624'; END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='hon.membership_activation_decisions'::regclass
        AND conname='membership_activation_decisions_decision_basis_check') IS DISTINCT FROM 'CHECK ((decision_basis = ''STAFF_ACTIVATION_PRE_POLICY''::text))'
    OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='hon.membership_activation_decisions'::regclass
        AND conname='membership_activation_decisions_authorizing_permission_check') IS DISTINCT FROM 'CHECK ((authorizing_permission = ''billing.membership.activate''::text))'
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.membership_activation_decisions'::regclass
        AND conname='membership_activation_decision_requirements_not_evaluated_check')
    OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='hon.membership_effective_periods'::regclass
        AND conname='membership_effective_periods_authorizing_permission_check') IS DISTINCT FROM 'CHECK ((authorizing_permission = ''billing.membership.activate''::text))' THEN
    RAISE EXCEPTION '0680 expects the 0177 decision and period constraints unchanged'; END IF;
END $$;

-- 0177 evidence gains a second basis. A staff decision keeps every 0177 rule; a signing decision names its signature and
-- records that the agreement was evaluated. Columns are only added, so no existing row changes.
ALTER TABLE hon.membership_activation_decisions ADD COLUMN signature_id uuid UNIQUE REFERENCES hon.membership_agreement_signatures(id) ON DELETE RESTRICT;
ALTER TABLE hon.membership_activation_decisions DROP CONSTRAINT membership_activation_decisions_decision_basis_check,
  DROP CONSTRAINT membership_activation_decisions_authorizing_permission_check,
  DROP CONSTRAINT membership_activation_decision_requirements_not_evaluated_check;
ALTER TABLE hon.membership_activation_decisions
  ADD CONSTRAINT membership_activation_decisions_decision_basis_check CHECK (decision_basis IN ('STAFF_ACTIVATION_PRE_POLICY','AGREEMENT_SIGNED')),
  ADD CONSTRAINT membership_activation_decisions_authorizing_permission_check CHECK (authorizing_permission IN ('billing.membership.activate','membership_agreement.signed')),
  ADD CONSTRAINT membership_activation_decision_requirements_not_evaluated_check CHECK (requirements_not_evaluated=CASE decision_basis
    WHEN 'AGREEMENT_SIGNED' THEN '["PAYMENT","RECURRING_PAYMENT_AUTHORIZATION","FINANCIAL_RESPONSIBILITY","SCHOOL_ACTIVATION_POLICY"]'::jsonb
    ELSE '["AGREEMENT","PAYMENT","RECURRING_PAYMENT_AUTHORIZATION","FINANCIAL_RESPONSIBILITY","SCHOOL_ACTIVATION_POLICY"]'::jsonb END),
  ADD CONSTRAINT membership_activation_decisions_signing_basis_check CHECK (
    (decision_basis='AGREEMENT_SIGNED')=(signature_id IS NOT NULL)
    AND (decision_basis='AGREEMENT_SIGNED')=(authorizing_permission='membership_agreement.signed')
    AND (decision_basis<>'AGREEMENT_SIGNED' OR (override_permission IS NULL AND adult_verification IS NULL AND reason_code='ROUTINE_ENROLLMENT')));
ALTER TABLE hon.membership_effective_periods DROP CONSTRAINT membership_effective_periods_authorizing_permission_check;
ALTER TABLE hon.membership_effective_periods
  ADD CONSTRAINT membership_effective_periods_authorizing_permission_check CHECK (authorizing_permission IN ('billing.membership.activate','membership_agreement.signed'));

-- One immutable outcome per signature and DRAFT it looked at.
CREATE TABLE hon.membership_signing_activations (
  signature_id uuid NOT NULL REFERENCES hon.membership_agreement_signatures(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('STARTED','LEFT_FOR_STAFF')),
  reason_codes jsonb NOT NULL CHECK (jsonb_typeof(reason_codes)='array' AND jsonb_array_length(reason_codes)<=20),
  decision_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (signature_id,membership_id),
  CHECK ((outcome='STARTED')=(decision_id IS NOT NULL)),
  CHECK (outcome='STARTED' OR jsonb_array_length(reason_codes)>=1),
  -- No foreign key to hon.memberships on purpose: its key-share row lock would wait on a membership another transaction
  -- holds, and the outcome of a DRAFT left for staff must never be able to fail the signing. Memberships are never deleted.
  FOREIGN KEY (decision_id,organization_id,school_id) REFERENCES hon.membership_activation_decisions(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE INDEX membership_signing_activations_membership ON hon.membership_signing_activations(organization_id,school_id,membership_id,created_at DESC);
ALTER TABLE hon.membership_signing_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_signing_activations FORCE ROW LEVEL SECURITY;
CREATE TRIGGER membership_signing_activations_immutable BEFORE UPDATE OR DELETE ON hon.membership_signing_activations
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER membership_signing_activations_no_truncate BEFORE TRUNCATE ON hon.membership_signing_activations
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Start one DRAFT for one signature, or say why not. Runs inside the caller's subtransaction; any error rolls back only
-- this membership's writes and locks. Returns {outcome, reasonCodes, decisionId}.
CREATE FUNCTION hon.membership_start_on_signing(sig hon.membership_agreement_signatures,selected uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=sig.organization_id; school uuid:=sig.school_id; m hon.memberships%ROWTYPE; updated hon.memberships%ROWTYPE;
  period hon.membership_effective_periods%ROWTYPE; terms hon.membership_plan_versions%ROWTYPE; evaluation jsonb; facts jsonb; digest text;
  tz text; today date; s date; e date; adjusted boolean:=false; adjustment text; codes jsonb; acks jsonb; receipt jsonb; instant timestamptz;
  decision_id uuid:=gen_random_uuid(); key text:='agreement-signature:'||sig.id::text||':'||selected::text; request uuid; source text;
BEGIN
  IF org IS DISTINCT FROM hon.current_organization_id() OR school IS DISTINCT FROM hon.current_school_id() THEN
    RAISE EXCEPTION 'MEMBERSHIP_SIGNING_SCOPE' USING ERRCODE='42501'; END IF;
  request:=coalesce(nullif(current_setting('app.hon_request_id',true),'')::uuid,sig.signing_id);
  -- The 0177 lock order: IAM, then people and accounts, then memberships and the row, then provenance and plans.
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  LOCK TABLE hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts IN SHARE MODE;
  LOCK TABLE hon.memberships IN ROW EXCLUSIVE MODE;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  LOCK TABLE hon.crm_adult_membership_draft_sources,hon.crm_guardian_child_enrolled_children,hon.crm_guardian_child_payer_designations,
    hon.crm_guardian_child_membership_draft_sources,hon.membership_plans,hon.membership_plan_versions,hon.membership_plan_selections IN SHARE MODE;
  IF m.id IS NULL OR m.state<>'DRAFT' THEN RETURN jsonb_build_object('outcome','LEFT_FOR_STAFF','reasonCodes','["MEMBERSHIP_NOT_DRAFT"]'::jsonb); END IF;
  -- The signature still stands for this child and this membership's participant.
  IF NOT EXISTS(SELECT 1 FROM hon.student_profiles sp WHERE sp.id=sig.student_profile_id AND sp.organization_id=org AND sp.school_id=school
      AND sp.person_id=m.participant_person_id) THEN
    RETURN jsonb_build_object('outcome','LEFT_FOR_STAFF','reasonCodes','["SIGNATURE_PARTICIPANT_MISMATCH"]'::jsonb); END IF;
  SELECT x.timezone INTO tz FROM hon.schools x WHERE x.id=school AND x.organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN
    RETURN jsonb_build_object('outcome','LEFT_FOR_STAFF','reasonCodes','["SCHOOL_TIMEZONE_INVALID"]'::jsonb); END IF;
  today:=hon.membership_local_date(clock_timestamp(),tz);

  evaluation:=hon.evaluate_membership_activation(selected,false,NULL,NULL);
  facts:=evaluation->'facts';
  s:=(facts->'suggestedDates'->>'startDate')::date;
  IF facts->'blocks'='[]'::jsonb AND s IS NOT NULL AND s<today THEN
    -- Never before the signing day: start today, and recount a plan's fixed term from today.
    SELECT v.* INTO terms FROM hon.membership_plan_selections ps JOIN hon.membership_plan_versions v ON v.plan_id=ps.plan_id AND v.version=ps.plan_version
      AND v.organization_id=ps.organization_id AND v.school_id=ps.school_id
      WHERE ps.membership_id=m.id AND ps.organization_id=org AND ps.school_id=school;
    IF facts->'suggestedDates'->>'endBasis'='PLAN_FIXED_TERM' AND terms.term_kind='FIXED_MONTHS' THEN
      e:=(today+make_interval(months=>terms.term_months))::date-1;
    ELSIF facts->'suggestedDates'->>'endBasis'='PLAN_OPEN_ENDED' THEN e:=NULL;
    ELSE RETURN jsonb_build_object('outcome','LEFT_FOR_STAFF','reasonCodes','["START_DATE_PASSED_DRAFT_END_DATE"]'::jsonb); END IF;
    s:=today; adjusted:=true;
    adjustment:='Started on the day the membership agreement was signed; the planned start date had already passed.';
    evaluation:=hon.evaluate_membership_activation(selected,true,s,e);
    facts:=evaluation->'facts';
  ELSE
    e:=(facts->'suggestedDates'->>'endDate')::date;
  END IF;
  SELECT coalesce(jsonb_agg(DISTINCT x ORDER BY x),'[]'::jsonb) INTO codes FROM (
    SELECT b->>'code' x FROM jsonb_array_elements(facts->'blocks') b
    UNION SELECT w->>'code' FROM jsonb_array_elements(facts->'warnings') w WHERE w->>'code'<>'START_DATE_IN_FUTURE'
    UNION SELECT o#>>'{}' FROM jsonb_array_elements(facts->'overridableWarnings') o) q;
  IF codes<>'[]'::jsonb OR facts->'projection' IS NULL OR jsonb_typeof(facts->'projection')<>'object'
    OR (facts->'proposedDates'->>'dateSource')<>(CASE WHEN adjusted THEN 'STAFF_ADJUSTED' ELSE 'SUGGESTED' END) THEN
    IF codes='[]'::jsonb THEN codes:='["DATES_NOT_CONFIRMABLE"]'::jsonb; END IF;
    RETURN jsonb_build_object('outcome','LEFT_FOR_STAFF','reasonCodes',codes); END IF;

  digest:=encode(sha256(convert_to(facts::text,'UTF8')),'hex');
  SELECT coalesce(jsonb_agg(w->'code' ORDER BY w->>'code'),'[]'::jsonb) INTO acks FROM jsonb_array_elements(facts->'warnings') w;
  source:=facts->>'source';
  instant:=clock_timestamp();
  receipt:=jsonb_build_object('membershipId',m.id,'state','ACTIVE','version',m.version+1,'previousVersion',m.version,
    'decisionId',decision_id,'decisionBasis','AGREEMENT_SIGNED','membershipSource',source,'signatureId',sig.id,'signingId',sig.signing_id,
    'authorizingPermission','membership_agreement.signed','overridePermission',NULL,
    'effectivePeriod',jsonb_build_object('periodVersion',1,'startDate',s,'endDate',e,'endDateInclusive',true,'schoolTimezone',tz,
      'dateSource',facts->'proposedDates'->>'dateSource','termStartedAt',facts->'projection'->'termStartedAt','termEndsAt',facts->'projection'->'termEndsAt'),
    'effectiveStatusAtActivation',hon.membership_effective_status_at('ACTIVE',(facts->'projection'->>'termStartedAt')::timestamptz,
      (facts->'projection'->>'termEndsAt')::timestamptz,instant),
    'acknowledgedWarnings',acks,'overridesUsed','[]'::jsonb,'followUps','[]'::jsonb,'adultVerification',NULL,'reasonCode','ROUTINE_ENROLLMENT',
    'requirementsNotEvaluated','["PAYMENT","RECURRING_PAYMENT_AUTHORIZATION","FINANCIAL_RESPONSIBILITY","SCHOOL_ACTIVATION_POLICY"]'::jsonb,
    'recordedAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO hon.membership_activation_decisions(id,organization_id,school_id,membership_id,prior_membership_version,next_membership_version,decision_basis,
      membership_source,actor_principal_id,authorizing_permission,override_permission,reason_code,reason_text,acknowledged_warnings,overrides,adult_verification,
      preview_digest,evaluated_facts,requirements_not_evaluated,idempotency_key,request_fingerprint,request_id,correlation_id,receipt,created_at,signature_id)
    VALUES(decision_id,org,school,m.id,m.version,m.version+1,'AGREEMENT_SIGNED',source,sig.signer_principal_id,'membership_agreement.signed',NULL,
      'ROUTINE_ENROLLMENT',NULL,acks,'[]'::jsonb,NULL,digest,facts,receipt->'requirementsNotEvaluated',key,digest,request,sig.signing_id,receipt,instant,sig.id);
  INSERT INTO hon.membership_effective_periods(organization_id,school_id,membership_id,period_version,change_kind,start_date,end_date,school_timezone,
      term_started_at,term_ends_at,date_source,suggested_start_date,suggested_end_date,suggestion_basis,adjustment_reason,actor_principal_id,
      authorizing_permission,decision_id,created_at)
    VALUES(org,school,m.id,1,'INITIAL',s,e,tz,(facts->'projection'->>'termStartedAt')::timestamptz,(facts->'projection'->>'termEndsAt')::timestamptz,
      facts->'proposedDates'->>'dateSource',(facts->'suggestedDates'->>'startDate')::date,(facts->'suggestedDates'->>'endDate')::date,
      jsonb_build_object('startBasis',facts->'suggestedDates'->'startBasis','endBasis',facts->'suggestedDates'->'endBasis'),adjustment,sig.signer_principal_id,
      'membership_agreement.signed',decision_id,instant)
    RETURNING * INTO period;
  UPDATE hon.memberships SET state='ACTIVE',version=version+1,term_started_at=period.term_started_at,term_ends_at=period.term_ends_at
    WHERE id=m.id AND organization_id=org AND school_id=school AND state='DRAFT' AND version=m.version RETURNING * INTO updated;
  IF updated.id IS NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,sig.signer_principal_id,CASE WHEN sig.method='SIGNING_LINK' THEN 'PUBLIC_API' ELSE 'HUMAN_UI' END,'billing.membership.activate','MEMBERSHIP',m.id,
      jsonb_build_object('state','DRAFT','version',m.version,'termStartedAt',facts->'existingTerm'->'termStartedAt','termEndsAt',facts->'existingTerm'->'termEndsAt'),
      receipt,'SUCCEEDED',request,sig.signing_id);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership.activated',2,'MEMBERSHIP',m.id,updated.version,sig.signing_id,request,
      receipt || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  RETURN jsonb_build_object('outcome','STARTED','reasonCodes','[]'::jsonb,'decisionId',decision_id);
END $$;

-- At commit, for one new signature: look at each of the child's DRAFTs once, oldest first. Each start runs in its own
-- subtransaction, so a refusal or lock conflict leaves that DRAFT for staff and never fails the signing.
CREATE FUNCTION hon.membership_agreement_signed_starts() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sig hon.membership_agreement_signatures%ROWTYPE; mid uuid; result jsonb; prev_org text; prev_school text; code text;
BEGIN
  SELECT * INTO sig FROM hon.membership_agreement_signatures x WHERE x.id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- The signature must be for the school's current agreement version.
  IF hon.membership_agreement_current(sig.organization_id,sig.school_id) IS DISTINCT FROM sig.version_id THEN RETURN NULL; END IF;
  prev_org:=current_setting('app.hon_organization_id',true); prev_school:=current_setting('app.hon_school_id',true);
  PERFORM set_config('app.hon_organization_id',sig.organization_id::text,true);
  PERFORM set_config('app.hon_school_id',sig.school_id::text,true);
  FOR mid IN SELECT m.id FROM hon.memberships m JOIN hon.student_profiles sp ON sp.person_id=m.participant_person_id
      AND sp.organization_id=m.organization_id AND sp.school_id=m.school_id
    WHERE sp.id=sig.student_profile_id AND m.organization_id=sig.organization_id AND m.school_id=sig.school_id AND m.state='DRAFT'
      AND NOT EXISTS(SELECT 1 FROM hon.membership_signing_activations a WHERE a.signature_id=sig.id AND a.membership_id=m.id)
    ORDER BY m.created_at,m.id LOOP
    BEGIN
      result:=hon.membership_start_on_signing(sig,mid);
    EXCEPTION WHEN others THEN
      code:=CASE WHEN SQLERRM ~ '^[A-Z][A-Z0-9_]{0,63}$' THEN SQLERRM ELSE 'START_FAILED_'||SQLSTATE END;
      result:=jsonb_build_object('outcome','LEFT_FOR_STAFF','reasonCodes',jsonb_build_array(code));
    END;
    INSERT INTO hon.membership_signing_activations(signature_id,membership_id,organization_id,school_id,outcome,reason_codes,decision_id)
      VALUES(sig.id,mid,sig.organization_id,sig.school_id,result->>'outcome',result->'reasonCodes',(result->>'decisionId')::uuid);
  END LOOP;
  PERFORM set_config('app.hon_organization_id',coalesce(prev_org,''),true);
  PERFORM set_config('app.hon_school_id',coalesce(prev_school,''),true);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER membership_agreement_signed_starts AFTER INSERT ON hon.membership_agreement_signatures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.membership_agreement_signed_starts();

COMMENT ON FUNCTION hon.membership_agreement_signed_starts() IS
'Owner decision 2026-11-22: a membership becomes active when its agreement is signed, or when staff start it. At commit of a current-version signature, starts each of the child''s DRAFT memberships that the 0177 gate would start with nothing left for staff, never before the signing day; records every outcome. No charge, schedule, invoice, provider call or communication.';

-- Deny first. Nothing is granted to any client role.
DO $$ DECLARE r text; f text;
  fns text[]:=ARRAY['hon.membership_start_on_signing(hon.membership_agreement_signatures,uuid)','hon.membership_agreement_signed_starts()']; BEGIN
  REVOKE ALL ON TABLE hon.membership_signing_activations FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.membership_signing_activations FROM %I',r); END LOOP;
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
END $$;

COMMIT;
