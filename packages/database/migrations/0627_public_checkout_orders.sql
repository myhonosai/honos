BEGIN;

-- Sign up and pay from a checkout page's share link (0627, assigned by the coordinator 2026-11-21; docs/architecture/
-- TUITION_COLLECTION.md §26). Owner ask (2026-11-21): a family without an HON account opens the page's link (0620) and
-- signs up. TEST/SANDBOX mode only, through the shared one-time payment (0529) on the school's own processor page; the
-- connection table already refuses LIVE. HON adds no fee. No message, CRM lead, student record, account or AI.
--   P1  What may be bought is what the HON Family app sells (0598): a ONE_TIME option of the PUBLISHED page the link names,
--       with no plan, not creating a membership, available on the school's today and within capacity. The page's version,
--       questions, add-ons and waiver are checked exactly as 0598 does. Price comes only from the page.
--   P2  Who: a buyer name, an email (required: it is the only detail the processor gets) and an optional mobile, typed by
--       the person; 1 to maxPerOrder participants by name, each with the page's answers. A hidden website field must be empty.
--   P3  The browser makes a random key (32-100 URL-safe characters) and keeps it. The key is the order's idempotency key and
--       its only proof of ownership: the database keeps its SHA-256, an exact repeat returns the same order, another
--       request under it is INVALID, and pay, status and cancel name the order only by link + key. No order or payment id is
--       ever taken from the browser; the API gets the payment id only from these functions (0529 caller rule).
--   P4  Places count PAID and payable OPEN orders of both kinds (0598 family_checkout_taken now sums both), under the page lock.
--   P5  Settling is the 0598 rule in its own trigger: SUCCEEDED for the same amount makes the order PAID; FAILED, EXPIRED or
--       CANCELED makes it CANCELED; a success for an order no longer OPEN is flagged for staff review. Nothing is refunded.
--   P6  Limits per page: 300 well-formed new order attempts and 1200 unknown-key lookups per rolling hour (a known key is always answered); 5 placed orders per email per rolling
--       hour (mistakes do not count); at most 500 placed orders per rolling day. Public answers carry results only (never PostgreSQL detail, names or emails).
--   P7  Staff with school_checkout.manage read the school's latest 200 link orders (buyer, participants, answers, state).
-- The runtime gains no table privilege; public writes run as a code-owned SYSTEM_SERVICE principal with no roles.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Public checkout orders require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Public checkout orders require a restricted runtime';
  END IF;
  IF to_regclass('hon.school_checkout_links') IS NULL OR to_regclass('hon.family_checkout_orders') IS NULL
    OR to_regprocedure('hon.public_school_checkout(text)') IS NULL OR to_regprocedure('hon.family_checkout_payment_live(uuid)') IS NULL
    OR to_regprocedure('hon.school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz)') IS NULL
    OR to_regprocedure('hon.school_event_text_ok(text,integer,integer)') IS NULL OR to_regprocedure('hon.school_pay_instant(timestamptz)') IS NULL
    OR to_regprocedure('hon.require_school_checkout_actor(text)') IS NULL THEN
    RAISE EXCEPTION 'Public checkout orders require 0261, 0402, 0529, 0598 and 0620';
  END IF;
END $$;

-- Code-owned public checkout intake and recorder. No user, role, HQ, family or delegated authority belongs to it.
INSERT INTO hon.principals(id,principal_type,display_name)
  VALUES('00000000-0000-4000-8000-000000000627','SYSTEM_SERVICE','Code-owned public checkout order intake');

