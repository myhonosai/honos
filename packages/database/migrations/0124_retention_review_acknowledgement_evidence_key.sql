BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Retention acknowledgement requires trusted migration owner'; END IF;
END $$;

-- 0123 is applied history. Retain every existing acknowledgement/receipt/audit/
-- inert outbox row, even if an evidence observation was acknowledged twice.
-- Block the old command's writes while choosing one canonical acknowledgement.
LOCK TABLE hon.retention_review_acknowledgements,hon.retention_review_acknowledgement_receipts,hon.retention_review_acknowledgement_outbox IN ACCESS EXCLUSIVE MODE;
CREATE TABLE hon.retention_review_acknowledgement_evidence_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL, school_id uuid NOT NULL,
 membership_id uuid NOT NULL, actor_principal_id uuid NOT NULL,
 evidence_version text NOT NULL CHECK(evidence_version='RETENTION_REVIEW_SIGNALS_V1'),
 evidence_fingerprint text NOT NULL CHECK(evidence_fingerprint ~ '^[0-9a-f]{64}$'),
 observed_at timestamptz NOT NULL, acknowledgement_id uuid NOT NULL UNIQUE,
 CONSTRAINT retention_ack_evidence_natural_key UNIQUE(organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at),
 -- Reserve the evidence key FIRST; only its winner may create the acknowledgement.
 -- Deferral permits that order without ever committing an orphan key or ack.
 CONSTRAINT retention_ack_evidence_ack_fk FOREIGN KEY(acknowledgement_id,organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at)
 REFERENCES hon.retention_review_acknowledgements(id,organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at)
 ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE hon.retention_review_acknowledgement_evidence_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.retention_review_acknowledgement_evidence_keys FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hon.retention_review_acknowledgement_evidence_keys FROM PUBLIC;
CREATE TRIGGER retention_ack_immutable BEFORE UPDATE OR DELETE ON hon.retention_review_acknowledgement_evidence_keys FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER retention_ack_no_truncate BEFORE TRUNCATE ON hon.retention_review_acknowledgement_evidence_keys FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();

-- Complete all ledger DDL before inserting rows: populated seeding schedules
-- deferred FK events, which PostgreSQL correctly refuses to ALTER past.
INSERT INTO hon.retention_review_acknowledgement_evidence_keys(organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at,acknowledgement_id)
SELECT DISTINCT ON(organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at)
 organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at,id
FROM hon.retention_review_acknowledgements
ORDER BY organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at,recorded_at DESC,id DESC;

-- Different idempotency keys may each retain an immutable receipt for ONE ack.
-- The scoped actor/key digest remains unique; existing receipts are unchanged.
ALTER TABLE hon.retention_review_acknowledgement_receipts
 DROP CONSTRAINT retention_review_acknowledgement_receipt_acknowledgement_id_key;

-- Fixed command version 0124. The public signature and redacted response remain
-- unchanged; all direct-human checks, live revalidation and inertness are kept.
CREATE OR REPLACE FUNCTION hon.acknowledge_retention_review_evidence(p_subject text,p_membership uuid,p_version text,p_fingerprint text,p_observed_at timestamptz,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); signals jsonb;
 receipt hon.retention_review_acknowledgement_receipts%ROWTYPE; acknowledgement hon.retention_review_acknowledgements%ROWTYPE;
 key_digest bytea; result jsonb; instant timestamptz; canonical_ack uuid; created boolean:=false;
