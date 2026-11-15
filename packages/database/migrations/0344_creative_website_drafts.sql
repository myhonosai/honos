BEGIN;

-- 0344 (WB1): AI website drafts paid from the school's creative credits. Spec: docs/architecture/CREATIVE_WEBSITE_DRAFTS.md.
-- Owner 2026-11-12 (docs/hon/INCLUDED_AI_AND_FAIR_USE.md): creative and heavier work (images, video, and heavy jobs such as
-- website building) spends the school's 12,000 monthly creative credits; any new heavy generator must reserve through the
-- same CW1 wallet path (0202, which carries the S4 and R2 pause guards) at HQ-configurable rates, and is never billed as an
-- included conversation. Nothing here calls a provider, charges a card, publishes a site or activates a program.
--
-- - The CW1 rate catalog gains a third kind, WEBSITE, billed per PAGE. The HQ owner publishes website rates with the
--   existing versioned rate command (PROVISIONAL only: there is no PAGE cost-evidence unit). IMAGE and VIDEO are unchanged.
-- - One draft = one request by a staff member of ONE school (the CW1 school actor) for 1..8 pages from a fixed list. The
--   unchanged CW1 reserve (pause gate, S4 and R2 decisions, eligibility, published rate, balance, wallet lock, audit,
--   outbox) reserves pages x rate; the API makes one provider call; the requester records the result exactly once. The
--   CS1 rules apply unchanged: SUCCEEDED charges only the pages returned (never above the reservation), FAILED returns the
--   credits with an unreported cost kept UNKNOWN, NOT_SENT returns them with a known zero cost, UNKNOWN holds them for
--   the HQ owner's existing CW1 resolve. Status shown to the school is derived from the reservation.
-- - Provider usage is recorded in ai_usage_ledger as spend_class CREATIVE_MEDIA, modality TEXT, customer credits 0.
-- - Fair use: one draft in progress per school. Drafts are text only, stored here, never published (WB1 stores
--   SYNTHETIC output from test providers only; a real provider needs owner approval and a reviewed origin).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON website drafts require a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.reserve_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.settle_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.saas_creative_evidence_actor(text,uuid)') IS NULL
    OR to_regprocedure('hon.creative_prompt_ok(text)') IS NULL THEN
    RAISE EXCEPTION 'HON website drafts require the CW1 creative wallet (0202) and CS1 (0216)';
  END IF;
END $$;

