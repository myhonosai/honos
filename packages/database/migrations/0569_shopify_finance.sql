BEGIN;

-- HON Shopify finance view, piece SH-F1 (0569, coordinator-allocated 2026-11-19). Spec: docs/architecture/SHOPIFY_COMMERCE.md.
-- Builds on 0405 (SH1), 0449 (SH1b) and 0496 (SH4a).
-- Owner vision (David, 2026-11-19): the Commerce page shows the store's money side next to the catalog and orders: the
-- Shopify Payments balance, the latest payouts and recent balance transactions. Shopify stays the source of truth; HON
-- only reads. Capital (financing) has no Shopify API, so HON links to the Shopify admin for it instead.
-- * A sync reads Shopify Payments once, after orders, when the store granted read_shopify_payments_accounts. HON asks
--   for that scope only when the owner presses Allow finance; connecting stays as it was.
-- * One snapshot per store: whether Shopify Payments is active, the balance per currency (at most 10), the latest 20
--   payouts and the latest 50 balance transactions. Each sync replaces the snapshot whole. Ids, statuses, instants and
--   amounts only: no bank account, no customer, no order detail.
-- * Only a person with commerce.shopify.manage can read it. The snapshot is deleted when the store stops being CONNECTED.
-- * Forced RLS with no policy and no client table privilege; the runtime and the worker execute fixed definer functions.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.shopify_leased_sync(jsonb,text[],boolean)') IS NULL OR to_regprocedure('hon.shopify_has_scope(text,text)') IS NULL THEN
    RAISE EXCEPTION '0569 requires 0449 and 0496 (Shopify background sync and product changes)'; END IF;
END $$;

CREATE TABLE hon.shopify_finance (
  connection_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  payments_active boolean NOT NULL,
  balances jsonb NOT NULL CHECK (jsonb_typeof(balances)='array' AND jsonb_array_length(balances)<=10),
  payouts jsonb NOT NULL CHECK (jsonb_typeof(payouts)='array' AND jsonb_array_length(payouts)<=20),
  transactions jsonb NOT NULL CHECK (jsonb_typeof(transactions)='array' AND jsonb_array_length(transactions)<=50),
  sync_id uuid NOT NULL REFERENCES hon.shopify_syncs(id),
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.shopify_connections(id,organization_id,school_id),
  CHECK (payments_active OR (balances='[]'::jsonb AND payouts='[]'::jsonb AND transactions='[]'::jsonb))
);
ALTER TABLE hon.shopify_finance ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.shopify_finance FORCE ROW LEVEL SECURITY;
CREATE TRIGGER shopify_finance_no_truncate BEFORE TRUNCATE ON hon.shopify_finance FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_shopify();
COMMENT ON TABLE hon.shopify_finance IS
'0569 the latest Shopify Payments snapshot (balance, payouts, balance transactions) of a CONNECTED store. Read-only copy; private.';

-- A store that stops being CONNECTED loses its snapshot.
CREATE FUNCTION hon.shopify_finance_on_end() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NEW.status<>'CONNECTED' THEN DELETE FROM hon.shopify_finance WHERE connection_id=NEW.id; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER shopify_connection_finance_end AFTER UPDATE OF status ON hon.shopify_connections
  FOR EACH ROW EXECUTE FUNCTION hon.shopify_finance_on_end();

-- Money as Shopify Payments sends it: a decimal string with at most 4 decimals below one billion, which may be negative.
CREATE FUNCTION hon.shopify_signed_money_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT v IS NOT NULL AND jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^-?(0|[1-9][0-9]{0,8})(\.[0-9]{1,4})?$'
$$;
CREATE FUNCTION hon.shopify_currency_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT v IS NOT NULL AND jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[A-Z]{3}$'
$$;

-- The snapshot exactly as the API sends it:
-- {paymentsActive, balances:[{currency, amount}], payouts:[{id, status, direction, issuedAt, currency, net}],
--  transactions:[{id, type, at, currency, amount, fee, net, test, payoutId|null}]}. Ids are the numeric part of the gid.
CREATE FUNCTION hon.shopify_finance_ok(f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(hon.shopify_keys_ok(f,ARRAY['paymentsActive','balances','payouts','transactions'],ARRAY[]::text[])
    AND jsonb_typeof(f->'paymentsActive')='boolean'
    AND jsonb_typeof(f->'balances')='array' AND jsonb_array_length(f->'balances')<=10
    AND jsonb_typeof(f->'payouts')='array' AND jsonb_array_length(f->'payouts')<=20
    AND jsonb_typeof(f->'transactions')='array' AND jsonb_array_length(f->'transactions')<=50
    AND ((f->>'paymentsActive')::boolean OR (jsonb_array_length(f->'balances')=0 AND jsonb_array_length(f->'payouts')=0 AND jsonb_array_length(f->'transactions')=0))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f->'balances') b WHERE NOT coalesce(
      hon.shopify_keys_ok(b,ARRAY['currency','amount'],ARRAY[]::text[]) AND hon.shopify_currency_ok(b->'currency') AND hon.shopify_signed_money_ok(b->'amount'),false))
    AND (SELECT count(DISTINCT b->>'currency') FROM jsonb_array_elements(f->'balances') b)=jsonb_array_length(f->'balances')
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f->'payouts') p WHERE NOT coalesce(
      hon.shopify_keys_ok(p,ARRAY['id','status','direction','issuedAt','currency','net'],ARRAY[]::text[])
      AND hon.shopify_id_ok(p->'id',false) AND jsonb_typeof(p->'status')='string' AND p->>'status' IN ('SCHEDULED','IN_TRANSIT','PAID','FAILED','CANCELED')
      AND jsonb_typeof(p->'direction')='string' AND p->>'direction' IN ('DEPOSIT','WITHDRAWAL')
      AND hon.shopify_instant_ok(p->'issuedAt',false) AND hon.shopify_currency_ok(p->'currency') AND hon.shopify_signed_money_ok(p->'net'),false))
    AND (SELECT count(DISTINCT p->>'id') FROM jsonb_array_elements(f->'payouts') p)=jsonb_array_length(f->'payouts')
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f->'transactions') t WHERE NOT coalesce(
      hon.shopify_keys_ok(t,ARRAY['id','type','at','currency','amount','fee','net','test','payoutId'],ARRAY[]::text[])
      AND hon.shopify_id_ok(t->'id',false) AND jsonb_typeof(t->'type')='string' AND t->>'type' ~ '^[A-Z_]{1,40}$'
      AND hon.shopify_instant_ok(t->'at',false) AND hon.shopify_currency_ok(t->'currency')
      AND hon.shopify_signed_money_ok(t->'amount') AND hon.shopify_signed_money_ok(t->'fee') AND hon.shopify_signed_money_ok(t->'net')
      AND jsonb_typeof(t->'test')='boolean' AND hon.shopify_id_ok(t->'payoutId',true),false))
    AND (SELECT count(DISTINCT t->>'id') FROM jsonb_array_elements(f->'transactions') t)=jsonb_array_length(f->'transactions'),false)