BEGIN
 actor:=hon.require_retention_acknowledgement_actor(p_subject);
 IF p_membership IS NULL OR p_version IS DISTINCT FROM 'RETENTION_REVIEW_SIGNALS_V1' OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
  OR p_observed_at IS NULL OR NOT isfinite(p_observed_at) OR p_observed_at<>date_trunc('milliseconds',p_observed_at)
  OR p_key IS NULL OR p_request IS NULL OR p_correlation IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 -- Stable alphabetic relation locks close source/authority INSERT/DELETE phantoms.
 LOCK TABLE hon.attendance_records,hon.curriculum_progress_observations,hon.family_access_grants,hon.hq_operator_grants,
  hon.membership_renewal_reviews,hon.membership_renewal_versions,hon.memberships,hon.organization_entitlements,hon.organizations,
  hon.permissions,hon.principal_role_grants,hon.principals,hon.role_permissions,hon.roles,hon.schools,hon.student_curriculum_enrollments,
  hon.student_profiles,hon.testing_candidates,hon.users IN SHARE MODE;
 actor:=hon.require_retention_acknowledgement_actor(p_subject);
 key_digest:=sha256(convert_to(p_key::text,'UTF8'));
 -- Always take the scoped idempotency lock before the evidence lock. Hash
 -- collisions merely serialize unrelated requests; uniqueness lives in the table.
 PERFORM pg_advisory_xact_lock(hashtextextended('retention.ack:'||org::text||':'||school::text||':'||actor::text||':'||p_key::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('retention.ack.evidence:'||jsonb_build_array(org,school,p_membership,actor,p_version,p_fingerprint,
  to_char(p_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text,0));
 -- Recompute after both locks, never from browser evidence. An existing receipt
 -- or evidence key does not bypass current authority/freshness/source checks.
 signals:=hon.read_retention_review_signals(p_subject,p_membership);
 PERFORM hon.require_retention_acknowledgement_actor(p_subject);
 instant:=date_trunc('milliseconds',clock_timestamp());
 IF p_observed_at>instant OR p_observed_at<instant-interval '5 minutes'
  OR hon.retention_review_evidence_fingerprint(signals,p_observed_at) IS DISTINCT FROM p_fingerprint THEN
  RAISE EXCEPTION 'RETENTION_EVIDENCE_CONFLICT' USING ERRCODE='40001';
 END IF;
 SELECT * INTO receipt FROM hon.retention_review_acknowledgement_receipts
 WHERE organization_id=org AND school_id=school AND actor_principal_id=actor AND idempotency_digest=key_digest;
 IF receipt.id IS NOT NULL THEN
  IF receipt.membership_id IS DISTINCT FROM p_membership OR receipt.evidence_version IS DISTINCT FROM p_version
   OR receipt.evidence_fingerprint IS DISTINCT FROM p_fingerprint OR receipt.observed_at IS DISTINCT FROM p_observed_at THEN
   RAISE EXCEPTION 'RETENTION_REPLAY_CONFLICT' USING ERRCODE='40001';
  END IF;
  -- Preserve exact historical receipt replay, including any pre-0124 duplicate.
  SELECT * INTO acknowledgement FROM hon.retention_review_acknowledgements WHERE id=receipt.acknowledgement_id;
 ELSE
  INSERT INTO hon.retention_review_acknowledgement_evidence_keys(organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at,acknowledgement_id)
  VALUES(org,school,p_membership,actor,p_version,p_fingerprint,p_observed_at,gen_random_uuid())
  ON CONFLICT ON CONSTRAINT retention_ack_evidence_natural_key DO NOTHING RETURNING acknowledgement_id INTO canonical_ack;
  created:=FOUND;
  IF created THEN
   INSERT INTO hon.retention_review_acknowledgements(id,organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at,recorded_at)
   VALUES(canonical_ack,org,school,p_membership,actor,p_version,p_fingerprint,p_observed_at,instant) RETURNING * INTO acknowledgement;
  ELSE
   SELECT acknowledgement_id INTO STRICT canonical_ack FROM hon.retention_review_acknowledgement_evidence_keys
   WHERE organization_id=org AND school_id=school AND membership_id=p_membership AND actor_principal_id=actor
    AND evidence_version=p_version AND evidence_fingerprint=p_fingerprint AND observed_at=p_observed_at;
   SELECT * INTO STRICT acknowledgement FROM hon.retention_review_acknowledgements WHERE id=canonical_ack;
  END IF;
 END IF;
 result:=jsonb_build_object('schemaVersion','RETENTION_REVIEW_ACKNOWLEDGEMENT_V1','membershipId',p_membership,
  'acknowledgementId',acknowledgement.id,'evidenceVersion',p_version,'evidenceFingerprint',p_fingerprint,
  'observedAt',to_char(p_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'recordedAt',to_char(acknowledgement.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'state','EVIDENCE_REVIEWED','humanOnly',true,'evidenceOnly',true,'noDownstreamEffect',true);
 IF receipt.id IS NULL THEN
  INSERT INTO hon.retention_review_acknowledgement_receipts(organization_id,school_id,membership_id,actor_principal_id,acknowledgement_id,idempotency_digest,evidence_version,evidence_fingerprint,observed_at)
  VALUES(org,school,p_membership,actor,acknowledgement.id,key_digest,p_version,p_fingerprint,p_observed_at);
 END IF;
 IF created THEN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
  VALUES(org,school,actor,'HUMAN_UI','retention.review.acknowledge','retention_review_acknowledgement',acknowledgement.id,NULL,result,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.retention_review_acknowledgement_outbox(organization_id,school_id,membership_id,actor_principal_id,acknowledgement_id,evidence_version,evidence_fingerprint,observed_at)
  VALUES(org,school,p_membership,actor,acknowledgement.id,p_version,p_fingerprint,p_observed_at);
 END IF;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION hon.acknowledge_retention_review_evidence(text,uuid,text,text,timestamptz,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON hon.retention_review_acknowledgement_evidence_keys FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.acknowledge_retention_review_evidence(text,uuid,text,text,timestamptz,uuid,uuid,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.acknowledge_retention_review_evidence(text,uuid,text,text,timestamptz,uuid,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
