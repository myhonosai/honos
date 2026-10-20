BEGIN;

-- Additive policy classification only: historical accounts remain intact. The
-- deterministic oldest (created_at, id) record is canonical for each payer at
-- a school; later records are retained as additional accounts.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Flexible billing account migration requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')) THEN
    RAISE EXCEPTION 'Flexible billing account migration requires a restricted runtime';
  END IF;
END $$;

ALTER TABLE hon.billing_accounts ADD COLUMN account_classification text;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY organization_id, school_id, responsible_person_id
    ORDER BY created_at ASC, id ASC
  ) AS account_rank
  FROM hon.billing_accounts
)
UPDATE hon.billing_accounts AS account
SET account_classification = CASE WHEN ranked.account_rank = 1 THEN 'CANONICAL' ELSE 'ADDITIONAL' END
FROM ranked
WHERE ranked.id = account.id;

ALTER TABLE hon.billing_accounts
  ALTER COLUMN account_classification SET DEFAULT 'CANONICAL',
  ALTER COLUMN account_classification SET NOT NULL,
  ADD CONSTRAINT billing_accounts_account_classification_check
    CHECK (account_classification IN ('CANONICAL', 'ADDITIONAL'));

-- This policy constraint is intentionally partial: additional accounts are
-- permitted only by the audited explicit command; no account is merged or
-- reassigned here.
CREATE UNIQUE INDEX billing_accounts_one_canonical_per_payer_idx
  ON hon.billing_accounts (organization_id, school_id, responsible_person_id)
  WHERE account_classification = 'CANONICAL';

-- Reassert the existing direct-table tenant boundary; this migration adds no
-- payment schema, grants, policy widening, or bypass path.
ALTER TABLE hon.billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.billing_accounts FORCE ROW LEVEL SECURITY;

-- The conventional service keeps IAM directory tables private from the runtime
-- role. Recheck the command's direct human authority inside this fixed definer
-- boundary instead of widening direct principal/grant reads.
CREATE FUNCTION hon.require_current_direct_human_billing_account_actor(p_principal_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE org uuid; school uuid; actor uuid;
BEGIN
  IF p_principal_id IS NULL
    OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'BILLING_ACCOUNT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  BEGIN
    org := hon.current_organization_id();
    school := hon.current_school_id();
    actor := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'BILLING_ACCOUNT_FORBIDDEN' USING ERRCODE = '42501';
  END;
  IF actor IS DISTINCT FROM p_principal_id
    OR org::text IS DISTINCT FROM current_setting('app.hon_organization_id', true)
    OR school::text IS DISTINCT FROM current_setting('app.hon_school_id', true) THEN
    RAISE EXCEPTION 'BILLING_ACCOUNT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM hon.principals AS principal
    WHERE principal.id = actor AND principal.principal_type = 'HUMAN_USER' AND principal.is_active
      AND (SELECT count(*) FROM hon.principals AS other
        WHERE other.user_id = principal.user_id AND other.is_active) = 1
      AND EXISTS (SELECT 1 FROM hon.organizations AS organization
        WHERE organization.id = org AND organization.status = 'ACTIVE')
      AND EXISTS (SELECT 1 FROM hon.schools AS current_school
        WHERE current_school.id = school AND current_school.organization_id = org AND current_school.status = 'ACTIVE')
      AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq WHERE hq.principal_id = actor)
      AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants AS family WHERE family.principal_id = actor
        AND family.effective_from <= clock_timestamp() AND (family.effective_until IS NULL OR family.effective_until > clock_timestamp()))
      AND NOT EXISTS (
        SELECT 1 FROM hon.principal_role_grants AS mixed
        JOIN hon.roles AS mixed_role ON mixed_role.id = mixed.role_id AND mixed_role.organization_id = mixed.organization_id
        WHERE mixed.principal_id = actor AND mixed.revoked_at IS NULL
          AND mixed.effective_from <= clock_timestamp() AND (mixed.effective_until IS NULL OR mixed.effective_until > clock_timestamp())
          AND mixed_role.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
      )
      AND hon.staff_member_eligible(actor, org, school)
      AND hon.principal_has_school_permission(actor, org, school, 'billing.account.create')
  ) THEN
    RAISE EXCEPTION 'BILLING_ACCOUNT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN true;
END $$;

-- The runtime may INSERT but intentionally has no UPDATE/DELETE privilege. Keep
-- the table-level serialization lock inside this fixed reauthorizing boundary.
CREATE FUNCTION hon.lock_current_direct_human_billing_accounts(p_principal_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  PERFORM hon.require_current_direct_human_billing_account_actor(p_principal_id);
  LOCK TABLE hon.billing_accounts IN SHARE ROW EXCLUSIVE MODE;
  PERFORM hon.require_current_direct_human_billing_account_actor(p_principal_id);
END $$;

REVOKE ALL ON FUNCTION hon.require_current_direct_human_billing_account_actor(uuid),
  hon.lock_current_direct_human_billing_accounts(uuid) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.require_current_direct_human_billing_account_actor(uuid),hon.lock_current_direct_human_billing_accounts(uuid) FROM %I', role_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.require_current_direct_human_billing_account_actor(uuid),
      hon.lock_current_direct_human_billing_accounts(uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
