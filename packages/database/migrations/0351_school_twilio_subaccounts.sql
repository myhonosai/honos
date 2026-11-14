BEGIN;
-- 0351 per-school Twilio subaccounts (docs/architecture/SCHOOL_OWN_SENDERS.md §4, piece T1).
-- Owner decision 2026-11-14: each school buys its own texting number inside HON, on its own Twilio subaccount, and the
-- number and texting cost are billed to the school. This migration only records subaccounts and lets webhooks and sends
-- find them. It buys nothing and creates nothing at Twilio: the API worker does that only behind
-- HON_TWILIO_PROVISIONING_APPROVED, and number purchases (T2) also need a human HQ owner approval.

CREATE TABLE hon.school_twilio_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  account_sid text UNIQUE CHECK (account_sid ~ '^AC[0-9a-f]{32}$'),
  status text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED')),
  -- The subaccount's auth token, sealed by the API (AES-256-GCM bound to key id, school and account SID). Used only to
  -- check Twilio webhook signatures; HON acts on the subaccount with the parent account's credentials.
  sealed_auth_token text CHECK (sealed_auth_token ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$' AND length(sealed_auth_token) <= 1024),
  vault_key_id text CHECK (vault_key_id ~ '^[a-z0-9-]{1,40}$'),
  -- While PENDING, one worker holds a claim so two never create a subaccount for the same school at once.
  claim_token uuid,
  claim_expires_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (school_id),
  UNIQUE (account_sid, school_id),
  CONSTRAINT school_twilio_accounts_shape CHECK (
    (status = 'PENDING' AND account_sid IS NULL AND sealed_auth_token IS NULL AND vault_key_id IS NULL
      AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR (status <> 'PENDING' AND account_sid IS NOT NULL AND sealed_auth_token IS NOT NULL AND vault_key_id IS NOT NULL
      AND claim_token IS NULL AND claim_expires_at IS NULL))
);
ALTER TABLE hon.school_twilio_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_twilio_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY school_twilio_accounts_tenant_isolation ON hon.school_twilio_accounts
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

-- A school sender may name the subaccount its number and Messaging Service live on, and only its own school's.
-- Null keeps today's meaning: the number is on HON's parent account (0248, hand-entered by an HQ owner).
ALTER TABLE hon.school_text_senders ADD COLUMN twilio_account_sid text;
ALTER TABLE hon.school_text_senders ADD CONSTRAINT school_text_senders_twilio_account_fk
  FOREIGN KEY (twilio_account_sid, school_id) REFERENCES hon.school_twilio_accounts(account_sid, school_id) ON DELETE RESTRICT;

-- Worker: claim the right to create a school's subaccount. ACTIVE returns the SID; a live claim by another worker is
-- BUSY; an expired claim is taken over (the API then asks Twilio for an existing account with the school's name first).
CREATE FUNCTION hon.begin_school_twilio_account(p_school uuid, p_lease_seconds integer)
RETURNS TABLE (state text, account_sid text, claim_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE s hon.schools%ROWTYPE; org_status text; row hon.school_twilio_accounts; token uuid := gen_random_uuid();
BEGIN
  IF p_school IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'INVALID_TWILIO_ACCOUNT_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO s FROM hon.schools WHERE id = p_school FOR SHARE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'SCHOOL_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT o.status::text INTO org_status FROM hon.organizations o WHERE o.id = s.organization_id;
  IF s.status::text <> 'ACTIVE' OR org_status IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'SCHOOL_INACTIVE' USING ERRCODE = '55000'; END IF;
  SELECT * INTO row FROM hon.school_twilio_accounts a WHERE a.school_id = p_school FOR UPDATE;
  IF row.id IS NULL THEN
    BEGIN
      INSERT INTO hon.school_twilio_accounts (organization_id, school_id, status, claim_token, claim_expires_at)
      VALUES (s.organization_id, s.id, 'PENDING', token, now() + make_interval(secs => p_lease_seconds));
    EXCEPTION WHEN unique_violation THEN
      -- Another worker's first claim committed between our read and insert: it holds the claim.
      state := 'BUSY'; account_sid := NULL; claim_token := NULL; RETURN NEXT; RETURN;
    END;
    state := 'CLAIMED'; account_sid := NULL; claim_token := token; RETURN NEXT; RETURN;
  END IF;
  IF row.status = 'ACTIVE' THEN state := 'ACTIVE'; account_sid := row.account_sid; claim_token := NULL; RETURN NEXT; RETURN; END IF;
  IF row.status <> 'PENDING' THEN RAISE EXCEPTION 'TWILIO_ACCOUNT_NOT_ACTIVE' USING ERRCODE = '55000'; END IF;
  IF row.claim_expires_at > now() THEN state := 'BUSY'; account_sid := NULL; claim_token := NULL; RETURN NEXT; RETURN; END IF;
  UPDATE hon.school_twilio_accounts SET claim_token = token, claim_expires_at = now() + make_interval(secs => p_lease_seconds),
    version = version + 1, updated_at = now() WHERE id = row.id;
  state := 'CLAIMED'; account_sid := NULL; claim_token := token; RETURN NEXT;
END $$;

-- Worker: record the subaccount for a live claim. A SID that another school already holds is refused (unique), and a
-- lost or expired claim aborts, so a slow worker cannot overwrite the result of the one that took over.
CREATE FUNCTION hon.complete_school_twilio_account(p_school uuid, p_claim_token uuid, p_account_sid text, p_sealed_auth_token text, p_vault_key_id text)
RETURNS TABLE (account_sid text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE row hon.school_twilio_accounts; next hon.school_twilio_accounts; req uuid := gen_random_uuid();
BEGIN
  IF p_school IS NULL OR p_claim_token IS NULL OR p_account_sid IS NULL OR p_account_sid !~ '^AC[0-9a-f]{32}$'
    OR p_sealed_auth_token IS NULL OR p_vault_key_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_TWILIO_ACCOUNT_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO row FROM hon.school_twilio_accounts a WHERE a.school_id = p_school FOR UPDATE;
  IF row.id IS NULL OR row.status <> 'PENDING' OR row.claim_token IS DISTINCT FROM p_claim_token OR row.claim_expires_at <= now() THEN
    RAISE EXCEPTION 'TWILIO_ACCOUNT_CLAIM_LOST' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.school_twilio_accounts a WHERE a.account_sid = p_account_sid) THEN
    RAISE EXCEPTION 'TWILIO_ACCOUNT_CONFLICT' USING ERRCODE = '23505';
  END IF;
  UPDATE hon.school_twilio_accounts SET status = 'ACTIVE', account_sid = p_account_sid, sealed_auth_token = p_sealed_auth_token,
    vault_key_id = p_vault_key_id, claim_token = NULL, claim_expires_at = NULL, version = version + 1, updated_at = now()
  WHERE id = row.id RETURNING * INTO next;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (next.organization_id, next.school_id, '00000000-0000-4000-8000-00000000c043', 'INTEGRATION', 'communication.twilio_account.created',
    'SCHOOL_TWILIO_ACCOUNT', next.id, jsonb_build_object('status', 'PENDING'),
    jsonb_build_object('status', next.status, 'accountSid', next.account_sid, 'version', next.version), 'SUCCEEDED', req, req, now());
  account_sid := next.account_sid; RETURN NEXT;
END $$;

-- Worker: the sealed token of an ACTIVE school subaccount, for a webhook signature check. Nothing for any other status.
CREATE FUNCTION hon.read_twilio_webhook_account(p_account_sid text)
RETURNS TABLE (school_id uuid, organization_id uuid, sealed_auth_token text, vault_key_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT a.school_id, a.organization_id, a.sealed_auth_token, a.vault_key_id
  FROM hon.school_twilio_accounts a WHERE a.account_sid = p_account_sid AND a.status = 'ACTIVE';
$$;

-- Worker: which subaccount the sending school's Messaging Service is on (none = HON's parent account) and that account's
-- status. Keyed on the school as well as the service SID, so a service SID entered for two schools never sends (or bills)
-- one school's texts on the other's subaccount.
CREATE FUNCTION hon.read_twilio_send_account(p_school uuid, p_service_sid text)
RETURNS TABLE (account_sid text, account_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT a.account_sid, a.status FROM hon.school_text_senders sender
  JOIN hon.school_twilio_accounts a ON a.account_sid = sender.twilio_account_sid AND a.school_id = sender.school_id
  WHERE sender.school_id = p_school AND sender.messaging_service_sid = p_service_sid;
$$;

-- Worker: the number is a sender (any status, so a STOP to a disabled number still verifies) of that subaccount.
CREATE FUNCTION hon.twilio_number_in_account(p_account_sid text, p_phone_e164 text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (
    SELECT 1 FROM hon.school_text_senders sender
    JOIN hon.school_twilio_accounts a ON a.account_sid = sender.twilio_account_sid AND a.school_id = sender.school_id
    WHERE a.account_sid = p_account_sid AND a.status = 'ACTIVE' AND sender.phone_e164 = p_phone_e164);
$$;

REVOKE ALL ON FUNCTION hon.begin_school_twilio_account(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.complete_school_twilio_account(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.read_twilio_webhook_account(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.read_twilio_send_account(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.twilio_number_in_account(text, text) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.school_twilio_accounts FROM %I', r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.begin_school_twilio_account(uuid, integer), '
      || 'hon.complete_school_twilio_account(uuid, uuid, text, text, text), hon.read_twilio_webhook_account(text), '
      || 'hon.read_twilio_send_account(uuid, text), hon.twilio_number_in_account(text, text) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_school_twilio_account(uuid, integer), hon.complete_school_twilio_account(uuid, uuid, text, text, text),
      hon.read_twilio_webhook_account(text), hon.read_twilio_send_account(uuid, text), hon.twilio_number_in_account(text, text)
      TO hon_communication_worker;
  END IF;
END;
$$;
COMMIT;
