BEGIN;

-- HON Shopify product editing with owner approval, piece SH4a (0496, coordinator-allocated 2026-11-18). Spec:
-- docs/architecture/SHOPIFY_COMMERCE.md. Builds on 0405 (SH1) and 0449 (SH1b).
-- Owner vision (David, 2026-11-18): Shopify stays the source of truth; HON prepares product changes and nothing reaches
-- Shopify until a person with commerce.shopify.manage approves that exact change.
-- * A change is either a new DRAFT product (title, description, type, vendor, one price, compare-at price, unit cost,
--   SKU) or an update of one mirrored product (title, type, vendor, status ACTIVE/DRAFT/ARCHIVED, and per variant the
--   price, compare-at price and unit cost). An update keeps the mirror's values of every field it touches as its base.
--   At most one open change per product; at most 20 open new drafts and 200 proposals a day per school.
-- * Approving leases the change to the approving person for three minutes and hands the sealed credential to the API,
--   which checks the product in Shopify against the base, writes it, reads it back and records the result. A result
--   is accepted only from that lease. An APPLIED result must carry the product as Shopify now has it and it must show
--   the proposed values. A lease that ends without a result reads as UNKNOWN; approving it again checks Shopify (the
--   new draft is found by the handle HON gave it) instead of writing a second time. At most five attempts.
-- * Editing needs the store to have granted write_products (and write_inventory for unit costs). HON asks for those
--   only when the owner presses Allow editing; connecting stays read-only.
-- * Every proposal is source HUMAN_UI. AI-prepared changes come later and will need a different person to approve.
-- * Forced RLS with no policy and no client table privilege; the runtime executes fixed definer functions only.
-- * Audit and outbox carry ids, the change kind, the field names and the outcome only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.shopify_connections') IS NULL OR to_regprocedure('hon.shopify_apply_page(hon.shopify_syncs,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '0496 requires 0405 and 0449 (Shopify connection and background sync)'; END IF;
END $$;

CREATE TABLE hon.shopify_product_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CREATE_DRAFT','UPDATE')),
  product_shopify_id bigint CHECK (product_shopify_id IS NULL OR product_shopify_id>0),
  handle text CHECK (handle IS NULL OR (length(handle) BETWEEN 1 AND 80 AND handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$')),
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes)='object' AND pg_column_size(changes)<=65536),
  base jsonb NOT NULL CHECK (jsonb_typeof(base)='object' AND pg_column_size(base)<=65536),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPLYING','APPLIED','FAILED','UNKNOWN','CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source text NOT NULL DEFAULT 'HUMAN_UI' CHECK (source IN ('HUMAN_UI')),
  proposed_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by_principal_id uuid REFERENCES hon.principals(id),
  approved_at timestamptz,
  leased_by_principal_id uuid REFERENCES hon.principals(id),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  cancelled_by_principal_id uuid REFERENCES hon.principals(id),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z_]{1,40}$'),
  finished_at timestamptz,
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.shopify_connections(id,organization_id,school_id),
  CHECK (kind='CREATE_DRAFT' OR product_shopify_id IS NOT NULL),
  CHECK ((kind='CREATE_DRAFT')=(handle IS NOT NULL)),
  CHECK (status<>'APPLIED' OR product_shopify_id IS NOT NULL),
  CHECK ((status IN ('PENDING','CANCELLED'))=(lease_token IS NULL)),
  CHECK ((lease_token IS NULL)=(leased_by_principal_id IS NULL) AND (lease_token IS NULL)=(lease_expires_at IS NULL)),
  CHECK ((lease_token IS NULL)=(approved_at IS NULL) AND (approved_at IS NULL)=(approved_by_principal_id IS NULL)),
  CHECK ((status='CANCELLED')=(cancelled_by_principal_id IS NOT NULL)),
  CHECK ((status IN ('APPLIED','FAILED','CANCELLED'))=(finished_at IS NOT NULL)),
  CHECK (failure_code IS NULL OR status IN ('FAILED','UNKNOWN')),
  CHECK (status NOT IN ('FAILED','UNKNOWN') OR failure_code IS NOT NULL)
);
-- One open change per mirrored product.
CREATE UNIQUE INDEX shopify_product_changes_one_open ON hon.shopify_product_changes (connection_id,product_shopify_id)
  WHERE kind='UPDATE' AND status IN ('PENDING','APPLYING','UNKNOWN');
CREATE UNIQUE INDEX shopify_product_changes_handle ON hon.shopify_product_changes (connection_id,handle) WHERE handle IS NOT NULL;
CREATE INDEX shopify_product_changes_school_idx ON hon.shopify_product_changes (school_id,proposed_at DESC);
ALTER TABLE hon.shopify_product_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.shopify_product_changes FORCE ROW LEVEL SECURITY;
COMMENT ON TABLE hon.shopify_product_changes IS
'0496 product changes HON prepares for a school''s Shopify store; each reaches Shopify only after a person with commerce.shopify.manage approves it. Private.';

