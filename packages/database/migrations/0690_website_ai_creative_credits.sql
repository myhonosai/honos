BEGIN;

-- 0690: AI website edits are paid from the school's creative credits (CW1 wallet, 0202), never from the included AI team
-- allowance. Owner decision 2026-11-24 (card "Charge AI website building to the school's creative credits?" -> Yes),
-- applying the owner's 2026-11-12 rule (docs/hon/INCLUDED_AI_AND_FAIR_USE.md): heavy work such as website building
-- reserves through the creative wallet at HQ-configurable rates and is never billed as an included conversation.
-- Design: docs/architecture/WEBSITE_AI_CREATIVE_CREDITS.md.
--
-- - The CW1 rate catalog gains the kind WEBSITE, billed per REQUEST, PROVISIONAL only, one unit per request. The HQ owner
--   publishes the rate (operation code website.edit) with the existing versioned rate command.
-- - hon.ai_text_creative_billing says which AI text kinds are creative-billed (WEBSITE_EDIT -> website.edit). The shared
--   0550 core keeps every other kind exactly as it was.
-- - Which credits pay is decided per request at prepare (owner decisions 2026-11-24): creative credits when the creative
--   program is on, the school is eligible for creative credits (a verified paid HON OS subscription, or a funded free trial,
--   which spends its own 1,500-credit TRIAL lot from 0683 first) and the website rate is published; otherwise (for example
--   an unpaid school) the request is an ordinary included-AI request exactly as in 0550.
-- - Prepare (ai_text_prepare, 0550 body): a creative-paid request neither reserves nor checks the included AI allowance.
--   Route, pause, access, the school AI limit and the kind's own block are unchanged. When the claim would send, one unit
--   is reserved from the creative wallet in the same transaction (pause gate, wallet lock, S4 CREATIVE_MEDIA and school
--   decision, eligibility, published rate, balance); a refusal blocks the row with its reason (CREATIVE_CREDITS_EXHAUSTED,
--   or AI_SPEND_STOPPED; CREATIVE_NOT_ELIGIBLE / CREATIVE_NOT_PRICED only if that changed under the lock), so the
--   provider is never called and an exhausted school never falls back to included AI. Lock order: ai.budget, the
--   proposal row, the creative pause gate, the wallet. No wallet-holding path takes ai.budget (0194 rule, restated here).
-- - Record (ai_text_record, 0550 body): a creative-paid request writes its AGENT_INFERENCE usage row with 0 customer credits
--   (the dollar cost is recorded once, there). The linked reservation is settled by the status trigger below.
-- - Settlement follows the proposal status (AFTER UPDATE trigger, same transaction): RESULT_RECORDED finalizes the unit
--   and links the 0550 usage row; RESULT_REJECTED or an over-budget FAILED releases it with that row's cost; a FAILED
--   without usage releases it with the cost UNKNOWN; a PRE_SEND failure releases it at a known zero cost; UNKNOWN moves
--   it to OUTCOME_UNKNOWN for the HQ owner's existing CW1 resolution, which is the only decision for it (the S4 unknown
--   queue lists included-credit holds only, and this row holds none).
-- - A WEBSITE reservation can only be created and provider-settled by this path; the public CW1 reserve and settle
--   refuse it. HQ resolution and late-cost recording keep working (usage recorded as TEXT, CREATIVE_MEDIA).
-- Nothing here calls a provider, charges a card, publishes a site or activates a program.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.ai_text_proposals') IS NULL OR to_regclass('hon.saas_creative_reservations') IS NULL
    OR to_regprocedure('hon.settle_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.creative_cost_basis_reference(text)') IS NULL
    OR to_regprocedure('hon.prepare_school_website_ai_edit(text,uuid,uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'Website AI creative credits require 0202, 0550 and 0637';
  END IF;
END $$;

-- ---------- the rate catalog and reservations accept WEBSITE (per REQUEST, provisional, one unit) ----------
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE contype='c' AND conrelid='hon.saas_creative_rates'::regclass
      AND (pg_get_constraintdef(oid) LIKE '%media_kind%' OR pg_get_constraintdef(oid) LIKE '%billing_unit%') LOOP
    EXECUTE format('ALTER TABLE hon.saas_creative_rates DROP CONSTRAINT %I', c.conname);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE contype='c' AND conrelid='hon.saas_creative_reservations'::regclass
      AND pg_get_constraintdef(oid) LIKE '%media_kind%' LOOP
    EXECUTE format('ALTER TABLE hon.saas_creative_reservations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE hon.saas_creative_rates
  ADD CONSTRAINT saas_creative_rates_media_kind_check CHECK (media_kind IN ('IMAGE','VIDEO','WEBSITE')),
  ADD CONSTRAINT saas_creative_rates_billing_unit_check CHECK (billing_unit IN ('IMAGE','VIDEO_SECOND','REQUEST')),
  ADD CONSTRAINT saas_creative_rates_unit_fits_kind CHECK (CASE media_kind
    WHEN 'IMAGE' THEN billing_unit IN ('IMAGE','REQUEST')
    WHEN 'VIDEO' THEN billing_unit IN ('IMAGE','VIDEO_SECOND','REQUEST')
    ELSE billing_unit = 'REQUEST' AND max_units_per_request = 1 AND rate_basis = 'PROVISIONAL' END);
ALTER TABLE hon.saas_creative_reservations
  ADD CONSTRAINT saas_creative_reservations_media_kind_check CHECK (media_kind IN ('IMAGE','VIDEO','WEBSITE'));

-- New block reasons for a creative-billed proposal.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE contype='c' AND conrelid='hon.ai_text_proposals'::regclass AND pg_get_constraintdef(oid) LIKE '%GATE_CLOSED%' LOOP
    EXECUTE format('ALTER TABLE hon.ai_text_proposals DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE hon.ai_text_proposals ADD CONSTRAINT ai_text_proposals_reason_check CHECK (reason IN ('CONFIGURATION_REQUIRED','NO_ELIGIBLE_ROUTE',
  'CUSTOMER_BUDGET_EXCEEDED','AI_SPEND_STOPPED','UNSUPPORTED_PROVIDER','INVALID_REQUEST','PROVIDER_REJECTED','PROVIDER_UNKNOWN','ROUTE_STALE',
  'RESULT_BUDGET_EXCEEDED','RESULT_INVALID','SUBJECT_STALE','GATE_CLOSED','CREATIVE_NOT_PRICED','CREATIVE_CREDITS_EXHAUSTED','CREATIVE_NOT_ELIGIBLE','CREATIVE_EDIT_IN_PROGRESS'));

-- Website usage is TEXT; IMAGE and VIDEO keep their own modality (0202 body otherwise unchanged). Used by the HQ owner's
-- CW1 resolution and late-cost recording.
CREATE OR REPLACE FUNCTION hon.saas_creative_record_usage(r hon.saas_creative_reservations, p_actor uuid, p_cost bigint, p_units integer) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE uid uuid;
BEGIN
  INSERT INTO hon.ai_usage_ledger(organization_id, school_id, initiator_principal_id, provider_code, model_code, modality,
      input_units, output_units, provider_cost_microunits, customer_credits, correlation_id, spend_class)
    VALUES (r.organization_id, r.school_id, p_actor, r.provider_id, r.model_code,
      (CASE WHEN r.media_kind = 'WEBSITE' THEN 'TEXT' ELSE r.media_kind END)::hon.ai_modality, 0, p_units, p_cost, 0, r.id, 'CREATIVE_MEDIA')
    RETURNING id INTO uid;
  RETURN uid;
END $$;

-- HQ rate publishing (0202 body) also accepts WEBSITE: per REQUEST, one unit, provisional (no cost evidence).
CREATE OR REPLACE FUNCTION hon.publish_saas_creative_rates(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; item jsonb; created hon.saas_creative_rate_versions%ROWTYPE; prior uuid; at timestamptz; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['rates','termsReference']
    OR coalesce(jsonb_typeof(p->'termsReference'), '') <> 'string' OR length(p->>'termsReference') NOT BETWEEN 1 AND 500 OR btrim(p->>'termsReference') <> p->>'termsReference'
    OR coalesce(jsonb_typeof(p->'rates'), '') <> 'array' OR jsonb_array_length(p->'rates') NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p->'rates') LOOP
    IF jsonb_typeof(item) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item) k) IS DISTINCT FROM
        ARRAY['billingUnit','costEvidenceId','creditsPerUnit','displayName','maxUnitsPerRequest','mediaKind','operationCode']
      OR coalesce(jsonb_typeof(item->'operationCode'), '') <> 'string' OR (item->>'operationCode') !~ '^[a-z][a-z0-9_.]{2,59}$'
      OR coalesce(item->>'mediaKind', '') NOT IN ('IMAGE','VIDEO','WEBSITE') OR coalesce(item->>'billingUnit', '') NOT IN ('IMAGE','VIDEO_SECOND','REQUEST')
      OR coalesce(jsonb_typeof(item->'displayName'), '') <> 'string' OR length(item->>'displayName') NOT BETWEEN 1 AND 120 OR btrim(item->>'displayName') <> item->>'displayName'
      OR coalesce(jsonb_typeof(item->'creditsPerUnit'), '') <> 'number' OR (item->>'creditsPerUnit') !~ '^[1-9][0-9]{0,6}$' OR (item->>'creditsPerUnit')::integer > 1000000
      OR coalesce(jsonb_typeof(item->'maxUnitsPerRequest'), '') <> 'number' OR (item->>'maxUnitsPerRequest') !~ '^[1-9][0-9]{0,3}$' OR (item->>'maxUnitsPerRequest')::integer > 1000
      OR coalesce(jsonb_typeof(item->'costEvidenceId'), '') NOT IN ('string','null')
      -- 0690: a website rate is per REQUEST, one unit per request, and always provisional.
      OR (item->>'mediaKind' = 'WEBSITE' AND NOT (item->>'billingUnit' = 'REQUEST' AND (item->>'maxUnitsPerRequest')::integer = 1
        AND jsonb_typeof(item->'costEvidenceId') = 'null')) THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'operationCode') FROM jsonb_array_elements(p->'rates')) <> jsonb_array_length(p->'rates') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.creative.rates', hon.saas_fingerprint(ARRAY['saas.creative.rates', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p->'rates') x LEFT JOIN hon.saas_provider_cost_evidence e ON e.id = (x->>'costEvidenceId')::uuid
      WHERE jsonb_typeof(x->'costEvidenceId') = 'string' AND (e.id IS NULL OR e.cost_unit <> x->>'billingUnit')) THEN
    RAISE EXCEPTION 'SAAS_PRICING_COST_EVIDENCE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p->'rates') x WHERE x->>'mediaKind' = 'IMAGE' AND x->>'billingUnit' = 'VIDEO_SECOND') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE hon.saas_creative_rate_versions IN SHARE ROW EXCLUSIVE MODE;
  at := clock_timestamp();
  SELECT id INTO prior FROM hon.saas_creative_rate_versions WHERE status = 'PUBLISHED' FOR UPDATE;
  IF prior IS NOT NULL THEN UPDATE hon.saas_creative_rate_versions SET status = 'RETIRED', retired_at = at WHERE id = prior; END IF;
  INSERT INTO hon.saas_creative_rate_versions(rate_version, status, terms_reference, published_by_principal_id, published_at)
    VALUES ((SELECT coalesce(max(rate_version), 0) + 1 FROM hon.saas_creative_rate_versions), 'PUBLISHED', p->>'termsReference', actor, at)
    RETURNING * INTO created;
  INSERT INTO hon.saas_creative_rates(rate_version_id, operation_code, media_kind, display_name, billing_unit, credits_per_unit, max_units_per_request, rate_basis, cost_evidence_id)
    SELECT created.id, x->>'operationCode', x->>'mediaKind', x->>'displayName', x->>'billingUnit', (x->>'creditsPerUnit')::integer,
      (x->>'maxUnitsPerRequest')::integer, CASE WHEN jsonb_typeof(x->'costEvidenceId') = 'string' THEN 'VERIFIED_COST' ELSE 'PROVISIONAL' END,
      CASE WHEN jsonb_typeof(x->'costEvidenceId') = 'string' THEN (x->>'costEvidenceId')::uuid END
    FROM jsonb_array_elements(p->'rates') x;
  snapshot := hon.saas_creative_rates_json(true);
  RETURN hon.saas_record(actor, p_key, 'saas.creative.rates', 'saas.creative.rates_published', 'CREATIVE_RATES', created.id, NULL,
    CASE WHEN prior IS NULL THEN NULL ELSE jsonb_build_object('retiredRateVersionId', prior) END, snapshot,
    jsonb_build_object('rates', snapshot, 'retiredRateVersionId', prior), at);
