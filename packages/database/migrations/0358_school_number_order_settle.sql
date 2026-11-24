BEGIN;
-- 0358 settle an unsettled school number order (docs/architecture/SCHOOL_OWN_SENDERS.md §8b, piece T2c; #343 review P3).
-- A FAILED order with outcome_unknown may or may not have bought its number. It keeps the number reserved and blocks the
-- school (0352). A human HON HQ owner checks the school's Twilio subaccount and records what they found:
-- - NOT_BOUGHT: the number is not on the subaccount. The order stays FAILED (SETTLED_NOT_BOUGHT) and stops holding the
--   number or blocking the school.
-- - BOUGHT: the number is on the subaccount. The order goes back to APPROVED with fresh attempts and the unknown flag
--   kept, so the purchase worker finds that number (it never buys again) and finishes the Messaging Service and sender.
-- Nothing here calls Twilio or charges anything.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.school_number_orders') IS NULL OR to_regprocedure('hon.guard_school_number_order()') IS NULL THEN
    RAISE EXCEPTION '0358 requires 0352'; END IF;
END $$;

ALTER TABLE hon.school_number_orders
  ADD COLUMN settled_by uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  ADD COLUMN settled_at timestamptz,
  ADD COLUMN settle_finding text CHECK (settle_finding IN ('BOUGHT','NOT_BOUGHT')),
  ADD COLUMN settle_note text CHECK (length(settle_note) BETWEEN 1 AND 500),
  ADD CONSTRAINT school_number_orders_settled CHECK ((settled_by IS NULL) = (settled_at IS NULL)
    AND (settled_by IS NULL) = (settle_finding IS NULL) AND (settled_by IS NULL) = (settle_note IS NULL));

-- 0352's guard, plus exactly the two settle moves. Everything else it refused is still refused.
CREATE OR REPLACE FUNCTION hon.guard_school_number_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE'
    AND (NEW.id,NEW.organization_id,NEW.school_id,NEW.phone_e164,NEW.locality,NEW.region,NEW.monthly_price_microunits,NEW.requested_by,NEW.idempotency_key,NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.phone_e164,OLD.locality,OLD.region,OLD.monthly_price_microunits,OLD.requested_by,OLD.idempotency_key,OLD.created_at)
    AND NEW.version > OLD.version THEN
    -- Ordinary forward moves (0352): never from a finished order, and a settle record is never written or changed here.
    IF OLD.status NOT IN ('PURCHASED','FAILED','REJECTED','CANCELLED')
      AND (NEW.settled_by,NEW.settled_at,NEW.settle_finding,NEW.settle_note) IS NOT DISTINCT FROM (OLD.settled_by,OLD.settled_at,OLD.settle_finding,OLD.settle_note)
      AND (NEW.status = OLD.status OR ROW(OLD.status, NEW.status) IN (ROW('REQUESTED','APPROVED'), ROW('REQUESTED','REJECTED'), ROW('REQUESTED','CANCELLED'),
        ROW('APPROVED','PURCHASING'), ROW('APPROVED','CANCELLED'), ROW('APPROVED','FAILED'),
        ROW('PURCHASING','PURCHASED'), ROW('PURCHASING','FAILED'), ROW('PURCHASING','APPROVED'))) THEN
      RETURN NEW;
    END IF;
    -- Settle (0358): only an unsettled FAILED order, with a full settle record. A BOUGHT order that fails unsettled again
    -- can be settled again; the audit trail keeps each finding.
    IF OLD.status='FAILED' AND OLD.outcome_unknown
      AND NEW.settled_by IS NOT NULL AND NEW.settled_at IS NOT NULL AND NEW.settle_note IS NOT NULL
      AND NEW.decided_by IS NOT DISTINCT FROM OLD.decided_by AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
      AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note
      AND ((NEW.settle_finding='NOT_BOUGHT' AND NEW.status='FAILED' AND NOT NEW.outcome_unknown AND NEW.failure_code='SETTLED_NOT_BOUGHT')
        OR (NEW.settle_finding='BOUGHT' AND NEW.status='APPROVED' AND NEW.outcome_unknown AND NEW.attempts=0 AND NEW.failure_code='SETTLED_BOUGHT')) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SCHOOL_NUMBER_ORDER_IMMUTABLE' USING ERRCODE='42501';
END $$;

-- HQ owner: record what the school's Twilio subaccount shows for an unsettled order.
CREATE FUNCTION hon.settle_school_number_order_from_hq(p_subject text, p_order uuid, p_finding text, p_note text, p_expected_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior hon.school_number_orders; next hon.school_number_orders; req uuid:=gen_random_uuid();
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_order IS NULL OR p_finding NOT IN ('BOUGHT','NOT_BOUGHT') OR p_note IS NULL OR length(p_note) NOT BETWEEN 1 AND 500
    OR p_note <> btrim(p_note) OR p_expected_version IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  SELECT * INTO prior FROM hon.school_number_orders o WHERE o.id=p_order FOR UPDATE;
  IF prior.id IS NULL THEN RAISE EXCEPTION 'NUMBER_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF prior.version<>p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF prior.status<>'FAILED' OR NOT prior.outcome_unknown THEN
    RAISE EXCEPTION 'NUMBER_ORDER_NOT_UNSETTLED' USING ERRCODE='55000'; END IF;
  IF p_finding='BOUGHT' AND EXISTS(SELECT 1 FROM hon.school_number_orders o WHERE o.school_id=prior.school_id AND o.id<>prior.id
      AND o.status IN ('REQUESTED','APPROVED','PURCHASING')) THEN
    RAISE EXCEPTION 'NUMBER_ORDER_OPEN' USING ERRCODE='55000'; END IF;
  UPDATE hon.school_number_orders SET settled_by=actor, settled_at=now(), settle_finding=p_finding, settle_note=p_note,
    status=CASE WHEN p_finding='BOUGHT' THEN 'APPROVED' ELSE 'FAILED' END,
    outcome_unknown=(p_finding='BOUGHT'), attempts=CASE WHEN p_finding='BOUGHT' THEN 0 ELSE attempts END,
    failure_code=CASE WHEN p_finding='BOUGHT' THEN 'SETTLED_BOUGHT' ELSE 'SETTLED_NOT_BOUGHT' END,
    version=version+1, updated_at=now()
  WHERE id=prior.id RETURNING * INTO next;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (next.organization_id, next.school_id, actor, 'HON_HQ', 'communication.number_order.settled', 'SCHOOL_NUMBER_ORDER', next.id,
    jsonb_build_object('status', prior.status, 'failureCode', prior.failure_code, 'version', prior.version),
    jsonb_build_object('status', next.status, 'finding', p_finding, 'failureCode', next.failure_code, 'version', next.version), 'SUCCEEDED', req, req, now());
  PERFORM hon.require_saas_hq_actor(p_subject, true);
  RETURN hon.school_number_order_json(next) || jsonb_build_object('schoolName',(SELECT s.name FROM hon.schools s WHERE s.id=next.school_id));
END $$;

DO $$
DECLARE r text;
BEGIN
  REVOKE ALL ON FUNCTION hon.settle_school_number_order_from_hq(text,uuid,text,text,integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION hon.guard_school_number_order() FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.settle_school_number_order_from_hq(text,uuid,text,text,integer) FROM %I', r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_school_number_order() FROM %I', r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.settle_school_number_order_from_hq(text,uuid,text,text,integer) TO hon_runtime;
  END IF;
END $$;
COMMIT;
