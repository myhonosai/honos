BEGIN;

-- Front-desk Point of Sale (0506; allocated as 0403 on 2026-11-16, renumbered above the main ceiling on 2026-11-18). Spec: docs/architecture/SCHOOL_POINT_OF_SALE.md.
-- Staff ring up school products (testing fees, uniforms, gear, apparel, events) for a contact or a walk-in and record
-- how the school was paid: cash, check, a card on the school's own terminal, or other. HON moves no money: a sale and a
-- refund are evidence records, like 0240 tuition payment records. Refunds are manual with a reason (owner policy
-- 2026-11-08: no automatic refund).
--
-- * pos.sell: see the register and history, ring up sales. pos.manage: catalog, stock, tax rate, refunds, report
--   (and everything pos.sell can do). Both staff-assignable, granted to system OWNER roles only here.
-- * Identity rules are the 0217 person-actor ones (one active human principal, active school and organization, paid
--   access) plus the POS permission at that exact school. Authority is decided again after the last write.
-- * Every amount is computed here from the current catalog and the school's tax rate. The screen sends the total it
--   showed; a different total is refused (POS_TOTAL_CHANGED) so staff never charge an amount they did not see.
-- * Forced RLS with no policy and no client table privilege: the runtime executes fixed definer functions only.
-- * Audit and outbox carry ids, amounts and counts only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.saas_ts(timestamptz)') IS NULL OR to_regclass('hon.people') IS NULL OR to_regclass('hon.role_permissions') IS NULL THEN
    RAISE EXCEPTION '0506 requires the people, IAM and saas timestamp foundations'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('pos.sell','Use the front-desk Point of Sale: see products and sales, record a sale paid in cash, check, the school''s own card terminal or other (evidence only, no money movement)',false,true),
  ('pos.manage','Manage the Point of Sale: products, stock, sales tax rate, manual refunds with a reason, and the sales report',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE (code='pos.sell' AND NOT is_sensitive AND is_staff_assignable)
    OR (code='pos.manage' AND is_sensitive AND is_staff_assignable))<>2 THEN
    RAISE EXCEPTION 'pos permissions already exist with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,x.code FROM hon.roles r CROSS JOIN (VALUES ('pos.sell'),('pos.manage')) x(code)
WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- One row per school once anything is saved or sold: currency, tax rate, receipt counter.
CREATE TABLE hon.pos_settings (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  tax_rate_bps integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 2500),
  receipt_seq integer NOT NULL DEFAULT 0 CHECK (receipt_seq BETWEEN 0 AND 999999999),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  updated_by_principal_id uuid REFERENCES hon.principals(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);

CREATE TABLE hon.pos_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80 AND btrim(name)=name AND name !~ '[\x01-\x1f\x7f]'),
  sku text CHECK (sku IS NULL OR sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  category text NOT NULL CHECK (category IN ('TESTING','UNIFORMS','EQUIPMENT','APPAREL','EVENTS','OTHER')),
  price_minor integer NOT NULL CHECK (price_minor BETWEEN 0 AND 10000000),
  taxable boolean NOT NULL,
  track_stock boolean NOT NULL,
  stock integer NOT NULL DEFAULT 0 CHECK (stock BETWEEN 0 AND 1000000),
  low_stock_at integer CHECK (low_stock_at IS NULL OR low_stock_at BETWEEN 0 AND 1000000),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (track_stock OR (stock=0 AND low_stock_at IS NULL)),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
CREATE INDEX pos_items_scope_idx ON hon.pos_items(organization_id,school_id,active,category,name);
CREATE UNIQUE INDEX pos_items_sku_idx ON hon.pos_items(school_id,lower(sku)) WHERE sku IS NOT NULL AND active;

CREATE TABLE hon.pos_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  receipt_number text NOT NULL CHECK (receipt_number ~ '^POS-[0-9]{8}-[0-9]{4,9}$'),
  local_date date NOT NULL,
  person_id uuid,
  walk_in_name text CHECK (walk_in_name IS NULL OR (length(walk_in_name) BETWEEN 1 AND 120 AND btrim(walk_in_name)=walk_in_name AND walk_in_name !~ '[\x01-\x1f\x7f]')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor integer NOT NULL CHECK (subtotal_minor BETWEEN 0 AND 100000000),
  discount_minor integer NOT NULL CHECK (discount_minor BETWEEN 0 AND 100000000),
  discount_kind text CHECK (discount_kind IN ('AMOUNT','PERCENT')),
  discount_value integer,
  discount_reason text CHECK (discount_reason IS NULL OR (length(discount_reason) BETWEEN 1 AND 200 AND btrim(discount_reason)=discount_reason AND discount_reason !~ '[\x01-\x1f\x7f]')),
  tax_rate_bps integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 2500),
  tax_minor integer NOT NULL CHECK (tax_minor BETWEEN 0 AND 100000000),
  total_minor integer NOT NULL CHECK (total_minor BETWEEN 0 AND 200000000),
  method text NOT NULL CHECK (method IN ('CASH','CHECK','CARD_TERMINAL','OTHER')),
  reference text CHECK (reference IS NULL OR (length(reference) BETWEEN 1 AND 120 AND btrim(reference)=reference AND reference !~ '[\x01-\x1f\x7f]')),
  note text CHECK (note IS NULL OR (length(note) BETWEEN 1 AND 500 AND btrim(note)=note AND note !~ '[\x01-\x1f\x7f]')),
  refunded_minor integer NOT NULL DEFAULT 0 CHECK (refunded_minor BETWEEN 0 AND 200000000),
  sold_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (person_id IS NULL OR walk_in_name IS NULL),
  CHECK ((discount_kind IS NULL)=(discount_value IS NULL) AND (discount_kind IS NULL)=(discount_reason IS NULL) AND (discount_kind IS NULL)=(discount_minor=0)),
  CHECK (discount_minor<=subtotal_minor AND total_minor=subtotal_minor-discount_minor+tax_minor AND refunded_minor<=total_minor),
  UNIQUE (school_id,receipt_number),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  FOREIGN KEY (person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id)
);
CREATE INDEX pos_sales_day_idx ON hon.pos_sales(organization_id,school_id,local_date DESC,created_at DESC);
CREATE INDEX pos_sales_person_idx ON hon.pos_sales(person_id) WHERE person_id IS NOT NULL;

