BEGIN;

-- HON Shopify Connected, piece SH1b (0449, coordinator-allocated 2026-11-16; first allocated 0408, then 0425, 0433 and 0442). Spec: docs/architecture/SHOPIFY_COMMERCE.md.
-- Builds on 0405 (SH1). Two things happen without a person pressing Sync now:
-- * Signed Shopify webhooks. The API checks Shopify's HMAC over the exact body before anything reaches the database,
--   and passes only the delivery id, topic, shop domain and trigger time. No payload is stored. Catalog, inventory and
--   order topics mark the store as needing a sync; app/uninstalled disconnects the store (its credential is destroyed
--   at once); shop/redact erases the store's mirror once it is no longer connected; customers/redact and
--   customers/data_request are recorded and need nothing else because HON's Shopify mirror holds no customer details.
--   Each delivery id is recorded once; a repeat is answered from its first outcome.
-- * Background sync. The worker login (hon_communication_worker, never the runtime) claims one due store at a time:
--   one Shopify reported a change for, or one not synced in six hours (the six-hour run also refreshes the token pair,
--   which keeps the 90-day refresh token alive). Only a CONNECTED store whose school, organization and HON entitlement
--   are active is claimed; never more than one sync per store every two minutes. A background sync is started by the
--   code-owned SYSTEM_SERVICE principal below and carries a lease token; only that lease can rotate, write pages to or
--   finish it, and a person's sync commands cannot touch it. It writes the mirror through the same page rules as 0405.
-- * Forced RLS with no policy and no client table privilege; the runtime gains nothing in this migration.
-- * Audit and outbox carry ids, the shop domain, topics and counts only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.shopify_connections') IS NULL OR to_regprocedure('hon.record_shopify_sync_page(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '0449 requires 0405 (Shopify connection)'; END IF;
END $$;

-- The code-owned actor of background syncs and webhook effects. It holds no role at any school.
INSERT INTO hon.principals (id,principal_type,user_id,display_name,is_active)
VALUES ('00000000-0000-4000-8000-000000000408','SYSTEM_SERVICE',NULL,'Shopify background sync and webhooks',true);

ALTER TABLE hon.shopify_syncs
  ADD COLUMN source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','SCHEDULED','WEBHOOK')),
  ADD COLUMN lease_token uuid,
  ADD CONSTRAINT shopify_syncs_lease_pair CHECK ((source='MANUAL')=(lease_token IS NULL)),
  ADD CONSTRAINT shopify_syncs_background_actor CHECK (source='MANUAL' OR started_by_principal_id='00000000-0000-4000-8000-000000000408');

-- A store Shopify reported a change for. One row per connection; a newer report moves requested_at forward.
CREATE TABLE hon.shopify_sync_requests (
  connection_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  topic text NOT NULL CHECK (topic IN ('products/create','products/update','products/delete','inventory_levels/update',
    'orders/create','orders/updated','orders/cancelled','orders/delete')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count>=1),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.shopify_connections(id,organization_id,school_id)
);

-- One row per verified delivery (Shopify's X-Shopify-Webhook-Id), kept forever, never changed. No payload.
CREATE TABLE hon.shopify_webhook_receipts (
  webhook_id text PRIMARY KEY CHECK (webhook_id ~ '^[A-Za-z0-9-]{1,64}$'),
  topic text NOT NULL CHECK (topic IN ('products/create','products/update','products/delete','inventory_levels/update',
    'orders/create','orders/updated','orders/cancelled','orders/delete','app/uninstalled','shop/redact','customers/redact','customers/data_request')),
  shop_domain text NOT NULL CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$'),
  connection_id uuid REFERENCES hon.shopify_connections(id),
  triggered_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome text NOT NULL CHECK (outcome IN ('SYNC_REQUESTED','UNINSTALLED','SHOP_ERASED','NO_CUSTOMER_DATA','IGNORED'))
);
CREATE INDEX shopify_webhook_receipts_connection_idx ON hon.shopify_webhook_receipts (connection_id,received_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shopify_sync_requests','shopify_webhook_receipts'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

-- 0405's guard, extended: a sync also keeps its source and lease, and a webhook receipt is never changed or deleted.
CREATE OR REPLACE FUNCTION hon.guard_shopify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'SHOPIFY_RECORD_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='shopify_connections' THEN
    IF TG_OP='UPDATE' AND NEW.version=OLD.version+1 AND (NEW.id,NEW.organization_id,NEW.school_id,NEW.shop_domain,NEW.connected_by_principal_id)
      IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.shop_domain,OLD.connected_by_principal_id) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='shopify_connect_intents' THEN
    IF TG_OP='UPDATE' AND (NEW.id,NEW.organization_id,NEW.school_id,NEW.shop_domain,NEW.started_by_principal_id,NEW.state_hash,NEW.created_at,NEW.expires_at)
        IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.shop_domain,OLD.started_by_principal_id,OLD.state_hash,OLD.created_at,OLD.expires_at)
      AND ((OLD.claimed_at IS NULL AND NEW.claimed_at IS NOT NULL AND NEW.finished_at IS NULL)
        OR (OLD.claimed_at IS NOT NULL AND OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL
          AND (NEW.claimed_at,NEW.connection_id) IS NOT DISTINCT FROM (OLD.claimed_at,OLD.connection_id))) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='shopify_syncs' THEN
    IF TG_OP='UPDATE' AND OLD.outcome='RUNNING' AND (NEW.id,NEW.connection_id,NEW.organization_id,NEW.school_id,NEW.started_by_principal_id,NEW.started_at,NEW.source,NEW.lease_token)
      IS NOT DISTINCT FROM (OLD.id,OLD.connection_id,OLD.organization_id,OLD.school_id,OLD.started_by_principal_id,OLD.started_at,OLD.source,OLD.lease_token) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='shopify_credentials' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.version=1 AND NEW.sealed IS NOT NULL AND NEW.rotated_at IS NULL AND NEW.destroyed_at IS NULL THEN RETURN NEW; END IF;
    ELSIF TG_OP='UPDATE' AND NEW.version=OLD.version+1
      AND (NEW.connection_id,NEW.organization_id,NEW.school_id,NEW.stored_by_principal_id,NEW.stored_at)
        IS NOT DISTINCT FROM (OLD.connection_id,OLD.organization_id,OLD.school_id,OLD.stored_by_principal_id,OLD.stored_at)
      AND (OLD.destroyed_at IS NULL OR (NEW.sealed IS NOT NULL AND NEW.destroyed_at IS NULL)) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME='shopify_webhook_receipts' THEN
    NULL;
  ELSE
    RETURN COALESCE(NEW,OLD);
  END IF;
  RAISE EXCEPTION 'SHOPIFY_RECORD_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER shopify_webhook_receipts_guard BEFORE UPDATE OR DELETE ON hon.shopify_webhook_receipts FOR EACH ROW EXECUTE FUNCTION hon.guard_shopify();
CREATE TRIGGER shopify_webhook_receipts_no_truncate BEFORE TRUNCATE ON hon.shopify_webhook_receipts FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_shopify();
CREATE TRIGGER shopify_sync_requests_no_truncate BEFORE TRUNCATE ON hon.shopify_sync_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_shopify();

-- Evidence written by the code-owned principal (source INTEGRATION). Ids, shop domain, topics and counts only.
CREATE FUNCTION hon.shopify_system_evidence(p_org uuid,p_school uuid,p_action text,p_entity uuid,p_version integer,p_state jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_request uuid:=gen_random_uuid();
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id,occurred_at)
    VALUES(p_org,p_school,'00000000-0000-4000-8000-000000000408','INTEGRATION',p_action,'SHOPIFY_CONNECTION',p_entity,p_state,'SUCCEEDED',v_request,v_request,clock_timestamp());
  INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(gen_random_uuid(),p_org,p_school,p_action,1,'SHOPIFY_CONNECTION',p_entity,p_version,v_request,v_request,p_state||jsonb_build_object('internalOnly',true));
END $$;

-- The school, organization and HON entitlement are active right now (the 0405 identity rules without a person).
CREATE FUNCTION hon.shopify_school_live(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.schools s JOIN hon.organizations o ON o.id=s.organization_id AND o.status='ACTIVE'
    WHERE s.id=p_school AND s.status='ACTIVE'
      AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=s.organization_id AND e.status='ACTIVE'
        AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())))
