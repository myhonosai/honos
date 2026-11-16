BEGIN;

-- HON Shopify Connected, piece SH1 (0405, coordinator-allocated 2026-11-16). Spec: docs/architecture/SHOPIFY_COMMERCE.md.
-- Owner vision (David, Oct 13-18 2026 recap, shared 2026-11-16): Shopify stays the commerce engine and the inventory
-- source of truth; HON connects through ONE HON Shopify app with OAuth (schools never create keys), never by iframe.
-- This piece connects one store per school, mirrors its catalog (products, variants, SKU, price, cost, stock) and the
-- last 60 days of orders read-only, and disconnects. HON never writes to Shopify here, stores no customer details, sends
-- nothing, charges nothing and spends nothing.
--
-- * commerce.shopify.read: see the Shopify page. commerce.shopify.manage: connect, sync, disconnect (and read). Both
--   staff-assignable, granted to system OWNER roles only. Identity rules are the 0403 POS ones (one active human
--   principal, active school and organization, active HON entitlement, live grant at that exact school). Authority is
--   decided again after the last write.
-- * A connect attempt is a single-use intent bound to the person, school and shop, holding only the SHA-256 of the
--   random OAuth state; 10 minutes; at most 10 per school per hour. One shop belongs to one school, ever.
-- * The API seals the Shopify tokens (AES-256-GCM, bound to the connection and shop). The database stores only sealed
--   text, never decrypts, and destroys it when the connection is disconnected or needs reconnecting. A CONNECTED
--   connection always has a live credential and any other status has none (checked at commit). Reads never return the
--   sealed text; only the sync prologue hands it to the API.
-- * Forced RLS with no policy and no client table privilege: the runtime executes fixed definer functions only.
-- * Audit and outbox carry ids, the shop domain and counts only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.saas_ts(timestamptz)') IS NULL OR to_regclass('hon.organization_entitlements') IS NULL OR to_regclass('hon.role_permissions') IS NULL THEN
    RAISE EXCEPTION '0405 requires the IAM, entitlement and saas timestamp foundations'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('commerce.shopify.read','See the school''s connected Shopify store: products, stock, costs, orders and the sales summary',false,true),
  ('commerce.shopify.manage','Connect, sync and disconnect the school''s Shopify store through the HON Shopify app',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE (code='commerce.shopify.read' AND NOT is_sensitive AND is_staff_assignable)
    OR (code='commerce.shopify.manage' AND is_sensitive AND is_staff_assignable))<>2 THEN
    RAISE EXCEPTION 'commerce.shopify permissions already exist with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,x.code FROM hon.roles r CROSS JOIN (VALUES ('commerce.shopify.read'),('commerce.shopify.manage')) x(code)
WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- One row per (school, shop), kept forever: a shop never moves to another school. Reconnecting reuses the row.
CREATE TABLE hon.shopify_connections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  shop_domain text NOT NULL UNIQUE CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$'),
  shop_name text CHECK (shop_name IS NULL OR (length(shop_name) BETWEEN 1 AND 120 AND shop_name !~ '[[:cntrl:]]')),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  scopes text NOT NULL CHECK (scopes ~ '^[a-z_]{1,40}(,[a-z_]{1,40}){0,19}$'),
  status text NOT NULL CHECK (status IN ('CONNECTED','NEEDS_RECONNECT','DISCONNECTED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  connected_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  connected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  last_sync_at timestamptz,
  last_sync_outcome text CHECK (last_sync_outcome IN ('SUCCEEDED','FAILED','NEEDS_RECONNECT')),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((status='CONNECTED')=(ended_at IS NULL))
);
-- One live (connected or waiting to reconnect) store per school.
CREATE UNIQUE INDEX shopify_connections_one_live ON hon.shopify_connections (school_id) WHERE status<>'DISCONNECTED';

CREATE TABLE hon.shopify_credentials (
  connection_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  key_id text NOT NULL CHECK (key_id ~ '^[a-z0-9-]{1,40}$'),
  sealed text CHECK (sealed IS NULL OR (length(sealed)<=8100 AND sealed ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$')),
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  stored_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rotated_at timestamptz,
  destroyed_at timestamptz,
  CHECK ((sealed IS NULL)=(destroyed_at IS NOT NULL)),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.shopify_connections(id,organization_id,school_id)
);

CREATE TABLE hon.shopify_connect_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  shop_domain text NOT NULL CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$'),
  started_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  connection_id uuid,
  finished_at timestamptz,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK (expires_at=created_at+interval '10 minutes'),
  CHECK ((claimed_at IS NULL)=(connection_id IS NULL)),
  CHECK (finished_at IS NULL OR claimed_at IS NOT NULL)
);
CREATE INDEX shopify_connect_intents_school_idx ON hon.shopify_connect_intents (school_id,created_at DESC);

CREATE TABLE hon.shopify_syncs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  started_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'RUNNING' CHECK (outcome IN ('RUNNING','SUCCEEDED','FAILED','NEEDS_RECONNECT','ABANDONED')),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z_]{1,40}$'),
  products_seen integer NOT NULL DEFAULT 0 CHECK (products_seen BETWEEN 0 AND 2000),
  variants_seen integer NOT NULL DEFAULT 0 CHECK (variants_seen BETWEEN 0 AND 200000),
  orders_seen integer NOT NULL DEFAULT 0 CHECK (orders_seen BETWEEN 0 AND 1000),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.shopify_connections(id,organization_id,school_id),
  CHECK ((outcome='RUNNING')=(finished_at IS NULL)),
  CHECK (failure_code IS NULL OR outcome IN ('FAILED','NEEDS_RECONNECT'))
);
CREATE INDEX shopify_syncs_connection_idx ON hon.shopify_syncs (connection_id,started_at DESC);
CREATE UNIQUE INDEX shopify_syncs_one_running ON hon.shopify_syncs (connection_id) WHERE outcome='RUNNING';

