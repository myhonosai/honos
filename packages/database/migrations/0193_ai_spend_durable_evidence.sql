BEGIN;
-- S4-a durable AI usage evidence (AI-14, AI-16, AI-5 for agent rows). Owner decisions AI-D6 and AI-D7 (2026-10-31).
-- A provider result that has already been charged is always recorded, even when access lapses while the call
-- is in flight. Recording and failing check only tenant, requester and SENDING state (evidence-only actor);
-- turning a result into an approval proposal keeps the full existing access gate. If access has lapsed, the
-- result is kept as RESULT_HELD / ACCESS_LAPSED and becomes a proposal only after access returns.
-- No new spend path, no policy value, no program change. Begin/prepare/bind keep the existing gates.

CREATE FUNCTION hon.ai_evidence_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
-- Resolves the direct human requester only. Deliberately checks no entitlement, role, permission or school
-- status: callers additionally require organization, school, requested_by and SENDING/RESULT_RECORDED state.
DECLARE actor uuid;
BEGIN
 PERFORM hon.require_tenant_context();
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI' OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=p_subject AND p.principal_type='HUMAN_USER' AND p.id::text=current_setting('app.hon_principal_id',true);
 IF actor IS NULL THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;

-- One ledger row per agent invocation (AI-5). Existing rows and B3 provider-usage rows keep NULL.
ALTER TABLE hon.ai_usage_ledger ADD COLUMN source_invocation_id uuid;
CREATE UNIQUE INDEX ai_usage_ledger_source_invocation_uidx ON hon.ai_usage_ledger(source_invocation_id) WHERE source_invocation_id IS NOT NULL;

ALTER TABLE hon.marketing_ai_invocations DROP CONSTRAINT marketing_ai_invocations_status_check, DROP CONSTRAINT marketing_ai_invocations_reason_check,
 ADD CONSTRAINT marketing_ai_invocations_status_check CHECK(status IN('PENDING','CONFIGURATION_REQUIRED','BLOCKED','SENDING','UNKNOWN','FAILED','RESULT_RECORDED','RESULT_HELD','AWAITING_APPROVAL','SAVED','REJECTED')),
 ADD CONSTRAINT marketing_ai_invocations_reason_check CHECK(reason IN('CONFIGURATION_REQUIRED','NO_ELIGIBLE_ROUTE','CUSTOMER_BUDGET_EXCEEDED','UNSUPPORTED_PROVIDER','INVALID_REQUEST','PROVIDER_REJECTED','PROVIDER_UNKNOWN','ROUTE_STALE','RESULT_BUDGET_EXCEEDED','ACCESS_LAPSED'));
ALTER TABLE hon.teaching_ai_invocations DROP CONSTRAINT teaching_ai_invocations_status_check, DROP CONSTRAINT teaching_ai_invocations_reason_check,
 ADD CONSTRAINT teaching_ai_invocations_status_check CHECK(status IN('PENDING','CONFIGURATION_REQUIRED','BLOCKED','SENDING','UNKNOWN','FAILED','RESULT_RECORDED','RESULT_HELD','AWAITING_APPROVAL','SAVED','REJECTED')),
 ADD CONSTRAINT teaching_ai_invocations_reason_check CHECK(reason IN('CONFIGURATION_REQUIRED','NO_ELIGIBLE_ROUTE','CUSTOMER_BUDGET_EXCEEDED','UNSUPPORTED_PROVIDER','INVALID_REQUEST','PROVIDER_REJECTED','PROVIDER_UNKNOWN','ROUTE_STALE','RESULT_BUDGET_EXCEEDED','ACCESS_LAPSED'));
