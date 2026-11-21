BEGIN;

-- Checkout page share links (0620, coordinator-allocated 2026-11-21; docs/architecture/TUITION_COLLECTION.md §25).
-- Owner ask (David, 2026-11-21, testing the live app): "checkout page how do i get link to show the page". Until now a
-- checkout page (0402) was seen only by signed-in guardians in the HON Family app (0598).
--   L1  hon.school_checkout_links: one link per checkout page, an unguessable 48-hex public id (24 random bytes). A link
--       is issued once and never changes, moves or is deleted; the page's own status decides whether it opens.
--   L2  issue_school_checkout_links: staff with school_checkout.manage (the 0269 actor rule, re-checked after the work)
--       get every page's link, issuing any that are missing for the school's pages (at most 200). Re-running it issues
--       nothing new, so it needs no Idempotency-Key. One audit row per issued link; no outbox event (nothing to tell).
--   L3  read_public_school_checkout: anyone with the link reads a whitelisted copy of a PUBLISHED page of an ACTIVE school
--       and organization with a live entitlement (the 0261 public event rule). Draft, archived, unknown or malformed links
--       read as nothing. Only options still available on the school's today are listed, with places left; no ids, plans,
--       collection methods, answers, orders, receipt text or staff names. No row is written.
-- Nothing here takes a payment, creates a lead or family, sends a message or adds a fee. Signing up from the link for
-- people without an account is the next slice.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Checkout page links require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Checkout page links require a restricted runtime';
  END IF;
  IF to_regclass('hon.school_checkouts') IS NULL OR to_regprocedure('hon.require_school_checkout_actor(text)') IS NULL
    OR to_regprocedure('hon.family_checkout_taken(uuid,text)') IS NULL OR to_regprocedure('hon.family_checkout_today(uuid)') IS NULL
    OR to_regprocedure('hon.family_checkout_option_open(jsonb,date)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL THEN
    RAISE EXCEPTION 'Checkout page links require 0177, 0269, 0402 and 0598';
  END IF;
END $$;

-- L1: one link per page.
CREATE TABLE hon.school_checkout_links (
  checkout_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  public_id text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24),'hex') CHECK (public_id ~ '^[a-f0-9]{48}$'),
  issued_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (checkout_id,school_id) REFERENCES hon.school_checkouts(id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE INDEX school_checkout_links_school ON hon.school_checkout_links(school_id,organization_id);
ALTER TABLE hon.school_checkout_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_checkout_links FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_checkout_links_no_truncate BEFORE TRUNCATE ON hon.school_checkout_links
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- A link is issued once for a page of its own school and never changes or goes away.
CREATE FUNCTION hon.guard_school_checkout_link() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'A checkout page link never changes and is never deleted' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.school_checkouts c WHERE c.id=NEW.checkout_id AND c.organization_id=NEW.organization_id AND c.school_id=NEW.school_id) THEN
    RAISE EXCEPTION 'A checkout page link belongs to a page of its own school' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_checkout_links_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_checkout_links
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_checkout_link();