-- The read-only mirror. Shopify ids are the numeric part of the GraphQL gid.
CREATE TABLE hon.shopify_products (
  connection_id uuid NOT NULL, shopify_id bigint NOT NULL CHECK (shopify_id>0),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  status text NOT NULL CHECK (status IN ('ACTIVE','DRAFT','ARCHIVED','UNLISTED')),
  vendor text CHECK (vendor IS NULL OR length(vendor) BETWEEN 1 AND 255),
  product_type text CHECK (product_type IS NULL OR length(product_type) BETWEEN 1 AND 255),
  handle text CHECK (handle IS NULL OR length(handle) BETWEEN 1 AND 255),
  image_url text CHECK (image_url IS NULL OR (length(image_url)<=2048 AND image_url ~ '^https://[a-z0-9.-]+\.(shopify\.com|shopifycdn\.net)/')),
  removed boolean NOT NULL DEFAULT false,
  last_sync_id uuid NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (connection_id,shopify_id),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.shopify_connections(id,organization_id,school_id)
);
CREATE TABLE hon.shopify_variants (
  connection_id uuid NOT NULL, shopify_id bigint NOT NULL CHECK (shopify_id>0),
  product_shopify_id bigint NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  sku text CHECK (sku IS NULL OR length(sku) BETWEEN 1 AND 255),
  barcode text CHECK (barcode IS NULL OR length(barcode) BETWEEN 1 AND 255),
  price numeric(14,4) NOT NULL CHECK (price BETWEEN 0 AND 1000000000),
  compare_at_price numeric(14,4) CHECK (compare_at_price IS NULL OR compare_at_price BETWEEN 0 AND 1000000000),
  unit_cost numeric(14,4) CHECK (unit_cost IS NULL OR unit_cost BETWEEN 0 AND 1000000000),
  tracked boolean NOT NULL,
  inventory_quantity integer CHECK (inventory_quantity IS NULL OR inventory_quantity BETWEEN -10000000 AND 10000000),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 2048),
  removed boolean NOT NULL DEFAULT false,
  last_sync_id uuid NOT NULL,
  PRIMARY KEY (connection_id,shopify_id),
  FOREIGN KEY (connection_id,product_shopify_id) REFERENCES hon.shopify_products(connection_id,shopify_id)
);
CREATE INDEX shopify_variants_product_idx ON hon.shopify_variants (connection_id,product_shopify_id,position);
CREATE TABLE hon.shopify_orders (
  connection_id uuid NOT NULL, shopify_id bigint NOT NULL CHECK (shopify_id>0),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  placed_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  financial_status text CHECK (financial_status IS NULL OR financial_status ~ '^[A-Z_]{1,40}$'),
  fulfillment_status text CHECK (fulfillment_status IS NULL OR fulfillment_status ~ '^[A-Z_]{1,40}$'),
  source_name text CHECK (source_name IS NULL OR length(source_name) BETWEEN 1 AND 64),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal numeric(14,4) NOT NULL CHECK (subtotal BETWEEN 0 AND 1000000000),
  discounts numeric(14,4) NOT NULL CHECK (discounts BETWEEN 0 AND 1000000000),
  tax numeric(14,4) NOT NULL CHECK (tax BETWEEN 0 AND 1000000000),
  total numeric(14,4) NOT NULL CHECK (total BETWEEN 0 AND 1000000000),
  last_sync_id uuid NOT NULL,
  PRIMARY KEY (connection_id,shopify_id),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.shopify_connections(id,organization_id,school_id)
);
CREATE INDEX shopify_orders_placed_idx ON hon.shopify_orders (connection_id,placed_at DESC);
CREATE TABLE hon.shopify_order_lines (
  connection_id uuid NOT NULL, order_shopify_id bigint NOT NULL, line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 50),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  sku text CHECK (sku IS NULL OR length(sku) BETWEEN 1 AND 255),
  variant_shopify_id bigint CHECK (variant_shopify_id IS NULL OR variant_shopify_id>0),
  quantity integer NOT NULL CHECK (quantity BETWEEN 0 AND 100000),
  unit_price numeric(14,4) NOT NULL CHECK (unit_price BETWEEN 0 AND 1000000000),
  PRIMARY KEY (connection_id,order_shopify_id,line_no),
  FOREIGN KEY (connection_id,order_shopify_id) REFERENCES hon.shopify_orders(connection_id,shopify_id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shopify_connections','shopify_credentials','shopify_connect_intents','shopify_syncs','shopify_products',
    'shopify_variants','shopify_orders','shopify_order_lines'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;
COMMENT ON TABLE hon.shopify_credentials IS
'0405 one API-sealed (AES-256-GCM) Shopify token pair per connection. Never plaintext; destroyed when the connection ends or needs reconnecting. Private.';

-- Settings-free guards. Connections never change school, shop or first connector, and each update bumps the version.
-- Intents are claimed once and finished once. Syncs change only while RUNNING and keep their identity. A credential
-- keeps its scope, every change bumps its version by one, and a destroyed one may only come back with a new sealed
-- pair (reconnect). Nothing in those four tables is deleted; nothing in any Shopify table is truncated. The mirror
-- tables are written only by the definer functions below (no client privilege).
CREATE FUNCTION hon.guard_shopify() RETURNS trigger
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
    IF TG_OP='UPDATE' AND OLD.outcome='RUNNING' AND (NEW.id,NEW.connection_id,NEW.organization_id,NEW.school_id,NEW.started_by_principal_id,NEW.started_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.connection_id,OLD.organization_id,OLD.school_id,OLD.started_by_principal_id,OLD.started_at) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='shopify_credentials' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.version=1 AND NEW.sealed IS NOT NULL AND NEW.rotated_at IS NULL AND NEW.destroyed_at IS NULL THEN RETURN NEW; END IF;
    ELSIF TG_OP='UPDATE' AND NEW.version=OLD.version+1
      AND (NEW.connection_id,NEW.organization_id,NEW.school_id,NEW.stored_by_principal_id,NEW.stored_at)
        IS NOT DISTINCT FROM (OLD.connection_id,OLD.organization_id,OLD.school_id,OLD.stored_by_principal_id,OLD.stored_at)
      AND (OLD.destroyed_at IS NULL OR (NEW.sealed IS NOT NULL AND NEW.destroyed_at IS NULL)) THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN COALESCE(NEW,OLD);
  END IF;
  RAISE EXCEPTION 'SHOPIFY_RECORD_IMMUTABLE' USING ERRCODE='42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shopify_connections','shopify_connect_intents','shopify_syncs'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_shopify()',t||'_guard',t);
  END LOOP;
  EXECUTE 'CREATE TRIGGER shopify_credentials_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.shopify_credentials FOR EACH ROW EXECUTE FUNCTION hon.guard_shopify()';
  FOREACH t IN ARRAY ARRAY['shopify_connections','shopify_credentials','shopify_connect_intents','shopify_syncs','shopify_products',
    'shopify_variants','shopify_orders','shopify_order_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_shopify()',t||'_no_truncate',t);
  END LOOP;
END $$;

-- Leaving CONNECTED destroys the sealed credential in the same statement.
CREATE FUNCTION hon.shopify_destroy_credential_on_end() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NEW.status<>'CONNECTED' THEN
    UPDATE hon.shopify_credentials SET version=version+1,sealed=NULL,destroyed_at=clock_timestamp()
      WHERE connection_id=NEW.id AND destroyed_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER shopify_connection_credential_destroy AFTER INSERT OR UPDATE ON hon.shopify_connections
  FOR EACH ROW EXECUTE FUNCTION hon.shopify_destroy_credential_on_end();

-- At commit: a CONNECTED connection has a live credential; any other status has none.
CREATE FUNCTION hon.shopify_check_connection_credential() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.shopify_connections%ROWTYPE; live boolean;
BEGIN
  SELECT * INTO c FROM hon.shopify_connections WHERE id=NEW.id;
  live:=EXISTS(SELECT 1 FROM hon.shopify_credentials k WHERE k.connection_id=c.id AND k.destroyed_at IS NULL);
  IF (c.status='CONNECTED')<>live THEN RAISE EXCEPTION 'SHOPIFY_CREDENTIAL_STATE' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER shopify_connection_credential_check AFTER INSERT OR UPDATE ON hon.shopify_connections
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.shopify_check_connection_credential();

-- The acting principal when the subject holds live Shopify authority at this exact school, else NULL.
-- p_manage=false: read or manage. p_manage=true: manage.
CREATE FUNCTION hon.shopify_actor(p_subject text,p_school uuid,p_manage boolean) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT p.id FROM hon.users u
  JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
  JOIN hon.schools s ON s.id=p_school AND s.status='ACTIVE'
  JOIN hon.organizations o ON o.id=s.organization_id AND o.status='ACTIVE'
  WHERE u.external_subject=p_subject
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=s.organization_id AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g
      JOIN hon.role_permissions rp ON rp.role_id=g.role_id AND rp.organization_id=s.organization_id
      WHERE g.principal_id=p.id AND g.organization_id=s.organization_id AND g.school_id=s.id AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND rp.permission_code=ANY(CASE WHEN p_manage THEN ARRAY['commerce.shopify.manage'] ELSE ARRAY['commerce.shopify.read','commerce.shopify.manage'] END))
  LIMIT 1
