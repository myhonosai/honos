BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls) AND rolname NOT IN('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Retention attention requires trusted migration owner'; END IF;
END $$;

-- Factual human attention only. OWNER bootstrap follows normal mapping; no other
-- system role or existing human receives implicit alert authority.
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('retention.review.alert.read','Direct human read of known-membership factual attention alerts',true,true),
 ('retention.review.alert.record','Direct human recording of fresh evidence-derived factual attention',true,true),
 ('retention.review.alert.resolve','Direct human no-note resolution of exact factual attention',true,true)
ON CONFLICT(code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
WHERE r.is_system_role AND r.code='OWNER' AND p.code IN('retention.review.alert.read','retention.review.alert.record','retention.review.alert.resolve') ON CONFLICT DO NOTHING;

CREATE TABLE hon.retention_attention_alerts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 membership_id uuid NOT NULL, actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 evidence_code text NOT NULL CHECK(evidence_code IN('TERM_ENDING_WITHIN_30_DAYS','TERM_ENDED','RENEWAL_REVIEW_NOT_RECORDED','UNEXCUSED_ABSENCE_RECORDED')),
 evidence_version text NOT NULL CHECK(evidence_version='RETENTION_REVIEW_SIGNALS_V1'),
 evidence_fingerprint text NOT NULL CHECK(evidence_fingerprint ~ '^[0-9a-f]{64}$'),
 observed_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
 CHECK(isfinite(observed_at) AND observed_at=date_trunc('milliseconds',observed_at)),
 CHECK(created_at>=observed_at AND created_at<=observed_at+interval '5 minutes'),
 UNIQUE(id,organization_id,school_id,membership_id),
 CONSTRAINT retention_attention_natural_key UNIQUE(organization_id,school_id,membership_id,evidence_code,evidence_version,evidence_fingerprint,observed_at),
 FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT
);
-- OPEN/version 1 is derived from the root; RESOLVED/version 2 only from this
-- single immutable history record. Neither root nor history is ever updated.
CREATE TABLE hon.retention_attention_resolutions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 membership_id uuid NOT NULL, alert_id uuid NOT NULL UNIQUE, actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 expected_alert_version integer NOT NULL CHECK(expected_alert_version=1),
 resolution_reason text NOT NULL CHECK(resolution_reason IN('REVIEW_COMPLETED','EVIDENCE_CHANGED','NO_FURTHER_REVIEW_NEEDED')),
 resolved_at timestamptz NOT NULL,
 UNIQUE(id,organization_id,school_id,membership_id,alert_id),
 FOREIGN KEY(alert_id,organization_id,school_id,membership_id) REFERENCES hon.retention_attention_alerts(id,organization_id,school_id,membership_id) ON DELETE RESTRICT
);
CREATE TABLE hon.retention_attention_record_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 membership_id uuid NOT NULL, actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 alert_id uuid NOT NULL, idempotency_digest bytea NOT NULL CHECK(octet_length(idempotency_digest)=32),
 UNIQUE(organization_id,school_id,actor_principal_id,idempotency_digest),
 FOREIGN KEY(alert_id,organization_id,school_id,membership_id) REFERENCES hon.retention_attention_alerts(id,organization_id,school_id,membership_id) ON DELETE RESTRICT
);
CREATE TABLE hon.retention_attention_resolution_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 membership_id uuid NOT NULL, actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 alert_id uuid NOT NULL, resolution_id uuid NOT NULL UNIQUE,
 idempotency_digest bytea NOT NULL CHECK(octet_length(idempotency_digest)=32),
 UNIQUE(organization_id,school_id,actor_principal_id,idempotency_digest),
 FOREIGN KEY(resolution_id,organization_id,school_id,membership_id,alert_id) REFERENCES hon.retention_attention_resolutions(id,organization_id,school_id,membership_id,alert_id) ON DELETE RESTRICT
);
CREATE TABLE hon.retention_attention_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 membership_id uuid NOT NULL, alert_id uuid NOT NULL,
 fact_version integer NOT NULL CHECK(fact_version IN(1,2)),
 event_code text NOT NULL CHECK((fact_version=1 AND event_code='retention.factual_attention_recorded.v1') OR (fact_version=2 AND event_code='retention.factual_attention_resolved.v1')),
 state text NOT NULL DEFAULT 'INERT' CHECK(state='INERT'),
 UNIQUE(alert_id,fact_version),
 FOREIGN KEY(alert_id,organization_id,school_id,membership_id) REFERENCES hon.retention_attention_alerts(id,organization_id,school_id,membership_id) ON DELETE RESTRICT
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['retention_attention_alerts','retention_attention_resolutions','retention_attention_record_receipts','retention_attention_resolution_receipts','retention_attention_outbox'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  EXECUTE format('CREATE TRIGGER retention_attention_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history()',t);
  EXECUTE format('CREATE TRIGGER retention_attention_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history()',t);
 END LOOP;
END $$;

CREATE FUNCTION hon.require_retention_attention_actor(p_subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); instant timestamptz:=clock_timestamp();
BEGIN
 actor:=hon.require_retention_review_actor(p_subject);
 IF p_permission IS NULL OR p_permission NOT IN('retention.review.alert.read','retention.review.alert.record','retention.review.alert.resolve')
  OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
  OR NOT EXISTS(SELECT 1 FROM hon.organizations WHERE id=org AND status='ACTIVE')
  OR NOT EXISTS(SELECT 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE')
  OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor AND effective_from<=instant AND (effective_until IS NULL OR effective_until>instant))
  OR EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id WHERE g.principal_id=actor AND g.revoked_at IS NULL AND g.effective_from<=instant AND (g.effective_until IS NULL OR g.effective_until>instant) AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
  OR (SELECT count(*) FROM hon.organization_entitlements WHERE organization_id=org AND status='ACTIVE' AND tier IN('ESSENTIAL','CORE','COMPLETE') AND effective_from<=instant AND (effective_until IS NULL OR effective_until>instant))<>1
  OR (SELECT count(DISTINCT rp.permission_code) FROM hon.principal_role_grants g
   JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
   JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
   JOIN hon.permissions p ON p.code=rp.permission_code AND p.is_sensitive AND p.is_staff_assignable
   WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school
    AND g.revoked_at IS NULL AND g.effective_from<=instant AND (g.effective_until IS NULL OR g.effective_until>instant)
    AND (r.management_school_id IS NULL OR r.management_school_id=school)
    AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
    AND rp.permission_code IN('retention.review.read',p_permission))<>2 THEN
  RAISE EXCEPTION 'RETENTION_ATTENTION_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 RETURN actor;
END $$;

-- Closed derivation from only the already displayed redacted facts. Missing
-- attendance/progression is never negative evidence and never an attention code.
CREATE FUNCTION hon.retention_attention_codes(p_signals jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT to_jsonb(array_remove(ARRAY[
  CASE WHEN p_signals#>>'{membershipTerm,endingObservation}'='ENDING_WITHIN_30_DAYS' THEN 'TERM_ENDING_WITHIN_30_DAYS' END,
  CASE WHEN p_signals#>>'{membershipTerm,endingObservation}'='TERM_ENDED' THEN 'TERM_ENDED' END,
  CASE WHEN p_signals#>>'{renewalReview,reason}'='NO_EXPLICIT_RENEWAL_REVIEW_RECORDED' THEN 'RENEWAL_REVIEW_NOT_RECORDED' END,
  CASE WHEN p_signals#>>'{attendance,status}'='AVAILABLE' AND (p_signals#>>'{attendance,unexcusedAbsenceCount}')::bigint>0 THEN 'UNEXCUSED_ABSENCE_RECORDED' END
 ]::text[],NULL))
$$;
CREATE FUNCTION hon.retention_attention_projection(p_alert uuid,p_include_resolution boolean) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('membershipId',a.membership_id,'alertId',a.id,'evidenceCode',a.evidence_code,
  'observedAt',to_char(a.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'createdAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'alertVersion',CASE WHEN r.id IS NULL THEN 1 ELSE 2 END,'state',CASE WHEN r.id IS NULL THEN 'OPEN' ELSE 'RESOLVED' END,
  'resolvedAt',CASE WHEN r.id IS NULL THEN NULL ELSE to_char(r.resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'resolutionReason',r.resolution_reason)
 FROM hon.retention_attention_alerts a LEFT JOIN hon.retention_attention_resolutions r ON r.alert_id=a.id AND r.organization_id=a.organization_id AND r.school_id=a.school_id AND r.membership_id=a.membership_id AND p_include_resolution
 WHERE a.id=p_alert AND a.organization_id=hon.current_organization_id() AND a.school_id=hon.current_school_id()
$$;
CREATE FUNCTION hon.read_retention_attention_alerts(p_subject text,p_membership uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
 PERFORM hon.require_retention_attention_actor(p_subject,'retention.review.alert.read');
 IF p_membership IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 PERFORM hon.read_retention_review_signals(p_subject,p_membership);
 -- Bounded one-membership history, newest 50; never a school-wide list/directory.
 SELECT coalesce(jsonb_agg(hon.retention_attention_projection(a.id,true) ORDER BY a.created_at DESC,a.id DESC),'[]'::jsonb) INTO result
 FROM (SELECT id,created_at FROM hon.retention_attention_alerts WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND membership_id=p_membership ORDER BY created_at DESC,id DESC LIMIT 50) a;
 PERFORM hon.require_retention_attention_actor(p_subject,'retention.review.alert.read');
 RETURN jsonb_build_object('membershipId',p_membership,'alerts',result);
END $$;
CREATE FUNCTION hon.read_retention_attention_evidence(p_subject text,p_membership uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE signals jsonb;
BEGIN
 PERFORM hon.require_retention_attention_actor(p_subject,'retention.review.alert.record');
 signals:=hon.read_retention_review_signals(p_subject,p_membership);
 PERFORM hon.require_retention_attention_actor(p_subject,'retention.review.alert.record');
 RETURN jsonb_build_object('signals',signals,'evidenceVersion','RETENTION_REVIEW_SIGNALS_V1',
  'evidenceFingerprint',hon.retention_review_evidence_fingerprint(signals,(signals->>'observedAt')::timestamptz),'attentionCodes',hon.retention_attention_codes(signals));
END $$;

CREATE FUNCTION hon.record_retention_attention_alert(p_subject text,p_membership uuid,p_version text,p_fingerprint text,p_observed_at timestamptz,p_code text,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); signals jsonb;
 receipt hon.retention_attention_record_receipts%ROWTYPE; alert hon.retention_attention_alerts%ROWTYPE;
 key_digest bytea; result jsonb; instant timestamptz; created boolean:=false;
BEGIN
 actor:=hon.require_retention_attention_actor(p_subject,'retention.review.alert.record');
 IF p_membership IS NULL OR p_version IS DISTINCT FROM 'RETENTION_REVIEW_SIGNALS_V1' OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
  OR p_observed_at IS NULL OR NOT isfinite(p_observed_at) OR p_observed_at<>date_trunc('milliseconds',p_observed_at)
  OR p_code IS NULL OR p_code NOT IN('TERM_ENDING_WITHIN_30_DAYS','TERM_ENDED','RENEWAL_REVIEW_NOT_RECORDED','UNEXCUSED_ABSENCE_RECORDED')
  OR p_key IS NULL OR p_request IS NULL OR p_correlation IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 -- Same deliberately coarse bounded manual-command locks as acknowledgement;
 -- close source and authorization phantoms. No source record is written.
 LOCK TABLE hon.attendance_records,hon.curriculum_progress_observations,hon.family_access_grants,hon.hq_operator_grants,
  hon.membership_renewal_reviews,hon.membership_renewal_versions,hon.memberships,hon.organization_entitlements,hon.organizations,
  hon.permissions,hon.principal_role_grants,hon.principals,hon.role_permissions,hon.roles,hon.schools,hon.student_curriculum_enrollments,
  hon.student_profiles,hon.testing_candidates,hon.users IN SHARE MODE;
 actor:=hon.require_retention_attention_actor(p_subject,'retention.review.alert.record');
 key_digest:=sha256(convert_to(p_key::text,'UTF8'));
 PERFORM pg_advisory_xact_lock(hashtextextended('retention.attention.record:'||org::text||':'||school::text||':'||actor::text||':'||p_key::text,0));
 -- Actor is intentionally NOT part of the school-wide natural evidence key.
 PERFORM pg_advisory_xact_lock(hashtextextended('retention.attention.evidence:'||jsonb_build_array(org,school,p_membership,p_code,p_version,p_fingerprint,
  to_char(p_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text,0));
 signals:=hon.read_retention_review_signals(p_subject,p_membership);
 PERFORM hon.require_retention_attention_actor(p_subject,'retention.review.alert.record');
 instant:=date_trunc('milliseconds',clock_timestamp());
 IF p_observed_at>instant OR p_observed_at<instant-interval '5 minutes'
  OR hon.retention_review_evidence_fingerprint(signals,p_observed_at) IS DISTINCT FROM p_fingerprint
  OR NOT(hon.retention_attention_codes(signals) ? p_code) THEN RAISE EXCEPTION 'RETENTION_EVIDENCE_CONFLICT' USING ERRCODE='40001'; END IF;
 SELECT * INTO receipt FROM hon.retention_attention_record_receipts WHERE organization_id=org AND school_id=school AND actor_principal_id=actor AND idempotency_digest=key_digest;
 IF receipt.id IS NOT NULL THEN
  SELECT * INTO STRICT alert FROM hon.retention_attention_alerts WHERE id=receipt.alert_id;
  IF alert.membership_id IS DISTINCT FROM p_membership OR alert.evidence_version IS DISTINCT FROM p_version OR alert.evidence_fingerprint IS DISTINCT FROM p_fingerprint OR alert.observed_at IS DISTINCT FROM p_observed_at OR alert.evidence_code IS DISTINCT FROM p_code THEN RAISE EXCEPTION 'RETENTION_REPLAY_CONFLICT' USING ERRCODE='40001'; END IF;
 ELSE
  INSERT INTO hon.retention_attention_alerts(organization_id,school_id,membership_id,actor_principal_id,evidence_code,evidence_version,evidence_fingerprint,observed_at,created_at)
  VALUES(org,school,p_membership,actor,p_code,p_version,p_fingerprint,p_observed_at,instant)
  ON CONFLICT ON CONSTRAINT retention_attention_natural_key DO NOTHING RETURNING * INTO alert;
  created:=FOUND;
  IF NOT created THEN
   SELECT * INTO STRICT alert FROM hon.retention_attention_alerts WHERE organization_id=org AND school_id=school AND membership_id=p_membership AND evidence_code=p_code AND evidence_version=p_version AND evidence_fingerprint=p_fingerprint AND observed_at=p_observed_at;
  END IF;
  INSERT INTO hon.retention_attention_record_receipts(organization_id,school_id,membership_id,actor_principal_id,alert_id,idempotency_digest) VALUES(org,school,p_membership,actor,alert.id,key_digest);
 END IF;
 -- Immutable creation receipt, not a claim about later current state. UI must
 -- reload the fixed alert read after a command before displaying current state.
 result:=hon.retention_attention_projection(alert.id,false);
 IF created THEN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
  VALUES(org,school,actor,'HUMAN_UI','retention.review.alert.record','retention_attention_alert',alert.id,NULL,result,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.retention_attention_outbox(organization_id,school_id,membership_id,alert_id,fact_version,event_code) VALUES(org,school,p_membership,alert.id,1,'retention.factual_attention_recorded.v1');
 END IF;
 PERFORM hon.require_retention_attention_actor(p_subject,'retention.review.alert.record');
 RETURN result;
END $$;

CREATE FUNCTION hon.resolve_retention_attention_alert(p_subject text,p_membership uuid,p_alert uuid,p_expected_version integer,p_reason text,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); alert hon.retention_attention_alerts%ROWTYPE;
 receipt hon.retention_attention_resolution_receipts%ROWTYPE; resolution hon.retention_attention_resolutions%ROWTYPE;
 key_digest bytea; result jsonb;
BEGIN
 actor:=hon.require_retention_attention_actor(p_subject,'retention.review.alert.resolve');
 IF p_membership IS NULL OR p_alert IS NULL OR p_expected_version IS DISTINCT FROM 1 OR p_reason IS NULL OR p_reason NOT IN('REVIEW_COMPLETED','EVIDENCE_CHANGED','NO_FURTHER_REVIEW_NEEDED') OR p_key IS NULL OR p_request IS NULL OR p_correlation IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 LOCK TABLE hon.family_access_grants,hon.hq_operator_grants,hon.memberships,hon.organization_entitlements,hon.organizations,
  hon.permissions,hon.principal_role_grants,hon.principals,hon.role_permissions,hon.roles,hon.schools,hon.users IN SHARE MODE;
 actor:=hon.require_retention_attention_actor(p_subject,'retention.review.alert.resolve');
 key_digest:=sha256(convert_to(p_key::text,'UTF8'));
 PERFORM pg_advisory_xact_lock(hashtextextended('retention.attention.resolve:'||org::text||':'||school::text||':'||actor::text||':'||p_key::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('retention.attention.alert:'||org::text||':'||school::text||':'||p_alert::text,0));
 PERFORM hon.require_retention_attention_actor(p_subject,'retention.review.alert.resolve');
 SELECT * INTO alert FROM hon.retention_attention_alerts WHERE id=p_alert AND organization_id=org AND school_id=school AND membership_id=p_membership;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM hon.memberships WHERE id=p_membership AND organization_id=org AND school_id=school) THEN RAISE EXCEPTION 'RETENTION_REVIEW_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 SELECT * INTO receipt FROM hon.retention_attention_resolution_receipts WHERE organization_id=org AND school_id=school AND actor_principal_id=actor AND idempotency_digest=key_digest;
 IF receipt.id IS NOT NULL THEN
  SELECT * INTO STRICT resolution FROM hon.retention_attention_resolutions WHERE id=receipt.resolution_id;
  IF receipt.membership_id IS DISTINCT FROM p_membership OR receipt.alert_id IS DISTINCT FROM p_alert OR resolution.expected_alert_version IS DISTINCT FROM p_expected_version OR resolution.resolution_reason IS DISTINCT FROM p_reason THEN RAISE EXCEPTION 'RETENTION_REPLAY_CONFLICT' USING ERRCODE='40001'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM hon.retention_attention_resolutions WHERE alert_id=p_alert) THEN RAISE EXCEPTION 'RETENTION_ALERT_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.retention_attention_resolutions(organization_id,school_id,membership_id,alert_id,actor_principal_id,expected_alert_version,resolution_reason,resolved_at)
  VALUES(org,school,p_membership,p_alert,actor,p_expected_version,p_reason,date_trunc('milliseconds',clock_timestamp())) RETURNING * INTO resolution;
  INSERT INTO hon.retention_attention_resolution_receipts(organization_id,school_id,membership_id,actor_principal_id,alert_id,resolution_id,idempotency_digest) VALUES(org,school,p_membership,actor,p_alert,resolution.id,key_digest);
  result:=hon.retention_attention_projection(p_alert,true);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
  VALUES(org,school,actor,'HUMAN_UI','retention.review.alert.resolve','retention_attention_alert',p_alert,hon.retention_attention_projection(p_alert,false),result,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.retention_attention_outbox(organization_id,school_id,membership_id,alert_id,fact_version,event_code) VALUES(org,school,p_membership,p_alert,2,'retention.factual_attention_resolved.v1');
 END IF;
 PERFORM hon.require_retention_attention_actor(p_subject,'retention.review.alert.resolve');
 RETURN hon.retention_attention_projection(p_alert,true);
END $$;

DO $$ DECLARE r text; t text; f text; BEGIN
 FOREACH f IN ARRAY ARRAY['require_retention_attention_actor(text,text)','retention_attention_codes(jsonb)','retention_attention_projection(uuid,boolean)','read_retention_attention_alerts(text,uuid)','read_retention_attention_evidence(text,uuid)','record_retention_attention_alert(text,uuid,text,text,timestamptz,text,uuid,uuid,uuid)','resolve_retention_attention_alert(text,uuid,uuid,integer,text,uuid,uuid,uuid)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM PUBLIC',f);
 END LOOP;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  FOREACH t IN ARRAY ARRAY['retention_attention_alerts','retention_attention_resolutions','retention_attention_record_receipts','retention_attention_resolution_receipts','retention_attention_outbox'] LOOP
   EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['require_retention_attention_actor(text,text)','retention_attention_codes(jsonb)','retention_attention_projection(uuid,boolean)','read_retention_attention_alerts(text,uuid)','read_retention_attention_evidence(text,uuid)','record_retention_attention_alert(text,uuid,text,text,timestamptz,text,uuid,uuid,uuid)','resolve_retention_attention_alert(text,uuid,uuid,integer,text,uuid,uuid,uuid)'] LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM %I',f,r);
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.read_retention_attention_alerts(text,uuid),hon.read_retention_attention_evidence(text,uuid),hon.record_retention_attention_alert(text,uuid,text,text,timestamptz,text,uuid,uuid,uuid),hon.resolve_retention_attention_alert(text,uuid,uuid,integer,text,uuid,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
