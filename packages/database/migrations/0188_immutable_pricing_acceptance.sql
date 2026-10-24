BEGIN;

-- Commercial A2: financial disclosure/acceptance evidence ONLY. No publication, checkout, provider,
-- paid-period counting, subscription, entitlement or AI issuance. 0179/0180 remain reserved.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
  AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
END $$;

CREATE TABLE hon.saas_price_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), offer_id uuid NOT NULL REFERENCES hon.saas_offer_set_offers(id),
 offer_set_id uuid NOT NULL REFERENCES hon.saas_offer_sets(id), offer_set_version integer NOT NULL,
 offer_set_revision integer NOT NULL, version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999),
 renewal_offer_id uuid NOT NULL REFERENCES hon.saas_offer_set_offers(id), terms jsonb NOT NULL,
 accepted_offer jsonb NOT NULL, accepted_offer_digest text NOT NULL CHECK(accepted_offer_digest ~ '^[0-9a-f]{64}$'),
 disclosure_version text NOT NULL CHECK(disclosure_version='HON_OS_PRICING_EN_V1'), disclosure_text text NOT NULL,
 terms_reference text NOT NULL, refund_terms jsonb NOT NULL, cancellation_terms jsonb NOT NULL,
 schedule_digest text NOT NULL CHECK(schedule_digest ~ '^[0-9a-f]{64}$'), reason text NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), idempotency_key uuid NOT NULL, recorded_at timestamptz NOT NULL,
 UNIQUE(offer_id,version), FOREIGN KEY(actor_principal_id,idempotency_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key),
 UNIQUE(actor_principal_id,idempotency_key)
);
CREATE TABLE hon.saas_price_acceptances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), schedule_id uuid NOT NULL REFERENCES hon.saas_price_schedules(id),
 organization_id uuid NOT NULL REFERENCES hon.organizations(id), school_id uuid NOT NULL REFERENCES hon.schools(id),
 schedule_digest text NOT NULL CHECK(schedule_digest ~ '^[0-9a-f]{64}$'),
 acceptance_digest text NOT NULL CHECK(acceptance_digest ~ '^[0-9a-f]{64}$'),
 disclosure_version text NOT NULL CHECK(disclosure_version='HON_OS_PRICING_EN_V1'), disclosure_text text NOT NULL,
 confirmation text NOT NULL CHECK(confirmation='ACCEPT_INITIAL_AND_SCHEDULED_RENEWAL_PRICES'),
 -- No authoritative Commercial C allocation contract exists yet. Founder acceptance must fail closed.
 founder_allocation_id uuid CHECK(founder_allocation_id IS NULL),
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), idempotency_key uuid NOT NULL, accepted_at timestamptz NOT NULL,
 UNIQUE(organization_id,school_id,schedule_id),
 FOREIGN KEY(actor_principal_id,idempotency_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key),
 UNIQUE(actor_principal_id,idempotency_key)
);

CREATE FUNCTION hon.saas_price_usd(p integer) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$ SELECT '$'||to_char(p::numeric/100,'FM999,999,990.00') $$;