ALTER TABLE hon.chad_follow_up_invocations DROP CONSTRAINT chad_follow_up_invocations_status_check, DROP CONSTRAINT chad_follow_up_invocations_reason_check,
 ADD CONSTRAINT chad_follow_up_invocations_status_check CHECK(status IN('PENDING','CONFIGURATION_REQUIRED','BLOCKED','SENDING','UNKNOWN','FAILED','RESULT_RECORDED','RESULT_HELD','AWAITING_APPROVAL','APPROVED','REJECTED')),
 ADD CONSTRAINT chad_follow_up_invocations_reason_check CHECK(reason IN('CONFIGURATION_REQUIRED','NO_ELIGIBLE_ROUTE','CUSTOMER_BUDGET_EXCEEDED','UNSUPPORTED_PROVIDER','INVALID_REQUEST','PROVIDER_REJECTED','PROVIDER_UNKNOWN','ROUTE_STALE','RESULT_BUDGET_EXCEEDED','LEAD_STALE','ACCESS_LAPSED'));

-- Replaced record/fail (evidence-only) and bind (full gate, now from RESULT_RECORDED or RESULT_HELD).
CREATE OR REPLACE FUNCTION hon.record_marketing_result(p_subject text, p_id uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$
DECLARE actor uuid:=hon.ai_evidence_actor(p_subject); i hon.marketing_ai_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; uid uuid; credits integer; d jsonb:=p_result->'draft'; over_budget boolean;
BEGIN
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND OR i.status<>'SENDING' OR i.usage_id IS NOT NULL THEN RAISE EXCEPTION 'MARKETING_OUTCOME_REPLAY' USING ERRCODE='40001'; END IF;
 SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id=i.plan_id;
 IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR NOT p_result ?& ARRAY['draft','inputTokens','outputTokens','providerCostMicrounits'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN('draft','inputTokens','outputTokens','providerCostMicrounits')) OR jsonb_typeof(d)<>'object' OR NOT d ?& ARRAY['title','content'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN('title','content')) OR jsonb_typeof(d->'title')<>'string' OR jsonb_typeof(d->'content')<>'string' OR NOT hon.marketing_safe_text(d->>'title',160) OR NOT hon.marketing_safe_text(d->>'content',6000) OR (p_result->>'inputTokens') !~ '^[0-9]+$' OR (p_result->>'outputTokens') !~ '^[0-9]+$' OR (p_result->>'providerCostMicrounits') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_MARKETING_RESULT' USING ERRCODE='22023'; END IF;
 credits:=((p_result->>'inputTokens')::integer+(p_result->>'outputTokens')::integer+999)/1000;
 over_budget:=(p_result->>'inputTokens')::integer>p.input_budget OR (p_result->>'outputTokens')::integer>p.output_budget OR (p_result->>'providerCostMicrounits')::bigint>p.max_provider_cost_microunits OR credits>i.reserved_credits;
 INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,provider_cost_microunits,customer_credits,correlation_id,source_invocation_id)
 VALUES(i.organization_id,i.school_id,actor,i.work_item_id,p.provider_id,p.model_id,'TEXT',(p_result->>'inputTokens')::bigint,(p_result->>'outputTokens')::bigint,(p_result->>'providerCostMicrounits')::bigint,credits,nullif(current_setting('app.hon_request_id',true),'')::uuid,i.id) RETURNING id INTO uid;
 UPDATE hon.marketing_ai_invocations SET usage_id=uid,reserved_credits=0,status=CASE WHEN over_budget THEN 'FAILED' ELSE 'RESULT_RECORDED' END,reason=CASE WHEN over_budget THEN 'RESULT_BUDGET_EXCEEDED' ELSE NULL END,updated_at=clock_timestamp() WHERE id=i.id;
 IF over_budget THEN UPDATE hon.work_items SET status='FAILED',version=version+1 WHERE id=i.work_item_id; PERFORM hon.marketing_event(i.id,'marketing.assistant.budget_failed'); RETURN NULL; END IF;
 INSERT INTO hon.marketing_ai_drafts(invocation_id,organization_id,school_id,campaign_id,title,content) VALUES(i.id,i.organization_id,i.school_id,i.campaign_id,d->>'title',d->>'content'); PERFORM hon.marketing_event(i.id,'marketing.assistant.result_recorded'); RETURN jsonb_build_object('invocationId',i.id,'campaignId',i.campaign_id,'campaignVersion',i.campaign_version,'title',d->>'title','content',d->>'content');
