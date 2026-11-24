BEGIN;

-- HON storefront blocks, Theme Builder slice TB2 (0609, coordinator-allocated 2026-11-20). Spec: docs/architecture/SHOPIFY_COMMERCE.md
-- (TB2). Commerce step 4, reworked after Shopify denied the write_themes exemption (2026-11-20).
-- * Retires TB1 (0600, merged but never deployed): HON no longer copies or rewrites theme files. Its tables, triggers, helpers
--   and runtime entry points are dropped here; 0600 itself is left as it was.
-- * The school's storefront look now comes from HON's theme app extension (app embed "School colors", app blocks "Size guide"
--   and "Pickup note"), which the owner adds in Shopify's theme editor and saves there. The extension reads one app-data
--   metafield on HON's own app installation (namespace hon_storefront, key settings). Writing it needs no protected scope.
-- * HON keeps the settings here (one row per CONNECTED store). Publishing pushes the saved settings to that metafield under a
--   three-minute lease: begin hands the sealed credential and the settings to the API, which sets the metafield and records
--   PUBLISHED, FAILED (nothing was written) or UNKNOWN (the write may have been saved; publishing again settles it, because
--   setting the metafield is idempotent). A lease that ends without a result settles UNKNOWN.
-- * Rows go when the store stops being CONNECTED. Forced RLS with no policy and no client table privilege; the runtime
--   executes five fixed definer functions only. Audit and outbox carry ids, versions and the outcome, never the text.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.shopify_edit_text_ok(jsonb,integer,boolean,boolean)') IS NULL OR to_regprocedure('hon.shopify_begin(text,jsonb,text[])') IS NULL
    OR to_regclass('hon.shopify_theme_drafts') IS NULL THEN
    RAISE EXCEPTION '0609 requires 0405, 0496 and 0600 (Shopify connection, product changes and TB1 theme drafts)'; END IF;
END $$;

-- TB1 retired: its entry points, helpers, trigger and tables.
DROP FUNCTION hon.read_shopify_theme_workspace(text,uuid);
DROP FUNCTION hon.begin_shopify_theme_work(text,jsonb);
DROP FUNCTION hon.rotate_shopify_theme_credential(text,jsonb);
DROP FUNCTION hon.finish_shopify_theme_work(text,jsonb);
DROP FUNCTION hon.shopify_theme_leased(uuid,uuid,jsonb);
DROP FUNCTION hon.shopify_theme_locked(uuid);
DROP FUNCTION hon.shopify_theme_edit_json(hon.shopify_theme_edits,boolean);
DROP FUNCTION hon.shopify_theme_name_ok(jsonb);
DROP FUNCTION hon.shopify_theme_files_ok(jsonb);
DROP FUNCTION hon.shopify_theme_recipe_ok(text,jsonb);
DROP TRIGGER shopify_connection_theme_end ON hon.shopify_connections;
DROP FUNCTION hon.shopify_theme_on_end();
DROP TABLE hon.shopify_theme_edits;
DROP TABLE hon.shopify_theme_drafts;
DROP FUNCTION hon.guard_shopify_theme_edit();

CREATE TABLE hon.shopify_storefronts (
  connection_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  settings jsonb NOT NULL CHECK (pg_column_size(settings)<=8192),
  settings_version integer NOT NULL DEFAULT 1 CHECK (settings_version>=1),
  saved_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The settings version last confirmed in Shopify, and the state of the latest publish.
  published_version integer CHECK (published_version IS NULL OR published_version BETWEEN 1 AND settings_version),
  published_at timestamptz,
  publish_status text NOT NULL DEFAULT 'NEVER' CHECK (publish_status IN ('NEVER','PUBLISHING','PUBLISHED','FAILED','UNKNOWN')),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z_]{1,40}$'),
  publishing_version integer CHECK (publishing_version IS NULL OR publishing_version BETWEEN 1 AND settings_version),
  lease_token uuid, leased_by_principal_id uuid REFERENCES hon.principals(id), lease_expires_at timestamptz,
  publish_day date, publishes_that_day integer NOT NULL DEFAULT 0 CHECK (publishes_that_day BETWEEN 0 AND 100),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.shopify_connections(id,organization_id,school_id) ON DELETE CASCADE,
  CHECK ((lease_token IS NULL)=(leased_by_principal_id IS NULL) AND (lease_token IS NULL)=(lease_expires_at IS NULL)
    AND (lease_token IS NULL)=(publishing_version IS NULL)),
  CHECK ((publish_status='PUBLISHING')=(lease_token IS NOT NULL)),
  CHECK ((published_version IS NULL)=(published_at IS NULL)),
  CHECK ((failure_code IS NOT NULL)=(publish_status IN ('FAILED','UNKNOWN')))
);
CREATE UNIQUE INDEX shopify_storefronts_school ON hon.shopify_storefronts (school_id);
ALTER TABLE hon.shopify_storefronts ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.shopify_storefronts FORCE ROW LEVEL SECURITY;
CREATE TRIGGER shopify_storefronts_no_truncate BEFORE TRUNCATE ON hon.shopify_storefronts FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_shopify();

