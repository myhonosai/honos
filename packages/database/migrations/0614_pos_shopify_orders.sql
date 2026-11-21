BEGIN;

-- SH2b (0614): the front desk sells made-to-order Shopify items. Owner, 2026-11-21: "a lot of items on Shopify are
-- print on demand, so it would need to make an order"; where it ships is asked at each sale (school pickup by default).
--
-- * A variant a print provider makes (0611 fulfilled_by) is listed on the register and sold only when the school's
--   store lets HON create orders (write_orders). It is never counted in stock: there is nothing on the shelf.
-- * A sale with such lines carries shipTo: {kind:'SCHOOL'} (the school's saved address, copied at the sale) or
--   {kind:'CUSTOMER', name, address1, address2, city, province, zip, country}. A sale without them carries none.
-- * The made-to-order lines of one sale become one row in hon.pos_shopify_orders. The API creates one PAID Shopify
--   order from it (the money was taken at the desk; HON still moves none) and records Shopify's order id and name.
--   The provider's own Shopify app picks the order up from there, as it does for an online order.
-- * The order row id is the order's tag in Shopify ("hon-pos-<id>"). Before creating, the API looks for an order with
--   that tag, so a lost answer does not create a second order; an uncertain order waits at least a minute before it
--   is tried again, so Shopify's search has seen the first one.
-- * The customer's address is held only until Shopify has the order: DONE clears it.
-- * A HON refund does not cancel the Shopify order; staff cancel it in Shopify.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.pos_shopify_stock_tasks') IS NULL OR to_regclass('hon.school_locations') IS NULL THEN
    RAISE EXCEPTION '0614 requires the Point of Sale Shopify lines (0613) and school locations'; END IF;
END $$;

-- Who makes a Shopify line when it is not the school: such a line is never counted in stock.
ALTER TABLE hon.pos_sale_lines ADD COLUMN made_by text
  CHECK (made_by IS NULL OR (category='SHOPIFY' AND NOT stock_tracked AND length(made_by) BETWEEN 1 AND 64));

-- The Shopify order a sale's made-to-order lines owe the provider.
CREATE TABLE hon.pos_shopify_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL, connection_id uuid NOT NULL,
  sale_id uuid NOT NULL UNIQUE,
  ship_kind text NOT NULL CHECK (ship_kind IN ('SCHOOL','CUSTOMER')),
  ship_to jsonb CHECK (ship_to IS NULL OR jsonb_typeof(ship_to)='object'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE','FAILED')),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z_]{1,40}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100000),
  shopify_order_id bigint CHECK (shopify_order_id>0),
  shopify_order_name text CHECK (shopify_order_name IS NULL OR (length(shopify_order_name) BETWEEN 1 AND 40 AND shopify_order_name !~ '[[:cntrl:]]')),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_attempt_at timestamptz, settled_at timestamptz,
  CHECK ((status='PENDING')=(settled_at IS NULL)),
  CHECK ((status='DONE')=(shopify_order_id IS NOT NULL)), CHECK ((status='DONE')=(ship_to IS NULL)),
  CHECK (shopify_order_name IS NULL OR status='DONE'),
  CHECK (status<>'DONE' OR failure_code IS NULL), CHECK (status<>'FAILED' OR failure_code IS NOT NULL),
  FOREIGN KEY (sale_id,organization_id,school_id) REFERENCES hon.pos_sales(id,organization_id,school_id),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.shopify_connections(id,organization_id,school_id)
);
CREATE INDEX pos_shopify_orders_open_idx ON hon.pos_shopify_orders(school_id,created_at,id) WHERE status<>'DONE';
ALTER TABLE hon.pos_shopify_orders ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.pos_shopify_orders FORCE ROW LEVEL SECURITY;

-- An order row keeps what it is for; DONE is final; nothing is deleted. The address may only be cleared, with DONE.
CREATE FUNCTION hon.guard_pos_shopify_order() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'POS_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF OLD.status='DONE' OR NEW.attempts<OLD.attempts OR (NEW.ship_to IS DISTINCT FROM OLD.ship_to AND NEW.ship_to IS NOT NULL)
    OR (to_jsonb(NEW)-ARRAY['status','failure_code','attempts','last_attempt_at','settled_at','shopify_order_id','shopify_order_name','ship_to'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','failure_code','attempts','last_attempt_at','settled_at','shopify_order_id','shopify_order_name','ship_to']) THEN
    RAISE EXCEPTION 'POS_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_shopify_orders_guard BEFORE UPDATE OR DELETE ON hon.pos_shopify_orders FOR EACH ROW EXECUTE FUNCTION hon.guard_pos_shopify_order();
CREATE TRIGGER pos_shopify_orders_no_truncate BEFORE TRUNCATE ON hon.pos_shopify_orders FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_pos_shopify_order();

-- Whether the store lets HON create orders.
CREATE FUNCTION hon.pos_shopify_orders_ok(p_connection uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT hon.shopify_has_scope(c.scopes,'write_orders') FROM hon.shopify_connections c WHERE c.id=p_connection AND c.status='CONNECTED'),false)
$$;

-- shipTo on a sale: absent or null, exactly {kind:'SCHOOL'}, or a customer's address.
CREATE FUNCTION hon.pos_ship_to_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN v IS NULL OR jsonb_typeof(v)='null' THEN true
    WHEN jsonb_typeof(v)<>'object' OR jsonb_typeof(v->'kind') IS DISTINCT FROM 'string' THEN false
    WHEN v->>'kind'='SCHOOL' THEN hon.pos_keys_ok(v,ARRAY['kind'],ARRAY[]::text[])
    WHEN v->>'kind'='CUSTOMER' THEN hon.pos_keys_ok(v,ARRAY['kind','name','address1','address2','city','province','zip','country'],ARRAY[]::text[])
      AND hon.pos_text_ok(v->'name',120,false) AND hon.pos_text_ok(v->'address1',120,false) AND hon.pos_text_ok(v->'address2',120,true)
      AND hon.pos_text_ok(v->'city',80,false) AND hon.pos_text_ok(v->'province',40,true) AND hon.pos_text_ok(v->'zip',20,true)
      AND jsonb_typeof(v->'country')='string' AND (v->>'country') ~ '^[A-Z]{2}$'
    ELSE false END
$$;

-- The school's saved address in the same shape, or NULL when it is not complete enough to ship to.
CREATE FUNCTION hon.pos_school_ship_to(p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT x.j FROM (SELECT jsonb_build_object('name',btrim(left(s.name,120)),'address1',btrim(left(l.address_line1,120)),'address2',nullif(btrim(left(l.address_line2,120)),''),
      'city',btrim(left(l.city,80)),'province',nullif(btrim(left(l.region_code,40)),''),'zip',nullif(btrim(left(l.postal_code,20)),''),'country',l.country_code) j
    FROM hon.school_locations l JOIN hon.schools s ON s.id=l.school_id WHERE l.school_id=p_school) x
  WHERE hon.pos_ship_to_ok(x.j||jsonb_build_object('kind','CUSTOMER'))
$$;

-- How a sale's Shopify order stands: NULL when the sale has no made-to-order line.
CREATE FUNCTION hon.pos_shopify_order_json(p_sale uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('status',CASE o.status WHEN 'PENDING' THEN 'WAITING' ELSE o.status END,'shipTo',o.ship_kind,'name',o.shopify_order_name,'failureCode',
    CASE WHEN o.status='FAILED' THEN o.failure_code END) FROM hon.pos_shopify_orders o WHERE o.sale_id=p_sale
$$;

-- The connection now says whether the store lets HON create orders (write_orders).
CREATE OR REPLACE FUNCTION hon.shopify_connection_json(c hon.shopify_connections) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('connectionId',c.id,'shopDomain',c.shop_domain,'shopName',c.shop_name,
    'currency',c.currency,'status',c.status,'version',c.version,'connectedAt',hon.saas_ts(c.connected_at),'endedAt',hon.saas_ts(c.ended_at),
    'ordersAllowed',hon.shopify_has_scope(c.scopes,'write_orders'),
    'lastSyncAt',hon.saas_ts(c.last_sync_at),'lastSyncOutcome',c.last_sync_outcome,
    'syncRunning',EXISTS(SELECT 1 FROM hon.shopify_syncs y WHERE y.connection_id=c.id AND y.outcome='RUNNING' AND y.started_at>clock_timestamp()-interval '15 minutes')) END
$$;

CREATE OR REPLACE FUNCTION hon.pos_sale_json(x hon.pos_sales) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.pos_sale_summary_json(x)||jsonb_build_object(
    'schoolName',(SELECT s.name FROM hon.schools s WHERE s.id=x.school_id),
    'soldBy',(SELECT left(p.display_name,120) FROM hon.principals p WHERE p.id=x.sold_by_principal_id),
    'lines',(SELECT coalesce(jsonb_agg(jsonb_build_object('lineId',l.id,'itemId',l.item_id,'name',l.name,'sku',l.sku,'category',l.category,
        'unitPriceMinor',l.unit_price_minor,'quantity',l.quantity,'lineTotalMinor',l.line_total_minor,'taxable',l.taxable,
        'stockTracked',l.stock_tracked,'restockedQuantity',l.restocked_quantity,
        'shopifyVariantId',l.shopify_variant_id::text,'madeBy',l.made_by) ORDER BY l.line_no),'[]'::jsonb) FROM hon.pos_sale_lines l WHERE l.sale_id=x.id),
    'subtotalMinor',x.subtotal_minor,
    'discount',CASE WHEN x.discount_kind IS NULL THEN NULL ELSE jsonb_build_object('kind',x.discount_kind,'value',x.discount_value,'reason',x.discount_reason,'amountMinor',x.discount_minor) END,
    'taxRateBps',x.tax_rate_bps,'taxMinor',x.tax_minor,'reference',x.reference,'note',x.note,
    'shopifyStock',hon.pos_shopify_stock_json(x.id),'shopifyOrder',hon.pos_shopify_order_json(x.id),
    'refunds',(SELECT coalesce(jsonb_agg(jsonb_build_object('refundId',r.id,'refundedAt',hon.saas_ts(r.created_at),'amountMinor',r.amount_minor,
        'method',r.method,'reason',r.reason,'restocked',r.restocked,
        'refundedBy',(SELECT left(p.display_name,120) FROM hon.principals p WHERE p.id=r.refunded_by_principal_id)) ORDER BY r.created_at),'[]'::jsonb)
      FROM hon.pos_refunds r WHERE r.sale_id=x.id))
$$;

CREATE OR REPLACE FUNCTION hon.read_pos(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_org uuid; manage boolean; tz text; today date; src record; v_currency text; orders_ok boolean;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.pos_actor(p_subject,p_school,false) IS NULL THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  manage:=hon.pos_actor(p_subject,p_school,true) IS NOT NULL;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=p_school;
  tz:=hon.pos_school_tz(p_school); today:=(clock_timestamp() AT TIME ZONE tz)::date;
  v_currency:=hon.pos_settings_json(p_school)->>'currency';
  SELECT * INTO src FROM hon.pos_shopify_source(p_school,v_currency);
  orders_ok:=src.state='READY' AND hon.pos_shopify_orders_ok(src.connection_id);
  RETURN jsonb_build_object('schoolId',p_school,'timezone',tz,'today',to_char(today,'YYYY-MM-DD'),'canManage',manage,
    'settings',hon.pos_settings_json(p_school),
    'items',(SELECT coalesce(jsonb_agg(hon.pos_item_json(i) ORDER BY i.category,lower(i.name),i.id),'[]'::jsonb) FROM hon.pos_items i
      WHERE i.organization_id=v_org AND i.school_id=p_school AND (i.active OR manage)),
    'todaySales',(SELECT jsonb_build_object('count',count(*)::int,'totalMinor',coalesce(sum(x.total_minor),0)::bigint)
      FROM hon.pos_sales x WHERE x.organization_id=v_org AND x.school_id=p_school AND x.local_date=today),
    -- The store's sellable variants (at most 2000), with the count Shopify will show once the waiting changes are sent.
    'shopify',jsonb_build_object('state',src.state,'shopName',src.shop_name,
      'items',CASE WHEN src.state='READY' THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('variantId',q.shopify_id::text,'productId',q.product_shopify_id::text,
          'name',q.name,'sku',q.sku,'priceMinor',q.price_minor,'tracked',q.tracked,'stock',q.stock,'imageUrl',q.image_url,'madeBy',q.made_by) ORDER BY lower(q.name),q.shopify_id),'[]'::jsonb)
        FROM (SELECT v.shopify_id,v.product_shopify_id,hon.pos_shopify_line_name(p.title,v.title) name,left(v.sku,40) sku,hon.pos_shopify_minor(v.price,v_currency) price_minor,
            (v.tracked AND v.fulfilled_by IS NULL) tracked,v.fulfilled_by made_by,p.image_url,CASE WHEN v.tracked AND v.fulfilled_by IS NULL THEN coalesce(v.inventory_quantity,0)+coalesce((SELECT sum(t.change) FROM hon.pos_shopify_stock_tasks t
              WHERE t.connection_id=v.connection_id AND t.variant_shopify_id=v.shopify_id AND t.status='PENDING'),0)::int END stock
          FROM hon.shopify_variants v JOIN hon.shopify_products p ON p.connection_id=v.connection_id AND p.shopify_id=v.product_shopify_id
          WHERE v.connection_id=src.connection_id AND NOT v.removed AND NOT p.removed AND p.status='ACTIVE' AND (v.fulfilled_by IS NULL OR orders_ok)
            AND hon.pos_shopify_minor(v.price,v_currency) IS NOT NULL
          ORDER BY lower(p.title),p.shopify_id,v.position LIMIT 2000) q) ELSE '[]'::jsonb END,
      'unsent',(SELECT jsonb_build_object('waiting',count(*) FILTER (WHERE t.status='PENDING')::int,'failed',count(*) FILTER (WHERE t.status='FAILED')::int)
        FROM hon.pos_shopify_stock_tasks t WHERE t.organization_id=v_org AND t.school_id=p_school AND t.status<>'DONE'),
      -- Made-to-order items (a print provider makes and ships them): sold only when the store allows HON to create orders.
      'madeToOrder',jsonb_build_object(
        'state',CASE WHEN orders_ok THEN 'READY' WHEN src.state='READY' AND EXISTS(SELECT 1 FROM hon.shopify_variants v
            JOIN hon.shopify_products p ON p.connection_id=v.connection_id AND p.shopify_id=v.product_shopify_id
            WHERE v.connection_id=src.connection_id AND NOT v.removed AND NOT p.removed AND p.status='ACTIVE' AND v.fulfilled_by IS NOT NULL) THEN 'NEEDS_PERMISSION' ELSE 'NONE' END,
        'pickup',hon.pos_school_ship_to(p_school) IS NOT NULL,
        'unsent',(SELECT jsonb_build_object('waiting',count(*) FILTER (WHERE o.status='PENDING')::int,'failed',count(*) FILTER (WHERE o.status='FAILED')::int)
          FROM hon.pos_shopify_orders o WHERE o.organization_id=v_org AND o.school_id=p_school AND o.status<>'DONE'))));
END $$;

-- Input as 0613, plus optional shipTo ({kind:'SCHOOL'} or a customer address) when a made-to-order line is sold.
CREATE OR REPLACE FUNCTION hon.record_pos_sale(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; st hon.pos_settings%ROWTYPE; tz text; today date; ln jsonb; n integer:=0; it hon.pos_items%ROWTYPE;
  sub bigint:=0; taxable_sub bigint:=0; disc bigint:=0; tax bigint:=0; total bigint; taxable_after bigint; qty integer;
  sale hon.pos_sales%ROWTYPE; want jsonb:='[]'::jsonb; d jsonb; v_seq integer; src record; sv record; v_price integer; orders_ok boolean; ship jsonb; has_made boolean;
BEGIN
  IF NOT hon.pos_keys_ok(p_input,ARRAY['schoolId','personId','walkInName','lines','discount','method','reference','note','expectedTotalMinor'],ARRAY['shipTo'])
    OR NOT hon.pos_ship_to_ok(p_input->'shipTo')
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
  orders_ok:=src.state='READY' AND hon.pos_shopify_orders_ok(src.connection_id);
  FOR ln IN SELECT value FROM jsonb_array_elements(p_input->'lines') LOOP
    n:=n+1; qty:=(ln->>'quantity')::integer;
    IF ln ? 'itemId' THEN
      SELECT * INTO it FROM hon.pos_items WHERE id=(ln->>'itemId')::uuid AND organization_id=b.org AND school_id=b.school AND active;
      IF NOT FOUND THEN RAISE EXCEPTION 'POS_ITEM_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
      want:=want||jsonb_build_object('n',n,'item',it.id,'name',it.name,'sku',it.sku,'category',it.category,'price',it.price_minor,'qty',qty,'taxable',it.taxable,'track',it.track_stock);
      sub:=sub+it.price_minor::bigint*qty; IF it.taxable THEN taxable_sub:=taxable_sub+it.price_minor::bigint*qty; END IF;
    ELSIF ln ? 'shopifyVariantId' THEN
      -- The mirror's current price and title for a variant of the connected store: one the school stocks itself, or
      -- (0614) one a print provider makes, when the store lets HON create the order the provider works from.
      IF src.state<>'READY' THEN RAISE EXCEPTION 'POS_ITEM_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
      SELECT v.shopify_id,v.product_shopify_id,v.sku,v.price,v.tracked,v.fulfilled_by,v.title vtitle,p.title ptitle INTO sv
        FROM hon.shopify_variants v JOIN hon.shopify_products p ON p.connection_id=v.connection_id AND p.shopify_id=v.product_shopify_id
        WHERE v.connection_id=src.connection_id AND v.shopify_id=(ln->>'shopifyVariantId')::bigint AND NOT v.removed AND NOT p.removed
          AND p.status='ACTIVE' AND (v.fulfilled_by IS NULL OR orders_ok);
      v_price:=CASE WHEN FOUND THEN hon.pos_shopify_minor(sv.price,st.currency::text) END;
      IF v_price IS NULL THEN RAISE EXCEPTION 'POS_ITEM_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
      want:=want||jsonb_build_object('n',n,'item',NULL,'name',hon.pos_shopify_line_name(sv.ptitle,sv.vtitle),'sku',left(sv.sku,40),'category','SHOPIFY','price',v_price,
        'qty',qty,'taxable',true,'track',sv.tracked AND sv.fulfilled_by IS NULL,'sc',src.connection_id,'sp',sv.product_shopify_id,'sv',sv.shopify_id,'mb',sv.fulfilled_by);
      sub:=sub+v_price::bigint*qty; taxable_sub:=taxable_sub+v_price::bigint*qty;
    ELSE
      want:=want||jsonb_build_object('n',n,'item',NULL,'name',ln->>'description','sku',NULL,'category','QUICK','price',(ln->>'unitPriceMinor')::integer,'qty',qty,'taxable',false,'track',false);
      sub:=sub+(ln->>'unitPriceMinor')::bigint*qty;
    END IF;
  END LOOP;
  -- A made-to-order line needs somewhere to ship; a sale without one must not carry an address.
  has_made:=EXISTS(SELECT 1 FROM jsonb_array_elements(want) w WHERE w->>'mb' IS NOT NULL);
  ship:=CASE WHEN jsonb_typeof(p_input->'shipTo')='object' THEN p_input->'shipTo' END;
  IF has_made AND ship IS NULL THEN RAISE EXCEPTION 'POS_SHIP_TO_REQUIRED' USING ERRCODE='22023'; END IF;
  IF NOT has_made AND ship IS NOT NULL THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  IF ship->>'kind'='SCHOOL' THEN
    ship:=hon.pos_school_ship_to(b.school);
    IF ship IS NULL THEN RAISE EXCEPTION 'POS_SCHOOL_ADDRESS_MISSING' USING ERRCODE='22023'; END IF;
  ELSIF ship IS NOT NULL THEN ship:=ship-'kind';
  END IF;
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
      shopify_connection_id,shopify_product_id,shopify_variant_id,made_by)
    SELECT sale.id,b.org,b.school,(w->>'n')::int,(w->>'item')::uuid,w->>'name',w->>'sku',w->>'category',(w->>'price')::int,(w->>'qty')::int,
      (w->>'price')::int*(w->>'qty')::int,(w->>'taxable')::boolean,(w->>'track')::boolean,(w->>'sc')::uuid,(w->>'sp')::bigint,(w->>'sv')::bigint,w->>'mb' FROM jsonb_array_elements(want) w;
  -- The made-to-order lines of this sale are one Shopify order the provider works from.
  IF has_made THEN
    INSERT INTO hon.pos_shopify_orders(organization_id,school_id,connection_id,sale_id,ship_kind,ship_to,created_by_principal_id)
      VALUES(b.org,b.school,src.connection_id,sale.id,p_input->'shipTo'->>'kind',ship,b.actor);
  END IF;
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

-- As 0613, and a waiting order also allows the rotation.
CREATE OR REPLACE FUNCTION hon.rotate_pos_shopify_credential(p_subject text,p_input jsonb) RETURNS jsonb
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
  IF src.state<>'READY' OR (NOT EXISTS(SELECT 1 FROM hon.pos_shopify_stock_tasks t WHERE t.school_id=v_school AND t.connection_id=src.connection_id AND t.status='PENDING')
      AND NOT EXISTS(SELECT 1 FROM hon.pos_shopify_orders o WHERE o.school_id=v_school AND o.connection_id=src.connection_id AND o.status='PENDING')) THEN
    RAISE EXCEPTION 'POS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  UPDATE hon.shopify_credentials SET version=version+1,key_id=k->>'keyId',sealed=k->>'sealed',access_expires_at=(k->>'accessExpiresAt')::timestamptz,
    refresh_expires_at=(k->>'refreshExpiresAt')::timestamptz,rotated_at=clock_timestamp()
    WHERE connection_id=src.connection_id AND destroyed_at IS NULL AND version=(p_input->>'expectedVersion')::integer RETURNING version INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'POS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF hon.pos_actor(p_subject,v_school,false) IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('version',v);
END $$;

-- BEGIN {schoolId, retryFailed}: the waiting orders the API should create now (at most 5), with the store's sealed
-- credential. A seller (pos.sell) sends after their own sale; retryFailed (pos.manage) also puts FAILED orders back.
-- An order tried less than a minute ago is left alone: Shopify's order search must have seen a first attempt before
-- the API looks for it again. Orders for a store the school no longer sells from are settled as FAILED.
CREATE FUNCTION hon.begin_pos_shopify_order(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_school uuid; v_actor uuid; v_org uuid; retry boolean; src record; ok boolean; k hon.shopify_credentials%ROWTYPE; v_tasks jsonb; v_state text;
BEGIN
  IF p_subject IS NULL OR NOT hon.pos_keys_ok(p_input,ARRAY['schoolId','retryFailed'],ARRAY[]::text[]) OR NOT hon.pos_uuid_ok(p_input->'schoolId',false)
    OR jsonb_typeof(p_input->'retryFailed') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid; retry:=(p_input->>'retryFailed')::boolean;
  v_actor:=hon.pos_actor(p_subject,v_school,retry);
  IF v_actor IS NULL THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=v_school;
  SELECT * INTO src FROM hon.pos_shopify_source(v_school,hon.pos_settings_json(v_school)->>'currency');
  ok:=src.state='READY' AND hon.pos_shopify_orders_ok(src.connection_id);
  v_state:=CASE WHEN ok THEN 'READY' WHEN src.state='READY' THEN 'NEEDS_ORDERS' ELSE src.state END;
  PERFORM 1 FROM hon.pos_shopify_orders WHERE organization_id=v_org AND school_id=v_school AND status<>'DONE' ORDER BY id FOR UPDATE;
  UPDATE hon.pos_shopify_orders SET status='FAILED',failure_code=CASE WHEN src.state='READY' THEN 'STORE_CHANGED' ELSE src.state END,settled_at=clock_timestamp()
    WHERE organization_id=v_org AND school_id=v_school AND status='PENDING' AND connection_id IS DISTINCT FROM src.connection_id;
  IF NOT ok THEN
    IF hon.pos_actor(p_subject,v_school,retry) IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('state',v_state,'connectionId',NULL,'shopDomain',NULL,'credential',NULL,'orders','[]'::jsonb);
  END IF;
  IF retry THEN
    -- A manager's "send again" is not held back by the 60 seconds: the lookup by tag still finds an order Shopify already has.
    UPDATE hon.pos_shopify_orders SET status='PENDING',settled_at=NULL,last_attempt_at=NULL
      WHERE organization_id=v_org AND school_id=v_school AND status='FAILED' AND connection_id=src.connection_id;
  END IF;
  WITH pick AS (SELECT id FROM hon.pos_shopify_orders WHERE organization_id=v_org AND school_id=v_school AND status='PENDING'
      AND (last_attempt_at IS NULL OR last_attempt_at<clock_timestamp()-interval '60 seconds') ORDER BY attempts,created_at,id LIMIT 5),
    upd AS (UPDATE hon.pos_shopify_orders o SET attempts=o.attempts+1,last_attempt_at=clock_timestamp() FROM pick WHERE o.id=pick.id RETURNING o.*)
  SELECT coalesce(jsonb_agg(jsonb_build_object('orderTaskId',u.id,'saleId',u.sale_id,'attempts',u.attempts,'shipTo',u.ship_to,
      'receiptNumber',x.receipt_number,'currency',x.currency,
      'lines',(SELECT jsonb_agg(jsonb_build_object('variantId',l.shopify_variant_id::text,'quantity',l.quantity,'unitPriceMinor',l.unit_price_minor) ORDER BY l.line_no)
        FROM hon.pos_sale_lines l WHERE l.sale_id=u.sale_id AND l.made_by IS NOT NULL)) ORDER BY u.attempts,u.created_at,u.id),'[]'::jsonb)
    INTO v_tasks FROM upd u JOIN hon.pos_sales x ON x.id=u.sale_id;
  SELECT * INTO k FROM hon.shopify_credentials WHERE connection_id=src.connection_id AND destroyed_at IS NULL;
  IF hon.pos_actor(p_subject,v_school,retry) IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('state','READY','connectionId',src.connection_id,'shopDomain',src.shop_domain,'orders',v_tasks,
    'credential',CASE WHEN k.connection_id IS NULL OR jsonb_array_length(v_tasks)=0 THEN NULL ELSE jsonb_build_object('keyId',k.key_id,'sealed',k.sealed,
      'version',k.version,'accessExpiresAt',hon.saas_ts(k.access_expires_at),'refreshExpiresAt',hon.saas_ts(k.refresh_expires_at)) END);
END $$;

-- FINISH {schoolId, orderTaskId, outcome, failureCode, shopifyOrderId, shopifyOrderName}: DONE (Shopify has the order;
-- its id and name are kept and the address is cleared), FAILED (Shopify will not take it as it is; a manager can send
-- it again) or RETRY (nothing certain; it waits). An order already settled answers its state and changes nothing.
CREATE FUNCTION hon.finish_pos_shopify_order(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_school uuid; v_actor uuid; o hon.pos_shopify_orders%ROWTYPE; v_outcome text; v_request uuid:=gen_random_uuid(); v_state jsonb; v_action text;
BEGIN
  v_outcome:=CASE WHEN jsonb_typeof(p_input->'outcome')='string' THEN p_input->>'outcome' END;
  IF p_subject IS NULL OR NOT hon.pos_keys_ok(p_input,ARRAY['schoolId','orderTaskId','outcome','failureCode','shopifyOrderId','shopifyOrderName'],ARRAY[]::text[])
    OR NOT hon.pos_uuid_ok(p_input->'schoolId',false) OR NOT hon.pos_uuid_ok(p_input->'orderTaskId',false)
    OR v_outcome IS NULL OR v_outcome NOT IN ('DONE','FAILED','RETRY')
    OR ((v_outcome='DONE')<>(jsonb_typeof(p_input->'failureCode')='null'))
    OR (v_outcome<>'DONE' AND (jsonb_typeof(p_input->'failureCode')<>'string' OR p_input->>'failureCode' !~ '^[A-Z_]{1,40}$'))
    OR (v_outcome='DONE' AND (jsonb_typeof(p_input->'shopifyOrderId')<>'string' OR p_input->>'shopifyOrderId' !~ '^[1-9][0-9]{0,17}$'
      OR NOT hon.pos_text_ok(p_input->'shopifyOrderName',40,false)))
    OR (v_outcome<>'DONE' AND (jsonb_typeof(p_input->'shopifyOrderId')<>'null' OR jsonb_typeof(p_input->'shopifyOrderName')<>'null')) THEN
    RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid;
  v_actor:=hon.pos_actor(p_subject,v_school,false);
  IF v_actor IS NULL THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO o FROM hon.pos_shopify_orders WHERE id=(p_input->>'orderTaskId')::uuid AND school_id=v_school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF o.status<>'PENDING' THEN RETURN jsonb_build_object('status',o.status,'changed',false); END IF;
  IF v_outcome='RETRY' THEN
    UPDATE hon.pos_shopify_orders SET failure_code=p_input->>'failureCode' WHERE id=o.id;
  ELSE
    IF v_outcome='DONE' THEN
      UPDATE hon.pos_shopify_orders SET status='DONE',failure_code=NULL,settled_at=clock_timestamp(),shopify_order_id=(p_input->>'shopifyOrderId')::bigint,
        shopify_order_name=p_input->>'shopifyOrderName',ship_to=NULL WHERE id=o.id;
    ELSE
      UPDATE hon.pos_shopify_orders SET status='FAILED',failure_code=p_input->>'failureCode',settled_at=clock_timestamp() WHERE id=o.id;
    END IF;
    v_action:=CASE WHEN v_outcome='DONE' THEN 'pos.shopify_order.created' ELSE 'pos.shopify_order.failed' END;
    v_state:=jsonb_build_object('orderTaskId',o.id,'saleId',o.sale_id,'shopifyOrderId',p_input->>'shopifyOrderId','failureCode',p_input->>'failureCode');
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id,occurred_at)
      VALUES(o.organization_id,o.school_id,v_actor,'HUMAN_UI',v_action,'POS_SALE',o.sale_id,v_state,'SUCCEEDED',v_request,v_request,clock_timestamp());
    INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
      VALUES(gen_random_uuid(),o.organization_id,o.school_id,v_action,1,'POS_SALE',o.sale_id,1,v_request,v_request,v_state||jsonb_build_object('internalOnly',true));
  END IF;
  IF hon.pos_actor(p_subject,v_school,false) IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('status',CASE WHEN v_outcome='RETRY' THEN 'PENDING' ELSE v_outcome END,'changed',true);
END $$;

DO $$ DECLARE r name; f regprocedure;
  entry text[]:=ARRAY['hon.begin_pos_shopify_order(text,jsonb)','hon.finish_pos_shopify_order(text,jsonb)'];
  e text;
BEGIN
  REVOKE ALL ON TABLE hon.pos_shopify_orders FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.pos_shopify_orders FROM %I',r);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname IN ('guard_pos_shopify_order','pos_shopify_orders_ok','pos_ship_to_ok','pos_school_ship_to','pos_shopify_order_json')
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
