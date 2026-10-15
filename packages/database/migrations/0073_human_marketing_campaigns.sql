BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Campaigns require a trusted migration owner'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('marketing.campaign.read','Human school campaign planning and aggregate attribution reads',true,true),
 ('marketing.campaign.create','Human school campaign planning creation; never spending or publishing',true,true),
 ('marketing.campaign.update','Human school campaign planning revisions; never spending or publishing',true,true),
 ('marketing.campaign.status','Human school campaign planning status changes',true,true),
 ('marketing.campaign.attribute','Human attribution to an ACTIVE current-school campaign',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code IN('marketing.campaign.read','marketing.campaign.create','marketing.campaign.update','marketing.campaign.status','marketing.campaign.attribute') ON CONFLICT DO NOTHING;

CREATE TABLE hon.marketing_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999), code text NOT NULL,
 name text NOT NULL, goal text NOT NULL, offer_label text NOT NULL, channel text NOT NULL,
 status text NOT NULL CHECK(status IN('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 planned_budget_minor bigint NOT NULL CHECK(planned_budget_minor BETWEEN 0 AND 1000000000000), currency text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id),
 UNIQUE(id,organization_id,school_id), UNIQUE(organization_id,school_id,code)
);
CREATE TABLE hon.marketing_campaign_versions (
 campaign_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL, version integer NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), source text NOT NULL CHECK(source='HUMAN_UI'),
 request_id uuid NOT NULL, snapshot jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(campaign_id,version), FOREIGN KEY(campaign_id,organization_id,school_id) REFERENCES hon.marketing_campaigns(id,organization_id,school_id)
);
CREATE TABLE hon.marketing_campaign_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint text NOT NULL,
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key), FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
-- Private creation-time facts. No retrospective backfill, contact joins or client ACLs.
CREATE TABLE hon.crm_lead_attributions (
 lead_id uuid PRIMARY KEY, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 campaign_id uuid, campaign_version integer, campaign_snapshot jsonb,
 source_code text, source_facts jsonb NOT NULL CHECK(jsonb_typeof(source_facts)='object'),
 import_batch_id uuid, import_row_index integer, import_checksum text,
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(lead_id,organization_id,school_id) REFERENCES hon.crm_leads(id,organization_id,school_id),
 FOREIGN KEY(campaign_id,organization_id,school_id) REFERENCES hon.marketing_campaigns(id,organization_id,school_id),
 FOREIGN KEY(campaign_id,campaign_version) REFERENCES hon.marketing_campaign_versions(campaign_id,version),
 FOREIGN KEY(import_batch_id,organization_id,school_id) REFERENCES hon.lead_import_batches(id,organization_id,school_id),
 FOREIGN KEY(import_batch_id,import_row_index,lead_id) REFERENCES hon.lead_import_rows(batch_id,row_index,lead_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((campaign_id IS NULL AND campaign_version IS NULL AND campaign_snapshot IS NULL) OR (campaign_id IS NOT NULL AND campaign_version IS NOT NULL AND campaign_snapshot IS NOT NULL AND jsonb_typeof(campaign_snapshot)='object')),
 CHECK((import_batch_id IS NULL AND import_row_index IS NULL AND import_checksum IS NULL) OR (import_batch_id IS NOT NULL AND import_row_index IS NOT NULL AND import_checksum IS NOT NULL AND import_checksum ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX marketing_campaign_scope_idx ON hon.marketing_campaigns(organization_id,school_id,updated_at DESC,id);
CREATE INDEX lead_attribution_campaign_idx ON hon.crm_lead_attributions(organization_id,school_id,campaign_id,lead_id);
ALTER TABLE hon.marketing_campaigns ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.marketing_campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.marketing_campaign_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.marketing_campaign_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.marketing_campaign_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.marketing_campaign_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_lead_attributions ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.crm_lead_attributions FORCE ROW LEVEL SECURITY;
-- Deliberately no policies; only fixed trusted boundaries can access these tables.
CREATE FUNCTION hon.guard_campaign_history() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_CAMPAIGN_EVIDENCE' USING ERRCODE='42501'; END $$;
CREATE TRIGGER campaign_versions_immutable BEFORE UPDATE OR DELETE ON hon.marketing_campaign_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER campaign_versions_no_truncate BEFORE TRUNCATE ON hon.marketing_campaign_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER campaign_requests_immutable BEFORE UPDATE OR DELETE ON hon.marketing_campaign_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER campaign_requests_no_truncate BEFORE TRUNCATE ON hon.marketing_campaign_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER lead_attributions_immutable BEFORE UPDATE OR DELETE ON hon.crm_lead_attributions FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER lead_attributions_no_truncate BEFORE TRUNCATE ON hon.crm_lead_attributions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();

CREATE FUNCTION hon.validate_campaign_window(p_from text,p_to text,p_history boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE v text; duration interval;
BEGIN
 FOR v IN SELECT unnest(ARRAY[p_from,p_to]) LOOP
  IF v IS NULL OR v !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' OR to_char(v::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>v THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
 duration:=p_to::timestamptz-p_from::timestamptz;
 IF duration<interval '1 day' OR duration>interval '366 days' OR (p_history AND p_to::timestamptz>clock_timestamp()) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
END $$;
CREATE FUNCTION hon.validate_campaign_input(p jsonb,p_status boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE k text; maxlen integer;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number'
 OR (p->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$' OR (p->>'expectedVersion')::numeric>999999998 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p_status THEN
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) AS keys(key) WHERE key NOT IN('expectedVersion','status')) OR (p->>'expectedVersion')::integer<1 OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR (p->>'status') NOT IN('DRAFT','ACTIVE','PAUSED','ARCHIVED') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) AS keys(key) WHERE key NOT IN('expectedVersion','code','name','goal','offerLabel','channel','startsAt','endsAt','plannedBudgetMinor','currency'))
 OR jsonb_typeof(p->'plannedBudgetMinor') IS DISTINCT FROM 'number' OR (p->>'plannedBudgetMinor') !~ '^(0|[1-9][0-9]{0,12})$' OR (p->>'plannedBudgetMinor')::numeric>1000000000000
 OR jsonb_typeof(p->'channel') IS DISTINCT FROM 'string' OR (p->>'channel') NOT IN('REFERRAL','EVENT','PRINT','EMAIL','SMS','SOCIAL','SEARCH','WEBSITE','OTHER')
 OR jsonb_typeof(p->'currency') IS DISTINCT FROM 'string' OR (p->>'currency') NOT IN('USD','EUR','GBP','AUD','CAD','NZD','JPY','SGD','HKD','CHF','CNY','INR','KRW','AED','MXN','BRL','ZAR') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT unnest(ARRAY['code','name','goal','offerLabel']) LOOP
  maxlen:=CASE k WHEN 'code' THEN 40 WHEN 'goal' THEN 500 ELSE 120 END;
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(p->>k)>maxlen OR (k<>'offerLabel' AND length(p->>k)<1) OR btrim(p->>k)<>p->>k OR (p->>k) ~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF (p->>'code') !~ '^[A-Z0-9][A-Z0-9_-]{0,39}$' OR jsonb_typeof(p->'startsAt') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'endsAt') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 PERFORM hon.validate_campaign_window(p->>'startsAt',p->>'endsAt',false);
END $$;
CREATE FUNCTION hon.campaign_summary(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',id,'version',version,'code',code,'name',name,'goal',goal,'offerLabel',offer_label,'channel',channel,'status',status,
 'startsAt',to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'endsAt',to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'plannedBudgetMinor',planned_budget_minor,'currency',currency,'createdAt',created_at,'updatedAt',updated_at,'planningOnly',true)
 FROM hon.marketing_campaigns WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
$$;
CREATE FUNCTION hon.guard_campaign_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'IMMUTABLE_CAMPAIGN_IDENTITY' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' AND (NEW.status IS DISTINCT FROM 'DRAFT' OR NEW.version IS DISTINCT FROM 1) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.created_at<>OLD.created_at OR NEW.code<>OLD.code OR NEW.currency<>OLD.currency OR NEW.version<>OLD.version+1 OR OLD.status='ARCHIVED' THEN RAISE EXCEPTION 'IMMUTABLE_CAMPAIGN_IDENTITY' USING ERRCODE='22023'; END IF;
  IF NEW.status<>OLD.status AND NOT ((OLD.status='DRAFT' AND NEW.status IN('ACTIVE','ARCHIVED')) OR (OLD.status='ACTIVE' AND NEW.status IN('PAUSED','ARCHIVED')) OR (OLD.status='PAUSED' AND NEW.status IN('ACTIVE','ARCHIVED'))) THEN RAISE EXCEPTION 'INVALID_CAMPAIGN_TRANSITION' USING ERRCODE='22023'; END IF;
 END IF;
 IF NEW.starts_at<>date_trunc('milliseconds',NEW.starts_at) OR NEW.ends_at<>date_trunc('milliseconds',NEW.ends_at) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 PERFORM hon.validate_campaign_input(jsonb_build_object('expectedVersion',NEW.version-1,'code',NEW.code,'name',NEW.name,'goal',NEW.goal,'offerLabel',NEW.offer_label,'channel',NEW.channel,
 'startsAt',to_char(NEW.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'endsAt',to_char(NEW.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'plannedBudgetMinor',NEW.planned_budget_minor,'currency',NEW.currency),false);
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_record_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.marketing_campaigns FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_record();
CREATE TRIGGER campaign_record_no_truncate BEFORE TRUNCATE ON hon.marketing_campaigns FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_record();

CREATE FUNCTION hon.require_campaign_actor(p_subject text,p_permission text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
 IF p_permission IS NULL OR p_permission NOT IN('marketing.campaign.read','marketing.campaign.create','marketing.campaign.update','marketing.campaign.status','marketing.campaign.attribute','crm.lead.create','migration.lead_import.finalize')
 OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true) AND p.principal_type='HUMAN_USER' AND p.is_active AND (SELECT count(*) FROM hon.principals x JOIN hon.users xu ON xu.id=x.user_id WHERE xu.external_subject=p_subject AND x.principal_type='HUMAN_USER' AND x.is_active)=1;
 IF actor IS NULL OR NOT hon.principal_has_school_permission(actor,hon.current_organization_id(),hon.current_school_id(),p_permission)
 OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=hon.current_organization_id() AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'CAMPAIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_campaign_actor(p_subject text,p_permission text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
-- Reviewed import 0074 also acquires user before principal/grants/roles; nested
-- finalize/attribution calls must never first acquire an earlier lock afterwards.
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CAMPAIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CAMPAIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_campaign_actor(p_subject,p_permission);
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR UPDATE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 RETURN hon.require_campaign_actor(p_subject,p_permission);
END $$;
CREATE FUNCTION hon.resolve_campaign_scope(p_subject text,p_permission text)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH candidates AS (
  SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id
  FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  JOIN hon.principal_role_grants g ON g.principal_id=p.id
  JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
  JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
  JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id
  JOIN hon.organizations o ON o.id=s.organization_id
  WHERE u.external_subject=p_subject AND p.principal_type='HUMAN_USER' AND p.is_active
   AND (SELECT count(*) FROM hon.principals x JOIN hon.users xu ON xu.id=x.user_id WHERE xu.external_subject=p_subject AND x.principal_type='HUMAN_USER' AND x.is_active)=1
   AND p_permission IN('marketing.campaign.read','marketing.campaign.create','marketing.campaign.update','marketing.campaign.status','marketing.campaign.attribute')
   AND rp.permission_code=p_permission AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp()
   AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()) AND o.status='ACTIVE' AND s.status='ACTIVE'
   AND (r.management_school_id IS NULL OR r.management_school_id=s.id)
 ) SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates)=1
$$;

-- Fixed CRM boundary: also revalidates exact live authority before ordinary lead replay.
CREATE FUNCTION hon.authorize_campaign_lead(p_subject text,p_attributed boolean) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject text:=p_subject;
BEGIN
 IF subject IS NULL THEN SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id::text=current_setting('app.hon_principal_id',true); END IF;
 IF p_attributed IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 PERFORM hon.lock_campaign_actor(subject,'crm.lead.create');
 IF p_attributed THEN PERFORM hon.require_campaign_actor(subject,'marketing.campaign.attribute'); END IF;
END $$;

CREATE FUNCTION hon.mutate_campaign(p_subject text,p_operation text,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; c hon.marketing_campaigns%ROWTYPE;
 previous hon.marketing_campaign_requests%ROWTYPE; fp text; result jsonb; expected integer; permission text;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN('create','update','status') OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
 OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) OR ((p_operation='create')<>(p_id IS NULL)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 PERFORM hon.validate_campaign_input(p_input,p_operation='status'); permission:='marketing.campaign.'||p_operation;
 actor:=hon.lock_campaign_actor(p_subject,permission);
 fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'id',p_id,'input',p_input)::text,'UTF8')),'hex');
 SELECT * INTO previous FROM hon.marketing_campaign_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN
  IF previous.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('campaign',previous.response,'replayed',true);
 END IF;
 expected:=(p_input->>'expectedVersion')::integer;
 IF p_operation='create' THEN
  IF expected<>0 OR (SELECT count(*) FROM hon.marketing_campaigns WHERE organization_id=org AND school_id=school)>=1000 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.marketing_campaigns(organization_id,school_id,version,code,name,goal,offer_label,channel,status,starts_at,ends_at,planned_budget_minor,currency)
  VALUES(org,school,1,p_input->>'code',p_input->>'name',p_input->>'goal',p_input->>'offerLabel',p_input->>'channel','DRAFT',(p_input->>'startsAt')::timestamptz,(p_input->>'endsAt')::timestamptz,(p_input->>'plannedBudgetMinor')::bigint,p_input->>'currency') RETURNING * INTO c;
 ELSE
  SELECT * INTO c FROM hon.marketing_campaigns WHERE id=p_id AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF c.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p_operation='status' THEN
   IF c.status=p_input->>'status' THEN RAISE EXCEPTION 'INVALID_CAMPAIGN_TRANSITION' USING ERRCODE='22023'; END IF;
   UPDATE hon.marketing_campaigns SET status=p_input->>'status',version=version+1,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
  ELSE
   UPDATE hon.marketing_campaigns SET code=p_input->>'code',name=p_input->>'name',goal=p_input->>'goal',offer_label=p_input->>'offerLabel',channel=p_input->>'channel',starts_at=(p_input->>'startsAt')::timestamptz,ends_at=(p_input->>'endsAt')::timestamptz,planned_budget_minor=(p_input->>'plannedBudgetMinor')::bigint,currency=p_input->>'currency',version=version+1,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
  END IF;
 END IF;
 result:=hon.campaign_summary(c.id); actor:=hon.require_campaign_actor(p_subject,permission);
 INSERT INTO hon.marketing_campaign_versions(campaign_id,organization_id,school_id,version,actor_principal_id,source,request_id,snapshot) VALUES(c.id,org,school,c.version,actor,'HUMAN_UI',p_request,result);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
 VALUES(org,school,actor,'HUMAN_UI',permission,'MARKETING_CAMPAIGN',c.id,CASE WHEN expected=0 THEN NULL ELSE jsonb_build_object('version',expected) END,jsonb_build_object('version',c.version,'status',c.status,'planningOnly',true),'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,'marketing.campaign.human_planned',1,'MARKETING_CAMPAIGN',c.id,c.version,p_correlation,p_request,jsonb_build_object('id',c.id,'version',c.version,'internalOnly',true,'planningOnly',true));
 INSERT INTO hon.marketing_campaign_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 RETURN jsonb_build_object('campaign',result,'replayed',false);
END $$;

CREATE FUNCTION hon.read_campaigns(p_subject text,p_kind text,p_id uuid,p_from text,p_to text,p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); asof timestamptz:=clock_timestamp();
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN('LIST','CURRENT','SAVED','FUNNEL') OR ((p_kind='LIST')<>(p_id IS NULL))
 OR (p_kind<>'FUNNEL' AND (p_from IS NOT NULL OR p_to IS NOT NULL)) OR (p_kind='FUNNEL' AND (p_from IS NULL OR p_to IS NULL))
 OR (p_kind<>'SAVED' AND p_version IS NOT NULL) OR (p_kind='SAVED' AND (p_version IS NULL OR p_version NOT BETWEEN 1 AND 999999999)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_campaign_actor(p_subject,'marketing.campaign.read');
 IF p_kind='LIST' THEN
  SELECT coalesce(jsonb_agg(hon.campaign_summary(id) ORDER BY updated_at DESC,id),'[]') INTO result FROM(
   SELECT id,updated_at FROM hon.marketing_campaigns WHERE organization_id=org AND school_id=school AND (status='ACTIVE' OR updated_at>=asof-interval '90 days') ORDER BY updated_at DESC,id LIMIT 100
  ) safe;
 ELSE
  result:=hon.campaign_summary(p_id);
  IF result IS NULL THEN RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_kind='SAVED' THEN
   SELECT snapshot INTO result FROM hon.marketing_campaign_versions WHERE campaign_id=p_id AND version=p_version AND organization_id=org AND school_id=school;
   IF NOT FOUND THEN RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  ELSIF p_kind='FUNNEL' THEN
   PERFORM hon.validate_campaign_window(p_from,p_to,true);
   WITH cohort AS MATERIALIZED(
    SELECT l.id,l.status FROM hon.crm_leads l JOIN hon.crm_lead_attributions a ON a.lead_id=l.id AND a.organization_id=l.organization_id AND a.school_id=l.school_id
    WHERE l.organization_id=org AND l.school_id=school AND a.campaign_id=p_id AND l.created_at>=p_from::timestamptz AND l.created_at<p_to::timestamptz
   ), trials AS MATERIALIZED(
    SELECT a.id,a.crm_lead_id,a.status FROM hon.crm_appointments a JOIN cohort l ON l.id=a.crm_lead_id
    WHERE a.organization_id=org AND a.school_id=school AND a.appointment_type='TRIAL' AND a.starts_at>=p_from::timestamptz AND a.starts_at<p_to::timestamptz
   ) SELECT jsonb_build_object('campaign',result,'from',p_from,'to',p_to,'asOf',asof,
    'leads',(SELECT count(*) FROM cohort),'trialLeads',(SELECT count(DISTINCT crm_lead_id) FROM trials),'trialAppointments',(SELECT count(*) FROM trials),
    'completedTrialAppointments',(SELECT count(*) FROM trials WHERE status='COMPLETED'),
    'wonLeads',(SELECT count(*) FROM cohort WHERE status='WON'),'lostLeads',(SELECT count(*) FROM cohort WHERE status='LOST'),'archivedLeads',(SELECT count(*) FROM cohort WHERE status='ARCHIVED'),
    'enrollmentLinkage','UNAVAILABLE','revenueLinkage','UNAVAILABLE') INTO result;
  END IF;
 END IF;
 actor:=hon.require_campaign_actor(p_subject,'marketing.campaign.read'); RETURN result;
END $$;

CREATE FUNCTION hon.capture_lead_attribution() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.marketing_campaigns%ROWTYPE; batch hon.lead_import_batches%ROWTYPE; rowdata hon.lead_import_rows%ROWTYPE;
 cid uuid; ccode text; actor uuid; subject text; b_id uuid; r_index integer; checksum text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF EXISTS(SELECT 1 FROM hon.crm_lead_attributions WHERE lead_id=OLD.id) AND (NEW.source_code IS DISTINCT FROM OLD.source_code OR NEW.attribution IS DISTINCT FROM OLD.attribution OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.created_at<>OLD.created_at OR NEW.id<>OLD.id) THEN RAISE EXCEPTION 'IMMUTABLE_LEAD_ATTRIBUTION' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF jsonb_typeof(NEW.attribution) IS DISTINCT FROM 'object' OR octet_length(NEW.attribution::text)>16384 OR (NEW.source_code IS NOT NULL AND (length(NEW.source_code)>80 OR NEW.source_code ~ '[[:cntrl:]]')) THEN RAISE EXCEPTION 'INVALID_SOURCE_FACTS' USING ERRCODE='22023'; END IF;
 IF NEW.attribution ? 'campaignId' THEN
  IF jsonb_typeof(NEW.attribution->'campaignId') IS DISTINCT FROM 'string' OR (NEW.attribution->>'campaignId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN RAISE EXCEPTION 'INVALID_CAMPAIGN_REFERENCE' USING ERRCODE='22023'; END IF;
  cid:=(NEW.attribution->>'campaignId')::uuid;
 END IF;
 IF NEW.attribution ? 'campaignCode' THEN
  ccode:=NEW.attribution->>'campaignCode';
  IF jsonb_typeof(NEW.attribution->'campaignCode') IS DISTINCT FROM 'string' OR ccode !~ '^[A-Z0-9][A-Z0-9_-]{0,39}$' THEN RAISE EXCEPTION 'INVALID_CAMPAIGN_REFERENCE' USING ERRCODE='22023'; END IF;
 END IF;
 IF cid IS NOT NULL OR ccode IS NOT NULL THEN
  SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id::text=current_setting('app.hon_principal_id',true);
  actor:=hon.lock_campaign_actor(subject,'marketing.campaign.attribute');
  IF NEW.organization_id<>hon.current_organization_id() OR NEW.school_id<>hon.current_school_id() THEN RAISE EXCEPTION 'CAMPAIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM hon.marketing_campaigns WHERE organization_id=NEW.organization_id AND school_id=NEW.school_id AND status='ACTIVE' AND (cid IS NULL OR id=cid) AND (ccode IS NULL OR code=ccode) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACTIVE_SCHOOL_CAMPAIGN_REQUIRED' USING ERRCODE='22023'; END IF;
 END IF;
 IF NEW.attribution ? 'migration' THEN
  b_id:=(NEW.attribution->'migration'->>'batchId')::uuid; r_index:=(NEW.attribution->'migration'->>'rowIndex')::integer;
  SELECT * INTO batch FROM hon.lead_import_batches WHERE id=b_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id AND status='REVIEW' AND review_actor::text=current_setting('app.hon_principal_id',true) AND review_expires_at>clock_timestamp();
  SELECT * INTO rowdata FROM hon.lead_import_rows WHERE batch_id=batch.id AND row_index=r_index AND choice='IMPORT' AND validation_errors='[]' AND lead_id IS NULL;
  IF batch.id IS NULL OR rowdata.batch_id IS NULL OR NEW.attribution->'migration'->>'sourceChecksum' IS DISTINCT FROM batch.source_checksum OR NEW.source_code IS DISTINCT FROM nullif(rowdata.normalized->>'source','') THEN RAISE EXCEPTION 'INVALID_IMPORT_PROVENANCE' USING ERRCODE='22023'; END IF;
  checksum:=batch.source_checksum;
 END IF;
 INSERT INTO hon.crm_lead_attributions(lead_id,organization_id,school_id,campaign_id,campaign_version,campaign_snapshot,source_code,source_facts,import_batch_id,import_row_index,import_checksum)
 VALUES(NEW.id,NEW.organization_id,NEW.school_id,c.id,c.version,CASE WHEN c.id IS NULL THEN NULL ELSE hon.campaign_summary(c.id) END,NEW.source_code,NEW.attribution,b_id,r_index,checksum);
 RETURN NEW;
END $$;
CREATE TRIGGER lead_source_immutable BEFORE UPDATE ON hon.crm_leads FOR EACH ROW EXECUTE FUNCTION hon.capture_lead_attribution();
CREATE TRIGGER lead_source_snapshot AFTER INSERT ON hon.crm_leads FOR EACH ROW EXECUTE FUNCTION hon.capture_lead_attribution();

-- Defense in depth: even a privileged inconsistent INSERT cannot forge evidence.
CREATE FUNCTION hon.guard_campaign_evidence_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE l hon.crm_leads%ROWTYPE; v hon.marketing_campaign_versions%ROWTYPE; b hon.lead_import_batches%ROWTYPE; r hon.lead_import_rows%ROWTYPE; facts jsonb; item jsonb;
BEGIN
 IF TG_TABLE_NAME='marketing_campaign_versions' THEN
  IF NEW.snapshot IS NULL OR NEW.snapshot IS DISTINCT FROM hon.campaign_summary(NEW.campaign_id)
   OR NEW.snapshot->>'version' IS DISTINCT FROM NEW.version::text
   OR NOT EXISTS(SELECT 1 FROM hon.marketing_campaigns WHERE id=NEW.campaign_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id AND version=NEW.version)
   OR NEW.actor_principal_id::text IS DISTINCT FROM current_setting('app.hon_principal_id',true)
   OR NEW.request_id::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
   THEN RAISE EXCEPTION 'INCOHERENT_CAMPAIGN_VERSION' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO l FROM hon.crm_leads WHERE id=NEW.lead_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id;
  IF l.id IS NULL OR NEW.source_code IS DISTINCT FROM l.source_code OR NEW.source_facts IS DISTINCT FROM l.attribution THEN RAISE EXCEPTION 'INCOHERENT_LEAD_SOURCE' USING ERRCODE='23514'; END IF;
  IF NEW.campaign_id IS NOT NULL THEN
   SELECT * INTO v FROM hon.marketing_campaign_versions WHERE campaign_id=NEW.campaign_id AND version=NEW.campaign_version AND organization_id=NEW.organization_id AND school_id=NEW.school_id;
   IF v.campaign_id IS NULL OR NEW.campaign_snapshot IS DISTINCT FROM v.snapshot OR v.snapshot->>'status' IS DISTINCT FROM 'ACTIVE'
    OR NOT(l.attribution ? 'campaignId' OR l.attribution ? 'campaignCode')
    OR (l.attribution ? 'campaignId' AND (l.attribution->>'campaignId')::uuid IS DISTINCT FROM NEW.campaign_id)
    OR (l.attribution ? 'campaignCode' AND l.attribution->>'campaignCode' IS DISTINCT FROM v.snapshot->>'code') THEN RAISE EXCEPTION 'INCOHERENT_LEAD_CAMPAIGN' USING ERRCODE='23514'; END IF;
  ELSIF l.attribution ? 'campaignId' OR l.attribution ? 'campaignCode' THEN RAISE EXCEPTION 'MISSING_LEAD_CAMPAIGN' USING ERRCODE='23514';
  END IF;
  IF NEW.import_batch_id IS NOT NULL THEN
   SELECT * INTO b FROM hon.lead_import_batches WHERE id=NEW.import_batch_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id;
   SELECT * INTO r FROM hon.lead_import_rows WHERE batch_id=b.id AND row_index=NEW.import_row_index;
   facts:=jsonb_build_object('migration',jsonb_build_object('batchId',b.id,'rowIndex',r.row_index,'sourceChecksum',b.source_checksum));
   FOR item IN SELECT jsonb_build_object(k,r.normalized->>k) FROM unnest(ARRAY['displayName','note','campaign','campaignCode','medium','sourceDetail']) k WHERE coalesce(r.normalized->>k,'')<>'' LOOP facts:=facts||item; END LOOP;
   IF b.id IS NULL OR r.batch_id IS NULL OR NEW.import_checksum IS DISTINCT FROM b.source_checksum OR NEW.source_facts IS DISTINCT FROM facts OR NEW.source_code IS DISTINCT FROM nullif(r.normalized->>'source','') THEN RAISE EXCEPTION 'INCOHERENT_IMPORT_SOURCE' USING ERRCODE='23514'; END IF;
  ELSIF l.attribution ? 'migration' THEN RAISE EXCEPTION 'MISSING_IMPORT_SOURCE' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_version_coherent BEFORE INSERT ON hon.marketing_campaign_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_evidence_insert();
CREATE TRIGGER lead_attribution_coherent BEFORE INSERT ON hon.crm_lead_attributions FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_evidence_insert();
CREATE FUNCTION hon.check_campaign_current_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM hon.marketing_campaigns c JOIN hon.marketing_campaign_versions v ON v.campaign_id=c.id AND v.version=c.version AND v.organization_id=c.organization_id AND v.school_id=c.school_id WHERE c.id=NEW.id) THEN RAISE EXCEPTION 'MISSING_CAMPAIGN_VERSION' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER campaign_current_version_coherent AFTER INSERT OR UPDATE ON hon.marketing_campaigns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.check_campaign_current_version();

REVOKE ALL ON TABLE hon.marketing_campaigns,hon.marketing_campaign_versions,hon.marketing_campaign_requests,hon.crm_lead_attributions FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_campaign_history(),hon.validate_campaign_window(text,text,boolean),hon.validate_campaign_input(jsonb,boolean),hon.campaign_summary(uuid),hon.guard_campaign_record(),hon.require_campaign_actor(text,text),hon.lock_campaign_actor(text,text),hon.resolve_campaign_scope(text,text),hon.authorize_campaign_lead(text,boolean),hon.mutate_campaign(text,text,uuid,jsonb,text,uuid,uuid),hon.read_campaigns(text,text,uuid,text,text,integer),hon.capture_lead_attribution(),hon.guard_campaign_evidence_insert(),hon.check_campaign_current_version() FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.marketing_campaigns,hon.marketing_campaign_versions,hon.marketing_campaign_requests,hon.crm_lead_attributions FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_campaign_history(),hon.validate_campaign_window(text,text,boolean),hon.validate_campaign_input(jsonb,boolean),hon.campaign_summary(uuid),hon.guard_campaign_record(),hon.require_campaign_actor(text,text),hon.lock_campaign_actor(text,text),hon.resolve_campaign_scope(text,text),hon.authorize_campaign_lead(text,boolean),hon.mutate_campaign(text,text,uuid,jsonb,text,uuid,uuid),hon.read_campaigns(text,text,uuid,text,text,integer),hon.capture_lead_attribution(),hon.guard_campaign_evidence_insert(),hon.check_campaign_current_version() FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.resolve_campaign_scope(text,text),hon.authorize_campaign_lead(text,boolean),hon.mutate_campaign(text,text,uuid,jsonb,text,uuid,uuid),hon.read_campaigns(text,text,uuid,text,text,integer) TO hon_runtime; END IF;
END $$;
COMMIT;
