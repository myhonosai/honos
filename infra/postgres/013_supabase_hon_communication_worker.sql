-- HON / Supabase communication delivery worker role (0243, docs/architecture/COMMUNICATION_DELIVERY.md)
-- Run after HON migrations through 0243 have completed. Replace the placeholder with a freshly generated
-- base64url password; do not save it in Git. Store the Session Pooler URI only as
-- HON_COMMUNICATION_WORKER_DATABASE_URL (never DATABASE_URL or HON_RUNTIME_DATABASE_URL).
ROLLBACK;
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_communication_worker') THEN
    RAISE EXCEPTION 'Role hon_communication_worker already exists. Inspect and rotate it deliberately rather than overwriting it.';
  END IF;
  IF to_regprocedure('hon.claim_communication_deliveries(text[],integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'Apply communication delivery migration 0243 first.';
  END IF;
END;
$$;

CREATE ROLE hon_communication_worker
  LOGIN
  PASSWORD '<PASTE_FRESH_BASE64URL_PASSWORD_HERE>'
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  CONNECTION LIMIT 10;

REVOKE ALL PRIVILEGES ON DATABASE postgres FROM hon_communication_worker;
GRANT CONNECT ON DATABASE postgres TO hon_communication_worker;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM hon_communication_worker;
GRANT USAGE ON SCHEMA hon TO hon_communication_worker;
ALTER ROLE hon_communication_worker SET search_path = hon, pg_catalog;

-- No direct HON table, sequence or function access. The worker receives one leased send at a time and
-- reports results and verified provider receipts only through these four fixed functions.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA hon FROM hon_communication_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hon FROM hon_communication_worker;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA hon FROM hon_communication_worker;
GRANT EXECUTE ON FUNCTION hon.claim_communication_deliveries(text[], integer, integer) TO hon_communication_worker;
GRANT EXECUTE ON FUNCTION hon.reconcile_expired_communication_leases(integer) TO hon_communication_worker;
GRANT EXECUTE ON FUNCTION hon.record_communication_send_result(uuid, uuid, text, text, text, text, integer, text, text, integer) TO hon_communication_worker;
GRANT EXECUTE ON FUNCTION hon.record_communication_provider_event(text, text, text, uuid, text, timestamptz, bigint) TO hon_communication_worker;
-- 0248 inbound STOP/START/HELP (when applied).
DO $$ BEGIN
  IF to_regprocedure('hon.record_inbound_text_keyword(text,text,text,text,timestamptz)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION hon.record_inbound_text_keyword(text, text, text, text, timestamptz) TO hon_communication_worker;
  END IF;
  -- 0249 missed-call routing, recording and text-back (when applied).
  IF to_regprocedure('hon.record_missed_call(text,text,text,text,timestamptz)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION hon.read_missed_call_route(text), hon.record_missed_call(text, text, text, text, timestamptz),
      hon.claim_missed_call_text_backs(integer, integer), hon.record_missed_call_text_back_result(uuid, uuid, text, text) TO hon_communication_worker;
  END IF;
  -- 0250 Zernio lead intake (when applied).
  IF to_regprocedure('hon.record_zernio_lead(text,text,text,text,jsonb,jsonb)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION hon.record_zernio_lead(text, text, text, text, jsonb, jsonb) TO hon_communication_worker;
  END IF;
END $$;

-- HQ-COMM 0281: the same worker delivers HQ messages through its own four fixed functions, when 0281 is applied.
DO $$
BEGIN
  IF to_regprocedure('hon.claim_hq_message_deliveries(text[],integer,integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION hon.claim_hq_message_deliveries(text[], integer, integer) TO hon_communication_worker;
    GRANT EXECUTE ON FUNCTION hon.reconcile_expired_hq_message_leases(integer) TO hon_communication_worker;
    GRANT EXECUTE ON FUNCTION hon.record_hq_message_send_result(uuid, uuid, text, text, text, text, integer, text, text, integer) TO hon_communication_worker;
    GRANT EXECUTE ON FUNCTION hon.record_hq_message_provider_event(text, text, text, uuid, text, timestamptz, bigint) TO hon_communication_worker;
  END IF;
END;
$$;

-- HQ-COMM 0282: inbound texts to the HQ number (confirmation codes, STOP / START / HELP), when 0282 is applied.
DO $$
BEGIN
  IF to_regprocedure('hon.record_hq_inbound_text(text,text,text,text,text,timestamptz)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION hon.record_hq_inbound_text(text, text, text, text, text, timestamptz) TO hon_communication_worker;
  END IF;
END;
$$;

-- 0351 school Twilio subaccounts: claim/complete creation, and the webhook/send/number reads (when applied).
DO $$
BEGIN
  IF to_regprocedure('hon.begin_school_twilio_account(uuid,integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION hon.begin_school_twilio_account(uuid, integer), hon.complete_school_twilio_account(uuid, uuid, text, text, text),
      hon.read_twilio_webhook_account(text), hon.read_twilio_send_account(uuid, text), hon.twilio_number_in_account(text, text) TO hon_communication_worker;
  END IF;
END;
$$;

COMMIT;