-- ---------- the rate catalog and reservations accept WEBSITE (per PAGE) ----------
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = 'hon.saas_creative_rates'::regclass
      AND (pg_get_constraintdef(oid) LIKE '%media_kind%' OR pg_get_constraintdef(oid) LIKE '%billing_unit%') LOOP
    EXECUTE format('ALTER TABLE hon.saas_creative_rates DROP CONSTRAINT %I', c.conname);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = 'hon.saas_creative_reservations'::regclass
      AND pg_get_constraintdef(oid) LIKE '%media_kind%' LOOP
    EXECUTE format('ALTER TABLE hon.saas_creative_reservations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE hon.saas_creative_rates
  ADD CONSTRAINT saas_creative_rates_media_kind_check CHECK (media_kind IN ('IMAGE','VIDEO','WEBSITE')),
  ADD CONSTRAINT saas_creative_rates_billing_unit_check CHECK (billing_unit IN ('IMAGE','VIDEO_SECOND','REQUEST','PAGE')),
  ADD CONSTRAINT saas_creative_rates_unit_fits_kind CHECK (CASE media_kind
    WHEN 'IMAGE' THEN billing_unit IN ('IMAGE','REQUEST')
    WHEN 'VIDEO' THEN billing_unit IN ('IMAGE','VIDEO_SECOND','REQUEST')
    ELSE billing_unit = 'PAGE' AND rate_basis = 'PROVISIONAL' END);
ALTER TABLE hon.saas_creative_reservations
  ADD CONSTRAINT saas_creative_reservations_media_kind_check CHECK (media_kind IN ('IMAGE','VIDEO','WEBSITE'));

-- Website text is recorded with the TEXT modality; IMAGE and VIDEO keep their own (unchanged otherwise from 0202).
CREATE OR REPLACE FUNCTION hon.saas_creative_record_usage(r hon.saas_creative_reservations, p_actor uuid, p_cost bigint, p_units integer) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE uid uuid;
BEGIN
  INSERT INTO hon.ai_usage_ledger(organization_id, school_id, initiator_principal_id, provider_code, model_code, modality,
      input_units, output_units, provider_cost_microunits, customer_credits, correlation_id, spend_class)
    VALUES (r.organization_id, r.school_id, p_actor, r.provider_id, r.model_code,
      (CASE r.media_kind WHEN 'WEBSITE' THEN 'TEXT' ELSE r.media_kind END)::hon.ai_modality, 0, p_units, p_cost, 0, r.id, 'CREATIVE_MEDIA')
    RETURNING id INTO uid;
  RETURN uid;
END $$;

-- The 0202 rate publication, now also accepting WEBSITE rates billed per PAGE (never with cost evidence). Every other
-- check, the HQ-owner authority, idempotency, retirement of the prior version and the audit record are unchanged.
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
      OR coalesce(item->>'mediaKind', '') NOT IN ('IMAGE','VIDEO','WEBSITE') OR coalesce(item->>'billingUnit', '') NOT IN ('IMAGE','VIDEO_SECOND','REQUEST','PAGE')
      OR coalesce(jsonb_typeof(item->'displayName'), '') <> 'string' OR length(item->>'displayName') NOT BETWEEN 1 AND 120 OR btrim(item->>'displayName') <> item->>'displayName'
      OR coalesce(jsonb_typeof(item->'creditsPerUnit'), '') <> 'number' OR (item->>'creditsPerUnit') !~ '^[1-9][0-9]{0,6}$' OR (item->>'creditsPerUnit')::integer > 1000000
      OR coalesce(jsonb_typeof(item->'maxUnitsPerRequest'), '') <> 'number' OR (item->>'maxUnitsPerRequest') !~ '^[1-9][0-9]{0,3}$' OR (item->>'maxUnitsPerRequest')::integer > 1000
      OR coalesce(jsonb_typeof(item->'costEvidenceId'), '') NOT IN ('string','null')
      -- The unit must fit the kind (IMAGE and VIDEO exactly as in 0202); a website rate is per PAGE, at most 8 pages, and always PROVISIONAL.
      OR NOT (CASE item->>'mediaKind'
        WHEN 'IMAGE' THEN item->>'billingUnit' IN ('IMAGE','REQUEST')
        WHEN 'VIDEO' THEN item->>'billingUnit' IN ('IMAGE','VIDEO_SECOND','REQUEST')
        ELSE item->>'billingUnit' = 'PAGE' AND (item->>'maxUnitsPerRequest')::integer <= 8 AND jsonb_typeof(item->'costEvidenceId') = 'null' END) THEN
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

-- ---------- drafts ----------
-- The fixed page list (order is the display order). A request names 1..8 distinct pages in this order.
CREATE FUNCTION hon.creative_website_page_rank(p_key text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT array_position(ARRAY['HOME','PROGRAMS','SCHEDULE','FREE_TRIAL','INSTRUCTORS','ABOUT','FAQ','CONTACT'], p_key)
$$;
CREATE FUNCTION hon.creative_website_pages_ok(p text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT p IS NOT NULL AND cardinality(p) BETWEEN 1 AND 8 AND array_position(p, NULL) IS NULL
    AND NOT EXISTS (SELECT 1 FROM unnest(p) x(k) WHERE hon.creative_website_page_rank(x.k) IS NULL)
    -- Strictly in the list's order, so also distinct.
    AND NOT EXISTS (SELECT 1 FROM generate_subscripts(p, 1) i
      WHERE i > 1 AND hon.creative_website_page_rank(p[i]) <= hon.creative_website_page_rank(p[i - 1]))
$$;
-- Printable single-line text (titles, headings): trimmed, no control or bidi-override characters.
CREATE FUNCTION hon.creative_website_line_ok(p text, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND length(p) BETWEEN 1 AND p_max AND btrim(p) = p
    AND p !~ E'[\\x01-\\x1f\\x7f\\u202a-\\u202e\\u2066-\\u2069]'
$$;
-- Printable body text: 1..2000 characters, trimmed, line breaks allowed.
CREATE FUNCTION hon.creative_website_body_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND length(p) BETWEEN 1 AND 2000 AND btrim(p, E' \t\n\r') = p
    AND p !~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f\\u202a-\\u202e\\u2066-\\u2069]'
$$;
-- One page's sections: 1..12 objects of exactly {heading, body}.
CREATE FUNCTION hon.creative_website_sections_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p) = 'array' AND jsonb_array_length(p) BETWEEN 1 AND 12
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p) s WHERE jsonb_typeof(s) <> 'object'
      OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(s) k) IS DISTINCT FROM ARRAY['body','heading']
      OR coalesce(jsonb_typeof(s->'heading'), '') <> 'string' OR coalesce(jsonb_typeof(s->'body'), '') <> 'string'
      OR NOT hon.creative_website_line_ok(s->>'heading', 120) OR NOT hon.creative_website_body_ok(s->>'body'))
