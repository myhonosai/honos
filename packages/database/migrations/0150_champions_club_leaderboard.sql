BEGIN;

-- HON Champions Club Milestone 3: referral leaderboards, school statistics and privacy.
-- Read-mostly. Official standings count only QUALIFIED attributions (never PENDING, REJECTED,
-- REFUNDED or REVERSED), only for ACTIVE schools of ACTIVE organizations, and never a school
-- under an HQ leaderboard hold. Schools are anonymous unless they opt in to show their name.
-- Nothing here changes an attribution, a reward or any billing record.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Champions Club leaderboard requires a trusted migration owner';
  END IF;
END $$;

-- Display privacy, chosen by the school itself. No row means ANONYMOUS.
CREATE TABLE hon.champions_leaderboard_preferences (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  display_mode text NOT NULL CHECK (display_mode IN ('ANONYMOUS','SCHOOL_NAME')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

-- Anti-fraud: HQ may hold a school out of the official standings while it is reviewed.
-- A hold never changes attributions or rewards; those keep their own decision paths.
CREATE TABLE hon.champions_leaderboard_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED')),
  reason_code text NOT NULL CHECK (reason_code IN ('FRAUD_REVIEW','DUPLICATE_REVIEW','DISPUTE','OWNER_REVIEW')),
  placed_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  placed_at timestamptz NOT NULL,
  released_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  released_at timestamptz,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  CHECK ((status = 'RELEASED') = (released_at IS NOT NULL) AND (released_at IS NULL) = (released_by_principal_id IS NULL))
);
CREATE UNIQUE INDEX champions_one_active_leaderboard_hold ON hon.champions_leaderboard_holds(school_id) WHERE status = 'ACTIVE';

ALTER TABLE hon.champions_audit DROP CONSTRAINT champions_audit_action_code_check;
ALTER TABLE hon.champions_audit ADD CONSTRAINT champions_audit_action_code_check CHECK (action_code IN ('champions.code.issue',
  'champions.policy.draft','champions.policy.publish','champions.attribution.capture','champions.attribution.decide',
  'champions.reward_policy.draft','champions.reward_policy.publish','champions.rewards.reconcile','champions.reward.decide',
  'champions.leaderboard.preference','champions.leaderboard.hold'));
ALTER TABLE hon.champions_audit DROP CONSTRAINT champions_audit_entity_type_check;
ALTER TABLE hon.champions_audit ADD CONSTRAINT champions_audit_entity_type_check CHECK (entity_type IN ('REFERRAL_CODE','POLICY',
  'ATTRIBUTION','REWARD_POLICY','REWARD_SCHOOL','REWARD_ENTRY','LEADERBOARD_PREFERENCE','LEADERBOARD_HOLD'));
ALTER TABLE hon.champions_outbox DROP CONSTRAINT champions_outbox_event_type_check;
ALTER TABLE hon.champions_outbox ADD CONSTRAINT champions_outbox_event_type_check CHECK (event_type IN ('champions.referral_code.issued',
  'champions.policy.drafted','champions.policy.published','champions.attribution.captured','champions.attribution.decided',
  'champions.reward_policy.drafted','champions.reward_policy.published','champions.rewards.reconciled','champions.reward.decided',
  'champions.leaderboard.preference_set','champions.leaderboard.hold_changed'));

CREATE FUNCTION hon.guard_champions_leaderboard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  -- Branch on the table first: PL/pgSQL does not short-circuit, and the two tables differ.
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'champions_leaderboard_preferences' THEN
      IF NEW.school_id = OLD.school_id AND NEW.organization_id = OLD.organization_id AND NEW.version = OLD.version + 1 THEN
        RETURN NEW;
      END IF;
    ELSIF OLD.status = 'ACTIVE' AND NEW.status = 'RELEASED'
      AND (to_jsonb(NEW) - ARRAY['status','released_by_principal_id','released_at']) = (to_jsonb(OLD) - ARRAY['status','released_by_principal_id','released_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['champions_leaderboard_preferences','champions_leaderboard_holds'] LOOP
    EXECUTE format('CREATE TRIGGER champions_guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_champions_leaderboard()',t);
    EXECUTE format('CREATE TRIGGER champions_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_champions_leaderboard()',t);
  END LOOP;
END $$;

-- ---------- private helpers ----------
-- 'YYYY-MM' -> first day of that UTC month; NULL for all-time. Months before the program
-- or in the future are refused rather than shown as empty.
CREATE FUNCTION hon.champions_period_month(p_period text, p_month text) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE m date;
BEGIN
  IF p_period = 'ALL_TIME' AND p_month IS NULL THEN RETURN NULL; END IF;
  IF p_period <> 'MONTH' OR p_month IS NULL OR p_month !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  m := (p_month || '-01')::date;
  IF m < date '2026-01-01' OR m > date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN m;
END $$;

-- Official standings from verified records only. Ties share a rank; within a tie the school
-- that reached its count first is listed first, then by school id for a stable order.
CREATE FUNCTION hon.champions_standings(p_month date)
RETURNS TABLE (school_id uuid, organization_id uuid, qualified integer, reached_at timestamptz, standing_rank integer, standing_position integer)
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH counts AS (
    SELECT a.referrer_school_id school_id, a.referrer_organization_id organization_id, count(*)::integer qualified, max(a.qualified_at) reached_at
    FROM hon.champions_attributions a
    JOIN hon.schools s ON s.id = a.referrer_school_id AND s.organization_id = a.referrer_organization_id AND s.status = 'ACTIVE'
    JOIN hon.organizations o ON o.id = a.referrer_organization_id AND o.status = 'ACTIVE'
    WHERE a.state = 'QUALIFIED'
      AND (p_month IS NULL OR ((a.qualified_at AT TIME ZONE 'UTC') >= p_month AND (a.qualified_at AT TIME ZONE 'UTC') < (p_month + interval '1 month')))
      AND NOT EXISTS (SELECT 1 FROM hon.champions_leaderboard_holds h WHERE h.school_id = a.referrer_school_id AND h.status = 'ACTIVE')
    GROUP BY a.referrer_school_id, a.referrer_organization_id)
  SELECT c.school_id, c.organization_id, c.qualified, c.reached_at,
    (rank() OVER (ORDER BY c.qualified DESC))::integer,
    (row_number() OVER (ORDER BY c.qualified DESC, c.reached_at, c.school_id))::integer
  FROM counts c
$$;

-- Milestone progress against the published reward ladder (M2). Counts the school's current
-- QUALIFIED referrals; a held school still sees its own progress.
CREATE FUNCTION hon.champions_milestone_progress(p_qualified integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE policy hon.champions_reward_policies%ROWTYPE; reached jsonb; next_one jsonb;
BEGIN
  SELECT * INTO policy FROM hon.champions_reward_policies WHERE status = 'PUBLISHED';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('program', jsonb_build_object('status','POLICY_UNDECIDED','policyVersion',NULL), 'reached', '[]'::jsonb, 'nextMilestone', NULL);
  END IF;
  WITH ladder AS (
    SELECT 'REFERRER_CREDIT'::text kind, r threshold FROM generate_series(1, policy.referrer_credit_max_rank) r
    UNION ALL SELECT 'FREE_MONTHS', policy.first_free_months_count UNION ALL SELECT 'FREE_MONTHS', policy.second_free_months_count
    UNION ALL SELECT 'PRIZE', policy.prize_count UNION ALL SELECT 'LIFETIME_MEMBERSHIP', policy.lifetime_count)
  SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('rewardKind', kind, 'milestoneCount', threshold) ORDER BY threshold) FROM ladder WHERE threshold <= p_qualified), '[]'::jsonb),
    (SELECT jsonb_build_object('rewardKind', kind, 'milestoneCount', threshold, 'remaining', threshold - p_qualified) FROM ladder WHERE threshold > p_qualified ORDER BY threshold LIMIT 1)
    INTO reached, next_one;
  RETURN jsonb_build_object('program', jsonb_build_object('status','PUBLISHED','policyVersion',policy.policy_version), 'reached', reached, 'nextMilestone', next_one);
END $$;

-- Per-school statistics. p_hq adds referred-organization identity to history; a school only
-- ever sees dates, states and reasons for its own referrals.
CREATE FUNCTION hon.champions_school_statistics_json(p_school uuid, p_hq boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE counts jsonb; series jsonb; history jsonb; qualified integer; all_time_rank integer; current_month date;
BEGIN
  current_month := date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date;
  SELECT jsonb_build_object('pending', count(*) FILTER (WHERE state = 'PENDING'), 'qualified', count(*) FILTER (WHERE state = 'QUALIFIED'),
      'rejected', count(*) FILTER (WHERE state = 'REJECTED'), 'refunded', count(*) FILTER (WHERE state = 'REFUNDED'),
      'reversed', count(*) FILTER (WHERE state = 'REVERSED')), count(*) FILTER (WHERE state = 'QUALIFIED')::integer
    INTO counts, qualified FROM hon.champions_attributions WHERE referrer_school_id = p_school;
  -- Last 12 UTC months including the current one, zero-filled, by month of qualification.
  SELECT jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'qualified',
      (SELECT count(*) FROM hon.champions_attributions a WHERE a.referrer_school_id = p_school AND a.state = 'QUALIFIED'
        AND (a.qualified_at AT TIME ZONE 'UTC') >= m AND (a.qualified_at AT TIME ZONE 'UTC') < m + interval '1 month')) ORDER BY m)
    INTO series FROM generate_series(current_month - interval '11 months', current_month, interval '1 month') m;
  SELECT coalesce(jsonb_agg(CASE WHEN p_hq THEN jsonb_build_object('occurredAt', hon.champions_ts(h.occurred_at), 'fromState', h.from_state,
        'toState', h.to_state, 'reason', h.state_reason, 'attributionId', a.id, 'referredOrganizationId', a.referred_organization_id,
        'referredOrganizationName', o.display_name)
      ELSE jsonb_build_object('occurredAt', hon.champions_ts(h.occurred_at), 'fromState', h.from_state, 'toState', h.to_state, 'reason', h.state_reason) END
      ORDER BY h.occurred_at DESC, h.version DESC), '[]'::jsonb) INTO history
    FROM (SELECT h.* FROM hon.champions_attribution_history h JOIN hon.champions_attributions a2 ON a2.id = h.attribution_id
      WHERE a2.referrer_school_id = p_school ORDER BY h.occurred_at DESC, h.version DESC LIMIT 50) h
    JOIN hon.champions_attributions a ON a.id = h.attribution_id JOIN hon.organizations o ON o.id = a.referred_organization_id;
  SELECT s.standing_rank INTO all_time_rank FROM hon.champions_standings(NULL) s WHERE s.school_id = p_school;
  RETURN jsonb_build_object('schoolId', p_school, 'referrals', counts, 'monthlyQualified', series,
    'milestones', hon.champions_milestone_progress(qualified) || jsonb_build_object('qualifiedReferrals', qualified),
    'allTimeRank', all_time_rank, 'history', history, 'historyLimit', 50);