$$;

-- Closed-input helpers.
CREATE FUNCTION hon.shopify_keys_ok(p jsonb,required text[],optional text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p)='object' AND p ?& required
    AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT (k=ANY(required) OR k=ANY(optional)))
$$;
-- Plain text from Shopify: bounded, no control characters (newlines and tabs included).
CREATE FUNCTION hon.shopify_text_ok(v jsonb,max_len integer,nullable boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN v IS NULL OR jsonb_typeof(v)='null' THEN nullable
    ELSE jsonb_typeof(v)='string' AND length(v#>>'{}') BETWEEN 1 AND max_len AND (v#>>'{}') !~ '[\x01-\x1f\x7f]' END
$$;
CREATE FUNCTION hon.shopify_id_ok(v jsonb,nullable boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN v IS NULL OR jsonb_typeof(v)='null' THEN nullable
    ELSE jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[1-9][0-9]{0,17}$' END
$$;
-- Money as Shopify sends it: a non-negative decimal string with at most 4 decimals, below one billion.
CREATE FUNCTION hon.shopify_money_ok(v jsonb,nullable boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN v IS NULL OR jsonb_typeof(v)='null' THEN nullable
    ELSE jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,4})?$' END
$$;
CREATE FUNCTION hon.shopify_int_ok(v jsonb,lo bigint,hi bigint,nullable boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN v IS NULL OR jsonb_typeof(v)='null' THEN nullable
    ELSE jsonb_typeof(v)='number' AND (v#>>'{}') ~ '^-?[0-9]{1,10}$' AND (v#>>'{}')::bigint BETWEEN lo AND hi END
$$;
CREATE FUNCTION hon.shopify_instant_ok(v jsonb,nullable boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN v IS NULL OR jsonb_typeof(v)='null' THEN nullable
    ELSE jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' END
$$;
CREATE FUNCTION hon.shopify_uuid_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT v IS NOT NULL AND jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
CREATE FUNCTION hon.shopify_shop_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT v IS NOT NULL AND jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$'
$$;
-- A sealed credential {keyId, sealed, accessExpiresAt, refreshExpiresAt} (UTC ms instants).
CREATE FUNCTION hon.shopify_credential_ok(k jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(hon.shopify_keys_ok(k,ARRAY['keyId','sealed','accessExpiresAt','refreshExpiresAt'],ARRAY[]::text[])
    AND jsonb_typeof(k->'keyId')='string' AND k->>'keyId' ~ '^[a-z0-9-]{1,40}$'
    AND jsonb_typeof(k->'sealed')='string' AND length(k->>'sealed')<=8100 AND k->>'sealed' ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
    AND hon.shopify_instant_ok(k->'accessExpiresAt',false) AND hon.shopify_instant_ok(k->'refreshExpiresAt',false)
    AND (k->>'refreshExpiresAt')::timestamptz>=(k->>'accessExpiresAt')::timestamptz,false)
$$;

CREATE FUNCTION hon.shopify_evidence(p_org uuid,p_school uuid,p_actor uuid,p_action text,p_entity_type text,p_entity uuid,p_version integer,p_state jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_request uuid:=gen_random_uuid();
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id,occurred_at)
    VALUES(p_org,p_school,p_actor,'HUMAN_UI',p_action,p_entity_type,p_entity,p_state,'SUCCEEDED',v_request,v_request,clock_timestamp());
  INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(gen_random_uuid(),p_org,p_school,p_action,1,p_entity_type,p_entity,p_version,v_request,v_request,p_state||jsonb_build_object('internalOnly',true));
END $$;

-- Authority is decided again after the last write.
CREATE FUNCTION hon.shopify_recheck(p_subject text,p_school uuid,p_actor uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF hon.shopify_actor(p_subject,p_school,true) IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'SHOPIFY_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

-- The prologue of every manage command: closed input with schoolId, live manage authority, the school lock.
CREATE FUNCTION hon.shopify_begin(p_subject text,p_input jsonb,p_required text[],OUT actor uuid,OUT org uuid,OUT school uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF p_subject IS NULL OR NOT hon.shopify_keys_ok(p_input,p_required||'schoolId'::text,ARRAY[]::text[]) OR NOT hon.shopify_uuid_ok(p_input->'schoolId') THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  school:=(p_input->>'schoolId')::uuid;
  actor:=hon.shopify_actor(p_subject,school,true);
  IF actor IS NULL THEN RAISE EXCEPTION 'SHOPIFY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT s.organization_id INTO org FROM hon.schools s WHERE s.id=school;
  PERFORM pg_advisory_xact_lock(hashtextextended('shopify-school:'||school::text,0));
END $$;

CREATE FUNCTION hon.shopify_connection_json(c hon.shopify_connections) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('connectionId',c.id,'shopDomain',c.shop_domain,'shopName',c.shop_name,
    'currency',c.currency,'status',c.status,'version',c.version,'connectedAt',hon.saas_ts(c.connected_at),'endedAt',hon.saas_ts(c.ended_at),
    'lastSyncAt',hon.saas_ts(c.last_sync_at),'lastSyncOutcome',c.last_sync_outcome,
    'syncRunning',EXISTS(SELECT 1 FROM hon.shopify_syncs y WHERE y.connection_id=c.id AND y.outcome='RUNNING' AND y.started_at>clock_timestamp()-interval '15 minutes')) END
$$;

-- The school's current store: the live one, else the most recently ended one (so its history stays visible).
CREATE FUNCTION hon.shopify_current(p_school uuid) RETURNS hon.shopify_connections
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT c FROM hon.shopify_connections c WHERE c.school_id=p_school
  ORDER BY (c.status<>'DISCONNECTED') DESC,c.updated_at DESC,c.id LIMIT 1
$$;

-- READ: connection, permission, mirror counts and the 30-day sales summary (cancelled orders excluded).
-- Estimated gross profit uses today's variant unit cost for lines whose variant has one; coveredSales is the part of
-- line sales those lines make up, so the screen can say how much of the profit figure is backed by a known cost.
CREATE FUNCTION hon.read_shopify(p_subject text,p_school uuid) RETURNS jsonb
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
      'lowStock',(SELECT count(*)::int FROM hon.shopify_variants v WHERE v.connection_id=c.id AND NOT v.removed AND v.tracked AND coalesce(v.inventory_quantity,0)<=3),
      'orders',(SELECT count(*)::int FROM hon.shopify_orders o WHERE o.connection_id=c.id)) END,
    'summary',summary);
END $$;

-- READ: the current store's products (not removed) with their variants and margin per variant. At most 2,000 products.
CREATE FUNCTION hon.read_shopify_catalog(p_subject text,p_school uuid) RETURNS jsonb
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
          'tracked',v.tracked,'inventoryQuantity',v.inventory_quantity,'lowStock',v.tracked AND coalesce(v.inventory_quantity,0)<=3)
        ORDER BY v.position,v.shopify_id),'[]'::jsonb) FROM hon.shopify_variants v WHERE v.connection_id=c.id AND v.product_shopify_id=p.shopify_id AND NOT v.removed))
      ORDER BY lower(p.title),p.shopify_id)
    FROM (SELECT * FROM hon.shopify_products x WHERE x.connection_id=c.id AND NOT x.removed ORDER BY lower(x.title),x.shopify_id LIMIT 2000) p),'[]'::jsonb));
