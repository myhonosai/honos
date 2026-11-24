BEGIN;

-- Parent pro shop (0581, assigned by the coordinator 2026-11-19; docs/architecture/PARENT_PRO_SHOP.md).
-- The owner asked for the school's pro shop in the HON Family app ("proshop as well like shopify items").
--   S1  A family with one live grant at the school (any access level) reads the school's own Shopify products that HON
--       already mirrors (0405/0449): ACTIVE, not removed, with a handle and at least one live variant; at most 100, by title.
--   S2  Each product carries its title, image, lowest live variant price as a 2-decimal string, and the link to its page on
--       the school's own store (https://<shop>.myshopify.com/products/<handle>). Buying happens there: HON takes no order,
--       payment or customer detail, and is never the merchant.
--   S3  Only a CONNECTED store is shown. Inventory, cost, margin, SKU, barcode, vendor and orders never reach a family.
-- No DML. The runtime gains no table privilege: the entry point is SECURITY DEFINER.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'The parent pro shop requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'The parent pro shop requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.parent_class_booking_scope(text,boolean)') IS NULL OR to_regclass('hon.shopify_connections') IS NULL
    OR to_regclass('hon.shopify_products') IS NULL OR to_regclass('hon.shopify_variants') IS NULL THEN
    RAISE EXCEPTION 'The parent pro shop requires 0329 and 0405';
  END IF;
END $$;

-- S1 parent scope: the 0329 family scope (one live grant, tenant, principal, source, live school and entitlement), with its
-- own refusal code. Reading needs no guardian level.
CREATE FUNCTION hon.parent_pro_shop_scope(subject text)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid, access_level text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  BEGIN
    RETURN QUERY SELECT * FROM hon.parent_class_booking_scope(subject,false);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'PARENT_PRO_SHOP_FORBIDDEN' USING ERRCODE='42501';
  END;
END $$;

-- S1-S3 parent read. A school with no connected store answers available=false and no products.
CREATE FUNCTION hon.read_parent_pro_shop(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; c hon.shopify_connections%ROWTYPE; school_name text; items jsonb;
BEGIN
  SELECT * INTO sc FROM hon.parent_pro_shop_scope(subject);
  SELECT s.name INTO school_name FROM hon.schools s WHERE s.id=sc.school_id AND s.organization_id=sc.organization_id;
  SELECT * INTO c FROM hon.shopify_connections x WHERE x.school_id=sc.school_id AND x.organization_id=sc.organization_id AND x.status='CONNECTED'
    ORDER BY x.updated_at DESC, x.id LIMIT 1;
  IF NOT FOUND OR c.currency IS NULL THEN
    RETURN jsonb_build_object('schoolName',school_name,'available',false,'currency',NULL,'products','[]'::jsonb);
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('productId',p.shopify_id::text,'title',p.title,'imageUrl',p.image_url,
      'fromPrice',to_char(p.low,'FM999999990.00'),'url','https://'||c.shop_domain||'/products/'||p.handle) ORDER BY lower(p.title),p.shopify_id),'[]'::jsonb)
    INTO items FROM (
      SELECT x.*, (SELECT min(v.price) FROM hon.shopify_variants v WHERE v.connection_id=c.id AND v.product_shopify_id=x.shopify_id AND NOT v.removed) low
      FROM hon.shopify_products x
      WHERE x.connection_id=c.id AND x.organization_id=sc.organization_id AND x.school_id=sc.school_id AND x.status='ACTIVE' AND NOT x.removed
        AND x.handle ~ '^[a-z0-9][a-z0-9-]{0,254}$'
        AND EXISTS (SELECT 1 FROM hon.shopify_variants v WHERE v.connection_id=c.id AND v.product_shopify_id=x.shopify_id AND NOT v.removed)
      ORDER BY lower(x.title), x.shopify_id LIMIT 100) p;
  RETURN jsonb_build_object('schoolName',school_name,'available',true,'currency',c.currency,'products',items);
END $$;

COMMENT ON FUNCTION hon.read_parent_pro_shop(text) IS
'0581 parent read: the school''s ACTIVE mirrored Shopify products (at most 100) with lowest price and a link to the school''s own product page. No DML; HON takes no order or payment.';

DO $$ DECLARE r text; f text; fns text[]:=ARRAY['hon.parent_pro_shop_scope(text)','hon.read_parent_pro_shop(text)']; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_parent_pro_shop(text) TO hon_runtime;
    IF has_function_privilege('hon_runtime','hon.parent_pro_shop_scope(text)','EXECUTE') THEN
      RAISE EXCEPTION 'The parent pro shop scope helper must stay private';
    END IF;
  END IF;
END $$;

COMMIT;