CREATE TABLE hon.pos_sale_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 50),
  item_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  sku text,
  category text NOT NULL CHECK (category IN ('TESTING','UNIFORMS','EQUIPMENT','APPAREL','EVENTS','OTHER','QUICK')),
  unit_price_minor integer NOT NULL CHECK (unit_price_minor BETWEEN 0 AND 10000000),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  line_total_minor integer NOT NULL,
  taxable boolean NOT NULL,
  stock_tracked boolean NOT NULL,
  restocked_quantity integer NOT NULL DEFAULT 0,
  CHECK (line_total_minor=unit_price_minor*quantity AND restocked_quantity BETWEEN 0 AND quantity),
  CHECK ((item_id IS NULL)=(category='QUICK') AND (stock_tracked IS FALSE OR item_id IS NOT NULL) AND (category<>'QUICK' OR NOT taxable)),
  UNIQUE (sale_id,line_no),
  FOREIGN KEY (sale_id,organization_id,school_id) REFERENCES hon.pos_sales(id,organization_id,school_id),
  FOREIGN KEY (item_id,organization_id,school_id) REFERENCES hon.pos_items(id,organization_id,school_id)
);

CREATE TABLE hon.pos_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  local_date date NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 1 AND 200000000),
  method text NOT NULL CHECK (method IN ('CASH','CHECK','CARD_TERMINAL','OTHER')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500 AND btrim(reason)=reason AND reason !~ '[\x01-\x1f\x7f]'),
  restocked jsonb NOT NULL CHECK (jsonb_typeof(restocked)='array'),
  refunded_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (sale_id,organization_id,school_id) REFERENCES hon.pos_sales(id,organization_id,school_id)
);
CREATE INDEX pos_refunds_sale_idx ON hon.pos_refunds(sale_id,created_at);
CREATE INDEX pos_refunds_day_idx ON hon.pos_refunds(organization_id,school_id,local_date);

CREATE TABLE hon.pos_stock_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  change integer NOT NULL CHECK (change<>0 AND change BETWEEN -1000000 AND 1000000),
  stock_after integer NOT NULL CHECK (stock_after BETWEEN 0 AND 1000000),
  kind text NOT NULL CHECK (kind IN ('STARTING','ADJUST','SALE','REFUND_RESTOCK')),
  reason text CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 200 AND btrim(reason)=reason AND reason !~ '[\x01-\x1f\x7f]')),
  sale_id uuid, refund_id uuid,
  principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (CASE kind WHEN 'SALE' THEN sale_id IS NOT NULL AND refund_id IS NULL WHEN 'REFUND_RESTOCK' THEN sale_id IS NOT NULL AND refund_id IS NOT NULL
    ELSE sale_id IS NULL AND refund_id IS NULL END),
  CHECK (kind<>'ADJUST' OR reason IS NOT NULL),
  FOREIGN KEY (item_id,organization_id,school_id) REFERENCES hon.pos_items(id,organization_id,school_id),
  FOREIGN KEY (refund_id) REFERENCES hon.pos_refunds(id)
);
CREATE INDEX pos_stock_moves_item_idx ON hon.pos_stock_moves(item_id,created_at);

CREATE TABLE hon.pos_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  operation text NOT NULL CHECK (operation IN ('item','stock','settings','sale','refund')),
  idempotency_key uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,operation,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pos_settings','pos_items','pos_sales','pos_sale_lines','pos_refunds','pos_stock_moves','pos_requests'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