-- A store that stops being CONNECTED loses its storefront settings.
CREATE FUNCTION hon.shopify_storefront_on_end() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NEW.status<>'CONNECTED' THEN DELETE FROM hon.shopify_storefronts WHERE connection_id=NEW.id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shopify_connection_storefront_end AFTER UPDATE OF status ON hon.shopify_connections FOR EACH ROW
  WHEN (NEW.status<>'CONNECTED') EXECUTE FUNCTION hon.shopify_storefront_on_end();

-- The settings exactly as the API sends them (the API validates them too). Colors are upper-case #RRGGBB.
CREATE FUNCTION hon.shopify_storefront_settings_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(v)='object'
    AND hon.shopify_keys_ok(v,ARRAY['primaryColor','accentColor','sizeGuideTitle','sizeGuideText','pickupNote'],ARRAY[]::text[])
    AND jsonb_typeof(v->'primaryColor')='string' AND v->>'primaryColor' ~ '^#[0-9A-F]{6}$'
    AND (jsonb_typeof(v->'accentColor')='null' OR (jsonb_typeof(v->'accentColor')='string' AND v->>'accentColor' ~ '^#[0-9A-F]{6}$'))
    AND hon.shopify_edit_text_ok(v->'sizeGuideTitle',60,true,false)
    AND hon.shopify_edit_text_ok(v->'sizeGuideText',2000,true,true)
    AND hon.shopify_edit_text_ok(v->'pickupNote',500,true,true)
    AND (jsonb_typeof(v->'sizeGuideTitle')='null' OR jsonb_typeof(v->'sizeGuideText')='string')
$$;

-- The store's row, locked; a lease that ran out is cleared and its publish settles as UNKNOWN.
CREATE FUNCTION hon.shopify_storefront_locked(p_connection uuid) RETURNS hon.shopify_storefronts
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE d hon.shopify_storefronts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM hon.shopify_storefronts WHERE connection_id=p_connection FOR UPDATE;
  IF d.connection_id IS NOT NULL AND d.lease_token IS NOT NULL AND d.lease_expires_at<=clock_timestamp() THEN
    UPDATE hon.shopify_storefronts SET publish_status='UNKNOWN',failure_code='LEASE_EXPIRED',lease_token=NULL,leased_by_principal_id=NULL,
      lease_expires_at=NULL,publishing_version=NULL,version=version+1,updated_at=clock_timestamp() WHERE connection_id=d.connection_id RETURNING * INTO d;
  END IF;
  RETURN d;
END $$;

-- READ: the saved settings and the publish state (a lease that ran out reads as UNKNOWN).
CREATE FUNCTION hon.read_shopify_storefront(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.shopify_connections%ROWTYPE; d hon.shopify_storefronts%ROWTYPE; v_live boolean;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.shopify_actor(p_subject,p_school,true) IS NULL THEN RAISE EXCEPTION 'SHOPIFY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  c:=hon.shopify_current(p_school);
  IF c.id IS NOT NULL AND c.status='CONNECTED' THEN SELECT * INTO d FROM hon.shopify_storefronts WHERE connection_id=c.id; END IF;
  v_live:=d.lease_token IS NOT NULL AND d.lease_expires_at>clock_timestamp();
  RETURN jsonb_build_object('schoolId',p_school,'connected',coalesce(c.status='CONNECTED',false),
    'shopDomain',CASE WHEN c.status='CONNECTED' THEN c.shop_domain END,
    'settings',d.settings,'settingsVersion',d.settings_version,'savedAt',hon.saas_ts(d.saved_at),
    'publishedVersion',d.published_version,'publishedAt',hon.saas_ts(d.published_at),
    'publishStatus',CASE WHEN d.connection_id IS NULL THEN 'NEVER' WHEN d.lease_token IS NOT NULL AND NOT v_live THEN 'UNKNOWN' ELSE d.publish_status END,
    'failureCode',CASE WHEN d.lease_token IS NOT NULL AND NOT v_live THEN 'LEASE_EXPIRED' ELSE d.failure_code END,
    'busy',coalesce(v_live,false));
END $$;

-- SAVE {schoolId, expectedVersion, settings}: replace the settings (expectedVersion null for the first save). Nothing reaches
-- Shopify until a publish.
CREATE FUNCTION hon.save_shopify_storefront(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; c hon.shopify_connections%ROWTYPE; d hon.shopify_storefronts%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['expectedVersion','settings']);
  IF NOT hon.shopify_int_ok(p_input->'expectedVersion',1,1000000000,true) OR NOT hon.shopify_storefront_settings_ok(p_input->'settings') THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  c:=hon.shopify_current(b.school);
  IF c.id IS NULL OR c.status<>'CONNECTED' THEN RAISE EXCEPTION 'SHOPIFY_NOT_CONNECTED' USING ERRCODE='P0002'; END IF;
  d:=hon.shopify_storefront_locked(c.id);
  IF d.connection_id IS NULL THEN
    IF jsonb_typeof(p_input->'expectedVersion')<>'null' THEN RAISE EXCEPTION 'SHOPIFY_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.shopify_storefronts(connection_id,organization_id,school_id,settings,saved_by_principal_id)
      VALUES(c.id,c.organization_id,c.school_id,p_input->'settings',b.actor) RETURNING * INTO d;
  ELSE
    IF jsonb_typeof(p_input->'expectedVersion')='null' OR (p_input->>'expectedVersion')::integer<>d.settings_version THEN
      RAISE EXCEPTION 'SHOPIFY_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    UPDATE hon.shopify_storefronts SET settings=p_input->'settings',settings_version=settings_version+1,saved_by_principal_id=b.actor,
      saved_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE connection_id=c.id RETURNING * INTO d;
  END IF;
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.storefront.saved','SHOPIFY_STOREFRONT',c.id,d.settings_version,
    jsonb_build_object('settingsVersion',d.settings_version));
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('settingsVersion',d.settings_version);
END $$;

