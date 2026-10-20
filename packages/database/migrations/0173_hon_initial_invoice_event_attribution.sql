BEGIN;

-- Initial invoice event attribution repair (B5, test mode only).
-- 0158 remains unchanged. 0172 is reserved for Claude's independent B6A PR #38.
-- Replace only event ingestion, preserving its signature, owner, SECURITY DEFINER, search path and
-- existing function-only ACL. No tables, grants, policies, entitlements or financial calculations change.
-- Historical append-only events and completed idempotency receipts are deliberately not rewritten.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON payment provider integration requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON payment provider integration requires a restricted runtime';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.ingest_saas_provider_event(p_event jsonb, p_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); prog hon.saas_payment_program%ROWTYPE; replay jsonb; o jsonb; v_type text; at timestamptz;
  c hon.saas_checkout_sessions%ROWTYPE; result jsonb; v_key uuid; v_org uuid; ev_id uuid; v_payment uuid; keys text[];
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_event IS NULL OR jsonb_typeof(p_event) <> 'object' OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_event) k) IS DISTINCT FROM ARRAY['createdAt','eventId','livemode','object','provider','type']
    OR p_event->>'provider' NOT IN ('STRIPE','STRIPE_SIMULATED') OR coalesce(p_event->>'eventId', '') !~ '^evt_[A-Za-z0-9_]{1,200}$'
    OR jsonb_typeof(p_event->'livemode') <> 'boolean' OR coalesce(jsonb_typeof(p_event->'object'), '') <> 'object'
    OR coalesce(p_event->>'type', '') !~ '^[a-z_]+(\.[a-z_]+){1,3}$' OR length(p_event->>'type') > 80
    OR coalesce(p_event->>'createdAt', '') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF (p_event->>'livemode')::boolean THEN RAISE EXCEPTION 'SAAS_PROVIDER_LIVE_MODE_REFUSED' USING ERRCODE = '42501'; END IF;
  SELECT * INTO prog FROM hon.saas_payment_program WHERE program_id = 1 FOR SHARE;
  IF prog.status <> 'TEST_MODE' OR prog.provider <> p_event->>'provider' THEN RAISE EXCEPTION 'SAAS_PAYMENTS_NOT_ACTIVE' USING ERRCODE = '42501'; END IF;
  o := p_event->'object'; v_type := p_event->>'type'; keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(o) k);
  -- Closed shapes for the event types HON applies; amounts are integer minor units.
  IF NOT coalesce(CASE
    WHEN v_type IN ('checkout.session.completed','checkout.session.async_payment_succeeded') THEN
      keys = ARRAY['amountTotal','checkoutId','currency','customerRef','invoiceRef','paymentIntentRef','paymentStatus','sessionId','subscriptionRef']
      AND (o->>'sessionId') ~ '^cs_test_[A-Za-z0-9_]{1,200}$' AND (o->>'checkoutId') ~ '^[0-9a-f-]{36}$' AND jsonb_typeof(o->'amountTotal') = 'number'
      AND (o->>'amountTotal') ~ '^[0-9]{1,9}$' AND jsonb_typeof(o->'currency') = 'string' AND o->>'paymentStatus' IN ('paid','unpaid','no_payment_required')
      AND (jsonb_typeof(o->'customerRef') = 'null' OR (o->>'customerRef') ~ '^cus_[A-Za-z0-9]{1,100}$')
      AND (jsonb_typeof(o->'subscriptionRef') = 'null' OR (o->>'subscriptionRef') ~ '^sub_[A-Za-z0-9]{1,100}$')
      AND (jsonb_typeof(o->'paymentIntentRef') = 'null' OR (o->>'paymentIntentRef') ~ '^pi_[A-Za-z0-9_]{1,200}$')
      AND (jsonb_typeof(o->'invoiceRef') = 'null' OR (o->>'invoiceRef') ~ '^in_[A-Za-z0-9_]{1,200}$')
    WHEN v_type IN ('checkout.session.expired','checkout.session.async_payment_failed') THEN
      keys = ARRAY['checkoutId','sessionId'] AND (o->>'sessionId') ~ '^cs_test_[A-Za-z0-9_]{1,200}$' AND (o->>'checkoutId') ~ '^[0-9a-f-]{36}$'
    WHEN v_type IN ('invoice.paid','invoice.payment_failed') THEN
      keys = ARRAY['amount','billingReason','currency','invoiceRef','paymentIntentRef','periodEnd','periodStart','subscriptionRef']
      AND (o->>'invoiceRef') ~ '^in_[A-Za-z0-9_]{1,200}$' AND (o->>'subscriptionRef') ~ '^sub_[A-Za-z0-9]{1,100}$'
      AND jsonb_typeof(o->'amount') = 'number' AND (o->>'amount') ~ '^[0-9]{1,9}$' AND jsonb_typeof(o->'billingReason') = 'string'
      AND (jsonb_typeof(o->'paymentIntentRef') = 'null' OR (o->>'paymentIntentRef') ~ '^pi_[A-Za-z0-9_]{1,200}$')
      AND (o->>'periodStart') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]{12}Z$' AND (o->>'periodEnd') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]{12}Z$'
    WHEN v_type = 'charge.refunded' THEN
      keys = ARRAY['amountRefunded','chargeRef','currency','invoiceRef','paymentIntentRef'] AND (o->>'chargeRef') ~ '^(ch|py)_[A-Za-z0-9_]{1,200}$'
      AND jsonb_typeof(o->'amountRefunded') = 'number' AND (o->>'amountRefunded') ~ '^[0-9]{1,9}$'
      AND (jsonb_typeof(o->'paymentIntentRef') = 'null' OR (o->>'paymentIntentRef') ~ '^pi_[A-Za-z0-9_]{1,200}$')
      AND (jsonb_typeof(o->'invoiceRef') = 'null' OR (o->>'invoiceRef') ~ '^in_[A-Za-z0-9_]{1,200}$')
    WHEN v_type = 'charge.dispute.created' THEN
      keys = ARRAY['amount','chargeRef','currency','disputeRef','paymentIntentRef'] AND (o->>'chargeRef') ~ '^(ch|py)_[A-Za-z0-9_]{1,200}$'
      AND (o->>'disputeRef') ~ '^(dp|du)_[A-Za-z0-9_]{1,200}$' AND jsonb_typeof(o->'amount') = 'number' AND (o->>'amount') ~ '^[0-9]{1,9}$'
      AND (jsonb_typeof(o->'paymentIntentRef') = 'null' OR (o->>'paymentIntentRef') ~ '^pi_[A-Za-z0-9_]{1,200}$')
    ELSE keys IS NULL OR keys = ARRAY[]::text[] END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_key := md5('saas.provider.event:' || (p_event->>'provider') || ':' || (p_event->>'eventId'))::uuid;
  replay := hon.saas_claim_request(actor, v_key, 'saas.provider.event', p_digest, gen_random_uuid(), gen_random_uuid());
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  IF v_type LIKE 'checkout.session.%' THEN
    SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = (o->>'checkoutId')::uuid AND provider = p_event->>'provider';
    IF c.id IS NULL OR (c.provider_session_id IS NOT NULL AND c.provider_session_id <> o->>'sessionId')
      OR EXISTS (SELECT 1 FROM hon.saas_checkout_sessions x WHERE x.provider_session_id = o->>'sessionId' AND x.id <> c.id) THEN
      result := jsonb_build_object('outcome','NEEDS_REVIEW','detail','UNKNOWN_CHECKOUT');
      c := NULL;
    ELSE
      v_org := c.organization_id;
      IF c.provider_session_id IS NULL THEN
        -- The adapter outcome was unknown, but the provider proves the session: attach it (no URL is shown again).
        UPDATE hon.saas_checkout_sessions SET provider_session_id = o->>'sessionId', version = version + 1, updated_at = at WHERE id = c.id;
      END IF;
      IF v_type IN ('checkout.session.completed','checkout.session.async_payment_succeeded') THEN
        IF o->>'paymentStatus' = 'paid' THEN
          result := hon.saas_activate_checkout(c.id, p_event, at);
        ELSE
          result := jsonb_build_object('outcome','AWAITING_ASYNC_PAYMENT','detail','PAYMENT_PENDING');
        END IF;
      ELSE
        SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = c.id FOR UPDATE;
        IF c.status IN ('CREATED','OPEN') THEN
          PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
          PERFORM hon.saas_close_checkout(c.id, CASE WHEN v_type = 'checkout.session.expired' THEN 'EXPIRED' ELSE 'FAILED' END,
            CASE WHEN v_type = 'checkout.session.expired' THEN 'PROVIDER_EXPIRED' ELSE 'ASYNC_PAYMENT_FAILED' END, actor, at);
          result := jsonb_build_object('outcome','APPLIED','detail',CASE WHEN v_type = 'checkout.session.expired' THEN 'CHECKOUT_EXPIRED' ELSE 'ASYNC_PAYMENT_FAILED' END);
        ELSE
          result := jsonb_build_object('outcome','IGNORED','detail','CHECKOUT_ALREADY_CLOSED');
        END IF;
      END IF;
    END IF;
  ELSIF v_type = 'invoice.paid' THEN
    IF o->>'billingReason' = 'subscription_create' THEN
      -- The subscription reference is not bound until checkout completion commits. Never finalize
      -- an unattributed success: the exception rolls back the request claim as well as this event.
      SELECT * INTO c FROM hon.saas_checkout_sessions WHERE provider = p_event->>'provider' AND provider_subscription_ref = o->>'subscriptionRef';
      IF c.id IS NULL THEN
        -- Same conservative dependency test as saas_apply_renewal. An open checkout is not a tenant
        -- match; it only defers disposition. No organization is guessed from metadata or another row.
        IF EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE provider = p_event->>'provider' AND status IN ('CREATED','OPEN')) THEN
          RAISE EXCEPTION 'SAAS_PROVIDER_EVENT_NOT_READY' USING ERRCODE = '55006';
        END IF;
        result := jsonb_build_object('outcome','NEEDS_REVIEW','detail','UNKNOWN_PROVIDER_SUBSCRIPTION');
      ELSE
        v_org := c.organization_id;
        IF c.status IN ('CREATED','OPEN') THEN
          RAISE EXCEPTION 'SAAS_PROVIDER_EVENT_NOT_READY' USING ERRCODE = '55006';
        ELSIF c.status <> 'COMPLETED' OR c.subscription_id IS NULL OR c.invoice_id IS NULL THEN
          result := jsonb_build_object('outcome','NEEDS_REVIEW','detail','SUBSCRIPTION_NOT_BILLABLE','organizationId',c.organization_id);
        ELSE
          SELECT e.id INTO v_payment FROM hon.saas_payment_evidence e
            WHERE e.invoice_id = c.invoice_id AND e.organization_id = c.organization_id AND e.subscription_id = c.subscription_id
              AND e.kind = 'PAYMENT_RECEIVED' AND e.source = 'PROVIDER_VERIFIED' AND e.provider_code = p_event->>'provider' AND e.provider_mode = 'TEST'
            ORDER BY e.recorded_at, e.id LIMIT 1;
          IF v_payment IS NULL THEN
            result := jsonb_build_object('outcome','NEEDS_REVIEW','detail','UNMATCHED_PAYMENT','subscriptionId',c.subscription_id);
          ELSE
            PERFORM hon.saas_link_payment_refs(p_event->>'provider', ARRAY[o->>'invoiceRef', o->>'paymentIntentRef'], v_payment, at);
            result := jsonb_build_object('outcome','ALREADY_APPLIED','detail','FIRST_INVOICE_COVERED_BY_CHECKOUT','subscriptionId',c.subscription_id);
          END IF;
        END IF;
      END IF;
    ELSE
      result := hon.saas_apply_renewal(jsonb_set(p_event, '{object,amountPaid}', o->'amount'), at);
    END IF;
  ELSIF v_type = 'invoice.payment_failed' THEN
    SELECT * INTO c FROM hon.saas_checkout_sessions WHERE provider = p_event->>'provider' AND provider_subscription_ref = o->>'subscriptionRef';
    -- Recorded for payment status (PAST_DUE); HON never suspends, cancels or retries automatically.
    result := CASE WHEN c.id IS NULL THEN jsonb_build_object('outcome','NEEDS_REVIEW','detail','UNKNOWN_PROVIDER_SUBSCRIPTION')
      ELSE jsonb_build_object('outcome','APPLIED','detail','RENEWAL_PAYMENT_FAILED','subscriptionId',c.subscription_id,'organizationId',c.organization_id) END;
  ELSIF v_type IN ('charge.refunded','charge.dispute.created') THEN
    result := hon.saas_apply_reversal(p_event, at);
  ELSE
    result := jsonb_build_object('outcome','IGNORED','detail','EVENT_TYPE_NOT_USED');
  END IF;
  v_org := coalesce(v_org, (result->>'organizationId')::uuid,
    (SELECT organization_id FROM hon.saas_subscriptions WHERE id = (result->>'subscriptionId')::uuid));
  INSERT INTO hon.saas_provider_events(provider,provider_event_id,event_type,livemode,provider_created_at,received_at,payload_digest,normalized,
      organization_id,checkout_id,subscription_id,outcome,outcome_detail)
    VALUES (p_event->>'provider',p_event->>'eventId',v_type,false,(p_event->>'createdAt')::timestamptz,at,p_digest,p_event,
      v_org,c.id,(result->>'subscriptionId')::uuid,result->>'outcome',result->>'detail')
    RETURNING id INTO ev_id;
  result := jsonb_build_object('eventId', ev_id, 'providerEventId', p_event->>'eventId', 'type', v_type, 'outcome', result->>'outcome',
    'detail', result->>'detail', 'organizationId', v_org, 'checkoutId', c.id, 'subscriptionId', result->>'subscriptionId');
  RETURN hon.saas_record(actor, v_key, 'saas.provider.event', 'saas.provider.event_recorded', 'PROVIDER_EVENT', ev_id, v_org, NULL, result,
    jsonb_build_object('event', result), at);
END $$;

COMMIT;
