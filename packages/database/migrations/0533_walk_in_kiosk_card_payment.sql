BEGIN;

-- Walk-in kiosk WK3 (0533, assigned by the coordinator 2026-11-18). Owner request (David, 2026-11-16): the kiosk is a
-- quick intake, waiver and "day pass or trial purchase"; owner decision (2026-11-16): pay on the tablet, with the front desk
-- as backup, and by a QR code on the visitor's own phone, TEST mode only. Spec: docs/architecture/WALK_IN_KIOSK.md section 9.
-- It is the walk-in caller of the shared one-time payment (0529, docs/architecture/TUITION_COLLECTION.md section 22):
--   K1  A PAY_AT_DESK visit can also be paid by card through HON: payment_state PAID_CARD, with the 0529 payment that paid it.
--       Only PAY_AT_DESK moves, once, to PAID_AT_DESK or PAID_CARD.
--   K2  The tablet that recorded a visit (and only it, while it is live, within 2 hours, by the same visit key it submitted
--       with) can open one card payment for that visit at the frozen offer price (hon.open_walkin_card_payment), and read and
--       settle it (hon.settle_walkin_card_payment). The payment id goes to the API only, never to a browser: every tablet
--       call names the visit by its key, and the payment is found from the visit, so no foreign payment can be named.
--   K3  Marking a visit paid at the desk first ends any card payment: one never started is cancelled here; one that reached
--       the processor must be cancelled through the API first (WALKIN_CARD_PAYMENT_OPEN); one still clearing is refused
--       (WALKIN_CARD_PAYMENT_IN_PROGRESS); one the visitor already paid marks the visit PAID_CARD instead, so nobody pays twice.
--   K4  The API reads a visit's card payment for that step only through hon.read_walkin_visit_card_payment (walkin_kiosk.run).
-- Test mode only: 0529 uses only a school's TEST connection. HON takes no fee. No message, refund or AI. Nothing here
-- deploys or turns anything on.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Walk-in kiosk card payment requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Walk-in kiosk card payment requires a restricted runtime';
  END IF;
  IF to_regclass('hon.walkin_visits') IS NULL OR to_regprocedure('hon.submit_walkin_visit(text,jsonb,text)') IS NULL
    OR to_regclass('hon.school_pay_once') IS NULL
    OR to_regprocedure('hon.school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz)') IS NULL
    OR to_regprocedure('hon.school_pay_once_state(uuid)') IS NULL OR to_regprocedure('hon.school_pay_once_cancel(uuid)') IS NULL
    OR to_regprocedure('hon.school_pay_once_provider(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Walk-in kiosk card payment requires 0414 and 0529';
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid='hon.walkin_visits'::regclass AND c.conname='walkin_visits_payment_state_check')
    IS DISTINCT FROM 'CHECK ((payment_state = ANY (ARRAY[''FREE''::text, ''PAY_AT_DESK''::text, ''PAID_AT_DESK''::text])))' THEN
    RAISE EXCEPTION 'Walk-in visits payment state check has an unexpected definition';
  END IF;
END $$;

-- K1: card payment columns. The payment row is the 0529 record of what the processor said.
ALTER TABLE hon.walkin_visits DROP CONSTRAINT walkin_visits_payment_state_check;
ALTER TABLE hon.walkin_visits
  ADD COLUMN card_payment_id uuid UNIQUE REFERENCES hon.school_pay_once(id) ON DELETE RESTRICT,
  ADD COLUMN card_paid_at timestamptz,
  ADD CONSTRAINT walkin_visits_payment_state_check CHECK (payment_state IN ('FREE','PAY_AT_DESK','PAID_AT_DESK','PAID_CARD')),
  ADD CONSTRAINT walkin_visits_card_paid_check CHECK ((payment_state='PAID_CARD')=(card_payment_id IS NOT NULL) AND (card_payment_id IS NULL)=(card_paid_at IS NULL));

