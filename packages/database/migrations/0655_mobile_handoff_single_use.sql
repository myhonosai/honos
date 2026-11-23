BEGIN;

-- 0655 Native app sign-in codes are single use (coordinator-allocated 2026-11-22; GitHub security review 2026-11-22).
-- Owner request (David, 2026-11-22): plug every hole the review found. Security fix: like 0644 it may be applied before
-- its queue turn when the independent reviewer agrees.
--   The HON Family and HON Staff apps trade a one-minute hand-off code plus their PKCE verifier for a mobile session.
--   The code was a stateless signed token, so the same code + verifier could be traded again until it expired. Each
--   code now carries a random jti, and the API may only issue a session after hon.redeem_mobile_handoff records that
--   (app, jti) for the first time. A second trade of the same code answers false and is refused.
--   The ledger is pre-authentication and holds no tenant, identity or token text: only the app, the jti and the code's
--   expiry. Rows are pruned once expired. Forced RLS, no policies, no table privilege for any platform or HON role;
--   hon_runtime may only EXECUTE the one function.
-- Nothing here changes existing data, sends, charges or calls an outside service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regnamespace('hon') IS NULL THEN RAISE EXCEPTION '0655 requires the hon schema'; END IF;
  IF to_regclass('hon.mobile_handoff_redemptions') IS NOT NULL OR to_regprocedure('hon.redeem_mobile_handoff(text,uuid,timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION '0655 names already exist'; END IF;
END $$;

CREATE TABLE hon.mobile_handoff_redemptions (
  app text NOT NULL CHECK (app IN ('family','staff')),
  jti uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (app, jti)
);
CREATE INDEX mobile_handoff_redemptions_expiry ON hon.mobile_handoff_redemptions (expires_at);
ALTER TABLE hon.mobile_handoff_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.mobile_handoff_redemptions FORCE ROW LEVEL SECURITY;

-- True exactly once per (app, jti) while the code is unexpired; false for a replay. Refuses malformed input.
CREATE FUNCTION hon.redeem_mobile_handoff(p_app text, p_jti uuid, p_expires_at timestamptz) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE now_at timestamptz := clock_timestamp(); inserted integer;
BEGIN
  IF p_app IS NULL OR p_app NOT IN ('family','staff') OR p_jti IS NULL OR p_expires_at IS NULL
    OR p_expires_at <= now_at OR p_expires_at > now_at + interval '120 seconds' THEN
    RAISE EXCEPTION 'MOBILE_HANDOFF_INVALID' USING ERRCODE='22023';
  END IF;
  DELETE FROM hon.mobile_handoff_redemptions WHERE expires_at < now_at - interval '5 minutes';
  INSERT INTO hon.mobile_handoff_redemptions(app, jti, expires_at) VALUES (p_app, p_jti, p_expires_at)
    ON CONFLICT (app, jti) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted = 1;
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON TABLE hon.mobile_handoff_redemptions FROM PUBLIC;
  REVOKE ALL ON FUNCTION hon.redeem_mobile_handoff(text,uuid,timestamptz) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','authenticator',
      'hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.mobile_handoff_redemptions FROM %I', r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.redeem_mobile_handoff(text,uuid,timestamptz) FROM %I', r);
  END LOOP;
  -- The runtime role may not exist yet on a fresh chain; infra/postgres/010 restates this grant when it does.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.redeem_mobile_handoff(text,uuid,timestamptz) TO hon_runtime;
  END IF;
END $$;

COMMIT;
