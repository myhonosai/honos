BEGIN;

-- Family checkout orders (0582, CP3 first slice, assigned by the coordinator 2026-11-19; docs/architecture/TUITION_COLLECTION.md
-- §24). Owner ask (2026-11-19): "event/checkout pages" in the HON Family app. A signed-in guardian buys one ONE_TIME
-- option of a PUBLISHED checkout page (0402) of their school, for one or more of their own children, through the shared
-- one-time payment (0529) on the school's own processor page. TEST/SANDBOX mode only (0258 refuses LIVE connections).
-- HON adds no fee. Not in this slice: MONTHLY options, options tied to a catalog plan, promo codes (CP4), public links.
--   F1  Who, what and how much come only from the database. The parent scope is the 0530 path: exactly one live family
--       (resolve_parent_journey_scopes) and a GUARDIAN grant (never VIEWER). Participants are distinct ACTIVE children of
--       that family. The page must be PUBLISHED at the version the parent saw; the option ONE_TIME, with no plan, still
--       available on the school's today and within capacity (0 is unlimited); answers, add-ons and the waiver are checked
--       against the page. Total = price for the first participant + the extra-participant fee (or the full price when the
--       page has none) for each other one + the chosen add-ons (each once per order).
--   F2  A caller never names a payment. The API gets a payment id only from these functions for an order of the family
--       (the 0529 caller rule); a foreign order, family, school or organization is refused before any payment read.
--   F3  The order is settled in the database, whatever path records the processor's answer (the parent's confirm, the
--       0529 sweep): SUCCEEDED marks it PAID; FAILED, EXPIRED or CANCELED marks it CANCELED and frees its places. A free
--       order (total 0) is PAID at once with no payment.
--   F4  Capacity counts PAID orders and OPEN orders whose payment may still be paid, under a per-page transaction lock.
--   F5  Staff with school_checkout.manage read the school's orders (who, what, answers, state). Nothing is sent to anyone.
-- Exact-request idempotency per guardian and key. At most 20 orders per family per day. No runtime table privilege.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Family checkout orders require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Family checkout orders require a restricted runtime';
  END IF;
  IF to_regclass('hon.school_checkouts') IS NULL OR to_regprocedure('hon.require_school_checkout_actor(text)') IS NULL
    OR to_regprocedure('hon.school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz)') IS NULL
    OR to_regprocedure('hon.resolve_parent_journey_scopes(text)') IS NULL OR to_regprocedure('hon.school_pay_instant(timestamptz)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL OR to_regprocedure('hon.school_pay_once_provider(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Family checkout orders require 0102, 0177, 0269, 0321, 0402 and 0529';
  END IF;
END $$;

-- Code-owned recorder of checkout order outcomes. No user, role, HQ, family or delegated authority.
INSERT INTO hon.principals(id,principal_type,display_name)
  VALUES('00000000-0000-4000-8000-000000000582','SYSTEM_SERVICE','Code-owned family checkout order recorder');

CREATE TABLE hon.family_checkout_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  checkout_id uuid NOT NULL,
  checkout_version integer NOT NULL CHECK (checkout_version>=1),
  family_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  option_key text NOT NULL CHECK (option_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- [{studentProfileId, answers:{key: string|boolean}}], 1..10 distinct children.
  participants jsonb NOT NULL CHECK (jsonb_typeof(participants)='array' AND jsonb_array_length(participants) BETWEEN 1 AND 10),
  add_on_keys jsonb NOT NULL CHECK (jsonb_typeof(add_on_keys)='array' AND jsonb_array_length(add_on_keys)<=10),
  waiver_sha256 text CHECK (waiver_sha256 IS NULL OR waiver_sha256 ~ '^[0-9a-f]{64}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 5000000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAID','CANCELED','REVIEW')),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 200 AND btrim(request_key)=request_key AND request_key !~ '[[:cntrl:]]'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  CHECK ((status='OPEN')=(settled_at IS NULL)),
  UNIQUE (principal_id,request_key),
  FOREIGN KEY (checkout_id,school_id) REFERENCES hon.school_checkouts(id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE INDEX family_checkout_orders_checkout ON hon.family_checkout_orders(checkout_id,option_key,status);
CREATE INDEX family_checkout_orders_family ON hon.family_checkout_orders(family_id,created_at DESC);
CREATE INDEX family_checkout_orders_school ON hon.family_checkout_orders(school_id,created_at DESC,id);
ALTER TABLE hon.family_checkout_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.family_checkout_orders FORCE ROW LEVEL SECURITY;
CREATE TRIGGER family_checkout_orders_no_truncate BEFORE TRUNCATE ON hon.family_checkout_orders
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- An order never changes what was bought, by whom or for how much, and is never deleted. It is created OPEN (or PAID
-- when free) and moves once from OPEN to PAID, CANCELED or REVIEW, with the version moving on by one.
CREATE FUNCTION hon.guard_family_checkout_order() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Family checkout orders are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NOT (NEW.status='OPEN' OR (NEW.status='PAID' AND NEW.amount_minor=0)) THEN
      RAISE EXCEPTION 'A new family checkout order is OPEN, or PAID when free' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.checkout_id,NEW.checkout_version,NEW.family_id,NEW.principal_id,NEW.option_key,NEW.participants,
      NEW.add_on_keys,NEW.waiver_sha256,NEW.title,NEW.amount_minor,NEW.currency,NEW.request_key,NEW.request_sha256,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.checkout_id,OLD.checkout_version,OLD.family_id,OLD.principal_id,OLD.option_key,OLD.participants,
      OLD.add_on_keys,OLD.waiver_sha256,OLD.title,OLD.amount_minor,OLD.currency,OLD.request_key,OLD.request_sha256,OLD.created_at)
    OR OLD.status<>'OPEN' OR NEW.status NOT IN ('PAID','CANCELED','REVIEW') OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'A family checkout order is settled once and never changes' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER family_checkout_orders_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.family_checkout_orders
  FOR EACH ROW EXECUTE FUNCTION hon.guard_family_checkout_order();

-- F1: the live guardian scope (as 0530): exactly one current family and a GUARDIAN grant, with its principal.
CREATE FUNCTION hon.family_checkout_scope(subject text, guardian boolean)
  RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid,family_id uuid,access_level text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; s record;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject THEN
    RAISE EXCEPTION 'FAMILY_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO n FROM hon.resolve_parent_journey_scopes(subject);
  IF n<>1 THEN RAISE EXCEPTION 'FAMILY_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM hon.resolve_parent_journey_scopes(subject);
  IF guardian AND s.access_level NOT IN ('PRIMARY_GUARDIAN'::hon.family_access_level,'SECONDARY_GUARDIAN'::hon.family_access_level) THEN
    RAISE EXCEPTION 'FAMILY_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT s.principal_id,s.organization_id,s.school_id,s.family_id,s.access_level::text;
END $$;

-- The family's ACTIVE children (STUDENT members whose primary family is this family), with display names.
CREATE FUNCTION hon.family_checkout_children(org uuid,school uuid,fam uuid) RETURNS TABLE(student_profile_id uuid,display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT sp.id,concat_ws(' ',pe.given_name,pe.family_name)
  FROM hon.student_profiles sp
  JOIN hon.family_members m ON m.person_id=sp.person_id AND m.organization_id=sp.organization_id AND m.school_id=sp.school_id
    AND m.family_id=fam AND m.member_role='STUDENT'
  JOIN hon.people pe ON pe.id=sp.person_id AND pe.organization_id=sp.organization_id AND pe.school_id=sp.school_id
  WHERE sp.primary_family_id=fam AND sp.status='ACTIVE' AND sp.organization_id=org AND sp.school_id=school
  ORDER BY 2,1 LIMIT 20
$$;

-- The school's calendar today.
CREATE FUNCTION hon.family_checkout_today(school uuid) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT (clock_timestamp() AT TIME ZONE coalesce((SELECT z.name FROM hon.schools k JOIN pg_timezone_names z ON z.name=k.timezone WHERE k.id=school),'UTC'))::date
$$;

-- Whether an order's payment may still be paid (PROCESSING, or OPEN before its processor session or itself ends).
CREATE FUNCTION hon.family_checkout_payment_live(o uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.school_pay_once p WHERE p.source='CHECKOUT_PAGE' AND p.source_id=o
    AND (p.state='PROCESSING' OR (p.state='OPEN' AND greatest(p.expires_at,coalesce(p.provider_expires_at,p.expires_at))>clock_timestamp())))
$$;

-- F4: places an option has taken: participants of PAID orders and of OPEN orders whose payment may still be paid.
CREATE FUNCTION hon.family_checkout_taken(checkout uuid,option_key text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(sum(jsonb_array_length(o.participants)),0)::bigint FROM hon.family_checkout_orders o
  WHERE o.checkout_id=checkout AND o.option_key=family_checkout_taken.option_key
    AND (o.status='PAID' OR (o.status='OPEN' AND hon.family_checkout_payment_live(o.id)))
$$;

-- The English text of a 0269 i18n value, or NULL.
CREATE FUNCTION hon.family_checkout_en(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(v)='object' THEN v->>'en' END
$$;

-- An option a family may buy in this slice (F1): ONE_TIME, no plan, available today.
CREATE FUNCTION hon.family_checkout_option_open(o jsonb,today date) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT o->>'billing'='ONE_TIME' AND jsonb_typeof(o->'planId')='null' AND o->>'createsMembership'='false'
    AND (jsonb_typeof(o->'availableThrough')='null' OR (o->>'availableThrough')::date>=today)
$$;

-- One page as a family sees it: English text, only the options this slice sells, with places left.
CREATE FUNCTION hon.family_checkout_page_json(c hon.school_checkouts,today date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('checkoutId',c.id,'version',c.version,'group',c.group_key,
    'title',hon.family_checkout_en(c.content->'title'),'description',hon.family_checkout_en(c.content->'description'),
    'currency',c.content->>'currency','maxParticipants',(c.content->'multiParticipant'->>'maxPerOrder')::integer,
    'blocks',coalesce((SELECT jsonb_agg(jsonb_build_object('position',b->>'position','text',hon.family_checkout_en(b->'text'))) FROM jsonb_array_elements(c.content->'blocks') b),'[]'::jsonb),
    'options',coalesce((SELECT jsonb_agg(jsonb_build_object('key',o->>'key','label',hon.family_checkout_en(o->'label'),'description',hon.family_checkout_en(o->'description'),
        'priceMinor',(o->>'priceMinor')::bigint,'additionalParticipantMinor',CASE WHEN jsonb_typeof(o->'additionalParticipantMinor')='number' THEN (o->>'additionalParticipantMinor')::bigint END,
        'mostPopular',(o->>'mostPopular')::boolean,
        'placesLeft',CASE WHEN (o->>'capacity')::bigint=0 THEN NULL ELSE greatest((o->>'capacity')::bigint-hon.family_checkout_taken(c.id,o->>'key'),0) END))
      FROM jsonb_array_elements(c.content->'options') o WHERE hon.family_checkout_option_open(o,today)),'[]'::jsonb),
    'addOns',coalesce((SELECT jsonb_agg(jsonb_build_object('key',a->>'key','label',hon.family_checkout_en(a->'label'),'amountMinor',(a->>'amountMinor')::bigint,
        'required',(a->>'required')::boolean)) FROM jsonb_array_elements(c.content->'addOns') a),'[]'::jsonb),
    'questions',coalesce((SELECT jsonb_agg(jsonb_build_object('key',f->>'key','label',hon.family_checkout_en(f->'label'),'kind',f->>'kind','required',(f->>'required')::boolean,
        'options',coalesce((SELECT jsonb_agg(hon.family_checkout_en(x)) FROM jsonb_array_elements(f->'options') x),'[]'::jsonb)))
      FROM jsonb_array_elements(c.content->'customFields') f),'[]'::jsonb),
    'waiver',hon.family_checkout_en(c.content->'waiver'->'text'),'thankYou',hon.family_checkout_en(c.content->'thankYou'))
$$;

-- One order as its family sees it.
CREATE FUNCTION hon.family_checkout_order_json(o hon.family_checkout_orders) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('orderId',o.id,'checkoutId',o.checkout_id,'title',o.title,'optionKey',o.option_key,
    'participantCount',jsonb_array_length(o.participants),'amountMinor',o.amount_minor,'currency',o.currency,
    'status',CASE WHEN o.status='OPEN' AND NOT hon.family_checkout_payment_live(o.id) THEN 'UNPAID' ELSE o.status END,
    'createdAt',hon.school_pay_instant(o.created_at))
$$;

-- F1 read: the school's published pages with something to buy, the family's children, and its latest 20 orders.
-- The provider code reaches the API only (it decides whether card payment is offered). No DML.
CREATE FUNCTION hon.read_parent_checkout_pages(subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; today date; school_name text;
BEGIN
  SELECT * INTO s FROM hon.family_checkout_scope(subject,false);
  today:=hon.family_checkout_today(s.school_id);
  SELECT k.name INTO school_name FROM hon.schools k WHERE k.id=s.school_id AND k.organization_id=s.organization_id;
  RETURN jsonb_build_object('schoolName',school_name,'canBuy',s.access_level IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN'),
    'providerCode',hon.school_pay_once_provider(s.organization_id,s.school_id),
    'pages',coalesce((SELECT jsonb_agg(p.j ORDER BY p.created_at,p.id) FROM (
        SELECT c.id,c.created_at,hon.family_checkout_page_json(c,today) j FROM hon.school_checkouts c
        WHERE c.organization_id=s.organization_id AND c.school_id=s.school_id AND c.status='PUBLISHED'
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.content->'options') o WHERE hon.family_checkout_option_open(o,today))
        ORDER BY c.created_at,c.id LIMIT 50) p),'[]'::jsonb),
    'children',coalesce((SELECT jsonb_agg(jsonb_build_object('studentProfileId',x.student_profile_id,'displayName',x.display_name) ORDER BY x.display_name,x.student_profile_id)
      FROM hon.family_checkout_children(s.organization_id,s.school_id,s.family_id) x),'[]'::jsonb),
    'orders',coalesce((SELECT jsonb_agg(hon.family_checkout_order_json(o) ORDER BY o.created_at DESC,o.id) FROM (
        SELECT * FROM hon.family_checkout_orders x WHERE x.organization_id=s.organization_id AND x.school_id=s.school_id AND x.family_id=s.family_id
        ORDER BY x.created_at DESC,x.id LIMIT 20) o),'[]'::jsonb));
END $$;

-- F1-F4 open: check everything against the page under its lock, then create the order and (when not free) open its
-- one-time payment. An exact repeat under the same key returns the same order; another request under it is refused.
CREATE FUNCTION hon.open_parent_checkout_order(subject text,p jsonb,key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE svc constant uuid:='00000000-0000-4000-8000-000000000582'; s record; c hon.school_checkouts%ROWTYPE; o jsonb; prior hon.family_checkout_orders%ROWTYPE;
  ord hon.family_checkout_orders%ROWTYPE; today date; fp text; n integer; each_extra bigint; total bigint; addons jsonb; parts jsonb:='[]'::jsonb;
  part jsonb; f jsonb; ans jsonb; v jsonb; payment uuid; request uuid:=gen_random_uuid(); title text;
BEGIN
  IF key IS NULL OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key OR key ~ '[[:cntrl:]]'
    OR jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['addOns','checkoutId','expectedVersion','optionKey','participants','waiverAccepted']
    OR jsonb_typeof(p->'checkoutId') IS DISTINCT FROM 'string' OR p->>'checkoutId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR p->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'optionKey') IS DISTINCT FROM 'string' OR p->>'optionKey' !~ '^[a-z][a-z0-9_]{0,39}$'
    OR jsonb_typeof(p->'waiverAccepted') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p->'addOns') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'addOns')>10
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'addOns') a WHERE jsonb_typeof(a)<>'string')
    OR (SELECT count(DISTINCT a) FROM jsonb_array_elements_text(p->'addOns') a)<>jsonb_array_length(p->'addOns')
    OR jsonb_typeof(p->'participants') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'participants') NOT BETWEEN 1 AND 10
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'participants') x WHERE jsonb_typeof(x)<>'object'
      OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(x) k) IS DISTINCT FROM ARRAY['answers','studentProfileId']
      OR jsonb_typeof(x->'studentProfileId')<>'string' OR x->>'studentProfileId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR jsonb_typeof(x->'answers')<>'object')
    OR (SELECT count(DISTINCT x->>'studentProfileId') FROM jsonb_array_elements(p->'participants') x)<>jsonb_array_length(p->'participants') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM hon.family_checkout_scope(subject,true);
  fp:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.family_checkout_orders x WHERE x.principal_id=s.principal_id AND x.request_key=key;
  IF FOUND THEN
    IF prior.request_sha256<>fp OR prior.family_id<>s.family_id OR prior.school_id<>s.school_id THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('orderId',prior.id,'status',prior.status,'amountMinor',prior.amount_minor,'currency',prior.currency,'replayed',true);
  END IF;
  -- Lock order: page -> (0529) school -> connection -> payment.
  SELECT * INTO c FROM hon.school_checkouts x WHERE x.id=(p->>'checkoutId')::uuid AND x.organization_id=s.organization_id AND x.school_id=s.school_id FOR UPDATE;
  IF NOT FOUND OR c.status<>'PUBLISHED' THEN RAISE EXCEPTION 'FAMILY_CHECKOUT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF c.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'FAMILY_CHECKOUT_CHANGED' USING ERRCODE='40001'; END IF;
  -- The scope is read again after the lock, so a grant that ended meanwhile cannot buy.
  IF NOT EXISTS(SELECT 1 FROM hon.family_checkout_scope(subject,true) t WHERE (t.principal_id,t.organization_id,t.school_id,t.family_id)=(s.principal_id,s.organization_id,s.school_id,s.family_id)) THEN
    RAISE EXCEPTION 'FAMILY_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF (SELECT count(*) FROM hon.family_checkout_orders x WHERE x.family_id=s.family_id AND x.created_at>clock_timestamp()-interval '1 day')>=20 THEN
    RAISE EXCEPTION 'FAMILY_CHECKOUT_RATE_LIMITED' USING ERRCODE='53400'; END IF;
  today:=hon.family_checkout_today(s.school_id);
  SELECT x INTO o FROM jsonb_array_elements(c.content->'options') x WHERE x->>'key'=p->>'optionKey';
  IF o IS NULL OR NOT hon.family_checkout_option_open(o,today) THEN RAISE EXCEPTION 'FAMILY_CHECKOUT_OPTION_UNAVAILABLE' USING ERRCODE='40001'; END IF;
  n:=jsonb_array_length(p->'participants');
  IF n>(c.content->'multiParticipant'->>'maxPerOrder')::integer THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  -- Participants: the family's own ACTIVE children; answers exactly the page's questions.
  FOR part IN SELECT x FROM jsonb_array_elements(p->'participants') x LOOP
    IF NOT EXISTS(SELECT 1 FROM hon.family_checkout_children(s.organization_id,s.school_id,s.family_id) ch WHERE ch.student_profile_id=(part->>'studentProfileId')::uuid) THEN
      RAISE EXCEPTION 'FAMILY_CHECKOUT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    ans:=part->'answers';
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(ans) k WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.content->'customFields') q WHERE q->>'key'=k)) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    FOR f IN SELECT q FROM jsonb_array_elements(c.content->'customFields') q LOOP
      v:=ans->(f->>'key');
      IF v IS NULL THEN
        IF (f->>'required')::boolean THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
      ELSIF f->>'kind'='CHECKBOX' THEN
        IF jsonb_typeof(v)<>'boolean' OR ((f->>'required')::boolean AND v<>'true'::jsonb) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
      ELSIF f->>'kind'='CHOICE' THEN
        IF jsonb_typeof(v)<>'string' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f->'options') x WHERE x->>'en'=v#>>'{}') THEN
          RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
      ELSE
        IF jsonb_typeof(v)<>'string' OR length(v#>>'{}')>500 OR btrim(v#>>'{}')='' OR (v#>>'{}') ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' THEN
          RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
      END IF;
    END LOOP;
    parts:=parts||jsonb_build_array(jsonb_build_object('studentProfileId',part->>'studentProfileId','answers',ans));
  END LOOP;
  -- Add-ons: known keys, every required one included.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'addOns') k WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.content->'addOns') a WHERE a->>'key'=k))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.content->'addOns') a WHERE (a->>'required')::boolean AND NOT (p->'addOns') ? (a->>'key')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(c.content->'waiver')='object' AND (p->>'waiverAccepted')<>'true' THEN RAISE EXCEPTION 'FAMILY_CHECKOUT_WAIVER_REQUIRED' USING ERRCODE='22023'; END IF;
  IF (o->>'capacity')::bigint>0 AND hon.family_checkout_taken(c.id,o->>'key')+n>(o->>'capacity')::bigint THEN
    RAISE EXCEPTION 'FAMILY_CHECKOUT_FULL' USING ERRCODE='40001'; END IF;
  each_extra:=CASE WHEN jsonb_typeof(o->'additionalParticipantMinor')='number' THEN (o->>'additionalParticipantMinor')::bigint ELSE (o->>'priceMinor')::bigint END;
  SELECT coalesce(jsonb_agg(k ORDER BY k),'[]'::jsonb) INTO addons FROM jsonb_array_elements_text(p->'addOns') k;
  total:=(o->>'priceMinor')::bigint+each_extra*(n-1)
    +coalesce((SELECT sum((a->>'amountMinor')::bigint) FROM jsonb_array_elements(c.content->'addOns') a WHERE (p->'addOns') ? (a->>'key')),0);
  title:=left(hon.family_checkout_en(c.content->'title')||' - '||hon.family_checkout_en(o->'label'),120);
  INSERT INTO hon.family_checkout_orders(organization_id,school_id,checkout_id,checkout_version,family_id,principal_id,option_key,participants,add_on_keys,
      waiver_sha256,title,amount_minor,currency,status,request_key,request_sha256,settled_at)
    VALUES(s.organization_id,s.school_id,c.id,c.version,s.family_id,s.principal_id,o->>'key',parts,addons,
      CASE WHEN jsonb_typeof(c.content->'waiver')='object' THEN encode(sha256(convert_to(c.content->'waiver'->>'text','UTF8')),'hex') END,
      btrim(title),total,c.content->>'currency',CASE WHEN total=0 THEN 'PAID' ELSE 'OPEN' END,key,fp,CASE WHEN total=0 THEN clock_timestamp() END)
    RETURNING * INTO ord;
  IF total>0 THEN
    payment:=hon.school_pay_once_open(ord.organization_id,ord.school_id,'CHECKOUT_PAGE',ord.id,total,ord.currency,
      jsonb_build_object('name',ord.title),'{}'::jsonb,clock_timestamp()+interval '30 minutes');
  END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(ord.organization_id,ord.school_id,s.principal_id,'HUMAN_UI','family_checkout.order_open','FAMILY_CHECKOUT_ORDER',ord.id,NULL,
      jsonb_build_object('orderId',ord.id,'checkoutId',ord.checkout_id,'optionKey',ord.option_key,'participantCount',n,'amountMinor',total,'currency',ord.currency,'status',ord.status),
      'SUCCEEDED',request,request);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(ord.organization_id,ord.school_id,CASE WHEN total=0 THEN 'family_checkout.order_paid' ELSE 'family_checkout.order_opened' END,1,'FAMILY_CHECKOUT_ORDER',ord.id,ord.version,request,request,
      jsonb_build_object('orderId',ord.id,'checkoutId',ord.checkout_id,'status',ord.status));
  RETURN jsonb_build_object('orderId',ord.id,'status',ord.status,'amountMinor',total,'currency',ord.currency,'replayed',false);