END $$;

-- ---------- which AI text kinds are creative-billed, and their reservations ----------
CREATE TABLE hon.ai_text_creative_billing (
  kind text PRIMARY KEY REFERENCES hon.ai_text_kinds(kind),
  operation_code text NOT NULL CHECK (operation_code ~ '^[a-z][a-z0-9_.]{2,59}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO hon.ai_text_creative_billing(kind, operation_code) VALUES ('WEBSITE_EDIT', 'website.edit');

-- One row per reservation a proposal made (a proposal that was released before sending can reserve again later).
CREATE TABLE hon.ai_text_creative_reservations (
  reservation_id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL REFERENCES hon.ai_text_proposals(id),
  school_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (reservation_id, school_id) REFERENCES hon.saas_creative_reservations(id, school_id)
);
CREATE INDEX ai_text_creative_reservations_proposal ON hon.ai_text_creative_reservations (proposal_id, created_at DESC);
ALTER TABLE hon.ai_text_creative_billing ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.ai_text_creative_billing FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_text_creative_reservations ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.ai_text_creative_reservations FORCE ROW LEVEL SECURITY;
CREATE FUNCTION hon.guard_ai_text_creative() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  RAISE EXCEPTION 'AI_TEXT_CREATIVE_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER ai_text_creative_billing_immutable BEFORE UPDATE OR DELETE ON hon.ai_text_creative_billing FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_text_creative();
CREATE TRIGGER ai_text_creative_billing_no_truncate BEFORE TRUNCATE ON hon.ai_text_creative_billing FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_text_creative();
CREATE TRIGGER ai_text_creative_reservations_immutable BEFORE UPDATE OR DELETE ON hon.ai_text_creative_reservations FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_text_creative();
CREATE TRIGGER ai_text_creative_reservations_no_truncate BEFORE TRUNCATE ON hon.ai_text_creative_reservations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_text_creative();

-- A WEBSITE reservation is created and provider-settled only by this path (transaction-local marker). Defence in depth
-- only: any session could set the marker, but the runtime cannot write these tables or call the private helpers anyway. The public CW1
-- reserve and settle refuse it; the HQ owner's resolution and late-cost recording are not provider settlements.
CREATE FUNCTION hon.guard_website_creative_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF coalesce(current_setting('hon.ai_text_creative', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND NEW.media_kind = 'WEBSITE' THEN RAISE EXCEPTION 'SAAS_OPERATION_NOT_PRICED' USING ERRCODE='23514'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.media_kind = 'WEBSITE' AND NEW.status_reason IN ('PROVIDER_SUCCEEDED','PROVIDER_FAILED','PROVIDER_OUTCOME_UNKNOWN')
    AND NEW.status_reason IS DISTINCT FROM OLD.status_reason THEN
    RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER website_creative_reservation_guard BEFORE INSERT OR UPDATE ON hon.saas_creative_reservations FOR EACH ROW
  EXECUTE FUNCTION hon.guard_website_creative_reservation();

-- Whether this request pays with creative credits: a creative-billed kind, the creative program on, the school eligible
-- for creative credits and the HQ website rate published. Otherwise it is an ordinary included-AI request exactly as in
-- 0550 (unpaid schools, and every school while the program is off or unpriced). A funded free trial is eligible (0683) and
-- pays from its TRIAL lot. Owner decisions 2026-11-24.
CREATE FUNCTION hon.ai_text_creative_applies(i hon.ai_text_proposals, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.ai_text_creative_billing b JOIN hon.saas_creative_rates r ON r.operation_code = b.operation_code AND r.media_kind = 'WEBSITE'
      JOIN hon.saas_creative_rate_versions v ON v.id = r.rate_version_id AND v.status = 'PUBLISHED' WHERE b.kind = i.kind)
    AND hon.saas_creative_program_active() AND (hon.saas_creative_eligibility(i.school_id, p_at)->>'eligible')::boolean
$$;

-- Reserve one unit for a proposal that is about to send. Caller holds ai.budget and the proposal row lock. Returns NULL
-- (reserved) or the block reason. Never raises for a business refusal, so nothing is sent and the row says why.
CREATE FUNCTION hon.ai_text_creative_reserve(i hon.ai_text_proposals, p hon.ai_invocation_plans) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE op text; at timestamptz; e jsonb; rate hon.saas_creative_rates%ROWTYPE; created hon.saas_creative_reservations%ROWTYPE; l record; need integer; take integer;
BEGIN
  SELECT operation_code INTO STRICT op FROM hon.ai_text_creative_billing WHERE kind = i.kind;
  PERFORM hon.saas_creative_pause_gate(i.organization_id);
  PERFORM hon.saas_creative_lock_wallet(i.school_id, clock_timestamp());
  at := clock_timestamp();
  IF hon.ai_spend_allowed(i.organization_id, i.school_id, at, 'CREATIVE_MEDIA') IS NOT NULL
    OR hon.ai_school_spend_decision(i.organization_id, i.school_id, at, 'CREATIVE_MEDIA') IS NOT NULL THEN RETURN 'AI_SPEND_STOPPED'; END IF;
  -- One creative-paid edit in flight per school: these holds carry no included credits, so the school AI cost limit
  -- (which counts only reserved_credits > 0) cannot see them; this keeps the unseen in-flight cost to one request.
  IF EXISTS (SELECT 1 FROM hon.ai_text_creative_reservations c JOIN hon.saas_creative_reservations x ON x.id = c.reservation_id AND x.school_id = c.school_id
      WHERE c.school_id = i.school_id AND x.status = 'RESERVED') THEN RETURN 'CREATIVE_EDIT_IN_PROGRESS'; END IF;
  PERFORM hon.saas_creative_open_window(i.school_id, i.requested_by, at);
  e := hon.saas_creative_eligibility(i.school_id, at);
  IF NOT (e->>'eligible')::boolean THEN RETURN 'CREATIVE_NOT_ELIGIBLE'; END IF;
  SELECT r.* INTO rate FROM hon.saas_creative_rates r JOIN hon.saas_creative_rate_versions v ON v.id = r.rate_version_id
    WHERE v.status = 'PUBLISHED' AND r.operation_code = op AND r.media_kind = 'WEBSITE';
  IF rate.operation_code IS NULL THEN RETURN 'CREATIVE_NOT_PRICED'; END IF;
  IF rate.credits_per_unit > (SELECT coalesce(sum(hon.saas_creative_lot_available(x, at)), 0) FROM hon.saas_creative_lots x WHERE x.school_id = i.school_id) THEN
    RETURN 'CREATIVE_CREDITS_EXHAUSTED';
  END IF;
  PERFORM set_config('hon.ai_text_creative', 'on', true);
  INSERT INTO hon.saas_creative_reservations(school_id, organization_id, rate_version_id, operation_code, media_kind, rate_basis, credits_per_unit, units,
      reserved_credits, status, status_reason, version, requested_by_principal_id, provider_id, model_code, cost_status, reserved_at)
    VALUES (i.school_id, i.organization_id, rate.rate_version_id, rate.operation_code, 'WEBSITE', rate.rate_basis, rate.credits_per_unit, 1,
      rate.credits_per_unit, 'RESERVED', 'RESERVED', 1, i.requested_by, p.provider_id, p.model_id, 'PENDING', at)
    RETURNING * INTO created;
  PERFORM set_config('hon.ai_text_creative', '', true);
  need := created.reserved_credits;
  FOR l IN SELECT x.*, hon.saas_creative_lot_available(x, at) avail FROM hon.saas_creative_lots x WHERE x.school_id = i.school_id
      ORDER BY hon.saas_creative_lot_rank(x.lot_kind), x.expires_at NULLS LAST, x.granted_at, x.id LOOP
    EXIT WHEN need = 0;
    CONTINUE WHEN l.avail <= 0;
    take := least(l.avail, need); need := need - take;
    INSERT INTO hon.saas_creative_ledger(school_id, organization_id, lot_id, entry_kind, credits, reservation_id, actor_principal_id, occurred_at)
      VALUES (i.school_id, i.organization_id, l.id, 'RESERVE', take, created.id, i.requested_by, at);
  END LOOP;
  IF need <> 0 THEN RAISE EXCEPTION 'SAAS_CREDITS_EXHAUSTED' USING ERRCODE = '23514'; END IF;
  INSERT INTO hon.ai_text_creative_reservations(reservation_id, proposal_id, school_id) VALUES (created.id, i.id, i.school_id);
  PERFORM hon.saas_creative_touch_wallet(i.school_id, at);
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
    VALUES (i.organization_id, i.school_id, i.requested_by, 'HON_STAFF', 'saas.creative.reserve', 'CREATIVE_RESERVATION', created.id, NULL,
      hon.saas_creative_reservation_json(created, false) || jsonb_build_object('aiTextProposalId', i.id), 'SUCCEEDED',
      nullif(current_setting('app.hon_request_id', true), '')::uuid, nullif(current_setting('app.hon_request_id', true), '')::uuid, now());
  RETURN NULL;
END $$;

-- Settle the open reservation of a creative-billed proposal from its status (AFTER UPDATE, same transaction).
CREATE FUNCTION hon.ai_text_creative_settle() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r hon.saas_creative_reservations%ROWTYPE; at timestamptz; cost bigint; next_status text; next_reason text; cost_state text; v_final integer;
BEGIN
  -- Only a request that reserved creative credits (an open link) settles; an included-AI request has none.
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR OLD.status <> 'SENDING' OR NOT EXISTS (SELECT 1 FROM hon.ai_text_creative_reservations c
      JOIN hon.saas_creative_reservations x ON x.id = c.reservation_id AND x.school_id = c.school_id WHERE c.proposal_id = NEW.id AND x.status = 'RESERVED') THEN
    RETURN NULL;
  END IF;
  at := clock_timestamp();
  PERFORM hon.saas_creative_lock_wallet(NEW.school_id, at);
  SELECT x.* INTO r FROM hon.ai_text_creative_reservations c JOIN hon.saas_creative_reservations x ON x.id = c.reservation_id AND x.school_id = c.school_id
    WHERE c.proposal_id = NEW.id AND x.status = 'RESERVED' FOR UPDATE OF x;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_CREATIVE_LEDGER_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF NEW.usage_id IS NOT NULL THEN SELECT provider_cost_microunits INTO STRICT cost FROM hon.ai_usage_ledger WHERE id = NEW.usage_id; END IF;
  PERFORM set_config('hon.ai_text_creative', 'on', true);
  IF NEW.status = 'UNKNOWN' THEN
    UPDATE hon.saas_creative_reservations SET status = 'OUTCOME_UNKNOWN', status_reason = 'PROVIDER_OUTCOME_UNKNOWN', version = version + 1 WHERE id = r.id;
  ELSIF NEW.status = 'RESULT_RECORDED' THEN
    v_final := 1;
    PERFORM hon.saas_creative_settle_lots(r, r.credits_per_unit, r.requested_by_principal_id, at);
    UPDATE hon.saas_creative_reservations SET status = 'FINALIZED', status_reason = 'PROVIDER_SUCCEEDED', version = version + 1, final_units = v_final,
        final_credits = r.credits_per_unit, cost_status = 'RECORDED', provider_cost_microunits = cost, cost_reference = 'AI_TEXT_PROPOSAL_USAGE',
        cost_recorded_at = at, usage_id = NEW.usage_id, settled_at = at, settled_by_principal_id = r.requested_by_principal_id
      WHERE id = r.id;
  ELSE
    -- RESULT_REJECTED / FAILED with usage: released at the recorded cost. FAILED without usage: cost UNKNOWN (HQ may
    -- record it later). PRE_SEND (back to CONFIGURATION_REQUIRED): nothing was sent, a known zero cost.
    IF NEW.usage_id IS NOT NULL THEN cost_state := 'RECORDED';
    ELSIF NEW.status = 'CONFIGURATION_REQUIRED' THEN cost_state := 'RECORDED'; cost := 0;
    ELSE cost_state := 'UNKNOWN'; cost := NULL; END IF;
    PERFORM hon.saas_creative_settle_lots(r, 0, r.requested_by_principal_id, at);
    UPDATE hon.saas_creative_reservations SET status = 'RELEASED', status_reason = 'PROVIDER_FAILED', version = version + 1,
        cost_status = cost_state, provider_cost_microunits = cost,
        cost_reference = CASE WHEN NEW.usage_id IS NOT NULL THEN 'AI_TEXT_PROPOSAL_USAGE' WHEN cost_state = 'RECORDED' THEN 'NOT_SENT' END,
        cost_recorded_at = CASE WHEN cost_state = 'RECORDED' THEN at END, usage_id = NEW.usage_id, settled_at = at, settled_by_principal_id = r.requested_by_principal_id
      WHERE id = r.id;
  END IF;
  PERFORM set_config('hon.ai_text_creative', '', true);
  PERFORM hon.saas_creative_touch_wallet(NEW.school_id, at);
  RETURN NULL;
END $$;
CREATE TRIGGER zz_ai_text_creative_settle AFTER UPDATE OF status ON hon.ai_text_proposals FOR EACH ROW EXECUTE FUNCTION hon.ai_text_creative_settle();

-- ---------- the shared core (0550 bodies plus the creative-billed branch) ----------
-- The final claim before a provider call. The organization budget lock is the FIRST lock (0194 order), then the row.
-- 0690: ai.budget always comes before the creative wallet; wallet-holding paths never take ai.budget.
CREATE OR REPLACE FUNCTION hon.ai_text_prepare(p_id uuid, p_requested_by uuid, p_plan uuid, p_ready boolean, p_block text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id());
  i hon.ai_text_proposals%ROWTYPE := hon.ai_text_row(p_id, p_requested_by); k hon.ai_text_kinds%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; why text;
  creative boolean; stale uuid;
BEGIN
  IF p_block IS NOT NULL AND p_block NOT IN ('SUBJECT_STALE','GATE_CLOSED') THEN RAISE EXCEPTION 'INVALID_AI_TEXT_PROPOSAL' USING ERRCODE='22023'; END IF;
  IF i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN
    UPDATE hon.ai_text_proposals SET status='UNKNOWN',reason='PROVIDER_UNKNOWN',updated_at=clock_timestamp() WHERE id=i.id;
    PERFORM hon.ai_text_event(i.id,'unknown'); RETURN NULL;
  END IF;
  IF i.status NOT IN ('PENDING','CONFIGURATION_REQUIRED','BLOCKED') THEN RETURN NULL; END IF;
  SELECT * INTO STRICT k FROM hon.ai_text_kinds WHERE kind=i.kind;
  creative := hon.ai_text_creative_applies(i, clock_timestamp());
  IF p_plan IS NULL THEN why := 'NO_ELIGIBLE_ROUTE';
  ELSE
    SELECT * INTO p FROM hon.ai_invocation_plans WHERE id=p_plan AND organization_id=i.organization_id AND school_id=i.school_id AND work_item_id=i.work_item_id
      AND agent_key=k.agent_key AND task_class=k.task_class AND modality='TEXT' AND input_budget=k.input_budget AND output_budget=k.output_budget
      AND max_provider_cost_microunits=k.max_cost_microunits;
    IF NOT FOUND OR (i.plan_id IS NOT NULL AND i.plan_id<>p_plan) THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_PLAN_SWAP' USING ERRCODE='42501'; END IF;
    -- Locks serialize HQ revocation with the final claim; a historical plan does not authorize execution.
    PERFORM 1 FROM hon.hq_ai_provider_connections WHERE provider_id=p.provider_id FOR SHARE;
    PERFORM 1 FROM hon.hq_ai_model_catalog WHERE catalog_id=p.catalog_id FOR SHARE;
    PERFORM 1 FROM hon.hq_ai_routing_policies WHERE policy_id=p.routing_policy_id FOR SHARE;
    PERFORM 1 FROM hon.hq_ai_routing_candidates WHERE policy_id=p.routing_policy_id FOR SHARE;
    IF p.provider_id<>'OPENROUTER' THEN why := 'UNSUPPORTED_PROVIDER';
    ELSIF NOT EXISTS(SELECT 1 FROM hon.hq_ai_provider_connections pc JOIN hon.hq_ai_model_catalog m ON m.provider_id=pc.provider_id
        JOIN hon.hq_ai_routing_candidates rc ON rc.catalog_id=m.catalog_id JOIN hon.hq_ai_routing_policies rp ON rp.policy_id=rc.policy_id
        WHERE pc.provider_id=p.provider_id AND pc.state='HEALTHY' AND pc.version=p.provider_version AND m.catalog_id=p.catalog_id AND m.model_id=p.model_id
          AND m.version=p.catalog_version AND m.active AND m.cost_unit='TOKEN' AND 'TEXT'=ANY(m.capabilities) AND 'TEXT'=ANY(m.modalities)
          AND m.effective_from<=clock_timestamp() AND (m.effective_until IS NULL OR m.effective_until>clock_timestamp())
          AND rp.policy_id=p.routing_policy_id AND rp.organization_id=i.organization_id AND rp.school_id=i.school_id AND rp.version=p.routing_policy_version
          AND rp.active AND rp.capability='TEXT' AND rp.effective_from<=clock_timestamp() AND (rp.effective_until IS NULL OR rp.effective_until>clock_timestamp())
          AND m.unit_cost_micros*(p.input_budget+p.output_budget)<=LEAST(rp.max_cost_micros,p.max_provider_cost_microunits)) THEN why := 'ROUTE_STALE';
    ELSIF p_block IS NOT NULL THEN why := p_block;
    ELSIF NOT p_ready THEN why := 'CONFIGURATION_REQUIRED'; END IF;
  END IF;
  -- S4: pause, access and the school's own AI limit (decided here so the row says why), then the organization budget.
  IF why IS NULL AND hon.ai_spend_allowed(i.organization_id,i.school_id,clock_timestamp(),'AGENT_INFERENCE') IS NOT NULL THEN why := 'AI_SPEND_STOPPED'; END IF;
  -- 0690: a request that pays with creative credits never spends or checks the included AI allowance.
  IF why IS NULL AND NOT creative AND hon.ai_org_committed_credits(i.organization_id,clock_timestamp())+p.customer_credit_estimate>hon.ai_org_ceiling(i.organization_id,clock_timestamp()) THEN
    why := 'CUSTOMER_BUDGET_EXCEEDED';
  END IF;
  -- 0690: a creative-paid edit whose API died after prepare stays SENDING and would block every later edit. Before the
  -- wallet lock (record takes the row, then the wallet), time out this school's aged creative-paid SENDING proposals
  -- exactly as 0550 does on re-prepare; the settle trigger moves each reservation to OUTCOME_UNKNOWN for the HQ CW1 queue.
  IF why IS NULL AND creative THEN
    FOR stale IN SELECT s.id FROM hon.ai_text_proposals s WHERE s.school_id=i.school_id AND s.organization_id=i.organization_id
        AND s.id<>i.id AND s.status='SENDING' AND s.updated_at<clock_timestamp()-interval '90 seconds'
        AND EXISTS (SELECT 1 FROM hon.ai_text_creative_reservations c JOIN hon.saas_creative_reservations x ON x.id=c.reservation_id
          AND x.school_id=c.school_id WHERE c.proposal_id=s.id AND x.status='RESERVED')
        ORDER BY s.id FOR UPDATE OF s SKIP LOCKED LOOP
      UPDATE hon.ai_text_proposals SET status='UNKNOWN',reason='PROVIDER_UNKNOWN',updated_at=clock_timestamp() WHERE id=stale;
      PERFORM hon.ai_text_event(stale,'unknown');
    END LOOP;
    why := hon.ai_text_creative_reserve(i, p);
  END IF;
  UPDATE hon.ai_text_proposals SET plan_id=coalesce(p.id,plan_id),
    status=CASE WHEN why IS NULL THEN 'SENDING' WHEN why='CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,
    reason=why, reserved_credits=CASE WHEN why IS NULL AND NOT creative THEN p.customer_credit_estimate ELSE 0 END, updated_at=clock_timestamp() WHERE id=i.id;
  UPDATE hon.work_items SET status=CASE WHEN why IS NULL THEN 'WORKING' ELSE 'NEEDS_ATTENTION' END,version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
  PERFORM hon.ai_text_event(i.id,CASE WHEN why IS NULL THEN 'prepared' ELSE 'blocked' END);
  IF why IS NOT NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('providerId',p.provider_id,'modelId',p.model_id,'providerRequestId',i.provider_request_id,
    'inputBudget',p.input_budget,'outputBudget',p.output_budget,'maxCostMicrounits',p.max_provider_cost_microunits);
END $$;

-- Evidence first (S4-a): exactly one ledger row for a SENDING proposal with a plan, then the result (0550 body). 0690: a
-- creative-paid request (an open reservation link) records 0 customer credits; its budget is the plan's token and cost limits, and its creative
-- reservation is settled by the status trigger.
CREATE OR REPLACE FUNCTION hon.ai_text_record(p_id uuid, p_requested_by uuid, p_usage jsonb, p_result jsonb, p_problems jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.ai_text_proposals%ROWTYPE := hon.ai_text_row(p_id, p_requested_by); k hon.ai_text_kinds%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE;
  uid uuid; credits integer; over boolean; v_next text; creative boolean;
BEGIN
  IF i.status<>'SENDING' OR i.usage_id IS NOT NULL OR i.plan_id IS NULL THEN RAISE EXCEPTION 'AI_TEXT_OUTCOME_REPLAY' USING ERRCODE='40001'; END IF;
  SELECT * INTO STRICT k FROM hon.ai_text_kinds WHERE kind=i.kind;
  SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id=i.plan_id;
  creative := EXISTS (SELECT 1 FROM hon.ai_text_creative_reservations c JOIN hon.saas_creative_reservations x ON x.id = c.reservation_id AND x.school_id = c.school_id
    WHERE c.proposal_id = i.id AND x.status = 'RESERVED');
  IF p_usage IS NULL OR jsonb_typeof(p_usage)<>'object'
    OR coalesce((SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_usage) x), ARRAY[]::text[]) <> ARRAY['inputTokens','outputTokens','providerCostMicrounits']
    OR jsonb_typeof(p_usage->'inputTokens')<>'number' OR (p_usage->>'inputTokens') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_usage->'outputTokens')<>'number' OR (p_usage->>'outputTokens') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_usage->'providerCostMicrounits')<>'number' OR (p_usage->>'providerCostMicrounits') !~ '^(0|[1-9][0-9]{0,9})$'
    OR p_result IS NULL OR length(p_result::text)>k.max_result_bytes
    OR p_problems IS NULL OR jsonb_typeof(p_problems)<>'array' OR jsonb_array_length(p_problems)>50 OR length(p_problems::text)>8192
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_problems) e WHERE jsonb_typeof(e)<>'string' OR length(e#>>'{}') NOT BETWEEN 1 AND 160) THEN
    RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023';
  END IF;
  credits := CASE WHEN creative THEN 0 ELSE ((p_usage->>'inputTokens')::integer+(p_usage->>'outputTokens')::integer+999)/1000 END;
  over := (p_usage->>'inputTokens')::integer>p.input_budget OR (p_usage->>'outputTokens')::integer>p.output_budget
    OR (p_usage->>'providerCostMicrounits')::bigint>p.max_provider_cost_microunits OR credits>i.reserved_credits;
  INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,
      provider_cost_microunits,customer_credits,correlation_id,source_invocation_id,spend_class)
    VALUES(i.organization_id,i.school_id,i.requested_by,i.work_item_id,p.provider_id,p.model_id,'TEXT',(p_usage->>'inputTokens')::bigint,(p_usage->>'outputTokens')::bigint,
      (p_usage->>'providerCostMicrounits')::bigint,credits,nullif(current_setting('app.hon_request_id',true),'')::uuid,i.id,'AGENT_INFERENCE') RETURNING id INTO uid;
  v_next := CASE WHEN over THEN 'FAILED' WHEN jsonb_array_length(p_problems)>0 THEN 'RESULT_REJECTED' ELSE 'RESULT_RECORDED' END;
  UPDATE hon.ai_text_proposals SET usage_id=uid, reserved_credits=0, status=v_next,
    reason=CASE v_next WHEN 'FAILED' THEN 'RESULT_BUDGET_EXCEEDED' WHEN 'RESULT_REJECTED' THEN 'RESULT_INVALID' END,
    result=CASE WHEN over THEN NULL ELSE p_result END, result_problems=CASE WHEN v_next='RESULT_REJECTED' THEN p_problems END, updated_at=clock_timestamp()
    WHERE id=i.id;
  UPDATE hon.work_items SET status=CASE WHEN v_next='RESULT_RECORDED' THEN 'WAITING_FOR_APPROVAL' ELSE 'FAILED' END,version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
  PERFORM hon.ai_text_event(i.id,CASE v_next WHEN 'FAILED' THEN 'budget_failed' WHEN 'RESULT_REJECTED' THEN 'result_rejected' ELSE 'result_recorded' END);
  RETURN v_next;
END $$;

-- What the next AI website edit will cost, shown before asking (no reservation): paid from CREATIVE_CREDITS (the published
-- website.edit rate and this school's available creative credits) or from INCLUDED_AI as in 0550. Anyone who may ask for
-- an AI website edit may read it; it carries no provider, cost or other-school fact.
CREATE FUNCTION hon.read_school_website_ai_price(p_subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.school_website_ai_actor(p_subject); school uuid := hon.current_school_id(); at timestamptz := clock_timestamp();
  per integer; creative boolean; e jsonb; pending integer := 0;
BEGIN
  SELECT r.credits_per_unit INTO per FROM hon.saas_creative_rates r JOIN hon.saas_creative_rate_versions v ON v.id = r.rate_version_id
    JOIN hon.ai_text_creative_billing b ON b.operation_code = r.operation_code AND b.kind = 'WEBSITE_EDIT'
    WHERE v.status = 'PUBLISHED' AND r.media_kind = 'WEBSITE';
  e := hon.saas_creative_eligibility(school, at);
  creative := per IS NOT NULL AND hon.saas_creative_program_active() AND (e->>'eligible')::boolean;
  IF NOT creative THEN RETURN jsonb_build_object('paidWith', 'INCLUDED_AI', 'creditsPerEdit', NULL, 'availableCredits', NULL); END IF;
  -- This month's included credits count before their lot is granted (the first reserve of the window grants it). A
  -- free-trial window (0683) has no subscription and no included monthly lot: only its TRIAL lot counts.
  IF e->>'subscriptionId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hon.saas_creative_lots l WHERE l.school_id = school AND l.lot_kind = 'INCLUDED_MONTHLY'
      AND l.subscription_id = (e->>'subscriptionId')::uuid AND l.window_index = (e#>>'{window,index}')::integer) THEN
    SELECT monthly_included_credits INTO pending FROM hon.saas_creative_program WHERE program_id = 1;
  END IF;
  RETURN jsonb_build_object('paidWith', 'CREATIVE_CREDITS', 'creditsPerEdit', per,
    'availableCredits', coalesce(pending, 0) + (SELECT coalesce(sum(hon.saas_creative_lot_available(x, at)), 0)::integer FROM hon.saas_creative_lots x WHERE x.school_id = school));
END $$;

-- ---------- privileges ----------
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['ai_text_creative_billing','ai_text_creative_reservations'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_ai_text_creative()','hon.guard_website_creative_reservation()',
    'hon.ai_text_creative_reserve(hon.ai_text_proposals,hon.ai_invocation_plans)','hon.ai_text_creative_settle()',
    'hon.ai_text_creative_applies(hon.ai_text_proposals,timestamptz)',
    'hon.read_school_website_ai_price(text)','hon.ai_text_prepare(uuid,uuid,uuid,boolean,text)','hon.ai_text_record(uuid,uuid,jsonb,jsonb,jsonb)',
    'hon.saas_creative_record_usage(hon.saas_creative_reservations,uuid,bigint,integer)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_website_ai_price(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
