BEGIN;

-- "Make my shop" requests (0655, coordinator-allocated 2026-11-22). Spec: docs/architecture/SHOPIFY_COMMERCE.md (New shop).
-- A school with no Shopify store asks HON to make one. No app can create a Shopify store, so HON HQ creates a client transfer
-- store in HON's Shopify Partner Dashboard by hand and transfers it to the school owner, who accepts it by email and sets
-- their own password and billing. HON only keeps the request and its outcome here; nothing in this slice calls Shopify.
-- * The school side (someone holding commerce.shopify.manage at that exact school) reads the school's latest request, makes
--   one (one open request per school, five in any thirty days, never while a store is CONNECTED) and cancels an open one.
-- * The HQ side (HQ owner, or an HQ operator with hq.billing.manage) lists the requests and settles an open one as CREATED
--   (with the new store's myshopify.com address) or DECLINED.
-- * The owner's email is the only personal detail. Audit and outbox carry ids and statuses, never the email, name or note.
-- * Forced RLS with no policy and no client table privilege; the runtime executes five fixed definer functions only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.shopify_begin(text,jsonb,text[])') IS NULL OR to_regprocedure('hon.shopify_edit_text_ok(jsonb,integer,boolean,boolean)') IS NULL
    OR to_regprocedure('hon.require_saas_hq_actor(text,boolean)') IS NULL THEN
    RAISE EXCEPTION '0655 requires 0154, 0405 and 0496 (HQ actor, Shopify connection and edit text check)'; END IF;
END $$;

CREATE TABLE hon.shopify_store_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  shop_name text NOT NULL CHECK (length(shop_name) BETWEEN 1 AND 60 AND shop_name !~ '[\x01-\x1f\x7f]'),
  owner_email text NOT NULL CHECK (length(owner_email)<=254 AND owner_email=lower(owner_email) AND owner_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  note text CHECK (note IS NULL OR (length(note) BETWEEN 1 AND 500 AND note !~ '[\x01-\x09\x0b-\x1f\x7f]')),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','CREATED','DECLINED','CANCELLED')),
  shop_domain text CHECK (shop_domain IS NULL OR shop_domain ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$'),
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_by_principal_id uuid REFERENCES hon.principals(id),
  settled_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE CASCADE,
  CHECK ((status='REQUESTED')=(settled_at IS NULL) AND (settled_at IS NULL)=(settled_by_principal_id IS NULL)),
  CHECK ((status='CREATED')=(shop_domain IS NOT NULL))
);
CREATE UNIQUE INDEX shopify_store_requests_open ON hon.shopify_store_requests (school_id) WHERE status='REQUESTED';
CREATE INDEX shopify_store_requests_school ON hon.shopify_store_requests (school_id,requested_at DESC);
CREATE INDEX shopify_store_requests_recent ON hon.shopify_store_requests (requested_at DESC);
ALTER TABLE hon.shopify_store_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.shopify_store_requests FORCE ROW LEVEL SECURITY;
CREATE TRIGGER shopify_store_requests_no_truncate BEFORE TRUNCATE ON hon.shopify_store_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_shopify();

CREATE FUNCTION hon.shopify_store_request_json(r hon.shopify_store_requests) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('requestId',r.id,'shopName',r.shop_name,'ownerEmail',r.owner_email,'note',r.note,
    'status',r.status,'shopDomain',r.shop_domain,'requestedAt',hon.saas_ts(r.requested_at),'settledAt',hon.saas_ts(r.settled_at),'version',r.version) END
$$;

-- READ (school): the school's latest request, for someone who manages Shopify there.
CREATE FUNCTION hon.read_shopify_store_request(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r hon.shopify_store_requests%ROWTYPE;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.shopify_actor(p_subject,p_school,true) IS NULL THEN RAISE EXCEPTION 'SHOPIFY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM hon.shopify_store_requests WHERE school_id=p_school ORDER BY requested_at DESC,id LIMIT 1;
  RETURN jsonb_build_object('schoolId',p_school,'request',hon.shopify_store_request_json(r));
END $$;

-- REQUEST {schoolId, shopName, ownerEmail, note}: ask HON to make the store.
CREATE FUNCTION hon.request_shopify_store(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; c hon.shopify_connections%ROWTYPE; r hon.shopify_store_requests%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['shopName','ownerEmail','note']);
  IF NOT hon.shopify_edit_text_ok(p_input->'shopName',60,false,false)
    OR jsonb_typeof(p_input->'ownerEmail')<>'string' OR length(p_input->>'ownerEmail')>254 OR p_input->>'ownerEmail'<>lower(p_input->>'ownerEmail')
    OR p_input->>'ownerEmail' !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' OR NOT hon.shopify_edit_text_ok(p_input->'note',500,true,true) THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  c:=hon.shopify_current(b.school);
  IF c.id IS NOT NULL AND c.status='CONNECTED' THEN RAISE EXCEPTION 'SHOPIFY_STORE_REQUEST_CONNECTED' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM hon.shopify_store_requests WHERE school_id=b.school AND status='REQUESTED') THEN
    RAISE EXCEPTION 'SHOPIFY_STORE_REQUEST_OPEN' USING ERRCODE='55006'; END IF;
  IF (SELECT count(*) FROM hon.shopify_store_requests WHERE school_id=b.school AND requested_at>clock_timestamp()-interval '30 days')>=5 THEN
    RAISE EXCEPTION 'SHOPIFY_STORE_REQUEST_LIMIT' USING ERRCODE='54000'; END IF;
  INSERT INTO hon.shopify_store_requests(organization_id,school_id,shop_name,owner_email,note,requested_by_principal_id)
    VALUES(b.org,b.school,p_input->>'shopName',p_input->>'ownerEmail',p_input->>'note',b.actor) RETURNING * INTO r;
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.store_request.requested','SHOPIFY_STORE_REQUEST',r.id,r.version,
    jsonb_build_object('status',r.status));
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('schoolId',b.school,'request',hon.shopify_store_request_json(r));
END $$;

-- CANCEL {schoolId, requestId}: the school withdraws its open request.
CREATE FUNCTION hon.cancel_shopify_store_request(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; r hon.shopify_store_requests%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['requestId']);
  IF NOT hon.shopify_uuid_ok(p_input->'requestId') THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM hon.shopify_store_requests WHERE id=(p_input->>'requestId')::uuid AND school_id=b.school FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'SHOPIFY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF r.status<>'REQUESTED' THEN RAISE EXCEPTION 'SHOPIFY_STORE_REQUEST_SETTLED' USING ERRCODE='55000'; END IF;
  UPDATE hon.shopify_store_requests SET status='CANCELLED',settled_by_principal_id=b.actor,settled_at=clock_timestamp(),version=version+1
    WHERE id=r.id RETURNING * INTO r;
  PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.store_request.cancelled','SHOPIFY_STORE_REQUEST',r.id,r.version,
    jsonb_build_object('status',r.status));
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('schoolId',b.school,'request',hon.shopify_store_request_json(r));
END $$;