-- Evidence guard (settings-free). Nothing is deleted or truncated. A sale changes only by a growing refunded amount;
-- a line only by a growing restocked quantity; refunds, stock moves and completed requests never change. Items and
-- settings keep their identity and advance their version by one on every change.
CREATE FUNCTION hon.guard_pos_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'POS_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME IN ('pos_refunds','pos_stock_moves') THEN RAISE EXCEPTION 'POS_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='pos_requests' THEN
    IF OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL
      OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.operation,NEW.idempotency_key,NEW.fingerprint,NEW.created_at)
        IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.operation,OLD.idempotency_key,OLD.fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'POS_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='pos_sales' THEN
    IF NEW.refunded_minor<=OLD.refunded_minor
      OR (to_jsonb(NEW)-'refunded_minor') IS DISTINCT FROM (to_jsonb(OLD)-'refunded_minor') THEN
      RAISE EXCEPTION 'POS_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='pos_sale_lines' THEN
    IF NEW.restocked_quantity<=OLD.restocked_quantity
      OR (to_jsonb(NEW)-'restocked_quantity') IS DISTINCT FROM (to_jsonb(OLD)-'restocked_quantity') THEN
      RAISE EXCEPTION 'POS_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='pos_items' THEN
    IF NEW.version<>OLD.version+1 OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.created_by_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.created_by_principal_id,OLD.created_at) THEN
      RAISE EXCEPTION 'POS_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  -- pos_settings: the receipt counter only grows; identity is fixed.
  IF NEW.receipt_seq<OLD.receipt_seq OR (NEW.school_id,NEW.organization_id) IS DISTINCT FROM (OLD.school_id,OLD.organization_id)
    OR NEW.version NOT IN (OLD.version,OLD.version+1) THEN
    RAISE EXCEPTION 'POS_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pos_settings','pos_items','pos_sales','pos_sale_lines','pos_refunds','pos_stock_moves','pos_requests'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_pos_evidence()',t||'_guard',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_pos_evidence()',t||'_no_truncate',t);
  END LOOP;
END $$;

-- The acting principal when the subject holds live POS authority at this exact school, else NULL.
-- p_manage=false: pos.sell or pos.manage. p_manage=true: pos.manage.
-- Staff only: HQ operators and family/student/HQ/platform roles never hold POS authority, and the
-- permission must be staff-assignable on a role scoped to this school (same rule as staff_member_eligible).
CREATE FUNCTION hon.pos_actor(p_subject text,p_school uuid,p_manage boolean) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT p.id FROM hon.users u
  JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
  JOIN hon.schools s ON s.id=p_school AND s.status='ACTIVE'
  JOIN hon.organizations o ON o.id=s.organization_id AND o.status='ACTIVE'
  WHERE u.external_subject=p_subject
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=s.organization_id AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g
      JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=g.role_id AND rp.organization_id=s.organization_id
      JOIN hon.permissions pm ON pm.code=rp.permission_code AND pm.is_staff_assignable
      WHERE g.principal_id=p.id AND (r.management_school_id IS NULL OR r.management_school_id=s.id)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)' AND g.organization_id=s.organization_id AND g.school_id=s.id AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND rp.permission_code=ANY(CASE WHEN p_manage THEN ARRAY['pos.manage'] ELSE ARRAY['pos.sell','pos.manage'] END))
  LIMIT 1
$$;