END $$;

-- F2: the latest payment of an order of this family, for start, confirm and cancel. A foreign order is
-- FAMILY_CHECKOUT_NOT_FOUND before any payment is read. No DML.
CREATE FUNCTION hon.read_parent_checkout_order(subject text,order_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; o hon.family_checkout_orders%ROWTYPE; x hon.school_pay_once%ROWTYPE;
BEGIN
  IF order_id IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM hon.family_checkout_scope(subject,true);
  SELECT * INTO o FROM hon.family_checkout_orders k WHERE k.id=order_id AND k.organization_id=s.organization_id AND k.school_id=s.school_id AND k.family_id=s.family_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAMILY_CHECKOUT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO x FROM hon.school_pay_once p WHERE p.source='CHECKOUT_PAGE' AND p.source_id=o.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1;
  RETURN jsonb_build_object('order',hon.family_checkout_order_json(o),'paymentId',x.id,'paymentState',x.state);
END $$;

-- F5: the school's latest 200 orders for staff with school_checkout.manage (who, what, answers, state). No DML.
CREATE FUNCTION hon.read_school_checkout_orders(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); items jsonb;
BEGIN
  actor:=hon.require_school_checkout_actor(subject);
  SELECT coalesce(jsonb_agg(jsonb_build_object('orderId',o.id,'checkoutId',o.checkout_id,'title',o.title,'optionKey',o.option_key,
      'familyName',(SELECT f.display_name FROM hon.families f WHERE f.id=o.family_id),
      'participants',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',(SELECT concat_ws(' ',pe.given_name,pe.family_name) FROM hon.student_profiles sp
          JOIN hon.people pe ON pe.id=sp.person_id WHERE sp.id=(x->>'studentProfileId')::uuid),'answers',x->'answers') ORDER BY ord),'[]'::jsonb)
        FROM jsonb_array_elements(o.participants) WITH ORDINALITY y(x,ord)),
      'addOnKeys',o.add_on_keys,'waiverAccepted',o.waiver_sha256 IS NOT NULL,'amountMinor',o.amount_minor,'currency',o.currency,
      'status',CASE WHEN o.status='OPEN' AND NOT hon.family_checkout_payment_live(o.id) THEN 'UNPAID' ELSE o.status END,
      'createdAt',hon.school_pay_instant(o.created_at),'settledAt',CASE WHEN o.settled_at IS NULL THEN NULL ELSE hon.school_pay_instant(o.settled_at) END)
    ORDER BY o.created_at DESC,o.id),'[]'::jsonb) INTO items
  FROM (SELECT * FROM hon.family_checkout_orders k WHERE k.organization_id=org AND k.school_id=school ORDER BY k.created_at DESC,k.id LIMIT 200) o;
  IF hon.require_school_checkout_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('orders',items);