-- Settings-free guards (0414), with K1: visits move only PAY_AT_DESK -> PAID_AT_DESK or PAY_AT_DESK -> PAID_CARD, once.
CREATE OR REPLACE FUNCTION hon.guard_walkin_kiosk() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='walkin_kiosk_settings' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.version<>1 OR NEW.waiver_version<>1 THEN RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
      RETURN NEW;
    END IF;
    IF (NEW.organization_id,NEW.school_id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.created_at)
      OR NEW.version<>OLD.version+1 OR NEW.waiver_version NOT IN (OLD.waiver_version,OLD.waiver_version+1)
      OR ((NEW.waiver_version=OLD.waiver_version)<>(NEW.waiver IS NOT DISTINCT FROM OLD.waiver)) THEN
      RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='walkin_kiosk_devices' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.version<>1 OR NEW.ended_at IS NOT NULL THEN RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
      RETURN NEW;
    END IF;
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.label,NEW.token_digest,NEW.started_by,NEW.started_at,NEW.ends_at)
        IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.label,OLD.token_digest,OLD.started_by,OLD.started_at,OLD.ends_at)
      OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='walkin_visits' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.version<>1 OR NEW.payment_state NOT IN ('FREE','PAY_AT_DESK') OR NEW.card_payment_id IS NOT NULL OR NEW.card_paid_at IS NOT NULL THEN
        RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
      RETURN NEW;
    END IF;
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.device_id,NEW.lead_id,NEW.contact_person_id,NEW.language,NEW.settings_version,NEW.offer_key,
        NEW.offer_kind,NEW.offer_name,NEW.price_minor,NEW.currency,NEW.emergency_name,NEW.emergency_phone,NEW.heard_from,NEW.marketing_opt_in,
        NEW.local_date,NEW.key_hash,NEW.payload_hash,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.device_id,OLD.lead_id,OLD.contact_person_id,OLD.language,OLD.settings_version,OLD.offer_key,
        OLD.offer_kind,OLD.offer_name,OLD.price_minor,OLD.currency,OLD.emergency_name,OLD.emergency_phone,OLD.heard_from,OLD.marketing_opt_in,
        OLD.local_date,OLD.key_hash,OLD.payload_hash,OLD.created_at)
      OR NEW.version<>OLD.version+1 OR OLD.payment_state<>'PAY_AT_DESK' OR NEW.payment_state NOT IN ('PAID_AT_DESK','PAID_CARD') THEN
      RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  -- walkin_waiver_texts, walkin_visit_participants, walkin_waiver_signatures: insert only.
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- The visit as staff see it (0414), with when it was paid by card.
CREATE OR REPLACE FUNCTION hon.walkin_visit_json(v hon.walkin_visits) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('visitId',v.id,'leadId',v.lead_id,'createdAt',hon.walkin_utc(v.created_at),'localDate',to_char(v.local_date,'YYYY-MM-DD'),
    'language',v.language,'offer',jsonb_build_object('key',v.offer_key,'kind',v.offer_kind,'name',v.offer_name,'priceMinor',v.price_minor,'currency',v.currency),
    'paymentState',v.payment_state,'deskMethod',v.desk_method,'deskPaidAt',hon.walkin_utc(v.desk_paid_at),'cardPaidAt',hon.walkin_utc(v.card_paid_at),
    'contact',(SELECT jsonb_build_object('givenName',p.given_name,'familyName',p.family_name,'email',p.email::text,'mobile',p.phone_e164) FROM hon.people p WHERE p.id=v.contact_person_id),
    'participants',coalesce((SELECT jsonb_agg(jsonb_build_object('givenName',x.given_name,'familyName',x.family_name,'birthDate',to_char(x.birth_date,'YYYY-MM-DD'),
      'isContact',x.is_contact,'isMinor',x.is_minor) ORDER BY x.ordinal) FROM hon.walkin_visit_participants x WHERE x.visit_id=v.id),'[]'::jsonb),
    'emergencyName',v.emergency_name,'emergencyPhone',v.emergency_phone,'heardFrom',v.heard_from,'marketingOptIn',v.marketing_opt_in,
    'waiverSignedAt',(SELECT hon.walkin_utc(s.signed_at) FROM hon.walkin_waiver_signatures s WHERE s.visit_id=v.id),
    'version',v.version)
$$;

-- The newest 0529 payment of a visit (any state), or NULL.
CREATE FUNCTION hon.walkin_card_payment_of(v hon.walkin_visits) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT p.id FROM hon.school_pay_once p WHERE p.organization_id=v.organization_id AND p.school_id=v.school_id
    AND p.source='WALKIN_VISIT' AND p.source_id=v.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1
$$;