-- LIST (HQ): every open request, oldest first, then the fifty most recently settled.
CREATE FUNCTION hon.read_hq_shopify_store_requests(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_open jsonb; v_settled jsonb;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,false);
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.at,x.id),'[]'::jsonb) INTO v_open FROM (
    SELECT r.id,r.requested_at AS at,hon.shopify_store_request_json(r)||jsonb_build_object('schoolId',r.school_id,'schoolName',s.name) AS j
    FROM hon.shopify_store_requests r JOIN hon.schools s ON s.id=r.school_id WHERE r.status='REQUESTED' ORDER BY r.requested_at,r.id LIMIT 200) x;
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.at DESC,x.id),'[]'::jsonb) INTO v_settled FROM (
    SELECT r.id,r.settled_at AS at,hon.shopify_store_request_json(r)||jsonb_build_object('schoolId',r.school_id,'schoolName',s.name) AS j
    FROM hon.shopify_store_requests r JOIN hon.schools s ON s.id=r.school_id WHERE r.status<>'REQUESTED' ORDER BY r.settled_at DESC,r.id LIMIT 50) x;
  RETURN jsonb_build_object('open',v_open,'settled',v_settled);
END $$;

-- SETTLE (HQ) {requestId, expectedVersion, outcome, shopDomain}: CREATED with the new store's address, or DECLINED with null.
CREATE FUNCTION hon.settle_hq_shopify_store_request(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_actor uuid; r hon.shopify_store_requests%ROWTYPE; v_outcome text;
BEGIN
  v_actor:=hon.require_saas_hq_actor(p_subject,false);
  IF NOT hon.shopify_keys_ok(p_input,ARRAY['requestId','expectedVersion','outcome','shopDomain'],ARRAY[]::text[])
    OR NOT hon.shopify_uuid_ok(p_input->'requestId') OR NOT hon.shopify_int_ok(p_input->'expectedVersion',1,1000000000,false)
    OR jsonb_typeof(p_input->'outcome')<>'string' THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  v_outcome:=p_input->>'outcome';
  IF v_outcome NOT IN ('CREATED','DECLINED') OR (v_outcome='CREATED' AND NOT hon.shopify_shop_ok(p_input->'shopDomain'))
    OR (v_outcome='DECLINED' AND jsonb_typeof(p_input->'shopDomain')<>'null') THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM hon.shopify_store_requests WHERE id=(p_input->>'requestId')::uuid FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'SHOPIFY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF r.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SHOPIFY_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF r.status<>'REQUESTED' THEN RAISE EXCEPTION 'SHOPIFY_STORE_REQUEST_SETTLED' USING ERRCODE='55000'; END IF;
  UPDATE hon.shopify_store_requests SET status=v_outcome,shop_domain=p_input->>'shopDomain',settled_by_principal_id=v_actor,
    settled_at=clock_timestamp(),version=version+1 WHERE id=r.id RETURNING * INTO r;
  PERFORM hon.shopify_evidence(r.organization_id,r.school_id,v_actor,'commerce.shopify.store_request.'||lower(v_outcome),'SHOPIFY_STORE_REQUEST',r.id,r.version,
    jsonb_build_object('status',r.status));
  IF hon.require_saas_hq_actor(p_subject,false) IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.shopify_store_request_json(r)||jsonb_build_object('schoolId',r.school_id,'schoolName',(SELECT name FROM hon.schools WHERE id=r.school_id));
END $$;

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_shopify_store_request(text,uuid)','hon.request_shopify_store(text,jsonb)',
    'hon.cancel_shopify_store_request(text,jsonb)','hon.read_hq_shopify_store_requests(text)','hon.settle_hq_shopify_store_request(text,jsonb)'];
BEGIN
  REVOKE ALL ON TABLE hon.shopify_store_requests FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.shopify_store_requests FROM %I',r); END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname='shopify_store_request_json' OR p.oid::regprocedure::text=ANY(entry)) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
