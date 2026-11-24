BEGIN;
-- 0352 school number orders (docs/architecture/SCHOOL_OWN_SENDERS.md §4.3, piece T2).
-- A school owner picks a local number inside HON; a human HON HQ owner approves each purchase (David's per-purchase OK);
-- the communication worker buys it on the school's own Twilio subaccount (0351) only behind
-- HON_TWILIO_PROVISIONING_APPROVED. The school pays only for the number (David 2026-11-14); this migration records the
-- quoted monthly price and charges nothing. A bought number becomes the school's sender as DISABLED; it is switched on
-- only after the school's A2P campaign is approved (T3).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.school_twilio_accounts') IS NULL OR to_regclass('hon.school_text_senders') IS NULL
    OR to_regprocedure('hon.require_saas_hq_actor(text,boolean)') IS NULL THEN RAISE EXCEPTION '0352 requires 0248 and 0351'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
  VALUES('communication.sender.manage','Choose and request the school''s own texting number; purchases still need HON HQ approval',true,true)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,'communication.sender.manage' FROM hon.roles r WHERE r.code='OWNER' AND r.is_system_role
  ON CONFLICT (role_id,permission_code) DO NOTHING;

CREATE TABLE hon.school_number_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+1[2-9][0-9]{9}$'),
  locality text CHECK (length(locality) BETWEEN 1 AND 80),
  region text CHECK (region ~ '^[A-Z]{2}$'),
  monthly_price_microunits bigint NOT NULL CHECK (monthly_price_microunits BETWEEN 0 AND 100000000),
  status text NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','APPROVED','PURCHASING','PURCHASED','FAILED','REJECTED','CANCELLED')),
  requested_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  decided_by uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  decision_note text CHECK (length(decision_note) BETWEEN 1 AND 500),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  -- A purchase step whose result was lost: the next attempt reads the subaccount before it buys anything.
  outcome_unknown boolean NOT NULL DEFAULT false,
  provider_number_sid text CHECK (provider_number_sid ~ '^PN[0-9a-f]{32}$'),
  messaging_service_sid text CHECK (messaging_service_sid ~ '^MG[0-9a-f]{32}$'),
  twilio_account_sid text CHECK (twilio_account_sid ~ '^AC[0-9a-f]{32}$'),
  failure_code text CHECK (failure_code ~ '^[A-Z_]{3,60}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (school_id, idempotency_key),
  CONSTRAINT school_number_orders_decision CHECK (status IN ('REQUESTED','CANCELLED') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT school_number_orders_lease CHECK ((status = 'PURCHASING') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT school_number_orders_purchased CHECK (status <> 'PURCHASED'
    OR (provider_number_sid IS NOT NULL AND messaging_service_sid IS NOT NULL AND twilio_account_sid IS NOT NULL))
);
-- One open order per school, and a number can be on only one open, bought or unsettled order. An unsettled order is a
-- FAILED one whose buy may have happened (outcome_unknown): HQ must reconcile it with Twilio before anything else.
CREATE UNIQUE INDEX school_number_orders_one_open ON hon.school_number_orders(school_id)
  WHERE status IN ('REQUESTED','APPROVED','PURCHASING');
CREATE UNIQUE INDEX school_number_orders_one_number ON hon.school_number_orders(phone_e164)
  WHERE status IN ('REQUESTED','APPROVED','PURCHASING','PURCHASED') OR (status = 'FAILED' AND outcome_unknown);
-- An order's school, number, quoted price, requester and key never change; status moves only forward, and a finished
-- order (PURCHASED, FAILED, REJECTED, CANCELLED) never changes again. No order is ever deleted.
CREATE FUNCTION hon.guard_school_number_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE'
    AND (NEW.id,NEW.organization_id,NEW.school_id,NEW.phone_e164,NEW.locality,NEW.region,NEW.monthly_price_microunits,NEW.requested_by,NEW.idempotency_key,NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.phone_e164,OLD.locality,OLD.region,OLD.monthly_price_microunits,OLD.requested_by,OLD.idempotency_key,OLD.created_at)
    AND OLD.status NOT IN ('PURCHASED','FAILED','REJECTED','CANCELLED') AND NEW.version > OLD.version
    AND (NEW.status = OLD.status OR ROW(OLD.status, NEW.status) IN (ROW('REQUESTED','APPROVED'), ROW('REQUESTED','REJECTED'), ROW('REQUESTED','CANCELLED'),
      ROW('APPROVED','PURCHASING'), ROW('APPROVED','CANCELLED'), ROW('APPROVED','FAILED'),
      ROW('PURCHASING','PURCHASED'), ROW('PURCHASING','FAILED'), ROW('PURCHASING','APPROVED'))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SCHOOL_NUMBER_ORDER_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_number_orders FOR EACH ROW EXECUTE FUNCTION hon.guard_school_number_order();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_number_orders FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_number_order();

-- 0351 review: a school's subaccount row keeps its school, and once a SID is recorded it never changes; no row is deleted.
CREATE FUNCTION hon.guard_school_twilio_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id,NEW.organization_id,NEW.school_id,NEW.created_at) IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.created_at)
    AND (OLD.account_sid IS NULL OR NEW.account_sid IS NOT DISTINCT FROM OLD.account_sid) AND NEW.version >= OLD.version THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SCHOOL_TWILIO_ACCOUNT_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_twilio_accounts FOR EACH ROW EXECUTE FUNCTION hon.guard_school_twilio_account();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_twilio_accounts FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_twilio_account();

ALTER TABLE hon.school_number_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_number_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY school_number_orders_tenant_isolation ON hon.school_number_orders
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

-- The direct human with live communication.sender.manage at the session school, with an ACTIVE in-window entitlement.
CREATE FUNCTION hon.require_school_sender_manager(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 2048 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SENDER_MANAGE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND hon.staff_member_eligible(p.id,org,school)
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code='communication.sender.manage' AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp()
      AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SENDER_MANAGE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.school_number_order_json(o hon.school_number_orders) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('orderId',o.id,'schoolId',o.school_id,'phoneE164',o.phone_e164,'locality',o.locality,'region',o.region,
    'monthlyPriceMicrounits',o.monthly_price_microunits,'status',o.status,'decisionNote',o.decision_note,'decidedAt',o.decided_at,
    'failureCode',o.failure_code,'outcomeUnknown',o.outcome_unknown,'version',o.version,'createdAt',o.created_at,'updatedAt',o.updated_at);
$$;

-- Owner: the scope check alone (search runs in the API, then calls this to prove authority first).
CREATE FUNCTION hon.authorize_school_number_search(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
  actor := hon.require_school_sender_manager(p_subject);
  RETURN jsonb_build_object('organizationId',hon.current_organization_id(),'schoolId',hon.current_school_id(),
    'hasProvisionedSender',EXISTS(SELECT 1 FROM hon.school_text_senders t WHERE t.school_id=hon.current_school_id() AND t.twilio_account_sid IS NOT NULL),
    'openOrder',(SELECT hon.school_number_order_json(o) FROM hon.school_number_orders o WHERE o.school_id=hon.current_school_id()
      AND (o.status IN ('REQUESTED','APPROVED','PURCHASING') OR (o.status='FAILED' AND o.outcome_unknown)) ORDER BY o.created_at DESC LIMIT 1));
END $$;

-- Owner: request one number. The API passes the number's locality and monthly price from its own fresh Twilio lookup.
CREATE FUNCTION hon.request_school_number(p_subject text, p_input jsonb, p_key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid; school uuid; prior hon.school_number_orders; next hon.school_number_orders; req uuid:=gen_random_uuid();
  phone text; locality text; region text; price bigint;
BEGIN
  actor := hon.require_school_sender_manager(p_subject);
  org := hon.current_organization_id(); school := hon.current_school_id();
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR NOT (p_input ?& ARRAY['phoneE164','monthlyPriceMicrounits'])
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('phoneE164','locality','region','monthlyPriceMicrounits'))
    OR jsonb_typeof(p_input->'phoneE164')<>'string' OR jsonb_typeof(p_input->'monthlyPriceMicrounits')<>'number'
    OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9._:-]{8,128}$' THEN
    RAISE EXCEPTION 'INVALID_NUMBER_ORDER' USING ERRCODE='22023';
  END IF;
  phone := p_input->>'phoneE164';
  locality := nullif(p_input->>'locality','');
  region := nullif(p_input->>'region','');
  price := (p_input->>'monthlyPriceMicrounits')::bigint;
  -- Replay of the same request returns the same order.
  SELECT * INTO prior FROM hon.school_number_orders o WHERE o.school_id=school AND o.idempotency_key=p_key;
  IF prior.id IS NOT NULL THEN
    IF prior.phone_e164<>phone THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='22023'; END IF;
    RETURN hon.school_number_order_json(prior);
  END IF;
  PERFORM 1 FROM hon.schools s WHERE s.id=school FOR UPDATE;
  IF EXISTS(SELECT 1 FROM hon.school_text_senders t WHERE t.school_id=school AND t.twilio_account_sid IS NOT NULL) THEN
    RAISE EXCEPTION 'SCHOOL_NUMBER_EXISTS' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM hon.school_number_orders o WHERE o.school_id=school AND o.status IN ('REQUESTED','APPROVED','PURCHASING')) THEN
    RAISE EXCEPTION 'NUMBER_ORDER_OPEN' USING ERRCODE='55000';
  END IF;
  -- A failed order that may still have bought a number blocks a second order until HQ reconciles it.
  IF EXISTS(SELECT 1 FROM hon.school_number_orders o WHERE o.school_id=school AND o.status='FAILED' AND o.outcome_unknown) THEN
    RAISE EXCEPTION 'NUMBER_ORDER_UNSETTLED' USING ERRCODE='55000';
  END IF;
  BEGIN
    INSERT INTO hon.school_number_orders (organization_id, school_id, phone_e164, locality, region, monthly_price_microunits, requested_by, idempotency_key)
    VALUES (org, school, phone, locality, region, price, actor, p_key) RETURNING * INTO next;
  EXCEPTION
    WHEN unique_violation THEN RAISE EXCEPTION 'NUMBER_UNAVAILABLE' USING ERRCODE='55000';
    WHEN check_violation THEN RAISE EXCEPTION 'INVALID_NUMBER_ORDER' USING ERRCODE='22023';
  END;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (org, school, actor, 'HUMAN_UI', 'communication.number_order.requested', 'SCHOOL_NUMBER_ORDER', next.id, NULL,
    jsonb_build_object('phone', next.phone_e164, 'monthlyPriceMicrounits', next.monthly_price_microunits, 'status', next.status), 'SUCCEEDED', req, req, now());
  PERFORM hon.require_school_sender_manager(p_subject);
  RETURN hon.school_number_order_json(next);
END $$;

-- Owner: cancel an order HQ has not started buying.
CREATE FUNCTION hon.cancel_school_number_order(p_subject text, p_order uuid, p_expected_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior hon.school_number_orders; next hon.school_number_orders; req uuid:=gen_random_uuid();
BEGIN
  actor := hon.require_school_sender_manager(p_subject);
  SELECT * INTO prior FROM hon.school_number_orders o WHERE o.id=p_order AND o.school_id=hon.current_school_id() FOR UPDATE;
  IF prior.id IS NULL THEN RAISE EXCEPTION 'NUMBER_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_expected_version IS DISTINCT FROM prior.version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF prior.status NOT IN ('REQUESTED','APPROVED') THEN RAISE EXCEPTION 'NUMBER_ORDER_NOT_CANCELLABLE' USING ERRCODE='55000'; END IF;
  UPDATE hon.school_number_orders SET status='CANCELLED', version=version+1, updated_at=now() WHERE id=prior.id RETURNING * INTO next;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (next.organization_id, next.school_id, actor, 'HUMAN_UI', 'communication.number_order.cancelled', 'SCHOOL_NUMBER_ORDER', next.id,
    jsonb_build_object('status', prior.status, 'version', prior.version), jsonb_build_object('status', next.status, 'version', next.version), 'SUCCEEDED', req, req, now());
  PERFORM hon.require_school_sender_manager(p_subject);
  RETURN hon.school_number_order_json(next);
END $$;

CREATE FUNCTION hon.read_school_number_orders(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
  PERFORM hon.require_school_sender_manager(p_subject);
  SELECT coalesce(jsonb_agg(hon.school_number_order_json(o) ORDER BY o.created_at DESC), '[]'::jsonb) INTO result
  FROM (SELECT * FROM hon.school_number_orders o WHERE o.school_id=hon.current_school_id() ORDER BY o.created_at DESC LIMIT 20) o;
  PERFORM hon.require_school_sender_manager(p_subject);
  RETURN jsonb_build_object('orders', result);
END $$;

-- HQ owner: approve or reject a requested number. Approval is the per-purchase OK; buying still needs the process switch.
CREATE FUNCTION hon.decide_school_number_order_from_hq(p_subject text, p_order uuid, p_decision text, p_note text, p_expected_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior hon.school_number_orders; next hon.school_number_orders; req uuid:=gen_random_uuid();
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_order IS NULL OR p_decision NOT IN ('APPROVE','REJECT') OR (p_note IS NOT NULL AND length(p_note) NOT BETWEEN 1 AND 500)
    OR p_expected_version IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  SELECT * INTO prior FROM hon.school_number_orders o WHERE o.id=p_order FOR UPDATE;
  IF prior.id IS NULL THEN RAISE EXCEPTION 'NUMBER_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF prior.version<>p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF prior.status<>'REQUESTED' THEN RAISE EXCEPTION 'NUMBER_ORDER_NOT_PENDING' USING ERRCODE='55000'; END IF;
  UPDATE hon.school_number_orders SET status=CASE WHEN p_decision='APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END,
    decided_by=actor, decided_at=now(), decision_note=p_note, version=version+1, updated_at=now()
  WHERE id=prior.id RETURNING * INTO next;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (next.organization_id, next.school_id, actor, 'HON_HQ', 'communication.number_order.decided', 'SCHOOL_NUMBER_ORDER', next.id,
    jsonb_build_object('status', prior.status, 'version', prior.version), jsonb_build_object('status', next.status, 'version', next.version), 'SUCCEEDED', req, req, now());
  PERFORM hon.require_saas_hq_actor(p_subject, true);
  RETURN hon.school_number_order_json(next) || jsonb_build_object('schoolName',(SELECT s.name FROM hon.schools s WHERE s.id=next.school_id));
END $$;

CREATE FUNCTION hon.read_hq_school_number_orders(p_subject text, p_status text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  IF p_status IS NOT NULL AND p_status NOT IN ('REQUESTED','APPROVED','PURCHASING','PURCHASED','FAILED','REJECTED','CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(hon.school_number_order_json(o) || jsonb_build_object('schoolName', s.name) ORDER BY o.created_at), '[]'::jsonb) INTO result
  FROM (SELECT * FROM hon.school_number_orders o WHERE p_status IS NULL OR o.status=p_status ORDER BY o.created_at LIMIT 200) o
  JOIN hon.schools s ON s.id=o.school_id;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  RETURN jsonb_build_object('orders', result);
END $$;

-- Worker: claim approved orders (and PURCHASING ones whose lease ran out) for a still-ACTIVE, entitled school.
CREATE FUNCTION hon.claim_school_number_purchases(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (order_id uuid, lease_token uuid, school_id uuid, organization_id uuid, phone_e164 text, attempt integer, outcome_unknown boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE o hon.school_number_orders; token uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 60 AND 900 THEN
    RAISE EXCEPTION 'INVALID_CLAIM' USING ERRCODE='22023'; END IF;
  FOR o IN SELECT x.* FROM hon.school_number_orders x
    JOIN hon.schools s ON s.id=x.school_id AND s.organization_id=x.organization_id AND s.status='ACTIVE'
    JOIN hon.organizations g ON g.id=x.organization_id AND g.status='ACTIVE'
    WHERE (x.status='APPROVED' OR (x.status='PURCHASING' AND x.lease_expires_at<=now()))
      AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=x.organization_id AND e.status='ACTIVE'
        AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    ORDER BY x.updated_at LIMIT p_limit FOR UPDATE OF x SKIP LOCKED LOOP
    token := gen_random_uuid();
    IF o.attempts >= 5 THEN
      -- Five tries without a result: stop and leave it for an HQ operator (never buys again on its own).
      -- If any attempt may have bought the number, it says so: RECONCILE_REQUIRED keeps the number and the school blocked.
      UPDATE hon.school_number_orders SET status='FAILED',
        failure_code=CASE WHEN o.outcome_unknown OR o.status='PURCHASING' OR o.provider_number_sid IS NOT NULL THEN 'RECONCILE_REQUIRED' ELSE 'ATTEMPTS_EXHAUSTED' END,
        outcome_unknown = o.outcome_unknown OR o.status='PURCHASING' OR o.provider_number_sid IS NOT NULL, lease_token=NULL, lease_expires_at=NULL,
        version=version+1, updated_at=now() WHERE id=o.id;
      CONTINUE;
    END IF;
    UPDATE hon.school_number_orders SET status='PURCHASING', lease_token=token, lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      attempts=attempts+1, outcome_unknown = outcome_unknown OR o.status='PURCHASING', version=version+1, updated_at=now() WHERE id=o.id;
    order_id:=o.id; lease_token:=token; school_id:=o.school_id; organization_id:=o.organization_id; phone_e164:=o.phone_e164;
    attempt:=o.attempts+1; outcome_unknown:=o.outcome_unknown OR o.status='PURCHASING';
    RETURN NEXT;
  END LOOP;
END $$;

-- Worker: the result of one purchase attempt. PURCHASED makes the number the school's sender, DISABLED until A2P (T3).
CREATE FUNCTION hon.record_school_number_purchase(p_order uuid, p_lease uuid, p_outcome text, p_number_sid text, p_service_sid text,
  p_account_sid text, p_failure_code text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE o hon.school_number_orders; next hon.school_number_orders; sender hon.school_text_senders; req uuid:=gen_random_uuid();
BEGIN
  IF p_order IS NULL OR p_lease IS NULL OR p_outcome NOT IN ('PURCHASED','FAILED','UNKNOWN','RETRY')
    OR (p_failure_code IS NOT NULL AND p_failure_code !~ '^[A-Z_]{3,60}$') THEN RAISE EXCEPTION 'INVALID_PURCHASE_RESULT' USING ERRCODE='22023'; END IF;
  SELECT * INTO o FROM hon.school_number_orders x WHERE x.id=p_order FOR UPDATE;
  IF o.id IS NULL OR o.status<>'PURCHASING' OR o.lease_token IS DISTINCT FROM p_lease OR o.lease_expires_at<=now() THEN
    RAISE EXCEPTION 'PURCHASE_LEASE_LOST' USING ERRCODE='40001'; END IF;
  IF p_outcome='PURCHASED' THEN
    IF p_number_sid !~ '^PN[0-9a-f]{32}$' OR p_service_sid !~ '^MG[0-9a-f]{32}$' OR p_account_sid !~ '^AC[0-9a-f]{32}$' THEN
      RAISE EXCEPTION 'INVALID_PURCHASE_RESULT' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS(SELECT 1 FROM hon.school_twilio_accounts a WHERE a.school_id=o.school_id AND a.account_sid=p_account_sid AND a.status='ACTIVE') THEN
      RAISE EXCEPTION 'TWILIO_ACCOUNT_MISMATCH' USING ERRCODE='42501'; END IF;
    SELECT * INTO sender FROM hon.school_text_senders t WHERE t.school_id=o.school_id FOR UPDATE;
    IF sender.id IS NULL THEN
      INSERT INTO hon.school_text_senders (organization_id, school_id, phone_e164, messaging_service_sid, status, mms_converter_confirmed,
        set_by_principal_id, twilio_account_sid)
      VALUES (o.organization_id, o.school_id, o.phone_e164, p_service_sid, 'DISABLED', true, '00000000-0000-4000-8000-00000000c043', p_account_sid);
    ELSE
      -- A school that had a hand-entered parent-account sender moves to its own number, switched off until A2P.
      UPDATE hon.school_text_senders SET phone_e164=o.phone_e164, messaging_service_sid=p_service_sid, status='DISABLED',
        mms_converter_confirmed=true, set_by_principal_id='00000000-0000-4000-8000-00000000c043', twilio_account_sid=p_account_sid,
        version=version+1, updated_at=now() WHERE id=sender.id;
    END IF;
    UPDATE hon.school_number_orders SET status='PURCHASED', provider_number_sid=p_number_sid, messaging_service_sid=p_service_sid,
      twilio_account_sid=p_account_sid, lease_token=NULL, lease_expires_at=NULL, outcome_unknown=false, failure_code=NULL,
      version=version+1, updated_at=now() WHERE id=o.id RETURNING * INTO next;
  ELSIF p_outcome='FAILED' THEN
    IF p_number_sid IS NOT NULL AND p_number_sid !~ '^PN[0-9a-f]{32}$' THEN RAISE EXCEPTION 'INVALID_PURCHASE_RESULT' USING ERRCODE='22023'; END IF;
    -- A failure after the number was bought (p_number_sid given) leaves it unsettled for HQ. Only Twilio refusing the buy
    -- itself, right after this attempt found no such number on the subaccount, proves nothing was bought.
    UPDATE hon.school_number_orders SET status='FAILED', failure_code=coalesce(p_failure_code,'PROVIDER_REJECTED'), lease_token=NULL, lease_expires_at=NULL,
      provider_number_sid=coalesce(p_number_sid, provider_number_sid),
      outcome_unknown = p_number_sid IS NOT NULL OR (outcome_unknown AND coalesce(p_failure_code,'') <> 'NUMBER_UNAVAILABLE'),
      version=version+1, updated_at=now() WHERE id=o.id RETURNING * INTO next;
  ELSIF p_outcome IN ('UNKNOWN','RETRY') AND p_number_sid IS NOT NULL AND p_number_sid !~ '^PN[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'INVALID_PURCHASE_RESULT' USING ERRCODE='22023';
  ELSIF p_outcome='UNKNOWN' THEN
    -- Stays PURCHASING; the lease runs out and the next claim reads the subaccount before doing anything.
    UPDATE hon.school_number_orders SET outcome_unknown=true, failure_code=coalesce(p_failure_code,'OUTCOME_UNKNOWN'), lease_expires_at=now(),
      provider_number_sid=coalesce(p_number_sid, provider_number_sid),
      version=version+1, updated_at=now() WHERE id=o.id RETURNING * INTO next;
  ELSE
    -- RETRY: this step certainly did nothing (switch off, unreachable); back to APPROVED for a later attempt. A number
    -- already bought in an earlier step (p_number_sid) keeps the order marked as possibly holding one.
    UPDATE hon.school_number_orders SET status='APPROVED', failure_code=p_failure_code, lease_token=NULL, lease_expires_at=NULL,
      provider_number_sid=coalesce(p_number_sid, provider_number_sid), outcome_unknown = outcome_unknown OR p_number_sid IS NOT NULL,
      version=version+1, updated_at=now() WHERE id=o.id RETURNING * INTO next;
  END IF;
  IF p_outcome IN ('PURCHASED','FAILED') THEN
    INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
      prior_state, next_state, result, request_id, correlation_id, occurred_at)
    VALUES (next.organization_id, next.school_id, '00000000-0000-4000-8000-00000000c043', 'INTEGRATION', 'communication.number_order.' || lower(p_outcome),
      'SCHOOL_NUMBER_ORDER', next.id, jsonb_build_object('status', 'PURCHASING'),
      jsonb_build_object('status', next.status, 'phone', next.phone_e164, 'failureCode', next.failure_code, 'outcomeUnknown', next.outcome_unknown,
        'version', next.version), 'SUCCEEDED', req, req, now());
  END IF;
  RETURN jsonb_build_object('status', next.status, 'version', next.version);
END $$;

-- 0248 HQ manual sender, now refusing to move a HON-bought (subaccount) number or service; status changes stay allowed.
CREATE OR REPLACE FUNCTION hon.set_school_text_sender_from_hq(
  p_subject text, p_school uuid, p_phone_e164 text, p_messaging_service_sid text, p_status text, p_mms_converter_confirmed boolean,
  p_expected_version integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; s hon.schools%ROWTYPE; prior hon.school_text_senders; next hon.school_text_senders; req uuid := gen_random_uuid();
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_school IS NULL OR p_status NOT IN ('ACTIVE', 'DISABLED') OR p_phone_e164 IS NULL OR p_messaging_service_sid IS NULL
    OR p_mms_converter_confirmed IS NULL THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'ACTIVE' AND NOT p_mms_converter_confirmed THEN
    RAISE EXCEPTION 'MMS_CONVERTER_NOT_CONFIRMED' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO s FROM hon.schools WHERE id = p_school;
  IF s.id IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO prior FROM hon.school_text_senders WHERE school_id = p_school FOR UPDATE;
  IF prior.id IS NULL THEN
    IF p_expected_version IS NOT NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    INSERT INTO hon.school_text_senders (organization_id, school_id, phone_e164, messaging_service_sid, status, mms_converter_confirmed, set_by_principal_id)
    VALUES (s.organization_id, s.id, p_phone_e164, p_messaging_service_sid, p_status, p_mms_converter_confirmed, actor) RETURNING * INTO next;
  ELSE
    IF p_expected_version IS DISTINCT FROM prior.version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    IF prior.twilio_account_sid IS NOT NULL AND (p_phone_e164 <> prior.phone_e164 OR p_messaging_service_sid <> prior.messaging_service_sid) THEN
      RAISE EXCEPTION 'PROVISIONED_SENDER_LOCKED' USING ERRCODE = '55000';
    END IF;
    UPDATE hon.school_text_senders SET phone_e164 = p_phone_e164, messaging_service_sid = p_messaging_service_sid, status = p_status,
      mms_converter_confirmed = p_mms_converter_confirmed, set_by_principal_id = actor, version = version + 1, updated_at = now()
    WHERE id = prior.id RETURNING * INTO next;
  END IF;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (s.organization_id, s.id, actor, 'HON_HQ', 'communication.text_sender.set', 'SCHOOL_TEXT_SENDER', next.id,
    CASE WHEN prior.id IS NULL THEN NULL ELSE jsonb_build_object('phone', prior.phone_e164, 'status', prior.status, 'version', prior.version) END,
    jsonb_build_object('phone', next.phone_e164, 'status', next.status, 'mmsConverterConfirmed', next.mms_converter_confirmed, 'version', next.version), 'SUCCEEDED', req, req, now());
  -- Authority is checked again after the lock and the write, so a grant that ended meanwhile aborts the change.
  PERFORM hon.require_saas_hq_actor(p_subject, true);
  RETURN jsonb_build_object('schoolId', next.school_id, 'phoneE164', next.phone_e164, 'status', next.status, 'mmsConverterConfirmed', next.mms_converter_confirmed,
    'version', next.version, 'updatedAt', next.updated_at);
END $$;

DO $$
DECLARE r text; f text;
  runtime_fns text[] := ARRAY['hon.authorize_school_number_search(text)','hon.request_school_number(text,jsonb,text)',
    'hon.cancel_school_number_order(text,uuid,integer)','hon.read_school_number_orders(text)',
    'hon.decide_school_number_order_from_hq(text,uuid,text,text,integer)','hon.read_hq_school_number_orders(text,text)'];
  worker_fns text[] := ARRAY['hon.claim_school_number_purchases(integer,integer)','hon.record_school_number_purchase(uuid,uuid,text,text,text,text,text)'];
  private_fns text[] := ARRAY['hon.require_school_sender_manager(text)','hon.school_number_order_json(hon.school_number_orders)',
    'hon.guard_school_number_order()','hon.guard_school_twilio_account()'];
BEGIN
  REVOKE ALL ON TABLE hon.school_number_orders FROM PUBLIC;
  FOREACH f IN ARRAY runtime_fns || worker_fns || private_fns LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||f||' FROM PUBLIC'; END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.school_number_orders FROM %I', r);
    FOREACH f IN ARRAY runtime_fns || worker_fns || private_fns LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY runtime_fns LOOP EXECUTE 'GRANT EXECUTE ON FUNCTION '||f||' TO hon_runtime'; END LOOP;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    FOREACH f IN ARRAY worker_fns LOOP EXECUTE 'GRANT EXECUTE ON FUNCTION '||f||' TO hon_communication_worker'; END LOOP;
  END IF;
END $$;
COMMIT;
