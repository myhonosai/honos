BEGIN;

-- Commerce review, CA1 (0615). Commerce step 7, the agent (owner vision 2026-11-18, section 13), first piece: the owner asks
-- how the store is doing and Marcus answers with a short summary, findings and recommendations. It is the third kind on the
-- shared AI text proposals of 0550 (docs/architecture/AI_TEXT_PROPOSALS.md), built exactly like MERCH_IDEAS (0596): one kinds
-- row and its own entry points. The 0550 core, every S4 function and the 0596 helpers are unchanged.
-- Spec: docs/architecture/SHOPIFY_COMMERCE.md (CA1).
--   R1 Who: the 0596 rule (hon.shopify_merch_ai_actor): a direct human with commerce.shopify.manage at the session school,
--      marketing.assistant.use and ai.invocation.plan there, and an active Complete entitlement. Only the requester prepares,
--      records or closes; anyone who may read the store reads.
--   R2 Gate: the school's store must be CONNECTED when the request starts and again at the final claim (else GATE_CLOSED,
--      nothing sent). S4 (HQ pause, access, the school's cost ceiling, the organization ceiling) is decided by the core.
--   R3 Facts: store totals only, at most about 5 KB: the 30-day order summary of the Overview, product and variant counts,
--      up to 12 low-stock variants, up to 12 thinnest-margin variants, how many variants have no cost, and how many front-desk
--      stock changes and orders have not reached Shopify. No customer, order name, address, family, student or billing data.
--   R4 Result: {summary, findings[1..5], recommendations[0..5]}, text only. A review changes nothing in HON or Shopify and
--      opens no draft; it can only be marked reviewed (APPLIED) or dismissed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Commerce review requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Commerce review requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.shopify_merch_ai_actor(text)') IS NULL OR to_regprocedure('hon.shopify_merch_ai_reader(text)') IS NULL
    OR to_regprocedure('hon.shopify_merch_keys_are(jsonb,text[])') IS NULL OR to_regclass('hon.pos_shopify_orders') IS NULL
    OR to_regclass('hon.pos_shopify_stock_tasks') IS NULL
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='hon' AND table_name='shopify_variants' AND column_name='fulfilled_by')
    OR to_regprocedure('hon.begin_shopify_commerce_review(text,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Commerce review requires migrations through 0596, 0611 and 0614 and must apply once';
  END IF;
END $$;

INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('COMMERCE_REVIEW','marcus','DRAFT_MARKETING',9000,2500,80000,12288,'HUMAN_UI','SHOPIFY_STORE','COMMERCE_REVIEW');

-- The closed vocabularies (the same lists as the contracts validator and the web page).
CREATE FUNCTION hon.shopify_review_focuses() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['OVERVIEW','SALES','PRICING','STOCK']
$$;
CREATE FUNCTION hon.shopify_review_areas() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['SALES','PRICING','STOCK','PRODUCTS','FRONT_DESK']
$$;

-- {focus, question '' or safe text up to 300}.
CREATE FUNCTION hon.shopify_review_brief_ok(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.shopify_merch_keys_are(p,ARRAY['focus','question'])
    AND jsonb_typeof(p->'focus')='string' AND (p->>'focus')=ANY(hon.shopify_review_focuses())
    AND jsonb_typeof(p->'question')='string' AND ((p->>'question')='' OR ((p->>'question')=btrim(p->>'question') AND hon.marketing_safe_text(p->>'question',300)))
$$;

-- What an answer may hold. The contracts validator checks the same shape again.
CREATE FUNCTION hon.shopify_review_ok(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.shopify_merch_keys_are(r,ARRAY['findings','recommendations','summary'])
    AND jsonb_typeof(r->'summary')='string' AND hon.marketing_safe_text(r->>'summary',500)
    AND jsonb_typeof(r->'findings')='array' AND jsonb_array_length(r->'findings') BETWEEN 1 AND 5
    AND jsonb_typeof(r->'recommendations')='array' AND jsonb_array_length(r->'recommendations')<=5
    AND octet_length(convert_to(r::text,'UTF8'))<=12288
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements((r->'findings')||(r->'recommendations')) i WHERE NOT (
      hon.shopify_merch_keys_are(i,ARRAY['area','detail','title'])
      AND jsonb_typeof(i->'area')='string' AND (i->>'area')=ANY(hon.shopify_review_areas())
      AND jsonb_typeof(i->'title')='string' AND hon.marketing_safe_text(i->>'title',100)
      AND jsonb_typeof(i->'detail')='string' AND hon.marketing_safe_text(i->>'detail',500)))
$$;

-- The facts Marcus sees: totals of the school's own store mirror. Titles are shortened; no person appears anywhere.
CREATE FUNCTION hon.shopify_review_facts(p_brief jsonb, p_connection uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH c AS (SELECT c.*, s.name school_name FROM hon.shopify_connections c JOIN hon.schools s ON s.id=c.school_id AND s.organization_id=c.organization_id
      WHERE c.id=p_connection AND c.school_id=hon.current_school_id() AND c.organization_id=hon.current_organization_id()),
    o AS (SELECT x.* FROM hon.shopify_orders x JOIN c ON c.id=x.connection_id WHERE x.placed_at>=clock_timestamp()-interval '30 days' AND x.cancelled_at IS NULL),
    l AS (SELECT ol.title,ol.quantity,ol.unit_price,v.unit_cost FROM hon.shopify_order_lines ol JOIN o ON o.connection_id=ol.connection_id AND o.shopify_id=ol.order_shopify_id
      LEFT JOIN hon.shopify_variants v ON v.connection_id=ol.connection_id AND v.shopify_id=ol.variant_shopify_id),
    v AS (SELECT left(p.title,60) product, left(v.title,40) variant, v.price, v.unit_cost, v.tracked, v.inventory_quantity, v.fulfilled_by
      FROM hon.shopify_variants v JOIN c ON c.id=v.connection_id
      JOIN hon.shopify_products p ON p.connection_id=v.connection_id AND p.shopify_id=v.product_shopify_id
      WHERE NOT v.removed AND NOT p.removed AND p.status='ACTIVE')
  SELECT jsonb_build_object('brief',p_brief,'schoolName',left(c.school_name,120),'currency',c.currency,
    'last30Days',jsonb_build_object(
      'orders',(SELECT count(*)::int FROM o),
      'sales',(SELECT round(coalesce(sum(total),0),2) FROM o),
      'averageOrder',(SELECT CASE WHEN count(*)=0 THEN 0 ELSE round(sum(total)/count(*),2) END FROM o),
      'itemsSold',(SELECT coalesce(sum(quantity),0)::int FROM l),
      'lineSales',(SELECT round(coalesce(sum(quantity*unit_price),0),2) FROM l),
      'salesWithKnownCost',(SELECT round(coalesce(sum(quantity*unit_price),0),2) FROM l WHERE unit_cost IS NOT NULL),
      'estimatedGrossProfit',(SELECT round(coalesce(sum(quantity*(unit_price-unit_cost)),0),2) FROM l WHERE unit_cost IS NOT NULL),
      'topProducts',(SELECT coalesce(jsonb_agg(t ORDER BY (t->>'quantity')::int DESC,t->>'title'),'[]'::jsonb) FROM (
        SELECT jsonb_build_object('title',left(title,60),'quantity',sum(quantity)::int,'sales',round(sum(quantity*unit_price),2)) t
        FROM l GROUP BY title ORDER BY sum(quantity) DESC,title LIMIT 8) x)),
    'catalog',jsonb_build_object(
      'activeVariants',(SELECT count(*)::int FROM v),
      'madeToOrderVariants',(SELECT count(*)::int FROM v WHERE fulfilled_by IS NOT NULL),
      'variantsWithoutCost',(SELECT count(*)::int FROM v WHERE unit_cost IS NULL),
      'lowStock',(SELECT coalesce(jsonb_agg(t ORDER BY (t->>'quantity')::int,t->>'product',t->>'variant'),'[]'::jsonb) FROM (
        SELECT jsonb_build_object('product',product,'variant',variant,'quantity',coalesce(inventory_quantity,0)) t
        FROM v WHERE fulfilled_by IS NULL AND tracked AND coalesce(inventory_quantity,0)<=3
        ORDER BY coalesce(inventory_quantity,0),product,variant LIMIT 12) x),
      'thinnestMargins',(SELECT coalesce(jsonb_agg(t ORDER BY (t->>'marginPercent')::numeric,t->>'product',t->>'variant'),'[]'::jsonb) FROM (
        SELECT jsonb_build_object('product',product,'variant',variant,'price',round(price,2),'cost',round(unit_cost,2),
          'marginPercent',round((price-unit_cost)*100/price,1)) t
        FROM v WHERE unit_cost IS NOT NULL AND price>0
        ORDER BY (price-unit_cost)/price,product,variant LIMIT 12) x)),
    'frontDesk',jsonb_build_object(
      'stockChangesNotSent',(SELECT count(*)::int FROM hon.pos_shopify_stock_tasks t WHERE t.connection_id=c.id AND t.school_id=c.school_id AND t.status IN ('PENDING','FAILED')),
      'ordersNotSent',(SELECT count(*)::int FROM hon.pos_shopify_orders t WHERE t.connection_id=c.id AND t.school_id=c.school_id
        AND (t.status='PENDING' OR (t.status='FAILED' AND t.failure_code IS DISTINCT FROM 'SALE_REFUNDED')))))
  FROM c
$$;

CREATE FUNCTION hon.shopify_review_view(p_id uuid, p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
    'reason',i.reason,'brief',i.request,'mine',i.requested_by=p_actor,
    'summary',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->>'summary' END,
    'findings',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->'findings' END,
    'recommendations',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->'recommendations' END,
    'problems',coalesce(i.result_problems,'[]'::jsonb),
    'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i
  WHERE i.id=p_id AND i.kind='COMMERCE_REVIEW' AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- Entry points (granted to hon_runtime).
CREATE FUNCTION hon.begin_shopify_commerce_review(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.shopify_merch_ai_actor(p_subject); c hon.shopify_connections%ROWTYPE; pid uuid; origin text;
BEGIN
  IF p_key IS NULL OR NOT hon.shopify_review_brief_ok(p_input) THEN RAISE EXCEPTION 'SHOPIFY_REVIEW_INVALID' USING ERRCODE='22023'; END IF;
  origin := actor::text||':'||p_key::text;
  c := hon.shopify_current(hon.current_school_id());
  -- A new request needs a connected store; an exact retry of an accepted request replays even after a disconnect.
  IF (c.id IS NULL OR c.status<>'CONNECTED') AND NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE kind='COMMERCE_REVIEW' AND origin_key=origin) THEN
    RAISE EXCEPTION 'SHOPIFY_REVIEW_NOT_CONNECTED' USING ERRCODE='P0002';
  END IF;
  pid := hon.ai_text_begin('COMMERCE_REVIEW',actor,origin,c.id,NULL,p_input);
  RETURN hon.shopify_review_view(pid,actor);
END $$;

CREATE FUNCTION hon.plan_shopify_commerce_review(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.shopify_merch_ai_actor(p_subject);
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='COMMERCE_REVIEW' AND organization_id=hon.current_organization_id()
    AND school_id=hon.current_school_id()) THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.ai_text_planning_reference(p_id, actor);
END $$;

-- The final claim: the organization budget lock FIRST (0194 order), then authority, then the store gate, the core claim, the facts.
CREATE FUNCTION hon.prepare_shopify_commerce_review(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.shopify_merch_ai_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; c hon.shopify_connections%ROWTYPE; inv jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'COMMERCE_REVIEW' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO c FROM hon.shopify_connections WHERE id=i.subject_id AND organization_id=i.organization_id AND school_id=i.school_id FOR SHARE;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, CASE WHEN NOT FOUND OR c.status<>'CONNECTED' THEN 'GATE_CLOSED' END);
  IF inv IS NULL THEN RETURN NULL; END IF;
  RETURN inv || jsonb_build_object('request',hon.shopify_review_facts(i.request,c.id)::text);
END $$;

-- Outcome writers resolve the human requester only (0193 evidence rule): a call in flight when access lapsed still records.
CREATE FUNCTION hon.fail_shopify_commerce_review(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='COMMERCE_REVIEW') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

-- p_result = {usage, proposal, problems}. A proposal outside the closed shape is stored empty and rejected.
CREATE FUNCTION hon.record_shopify_commerce_review(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); proposal jsonb; problems jsonb; status text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='COMMERCE_REVIEW') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT hon.shopify_merch_keys_are(p_result,ARRAY['problems','proposal','usage']) THEN RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023'; END IF;
  proposal := p_result->'proposal'; problems := p_result->'problems';
  IF NOT hon.shopify_review_ok(proposal) THEN
    proposal := jsonb_build_object('summary','','findings','[]'::jsonb,'recommendations','[]'::jsonb);
    problems := CASE WHEN jsonb_typeof(problems)='array' THEN problems ELSE '[]'::jsonb END || to_jsonb('The answer was not a commerce review.'::text);
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', proposal, problems);
  RETURN hon.shopify_review_view(p_id, actor) || jsonb_build_object('recorded',status);
END $$;

-- The school's newest 10 reviews for anyone who may read the store, or one by id.
CREATE FUNCTION hon.read_shopify_commerce_reviews(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.shopify_merch_ai_reader(p_subject); v jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    v := hon.shopify_review_view(p_id, actor);
    IF v IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN v;
  END IF;
  RETURN coalesce((SELECT jsonb_agg(hon.shopify_review_view(x.id, actor) ORDER BY x.created_at DESC, x.id)
    FROM (SELECT id, created_at FROM hon.ai_text_proposals WHERE kind='COMMERCE_REVIEW' AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
      ORDER BY created_at DESC, id LIMIT 10) x),'[]'::jsonb);
END $$;

-- APPLIED once the requester marked the review as reviewed, or DISMISSED. The requester only; they must still read the store.
CREATE FUNCTION hon.close_shopify_commerce_review(p_subject text, p_id uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.shopify_merch_ai_reader(p_subject);
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='COMMERCE_REVIEW') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_close(p_id, actor, p_status);
  RETURN hon.shopify_review_view(p_id, actor);
END $$;

-- Privileges: deny first, then exactly the seven entry points for the runtime role.
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.shopify_review_focuses()','hon.shopify_review_areas()','hon.shopify_review_brief_ok(jsonb)','hon.shopify_review_ok(jsonb)',
    'hon.shopify_review_facts(jsonb,uuid)','hon.shopify_review_view(uuid,uuid)','hon.begin_shopify_commerce_review(text,jsonb,uuid)',
    'hon.plan_shopify_commerce_review(text,uuid)','hon.prepare_shopify_commerce_review(text,uuid,uuid,boolean)',
    'hon.fail_shopify_commerce_review(text,uuid,text,text)','hon.record_shopify_commerce_review(text,uuid,jsonb)',
    'hon.read_shopify_commerce_reviews(text,uuid)','hon.close_shopify_commerce_review(text,uuid,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_shopify_commerce_review(text,jsonb,uuid), hon.plan_shopify_commerce_review(text,uuid),
      hon.prepare_shopify_commerce_review(text,uuid,uuid,boolean), hon.fail_shopify_commerce_review(text,uuid,text,text),
      hon.record_shopify_commerce_review(text,uuid,jsonb), hon.read_shopify_commerce_reviews(text,uuid), hon.close_shopify_commerce_review(text,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