END $$;

-- F3: the processor's final answer settles the order in the same transaction, whoever recorded it. SUCCEEDED pays an
-- OPEN order of the same amount; an order that is somehow no longer OPEN keeps the success on the payment and is
-- flagged for staff review (another amount marks the order REVIEW).
-- FAILED, EXPIRED or CANCELED cancels an OPEN order and frees its places. Nothing is guessed or refunded here.
CREATE FUNCTION hon.settle_family_checkout_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE svc constant uuid:='00000000-0000-4000-8000-000000000582'; request uuid:=gen_random_uuid(); o hon.family_checkout_orders%ROWTYPE; next text;
BEGIN
  SELECT * INTO o FROM hon.family_checkout_orders k WHERE k.id=NEW.source_id AND k.organization_id=NEW.organization_id AND k.school_id=NEW.school_id FOR UPDATE;
  -- A CHECKOUT_PAGE payment with no order is not a family order (only the internal 0529 opener can make one): left alone.
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NEW.state='SUCCEEDED' THEN
    next:=CASE WHEN o.status='OPEN' AND o.amount_minor=NEW.amount_minor AND o.currency=NEW.currency::text THEN 'PAID' ELSE 'REVIEW' END;
  ELSE
    IF o.status<>'OPEN' OR hon.family_checkout_payment_live(o.id) THEN RETURN NULL; END IF;
    next:='CANCELED';
  END IF;
  IF o.status<>'OPEN' THEN
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
      VALUES(NEW.organization_id,NEW.school_id,svc,'SYSTEM_SERVICE','family_checkout.review_needed','SCHOOL_PAY_ONCE',NEW.id,NULL,
        jsonb_build_object('paymentId',NEW.id,'orderId',NEW.source_id,'amountMinor',NEW.amount_minor,'currency',NEW.currency::text),'SUCCEEDED',request,NEW.id);
    INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
      VALUES(NEW.organization_id,NEW.school_id,'family_checkout.review_needed',1,'SCHOOL_PAY_ONCE',NEW.id,NEW.version,NEW.id,request,
        jsonb_build_object('paymentId',NEW.id,'orderId',NEW.source_id));
    RETURN NULL;
  END IF;
  UPDATE hon.family_checkout_orders SET status=next,settled_at=clock_timestamp(),version=version+1 WHERE id=o.id RETURNING * INTO o;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(o.organization_id,o.school_id,svc,'SYSTEM_SERVICE','family_checkout.order_'||lower(next),'FAMILY_CHECKOUT_ORDER',o.id,jsonb_build_object('status','OPEN'),
      jsonb_build_object('orderId',o.id,'onceId',NEW.id,'status',o.status,'amountMinor',o.amount_minor,'currency',o.currency),'SUCCEEDED',request,NEW.id);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(o.organization_id,o.school_id,'family_checkout.order_'||lower(next),1,'FAMILY_CHECKOUT_ORDER',o.id,o.version,NEW.id,request,
      jsonb_build_object('orderId',o.id,'checkoutId',o.checkout_id,'status',o.status));
  RETURN NULL;