-- BEGIN {schoolId, settingsVersion}: lease the store's publish for three minutes. The version must be the saved one, so what
-- reaches Shopify is exactly what the owner last saw. At most 100 publishes a day per store. Answers the settings, the lease
-- and the sealed credential.
CREATE FUNCTION hon.begin_shopify_storefront_publish(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; c hon.shopify_connections%ROWTYPE; d hon.shopify_storefronts%ROWTYPE; k hon.shopify_credentials%ROWTYPE;
  v_lease uuid:=gen_random_uuid(); v_today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['settingsVersion']);
  IF NOT hon.shopify_int_ok(p_input->'settingsVersion',1,1000000000,false) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  c:=hon.shopify_current(b.school);
  IF c.id IS NULL OR c.status<>'CONNECTED' THEN RAISE EXCEPTION 'SHOPIFY_NOT_CONNECTED' USING ERRCODE='P0002'; END IF;
  SELECT * INTO c FROM hon.shopify_connections WHERE id=c.id FOR UPDATE;
  IF c.status<>'CONNECTED' THEN RAISE EXCEPTION 'SHOPIFY_NOT_CONNECTED' USING ERRCODE='P0002'; END IF;
  d:=hon.shopify_storefront_locked(c.id);
  IF d.connection_id IS NULL THEN RAISE EXCEPTION 'SHOPIFY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF d.lease_token IS NOT NULL THEN RAISE EXCEPTION 'SHOPIFY_STOREFRONT_BUSY' USING ERRCODE='55006'; END IF;
  IF (p_input->>'settingsVersion')::integer<>d.settings_version THEN RAISE EXCEPTION 'SHOPIFY_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF d.publish_day IS NOT DISTINCT FROM v_today AND d.publishes_that_day>=100 THEN RAISE EXCEPTION 'SHOPIFY_STOREFRONT_LIMIT' USING ERRCODE='54000'; END IF;
  UPDATE hon.shopify_storefronts SET publish_status='PUBLISHING',failure_code=NULL,lease_token=v_lease,leased_by_principal_id=b.actor,
    lease_expires_at=clock_timestamp()+interval '3 minutes',publishing_version=d.settings_version,
    publishes_that_day=CASE WHEN publish_day IS NOT DISTINCT FROM v_today THEN publishes_that_day+1 ELSE 1 END,publish_day=v_today,
    version=version+1,updated_at=clock_timestamp() WHERE connection_id=c.id RETURNING * INTO d;
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.storefront.publish_started','SHOPIFY_STOREFRONT',c.id,d.settings_version,
    jsonb_build_object('settingsVersion',d.settings_version));
  SELECT * INTO k FROM hon.shopify_credentials WHERE connection_id=c.id AND destroyed_at IS NULL;
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('leaseToken',v_lease,'connectionId',c.id,'shopDomain',c.shop_domain,
    'settingsVersion',d.settings_version,'settings',d.settings,
    'credential',jsonb_build_object('keyId',k.key_id,'sealed',k.sealed,'version',k.version,
      'accessExpiresAt',hon.saas_ts(k.access_expires_at),'refreshExpiresAt',hon.saas_ts(k.refresh_expires_at)));