END $$;

-- READ: the current store's orders, newest first, at most 200, with lines.
CREATE FUNCTION hon.read_shopify_orders(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.shopify_connections%ROWTYPE;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.shopify_actor(p_subject,p_school,false) IS NULL THEN RAISE EXCEPTION 'SHOPIFY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  c:=hon.shopify_current(p_school);
  RETURN jsonb_build_object('schoolId',p_school,'currency',c.currency,'orders',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'orderId',o.shopify_id::text,'name',o.name,'placedAt',hon.saas_ts(o.placed_at),'cancelledAt',hon.saas_ts(o.cancelled_at),
      'financialStatus',o.financial_status,'fulfillmentStatus',o.fulfillment_status,'sourceName',o.source_name,'currency',o.currency,
      'subtotal',o.subtotal,'discounts',o.discounts,'tax',o.tax,'total',o.total,
      'lines',(SELECT coalesce(jsonb_agg(jsonb_build_object('title',l.title,'sku',l.sku,'variantId',l.variant_shopify_id::text,
          'quantity',l.quantity,'unitPrice',l.unit_price) ORDER BY l.line_no),'[]'::jsonb)
        FROM hon.shopify_order_lines l WHERE l.connection_id=c.id AND l.order_shopify_id=o.shopify_id))
      ORDER BY o.placed_at DESC,o.shopify_id DESC)
    FROM (SELECT * FROM hon.shopify_orders x WHERE x.connection_id=c.id ORDER BY x.placed_at DESC,x.shopify_id DESC LIMIT 200) o),'[]'::jsonb));