$$;

-- One page of the mirror, validated whole before anything is written (0405 rules, moved here so a person's sync and a
-- background sync write through the same code).
CREATE FUNCTION hon.shopify_apply_page(y hon.shopify_syncs,kind text,items jsonb) RETURNS jsonb
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
        IF NOT hon.shopify_keys_ok(v,ARRAY['id','title','sku','barcode','price','compareAtPrice','unitCost','tracked','inventoryQuantity'],ARRAY[]::text[])
          OR NOT hon.shopify_id_ok(v->'id',false) OR NOT hon.shopify_text_ok(v->'title',255,false)
          OR NOT hon.shopify_text_ok(v->'sku',255,true) OR NOT hon.shopify_text_ok(v->'barcode',255,true)
          OR NOT hon.shopify_money_ok(v->'price',false) OR NOT hon.shopify_money_ok(v->'compareAtPrice',true) OR NOT hon.shopify_money_ok(v->'unitCost',true)
          OR jsonb_typeof(v->'tracked') IS DISTINCT FROM 'boolean' OR NOT hon.shopify_int_ok(v->'inventoryQuantity',-10000000,10000000,true)
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
        INSERT INTO hon.shopify_variants AS x (connection_id,shopify_id,product_shopify_id,title,sku,barcode,price,compare_at_price,unit_cost,tracked,inventory_quantity,position,removed,last_sync_id)
          VALUES(y.connection_id,(v->>'id')::bigint,(e->>'id')::bigint,v->>'title',v->>'sku',v->>'barcode',(v->>'price')::numeric,(v->>'compareAtPrice')::numeric,
            (v->>'unitCost')::numeric,(v->>'tracked')::boolean,(v->>'inventoryQuantity')::integer,pos,false,y.id)
          ON CONFLICT (connection_id,shopify_id) DO UPDATE SET product_shopify_id=excluded.product_shopify_id,title=excluded.title,sku=excluded.sku,
            barcode=excluded.barcode,price=excluded.price,compare_at_price=excluded.compare_at_price,unit_cost=excluded.unit_cost,tracked=excluded.tracked,
            inventory_quantity=excluded.inventory_quantity,position=excluded.position,removed=false,last_sync_id=excluded.last_sync_id;
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