CREATE TABLE hon.public_checkout_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  checkout_id uuid NOT NULL,
  checkout_version integer NOT NULL CHECK (checkout_version>=1),
  option_key text NOT NULL CHECK (option_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  buyer_name text NOT NULL CHECK (hon.school_event_text_ok(buyer_name,1,120)),
  email text NOT NULL CHECK (length(email)<=254 AND email=lower(email)
    AND email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$'),
  mobile text CHECK (mobile IS NULL OR mobile ~ '^\+[1-9][0-9]{6,14}$'),
  -- [{name, answers:{key: string|boolean}}], 1..10.
  participants jsonb NOT NULL CHECK (jsonb_typeof(participants)='array' AND jsonb_array_length(participants) BETWEEN 1 AND 10),
  add_on_keys jsonb NOT NULL CHECK (jsonb_typeof(add_on_keys)='array' AND jsonb_array_length(add_on_keys)<=10),
  waiver_sha256 text CHECK (waiver_sha256 IS NULL OR waiver_sha256 ~ '^[0-9a-f]{64}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 5000000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAID','CANCELED','REVIEW')),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  CHECK ((status='OPEN')=(settled_at IS NULL)),
  UNIQUE (checkout_id,key_hash),
  FOREIGN KEY (checkout_id,school_id) REFERENCES hon.school_checkouts(id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE INDEX public_checkout_orders_checkout ON hon.public_checkout_orders(checkout_id,option_key,status);
CREATE INDEX public_checkout_orders_email ON hon.public_checkout_orders(checkout_id,email,created_at DESC);
CREATE INDEX public_checkout_orders_school ON hon.public_checkout_orders(school_id,created_at DESC,id);

-- P6: hourly public attempt counters per page (two fixed buckets; nothing about people).
CREATE TABLE hon.public_checkout_rates (
  checkout_id uuid NOT NULL REFERENCES hon.school_checkouts(id) ON DELETE RESTRICT,
  bucket text NOT NULL CHECK (bucket IN ('ORDER_ATTEMPTS','LOOKUP_ATTEMPTS')),
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 100001),
  PRIMARY KEY (checkout_id,bucket)
);
ALTER TABLE hon.public_checkout_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.public_checkout_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.public_checkout_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.public_checkout_rates FORCE ROW LEVEL SECURITY;
CREATE TRIGGER public_checkout_orders_no_truncate BEFORE TRUNCATE ON hon.public_checkout_orders
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- An order never changes what was bought, by whom or for how much, and is never deleted. It is created OPEN (or PAID
-- when free) and moves once from OPEN to PAID, CANCELED or REVIEW, with the version moving on by one.
CREATE FUNCTION hon.guard_public_checkout_order() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Public checkout orders are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NOT (NEW.status='OPEN' OR (NEW.status='PAID' AND NEW.amount_minor=0)) THEN
      RAISE EXCEPTION 'A new public checkout order is OPEN, or PAID when free' USING ERRCODE='55000'; END IF;
    IF NOT EXISTS(SELECT 1 FROM hon.school_checkouts c WHERE c.id=NEW.checkout_id AND c.school_id=NEW.school_id AND c.organization_id=NEW.organization_id) THEN
      RAISE EXCEPTION 'A public checkout order belongs to a page of its own school' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.checkout_id,NEW.checkout_version,NEW.option_key,NEW.buyer_name,NEW.email,NEW.mobile,NEW.participants,
      NEW.add_on_keys,NEW.waiver_sha256,NEW.title,NEW.amount_minor,NEW.currency,NEW.key_hash,NEW.payload_hash,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.checkout_id,OLD.checkout_version,OLD.option_key,OLD.buyer_name,OLD.email,OLD.mobile,OLD.participants,
      OLD.add_on_keys,OLD.waiver_sha256,OLD.title,OLD.amount_minor,OLD.currency,OLD.key_hash,OLD.payload_hash,OLD.created_at)
    OR OLD.status<>'OPEN' OR NEW.status NOT IN ('PAID','CANCELED','REVIEW') OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'A public checkout order is settled once and never changes' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_checkout_orders_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.public_checkout_orders
  FOR EACH ROW EXECUTE FUNCTION hon.guard_public_checkout_order();

-- P4: places an option has taken, now from both family (0598) and link (0627) orders.
CREATE OR REPLACE FUNCTION hon.family_checkout_taken(checkout uuid,option_key text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT (SELECT coalesce(sum(jsonb_array_length(o.participants)),0) FROM hon.family_checkout_orders o
      WHERE o.checkout_id=checkout AND o.option_key=family_checkout_taken.option_key
        AND (o.status='PAID' OR (o.status='OPEN' AND hon.family_checkout_payment_live(o.id))))::bigint
    +(SELECT coalesce(sum(jsonb_array_length(o.participants)),0) FROM hon.public_checkout_orders o
      WHERE o.checkout_id=checkout AND o.option_key=family_checkout_taken.option_key
        AND (o.status='PAID' OR (o.status='OPEN' AND hon.family_checkout_payment_live(o.id))))::bigint
$$;

-- One hourly counter: true while under the limit.
CREATE FUNCTION hon.take_public_checkout_rate(checkout uuid,bucket_name text,limit_count integer) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; asof timestamptz:=clock_timestamp();
BEGIN
  INSERT INTO hon.public_checkout_rates(checkout_id,bucket,window_start,attempts) VALUES(checkout,bucket_name,asof,1)
  ON CONFLICT(checkout_id,bucket) DO UPDATE SET
    window_start=CASE WHEN hon.public_checkout_rates.window_start<=asof-interval '1 hour' THEN asof ELSE hon.public_checkout_rates.window_start END,
    attempts=CASE WHEN hon.public_checkout_rates.window_start<=asof-interval '1 hour' THEN 1 ELSE least(hon.public_checkout_rates.attempts+1,100001) END
  RETURNING attempts INTO n;
  RETURN n<=limit_count;
END $$;

-- The code-owned intake principal still has no authority (checked on every write).
CREATE FUNCTION hon.public_checkout_intake_ok() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000627' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active)
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000627')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id='00000000-0000-4000-8000-000000000627')
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id='00000000-0000-4000-8000-000000000627')
$$;