END $function$;

CREATE OR REPLACE FUNCTION hon.fail_marketing_invocation(p_subject text, p_id uuid, p_outcome text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$
DECLARE actor uuid:=hon.ai_evidence_actor(p_subject); i hon.marketing_ai_invocations%ROWTYPE;
BEGIN
 IF p_outcome NOT IN('PRE_SEND','FAILED','UNKNOWN') OR p_reason NOT IN('CONFIGURATION_REQUIRED','UNSUPPORTED_PROVIDER','INVALID_REQUEST','PROVIDER_REJECTED','PROVIDER_UNKNOWN') THEN RAISE EXCEPTION 'INVALID_MARKETING_OUTCOME' USING ERRCODE='22023'; END IF;
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND OR i.status<>'SENDING' THEN RAISE EXCEPTION 'MARKETING_OUTCOME_REPLAY' USING ERRCODE='40001'; END IF;
 UPDATE hon.marketing_ai_invocations SET status=CASE WHEN p_outcome='PRE_SEND' THEN 'CONFIGURATION_REQUIRED' ELSE p_outcome END,reason=p_reason,reserved_credits=CASE WHEN p_outcome='UNKNOWN' THEN reserved_credits ELSE 0 END,updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
 PERFORM hon.marketing_event(i.id,'marketing.assistant.provider_result');
END $function$;

CREATE OR REPLACE FUNCTION hon.bind_marketing_proposal(p_subject text, p_id uuid, p_action uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$
DECLARE actor uuid:=hon.marketing_owner(p_subject); i hon.marketing_ai_invocations%ROWTYPE; d hon.marketing_ai_drafts%ROWTYPE;
BEGIN
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 SELECT * INTO STRICT d FROM hon.marketing_ai_drafts WHERE invocation_id=i.id;
 IF NOT FOUND OR i.status NOT IN('RESULT_RECORDED','RESULT_HELD') OR i.action_request_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM hon.action_requests a WHERE a.id=p_action AND a.organization_id=i.organization_id AND a.school_id=i.school_id AND a.requested_by_principal_id=actor AND a.action_code='marketing.draft.save' AND a.required_permission='marketing.assistant.use' AND a.effective_authority_mode='CONFIRM' AND a.status='AWAITING_APPROVAL' AND a.normalized_payload=jsonb_build_object('invocationId',i.id,'campaignId',i.campaign_id,'campaignVersion',i.campaign_version,'title',d.title,'content',d.content)) THEN RAISE EXCEPTION 'MARKETING_ACTION_BINDING' USING ERRCODE='42501'; END IF;
 UPDATE hon.marketing_ai_invocations SET action_request_id=p_action,status='AWAITING_APPROVAL',updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status='WAITING_FOR_APPROVAL',version=version+1 WHERE id=i.work_item_id;
 PERFORM hon.marketing_event(i.id,'marketing.assistant.drafted');
END $function$;

CREATE FUNCTION hon.read_marketing_result_payload(p_subject text,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
-- Full existing access gate: a recorded or held result becomes an approval proposal only while access is current.
DECLARE actor uuid:=hon.marketing_owner(p_subject); i hon.marketing_ai_invocations%ROWTYPE; d hon.marketing_ai_drafts%ROWTYPE;
BEGIN
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND OR i.status NOT IN('RESULT_RECORDED','RESULT_HELD') OR i.action_request_id IS NOT NULL THEN RETURN NULL; END IF;
 SELECT * INTO STRICT d FROM hon.marketing_ai_drafts WHERE invocation_id=i.id;
 RETURN jsonb_build_object('invocationId',i.id,'campaignId',i.campaign_id,'campaignVersion',i.campaign_version,'title',d.title,'content',d.content);
END $$;
CREATE FUNCTION hon.hold_marketing_result(p_subject text,p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
-- Evidence-only actor. Holds a recorded result ONLY when the full access gate now refuses (AI-D7).
DECLARE actor uuid:=hon.ai_evidence_actor(p_subject); i hon.marketing_ai_invocations%ROWTYPE; lapsed boolean:=false;
BEGIN
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND OR i.status<>'RESULT_RECORDED' OR i.action_request_id IS NOT NULL THEN RAISE EXCEPTION 'MARKETING_HOLD_REPLAY' USING ERRCODE='40001'; END IF;
 BEGIN PERFORM hon.marketing_owner(p_subject); EXCEPTION WHEN insufficient_privilege THEN lapsed:=true; END;
 IF NOT lapsed THEN RAISE EXCEPTION 'AI_ACCESS_NOT_LAPSED' USING ERRCODE='55000'; END IF;
 UPDATE hon.marketing_ai_invocations SET status='RESULT_HELD',reason='ACCESS_LAPSED',updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
 PERFORM hon.marketing_event(i.id,'marketing.assistant.result_held');
END $$;

CREATE OR REPLACE FUNCTION hon.record_teaching_result(p_subject text, p_id uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$
DECLARE actor uuid:=hon.ai_evidence_actor(p_subject); i hon.teaching_ai_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; uid uuid; credits integer; d jsonb:=p_result->'draft'; over boolean;
BEGIN SELECT * INTO i FROM hon.teaching_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE; IF NOT FOUND OR i.status<>'SENDING' OR i.usage_id IS NOT NULL THEN RAISE EXCEPTION 'TEACHING_OUTCOME_REPLAY' USING ERRCODE='40001'; END IF; SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id=i.plan_id; IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR NOT p_result?&ARRAY['draft','inputTokens','outputTokens','providerCostMicrounits'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN('draft','inputTokens','outputTokens','providerCostMicrounits')) OR jsonb_typeof(d)<>'object' OR NOT d?&ARRAY['title','content'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN('title','content')) OR jsonb_typeof(d->'title')<>'string' OR jsonb_typeof(d->'content')<>'string' OR NOT hon.teaching_assistant_safe_text(d->>'title',160) OR NOT hon.teaching_assistant_safe_text(d->>'content',6000) OR (p_result->>'inputTokens')!~'^[0-9]+$' OR (p_result->>'outputTokens')!~'^[0-9]+$' OR (p_result->>'providerCostMicrounits')!~'^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_TEACHING_RESULT' USING ERRCODE='22023'; END IF; credits:=((p_result->>'inputTokens')::integer+(p_result->>'outputTokens')::integer+999)/1000; over:=(p_result->>'inputTokens')::integer>p.input_budget OR (p_result->>'outputTokens')::integer>p.output_budget OR (p_result->>'providerCostMicrounits')::bigint>p.max_provider_cost_microunits OR credits>i.reserved_credits; INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,provider_cost_microunits,customer_credits,correlation_id,source_invocation_id) VALUES(i.organization_id,i.school_id,actor,i.work_item_id,p.provider_id,p.model_id,'TEXT',(p_result->>'inputTokens')::bigint,(p_result->>'outputTokens')::bigint,(p_result->>'providerCostMicrounits')::bigint,credits,nullif(current_setting('app.hon_request_id',true),'')::uuid,i.id) RETURNING id INTO uid; UPDATE hon.teaching_ai_invocations SET usage_id=uid,reserved_credits=0,status=CASE WHEN over THEN 'FAILED' ELSE 'RESULT_RECORDED' END,reason=CASE WHEN over THEN 'RESULT_BUDGET_EXCEEDED' ELSE NULL END,updated_at=clock_timestamp() WHERE id=i.id; IF over THEN UPDATE hon.work_items SET status='FAILED',version=version+1 WHERE id=i.work_item_id; PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.budget_failed'); RETURN NULL; END IF; INSERT INTO hon.teaching_ai_drafts(invocation_id,organization_id,school_id,curriculum_id,title,content) VALUES(i.id,i.organization_id,i.school_id,i.curriculum_id,d->>'title',d->>'content'); PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.result_recorded'); RETURN jsonb_build_object('invocationId',i.id,'curriculumId',i.curriculum_id,'curriculumVersion',i.curriculum_version,'title',d->>'title','content',d->>'content'); END $function$;

CREATE OR REPLACE FUNCTION hon.fail_teaching_invocation(p_subject text, p_id uuid, p_outcome text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$ DECLARE actor uuid:=hon.ai_evidence_actor(p_subject); i hon.teaching_ai_invocations%ROWTYPE; BEGIN IF p_outcome NOT IN('PRE_SEND','FAILED','UNKNOWN') OR p_reason NOT IN('CONFIGURATION_REQUIRED','UNSUPPORTED_PROVIDER','INVALID_REQUEST','PROVIDER_REJECTED','PROVIDER_UNKNOWN') THEN RAISE EXCEPTION 'INVALID_TEACHING_OUTCOME' USING ERRCODE='22023'; END IF; SELECT * INTO i FROM hon.teaching_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE; IF NOT FOUND OR i.status<>'SENDING' THEN RAISE EXCEPTION 'TEACHING_OUTCOME_REPLAY' USING ERRCODE='40001'; END IF; UPDATE hon.teaching_ai_invocations SET status=CASE WHEN p_outcome='PRE_SEND' THEN 'CONFIGURATION_REQUIRED' ELSE p_outcome END,reason=p_reason,reserved_credits=CASE WHEN p_outcome='UNKNOWN' THEN reserved_credits ELSE 0 END,updated_at=clock_timestamp() WHERE id=i.id; UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1 WHERE id=i.work_item_id; PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.provider_result'); END $function$;

CREATE OR REPLACE FUNCTION hon.bind_teaching_proposal(p_subject text, p_id uuid, p_action uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$ DECLARE actor uuid:=hon.require_teaching_assistant_actor(p_subject,true); i hon.teaching_ai_invocations%ROWTYPE; d hon.teaching_ai_drafts%ROWTYPE; BEGIN SELECT * INTO i FROM hon.teaching_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE; SELECT * INTO STRICT d FROM hon.teaching_ai_drafts WHERE invocation_id=i.id; IF NOT FOUND OR i.status NOT IN('RESULT_RECORDED','RESULT_HELD') OR i.action_request_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM hon.action_requests a WHERE a.id=p_action AND a.organization_id=i.organization_id AND a.school_id=i.school_id AND a.requested_by_principal_id=actor AND a.action_code='teaching.draft.save' AND a.required_permission='teaching.assistant.use' AND a.effective_authority_mode='CONFIRM' AND a.status='AWAITING_APPROVAL' AND a.normalized_payload=jsonb_build_object('invocationId',i.id,'curriculumId',i.curriculum_id,'curriculumVersion',i.curriculum_version,'title',d.title,'content',d.content)) THEN RAISE EXCEPTION 'TEACHING_ACTION_BINDING' USING ERRCODE='42501'; END IF; UPDATE hon.teaching_ai_invocations SET action_request_id=p_action,status='AWAITING_APPROVAL',updated_at=clock_timestamp() WHERE id=i.id; UPDATE hon.work_items SET status='WAITING_FOR_APPROVAL',version=version+1 WHERE id=i.work_item_id; PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.drafted'); END $function$;

CREATE FUNCTION hon.read_teaching_result_payload(p_subject text,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
-- Full existing access gate: a recorded or held result becomes an approval proposal only while access is current.
DECLARE actor uuid:=hon.require_teaching_assistant_actor(p_subject,true); i hon.teaching_ai_invocations%ROWTYPE; d hon.teaching_ai_drafts%ROWTYPE;
BEGIN
 SELECT * INTO i FROM hon.teaching_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND OR i.status NOT IN('RESULT_RECORDED','RESULT_HELD') OR i.action_request_id IS NOT NULL THEN RETURN NULL; END IF;
 SELECT * INTO STRICT d FROM hon.teaching_ai_drafts WHERE invocation_id=i.id;
 RETURN jsonb_build_object('invocationId',i.id,'curriculumId',i.curriculum_id,'curriculumVersion',i.curriculum_version,'title',d.title,'content',d.content);
END $$;
CREATE FUNCTION hon.hold_teaching_result(p_subject text,p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
-- Evidence-only actor. Holds a recorded result ONLY when the full access gate now refuses (AI-D7).
DECLARE actor uuid:=hon.ai_evidence_actor(p_subject); i hon.teaching_ai_invocations%ROWTYPE; lapsed boolean:=false;
BEGIN
 SELECT * INTO i FROM hon.teaching_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND OR i.status<>'RESULT_RECORDED' OR i.action_request_id IS NOT NULL THEN RAISE EXCEPTION 'TEACHING_HOLD_REPLAY' USING ERRCODE='40001'; END IF;
 BEGIN PERFORM hon.require_teaching_assistant_actor(p_subject,true); EXCEPTION WHEN insufficient_privilege THEN lapsed:=true; END;
 IF NOT lapsed THEN RAISE EXCEPTION 'AI_ACCESS_NOT_LAPSED' USING ERRCODE='55000'; END IF;
 UPDATE hon.teaching_ai_invocations SET status='RESULT_HELD',reason='ACCESS_LAPSED',updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
 PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.result_held');
END $$;

CREATE OR REPLACE FUNCTION hon.record_chad_follow_up_result(p_subject text, p_id uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$ DECLARE actor uuid:=hon.ai_evidence_actor(p_subject);i hon.chad_follow_up_invocations%ROWTYPE;p hon.ai_invocation_plans%ROWTYPE;d jsonb:=p_result->'draft';uid uuid;credits integer;over boolean;BEGIN SELECT * INTO i FROM hon.chad_follow_up_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;IF NOT FOUND OR i.status<>'SENDING' OR i.usage_id IS NOT NULL THEN RAISE EXCEPTION 'CHAD_FOLLOW_UP_OUTCOME_REPLAY' USING ERRCODE='40001';END IF;SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id=i.plan_id;IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR NOT p_result ?& ARRAY['draft','inputTokens','outputTokens','providerCostMicrounits'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN('draft','inputTokens','outputTokens','providerCostMicrounits')) OR jsonb_typeof(d)<>'object' OR NOT d ?& ARRAY['subject','content'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN('subject','content')) OR jsonb_typeof(d->'subject')<>'string' OR jsonb_typeof(d->'content')<>'string' OR length(btrim(d->>'subject')) NOT BETWEEN 1 AND 120 OR length(btrim(d->>'content')) NOT BETWEEN 1 AND 3000 OR (p_result->>'inputTokens')!~'^[0-9]+$' OR (p_result->>'outputTokens')!~'^[0-9]+$' OR (p_result->>'providerCostMicrounits')!~'^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_CHAD_FOLLOW_UP_RESULT' USING ERRCODE='22023';END IF;credits:=((p_result->>'inputTokens')::integer+(p_result->>'outputTokens')::integer+999)/1000;over:=(p_result->>'inputTokens')::integer>p.input_budget OR (p_result->>'outputTokens')::integer>p.output_budget OR (p_result->>'providerCostMicrounits')::bigint>p.max_provider_cost_microunits OR credits>i.reserved_credits;INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,provider_cost_microunits,customer_credits,correlation_id,source_invocation_id) VALUES(i.organization_id,i.school_id,actor,i.work_item_id,p.provider_id,p.model_id,'TEXT',(p_result->>'inputTokens')::bigint,(p_result->>'outputTokens')::bigint,(p_result->>'providerCostMicrounits')::bigint,credits,nullif(current_setting('app.hon_request_id',true),'')::uuid,i.id) RETURNING id INTO uid;UPDATE hon.chad_follow_up_invocations SET usage_id=uid,reserved_credits=0,status=CASE WHEN over THEN 'FAILED' ELSE 'RESULT_RECORDED' END,reason=CASE WHEN over THEN 'RESULT_BUDGET_EXCEEDED' ELSE NULL END,updated_at=clock_timestamp() WHERE id=i.id;IF over THEN UPDATE hon.work_items SET status='FAILED',version=version+1 WHERE id=i.work_item_id;PERFORM hon.chad_follow_up_event(i.id,'chad.follow_up_draft.budget_failed');RETURN NULL;END IF;INSERT INTO hon.chad_follow_up_drafts(invocation_id,organization_id,school_id,lead_id,subject,content) VALUES(i.id,i.organization_id,i.school_id,i.lead_id,d->>'subject',d->>'content'); PERFORM hon.chad_follow_up_event(i.id,'chad.follow_up_draft.result_recorded'); RETURN jsonb_build_object('invocationId',i.id,'leadId',i.lead_id,'leadVersion',i.lead_version,'purpose',i.purpose,'subject',d->>'subject','content',d->>'content','delivery','NOT_CREATED_OR_SENT');END $function$;

CREATE OR REPLACE FUNCTION hon.fail_chad_follow_up_invocation(p_subject text, p_id uuid, p_outcome text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$ DECLARE actor uuid:=hon.ai_evidence_actor(p_subject);i hon.chad_follow_up_invocations%ROWTYPE;BEGIN IF p_outcome NOT IN('PRE_SEND','FAILED','UNKNOWN') OR p_reason NOT IN('CONFIGURATION_REQUIRED','UNSUPPORTED_PROVIDER','INVALID_REQUEST','PROVIDER_REJECTED','PROVIDER_UNKNOWN') THEN RAISE EXCEPTION 'INVALID_CHAD_FOLLOW_UP_OUTCOME' USING ERRCODE='22023';END IF;SELECT * INTO i FROM hon.chad_follow_up_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;IF NOT FOUND OR i.status<>'SENDING' THEN RAISE EXCEPTION 'CHAD_FOLLOW_UP_OUTCOME_REPLAY' USING ERRCODE='40001';END IF;UPDATE hon.chad_follow_up_invocations SET status=CASE WHEN p_outcome='PRE_SEND' THEN 'CONFIGURATION_REQUIRED' ELSE p_outcome END,reason=p_reason,reserved_credits=CASE WHEN p_outcome='UNKNOWN' THEN reserved_credits ELSE 0 END,updated_at=clock_timestamp() WHERE id=i.id;UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1 WHERE id=i.work_item_id;PERFORM hon.chad_follow_up_event(i.id,'chad.follow_up_draft.provider_result');END $function$;

CREATE OR REPLACE FUNCTION hon.bind_chad_follow_up_proposal(p_subject text, p_id uuid, p_action uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$ DECLARE actor uuid:=hon.require_chad_follow_up_actor(p_subject);i hon.chad_follow_up_invocations%ROWTYPE;d hon.chad_follow_up_drafts%ROWTYPE;BEGIN SELECT * INTO i FROM hon.chad_follow_up_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;SELECT * INTO STRICT d FROM hon.chad_follow_up_drafts WHERE invocation_id=i.id;IF NOT FOUND OR i.status NOT IN('RESULT_RECORDED','RESULT_HELD') OR i.action_request_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM hon.action_requests a WHERE a.id=p_action AND a.organization_id=i.organization_id AND a.school_id=i.school_id AND a.requested_by_principal_id=actor AND a.action_code='crm.follow_up_draft.propose' AND a.required_permission='crm.assistant.follow_up_draft' AND a.effective_authority_mode='CONFIRM' AND a.status='AWAITING_APPROVAL' AND a.normalized_payload=jsonb_build_object('invocationId',i.id,'leadId',i.lead_id,'leadVersion',i.lead_version,'purpose',i.purpose,'subject',d.subject,'content',d.content,'delivery','NOT_CREATED_OR_SENT')) THEN RAISE EXCEPTION 'CHAD_FOLLOW_UP_ACTION_BINDING' USING ERRCODE='42501';END IF;UPDATE hon.chad_follow_up_invocations SET action_request_id=p_action,status='AWAITING_APPROVAL',updated_at=clock_timestamp() WHERE id=i.id;UPDATE hon.work_items SET status='WAITING_FOR_APPROVAL',version=version+1 WHERE id=i.work_item_id;PERFORM hon.chad_follow_up_event(i.id,'chad.follow_up_draft.proposed');END $function$;

CREATE FUNCTION hon.read_chad_follow_up_result_payload(p_subject text,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
-- Full existing access gate: a recorded or held result becomes an approval proposal only while access is current.
DECLARE actor uuid:=hon.require_chad_follow_up_actor(p_subject); i hon.chad_follow_up_invocations%ROWTYPE; d hon.chad_follow_up_drafts%ROWTYPE;
BEGIN
 SELECT * INTO i FROM hon.chad_follow_up_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND OR i.status NOT IN('RESULT_RECORDED','RESULT_HELD') OR i.action_request_id IS NOT NULL THEN RETURN NULL; END IF;
 SELECT * INTO STRICT d FROM hon.chad_follow_up_drafts WHERE invocation_id=i.id;
 RETURN jsonb_build_object('invocationId',i.id,'leadId',i.lead_id,'leadVersion',i.lead_version,'purpose',i.purpose,'subject',d.subject,'content',d.content,'delivery','NOT_CREATED_OR_SENT');
END $$;
CREATE FUNCTION hon.hold_chad_follow_up_result(p_subject text,p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
-- Evidence-only actor. Holds a recorded result ONLY when the full access gate now refuses (AI-D7).
DECLARE actor uuid:=hon.ai_evidence_actor(p_subject); i hon.chad_follow_up_invocations%ROWTYPE; lapsed boolean:=false;
BEGIN
 SELECT * INTO i FROM hon.chad_follow_up_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND OR i.status<>'RESULT_RECORDED' OR i.action_request_id IS NOT NULL THEN RAISE EXCEPTION 'CHAD_FOLLOW_UP_HOLD_REPLAY' USING ERRCODE='40001'; END IF;
 BEGIN PERFORM hon.require_chad_follow_up_actor(p_subject); EXCEPTION WHEN insufficient_privilege THEN lapsed:=true; END;
 IF NOT lapsed THEN RAISE EXCEPTION 'AI_ACCESS_NOT_LAPSED' USING ERRCODE='55000'; END IF;
 UPDATE hon.chad_follow_up_invocations SET status='RESULT_HELD',reason='ACCESS_LAPSED',updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
 PERFORM hon.chad_follow_up_event(i.id,'chad.follow_up_draft.result_held');
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOREACH f IN ARRAY ARRAY['hon.ai_evidence_actor(text)'::regprocedure,
  'hon.read_marketing_result_payload(text,uuid)'::regprocedure,'hon.hold_marketing_result(text,uuid)'::regprocedure,
  'hon.read_teaching_result_payload(text,uuid)'::regprocedure,'hon.hold_teaching_result(text,uuid)'::regprocedure,
  'hon.read_chad_follow_up_result_payload(text,uuid)'::regprocedure,'hon.hold_chad_follow_up_result(text,uuid)'::regprocedure] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon',f); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated',f); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM service_role',f); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.read_marketing_result_payload(text,uuid),hon.hold_marketing_result(text,uuid),
   hon.read_teaching_result_payload(text,uuid),hon.hold_teaching_result(text,uuid),
   hon.read_chad_follow_up_result_payload(text,uuid),hon.hold_chad_follow_up_result(text,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