-- L2: every page's link for staff, issuing the missing ones.
CREATE FUNCTION hon.issue_school_checkout_links(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; request uuid:=gen_random_uuid(); l record; links jsonb;
BEGIN
  actor:=hon.require_school_checkout_actor(subject);
  FOR l IN INSERT INTO hon.school_checkout_links(checkout_id,organization_id,school_id,issued_by_principal_id)
      SELECT c.id,c.organization_id,c.school_id,actor FROM (SELECT x.id,x.organization_id,x.school_id FROM hon.school_checkouts x
        WHERE x.organization_id=org AND x.school_id=school ORDER BY x.created_at,x.id LIMIT 200) c
      WHERE NOT EXISTS(SELECT 1 FROM hon.school_checkout_links k WHERE k.checkout_id=c.id)
      ON CONFLICT (checkout_id) DO NOTHING RETURNING checkout_id LOOP
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
      VALUES(org,school,actor,'HUMAN_UI','school_checkout.link_issued','SCHOOL_CHECKOUT',l.checkout_id,NULL,jsonb_build_object('pageId',l.checkout_id),'SUCCEEDED',request,request);
  END LOOP;
  SELECT coalesce(jsonb_agg(jsonb_build_object('pageId',k.checkout_id,'publicId',k.public_id) ORDER BY k.checkout_id),'[]'::jsonb) INTO links
  FROM (SELECT * FROM hon.school_checkout_links x WHERE x.organization_id=org AND x.school_id=school ORDER BY x.checkout_id LIMIT 200) k;
  IF hon.require_school_checkout_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('links',links);
END $$;

-- The page a link may show: PUBLISHED, of an ACTIVE school and organization with a live entitlement.
CREATE FUNCTION hon.public_school_checkout(pid text) RETURNS hon.school_checkouts
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT c.* FROM hon.school_checkout_links k
  JOIN hon.school_checkouts c ON c.id=k.checkout_id AND c.school_id=k.school_id AND c.organization_id=k.organization_id
  JOIN hon.organizations o ON o.id=c.organization_id JOIN hon.schools s ON s.id=c.school_id AND s.organization_id=c.organization_id
  WHERE pid ~ '^[a-f0-9]{48}$' AND k.public_id=pid AND c.status='PUBLISHED' AND o.status='ACTIVE' AND s.status='ACTIVE'
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements x WHERE x.organization_id=c.organization_id AND x.tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND x.status='ACTIVE' AND x.effective_from<=clock_timestamp() AND (x.effective_until IS NULL OR x.effective_until>clock_timestamp()))
$$;

-- L3: the whitelisted public copy, or NULL. Text stays in the page's languages (en, plus ko/es when written).
CREATE FUNCTION hon.read_public_school_checkout(pid text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.school_checkouts%ROWTYPE; today date; school_name text;
BEGIN
  IF pid IS NULL OR pid !~ '^[a-f0-9]{48}$' THEN RETURN NULL; END IF;
  c:=hon.public_school_checkout(pid);
  IF c.id IS NULL THEN RETURN NULL; END IF;
  today:=hon.family_checkout_today(c.school_id);
  SELECT s.name INTO school_name FROM hon.schools s WHERE s.id=c.school_id AND s.organization_id=c.organization_id;
  RETURN jsonb_build_object('publicId',pid,'schoolName',school_name,'title',c.content->'title','description',c.content->'description',
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
    'addOns',coalesce((SELECT jsonb_agg(jsonb_build_object('label',a->'label','amountMinor',a->'amountMinor','required',(a->>'required')::boolean) ORDER BY n)
      FROM jsonb_array_elements(c.content->'addOns') WITH ORDINALITY y(a,n)),'[]'::jsonb),
    'hasWaiver',jsonb_typeof(c.content->'waiver')='object');
END $$;

COMMENT ON FUNCTION hon.issue_school_checkout_links(text) IS
'0620 staff (school_checkout.manage): every checkout page''s share link, issuing missing ones. Writes links and audit only.';
COMMENT ON FUNCTION hon.read_public_school_checkout(text) IS
'0620 public: a whitelisted copy of the PUBLISHED checkout page a share link names, or NULL. No DML.';

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.issue_school_checkout_links(text)','hon.read_public_school_checkout(text)'];
  fns text[]:=ARRAY['hon.guard_school_checkout_link()','hon.public_school_checkout(text)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.school_checkout_links FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.school_checkout_links FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
    IF EXISTS(SELECT 1 FROM unnest(fns) f2 WHERE f2<>ALL(entry) AND has_function_privilege('hon_runtime',f2,'EXECUTE'))
      OR has_table_privilege('hon_runtime','hon.school_checkout_links','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'Checkout page link helpers and table must stay private';
    END IF;
  END IF;
END $$;

COMMIT;
