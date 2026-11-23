BEGIN;

-- 0659 (allocated by the coordinator 2026-11-23): membership details on the contact card's Membership tab. Owner (David),
-- 2026-11-21: "membership section should let staff create membership, send agreement for sign, have membership info and more."
-- One read-only entry point, hon.read_school_contact_membership_details(subject, {personId}), for the session school only.
-- Authority: the 0521 contacts actor (a direct human at the session school with live people.read, active school, organization
-- and HON entitlement; HQ, family, delegated and automated callers refused), then the 0522 per-section checks:
--   items (payer and payment schedule: cadence, amount, next charge)  billing.membership.read, as the card's membership tab
--   paid and due per membership                                        one of the 0280 receivables-reader codes, as the card's
--                                                                      billing tab; otherwise null, so a membership-only role
--                                                                      never sees payment amounts
-- The same memberships as the card's membership tab (not DRAFT, newest 20). Nothing is written, sent or charged; no card,
-- method or processor fact is returned.

CREATE FUNCTION hon.read_school_contact_membership_details(p_subject text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
  actor uuid; pid uuid; can_billing boolean; can_invoices boolean; items jsonb;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  actor:=hon.require_school_contacts_actor(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k<>'personId')
    OR jsonb_typeof(p_input->'personId') IS DISTINCT FROM 'string' OR lower(p_input->>'personId') !~ uuid_re THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  pid:=(p_input->>'personId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM hon.people WHERE id=pid AND organization_id=org AND school_id=school) THEN
    RAISE EXCEPTION 'SCHOOL_CONTACT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  can_billing:=hon.school_contact_card_can(actor,org,school,'billing.membership.read');
  IF NOT can_billing THEN RETURN jsonb_build_object('allowed',false); END IF;
  can_invoices:=hon.school_contact_card_can(actor,org,school,'billing.invoice.create')
    OR hon.school_contact_card_can(actor,org,school,'billing.invoice.issue')
    OR hon.school_contact_card_can(actor,org,school,'billing.invoice.payment.record');

  items:=coalesce((SELECT jsonb_agg(jsonb_build_object('membershipId',x.id,
      'payer',(SELECT jsonb_build_object('personId',p.id,'givenName',p.given_name,'familyName',p.family_name)
        FROM hon.billing_accounts a JOIN hon.people p ON p.id=a.responsible_person_id AND p.organization_id=org AND p.school_id=school
        WHERE a.id=x.billing_account_id AND a.organization_id=org AND a.school_id=school),
      'schedule',(SELECT jsonb_build_object('frequency',s.frequency,'amountMinor',s.amount_minor,'currency',s.currency::text,
          'nextChargeAt',hon.school_contact_card_time(s.next_charge_at),'autoRenew',s.auto_renew,'status',s.status)
        FROM hon.membership_payment_schedules s WHERE s.membership_id=x.id AND s.organization_id=org AND s.school_id=school
        ORDER BY (s.status='CANCELLED'), s.created_at DESC, s.id LIMIT 1),
      'paid',CASE WHEN NOT can_invoices THEN NULL ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('currency',t.currency,'paidMinor',t.paid,'dueMinor',t.due) ORDER BY t.currency)
        FROM (SELECT i.currency::text AS currency, sum(coalesce(pd.paid,0))::bigint AS paid,
            sum(CASE WHEN i.status='ISSUED' THEN greatest(i.total_minor-coalesce(pd.paid,0),0) ELSE 0 END)::bigint AS due
          FROM hon.invoices i
          LEFT JOIN LATERAL (SELECT sum(r.amount_minor) AS paid FROM hon.invoice_payment_records r
            WHERE r.invoice_id=i.id AND r.organization_id=org AND r.school_id=school AND r.voided_at IS NULL) pd ON true
          WHERE i.organization_id=org AND i.school_id=school AND i.membership_id=x.id AND i.status IN ('ISSUED','PAID')
          GROUP BY i.currency) t), '[]'::jsonb) END,
      'lastPaidOn',CASE WHEN NOT can_invoices THEN NULL ELSE (SELECT to_char(max(r.received_on),'YYYY-MM-DD') FROM hon.invoice_payment_records r
        JOIN hon.invoices i ON i.id=r.invoice_id AND i.organization_id=org AND i.school_id=school AND i.membership_id=x.id
        WHERE r.organization_id=org AND r.school_id=school AND r.voided_at IS NULL) END)
    ORDER BY x.term_started_at DESC NULLS LAST, x.id)
    FROM (SELECT * FROM hon.memberships x WHERE x.organization_id=org AND x.school_id=school AND x.participant_person_id=pid AND x.state<>'DRAFT'
      ORDER BY x.term_started_at DESC NULLS LAST, x.id LIMIT 20) x), '[]'::jsonb);

  -- Authority is decided again after every read, so a grant revoked meanwhile returns nothing.
  PERFORM hon.require_school_contacts_actor(p_subject);
  IF NOT hon.school_contact_card_can(actor,org,school,'billing.membership.read') THEN RETURN jsonb_build_object('allowed',false); END IF;
  RETURN jsonb_build_object('allowed',true,'money',can_invoices,'items',items);
END $$;

REVOKE ALL ON FUNCTION hon.read_school_contact_membership_details(text,jsonb) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','authenticator','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_school_contact_membership_details(text,jsonb) FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_contact_membership_details(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