-- K1: mark a PAY_AT_DESK visit PAID_CARD from the locked 0529 state `s` of its own payment (exact scope, record, amount and
-- currency), with one audit row and one internal outbox event. Returns the updated visit.
CREATE FUNCTION hon.walkin_card_paid(v hon.walkin_visits,s jsonb,actor uuid,source text,request uuid) RETURNS hon.walkin_visits
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF v.payment_state<>'PAY_AT_DESK' OR s->>'state' IS DISTINCT FROM 'SUCCEEDED' OR s->>'source' IS DISTINCT FROM 'WALKIN_VISIT'
    OR (s->>'sourceId')::uuid IS DISTINCT FROM v.id OR (s->>'organizationId')::uuid IS DISTINCT FROM v.organization_id
    OR (s->>'schoolId')::uuid IS DISTINCT FROM v.school_id OR (s->>'amountMinor')::bigint IS DISTINCT FROM v.price_minor::bigint
    OR s->>'currency' IS DISTINCT FROM v.currency THEN RAISE EXCEPTION 'WALKIN_CARD_PAYMENT_MISMATCH' USING ERRCODE='22023'; END IF;
  UPDATE hon.walkin_visits SET payment_state='PAID_CARD',card_payment_id=(s->>'paymentId')::uuid,card_paid_at=clock_timestamp(),
    version=version+1,updated_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(v.organization_id,v.school_id,actor,source,'walkin_kiosk.visit.card_paid','WALKIN_VISIT',v.id,
      jsonb_build_object('visitId',v.id,'paymentState','PAY_AT_DESK','version',v.version-1),
      jsonb_build_object('visitId',v.id,'paymentState',v.payment_state,'paymentId',v.card_payment_id,'version',v.version),'SUCCEEDED',request,request);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(v.organization_id,v.school_id,'walkin_kiosk.visit_card_paid',1,'WALKIN_VISIT',v.id,v.version,request,request,
      jsonb_build_object('visitId',v.id,'paymentId',v.card_payment_id,'internalOnly',true));
  RETURN v;
END $$;

-- K2: the live tablet for `digest`, with the same authority held still for this transaction as a visit submit (0414 W3):
-- lock order organization -> school -> settings -> device, then the starter's grants, role permissions and entitlement rows,
-- decided again. NULL id when it is not a live tablet.
CREATE FUNCTION hon.walkin_tablet_hold(digest text) RETURNS hon.walkin_kiosk_devices
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE d hon.walkin_kiosk_devices%ROWTYPE; k hon.walkin_kiosk_settings%ROWTYPE; none hon.walkin_kiosk_devices%ROWTYPE;
  svc constant uuid:='00000000-0000-4000-8000-000000000414';
BEGIN
  d:=hon.walkin_live_device(digest);
  IF d.id IS NULL THEN RETURN none; END IF;
  PERFORM 1 FROM hon.organizations WHERE id=d.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN none; END IF;
  PERFORM 1 FROM hon.schools WHERE id=d.school_id AND organization_id=d.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN none; END IF;
  SELECT * INTO k FROM hon.walkin_kiosk_settings WHERE organization_id=d.organization_id AND school_id=d.school_id FOR SHARE;
  SELECT * INTO d FROM hon.walkin_kiosk_devices WHERE id=d.id FOR SHARE;
  IF NOT k.enabled OR d.ended_at IS NOT NULL OR d.ends_at<=clock_timestamp() THEN RETURN none; END IF;
  PERFORM 1 FROM hon.principals WHERE id=d.started_by FOR SHARE;
  PERFORM 1 FROM hon.principal_role_grants g WHERE g.principal_id=d.started_by AND g.organization_id=d.organization_id AND g.revoked_at IS NULL ORDER BY g.id FOR SHARE;
  PERFORM 1 FROM hon.role_permissions rp WHERE rp.organization_id=d.organization_id AND rp.permission_code='walkin_kiosk.run'
    AND rp.role_id IN (SELECT g.role_id FROM hon.principal_role_grants g WHERE g.principal_id=d.started_by AND g.organization_id=d.organization_id)
    ORDER BY rp.role_id FOR SHARE;
  PERFORM 1 FROM hon.organization_entitlements e WHERE e.organization_id=d.organization_id FOR SHARE;
  IF NOT hon.walkin_principal_holds(d.started_by,d.organization_id,d.school_id,'walkin_kiosk.run') THEN RETURN none; END IF;
  PERFORM 1 FROM hon.principals WHERE id=svc AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active FOR SHARE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id=svc) OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=svc)
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=svc) THEN RETURN none; END IF;
  RETURN d;
END $$;