-- 0405 PAGE for a person's sync, now writing through hon.shopify_apply_page. Same input, checks, order and answer.
CREATE OR REPLACE FUNCTION hon.record_shopify_sync_page(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; y hon.shopify_syncs%ROWTYPE; kind text; items jsonb; r jsonb;
BEGIN
  kind:=CASE WHEN jsonb_typeof(p_input)='object' AND jsonb_typeof(p_input->'kind')='string' THEN p_input->>'kind' END;
  IF kind IS NULL OR kind NOT IN ('PRODUCTS','ORDERS') THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['syncId','kind',CASE WHEN kind='ORDERS' THEN 'orders' ELSE 'products' END]);
  items:=CASE WHEN kind='ORDERS' THEN p_input->'orders' ELSE p_input->'products' END;
  IF jsonb_typeof(items) IS DISTINCT FROM 'array' OR jsonb_array_length(items)>50 THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  y:=hon.shopify_running_sync(b.school,b.actor,p_input->'syncId');
  r:=hon.shopify_apply_page(y,kind,items);
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN r;
END $$;

-- ---------- worker (hon_communication_worker) ----------

-- WEBHOOK {webhookId, topic, shopDomain, triggeredAt|null}: the API verified Shopify's signature over the exact body.
-- Recorded once per delivery id; a repeat returns the first outcome with replayed=true and changes nothing.
CREATE FUNCTION hon.record_shopify_webhook(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_id text; v_topic text; v_shop text; v_at timestamptz; c hon.shopify_connections%ROWTYPE; prior text; v_outcome text:='IGNORED';
  n_lines integer; n_orders integer; n_variants integer; n_products integer;
BEGIN
  IF NOT hon.shopify_keys_ok(p_input,ARRAY['webhookId','topic','shopDomain','triggeredAt'],ARRAY[]::text[])
    OR jsonb_typeof(p_input->'webhookId') IS DISTINCT FROM 'string' OR p_input->>'webhookId' !~ '^[A-Za-z0-9-]{1,64}$'
    OR jsonb_typeof(p_input->'topic') IS DISTINCT FROM 'string' OR p_input->>'topic' NOT IN ('products/create','products/update','products/delete',
      'inventory_levels/update','orders/create','orders/updated','orders/cancelled','orders/delete','app/uninstalled','shop/redact',
      'customers/redact','customers/data_request')
    OR NOT hon.shopify_shop_ok(p_input->'shopDomain') OR NOT hon.shopify_instant_ok(p_input->'triggeredAt',true) THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  v_id:=p_input->>'webhookId'; v_topic:=p_input->>'topic'; v_shop:=p_input->>'shopDomain'; v_at:=(p_input->>'triggeredAt')::timestamptz;
  PERFORM pg_advisory_xact_lock(hashtextextended('shopify-webhook:'||v_id,0));
  SELECT outcome INTO prior FROM hon.shopify_webhook_receipts WHERE webhook_id=v_id;
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('outcome',prior,'replayed',true); END IF;
  SELECT * INTO c FROM hon.shopify_connections WHERE shop_domain=v_shop;
  IF c.id IS NOT NULL THEN
    -- The same order as a person's command: the school lock, then the connection row.
    PERFORM pg_advisory_xact_lock(hashtextextended('shopify-school:'||c.school_id::text,0));
    SELECT * INTO c FROM hon.shopify_connections WHERE id=c.id FOR UPDATE;
  END IF;
  IF v_topic IN ('customers/redact','customers/data_request') THEN
    v_outcome:='NO_CUSTOMER_DATA';
  ELSIF c.id IS NULL THEN
    v_outcome:='IGNORED';
  ELSIF v_topic='app/uninstalled' THEN
    IF c.status<>'DISCONNECTED' THEN
      UPDATE hon.shopify_syncs SET outcome='FAILED',failure_code='UNINSTALLED',finished_at=clock_timestamp() WHERE connection_id=c.id AND outcome='RUNNING';
      UPDATE hon.shopify_connections SET status='DISCONNECTED',version=version+1,updated_at=clock_timestamp(),ended_at=coalesce(ended_at,clock_timestamp())
        WHERE id=c.id RETURNING * INTO c;
      DELETE FROM hon.shopify_sync_requests WHERE connection_id=c.id;
      PERFORM hon.shopify_system_evidence(c.organization_id,c.school_id,'commerce.shopify.uninstalled',c.id,c.version,
        jsonb_build_object('shopDomain',c.shop_domain,'webhookId',v_id));
      v_outcome:='UNINSTALLED';
    END IF;
  ELSIF v_topic='shop/redact' THEN
    -- Shopify asks for this 48 hours after the store uninstalled HON. A store connected again is not erased.
    IF c.status<>'CONNECTED' THEN
      DELETE FROM hon.shopify_order_lines WHERE connection_id=c.id; GET DIAGNOSTICS n_lines=ROW_COUNT;
      DELETE FROM hon.shopify_orders WHERE connection_id=c.id; GET DIAGNOSTICS n_orders=ROW_COUNT;
      DELETE FROM hon.shopify_variants WHERE connection_id=c.id; GET DIAGNOSTICS n_variants=ROW_COUNT;
      DELETE FROM hon.shopify_products WHERE connection_id=c.id; GET DIAGNOSTICS n_products=ROW_COUNT;
      DELETE FROM hon.shopify_sync_requests WHERE connection_id=c.id;
      UPDATE hon.shopify_connections SET shop_name=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
      PERFORM hon.shopify_system_evidence(c.organization_id,c.school_id,'commerce.shopify.shop_erased',c.id,c.version,
        jsonb_build_object('shopDomain',c.shop_domain,'webhookId',v_id,'products',n_products,'variants',n_variants,'orders',n_orders,'orderLines',n_lines));
      v_outcome:='SHOP_ERASED';
    END IF;
  ELSIF c.status='CONNECTED' THEN
    INSERT INTO hon.shopify_sync_requests AS r (connection_id,organization_id,school_id,topic) VALUES(c.id,c.organization_id,c.school_id,v_topic)
      ON CONFLICT (connection_id) DO UPDATE SET topic=excluded.topic,requested_at=clock_timestamp(),request_count=r.request_count+1;
    v_outcome:='SYNC_REQUESTED';
  END IF;
  INSERT INTO hon.shopify_webhook_receipts(webhook_id,topic,shop_domain,connection_id,triggered_at,outcome) VALUES(v_id,v_topic,v_shop,c.id,v_at,v_outcome);
  RETURN jsonb_build_object('outcome',v_outcome,'replayed',false);
END $$;

-- CLAIM: one due store, or null. Due: CONNECTED, school/organization/entitlement live, no sync started in the last two
-- minutes or running (under 15 minutes old), and either a change report newer than its latest sync or no finished
-- sync in six hours. A store another worker holds is skipped. Returns the sealed credential to the API.
CREATE FUNCTION hon.claim_shopify_background_sync() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.shopify_connections%ROWTYPE; y hon.shopify_syncs%ROWTYPE; k hon.shopify_credentials%ROWTYPE; requested boolean; found boolean:=false;
BEGIN
  -- Up to 20 due stores, most urgent first. Never wait for a person's command: a store whose school is busy is skipped
  -- (tried again on the next run) and the next due store is claimed instead.
  FOR c IN SELECT x.* FROM hon.shopify_connections x
    LEFT JOIN hon.shopify_sync_requests r ON r.connection_id=x.id
    LEFT JOIN LATERAL (SELECT max(z.started_at) started FROM hon.shopify_syncs z WHERE z.connection_id=x.id) last ON true
    WHERE x.status='CONNECTED' AND hon.shopify_school_live(x.school_id)
      AND coalesce(last.started,'-infinity'::timestamptz)<clock_timestamp()-interval '2 minutes'
      AND NOT EXISTS(SELECT 1 FROM hon.shopify_syncs z WHERE z.connection_id=x.id AND z.outcome='RUNNING' AND z.started_at>clock_timestamp()-interval '15 minutes')
      AND (r.requested_at>coalesce(last.started,'-infinity'::timestamptz) OR coalesce(x.last_sync_at,'-infinity'::timestamptz)<clock_timestamp()-interval '6 hours')
    ORDER BY (r.requested_at>coalesce(last.started,'-infinity'::timestamptz)) IS TRUE DESC,x.last_sync_at NULLS FIRST,x.id
    LIMIT 20 FOR UPDATE OF x SKIP LOCKED LOOP
    IF pg_try_advisory_xact_lock(hashtextextended('shopify-school:'||c.school_id::text,0)) THEN found:=true; EXIT; END IF;
  END LOOP;
  IF NOT found THEN RETURN NULL; END IF;
  requested:=EXISTS(SELECT 1 FROM hon.shopify_sync_requests r WHERE r.connection_id=c.id
    AND r.requested_at>coalesce((SELECT max(z.started_at) FROM hon.shopify_syncs z WHERE z.connection_id=c.id),'-infinity'::timestamptz));
  UPDATE hon.shopify_syncs SET outcome='ABANDONED',finished_at=clock_timestamp()
    WHERE connection_id=c.id AND outcome='RUNNING' AND started_at<=clock_timestamp()-interval '15 minutes';
  INSERT INTO hon.shopify_syncs(connection_id,organization_id,school_id,started_by_principal_id,source,lease_token)
    VALUES(c.id,c.organization_id,c.school_id,'00000000-0000-4000-8000-000000000408',CASE WHEN requested THEN 'WEBHOOK' ELSE 'SCHEDULED' END,gen_random_uuid())
    RETURNING * INTO y;
  SELECT * INTO k FROM hon.shopify_credentials WHERE connection_id=c.id AND destroyed_at IS NULL;
  RETURN jsonb_build_object('syncId',y.id,'leaseToken',y.lease_token,'source',y.source,'schoolId',c.school_id,'connectionId',c.id,'shopDomain',c.shop_domain,
    'credential',jsonb_build_object('keyId',k.key_id,'sealed',k.sealed,'version',k.version,
      'accessExpiresAt',hon.saas_ts(k.access_expires_at),'refreshExpiresAt',hon.saas_ts(k.refresh_expires_at)));
END $$;

-- The running background sync this lease holds, on a store that is still CONNECTED, locked in the order a person's
-- command uses (school lock, then the sync). p_live: the school must also still be live (pages and rotation).
CREATE FUNCTION hon.shopify_leased_sync(p_input jsonb,p_required text[],p_live boolean) RETURNS hon.shopify_syncs
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE y hon.shopify_syncs%ROWTYPE;
BEGIN
  IF NOT hon.shopify_keys_ok(p_input,ARRAY['syncId','leaseToken']||p_required,ARRAY[]::text[])
    OR NOT hon.shopify_uuid_ok(p_input->'syncId') OR NOT hon.shopify_uuid_ok(p_input->'leaseToken') THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO y FROM hon.shopify_syncs WHERE id=(p_input->>'syncId')::uuid;
  IF y.id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('shopify-school:'||y.school_id::text,0));
    SELECT * INTO y FROM hon.shopify_syncs WHERE id=y.id FOR UPDATE;
  END IF;
  IF y.id IS NULL OR y.source='MANUAL' OR y.lease_token IS DISTINCT FROM (p_input->>'leaseToken')::uuid OR y.outcome<>'RUNNING'
    OR y.started_at<=clock_timestamp()-interval '15 minutes'
    OR NOT EXISTS(SELECT 1 FROM hon.shopify_connections c WHERE c.id=y.connection_id AND c.status='CONNECTED') THEN
    RAISE EXCEPTION 'SHOPIFY_SYNC_NOT_RUNNING' USING ERRCODE='22023'; END IF;
  IF p_live AND NOT hon.shopify_school_live(y.school_id) THEN RAISE EXCEPTION 'SHOPIFY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN y;