-- Every amount is read from the SAME immutable published set, never supplied by the purchaser.
-- A schedule is a new explicit generation, not a reinterpretation of an old subscription/checkout.
CREATE FUNCTION hon.saas_price_content(p_offer uuid,p_renewal uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE o hon.saas_offer_set_offers%ROWTYPE; r hon.saas_offer_set_offers%ROWTYPE; s hon.saas_offer_sets%ROWTYPE;
 monthly integer; n integer; introductory integer; annual boolean; founder boolean; disclosure text; terms jsonb; snapshot jsonb;
BEGIN
 SELECT * INTO o FROM hon.saas_offer_set_offers WHERE id=p_offer;
 SELECT * INTO r FROM hon.saas_offer_set_offers WHERE id=p_renewal;
 SELECT * INTO s FROM hon.saas_offer_sets WHERE id=o.set_id;
 IF s.status IS DISTINCT FROM 'PUBLISHED' OR NOT hon.saas_hon_os_offer_on_sale(o,clock_timestamp())
  OR NOT hon.saas_hon_os_offer_on_sale(r,clock_timestamp()) OR r.set_id IS DISTINCT FROM o.set_id THEN
  RAISE EXCEPTION 'SAAS_OFFER_NOT_AVAILABLE' USING ERRCODE='23514'; END IF;
 IF o.offer_kind NOT IN ('REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL')
  THEN RAISE EXCEPTION 'SAAS_PRICE_TERMS_UNSUPPORTED' USING ERRCODE='23514'; END IF;
 annual:=o.billing_interval='ANNUAL'; founder:=o.founder;
 SELECT count(*),min(price_minor) INTO n,monthly FROM hon.saas_offer_set_offers WHERE set_id=s.id AND offer_kind='REGULAR_MONTHLY';
 IF n<>1 OR r.offer_kind IS DISTINCT FROM CASE WHEN annual THEN 'REGULAR_ANNUAL' ELSE 'REGULAR_MONTHLY' END
  OR (NOT founder AND r.id<>o.id) OR o.price_lock<>'NONE' OR r.price_lock<>'NONE'
  OR o.refund_window_days IS NULL OR o.cancellation_timing IS DISTINCT FROM 'END_OF_PAID_PERIOD'
  OR (annual AND o.annual_renewal IS DISTINCT FROM CASE WHEN founder THEN 'AUTO_RENEW_AT_CURRENT_PRICE' ELSE 'AUTO_RENEW_AT_LOCKED_PRICE' END)
  OR (founder AND (o.price_minor>=r.price_minor OR o.price_minor>=monthly::bigint*CASE WHEN annual THEN 12 ELSE 1 END))
  THEN RAISE EXCEPTION 'SAAS_PRICE_TERMS_UNSUPPORTED' USING ERRCODE='23514'; END IF;
 introductory:=CASE WHEN founder THEN CASE WHEN annual THEN 1 ELSE 12 END ELSE 0 END;
 terms:=jsonb_build_object('schemaVersion',1,'productCode','HON_OS','currency','USD','offerKind',o.offer_kind,
  'billingInterval',o.billing_interval,'initialPriceMinor',o.price_minor,'introductoryPaidPeriods',introductory,
  'renewalPriceMinor',r.price_minor,'monthlyListReferenceMinor',monthly,'renewalPriceRule','FIXED_ACCEPTED_SCHEDULE',
  'periodCountingRule','DISTINCT_VERIFIED_PAID_PERIODS','discountStacking','FORBIDDEN',
  'promotionReuse','REQUIRES_ORGANIZATION_PROMOTION_HISTORY','existingCustomerPrices','UNCHANGED');
 disclosure:=CASE
  WHEN o.offer_kind='FOUNDER_MONTHLY' THEN hon.saas_price_usd(o.price_minor)||' per month for the first 12 qualifying paid monthly periods. Thereafter, '||hon.saas_price_usd(r.price_minor)||' per month until canceled under the accepted terms.'
  WHEN o.offer_kind='FOUNDER_ANNUAL' THEN hon.saas_price_usd(o.price_minor)||' for the first annual subscription period. Renews at '||hon.saas_price_usd(r.price_minor)||' annually unless canceled under the accepted terms.'
  WHEN annual THEN hon.saas_price_usd(o.price_minor)||' per annual subscription period. Renews at '||hon.saas_price_usd(r.price_minor)||' annually unless canceled under the accepted terms.'
  ELSE hon.saas_price_usd(o.price_minor)||' per month until canceled under the accepted terms.' END;
 snapshot:=hon.saas_hon_os_accepted_offer(o);
 RETURN jsonb_build_object('offerId',o.id,'offerSetId',s.id,'offerSetVersion',s.set_version,'offerSetRevision',s.revision,
  'renewalOfferId',r.id,'terms',terms,'acceptedOffer',snapshot,'acceptedOfferDigest',hon.saas_hon_os_digest(snapshot),
  'disclosureVersion','HON_OS_PRICING_EN_V1','disclosureLanguage','en','disclosureText',disclosure,
  'termsReference',s.terms_reference,'refundTerms',jsonb_build_object('termsReference',s.terms_reference,'windowDays',o.refund_window_days),
  'cancellationTerms',jsonb_build_object('termsReference',s.terms_reference,'timing',o.cancellation_timing));
END $$;

CREATE FUNCTION hon.saas_price_schedule_json(p hon.saas_price_schedules) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('scheduleId',p.id,'version',p.version,'offerId',p.offer_id,'offerSetId',p.offer_set_id,
 'offerSetVersion',p.offer_set_version,'offerSetRevision',p.offer_set_revision,'renewalOfferId',p.renewal_offer_id,
 'terms',p.terms,'acceptedOffer',p.accepted_offer,'acceptedOfferDigest',p.accepted_offer_digest,
 'disclosureVersion',p.disclosure_version,'disclosureLanguage','en','disclosureText',p.disclosure_text,
 'termsReference',p.terms_reference,'refundTerms',p.refund_terms,'cancellationTerms',p.cancellation_terms,
 'scheduleDigest',p.schedule_digest,'actorPrincipalId',p.actor_principal_id,'recordedAt',hon.saas_ts(p.recorded_at),
 'providerBinding','UNAVAILABLE_COMMERCIAL_B','billingEnabled',false)
$$;
CREATE FUNCTION hon.saas_price_acceptance_json(p hon.saas_price_acceptances) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('acceptanceId',p.id,'organizationId',p.organization_id,'schoolId',p.school_id,
 'schedule',(SELECT hon.saas_price_schedule_json(s) FROM hon.saas_price_schedules s WHERE s.id=p.schedule_id),
 'scheduleDigest',p.schedule_digest,'acceptanceDigest',p.acceptance_digest,'disclosureVersion',p.disclosure_version,
 'disclosureText',p.disclosure_text,'confirmation',p.confirmation,'founderAllocationId',p.founder_allocation_id,
 'actorPrincipalId',p.actor_principal_id,'idempotencyKey',p.idempotency_key,'acceptedAt',hon.saas_ts(p.accepted_at),
 'paymentStatus','NOT_AUTHORIZED','subscriptionStatus','NOT_CREATED','accessGranted',false,'paidPeriodEvidence','NOT_IMPLEMENTED_COMMERCIAL_B')
$$;

-- Same IAM order as the existing purchaser/HQ commands, with additional authorization inputs protected.
-- No organization, entitlement, inventory, checkout, subscription or trial lock is acquired afterwards.
CREATE FUNCTION hon.saas_price_lock_authority() RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
 LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.family_access_grants,hon.hq_operator_grants,
  hon.roles,hon.role_permissions,hon.permissions,hon.organizations,hon.schools IN SHARE MODE;
END $$;

CREATE FUNCTION hon.record_saas_price_schedule(p_subject text,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; replay jsonb; content jsonb; latest integer; created hon.saas_price_schedules%ROWTYPE; at timestamptz;
BEGIN
 IF NOT hon.saas_trial_keys(p,ARRAY['offerId','renewalOfferId','expectedOfferSetRevision','expectedVersion','disclosureVersion','confirmation','reason'])
  OR coalesce(p->>'offerId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(p->>'renewalOfferId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR NOT hon.saas_trial_uint(p->'expectedOfferSetRevision',1,999999999) OR NOT hon.saas_trial_uint(p->'expectedVersion',0,999999998)
  OR p->>'disclosureVersion' IS DISTINCT FROM 'HON_OS_PRICING_EN_V1'
  OR p->>'confirmation' IS DISTINCT FROM 'RECORD_IMMUTABLE_PRICING_SCHEDULE_ONLY'
  OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string' OR length(p->>'reason') NOT BETWEEN 10 AND 500
  OR p->>'reason'<>btrim(p->>'reason') THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
 actor:=hon.require_saas_hq_actor(p_subject,true); PERFORM hon.saas_price_lock_authority();actor:=hon.require_saas_hq_actor(p_subject,true);
 replay:=hon.saas_claim_request(actor,p_key,'saas.price_schedule.record',hon.saas_fingerprint(ARRAY['saas.price_schedule.record',p::text]),p_request,p_correlation);
 IF replay IS NOT NULL THEN PERFORM hon.require_saas_hq_actor(p_subject,true); RETURN replay; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('saas.offer_sets',0));
 LOCK TABLE hon.saas_offer_sets,hon.saas_offer_sales_stops IN SHARE MODE;
 PERFORM hon.require_saas_hq_actor(p_subject,true);
 content:=hon.saas_price_content((p->>'offerId')::uuid,(p->>'renewalOfferId')::uuid);
 SELECT coalesce(max(version),0) INTO latest FROM hon.saas_price_schedules WHERE offer_id=(p->>'offerId')::uuid;
 IF latest<>(p->>'expectedVersion')::int OR (content->>'offerSetRevision')::int<>(p->>'expectedOfferSetRevision')::int
  THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 at:=clock_timestamp();
 INSERT INTO hon.saas_price_schedules(offer_id,offer_set_id,offer_set_version,offer_set_revision,version,renewal_offer_id,terms,
  accepted_offer,accepted_offer_digest,disclosure_version,disclosure_text,terms_reference,refund_terms,cancellation_terms,
  schedule_digest,reason,actor_principal_id,idempotency_key,recorded_at)
 VALUES((content->>'offerId')::uuid,(content->>'offerSetId')::uuid,(content->>'offerSetVersion')::int,(content->>'offerSetRevision')::int,
  latest+1,(content->>'renewalOfferId')::uuid,content->'terms',content->'acceptedOffer',content->>'acceptedOfferDigest',
  content->>'disclosureVersion',content->>'disclosureText',content->>'termsReference',content->'refundTerms',content->'cancellationTerms',
  hon.saas_hon_os_digest(content||jsonb_build_object('version',latest+1)),p->>'reason',actor,p_key,at) RETURNING * INTO created;
 RETURN hon.saas_record(actor,p_key,'saas.price_schedule.record','saas.price_schedule.recorded','PRICE_SCHEDULE',created.id,NULL,NULL,
  hon.saas_price_schedule_json(created),jsonb_build_object('schedule',hon.saas_price_schedule_json(created)),at);
END $$;

CREATE FUNCTION hon.saas_price_acceptance_preview(p_org uuid,p_school uuid,p_schedule uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE s hon.saas_price_schedules%ROWTYPE; content jsonb; blockers jsonb:='[]'; digest text;
BEGIN
 SELECT * INTO s FROM hon.saas_price_schedules WHERE id=p_schedule;
 IF s.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 BEGIN
  content:=hon.saas_price_content(s.offer_id,s.renewal_offer_id);
  IF hon.saas_hon_os_digest(content||jsonb_build_object('version',s.version))<>s.schedule_digest
   THEN blockers:=blockers||'"SCHEDULE_CHANGED"'::jsonb; END IF;
 EXCEPTION WHEN check_violation THEN blockers:=blockers||'"OFFER_NOT_AVAILABLE"'::jsonb; END;
 IF s.version<>(SELECT max(version) FROM hon.saas_price_schedules WHERE offer_id=s.offer_id) THEN blockers:=blockers||'"SCHEDULE_SUPERSEDED"'::jsonb; END IF;
 IF s.terms->>'offerKind' LIKE 'FOUNDER_%' THEN blockers:=blockers||'"FOUNDER_ALLOCATION_CONTRACT_UNAVAILABLE"'::jsonb; END IF;
 IF EXISTS(SELECT 1 FROM hon.saas_price_acceptances WHERE organization_id=p_org AND school_id=p_school AND schedule_id=s.id)
  THEN blockers:=blockers||'"ALREADY_ACCEPTED"'::jsonb; END IF;
 digest:=hon.saas_hon_os_digest(jsonb_build_object('organizationId',p_org,'schoolId',p_school,'scheduleId',s.id,'scheduleDigest',s.schedule_digest));
 RETURN jsonb_build_object('organizationId',p_org,'schoolId',p_school,'schedule',hon.saas_price_schedule_json(s),
  'acceptanceDigest',digest,'canAcknowledge',jsonb_array_length(blockers)=0,'blockers',blockers,
  'purchaseAvailable',false,'paymentAuthorized',false,'accessGranted',false,'asOf',hon.saas_ts(clock_timestamp()));
END $$;
CREATE FUNCTION hon.preview_saas_price_acceptance(p_subject text,p_school uuid,p_schedule uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor record;
BEGIN SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
 RETURN hon.saas_price_acceptance_preview(actor.organization_id,p_school,p_schedule); END $$;

CREATE FUNCTION hon.accept_saas_price_schedule(p_subject text,p_school uuid,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor record; replay jsonb; preview jsonb; s hon.saas_price_schedules%ROWTYPE; created hon.saas_price_acceptances%ROWTYPE; at timestamptz;
BEGIN
 IF NOT hon.saas_trial_keys(p,ARRAY['scheduleId','scheduleDigest','acceptanceDigest','confirmation'])
  OR coalesce(p->>'scheduleId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(p->>'scheduleDigest','') !~ '^[0-9a-f]{64}$'
  OR coalesce(p->>'acceptanceDigest','') !~ '^[0-9a-f]{64}$' OR p->>'confirmation' IS DISTINCT FROM 'ACCEPT_INITIAL_AND_SCHEDULED_RENEWAL_PRICES'
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
 PERFORM hon.saas_price_lock_authority(); SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
 replay:=hon.saas_claim_request(actor.principal_id,p_key,'saas.price_schedule.accept',hon.saas_fingerprint(ARRAY['saas.price_schedule.accept',p_school::text,p::text]),p_request,p_correlation);
 IF replay IS NOT NULL THEN PERFORM hon.require_saas_school_purchaser(p_subject,p_school); RETURN replay; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('saas.offer_sets',0));
 LOCK TABLE hon.saas_offer_sets,hon.saas_offer_sales_stops IN SHARE MODE;
 SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
 preview:=hon.saas_price_acceptance_preview(actor.organization_id,p_school,(p->>'scheduleId')::uuid);
 IF preview->'schedule'->>'scheduleDigest' IS DISTINCT FROM p->>'scheduleDigest' OR preview->>'acceptanceDigest' IS DISTINCT FROM p->>'acceptanceDigest'
  THEN RAISE EXCEPTION 'SAAS_PRICE_PREVIEW_STALE' USING ERRCODE='40001'; END IF;
 IF (preview->>'canAcknowledge')::boolean IS NOT true THEN RAISE EXCEPTION 'SAAS_PRICE_ACCEPTANCE_BLOCKED' USING ERRCODE='23514'; END IF;
 SELECT * INTO s FROM hon.saas_price_schedules WHERE id=(p->>'scheduleId')::uuid;
 at:=clock_timestamp();
 INSERT INTO hon.saas_price_acceptances(schedule_id,organization_id,school_id,schedule_digest,acceptance_digest,disclosure_version,
  disclosure_text,confirmation,actor_principal_id,idempotency_key,accepted_at)
 VALUES(s.id,actor.organization_id,p_school,s.schedule_digest,preview->>'acceptanceDigest',s.disclosure_version,s.disclosure_text,
  p->>'confirmation',actor.principal_id,p_key,at) RETURNING * INTO created;
 RETURN hon.saas_record(actor.principal_id,p_key,'saas.price_schedule.accept','saas.price_schedule.accepted','PRICE_ACCEPTANCE',created.id,actor.organization_id,NULL,
  hon.saas_price_acceptance_json(created),jsonb_build_object('acceptance',hon.saas_price_acceptance_json(created)),at);
END $$;

CREATE FUNCTION hon.read_saas_price_schedule(p_subject text,p_schedule uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s hon.saas_price_schedules%ROWTYPE;
BEGIN PERFORM hon.require_saas_hq_actor(p_subject,false); SELECT * INTO s FROM hon.saas_price_schedules WHERE id=p_schedule;
 IF s.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF; RETURN hon.saas_price_schedule_json(s); END $$;
CREATE FUNCTION hon.read_saas_price_acceptance(p_subject text,p_school uuid,p_acceptance uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor record; a hon.saas_price_acceptances%ROWTYPE;
BEGIN SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
 SELECT * INTO a FROM hon.saas_price_acceptances WHERE id=p_acceptance AND organization_id=actor.organization_id AND school_id=p_school;
 IF a.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF; RETURN hon.saas_price_acceptance_json(a); END $$;

-- INSERT guards recompute facts, and deferred evidence checks refuse incomplete/forged commands at COMMIT.
-- No session variable confers authority. Runtime has no INSERT privilege or helper execution privilege.
CREATE FUNCTION hon.guard_saas_price_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject text; content jsonb; actor record; preview jsonb; op text;
BEGIN
 SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=NEW.actor_principal_id;
 IF TG_TABLE_NAME='saas_price_schedules' THEN
  PERFORM hon.require_saas_hq_actor(subject,true);op:='saas.price_schedule.record';
  content:=hon.saas_price_content(NEW.offer_id,NEW.renewal_offer_id);
  IF NEW.version<>(SELECT coalesce(max(version),0)+1 FROM hon.saas_price_schedules WHERE offer_id=NEW.offer_id)
   OR content IS DISTINCT FROM jsonb_build_object('offerId',NEW.offer_id,'offerSetId',NEW.offer_set_id,'offerSetVersion',NEW.offer_set_version,
    'offerSetRevision',NEW.offer_set_revision,'renewalOfferId',NEW.renewal_offer_id,'terms',NEW.terms,'acceptedOffer',NEW.accepted_offer,
    'acceptedOfferDigest',NEW.accepted_offer_digest,'disclosureVersion',NEW.disclosure_version,'disclosureLanguage','en','disclosureText',NEW.disclosure_text,
    'termsReference',NEW.terms_reference,'refundTerms',NEW.refund_terms,'cancellationTerms',NEW.cancellation_terms)
   OR NEW.schedule_digest<>hon.saas_hon_os_digest(content||jsonb_build_object('version',NEW.version))
   THEN RAISE EXCEPTION 'SAAS_PRICE_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(subject,NEW.school_id);op:='saas.price_schedule.accept';
  preview:=hon.saas_price_acceptance_preview(actor.organization_id,NEW.school_id,NEW.schedule_id);
  IF actor.principal_id<>NEW.actor_principal_id OR actor.organization_id<>NEW.organization_id OR (preview->>'canAcknowledge')::boolean IS NOT true
   OR NEW.schedule_digest IS DISTINCT FROM preview->'schedule'->>'scheduleDigest' OR NEW.acceptance_digest IS DISTINCT FROM preview->>'acceptanceDigest'
   OR NEW.disclosure_version IS DISTINCT FROM preview->'schedule'->>'disclosureVersion'
   OR NEW.disclosure_text IS DISTINCT FROM preview->'schedule'->>'disclosureText'
   THEN RAISE EXCEPTION 'SAAS_PRICE_ACCEPTANCE_BLOCKED' USING ERRCODE='23514'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM hon.saas_requests WHERE actor_principal_id=NEW.actor_principal_id AND idempotency_key=NEW.idempotency_key
  AND operation=op AND status='IN_PROGRESS') THEN RAISE EXCEPTION 'SAAS_PRICE_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION hon.verify_saas_price_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject text; op text; event text; entity text; field text; data jsonb; org uuid; s hon.saas_price_schedules%ROWTYPE;
BEGIN
 SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=NEW.actor_principal_id;
 IF TG_TABLE_NAME='saas_price_schedules' THEN
  PERFORM hon.require_saas_hq_actor(subject,true);op:='saas.price_schedule.record';event:='saas.price_schedule.recorded';entity:='PRICE_SCHEDULE';field:='schedule';data:=hon.saas_price_schedule_json(NEW);s:=NEW;
 ELSE
  PERFORM hon.require_saas_school_purchaser(subject,NEW.school_id);op:='saas.price_schedule.accept';event:='saas.price_schedule.accepted';entity:='PRICE_ACCEPTANCE';field:='acceptance';data:=hon.saas_price_acceptance_json(NEW);org:=NEW.organization_id;
  SELECT * INTO s FROM hon.saas_price_schedules WHERE id=NEW.schedule_id;
 END IF;
 -- Clock expiry during a long transaction cannot acknowledge a now-withdrawn offer.
 PERFORM hon.saas_price_content(s.offer_id,s.renewal_offer_id);
 IF NOT EXISTS(SELECT 1 FROM hon.saas_requests r JOIN hon.saas_audit a USING(actor_principal_id,idempotency_key) JOIN hon.saas_outbox o ON o.audit_id=a.id
  WHERE r.actor_principal_id=NEW.actor_principal_id AND r.idempotency_key=NEW.idempotency_key AND r.status='COMPLETED' AND r.operation=op
   AND r.response_body->field=data AND a.action_code=op AND a.entity_type=entity AND a.entity_id=NEW.id
   AND a.organization_id IS NOT DISTINCT FROM org AND a.next_state=data AND o.event_type=event AND o.payload->>'executionAllowed'='false')
  THEN RAISE EXCEPTION 'SAAS_PRICE_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION hon.guard_saas_price_provider_boundary() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM hon.saas_price_schedules WHERE offer_id=NEW.hon_os_offer_id)
  THEN RAISE EXCEPTION 'SAAS_PRICE_PROVIDER_BINDING_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER saas_price_provider_boundary BEFORE INSERT ON hon.saas_checkout_sessions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_price_provider_boundary();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['saas_price_schedules','saas_price_acceptances'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  EXECUTE format('CREATE TRIGGER saas_price_authority BEFORE INSERT ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_price_insert()',t);
  EXECUTE format('CREATE CONSTRAINT TRIGGER saas_price_evidence AFTER INSERT ON hon.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_price_evidence()',t);
 END LOOP;
END $$;

-- Extend closed vocabularies without dropping any D9/D10/D11-A values.
DO $$ DECLARE def text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_action_code_check';
 ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
 EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR action_code IN (''saas.price_schedule.record'',''saas.price_schedule.accept''))';
 SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_entity_type_check';
 ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
 EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR entity_type IN (''PRICE_SCHEDULE'',''PRICE_ACCEPTANCE''))';
 SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_outbox'::regclass AND conname='saas_outbox_event_type_check';
 ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
 EXECUTE 'ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR event_type IN (''saas.price_schedule.recorded'',''saas.price_schedule.accepted''))';
END $$;

DO $$ DECLARE r text;t text;c text;f text;BEGIN
 FOREACH t IN ARRAY ARRAY['saas_price_schedules','saas_price_acceptances'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
   FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
  END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['hon.saas_price_usd(integer)','hon.saas_price_content(uuid,uuid)',
  'hon.saas_price_schedule_json(hon.saas_price_schedules)','hon.saas_price_acceptance_json(hon.saas_price_acceptances)',
  'hon.saas_price_lock_authority()','hon.record_saas_price_schedule(text,jsonb,uuid,uuid,uuid)',
  'hon.saas_price_acceptance_preview(uuid,uuid,uuid)','hon.preview_saas_price_acceptance(text,uuid,uuid)',
  'hon.accept_saas_price_schedule(text,uuid,jsonb,uuid,uuid,uuid)','hon.read_saas_price_schedule(text,uuid)',
  'hon.read_saas_price_acceptance(text,uuid,uuid)','hon.guard_saas_price_insert()','hon.verify_saas_price_evidence()',
  'hon.guard_saas_price_provider_boundary()'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.record_saas_price_schedule(text,jsonb,uuid,uuid,uuid),hon.preview_saas_price_acceptance(text,uuid,uuid),
   hon.accept_saas_price_schedule(text,uuid,jsonb,uuid,uuid,uuid),hon.read_saas_price_schedule(text,uuid),hon.read_saas_price_acceptance(text,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
