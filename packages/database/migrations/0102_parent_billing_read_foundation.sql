BEGIN;

-- Parent/Eian billing is a deliberately narrow, conventional observation-only
-- boundary. It has no caller-selected school, family, child, account, invoice,
-- payment, provider, or action identifier. The verified subject is resolved to
-- exactly one live guardian family inside this function; staff, HQ, and VIEWER
-- access never become a billing fallback.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Trusted parent billing migration owner required';
  END IF;
END $$;

-- Reassert the canonical forced-RLS posture on the operational inputs. The
-- projection below does not add a table policy or broad family access; all
-- direct data-plane access remains the reviewed school-scoped runtime minimum.
ALTER TABLE hon.billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.billing_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.payment_attempts FORCE ROW LEVEL SECURITY;

-- These indexes serve the exact current-family participant/payer and linked
-- invoice observations. They contain no new derived parent data store.
CREATE INDEX IF NOT EXISTS parent_billing_membership_participant_scope_idx
  ON hon.memberships (organization_id, school_id, participant_person_id, billing_account_id, id);
CREATE INDEX IF NOT EXISTS parent_billing_invoice_membership_scope_idx
  ON hon.invoices (organization_id, school_id, membership_id, due_at, id);
CREATE INDEX IF NOT EXISTS parent_billing_payment_invoice_scope_idx
  ON hon.payment_attempts (organization_id, school_id, invoice_id, initiated_at DESC, id DESC);