-- The order a key names on the page a link names, or nothing.
CREATE FUNCTION hon.public_checkout_order_for(checkout uuid,key text) RETURNS hon.public_checkout_orders
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT o.* FROM hon.public_checkout_orders o
  WHERE key ~ '^[A-Za-z0-9_-]{32,100}$' AND o.checkout_id=checkout
    AND o.key_hash=encode(sha256(convert_to('hon-public-checkout:'||checkout::text||':'||key,'UTF8')),'hex')
$$;

-- One order as the person who placed it sees it (no buyer details, no payment id).
CREATE FUNCTION hon.public_checkout_order_json(o hon.public_checkout_orders) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('orderId',o.id,'title',o.title,'optionKey',o.option_key,
    'participantCount',jsonb_array_length(o.participants),'amountMinor',o.amount_minor,'currency',o.currency,
    'status',CASE WHEN o.status='OPEN' AND NOT hon.family_checkout_payment_live(o.id) THEN 'UNPAID' ELSE o.status END,
    'createdAt',hon.school_pay_instant(o.created_at))
$$;

-- L3 (0620) again, for the sign-up form: adds the page version, add-on keys, the questions, the waiver and thank-you
-- text, and the school's provider code (for the API only: it decides whether card payment is offered).
CREATE OR REPLACE FUNCTION hon.read_public_school_checkout(pid text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.school_checkouts%ROWTYPE; today date; school_name text;
BEGIN
  IF pid IS NULL OR pid !~ '^[a-f0-9]{48}$' THEN RETURN NULL; END IF;
  c:=hon.public_school_checkout(pid);
  IF c.id IS NULL THEN RETURN NULL; END IF;
  today:=hon.family_checkout_today(c.school_id);
  SELECT s.name INTO school_name FROM hon.schools s WHERE s.id=c.school_id AND s.organization_id=c.organization_id;
  RETURN jsonb_build_object('publicId',pid,'schoolName',school_name,'version',c.version,'title',c.content->'title','description',c.content->'description',
    'currency',c.content->>'currency','maxParticipants',(c.content->'multiParticipant'->>'maxPerOrder')::integer,
    'blocks',coalesce((SELECT jsonb_agg(jsonb_build_object('position',b->>'position','text',b->'text') ORDER BY n) FROM jsonb_array_elements(c.content->'blocks') WITH ORDINALITY y(b,n)),'[]'::jsonb),
    'options',coalesce((SELECT jsonb_agg(jsonb_build_object('key',o->>'key','label',o->'label','description',o->'description','billing',o->>'billing',
        'priceMinor',o->'priceMinor','recurringMinor',o->'recurringMinor','installments',o->'installments',
        'downPayment',CASE WHEN jsonb_typeof(o->'downPayment')='object' THEN jsonb_build_object('amountMinor',o->'downPayment'->'amountMinor','label',o->'downPayment'->'label') ELSE 'null'::jsonb END,
        'additionalParticipantMinor',o->'additionalParticipantMinor','mostPopular',(o->>'mostPopular')::boolean,
        'placesLeft',CASE WHEN (o->>'capacity')::bigint=0 THEN NULL ELSE greatest((o->>'capacity')::bigint-hon.family_checkout_taken(c.id,o->>'key'),0) END,
        'inFamilyApp',hon.family_checkout_option_open(o,today)) ORDER BY n)
      FROM jsonb_array_elements(c.content->'options') WITH ORDINALITY y(o,n)
      WHERE jsonb_typeof(o->'availableThrough')='null' OR (o->>'availableThrough')::date>=today),'[]'::jsonb),
    'addOns',coalesce((SELECT jsonb_agg(jsonb_build_object('key',a->>'key','label',a->'label','amountMinor',a->'amountMinor','required',(a->>'required')::boolean) ORDER BY n)
      FROM jsonb_array_elements(c.content->'addOns') WITH ORDINALITY y(a,n)),'[]'::jsonb),
    'questions',coalesce((SELECT jsonb_agg(jsonb_build_object('key',f->>'key','label',f->'label','kind',f->>'kind','required',(f->>'required')::boolean,
        'options',f->'options') ORDER BY n) FROM jsonb_array_elements(c.content->'customFields') WITH ORDINALITY y(f,n)),'[]'::jsonb),
    'hasWaiver',jsonb_typeof(c.content->'waiver')='object',
    'waiver',CASE WHEN jsonb_typeof(c.content->'waiver')='object' THEN c.content->'waiver'->'text' ELSE 'null'::jsonb END,
    'thankYou',c.content->'thankYou',
    'providerCode',hon.school_pay_once_provider(c.organization_id,c.school_id));
END $$;

-- P1-P4, P6: place an order from a link. Returns {result}: OPEN or PAID (with orderId, amountMinor, currency, replayed),
-- or INVALID, CHANGED, UNAVAILABLE, FULL, WAIVER_REQUIRED, NOT_AVAILABLE or RATE_LIMITED. can_pay is the API's answer to
-- whether the school's processor can show a hosted page; a priced order is refused (NOT_AVAILABLE) without it.
CREATE FUNCTION hon.open_public_checkout_order(pid text,p jsonb,key text,can_pay boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE svc constant uuid:='00000000-0000-4000-8000-000000000627'; c hon.school_checkouts%ROWTYPE; o jsonb; prior hon.public_checkout_orders%ROWTYPE;
  ord hon.public_checkout_orders%ROWTYPE; today date; kh text; ph text; n integer; each_extra bigint; total bigint; addons jsonb; parts jsonb:='[]'::jsonb;
  part jsonb; f jsonb; ans jsonb; v jsonb; payment uuid; request uuid:=gen_random_uuid(); title text; b_name text; b_email text; b_mobile text;
BEGIN
  IF pid IS NULL OR pid !~ '^[a-f0-9]{48}$' OR key IS NULL OR key !~ '^[A-Za-z0-9_-]{32,100}$' OR can_pay IS NULL THEN
    RETURN jsonb_build_object('result','INVALID'); END IF;
  c:=hon.public_school_checkout(pid);
  IF c.id IS NULL OR NOT hon.public_checkout_intake_ok() THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  -- Shape first (P2): exactly these keys, sizes bounded; nothing is written for a malformed request.
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>16384
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['addOns','buyer','expectedVersion','optionKey','participants','waiverAccepted','website']
    OR jsonb_typeof(p->'website') IS DISTINCT FROM 'string' OR p->>'website'<>''
    OR jsonb_typeof(p->'buyer') IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p->'buyer') k) IS DISTINCT FROM ARRAY['email','mobile','name']
    OR jsonb_typeof(p->'buyer'->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'buyer'->'email') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p->'buyer'->'mobile') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR p->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'optionKey') IS DISTINCT FROM 'string' OR p->>'optionKey' !~ '^[a-z][a-z0-9_]{0,39}$'
    OR jsonb_typeof(p->'waiverAccepted') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p->'addOns') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'addOns')>10
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'addOns') a WHERE jsonb_typeof(a)<>'string')
    OR (SELECT count(DISTINCT a) FROM jsonb_array_elements_text(p->'addOns') a)<>jsonb_array_length(p->'addOns')
    OR jsonb_typeof(p->'participants') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'participants') NOT BETWEEN 1 AND 10
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'participants') x WHERE jsonb_typeof(x)<>'object'
      OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(x) k) IS DISTINCT FROM ARRAY['answers','name']
      OR jsonb_typeof(x->'name')<>'string' OR NOT hon.school_event_text_ok(x->>'name',1,120)
      OR jsonb_typeof(x->'answers')<>'object') THEN
    RETURN jsonb_build_object('result','INVALID'); END IF;
  b_name:=p->'buyer'->>'name'; b_email:=lower(p->'buyer'->>'email'); b_mobile:=p->'buyer'->>'mobile';
  IF NOT hon.school_event_text_ok(b_name,1,120) OR length(b_email)>254 OR length(b_mobile)>16
    OR b_email !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$'
    OR (b_mobile<>'' AND b_mobile !~ '^\+[1-9][0-9]{6,14}$') THEN
    RETURN jsonb_build_object('result','INVALID'); END IF;
  -- P3: an exact repeat under the same key returns the same order, whatever has happened since.
  kh:=encode(sha256(convert_to('hon-public-checkout:'||c.id::text||':'||key,'UTF8')),'hex');
  ph:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.public_checkout_orders x WHERE x.checkout_id=c.id AND x.key_hash=kh;
  IF FOUND THEN
    IF prior.payload_hash<>ph THEN RETURN jsonb_build_object('result','INVALID'); END IF;
    RETURN jsonb_build_object('result',CASE WHEN prior.status='PAID' THEN 'PAID' ELSE 'OPEN' END,'orderId',prior.id,'amountMinor',prior.amount_minor,
      'currency',prior.currency,'replayed',true);
  END IF;
  -- Only a well-formed new order counts toward the page's attempts (a malformed body or a replay does not).
  DELETE FROM hon.public_checkout_rates WHERE checkout_id=c.id AND window_start<=clock_timestamp()-interval '1 hour';
  IF NOT hon.take_public_checkout_rate(c.id,'ORDER_ATTEMPTS',300) THEN RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
  -- Lock order: page -> (0529) school -> connection -> payment, as 0598.
  SELECT * INTO c FROM hon.school_checkouts x WHERE x.id=c.id FOR UPDATE;
  -- A same-key submit that won the lock first is replayed here rather than failing on the unique key.
  SELECT * INTO prior FROM hon.public_checkout_orders x WHERE x.checkout_id=c.id AND x.key_hash=kh;
  IF FOUND THEN
    IF prior.payload_hash<>ph THEN RETURN jsonb_build_object('result','INVALID'); END IF;
    RETURN jsonb_build_object('result',CASE WHEN prior.status='PAID' THEN 'PAID' ELSE 'OPEN' END,'orderId',prior.id,'amountMinor',prior.amount_minor,
      'currency',prior.currency,'replayed',true);
  END IF;
  -- The link is decided again after the lock, so a page taken down meanwhile cannot sell.
  IF (hon.public_school_checkout(pid)).id IS DISTINCT FROM c.id OR c.status<>'PUBLISHED' THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  IF c.version<>(p->>'expectedVersion')::integer THEN RETURN jsonb_build_object('result','CHANGED'); END IF;
  IF (SELECT count(*) FROM hon.public_checkout_orders x WHERE x.checkout_id=c.id AND x.created_at>clock_timestamp()-interval '1 day')>=500
    OR (SELECT count(*) FROM hon.public_checkout_orders x WHERE x.checkout_id=c.id AND x.email=b_email AND x.created_at>clock_timestamp()-interval '1 hour')>=5 THEN
    RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
  today:=hon.family_checkout_today(c.school_id);
  SELECT x INTO o FROM jsonb_array_elements(c.content->'options') x WHERE x->>'key'=p->>'optionKey';
  IF o IS NULL OR NOT hon.family_checkout_option_open(o,today) THEN RETURN jsonb_build_object('result','UNAVAILABLE'); END IF;
  n:=jsonb_array_length(p->'participants');
  IF n>(c.content->'multiParticipant'->>'maxPerOrder')::integer THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  -- Answers: exactly the page's questions, for each participant (the 0598 rules).
  FOR part IN SELECT x FROM jsonb_array_elements(p->'participants') x LOOP
    ans:=part->'answers';
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(ans) k WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.content->'customFields') q WHERE q->>'key'=k)) THEN
      RETURN jsonb_build_object('result','INVALID'); END IF;
    FOR f IN SELECT q FROM jsonb_array_elements(c.content->'customFields') q LOOP
      v:=ans->(f->>'key');
      IF v IS NULL THEN
        IF (f->>'required')::boolean THEN RETURN jsonb_build_object('result','INVALID'); END IF;
      ELSIF f->>'kind'='CHECKBOX' THEN
        IF jsonb_typeof(v)<>'boolean' OR ((f->>'required')::boolean AND v<>'true'::jsonb) THEN RETURN jsonb_build_object('result','INVALID'); END IF;
      ELSIF f->>'kind'='CHOICE' THEN
        IF jsonb_typeof(v)<>'string' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f->'options') x WHERE x->>'en'=v#>>'{}') THEN
          RETURN jsonb_build_object('result','INVALID'); END IF;
      ELSE
        IF jsonb_typeof(v)<>'string' OR length(v#>>'{}')>500 OR btrim(v#>>'{}')='' OR (v#>>'{}') ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' THEN
          RETURN jsonb_build_object('result','INVALID'); END IF;
      END IF;
    END LOOP;
    parts:=parts||jsonb_build_array(jsonb_build_object('name',part->>'name','answers',ans));
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'addOns') k WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.content->'addOns') a WHERE a->>'key'=k))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.content->'addOns') a WHERE (a->>'required')::boolean AND NOT (p->'addOns') ? (a->>'key')) THEN
    RETURN jsonb_build_object('result','INVALID'); END IF;
  IF jsonb_typeof(c.content->'waiver')='object' AND (p->>'waiverAccepted')<>'true' THEN RETURN jsonb_build_object('result','WAIVER_REQUIRED'); END IF;
  IF (o->>'capacity')::bigint>0 AND hon.family_checkout_taken(c.id,o->>'key')+n>(o->>'capacity')::bigint THEN
    RETURN jsonb_build_object('result','FULL'); END IF;
  each_extra:=CASE WHEN jsonb_typeof(o->'additionalParticipantMinor')='number' THEN (o->>'additionalParticipantMinor')::bigint ELSE (o->>'priceMinor')::bigint END;
  SELECT coalesce(jsonb_agg(k ORDER BY k),'[]'::jsonb) INTO addons FROM jsonb_array_elements_text(p->'addOns') k;
  total:=(o->>'priceMinor')::bigint+each_extra*(n-1)
    +coalesce((SELECT sum((a->>'amountMinor')::bigint) FROM jsonb_array_elements(c.content->'addOns') a WHERE (p->'addOns') ? (a->>'key')),0);
  IF total>0 AND (NOT can_pay OR hon.school_pay_once_provider(c.organization_id,c.school_id) IS NULL) THEN
    RETURN jsonb_build_object('result','NOT_AVAILABLE'); END IF;
  title:=btrim(left(hon.family_checkout_en(c.content->'title')||' - '||hon.family_checkout_en(o->'label'),120));
  INSERT INTO hon.public_checkout_orders(organization_id,school_id,checkout_id,checkout_version,option_key,buyer_name,email,mobile,participants,add_on_keys,
      waiver_sha256,title,amount_minor,currency,status,key_hash,payload_hash,settled_at)
    VALUES(c.organization_id,c.school_id,c.id,c.version,o->>'key',b_name,b_email,nullif(b_mobile,''),parts,addons,
      CASE WHEN jsonb_typeof(c.content->'waiver')='object' THEN encode(sha256(convert_to(c.content->'waiver'->>'text','UTF8')),'hex') END,
      title,total,c.content->>'currency',CASE WHEN total=0 THEN 'PAID' ELSE 'OPEN' END,kh,ph,CASE WHEN total=0 THEN clock_timestamp() END)
    RETURNING * INTO ord;
  IF total>0 THEN
    payment:=hon.school_pay_once_open(ord.organization_id,ord.school_id,'CHECKOUT_PAGE',ord.id,total,ord.currency,
      jsonb_build_object('name',ord.title),jsonb_build_object('email',ord.email),clock_timestamp()+interval '30 minutes');
  END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(ord.organization_id,ord.school_id,svc,'PUBLIC_API','public_checkout.order_open','PUBLIC_CHECKOUT_ORDER',ord.id,NULL,
      jsonb_build_object('orderId',ord.id,'checkoutId',ord.checkout_id,'optionKey',ord.option_key,'participantCount',n,'amountMinor',total,'currency',ord.currency,'status',ord.status),
      'SUCCEEDED',request,request);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(ord.organization_id,ord.school_id,CASE WHEN total=0 THEN 'public_checkout.order_paid' ELSE 'public_checkout.order_opened' END,1,'PUBLIC_CHECKOUT_ORDER',ord.id,ord.version,request,request,
      jsonb_build_object('orderId',ord.id,'checkoutId',ord.checkout_id,'status',ord.status,'internalOnly',true));
  RETURN jsonb_build_object('result',ord.status,'orderId',ord.id,'amountMinor',total,'currency',ord.currency,'replayed',false);