END $$;

-- ROTATE {syncId, leaseToken, expectedVersion, credential}.
CREATE FUNCTION hon.rotate_shopify_background_credential(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE y hon.shopify_syncs%ROWTYPE; k jsonb; v integer;
BEGIN
  y:=hon.shopify_leased_sync(p_input,ARRAY['expectedVersion','credential'],true);
  k:=p_input->'credential';
  IF NOT hon.shopify_int_ok(p_input->'expectedVersion',1,1000000000,false) OR NOT hon.shopify_credential_ok(k)
    OR (k->>'accessExpiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  UPDATE hon.shopify_credentials SET version=version+1,key_id=k->>'keyId',sealed=k->>'sealed',access_expires_at=(k->>'accessExpiresAt')::timestamptz,
    refresh_expires_at=(k->>'refreshExpiresAt')::timestamptz,rotated_at=clock_timestamp()
    WHERE connection_id=y.connection_id AND destroyed_at IS NULL AND version=(p_input->>'expectedVersion')::integer RETURNING version INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'SHOPIFY_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('version',v);
END $$;

-- PAGE {syncId, leaseToken, kind, products|orders}: the 0405 page rules.
CREATE FUNCTION hon.record_shopify_background_page(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE y hon.shopify_syncs%ROWTYPE; kind text;
BEGIN
  kind:=CASE WHEN jsonb_typeof(p_input)='object' AND jsonb_typeof(p_input->'kind')='string' THEN p_input->>'kind' END;
  IF kind IS NULL OR kind NOT IN ('PRODUCTS','ORDERS') THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  y:=hon.shopify_leased_sync(p_input,ARRAY['kind',CASE WHEN kind='ORDERS' THEN 'orders' ELSE 'products' END],true);
  RETURN hon.shopify_apply_page(y,kind,CASE WHEN kind='ORDERS' THEN p_input->'orders' ELSE p_input->'products' END);
END $$;

-- FINISH {syncId, leaseToken, outcome, failureCode}: the 0405 finish rules, evidence by the code-owned principal.
CREATE FUNCTION hon.finish_shopify_background_sync(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE y hon.shopify_syncs%ROWTYPE; c hon.shopify_connections%ROWTYPE; v_outcome text; removed_products integer:=0; removed_variants integer:=0;
BEGIN
  y:=hon.shopify_leased_sync(p_input,ARRAY['outcome','failureCode'],false);
  v_outcome:=p_input->>'outcome';
  IF jsonb_typeof(p_input->'outcome') IS DISTINCT FROM 'string' OR v_outcome NOT IN ('SUCCEEDED','FAILED','NEEDS_RECONNECT')
    OR (v_outcome='SUCCEEDED' AND jsonb_typeof(p_input->'failureCode') IS DISTINCT FROM 'null')
    OR (v_outcome<>'SUCCEEDED' AND (jsonb_typeof(p_input->'failureCode') IS DISTINCT FROM 'string' OR p_input->>'failureCode' !~ '^[A-Z_]{1,40}$')) THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  IF v_outcome='SUCCEEDED' THEN
    UPDATE hon.shopify_variants x SET removed=true WHERE x.connection_id=y.connection_id AND NOT x.removed AND x.last_sync_id<>y.id;
    GET DIAGNOSTICS removed_variants=ROW_COUNT;
    UPDATE hon.shopify_products x SET removed=true WHERE x.connection_id=y.connection_id AND NOT x.removed AND x.last_sync_id<>y.id;
    GET DIAGNOSTICS removed_products=ROW_COUNT;
  END IF;
  UPDATE hon.shopify_syncs SET outcome=v_outcome,failure_code=p_input->>'failureCode',finished_at=clock_timestamp() WHERE id=y.id RETURNING * INTO y;
  UPDATE hon.shopify_connections SET last_sync_at=y.finished_at,last_sync_outcome=y.outcome,version=version+1,updated_at=clock_timestamp(),
    status=CASE WHEN y.outcome='NEEDS_RECONNECT' THEN 'NEEDS_RECONNECT' ELSE status END,
    ended_at=CASE WHEN y.outcome='NEEDS_RECONNECT' THEN clock_timestamp() ELSE ended_at END
    WHERE id=y.connection_id RETURNING * INTO c;
  PERFORM hon.shopify_system_evidence(c.organization_id,c.school_id,'commerce.shopify.synced',c.id,c.version,
    jsonb_build_object('syncId',y.id,'source',y.source,'outcome',y.outcome,'failureCode',y.failure_code,'products',y.products_seen,'variants',y.variants_seen,
      'orders',y.orders_seen,'removedProducts',removed_products,'removedVariants',removed_variants));
  RETURN jsonb_build_object('syncId',y.id,'source',y.source,'outcome',y.outcome,'failureCode',y.failure_code,'productsSeen',y.products_seen,
    'variantsSeen',y.variants_seen,'ordersSeen',y.orders_seen,'removedProducts',removed_products,'removedVariants',removed_variants,'connectionStatus',c.status);
END $$;

DO $$ DECLARE r text; t text; f text;
  worker text[]:=ARRAY['hon.record_shopify_webhook(jsonb)','hon.claim_shopify_background_sync()','hon.rotate_shopify_background_credential(jsonb)',
    'hon.record_shopify_background_page(jsonb)','hon.finish_shopify_background_sync(jsonb)'];
  runtime_entry text[]:=ARRAY['hon.read_shopify(text,uuid)','hon.read_shopify_catalog(text,uuid)','hon.read_shopify_orders(text,uuid)',
    'hon.start_shopify_connect(text,jsonb,text)','hon.claim_shopify_connect(text,jsonb)','hon.record_shopify_connection(text,jsonb)',
    'hon.begin_shopify_sync(text,jsonb)','hon.rotate_shopify_credential(text,jsonb)','hon.record_shopify_sync_page(text,jsonb)',
    'hon.finish_shopify_sync(text,jsonb)','hon.disconnect_shopify(text,jsonb)'];
BEGIN
  FOREACH t IN ARRAY ARRAY['shopify_sync_requests','shopify_webhook_receipts'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  -- Every Shopify function that is not a runtime entry point (helpers and the five worker functions) is closed to all.
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND p.proname LIKE '%shopify%' AND NOT (p.oid::regprocedure::text=ANY(runtime_entry)) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    FOREACH f IN ARRAY worker LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_communication_worker',f); END LOOP;
  END IF;
END $$;

COMMIT;
