BEGIN;

-- Shopify fulfilment source, print-on-demand slice PD1 (0611, coordinator-allocated 2026-11-20). Spec:
-- docs/architecture/SHOPIFY_COMMERCE.md (PD1). Commerce step 6.
-- * A school that sells print-on-demand items installs the provider's own Shopify app (Printful and others). Shopify then
--   stocks those variants at that provider's fulfilment-service location, and the provider makes and ships each order. HON
--   connects to no provider here and sends no order anywhere.
-- * The sync (read_inventory, which HON already holds) now reads who fulfils each variant. hon.shopify_variants.fulfilled_by
--   is the fulfilment service's name as Shopify shows it, or NULL when the school's own location stocks the variant.
-- * 'fulfilledBy' is an optional key of a variant in a sync page, a webhook product and a read-back product. A variant
--   sent without the key keeps the value it had (an API one release behind changes nothing).
-- * The catalog read returns fulfilledBy per variant. Low stock (variant flag and the workspace count) no longer counts a
--   provider's variants, because the school cannot restock them; the workspace counts gain 'provider'.
-- No new table, entry point, grant or scope: five existing functions are replaced with the same signatures and owners.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.shopify_apply_page(hon.shopify_syncs,text,jsonb)') IS NULL OR to_regprocedure('hon.shopify_mirror_product(uuid,jsonb,uuid)') IS NULL
    OR to_regprocedure('hon.shopify_product_item_ok(jsonb)') IS NULL OR to_regprocedure('hon.read_shopify_catalog(text,uuid)') IS NULL THEN
    RAISE EXCEPTION '0611 requires 0405, 0449 and 0496 (Shopify connection, background sync and product changes)'; END IF;
END $$;

ALTER TABLE hon.shopify_variants ADD COLUMN fulfilled_by text
  CHECK (fulfilled_by IS NULL OR (length(fulfilled_by) BETWEEN 1 AND 64 AND fulfilled_by !~ '[[:cntrl:]]' AND fulfilled_by=btrim(fulfilled_by)));

