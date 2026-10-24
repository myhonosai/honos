BEGIN;

-- D11-A: governance metadata ONLY. No approval/campaign is seeded; every activation gate stays closed.
-- 0179/0180 remain reserved. D9/D10, entitlement, checkout, subscription and credit functions are unchanged.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
  AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
END $$;

CREATE FUNCTION hon.saas_trial_keys(p jsonb, expected text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
 SELECT coalesce(jsonb_typeof(p)='object' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)
  =(SELECT array_agg(k ORDER BY k) FROM unnest(expected) k),false)
$$;
CREATE FUNCTION hon.saas_trial_uint(p jsonb, low bigint, high bigint) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
 SELECT CASE WHEN jsonb_typeof(p)='number' AND p::text ~ '^(0|[1-9][0-9]{0,9})$' THEN (p::text)::bigint BETWEEN low AND high ELSE false END
$$;
CREATE FUNCTION hon.saas_trial_choices(p jsonb, allowed jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 RETURN jsonb_array_length(p)>0 AND jsonb_array_length(p)<=jsonb_array_length(allowed)
  AND (SELECT count(DISTINCT x) FROM jsonb_array_elements(p) x)=jsonb_array_length(p) AND p <@ allowed;
END $$;
CREATE FUNCTION hon.saas_trial_timestamp(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'string' OR (p#>>'{}') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN false; END IF;
 PERFORM (p#>>'{}')::timestamptz; RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION hon.saas_trial_policy_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE b jsonb; k text;
BEGIN
 IF NOT hon.saas_trial_keys(p,ARRAY['allowedDurationsDays','allowedCapabilityProfiles','allowedEligibilityCodes','allowedLinkModes','maxEnrollmentCapacity','maxEnrollmentWindowDays','maxPublishedCampaigns','maxTotalEnrollmentCapacity','termsReference','promotionalLimits']) THEN RETURN false; END IF;
 IF NOT hon.saas_trial_choices(p->'allowedDurationsDays','[7,14,30,60,90]')
  OR NOT hon.saas_trial_choices(p->'allowedCapabilityProfiles','["CORE","COMPLETE"]')
  OR NOT hon.saas_trial_choices(p->'allowedEligibilityCodes','["NEW_ORGANIZATIONS_ONLY","HQ_REVIEW_REQUIRED"]')
  OR NOT hon.saas_trial_choices(p->'allowedLinkModes','["PUBLIC","PRIVATE_INVITATION","PROMOTIONAL"]')
  OR NOT hon.saas_trial_uint(p->'maxEnrollmentCapacity',1,1000000) OR NOT hon.saas_trial_uint(p->'maxEnrollmentWindowDays',1,3660)
  OR NOT hon.saas_trial_uint(p->'maxPublishedCampaigns',1,10000) OR NOT hon.saas_trial_uint(p->'maxTotalEnrollmentCapacity',1,1000000000)
  OR coalesce(jsonb_typeof(p->'termsReference')<>'string' OR (p->>'termsReference') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{4,199}$',true) THEN RETURN false; END IF;
 IF (p->>'maxTotalEnrollmentCapacity')::bigint<(p->>'maxEnrollmentCapacity')::bigint THEN RETURN false; END IF;
 b:=p->'promotionalLimits'; IF b='null'::jsonb THEN RETURN true; END IF;
 IF NOT hon.saas_trial_keys(b,ARRAY['maxCreditsPerEnrollment','maxCreditExpiryDays','maxDailyCreditCap','maxPerRequestCreditCap','maxCampaignCostMinor','maxTotalCampaignCostMinor']) THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['maxCreditsPerEnrollment','maxDailyCreditCap','maxPerRequestCreditCap'] LOOP IF NOT hon.saas_trial_uint(b->k,1,1000000) THEN RETURN false; END IF; END LOOP;
 IF NOT hon.saas_trial_uint(b->'maxCreditExpiryDays',1,90) OR NOT hon.saas_trial_uint(b->'maxCampaignCostMinor',1,1000000000)
  OR NOT hon.saas_trial_uint(b->'maxTotalCampaignCostMinor',1,1000000000) THEN RETURN false; END IF;
 RETURN (b->>'maxPerRequestCreditCap')::int<=(b->>'maxDailyCreditCap')::int AND (b->>'maxDailyCreditCap')::int<=(b->>'maxCreditsPerEnrollment')::int
  AND (b->>'maxCampaignCostMinor')::bigint<=(b->>'maxTotalCampaignCostMinor')::bigint;
END $$;
CREATE FUNCTION hon.saas_trial_campaign_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE b jsonb; k text;
BEGIN
 IF NOT hon.saas_trial_keys(p,ARRAY['name','durationDays','capabilityProfile','eligibility','linkMode','enrollmentOpensAt','enrollmentClosesAt','maximumEnrollments','termsReference','promotionalBudget']) THEN RETURN false; END IF;
 IF jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR p->>'name'<>btrim(p->>'name') OR length(p->>'name') NOT BETWEEN 1 AND 120 OR (p->>'name') ~ '[[:cntrl:]]'
  OR NOT hon.saas_trial_uint(p->'durationDays',1,90) OR p->>'durationDays' NOT IN ('7','14','30','60','90')
  OR coalesce(p->>'capabilityProfile' NOT IN ('CORE','COMPLETE'),true) OR coalesce(p->>'eligibility' NOT IN ('NEW_ORGANIZATIONS_ONLY','HQ_REVIEW_REQUIRED'),true)
  OR coalesce(p->>'linkMode' NOT IN ('PUBLIC','PRIVATE_INVITATION','PROMOTIONAL'),true)
  OR NOT hon.saas_trial_timestamp(p->'enrollmentOpensAt') OR NOT hon.saas_trial_timestamp(p->'enrollmentClosesAt')
  OR NOT hon.saas_trial_uint(p->'maximumEnrollments',1,1000000) OR jsonb_typeof(p->'termsReference') IS DISTINCT FROM 'string'
  OR (p->>'termsReference') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{4,199}$' THEN RETURN false; END IF;
 IF (p->>'enrollmentClosesAt')::timestamptz<=(p->>'enrollmentOpensAt')::timestamptz
  OR extract(epoch FROM ((p->>'enrollmentClosesAt')::timestamptz-(p->>'enrollmentOpensAt')::timestamptz))>3660::bigint*86400 THEN RETURN false; END IF;
 b:=p->'promotionalBudget'; IF b='null'::jsonb THEN RETURN true; END IF;
 IF NOT hon.saas_trial_keys(b,ARRAY['currency','creditsPerEnrollment','creditExpiryDays','dailyCreditCap','perRequestCreditCap','maximumCampaignCostMinor']) OR b->>'currency' IS DISTINCT FROM 'USD' THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['creditsPerEnrollment','dailyCreditCap','perRequestCreditCap'] LOOP IF NOT hon.saas_trial_uint(b->k,1,1000000) THEN RETURN false; END IF; END LOOP;
 IF NOT hon.saas_trial_uint(b->'creditExpiryDays',1,90) OR NOT hon.saas_trial_uint(b->'maximumCampaignCostMinor',1,1000000000) THEN RETURN false; END IF;
 RETURN (b->>'perRequestCreditCap')::int<=(b->>'dailyCreditCap')::int AND (b->>'dailyCreditCap')::int<=(b->>'creditsPerEnrollment')::int AND (b->>'creditExpiryDays')::int<=(p->>'durationDays')::int;
END $$;

CREATE TABLE hon.saas_trial_program (
 program_id smallint PRIMARY KEY CHECK(program_id=1), status text NOT NULL CHECK(status='INACTIVE'),
 signup_enabled boolean NOT NULL CHECK(signup_enabled=false), enrollment_enabled boolean NOT NULL CHECK(enrollment_enabled=false),
 promotional_issuance_enabled boolean NOT NULL CHECK(promotional_issuance_enabled=false)
);
INSERT INTO hon.saas_trial_program VALUES(1,'INACTIVE',false,false,false);
CREATE TABLE hon.saas_trial_policy_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version integer NOT NULL UNIQUE CHECK(version BETWEEN 1 AND 999999999),
 status text NOT NULL DEFAULT 'PROPOSED' CHECK(status='PROPOSED'), terms jsonb NOT NULL CHECK(hon.saas_trial_policy_valid(terms)),
 reason text NOT NULL CHECK(reason=btrim(reason) AND length(reason) BETWEEN 10 AND 500),
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), idempotency_key uuid NOT NULL, recorded_at timestamptz NOT NULL,
 FOREIGN KEY(actor_principal_id,idempotency_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key), UNIQUE(actor_principal_id,idempotency_key)
);
CREATE TABLE hon.saas_trial_policy_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision integer NOT NULL UNIQUE CHECK(revision BETWEEN 1 AND 999999999),
 policy_id uuid NOT NULL REFERENCES hon.saas_trial_policy_versions(id), decision text NOT NULL CHECK(decision IN ('APPROVED','WITHDRAWN','REVOKED')),
 valid_from timestamptz NOT NULL CHECK(isfinite(valid_from)), valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>valid_from),
 confirmation text, reason text NOT NULL CHECK(reason=btrim(reason) AND length(reason) BETWEEN 10 AND 500),
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), idempotency_key uuid NOT NULL, recorded_at timestamptz NOT NULL,
 FOREIGN KEY(actor_principal_id,idempotency_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key), UNIQUE(actor_principal_id,idempotency_key),
 CHECK((decision='APPROVED' AND confirmation IS NOT NULL AND confirmation='APPROVE_CUSTOMER_TRIAL_POLICY_ONLY') OR (decision<>'APPROVED' AND confirmation IS NULL))
);
CREATE TABLE hon.saas_trial_campaign_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL, version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999),
 definition jsonb NOT NULL CHECK(hon.saas_trial_campaign_valid(definition)), reason text NOT NULL CHECK(reason=btrim(reason) AND length(reason) BETWEEN 10 AND 500),
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), idempotency_key uuid NOT NULL, recorded_at timestamptz NOT NULL,
 UNIQUE(campaign_id,version), UNIQUE(id,campaign_id),
 FOREIGN KEY(actor_principal_id,idempotency_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key), UNIQUE(actor_principal_id,idempotency_key)
);
CREATE TABLE hon.saas_trial_publications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 999999999),
 kind text NOT NULL CHECK(kind IN ('PUBLISHED','WITHDRAWN')), version_id uuid NOT NULL, policy_decision_id uuid NOT NULL REFERENCES hon.saas_trial_policy_decisions(id),
 preview_digest text CHECK(preview_digest ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(reason=btrim(reason) AND length(reason) BETWEEN 10 AND 500),
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), idempotency_key uuid NOT NULL, recorded_at timestamptz NOT NULL,
 FOREIGN KEY(version_id,campaign_id) REFERENCES hon.saas_trial_campaign_versions(id,campaign_id), UNIQUE(campaign_id,revision),
 FOREIGN KEY(actor_principal_id,idempotency_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key), UNIQUE(actor_principal_id,idempotency_key),
 CHECK((kind='PUBLISHED' AND preview_digest IS NOT NULL) OR (kind='WITHDRAWN' AND preview_digest IS NULL))
);

