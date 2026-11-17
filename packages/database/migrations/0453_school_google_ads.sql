BEGIN;

-- A5 (0453, docs/architecture/SCHOOL_ADS_MARKETING.md §8): a school connects its own Google Ads account through the
-- same Zernio profile it uses for Facebook and runs simple Google Search ads inside the same monthly ad spend cap.
-- Extends 0347 (connections) and 0445 (ads) instead of adding a second ad system, so the cap, the 60-second lease,
-- UNKNOWN handling and the direct-human command rules are the reviewed ones. Nothing is created or spent unless the API
-- server has HON_ZERNIO_ADS_APPROVED=true and a Zernio key; tests use the deterministic fake.
-- - Google charges the school's own Google Ads account. HON never pays or holds ad spend.
-- - A Google Ads account only runs ads: its publish and inbox switches stay off and it is never a post target.
-- - A Google ad is drafted with the school's own text (headlines, descriptions, landing page, keywords), a total
--   budget of at least 1.00 a day and a 1 to 31 day range. Its whole budget counts against every month its range
--   touches, together with the school's Meta ads (0445 rule). Approving creates it PAUSED at Google; turning it on is
--   a separate human command and the only spending step. The API sends Google a daily budget of total / days.
-- - Owner decision (2026-11-17): every ad, Google and Meta, targets people within 5 miles of the school's street
--   address (hon.school_locations, 0392). Approving an ad is refused until the school has saved a street address.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.school_social_ads') IS NULL OR to_regprocedure('hon.start_school_social_ad_operation(text,uuid,jsonb,text,uuid,uuid)') IS NULL
    THEN RAISE EXCEPTION '0453 requires the 0445 school social ads records'; END IF;
  IF to_regclass('hon.school_locations') IS NULL THEN RAISE EXCEPTION '0453 requires the 0392 school locations'; END IF;
END $$;

-- Connections: GOOGLE_ADS joins the platforms. A Google Ads account never publishes or reads an inbox.
ALTER TABLE hon.school_social_accounts DROP CONSTRAINT school_social_accounts_platform_check;
ALTER TABLE hon.school_social_accounts ADD CONSTRAINT school_social_accounts_platform_check CHECK (platform IN ('FACEBOOK','INSTAGRAM','GOOGLE_ADS'));
ALTER TABLE hon.school_social_accounts ADD CONSTRAINT school_social_accounts_google_ads_only CHECK (platform<>'GOOGLE_ADS' OR NOT (publish_enabled OR inbox_enabled));
ALTER TABLE hon.school_social_connect_intents DROP CONSTRAINT school_social_connect_intents_platform_check;
ALTER TABLE hon.school_social_connect_intents ADD CONSTRAINT school_social_connect_intents_platform_check CHECK (platform IN ('FACEBOOK','INSTAGRAM','GOOGLE_ADS'));

ALTER TABLE hon.school_social_commands DROP CONSTRAINT school_social_commands_operation_check;
ALTER TABLE hon.school_social_commands ADD CONSTRAINT school_social_commands_operation_check
  CHECK (operation IN ('CHANGE','POST_CREATE','POST_EDIT','POST_APPROVE','POST_CANCEL','POST_RESOLVE',
    'INBOX_REPLY','INBOX_CHANGE','INBOX_RESOLVE','INBOX_COMMENT','AD_BUDGET','AD_CREATE','AD_CANCEL','AD_START','AD_RESOLVE','AD_GOOGLE_CREATE'));

-- Ads: every existing row is a Meta boost. A Google Search ad has no post target and carries the school's own text.
ALTER TABLE hon.school_social_ads ADD COLUMN channel text NOT NULL DEFAULT 'META_BOOST' CHECK (channel IN ('META_BOOST','GOOGLE_SEARCH'));
ALTER TABLE hon.school_social_ads ADD COLUMN google_content jsonb CHECK (google_content IS NULL OR jsonb_typeof(google_content)='object');
ALTER TABLE hon.school_social_ads ALTER COLUMN target_id DROP NOT NULL;
ALTER TABLE hon.school_social_ads ADD CONSTRAINT school_social_ads_channel_shape
  CHECK ((channel='META_BOOST')=(target_id IS NOT NULL) AND (channel='GOOGLE_SEARCH')=(google_content IS NOT NULL));

