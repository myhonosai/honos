BEGIN;

-- HON Shopify Connected, piece SH1c (0470, allocated 2026-11-17). Spec: docs/architecture/SHOPIFY_COMMERCE.md.
-- Retention for the order mirror. HON reads only the last 60 days of a store's orders, so a mirrored order (and its
-- lines) is kept for 60 days after it was placed and then deleted:
-- * every successful sync (a person's Sync now or a background run) deletes that store's orders placed more than 60
--   days ago, in the same transaction that records the sync as SUCCEEDED;
-- * the background worker (hon_communication_worker) also deletes them for every store, including stores that are
--   disconnected and no longer sync, in bounded batches.
-- Order rows hold no customer details (0405); this keeps even order totals from outliving their use. Nothing is
-- granted to the runtime.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.claim_shopify_background_sync()') IS NULL THEN RAISE EXCEPTION '0470 requires 0449 (Shopify background sync)'; END IF;
END $$;

-- On SUCCEEDED: this store's orders older than 60 days go (lines first).
CREATE FUNCTION hon.shopify_purge_expired_orders_on_success() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF OLD.outcome='RUNNING' AND NEW.outcome='SUCCEEDED' THEN
    DELETE FROM hon.shopify_order_lines l USING hon.shopify_orders o
      WHERE o.connection_id=NEW.connection_id AND o.placed_at<clock_timestamp()-interval '60 days'
        AND l.connection_id=o.connection_id AND l.order_shopify_id=o.shopify_id;
    DELETE FROM hon.shopify_orders WHERE connection_id=NEW.connection_id AND placed_at<clock_timestamp()-interval '60 days';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER shopify_syncs_order_retention AFTER UPDATE OF outcome ON hon.shopify_syncs
  FOR EACH ROW EXECUTE FUNCTION hon.shopify_purge_expired_orders_on_success();

-- Worker: up to 2,000 expired orders (any store, connected or not) and their lines per call. Never waits for a lock:
-- an order a running sync holds is left for the next call. Returns {orders, lines, more}.
CREATE FUNCTION hon.purge_expired_shopify_orders() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n_orders integer; n_lines integer;
BEGIN
  WITH e AS (SELECT o.connection_id,o.shopify_id FROM hon.shopify_orders o WHERE o.placed_at<clock_timestamp()-interval '60 days'
      ORDER BY o.placed_at LIMIT 2000 FOR UPDATE SKIP LOCKED),
    gone_lines AS (DELETE FROM hon.shopify_order_lines l USING e WHERE l.connection_id=e.connection_id AND l.order_shopify_id=e.shopify_id RETURNING 1),
    gone_orders AS (DELETE FROM hon.shopify_orders o USING e WHERE o.connection_id=e.connection_id AND o.shopify_id=e.shopify_id RETURNING 1)
  SELECT (SELECT count(*) FROM gone_orders),(SELECT count(*) FROM gone_lines) INTO n_orders,n_lines;
  RETURN jsonb_build_object('orders',n_orders,'lines',n_lines,
    'more',EXISTS(SELECT 1 FROM hon.shopify_orders WHERE placed_at<clock_timestamp()-interval '60 days'));
END $$;

DO $$ DECLARE r text; f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.shopify_purge_expired_orders_on_success()','hon.purge_expired_shopify_orders()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.purge_expired_shopify_orders() TO hon_communication_worker;
  END IF;
END $$;

COMMIT;