END $$;
CREATE TRIGGER family_checkout_settle AFTER UPDATE ON hon.school_pay_once
  FOR EACH ROW WHEN (NEW.source='CHECKOUT_PAGE' AND NEW.state IN ('SUCCEEDED','FAILED','EXPIRED','CANCELED') AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION hon.settle_family_checkout_order();

COMMENT ON FUNCTION hon.read_parent_checkout_pages(text) IS
'0582 API-only: the school''s published checkout pages with one-time options a family can buy, the family''s children and latest orders. No DML.';
COMMENT ON FUNCTION hon.open_parent_checkout_order(text,jsonb,text) IS
'0582 API-only: a guardian''s checkout order for their own children, priced by the page, with its one-time payment opened (test mode only).';
COMMENT ON FUNCTION hon.read_parent_checkout_order(text,uuid) IS
'0582 API-only: an order of the guardian''s family and its latest payment id (for start, confirm and cancel). No DML.';
COMMENT ON FUNCTION hon.read_school_checkout_orders(text) IS
'0582 staff read (school_checkout.manage): the school''s latest 200 family checkout orders. No DML.';

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_parent_checkout_pages(text)','hon.open_parent_checkout_order(text,jsonb,text)','hon.read_parent_checkout_order(text,uuid)',
    'hon.read_school_checkout_orders(text)'];
  fns text[]:=ARRAY['hon.guard_family_checkout_order()','hon.family_checkout_scope(text,boolean)','hon.family_checkout_children(uuid,uuid,uuid)',
    'hon.family_checkout_today(uuid)','hon.family_checkout_payment_live(uuid)','hon.family_checkout_taken(uuid,text)','hon.family_checkout_en(jsonb)',
    'hon.family_checkout_option_open(jsonb,date)','hon.family_checkout_page_json(hon.school_checkouts,date)',
    'hon.family_checkout_order_json(hon.family_checkout_orders)','hon.settle_family_checkout_order()']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.family_checkout_orders FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.family_checkout_orders FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
    IF EXISTS(SELECT 1 FROM unnest(fns) f2 WHERE f2<>ALL(entry) AND has_function_privilege('hon_runtime',f2,'EXECUTE'))
      OR has_table_privilege('hon_runtime','hon.family_checkout_orders','SELECT') OR has_table_privilege('hon_runtime','hon.family_checkout_orders','INSERT')
      OR has_function_privilege('hon_runtime','hon.school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz)','EXECUTE') THEN
      RAISE EXCEPTION 'Family checkout helpers and table must stay private';
    END IF;
  END IF;
END $$;

COMMIT;
