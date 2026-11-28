BEGIN;

-- HQ email and text blasts HB1 (0712, allocated by the coordinator 2026-11-28). Owner request (David, 2026-11-28): HQ blasts
-- "like school OS with filter and everything". Spec: docs/architecture/HQ_BLASTS.md. Contract: @hon/contracts hq-blasts.ts.
-- Rules:
--   HB1  Only the current HQ owner (0281 hq_communication_is_owner) lists, reads, counts, saves, sends and cancels blasts.
--        Direct human only (0281 require_hq_communication_actor refuses AI/delegated context); proved again after the locks.
--   HB2  A blast is one channel (EMAIL with a subject, or SMS), one purpose (ANNOUNCEMENT, SUPPORT or ONBOARDING; never
--        BILLING or ACCOUNT, which pass an email opt-out), one plain-text body with the closed merge tags {{first_name}}
--        {{school_name}} {{hq_name}}, and an audience of schools (closed filter shape, hon.hq_blast_audience_ok).
--   HB3  The audience is resolved here (hon.hq_blast_resolve), for the count and for the send alike: ACTIVE and SUSPENDED
--        ("paused") schools of ACTIVE/SUSPENDED organizations matching every filter, plus picked schools, minus left-out ones;
--        archived never. Each school's current non-HQ owners (0281) are reachable by email when they have an account email
--        and no HQ email opt-out, by text when they turned HQ texts on with a confirmed phone (0282). A school with a blast on
--        the same channel in the last 24 hours is skipped as RECENTLY_SENT. HQ never sees an address.
--   HB4  Sending writes, per reachable school, one QUEUED hon.hq_messages row (blast_id, subject, body with {{school_name}} and
--        {{hq_name}} filled) and one delivery per reachable owner due at send_at; the 0281 dispatcher delivers them with its
--        own consent, quiet-hours and sender checks. {{first_name}} is filled by the claim, in memory. At most 2,000 schools
--        per blast and 10 blasts handed over in any 24 hours (one HQ lock). A scheduled blast can be cancelled before its
--        time while no delivery has left PENDING: its messages become CANCELLED and pending deliveries SUPPRESSED.
--   HB5  ANNOUNCEMENT joins the HQ owner's messaging purposes only (operators unchanged). One-off HQ messages keep the four
--        0281 purposes. Exact-request idempotency, append-only events and an inert outbox with ids and counts only.
--        The runtime gains no table privilege, only EXECUTE on the seven entry points.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ blasts require a trusted migration owner'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HQ blasts require a restricted runtime'; END IF;
  IF to_regprocedure('hon.require_hq_communication_actor(text,text)') IS NULL OR to_regprocedure('hon.hq_contact_sms_address(uuid)') IS NULL
    OR to_regprocedure('hon.school_plan_features(uuid,uuid)') IS NULL OR to_regclass('hon.school_locations') IS NULL
    OR to_regclass('hon.hon_os_trial_enrollments') IS NULL OR to_regclass('hon.hq_inbound_replies') IS NULL THEN
    RAISE EXCEPTION '0712 requires 0281, 0282, 0246, 0392, 0698 and 0699'; END IF;
END $$;

-- ---------- ANNOUNCEMENT purpose (HQ owner only) ----------
ALTER TABLE hon.hq_messages DROP CONSTRAINT hq_messages_purpose_check;
ALTER TABLE hon.hq_messages ADD CONSTRAINT hq_messages_purpose_check CHECK (purpose IN ('SUPPORT','BILLING','ONBOARDING','ACCOUNT','ANNOUNCEMENT'));

CREATE OR REPLACE FUNCTION hon.hq_communication_purposes(p_principal uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce(array_agg(DISTINCT x.purpose ORDER BY x.purpose), ARRAY[]::text[]) FROM (
    SELECT unnest(CASE WHEN g.hq_role = 'HON_HQ_OWNER' THEN ARRAY['ACCOUNT','ANNOUNCEMENT','BILLING','ONBOARDING','SUPPORT']
      WHEN g.hq_role IN ('HON_HQ_OPERATOR','HON_HQ_SUPPORT') THEN
        (CASE WHEN 'hq.support.manage' = ANY(g.permission_codes) THEN ARRAY['ACCOUNT','SUPPORT'] ELSE ARRAY[]::text[] END)
        || (CASE WHEN 'hq.billing.manage' = ANY(g.permission_codes) THEN ARRAY['BILLING'] ELSE ARRAY[]::text[] END)
        || (CASE WHEN 'hq.onboarding.manage' = ANY(g.permission_codes) THEN ARRAY['ONBOARDING'] ELSE ARRAY[]::text[] END)
      ELSE ARRAY[]::text[] END) AS purpose
    FROM hon.hq_operator_grants g JOIN hon.principals p ON p.id = g.principal_id
    WHERE g.principal_id = p_principal AND p.is_active AND p.principal_type = 'HUMAN_USER'
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (SELECT count(*) FROM hon.principals o WHERE o.user_id = p.user_id AND o.is_active) = 1
      AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
        AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()))) x
$$;

-- Same meaning as 0281 (a live HQ owner grant that passes every identity rule), now that the owner holds five purposes.
CREATE OR REPLACE FUNCTION hon.hq_communication_is_owner(p_principal uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p_principal AND g.hq_role = 'HON_HQ_OWNER'
    AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp()))
  AND 'ANNOUNCEMENT' = ANY(hon.hq_communication_purposes(p_principal))
$$;

