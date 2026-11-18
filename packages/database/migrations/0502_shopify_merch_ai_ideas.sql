BEGIN;

-- Merch Studio AI ideas, CS-M2 (0502). Commerce step 3 (owner vision 2026-11-18, section 7): Marcus writes up to three merch
-- product ideas (title, description, product type, suggested price, print notes) from the owner's brief. It is the second
-- kind on the shared AI text proposals of 0489 (docs/architecture/AI_TEXT_PROPOSALS.md): one kinds row and its own entry
-- points. The 0489 core and every S4 function are unchanged. Spec: docs/architecture/SHOPIFY_COMMERCE.md (CS-M2).
--   M1 Who: a direct human with commerce.shopify.manage at the session school (0405 rules), marketing.assistant.use and
--      ai.invocation.plan there, and an active Complete entitlement. Only the requester prepares, records or closes; anyone
--      who may read the store reads.
--   M2 Gate: the school's store must be CONNECTED when the request starts and again at the final claim (else GATE_CLOSED,
--      nothing sent). S4 (HQ pause, access, the school's cost ceiling, the organization ceiling) is decided by the core.
--   M3 Facts: the brief, the school name, the store currency, the saved brand color and up to 30 existing product titles
--      (shortened). No customer, order, family, student or billing data is read.
--   M4 Result: {summary, ideas[1..3]}; checked in shape here and in full by the contracts validator in the API. An answer
--      outside the shape is stored empty and RESULT_REJECTED with its usage kept. An idea is text only: it changes nothing.
--      Using one opens the SH4a draft form; Shopify is changed only by an approved SH4a change.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Merch AI ideas require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Merch AI ideas require a restricted runtime';
  END IF;
  IF to_regclass('hon.ai_text_proposals') IS NULL OR to_regprocedure('hon.ai_text_begin(text,uuid,text,uuid,integer,jsonb)') IS NULL
    OR to_regprocedure('hon.shopify_actor(text,uuid,boolean)') IS NULL OR to_regprocedure('hon.shopify_current(uuid)') IS NULL
    OR to_regclass('hon.shopify_product_changes') IS NULL OR to_regclass('hon.school_page_branding') IS NULL
    OR to_regprocedure('hon.marketing_safe_text(text,integer)') IS NULL OR to_regprocedure('hon.begin_shopify_merch_ideas(text,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Merch AI ideas require migrations through 0496 and 0489 and must apply once';
  END IF;
END $$;

INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('MERCH_IDEAS','marcus','DRAFT_MARKETING',6000,3000,80000,12288,'HUMAN_UI','SHOPIFY_STORE','MERCH_IDEAS');

-- The closed brief vocabulary (the same lists as the web Merch Studio).
CREATE FUNCTION hon.shopify_merch_kinds() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['TSHIRT','HOODIE','RASHGUARD','HAT','BAG','BOTTLE','STICKER','PATCH']
$$;
CREATE FUNCTION hon.shopify_merch_styles() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['MINIMAL','ATHLETIC','STREETWEAR','CLASSIC','PREMIUM']
$$;
CREATE FUNCTION hon.shopify_merch_keys_are(p jsonb, k text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p)='object'
    AND coalesce((SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p) x), ARRAY[]::text[]) = (SELECT array_agg(y ORDER BY y) FROM unnest(k) y)
$$;

-- {kind, styles[1..3] distinct, colors[0..10] distinct safe text up to 40, notes '' or safe text up to 500}.
CREATE FUNCTION hon.shopify_merch_brief_ok(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.shopify_merch_keys_are(p,ARRAY['colors','kind','notes','styles'])
    AND jsonb_typeof(p->'kind')='string' AND (p->>'kind')=ANY(hon.shopify_merch_kinds())
    AND jsonb_typeof(p->'styles')='array' AND jsonb_array_length(p->'styles') BETWEEN 1 AND 3
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'styles') s WHERE jsonb_typeof(s)<>'string' OR NOT (s#>>'{}')=ANY(hon.shopify_merch_styles()))
    AND (SELECT count(DISTINCT s#>>'{}') FROM jsonb_array_elements(p->'styles') s)=jsonb_array_length(p->'styles')
    AND jsonb_typeof(p->'colors')='array' AND jsonb_array_length(p->'colors')<=10
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'colors') c WHERE jsonb_typeof(c)<>'string' OR (c#>>'{}')<>btrim(c#>>'{}') OR NOT hon.marketing_safe_text(c#>>'{}',40))
    AND (SELECT count(DISTINCT lower(c#>>'{}')) FROM jsonb_array_elements(p->'colors') c)=jsonb_array_length(p->'colors')
    AND jsonb_typeof(p->'notes')='string' AND ((p->>'notes')='' OR ((p->>'notes')=btrim(p->>'notes') AND hon.marketing_safe_text(p->>'notes',500)))
$$;

-- What an answer may hold. The contracts validator checks the same shape again and more (requested styles, money text).
CREATE FUNCTION hon.shopify_merch_ideas_ok(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.shopify_merch_keys_are(r,ARRAY['ideas','summary'])
    AND jsonb_typeof(r->'summary')='string' AND hon.marketing_safe_text(r->>'summary',300)
    AND jsonb_typeof(r->'ideas')='array' AND jsonb_array_length(r->'ideas') BETWEEN 1 AND 3 AND octet_length(convert_to(r::text,'UTF8'))<=12288
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'ideas') i WHERE NOT (
      hon.shopify_merch_keys_are(i,ARRAY['description','price','printNotes','productType','style','title'])
      AND jsonb_typeof(i->'style')='string' AND (i->>'style')=ANY(hon.shopify_merch_styles())
      AND jsonb_typeof(i->'title')='string' AND hon.marketing_safe_text(i->>'title',120)
      AND jsonb_typeof(i->'description')='string' AND hon.marketing_safe_text(i->>'description',1200)
      AND jsonb_typeof(i->'productType')='string' AND hon.marketing_safe_text(i->>'productType',60)
      AND jsonb_typeof(i->'printNotes')='string' AND hon.marketing_safe_text(i->>'printNotes',300)
      AND (jsonb_typeof(i->'price')='null' OR (jsonb_typeof(i->'price')='string' AND (i->>'price') ~ '^(0|[1-9][0-9]{0,5})(\.[0-9]{2})?$'))))
$$;

-- The requester for a command: Shopify manage at the session school, the Marcus capability, AI planning and Complete.
CREATE FUNCTION hon.shopify_merch_ai_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  org := hon.current_organization_id(); school := hon.current_school_id();
  actor := hon.shopify_actor(p_subject, school, true);
  IF actor IS NULL OR NOT hon.principal_has_school_permission(actor,org,school,'marketing.assistant.use')
    OR NOT hon.principal_has_school_permission(actor,org,school,'ai.invocation.plan')
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.tier='COMPLETE' AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'SHOPIFY_MERCH_AI_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- A reader: Shopify read or manage at the session school (0405 rules).
CREATE FUNCTION hon.shopify_merch_ai_reader(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  actor := hon.shopify_actor(p_subject, hon.current_school_id(), false);
  IF actor IS NULL THEN RAISE EXCEPTION 'SHOPIFY_MERCH_AI_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- The facts Marcus sees, at most about 4 KB: the brief, the school name, the store currency, the brand color and up to 30
-- existing product titles so ideas do not repeat them.
CREATE FUNCTION hon.shopify_merch_ai_facts(p_brief jsonb, p_connection uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('brief',p_brief,'schoolName',left(s.name,120),'currency',c.currency,
    'brandColor',(SELECT b.accent_color FROM hon.school_page_branding b WHERE b.school_id=c.school_id AND b.organization_id=c.organization_id),
    'existingProducts',coalesce((SELECT jsonb_agg(t ORDER BY t) FROM (SELECT left(p.title,80) t FROM hon.shopify_products p
      WHERE p.connection_id=c.id AND p.school_id=c.school_id AND p.organization_id=c.organization_id ORDER BY p.title LIMIT 30) x),'[]'::jsonb))
  FROM hon.shopify_connections c JOIN hon.schools s ON s.id=c.school_id AND s.organization_id=c.organization_id
  WHERE c.id=p_connection AND c.school_id=hon.current_school_id() AND c.organization_id=hon.current_organization_id()
$$;

CREATE FUNCTION hon.shopify_merch_ai_view(p_id uuid, p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
    'reason',i.reason,'brief',i.request,'mine',i.requested_by=p_actor,
    'summary',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->>'summary' END,
    'ideas',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->'ideas' END,
    'problems',coalesce(i.result_problems,'[]'::jsonb),
    'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i
  WHERE i.id=p_id AND i.kind='MERCH_IDEAS' AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- Entry points (granted to hon_runtime).
CREATE FUNCTION hon.begin_shopify_merch_ideas(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.shopify_merch_ai_actor(p_subject); c hon.shopify_connections%ROWTYPE; pid uuid; origin text;
BEGIN
  IF p_key IS NULL OR NOT hon.shopify_merch_brief_ok(p_input) THEN RAISE EXCEPTION 'SHOPIFY_MERCH_AI_INVALID' USING ERRCODE='22023'; END IF;
  origin := actor::text||':'||p_key::text;
  c := hon.shopify_current(hon.current_school_id());
  -- A new request needs a connected store; an exact retry of an accepted request replays even after a disconnect.
  IF (c.id IS NULL OR c.status<>'CONNECTED') AND NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE kind='MERCH_IDEAS' AND origin_key=origin) THEN
    RAISE EXCEPTION 'SHOPIFY_MERCH_AI_NOT_CONNECTED' USING ERRCODE='P0002';
  END IF;
  pid := hon.ai_text_begin('MERCH_IDEAS',actor,origin,c.id,NULL,p_input);
  RETURN hon.shopify_merch_ai_view(pid,actor);
END $$;

CREATE FUNCTION hon.shopify_merch_ideas_planning_reference(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  RETURN hon.ai_text_planning_reference(p_id, hon.shopify_merch_ai_actor(p_subject));
END $$;

-- The final claim: the organization budget lock FIRST (0194 order), then authority, then the store gate, the core claim, the facts.
CREATE FUNCTION hon.prepare_shopify_merch_ideas(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.shopify_merch_ai_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; c hon.shopify_connections%ROWTYPE; inv jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'MERCH_IDEAS' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO c FROM hon.shopify_connections WHERE id=i.subject_id AND organization_id=i.organization_id AND school_id=i.school_id FOR SHARE;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, CASE WHEN NOT FOUND OR c.status<>'CONNECTED' THEN 'GATE_CLOSED' END);
  IF inv IS NULL THEN RETURN NULL; END IF;
  RETURN inv || jsonb_build_object('request',hon.shopify_merch_ai_facts(i.request,c.id)::text);
END $$;

-- Outcome writers resolve the human requester only (0193 evidence rule): a call in flight when access lapsed still records.
CREATE FUNCTION hon.fail_shopify_merch_ideas(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MERCH_IDEAS') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

-- p_result = {usage, proposal, problems}. A proposal outside the closed shape is stored empty and rejected.
CREATE FUNCTION hon.record_shopify_merch_ideas(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); proposal jsonb; problems jsonb; status text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MERCH_IDEAS') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT hon.shopify_merch_keys_are(p_result,ARRAY['problems','proposal','usage']) THEN RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023'; END IF;
  proposal := p_result->'proposal'; problems := p_result->'problems';
  IF NOT hon.shopify_merch_ideas_ok(proposal) THEN
    proposal := jsonb_build_object('summary','','ideas','[]'::jsonb);
    problems := CASE WHEN jsonb_typeof(problems)='array' THEN problems ELSE '[]'::jsonb END || to_jsonb('The answer was not a list of merch ideas.'::text);
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', proposal, problems);
  RETURN hon.shopify_merch_ai_view(p_id, actor) || jsonb_build_object('recorded',status);
END $$;

-- The school's newest 20 idea requests for anyone who may read the store, or one by id.
CREATE FUNCTION hon.read_shopify_merch_ideas(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.shopify_merch_ai_reader(p_subject); v jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    v := hon.shopify_merch_ai_view(p_id, actor);
    IF v IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN v;
  END IF;
  RETURN coalesce((SELECT jsonb_agg(hon.shopify_merch_ai_view(x.id, actor) ORDER BY x.created_at DESC, x.id)
    FROM (SELECT id, created_at FROM hon.ai_text_proposals WHERE kind='MERCH_IDEAS' AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
      ORDER BY created_at DESC, id LIMIT 20) x),'[]'::jsonb);
END $$;

-- APPLIED once the requester used an idea (it was saved for approval as an SH4a draft), or DISMISSED. The requester only;
-- they must still be able to read the store.
CREATE FUNCTION hon.close_shopify_merch_ideas(p_subject text, p_id uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.shopify_merch_ai_reader(p_subject);
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MERCH_IDEAS') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_close(p_id, actor, p_status);
  RETURN hon.shopify_merch_ai_view(p_id, actor);
END $$;

-- Privileges: deny first, then exactly the seven entry points for the runtime role.
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.shopify_merch_kinds()','hon.shopify_merch_styles()','hon.shopify_merch_keys_are(jsonb,text[])','hon.shopify_merch_brief_ok(jsonb)',
    'hon.shopify_merch_ideas_ok(jsonb)','hon.shopify_merch_ai_actor(text)','hon.shopify_merch_ai_reader(text)','hon.shopify_merch_ai_facts(jsonb,uuid)',
    'hon.shopify_merch_ai_view(uuid,uuid)','hon.begin_shopify_merch_ideas(text,jsonb,uuid)','hon.shopify_merch_ideas_planning_reference(text,uuid)',
    'hon.prepare_shopify_merch_ideas(text,uuid,uuid,boolean)','hon.fail_shopify_merch_ideas(text,uuid,text,text)','hon.record_shopify_merch_ideas(text,uuid,jsonb)',
    'hon.read_shopify_merch_ideas(text,uuid)','hon.close_shopify_merch_ideas(text,uuid,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_shopify_merch_ideas(text,jsonb,uuid), hon.shopify_merch_ideas_planning_reference(text,uuid),
      hon.prepare_shopify_merch_ideas(text,uuid,uuid,boolean), hon.fail_shopify_merch_ideas(text,uuid,text,text),
      hon.record_shopify_merch_ideas(text,uuid,jsonb), hon.read_shopify_merch_ideas(text,uuid), hon.close_shopify_merch_ideas(text,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