-- 0453: the channel and the Google text join the fields an ad keeps forever (otherwise unchanged).
CREATE OR REPLACE FUNCTION hon.guard_school_social_ads() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='school_social_ad_budgets' THEN
    IF (NEW.organization_id,NEW.school_id) IS NOT DISTINCT FROM (OLD.organization_id,OLD.school_id) AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='school_social_ads' THEN
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.account_id,NEW.target_id,NEW.budget_cents,NEW.currency,NEW.starts_on,NEW.ends_on,NEW.created_by_principal_id,NEW.created_at,NEW.channel,NEW.google_content)
      IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.account_id,OLD.target_id,OLD.budget_cents,OLD.currency,OLD.starts_on,OLD.ends_on,OLD.created_by_principal_id,OLD.created_at,OLD.channel,OLD.google_content)
      AND NEW.version=OLD.version+1 AND (OLD.provider_ad_id IS NULL OR NEW.provider_ad_id IS NOT DISTINCT FROM OLD.provider_ad_id)
      AND (OLD.approved_by_principal_id IS NULL OR NEW.approved_by_principal_id IS NOT DISTINCT FROM OLD.approved_by_principal_id)
      AND (OLD.status,NEW.status) IN (('DRAFT','CREATING'),('DRAFT','CANCELLED'),
        ('CREATING','PAUSED'),('CREATING','FAILED'),('CREATING','UNKNOWN'),
        ('PAUSED','ACTIVATING'),('ACTIVATING','ACTIVE'),('ACTIVATING','PAUSED'),('ACTIVATING','UNKNOWN'),
        ('ACTIVE','PAUSING'),('UNKNOWN','PAUSING'),('PAUSING','PAUSED'),('PAUSING','ACTIVE'),('PAUSING','UNKNOWN'),
        -- a late answer under its own lease, or a person's resolution
        ('UNKNOWN','PAUSED'),('UNKNOWN','ACTIVE'),('UNKNOWN','FAILED')) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'SOCIAL_RECORD_IMMUTABLE' USING ERRCODE='42501';
END $$;

-- 0453: GOOGLE_ADS can be connected (otherwise unchanged).
CREATE OR REPLACE FUNCTION hon.start_school_social_connect(p_subject text,p_input jsonb,p_state_hash text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; i hon.school_social_connect_intents%ROWTYPE;
  at timestamptz:=clock_timestamp();
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['platform']
    OR jsonb_typeof(p_input->'platform') IS DISTINCT FROM 'string' OR (p_input->>'platform') NOT IN ('FACEBOOK','INSTAGRAM','GOOGLE_ADS')
    OR p_state_hash IS NULL OR p_state_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.manage');
  PERFORM pg_advisory_xact_lock(hashtextextended('school-social:'||school::text,0));
  IF (SELECT count(*) FROM hon.school_social_connect_intents WHERE organization_id=org AND school_id=school AND created_at>at-interval '1 hour')>=10 THEN
    RAISE EXCEPTION 'SOCIAL_RATE_LIMITED' USING ERRCODE='54000'; END IF;
  INSERT INTO hon.school_social_connect_intents(organization_id,school_id,platform,started_by_principal_id,state_hash,created_at,expires_at)
    VALUES(org,school,p_input->>'platform',actor,p_state_hash,at,at+interval '10 minutes') RETURNING * INTO i;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.connect.started','SCHOOL_SOCIAL_CONNECT',i.id,1,
    jsonb_build_object('platform',i.platform),p_request,p_correlation);
  IF hon.require_school_social_actor(p_subject,'marketing.social.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('intentId',i.id,'platform',i.platform,'expiresAt',hon.saas_ts(i.expires_at),
    'providerProfileId',(SELECT provider_profile_id FROM hon.school_social_profiles WHERE organization_id=org AND school_id=school));
END $$;

