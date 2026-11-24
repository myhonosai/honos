BEGIN;

-- SH2 (0613): the front-desk Point of Sale sells the school's Shopify products. Owner decision 2026-11-21: "Stock now,
-- orders later" - a POS sale of a Shopify product lowers that product's count in Shopify; it does not create a Shopify
-- order (that needs write_orders and every store approving the app again; a later piece).
--
-- * The register shows the variants of the school's CONNECTED store from HON's mirror when the store allowed editing
--   (write_inventory), its currency is the POS currency, the product is ACTIVE and the school stocks it itself (a
--   variant a print provider makes is not handed over at a counter). The price is the mirror's price; the sale is
--   refused with POS_TOTAL_CHANGED when it differs from what the screen showed, like any other line.
-- * A Shopify line is never refused for stock: the item is in the customer's hand, and Shopify's count may be behind.
-- * Every tracked Shopify line queues one stock task (minus the quantity; a refund that puts units back queues plus).
--   The API sends each task to Shopify with the task id as Shopify's idempotency key, so sending twice changes the
--   count once. Until a task is DONE the register shows the mirror count with the waiting change applied; when it is
--   DONE the mirror row takes the change, and the next sync replaces it with Shopify's own number.
-- * Sales tax: a Shopify line is taxable (the mirror does not hold Shopify's per-variant tax flag yet).
-- * HON still moves no money. Tasks, like sales, are evidence: never deleted, and DONE is final.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.pos_sale_lines') IS NULL OR to_regprocedure('hon.shopify_has_scope(text,text)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='hon' AND table_name='shopify_variants' AND column_name='fulfilled_by') THEN
    RAISE EXCEPTION '0613 requires the Point of Sale (0612) and the Shopify mirror with its fulfilment source (0611)'; END IF;
END $$;

-- A sale line can now come from Shopify: no POS item, the Shopify ids instead, category SHOPIFY.
ALTER TABLE hon.pos_sale_lines ADD COLUMN shopify_connection_id uuid, ADD COLUMN shopify_product_id bigint, ADD COLUMN shopify_variant_id bigint;
DO $$ DECLARE c record; n integer:=0; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='hon.pos_sale_lines'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%QUICK%' LOOP
    EXECUTE format('ALTER TABLE hon.pos_sale_lines DROP CONSTRAINT %I',c.conname); n:=n+1;
  END LOOP;
  IF n<>2 THEN RAISE EXCEPTION '0613 expected the two 0612 line checks, found %',n; END IF;
END $$;
ALTER TABLE hon.pos_sale_lines
  ADD CONSTRAINT pos_sale_lines_category_check CHECK (category IN ('TESTING','UNIFORMS','EQUIPMENT','APPAREL','EVENTS','OTHER','QUICK','SHOPIFY')),
  ADD CONSTRAINT pos_sale_lines_source_check CHECK (CASE category
    WHEN 'QUICK' THEN item_id IS NULL AND shopify_variant_id IS NULL AND NOT taxable AND NOT stock_tracked
    WHEN 'SHOPIFY' THEN item_id IS NULL AND shopify_variant_id>0 AND shopify_product_id>0 AND shopify_connection_id IS NOT NULL
    ELSE item_id IS NOT NULL AND shopify_variant_id IS NULL END
    AND (shopify_variant_id IS NULL)=(shopify_product_id IS NULL) AND (shopify_variant_id IS NULL)=(shopify_connection_id IS NULL)),
  ADD CONSTRAINT pos_sale_lines_shopify_fk FOREIGN KEY (shopify_connection_id,organization_id,school_id)
    REFERENCES hon.shopify_connections(id,organization_id,school_id);

-- One change to a Shopify count that a sale (minus) or a refund restock (plus) owes Shopify.
CREATE TABLE hon.pos_shopify_stock_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL, connection_id uuid NOT NULL,
  sale_id uuid NOT NULL, line_id uuid NOT NULL REFERENCES hon.pos_sale_lines(id), refund_id uuid REFERENCES hon.pos_refunds(id),
  variant_shopify_id bigint NOT NULL CHECK (variant_shopify_id>0),
  change integer NOT NULL CHECK (change<>0 AND change BETWEEN -999 AND 999),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE','FAILED')),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z_]{1,40}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100000),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_attempt_at timestamptz, settled_at timestamptz,
  CHECK ((refund_id IS NULL)=(change<0)),
  CHECK ((status='PENDING')=(settled_at IS NULL)),
  CHECK (status<>'DONE' OR failure_code IS NULL), CHECK (status<>'FAILED' OR failure_code IS NOT NULL),
  FOREIGN KEY (sale_id,organization_id,school_id) REFERENCES hon.pos_sales(id,organization_id,school_id),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.shopify_connections(id,organization_id,school_id)
);
CREATE INDEX pos_shopify_stock_tasks_open_idx ON hon.pos_shopify_stock_tasks(school_id,created_at,id) WHERE status<>'DONE';
CREATE INDEX pos_shopify_stock_tasks_sale_idx ON hon.pos_shopify_stock_tasks(sale_id);
CREATE INDEX pos_shopify_stock_tasks_variant_idx ON hon.pos_shopify_stock_tasks(connection_id,variant_shopify_id) WHERE status='PENDING';
ALTER TABLE hon.pos_shopify_stock_tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.pos_shopify_stock_tasks FORCE ROW LEVEL SECURITY;