$$;

CREATE TABLE hon.creative_website_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  reservation_id uuid NOT NULL UNIQUE,
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  operation_code text NOT NULL CHECK (operation_code ~ '^[a-z][a-z0-9_.]{2,59}$'),
  pages text[] NOT NULL CHECK (hon.creative_website_pages_ok(pages)),
  brief text NOT NULL CHECK (hon.creative_prompt_ok(brief)),
  phase text NOT NULL CHECK (phase IN ('SUBMITTING','RESULT_RECORDED','PROVIDER_FAILED','NOT_SENT','PROVIDER_UNKNOWN')),
  failure_reason text,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (requested_by_principal_id, idempotency_key),
  UNIQUE (id, school_id),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.saas_creative_wallets(school_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (reservation_id, school_id) REFERENCES hon.saas_creative_reservations(id, school_id) ON DELETE RESTRICT,
  CHECK ((phase = 'SUBMITTING') = (completed_at IS NULL)),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (CASE phase
    WHEN 'SUBMITTING' THEN failure_reason IS NULL
    WHEN 'RESULT_RECORDED' THEN failure_reason IS NULL
    WHEN 'PROVIDER_FAILED' THEN failure_reason = 'PROVIDER_REJECTED'
    WHEN 'NOT_SENT' THEN failure_reason IN ('PROVIDER_NOT_CONNECTED','INVALID_REQUEST')
    ELSE failure_reason IN ('PROVIDER_UNKNOWN','UNVERIFIED_RESULT','INTERRUPTED') END)
);
CREATE INDEX creative_website_drafts_school ON hon.creative_website_drafts (school_id, created_at DESC, id DESC);

