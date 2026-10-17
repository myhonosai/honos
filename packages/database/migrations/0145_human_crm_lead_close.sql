BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'CRM lead close requires a trusted migration owner';
  END IF;
END $$;
INSERT INTO hon.permissions(code, description, is_sensitive, is_staff_assignable)
VALUES ('crm.lead.close','Direct human current OPEN lead close, CRM-only; not enrollment or payment',true,true);
INSERT INTO hon.role_permissions(role_id, organization_id, permission_code)
SELECT id, organization_id, 'crm.lead.close' FROM hon.roles WHERE is_system_role AND code = 'OWNER' ON CONFLICT DO NOTHING;

-- Private immutable replay/note evidence. No runtime table ACL or RLS policy.
CREATE TABLE hon.crm_lead_close_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, lead_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL, fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  UNIQUE (lead_id),
  FOREIGN KEY (lead_id,organization_id,school_id) REFERENCES hon.crm_leads(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.crm_lead_close_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_lead_close_requests FORCE ROW LEVEL SECURITY;
CREATE FUNCTION hon.guard_crm_lead_close_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_CRM_LEAD_CLOSE_RECEIPT' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER crm_lead_close_immutable BEFORE UPDATE OR DELETE ON hon.crm_lead_close_requests
FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_lead_close_history();
CREATE TRIGGER crm_lead_close_no_truncate BEFORE TRUNCATE ON hon.crm_lead_close_requests
FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_crm_lead_close_history();

CREATE FUNCTION hon.crm_lead_close_has_permission(actor uuid, org uuid, school uuid, permission text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT permission IN ('crm.lead.read','crm.lead.close') AND hon.staff_member_eligible(actor,org,school) AND EXISTS (
    SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
    JOIN hon.role_permissions rp ON rp.role_id = r.id AND rp.organization_id = r.organization_id
    JOIN hon.permissions p ON p.code = rp.permission_code
    WHERE g.principal_id = actor AND g.organization_id = org AND g.school_id = school AND p.code = permission AND p.is_staff_assignable
      AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (r.management_school_id IS NULL OR r.management_school_id = school)
      AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
$$;
CREATE FUNCTION hon.resolve_crm_lead_close_scope(subject text, selected_school uuid)
RETURNS TABLE (principal_id uuid, organization_id uuid, school_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT DISTINCT p.id, s.organization_id, s.id FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  JOIN hon.schools s ON s.id = selected_school
  WHERE u.external_subject = subject AND length(subject) BETWEEN 1 AND 200 AND btrim(subject) = subject
    AND p.is_active
    AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1
    AND hon.crm_lead_close_has_permission(p.id,s.organization_id,s.id,'crm.lead.read')
    AND hon.crm_lead_close_has_permission(p.id,s.organization_id,s.id,'crm.lead.close')
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()))
    AND NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
      WHERE g.principal_id = p.id AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id = s.organization_id
      AND e.status = 'ACTIVE' AND e.tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND e.effective_from <= clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until > clock_timestamp()))
$$;
CREATE FUNCTION hon.require_crm_lead_close_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := nullif(current_setting('app.hon_principal_id',true),'')::uuid;
BEGIN
  IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM hon.resolve_crm_lead_close_scope(subject,hon.current_school_id()) s
      WHERE s.principal_id = actor AND s.organization_id = hon.current_organization_id()) THEN
    RAISE EXCEPTION 'CRM_LEAD_CLOSE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END $$;

-- Defense against the older generic runtime UPDATE grant. An invoker trigger
-- observes the fixed command's trusted owner, not a caller-forgeable GUC alone.
CREATE FUNCTION hon.guard_crm_lead_close_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF OLD.status IN ('WON','LOST') OR NEW.status IN ('WON','LOST')
    OR (NEW.won_at,NEW.lost_at) IS DISTINCT FROM (OLD.won_at,OLD.lost_at) THEN
    IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'hon.close_crm_lead(text,uuid,jsonb,uuid,uuid,uuid)'::regprocedure)
      OR current_setting('app.hon_crm_close_lead_id',true) IS DISTINCT FROM OLD.id::text
      OR OLD.status <> 'OPEN' OR NEW.status NOT IN ('WON','LOST') OR NEW.version <> OLD.version + 1
      OR (to_jsonb(NEW) - ARRAY['status','won_at','lost_at','version','updated_at']) IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status','won_at','lost_at','version','updated_at'])
      OR (NEW.status = 'WON') <> (NEW.won_at IS NOT NULL) OR (NEW.status = 'LOST') <> (NEW.lost_at IS NOT NULL) THEN
      RAISE EXCEPTION 'FIXED_HUMAN_CRM_CLOSE_REQUIRED' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_lead_close_update_guard BEFORE UPDATE ON hon.crm_leads
FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_lead_close_update();