$$;

-- Replaces the store's snapshot with this one, read during sync y.
CREATE FUNCTION hon.shopify_apply_finance(y hon.shopify_syncs,f jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.shopify_connections%ROWTYPE;
BEGIN
  IF y.id IS NULL OR NOT hon.shopify_finance_ok(f) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM hon.shopify_connections WHERE id=y.connection_id;
  IF NOT hon.shopify_has_scope(c.scopes,'read_shopify_payments_accounts') THEN RAISE EXCEPTION 'SHOPIFY_FINANCE_NOT_ALLOWED' USING ERRCODE='55000'; END IF;
  INSERT INTO hon.shopify_finance(connection_id,organization_id,school_id,payments_active,balances,payouts,transactions,sync_id,read_at)
    VALUES(c.id,c.organization_id,c.school_id,(f->>'paymentsActive')::boolean,f->'balances',f->'payouts',f->'transactions',y.id,clock_timestamp())
    ON CONFLICT (connection_id) DO UPDATE SET payments_active=EXCLUDED.payments_active,balances=EXCLUDED.balances,payouts=EXCLUDED.payouts,
      transactions=EXCLUDED.transactions,sync_id=EXCLUDED.sync_id,read_at=EXCLUDED.read_at;
  RETURN jsonb_build_object('syncId',y.id,'paymentsActive',(f->>'paymentsActive')::boolean,'payouts',jsonb_array_length(f->'payouts'),
    'transactions',jsonb_array_length(f->'transactions'));
END $$;

-- FINANCE {schoolId, syncId, finance}: a person's running sync read Shopify Payments.
CREATE FUNCTION hon.record_shopify_finance(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; y hon.shopify_syncs%ROWTYPE; r jsonb;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['syncId','finance']);
  y:=hon.shopify_running_sync(b.school,b.actor,p_input->'syncId');
  r:=hon.shopify_apply_finance(y,p_input->'finance');
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN r;
END $$;

-- FINANCE {syncId, leaseToken, finance}: the background sync this lease holds read Shopify Payments.
CREATE FUNCTION hon.record_shopify_background_finance(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE y hon.shopify_syncs%ROWTYPE;
BEGIN
  y:=hon.shopify_leased_sync(p_input,ARRAY['finance'],true);
  RETURN hon.shopify_apply_finance(y,p_input->'finance');
END $$;

-- READ (commerce.shopify.manage): whether the store granted finance, and the latest snapshot of a CONNECTED store.
CREATE FUNCTION hon.read_shopify_finance(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.shopify_connections%ROWTYPE; f hon.shopify_finance%ROWTYPE;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.shopify_actor(p_subject,p_school,true) IS NULL THEN RAISE EXCEPTION 'SHOPIFY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM hon.shopify_connections x WHERE x.school_id=p_school AND x.status='CONNECTED' ORDER BY x.updated_at DESC,x.id LIMIT 1;
  IF c.id IS NOT NULL THEN SELECT * INTO f FROM hon.shopify_finance x WHERE x.connection_id=c.id; END IF;
  RETURN jsonb_build_object('schoolId',p_school,'connected',c.id IS NOT NULL,
    'financeAllowed',c.id IS NOT NULL AND hon.shopify_has_scope(c.scopes,'read_shopify_payments_accounts'),
    'currency',c.currency,
    'finance',CASE WHEN f.connection_id IS NULL THEN NULL ELSE jsonb_build_object('paymentsActive',f.payments_active,'balances',f.balances,
      'payouts',f.payouts,'transactions',f.transactions,'readAt',hon.saas_ts(f.read_at)) END);
END $$;

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_shopify_finance(text,uuid)','hon.record_shopify_finance(text,jsonb)'];
  worker text[]:=ARRAY['hon.record_shopify_background_finance(jsonb)'];
BEGIN
  REVOKE ALL ON TABLE hon.shopify_finance FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.shopify_finance FROM %I',r); END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname IN ('shopify_finance_on_end','shopify_signed_money_ok','shopify_currency_ok','shopify_finance_ok',
      'shopify_apply_finance') OR p.oid::regprocedure::text=ANY(entry||worker)) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    FOREACH f IN ARRAY worker LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_communication_worker',f); END LOOP;
  END IF;
END $$;

COMMIT;