CREATE TABLE hon.creative_website_draft_pages (
  draft_id uuid NOT NULL,
  school_id uuid NOT NULL,
  page_key text NOT NULL CHECK (hon.creative_website_page_rank(page_key) IS NOT NULL),
  title text NOT NULL CHECK (hon.creative_website_line_ok(title, 120)),
  sections jsonb NOT NULL CHECK (hon.creative_website_sections_ok(sections)),
  -- WB1: synthetic output from test providers only. Real provider text needs owner approval and a reviewed origin.
  origin text NOT NULL CHECK (origin = 'SYNTHETIC'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (draft_id, page_key),
  FOREIGN KEY (draft_id, school_id) REFERENCES hon.creative_website_drafts(id, school_id) ON DELETE RESTRICT
);

-- Drafts move once, SUBMITTING -> a terminal phase, with every request field unchanged. Pages are append-only.
CREATE FUNCTION hon.guard_creative_website_draft() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE moving text[] := ARRAY['phase','failure_reason','version','completed_at'];
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.phase = 'SUBMITTING' AND NEW.phase <> 'SUBMITTING' AND NEW.version = OLD.version + 1
    AND (to_jsonb(NEW) - moving) = (to_jsonb(OLD) - moving) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER creative_website_draft_guarded BEFORE UPDATE OR DELETE ON hon.creative_website_drafts FOR EACH ROW EXECUTE FUNCTION hon.guard_creative_website_draft();
CREATE TRIGGER creative_website_draft_no_truncate BEFORE TRUNCATE ON hon.creative_website_drafts FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_creative_website_draft();
CREATE TRIGGER creative_website_page_immutable BEFORE UPDATE OR DELETE ON hon.creative_website_draft_pages FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER creative_website_page_no_truncate BEFORE TRUNCATE ON hon.creative_website_draft_pages FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- School view of one draft. Status comes from the reservation (the credit truth), exactly like CS1. The page text is
-- included only when p_pages and only for a draft charged on its own recorded result. No provider, model, cost or actor.
CREATE FUNCTION hon.creative_website_draft_json(d hon.creative_website_drafts, p_pages boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('draftId', d.id, 'schoolId', d.school_id, 'operationCode', d.operation_code, 'pages', to_jsonb(d.pages), 'brief', d.brief,
    'status', CASE r.status
      WHEN 'RESERVED' THEN 'GENERATING'
      WHEN 'OUTCOME_UNKNOWN' THEN 'UNDER_REVIEW'
      WHEN 'FINALIZED' THEN CASE WHEN d.phase = 'RESULT_RECORDED' THEN 'SUCCEEDED' ELSE 'RESOLVED_CHARGED' END
      ELSE CASE WHEN d.phase IN ('PROVIDER_FAILED','NOT_SENT') THEN 'FAILED' ELSE 'RESOLVED_NOT_CHARGED' END END,
    'failureReason', CASE WHEN r.status = 'OUTCOME_UNKNOWN' THEN coalesce(d.failure_reason, 'PROVIDER_UNKNOWN')
      WHEN r.status = 'FINALIZED' AND d.phase = 'RESULT_RECORDED' THEN NULL ELSE d.failure_reason END,
    'reservedCredits', r.reserved_credits,
    'chargedCredits', CASE WHEN r.status = 'FINALIZED' THEN r.final_credits END,
    'createdAt', hon.saas_ts(d.created_at),
    'completedAt', CASE WHEN r.status = 'RESERVED' THEN NULL ELSE hon.saas_ts(coalesce(d.completed_at, r.settled_at)) END,
    'content', CASE WHEN p_pages AND r.status = 'FINALIZED' AND d.phase = 'RESULT_RECORDED' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('pageKey', x.page_key,
        'title', x.title, 'sections', x.sections, 'origin', x.origin) ORDER BY hon.creative_website_page_rank(x.page_key))
      FROM hon.creative_website_draft_pages x WHERE x.draft_id = d.id AND x.school_id = d.school_id), '[]'::jsonb) END)
  FROM hon.saas_creative_reservations r WHERE r.id = d.reservation_id AND r.school_id = d.school_id
$$;

CREATE FUNCTION hon.creative_website_draft_fingerprint(p_school uuid, p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('schoolId', p_school, 'operationCode', p->'operationCode', 'pages', p->'pages',
    'brief', p->'brief')::text, 'UTF8')), 'hex')
$$;