END $$;

-- START {schoolId, shopDomain}: a single-use intent holding only the hash of the random state the API made. The shop
-- must not belong to another school, and the school must not have a different live store.
CREATE FUNCTION hon.start_shopify_connect(p_subject text,p_input jsonb,p_state_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; i hon.shopify_connect_intents%ROWTYPE; at timestamptz:=clock_timestamp(); shop text;
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['shopDomain']);
  IF NOT hon.shopify_shop_ok(p_input->'shopDomain') THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  shop:=p_input->>'shopDomain';
  IF EXISTS(SELECT 1 FROM hon.shopify_connections WHERE shop_domain=shop AND school_id<>b.school) THEN
    RAISE EXCEPTION 'SHOPIFY_SHOP_TAKEN' USING ERRCODE='23505'; END IF;
  IF EXISTS(SELECT 1 FROM hon.shopify_connections WHERE school_id=b.school AND status<>'DISCONNECTED' AND shop_domain<>shop) THEN
    RAISE EXCEPTION 'SHOPIFY_OTHER_STORE_CONNECTED' USING ERRCODE='23505'; END IF;
  IF (SELECT count(*) FROM hon.shopify_connect_intents WHERE school_id=b.school AND created_at>at-interval '1 hour')>=10 THEN
    RAISE EXCEPTION 'SHOPIFY_RATE_LIMITED' USING ERRCODE='54000'; END IF;
  INSERT INTO hon.shopify_connect_intents(organization_id,school_id,shop_domain,started_by_principal_id,state_hash,created_at,expires_at)
    VALUES(b.org,b.school,shop,b.actor,p_state_hash,at,at+interval '10 minutes') RETURNING * INTO i;
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.connect.started','SHOPIFY_CONNECT',i.id,1,jsonb_build_object('shopDomain',shop));
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('intentId',i.id,'shopDomain',shop,'expiresAt',hon.saas_ts(i.expires_at));
END $$;

-- CLAIM {schoolId, shopDomain, stateHash}: Shopify sent the browser back (the API already checked Shopify's signature).
-- Same person, same school, same shop, unused and unexpired; claimed now. Returns the connection id the API binds the
-- sealed credential to: this school's row for the shop, or a new id.
CREATE FUNCTION hon.claim_shopify_connect(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; i hon.shopify_connect_intents%ROWTYPE; conn uuid;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['shopDomain','stateHash']);
  IF NOT hon.shopify_shop_ok(p_input->'shopDomain') OR jsonb_typeof(p_input->'stateHash') IS DISTINCT FROM 'string'
    OR p_input->>'stateHash' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'SHOPIFY_CONNECT_STATE_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO i FROM hon.shopify_connect_intents WHERE state_hash=p_input->>'stateHash' FOR UPDATE;
  -- An unknown state, one from another person, school or shop, and a used one all read the same.
  IF i.id IS NULL OR i.school_id<>b.school OR i.started_by_principal_id<>b.actor OR i.shop_domain<>p_input->>'shopDomain' OR i.claimed_at IS NOT NULL THEN
    RAISE EXCEPTION 'SHOPIFY_CONNECT_STATE_INVALID' USING ERRCODE='22023'; END IF;
  IF i.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'SHOPIFY_CONNECT_STATE_EXPIRED' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('shopify-shop:'||i.shop_domain,0));
  IF EXISTS(SELECT 1 FROM hon.shopify_connections WHERE shop_domain=i.shop_domain AND school_id<>b.school) THEN
    RAISE EXCEPTION 'SHOPIFY_SHOP_TAKEN' USING ERRCODE='23505'; END IF;
  SELECT id INTO conn FROM hon.shopify_connections WHERE shop_domain=i.shop_domain AND school_id=b.school;
  UPDATE hon.shopify_connect_intents SET claimed_at=clock_timestamp(),connection_id=coalesce(conn,gen_random_uuid()) WHERE id=i.id RETURNING * INTO i;
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('intentId',i.id,'connectionId',i.connection_id,'shopDomain',i.shop_domain);
END $$;

