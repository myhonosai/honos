BEGIN;
-- No credentials, provider response blobs or public delivery state. Runtime only executes reviewed functions.
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('marketing.assistant.use','Complete owner marketing draft requests and approved internal workspace saves',true,false);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT id,organization_id,'marketing.assistant.use' FROM hon.roles WHERE is_system_role AND code='OWNER' ON CONFLICT DO NOTHING;
CREATE TABLE hon.marketing_ai_invocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 requested_by uuid NOT NULL REFERENCES hon.principals(id), campaign_id uuid NOT NULL, campaign_version integer NOT NULL,
 work_item_id uuid NOT NULL, plan_id uuid, provider_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
 request_text text NOT NULL, request_hash text NOT NULL, idempotency_key uuid NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','CONFIGURATION_REQUIRED','BLOCKED','SENDING','UNKNOWN','FAILED','AWAITING_APPROVAL','SAVED','REJECTED')),
 reason text CHECK(reason IN('CONFIGURATION_REQUIRED','NO_ELIGIBLE_ROUTE','CUSTOMER_BUDGET_EXCEEDED','UNSUPPORTED_PROVIDER','INVALID_REQUEST','PROVIDER_REJECTED','PROVIDER_UNKNOWN','ROUTE_STALE','RESULT_BUDGET_EXCEEDED')),
 reserved_credits integer NOT NULL DEFAULT 0 CHECK(reserved_credits BETWEEN 0 AND 6),
 action_request_id uuid, usage_id uuid REFERENCES hon.ai_usage_ledger(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(campaign_id,organization_id,school_id) REFERENCES hon.marketing_campaigns(id,organization_id,school_id),
 FOREIGN KEY(work_item_id,organization_id,school_id) REFERENCES hon.work_items(id,organization_id,school_id),
 FOREIGN KEY(action_request_id,organization_id,school_id) REFERENCES hon.action_requests(id,organization_id,school_id),
 FOREIGN KEY(plan_id) REFERENCES hon.ai_invocation_plans(id),
 UNIQUE(id,organization_id,school_id), UNIQUE(organization_id,school_id,requested_by,idempotency_key), UNIQUE(provider_request_id), UNIQUE(work_item_id), UNIQUE(plan_id), UNIQUE(action_request_id), UNIQUE(usage_id)
);
CREATE TABLE hon.marketing_ai_drafts (
 invocation_id uuid PRIMARY KEY, organization_id uuid NOT NULL, school_id uuid NOT NULL, campaign_id uuid NOT NULL,
 title text NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(invocation_id,organization_id,school_id) REFERENCES hon.marketing_ai_invocations(id,organization_id,school_id),
 FOREIGN KEY(campaign_id,organization_id,school_id) REFERENCES hon.marketing_campaigns(id,organization_id,school_id)
);
-- Saving an approved draft means attaching exact content to the existing campaign workspace, NEVER external publish.
CREATE TABLE hon.marketing_campaign_content (
 invocation_id uuid PRIMARY KEY, organization_id uuid NOT NULL, school_id uuid NOT NULL, campaign_id uuid NOT NULL,
 action_request_id uuid NOT NULL, title text NOT NULL, content text NOT NULL, saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(invocation_id,organization_id,school_id) REFERENCES hon.marketing_ai_invocations(id,organization_id,school_id),
 FOREIGN KEY(campaign_id,organization_id,school_id) REFERENCES hon.marketing_campaigns(id,organization_id,school_id),
 FOREIGN KEY(action_request_id,organization_id,school_id) REFERENCES hon.action_requests(id,organization_id,school_id)
);
ALTER TABLE hon.marketing_ai_invocations ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.marketing_ai_invocations FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.marketing_ai_drafts ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.marketing_ai_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.marketing_campaign_content ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.marketing_campaign_content FORCE ROW LEVEL SECURITY;
-- Intentionally deny-all policies: no direct runtime table rights, including SELECT.
CREATE TRIGGER marketing_draft_immutable BEFORE UPDATE OR DELETE ON hon.marketing_ai_drafts FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER marketing_draft_no_truncate BEFORE TRUNCATE ON hon.marketing_ai_drafts FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER marketing_content_immutable BEFORE UPDATE OR DELETE ON hon.marketing_campaign_content FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER marketing_content_no_truncate BEFORE TRUNCATE ON hon.marketing_campaign_content FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();
CREATE FUNCTION hon.marketing_safe_text(v text,n integer) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT v IS NOT NULL AND length(btrim(v)) BETWEEN 1 AND n AND v !~* '(-----BEGIN|Bearer[[:space:]]+|\msk[-_][A-Za-z0-9_-]+|\meyJ[A-Za-z0-9_-]+\.eyJ|(?:api[ _-]?key|password|secret|authorization)[[:space:]]*[:=]|[\x01-\x08\x0b\x0c\x0e-\x1f\x7f])'
$$;
ALTER TABLE hon.marketing_ai_invocations ADD CHECK(hon.marketing_safe_text(request_text,2000)), ADD CHECK(request_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE hon.marketing_ai_drafts ADD CHECK(hon.marketing_safe_text(title,160)), ADD CHECK(hon.marketing_safe_text(content,6000));
ALTER TABLE hon.marketing_campaign_content ADD CHECK(hon.marketing_safe_text(title,160)), ADD CHECK(hon.marketing_safe_text(content,6000));
CREATE FUNCTION hon.marketing_owner(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 actor:=hon.lock_campaign_actor(p_subject,'marketing.campaign.read');
 PERFORM hon.require_ai_invocation_plan_access();
 IF NOT hon.principal_has_school_permission(actor,org,school,'marketing.assistant.use') OR NOT hon.principal_has_school_permission(actor,org,school,'ai.invocation.plan')
 OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor)
 OR NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND r.code='OWNER' AND r.is_system_role AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
 OR EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id WHERE g.principal_id=actor AND r.code='PARENT' AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'MARKETING_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.marketing_event(p_id uuid,p_event text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.marketing_ai_invocations%ROWTYPE; payload jsonb; rid uuid:=nullif(current_setting('app.hon_request_id',true),'')::uuid;
BEGIN
 SELECT * INTO STRICT i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
 payload:=jsonb_build_object('invocationId',i.id,'workItemId',i.work_item_id,'status',i.status,'reason',i.reason,'internalOnly',true);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id,action_request_id)
 VALUES(i.organization_id,i.school_id,nullif(current_setting('app.hon_principal_id',true),'')::uuid,'HUMAN_UI',p_event,'MARKETING_INVOCATION',i.id,payload,'SUCCEEDED',rid,rid,i.action_request_id);
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(i.organization_id,i.school_id,p_event,1,'MARKETING_INVOCATION',i.id,1,rid,rid,payload);
END $$;
CREATE FUNCTION hon.read_marketing_invocation(p_subject text,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.marketing_owner(p_subject); result jsonb;
BEGIN
 SELECT jsonb_build_object('id',i.id,'schoolId',i.school_id,'campaignId',i.campaign_id,'workItemId',i.work_item_id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '30 seconds' THEN 'UNKNOWN' ELSE i.status END,'reason',i.reason,'actionRequestId',i.action_request_id,
 'draft',CASE WHEN d.invocation_id IS NULL THEN NULL ELSE jsonb_build_object('title',d.title,'content',d.content) END,'inputTokens',u.input_units,'outputTokens',u.output_units,'providerCostMicrounits',u.provider_cost_microunits,'customerCredits',u.customer_credits) INTO result
 FROM hon.marketing_ai_invocations i LEFT JOIN hon.marketing_ai_drafts d ON d.invocation_id=i.id LEFT JOIN hon.ai_usage_ledger u ON u.id=i.usage_id
 WHERE i.id=p_id AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id() AND i.requested_by=actor;
 IF result IS NULL THEN RAISE EXCEPTION 'MARKETING_NOT_FOUND' USING ERRCODE='P0002'; END IF; RETURN result;
END $$;
CREATE FUNCTION hon.begin_marketing_request(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.marketing_owner(p_subject); org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); c hon.marketing_campaigns%ROWTYPE; i hon.marketing_ai_invocations%ROWTYPE; wid uuid; fingerprint text;
BEGIN
 IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR NOT p_input ?& ARRAY['campaignId','request'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('campaignId','request')) OR jsonb_typeof(p_input->'request')<>'string' OR NOT hon.marketing_safe_text(p_input->>'request',2000) THEN RAISE EXCEPTION 'INVALID_MARKETING_REQUEST' USING ERRCODE='22023'; END IF;
 fingerprint:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE organization_id=org AND school_id=school AND requested_by=actor AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN IF i.request_hash<>fingerprint THEN RAISE EXCEPTION 'MARKETING_REPLAY_SWAP' USING ERRCODE='23505'; END IF; RETURN hon.read_marketing_invocation(p_subject,i.id); END IF;
 SELECT * INTO c FROM hon.marketing_campaigns WHERE id=(p_input->>'campaignId')::uuid AND organization_id=org AND school_id=school AND status<>'ARCHIVED' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MARKETING_TARGET_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 INSERT INTO hon.work_items(organization_id,school_id,work_type,status,subject_type,subject_id,payload,correlation_id)
 VALUES(org,school,'AI_DRAFT_MARKETING','READY','MARKETING_CAMPAIGN',c.id,'{}',nullif(current_setting('app.hon_request_id',true),'')::uuid) RETURNING id INTO wid;
 INSERT INTO hon.marketing_ai_invocations(organization_id,school_id,requested_by,campaign_id,campaign_version,work_item_id,request_text,request_hash,idempotency_key)
 VALUES(org,school,actor,c.id,c.version,wid,p_input->>'request',fingerprint,p_key) RETURNING * INTO i;
 PERFORM hon.marketing_event(i.id,'marketing.assistant.requested'); RETURN hon.read_marketing_invocation(p_subject,i.id);
END $$;
CREATE FUNCTION hon.prepare_marketing_invocation(p_subject text,p_id uuid,p_plan uuid,p_ready boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.marketing_owner(p_subject); i hon.marketing_ai_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; used numeric; reserved numeric; v_reason text;
BEGIN
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MARKETING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '30 seconds' THEN UPDATE hon.marketing_ai_invocations SET status='UNKNOWN',reason='PROVIDER_UNKNOWN',updated_at=clock_timestamp() WHERE id=i.id; PERFORM hon.marketing_event(i.id,'marketing.assistant.unknown'); RETURN NULL; END IF;
 IF i.status NOT IN('PENDING','CONFIGURATION_REQUIRED','BLOCKED') THEN RETURN NULL; END IF;
 IF p_plan IS NULL THEN UPDATE hon.marketing_ai_invocations SET status='BLOCKED',reason='NO_ELIGIBLE_ROUTE' WHERE id=i.id; UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1 WHERE id=i.work_item_id; PERFORM hon.marketing_event(i.id,'marketing.assistant.blocked'); RETURN NULL; END IF;
 SELECT * INTO p FROM hon.ai_invocation_plans WHERE id=p_plan AND organization_id=i.organization_id AND school_id=i.school_id AND work_item_id=i.work_item_id AND task_class='DRAFT_MARKETING' AND agent_key='marcus' AND input_budget=4096 AND output_budget=1024 AND max_provider_cost_microunits=100000;
 IF NOT FOUND OR (i.plan_id IS NOT NULL AND i.plan_id<>p_plan) THEN RAISE EXCEPTION 'MARKETING_PLAN_SWAP' USING ERRCODE='42501'; END IF;
 -- Locks serialize HQ revocation with the final claim; historical plans do not authorize execution.
 PERFORM 1 FROM hon.hq_ai_provider_connections WHERE provider_id=p.provider_id FOR SHARE;
 PERFORM 1 FROM hon.hq_ai_model_catalog WHERE catalog_id=p.catalog_id FOR SHARE;
 PERFORM 1 FROM hon.hq_ai_routing_policies WHERE policy_id=p.routing_policy_id FOR SHARE;
 PERFORM 1 FROM hon.hq_ai_routing_candidates WHERE policy_id=p.routing_policy_id FOR SHARE;
 IF p.provider_id<>'OPENROUTER' THEN v_reason:='UNSUPPORTED_PROVIDER';
 ELSIF NOT EXISTS(SELECT 1 FROM hon.hq_ai_provider_connections pc JOIN hon.hq_ai_model_catalog m ON m.provider_id=pc.provider_id JOIN hon.hq_ai_routing_candidates rc ON rc.catalog_id=m.catalog_id JOIN hon.hq_ai_routing_policies rp ON rp.policy_id=rc.policy_id WHERE pc.provider_id=p.provider_id AND pc.state='HEALTHY' AND pc.version=p.provider_version AND m.catalog_id=p.catalog_id AND m.model_id=p.model_id AND m.version=p.catalog_version AND m.active AND m.cost_unit='TOKEN' AND 'TEXT'=ANY(m.capabilities) AND 'TEXT'=ANY(m.modalities) AND m.effective_from<=clock_timestamp() AND (m.effective_until IS NULL OR m.effective_until>clock_timestamp()) AND rp.policy_id=p.routing_policy_id AND rp.organization_id=i.organization_id AND rp.school_id=i.school_id AND rp.version=p.routing_policy_version AND rp.active AND rp.capability='TEXT' AND rp.effective_from<=clock_timestamp() AND (rp.effective_until IS NULL OR rp.effective_until>clock_timestamp()) AND m.unit_cost_micros*5120<=LEAST(rp.max_cost_micros,p.max_provider_cost_microunits)) THEN v_reason:='ROUTE_STALE';
 ELSIF NOT p_ready THEN v_reason:='CONFIGURATION_REQUIRED'; END IF;
 SELECT coalesce(sum(customer_credits),0) INTO used FROM hon.ai_usage_ledger WHERE organization_id=i.organization_id AND occurred_at>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND occurred_at<(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC';
 SELECT coalesce(sum(reserved_credits),0) INTO reserved FROM hon.marketing_ai_invocations WHERE organization_id=i.organization_id;
 IF v_reason IS NULL AND used+reserved+p.customer_credit_estimate>12000 THEN v_reason:='CUSTOMER_BUDGET_EXCEEDED'; END IF;
 UPDATE hon.marketing_ai_invocations SET plan_id=p.id,status=CASE WHEN v_reason IS NULL THEN 'SENDING' WHEN v_reason='CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,reason=v_reason,reserved_credits=CASE WHEN v_reason IS NULL THEN p.customer_credit_estimate ELSE 0 END,updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status=CASE WHEN v_reason IS NULL THEN 'WORKING' ELSE 'NEEDS_ATTENTION' END,version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
 PERFORM hon.marketing_event(i.id,'marketing.assistant.prepared');
 IF v_reason IS NOT NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('providerId',p.provider_id,'modelId',p.model_id,'providerRequestId',i.provider_request_id,'request',i.request_text,'inputBudget',p.input_budget,'outputBudget',p.output_budget,'maxCostMicrounits',p.max_provider_cost_microunits);
END $$;
CREATE FUNCTION hon.fail_marketing_invocation(p_subject text,p_id uuid,p_outcome text,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.marketing_owner(p_subject); i hon.marketing_ai_invocations%ROWTYPE;
BEGIN
 IF p_outcome NOT IN('PRE_SEND','FAILED','UNKNOWN') OR p_reason NOT IN('CONFIGURATION_REQUIRED','UNSUPPORTED_PROVIDER','INVALID_REQUEST','PROVIDER_REJECTED','PROVIDER_UNKNOWN') THEN RAISE EXCEPTION 'INVALID_MARKETING_OUTCOME' USING ERRCODE='22023'; END IF;
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND OR i.status<>'SENDING' THEN RAISE EXCEPTION 'MARKETING_OUTCOME_REPLAY' USING ERRCODE='40001'; END IF;
 UPDATE hon.marketing_ai_invocations SET status=CASE WHEN p_outcome='PRE_SEND' THEN 'CONFIGURATION_REQUIRED' ELSE p_outcome END,reason=p_reason,reserved_credits=CASE WHEN p_outcome='UNKNOWN' THEN reserved_credits ELSE 0 END,updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
 PERFORM hon.marketing_event(i.id,'marketing.assistant.provider_result');
END $$;
CREATE FUNCTION hon.record_marketing_result(p_subject text,p_id uuid,p_result jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.marketing_owner(p_subject); i hon.marketing_ai_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; uid uuid; credits integer; d jsonb:=p_result->'draft'; over_budget boolean;
BEGIN
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND OR i.status<>'SENDING' OR i.usage_id IS NOT NULL THEN RAISE EXCEPTION 'MARKETING_OUTCOME_REPLAY' USING ERRCODE='40001'; END IF;
 SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id=i.plan_id;
 IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR NOT p_result ?& ARRAY['draft','inputTokens','outputTokens','providerCostMicrounits'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN('draft','inputTokens','outputTokens','providerCostMicrounits')) OR jsonb_typeof(d)<>'object' OR NOT d ?& ARRAY['title','content'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN('title','content')) OR jsonb_typeof(d->'title')<>'string' OR jsonb_typeof(d->'content')<>'string' OR NOT hon.marketing_safe_text(d->>'title',160) OR NOT hon.marketing_safe_text(d->>'content',6000) OR (p_result->>'inputTokens') !~ '^[0-9]+$' OR (p_result->>'outputTokens') !~ '^[0-9]+$' OR (p_result->>'providerCostMicrounits') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_MARKETING_RESULT' USING ERRCODE='22023'; END IF;
 credits:=((p_result->>'inputTokens')::integer+(p_result->>'outputTokens')::integer+999)/1000;
 over_budget:=(p_result->>'inputTokens')::integer>p.input_budget OR (p_result->>'outputTokens')::integer>p.output_budget OR (p_result->>'providerCostMicrounits')::bigint>p.max_provider_cost_microunits OR credits>i.reserved_credits;
 INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,provider_cost_microunits,customer_credits,correlation_id)
 VALUES(i.organization_id,i.school_id,actor,i.work_item_id,p.provider_id,p.model_id,'TEXT',(p_result->>'inputTokens')::bigint,(p_result->>'outputTokens')::bigint,(p_result->>'providerCostMicrounits')::bigint,credits,nullif(current_setting('app.hon_request_id',true),'')::uuid) RETURNING id INTO uid;
 UPDATE hon.marketing_ai_invocations SET usage_id=uid,reserved_credits=0,status=CASE WHEN over_budget THEN 'FAILED' ELSE status END,reason=CASE WHEN over_budget THEN 'RESULT_BUDGET_EXCEEDED' ELSE NULL END WHERE id=i.id;
 IF over_budget THEN UPDATE hon.work_items SET status='FAILED',version=version+1 WHERE id=i.work_item_id; PERFORM hon.marketing_event(i.id,'marketing.assistant.budget_failed'); RETURN NULL; END IF;
 INSERT INTO hon.marketing_ai_drafts(invocation_id,organization_id,school_id,campaign_id,title,content) VALUES(i.id,i.organization_id,i.school_id,i.campaign_id,d->>'title',d->>'content');
 RETURN jsonb_build_object('invocationId',i.id,'campaignId',i.campaign_id,'campaignVersion',i.campaign_version,'title',d->>'title','content',d->>'content');
END $$;
CREATE FUNCTION hon.bind_marketing_proposal(p_subject text,p_id uuid,p_action uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.marketing_owner(p_subject); i hon.marketing_ai_invocations%ROWTYPE; d hon.marketing_ai_drafts%ROWTYPE;
BEGIN
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 SELECT * INTO STRICT d FROM hon.marketing_ai_drafts WHERE invocation_id=i.id;
 IF i.status<>'SENDING' OR i.action_request_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM hon.action_requests a WHERE a.id=p_action AND a.organization_id=i.organization_id AND a.school_id=i.school_id AND a.requested_by_principal_id=actor AND a.action_code='marketing.draft.save' AND a.required_permission='marketing.assistant.use' AND a.effective_authority_mode='CONFIRM' AND a.status='AWAITING_APPROVAL' AND a.normalized_payload=jsonb_build_object('invocationId',i.id,'campaignId',i.campaign_id,'campaignVersion',i.campaign_version,'title',d.title,'content',d.content)) THEN RAISE EXCEPTION 'MARKETING_ACTION_BINDING' USING ERRCODE='42501'; END IF;
 UPDATE hon.marketing_ai_invocations SET action_request_id=p_action,status='AWAITING_APPROVAL',updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status='WAITING_FOR_APPROVAL',version=version+1 WHERE id=i.work_item_id;
 PERFORM hon.marketing_event(i.id,'marketing.assistant.drafted');
END $$;
CREATE FUNCTION hon.marketing_action_is_current(p_action uuid,p_payload jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE ok boolean;
BEGIN
 PERFORM 1 FROM hon.marketing_campaigns c JOIN hon.marketing_ai_invocations i ON i.campaign_id=c.id WHERE i.action_request_id=p_action AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id() FOR SHARE OF c;
 SELECT EXISTS(SELECT 1 FROM hon.marketing_ai_invocations i JOIN hon.marketing_ai_drafts d ON d.invocation_id=i.id JOIN hon.marketing_campaigns c ON c.id=i.campaign_id AND c.organization_id=i.organization_id AND c.school_id=i.school_id WHERE i.action_request_id=p_action AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id() AND i.status='AWAITING_APPROVAL' AND c.version=i.campaign_version AND c.status<>'ARCHIVED' AND p_payload=jsonb_build_object('invocationId',i.id,'campaignId',i.campaign_id,'campaignVersion',i.campaign_version,'title',d.title,'content',d.content)) INTO ok; RETURN ok;
END $$;
CREATE FUNCTION hon.reject_marketing_draft(p_action uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.marketing_ai_invocations%ROWTYPE;
BEGIN
 IF NOT hon.human_action_reviewer() THEN RAISE EXCEPTION 'REVIEW_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE action_request_id=p_action AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR UPDATE;
 IF NOT FOUND OR i.status<>'AWAITING_APPROVAL' OR NOT EXISTS(SELECT 1 FROM hon.action_requests a JOIN hon.action_approvals ap ON ap.action_request_id=a.id WHERE a.id=p_action AND a.status='DENIED' AND ap.decision='DENIED' AND ap.reviewed_payload_hash=a.payload_hash AND ap.reviewed_policy_version=a.policy_version AND ap.reviewer_principal_id<>i.requested_by) THEN RAISE EXCEPTION 'REJECTION_BINDING' USING ERRCODE='42501'; END IF;
 UPDATE hon.marketing_ai_invocations SET status='REJECTED',updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status='FAILED',version=version+1,result='{"reason":"HUMAN_REJECTED"}' WHERE id=i.work_item_id;
 PERFORM hon.marketing_event(i.id,'marketing.assistant.rejected');
END $$;
CREATE FUNCTION hon.save_approved_marketing_draft(p_subject text,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.marketing_owner(p_subject); i hon.marketing_ai_invocations%ROWTYPE; a hon.action_requests%ROWTYPE; d hon.marketing_ai_drafts%ROWTYPE; pv integer; mode hon.authority_mode; current_target boolean;
BEGIN
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MARKETING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF i.status='SAVED' THEN RETURN hon.read_marketing_invocation(p_subject,p_id); END IF;
 SELECT * INTO a FROM hon.action_requests WHERE id=i.action_request_id AND organization_id=i.organization_id AND school_id=i.school_id FOR UPDATE;
 IF i.status<>'AWAITING_APPROVAL' OR a.id IS NULL THEN RAISE EXCEPTION 'MARKETING_APPROVAL_STALE' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.action_policies WHERE organization_id=i.organization_id AND school_id=i.school_id AND action_code='marketing.draft.save' FOR SHARE;
 -- Lock reviewer identity before grants/roles, including other-school PARENT
 -- grants. User/principal UPDATE locks also serialize new identity/grant/HQ
 -- references; locking only existing school permission rows misses exclusions.
 PERFORM 1 FROM hon.users u WHERE u.id IN(SELECT p.user_id FROM hon.principals p JOIN hon.action_approvals ap ON ap.reviewer_principal_id=p.id WHERE ap.action_request_id=a.id) ORDER BY u.id FOR UPDATE;
 PERFORM 1 FROM hon.principals p WHERE p.user_id IN(SELECT reviewer.user_id FROM hon.principals reviewer JOIN hon.action_approvals ap ON ap.reviewer_principal_id=reviewer.id WHERE ap.action_request_id=a.id) ORDER BY p.id FOR UPDATE;
 PERFORM 1 FROM hon.principal_role_grants g JOIN hon.action_approvals ap ON ap.reviewer_principal_id=g.principal_id WHERE ap.action_request_id=a.id ORDER BY g.id FOR SHARE OF g;
 PERFORM 1 FROM hon.roles r WHERE r.id IN(SELECT g.role_id FROM hon.principal_role_grants g JOIN hon.action_approvals ap ON ap.reviewer_principal_id=g.principal_id WHERE ap.action_request_id=a.id) ORDER BY r.id FOR SHARE;
 PERFORM 1 FROM hon.role_permissions rp JOIN hon.principal_role_grants g ON g.role_id=rp.role_id JOIN hon.action_approvals ap ON ap.reviewer_principal_id=g.principal_id WHERE ap.action_request_id=a.id ORDER BY rp.role_id,rp.permission_code FOR SHARE OF rp;
 SELECT * INTO STRICT d FROM hon.marketing_ai_drafts WHERE invocation_id=i.id FOR SHARE;
 PERFORM 1 FROM hon.work_items WHERE id=i.work_item_id FOR UPDATE;
 current_target:=hon.marketing_action_is_current(a.id,a.normalized_payload);
 -- All potentially waiting dependency locks precede the final live checks.
 -- Neither the initial owner check nor an approval's historical reviewer is
 -- durable authority: re-evaluate qualification, policy and approval clock.
 actor:=hon.marketing_owner(p_subject);
 SELECT policy_version,authority_mode INTO pv,mode FROM hon.action_policies WHERE organization_id=i.organization_id AND school_id=i.school_id AND action_code='marketing.draft.save' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()) ORDER BY policy_version DESC LIMIT 1;
 -- CONFIRM platform floor allows school AUTO only as a weaker source; RESTRICTED always blocks.
 IF i.status<>'AWAITING_APPROVAL' OR a.status<>'APPROVED' OR a.action_code<>'marketing.draft.save' OR a.required_permission<>'marketing.assistant.use' OR a.requested_by_principal_id<>actor OR a.delegated_by_principal_id IS NOT NULL OR a.effective_authority_mode<>'CONFIRM' OR a.approval_expires_at IS NULL OR a.approval_expires_at<=clock_timestamp() OR a.policy_version<>coalesce(pv,0) OR mode='RESTRICTED' OR current_target IS DISTINCT FROM true THEN RAISE EXCEPTION 'MARKETING_APPROVAL_STALE' USING ERRCODE='42501'; END IF;
 -- Match require_human_action_review's complete live reviewer qualification,
 -- not merely action.approve. PARENT excludes active grants in ANY school/org;
 -- expired, revoked or future grants do not exclude a reviewer.
 IF NOT EXISTS(SELECT 1 FROM hon.action_approvals ap JOIN hon.principals p ON p.id=ap.reviewer_principal_id JOIN hon.users u ON u.id=p.user_id WHERE ap.action_request_id=a.id AND ap.organization_id=i.organization_id AND ap.school_id=i.school_id AND ap.decision='APPROVED' AND ap.reviewed_payload_hash=a.payload_hash AND ap.reviewed_policy_version=a.policy_version AND ap.reviewer_principal_id<>actor AND p.is_active AND p.principal_type='HUMAN_USER'
 AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=p.user_id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
 AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id WHERE g.principal_id=p.id AND r.code='PARENT' AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
 AND hon.principal_has_school_permission(p.id,i.organization_id,i.school_id,'action.approve')) THEN RAISE EXCEPTION 'MARKETING_APPROVAL_EVIDENCE' USING ERRCODE='42501'; END IF;
 INSERT INTO hon.marketing_campaign_content(invocation_id,organization_id,school_id,campaign_id,action_request_id,title,content) VALUES(i.id,i.organization_id,i.school_id,i.campaign_id,a.id,d.title,d.content);
 UPDATE hon.action_requests SET status='SUCCEEDED',verified_result=jsonb_build_object('invocationId',i.id,'campaignId',i.campaign_id,'internalOnly',true),updated_at=clock_timestamp() WHERE id=a.id;
 UPDATE hon.marketing_ai_invocations SET status='SAVED',updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status='COMPLETED',version=version+1,result=jsonb_build_object('invocationId',i.id,'campaignId',i.campaign_id,'internalOnly',true),updated_at=clock_timestamp() WHERE id=i.work_item_id;
 PERFORM hon.marketing_event(i.id,'marketing.assistant.saved'); RETURN hon.read_marketing_invocation(p_subject,i.id);
END $$;
-- Private identity and result records are immutable apart from their fixed state-machine columns.
CREATE FUNCTION hon.guard_marketing_invocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'IMMUTABLE_MARKETING_REQUEST' USING ERRCODE='42501'; END IF;
 IF (to_jsonb(NEW)-ARRAY['plan_id','status','reason','reserved_credits','action_request_id','usage_id','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['plan_id','status','reason','reserved_credits','action_request_id','usage_id','updated_at']) OR (OLD.plan_id IS NOT NULL AND NEW.plan_id IS DISTINCT FROM OLD.plan_id) OR (OLD.action_request_id IS NOT NULL AND NEW.action_request_id IS DISTINCT FROM OLD.action_request_id) OR (OLD.usage_id IS NOT NULL AND NEW.usage_id IS DISTINCT FROM OLD.usage_id) THEN RAISE EXCEPTION 'IMMUTABLE_MARKETING_BINDING' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER marketing_invocation_guard BEFORE UPDATE OR DELETE ON hon.marketing_ai_invocations FOR EACH ROW EXECUTE FUNCTION hon.guard_marketing_invocation();
CREATE TRIGGER marketing_invocation_no_truncate BEFORE TRUNCATE ON hon.marketing_ai_invocations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_marketing_invocation();
DO $$ DECLARE f regprocedure; BEGIN
 REVOKE ALL ON hon.marketing_ai_invocations,hon.marketing_ai_drafts,hon.marketing_campaign_content FROM PUBLIC;
 FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname IN('marketing_safe_text','marketing_owner','marketing_event','read_marketing_invocation','begin_marketing_request','prepare_marketing_invocation','fail_marketing_invocation','record_marketing_result','bind_marketing_proposal','marketing_action_is_current','reject_marketing_draft','save_approved_marketing_draft','guard_marketing_invocation') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f); END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
 REVOKE ALL ON hon.marketing_ai_invocations,hon.marketing_ai_drafts,hon.marketing_campaign_content FROM hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.read_marketing_invocation(text,uuid),hon.begin_marketing_request(text,jsonb,uuid),hon.prepare_marketing_invocation(text,uuid,uuid,boolean),hon.fail_marketing_invocation(text,uuid,text,text),hon.record_marketing_result(text,uuid,jsonb),hon.bind_marketing_proposal(text,uuid,uuid),hon.marketing_action_is_current(uuid,jsonb),hon.reject_marketing_draft(uuid),hon.save_approved_marketing_draft(text,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