-- 0453: a Google Ads account's publish and inbox switches stay off (otherwise unchanged).
CREATE OR REPLACE FUNCTION hon.change_school_social_account(p_subject text,p_account uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior hon.school_social_commands%ROWTYPE;
  fp text; a hon.school_social_accounts%ROWTYPE; keys text[]; result jsonb; disconnecting boolean;
BEGIN
  keys:=(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p_input)='object' THEN p_input ELSE '{}'::jsonb END) k);
  disconnecting:=keys IS NOT DISTINCT FROM ARRAY['disconnect','expectedVersion'];
  IF p_account IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR NOT (disconnecting OR keys IS NOT DISTINCT FROM ARRAY['adsEnabled','expectedVersion','inboxEnabled','publishEnabled'])
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR (disconnecting AND (p_input->'disconnect') IS DISTINCT FROM 'true'::jsonb)
    OR (NOT disconnecting AND (jsonb_typeof(p_input->'publishEnabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'inboxEnabled') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(p_input->'adsEnabled') IS DISTINCT FROM 'boolean'))
    OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.manage');
  fp:=encode(sha256(convert_to('marketing.social.account.change:'||p_account::text||':'||p_input::text,'UTF8')),'hex');
  INSERT INTO hon.school_social_commands(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(org,school,actor,p_key,'CHANGE',fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.school_social_commands WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'SOCIAL_BUSY' USING ERRCODE='55P03'; END IF;
    RETURN jsonb_build_object('record',prior.response,'replayed',true);
  END IF;
  SELECT * INTO a FROM hon.school_social_accounts WHERE id=p_account AND organization_id=org AND school_id=school FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF a.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SOCIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF a.status<>'CONNECTED' THEN RAISE EXCEPTION 'SOCIAL_ACCOUNT_DISCONNECTED' USING ERRCODE='23514'; END IF;
  -- 0453: a Google Ads account only runs ads; it never publishes or reads an inbox.
  IF a.platform='GOOGLE_ADS' AND NOT disconnecting AND ((p_input->>'publishEnabled')::boolean OR (p_input->>'inboxEnabled')::boolean) THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  IF disconnecting THEN
    UPDATE hon.school_social_accounts SET status='DISCONNECTED',publish_enabled=false,inbox_enabled=false,ads_enabled=false,
      version=version+1,updated_at=clock_timestamp(),disconnected_at=clock_timestamp() WHERE id=a.id RETURNING * INTO a;
    PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.account.disconnected','SCHOOL_SOCIAL_ACCOUNT',a.id,a.version,
      jsonb_build_object('platform',a.platform),p_request,p_correlation);
  ELSE
    UPDATE hon.school_social_accounts SET publish_enabled=(p_input->>'publishEnabled')::boolean,inbox_enabled=(p_input->>'inboxEnabled')::boolean,
      ads_enabled=(p_input->>'adsEnabled')::boolean,version=version+1,updated_at=clock_timestamp() WHERE id=a.id RETURNING * INTO a;
    PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.account.changed','SCHOOL_SOCIAL_ACCOUNT',a.id,a.version,
      jsonb_build_object('platform',a.platform,'publishEnabled',a.publish_enabled,'inboxEnabled',a.inbox_enabled,'adsEnabled',a.ads_enabled),p_request,p_correlation);
  END IF;
  -- The provider account id leaves the database only on disconnect, so the API can ask Zernio to remove it.
  result:=hon.school_social_account_json(a)||CASE WHEN disconnecting THEN jsonb_build_object('providerAccountId',a.provider_account_id) ELSE '{}'::jsonb END;
  UPDATE hon.school_social_commands SET response=result,completed_at=clock_timestamp()
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
  IF hon.require_school_social_actor(p_subject,'marketing.social.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- 0453: a Google Ads account is refused as a post target (otherwise unchanged).
CREATE OR REPLACE FUNCTION hon.school_social_post_fields(p_org uuid,p_school uuid,p_input jsonb,p_edit boolean) RETURNS uuid[]
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE keys text[]; e jsonb; ids uuid[]:='{}'; a hon.school_social_accounts%ROWTYPE; allowed text[];
BEGIN
  allowed:=CASE WHEN p_edit THEN ARRAY['accountIds','expectedVersion','linkUrl','text'] ELSE ARRAY['accountIds','linkUrl','text'] END;
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  keys:=(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k);
  IF NOT keys<@allowed OR NOT ARRAY['accountIds','text']<@keys OR (p_edit AND NOT 'expectedVersion'=ANY(keys))
    OR jsonb_typeof(p_input->'text') IS DISTINCT FROM 'string' OR length(p_input->>'text') NOT BETWEEN 1 AND 2200 OR btrim(p_input->>'text')=''
    OR (p_input->>'text') ~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]'
    OR (p_input ? 'linkUrl' AND jsonb_typeof(p_input->'linkUrl') NOT IN ('string','null'))
    OR (jsonb_typeof(p_input->'linkUrl')='string' AND (length(p_input->>'linkUrl')>2000
      OR (p_input->>'linkUrl') !~ '^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(/[!-~]*)?$'))
    OR (p_edit AND (jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'))
    OR jsonb_typeof(p_input->'accountIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'accountIds') NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_input->'accountIds') LOOP
    IF jsonb_typeof(e)<>'string' OR (e#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR (e#>>'{}')::uuid=ANY(ids) THEN
      RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
    ids:=ids||(e#>>'{}')::uuid;
  END LOOP;
  FOR a IN SELECT * FROM hon.school_social_accounts WHERE id=ANY(ids) AND organization_id=p_org AND school_id=p_school ORDER BY id LOOP
    IF a.status<>'CONNECTED' THEN RAISE EXCEPTION 'SOCIAL_ACCOUNT_DISCONNECTED' USING ERRCODE='23514'; END IF;
    IF a.platform='INSTAGRAM' THEN RAISE EXCEPTION 'SOCIAL_MEDIA_REQUIRED' USING ERRCODE='0A000'; END IF;
    -- 0453: a Google Ads account is never a post target.
    IF a.platform='GOOGLE_ADS' THEN RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM hon.school_social_accounts WHERE id=ANY(ids) AND organization_id=p_org AND school_id=p_school)<>cardinality(ids) THEN
    RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN ids;
END $$;

-- 0453: the channel and the Google text; a Google ad has no post.
CREATE OR REPLACE FUNCTION hon.school_social_ad_json(d hon.school_social_ads) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('adId',d.id,'channel',d.channel,'accountId',d.account_id,'targetId',d.target_id,
    'postId',(SELECT t.post_id FROM hon.school_social_post_targets t WHERE t.id=d.target_id),'accountName',a.display_name,
    'budgetCents',d.budget_cents,'currency',d.currency,'startsOn',to_char(d.starts_on,'YYYY-MM-DD'),'endsOn',to_char(d.ends_on,'YYYY-MM-DD'),
    'status',CASE WHEN d.status IN ('CREATING','ACTIVATING','PAUSING') AND d.lease_expires_at<=clock_timestamp() THEN 'UNKNOWN' ELSE d.status END,
    'operation',d.operation,'resolvedByPerson',d.resolved_by_principal_id IS NOT NULL,'createdAt',hon.saas_ts(d.created_at),'version',d.version,
    'google',d.google_content)
  FROM hon.school_social_accounts a WHERE a.id=d.account_id;
$$;

-- A list of 1-line texts: an array of min..max distinct (ignoring case) strings, each trimmed, 1..maxlen characters,
-- with no control characters. Keywords also refuse Google's match-type and operator characters.
CREATE FUNCTION hon.school_social_google_texts_ok(p jsonb,p_min integer,p_max integer,p_len integer,p_keyword boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(p)='array' AND jsonb_array_length(p) BETWEEN p_min AND p_max
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p) e WHERE jsonb_typeof(e)<>'string' OR length(e#>>'{}') NOT BETWEEN 1 AND p_len
      OR btrim(e#>>'{}')<>(e#>>'{}') OR (e#>>'{}') ~ '[[:cntrl:]]' OR (p_keyword AND (e#>>'{}') ~ '[][!@%^*()={};~<>?|"]'))
    AND (SELECT count(DISTINCT lower(e#>>'{}')) FROM jsonb_array_elements(p) e)=jsonb_array_length(p);
$$;

-- DRAFT a Google Search ad {accountId, budgetCents, startsOn, endsOn, headlines[3..15] (1 to 30 characters),
-- descriptions[2..4] (1 to 90), finalUrl (https), keywords[1..20] (1 to 80)}. The account must be this school's
-- CONNECTED Google Ads account with ads on; dates 1 to 31 days, from today (school time) up to 90 days ahead; at least
-- 1.00 a day; never over the cap. Nothing is sent to Google.
CREATE FUNCTION hon.create_school_social_google_ad(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb;
  a hon.school_social_accounts%ROWTYPE; b hon.school_social_ad_budgets%ROWTYPE; d hon.school_social_ads%ROWTYPE; v_start date; v_end date; today date; result jsonb;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k)
      IS DISTINCT FROM ARRAY['accountId','budgetCents','descriptions','endsOn','finalUrl','headlines','keywords','startsOn']
    OR jsonb_typeof(p_input->'accountId') IS DISTINCT FROM 'string' OR (p_input->>'accountId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'budgetCents') IS DISTINCT FROM 'number' OR (p_input->>'budgetCents') !~ '^[1-9][0-9]{2,6}$' OR (p_input->>'budgetCents')::integer>1000000
    OR jsonb_typeof(p_input->'startsOn') IS DISTINCT FROM 'string' OR (p_input->>'startsOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR jsonb_typeof(p_input->'endsOn') IS DISTINCT FROM 'string' OR (p_input->>'endsOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR NOT hon.school_social_google_texts_ok(p_input->'headlines',3,15,30,false)
    OR NOT hon.school_social_google_texts_ok(p_input->'descriptions',2,4,90,false)
    OR NOT hon.school_social_google_texts_ok(p_input->'keywords',1,20,80,true)
    OR jsonb_typeof(p_input->'finalUrl') IS DISTINCT FROM 'string' OR length(p_input->>'finalUrl')>2000
    OR (p_input->>'finalUrl') !~ '^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(/[!-~]*)?$' THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  BEGIN v_start:=(p_input->>'startsOn')::date; v_end:=(p_input->>'endsOn')::date; EXCEPTION WHEN others THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.ads');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'AD_GOOGLE_CREATE',
    encode(sha256(convert_to('marketing.social.ads.google.create:'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  today:=hon.school_social_today(school);
  IF v_end<v_start OR v_end-v_start>30 OR v_start<today OR v_start>today+90
    OR (p_input->>'budgetCents')::integer<100*(v_end-v_start+1) THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM hon.school_social_accounts WHERE id=(p_input->>'accountId')::uuid AND organization_id=org AND school_id=school FOR SHARE;
  IF a.id IS NULL OR a.platform<>'GOOGLE_ADS' THEN RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF a.status<>'CONNECTED' OR NOT a.ads_enabled THEN RAISE EXCEPTION 'SOCIAL_ADS_OFF' USING ERRCODE='23514'; END IF;
  SELECT * INTO b FROM hon.school_social_ad_budgets WHERE organization_id=org AND school_id=school;
  IF b.school_id IS NULL OR b.monthly_cap_cents=0 THEN RAISE EXCEPTION 'SOCIAL_AD_NO_BUDGET' USING ERRCODE='23514'; END IF;
  IF (p_input->>'budgetCents')::integer>b.monthly_cap_cents THEN RAISE EXCEPTION 'SOCIAL_AD_OVER_CAP' USING ERRCODE='23514'; END IF;
  INSERT INTO hon.school_social_ads(organization_id,school_id,account_id,target_id,channel,google_content,budget_cents,currency,starts_on,ends_on,status,created_by_principal_id)
    VALUES(org,school,a.id,NULL,'GOOGLE_SEARCH',jsonb_build_object('headlines',p_input->'headlines','descriptions',p_input->'descriptions',
      'finalUrl',p_input->'finalUrl','keywords',p_input->'keywords'),(p_input->>'budgetCents')::integer,b.currency,v_start,v_end,'DRAFT',actor) RETURNING * INTO d;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.ads.drafted','SCHOOL_SOCIAL_AD',d.id,d.version,
    jsonb_build_object('channel',d.channel,'budgetCents',d.budget_cents,'currency',d.currency,'days',d.ends_on-d.starts_on+1),p_request,p_correlation);
  result:=hon.school_social_ad_json(d);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.ads') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- 0453: a Google ad needs no post; the account must match the channel; the send carries the channel, the Google text
-- and the daily budget (otherwise unchanged).
CREATE OR REPLACE FUNCTION hon.start_school_social_ad_operation(p_subject text,p_ad uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; d hon.school_social_ads%ROWTYPE;
  a hon.school_social_accounts%ROWTYPE; t hon.school_social_post_targets%ROWTYPE; b hon.school_social_ad_budgets%ROWTYPE; op text; next_status text;
  at timestamptz:=clock_timestamp(); today date; m date; extra integer; result jsonb; shown text;
  l hon.school_locations%ROWTYPE; place jsonb;
BEGIN
  IF p_ad IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedVersion','operation']
    OR jsonb_typeof(p_input->'operation') IS DISTINCT FROM 'string' OR (p_input->>'operation') NOT IN ('CREATE','ACTIVATE','PAUSE')
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  op:=p_input->>'operation';
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.ads');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'AD_START',
    encode(sha256(convert_to('marketing.social.ads.start:'||p_ad::text||':'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  -- The budget lock first (every cap decision for this school is taken under it), then the ad.
  PERFORM pg_advisory_xact_lock(hashtextextended('social-ad-budget:'||school::text,0));
  SELECT * INTO d FROM hon.school_social_ads WHERE id=p_ad AND organization_id=org AND school_id=school FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_AD_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF d.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SOCIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  shown:=CASE WHEN d.status IN ('CREATING','ACTIVATING','PAUSING') AND d.lease_expires_at<=at THEN 'UNKNOWN' ELSE d.status END;
  -- An operation whose lease ran out becomes UNKNOWN before anything else happens to the ad.
  IF shown='UNKNOWN' AND d.status<>'UNKNOWN' THEN
    UPDATE hon.school_social_ads SET status='UNKNOWN',version=version+1,updated_at=at WHERE id=d.id RETURNING * INTO d;
  END IF;
  SELECT * INTO a FROM hon.school_social_accounts WHERE id=d.account_id FOR SHARE;
  today:=hon.school_social_today(school);
  IF op IN ('CREATE','ACTIVATE') THEN
    IF NOT ((op='CREATE' AND d.status='DRAFT') OR (op='ACTIVATE' AND d.status='PAUSED')) OR d.ends_on<today
      OR (op='CREATE' AND d.starts_on<today) THEN RAISE EXCEPTION 'SOCIAL_AD_STATE' USING ERRCODE='55000'; END IF;
    IF a.status<>'CONNECTED' OR NOT a.ads_enabled OR a.organization_id<>org OR a.school_id<>school
      OR a.platform<>(CASE d.channel WHEN 'META_BOOST' THEN 'FACEBOOK' ELSE 'GOOGLE_ADS' END) THEN RAISE EXCEPTION 'SOCIAL_ADS_OFF' USING ERRCODE='23514'; END IF;
    SELECT * INTO t FROM hon.school_social_post_targets WHERE id=d.target_id;
    IF op='CREATE' AND d.channel='META_BOOST' AND (t.status IS DISTINCT FROM 'PUBLISHED' OR t.provider_post_id IS NULL) THEN RAISE EXCEPTION 'SOCIAL_AD_POST_NOT_PUBLISHED' USING ERRCODE='55000'; END IF;
    SELECT * INTO b FROM hon.school_social_ad_budgets WHERE organization_id=org AND school_id=school;
    IF b.school_id IS NULL OR b.monthly_cap_cents=0 THEN RAISE EXCEPTION 'SOCIAL_AD_NO_BUDGET' USING ERRCODE='23514'; END IF;
    IF b.currency<>d.currency THEN RAISE EXCEPTION 'SOCIAL_AD_STATE' USING ERRCODE='55000'; END IF;
    -- Every calendar month the ad touches must still fit, counting this ad once (a PAUSED ad already counts).
    m:=date_trunc('month',d.starts_on)::date; extra:=CASE WHEN d.status='DRAFT' THEN d.budget_cents ELSE 0 END;
    WHILE m<=d.ends_on LOOP
      IF hon.school_social_ad_committed(org,school,m)+extra>b.monthly_cap_cents THEN
        RAISE EXCEPTION 'SOCIAL_AD_OVER_CAP' USING ERRCODE='23514'; END IF;
      m:=(m+interval '1 month')::date;
    END LOOP;
    -- 0453 owner decision: an ad is created to reach people within 5 miles of the school's street address.
    IF op='CREATE' THEN
      SELECT * INTO l FROM hon.school_locations WHERE school_id=school AND organization_id=org;
      IF l.school_id IS NULL OR l.address_line1 IS NULL OR btrim(l.address_line1)='' THEN
        RAISE EXCEPTION 'SOCIAL_AD_NO_ADDRESS' USING ERRCODE='23514'; END IF;
      place:=jsonb_build_object('addressLine1',l.address_line1,'addressLine2',l.address_line2,'city',l.city,'region',l.region_code,
        'postalCode',l.postal_code,'country',l.country_code,'radiusMiles',5);
    END IF;
    next_status:=CASE op WHEN 'CREATE' THEN 'CREATING' ELSE 'ACTIVATING' END;
  ELSE
    IF NOT (d.status='ACTIVE' OR (d.status='UNKNOWN' AND d.provider_ad_id IS NOT NULL)) THEN RAISE EXCEPTION 'SOCIAL_AD_STATE' USING ERRCODE='55000'; END IF;
    next_status:='PAUSING';
  END IF;
  UPDATE hon.school_social_ads SET status=next_status,operation=op,prior_status=CASE WHEN op='PAUSE' THEN d.status WHEN op='ACTIVATE' THEN 'PAUSED' END,
    lease_token=gen_random_uuid(),lease_expires_at=at+interval '60 seconds',
    approved_by_principal_id=CASE WHEN op='CREATE' THEN actor ELSE approved_by_principal_id END,
    activated_by_principal_id=CASE WHEN op='ACTIVATE' THEN actor ELSE activated_by_principal_id END,
    -- A person's resolution settles one operation; the next operation starts unresolved.
    resolved_by_principal_id=NULL,
    version=version+1,updated_at=at WHERE id=d.id RETURNING * INTO d;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.ads.'||lower(op)||'_started','SCHOOL_SOCIAL_AD',d.id,d.version,
    jsonb_build_object('operation',op,'budgetCents',d.budget_cents),p_request,p_correlation);
  result:=hon.school_social_ad_json(d);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.ads') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO t FROM hon.school_social_post_targets WHERE id=d.target_id;
  -- 0453: the channel, and for Google the school's own ad text and a daily budget (total / days, rounded down). This
  -- keeps the expected spend inside the total counted against the cap; Google may still overdeliver up to 2x on a day
  -- (spec 8.2 item 6 gates real use). On CREATE, both channels also get the 5-mile radius around the school's address.
  RETURN jsonb_build_object('record',result,'replayed',false,'send',jsonb_build_object('adId',d.id,'leaseToken',d.lease_token,'operation',op,
    'channel',d.channel,'google',d.google_content,'location',place,
    'dailyBudgetCents',CASE WHEN d.channel='GOOGLE_SEARCH' THEN d.budget_cents/(d.ends_on-d.starts_on+1) END,
    'providerAccountId',a.provider_account_id,'providerPostId',t.provider_post_id,'providerAdId',d.provider_ad_id,'budgetCents',d.budget_cents,
    'currency',d.currency,'startsOn',to_char(d.starts_on,'YYYY-MM-DD'),'endsOn',to_char(d.ends_on,'YYYY-MM-DD'),
    'timezone',(SELECT s.timezone FROM hon.schools s WHERE s.id=school)));
END $$;

DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.school_social_google_texts_ok(jsonb,integer,integer,integer,boolean)','hon.create_school_social_google_ad(text,jsonb,text,uuid,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','hon_communication_worker','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_school_social_google_ad(text,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