CREATE FUNCTION hon.read_parent_billing_view(p_subject text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_scope record;
  v_scope_count integer;
  v_unsafe_link boolean;
  v_memberships jsonb;
  v_invoices jsonb;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject THEN
    RAISE EXCEPTION 'PARENT_BILLING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- resolve_parent_journey_scopes itself proves an active HUMAN_USER principal,
  -- active tenant topology, live family grant, and a current family. Its two-row
  -- cap intentionally makes multi-family accounts ambiguous rather than picking
  -- a school or family. Billing additionally requires an actual guardian grant;
  -- a VIEWER is never treated as a payer or billing authority.
  SELECT count(*) INTO v_scope_count FROM hon.resolve_parent_journey_scopes(p_subject);
  IF v_scope_count <> 1 THEN
    RAISE EXCEPTION 'PARENT_BILLING_SCOPE_AMBIGUOUS' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_scope FROM hon.resolve_parent_journey_scopes(p_subject);
  IF v_scope.access_level NOT IN ('PRIMARY_GUARDIAN'::hon.family_access_level, 'SECONDARY_GUARDIAN'::hon.family_access_level) THEN
    RAISE EXCEPTION 'PARENT_BILLING_GUARDIAN_REQUIRED' USING ERRCODE = '42501';
  END IF;

  -- A membership is observable only when both sides of its family linkage are
  -- current and explicit: its participant is a current-family STUDENT and the
  -- billing-account responsible person is a current-family GUARDIAN designated
  -- as billing contact. Do not guess from a shared school, surname, account, or
  -- principal. If any child membership lacks that proof, suppress all billing
  -- facts instead of silently claiming the remaining result is complete.
  SELECT EXISTS (
    SELECT 1
    FROM hon.memberships AS membership
    JOIN hon.family_members AS participant
      ON participant.person_id = membership.participant_person_id
     AND participant.organization_id = membership.organization_id
     AND participant.school_id = membership.school_id
     AND participant.family_id = v_scope.family_id
     AND participant.member_role = 'STUDENT'::hon.family_member_role
    LEFT JOIN hon.billing_accounts AS account
      ON account.id = membership.billing_account_id
     AND account.organization_id = membership.organization_id
     AND account.school_id = membership.school_id
    LEFT JOIN hon.family_members AS payer
      ON payer.person_id = account.responsible_person_id
     AND payer.organization_id = account.organization_id
     AND payer.school_id = account.school_id
     AND payer.family_id = v_scope.family_id
     AND payer.member_role = 'GUARDIAN'::hon.family_member_role
     AND payer.is_billing_contact
    WHERE membership.organization_id = v_scope.organization_id
      AND membership.school_id = v_scope.school_id
      AND payer.id IS NULL
  ) INTO v_unsafe_link;

  IF v_unsafe_link THEN
    RETURN jsonb_build_object(
      'generatedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'accessLevel', v_scope.access_level::text,
      'memberships', jsonb_build_object('status', 'UNAVAILABLE', 'reason', 'PAYER_LINK_UNVERIFIED'),
      'invoices', jsonb_build_object('status', 'UNAVAILABLE', 'reason', 'PAYER_LINK_UNVERIFIED')
    );
  END IF;

  SELECT coalesce(jsonb_agg(x.item ORDER BY x.participant_name, x.membership_id), '[]'::jsonb)
    INTO v_memberships
  FROM (
    SELECT
      membership.id AS membership_id,
      concat_ws(' ', participant_person.given_name, participant_person.family_name) AS participant_name,
      jsonb_build_object(
        'participant', jsonb_build_object(
          'displayName', concat_ws(' ', participant_person.given_name, participant_person.family_name),
          'linkage', 'CURRENT_FAMILY_STUDENT'
        ),
        'payerLinkage', 'CURRENT_FAMILY_DESIGNATED_BILLING_CONTACT',
        'state', membership.state::text,
        'termStartedAt', CASE WHEN membership.term_started_at IS NULL THEN NULL ELSE to_char(membership.term_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'termEndsAt', CASE WHEN membership.term_ends_at IS NULL THEN NULL ELSE to_char(membership.term_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
      ) AS item
    FROM hon.memberships AS membership
    JOIN hon.billing_accounts AS account
      ON account.id = membership.billing_account_id
     AND account.organization_id = membership.organization_id
     AND account.school_id = membership.school_id
    JOIN hon.family_members AS participant
      ON participant.person_id = membership.participant_person_id
     AND participant.organization_id = membership.organization_id
     AND participant.school_id = membership.school_id
     AND participant.family_id = v_scope.family_id
     AND participant.member_role = 'STUDENT'::hon.family_member_role
    JOIN hon.people AS participant_person
      ON participant_person.id = participant.person_id
     AND participant_person.organization_id = participant.organization_id
     AND participant_person.school_id = participant.school_id
    JOIN hon.family_members AS payer
      ON payer.person_id = account.responsible_person_id
     AND payer.organization_id = account.organization_id
     AND payer.school_id = account.school_id
     AND payer.family_id = v_scope.family_id
     AND payer.member_role = 'GUARDIAN'::hon.family_member_role
     AND payer.is_billing_contact
    WHERE membership.organization_id = v_scope.organization_id
      AND membership.school_id = v_scope.school_id
    ORDER BY participant_person.given_name, participant_person.family_name, membership.id
    LIMIT 51
  ) AS x;

  SELECT coalesce(jsonb_agg(x.item ORDER BY x.due_sort NULLS LAST, x.invoice_id), '[]'::jsonb)
    INTO v_invoices
  FROM (
    SELECT
      invoice.id AS invoice_id,
      invoice.due_at AS due_sort,
      jsonb_build_object(
        'participant', jsonb_build_object(
          'displayName', concat_ws(' ', participant_person.given_name, participant_person.family_name),
          'linkage', 'CURRENT_FAMILY_STUDENT'
        ),
        'status', invoice.status::text,
        'currency', invoice.currency::text,
        'totalMinor', invoice.total_minor,
        'dueAt', CASE WHEN invoice.due_at IS NULL THEN NULL ELSE to_char(invoice.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'paymentAttempts', jsonb_build_object(
          'status', 'AVAILABLE',
          'items', CASE WHEN jsonb_array_length(attempts.items) > 20 THEN attempts.items - 20 ELSE attempts.items END,
          'limited', jsonb_array_length(attempts.items) > 20
        )
      ) AS item
    FROM hon.invoices AS invoice
    JOIN hon.memberships AS membership
      ON membership.id = invoice.membership_id
     AND membership.organization_id = invoice.organization_id
     AND membership.school_id = invoice.school_id
     AND membership.billing_account_id = invoice.billing_account_id
    JOIN hon.billing_accounts AS account
      ON account.id = membership.billing_account_id
     AND account.organization_id = membership.organization_id
     AND account.school_id = membership.school_id
    JOIN hon.family_members AS participant
      ON participant.person_id = membership.participant_person_id
     AND participant.organization_id = membership.organization_id
     AND participant.school_id = membership.school_id
     AND participant.family_id = v_scope.family_id
     AND participant.member_role = 'STUDENT'::hon.family_member_role
    JOIN hon.people AS participant_person
      ON participant_person.id = participant.person_id
     AND participant_person.organization_id = participant.organization_id
     AND participant_person.school_id = participant.school_id
    JOIN hon.family_members AS payer
      ON payer.person_id = account.responsible_person_id
     AND payer.organization_id = account.organization_id
     AND payer.school_id = account.school_id
     AND payer.family_id = v_scope.family_id
     AND payer.member_role = 'GUARDIAN'::hon.family_member_role
     AND payer.is_billing_contact
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_agg(y.item ORDER BY y.initiated_at DESC, y.payment_id DESC), '[]'::jsonb) AS items
      FROM (
        SELECT payment.id AS payment_id, payment.initiated_at,
          jsonb_build_object(
            'state', payment.state::text,
            'amountMinor', payment.amount_minor,
            'currency', payment.currency::text,
            'initiatedAt', to_char(payment.initiated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'reconciledAt', CASE WHEN payment.reconciled_at IS NULL THEN NULL ELSE to_char(payment.reconciled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
          ) AS item
        FROM hon.payment_attempts AS payment
        WHERE payment.invoice_id = invoice.id
          AND payment.organization_id = invoice.organization_id
          AND payment.school_id = invoice.school_id
        ORDER BY payment.initiated_at DESC, payment.id DESC
        LIMIT 21
      ) AS y
    ) AS attempts
    WHERE invoice.organization_id = v_scope.organization_id
      AND invoice.school_id = v_scope.school_id
    ORDER BY invoice.due_at NULLS LAST, invoice.id
    LIMIT 51
  ) AS x;

  RETURN jsonb_build_object(
    'generatedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'accessLevel', v_scope.access_level::text,
    'memberships', jsonb_build_object(
      'status', 'AVAILABLE',
      'items', CASE WHEN jsonb_array_length(v_memberships) > 50 THEN v_memberships - 50 ELSE v_memberships END,
      'limited', jsonb_array_length(v_memberships) > 50
    ),
    'invoices', jsonb_build_object(
      'status', 'AVAILABLE',
      'items', CASE WHEN jsonb_array_length(v_invoices) > 50 THEN v_invoices - 50 ELSE v_invoices END,
      'limited', jsonb_array_length(v_invoices) > 50
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION hon.read_parent_billing_view(text) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'hon_runtime') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_parent_billing_view(text) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_parent_billing_view(text) TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