CREATE FUNCTION hon.saas_trial_policy_json(p hon.saas_trial_policy_versions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('policyId',p.id,'version',p.version,'status',p.status,'terms',p.terms,'reason',p.reason,'actorPrincipalId',p.actor_principal_id,'recordedAt',hon.saas_ts(p.recorded_at))
$$;
CREATE FUNCTION hon.saas_trial_decision_json(p hon.saas_trial_policy_decisions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('decisionId',p.id,'revision',p.revision,'policyId',p.policy_id,'decision',p.decision,'validFrom',hon.saas_ts(p.valid_from),'validUntil',hon.saas_ts(p.valid_until),'reason',p.reason,'actorPrincipalId',p.actor_principal_id,'recordedAt',hon.saas_ts(p.recorded_at))
$$;
CREATE FUNCTION hon.saas_trial_campaign_json(p hon.saas_trial_campaign_versions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('versionId',p.id,'campaignId',p.campaign_id,'version',p.version,'definition',p.definition,'reason',p.reason,'actorPrincipalId',p.actor_principal_id,'recordedAt',hon.saas_ts(p.recorded_at))
$$;
CREATE FUNCTION hon.saas_trial_publication_json(p hon.saas_trial_publications) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('publicationId',p.id,'campaignId',p.campaign_id,'revision',p.revision,'kind',p.kind,'versionId',p.version_id,'policyDecisionId',p.policy_decision_id,'previewDigest',p.preview_digest,'reason',p.reason,'actorPrincipalId',p.actor_principal_id,'recordedAt',hon.saas_ts(p.recorded_at),'activationAvailable',false)
$$;

-- Low-volume governance uses one mutex: IAM -> request -> D11-A governance. No tenant, checkout or
-- subscription lock is taken. This mutex never substitutes for a future enrollment/spend lock design.
CREATE FUNCTION hon.saas_trial_begin(p_subject text,p_key uuid,p_operation text,p_input jsonb,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; replay jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
 actor:=hon.require_saas_hq_actor(p_subject,true);
 LOCK TABLE hon.users,hon.principals,hon.hq_operator_grants,hon.family_access_grants IN SHARE MODE;
 actor:=hon.require_saas_hq_actor(p_subject,true);
 replay:=hon.saas_claim_request(actor,p_key,p_operation,hon.saas_fingerprint(ARRAY[p_operation,p_input::text]),p_request,p_correlation);
 IF replay IS NOT NULL THEN PERFORM hon.require_saas_hq_actor(p_subject,true);RETURN jsonb_build_object('actorId',actor,'replay',replay);END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('saas.customer_trials.governance',0));
 PERFORM hon.require_saas_hq_actor(p_subject,true);
 RETURN jsonb_build_object('actorId',actor,'replay',NULL);
END $$;

CREATE FUNCTION hon.saas_trial_preview(p_version uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE v hon.saas_trial_campaign_versions%ROWTYPE; d hon.saas_trial_policy_decisions%ROWTYPE; t jsonb; c jsonb; b jsonb; limits jsonb;
 prior_revision integer; latest_version integer; blockers jsonb:='[]'; at timestamptz:=clock_timestamp(); digest text;
 used_campaigns bigint; used_capacity bigint; used_budget bigint;
BEGIN
 SELECT * INTO v FROM hon.saas_trial_campaign_versions WHERE id=p_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002';END IF;
 SELECT * INTO d FROM hon.saas_trial_policy_decisions ORDER BY revision DESC LIMIT 1;
 SELECT terms INTO t FROM hon.saas_trial_policy_versions WHERE id=d.policy_id;
 c:=v.definition;b:=c->'promotionalBudget';limits:=t->'promotionalLimits';
 SELECT max(version) INTO latest_version FROM hon.saas_trial_campaign_versions WHERE campaign_id=v.campaign_id;
 SELECT coalesce(max(revision),0) INTO prior_revision FROM hon.saas_trial_publications WHERE campaign_id=v.campaign_id;
 IF latest_version<>v.version THEN blockers:=blockers||'"CAMPAIGN_VERSION_STALE"';END IF;
 IF EXISTS(SELECT 1 FROM hon.saas_trial_publications WHERE version_id=v.id AND kind='PUBLISHED') THEN blockers:=blockers||'"CAMPAIGN_ALREADY_PUBLISHED"';END IF;
 IF d.id IS NULL OR d.decision<>'APPROVED' OR d.valid_from>at OR d.valid_until<=at THEN blockers:=blockers||'"TRIAL_POLICY_REQUIRED"';END IF;
 IF (c->>'enrollmentClosesAt')::timestamptz<=at THEN blockers:=blockers||'"ENROLLMENT_WINDOW_ENDED"';END IF;
 IF d.id IS NOT NULL THEN
  IF NOT (t->'allowedDurationsDays' @> jsonb_build_array(c->'durationDays')) THEN blockers:=blockers||'"DURATION_NOT_ALLOWED"';END IF;
  IF NOT (t->'allowedCapabilityProfiles' @> jsonb_build_array(c->'capabilityProfile')) THEN blockers:=blockers||'"CAPABILITY_PROFILE_NOT_ALLOWED"';END IF;
  IF NOT (t->'allowedEligibilityCodes' @> jsonb_build_array(c->'eligibility')) THEN blockers:=blockers||'"ELIGIBILITY_NOT_ALLOWED"';END IF;
  IF NOT (t->'allowedLinkModes' @> jsonb_build_array(c->'linkMode')) THEN blockers:=blockers||'"LINK_MODE_NOT_ALLOWED"';END IF;
  IF c->>'termsReference' IS DISTINCT FROM t->>'termsReference' THEN blockers:=blockers||'"TERMS_REFERENCE_MISMATCH"';END IF;
  IF (c->>'maximumEnrollments')::int>(t->>'maxEnrollmentCapacity')::int THEN blockers:=blockers||'"CAPACITY_EXCEEDS_POLICY"';END IF;
  IF extract(epoch FROM ((c->>'enrollmentClosesAt')::timestamptz-(c->>'enrollmentOpensAt')::timestamptz))>(t->>'maxEnrollmentWindowDays')::bigint*86400
   OR (c->>'enrollmentOpensAt')::timestamptz<d.valid_from OR (c->>'enrollmentClosesAt')::timestamptz>d.valid_until THEN blockers:=blockers||'"ENROLLMENT_WINDOW_EXCEEDS_POLICY"';END IF;
  IF b<>'null'::jsonb THEN
   IF limits='null'::jsonb THEN blockers:=blockers||'"PROMOTIONAL_METADATA_NOT_ALLOWED"';
   ELSIF (b->>'creditsPerEnrollment')::int>(limits->>'maxCreditsPerEnrollment')::int OR (b->>'creditExpiryDays')::int>(limits->>'maxCreditExpiryDays')::int
    OR (b->>'dailyCreditCap')::int>(limits->>'maxDailyCreditCap')::int OR (b->>'perRequestCreditCap')::int>(limits->>'maxPerRequestCreditCap')::int
    OR (b->>'maximumCampaignCostMinor')::bigint>(limits->>'maxCampaignCostMinor')::bigint THEN blockers:=blockers||'"PROMOTIONAL_METADATA_EXCEEDS_POLICY"';END IF;
  END IF;
  -- Current effective publications only. Drafts never consume these PLANNED exposure limits.
  SELECT count(*),coalesce(sum((cv.definition->>'maximumEnrollments')::bigint),0),coalesce(sum((cv.definition->'promotionalBudget'->>'maximumCampaignCostMinor')::bigint),0)
   INTO used_campaigns,used_capacity,used_budget
   FROM hon.saas_trial_publications pub JOIN hon.saas_trial_campaign_versions cv ON cv.id=pub.version_id
   WHERE pub.campaign_id<>v.campaign_id AND pub.kind='PUBLISHED' AND pub.policy_decision_id=d.id
    AND pub.revision=(SELECT max(x.revision) FROM hon.saas_trial_publications x WHERE x.campaign_id=pub.campaign_id);
  IF used_campaigns+1>(t->>'maxPublishedCampaigns')::int OR used_capacity+(c->>'maximumEnrollments')::int>(t->>'maxTotalEnrollmentCapacity')::bigint THEN blockers:=blockers||'"AGGREGATE_CAPACITY_EXCEEDS_POLICY"';END IF;
  IF limits<>'null'::jsonb AND used_budget+coalesce((b->>'maximumCampaignCostMinor')::bigint,0)>(limits->>'maxTotalCampaignCostMinor')::bigint THEN blockers:=blockers||'"AGGREGATE_PROMOTIONAL_METADATA_EXCEEDS_POLICY"';END IF;
 END IF;
 digest:=hon.saas_fingerprint(ARRAY['CUSTOMER_TRIAL_PUBLICATION_ONLY',v.id::text,v.campaign_id::text,v.version::text,v.definition::text,prior_revision::text,d.id::text,t::text,coalesce(used_campaigns,0)::text,coalesce(used_capacity,0)::text,coalesce(used_budget,0)::text]);
 RETURN jsonb_build_object('campaignId',v.campaign_id,'versionId',v.id,'version',v.version,'expectedRevision',prior_revision,'policyDecisionId',d.id,'policyId',d.policy_id,
  'digest',digest,'ready',jsonb_array_length(blockers)=0,'blockers',blockers,'activationAvailable',false,'promotionalCreditsAvailable',false,
  'plannedExposure',jsonb_build_object('enrollments',(c->>'maximumEnrollments')::int,'promotionalCostMinor',coalesce((b->>'maximumCampaignCostMinor')::bigint,0),'currency','USD'),'asOf',hon.saas_ts(at));
END $$;

CREATE FUNCTION hon.propose_saas_trial_policy(p_subject text,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE ctx jsonb; actor uuid; latest integer; made hon.saas_trial_policy_versions%ROWTYPE;
BEGIN
 IF NOT hon.saas_trial_keys(p,ARRAY['expectedVersion','terms','reason']) OR NOT hon.saas_trial_uint(p->'expectedVersion',0,999999998)
  OR NOT hon.saas_trial_policy_valid(p->'terms') OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string'
  OR p->>'reason'<>btrim(p->>'reason') OR length(p->>'reason') NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';END IF;
 ctx:=hon.saas_trial_begin(p_subject,p_key,'saas.trials.policy_propose',p,p_request,p_correlation);
 IF ctx->'replay'<>'null'::jsonb THEN RETURN ctx->'replay';END IF;actor:=(ctx->>'actorId')::uuid;
 SELECT coalesce(max(version),0) INTO latest FROM hon.saas_trial_policy_versions;
 IF latest<>(p->>'expectedVersion')::int THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
 INSERT INTO hon.saas_trial_policy_versions(version,terms,reason,actor_principal_id,idempotency_key,recorded_at)
  VALUES(latest+1,p->'terms',p->>'reason',actor,p_key,clock_timestamp()) RETURNING * INTO made;
 RETURN hon.saas_record(actor,p_key,'saas.trials.policy_propose','saas.trials.policy_proposed','TRIAL_POLICY',made.id,NULL,NULL,hon.saas_trial_policy_json(made),jsonb_build_object('policyVersion',hon.saas_trial_policy_json(made)),clock_timestamp());
END $$;
CREATE FUNCTION hon.decide_saas_trial_policy(p_subject text,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE ctx jsonb; actor uuid; prior hon.saas_trial_policy_decisions%ROWTYPE; made hon.saas_trial_policy_decisions%ROWTYPE;
 policy uuid; starts timestamptz; ends timestamptz; action text;
BEGIN
 action:=p->>'decision';
 IF action IS NULL OR action NOT IN ('APPROVED','WITHDRAWN','REVOKED') OR NOT hon.saas_trial_uint(p->'expectedRevision',0,999999998)
  OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string' OR p->>'reason'<>btrim(p->>'reason') OR length(p->>'reason') NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';END IF;
 IF action='APPROVED' THEN
  IF NOT hon.saas_trial_keys(p,ARRAY['decision','expectedRevision','policyId','validFrom','validUntil','reason','confirmation'])
   OR jsonb_typeof(p->'policyId') IS DISTINCT FROM 'string' OR p->>'confirmation' IS DISTINCT FROM 'APPROVE_CUSTOMER_TRIAL_POLICY_ONLY'
   OR NOT hon.saas_trial_timestamp(p->'validFrom') OR NOT hon.saas_trial_timestamp(p->'validUntil') THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';END IF;
  policy:=(p->>'policyId')::uuid;starts:=(p->>'validFrom')::timestamptz;ends:=(p->>'validUntil')::timestamptz;
 ELSE
  IF NOT hon.saas_trial_keys(p,ARRAY['decision','expectedRevision','reason']) THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';END IF;
 END IF;
 ctx:=hon.saas_trial_begin(p_subject,p_key,'saas.trials.policy_decide',p,p_request,p_correlation);
 IF ctx->'replay'<>'null'::jsonb THEN RETURN ctx->'replay';END IF;actor:=(ctx->>'actorId')::uuid;
 SELECT * INTO prior FROM hon.saas_trial_policy_decisions ORDER BY revision DESC LIMIT 1;
 IF coalesce(prior.revision,0)<>(p->>'expectedRevision')::int THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
 IF action='APPROVED' THEN
  IF policy IS DISTINCT FROM (SELECT id FROM hon.saas_trial_policy_versions ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'SAAS_TRIAL_POLICY_STALE' USING ERRCODE='40001';END IF;
  IF starts>=ends OR ends<=clock_timestamp() THEN RAISE EXCEPTION 'SAAS_TRIAL_POLICY_WINDOW_INVALID' USING ERRCODE='23514';END IF;
 ELSE
  IF prior.id IS NULL OR prior.decision<>'APPROVED' THEN RAISE EXCEPTION 'SAAS_TRIAL_POLICY_REQUIRED' USING ERRCODE='23514';END IF;
  policy:=prior.policy_id;starts:=prior.valid_from;ends:=prior.valid_until;
 END IF;
 INSERT INTO hon.saas_trial_policy_decisions(revision,policy_id,decision,valid_from,valid_until,confirmation,reason,actor_principal_id,idempotency_key,recorded_at)
  VALUES(coalesce(prior.revision,0)+1,policy,action,starts,ends,p->>'confirmation',p->>'reason',actor,p_key,clock_timestamp()) RETURNING * INTO made;
 RETURN hon.saas_record(actor,p_key,'saas.trials.policy_decide','saas.trials.policy_decided','TRIAL_POLICY_DECISION',made.id,NULL,
  CASE WHEN prior.id IS NULL THEN NULL ELSE hon.saas_trial_decision_json(prior) END,hon.saas_trial_decision_json(made),jsonb_build_object('decision',hon.saas_trial_decision_json(made)),clock_timestamp());
END $$;
CREATE FUNCTION hon.draft_saas_trial_campaign(p_subject text,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE ctx jsonb; actor uuid; campaign uuid; latest integer; made hon.saas_trial_campaign_versions%ROWTYPE;
BEGIN
 IF NOT hon.saas_trial_keys(p,ARRAY['campaignId','expectedVersion','definition','reason']) OR NOT hon.saas_trial_uint(p->'expectedVersion',0,999999998)
  OR NOT hon.saas_trial_campaign_valid(p->'definition') OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string'
  OR p->>'reason'<>btrim(p->>'reason') OR length(p->>'reason') NOT BETWEEN 10 AND 500
  OR jsonb_typeof(p->'campaignId') NOT IN ('string','null') THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';END IF;
 campaign:=(p->>'campaignId')::uuid;
 ctx:=hon.saas_trial_begin(p_subject,p_key,'saas.trials.campaign_draft',p,p_request,p_correlation);
 IF ctx->'replay'<>'null'::jsonb THEN RETURN ctx->'replay';END IF;actor:=(ctx->>'actorId')::uuid;
 IF campaign IS NULL THEN
  IF (p->>'expectedVersion')::int<>0 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';END IF;
  campaign:=gen_random_uuid();latest:=0;
 ELSE
  SELECT max(version) INTO latest FROM hon.saas_trial_campaign_versions WHERE campaign_id=campaign;
  IF latest IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002';END IF;
 END IF;
 IF latest<>(p->>'expectedVersion')::int THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
 INSERT INTO hon.saas_trial_campaign_versions(campaign_id,version,definition,reason,actor_principal_id,idempotency_key,recorded_at)
  VALUES(campaign,latest+1,p->'definition',p->>'reason',actor,p_key,clock_timestamp()) RETURNING * INTO made;
 RETURN hon.saas_record(actor,p_key,'saas.trials.campaign_draft','saas.trials.campaign_drafted','TRIAL_CAMPAIGN_VERSION',made.id,NULL,NULL,hon.saas_trial_campaign_json(made),jsonb_build_object('campaignVersion',hon.saas_trial_campaign_json(made)),clock_timestamp());
END $$;
CREATE FUNCTION hon.publish_saas_trial_campaign(p_subject text,p_campaign uuid,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE ctx jsonb; actor uuid; preview jsonb; made hon.saas_trial_publications%ROWTYPE; version uuid;
BEGIN
 IF p_campaign IS NULL OR NOT hon.saas_trial_keys(p,ARRAY['versionId','expectedRevision','previewDigest','confirmation','reason'])
  OR NOT hon.saas_trial_uint(p->'expectedRevision',0,999999998) OR jsonb_typeof(p->'versionId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p->'previewDigest') IS DISTINCT FROM 'string' OR (p->>'previewDigest') !~ '^[0-9a-f]{64}$'
  OR p->>'confirmation' IS DISTINCT FROM 'PUBLISH_TRIAL_CAMPAIGN_DEFINITION_ONLY' OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string'
  OR p->>'reason'<>btrim(p->>'reason') OR length(p->>'reason') NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';END IF;
 version:=(p->>'versionId')::uuid;
 ctx:=hon.saas_trial_begin(p_subject,p_key,'saas.trials.campaign_publish',jsonb_build_object('campaignId',p_campaign,'input',p),p_request,p_correlation);
 IF ctx->'replay'<>'null'::jsonb THEN RETURN ctx->'replay';END IF;actor:=(ctx->>'actorId')::uuid;
 preview:=hon.saas_trial_preview(version);
 IF (preview->>'campaignId')::uuid<>p_campaign THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002';END IF;
 IF (preview->>'expectedRevision')::int<>(p->>'expectedRevision')::int THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
 IF preview->>'digest'<>p->>'previewDigest' THEN RAISE EXCEPTION 'SAAS_TRIAL_PREVIEW_STALE' USING ERRCODE='40001';END IF;
 IF (preview->>'ready')::boolean IS NOT true THEN RAISE EXCEPTION 'SAAS_TRIAL_PUBLICATION_BLOCKED' USING ERRCODE='23514';END IF;
 INSERT INTO hon.saas_trial_publications(campaign_id,revision,kind,version_id,policy_decision_id,preview_digest,reason,actor_principal_id,idempotency_key,recorded_at)
  VALUES(p_campaign,(p->>'expectedRevision')::int+1,'PUBLISHED',version,(preview->>'policyDecisionId')::uuid,p->>'previewDigest',p->>'reason',actor,p_key,clock_timestamp()) RETURNING * INTO made;
 RETURN hon.saas_record(actor,p_key,'saas.trials.campaign_publish','saas.trials.campaign_published','TRIAL_PUBLICATION',made.id,NULL,NULL,hon.saas_trial_publication_json(made),jsonb_build_object('publication',hon.saas_trial_publication_json(made)),clock_timestamp());
END $$;
CREATE FUNCTION hon.withdraw_saas_trial_campaign(p_subject text,p_campaign uuid,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE ctx jsonb; actor uuid; prior hon.saas_trial_publications%ROWTYPE; made hon.saas_trial_publications%ROWTYPE;
BEGIN
 IF p_campaign IS NULL OR NOT hon.saas_trial_keys(p,ARRAY['expectedRevision','reason']) OR NOT hon.saas_trial_uint(p->'expectedRevision',0,999999998)
  OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string' OR p->>'reason'<>btrim(p->>'reason') OR length(p->>'reason') NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';END IF;
 ctx:=hon.saas_trial_begin(p_subject,p_key,'saas.trials.campaign_withdraw',jsonb_build_object('campaignId',p_campaign,'input',p),p_request,p_correlation);
 IF ctx->'replay'<>'null'::jsonb THEN RETURN ctx->'replay';END IF;actor:=(ctx->>'actorId')::uuid;
 SELECT * INTO prior FROM hon.saas_trial_publications WHERE campaign_id=p_campaign ORDER BY revision DESC LIMIT 1;
 IF prior.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002';END IF;
 IF prior.revision<>(p->>'expectedRevision')::int THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
 IF prior.kind<>'PUBLISHED' THEN RAISE EXCEPTION 'SAAS_TRIAL_PUBLICATION_BLOCKED' USING ERRCODE='23514';END IF;
 INSERT INTO hon.saas_trial_publications(campaign_id,revision,kind,version_id,policy_decision_id,reason,actor_principal_id,idempotency_key,recorded_at)
  VALUES(p_campaign,prior.revision+1,'WITHDRAWN',prior.version_id,prior.policy_decision_id,p->>'reason',actor,p_key,clock_timestamp()) RETURNING * INTO made;
 RETURN hon.saas_record(actor,p_key,'saas.trials.campaign_withdraw','saas.trials.campaign_withdrawn','TRIAL_PUBLICATION',made.id,NULL,hon.saas_trial_publication_json(prior),hon.saas_trial_publication_json(made),jsonb_build_object('publication',hon.saas_trial_publication_json(made)),clock_timestamp());
END $$;

-- Structural backstop, even for inserts attempted around the command. Runtime has no direct table privileges.
CREATE FUNCTION hon.guard_saas_trial_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject text; v_operation text; latest integer; preview jsonb; prior hon.saas_trial_publications%ROWTYPE; d hon.saas_trial_policy_decisions%ROWTYPE;
BEGIN
 SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=NEW.actor_principal_id;
 PERFORM hon.require_saas_hq_actor(subject,true);
 PERFORM pg_advisory_xact_lock(hashtextextended('saas.customer_trials.governance',0));
 PERFORM hon.require_saas_hq_actor(subject,true);
 IF TG_TABLE_NAME='saas_trial_policy_versions' THEN
  v_operation:='saas.trials.policy_propose';SELECT coalesce(max(version),0) INTO latest FROM hon.saas_trial_policy_versions;
  IF NEW.version<>latest+1 THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
 ELSIF TG_TABLE_NAME='saas_trial_policy_decisions' THEN
  v_operation:='saas.trials.policy_decide';SELECT coalesce(max(revision),0) INTO latest FROM hon.saas_trial_policy_decisions;
  IF NEW.revision<>latest+1 THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
  IF NEW.decision='APPROVED' AND (NEW.valid_until<=clock_timestamp() OR NEW.policy_id IS DISTINCT FROM (SELECT id FROM hon.saas_trial_policy_versions ORDER BY version DESC LIMIT 1)) THEN RAISE EXCEPTION 'SAAS_TRIAL_POLICY_REQUIRED' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='saas_trial_campaign_versions' THEN
  v_operation:='saas.trials.campaign_draft';SELECT coalesce(max(version),0) INTO latest FROM hon.saas_trial_campaign_versions WHERE campaign_id=NEW.campaign_id;
  IF NEW.version<>latest+1 THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
 ELSE
  v_operation:=CASE WHEN NEW.kind='PUBLISHED' THEN 'saas.trials.campaign_publish' ELSE 'saas.trials.campaign_withdraw' END;
  SELECT * INTO prior FROM hon.saas_trial_publications WHERE campaign_id=NEW.campaign_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision<>coalesce(prior.revision,0)+1 THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
  IF NEW.kind='PUBLISHED' THEN
   preview:=hon.saas_trial_preview(NEW.version_id);
   IF (preview->>'ready')::boolean IS NOT true OR NEW.preview_digest IS DISTINCT FROM preview->>'digest' OR NEW.policy_decision_id IS DISTINCT FROM (preview->>'policyDecisionId')::uuid
    OR NEW.campaign_id IS DISTINCT FROM (preview->>'campaignId')::uuid THEN RAISE EXCEPTION 'SAAS_TRIAL_PUBLICATION_BLOCKED' USING ERRCODE='23514';END IF;
  ELSIF prior.id IS NULL OR prior.kind<>'PUBLISHED' OR NEW.version_id<>prior.version_id OR NEW.policy_decision_id<>prior.policy_decision_id THEN RAISE EXCEPTION 'SAAS_TRIAL_PUBLICATION_BLOCKED' USING ERRCODE='23514';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM hon.saas_requests r WHERE r.actor_principal_id=NEW.actor_principal_id AND r.idempotency_key=NEW.idempotency_key AND r.operation=v_operation AND r.status='IN_PROGRESS') THEN RAISE EXCEPTION 'SAAS_TRIAL_EVIDENCE_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION hon.verify_saas_trial_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject text; v_operation text; event text; entity text; field text; data jsonb; d hon.saas_trial_policy_decisions%ROWTYPE;
BEGIN
 SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=NEW.actor_principal_id;
 PERFORM hon.require_saas_hq_actor(subject,true);
 IF TG_TABLE_NAME='saas_trial_policy_versions' THEN v_operation:='saas.trials.policy_propose';event:='saas.trials.policy_proposed';entity:='TRIAL_POLICY';field:='policyVersion';data:=hon.saas_trial_policy_json(NEW);
 ELSIF TG_TABLE_NAME='saas_trial_policy_decisions' THEN
  v_operation:='saas.trials.policy_decide';event:='saas.trials.policy_decided';entity:='TRIAL_POLICY_DECISION';field:='decision';data:=hon.saas_trial_decision_json(NEW);
  IF NEW.decision='APPROVED' AND NEW.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'SAAS_TRIAL_POLICY_WINDOW_INVALID' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='saas_trial_campaign_versions' THEN v_operation:='saas.trials.campaign_draft';event:='saas.trials.campaign_drafted';entity:='TRIAL_CAMPAIGN_VERSION';field:='campaignVersion';data:=hon.saas_trial_campaign_json(NEW);
 ELSE
  v_operation:=CASE WHEN NEW.kind='PUBLISHED' THEN 'saas.trials.campaign_publish' ELSE 'saas.trials.campaign_withdraw' END;
  event:=CASE WHEN NEW.kind='PUBLISHED' THEN 'saas.trials.campaign_published' ELSE 'saas.trials.campaign_withdrawn' END;entity:='TRIAL_PUBLICATION';field:='publication';data:=hon.saas_trial_publication_json(NEW);
  IF NEW.kind='PUBLISHED' THEN
   SELECT * INTO d FROM hon.saas_trial_policy_decisions ORDER BY revision DESC LIMIT 1;
   IF NEW.policy_decision_id IS DISTINCT FROM d.id OR d.decision<>'APPROVED' OR d.valid_from>clock_timestamp() OR d.valid_until<=clock_timestamp()
    OR (SELECT (definition->>'enrollmentClosesAt')::timestamptz FROM hon.saas_trial_campaign_versions WHERE id=NEW.version_id)<=clock_timestamp() THEN RAISE EXCEPTION 'SAAS_TRIAL_POLICY_REQUIRED' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM hon.saas_requests r JOIN hon.saas_audit a USING(actor_principal_id,idempotency_key) JOIN hon.saas_outbox o ON o.audit_id=a.id
  WHERE r.actor_principal_id=NEW.actor_principal_id AND r.idempotency_key=NEW.idempotency_key AND r.status='COMPLETED' AND r.operation=v_operation
   AND r.response_body->field=data AND a.action_code=v_operation AND a.entity_type=entity AND a.entity_id=NEW.id AND a.organization_id IS NULL AND a.next_state=data AND o.event_type=event)
 THEN RAISE EXCEPTION 'SAAS_TRIAL_EVIDENCE_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION hon.read_saas_trial_governance(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
 PERFORM hon.require_saas_hq_actor(p_subject,false);
 SELECT jsonb_build_object('scope','CUSTOMER_TRIAL_GOVERNANCE_ONLY',
  'program',(SELECT jsonb_build_object('status',status,'signupEnabled',signup_enabled,'enrollmentEnabled',enrollment_enabled,'promotionalIssuanceEnabled',promotional_issuance_enabled) FROM hon.saas_trial_program),
  'policyVersions',(SELECT coalesce(jsonb_agg(hon.saas_trial_policy_json(x) ORDER BY version DESC),'[]') FROM hon.saas_trial_policy_versions x WHERE id IN (SELECT id FROM hon.saas_trial_policy_versions ORDER BY version DESC LIMIT 100)),
  'policyDecisions',(SELECT coalesce(jsonb_agg(hon.saas_trial_decision_json(x) ORDER BY revision DESC),'[]') FROM hon.saas_trial_policy_decisions x WHERE id IN (SELECT id FROM hon.saas_trial_policy_decisions ORDER BY revision DESC LIMIT 100)),
  'campaignVersions',(SELECT coalesce(jsonb_agg(hon.saas_trial_campaign_json(x) ORDER BY recorded_at DESC,id DESC),'[]') FROM hon.saas_trial_campaign_versions x WHERE id IN (SELECT id FROM hon.saas_trial_campaign_versions ORDER BY recorded_at DESC,id DESC LIMIT 100)),
  'publications',(SELECT coalesce(jsonb_agg(hon.saas_trial_publication_json(x) ORDER BY recorded_at DESC,id DESC),'[]') FROM hon.saas_trial_publications x WHERE id IN (SELECT id FROM hon.saas_trial_publications ORDER BY recorded_at DESC,id DESC LIMIT 100)),
  'limit',100,'hasMore',jsonb_build_object('policyVersions',(SELECT count(*)>100 FROM hon.saas_trial_policy_versions),'policyDecisions',(SELECT count(*)>100 FROM hon.saas_trial_policy_decisions),'campaignVersions',(SELECT count(*)>100 FROM hon.saas_trial_campaign_versions),'publications',(SELECT count(*)>100 FROM hon.saas_trial_publications)),
  'existingPrograms',jsonb_build_object('paidAccess',(SELECT status FROM hon.saas_access_program),'aiCredits',(SELECT status FROM hon.saas_credit_program),'payments',(SELECT status FROM hon.saas_payment_program)),
  'asOf',hon.saas_ts(clock_timestamp())) INTO result;
 RETURN result;
END $$;
CREATE FUNCTION hon.read_saas_trial_campaign(p_subject text,p_campaign uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
 PERFORM hon.require_saas_hq_actor(p_subject,false);
 IF p_campaign IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM hon.saas_trial_campaign_versions WHERE campaign_id=p_campaign) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002';END IF;
 RETURN jsonb_build_object('campaignId',p_campaign,
  'versions',(SELECT coalesce(jsonb_agg(hon.saas_trial_campaign_json(x) ORDER BY version DESC),'[]') FROM hon.saas_trial_campaign_versions x WHERE id IN (SELECT id FROM hon.saas_trial_campaign_versions WHERE campaign_id=p_campaign ORDER BY version DESC LIMIT 100)),
  'publications',(SELECT coalesce(jsonb_agg(hon.saas_trial_publication_json(x) ORDER BY revision DESC),'[]') FROM hon.saas_trial_publications x WHERE id IN (SELECT id FROM hon.saas_trial_publications WHERE campaign_id=p_campaign ORDER BY revision DESC LIMIT 100)),
  'limit',100,'hasMore',jsonb_build_object('versions',(SELECT count(*)>100 FROM hon.saas_trial_campaign_versions WHERE campaign_id=p_campaign),'publications',(SELECT count(*)>100 FROM hon.saas_trial_publications WHERE campaign_id=p_campaign)),
  'activationAvailable',false,'asOf',hon.saas_ts(clock_timestamp()));
END $$;
CREATE FUNCTION hon.preview_saas_trial_publication(p_subject text,p_version uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN PERFORM hon.require_saas_hq_actor(p_subject,false);RETURN hon.saas_trial_preview(p_version);END $$;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['saas_trial_program','saas_trial_policy_versions','saas_trial_policy_decisions','saas_trial_campaign_versions','saas_trial_publications'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  IF t<>'saas_trial_program' THEN
   EXECUTE format('CREATE TRIGGER saas_trial_authority BEFORE INSERT ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_trial_insert()',t);
   EXECUTE format('CREATE CONSTRAINT TRIGGER saas_trial_evidence AFTER INSERT ON hon.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_trial_evidence()',t);
  END IF;
 END LOOP;
END $$;

ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (action_code IN ('saas.catalog.draft','saas.catalog.publish',
  'saas.founder.reserve','saas.founder.release','saas.subscription.record','saas.subscription.command',
  'saas.invoice.draft','saas.invoice.command','saas.payment.evidence',
  'saas.credits.program','saas.credits.cost_evidence','saas.credits.pricing_draft','saas.credits.pricing_publish',
  'saas.credits.allowance','saas.credits.reserve','saas.credits.settle','saas.credits.resolve',
  'saas.refund.request','saas.refund.decide','saas.rewards.fulfillment','saas.rewards.apply','saas.rewards.credit_apply','saas.rewards.alert_resolve',
  'saas.payments.program','saas.checkout.create','saas.checkout.attach','saas.checkout.cancel','saas.checkout.sweep','saas.provider.event',
  'saas.access.await','saas.access.retry',
  'saas.offers.draft','saas.offers.revise','saas.offers.discard','saas.offers.publish','saas.offers.stop_sales',
  'saas.checkout.create_hon_os','saas.access.initialize',
  'saas.access.exception_grant','saas.access.exception_revoke','saas.access.exception_close','saas.access.exception_policy','saas.trials.policy_propose','saas.trials.policy_decide','saas.trials.campaign_draft','saas.trials.campaign_publish','saas.trials.campaign_withdraw'));

ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (entity_type IN ('CATALOG','FOUNDER_RESERVATION','SUBSCRIPTION',
  'INVOICE','PAYMENT_EVIDENCE','CREDIT_PROGRAM','COST_EVIDENCE','PRICING','ALLOWANCE','CREDIT_RESERVATION','REFUND_REQUEST','REWARD_FULFILLMENT',
  'REWARD_APPLICATION','REFERRAL_ALERT','PAYMENT_PROGRAM','CHECKOUT','PROVIDER_EVENT','ACCESS_STATE','OFFER_SET','OFFER','ACCESS_EXCEPTION','ACCESS_EXCEPTION_POLICY','TRIAL_POLICY','TRIAL_POLICY_DECISION','TRIAL_CAMPAIGN_VERSION','TRIAL_PUBLICATION'));

ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (event_type IN ('saas.catalog.drafted','saas.catalog.published',
  'saas.founder.reserved','saas.founder.released','saas.subscription.recorded','saas.subscription.changed',
  'saas.invoice.drafted','saas.invoice.changed','saas.payment.evidence_recorded',
  'saas.credits.program_changed','saas.credits.cost_recorded','saas.credits.pricing_drafted','saas.credits.pricing_published',
  'saas.credits.allowance_changed','saas.credits.reserved','saas.credits.settled','saas.credits.resolved',
  'saas.refund.requested','saas.refund.decided','saas.rewards.fulfillment_changed','saas.rewards.applied','saas.rewards.credit_applied',
  'saas.rewards.alert_resolved','saas.payments.program_changed','saas.checkout.created','saas.checkout.changed','saas.checkouts.swept',
  'saas.provider.event_recorded','saas.access.awaiting','saas.access.retried',
  'saas.offers.drafted','saas.offers.revised','saas.offers.discarded','saas.offers.published','saas.offers.sales_stopped',
  'saas.access.initialized','saas.access.exception_granted','saas.access.exception_ended','saas.access.exceptions_closed','saas.access.exception_policy_decided','saas.trials.policy_proposed','saas.trials.policy_decided','saas.trials.campaign_drafted','saas.trials.campaign_published','saas.trials.campaign_withdrawn'));

-- Exact private table/column/function ACLs. No public/signup/activation or issuance function exists.
DO $$ DECLARE r text;t text;c text;f text;BEGIN
 FOREACH t IN ARRAY ARRAY['saas_trial_program','saas_trial_policy_versions','saas_trial_policy_decisions','saas_trial_campaign_versions','saas_trial_publications'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);END LOOP;
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
   FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r);END LOOP;
  END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['hon.saas_trial_keys(jsonb,text[])','hon.saas_trial_uint(jsonb,bigint,bigint)','hon.saas_trial_choices(jsonb,jsonb)','hon.saas_trial_timestamp(jsonb)','hon.saas_trial_policy_valid(jsonb)','hon.saas_trial_campaign_valid(jsonb)','hon.saas_trial_policy_json(hon.saas_trial_policy_versions)','hon.saas_trial_decision_json(hon.saas_trial_policy_decisions)','hon.saas_trial_campaign_json(hon.saas_trial_campaign_versions)','hon.saas_trial_publication_json(hon.saas_trial_publications)','hon.saas_trial_begin(text,uuid,text,jsonb,uuid,uuid)','hon.saas_trial_preview(uuid)','hon.propose_saas_trial_policy(text,jsonb,uuid,uuid,uuid)','hon.decide_saas_trial_policy(text,jsonb,uuid,uuid,uuid)','hon.draft_saas_trial_campaign(text,jsonb,uuid,uuid,uuid)','hon.publish_saas_trial_campaign(text,uuid,jsonb,uuid,uuid,uuid)','hon.withdraw_saas_trial_campaign(text,uuid,jsonb,uuid,uuid,uuid)','hon.guard_saas_trial_insert()','hon.verify_saas_trial_evidence()','hon.read_saas_trial_governance(text)','hon.read_saas_trial_campaign(text,uuid)','hon.preview_saas_trial_publication(text,uuid)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
 GRANT EXECUTE ON FUNCTION hon.propose_saas_trial_policy(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.decide_saas_trial_policy(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.draft_saas_trial_campaign(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.publish_saas_trial_campaign(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.withdraw_saas_trial_campaign(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.read_saas_trial_governance(text) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.read_saas_trial_campaign(text,uuid) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.preview_saas_trial_publication(text,uuid) TO hon_runtime;
 END IF;
END $$;

COMMIT;