-- RECORD {schoolId, intentId, shopName, currency, scopes, credential}: the API exchanged Shopify's one-time code for
-- the school's token pair and sealed it. Once per claimed intent, within 10 minutes of the claim. The connection
-- becomes CONNECTED with its credential in the same transaction.
CREATE FUNCTION hon.record_shopify_connection(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; i hon.shopify_connect_intents%ROWTYPE; c hon.shopify_connections%ROWTYPE; k jsonb; reconnected boolean:=false;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['intentId','shopName','currency','scopes','credential']);
  k:=p_input->'credential';
  IF NOT hon.shopify_uuid_ok(p_input->'intentId') OR NOT hon.shopify_text_ok(p_input->'shopName',120,false)
    OR jsonb_typeof(p_input->'currency') IS DISTINCT FROM 'string' OR p_input->>'currency' !~ '^[A-Z]{3}$'
    OR jsonb_typeof(p_input->'scopes') IS DISTINCT FROM 'string' OR p_input->>'scopes' !~ '^[a-z_]{1,40}(,[a-z_]{1,40}){0,19}$'
    OR NOT hon.shopify_credential_ok(k) OR (k->>'accessExpiresAt')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO i FROM hon.shopify_connect_intents WHERE id=(p_input->>'intentId')::uuid AND school_id=b.school FOR UPDATE;
  IF i.id IS NULL OR i.started_by_principal_id<>b.actor OR i.claimed_at IS NULL OR i.finished_at IS NOT NULL
    OR i.claimed_at<clock_timestamp()-interval '10 minutes' THEN RAISE EXCEPTION 'SHOPIFY_CONNECT_STATE_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('shopify-shop:'||i.shop_domain,0));
  IF EXISTS(SELECT 1 FROM hon.shopify_connections WHERE shop_domain=i.shop_domain AND school_id<>b.school) THEN
    RAISE EXCEPTION 'SHOPIFY_SHOP_TAKEN' USING ERRCODE='23505'; END IF;
  IF EXISTS(SELECT 1 FROM hon.shopify_connections WHERE school_id=b.school AND status<>'DISCONNECTED' AND shop_domain<>i.shop_domain) THEN
    RAISE EXCEPTION 'SHOPIFY_OTHER_STORE_CONNECTED' USING ERRCODE='23505'; END IF;
  SELECT * INTO c FROM hon.shopify_connections WHERE id=i.connection_id FOR UPDATE;
  IF c.id IS NULL THEN
    INSERT INTO hon.shopify_connections(id,organization_id,school_id,shop_domain,shop_name,currency,scopes,status,connected_by_principal_id)
      VALUES(i.connection_id,b.org,b.school,i.shop_domain,p_input->>'shopName',p_input->>'currency',p_input->>'scopes','CONNECTED',b.actor) RETURNING * INTO c;
    INSERT INTO hon.shopify_credentials(connection_id,organization_id,school_id,key_id,sealed,access_expires_at,refresh_expires_at,stored_by_principal_id)
      VALUES(c.id,b.org,b.school,k->>'keyId',k->>'sealed',(k->>'accessExpiresAt')::timestamptz,(k->>'refreshExpiresAt')::timestamptz,b.actor);
  ELSE
    IF c.school_id<>b.school OR c.shop_domain<>i.shop_domain THEN RAISE EXCEPTION 'SHOPIFY_CONNECT_STATE_INVALID' USING ERRCODE='22023'; END IF;
    reconnected:=true;
    UPDATE hon.shopify_connections SET status='CONNECTED',shop_name=p_input->>'shopName',currency=p_input->>'currency',scopes=p_input->>'scopes',
      version=version+1,updated_at=clock_timestamp(),ended_at=NULL,connected_at=CASE WHEN c.status='DISCONNECTED' THEN clock_timestamp() ELSE connected_at END
      WHERE id=c.id RETURNING * INTO c;
    -- The connection's one credential row takes the new pair as its next version (a destroyed one comes back to life).
    UPDATE hon.shopify_credentials SET version=version+1,key_id=k->>'keyId',sealed=k->>'sealed',access_expires_at=(k->>'accessExpiresAt')::timestamptz,
      refresh_expires_at=(k->>'refreshExpiresAt')::timestamptz,rotated_at=clock_timestamp(),destroyed_at=NULL WHERE connection_id=c.id;
    IF NOT FOUND THEN
      INSERT INTO hon.shopify_credentials(connection_id,organization_id,school_id,key_id,sealed,access_expires_at,refresh_expires_at,stored_by_principal_id)
        VALUES(c.id,b.org,b.school,k->>'keyId',k->>'sealed',(k->>'accessExpiresAt')::timestamptz,(k->>'refreshExpiresAt')::timestamptz,b.actor);
    END IF;
  END IF;
  UPDATE hon.shopify_connect_intents SET finished_at=clock_timestamp() WHERE id=i.id;
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.connected','SHOPIFY_CONNECTION',c.id,c.version,
    jsonb_build_object('shopDomain',c.shop_domain,'intentId',i.id,'reconnected',reconnected));
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('connection',hon.shopify_connection_json(c));
END $$;