-- CREATE: the school actor's request, exactly the CS1 create shape. The same key and body return the same draft (never a
-- second reservation or provider call); the same key with another body is refused (409). The unchanged CW1 reserve runs
-- under a key derived from the request key. Only a WEBSITE rate can fund a draft. Authority, the S4 and R2 decisions and
-- eligibility are decided again after the draft write, still under the reserve's pause gate and wallet lock.
CREATE FUNCTION hon.create_creative_website_draft(p_subject text, p_school uuid, p jsonb, p_provider jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; fp text; existing hon.creative_website_drafts%ROWTYPE; receipt jsonb; res hon.saas_creative_reservations%ROWTYPE;
  created hon.creative_website_drafts%ROWTYPE; busy integer; again record; at timestamptz; why text; e jsonb; out jsonb; pages text[];
BEGIN
  IF p_key IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['brief','operationCode','pages']
    OR coalesce(jsonb_typeof(p->'operationCode'), '') <> 'string' OR (p->>'operationCode') !~ '^[a-z][a-z0-9_.]{2,59}$'
    OR coalesce(jsonb_typeof(p->'brief'), '') <> 'string' OR NOT hon.creative_prompt_ok(p->>'brief')
    OR coalesce(jsonb_typeof(p->'pages'), '') <> 'array' OR jsonb_array_length(p->'pages') NOT BETWEEN 1 AND 8
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p->'pages') x WHERE jsonb_typeof(x) <> 'string')
    OR p_provider IS NULL OR jsonb_typeof(p_provider) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_provider) k) IS DISTINCT FROM ARRAY['modelCode','providerId']
    OR coalesce(jsonb_typeof(p_provider->'providerId'), '') <> 'string' OR coalesce(jsonb_typeof(p_provider->'modelCode'), '') <> 'string' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  pages := ARRAY(SELECT x FROM jsonb_array_elements_text(p->'pages') x);
  IF NOT hon.creative_website_pages_ok(pages) THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  fp := hon.creative_website_draft_fingerprint(scope.school_id, p);
  SELECT * INTO existing FROM hon.creative_website_drafts WHERE requested_by_principal_id = scope.principal_id AND idempotency_key = p_key;
  IF FOUND THEN
    IF existing.request_fingerprint <> fp OR existing.school_id <> scope.school_id THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('draft', hon.creative_website_draft_json(existing, false), 'balance', hon.saas_creative_balance_json(existing.school_id, clock_timestamp()), 'replayed', true);
  END IF;
  receipt := hon.reserve_saas_creative_credits(p_subject, scope.school_id,
    jsonb_build_object('operationCode', p->'operationCode', 'units', cardinality(pages), 'providerId', p_provider->'providerId', 'modelCode', p_provider->'modelCode'),
    md5('creative.website:' || p_key::text)::uuid, p_request, p_correlation);
  IF (receipt->>'replayed')::boolean THEN
    SELECT * INTO existing FROM hon.creative_website_drafts WHERE requested_by_principal_id = scope.principal_id AND idempotency_key = p_key;
    IF NOT FOUND OR existing.request_fingerprint <> fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('draft', hon.creative_website_draft_json(existing, false), 'balance', hon.saas_creative_balance_json(existing.school_id, clock_timestamp()), 'replayed', true);
  END IF;
  SELECT * INTO res FROM hon.saas_creative_reservations WHERE id = (receipt#>>'{reservation,reservationId}')::uuid AND school_id = scope.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_CREATIVE_LEDGER_MISMATCH' USING ERRCODE = '23514'; END IF;
  -- An image or video rate never funds a draft; the refusal rolls back the reservation with it.
  IF res.media_kind <> 'WEBSITE' OR res.units <> cardinality(pages) THEN RAISE EXCEPTION 'CREATIVE_WEBSITE_RATE_INVALID' USING ERRCODE = '23514'; END IF;
  -- Fair use: the reserve holds the school's wallet lock until commit, so this count and the insert are serialized per school.
  SELECT count(*) INTO busy FROM hon.creative_website_drafts d JOIN hon.saas_creative_reservations r ON r.id = d.reservation_id AND r.school_id = d.school_id
    WHERE d.school_id = scope.school_id AND r.status = 'RESERVED';
  IF busy >= 1 THEN RAISE EXCEPTION 'CREATIVE_TOO_MANY_IN_PROGRESS' USING ERRCODE = '23514'; END IF;
  INSERT INTO hon.creative_website_drafts(school_id, organization_id, reservation_id, requested_by_principal_id, idempotency_key, request_fingerprint,
      operation_code, pages, brief, phase, version, created_at)
    VALUES (res.school_id, res.organization_id, res.id, scope.principal_id, p_key, fp, res.operation_code, pages, p->>'brief', 'SUBMITTING', 1, res.reserved_at)
    RETURNING * INTO created;
  out := jsonb_build_object('draft', hon.creative_website_draft_json(created, false), 'balance', receipt->'balance', 'replayed', false);
  at := clock_timestamp();
  SELECT * INTO again FROM hon.require_saas_school_actor(p_subject, scope.school_id) LIMIT 1;
  IF again.principal_id IS DISTINCT FROM scope.principal_id OR again.school_id IS DISTINCT FROM scope.school_id THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  why := hon.ai_spend_allowed(scope.organization_id, at, 'CREATIVE_MEDIA');
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || why USING ERRCODE = '23514'; END IF;
  e := hon.saas_creative_eligibility(scope.school_id, at);
  IF NOT (e->>'eligible')::boolean THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || (e->>'reason') USING ERRCODE = '23514'; END IF;
  RETURN out;
END $$;

-- RECORD: the provider outcome, exactly once, by the draft's own requester (the CW1 evidence actor: never refused by a
-- pause or an access change, so an in-flight result is never lost). SUCCEEDED carries 1..N distinct requested pages and
-- charges only those (finalUnits = pages returned). UNKNOWN with reason INTERRUPTED is accepted only after 120 seconds.
CREATE FUNCTION hon.record_creative_website_draft_result(p_subject text, p_draft uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE d hon.creative_website_drafts%ROWTYPE; outcome text; reason text; v integer; body jsonb; receipt jsonb; a jsonb; n integer;
  at timestamptz; next_phase text; updated hon.creative_website_drafts%ROWTYPE;
BEGIN
  IF p_draft IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['failureReason','outcome','pages','providerCostMicrounits'] THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  outcome := p->>'outcome'; reason := p->>'failureReason';
  IF NOT coalesce(CASE outcome
      WHEN 'SUCCEEDED' THEN jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'
        AND jsonb_typeof(p->'pages') = 'array' AND jsonb_array_length(p->'pages') BETWEEN 1 AND 8 AND jsonb_typeof(p->'failureReason') = 'null'
      WHEN 'FAILED' THEN jsonb_typeof(p->'pages') = 'null' AND reason = 'PROVIDER_REJECTED'
        AND (jsonb_typeof(p->'providerCostMicrounits') = 'null' OR (jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'))
      WHEN 'NOT_SENT' THEN jsonb_typeof(p->'pages') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null' AND reason IN ('PROVIDER_NOT_CONNECTED','INVALID_REQUEST')
      WHEN 'UNKNOWN' THEN jsonb_typeof(p->'pages') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null'
        AND reason IN ('PROVIDER_UNKNOWN','UNVERIFIED_RESULT','INTERRUPTED')
      ELSE false END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO d FROM hon.creative_website_drafts WHERE id = p_draft;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.saas_creative_evidence_actor(p_subject, d.requested_by_principal_id);
  IF d.phase <> 'SUBMITTING' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  IF reason = 'INTERRUPTED' AND clock_timestamp() < d.created_at + interval '120 seconds' THEN
    RAISE EXCEPTION 'CREATIVE_GENERATION_IN_PROGRESS' USING ERRCODE = '40001';
  END IF;
  IF outcome = 'SUCCEEDED' THEN
    FOR a IN SELECT x FROM jsonb_array_elements(p->'pages') x LOOP
      IF jsonb_typeof(a) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a) k) IS DISTINCT FROM ARRAY['pageKey','sections','title']
        OR coalesce(jsonb_typeof(a->'pageKey'), '') <> 'string' OR NOT (a->>'pageKey' = ANY (d.pages))
        OR coalesce(jsonb_typeof(a->'title'), '') <> 'string' OR NOT hon.creative_website_line_ok(a->>'title', 120)
        OR NOT hon.creative_website_sections_ok(a->'sections') THEN
        RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
      END IF;
    END LOOP;
    n := jsonb_array_length(p->'pages');
    IF (SELECT count(DISTINCT x->>'pageKey') FROM jsonb_array_elements(p->'pages') x) <> n THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
    body := jsonb_build_object('outcome', 'SUCCEEDED', 'finalUnits', n, 'providerCostMicrounits', p->'providerCostMicrounits');
    next_phase := 'RESULT_RECORDED';
  ELSIF outcome = 'FAILED' THEN
    body := jsonb_build_object('outcome', 'FAILED', 'finalUnits', NULL, 'providerCostMicrounits', p->'providerCostMicrounits'); next_phase := 'PROVIDER_FAILED';
  ELSIF outcome = 'NOT_SENT' THEN
    body := jsonb_build_object('outcome', 'FAILED', 'finalUnits', NULL, 'providerCostMicrounits', 0); next_phase := 'NOT_SENT';
  ELSE
    body := jsonb_build_object('outcome', 'UNKNOWN', 'finalUnits', NULL, 'providerCostMicrounits', NULL); next_phase := 'PROVIDER_UNKNOWN';
  END IF;
  SELECT version INTO v FROM hon.saas_creative_reservations WHERE id = d.reservation_id AND school_id = d.school_id;
  receipt := hon.settle_saas_creative_credits(p_subject, d.reservation_id, body || jsonb_build_object('expectedVersion', v),
    md5('creative.website.result:' || d.id::text)::uuid, gen_random_uuid(), gen_random_uuid());
  IF (receipt->>'replayed')::boolean THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp();
  UPDATE hon.creative_website_drafts SET phase = next_phase, failure_reason = CASE WHEN outcome = 'SUCCEEDED' THEN NULL ELSE reason END,
      version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = d.id AND phase = 'SUBMITTING' RETURNING * INTO updated;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  IF outcome = 'SUCCEEDED' THEN
    INSERT INTO hon.creative_website_draft_pages(draft_id, school_id, page_key, title, sections, origin, created_at)
      SELECT d.id, d.school_id, x->>'pageKey', x->>'title', x->'sections', 'SYNTHETIC', at FROM jsonb_array_elements(p->'pages') x;
  END IF;
  RETURN jsonb_build_object('draft', hon.creative_website_draft_json(updated, true), 'balance', receipt->'balance', 'replayed', false);
END $$;

-- READS: the exact school only (CW1 school actor). The list carries no page text (newest 50); one draft carries it.
CREATE FUNCTION hon.read_creative_website_drafts(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; list jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT coalesce(jsonb_agg(hon.creative_website_draft_json(d, false) ORDER BY d.created_at DESC, d.id DESC), '[]'::jsonb) INTO list
    FROM (SELECT * FROM hon.creative_website_drafts WHERE school_id = scope.school_id ORDER BY created_at DESC, id DESC LIMIT 50) d;
  RETURN jsonb_build_object('drafts', list, 'limit', 50);
END $$;

CREATE FUNCTION hon.read_creative_website_draft(p_subject text, p_school uuid, p_draft uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; d hon.creative_website_drafts%ROWTYPE;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT * INTO d FROM hon.creative_website_drafts WHERE id = p_draft AND school_id = scope.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN hon.creative_website_draft_json(d, true);
END $$;

-- ---------- ACL: private deny-all tables; four runtime entry points ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['creative_website_drafts','creative_website_draft_pages'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I CASCADE',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace
      AND p.proname IN ('creative_website_page_rank','creative_website_pages_ok','creative_website_line_ok','creative_website_body_ok',
        'creative_website_sections_ok','guard_creative_website_draft','creative_website_draft_json','creative_website_draft_fingerprint',
        'create_creative_website_draft','record_creative_website_draft_result','read_creative_website_drafts','read_creative_website_draft') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_creative_website_draft(text,uuid,jsonb,jsonb,uuid,uuid,uuid), hon.record_creative_website_draft_result(text,uuid,jsonb),
      hon.read_creative_website_drafts(text,uuid), hon.read_creative_website_draft(text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