-- A task keeps what it is and whom it is for; DONE is final; nothing is deleted.
CREATE FUNCTION hon.guard_pos_shopify_stock_task() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'POS_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF OLD.status='DONE' OR NEW.attempts<OLD.attempts
    OR (to_jsonb(NEW)-ARRAY['status','failure_code','attempts','last_attempt_at','settled_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','failure_code','attempts','last_attempt_at','settled_at']) THEN
    RAISE EXCEPTION 'POS_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_shopify_stock_tasks_guard BEFORE UPDATE OR DELETE ON hon.pos_shopify_stock_tasks FOR EACH ROW EXECUTE FUNCTION hon.guard_pos_shopify_stock_task();
CREATE TRIGGER pos_shopify_stock_tasks_no_truncate BEFORE TRUNCATE ON hon.pos_shopify_stock_tasks FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_pos_shopify_stock_task();

-- A Shopify price as POS minor units in the POS currency (KRW and JPY have none), or NULL when it does not fit.
CREATE FUNCTION hon.pos_shopify_minor(p_price numeric,p_currency text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN x=trunc(x) AND x BETWEEN 0 AND 10000000 THEN x::integer END
  FROM (SELECT p_price*CASE WHEN p_currency IN ('KRW','JPY') THEN 1 ELSE 100 END x) t
$$;

-- Whether the school's Shopify store can be sold from the register, and which connection it is.
-- READY: connected, editing allowed, same currency. Otherwise the reason the register shows to a manager.
CREATE FUNCTION hon.pos_shopify_source(p_school uuid,p_currency text,OUT state text,OUT connection_id uuid,OUT shop_name text,OUT shop_domain text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE c hon.shopify_connections%ROWTYPE;
BEGIN
  c:=hon.shopify_current(p_school);
  IF c.id IS NULL OR c.status<>'CONNECTED' THEN state:='NOT_CONNECTED'; RETURN; END IF;
  shop_name:=c.shop_name; shop_domain:=c.shop_domain;
  IF NOT hon.shopify_has_scope(c.scopes,'write_inventory') THEN state:='NEEDS_EDITING'; RETURN; END IF;
  IF c.currency IS DISTINCT FROM p_currency THEN state:='CURRENCY_MISMATCH'; RETURN; END IF;
  state:='READY'; connection_id:=c.id;
END $$;

-- How a sale's Shopify stock changes stand: counts by state (all zero when the sale has no tracked Shopify line).
CREATE FUNCTION hon.pos_shopify_stock_json(p_sale uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('waiting',count(*) FILTER (WHERE t.status='PENDING')::int,'done',count(*) FILTER (WHERE t.status='DONE')::int,
    'failed',count(*) FILTER (WHERE t.status='FAILED')::int)
  FROM hon.pos_shopify_stock_tasks t WHERE t.sale_id=p_sale
$$;

-- The line name for a Shopify variant: the product title, plus the variant title unless it is Shopify's single default.
CREATE FUNCTION hon.pos_shopify_line_name(p_product text,p_variant text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN x='' THEN 'Shopify product' ELSE x END FROM (SELECT btrim(left(regexp_replace(
    CASE WHEN p_variant IS NULL OR p_variant='Default Title' THEN p_product ELSE p_product||' - '||p_variant END,'[\x01-\x1f\x7f]',' ','g'),80)) x) t
$$;

CREATE OR REPLACE FUNCTION hon.pos_sale_json(x hon.pos_sales) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.pos_sale_summary_json(x)||jsonb_build_object(
    'schoolName',(SELECT s.name FROM hon.schools s WHERE s.id=x.school_id),
    'soldBy',(SELECT left(p.display_name,120) FROM hon.principals p WHERE p.id=x.sold_by_principal_id),
    'lines',(SELECT coalesce(jsonb_agg(jsonb_build_object('lineId',l.id,'itemId',l.item_id,'name',l.name,'sku',l.sku,'category',l.category,
        'unitPriceMinor',l.unit_price_minor,'quantity',l.quantity,'lineTotalMinor',l.line_total_minor,'taxable',l.taxable,
        'stockTracked',l.stock_tracked,'restockedQuantity',l.restocked_quantity,
        'shopifyVariantId',l.shopify_variant_id::text) ORDER BY l.line_no),'[]'::jsonb) FROM hon.pos_sale_lines l WHERE l.sale_id=x.id),
    'subtotalMinor',x.subtotal_minor,
    'discount',CASE WHEN x.discount_kind IS NULL THEN NULL ELSE jsonb_build_object('kind',x.discount_kind,'value',x.discount_value,'reason',x.discount_reason,'amountMinor',x.discount_minor) END,
    'taxRateBps',x.tax_rate_bps,'taxMinor',x.tax_minor,'reference',x.reference,'note',x.note,
    'shopifyStock',hon.pos_shopify_stock_json(x.id),
    'refunds',(SELECT coalesce(jsonb_agg(jsonb_build_object('refundId',r.id,'refundedAt',hon.saas_ts(r.created_at),'amountMinor',r.amount_minor,
        'method',r.method,'reason',r.reason,'restocked',r.restocked,
        'refundedBy',(SELECT left(p.display_name,120) FROM hon.principals p WHERE p.id=r.refunded_by_principal_id)) ORDER BY r.created_at),'[]'::jsonb)
      FROM hon.pos_refunds r WHERE r.sale_id=x.id))
$$;

CREATE OR REPLACE FUNCTION hon.read_pos(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_org uuid; manage boolean; tz text; today date; src record; v_currency text;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.pos_actor(p_subject,p_school,false) IS NULL THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  manage:=hon.pos_actor(p_subject,p_school,true) IS NOT NULL;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=p_school;
  tz:=hon.pos_school_tz(p_school); today:=(clock_timestamp() AT TIME ZONE tz)::date;
  v_currency:=hon.pos_settings_json(p_school)->>'currency';
  SELECT * INTO src FROM hon.pos_shopify_source(p_school,v_currency);
  RETURN jsonb_build_object('schoolId',p_school,'timezone',tz,'today',to_char(today,'YYYY-MM-DD'),'canManage',manage,
    'settings',hon.pos_settings_json(p_school),
    'items',(SELECT coalesce(jsonb_agg(hon.pos_item_json(i) ORDER BY i.category,lower(i.name),i.id),'[]'::jsonb) FROM hon.pos_items i
      WHERE i.organization_id=v_org AND i.school_id=p_school AND (i.active OR manage)),
    'todaySales',(SELECT jsonb_build_object('count',count(*)::int,'totalMinor',coalesce(sum(x.total_minor),0)::bigint)
      FROM hon.pos_sales x WHERE x.organization_id=v_org AND x.school_id=p_school AND x.local_date=today),
    -- The store's sellable variants (at most 2000), with the count Shopify will show once the waiting changes are sent.
    'shopify',jsonb_build_object('state',src.state,'shopName',src.shop_name,
      'items',CASE WHEN src.state='READY' THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('variantId',q.shopify_id::text,'productId',q.product_shopify_id::text,
          'name',q.name,'sku',q.sku,'priceMinor',q.price_minor,'tracked',q.tracked,'stock',q.stock,'imageUrl',q.image_url) ORDER BY lower(q.name),q.shopify_id),'[]'::jsonb)
        FROM (SELECT v.shopify_id,v.product_shopify_id,hon.pos_shopify_line_name(p.title,v.title) name,left(v.sku,40) sku,hon.pos_shopify_minor(v.price,v_currency) price_minor,
            v.tracked,p.image_url,CASE WHEN v.tracked THEN coalesce(v.inventory_quantity,0)+coalesce((SELECT sum(t.change) FROM hon.pos_shopify_stock_tasks t
              WHERE t.connection_id=v.connection_id AND t.variant_shopify_id=v.shopify_id AND t.status='PENDING'),0)::int END stock
          FROM hon.shopify_variants v JOIN hon.shopify_products p ON p.connection_id=v.connection_id AND p.shopify_id=v.product_shopify_id
          WHERE v.connection_id=src.connection_id AND NOT v.removed AND NOT p.removed AND p.status='ACTIVE' AND v.fulfilled_by IS NULL
            AND hon.pos_shopify_minor(v.price,v_currency) IS NOT NULL
          ORDER BY lower(p.title),p.shopify_id,v.position LIMIT 2000) q) ELSE '[]'::jsonb END,
      'unsent',(SELECT jsonb_build_object('waiting',count(*) FILTER (WHERE t.status='PENDING')::int,'failed',count(*) FILTER (WHERE t.status='FAILED')::int)
        FROM hon.pos_shopify_stock_tasks t WHERE t.organization_id=v_org AND t.school_id=p_school AND t.status<>'DONE')));
END $$;

-- Input as 0612, and a line may also be {shopifyVariantId, quantity}.
CREATE OR REPLACE FUNCTION hon.record_pos_sale(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; st hon.pos_settings%ROWTYPE; tz text; today date; ln jsonb; n integer:=0; it hon.pos_items%ROWTYPE;
  sub bigint:=0; taxable_sub bigint:=0; disc bigint:=0; tax bigint:=0; total bigint; taxable_after bigint; qty integer;
  sale hon.pos_sales%ROWTYPE; want jsonb:='[]'::jsonb; d jsonb; v_seq integer; src record; sv record; v_price integer;
BEGIN
  IF NOT hon.pos_keys_ok(p_input,ARRAY['schoolId','personId','walkInName','lines','discount','method','reference','note','expectedTotalMinor'],ARRAY[]::text[])
    OR NOT hon.pos_uuid_ok(p_input->'personId',true) OR NOT hon.pos_text_ok(p_input->'walkInName',120,true)
    OR (jsonb_typeof(p_input->'personId')='string' AND jsonb_typeof(p_input->'walkInName')<>'null')
    OR jsonb_typeof(p_input->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'lines') NOT BETWEEN 1 AND 50
    OR jsonb_typeof(p_input->'method') IS DISTINCT FROM 'string' OR p_input->>'method' NOT IN ('CASH','CHECK','CARD_TERMINAL','OTHER')
    OR NOT hon.pos_text_ok(p_input->'reference',120,true) OR NOT hon.pos_text_ok(p_input->'note',500,true)
    OR NOT hon.pos_int_ok(p_input->'expectedTotalMinor',0,200000000) THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  FOR ln IN SELECT value FROM jsonb_array_elements(p_input->'lines') LOOP
    IF NOT (hon.pos_keys_ok(ln,ARRAY['itemId','quantity'],ARRAY[]::text[]) AND hon.pos_uuid_ok(ln->'itemId',false))
      AND NOT (hon.pos_keys_ok(ln,ARRAY['shopifyVariantId','quantity'],ARRAY[]::text[]) AND jsonb_typeof(ln->'shopifyVariantId')='string'
        AND ln->>'shopifyVariantId' ~ '^[1-9][0-9]{0,17}$')
      AND NOT (hon.pos_keys_ok(ln,ARRAY['description','unitPriceMinor','quantity'],ARRAY[]::text[]) AND hon.pos_text_ok(ln->'description',80,false)
        AND hon.pos_int_ok(ln->'unitPriceMinor',1,10000000)) THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
    IF NOT hon.pos_int_ok(ln->'quantity',1,999) THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  d:=p_input->'discount';
  IF NOT (jsonb_typeof(d)='null' OR (hon.pos_keys_ok(d,ARRAY['kind','value','reason'],ARRAY[]::text[])
      AND d->>'kind' IN ('AMOUNT','PERCENT') AND jsonb_typeof(d->'kind')='string'
      AND hon.pos_int_ok(d->'value',1,CASE WHEN d->>'kind'='PERCENT' THEN 100 ELSE 100000000 END) AND hon.pos_text_ok(d->'reason',200,false))) THEN
    RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.pos_begin(p_subject,'sale',p_input,p_key,false);
  IF b.replay IS NOT NULL THEN RETURN b.replay||jsonb_build_object('replayed',true); END IF;
  IF jsonb_typeof(p_input->'personId')='string' THEN
    PERFORM 1 FROM hon.people WHERE id=(p_input->>'personId')::uuid AND organization_id=b.org AND school_id=b.school FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'POS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  END IF;
  tz:=hon.pos_school_tz(b.school); today:=(clock_timestamp() AT TIME ZONE tz)::date;
  -- Lock order: settings row (receipt counter), then catalog items by id.
  st:=hon.pos_lock_settings(b.org,b.school);
  PERFORM 1 FROM hon.pos_items WHERE organization_id=b.org AND school_id=b.school
    AND id IN (SELECT (e->>'itemId')::uuid FROM jsonb_array_elements(p_input->'lines') e WHERE e ? 'itemId') ORDER BY id FOR UPDATE;
  SELECT * INTO src FROM hon.pos_shopify_source(b.school,st.currency::text);
  FOR ln IN SELECT value FROM jsonb_array_elements(p_input->'lines') LOOP
    n:=n+1; qty:=(ln->>'quantity')::integer;
    IF ln ? 'itemId' THEN
      SELECT * INTO it FROM hon.pos_items WHERE id=(ln->>'itemId')::uuid AND organization_id=b.org AND school_id=b.school AND active;
      IF NOT FOUND THEN RAISE EXCEPTION 'POS_ITEM_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
      want:=want||jsonb_build_object('n',n,'item',it.id,'name',it.name,'sku',it.sku,'category',it.category,'price',it.price_minor,'qty',qty,'taxable',it.taxable,'track',it.track_stock);
      sub:=sub+it.price_minor::bigint*qty; IF it.taxable THEN taxable_sub:=taxable_sub+it.price_minor::bigint*qty; END IF;
    ELSIF ln ? 'shopifyVariantId' THEN
      -- The mirror's current price and title for a variant the school stocks itself in its connected store.
      IF src.state<>'READY' THEN RAISE EXCEPTION 'POS_ITEM_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
      SELECT v.shopify_id,v.product_shopify_id,v.sku,v.price,v.tracked,v.title vtitle,p.title ptitle INTO sv
        FROM hon.shopify_variants v JOIN hon.shopify_products p ON p.connection_id=v.connection_id AND p.shopify_id=v.product_shopify_id
        WHERE v.connection_id=src.connection_id AND v.shopify_id=(ln->>'shopifyVariantId')::bigint AND NOT v.removed AND NOT p.removed
          AND p.status='ACTIVE' AND v.fulfilled_by IS NULL;
      v_price:=CASE WHEN FOUND THEN hon.pos_shopify_minor(sv.price,st.currency::text) END;
      IF v_price IS NULL THEN RAISE EXCEPTION 'POS_ITEM_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
      want:=want||jsonb_build_object('n',n,'item',NULL,'name',hon.pos_shopify_line_name(sv.ptitle,sv.vtitle),'sku',left(sv.sku,40),'category','SHOPIFY','price',v_price,
        'qty',qty,'taxable',true,'track',sv.tracked,'sc',src.connection_id,'sp',sv.product_shopify_id,'sv',sv.shopify_id);
      sub:=sub+v_price::bigint*qty; taxable_sub:=taxable_sub+v_price::bigint*qty;
    ELSE
      want:=want||jsonb_build_object('n',n,'item',NULL,'name',ln->>'description','sku',NULL,'category','QUICK','price',(ln->>'unitPriceMinor')::integer,'qty',qty,'taxable',false,'track',false);
      sub:=sub+(ln->>'unitPriceMinor')::bigint*qty;
    END IF;
  END LOOP;
  -- Total tracked quantity per item (an item may appear on several lines) must be in stock.
  IF EXISTS(SELECT 1 FROM (SELECT (w->>'item')::uuid item,sum((w->>'qty')::int) q FROM jsonb_array_elements(want) w WHERE (w->>'track')::boolean GROUP BY 1) t
      JOIN hon.pos_items i ON i.id=t.item WHERE i.stock<t.q) THEN -- Shopify lines have no POS item and are never refused for stock
    RAISE EXCEPTION 'POS_OUT_OF_STOCK' USING ERRCODE='22023'; END IF;
  IF sub>100000000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(want) w WHERE (w->>'price')::bigint*(w->>'qty')::int>2147483647) THEN
    RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(d)='object' THEN
    disc:=CASE WHEN d->>'kind'='PERCENT' THEN hon.pos_div_round(sub*(d->>'value')::bigint,100) ELSE (d->>'value')::bigint END;
    IF disc>sub OR disc<1 THEN RAISE EXCEPTION 'POS_DISCOUNT_TOO_LARGE' USING ERRCODE='22023'; END IF;
  END IF;
  taxable_after:=taxable_sub-CASE WHEN sub=0 THEN 0 ELSE hon.pos_div_round(disc*taxable_sub,sub) END;
  tax:=hon.pos_div_round(taxable_after*st.tax_rate_bps,10000);
  total:=sub-disc+tax;
  IF total<>(p_input->>'expectedTotalMinor')::bigint THEN RAISE EXCEPTION 'POS_TOTAL_CHANGED' USING ERRCODE='40001'; END IF;
  v_seq:=st.receipt_seq+1;
  UPDATE hon.pos_settings SET receipt_seq=v_seq WHERE school_id=b.school;
  INSERT INTO hon.pos_sales(organization_id,school_id,receipt_number,local_date,person_id,walk_in_name,currency,subtotal_minor,discount_minor,
      discount_kind,discount_value,discount_reason,tax_rate_bps,tax_minor,total_minor,method,reference,note,sold_by_principal_id)
    VALUES(b.org,b.school,'POS-'||to_char(today,'YYYYMMDD')||'-'||lpad(v_seq::text,4,'0'),today,(p_input->>'personId')::uuid,p_input->>'walkInName',st.currency,
      sub,disc,d->>'kind',(d->>'value')::integer,d->>'reason',st.tax_rate_bps,tax,total,p_input->>'method',p_input->>'reference',p_input->>'note',b.actor)
    RETURNING * INTO sale;
  INSERT INTO hon.pos_sale_lines(sale_id,organization_id,school_id,line_no,item_id,name,sku,category,unit_price_minor,quantity,line_total_minor,taxable,stock_tracked,
      shopify_connection_id,shopify_product_id,shopify_variant_id)
    SELECT sale.id,b.org,b.school,(w->>'n')::int,(w->>'item')::uuid,w->>'name',w->>'sku',w->>'category',(w->>'price')::int,(w->>'qty')::int,
      (w->>'price')::int*(w->>'qty')::int,(w->>'taxable')::boolean,(w->>'track')::boolean,(w->>'sc')::uuid,(w->>'sp')::bigint,(w->>'sv')::bigint FROM jsonb_array_elements(want) w;
  -- Each tracked Shopify line owes Shopify its quantity.
  INSERT INTO hon.pos_shopify_stock_tasks(organization_id,school_id,connection_id,sale_id,line_id,variant_shopify_id,change,created_by_principal_id)
    SELECT b.org,b.school,l.shopify_connection_id,sale.id,l.id,l.shopify_variant_id,-l.quantity,b.actor FROM hon.pos_sale_lines l
    WHERE l.sale_id=sale.id AND l.category='SHOPIFY' AND l.stock_tracked ORDER BY l.line_no;
  WITH t AS (SELECT (w->>'item')::uuid item,sum((w->>'qty')::int)::int q FROM jsonb_array_elements(want) w WHERE (w->>'track')::boolean GROUP BY 1),
    u AS (UPDATE hon.pos_items i SET stock=i.stock-t.q,version=i.version+1,updated_by_principal_id=b.actor,updated_at=clock_timestamp()
      FROM t WHERE i.id=t.item RETURNING i.id,i.stock,t.q)
  INSERT INTO hon.pos_stock_moves(item_id,organization_id,school_id,change,stock_after,kind,sale_id,principal_id)
    SELECT u.id,b.org,b.school,-u.q,u.stock,'SALE',sale.id,b.actor FROM u;
  RETURN hon.pos_finish(p_subject,false,b.actor,b.org,b.school,'sale',p_key,'pos.sale.recorded','POS_SALE',sale.id,1,NULL,
    jsonb_build_object('saleId',sale.id,'receiptNumber',sale.receipt_number,'personId',sale.person_id,'currency',sale.currency,'totalMinor',sale.total_minor,
      'discountMinor',sale.discount_minor,'taxMinor',sale.tax_minor,'method',sale.method,'lineCount',n),
    jsonb_build_object('sale',hon.pos_sale_json(sale),'replayed',false));
END $$;

CREATE OR REPLACE FUNCTION hon.refund_pos_sale(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; sale hon.pos_sales%ROWTYPE; nxt hon.pos_sales%ROWTYPE; r jsonb; ref hon.pos_refunds%ROWTYPE; amount integer; tz text;
BEGIN
  IF NOT hon.pos_keys_ok(p_input,ARRAY['schoolId','saleId','amountMinor','method','reason','restock'],ARRAY[]::text[])
    OR NOT hon.pos_uuid_ok(p_input->'saleId',false) OR NOT hon.pos_int_ok(p_input->'amountMinor',1,200000000)
    OR jsonb_typeof(p_input->'method') IS DISTINCT FROM 'string' OR p_input->>'method' NOT IN ('CASH','CHECK','CARD_TERMINAL','OTHER')
    OR NOT hon.pos_text_ok(p_input->'reason',500,false)
    OR jsonb_typeof(p_input->'restock') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'restock')>50 THEN
    RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_input->'restock') LOOP
    IF NOT hon.pos_keys_ok(r,ARRAY['lineId','quantity'],ARRAY[]::text[]) OR NOT hon.pos_uuid_ok(r->'lineId',false) OR NOT hon.pos_int_ok(r->'quantity',1,999) THEN
      RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT e->>'lineId') FROM jsonb_array_elements(p_input->'restock') e)<>jsonb_array_length(p_input->'restock') THEN
    RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.pos_begin(p_subject,'refund',p_input,p_key,true);
  IF b.replay IS NOT NULL THEN RETURN b.replay||jsonb_build_object('replayed',true); END IF;
  SELECT * INTO sale FROM hon.pos_sales WHERE id=(p_input->>'saleId')::uuid AND organization_id=b.org AND school_id=b.school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  amount:=(p_input->>'amountMinor')::integer;
  IF amount>sale.total_minor-sale.refunded_minor THEN RAISE EXCEPTION 'POS_REFUND_TOO_LARGE' USING ERRCODE='22023'; END IF;
  -- Lock restocked items in id order (same lock order as a sale).
  PERFORM 1 FROM hon.pos_items WHERE id IN (SELECT l.item_id FROM hon.pos_sale_lines l JOIN jsonb_array_elements(p_input->'restock') e ON l.id=(e->>'lineId')::uuid WHERE l.sale_id=sale.id)
    ORDER BY id FOR UPDATE;
  -- Restock only lines whose item still tracks stock, so every restocked unit has a stock move (or, for a Shopify line, a stock task).
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'restock') e LEFT JOIN hon.pos_sale_lines l ON l.id=(e->>'lineId')::uuid AND l.sale_id=sale.id
      LEFT JOIN hon.pos_items i ON i.id=l.item_id
      WHERE l.id IS NULL OR NOT l.stock_tracked OR l.restocked_quantity+(e->>'quantity')::int>l.quantity
        OR (l.category<>'SHOPIFY' AND (i.id IS NULL OR NOT i.track_stock))) THEN
    RAISE EXCEPTION 'POS_RESTOCK_INVALID' USING ERRCODE='22023'; END IF;
  tz:=hon.pos_school_tz(b.school);
  UPDATE hon.pos_sales SET refunded_minor=refunded_minor+amount WHERE id=sale.id RETURNING * INTO nxt;
  INSERT INTO hon.pos_refunds(sale_id,organization_id,school_id,local_date,amount_minor,method,reason,restocked,refunded_by_principal_id)
    VALUES(sale.id,b.org,b.school,(clock_timestamp() AT TIME ZONE tz)::date,amount,p_input->>'method',p_input->>'reason',
      (SELECT coalesce(jsonb_agg(jsonb_build_object('lineId',(e->>'lineId')::uuid,'quantity',(e->>'quantity')::int) ORDER BY e->>'lineId'),'[]'::jsonb)
        FROM jsonb_array_elements(p_input->'restock') e),b.actor)
    RETURNING * INTO ref;
  UPDATE hon.pos_sale_lines l SET restocked_quantity=l.restocked_quantity+(e->>'quantity')::int
    FROM jsonb_array_elements(p_input->'restock') e WHERE l.id=(e->>'lineId')::uuid AND l.sale_id=sale.id;
  WITH t AS (SELECT l.item_id item,sum((e->>'quantity')::int)::int q FROM hon.pos_sale_lines l JOIN jsonb_array_elements(p_input->'restock') e ON l.id=(e->>'lineId')::uuid
      WHERE l.sale_id=sale.id GROUP BY 1),
    u AS (UPDATE hon.pos_items i SET stock=i.stock+t.q,version=i.version+1,updated_by_principal_id=b.actor,updated_at=clock_timestamp()
      FROM t WHERE i.id=t.item AND i.track_stock RETURNING i.id,i.stock,t.q)
  INSERT INTO hon.pos_stock_moves(item_id,organization_id,school_id,change,stock_after,kind,sale_id,refund_id,principal_id)
    SELECT u.id,b.org,b.school,u.q,u.stock,'REFUND_RESTOCK',sale.id,ref.id,b.actor FROM u;
  -- Units of a Shopify line that go back on the shelf are owed back to Shopify's count.
  INSERT INTO hon.pos_shopify_stock_tasks(organization_id,school_id,connection_id,sale_id,line_id,refund_id,variant_shopify_id,change,created_by_principal_id)
    SELECT b.org,b.school,l.shopify_connection_id,sale.id,l.id,ref.id,l.shopify_variant_id,(e->>'quantity')::int,b.actor
    FROM hon.pos_sale_lines l JOIN jsonb_array_elements(p_input->'restock') e ON l.id=(e->>'lineId')::uuid
    WHERE l.sale_id=sale.id AND l.category='SHOPIFY' ORDER BY l.line_no;
  RETURN hon.pos_finish(p_subject,true,b.actor,b.org,b.school,'refund',p_key,'pos.sale.refunded','POS_SALE',sale.id,
    (SELECT count(*)::int+1 FROM hon.pos_refunds WHERE sale_id=sale.id),
    jsonb_build_object('refundedMinor',sale.refunded_minor),
    jsonb_build_object('saleId',sale.id,'refundId',ref.id,'amountMinor',amount,'method',ref.method,'refundedMinor',nxt.refunded_minor,
      'restockedLines',jsonb_array_length(ref.restocked)),
    jsonb_build_object('sale',hon.pos_sale_json(nxt),'replayed',false));