-- SYNC BEGIN {schoolId}: one running sync per connection (one older than 15 minutes is marked ABANDONED). Returns the
-- sealed credential to the API, the only place it is ever opened.
CREATE FUNCTION hon.begin_shopify_sync(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; c hon.shopify_connections%ROWTYPE; y hon.shopify_syncs%ROWTYPE; k hon.shopify_credentials%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY[]::text[]);
  SELECT * INTO c FROM hon.shopify_connections WHERE school_id=b.school AND status='CONNECTED' FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'SHOPIFY_NOT_CONNECTED' USING ERRCODE='P0002'; END IF;
  UPDATE hon.shopify_syncs SET outcome='ABANDONED',finished_at=clock_timestamp()
    WHERE connection_id=c.id AND outcome='RUNNING' AND started_at<=clock_timestamp()-interval '15 minutes';
  IF EXISTS(SELECT 1 FROM hon.shopify_syncs WHERE connection_id=c.id AND outcome='RUNNING') THEN
    RAISE EXCEPTION 'SHOPIFY_SYNC_RUNNING' USING ERRCODE='55P03'; END IF;
  INSERT INTO hon.shopify_syncs(connection_id,organization_id,school_id,started_by_principal_id) VALUES(c.id,b.org,b.school,b.actor) RETURNING * INTO y;
  SELECT * INTO k FROM hon.shopify_credentials WHERE connection_id=c.id AND destroyed_at IS NULL;
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('syncId',y.id,'connectionId',c.id,'shopDomain',c.shop_domain,
    'credential',jsonb_build_object('keyId',k.key_id,'sealed',k.sealed,'version',k.version,
      'accessExpiresAt',hon.saas_ts(k.access_expires_at),'refreshExpiresAt',hon.saas_ts(k.refresh_expires_at)));
END $$;