END $$;

-- The live lease this person holds on the store's publish.
CREATE FUNCTION hon.shopify_storefront_leased(p_school uuid,p_actor uuid,p_lease jsonb) RETURNS hon.shopify_storefronts
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE d hon.shopify_storefronts%ROWTYPE;
BEGIN
  IF NOT hon.shopify_uuid_ok(p_lease) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO d FROM hon.shopify_storefronts WHERE school_id=p_school AND lease_token=(p_lease#>>'{}')::uuid FOR UPDATE;
  IF d.connection_id IS NULL OR d.leased_by_principal_id<>p_actor OR d.lease_expires_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM hon.shopify_connections c WHERE c.id=d.connection_id AND c.status='CONNECTED') THEN
    RAISE EXCEPTION 'SHOPIFY_STOREFRONT_NOT_LEASED' USING ERRCODE='55000'; END IF;
  RETURN d;
END $$;

-- ROTATE {schoolId, leaseToken, expectedVersion, credential}: the API refreshed the token pair under this lease.
CREATE FUNCTION hon.rotate_shopify_storefront_credential(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; d hon.shopify_storefronts%ROWTYPE; k jsonb; v integer;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['leaseToken','expectedVersion','credential']);
  k:=p_input->'credential';
  IF NOT hon.shopify_int_ok(p_input->'expectedVersion',1,1000000000,false) OR NOT hon.shopify_credential_ok(k)
    OR (k->>'accessExpiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  d:=hon.shopify_storefront_leased(b.school,b.actor,p_input->'leaseToken');
  UPDATE hon.shopify_credentials SET version=version+1,key_id=k->>'keyId',sealed=k->>'sealed',access_expires_at=(k->>'accessExpiresAt')::timestamptz,
    refresh_expires_at=(k->>'refreshExpiresAt')::timestamptz,rotated_at=clock_timestamp()
    WHERE connection_id=d.connection_id AND destroyed_at IS NULL AND version=(p_input->>'expectedVersion')::integer RETURNING version INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'SHOPIFY_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('version',v);
END $$;

-- FINISH {schoolId, leaseToken, outcome, failureCode}: PUBLISHED (failureCode null; the leased version is now in Shopify),
-- FAILED (nothing was written) or UNKNOWN (the write may have been saved).
CREATE FUNCTION hon.finish_shopify_storefront_publish(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; d hon.shopify_storefronts%ROWTYPE; v_outcome text;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['leaseToken','outcome','failureCode']);
  v_outcome:=CASE WHEN jsonb_typeof(p_input->'outcome')='string' THEN p_input->>'outcome' END;
  IF v_outcome IS NULL OR v_outcome NOT IN ('PUBLISHED','FAILED','UNKNOWN')
    OR ((v_outcome='PUBLISHED')<>(jsonb_typeof(p_input->'failureCode')='null'))
    OR (v_outcome<>'PUBLISHED' AND (jsonb_typeof(p_input->'failureCode')<>'string' OR p_input->>'failureCode' !~ '^[A-Z_]{1,40}$')) THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  d:=hon.shopify_storefront_leased(b.school,b.actor,p_input->'leaseToken');
  UPDATE hon.shopify_storefronts SET publish_status=v_outcome,failure_code=p_input->>'failureCode',
    published_version=CASE WHEN v_outcome='PUBLISHED' THEN publishing_version ELSE published_version END,
    published_at=CASE WHEN v_outcome='PUBLISHED' THEN clock_timestamp() ELSE published_at END,
    lease_token=NULL,leased_by_principal_id=NULL,lease_expires_at=NULL,publishing_version=NULL,version=version+1,updated_at=clock_timestamp()
    WHERE connection_id=d.connection_id RETURNING * INTO d;
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.storefront.'||lower(v_outcome),'SHOPIFY_STOREFRONT',d.connection_id,
    d.settings_version,jsonb_build_object('publishedVersion',d.published_version,'failureCode',d.failure_code));
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('outcome',v_outcome,'publishedVersion',d.published_version);
END $$;

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_shopify_storefront(text,uuid)','hon.save_shopify_storefront(text,jsonb)',
    'hon.begin_shopify_storefront_publish(text,jsonb)','hon.rotate_shopify_storefront_credential(text,jsonb)',
    'hon.finish_shopify_storefront_publish(text,jsonb)'];
BEGIN
  REVOKE ALL ON TABLE hon.shopify_storefronts FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.shopify_storefronts FROM %I',r); END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname IN ('shopify_storefront_on_end','shopify_storefront_settings_ok','shopify_storefront_locked',
      'shopify_storefront_leased') OR p.oid::regprocedure::text=ANY(entry)) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