END $$;

-- ---------- HQ reads and the hold command ----------
CREATE FUNCTION hon.read_champions_leaderboard_from_hq(p_subject text, p_period text, p_month text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE m date; standings jsonb; held jsonb; total integer;
BEGIN
  m := hon.champions_period_month(p_period, p_month);
  PERFORM hon.require_champions_hq_actor(p_subject, false);
  SELECT count(*) INTO total FROM hon.champions_standings(m);
  SELECT coalesce(jsonb_agg(jsonb_build_object('rank', s.standing_rank, 'position', s.standing_position, 'schoolId', s.school_id,
      'schoolName', sc.name, 'organizationId', s.organization_id, 'organizationName', o.display_name, 'qualifiedReferrals', s.qualified,
      'pendingReferrals', (SELECT count(*) FROM hon.champions_attributions a WHERE a.referrer_school_id = s.school_id AND a.state = 'PENDING'),
      'reachedAt', hon.champions_ts(s.reached_at),
      'displayMode', coalesce((SELECT p.display_mode FROM hon.champions_leaderboard_preferences p WHERE p.school_id = s.school_id), 'ANONYMOUS'))
      ORDER BY s.standing_position), '[]'::jsonb) INTO standings
    FROM (SELECT * FROM hon.champions_standings(m) ORDER BY standing_position LIMIT 100) s
    JOIN hon.schools sc ON sc.id = s.school_id JOIN hon.organizations o ON o.id = s.organization_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('schoolId', h.school_id, 'schoolName', sc.name, 'reasonCode', h.reason_code,
      'placedAt', hon.champions_ts(h.placed_at),
      'qualifiedReferrals', (SELECT count(*) FROM hon.champions_attributions a WHERE a.referrer_school_id = h.school_id AND a.state = 'QUALIFIED'))
      ORDER BY h.placed_at, h.school_id), '[]'::jsonb) INTO held
    FROM hon.champions_leaderboard_holds h JOIN hon.schools sc ON sc.id = h.school_id WHERE h.status = 'ACTIVE';
  RETURN jsonb_build_object('period', p_period, 'month', CASE WHEN m IS NULL THEN NULL ELSE to_char(m, 'YYYY-MM') END,
    'standings', standings, 'totalRanked', total, 'limit', 100, 'held', held, 'countsOnly', 'QUALIFIED', 'timeZone', 'UTC');