END $$;

-- BEGIN {schoolId, retryFailed}: hand the API up to 20 waiting stock changes of the school's connected store, least-tried
-- first, with the sealed credential. Any POS seller may send (it runs right after a sale); retryFailed needs pos.manage
-- and puts FAILED changes of the current store back in the queue. A waiting change whose store is no longer the
-- school's sellable store is settled as FAILED with the reason.
CREATE FUNCTION hon.begin_pos_shopify_stock(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_school uuid; v_actor uuid; v_org uuid; retry boolean; src record; k hon.shopify_credentials%ROWTYPE; v_tasks jsonb;
BEGIN
  IF p_subject IS NULL OR NOT hon.pos_keys_ok(p_input,ARRAY['schoolId','retryFailed'],ARRAY[]::text[]) OR NOT hon.pos_uuid_ok(p_input->'schoolId',false)
    OR jsonb_typeof(p_input->'retryFailed') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid; retry:=(p_input->>'retryFailed')::boolean;
  v_actor:=hon.pos_actor(p_subject,v_school,retry);
  IF v_actor IS NULL THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=v_school;
  SELECT * INTO src FROM hon.pos_shopify_source(v_school,hon.pos_settings_json(v_school)->>'currency');
  PERFORM 1 FROM hon.pos_shopify_stock_tasks WHERE organization_id=v_org AND school_id=v_school AND status<>'DONE' ORDER BY id FOR UPDATE;
  UPDATE hon.pos_shopify_stock_tasks SET status='FAILED',failure_code=CASE WHEN src.state='READY' THEN 'STORE_CHANGED' ELSE src.state END,settled_at=clock_timestamp()
    WHERE organization_id=v_org AND school_id=v_school AND status='PENDING' AND connection_id IS DISTINCT FROM src.connection_id;
  IF src.state<>'READY' THEN
    IF hon.pos_actor(p_subject,v_school,retry) IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('state',src.state,'connectionId',NULL,'shopDomain',NULL,'credential',NULL,'tasks','[]'::jsonb);
  END IF;
  IF retry THEN
    UPDATE hon.pos_shopify_stock_tasks SET status='PENDING',settled_at=NULL
      WHERE organization_id=v_org AND school_id=v_school AND status='FAILED' AND connection_id=src.connection_id;
  END IF;
  WITH pick AS (SELECT id FROM hon.pos_shopify_stock_tasks WHERE organization_id=v_org AND school_id=v_school AND status='PENDING'
      ORDER BY attempts,created_at,id LIMIT 20),
    upd AS (UPDATE hon.pos_shopify_stock_tasks t SET attempts=t.attempts+1,last_attempt_at=clock_timestamp() FROM pick WHERE t.id=pick.id
      RETURNING t.id,t.variant_shopify_id,t.change,t.sale_id,t.attempts,t.created_at)
  SELECT coalesce(jsonb_agg(jsonb_build_object('taskId',u.id,'variantId',u.variant_shopify_id::text,'change',u.change,'saleId',u.sale_id,'attempts',u.attempts)
    ORDER BY u.attempts,u.created_at,u.id),'[]'::jsonb) INTO v_tasks FROM upd u;
  SELECT * INTO k FROM hon.shopify_credentials WHERE connection_id=src.connection_id AND destroyed_at IS NULL;
  IF hon.pos_actor(p_subject,v_school,retry) IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('state','READY','connectionId',src.connection_id,'shopDomain',src.shop_domain,'tasks',v_tasks,
    'credential',CASE WHEN k.connection_id IS NULL OR jsonb_array_length(v_tasks)=0 THEN NULL ELSE jsonb_build_object('keyId',k.key_id,'sealed',k.sealed,
      'version',k.version,'accessExpiresAt',hon.saas_ts(k.access_expires_at),'refreshExpiresAt',hon.saas_ts(k.refresh_expires_at)) END);
END $$;

-- ROTATE {schoolId, expectedVersion, credential}: the API refreshed the store's token pair while sending stock changes.
-- Only while the school's sellable store has a change waiting, and only over the version the API was handed.
CREATE FUNCTION hon.rotate_pos_shopify_credential(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_school uuid; v_actor uuid; src record; k jsonb; v integer;
BEGIN
  k:=p_input->'credential';
  IF p_subject IS NULL OR NOT hon.pos_keys_ok(p_input,ARRAY['schoolId','expectedVersion','credential'],ARRAY[]::text[]) OR NOT hon.pos_uuid_ok(p_input->'schoolId',false)
    OR NOT hon.pos_int_ok(p_input->'expectedVersion',1,1000000000) OR NOT hon.shopify_credential_ok(k)
    OR (k->>'accessExpiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid;
  v_actor:=hon.pos_actor(p_subject,v_school,false);
  IF v_actor IS NULL THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO src FROM hon.pos_shopify_source(v_school,hon.pos_settings_json(v_school)->>'currency');
  IF src.state<>'READY' OR NOT EXISTS(SELECT 1 FROM hon.pos_shopify_stock_tasks t WHERE t.school_id=v_school AND t.connection_id=src.connection_id AND t.status='PENDING') THEN
    RAISE EXCEPTION 'POS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  UPDATE hon.shopify_credentials SET version=version+1,key_id=k->>'keyId',sealed=k->>'sealed',access_expires_at=(k->>'accessExpiresAt')::timestamptz,
    refresh_expires_at=(k->>'refreshExpiresAt')::timestamptz,rotated_at=clock_timestamp()
    WHERE connection_id=src.connection_id AND destroyed_at IS NULL AND version=(p_input->>'expectedVersion')::integer RETURNING version INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'POS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF hon.pos_actor(p_subject,v_school,false) IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('version',v);
END $$;

-- FINISH {schoolId, taskId, outcome, failureCode}: DONE (Shopify took the change; failureCode null; the mirror row takes it
-- too), FAILED (Shopify will not take it as it is; a manager can send it again) or RETRY (nothing certain; it stays
-- waiting and the same task id is sent again, which Shopify applies at most once). A task already settled answers its
-- state and changes nothing.
CREATE FUNCTION hon.finish_pos_shopify_stock(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_school uuid; v_actor uuid; t hon.pos_shopify_stock_tasks%ROWTYPE; v_outcome text; v_request uuid:=gen_random_uuid(); v_state jsonb; v_action text;
BEGIN
  v_outcome:=CASE WHEN jsonb_typeof(p_input->'outcome')='string' THEN p_input->>'outcome' END;
  IF p_subject IS NULL OR NOT hon.pos_keys_ok(p_input,ARRAY['schoolId','taskId','outcome','failureCode'],ARRAY[]::text[]) OR NOT hon.pos_uuid_ok(p_input->'schoolId',false)
    OR NOT hon.pos_uuid_ok(p_input->'taskId',false) OR v_outcome IS NULL OR v_outcome NOT IN ('DONE','FAILED','RETRY')
    OR ((v_outcome='DONE')<>(jsonb_typeof(p_input->'failureCode')='null'))
    OR (v_outcome<>'DONE' AND (jsonb_typeof(p_input->'failureCode')<>'string' OR p_input->>'failureCode' !~ '^[A-Z_]{1,40}$')) THEN
    RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid;
  v_actor:=hon.pos_actor(p_subject,v_school,false);
  IF v_actor IS NULL THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO t FROM hon.pos_shopify_stock_tasks WHERE id=(p_input->>'taskId')::uuid AND school_id=v_school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF t.status<>'PENDING' THEN RETURN jsonb_build_object('status',t.status,'changed',false); END IF;
  IF v_outcome='RETRY' THEN
    UPDATE hon.pos_shopify_stock_tasks SET failure_code=p_input->>'failureCode' WHERE id=t.id;
  ELSE
    UPDATE hon.pos_shopify_stock_tasks SET status=v_outcome,failure_code=p_input->>'failureCode',settled_at=clock_timestamp() WHERE id=t.id;
    IF v_outcome='DONE' THEN
      UPDATE hon.shopify_variants SET inventory_quantity=greatest(-10000000,least(10000000,inventory_quantity+t.change))
        WHERE connection_id=t.connection_id AND shopify_id=t.variant_shopify_id AND tracked AND inventory_quantity IS NOT NULL;
    END IF;
    v_action:=CASE WHEN v_outcome='DONE' THEN 'pos.shopify_stock.sent' ELSE 'pos.shopify_stock.failed' END;
    v_state:=jsonb_build_object('taskId',t.id,'saleId',t.sale_id,'refundId',t.refund_id,'change',t.change,'failureCode',p_input->>'failureCode');
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id,occurred_at)
      VALUES(t.organization_id,t.school_id,v_actor,'HUMAN_UI',v_action,'POS_SALE',t.sale_id,v_state,'SUCCEEDED',v_request,v_request,clock_timestamp());
    INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
      VALUES(gen_random_uuid(),t.organization_id,t.school_id,v_action,1,'POS_SALE',t.sale_id,1,v_request,v_request,v_state||jsonb_build_object('internalOnly',true));
  END IF;
  IF hon.pos_actor(p_subject,v_school,false) IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('status',CASE WHEN v_outcome='RETRY' THEN 'PENDING' ELSE v_outcome END,'changed',true);
END $$;

-- Deny first, then exactly the three new entry points for the runtime role (the replaced 0612 functions keep their grants).
DO $$ DECLARE r text; f regprocedure;
  entry text[]:=ARRAY['hon.begin_pos_shopify_stock(text,jsonb)','hon.rotate_pos_shopify_credential(text,jsonb)','hon.finish_pos_shopify_stock(text,jsonb)'];
  e text;
BEGIN
  REVOKE ALL ON TABLE hon.pos_shopify_stock_tasks FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.pos_shopify_stock_tasks FROM %I',r);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname IN ('guard_pos_shopify_stock_task','pos_shopify_minor','pos_shopify_source','pos_shopify_stock_json','pos_shopify_line_name')
      OR p.oid::regprocedure::text=ANY(entry)) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH e IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',e); END LOOP;
  END IF;
END $$;

COMMIT;