-- ---------- text and audience checks ----------
CREATE FUNCTION hon.hq_blast_text_ok(v jsonb, p_min integer, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v) = 'string' AND (v#>>'{}') !~ '^[ \t\n\r]' AND (v#>>'{}') !~ '[ \t\n\r]$'
    AND length(v#>>'{}') BETWEEN p_min AND p_max AND (v#>>'{}') !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'
    AND regexp_replace(v#>>'{}', '\{\{(first_name|school_name|hq_name)\}\}', '', 'g') !~ '(\{\{|\}\})', false)
$$;
CREATE FUNCTION hon.hq_blast_line_ok(v jsonb, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT hon.hq_blast_text_ok(v, 1, p_max) AND (v#>>'{}') !~ '[\t\n\r]'
$$;

-- A JSON array of 1..p_max distinct strings, each matching p_pattern.
CREATE FUNCTION hon.hq_blast_strings_ok(a jsonb, p_max integer, p_pattern text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(a) = 'array' AND jsonb_array_length(a) BETWEEN 1 AND p_max
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a) e WHERE jsonb_typeof(e) <> 'string' OR (e#>>'{}') !~ p_pattern)
    AND (SELECT count(DISTINCT lower(e#>>'{}')) FROM jsonb_array_elements(a) e) = jsonb_array_length(a), false)
$$;

-- A real calendar day written YYYY-MM-DD (2000-2099).
CREATE FUNCTION hon.hq_blast_day_ok(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR (v#>>'{}') !~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN RETURN false; END IF;
  RETURN to_char(make_date(substr(v#>>'{}', 1, 4)::integer, substr(v#>>'{}', 6, 2)::integer, substr(v#>>'{}', 9, 2)::integer), 'YYYY-MM-DD') = (v#>>'{}');
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN false;
END $$;

-- The closed audience shape. Every key is optional; {} means every active and paused school.
CREATE FUNCTION hon.hq_blast_audience_ok(a jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce(jsonb_typeof(a) = 'object'
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(a) k WHERE k NOT IN ('statuses','planNames','noPlan','founder','billingIntervals',
      'freePlan','trial','trialEndsWithinDays','joinedWithinDays','joinedFrom','joinedTo','countries','regions','cities',
      'featuresIncluded','featuresMissing','canGetTexts','schools','excludeSchools'))
    AND (NOT a ? 'statuses' OR hon.hq_blast_strings_ok(a->'statuses', 2, '^(ACTIVE|PAUSED)$'))
    AND (NOT a ? 'planNames' OR hon.hq_blast_strings_ok(a->'planNames', 20, '^\S(?:.{0,78}\S)?$'))
    AND (NOT a ? 'noPlan' OR a->'noPlan' = 'true'::jsonb)
    AND (NOT a ? 'founder' OR jsonb_typeof(a->'founder') = 'boolean')
    AND (NOT a ? 'billingIntervals' OR hon.hq_blast_strings_ok(a->'billingIntervals', 3, '^(MONTHLY|ANNUAL|ONE_TIME)$'))
    AND (NOT a ? 'freePlan' OR jsonb_typeof(a->'freePlan') = 'boolean')
    AND (NOT a ? 'trial' OR (jsonb_typeof(a->'trial') = 'string' AND a->>'trial' IN ('ON_TRIAL','TRIAL_ENDED','NEVER')))
    AND (NOT a ? 'trialEndsWithinDays' OR (a->'trialEndsWithinDays' IN ('7'::jsonb, '14'::jsonb, '30'::jsonb)
      AND coalesce(a->>'trial', 'ON_TRIAL') = 'ON_TRIAL'))
    AND (NOT a ? 'joinedWithinDays' OR (a->'joinedWithinDays' IN ('7'::jsonb, '30'::jsonb, '90'::jsonb)
      AND NOT a ? 'joinedFrom' AND NOT a ? 'joinedTo'))
    AND (NOT a ? 'joinedFrom' OR hon.hq_blast_day_ok(a->'joinedFrom'))
    AND (NOT a ? 'joinedTo' OR hon.hq_blast_day_ok(a->'joinedTo'))
    AND (NOT (a ? 'joinedFrom' AND a ? 'joinedTo') OR a->>'joinedFrom' <= a->>'joinedTo')
    AND (NOT a ? 'countries' OR hon.hq_blast_strings_ok(a->'countries', 10, '^[A-Z]{2}$'))
    AND (NOT a ? 'regions' OR hon.hq_blast_strings_ok(a->'regions', 20, '^[A-Z0-9]{1,3}$'))
    AND (NOT a ? 'cities' OR hon.hq_blast_strings_ok(a->'cities', 20, '^\S(?:[^\x00-\x1F\x7F]{0,98}\S)?$'))
    AND (NOT a ? 'featuresIncluded' OR (hon.hq_blast_strings_ok(a->'featuresIncluded', 20, '^[a-z]+\.[a-z_]+$')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(a->'featuresIncluded') f WHERE NOT f = ANY(hon.saas_plan_capabilities('COMPLETE')))))
    AND (NOT a ? 'featuresMissing' OR (hon.hq_blast_strings_ok(a->'featuresMissing', 20, '^[a-z]+\.[a-z_]+$')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(a->'featuresMissing') f WHERE NOT f = ANY(hon.saas_plan_capabilities('COMPLETE')))))
    AND (NOT a ? 'canGetTexts' OR a->'canGetTexts' = 'true'::jsonb)
    AND (NOT a ? 'schools' OR hon.hq_blast_strings_ok(a->'schools', 200, '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
    AND (NOT a ? 'excludeSchools' OR hon.hq_blast_strings_ok(a->'excludeSchools', 200, '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')), false)
$$;

-- ---------- records ----------
CREATE TABLE hon.hq_blasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (hon.hq_blast_line_ok(to_jsonb(name), 100)),
  channel text NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  purpose text NOT NULL CHECK (purpose IN ('ANNOUNCEMENT','SUPPORT','ONBOARDING')),
  subject text CHECK (subject IS NULL OR hon.hq_blast_line_ok(to_jsonb(subject), 150)),
  -- Room is left for the filled-in tags: a queued message must still fit 0281 (SMS 1,600, email 4,000).
  body text NOT NULL CHECK (hon.hq_blast_text_ok(to_jsonb(body), 1, CASE channel WHEN 'EMAIL' THEN 3500 ELSE 1400 END)),
  audience jsonb NOT NULL CHECK (hon.hq_blast_audience_ok(audience)),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','QUEUED','CANCELLED')),
  send_at timestamptz,
  queued_at timestamptz,
  queued_by uuid REFERENCES hon.principals(id),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES hon.principals(id),
  school_count integer CHECK (school_count IS NULL OR school_count BETWEEN 1 AND 2000),
  recipient_count integer CHECK (recipient_count IS NULL OR recipient_count BETWEEN 1 AND 200000),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_by uuid NOT NULL REFERENCES hon.principals(id),
  updated_by uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((channel = 'EMAIL') = (subject IS NOT NULL)),
  CHECK ((status = 'DRAFT') = (queued_at IS NULL AND queued_by IS NULL AND school_count IS NULL AND recipient_count IS NULL AND send_at IS NULL)),
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
);
CREATE INDEX hq_blasts_updated_idx ON hon.hq_blasts (updated_at DESC, id DESC);
CREATE INDEX hq_blasts_queued_idx ON hon.hq_blasts (queued_at) WHERE queued_at IS NOT NULL;

-- What happened to each school at send. Append-only.
CREATE TABLE hon.hq_blast_schools (
  blast_id uuid NOT NULL REFERENCES hon.hq_blasts(id),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('QUEUED','NO_OWNERS','NOT_REACHABLE','RECENTLY_SENT')),
  owner_count integer NOT NULL CHECK (owner_count BETWEEN 0 AND 100),
  reachable_count integer NOT NULL CHECK (reachable_count BETWEEN 0 AND 100 AND reachable_count <= owner_count),
  message_id uuid REFERENCES hon.hq_messages(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (blast_id, school_id),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id),
  CHECK ((outcome = 'QUEUED') = (message_id IS NOT NULL AND reachable_count > 0))
);

ALTER TABLE hon.hq_messages ADD COLUMN subject text CHECK (subject IS NULL OR (subject = btrim(subject) AND length(subject) BETWEEN 1 AND 300
  AND subject !~ '[\x00-\x1F\x7F]'));
ALTER TABLE hon.hq_messages ADD COLUMN blast_id uuid REFERENCES hon.hq_blasts(id);
ALTER TABLE hon.hq_messages ADD CONSTRAINT hq_messages_blast_shape CHECK (
  (blast_id IS NULL AND subject IS NULL AND purpose <> 'ANNOUNCEMENT')
  OR (blast_id IS NOT NULL AND (channel = 'EMAIL') = (subject IS NOT NULL) AND purpose IN ('ANNOUNCEMENT','SUPPORT','ONBOARDING')));
CREATE INDEX hq_messages_blast_idx ON hon.hq_messages (blast_id) WHERE blast_id IS NOT NULL;
CREATE INDEX hq_messages_school_blast_recent_idx ON hon.hq_messages (school_id, channel, queued_at) WHERE blast_id IS NOT NULL;

CREATE TABLE hon.hq_blast_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('SAVE','SEND','CANCEL')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (actor_principal_id, idempotency_key)
);
CREATE TABLE hon.hq_blast_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blast_id uuid NOT NULL REFERENCES hon.hq_blasts(id),
  action text NOT NULL CHECK (action IN ('CREATED','EDITED','QUEUED','CANCELLED')),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  request_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  version integer NOT NULL,
  school_count integer,
  recipient_count integer,
  occurred_at timestamptz NOT NULL,
  UNIQUE (actor_principal_id, idempotency_key)
);
CREATE INDEX hq_blast_events_blast_idx ON hon.hq_blast_events (blast_id, occurred_at);
CREATE TABLE hon.hq_blast_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES hon.hq_blast_events(id),
  event_type text NOT NULL CHECK (event_type IN ('hq.blast.saved','hq.blast.queued','hq.blast.cancelled')),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  request_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);

-- A blast changes only by version bump; only a DRAFT changes content; QUEUED may only become CANCELLED.
CREATE FUNCTION hon.guard_hq_blast() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.status <> 'DRAFT' THEN RAISE EXCEPTION 'HQ_BLAST_IMMUTABLE' USING ERRCODE = '42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND (NEW.id, NEW.created_by, NEW.created_at) = (OLD.id, OLD.created_by, OLD.created_at)
    AND (OLD.status = 'DRAFT'
      OR (OLD.status = 'QUEUED' AND NEW.status = 'CANCELLED'
        AND (to_jsonb(NEW) - ARRAY['status','cancelled_at','cancelled_by','updated_by','updated_at','version'])
          = (to_jsonb(OLD) - ARRAY['status','cancelled_at','cancelled_by','updated_by','updated_at','version'])))
    AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'CANCELLED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HQ_BLAST_IMMUTABLE' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER guarded BEFORE INSERT OR UPDATE OR DELETE ON hon.hq_blasts FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_blast();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_blast_schools','hq_blast_requests','hq_blast_events','hq_blast_outbox'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_evidence()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hq_blasts','hq_blast_schools','hq_blast_requests','hq_blast_events','hq_blast_outbox'] LOOP
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_communication_evidence()', t);
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
  END LOOP;
END $$;

-- ---------- audience ----------
-- Every school the audience reaches, with its owners and how many can get this channel. Shared by the count and the send.
CREATE FUNCTION hon.hq_blast_resolve(p_audience jsonb, p_channel text)
RETURNS TABLE (organization_id uuid, school_id uuid, school_name text, owner_count integer, reachable_count integer, outcome text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE a jsonb := p_audience; now_at timestamptz := clock_timestamp();
  statuses text[]; picks uuid[]; leaves uuid[]; plans text[]; intervals text[]; countries text[]; regions text[]; cities text[];
  f_in text[]; f_out text[];
BEGIN
  IF NOT hon.hq_blast_audience_ok(a) OR p_channel NOT IN ('EMAIL','SMS') THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  statuses := ARRAY(SELECT CASE e WHEN 'PAUSED' THEN 'SUSPENDED' ELSE e END FROM jsonb_array_elements_text(coalesce(a->'statuses', '["ACTIVE","PAUSED"]')) e);
  picks := ARRAY(SELECT e::uuid FROM jsonb_array_elements_text(coalesce(a->'schools', '[]')) e);
  leaves := ARRAY(SELECT e::uuid FROM jsonb_array_elements_text(coalesce(a->'excludeSchools', '[]')) e);
  plans := ARRAY(SELECT lower(e) FROM jsonb_array_elements_text(coalesce(a->'planNames', '[]')) e);
  intervals := ARRAY(SELECT e FROM jsonb_array_elements_text(coalesce(a->'billingIntervals', '[]')) e);
  countries := ARRAY(SELECT e FROM jsonb_array_elements_text(coalesce(a->'countries', '[]')) e);
  regions := ARRAY(SELECT e FROM jsonb_array_elements_text(coalesce(a->'regions', '[]')) e);
  cities := ARRAY(SELECT lower(e) FROM jsonb_array_elements_text(coalesce(a->'cities', '[]')) e);
  f_in := ARRAY(SELECT e FROM jsonb_array_elements_text(coalesce(a->'featuresIncluded', '[]')) e);
  f_out := ARRAY(SELECT e FROM jsonb_array_elements_text(coalesce(a->'featuresMissing', '[]')) e);
  RETURN QUERY
  WITH live AS (
    SELECT s.id, s.organization_id, s.name, s.status::text AS status, s.created_at, s.timezone
    FROM hon.schools s JOIN hon.organizations o ON o.id = s.organization_id
    WHERE s.status IN ('ACTIVE','SUSPENDED') AND o.status IN ('ACTIVE','SUSPENDED')),
  facts AS (
    SELECT l.*, cur.action = 'ASSIGN' AND cur.school_id = l.id AS has_plan, cur.plan_name, cur.founder, cur.billing_interval, cur.price_minor,
      t.starts_at AS trial_starts, t.ends_at AS trial_ends, loc.country_code, loc.region_code, loc.city
    FROM live l
    LEFT JOIN LATERAL (SELECT (hon.hq_school_plan_current(l.organization_id)).*) cur ON true
    LEFT JOIN hon.hon_os_trial_enrollments t ON t.organization_id = l.organization_id AND t.school_id = l.id
    LEFT JOIN hon.school_locations loc ON loc.school_id = l.id AND loc.organization_id = l.organization_id),
  matched AS (
    SELECT f.* FROM facts f WHERE f.status = ANY(statuses)
      AND (NOT (a ? 'planNames' OR a ? 'noPlan')
        OR (coalesce(f.has_plan, false) AND lower(f.plan_name) = ANY(plans)) OR (a ? 'noPlan' AND NOT coalesce(f.has_plan, false)))
      AND (NOT a ? 'founder' OR (coalesce(f.has_plan, false) AND f.founder = (a->'founder')::boolean))
      AND (NOT a ? 'billingIntervals' OR (coalesce(f.has_plan, false) AND f.billing_interval = ANY(intervals)))
      AND (NOT a ? 'freePlan' OR (coalesce(f.has_plan, false) AND (f.price_minor = 0) = (a->'freePlan')::boolean))
      AND (NOT a ? 'trial' OR CASE a->>'trial'
        WHEN 'ON_TRIAL' THEN f.trial_starts <= now_at AND f.trial_ends > now_at
        WHEN 'TRIAL_ENDED' THEN f.trial_ends <= now_at
        ELSE f.trial_ends IS NULL END)
      AND (NOT a ? 'trialEndsWithinDays' OR (f.trial_starts <= now_at AND f.trial_ends > now_at
        AND f.trial_ends <= now_at + make_interval(days => (a->>'trialEndsWithinDays')::integer)))
      AND (NOT a ? 'joinedWithinDays' OR f.created_at >= now_at - make_interval(days => (a->>'joinedWithinDays')::integer))
      AND (NOT a ? 'joinedFrom' OR f.created_at >= (a->>'joinedFrom')::date::timestamp AT TIME ZONE 'UTC')
      AND (NOT a ? 'joinedTo' OR f.created_at < ((a->>'joinedTo')::date + 1)::timestamp AT TIME ZONE 'UTC')
      AND (NOT a ? 'countries' OR f.country_code = ANY(countries))
      AND (NOT a ? 'regions' OR f.region_code = ANY(regions))
      AND (NOT a ? 'cities' OR lower(f.city) = ANY(cities))
      AND (cardinality(f_in) = 0 OR f_in <@ ARRAY(SELECT jsonb_array_elements_text(hon.school_plan_features(f.organization_id, f.id)->'included')))
      AND (cardinality(f_out) = 0 OR NOT f_out <@ ARRAY(SELECT jsonb_array_elements_text(hon.school_plan_features(f.organization_id, f.id)->'included')))
    UNION
    SELECT f.* FROM facts f WHERE f.id = ANY(picks)),
  chosen AS (SELECT DISTINCT ON (m.id) m.* FROM matched m WHERE NOT m.id = ANY(leaves) ORDER BY m.id),
  owners AS (
    SELECT c.id AS school, r.user_id,
      CASE p_channel
        WHEN 'EMAIL' THEN nullif(btrim((SELECT u.email::text FROM hon.users u WHERE u.id = r.user_id)), '') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM hon.hq_contact_preferences x WHERE x.user_id = r.user_id AND x.channel = 'EMAIL' AND x.status = 'OPTED_OUT')
        ELSE EXISTS (SELECT 1 FROM hon.hq_contact_preferences x WHERE x.user_id = r.user_id AND x.channel = 'SMS' AND x.status = 'OPTED_IN')
          AND hon.hq_contact_sms_address(r.user_id) IS NOT NULL END AS reachable,
      EXISTS (SELECT 1 FROM hon.hq_contact_preferences x WHERE x.user_id = r.user_id AND x.channel = 'SMS' AND x.status = 'OPTED_IN')
        AND hon.hq_contact_sms_address(r.user_id) IS NOT NULL AS texts_on
    FROM chosen c CROSS JOIN LATERAL hon.hq_message_owner_recipients(c.id) r),
  counted AS (
    SELECT c.organization_id, c.id, c.name, c.id = ANY(picks) AS picked,
      (SELECT count(*) FROM owners o WHERE o.school = c.id)::integer AS n_owners,
      (SELECT count(*) FROM owners o WHERE o.school = c.id AND o.reachable)::integer AS n_reach,
      EXISTS (SELECT 1 FROM owners o WHERE o.school = c.id AND o.texts_on) AS any_texts,
      EXISTS (SELECT 1 FROM hon.hq_messages m WHERE m.school_id = c.id AND m.channel = p_channel AND m.blast_id IS NOT NULL AND m.status = 'QUEUED'
        AND m.queued_at > now_at - interval '24 hours') AS recent
    FROM chosen c)
  SELECT k.organization_id, k.id, left(k.name, 300), least(k.n_owners, 100), least(k.n_reach, 100),
    CASE WHEN k.n_owners = 0 THEN 'NO_OWNERS' WHEN k.recent THEN 'RECENTLY_SENT' WHEN k.n_reach = 0 THEN 'NOT_REACHABLE' ELSE 'QUEUED' END
  FROM counted k WHERE NOT a ? 'canGetTexts' OR k.any_texts OR k.picked
  ORDER BY k.name, k.id;
END $$;

-- ---------- projections ----------
CREATE FUNCTION hon.hq_blast_fill(p_text text, p_school text, p_hq text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT replace(replace(p_text, '{{school_name}}', p_school), '{{hq_name}}', p_hq)
$$;

CREATE FUNCTION hon.hq_blast_json(b hon.hq_blasts) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('blastId', b.id, 'name', b.name, 'channel', b.channel, 'purpose', b.purpose, 'subject', b.subject,
    'body', b.body, 'audience', b.audience, 'status', b.status, 'sendAt', hon.saas_ts(b.send_at), 'queuedAt', hon.saas_ts(b.queued_at),
    'cancelledAt', hon.saas_ts(b.cancelled_at), 'schoolCount', b.school_count, 'recipientCount', b.recipient_count,
    'createdBy', hon.hq_communication_person_json(b.created_by), 'createdAt', hon.saas_ts(b.created_at),
    'updatedAt', hon.saas_ts(b.updated_at), 'version', b.version)
$$;

CREATE FUNCTION hon.hq_blast_results_json(p_blast uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object(
    'schools', (SELECT jsonb_build_object('queued', count(*) FILTER (WHERE x.outcome = 'QUEUED'),
      'noOwners', count(*) FILTER (WHERE x.outcome = 'NO_OWNERS'), 'notReachable', count(*) FILTER (WHERE x.outcome = 'NOT_REACHABLE'),
      'recentlySent', count(*) FILTER (WHERE x.outcome = 'RECENTLY_SENT')) FROM hon.hq_blast_schools x WHERE x.blast_id = p_blast),
    'deliveries', (SELECT jsonb_build_object(
      'waiting', count(*) FILTER (WHERE d.status = 'PENDING' AND d.hold_reason IS NOT NULL),
      'pending', count(*) FILTER (WHERE d.status = 'PENDING' AND d.hold_reason IS NULL),
      'sending', count(*) FILTER (WHERE d.status = 'SENDING'), 'accepted', count(*) FILTER (WHERE d.status = 'ACCEPTED'),
      'delivered', count(*) FILTER (WHERE d.status = 'DELIVERED'), 'bounced', count(*) FILTER (WHERE d.status = 'BOUNCED'),
      'failed', count(*) FILTER (WHERE d.status = 'FAILED'), 'suppressed', count(*) FILTER (WHERE d.status = 'SUPPRESSED'),
      'unknown', count(*) FILTER (WHERE d.status = 'UNKNOWN'))
      FROM hon.hq_message_deliveries d JOIN hon.hq_messages m ON m.id = d.message_id WHERE m.blast_id = p_blast))
$$;

-- The current HQ messages projection, plus subject and blastId (null for one-off messages).
CREATE OR REPLACE FUNCTION hon.hq_message_json(m hon.hq_messages) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('messageId', m.id, 'organizationId', m.organization_id,
    'organizationDisplayName', left((SELECT o.display_name FROM hon.organizations o WHERE o.id = m.organization_id), 300),
    'schoolId', m.school_id, 'schoolDisplayName', left((SELECT s.name FROM hon.schools s WHERE s.id = m.school_id), 300),
    'purpose', m.purpose, 'channel', m.channel, 'content', m.content, 'supportCaseId', m.support_case_id, 'status', m.status,
    'recipientCount', m.recipient_count, 'createdBy', hon.hq_communication_person_json(m.created_by), 'createdAt', hon.saas_ts(m.created_at),
    'queuedAt', hon.saas_ts(m.queued_at), 'cancelledAt', hon.saas_ts(m.cancelled_at), 'updatedAt', hon.saas_ts(m.updated_at),
    'version', m.version, 'subject', m.subject, 'blastId', m.blast_id,
    'deliverySummary', (SELECT jsonb_build_object(
      'pending', count(*) FILTER (WHERE d.status IN ('PENDING','SENDING')), 'accepted', count(*) FILTER (WHERE d.status = 'ACCEPTED'),
      'delivered', count(*) FILTER (WHERE d.status = 'DELIVERED'), 'suppressed', count(*) FILTER (WHERE d.status = 'SUPPRESSED'),
      'failed', count(*) FILTER (WHERE d.status IN ('FAILED','BOUNCED')), 'unknown', count(*) FILTER (WHERE d.status = 'UNKNOWN'))
      FROM hon.hq_message_deliveries d WHERE d.message_id = m.id))
$$;

-- ---------- helpers ----------
CREATE FUNCTION hon.hq_blast_claim(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prior hon.hq_blast_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-blast:' || p_actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO prior FROM hon.hq_blast_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.operation <> p_operation OR prior.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  RETURN prior.response || jsonb_build_object('replayed', true);
END $$;

CREATE FUNCTION hon.hq_blast_record(p_actor uuid, p_key uuid, p_request uuid, p_correlation uuid, p_operation text, p_fingerprint text,
  p_action text, b hon.hq_blasts, p_result jsonb, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE ev uuid;
BEGIN
  INSERT INTO hon.hq_blast_requests VALUES (p_actor, p_key, p_operation, p_fingerprint, p_result, p_at);
  INSERT INTO hon.hq_blast_events (blast_id, action, actor_principal_id, idempotency_key, request_id, correlation_id, version, school_count,
    recipient_count, occurred_at)
  VALUES (b.id, p_action, p_actor, p_key, p_request, p_correlation, b.version, b.school_count, b.recipient_count, p_at) RETURNING id INTO ev;
  INSERT INTO hon.hq_blast_outbox (event_id, event_type, request_id, correlation_id, payload, occurred_at)
  VALUES (ev, CASE p_operation WHEN 'SAVE' THEN 'hq.blast.saved' WHEN 'SEND' THEN 'hq.blast.queued' ELSE 'hq.blast.cancelled' END,
    p_request, p_correlation, jsonb_build_object('blastId', b.id, 'version', b.version, 'status', b.status, 'channel', b.channel,
      'schoolCount', b.school_count, 'recipientCount', b.recipient_count), p_at);
END $$;

CREATE FUNCTION hon.hq_blast_args_ok(p_key uuid, p_request uuid, p_correlation uuid) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p_key IS NULL OR p_request IS NULL OR p_correlation IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
END $$;

-- ---------- commands (HQ owner only) ----------
-- SAVE: {blastId|null, expectedVersion (0 for new), name, channel, purpose, subject|null, body, audience}
CREATE FUNCTION hon.save_hq_blast(p_subject text, p_input jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; b hon.hq_blasts%ROWTYPE; fp text; at timestamptz := clock_timestamp(); result jsonb; v_id uuid; v_expected integer;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, 'OWNER');
  PERFORM hon.hq_blast_args_ok(p_key, p_request, p_correlation);
  PERFORM hon.hq_communication_keys(p_input, ARRAY['audience','blastId','body','channel','expectedVersion','name','purpose','subject']);
  v_id := hon.hq_communication_uuid(p_input, 'blastId', true);
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$'
    OR ((p_input->>'expectedVersion')::integer = 0) <> (v_id IS NULL)
    OR jsonb_typeof(p_input->'channel') IS DISTINCT FROM 'string' OR p_input->>'channel' NOT IN ('EMAIL','SMS')
    OR jsonb_typeof(p_input->'purpose') IS DISTINCT FROM 'string' OR p_input->>'purpose' NOT IN ('ANNOUNCEMENT','SUPPORT','ONBOARDING')
    OR NOT hon.hq_blast_line_ok(p_input->'name', 100)
    OR (p_input->>'channel' = 'EMAIL' AND NOT hon.hq_blast_line_ok(p_input->'subject', 150))
    OR (p_input->>'channel' = 'SMS' AND jsonb_typeof(p_input->'subject') IS DISTINCT FROM 'null')
    OR NOT hon.hq_blast_text_ok(p_input->'body', 1, CASE p_input->>'channel' WHEN 'EMAIL' THEN 3500 ELSE 1400 END)
    OR NOT hon.hq_blast_audience_ok(p_input->'audience') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := (p_input->>'expectedVersion')::integer;
  fp := hon.saas_fingerprint(ARRAY['hq.blast.save', p_input::text]);
  replay := hon.hq_blast_claim(actor, p_key, 'SAVE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER'); RETURN replay; END IF;
  IF v_id IS NULL THEN
    INSERT INTO hon.hq_blasts (name, channel, purpose, subject, body, audience, created_by, updated_by, created_at, updated_at)
    VALUES (p_input->>'name', p_input->>'channel', p_input->>'purpose', p_input->>'subject', p_input->>'body', p_input->'audience',
      actor, actor, at, at) RETURNING * INTO b;
  ELSE
    SELECT * INTO b FROM hon.hq_blasts WHERE id = v_id FOR UPDATE;
    IF b.id IS NULL THEN RAISE EXCEPTION 'HQ_BLAST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
    IF b.version <> v_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    IF b.status <> 'DRAFT' THEN RAISE EXCEPTION 'HQ_BLAST_NOT_DRAFT' USING ERRCODE = '23514'; END IF;
    UPDATE hon.hq_blasts SET name = p_input->>'name', channel = p_input->>'channel', purpose = p_input->>'purpose', subject = p_input->>'subject',
      body = p_input->>'body', audience = p_input->'audience', updated_by = actor, updated_at = at, version = version + 1
    WHERE id = b.id RETURNING * INTO b;
  END IF;
  result := jsonb_build_object('operation', 'SAVE', 'blast', hon.hq_blast_json(b));
  PERFORM hon.hq_blast_record(actor, p_key, p_request, p_correlation, 'SAVE', fp, CASE WHEN v_id IS NULL THEN 'CREATED' ELSE 'EDITED' END, b, result, at);
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- SEND: {blastId, expectedVersion, sendAt|null}. null = now; otherwise a time up to 60 days ahead.
CREATE FUNCTION hon.send_hq_blast(p_subject text, p_input jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; b hon.hq_blasts%ROWTYPE; m hon.hq_messages%ROWTYPE; d hon.hq_message_deliveries%ROWTYPE; fp text;
  at timestamptz := clock_timestamp(); result jsonb; v_id uuid; v_send timestamptz; r record; o record; hq_name text;
  n_schools integer := 0; n_people integer := 0; v_subject text; v_content text; targets jsonb;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, 'OWNER');
  PERFORM hon.hq_blast_args_ok(p_key, p_request, p_correlation);
  PERFORM hon.hq_communication_keys(p_input, ARRAY['blastId','expectedVersion','sendAt']);
  v_id := hon.hq_communication_uuid(p_input, 'blastId', false);
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR (jsonb_typeof(p_input->'sendAt') <> 'null' AND (jsonb_typeof(p_input->'sendAt') <> 'string'
      OR p_input->>'sendAt' !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_send := CASE WHEN jsonb_typeof(p_input->'sendAt') = 'string' THEN (p_input->>'sendAt')::timestamptz END;
  IF v_send IS NOT NULL AND (v_send < at - interval '5 minutes' OR v_send > at + interval '60 days') THEN
    RAISE EXCEPTION 'HQ_BLAST_SEND_TIME' USING ERRCODE = '23514';
  END IF;
  v_send := greatest(coalesce(v_send, at), at);
  fp := hon.saas_fingerprint(ARRAY['hq.blast.send', p_input::text]);
  replay := hon.hq_blast_claim(actor, p_key, 'SEND', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER'); RETURN replay; END IF;
  -- One HQ lock for the daily count, then the blast.
  PERFORM pg_advisory_xact_lock(hashtextextended('hq-blast-send', 0));
  SELECT * INTO b FROM hon.hq_blasts WHERE id = v_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'HQ_BLAST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF b.version <> (p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF b.status <> 'DRAFT' THEN RAISE EXCEPTION 'HQ_BLAST_NOT_DRAFT' USING ERRCODE = '23514'; END IF;
  IF (SELECT count(*) FROM hon.hq_blasts x WHERE x.queued_at > at - interval '24 hours') >= 10 THEN
    RAISE EXCEPTION 'HQ_BLAST_DAILY_LIMIT' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.school_name, x.school_id), '[]'::jsonb) INTO targets FROM hon.hq_blast_resolve(b.audience, b.channel) x;
  IF (SELECT count(*) FROM jsonb_array_elements(targets) e WHERE e->>'outcome' = 'QUEUED') > 2000 THEN
    RAISE EXCEPTION 'HQ_BLAST_AUDIENCE_TOO_LARGE' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(targets) e WHERE e->>'outcome' = 'QUEUED') THEN
    RAISE EXCEPTION 'HQ_BLAST_NO_RECIPIENTS' USING ERRCODE = '23514';
  END IF;
  hq_name := left(coalesce(nullif(btrim((SELECT u.display_name FROM hon.principals p JOIN hon.users u ON u.id = p.user_id WHERE p.id = actor)), ''), 'HON OS'), 80);
  FOR r IN SELECT * FROM jsonb_to_recordset(targets) AS t(organization_id uuid, school_id uuid, school_name text, owner_count integer,
      reachable_count integer, outcome text) ORDER BY t.school_name, t.school_id LOOP
    IF r.outcome <> 'QUEUED' THEN
      INSERT INTO hon.hq_blast_schools (blast_id, organization_id, school_id, outcome, owner_count, reachable_count)
      VALUES (b.id, r.organization_id, r.school_id, r.outcome, r.owner_count, r.reachable_count);
      CONTINUE;
    END IF;
    v_content := hon.hq_blast_fill(b.body, btrim(r.school_name), hq_name);
    v_subject := CASE WHEN b.subject IS NOT NULL THEN hon.hq_blast_fill(b.subject, btrim(r.school_name), hq_name) END;
    IF length(v_content) > (CASE b.channel WHEN 'SMS' THEN 1600 ELSE 4000 END) OR (v_subject IS NOT NULL AND length(v_subject) > 300) THEN
      RAISE EXCEPTION 'HQ_BLAST_TEXT_TOO_LONG' USING ERRCODE = '23514';
    END IF;
    INSERT INTO hon.hq_messages (organization_id, school_id, purpose, channel, content, subject, blast_id, status, recipient_count,
      created_by, created_at, queued_by, queued_at, updated_at)
    VALUES (r.organization_id, r.school_id, b.purpose, b.channel, v_content, v_subject, b.id, 'QUEUED', r.reachable_count,
      actor, at, actor, at, at) RETURNING * INTO m;
    FOR o IN SELECT x.principal_id FROM hon.hq_message_owner_recipients(r.school_id) x JOIN hon.users u ON u.id = x.user_id
      WHERE CASE b.channel
        WHEN 'EMAIL' THEN nullif(btrim(u.email::text), '') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM hon.hq_contact_preferences c WHERE c.user_id = x.user_id AND c.channel = 'EMAIL' AND c.status = 'OPTED_OUT')
        ELSE EXISTS (SELECT 1 FROM hon.hq_contact_preferences c WHERE c.user_id = x.user_id AND c.channel = 'SMS' AND c.status = 'OPTED_IN')
          AND hon.hq_contact_sms_address(x.user_id) IS NOT NULL END
      ORDER BY x.principal_id LIMIT 100 LOOP
      INSERT INTO hon.hq_message_deliveries (organization_id, school_id, message_id, recipient_principal_id, channel, next_attempt_at)
      VALUES (m.organization_id, m.school_id, m.id, o.principal_id, m.channel, v_send) RETURNING * INTO d;
      PERFORM hon.hq_message_delivery_evidence(d, NULL, 'hq.communication.delivery.created');
      n_people := n_people + 1;
    END LOOP;
    INSERT INTO hon.hq_blast_schools (blast_id, organization_id, school_id, outcome, owner_count, reachable_count, message_id)
    VALUES (b.id, r.organization_id, r.school_id, 'QUEUED', r.owner_count, r.reachable_count, m.id);
    n_schools := n_schools + 1;
  END LOOP;
  UPDATE hon.hq_blasts SET status = 'QUEUED', send_at = v_send, queued_at = at, queued_by = actor, school_count = n_schools,
    recipient_count = n_people, updated_by = actor, updated_at = at, version = version + 1 WHERE id = b.id RETURNING * INTO b;
  result := jsonb_build_object('operation', 'SEND', 'blast', hon.hq_blast_json(b), 'results', hon.hq_blast_results_json(b.id));
  PERFORM hon.hq_blast_record(actor, p_key, p_request, p_correlation, 'SEND', fp, 'QUEUED', b, result, at);
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- CANCEL: {blastId, expectedVersion}. Only a queued blast none of whose deliveries has left PENDING.
CREATE FUNCTION hon.cancel_hq_blast(p_subject text, p_input jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; b hon.hq_blasts%ROWTYPE; m hon.hq_messages%ROWTYPE; d hon.hq_message_deliveries%ROWTYPE; fp text;
  at timestamptz := clock_timestamp(); result jsonb; v_id uuid;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, 'OWNER');
  PERFORM hon.hq_blast_args_ok(p_key, p_request, p_correlation);
  PERFORM hon.hq_communication_keys(p_input, ARRAY['blastId','expectedVersion']);
  v_id := hon.hq_communication_uuid(p_input, 'blastId', false);
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  fp := hon.saas_fingerprint(ARRAY['hq.blast.cancel', p_input::text]);
  replay := hon.hq_blast_claim(actor, p_key, 'CANCEL', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER'); RETURN replay; END IF;
  SELECT * INTO b FROM hon.hq_blasts WHERE id = v_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'HQ_BLAST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF b.version <> (p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  -- Lock the messages and deliveries first (waiting out any claim in flight), as 0281 cancel does.
  PERFORM 1 FROM hon.hq_messages x WHERE x.blast_id = b.id ORDER BY x.id FOR UPDATE;
  PERFORM 1 FROM hon.hq_message_deliveries x JOIN hon.hq_messages y ON y.id = x.message_id WHERE y.blast_id = b.id ORDER BY x.id FOR UPDATE OF x;
  IF b.status <> 'QUEUED' OR EXISTS (SELECT 1 FROM hon.hq_message_deliveries x JOIN hon.hq_messages y ON y.id = x.message_id
      WHERE y.blast_id = b.id AND x.status NOT IN ('PENDING','SUPPRESSED')) THEN
    RAISE EXCEPTION 'HQ_BLAST_NOT_CANCELLABLE' USING ERRCODE = '23514';
  END IF;
  FOR d IN SELECT x.* FROM hon.hq_message_deliveries x JOIN hon.hq_messages y ON y.id = x.message_id
      WHERE y.blast_id = b.id AND x.status = 'PENDING' ORDER BY x.id LOOP
    UPDATE hon.hq_message_deliveries SET status = 'SUPPRESSED', hold_reason = NULL, failure_code = 'CANCELLED', final_at = at,
      version = version + 1, updated_at = at WHERE id = d.id RETURNING * INTO d;
    PERFORM hon.hq_message_delivery_evidence(d, 'PENDING', 'hq.communication.delivery.cancelled');
  END LOOP;
  FOR m IN SELECT * FROM hon.hq_messages x WHERE x.blast_id = b.id AND x.status = 'QUEUED' ORDER BY x.id LOOP
    UPDATE hon.hq_messages SET status = 'CANCELLED', cancelled_by = actor, cancelled_at = at, updated_at = at, version = version + 1 WHERE id = m.id;
  END LOOP;
  UPDATE hon.hq_blasts SET status = 'CANCELLED', cancelled_at = at, cancelled_by = actor, updated_by = actor, updated_at = at, version = version + 1
  WHERE id = b.id RETURNING * INTO b;
  result := jsonb_build_object('operation', 'CANCEL', 'blast', hon.hq_blast_json(b), 'results', hon.hq_blast_results_json(b.id));
  PERFORM hon.hq_blast_record(actor, p_key, p_request, p_correlation, 'CANCEL', fp, 'CANCELLED', b, result, at);
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- reads (HQ owner only) ----------
CREATE FUNCTION hon.read_hq_blasts(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE result jsonb;
BEGIN
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  SELECT jsonb_build_object('blasts', coalesce(jsonb_agg(hon.hq_blast_json(x.b) || jsonb_build_object('results', hon.hq_blast_results_json((x.b).id))
      ORDER BY (x.b).updated_at DESC, (x.b).id DESC), '[]'::jsonb),
    'sentToday', (SELECT count(*) FROM hon.hq_blasts y WHERE y.queued_at > clock_timestamp() - interval '24 hours'), 'dailyLimit', 10,
    'asOf', hon.saas_ts(clock_timestamp()))
  INTO result FROM (SELECT y AS b FROM hon.hq_blasts y ORDER BY y.updated_at DESC, y.id DESC LIMIT 200) x;
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result;
END $$;

CREATE FUNCTION hon.read_hq_blast(p_subject text, p_blast uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE b hon.hq_blasts%ROWTYPE; result jsonb;
BEGIN
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  IF p_blast IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO b FROM hon.hq_blasts WHERE id = p_blast;
  IF b.id IS NULL THEN RAISE EXCEPTION 'HQ_BLAST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  result := jsonb_build_object('blast', hon.hq_blast_json(b), 'results', hon.hq_blast_results_json(b.id),
    'schools', (SELECT coalesce(jsonb_agg(jsonb_build_object('schoolId', x.school_id,
        'schoolDisplayName', left((SELECT s.name FROM hon.schools s WHERE s.id = x.school_id), 300), 'outcome', x.outcome,
        'ownerCount', x.owner_count, 'reachableCount', x.reachable_count, 'messageId', x.message_id)
      ORDER BY x.recorded_at, x.school_id), '[]'::jsonb) FROM (SELECT * FROM hon.hq_blast_schools y WHERE y.blast_id = b.id
        ORDER BY y.recorded_at, y.school_id LIMIT 2000) x),
    'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result;
END $$;

-- The count before sending, resolved exactly as the send will: no address, only counts, the first 50 schools and one sample.
CREATE FUNCTION hon.read_hq_blast_audience(p_subject text, p_blast uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE b hon.hq_blasts%ROWTYPE; result jsonb; first_school text; hq_name text; actor uuid; targets jsonb;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, 'OWNER');
  IF p_blast IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO b FROM hon.hq_blasts WHERE id = p_blast;
  IF b.id IS NULL THEN RAISE EXCEPTION 'HQ_BLAST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.school_name, x.school_id), '[]'::jsonb) INTO targets FROM hon.hq_blast_resolve(b.audience, b.channel) x;
  SELECT btrim(e->>'school_name') INTO first_school FROM jsonb_array_elements(targets) e WHERE e->>'outcome' = 'QUEUED' LIMIT 1;
  hq_name := left(coalesce(nullif(btrim((SELECT u.display_name FROM hon.principals p JOIN hon.users u ON u.id = p.user_id WHERE p.id = actor)), ''), 'HON OS'), 80);
  SELECT jsonb_build_object('blastId', b.id, 'channel', b.channel,
    'schoolsMatched', count(*), 'schoolsReached', count(*) FILTER (WHERE y.outcome = 'QUEUED'),
    'ownersTotal', coalesce(sum(y.owner_count), 0), 'ownersReached', coalesce(sum(y.reachable_count) FILTER (WHERE y.outcome = 'QUEUED'), 0),
    'skipped', jsonb_build_object('noOwners', count(*) FILTER (WHERE y.outcome = 'NO_OWNERS'),
      'notReachable', count(*) FILTER (WHERE y.outcome = 'NOT_REACHABLE'), 'recentlySent', count(*) FILTER (WHERE y.outcome = 'RECENTLY_SENT'),
      'ownersNotReachable', coalesce(sum(y.owner_count - y.reachable_count) FILTER (WHERE y.outcome = 'QUEUED'), 0)),
    'tooLarge', count(*) FILTER (WHERE y.outcome = 'QUEUED') > 2000,
    'schools', coalesce((SELECT jsonb_agg(jsonb_build_object('schoolId', e->'school_id', 'schoolDisplayName', e->'school_name', 'outcome', e->'outcome',
        'ownerCount', e->'owner_count', 'reachableCount', e->'reachable_count') ORDER BY n)
      FROM jsonb_array_elements(targets) WITH ORDINALITY AS q(e, n) WHERE n <= 50), '[]'::jsonb),
    'sample', CASE WHEN first_school IS NULL THEN NULL ELSE jsonb_build_object('schoolDisplayName', first_school,
      'subject', CASE WHEN b.subject IS NOT NULL THEN replace(hon.hq_blast_fill(b.subject, first_school, hq_name), '{{first_name}}', 'Alex') END,
      'body', replace(hon.hq_blast_fill(b.body, first_school, hq_name), '{{first_name}}', 'Alex')) END,
    'asOf', hon.saas_ts(clock_timestamp()))
  INTO result FROM jsonb_to_recordset(targets) AS y(owner_count integer, reachable_count integer, outcome text);
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result;
END $$;

-- Choices for the filters: the plan names in use, every plan feature, the countries/regions in use, and (with p_search,
-- 2-80 characters) up to 20 schools whose name matches, for the picker. No address or owner detail.
CREATE FUNCTION hon.read_hq_blast_options(p_subject text, p_search text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE result jsonb; pattern text;
BEGIN
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  IF p_search IS NOT NULL AND (length(p_search) NOT BETWEEN 2 AND 80 OR btrim(p_search) <> p_search OR p_search ~ '[\x00-\x1F\x7F]') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  pattern := CASE WHEN p_search IS NULL THEN NULL ELSE '%' || replace(replace(replace(lower(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' END;
  result := jsonb_build_object(
    'planNames', (SELECT coalesce(jsonb_agg(DISTINCT cur.plan_name), '[]'::jsonb) FROM hon.schools s
      CROSS JOIN LATERAL (SELECT (hon.hq_school_plan_current(s.organization_id)).*) cur
      WHERE s.status IN ('ACTIVE','SUSPENDED') AND cur.action = 'ASSIGN' AND cur.school_id = s.id),
    'features', to_jsonb(hon.saas_plan_capabilities('COMPLETE')),
    'countries', (SELECT coalesce(jsonb_agg(DISTINCT l.country_code), '[]'::jsonb) FROM hon.school_locations l
      JOIN hon.schools s ON s.id = l.school_id WHERE s.status IN ('ACTIVE','SUSPENDED')),
    'regions', (SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('country', l.country_code, 'region', l.region_code)), '[]'::jsonb)
      FROM hon.school_locations l JOIN hon.schools s ON s.id = l.school_id WHERE s.status IN ('ACTIVE','SUSPENDED') AND l.region_code IS NOT NULL),
    'schools', CASE WHEN pattern IS NULL THEN '[]'::jsonb ELSE (SELECT coalesce(jsonb_agg(jsonb_build_object('schoolId', x.id,
        'schoolDisplayName', left(x.name, 300), 'organizationDisplayName', left(x.org, 300),
        'status', CASE x.status WHEN 'SUSPENDED' THEN 'PAUSED' ELSE x.status END) ORDER BY x.name, x.id), '[]'::jsonb)
      FROM (SELECT s.id, s.name, o.display_name AS org, s.status::text AS status FROM hon.schools s JOIN hon.organizations o ON o.id = s.organization_id
        WHERE s.status IN ('ACTIVE','SUSPENDED') AND o.status IN ('ACTIVE','SUSPENDED')
          AND (lower(s.name) LIKE pattern ESCAPE '\' OR lower(o.display_name) LIKE pattern ESCAPE '\')
        ORDER BY s.name, s.id LIMIT 20) x) END,
    'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result;
END $$;

-- ---------- templates (HQ owner only) ----------
-- Saved blast texts to start from, like the Manus CRM's Templates tab. A template sends nothing and holds no audience.
CREATE TABLE hon.hq_blast_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (hon.hq_blast_line_ok(to_jsonb(name), 100)),
  channel text NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  subject text CHECK (subject IS NULL OR hon.hq_blast_line_ok(to_jsonb(subject), 150)),
  body text NOT NULL CHECK (hon.hq_blast_text_ok(to_jsonb(body), 1, CASE channel WHEN 'EMAIL' THEN 3500 ELSE 1400 END)),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_by uuid NOT NULL REFERENCES hon.principals(id),
  updated_by uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((channel = 'EMAIL') = (subject IS NOT NULL))
);
CREATE INDEX hq_blast_templates_updated_idx ON hon.hq_blast_templates (updated_at DESC, id DESC);
CREATE TABLE hon.hq_blast_template_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (actor_principal_id, idempotency_key)
);
CREATE TABLE hon.hq_blast_template_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES hon.hq_blast_templates(id),
  action text NOT NULL CHECK (action IN ('CREATED','EDITED','ARCHIVED')),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  request_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  version integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (actor_principal_id, idempotency_key)
);
-- A template changes only by version bump, is never deleted, and an archived one stays archived.
CREATE FUNCTION hon.guard_hq_blast_template() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.status <> 'ACTIVE' THEN RAISE EXCEPTION 'HQ_BLAST_IMMUTABLE' USING ERRCODE = '42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND OLD.status = 'ACTIVE'
    AND (NEW.id, NEW.created_by, NEW.created_at) = (OLD.id, OLD.created_by, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HQ_BLAST_IMMUTABLE' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER guarded BEFORE INSERT OR UPDATE OR DELETE ON hon.hq_blast_templates FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_blast_template();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_blast_template_requests','hq_blast_template_events'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_communication_evidence()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hq_blast_templates','hq_blast_template_requests','hq_blast_template_events'] LOOP
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_communication_evidence()', t);
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
  END LOOP;
END $$;

CREATE FUNCTION hon.hq_blast_template_json(t hon.hq_blast_templates) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('templateId', t.id, 'name', t.name, 'channel', t.channel, 'subject', t.subject, 'body', t.body, 'status', t.status,
    'createdBy', hon.hq_communication_person_json(t.created_by), 'updatedAt', hon.saas_ts(t.updated_at), 'version', t.version)
$$;

-- SAVE TEMPLATE: {templateId|null, expectedVersion (0 for new), name, channel, subject|null, body, archived}. archived true
-- retires an existing template (its text must be sent unchanged); a new template cannot start archived.
CREATE FUNCTION hon.save_hq_blast_template(p_subject text, p_input jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; prior hon.hq_blast_template_requests%ROWTYPE; t hon.hq_blast_templates%ROWTYPE; fp text; at timestamptz := clock_timestamp();
  result jsonb; v_id uuid; v_expected integer; v_archive boolean; v_action text;
BEGIN
  actor := hon.require_hq_communication_actor(p_subject, 'OWNER');
  PERFORM hon.hq_blast_args_ok(p_key, p_request, p_correlation);
  PERFORM hon.hq_communication_keys(p_input, ARRAY['archived','body','channel','expectedVersion','name','subject','templateId']);
  v_id := hon.hq_communication_uuid(p_input, 'templateId', true);
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$'
    OR ((p_input->>'expectedVersion')::integer = 0) <> (v_id IS NULL)
    OR jsonb_typeof(p_input->'archived') IS DISTINCT FROM 'boolean' OR (v_id IS NULL AND (p_input->>'archived')::boolean)
    OR jsonb_typeof(p_input->'channel') IS DISTINCT FROM 'string' OR p_input->>'channel' NOT IN ('EMAIL','SMS')
    OR NOT hon.hq_blast_line_ok(p_input->'name', 100)
    OR (p_input->>'channel' = 'EMAIL' AND NOT hon.hq_blast_line_ok(p_input->'subject', 150))
    OR (p_input->>'channel' = 'SMS' AND jsonb_typeof(p_input->'subject') IS DISTINCT FROM 'null')
    OR NOT hon.hq_blast_text_ok(p_input->'body', 1, CASE p_input->>'channel' WHEN 'EMAIL' THEN 3500 ELSE 1400 END) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := (p_input->>'expectedVersion')::integer; v_archive := (p_input->>'archived')::boolean;
  fp := hon.saas_fingerprint(ARRAY['hq.blast.template.save', p_input::text]);
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-blast-template:' || actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO prior FROM hon.hq_blast_template_requests WHERE actor_principal_id = actor AND idempotency_key = p_key;
  IF FOUND THEN
    IF prior.fingerprint <> fp THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
    RETURN prior.response || jsonb_build_object('replayed', true);
  END IF;
  IF v_id IS NULL THEN
    INSERT INTO hon.hq_blast_templates (name, channel, subject, body, created_by, updated_by, created_at, updated_at)
    VALUES (p_input->>'name', p_input->>'channel', p_input->>'subject', p_input->>'body', actor, actor, at, at) RETURNING * INTO t;
    v_action := 'CREATED';
  ELSE
    SELECT * INTO t FROM hon.hq_blast_templates WHERE id = v_id FOR UPDATE;
    IF t.id IS NULL OR t.status <> 'ACTIVE' THEN RAISE EXCEPTION 'HQ_BLAST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
    IF t.version <> v_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    IF v_archive AND (t.name, t.channel, t.subject, t.body) IS DISTINCT FROM
      (p_input->>'name', p_input->>'channel', p_input->>'subject', p_input->>'body') THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
    END IF;
    UPDATE hon.hq_blast_templates SET name = p_input->>'name', channel = p_input->>'channel', subject = p_input->>'subject', body = p_input->>'body',
      status = CASE WHEN v_archive THEN 'ARCHIVED' ELSE 'ACTIVE' END, updated_by = actor, updated_at = at, version = version + 1
    WHERE id = t.id RETURNING * INTO t;
    v_action := CASE WHEN v_archive THEN 'ARCHIVED' ELSE 'EDITED' END;
  END IF;
  result := jsonb_build_object('operation', 'TEMPLATE_SAVE', 'template', hon.hq_blast_template_json(t));
  INSERT INTO hon.hq_blast_template_requests VALUES (actor, p_key, fp, result, at);
  INSERT INTO hon.hq_blast_template_events (template_id, action, actor_principal_id, idempotency_key, request_id, correlation_id, version, occurred_at)
  VALUES (t.id, v_action, actor, p_key, p_request, p_correlation, t.version, at);
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- The active templates, newest first, at most 200.
CREATE FUNCTION hon.read_hq_blast_templates(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE result jsonb;
BEGIN
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  SELECT jsonb_build_object('templates', coalesce(jsonb_agg(hon.hq_blast_template_json(x.t) ORDER BY (x.t).updated_at DESC, (x.t).id DESC), '[]'::jsonb),
    'asOf', hon.saas_ts(clock_timestamp()))
  INTO result FROM (SELECT y AS t FROM hon.hq_blast_templates y WHERE y.status = 'ACTIVE' ORDER BY y.updated_at DESC, y.id DESC LIMIT 200) x;
  PERFORM hon.require_hq_communication_actor(p_subject, 'OWNER');
  RETURN result;
END $$;

-- ---------- the claim also returns the subject and the blast, and fills {{first_name}} ----------
-- Same claim as 0282. For a blast message only, {{first_name}} in the body and subject becomes the owner's first name
-- (first word of their display name, at most 40 characters; "there" when empty), in memory for this send. Nothing stored.
DROP FUNCTION hon.claim_hq_message_deliveries(text[], integer, integer);
CREATE FUNCTION hon.claim_hq_message_deliveries(p_channels text[], p_limit integer, p_lease_seconds integer DEFAULT 60)
RETURNS TABLE (delivery_id uuid, lease_token uuid, organization_id uuid, school_id uuid, message_id uuid, channel text,
  recipient_address text, content text, sender_ref text, sender_name text, attempt integer, purpose text, subject text, blast_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE v_delivery hon.hq_message_deliveries; v_message hon.hq_messages; v_sender hon.hq_communication_senders; v_prior text;
  v_user uuid; v_address text; v_zone text; v_local timestamp; v_wake timestamptz; v_token uuid; v_fail text; v_first text;
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'HQ message claim limit must be between 1 and 100.' USING ERRCODE = '22023'; END IF;
  IF p_lease_seconds < 15 OR p_lease_seconds > 300 THEN RAISE EXCEPTION 'HQ message lease must be between 15 and 300 seconds.' USING ERRCODE = '22023'; END IF;
  IF p_channels IS NULL OR cardinality(p_channels) < 1 OR NOT (p_channels <@ ARRAY['EMAIL','SMS']) THEN
    RAISE EXCEPTION 'HQ message claim channels must be EMAIL and/or SMS.' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.reconcile_expired_hq_message_leases(p_limit);
  FOR v_delivery IN SELECT d.* FROM hon.hq_message_deliveries d
    WHERE d.status = 'PENDING' AND d.channel = ANY (p_channels) AND d.next_attempt_at <= now()
    ORDER BY d.next_attempt_at, d.id FOR UPDATE OF d SKIP LOCKED LIMIT p_limit LOOP
    v_prior := v_delivery.status::text;
    SELECT * INTO v_message FROM hon.hq_messages WHERE id = v_delivery.message_id;
    SELECT p.user_id INTO v_user FROM hon.principals p WHERE p.id = v_delivery.recipient_principal_id;
    v_fail := NULL;
    IF v_message.status <> 'QUEUED' THEN v_fail := 'CANCELLED';
    ELSIF v_delivery.attempt_count >= 5 THEN v_fail := 'RETRIES_EXHAUSTED';
    ELSIF NOT EXISTS (SELECT 1 FROM hon.hq_message_owner_recipients(v_delivery.school_id) r WHERE r.principal_id = v_delivery.recipient_principal_id) THEN
      v_fail := 'RECIPIENT_REMOVED';
    -- An email opt-out does not stop BILLING or ACCOUNT notices (owner decision 2026-11-12): they are required notices about the
    -- school's own HON account. Support, onboarding and announcement email (blasts never use BILLING/ACCOUNT), and every
    -- text, honor the opt-out.
    ELSIF EXISTS (SELECT 1 FROM hon.hq_contact_preferences c WHERE c.user_id = v_user AND c.channel = v_delivery.channel AND c.status = 'OPTED_OUT')
        AND NOT (v_delivery.channel = 'EMAIL' AND v_message.purpose IN ('BILLING','ACCOUNT') AND v_message.blast_id IS NULL)
      -- Texts also need the person's own HQ texting opt-in (recorded by 0282 after they confirm their phone).
      OR (v_delivery.channel = 'SMS' AND NOT EXISTS (SELECT 1 FROM hon.hq_contact_preferences c WHERE c.user_id = v_user
        AND c.channel = 'SMS' AND c.status = 'OPTED_IN')) THEN
      v_fail := 'CONSENT_MISSING';
    ELSE
      v_address := CASE v_delivery.channel WHEN 'EMAIL' THEN (SELECT u.email::text FROM hon.users u WHERE u.id = v_user)
        ELSE hon.hq_contact_sms_address(v_user) END;
      IF v_address IS NULL OR btrim(v_address) = '' THEN v_fail := 'ADDRESS_MISSING'; END IF;
    END IF;
    IF v_fail IS NOT NULL THEN
      UPDATE hon.hq_message_deliveries SET status = CASE WHEN v_fail = 'RETRIES_EXHAUSTED' THEN 'FAILED' ELSE 'SUPPRESSED' END::hon.communication_delivery_status,
        hold_reason = NULL, failure_code = v_fail, final_at = now(), version = version + 1, updated_at = now()
      WHERE id = v_delivery.id RETURNING * INTO v_delivery;
      PERFORM hon.hq_message_delivery_evidence(v_delivery, v_prior, 'hq.communication.delivery.' || lower(v_delivery.status::text));
      CONTINUE;
    END IF;

    v_sender := NULL;
    SELECT * INTO v_sender FROM hon.hq_communication_senders s WHERE s.channel = v_delivery.channel AND s.status = 'ACTIVE';
    IF v_sender.id IS NULL THEN
      IF v_delivery.hold_reason IS DISTINCT FROM 'NO_SENDER' THEN
        UPDATE hon.hq_message_deliveries SET hold_reason = 'NO_SENDER', next_attempt_at = now() + interval '1 hour', version = version + 1,
          updated_at = now() WHERE id = v_delivery.id RETURNING * INTO v_delivery;
        PERFORM hon.hq_message_delivery_evidence(v_delivery, v_prior, 'hq.communication.delivery.held');
      ELSE
        UPDATE hon.hq_message_deliveries SET next_attempt_at = now() + interval '1 hour' WHERE id = v_delivery.id;
      END IF;
      CONTINUE;
    END IF;

    IF v_delivery.channel = 'SMS' THEN
      SELECT s.timezone INTO v_zone FROM hon.schools s WHERE s.id = v_delivery.school_id;
      v_local := now() AT TIME ZONE v_zone;
      IF v_local::time >= time '21:00' OR v_local::time < time '08:00' THEN
        v_wake := (date_trunc('day', v_local) + CASE WHEN v_local::time >= time '21:00' THEN interval '1 day' ELSE interval '0' END
          + interval '8 hours') AT TIME ZONE v_zone;
        IF v_delivery.hold_reason IS DISTINCT FROM 'QUIET_HOURS' THEN
          UPDATE hon.hq_message_deliveries SET hold_reason = 'QUIET_HOURS', next_attempt_at = v_wake, version = version + 1, updated_at = now()
          WHERE id = v_delivery.id RETURNING * INTO v_delivery;
          PERFORM hon.hq_message_delivery_evidence(v_delivery, v_prior, 'hq.communication.delivery.held');
        ELSE
          UPDATE hon.hq_message_deliveries SET next_attempt_at = v_wake WHERE id = v_delivery.id;
        END IF;
        CONTINUE;
      END IF;
    END IF;

    v_token := gen_random_uuid();
    UPDATE hon.hq_message_deliveries SET status = 'SENDING', hold_reason = NULL, attempt_count = attempt_count + 1, lease_token = v_token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds), sender_id = v_sender.id, version = version + 1, updated_at = now()
    WHERE id = v_delivery.id RETURNING * INTO v_delivery;
    PERFORM hon.hq_message_delivery_evidence(v_delivery, v_prior, 'hq.communication.delivery.leased');
    v_first := left(coalesce(nullif(split_part(btrim((SELECT u.display_name FROM hon.users u WHERE u.id = v_user)), ' ', 1), ''), 'there'), 40);
    delivery_id := v_delivery.id; lease_token := v_token; organization_id := v_delivery.organization_id; school_id := v_delivery.school_id;
    message_id := v_delivery.message_id; channel := v_delivery.channel; recipient_address := v_address;
    content := CASE WHEN v_message.blast_id IS NULL THEN v_message.content ELSE replace(v_message.content, '{{first_name}}', v_first) END;
    sender_ref := CASE v_delivery.channel WHEN 'EMAIL' THEN v_sender.email_from ELSE v_sender.sms_service_sid END;
    sender_name := coalesce(v_sender.email_display_name, 'HON OS'); attempt := v_delivery.attempt_count;
    purpose := v_message.purpose::text;
    subject := CASE WHEN v_message.subject IS NULL THEN NULL ELSE replace(v_message.subject, '{{first_name}}', v_first) END;
    blast_id := v_message.blast_id;
    RETURN NEXT;
  END LOOP;
END $$;

-- ---------- privileges ----------
DO $$ DECLARE r text; t text; f text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker','hon_outbox_worker') LOOP
    FOREACH t IN ARRAY ARRAY['hq_blasts','hq_blast_schools','hq_blast_requests','hq_blast_events','hq_blast_outbox',
        'hq_blast_templates','hq_blast_template_requests','hq_blast_template_events'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hq_communication_purposes(uuid)','hq_communication_is_owner(uuid)',
    'hq_blast_text_ok(jsonb,integer,integer)','hq_blast_line_ok(jsonb,integer)','hq_blast_strings_ok(jsonb,integer,text)',
    'hq_blast_day_ok(jsonb)','hq_blast_audience_ok(jsonb)','guard_hq_blast()','hq_blast_resolve(jsonb,text)','hq_blast_fill(text,text,text)',
    'hq_blast_json(hon.hq_blasts)','hq_blast_results_json(uuid)','hq_message_json(hon.hq_messages)',
    'hq_blast_claim(uuid,uuid,text,text)','hq_blast_record(uuid,uuid,uuid,uuid,text,text,text,hon.hq_blasts,jsonb,timestamptz)',
    'hq_blast_args_ok(uuid,uuid,uuid)',
    'save_hq_blast(text,jsonb,uuid,uuid,uuid)','send_hq_blast(text,jsonb,uuid,uuid,uuid)','cancel_hq_blast(text,jsonb,uuid,uuid,uuid)',
    'read_hq_blasts(text)','read_hq_blast(text,uuid)','read_hq_blast_audience(text,uuid)','read_hq_blast_options(text,text)',
    'guard_hq_blast_template()','hq_blast_template_json(hon.hq_blast_templates)','save_hq_blast_template(text,jsonb,uuid,uuid,uuid)',
    'read_hq_blast_templates(text)',
    'claim_hq_message_deliveries(text[],integer,integer)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker','hon_outbox_worker') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.save_hq_blast(text,jsonb,uuid,uuid,uuid), hon.send_hq_blast(text,jsonb,uuid,uuid,uuid),
      hon.cancel_hq_blast(text,jsonb,uuid,uuid,uuid), hon.read_hq_blasts(text), hon.read_hq_blast(text,uuid),
      hon.read_hq_blast_audience(text,uuid), hon.read_hq_blast_options(text,text), hon.save_hq_blast_template(text,jsonb,uuid,uuid,uuid),
      hon.read_hq_blast_templates(text) TO hon_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.claim_hq_message_deliveries(text[],integer,integer) TO hon_communication_worker;
  END IF;
END $$;

COMMIT;