-- A change keeps what was proposed, by whom and against which base. Every update bumps the version by one and moves
-- along PENDING -> APPLYING | CANCELLED, APPLYING -> APPLIED | FAILED | UNKNOWN, UNKNOWN -> APPLYING | APPLIED | FAILED.
-- A new draft learns its Shopify id once. Nothing is deleted or truncated.
CREATE FUNCTION hon.guard_shopify_product_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.version=OLD.version+1
    AND (NEW.id,NEW.connection_id,NEW.organization_id,NEW.school_id,NEW.kind,NEW.handle,NEW.changes,NEW.base,NEW.source,NEW.proposed_by_principal_id,NEW.proposed_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.connection_id,OLD.organization_id,OLD.school_id,OLD.kind,OLD.handle,OLD.changes,OLD.base,OLD.source,OLD.proposed_by_principal_id,OLD.proposed_at)
    AND (NEW.product_shopify_id IS NOT DISTINCT FROM OLD.product_shopify_id OR (OLD.kind='CREATE_DRAFT' AND OLD.product_shopify_id IS NULL))
    AND NEW.attempts>=OLD.attempts
    AND (NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at OR OLD.approved_at IS NULL)
    AND ((OLD.status='PENDING' AND NEW.status IN ('APPLYING','CANCELLED'))
      OR (OLD.status='APPLYING' AND NEW.status IN ('APPLIED','FAILED','UNKNOWN'))
      OR (OLD.status='UNKNOWN' AND NEW.status IN ('APPLYING','APPLIED','FAILED'))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SHOPIFY_RECORD_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER shopify_product_changes_guard BEFORE UPDATE OR DELETE ON hon.shopify_product_changes FOR EACH ROW EXECUTE FUNCTION hon.guard_shopify_product_change();
CREATE TRIGGER shopify_product_changes_no_truncate BEFORE TRUNCATE ON hon.shopify_product_changes FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_shopify();

-- Text a person typed: bounded, trimmed, no control characters. A description may also hold line breaks.
CREATE FUNCTION hon.shopify_edit_text_ok(v jsonb,max_len integer,nullable boolean,multiline boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN v IS NULL OR jsonb_typeof(v)='null' THEN nullable
    ELSE jsonb_typeof(v)='string' AND length(v#>>'{}') BETWEEN 1 AND max_len AND (v#>>'{}')=btrim(v#>>'{}',E' \n')
      AND (v#>>'{}') ~ '[^[:space:]]'
      AND (v#>>'{}') !~ CASE WHEN multiline THEN '[\x01-\x09\x0b-\x1f\x7f]' ELSE '[\x01-\x1f\x7f]' END END
$$;

-- The store granted this scope (a write_x grant includes read_x).
CREATE FUNCTION hon.shopify_has_scope(p_scopes text,p_scope text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT p_scope=ANY(string_to_array(coalesce(p_scopes,''),','))
    OR (p_scope LIKE 'read\_%' AND 'write_'||substr(p_scope,6)=ANY(string_to_array(coalesce(p_scopes,''),',')))
$$;

-- The change touches a unit cost (which needs write_inventory).
CREATE FUNCTION hon.shopify_change_touches_cost(p_kind text,p_changes jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN p_kind='CREATE_DRAFT' THEN jsonb_typeof(p_changes->'unitCost')='string'
    ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_changes->'variants')='array' THEN p_changes->'variants' ELSE '[]'::jsonb END) v
      WHERE v ? 'unitCost') END
$$;

-- One product exactly as a sync page carries it (the 0449 page rules for one record).
CREATE FUNCTION hon.shopify_product_item_ok(e jsonb) RETURNS boolean
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
    IF NOT coalesce(hon.shopify_keys_ok(v,ARRAY['id','title','sku','barcode','price','compareAtPrice','unitCost','tracked','inventoryQuantity'],ARRAY[]::text[]),false)
      OR NOT hon.shopify_id_ok(v->'id',false) OR NOT hon.shopify_text_ok(v->'title',255,false)
      OR NOT hon.shopify_text_ok(v->'sku',255,true) OR NOT hon.shopify_text_ok(v->'barcode',255,true)
      OR NOT hon.shopify_money_ok(v->'price',false) OR NOT hon.shopify_money_ok(v->'compareAtPrice',true) OR NOT hon.shopify_money_ok(v->'unitCost',true)
      OR jsonb_typeof(v->'tracked') IS DISTINCT FROM 'boolean' OR NOT hon.shopify_int_ok(v->'inventoryQuantity',-10000000,10000000,true)
      OR (v->>'id')::bigint=ANY(vids) THEN RETURN false; END IF;
    vids:=vids||(v->>'id')::bigint;
  END LOOP;
  RETURN true;
END $$;

-- Writes one product (as Shopify now has it) into the mirror. Rows already mirrored keep the sync that last saw them,
-- so a sync running at the same moment never marks them removed; a new product is stamped with that running sync when
-- there is one. Variants the record does not list are left as they are (the next sync settles them).
CREATE FUNCTION hon.shopify_mirror_product(p_connection uuid,e jsonb,p_stamp uuid) RETURNS void
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
    INSERT INTO hon.shopify_variants AS x (connection_id,shopify_id,product_shopify_id,title,sku,barcode,price,compare_at_price,unit_cost,tracked,inventory_quantity,position,removed,last_sync_id)
      VALUES(c.id,(v->>'id')::bigint,(e->>'id')::bigint,v->>'title',v->>'sku',v->>'barcode',(v->>'price')::numeric,(v->>'compareAtPrice')::numeric,
        (v->>'unitCost')::numeric,(v->>'tracked')::boolean,(v->>'inventoryQuantity')::integer,pos,false,stamp)
      ON CONFLICT (connection_id,shopify_id) DO UPDATE SET product_shopify_id=excluded.product_shopify_id,title=excluded.title,sku=excluded.sku,
        barcode=excluded.barcode,price=excluded.price,compare_at_price=excluded.compare_at_price,unit_cost=excluded.unit_cost,tracked=excluded.tracked,
        inventory_quantity=excluded.inventory_quantity,position=excluded.position,removed=false;
  END LOOP;
END $$;

-- The mirror's current values of every field an update touches, in the change's own shape.
CREATE FUNCTION hon.shopify_change_base(p_connection uuid,p_product bigint,p_changes jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
      'title',CASE WHEN p_changes ? 'title' THEN to_jsonb(p.title) END,
      'status',CASE WHEN p_changes ? 'status' THEN to_jsonb(p.status) END))
    || CASE WHEN p_changes ? 'productType' THEN jsonb_build_object('productType',p.product_type) ELSE '{}'::jsonb END
    || CASE WHEN p_changes ? 'vendor' THEN jsonb_build_object('vendor',p.vendor) ELSE '{}'::jsonb END
    || CASE WHEN p_changes ? 'variants' THEN jsonb_build_object('variants',(SELECT coalesce(jsonb_agg(
        jsonb_build_object('variantId',(w->>'variantId'))
        || CASE WHEN w ? 'price' THEN jsonb_build_object('price',x.price::text) ELSE '{}'::jsonb END
        || CASE WHEN w ? 'compareAtPrice' THEN jsonb_build_object('compareAtPrice',x.compare_at_price::text) ELSE '{}'::jsonb END
        || CASE WHEN w ? 'unitCost' THEN jsonb_build_object('unitCost',x.unit_cost::text) ELSE '{}'::jsonb END ORDER BY o),'[]'::jsonb)
      FROM jsonb_array_elements(p_changes->'variants') WITH ORDINALITY q(w,o)
      LEFT JOIN hon.shopify_variants x ON x.connection_id=p_connection AND x.product_shopify_id=p_product AND x.shopify_id=(w->>'variantId')::bigint AND NOT x.removed))
      ELSE '{}'::jsonb END
  FROM hon.shopify_products p WHERE p.connection_id=p_connection AND p.shopify_id=p_product AND NOT p.removed
$$;

-- Money strings compared as numbers (both may be null).
CREATE FUNCTION hon.shopify_same_money(a jsonb,b jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN (a IS NULL OR jsonb_typeof(a)='null') OR (b IS NULL OR jsonb_typeof(b)='null')
    THEN (a IS NULL OR jsonb_typeof(a)='null') AND (b IS NULL OR jsonb_typeof(b)='null')
    ELSE (a#>>'{}')::numeric=(b#>>'{}')::numeric END
$$;

-- A product record shows every value the change proposed.
CREATE FUNCTION hon.shopify_change_matches(x hon.shopify_product_changes,e jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE w jsonb; v jsonb;
BEGIN
  IF NOT hon.shopify_product_item_ok(e) THEN RETURN false; END IF;
  IF x.kind='CREATE_DRAFT' THEN
    v:=e->'variants'->0;
    RETURN e->>'handle' IS NOT DISTINCT FROM x.handle AND e->>'title'=x.changes->>'title' AND e->>'status'='DRAFT'
      AND hon.shopify_same_money(v->'price',x.changes->'price') AND hon.shopify_same_money(v->'compareAtPrice',x.changes->'compareAtPrice')
      AND (NOT hon.shopify_change_touches_cost(x.kind,x.changes) OR hon.shopify_same_money(v->'unitCost',x.changes->'unitCost'))
      AND (x.changes->'sku' IS NULL OR jsonb_typeof(x.changes->'sku')='null' OR v->>'sku'=x.changes->>'sku');
  END IF;
  IF (e->>'id')::bigint<>x.product_shopify_id
    OR (x.changes ? 'title' AND e->>'title' IS DISTINCT FROM x.changes->>'title')
    OR (x.changes ? 'status' AND e->>'status' IS DISTINCT FROM x.changes->>'status')
    OR (x.changes ? 'productType' AND e->>'productType' IS DISTINCT FROM x.changes->>'productType')
    OR (x.changes ? 'vendor' AND e->>'vendor' IS DISTINCT FROM x.changes->>'vendor') THEN RETURN false; END IF;
  FOR w IN SELECT * FROM jsonb_array_elements(CASE WHEN x.changes ? 'variants' THEN x.changes->'variants' ELSE '[]'::jsonb END) LOOP
    SELECT y INTO v FROM jsonb_array_elements(e->'variants') y WHERE y->>'id'=w->>'variantId';
    IF v IS NULL OR (w ? 'price' AND NOT hon.shopify_same_money(v->'price',w->'price'))
      OR (w ? 'compareAtPrice' AND NOT hon.shopify_same_money(v->'compareAtPrice',w->'compareAtPrice'))
      OR (w ? 'unitCost' AND NOT hon.shopify_same_money(v->'unitCost',w->'unitCost')) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

-- What the screens and the API see of a change. A lease that ran out without a result reads as UNKNOWN.
CREATE FUNCTION hon.shopify_change_json(x hon.shopify_product_changes) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('changeId',x.id,'kind',x.kind,'productId',x.product_shopify_id::text,'handle',x.handle,
    'status',CASE WHEN x.status='APPLYING' AND x.lease_expires_at<=clock_timestamp() THEN 'UNKNOWN' ELSE x.status END,
    'version',x.version,'changes',x.changes,'base',x.base,'attempts',x.attempts,'failureCode',
    CASE WHEN x.status='APPLYING' AND x.lease_expires_at<=clock_timestamp() THEN 'LEASE_EXPIRED' ELSE x.failure_code END,
    'proposedAt',hon.saas_ts(x.proposed_at),'approvedAt',hon.saas_ts(x.approved_at),'finishedAt',hon.saas_ts(x.finished_at),
    'proposedByMe',false)
$$;

-- The change rows a person's command acts on: this school's, locked.
CREATE FUNCTION hon.shopify_locked_change(p_school uuid,p_change jsonb) RETURNS hon.shopify_product_changes
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.shopify_product_changes%ROWTYPE;
BEGIN
  IF NOT hon.shopify_uuid_ok(p_change) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO x FROM hon.shopify_product_changes WHERE id=(p_change#>>'{}')::uuid AND school_id=p_school FOR UPDATE;
  IF x.id IS NULL THEN RAISE EXCEPTION 'SHOPIFY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- A lease that ended without a result is settled as UNKNOWN before anything else looks at it.
  IF x.status='APPLYING' AND x.lease_expires_at<=clock_timestamp() THEN
    UPDATE hon.shopify_product_changes SET status='UNKNOWN',failure_code='LEASE_EXPIRED',version=version+1 WHERE id=x.id RETURNING * INTO x;
  END IF;
  RETURN x;
END $$;

-- READ: the editing permissions of the current store and its latest 100 changes (open ones first).
CREATE FUNCTION hon.read_shopify_product_changes(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.shopify_connections%ROWTYPE; actor uuid; manage boolean;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.shopify_actor(p_subject,p_school,false);
  IF actor IS NULL THEN RAISE EXCEPTION 'SHOPIFY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  manage:=hon.shopify_actor(p_subject,p_school,true) IS NOT NULL;
  c:=hon.shopify_current(p_school);
  RETURN jsonb_build_object('schoolId',p_school,'canManage',manage,
    'editProducts',c.status='CONNECTED' AND hon.shopify_has_scope(c.scopes,'write_products'),
    'editCosts',c.status='CONNECTED' AND hon.shopify_has_scope(c.scopes,'write_inventory'),
    'changes',coalesce((SELECT jsonb_agg(hon.shopify_change_json(x)||jsonb_build_object('proposedByMe',x.proposed_by_principal_id=actor)
        ORDER BY (x.status IN ('PENDING','APPLYING','UNKNOWN')) DESC,x.proposed_at DESC,x.id)
      FROM (SELECT * FROM hon.shopify_product_changes y WHERE y.connection_id=c.id
        ORDER BY (y.status IN ('PENDING','APPLYING','UNKNOWN')) DESC,y.proposed_at DESC,y.id LIMIT 100) x),'[]'::jsonb));
END $$;

-- PROPOSE {schoolId, kind, productId, changes}: saved as PENDING; nothing reaches Shopify.
--   CREATE_DRAFT, productId null, changes {title, description, productType, vendor, price, compareAtPrice, unitCost, sku}
--     (every key present; all but title and price may be null).
--   UPDATE, productId of a mirrored product, changes with at least one of {title, productType, vendor, status,
--     variants: [{variantId, price?, compareAtPrice?, unitCost?}]}; every value given must differ from the mirror.
CREATE FUNCTION hon.propose_shopify_product_change(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; c hon.shopify_connections%ROWTYPE; x hon.shopify_product_changes%ROWTYPE; v_kind text; ch jsonb; w jsonb; v_product bigint;
  p hon.shopify_products%ROWTYPE; v hon.shopify_variants%ROWTYPE; vids bigint[]:='{}'; v_id uuid:=gen_random_uuid(); slug text; v_base jsonb:='{}'::jsonb;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['kind','productId','changes']);
  v_kind:=CASE WHEN jsonb_typeof(p_input->'kind')='string' THEN p_input->>'kind' END;
  ch:=p_input->'changes';
  IF v_kind IS NULL OR v_kind NOT IN ('CREATE_DRAFT','UPDATE') OR jsonb_typeof(ch) IS DISTINCT FROM 'object' OR pg_column_size(ch)>65536 THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM hon.shopify_connections WHERE school_id=b.school AND status='CONNECTED' FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'SHOPIFY_NOT_CONNECTED' USING ERRCODE='P0002'; END IF;
  IF (SELECT count(*) FROM hon.shopify_product_changes WHERE school_id=b.school AND proposed_at>clock_timestamp()-interval '1 day')>=200 THEN
    RAISE EXCEPTION 'SHOPIFY_RATE_LIMITED' USING ERRCODE='54000'; END IF;
  IF v_kind='CREATE_DRAFT' THEN
    IF jsonb_typeof(p_input->'productId') IS DISTINCT FROM 'null'
      OR NOT hon.shopify_keys_ok(ch,ARRAY['title','description','productType','vendor','price','compareAtPrice','unitCost','sku'],ARRAY[]::text[])
      OR NOT hon.shopify_edit_text_ok(ch->'title',255,false,false) OR NOT hon.shopify_edit_text_ok(ch->'description',5000,true,true)
      OR NOT hon.shopify_edit_text_ok(ch->'productType',255,true,false) OR NOT hon.shopify_edit_text_ok(ch->'vendor',255,true,false)
      OR NOT hon.shopify_money_ok(ch->'price',false) OR NOT hon.shopify_money_ok(ch->'compareAtPrice',true) OR NOT hon.shopify_money_ok(ch->'unitCost',true)
      OR NOT hon.shopify_edit_text_ok(ch->'sku',255,true,false) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
    IF (SELECT count(*) FROM hon.shopify_product_changes WHERE school_id=b.school AND kind='CREATE_DRAFT' AND status IN ('PENDING','APPLYING','UNKNOWN'))>=20 THEN
      RAISE EXCEPTION 'SHOPIFY_TOO_MANY_DRAFTS' USING ERRCODE='54000'; END IF;
    -- The handle HON gives the new product: the title's letters and digits, then the change id, so it is unique and
    -- an unknown result can be found again in Shopify.
    slug:=left(btrim(regexp_replace(lower(ch->>'title'),'[^a-z0-9]+','-','g'),'-'),60);
    slug:=CASE WHEN slug='' THEN 'product' ELSE btrim(slug,'-') END||'-'||left(replace(v_id::text,'-',''),10);
  ELSE
    IF NOT hon.shopify_id_ok(p_input->'productId',false)
      OR NOT hon.shopify_keys_ok(ch,ARRAY[]::text[],ARRAY['title','productType','vendor','status','variants'])
      OR NOT EXISTS(SELECT 1 FROM jsonb_object_keys(ch))
      OR (ch ? 'title' AND NOT hon.shopify_edit_text_ok(ch->'title',255,false,false))
      OR (ch ? 'productType' AND NOT hon.shopify_edit_text_ok(ch->'productType',255,true,false))
      OR (ch ? 'vendor' AND NOT hon.shopify_edit_text_ok(ch->'vendor',255,true,false))
      OR (ch ? 'status' AND (jsonb_typeof(ch->'status') IS DISTINCT FROM 'string' OR ch->>'status' NOT IN ('ACTIVE','DRAFT','ARCHIVED')))
      OR (ch ? 'variants' AND (jsonb_typeof(ch->'variants') IS DISTINCT FROM 'array' OR jsonb_array_length(ch->'variants') NOT BETWEEN 1 AND 100)) THEN
      RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
    v_product:=(p_input->>'productId')::bigint;
    SELECT * INTO p FROM hon.shopify_products WHERE connection_id=c.id AND shopify_id=v_product AND NOT removed;
    IF p.shopify_id IS NULL THEN RAISE EXCEPTION 'SHOPIFY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF (ch ? 'title' AND ch->>'title'=p.title) OR (ch ? 'status' AND ch->>'status'=p.status)
      OR (ch ? 'productType' AND ch->>'productType' IS NOT DISTINCT FROM p.product_type) OR (ch ? 'vendor' AND ch->>'vendor' IS NOT DISTINCT FROM p.vendor) THEN
      RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
    FOR w IN SELECT * FROM jsonb_array_elements(CASE WHEN ch ? 'variants' THEN ch->'variants' ELSE '[]'::jsonb END) LOOP
      IF NOT hon.shopify_keys_ok(w,ARRAY['variantId'],ARRAY['price','compareAtPrice','unitCost']) OR NOT hon.shopify_id_ok(w->'variantId',false)
        OR (SELECT count(*) FROM jsonb_object_keys(w))<2 OR (w->>'variantId')::bigint=ANY(vids)
        OR (w ? 'price' AND NOT hon.shopify_money_ok(w->'price',false))
        OR (w ? 'compareAtPrice' AND NOT hon.shopify_money_ok(w->'compareAtPrice',true))
        OR (w ? 'unitCost' AND NOT hon.shopify_money_ok(w->'unitCost',true)) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
      vids:=vids||(w->>'variantId')::bigint;
      SELECT * INTO v FROM hon.shopify_variants WHERE connection_id=c.id AND product_shopify_id=v_product AND shopify_id=(w->>'variantId')::bigint AND NOT removed;
      IF v.shopify_id IS NULL THEN RAISE EXCEPTION 'SHOPIFY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
      IF (w ? 'price' AND hon.shopify_same_money(w->'price',to_jsonb(v.price::text)))
        OR (w ? 'compareAtPrice' AND hon.shopify_same_money(w->'compareAtPrice',to_jsonb(v.compare_at_price::text)))
        OR (w ? 'unitCost' AND hon.shopify_same_money(w->'unitCost',to_jsonb(v.unit_cost::text))) THEN
        RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM hon.shopify_product_changes WHERE connection_id=c.id AND product_shopify_id=v_product AND kind='UPDATE' AND status IN ('PENDING','APPLYING','UNKNOWN')) THEN
      RAISE EXCEPTION 'SHOPIFY_CHANGE_OPEN' USING ERRCODE='23505'; END IF;
    v_base:=hon.shopify_change_base(c.id,v_product,ch);
  END IF;
  INSERT INTO hon.shopify_product_changes(id,connection_id,organization_id,school_id,kind,product_shopify_id,handle,changes,base,proposed_by_principal_id)
    VALUES(v_id,c.id,b.org,b.school,v_kind,v_product,slug,ch,v_base,b.actor) RETURNING * INTO x;
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.product_change.proposed','SHOPIFY_PRODUCT_CHANGE',x.id,x.version,
    jsonb_build_object('kind',x.kind,'productId',x.product_shopify_id::text,'fields',(SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(ch) k)));
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('change',hon.shopify_change_json(x)||jsonb_build_object('proposedByMe',true));
END $$;

-- CANCEL {schoolId, changeId, expectedVersion}: a PENDING change is dropped. Nothing reaches Shopify.
CREATE FUNCTION hon.cancel_shopify_product_change(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; x hon.shopify_product_changes%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['changeId','expectedVersion']);
  IF NOT hon.shopify_int_ok(p_input->'expectedVersion',1,1000000000,false) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  x:=hon.shopify_locked_change(b.school,p_input->'changeId');
  IF x.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SHOPIFY_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF x.status<>'PENDING' THEN RAISE EXCEPTION 'SHOPIFY_CHANGE_NOT_PENDING' USING ERRCODE='55000'; END IF;
  UPDATE hon.shopify_product_changes SET status='CANCELLED',cancelled_by_principal_id=b.actor,finished_at=clock_timestamp(),version=version+1
    WHERE id=x.id RETURNING * INTO x;
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.product_change.cancelled','SHOPIFY_PRODUCT_CHANGE',x.id,x.version,
    jsonb_build_object('kind',x.kind,'productId',x.product_shopify_id::text));
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('change',hon.shopify_change_json(x));
END $$;

-- APPROVE {schoolId, changeId, expectedVersion}: the person approves this exact change. A PENDING change is leased to
-- them to APPLY; an UNKNOWN one to CHECK (the API looks in Shopify and does not write again). The store must still be
-- the change's store, CONNECTED, with the needed scopes, and an update's base must still match the mirror. Returns the
-- lease and the sealed credential to the API, the only place it is opened.
CREATE FUNCTION hon.approve_shopify_product_change(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; c hon.shopify_connections%ROWTYPE; x hon.shopify_product_changes%ROWTYPE; k hon.shopify_credentials%ROWTYPE; mode text;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['changeId','expectedVersion']);
  IF NOT hon.shopify_int_ok(p_input->'expectedVersion',1,1000000000,false) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  x:=hon.shopify_locked_change(b.school,p_input->'changeId');
  -- A change that just settled as UNKNOWN moved one version on; the person saw it as UNKNOWN already.
  IF x.version<>(p_input->>'expectedVersion')::integer AND NOT (x.status='UNKNOWN' AND x.failure_code='LEASE_EXPIRED'
      AND x.version=(p_input->>'expectedVersion')::integer+1) THEN
    RAISE EXCEPTION 'SHOPIFY_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF x.status NOT IN ('PENDING','UNKNOWN') THEN RAISE EXCEPTION 'SHOPIFY_CHANGE_NOT_PENDING' USING ERRCODE='55000'; END IF;
  IF x.attempts>=5 THEN RAISE EXCEPTION 'SHOPIFY_CHANGE_ATTEMPTS' USING ERRCODE='54000'; END IF;
  SELECT * INTO c FROM hon.shopify_connections WHERE id=x.connection_id FOR UPDATE;
  IF c.status<>'CONNECTED' THEN RAISE EXCEPTION 'SHOPIFY_NOT_CONNECTED' USING ERRCODE='P0002'; END IF;
  IF NOT hon.shopify_has_scope(c.scopes,'write_products')
    OR (hon.shopify_change_touches_cost(x.kind,x.changes) AND NOT hon.shopify_has_scope(c.scopes,'write_inventory')) THEN
    RAISE EXCEPTION 'SHOPIFY_EDIT_NOT_ALLOWED' USING ERRCODE='55000'; END IF;
  mode:=CASE WHEN x.status='PENDING' THEN 'APPLY' ELSE 'CHECK' END;
  IF mode='APPLY' AND x.kind='UPDATE' AND hon.shopify_change_base(c.id,x.product_shopify_id,x.changes) IS DISTINCT FROM x.base THEN
    RAISE EXCEPTION 'SHOPIFY_CHANGE_STALE' USING ERRCODE='40001'; END IF;
  UPDATE hon.shopify_product_changes SET status='APPLYING',failure_code=NULL,attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+interval '3 minutes',leased_by_principal_id=b.actor,
    approved_by_principal_id=coalesce(approved_by_principal_id,b.actor),approved_at=coalesce(approved_at,clock_timestamp()),version=version+1
    WHERE id=x.id RETURNING * INTO x;
  SELECT * INTO k FROM hon.shopify_credentials WHERE connection_id=c.id AND destroyed_at IS NULL;
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.product_change.approved','SHOPIFY_PRODUCT_CHANGE',x.id,x.version,
    jsonb_build_object('kind',x.kind,'productId',x.product_shopify_id::text,'mode',mode,'attempt',x.attempts));
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('change',hon.shopify_change_json(x),'mode',mode,'leaseToken',x.lease_token,'connectionId',c.id,'shopDomain',c.shop_domain,
    'credential',jsonb_build_object('keyId',k.key_id,'sealed',k.sealed,'version',k.version,
      'accessExpiresAt',hon.saas_ts(k.access_expires_at),'refreshExpiresAt',hon.saas_ts(k.refresh_expires_at)));
END $$;

-- The leased change this person holds, under that lease token.
CREATE FUNCTION hon.shopify_leased_change(p_school uuid,p_actor uuid,p_input jsonb,p_live boolean) RETURNS hon.shopify_product_changes
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.shopify_product_changes%ROWTYPE;
BEGIN
  IF NOT hon.shopify_uuid_ok(p_input->'changeId') OR NOT hon.shopify_uuid_ok(p_input->'leaseToken') THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO x FROM hon.shopify_product_changes WHERE id=(p_input->>'changeId')::uuid AND school_id=p_school FOR UPDATE;
  IF x.id IS NULL OR x.lease_token IS DISTINCT FROM (p_input->>'leaseToken')::uuid OR x.leased_by_principal_id<>p_actor
    OR x.status NOT IN ('APPLYING','UNKNOWN') OR (p_live AND (x.status<>'APPLYING' OR x.lease_expires_at<=clock_timestamp())) THEN
    RAISE EXCEPTION 'SHOPIFY_CHANGE_NOT_LEASED' USING ERRCODE='55000'; END IF;
  RETURN x;
END $$;

-- ROTATE {schoolId, changeId, leaseToken, expectedVersion, credential}: the API refreshed the token pair under this lease.
CREATE FUNCTION hon.rotate_shopify_change_credential(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; x hon.shopify_product_changes%ROWTYPE; k jsonb; v integer;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['changeId','leaseToken','expectedVersion','credential']);
  k:=p_input->'credential';
  IF NOT hon.shopify_int_ok(p_input->'expectedVersion',1,1000000000,false) OR NOT hon.shopify_credential_ok(k)
    OR (k->>'accessExpiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  x:=hon.shopify_leased_change(b.school,b.actor,p_input,true);
  IF NOT EXISTS(SELECT 1 FROM hon.shopify_connections WHERE id=x.connection_id AND status='CONNECTED') THEN
    RAISE EXCEPTION 'SHOPIFY_NOT_CONNECTED' USING ERRCODE='P0002'; END IF;
  UPDATE hon.shopify_credentials SET version=version+1,key_id=k->>'keyId',sealed=k->>'sealed',access_expires_at=(k->>'accessExpiresAt')::timestamptz,
    refresh_expires_at=(k->>'refreshExpiresAt')::timestamptz,rotated_at=clock_timestamp()
    WHERE connection_id=x.connection_id AND destroyed_at IS NULL AND version=(p_input->>'expectedVersion')::integer RETURNING version INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'SHOPIFY_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('version',v);
END $$;

-- RESULT {schoolId, changeId, leaseToken, outcome, failureCode, product}: what the API saw in Shopify under the lease.
--   APPLIED: failureCode null; product is the record as Shopify now has it and must show every proposed value (a new
--     draft also carries its handle). The mirror takes it.
--   FAILED: failureCode set; product, when given, is the record as Shopify has it (for example, changed there since
--     the proposal) and refreshes the mirror.
--   UNKNOWN: failureCode set, no product: HON cannot tell whether Shopify took the change; approving again checks.
CREATE FUNCTION hon.record_shopify_product_change_result(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; x hon.shopify_product_changes%ROWTYPE; v_outcome text; e jsonb;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['changeId','leaseToken','outcome','failureCode','product']);
  v_outcome:=CASE WHEN jsonb_typeof(p_input->'outcome')='string' THEN p_input->>'outcome' END;
  e:=CASE WHEN jsonb_typeof(p_input->'product')='null' THEN NULL ELSE p_input->'product' END;
  IF v_outcome IS NULL OR v_outcome NOT IN ('APPLIED','FAILED','UNKNOWN')
    OR (v_outcome='APPLIED' AND (jsonb_typeof(p_input->'failureCode') IS DISTINCT FROM 'null' OR e IS NULL))
    OR (v_outcome<>'APPLIED' AND (jsonb_typeof(p_input->'failureCode') IS DISTINCT FROM 'string' OR p_input->>'failureCode' !~ '^[A-Z_]{1,40}$'))
    OR (v_outcome='UNKNOWN' AND e IS NOT NULL)
    OR (e IS NOT NULL AND NOT hon.shopify_product_item_ok(e)) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  x:=hon.shopify_leased_change(b.school,b.actor,p_input,false);
  -- Still unknown after the lease already ran out: nothing new to record.
  IF x.status='UNKNOWN' AND v_outcome='UNKNOWN' THEN
    PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
    RETURN jsonb_build_object('change',hon.shopify_change_json(x));
  END IF;
  IF e IS NOT NULL AND ((x.kind='UPDATE' AND (e->>'id')::bigint<>x.product_shopify_id)
      OR (x.kind='CREATE_DRAFT' AND e->>'handle' IS DISTINCT FROM x.handle)
      OR (v_outcome='APPLIED' AND NOT hon.shopify_change_matches(x,e))) THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  IF e IS NOT NULL THEN PERFORM hon.shopify_mirror_product(x.connection_id,e,x.id); END IF;
  UPDATE hon.shopify_product_changes SET status=v_outcome,failure_code=p_input->>'failureCode',
    product_shopify_id=CASE WHEN x.kind='CREATE_DRAFT' AND e IS NOT NULL THEN (e->>'id')::bigint ELSE product_shopify_id END,
    finished_at=CASE WHEN v_outcome='UNKNOWN' THEN NULL ELSE clock_timestamp() END,
    lease_expires_at=least(lease_expires_at,clock_timestamp()),version=version+1
    WHERE id=x.id RETURNING * INTO x;
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.product_change.'||lower(v_outcome),'SHOPIFY_PRODUCT_CHANGE',x.id,x.version,
    jsonb_build_object('kind',x.kind,'productId',x.product_shopify_id::text,'failureCode',x.failure_code,'attempt',x.attempts));
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('change',hon.shopify_change_json(x));
END $$;

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_shopify_product_changes(text,uuid)','hon.propose_shopify_product_change(text,jsonb)',
    'hon.cancel_shopify_product_change(text,jsonb)','hon.approve_shopify_product_change(text,jsonb)',
    'hon.rotate_shopify_change_credential(text,jsonb)','hon.record_shopify_product_change_result(text,jsonb)'];
BEGIN
  REVOKE ALL ON TABLE hon.shopify_product_changes FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.shopify_product_changes FROM %I',r); END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname IN ('guard_shopify_product_change','shopify_edit_text_ok','shopify_has_scope','shopify_change_touches_cost',
      'shopify_product_item_ok','shopify_mirror_product','shopify_change_base','shopify_same_money','shopify_change_matches','shopify_change_json',
      'shopify_locked_change','shopify_leased_change') OR p.oid::regprocedure::text=ANY(entry)) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