CREATE FUNCTION hon.pos_text_ok(v jsonb,max_len integer,nullable boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN v IS NULL OR jsonb_typeof(v)='null' THEN nullable
    ELSE jsonb_typeof(v)='string' AND length(v#>>'{}') BETWEEN 1 AND max_len AND btrim(v#>>'{}')=v#>>'{}' AND (v#>>'{}') !~ '[\x01-\x1f\x7f]' END
$$;
CREATE FUNCTION hon.pos_int_ok(v jsonb,lo bigint,hi bigint) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT v IS NOT NULL AND jsonb_typeof(v)='number' AND (v#>>'{}') ~ '^-?[0-9]{1,10}$' AND (v#>>'{}')::bigint BETWEEN lo AND hi
$$;
CREATE FUNCTION hon.pos_keys_ok(p jsonb,required text[],optional text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p)='object' AND p ?& required
    AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT (k=ANY(required) OR k=ANY(optional)))
$$;
CREATE FUNCTION hon.pos_uuid_ok(v jsonb,nullable boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN v IS NULL OR jsonb_typeof(v)='null' THEN nullable
    ELSE jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' END
$$;
-- Whole-number half-up rounding of a/b for non-negative a and positive b.
CREATE FUNCTION hon.pos_div_round(a bigint,b bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$ SELECT (2*a+b)/(2*b) $$;

CREATE FUNCTION hon.pos_school_tz(p_school uuid) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE tz text;
BEGIN
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=p_school;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN
    RAISE EXCEPTION 'POS_SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  RETURN tz;
END $$;

CREATE FUNCTION hon.pos_item_json(i hon.pos_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('itemId',i.id,'name',i.name,'sku',i.sku,'category',i.category,'priceMinor',i.price_minor,
    'taxable',i.taxable,'trackStock',i.track_stock,'stock',CASE WHEN i.track_stock THEN i.stock END,'lowStockAt',i.low_stock_at,
    'lowStock',i.track_stock AND i.low_stock_at IS NOT NULL AND i.stock<=i.low_stock_at,'active',i.active,'version',i.version)
$$;

CREATE FUNCTION hon.pos_settings_json(p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT jsonb_build_object('currency',s.currency::text,'taxRateBps',s.tax_rate_bps,'version',s.version)
    FROM hon.pos_settings s WHERE s.school_id=p_school),jsonb_build_object('currency','USD','taxRateBps',0,'version',NULL))
$$;

CREATE FUNCTION hon.pos_sale_summary_json(x hon.pos_sales) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('saleId',x.id,'receiptNumber',x.receipt_number,'soldAt',hon.saas_ts(x.created_at),'localDate',to_char(x.local_date,'YYYY-MM-DD'),
    'customer',CASE WHEN x.person_id IS NOT NULL THEN (SELECT jsonb_build_object('personId',pp.id,'name',left(btrim(pp.given_name||' '||coalesce(pp.family_name,'')),120))
        FROM hon.people pp WHERE pp.id=x.person_id) ELSE jsonb_build_object('personId',NULL,'name',x.walk_in_name) END,
    'firstItem',(SELECT l.name FROM hon.pos_sale_lines l WHERE l.sale_id=x.id ORDER BY l.line_no LIMIT 1),
    'itemCount',(SELECT sum(l.quantity)::int FROM hon.pos_sale_lines l WHERE l.sale_id=x.id),
    'currency',x.currency::text,'totalMinor',x.total_minor,'refundedMinor',x.refunded_minor,'method',x.method,
    'status',CASE WHEN x.refunded_minor=0 THEN 'PAID' WHEN x.refunded_minor<x.total_minor THEN 'PARTLY_REFUNDED' ELSE 'REFUNDED' END)
$$;

CREATE FUNCTION hon.pos_sale_json(x hon.pos_sales) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.pos_sale_summary_json(x)||jsonb_build_object(
    'schoolName',(SELECT s.name FROM hon.schools s WHERE s.id=x.school_id),
    'soldBy',(SELECT left(p.display_name,120) FROM hon.principals p WHERE p.id=x.sold_by_principal_id),
    'lines',(SELECT coalesce(jsonb_agg(jsonb_build_object('lineId',l.id,'itemId',l.item_id,'name',l.name,'sku',l.sku,'category',l.category,
        'unitPriceMinor',l.unit_price_minor,'quantity',l.quantity,'lineTotalMinor',l.line_total_minor,'taxable',l.taxable,
        'stockTracked',l.stock_tracked,'restockedQuantity',l.restocked_quantity) ORDER BY l.line_no),'[]'::jsonb) FROM hon.pos_sale_lines l WHERE l.sale_id=x.id),
    'subtotalMinor',x.subtotal_minor,
    'discount',CASE WHEN x.discount_kind IS NULL THEN NULL ELSE jsonb_build_object('kind',x.discount_kind,'value',x.discount_value,'reason',x.discount_reason,'amountMinor',x.discount_minor) END,
    'taxRateBps',x.tax_rate_bps,'taxMinor',x.tax_minor,'reference',x.reference,'note',x.note,
    'refunds',(SELECT coalesce(jsonb_agg(jsonb_build_object('refundId',r.id,'refundedAt',hon.saas_ts(r.created_at),'amountMinor',r.amount_minor,
        'method',r.method,'reason',r.reason,'restocked',r.restocked,
        'refundedBy',(SELECT left(p.display_name,120) FROM hon.principals p WHERE p.id=r.refunded_by_principal_id)) ORDER BY r.created_at),'[]'::jsonb)
      FROM hon.pos_refunds r WHERE r.sale_id=x.id))
$$;

-- Register read: settings, the active catalog (and archived items for managers), permissions and today's totals.
CREATE FUNCTION hon.read_pos(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_org uuid; manage boolean; tz text; today date;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.pos_actor(p_subject,p_school,false) IS NULL THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  manage:=hon.pos_actor(p_subject,p_school,true) IS NOT NULL;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=p_school;
  tz:=hon.pos_school_tz(p_school); today:=(clock_timestamp() AT TIME ZONE tz)::date;
  RETURN jsonb_build_object('schoolId',p_school,'timezone',tz,'today',to_char(today,'YYYY-MM-DD'),'canManage',manage,
    'settings',hon.pos_settings_json(p_school),
    'items',(SELECT coalesce(jsonb_agg(hon.pos_item_json(i) ORDER BY i.category,lower(i.name),i.id),'[]'::jsonb) FROM hon.pos_items i
      WHERE i.organization_id=v_org AND i.school_id=p_school AND (i.active OR manage)),
    'todaySales',(SELECT jsonb_build_object('count',count(*)::int,'totalMinor',coalesce(sum(x.total_minor),0)::bigint)
      FROM hon.pos_sales x WHERE x.organization_id=v_org AND x.school_id=p_school AND x.local_date=today));
END $$;

-- History + report for a school-local date range (at most 366 days). Sales newest first (at most 500). The report
-- counts sales by sale date and refunds by refund date.
CREATE FUNCTION hon.read_pos_sales(p_subject text,p_school uuid,p_from date,p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_org uuid; manage boolean; report jsonb;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>366 THEN
    RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.pos_actor(p_subject,p_school,false) IS NULL THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  manage:=hon.pos_actor(p_subject,p_school,true) IS NOT NULL;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=p_school;
  IF manage THEN
    WITH s AS (SELECT * FROM hon.pos_sales x WHERE x.organization_id=v_org AND x.school_id=p_school AND x.local_date BETWEEN p_from AND p_to),
      r AS (SELECT * FROM hon.pos_refunds x WHERE x.organization_id=v_org AND x.school_id=p_school AND x.local_date BETWEEN p_from AND p_to),
      m AS (SELECT method FROM s UNION SELECT method FROM r)
    SELECT jsonb_build_object('salesCount',(SELECT count(*)::int FROM s),
      'grossMinor',(SELECT coalesce(sum(subtotal_minor),0)::bigint FROM s),
      'discountMinor',(SELECT coalesce(sum(discount_minor),0)::bigint FROM s),
      'taxMinor',(SELECT coalesce(sum(tax_minor),0)::bigint FROM s),
      'collectedMinor',(SELECT coalesce(sum(total_minor),0)::bigint FROM s),
      'refundsCount',(SELECT count(*)::int FROM r),
      'refundedMinor',(SELECT coalesce(sum(amount_minor),0)::bigint FROM r),
      'netMinor',(SELECT coalesce(sum(total_minor),0)::bigint FROM s)-(SELECT coalesce(sum(amount_minor),0)::bigint FROM r),
      'byMethod',(SELECT coalesce(jsonb_agg(jsonb_build_object('method',m.method,
          'collectedMinor',(SELECT coalesce(sum(total_minor),0)::bigint FROM s WHERE s.method=m.method),
          'refundedMinor',(SELECT coalesce(sum(amount_minor),0)::bigint FROM r WHERE r.method=m.method)) ORDER BY m.method),'[]'::jsonb) FROM m),
      'topItems',(SELECT coalesce(jsonb_agg(t ORDER BY (t->>'quantity')::int DESC,t->>'name'),'[]'::jsonb) FROM (
          SELECT jsonb_build_object('name',l.name,'quantity',sum(l.quantity)::int,'salesMinor',sum(l.line_total_minor)::bigint) t
          FROM hon.pos_sale_lines l JOIN s ON s.id=l.sale_id GROUP BY l.name ORDER BY sum(l.quantity) DESC,l.name LIMIT 10) q))
    INTO report;
  END IF;
  RETURN jsonb_build_object('from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),
    'sales',(SELECT coalesce(jsonb_agg(hon.pos_sale_summary_json(x) ORDER BY x.created_at DESC,x.id),'[]'::jsonb) FROM (
      SELECT * FROM hon.pos_sales x WHERE x.organization_id=v_org AND x.school_id=p_school AND x.local_date BETWEEN p_from AND p_to
      ORDER BY x.created_at DESC,x.id LIMIT 500) x),
    'report',report);
END $$;

CREATE FUNCTION hon.read_pos_sale(p_subject text,p_school uuid,p_sale uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_org uuid; x hon.pos_sales%ROWTYPE;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL OR p_sale IS NULL THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.pos_actor(p_subject,p_school,false) IS NULL THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=p_school;
  SELECT * INTO x FROM hon.pos_sales WHERE id=p_sale AND organization_id=v_org AND school_id=p_school;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.pos_sale_json(x);
END $$;

-- Common prologue: live authority, own receipt (exact replay only while authority is current), school row.
CREATE FUNCTION hon.pos_begin(p_subject text,p_operation text,p_input jsonb,p_key uuid,p_manage boolean,OUT actor uuid,OUT org uuid,OUT school uuid,OUT replay jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE fp text; prior hon.pos_requests%ROWTYPE;
BEGIN
  IF p_subject IS NULL OR p_key IS NULL OR NOT hon.pos_uuid_ok(p_input->'schoolId',false) THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  school:=(p_input->>'schoolId')::uuid;
  actor:=hon.pos_actor(p_subject,school,p_manage);
  IF actor IS NULL THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO org FROM hon.schools WHERE id=school;
  fp:=encode(sha256(convert_to('POS:'||p_operation||':'||p_input::text,'UTF8')),'hex');
  INSERT INTO hon.pos_requests(organization_id,school_id,principal_id,operation,idempotency_key,fingerprint)
    VALUES(org,school,actor,p_operation,p_key,fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.pos_requests WHERE organization_id=org AND school_id=school AND principal_id=actor
      AND operation=p_operation AND idempotency_key=p_key FOR UPDATE;
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'POS_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'POS_BUSY' USING ERRCODE='55P03'; END IF;
    IF hon.pos_actor(p_subject,school,p_manage) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
    replay:=prior.response; RETURN;
  END IF;
END $$;

-- Common epilogue: id/amount-only audit and outbox, receipt completion, authority decided again after the last write.
CREATE FUNCTION hon.pos_finish(p_subject text,p_manage boolean,p_actor uuid,p_org uuid,p_school uuid,p_operation text,p_key uuid,
  p_action text,p_entity_type text,p_entity uuid,p_version integer,p_prior jsonb,p_next jsonb,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_request uuid:=gen_random_uuid();
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,occurred_at)
    VALUES(p_org,p_school,p_actor,'HUMAN_UI',p_action,p_entity_type,p_entity,p_prior,p_next,'SUCCEEDED',v_request,v_request,clock_timestamp());
  INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(gen_random_uuid(),p_org,p_school,p_action,1,p_entity_type,p_entity,p_version,v_request,v_request,p_next);
  UPDATE hon.pos_requests SET response=p_result,completed_at=clock_timestamp()
    WHERE organization_id=p_org AND school_id=p_school AND principal_id=p_actor AND operation=p_operation AND idempotency_key=p_key;
  IF hon.pos_actor(p_subject,p_school,p_manage) IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'POS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN p_result;
END $$;

-- The school's settings row, created on first use and locked.
CREATE FUNCTION hon.pos_lock_settings(p_org uuid,p_school uuid) RETURNS hon.pos_settings
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s hon.pos_settings%ROWTYPE;
BEGIN
  INSERT INTO hon.pos_settings(school_id,organization_id) VALUES(p_school,p_org) ON CONFLICT DO NOTHING;
  SELECT * INTO s FROM hon.pos_settings WHERE school_id=p_school AND organization_id=p_org FOR UPDATE;
  RETURN s;
END $$;

-- Input: exactly {schoolId, expectedVersion (null before the first save), currency, taxRateBps}. The currency cannot
-- change once the school has a sale. Returns {settings}.
CREATE FUNCTION hon.save_pos_settings(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; s hon.pos_settings%ROWTYPE; existed boolean; prior jsonb; nxt jsonb;
BEGIN
  IF NOT hon.pos_keys_ok(p_input,ARRAY['schoolId','expectedVersion','currency','taxRateBps'],ARRAY[]::text[])
    OR NOT (jsonb_typeof(p_input->'expectedVersion')='null' OR hon.pos_int_ok(p_input->'expectedVersion',1,999999999))
    OR jsonb_typeof(p_input->'currency') IS DISTINCT FROM 'string' OR p_input->>'currency' NOT IN ('USD','CAD','GBP','EUR','AUD','NZD','KRW','JPY','MXN')
    OR NOT hon.pos_int_ok(p_input->'taxRateBps',0,2500) THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.pos_begin(p_subject,'settings',p_input,p_key,true);
  IF b.replay IS NOT NULL THEN RETURN b.replay||jsonb_build_object('replayed',true); END IF;
  existed:=EXISTS(SELECT 1 FROM hon.pos_settings WHERE school_id=b.school);
  s:=hon.pos_lock_settings(b.org,b.school);
  IF (existed AND (jsonb_typeof(p_input->'expectedVersion')<>'number' OR s.version<>(p_input->>'expectedVersion')::integer))
    OR (NOT existed AND jsonb_typeof(p_input->'expectedVersion')<>'null') THEN
    RAISE EXCEPTION 'POS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF s.currency<>p_input->>'currency' AND EXISTS(SELECT 1 FROM hon.pos_sales WHERE school_id=b.school) THEN
    RAISE EXCEPTION 'POS_CURRENCY_LOCKED' USING ERRCODE='22023'; END IF;
  prior:=CASE WHEN existed THEN hon.pos_settings_json(b.school) END;
  UPDATE hon.pos_settings SET currency=p_input->>'currency',tax_rate_bps=(p_input->>'taxRateBps')::integer,
    version=CASE WHEN existed THEN version+1 ELSE version END,updated_by_principal_id=b.actor,updated_at=clock_timestamp()
    WHERE school_id=b.school;
  nxt:=hon.pos_settings_json(b.school);
  RETURN hon.pos_finish(p_subject,true,b.actor,b.org,b.school,'settings',p_key,'pos.settings.saved','POS_SETTINGS',b.school,(nxt->>'version')::integer,
    prior,nxt,jsonb_build_object('settings',nxt,'replayed',false));
END $$;

-- Input: exactly {schoolId, itemId (null to add), expectedVersion (null to add), name, sku, category, priceMinor,
-- taxable, trackStock, lowStockAt, startingStock (add only; 0 when not tracked), active}. Stock changes only through
-- the stock command. Turning tracking off needs the stock at 0. Returns {item}.
CREATE FUNCTION hon.save_pos_item(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; cur hon.pos_items%ROWTYPE; nxt hon.pos_items%ROWTYPE; adding boolean; track boolean; starting integer; prior jsonb;
BEGIN
  IF NOT hon.pos_keys_ok(p_input,ARRAY['schoolId','itemId','expectedVersion','name','sku','category','priceMinor','taxable','trackStock','lowStockAt','startingStock','active'],ARRAY[]::text[])
    OR NOT hon.pos_uuid_ok(p_input->'itemId',true)
    OR NOT (jsonb_typeof(p_input->'expectedVersion')='null' OR hon.pos_int_ok(p_input->'expectedVersion',1,999999999))
    OR (jsonb_typeof(p_input->'itemId')='null')<>(jsonb_typeof(p_input->'expectedVersion')='null')
    OR NOT hon.pos_text_ok(p_input->'name',80,false)
    OR NOT (jsonb_typeof(p_input->'sku')='null' OR (jsonb_typeof(p_input->'sku')='string' AND p_input->>'sku' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'))
    OR jsonb_typeof(p_input->'category') IS DISTINCT FROM 'string' OR p_input->>'category' NOT IN ('TESTING','UNIFORMS','EQUIPMENT','APPAREL','EVENTS','OTHER')
    OR NOT hon.pos_int_ok(p_input->'priceMinor',0,10000000)
    OR jsonb_typeof(p_input->'taxable')<>'boolean' OR jsonb_typeof(p_input->'trackStock')<>'boolean' OR jsonb_typeof(p_input->'active')<>'boolean'
    OR NOT (jsonb_typeof(p_input->'lowStockAt')='null' OR hon.pos_int_ok(p_input->'lowStockAt',0,1000000))
    OR NOT hon.pos_int_ok(p_input->'startingStock',0,1000000) THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  adding:=jsonb_typeof(p_input->'itemId')='null'; track:=(p_input->>'trackStock')::boolean; starting:=(p_input->>'startingStock')::integer;
  IF (NOT track AND (starting<>0 OR jsonb_typeof(p_input->'lowStockAt')<>'null')) OR (NOT adding AND starting<>0)
    OR (adding AND NOT (p_input->>'active')::boolean) THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.pos_begin(p_subject,'item',p_input,p_key,true);
  IF b.replay IS NOT NULL THEN RETURN b.replay||jsonb_build_object('replayed',true); END IF;
  IF jsonb_typeof(p_input->'sku')='string' AND (p_input->>'active')::boolean AND EXISTS(SELECT 1 FROM hon.pos_items WHERE school_id=b.school AND active
      AND lower(sku)=lower(p_input->>'sku') AND (adding OR id<>(p_input->>'itemId')::uuid)) THEN
    RAISE EXCEPTION 'POS_SKU_TAKEN' USING ERRCODE='23505'; END IF;
  IF adding THEN
    INSERT INTO hon.pos_items(organization_id,school_id,name,sku,category,price_minor,taxable,track_stock,stock,low_stock_at,created_by_principal_id,updated_by_principal_id)
      VALUES(b.org,b.school,p_input->>'name',p_input->>'sku',p_input->>'category',(p_input->>'priceMinor')::integer,(p_input->>'taxable')::boolean,
        track,starting,(p_input->>'lowStockAt')::integer,b.actor,b.actor) RETURNING * INTO nxt;
    IF starting>0 THEN
      INSERT INTO hon.pos_stock_moves(item_id,organization_id,school_id,change,stock_after,kind,principal_id)
        VALUES(nxt.id,b.org,b.school,starting,starting,'STARTING',b.actor);
    END IF;
  ELSE
    SELECT * INTO cur FROM hon.pos_items WHERE id=(p_input->>'itemId')::uuid AND organization_id=b.org AND school_id=b.school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'POS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF cur.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'POS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF cur.track_stock AND NOT track AND cur.stock<>0 THEN RAISE EXCEPTION 'POS_STOCK_NOT_EMPTY' USING ERRCODE='22023'; END IF;
    prior:=hon.pos_item_json(cur);
    UPDATE hon.pos_items SET name=p_input->>'name',sku=p_input->>'sku',category=p_input->>'category',price_minor=(p_input->>'priceMinor')::integer,
      taxable=(p_input->>'taxable')::boolean,track_stock=track,low_stock_at=(p_input->>'lowStockAt')::integer,active=(p_input->>'active')::boolean,
      version=version+1,updated_by_principal_id=b.actor,updated_at=clock_timestamp() WHERE id=cur.id RETURNING * INTO nxt;
  END IF;
  RETURN hon.pos_finish(p_subject,true,b.actor,b.org,b.school,'item',p_key,'pos.item.saved','POS_ITEM',nxt.id,nxt.version,
    prior,jsonb_build_object('itemId',nxt.id,'priceMinor',nxt.price_minor,'active',nxt.active,'stock',nxt.stock,'version',nxt.version),
    jsonb_build_object('item',hon.pos_item_json(nxt),'replayed',false));
END $$;

-- Input: exactly {schoolId, itemId, expectedVersion, change (non-zero whole number), reason}. Stock never goes below 0.
CREATE FUNCTION hon.adjust_pos_stock(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; cur hon.pos_items%ROWTYPE; nxt hon.pos_items%ROWTYPE; delta integer;
BEGIN
  IF NOT hon.pos_keys_ok(p_input,ARRAY['schoolId','itemId','expectedVersion','change','reason'],ARRAY[]::text[])
    OR NOT hon.pos_uuid_ok(p_input->'itemId',false) OR NOT hon.pos_int_ok(p_input->'expectedVersion',1,999999999)
    OR NOT hon.pos_int_ok(p_input->'change',-1000000,1000000) OR (p_input->>'change')::integer=0
    OR NOT hon.pos_text_ok(p_input->'reason',200,false) THEN RAISE EXCEPTION 'POS_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.pos_begin(p_subject,'stock',p_input,p_key,true);
  IF b.replay IS NOT NULL THEN RETURN b.replay||jsonb_build_object('replayed',true); END IF;
  SELECT * INTO cur FROM hon.pos_items WHERE id=(p_input->>'itemId')::uuid AND organization_id=b.org AND school_id=b.school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF cur.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'POS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF NOT cur.track_stock THEN RAISE EXCEPTION 'POS_STOCK_NOT_TRACKED' USING ERRCODE='22023'; END IF;
  delta:=(p_input->>'change')::integer;
  IF cur.stock+delta<0 OR cur.stock+delta>1000000 THEN RAISE EXCEPTION 'POS_STOCK_OUT_OF_RANGE' USING ERRCODE='22023'; END IF;
  UPDATE hon.pos_items SET stock=stock+delta,version=version+1,updated_by_principal_id=b.actor,updated_at=clock_timestamp() WHERE id=cur.id RETURNING * INTO nxt;
  INSERT INTO hon.pos_stock_moves(item_id,organization_id,school_id,change,stock_after,kind,reason,principal_id)
    VALUES(cur.id,b.org,b.school,delta,nxt.stock,'ADJUST',p_input->>'reason',b.actor);
  RETURN hon.pos_finish(p_subject,true,b.actor,b.org,b.school,'stock',p_key,'pos.stock.adjusted','POS_ITEM',nxt.id,nxt.version,
    jsonb_build_object('stock',cur.stock),jsonb_build_object('itemId',nxt.id,'change',delta,'stock',nxt.stock,'version',nxt.version),
    jsonb_build_object('item',hon.pos_item_json(nxt),'replayed',false));
END $$;

-- Input: exactly {schoolId, personId, walkInName, lines, discount, method, reference, note, expectedTotalMinor}.
-- lines: 1..50 of {itemId, quantity} (an active catalog item at this school) or {description, unitPriceMinor,
-- quantity} (a quick amount, never taxed). discount: null or {kind AMOUNT|PERCENT, value, reason}. Prices, tax and the
-- total come from the catalog and settings now; a total different from expectedTotalMinor is refused. Tracked stock
-- is taken off and may not go below 0. Returns {sale}.
CREATE FUNCTION hon.record_pos_sale(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; st hon.pos_settings%ROWTYPE; tz text; today date; ln jsonb; n integer:=0; it hon.pos_items%ROWTYPE;
  sub bigint:=0; taxable_sub bigint:=0; disc bigint:=0; tax bigint:=0; total bigint; taxable_after bigint; qty integer;
  sale hon.pos_sales%ROWTYPE; want jsonb:='[]'::jsonb; d jsonb; v_seq integer;
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
  FOR ln IN SELECT value FROM jsonb_array_elements(p_input->'lines') LOOP
    n:=n+1; qty:=(ln->>'quantity')::integer;
    IF ln ? 'itemId' THEN
      SELECT * INTO it FROM hon.pos_items WHERE id=(ln->>'itemId')::uuid AND organization_id=b.org AND school_id=b.school AND active;
      IF NOT FOUND THEN RAISE EXCEPTION 'POS_ITEM_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
      want:=want||jsonb_build_object('n',n,'item',it.id,'name',it.name,'sku',it.sku,'category',it.category,'price',it.price_minor,'qty',qty,'taxable',it.taxable,'track',it.track_stock);
      sub:=sub+it.price_minor::bigint*qty; IF it.taxable THEN taxable_sub:=taxable_sub+it.price_minor::bigint*qty; END IF;
    ELSE
      want:=want||jsonb_build_object('n',n,'item',NULL,'name',ln->>'description','sku',NULL,'category','QUICK','price',(ln->>'unitPriceMinor')::integer,'qty',qty,'taxable',false,'track',false);
      sub:=sub+(ln->>'unitPriceMinor')::bigint*qty;
    END IF;
  END LOOP;
  -- Total tracked quantity per item (an item may appear on several lines) must be in stock.
  IF EXISTS(SELECT 1 FROM (SELECT (w->>'item')::uuid item,sum((w->>'qty')::int) q FROM jsonb_array_elements(want) w WHERE (w->>'track')::boolean GROUP BY 1) t
      JOIN hon.pos_items i ON i.id=t.item WHERE i.stock<t.q) THEN
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
  INSERT INTO hon.pos_sale_lines(sale_id,organization_id,school_id,line_no,item_id,name,sku,category,unit_price_minor,quantity,line_total_minor,taxable,stock_tracked)
    SELECT sale.id,b.org,b.school,(w->>'n')::int,(w->>'item')::uuid,w->>'name',w->>'sku',w->>'category',(w->>'price')::int,(w->>'qty')::int,
      (w->>'price')::int*(w->>'qty')::int,(w->>'taxable')::boolean,(w->>'track')::boolean FROM jsonb_array_elements(want) w;
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

-- Input: exactly {schoolId, saleId, amountMinor, method, reason, restock: [{lineId, quantity}]}. A manual refund the
-- school paid back outside HON, up to what is left on the sale; restocked quantities go back on the shelf. Returns
-- {sale} with all its refunds.
CREATE FUNCTION hon.refund_pos_sale(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
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
  -- Restock only lines whose item still tracks stock, so every restocked unit has a stock move.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'restock') e LEFT JOIN hon.pos_sale_lines l ON l.id=(e->>'lineId')::uuid AND l.sale_id=sale.id
      LEFT JOIN hon.pos_items i ON i.id=l.item_id
      WHERE l.id IS NULL OR NOT l.stock_tracked OR i.id IS NULL OR NOT i.track_stock OR l.restocked_quantity+(e->>'quantity')::int>l.quantity) THEN
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
  RETURN hon.pos_finish(p_subject,true,b.actor,b.org,b.school,'refund',p_key,'pos.sale.refunded','POS_SALE',sale.id,
    (SELECT count(*)::int+1 FROM hon.pos_refunds WHERE sale_id=sale.id),
    jsonb_build_object('refundedMinor',sale.refunded_minor),
    jsonb_build_object('saleId',sale.id,'refundId',ref.id,'amountMinor',amount,'method',ref.method,'refundedMinor',nxt.refunded_minor,
      'restockedLines',jsonb_array_length(ref.restocked)),
    jsonb_build_object('sale',hon.pos_sale_json(nxt),'replayed',false));
END $$;

-- Deny first, then exactly the fixed entry points for the runtime role. No table privilege for any client role.
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['pos_settings','pos_items','pos_sales','pos_sale_lines','pos_refunds','pos_stock_moves','pos_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname LIKE 'pos\_%' OR p.proname IN ('guard_pos_evidence','read_pos','read_pos_sales','read_pos_sale','save_pos_settings',
      'save_pos_item','adjust_pos_stock','record_pos_sale','refund_pos_sale')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_pos(text,uuid),hon.read_pos_sales(text,uuid,date,date),hon.read_pos_sale(text,uuid,uuid),
      hon.save_pos_settings(text,jsonb,uuid),hon.save_pos_item(text,jsonb,uuid),hon.adjust_pos_stock(text,jsonb,uuid),
      hon.record_pos_sale(text,jsonb,uuid),hon.refund_pos_sale(text,jsonb,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