-- The running sync this person started at this school, on a connection that is still CONNECTED.
CREATE FUNCTION hon.shopify_running_sync(p_school uuid,p_actor uuid,p_sync jsonb) RETURNS hon.shopify_syncs
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE y hon.shopify_syncs%ROWTYPE;
BEGIN
  IF NOT hon.shopify_uuid_ok(p_sync) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO y FROM hon.shopify_syncs WHERE id=(p_sync#>>'{}')::uuid AND school_id=p_school FOR UPDATE;
  IF y.id IS NULL OR y.started_by_principal_id<>p_actor OR y.outcome<>'RUNNING'
    OR NOT EXISTS(SELECT 1 FROM hon.shopify_connections c WHERE c.id=y.connection_id AND c.status='CONNECTED') THEN
    RAISE EXCEPTION 'SHOPIFY_SYNC_NOT_RUNNING' USING ERRCODE='22023'; END IF;
  RETURN y;
END $$;

-- ROTATE {schoolId, syncId, expectedVersion, credential}: the API refreshed the token pair during this sync.
CREATE FUNCTION hon.rotate_shopify_credential(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; y hon.shopify_syncs%ROWTYPE; k jsonb; v integer;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['syncId','expectedVersion','credential']);
  k:=p_input->'credential';
  IF NOT hon.shopify_int_ok(p_input->'expectedVersion',1,1000000000,false) OR NOT hon.shopify_credential_ok(k)
    OR (k->>'accessExpiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  y:=hon.shopify_running_sync(b.school,b.actor,p_input->'syncId');
  UPDATE hon.shopify_credentials SET version=version+1,key_id=k->>'keyId',sealed=k->>'sealed',access_expires_at=(k->>'accessExpiresAt')::timestamptz,
    refresh_expires_at=(k->>'refreshExpiresAt')::timestamptz,rotated_at=clock_timestamp()
    WHERE connection_id=y.connection_id AND destroyed_at IS NULL AND version=(p_input->>'expectedVersion')::integer RETURNING version INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'SHOPIFY_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('version',v);
END $$;

-- PAGE {schoolId, syncId, kind: PRODUCTS, products: [...]} or {schoolId, syncId, kind: ORDERS, orders: [...]}: up to
-- 50 records, upserted into this store's mirror and stamped with the sync. The whole page is validated before anything
-- is written. A record already seen in this run is refused. Run totals are capped (2,000 products, 1,000 orders).
CREATE FUNCTION hon.record_shopify_sync_page(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; y hon.shopify_syncs%ROWTYPE; kind text; items jsonb; e jsonb; v jsonb; l jsonb; pos integer; n integer; nv integer:=0;
  ids bigint[]:='{}'; vids bigint[]:='{}';
BEGIN
  kind:=CASE WHEN jsonb_typeof(p_input)='object' AND jsonb_typeof(p_input->'kind')='string' THEN p_input->>'kind' END;
  IF kind IS NULL OR kind NOT IN ('PRODUCTS','ORDERS') THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['syncId','kind',CASE WHEN kind='ORDERS' THEN 'orders' ELSE 'products' END]);
  items:=CASE WHEN kind='ORDERS' THEN p_input->'orders' ELSE p_input->'products' END;
  IF jsonb_typeof(items) IS DISTINCT FROM 'array' OR jsonb_array_length(items)>50 THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  y:=hon.shopify_running_sync(b.school,b.actor,p_input->'syncId');
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
        VALUES(y.connection_id,(e->>'id')::bigint,b.org,b.school,e->>'title',e->>'status',e->>'vendor',e->>'productType',e->>'handle',e->>'imageUrl',false,y.id,clock_timestamp())
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
        VALUES(y.connection_id,(e->>'id')::bigint,b.org,b.school,e->>'name',(e->>'placedAt')::timestamptz,(e->>'cancelledAt')::timestamptz,
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
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('syncId',y.id,'productsSeen',y.products_seen,'variantsSeen',y.variants_seen,'ordersSeen',y.orders_seen);
END $$;

-- FINISH {schoolId, syncId, outcome, failureCode}: SUCCEEDED marks products and variants this run did not see as
-- removed (orders are kept); FAILED keeps the mirror as it was; NEEDS_RECONNECT also moves the connection to
-- NEEDS_RECONNECT, which destroys the credential.
CREATE FUNCTION hon.finish_shopify_sync(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; y hon.shopify_syncs%ROWTYPE; c hon.shopify_connections%ROWTYPE; v_outcome text; removed_products integer:=0; removed_variants integer:=0;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['syncId','outcome','failureCode']);
  v_outcome:=p_input->>'outcome';
  IF jsonb_typeof(p_input->'outcome') IS DISTINCT FROM 'string' OR v_outcome NOT IN ('SUCCEEDED','FAILED','NEEDS_RECONNECT')
    OR (v_outcome='SUCCEEDED' AND jsonb_typeof(p_input->'failureCode') IS DISTINCT FROM 'null')
    OR (v_outcome<>'SUCCEEDED' AND (jsonb_typeof(p_input->'failureCode') IS DISTINCT FROM 'string' OR p_input->>'failureCode' !~ '^[A-Z_]{1,40}$')) THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  y:=hon.shopify_running_sync(b.school,b.actor,p_input->'syncId');
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
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.synced','SHOPIFY_CONNECTION',c.id,c.version,
    jsonb_build_object('syncId',y.id,'outcome',y.outcome,'failureCode',y.failure_code,'products',y.products_seen,'variants',y.variants_seen,
      'orders',y.orders_seen,'removedProducts',removed_products,'removedVariants',removed_variants));
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('syncId',y.id,'outcome',y.outcome,'failureCode',y.failure_code,'productsSeen',y.products_seen,'variantsSeen',y.variants_seen,
    'ordersSeen',y.orders_seen,'removedProducts',removed_products,'removedVariants',removed_variants,'connection',hon.shopify_connection_json(c));
END $$;

-- DISCONNECT {schoolId, connectionId, expectedVersion}: the store stops syncing and its credential is destroyed. The
-- mirror is kept as history; reconnecting the same store continues it. A running sync ends as FAILED.
CREATE FUNCTION hon.disconnect_shopify(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; c hon.shopify_connections%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['connectionId','expectedVersion']);
  IF NOT hon.shopify_uuid_ok(p_input->'connectionId') OR NOT hon.shopify_int_ok(p_input->'expectedVersion',1,1000000000,false) THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM hon.shopify_connections WHERE id=(p_input->>'connectionId')::uuid AND school_id=b.school FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'SHOPIFY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF c.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SHOPIFY_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF c.status='DISCONNECTED' THEN RAISE EXCEPTION 'SHOPIFY_NOT_CONNECTED' USING ERRCODE='P0002'; END IF;
  UPDATE hon.shopify_syncs SET outcome='FAILED',failure_code='DISCONNECTED',finished_at=clock_timestamp() WHERE connection_id=c.id AND outcome='RUNNING';
  UPDATE hon.shopify_connections SET status='DISCONNECTED',version=version+1,updated_at=clock_timestamp(),ended_at=coalesce(ended_at,clock_timestamp())
    WHERE id=c.id RETURNING * INTO c;
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.disconnected','SHOPIFY_CONNECTION',c.id,c.version,jsonb_build_object('shopDomain',c.shop_domain));
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('connection',hon.shopify_connection_json(c));
END $$;

DO $$ DECLARE r text; t text; f text;
  entry text[]:=ARRAY['hon.read_shopify(text,uuid)','hon.read_shopify_catalog(text,uuid)','hon.read_shopify_orders(text,uuid)',
    'hon.start_shopify_connect(text,jsonb,text)','hon.claim_shopify_connect(text,jsonb)','hon.record_shopify_connection(text,jsonb)',
    'hon.begin_shopify_sync(text,jsonb)','hon.rotate_shopify_credential(text,jsonb)','hon.record_shopify_sync_page(text,jsonb)',
    'hon.finish_shopify_sync(text,jsonb)','hon.disconnect_shopify(text,jsonb)'];
BEGIN
  FOREACH t IN ARRAY ARRAY['shopify_connections','shopify_credentials','shopify_connect_intents','shopify_syncs','shopify_products',
    'shopify_variants','shopify_orders','shopify_order_lines'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname LIKE 'shopify\_%' OR p.proname='guard_shopify' OR p.oid::regprocedure::text=ANY(entry)) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