END $$;

CREATE FUNCTION hon.read_champions_school_statistics_from_hq(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE school_row hon.schools%ROWTYPE; hold hon.champions_leaderboard_holds%ROWTYPE;
BEGIN
  IF p_school IS NULL THEN RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_champions_hq_actor(p_subject, false);
  SELECT * INTO school_row FROM hon.schools WHERE id = p_school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO hold FROM hon.champions_leaderboard_holds WHERE school_id = p_school AND status = 'ACTIVE';
  RETURN hon.champions_school_statistics_json(p_school, true) || jsonb_build_object('schoolName', school_row.name,
    'organizationId', school_row.organization_id,
    'displayMode', coalesce((SELECT p.display_mode FROM hon.champions_leaderboard_preferences p WHERE p.school_id = p_school), 'ANONYMOUS'),
    'hold', CASE WHEN hold.id IS NULL THEN NULL ELSE jsonb_build_object('reasonCode', hold.reason_code, 'placedAt', hon.champions_ts(hold.placed_at)) END);
END $$;

-- PLACE (HQ owner or operator) takes a school out of the official standings; RELEASE
-- (HQ owner only) returns it. Neither touches attributions or rewards.
CREATE FUNCTION hon.set_champions_leaderboard_hold(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; action text; v_school uuid; school_row hon.schools%ROWTYPE; hold hon.champions_leaderboard_holds%ROWTYPE;
  keys text[]; at timestamptz; result jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(p) k;
  action := p->>'action';
  IF jsonb_typeof(p->'action') <> 'string' OR jsonb_typeof(p->'schoolId') <> 'string'
    OR (p->>'schoolId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NOT ((action = 'PLACE' AND keys = ARRAY['action','reasonCode','schoolId'] AND jsonb_typeof(p->'reasonCode') = 'string'
        AND p->>'reasonCode' IN ('FRAUD_REVIEW','DUPLICATE_REVIEW','DISPUTE','OWNER_REVIEW'))
      OR (action = 'RELEASE' AND keys = ARRAY['action','schoolId'])) THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_school := (p->>'schoolId')::uuid;
  actor := hon.require_champions_hq_actor(p_subject, action = 'RELEASE');
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_champions_hq_actor(p_subject, action = 'RELEASE');
  replay := hon.champions_claim_request(actor, p_key, 'champions.leaderboard.hold',
    hon.champions_fingerprint(ARRAY['champions.leaderboard.hold', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO school_row FROM hon.schools WHERE id = v_school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('champions.leaderboard.hold:' || v_school::text, 0));
  SELECT * INTO hold FROM hon.champions_leaderboard_holds h WHERE h.school_id = v_school AND h.status = 'ACTIVE' FOR UPDATE;
  at := clock_timestamp();
  IF action = 'PLACE' THEN
    IF FOUND THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
    INSERT INTO hon.champions_leaderboard_holds(school_id,organization_id,reason_code,placed_by_principal_id,placed_at)
      VALUES (v_school, school_row.organization_id, p->>'reasonCode', actor, at) RETURNING * INTO hold;
  ELSE
    IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
    UPDATE hon.champions_leaderboard_holds SET status = 'RELEASED', released_by_principal_id = actor, released_at = at
      WHERE id = hold.id RETURNING * INTO hold;
  END IF;
  result := jsonb_build_object('schoolId', v_school, 'status', hold.status, 'reasonCode', hold.reason_code,
    'placedAt', hon.champions_ts(hold.placed_at), 'releasedAt', CASE WHEN hold.released_at IS NULL THEN NULL ELSE hon.champions_ts(hold.released_at) END);
  RETURN hon.champions_record(actor, p_key, 'champions.leaderboard.hold', 'champions.leaderboard.hold_changed', 'LEADERBOARD_HOLD', hold.id,
    school_row.organization_id, NULL, jsonb_build_object('status', hold.status, 'reasonCode', hold.reason_code), result, at);
END $$;

-- ---------- school reads and the privacy command ----------
-- Privacy-filtered standings: other schools appear only by rank and count, named only if they
-- opted in. No other school's id, organization, pending count or hold is ever returned.
CREATE FUNCTION hon.read_champions_leaderboard_for_school(p_subject text, p_school uuid, p_period text, p_month text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; m date; standings jsonb; my_rank integer; ranked boolean; my_qualified integer; mode text;
BEGIN
  m := hon.champions_period_month(p_period, p_month);
  SELECT * INTO scope FROM hon.require_champions_school_actor(p_subject, p_school) LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('rank', s.standing_rank,
      'displayName', CASE WHEN s.school_id = p_school OR pref.display_mode = 'SCHOOL_NAME' THEN sc.name END,
      'anonymous', NOT (s.school_id = p_school OR coalesce(pref.display_mode, 'ANONYMOUS') = 'SCHOOL_NAME'),
      'qualifiedReferrals', s.qualified, 'isYou', s.school_id = p_school) ORDER BY s.standing_position), '[]'::jsonb) INTO standings
    FROM (SELECT * FROM hon.champions_standings(m) ORDER BY standing_position LIMIT 25) s
    JOIN hon.schools sc ON sc.id = s.school_id
    LEFT JOIN hon.champions_leaderboard_preferences pref ON pref.school_id = s.school_id;
  SELECT s.standing_rank INTO my_rank FROM hon.champions_standings(m) s WHERE s.school_id = p_school;
  ranked := FOUND;
  SELECT count(*)::integer INTO my_qualified FROM hon.champions_attributions a WHERE a.referrer_school_id = p_school AND a.state = 'QUALIFIED'
    AND (m IS NULL OR ((a.qualified_at AT TIME ZONE 'UTC') >= m AND (a.qualified_at AT TIME ZONE 'UTC') < (m + interval '1 month')));
  mode := coalesce((SELECT p.display_mode FROM hon.champions_leaderboard_preferences p WHERE p.school_id = p_school), 'ANONYMOUS');
  -- A school outside the standings sees NOT_RANKED, never the reason (a hold stays confidential).
  RETURN jsonb_build_object('period', p_period, 'month', CASE WHEN m IS NULL THEN NULL ELSE to_char(m, 'YYYY-MM') END,
    'standings', standings, 'limit', 25,
    'you', jsonb_build_object('schoolId', p_school, 'status', CASE WHEN ranked THEN 'RANKED' ELSE 'NOT_RANKED' END,
      'rank', my_rank, 'qualifiedReferrals', my_qualified, 'displayMode', mode),
    'countsOnly', 'QUALIFIED', 'timeZone', 'UTC');
END $$;

CREATE FUNCTION hon.read_champions_school_statistics(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record;
BEGIN
  SELECT * INTO scope FROM hon.require_champions_school_actor(p_subject, p_school) LIMIT 1;
  RETURN hon.champions_school_statistics_json(p_school, false)
    || jsonb_build_object('displayMode', coalesce((SELECT p.display_mode FROM hon.champions_leaderboard_preferences p WHERE p.school_id = p_school), 'ANONYMOUS'));
END $$;

CREATE FUNCTION hon.set_champions_leaderboard_preference(p_subject text, p_school uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; replay jsonb; pref hon.champions_leaderboard_preferences%ROWTYPE; prior_mode text; at timestamptz; result jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['displayMode']
    OR jsonb_typeof(p->'displayMode') <> 'string' OR p->>'displayMode' NOT IN ('ANONYMOUS','SCHOOL_NAME') THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO scope FROM hon.require_champions_school_actor(p_subject, p_school) LIMIT 1;
  LOCK TABLE hon.users, hon.principals, hon.principal_role_grants, hon.roles, hon.role_permissions, hon.permissions,
    hon.family_access_grants, hon.hq_operator_grants, hon.organization_entitlements IN SHARE MODE;
  SELECT * INTO scope FROM hon.require_champions_school_actor(p_subject, p_school) LIMIT 1;
  replay := hon.champions_claim_request(scope.principal_id, p_key, 'champions.leaderboard.preference',
    hon.champions_fingerprint(ARRAY['champions.leaderboard.preference', p_school::text, p->>'displayMode']), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  SELECT * INTO pref FROM hon.champions_leaderboard_preferences WHERE school_id = p_school FOR UPDATE;
  prior_mode := coalesce(pref.display_mode, 'ANONYMOUS');
  IF pref.school_id IS NULL THEN
    INSERT INTO hon.champions_leaderboard_preferences(school_id,organization_id,display_mode,updated_by_principal_id,updated_at)
      VALUES (p_school, scope.organization_id, p->>'displayMode', scope.principal_id, at) RETURNING * INTO pref;
  ELSE
    UPDATE hon.champions_leaderboard_preferences SET display_mode = p->>'displayMode', version = version + 1,
        updated_by_principal_id = scope.principal_id, updated_at = at
      WHERE school_id = p_school RETURNING * INTO pref;
  END IF;
  result := jsonb_build_object('schoolId', p_school, 'displayMode', pref.display_mode, 'version', pref.version, 'updatedAt', hon.champions_ts(pref.updated_at));
  RETURN hon.champions_record(scope.principal_id, p_key, 'champions.leaderboard.preference', 'champions.leaderboard.preference_set',
    'LEADERBOARD_PREFERENCE', p_school, scope.organization_id, jsonb_build_object('displayMode', prior_mode),
    jsonb_build_object('displayMode', pref.display_mode, 'version', pref.version), result, at);
END $$;

-- ---------- RLS and ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['champions_leaderboard_preferences','champions_leaderboard_holds'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE',col,t);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_champions_leaderboard()','hon.champions_period_month(text,text)','hon.champions_standings(date)',
      'hon.champions_milestone_progress(integer)','hon.champions_school_statistics_json(uuid,boolean)',
      'hon.read_champions_leaderboard_from_hq(text,text,text)','hon.read_champions_school_statistics_from_hq(text,uuid)',
      'hon.set_champions_leaderboard_hold(text,jsonb,uuid,uuid,uuid)','hon.read_champions_leaderboard_for_school(text,uuid,text,text)',
      'hon.read_champions_school_statistics(text,uuid)','hon.set_champions_leaderboard_preference(text,uuid,jsonb,uuid,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_champions_leaderboard_from_hq(text,text,text), hon.read_champions_school_statistics_from_hq(text,uuid),
      hon.set_champions_leaderboard_hold(text,jsonb,uuid,uuid,uuid), hon.read_champions_leaderboard_for_school(text,uuid,text,text),
      hon.read_champions_school_statistics(text,uuid), hon.set_champions_leaderboard_preference(text,uuid,jsonb,uuid,uuid,uuid)
      TO hon_runtime;
  END IF;
END $$;

COMMIT;