CREATE FUNCTION hon.close_crm_lead(subject text, selected_lead uuid, p jsonb, key uuid, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; org uuid := hon.current_organization_id(); school uuid := hon.current_school_id();
  prior hon.crm_leads%ROWTYPE; receipt hon.crm_lead_close_requests%ROWTYPE;
  fp text; result jsonb; evidence jsonb; closed timestamptz; note text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023'; END IF;
  IF NOT p ?& ARRAY['status','expectedVersion'] OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('status','expectedVersion','closeNote'))
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('WON','LOST')
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR p->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$'
    OR (p->>'expectedVersion')::numeric > 999999998 OR selected_lead IS NULL OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
  END IF;
  IF p ? 'closeNote' THEN
    note := p->>'closeNote';
    IF jsonb_typeof(p->'closeNote') IS DISTINCT FROM 'string' OR length(note) NOT BETWEEN 1 AND 2000
      OR btrim(note,E' \t\n\r') <> note OR replace(note,E'\n','') ~ '[[:cntrl:]\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]'
      OR note ~ '^[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]|[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]$' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
    END IF;
  END IF;
  actor := hon.require_crm_lead_close_actor(subject);
  -- Protect revocation/mixed identity/role/entitlement phantoms through commit.
  LOCK TABLE hon.users, hon.principals, hon.principal_role_grants, hon.roles, hon.role_permissions, hon.permissions,
    hon.hq_operator_grants, hon.family_access_grants, hon.organizations, hon.schools, hon.organization_entitlements IN SHARE MODE;
  actor := hon.require_crm_lead_close_actor(subject);
  SELECT * INTO prior FROM hon.crm_leads l WHERE l.id = selected_lead AND l.organization_id = org AND l.school_id = school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_LEAD_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  fp := encode(sha256(convert_to(jsonb_build_object('command','crm.lead.close','leadId',selected_lead,'input',p)::text,'UTF8')),'hex');
  SELECT * INTO receipt FROM hon.crm_lead_close_requests r
    WHERE r.organization_id = org AND r.school_id = school AND r.principal_id = actor AND r.idempotency_key = key;
  IF FOUND THEN
    IF receipt.fingerprint <> fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    PERFORM hon.require_crm_lead_close_actor(subject);
    RETURN jsonb_build_object('receipt',receipt.response,'replayed',true);
  END IF;
  IF prior.status <> 'OPEN' OR prior.version <> (p->>'expectedVersion')::integer THEN
    RAISE EXCEPTION 'CRM_LEAD_CLOSE_CONFLICT' USING ERRCODE = '40001';
  END IF;
  closed := clock_timestamp();
  PERFORM set_config('app.hon_crm_close_lead_id',selected_lead::text,true);
  UPDATE hon.crm_leads SET status = (p->>'status')::hon.lead_status,
    won_at = CASE WHEN p->>'status' = 'WON' THEN closed END, lost_at = CASE WHEN p->>'status' = 'LOST' THEN closed END,
    version = version + 1, updated_at = closed
    WHERE id = prior.id AND organization_id = org AND school_id = school AND status = 'OPEN' AND version = (p->>'expectedVersion')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_LEAD_CLOSE_CONFLICT' USING ERRCODE = '40001'; END IF;
  PERFORM set_config('app.hon_crm_close_lead_id','',true);
  result := jsonb_build_object('organizationId',org,'schoolId',school,'leadId',prior.id,'status',p->>'status',
    'priorVersion',prior.version,'version',prior.version+1,'closedAt',to_char(closed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'closeNote',note,'crmOnly',true);
  evidence := (result - 'closeNote') || jsonb_build_object('humanOnly',true,'internalOnly',true,'executionAllowed',false);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
  VALUES (org,school,actor,'HUMAN_UI','crm.lead.close','CRM_LEAD',prior.id,jsonb_build_object('status','OPEN','version',prior.version),evidence,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
  VALUES (org,school,'crm.lead.human_closed',1,'CRM_LEAD',prior.id,prior.version+1,correlation,request,evidence);
  INSERT INTO hon.crm_lead_close_requests(organization_id,school_id,lead_id,principal_id,idempotency_key,fingerprint,response)
  VALUES (org,school,prior.id,actor,key,fp,result);
  PERFORM hon.require_crm_lead_close_actor(subject);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;
COMMENT ON FUNCTION hon.close_crm_lead(text,uuid,jsonb,uuid,uuid,uuid) IS
  'Direct HUMAN_UI only; current OPEN expected version -> WON/LOST CRM recordkeeping. No enrollment/payment/conversion or executable event.';

REVOKE ALL ON TABLE hon.crm_lead_close_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_crm_lead_close_history(), hon.crm_lead_close_has_permission(uuid,uuid,uuid,text),
  hon.resolve_crm_lead_close_scope(text,uuid), hon.require_crm_lead_close_actor(text), hon.guard_crm_lead_close_update(),
  hon.close_crm_lead(text,uuid,jsonb,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','hon_runtime') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.crm_lead_close_requests FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_crm_lead_close_history(), hon.crm_lead_close_has_permission(uuid,uuid,uuid,text), hon.resolve_crm_lead_close_scope(text,uuid), hon.require_crm_lead_close_actor(text), hon.guard_crm_lead_close_update(), hon.close_crm_lead(text,uuid,jsonb,uuid,uuid,uuid) FROM %I',r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.resolve_crm_lead_close_scope(text,uuid), hon.close_crm_lead(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