-- A fulfilment service name from Shopify: absent, null, or 1..64 characters with no control characters or outer spaces.
CREATE FUNCTION hon.shopify_fulfilled_by_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT v IS NULL OR jsonb_typeof(v)='null' OR (jsonb_typeof(v)='string' AND length(v #>> '{}') BETWEEN 1 AND 64
    AND (v #>> '{}') !~ '[[:cntrl:]]' AND (v #>> '{}')=btrim(v #>> '{}'))
$$;

-- 0449 page writer, now keeping who fulfils each variant.
CREATE OR REPLACE FUNCTION hon.shopify_apply_page(y hon.shopify_syncs,kind text,items jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE e jsonb; v jsonb; l jsonb; pos integer; n integer; nv integer:=0; ids bigint[]:='{}'; vids bigint[]:='{}';
BEGIN
  IF y.id IS NULL OR kind IS NULL OR kind NOT IN ('PRODUCTS','ORDERS') OR jsonb_typeof(items) IS DISTINCT FROM 'array' OR jsonb_array_length(items)>50 THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(items) LOOP
    IF kind='PRODUCTS' THEN
      IF NOT hon.shopify_keys_ok(e,ARRAY['id','title','status','vendor','productType','handle','imageUrl','variants'],ARRAY[]::text[])
        OR NOT hon.shopify_id_ok(e->'id',false) OR NOT hon.shopify_text_ok(e->'title',255,false)
        OR jsonb_typeof(e->'status') IS DISTINCT FROM 'string' OR e->>'status' NOT IN ('ACTIVE','DRAFT','ARCHIVED','UNLISTED')
        OR NOT hon.shopify_text_ok(e->'vendor',255,true) OR NOT hon.shopify_text_ok(e->'productType',255,true) OR NOT hon.shopify_text_ok(e->'handle',255,true)
        OR NOT (jsonb_typeof(e->'imageUrl')='null' OR (jsonb_typeof(e->'imageUrl')='string' AND length(e->>'imageUrl')<=2048
          AND e->>'imageUrl' ~ '^https://[a-z0-9.-]+\.(shopify\.com|shopifycdn\.net)/' AND e->>'imageUrl' !~ '[[:space:]"''<>\\]'))
        OR jsonb_typeof(e->'variants') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'variants') NOT BETWEEN 1 AND 100
        OR (e->>'id')::bigint=ANY(ids) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
      ids:=ids||(e->>'id')::bigint;
      FOR v IN SELECT * FROM jsonb_array_elements(e->'variants') LOOP
        IF NOT hon.shopify_keys_ok(v,ARRAY['id','title','sku','barcode','price','compareAtPrice','unitCost','tracked','inventoryQuantity'],ARRAY['fulfilledBy'])
          OR NOT hon.shopify_id_ok(v->'id',false) OR NOT hon.shopify_text_ok(v->'title',255,false)
          OR NOT hon.shopify_text_ok(v->'sku',255,true) OR NOT hon.shopify_text_ok(v->'barcode',255,true)
          OR NOT hon.shopify_money_ok(v->'price',false) OR NOT hon.shopify_money_ok(v->'compareAtPrice',true) OR NOT hon.shopify_money_ok(v->'unitCost',true)
          OR jsonb_typeof(v->'tracked') IS DISTINCT FROM 'boolean' OR NOT hon.shopify_int_ok(v->'inventoryQuantity',-10000000,10000000,true)
          OR NOT hon.shopify_fulfilled_by_ok(v->'fulfilledBy')
          OR (v->>'id')::bigint=ANY(vids) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
        vids:=vids||(v->>'id')::bigint;
      END LOOP;
    ELSE
      IF NOT hon.shopify_keys_ok(e,ARRAY['id','name','placedAt','cancelledAt','financialStatus','fulfillmentStatus','sourceName','currency',
          'subtotal','discounts','tax','total','lines'],ARRAY[]::text[])
        OR NOT hon.shopify_id_ok(e->'id',false) OR NOT hon.shopify_text_ok(e->'name',64,false)
        OR NOT hon.shopify_instant_ok(e->'placedAt',false) OR NOT hon.shopify_instant_ok(e->'cancelledAt',true)
        OR NOT (jsonb_typeof(e->'financialStatus')='null' OR (jsonb_typeof(e->'financialStatus')='string' AND e->>'financialStatus' ~ '^[A-Z_]{1,40}$'))
        OR NOT (jsonb_typeof(e->'fulfillmentStatus')='null' OR (jsonb_typeof(e->'fulfillmentStatus')='string' AND e->>'fulfillmentStatus' ~ '^[A-Z_]{1,40}$'))
        OR NOT hon.shopify_text_ok(e->'sourceName',64,true)
        OR jsonb_typeof(e->'currency') IS DISTINCT FROM 'string' OR e->>'currency' !~ '^[A-Z]{3}$'
        OR NOT hon.shopify_money_ok(e->'subtotal',false) OR NOT hon.shopify_money_ok(e->'discounts',false)
        OR NOT hon.shopify_money_ok(e->'tax',false) OR NOT hon.shopify_money_ok(e->'total',false)
        OR jsonb_typeof(e->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'lines')>50
        OR (e->>'id')::bigint=ANY(ids) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
      ids:=ids||(e->>'id')::bigint;
      FOR l IN SELECT * FROM jsonb_array_elements(e->'lines') LOOP
        IF NOT hon.shopify_keys_ok(l,ARRAY['title','sku','variantId','quantity','unitPrice'],ARRAY[]::text[])
          OR NOT hon.shopify_text_ok(l->'title',255,false) OR NOT hon.shopify_text_ok(l->'sku',255,true) OR NOT hon.shopify_id_ok(l->'variantId',true)
          OR NOT hon.shopify_int_ok(l->'quantity',0,100000,false) OR NOT hon.shopify_money_ok(l->'unitPrice',false) THEN
          RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
      END LOOP;
    END IF;
  END LOOP;
  n:=coalesce(array_length(ids,1),0);
  IF kind='PRODUCTS' THEN
    IF EXISTS(SELECT 1 FROM hon.shopify_products WHERE connection_id=y.connection_id AND last_sync_id=y.id AND shopify_id=ANY(ids))
      OR EXISTS(SELECT 1 FROM hon.shopify_variants WHERE connection_id=y.connection_id AND last_sync_id=y.id AND shopify_id=ANY(vids))
      OR y.products_seen+n>2000 THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
    FOR e IN SELECT * FROM jsonb_array_elements(items) LOOP
      INSERT INTO hon.shopify_products AS p (connection_id,shopify_id,organization_id,school_id,title,status,vendor,product_type,handle,image_url,removed,last_sync_id,synced_at)
        VALUES(y.connection_id,(e->>'id')::bigint,y.organization_id,y.school_id,e->>'title',e->>'status',e->>'vendor',e->>'productType',e->>'handle',e->>'imageUrl',false,y.id,clock_timestamp())
        ON CONFLICT (connection_id,shopify_id) DO UPDATE SET title=excluded.title,status=excluded.status,vendor=excluded.vendor,product_type=excluded.product_type,
          handle=excluded.handle,image_url=excluded.image_url,removed=false,last_sync_id=excluded.last_sync_id,synced_at=excluded.synced_at;
      pos:=0;
      FOR v IN SELECT * FROM jsonb_array_elements(e->'variants') LOOP
        pos:=pos+1; nv:=nv+1;
        INSERT INTO hon.shopify_variants AS x (connection_id,shopify_id,product_shopify_id,title,sku,barcode,price,compare_at_price,unit_cost,tracked,inventory_quantity,position,removed,last_sync_id,fulfilled_by)
          VALUES(y.connection_id,(v->>'id')::bigint,(e->>'id')::bigint,v->>'title',v->>'sku',v->>'barcode',(v->>'price')::numeric,(v->>'compareAtPrice')::numeric,
            (v->>'unitCost')::numeric,(v->>'tracked')::boolean,(v->>'inventoryQuantity')::integer,pos,false,y.id,v->>'fulfilledBy')
          ON CONFLICT (connection_id,shopify_id) DO UPDATE SET product_shopify_id=excluded.product_shopify_id,title=excluded.title,sku=excluded.sku,
            barcode=excluded.barcode,price=excluded.price,compare_at_price=excluded.compare_at_price,unit_cost=excluded.unit_cost,tracked=excluded.tracked,
            inventory_quantity=excluded.inventory_quantity,position=excluded.position,removed=false,last_sync_id=excluded.last_sync_id,
            fulfilled_by=CASE WHEN v ? 'fulfilledBy' THEN excluded.fulfilled_by ELSE x.fulfilled_by END;
      END LOOP;
    END LOOP;
    UPDATE hon.shopify_syncs SET products_seen=products_seen+n,variants_seen=variants_seen+nv WHERE id=y.id RETURNING * INTO y;
  ELSE
    IF EXISTS(SELECT 1 FROM hon.shopify_orders WHERE connection_id=y.connection_id AND last_sync_id=y.id AND shopify_id=ANY(ids))
      OR y.orders_seen+n>1000 THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
    FOR e IN SELECT * FROM jsonb_array_elements(items) LOOP
      INSERT INTO hon.shopify_orders AS o (connection_id,shopify_id,organization_id,school_id,name,placed_at,cancelled_at,financial_status,fulfillment_status,
          source_name,currency,subtotal,discounts,tax,total,last_sync_id)
        VALUES(y.connection_id,(e->>'id')::bigint,y.organization_id,y.school_id,e->>'name',(e->>'placedAt')::timestamptz,(e->>'cancelledAt')::timestamptz,
          e->>'financialStatus',e->>'fulfillmentStatus',e->>'sourceName',e->>'currency',(e->>'subtotal')::numeric,(e->>'discounts')::numeric,
          (e->>'tax')::numeric,(e->>'total')::numeric,y.id)
        ON CONFLICT (connection_id,shopify_id) DO UPDATE SET name=excluded.name,placed_at=excluded.placed_at,cancelled_at=excluded.cancelled_at,
          financial_status=excluded.financial_status,fulfillment_status=excluded.fulfillment_status,source_name=excluded.source_name,
          currency=excluded.currency,subtotal=excluded.subtotal,discounts=excluded.discounts,tax=excluded.tax,total=excluded.total,last_sync_id=excluded.last_sync_id;
      DELETE FROM hon.shopify_order_lines WHERE connection_id=y.connection_id AND order_shopify_id=(e->>'id')::bigint;
      INSERT INTO hon.shopify_order_lines(connection_id,order_shopify_id,line_no,title,sku,variant_shopify_id,quantity,unit_price)
        SELECT y.connection_id,(e->>'id')::bigint,x.n::int,x.l->>'title',x.l->>'sku',(x.l->>'variantId')::bigint,(x.l->>'quantity')::integer,(x.l->>'unitPrice')::numeric
        FROM jsonb_array_elements(e->'lines') WITH ORDINALITY x(l,n);
    END LOOP;
    UPDATE hon.shopify_syncs SET orders_seen=orders_seen+n WHERE id=y.id RETURNING * INTO y;
  END IF;
  RETURN jsonb_build_object('syncId',y.id,'productsSeen',y.products_seen,'variantsSeen',y.variants_seen,'ordersSeen',y.orders_seen);
END $$;

-- 0496 product check and mirror writer, same addition.
CREATE OR REPLACE FUNCTION hon.shopify_product_item_ok(e jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE v jsonb; vids bigint[]:='{}';
BEGIN
  IF NOT coalesce(hon.shopify_keys_ok(e,ARRAY['id','title','status','vendor','productType','handle','imageUrl','variants'],ARRAY[]::text[]),false)
    OR NOT hon.shopify_id_ok(e->'id',false) OR NOT hon.shopify_text_ok(e->'title',255,false)
    OR jsonb_typeof(e->'status') IS DISTINCT FROM 'string' OR e->>'status' NOT IN ('ACTIVE','DRAFT','ARCHIVED','UNLISTED')
    OR NOT hon.shopify_text_ok(e->'vendor',255,true) OR NOT hon.shopify_text_ok(e->'productType',255,true) OR NOT hon.shopify_text_ok(e->'handle',255,true)
    OR NOT (jsonb_typeof(e->'imageUrl')='null' OR (jsonb_typeof(e->'imageUrl')='string' AND length(e->>'imageUrl')<=2048
      AND e->>'imageUrl' ~ '^https://[a-z0-9.-]+\.(shopify\.com|shopifycdn\.net)/' AND e->>'imageUrl' !~ '[[:space:]"''<>\\]'))
    OR jsonb_typeof(e->'variants') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'variants') NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  FOR v IN SELECT * FROM jsonb_array_elements(e->'variants') LOOP
    IF NOT coalesce(hon.shopify_keys_ok(v,ARRAY['id','title','sku','barcode','price','compareAtPrice','unitCost','tracked','inventoryQuantity'],ARRAY['fulfilledBy']),false)
      OR NOT hon.shopify_id_ok(v->'id',false) OR NOT hon.shopify_text_ok(v->'title',255,false)
      OR NOT hon.shopify_text_ok(v->'sku',255,true) OR NOT hon.shopify_text_ok(v->'barcode',255,true)
      OR NOT hon.shopify_money_ok(v->'price',false) OR NOT hon.shopify_money_ok(v->'compareAtPrice',true) OR NOT hon.shopify_money_ok(v->'unitCost',true)
      OR jsonb_typeof(v->'tracked') IS DISTINCT FROM 'boolean' OR NOT hon.shopify_int_ok(v->'inventoryQuantity',-10000000,10000000,true)
      OR NOT hon.shopify_fulfilled_by_ok(v->'fulfilledBy')
      OR (v->>'id')::bigint=ANY(vids) THEN RETURN false; END IF;
    vids:=vids||(v->>'id')::bigint;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION hon.shopify_mirror_product(p_connection uuid,e jsonb,p_stamp uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.shopify_connections%ROWTYPE; v jsonb; pos integer:=0; stamp uuid;
BEGIN
  IF NOT hon.shopify_product_item_ok(e) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM hon.shopify_connections WHERE id=p_connection;
  stamp:=coalesce((SELECT y.id FROM hon.shopify_syncs y WHERE y.connection_id=c.id AND y.outcome='RUNNING' LIMIT 1),p_stamp);
  INSERT INTO hon.shopify_products AS p (connection_id,shopify_id,organization_id,school_id,title,status,vendor,product_type,handle,image_url,removed,last_sync_id,synced_at)
    VALUES(c.id,(e->>'id')::bigint,c.organization_id,c.school_id,e->>'title',e->>'status',e->>'vendor',e->>'productType',e->>'handle',e->>'imageUrl',false,stamp,clock_timestamp())
    ON CONFLICT (connection_id,shopify_id) DO UPDATE SET title=excluded.title,status=excluded.status,vendor=excluded.vendor,product_type=excluded.product_type,
      handle=excluded.handle,image_url=excluded.image_url,removed=false,synced_at=excluded.synced_at;
  FOR v IN SELECT * FROM jsonb_array_elements(e->'variants') LOOP
    pos:=pos+1;
    INSERT INTO hon.shopify_variants AS x (connection_id,shopify_id,product_shopify_id,title,sku,barcode,price,compare_at_price,unit_cost,tracked,inventory_quantity,position,removed,last_sync_id,fulfilled_by)
      VALUES(c.id,(v->>'id')::bigint,(e->>'id')::bigint,v->>'title',v->>'sku',v->>'barcode',(v->>'price')::numeric,(v->>'compareAtPrice')::numeric,
        (v->>'unitCost')::numeric,(v->>'tracked')::boolean,(v->>'inventoryQuantity')::integer,pos,false,stamp,v->>'fulfilledBy')
      ON CONFLICT (connection_id,shopify_id) DO UPDATE SET product_shopify_id=excluded.product_shopify_id,title=excluded.title,sku=excluded.sku,
        barcode=excluded.barcode,price=excluded.price,compare_at_price=excluded.compare_at_price,unit_cost=excluded.unit_cost,tracked=excluded.tracked,
        inventory_quantity=excluded.inventory_quantity,position=excluded.position,removed=false,
        fulfilled_by=CASE WHEN v ? 'fulfilledBy' THEN excluded.fulfilled_by ELSE x.fulfilled_by END;
  END LOOP;
END $$;

-- 0405 workspace read: low stock leaves out a provider's variants; counts gain 'provider'.
CREATE OR REPLACE FUNCTION hon.read_shopify(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.shopify_connections%ROWTYPE; manage boolean; since timestamptz:=clock_timestamp()-interval '30 days'; summary jsonb;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.shopify_actor(p_subject,p_school,false) IS NULL THEN RAISE EXCEPTION 'SHOPIFY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  manage:=hon.shopify_actor(p_subject,p_school,true) IS NOT NULL;
  c:=hon.shopify_current(p_school);
  IF c.id IS NOT NULL THEN
    WITH o AS (SELECT * FROM hon.shopify_orders x WHERE x.connection_id=c.id AND x.placed_at>=since AND x.cancelled_at IS NULL),
    l AS (SELECT ol.title,ol.quantity,ol.unit_price,v.unit_cost FROM hon.shopify_order_lines ol JOIN o ON o.shopify_id=ol.order_shopify_id
      LEFT JOIN hon.shopify_variants v ON v.connection_id=c.id AND v.shopify_id=ol.variant_shopify_id WHERE ol.connection_id=c.id)
    SELECT jsonb_build_object('days',30,
      'orders',(SELECT count(*)::int FROM o),
      'sales',(SELECT round(coalesce(sum(total),0),2) FROM o),
      'averageOrder',(SELECT CASE WHEN count(*)=0 THEN 0 ELSE round(sum(total)/count(*),2) END FROM o),
      'itemsSold',(SELECT coalesce(sum(quantity),0)::int FROM l),
      'lineSales',(SELECT round(coalesce(sum(quantity*unit_price),0),2) FROM l),
      'coveredSales',(SELECT round(coalesce(sum(quantity*unit_price),0),2) FROM l WHERE unit_cost IS NOT NULL),
      'estimatedGrossProfit',(SELECT round(coalesce(sum(quantity*(unit_price-unit_cost)),0),2) FROM l WHERE unit_cost IS NOT NULL),
      'topProducts',(SELECT coalesce(jsonb_agg(t ORDER BY (t->>'quantity')::int DESC,t->>'title'),'[]'::jsonb) FROM (
        SELECT jsonb_build_object('title',title,'quantity',sum(quantity)::int,'sales',round(sum(quantity*unit_price),2)) t
        FROM l GROUP BY title ORDER BY sum(quantity) DESC,title LIMIT 5) x))
    INTO summary;
  END IF;
  RETURN jsonb_build_object('schoolId',p_school,'canManage',manage,'connection',hon.shopify_connection_json(c),
    'counts',CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
      'products',(SELECT count(*)::int FROM hon.shopify_products p WHERE p.connection_id=c.id AND NOT p.removed),
      'variants',(SELECT count(*)::int FROM hon.shopify_variants v WHERE v.connection_id=c.id AND NOT v.removed),
      'lowStock',(SELECT count(*)::int FROM hon.shopify_variants v WHERE v.connection_id=c.id AND NOT v.removed AND v.fulfilled_by IS NULL AND v.tracked AND coalesce(v.inventory_quantity,0)<=3),
      'provider',(SELECT count(*)::int FROM hon.shopify_variants v WHERE v.connection_id=c.id AND NOT v.removed AND v.fulfilled_by IS NOT NULL),
      'orders',(SELECT count(*)::int FROM hon.shopify_orders o WHERE o.connection_id=c.id)) END,
    'summary',summary);
END $$;

-- 0405 catalog read: fulfilledBy per variant.
CREATE OR REPLACE FUNCTION hon.read_shopify_catalog(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.shopify_connections%ROWTYPE;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.shopify_actor(p_subject,p_school,false) IS NULL THEN RAISE EXCEPTION 'SHOPIFY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  c:=hon.shopify_current(p_school);
  RETURN jsonb_build_object('schoolId',p_school,'currency',c.currency,'products',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'productId',p.shopify_id::text,'title',p.title,'status',p.status,'vendor',p.vendor,'productType',p.product_type,'imageUrl',p.image_url,
      'variants',(SELECT coalesce(jsonb_agg(jsonb_build_object('variantId',v.shopify_id::text,'title',v.title,'sku',v.sku,'barcode',v.barcode,
          'price',v.price,'compareAtPrice',v.compare_at_price,'unitCost',v.unit_cost,
          'margin',CASE WHEN v.unit_cost IS NULL THEN NULL ELSE v.price-v.unit_cost END,
          'marginPercent',CASE WHEN v.unit_cost IS NULL OR v.price=0 THEN NULL ELSE round(100*(v.price-v.unit_cost)/v.price,1) END,
          'tracked',v.tracked,'inventoryQuantity',v.inventory_quantity,'lowStock',v.fulfilled_by IS NULL AND v.tracked AND coalesce(v.inventory_quantity,0)<=3,'fulfilledBy',v.fulfilled_by)
        ORDER BY v.position,v.shopify_id),'[]'::jsonb) FROM hon.shopify_variants v WHERE v.connection_id=c.id AND v.product_shopify_id=p.shopify_id AND NOT v.removed))
      ORDER BY lower(p.title),p.shopify_id)
    FROM (SELECT * FROM hon.shopify_products x WHERE x.connection_id=c.id AND NOT x.removed ORDER BY lower(x.title),x.shopify_id LIMIT 2000) p),'[]'::jsonb));
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.shopify_fulfilled_by_ok(jsonb) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.shopify_fulfilled_by_ok(jsonb) FROM %I',r); END LOOP;
END $$;

COMMIT;