-- K2: the visit this tablet recorded with `key` in the last 2 hours, locked FOR UPDATE. NULL id otherwise.
CREATE FUNCTION hon.walkin_tablet_visit(d hon.walkin_kiosk_devices,key text) RETURNS hon.walkin_visits
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT v.* FROM hon.walkin_visits v WHERE v.device_id=d.id AND v.organization_id=d.organization_id AND v.school_id=d.school_id
    AND v.key_hash=encode(sha256(convert_to(d.token_digest||':key:'||key,'UTF8')),'hex') AND v.created_at>clock_timestamp()-interval '2 hours'
  FOR UPDATE
$$;

-- K2 tablet: which processor would take a card here (STRIPE_CONNECT, SQUARE) or null, for the API to decide which ways to
-- offer. {providerCode} or NULL for any token that is not a live tablet. No DML.
CREATE FUNCTION hon.read_walkin_card_provider(digest text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE d hon.walkin_kiosk_devices%ROWTYPE;
BEGIN
  d:=hon.walkin_live_device(digest);
  IF d.id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('providerCode',hon.school_pay_once_provider(d.organization_id,d.school_id));
END $$;

-- K2 tablet: open (or get back) the card payment for the visit recorded with `key`. Returns {result}: OPEN or PROCESSING
-- (with paymentId and providerCode, for the API only), PAID, NOT_DUE, NOT_AVAILABLE, NOT_FOUND, INVALID, CLOSED or
-- RATE_LIMITED. The amount is the frozen offer price; the label is the offer name; no payer detail is sent.
CREATE FUNCTION hon.open_walkin_card_payment(digest text,key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE d hon.walkin_kiosk_devices%ROWTYPE; v hon.walkin_visits%ROWTYPE; pay uuid; s jsonb; provider text;
  svc constant uuid:='00000000-0000-4000-8000-000000000414';
BEGIN
  IF digest IS NULL OR digest !~ '^[a-f0-9]{64}$' OR key IS NULL OR key !~ '^[A-Za-z0-9_-]{16,100}$' THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  d:=hon.walkin_tablet_hold(digest);
  IF d.id IS NULL THEN RETURN jsonb_build_object('result','CLOSED'); END IF;
  IF NOT hon.take_walkin_kiosk_rate(d.id,encode(sha256(convert_to(d.token_digest||':card-open','UTF8')),'hex'),120) THEN
    RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
  v:=hon.walkin_tablet_visit(d,key);
  IF v.id IS NULL THEN RETURN jsonb_build_object('result','NOT_FOUND'); END IF;
  IF v.payment_state='PAID_CARD' THEN RETURN jsonb_build_object('result','PAID'); END IF;
  IF v.payment_state<>'PAY_AT_DESK' THEN RETURN jsonb_build_object('result','NOT_DUE'); END IF;
  pay:=hon.walkin_card_payment_of(v);
  IF pay IS NOT NULL THEN
    s:=hon.school_pay_once_state(pay);
    IF s->>'state'='SUCCEEDED' THEN
      PERFORM hon.walkin_card_paid(v,s,svc,'PUBLIC_API',gen_random_uuid());
      RETURN jsonb_build_object('result','PAID');
    END IF;
    IF s->>'state' IN ('OPEN','PROCESSING') THEN
      RETURN jsonb_build_object('result',s->>'state','paymentId',pay,'providerCode',s->>'providerCode');
    END IF;
  END IF;
  provider:=hon.school_pay_once_provider(v.organization_id,v.school_id);
  IF provider IS NULL THEN RETURN jsonb_build_object('result','NOT_AVAILABLE'); END IF;
  BEGIN
    pay:=hon.school_pay_once_open(v.organization_id,v.school_id,'WALKIN_VISIT',v.id,v.price_minor::bigint,v.currency,
      jsonb_build_object('name',v.offer_name),'{}'::jsonb,clock_timestamp()+interval '20 minutes');
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM='SCHOOL_PAY_ONCE_NOT_AVAILABLE' THEN RETURN jsonb_build_object('result','NOT_AVAILABLE'); END IF;
    RAISE;
  END;
  s:=hon.school_pay_once_state(pay);
  -- Decided again after the last write: if the tablet is no longer live, nothing above commits.
  IF (hon.walkin_live_device(digest)).id IS DISTINCT FROM d.id THEN RAISE EXCEPTION 'WALKIN_KIOSK_CLOSED' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('result','OPEN','paymentId',pay,'providerCode',s->>'providerCode');
END $$;

-- K2 tablet: the card payment of the visit recorded with `key`, settled into the visit when the processor's recorded answer
-- is SUCCEEDED. Returns {result}: PAID, OPEN or PROCESSING (with paymentId, for the API only), FAILED, EXPIRED, CANCELED,
-- NONE (never opened), NOT_DUE, NOT_FOUND, INVALID, CLOSED or RATE_LIMITED.
CREATE FUNCTION hon.settle_walkin_card_payment(digest text,key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE d hon.walkin_kiosk_devices%ROWTYPE; v hon.walkin_visits%ROWTYPE; pay uuid; s jsonb;
  svc constant uuid:='00000000-0000-4000-8000-000000000414';
BEGIN
  IF digest IS NULL OR digest !~ '^[a-f0-9]{64}$' OR key IS NULL OR key !~ '^[A-Za-z0-9_-]{16,100}$' THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  d:=hon.walkin_tablet_hold(digest);
  IF d.id IS NULL THEN RETURN jsonb_build_object('result','CLOSED'); END IF;
  -- About one check every 2 seconds per tablet for an hour.
  IF NOT hon.take_walkin_kiosk_rate(d.id,encode(sha256(convert_to(d.token_digest||':card-check','UTF8')),'hex'),1800) THEN
    RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
  v:=hon.walkin_tablet_visit(d,key);
  IF v.id IS NULL THEN RETURN jsonb_build_object('result','NOT_FOUND'); END IF;
  IF v.payment_state='PAID_CARD' THEN RETURN jsonb_build_object('result','PAID'); END IF;
  IF v.payment_state<>'PAY_AT_DESK' THEN RETURN jsonb_build_object('result','NOT_DUE'); END IF;
  pay:=hon.walkin_card_payment_of(v);
  IF pay IS NULL THEN RETURN jsonb_build_object('result','NONE'); END IF;
  s:=hon.school_pay_once_state(pay);
  IF s->>'state'='SUCCEEDED' THEN
    PERFORM hon.walkin_card_paid(v,s,svc,'PUBLIC_API',gen_random_uuid());
    IF (hon.walkin_live_device(digest)).id IS DISTINCT FROM d.id THEN RAISE EXCEPTION 'WALKIN_KIOSK_CLOSED' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('result','PAID');
  END IF;
  IF s->>'state' IN ('OPEN','PROCESSING') THEN RETURN jsonb_build_object('result',s->>'state','paymentId',pay); END IF;
  RETURN jsonb_build_object('result',s->>'state');
END $$;

-- K4 staff (walkin_kiosk.run): the newest card payment of one visit in the selected school, for the API to end it at the
-- processor before the visit is marked paid at the desk. {paymentId, state, providerOpen} (all null when none). No DML.
CREATE FUNCTION hon.read_walkin_visit_card_payment(subject text,selected uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); v hon.walkin_visits%ROWTYPE; x hon.school_pay_once%ROWTYPE;
BEGIN
  IF selected IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  PERFORM hon.require_walkin_actor(subject,'walkin_kiosk.run');
  SELECT * INTO v FROM hon.walkin_visits w WHERE w.id=selected AND w.organization_id=org AND w.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'WALKIN_VISIT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO x FROM hon.school_pay_once p WHERE p.id=hon.walkin_card_payment_of(v);
  IF NOT FOUND THEN RETURN jsonb_build_object('paymentId',NULL,'state',NULL,'providerOpen',NULL); END IF;
  RETURN jsonb_build_object('paymentId',x.id,'state',x.state,'providerOpen',x.state='OPEN' AND x.surface IS NOT NULL);
END $$;

-- W4 with K3: mark a PAY_AT_DESK visit paid at the desk. p = {expectedVersion, method}. Any card payment is ended first; a
-- card payment the visitor already paid marks the visit PAID_CARD instead (the receipt says so).
CREATE OR REPLACE FUNCTION hon.set_walkin_visit_desk_paid(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  v hon.walkin_visits%ROWTYPE; result jsonb; pay uuid; s jsonb;
BEGIN
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['expectedVersion','method']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','method'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'method') IS DISTINCT FROM 'string' OR (p->>'method') NOT IN ('CASH','CARD_OUTSIDE_HON','OTHER')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','walkin_kiosk.visit.desk_paid','visitId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.walkin_command_begin(subject,'walkin_kiosk.run',key,fp);
  actor:=hon.require_walkin_actor(subject,'walkin_kiosk.run');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO v FROM hon.walkin_visits x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WALKIN_VISIT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF v.payment_state<>'PAY_AT_DESK' THEN RAISE EXCEPTION 'WALKIN_VISIT_NOT_DUE' USING ERRCODE='40001'; END IF;
  -- K3: lock order visit -> payment (the tablet paths take the same order).
  pay:=hon.walkin_card_payment_of(v);
  IF pay IS NOT NULL THEN
    s:=hon.school_pay_once_state(pay);
    IF s->>'state'='OPEN' THEN
      IF (s->>'providerOpen')::boolean THEN RAISE EXCEPTION 'WALKIN_CARD_PAYMENT_OPEN' USING ERRCODE='40001'; END IF;
      s:=hon.school_pay_once_cancel(pay);
    ELSIF s->>'state'='PROCESSING' THEN RAISE EXCEPTION 'WALKIN_CARD_PAYMENT_IN_PROGRESS' USING ERRCODE='40001';
    ELSIF s->>'state'='SUCCEEDED' THEN
      v:=hon.walkin_card_paid(v,s,actor,'HUMAN_UI',request);
      result:=jsonb_build_object('visit',hon.walkin_visit_json(v));
      UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
        WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
      IF hon.require_walkin_actor(subject,'walkin_kiosk.run') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'WALKIN_KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
      RETURN jsonb_build_object('receipt',result,'replayed',false);
    END IF;
  END IF;
  UPDATE hon.walkin_visits SET payment_state='PAID_AT_DESK',desk_method=p->>'method',desk_paid_at=clock_timestamp(),desk_paid_by=actor,
    version=version+1,updated_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
  result:=jsonb_build_object('visit',hon.walkin_visit_json(v));
  PERFORM hon.walkin_command_finish(subject,'walkin_kiosk.run',key,actor,result,'walkin_kiosk.visit.desk_paid','WALKIN_VISIT',v.id,
    jsonb_build_object('visitId',v.id,'paymentState','PAY_AT_DESK','version',v.version-1),
    jsonb_build_object('visitId',v.id,'paymentState',v.payment_state,'version',v.version),'walkin_kiosk.visit_desk_paid',v.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

COMMENT ON COLUMN hon.walkin_visits.card_payment_id IS '0533 the 0529 one-time payment (TEST mode) that paid this visit by card (PAID_CARD).';
COMMENT ON FUNCTION hon.open_walkin_card_payment(text,text) IS
'Tablet (K2): open or get back the TEST-mode card payment for the visit this live tablet recorded with this key. The payment id is for the API only.';
COMMENT ON FUNCTION hon.settle_walkin_card_payment(text,text) IS
'Tablet (K2): the card payment state of the visit this live tablet recorded with this key; marks the visit PAID_CARD on a recorded SUCCEEDED.';
COMMENT ON FUNCTION hon.read_walkin_card_provider(text) IS
'Tablet (K2): which processor would take a card for this live tablet''s school, or null. No DML.';
COMMENT ON FUNCTION hon.read_walkin_visit_card_payment(text,uuid) IS
'Staff (K4, walkin_kiosk.run): the newest card payment of one visit, for the API to end it before marking the visit paid at the desk. No DML.';

DO $$ DECLARE r text; f text; fns text[]:=ARRAY['hon.walkin_card_payment_of(hon.walkin_visits)',
    'hon.walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid)','hon.walkin_tablet_hold(text)','hon.walkin_tablet_visit(hon.walkin_kiosk_devices,text)',
    'hon.read_walkin_card_provider(text)','hon.open_walkin_card_payment(text,text)','hon.settle_walkin_card_payment(text,text)',
    'hon.read_walkin_visit_card_payment(text,uuid)']; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_walkin_card_provider(text),hon.open_walkin_card_payment(text,text),hon.settle_walkin_card_payment(text,text),
      hon.read_walkin_visit_card_payment(text,uuid) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime')
    AND (has_table_privilege('hon_runtime','hon.walkin_visits','SELECT,INSERT,UPDATE,DELETE')
      OR has_table_privilege('hon_runtime','hon.school_pay_once','SELECT,INSERT,UPDATE,DELETE')
      OR has_function_privilege('hon_runtime','hon.school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid)','EXECUTE')) THEN
    RAISE EXCEPTION 'Walk-in kiosk card payment must not widen runtime privileges';
  END IF;
END $$;
COMMIT;