END $$;

-- P3: the order a link + key names and its latest payment, for the API's pay, status and cancel. Returns {result}: FOUND
-- (with order, paymentId, paymentState, providerCode), INVALID or RATE_LIMITED. Writes only the lookup counter.
CREATE FUNCTION hon.read_public_checkout_order(pid text,key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.school_checkouts%ROWTYPE; o hon.public_checkout_orders%ROWTYPE; x hon.school_pay_once%ROWTYPE;
BEGIN
  IF pid IS NULL OR pid !~ '^[a-f0-9]{48}$' OR key IS NULL OR key !~ '^[A-Za-z0-9_-]{32,100}$' THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  -- The order stays reachable after the page is taken down (it may still need to be confirmed or cancelled), but only
  -- through the link it was placed from.
  SELECT c2.* INTO c FROM hon.school_checkout_links k JOIN hon.school_checkouts c2 ON c2.id=k.checkout_id AND c2.school_id=k.school_id
    AND c2.organization_id=k.organization_id WHERE k.public_id=pid;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  -- A real key is always answered; only misses count, so guessing keys can never lock buyers out of their own order.
  o:=hon.public_checkout_order_for(c.id,key);
  IF o.id IS NULL THEN
    DELETE FROM hon.public_checkout_rates WHERE checkout_id=c.id AND window_start<=clock_timestamp()-interval '1 hour';
    IF NOT hon.take_public_checkout_rate(c.id,'LOOKUP_ATTEMPTS',1200) THEN RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
    RETURN jsonb_build_object('result','INVALID');
  END IF;
  SELECT * INTO x FROM hon.school_pay_once p WHERE p.organization_id=o.organization_id AND p.school_id=o.school_id AND p.source='CHECKOUT_PAGE'
    AND p.source_id=o.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1;
  RETURN jsonb_build_object('result','FOUND','order',hon.public_checkout_order_json(o),'paymentId',x.id,'paymentState',x.state,
    'providerCode',hon.school_pay_once_provider(o.organization_id,o.school_id));
END $$;

-- P7: the school's latest 200 link orders for staff with school_checkout.manage. No DML.
CREATE FUNCTION hon.read_school_public_checkout_orders(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); items jsonb;
BEGIN
  actor:=hon.require_school_checkout_actor(subject);
  SELECT coalesce(jsonb_agg(jsonb_build_object('orderId',o.id,'checkoutId',o.checkout_id,'title',o.title,'optionKey',o.option_key,
      'buyer',jsonb_build_object('name',o.buyer_name,'email',o.email,'mobile',o.mobile),
      'participants',o.participants,'addOnKeys',o.add_on_keys,'waiverAccepted',o.waiver_sha256 IS NOT NULL,'amountMinor',o.amount_minor,'currency',o.currency,
      'status',CASE WHEN o.status='OPEN' AND NOT hon.family_checkout_payment_live(o.id) THEN 'UNPAID' ELSE o.status END,
      'createdAt',hon.school_pay_instant(o.created_at),'settledAt',CASE WHEN o.settled_at IS NULL THEN NULL ELSE hon.school_pay_instant(o.settled_at) END)
    ORDER BY o.created_at DESC,o.id),'[]'::jsonb) INTO items
  FROM (SELECT * FROM hon.public_checkout_orders k WHERE k.organization_id=org AND k.school_id=school ORDER BY k.created_at DESC,k.id LIMIT 200) o;
  IF hon.require_school_checkout_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('orders',items);
END $$;

-- P5: the processor's final answer settles a link order in the same transaction, whoever recorded it (the 0598 rule).
CREATE FUNCTION hon.settle_public_checkout_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE svc constant uuid:='00000000-0000-4000-8000-000000000627'; request uuid:=gen_random_uuid(); o hon.public_checkout_orders%ROWTYPE; next text;
BEGIN
  SELECT * INTO o FROM hon.public_checkout_orders k WHERE k.id=NEW.source_id AND k.organization_id=NEW.organization_id AND k.school_id=NEW.school_id FOR UPDATE;
  -- A CHECKOUT_PAGE payment of a family order (0598) is settled by its own trigger: left alone here.
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NEW.state='SUCCEEDED' THEN
    next:=CASE WHEN o.status='OPEN' AND o.amount_minor=NEW.amount_minor AND o.currency=NEW.currency::text THEN 'PAID' ELSE 'REVIEW' END;
  ELSE
    IF o.status<>'OPEN' OR hon.family_checkout_payment_live(o.id) THEN RETURN NULL; END IF;
    next:='CANCELED';
  END IF;
  IF o.status<>'OPEN' THEN
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
      VALUES(NEW.organization_id,NEW.school_id,svc,'SYSTEM_SERVICE','public_checkout.review_needed','SCHOOL_PAY_ONCE',NEW.id,NULL,
        jsonb_build_object('paymentId',NEW.id,'orderId',NEW.source_id,'amountMinor',NEW.amount_minor,'currency',NEW.currency::text),'SUCCEEDED',request,NEW.id);
    INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
      VALUES(NEW.organization_id,NEW.school_id,'public_checkout.review_needed',1,'SCHOOL_PAY_ONCE',NEW.id,NEW.version,NEW.id,request,
        jsonb_build_object('paymentId',NEW.id,'orderId',NEW.source_id,'internalOnly',true));
    RETURN NULL;
  END IF;
  UPDATE hon.public_checkout_orders SET status=next,settled_at=clock_timestamp(),version=version+1 WHERE id=o.id RETURNING * INTO o;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(o.organization_id,o.school_id,svc,'SYSTEM_SERVICE','public_checkout.order_'||lower(next),'PUBLIC_CHECKOUT_ORDER',o.id,jsonb_build_object('status','OPEN'),
      jsonb_build_object('orderId',o.id,'onceId',NEW.id,'status',o.status,'amountMinor',o.amount_minor,'currency',o.currency),'SUCCEEDED',request,NEW.id);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(o.organization_id,o.school_id,'public_checkout.order_'||lower(next),1,'PUBLIC_CHECKOUT_ORDER',o.id,o.version,NEW.id,request,
      jsonb_build_object('orderId',o.id,'checkoutId',o.checkout_id,'status',o.status,'internalOnly',true));
  RETURN NULL;
END $$;
CREATE TRIGGER public_checkout_settle AFTER UPDATE ON hon.school_pay_once
  FOR EACH ROW WHEN (NEW.source='CHECKOUT_PAGE' AND NEW.state IN ('SUCCEEDED','FAILED','EXPIRED','CANCELED') AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION hon.settle_public_checkout_order();

COMMENT ON TABLE hon.public_checkout_orders IS '0627 orders placed from a checkout page share link by people without an account. Private.';
COMMENT ON FUNCTION hon.open_public_checkout_order(text,jsonb,text,boolean) IS
'0627 public: an order from a share link, priced by the page, with its one-time payment opened (test mode only).';
COMMENT ON FUNCTION hon.read_public_checkout_order(text,text) IS
'0627 public (API only): the order a link + key names and its latest payment id, for pay, status and cancel.';
COMMENT ON FUNCTION hon.read_school_public_checkout_orders(text) IS
'0627 staff read (school_checkout.manage): the school''s latest 200 share link orders. No DML.';

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.open_public_checkout_order(text,jsonb,text,boolean)','hon.read_public_checkout_order(text,text)',
    'hon.read_school_public_checkout_orders(text)'];
  fns text[]:=ARRAY['hon.guard_public_checkout_order()','hon.take_public_checkout_rate(uuid,text,integer)','hon.public_checkout_intake_ok()',
    'hon.public_checkout_order_for(uuid,text)','hon.public_checkout_order_json(hon.public_checkout_orders)',
    'hon.settle_public_checkout_order()','hon.family_checkout_taken(uuid,text)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.public_checkout_orders','hon.public_checkout_rates'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
    IF EXISTS(SELECT 1 FROM unnest(fns) f2 WHERE f2<>ALL(entry) AND has_function_privilege('hon_runtime',f2,'EXECUTE'))
      OR has_table_privilege('hon_runtime','hon.public_checkout_orders','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_table_privilege('hon_runtime','hon.public_checkout_rates','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR NOT has_function_privilege('hon_runtime','hon.read_public_school_checkout(text)','EXECUTE') THEN
      RAISE EXCEPTION 'Public checkout order helpers and tables must stay private';
    END IF;
  END IF;
END $$;

COMMIT;
