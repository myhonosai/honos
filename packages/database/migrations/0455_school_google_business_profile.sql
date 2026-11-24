BEGIN;

-- Google Business Profile (0455, docs/architecture/SCHOOL_ADS_MARKETING.md §9): owner request 2026-11-17 ("Let's add
-- Google business as well"). A school connects its own Google Business Profile through the same Zernio profile it uses
-- for Facebook and Google Ads, and HON publishes the school's approved posts to it through the reviewed 0348 post path
-- (draft, a person approves, one leased send, receipts, UNKNOWN never resent). Nothing is posted unless the API server
-- has HON_ZERNIO_PUBLISH_APPROVED=true and a Zernio key; tests use the deterministic fake.
-- - A Google Business Profile only publishes: its inbox and ads switches stay off (reviews come in a later piece).
-- - A post sent to a Google Business Profile holds at most 1,500 characters; its link becomes the post's button.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.create_school_social_google_ad(text,jsonb,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.claim_school_social_post_targets(integer,integer)') IS NULL THEN RAISE EXCEPTION '0455 requires the 0348 posts and 0453 Google ads records'; END IF;
END $$;

ALTER TABLE hon.school_social_accounts DROP CONSTRAINT school_social_accounts_platform_check;
ALTER TABLE hon.school_social_accounts ADD CONSTRAINT school_social_accounts_platform_check CHECK (platform IN ('FACEBOOK','INSTAGRAM','GOOGLE_ADS','GOOGLE_BUSINESS'));
ALTER TABLE hon.school_social_accounts ADD CONSTRAINT school_social_accounts_google_business_only CHECK (platform<>'GOOGLE_BUSINESS' OR NOT (inbox_enabled OR ads_enabled));
ALTER TABLE hon.school_social_connect_intents DROP CONSTRAINT school_social_connect_intents_platform_check;
ALTER TABLE hon.school_social_connect_intents ADD CONSTRAINT school_social_connect_intents_platform_check CHECK (platform IN ('FACEBOOK','INSTAGRAM','GOOGLE_ADS','GOOGLE_BUSINESS'));

-- 0455: GOOGLE_BUSINESS can be connected (otherwise the 0453 version).
CREATE OR REPLACE FUNCTION hon.start_school_social_connect(p_subject text,p_input jsonb,p_state_hash text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; i hon.school_social_connect_intents%ROWTYPE;
  at timestamptz:=clock_timestamp();
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['platform']
    OR jsonb_typeof(p_input->'platform') IS DISTINCT FROM 'string' OR (p_input->>'platform') NOT IN ('FACEBOOK','INSTAGRAM','GOOGLE_ADS','GOOGLE_BUSINESS')
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

-- 0455: a Google Business Profile's inbox and ads switches stay off (otherwise the 0453 version).
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
  -- 0455: a Google Business Profile only publishes posts; it has no inbox here yet and never runs ads.
  IF a.platform='GOOGLE_BUSINESS' AND NOT disconnecting AND ((p_input->>'inboxEnabled')::boolean OR (p_input->>'adsEnabled')::boolean) THEN
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

-- 0455: a Google Business Profile is a post target, for text up to 1,500 characters (otherwise the 0453 version).
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
    -- 0455: Google Business Profile posts hold at most 1,500 characters (the link travels as the post's button).
    IF a.platform='GOOGLE_BUSINESS' AND length(p_input->>'text')>1500 THEN RAISE EXCEPTION 'SOCIAL_TEXT_TOO_LONG' USING ERRCODE='22001'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM hon.school_social_accounts WHERE id=ANY(ids) AND organization_id=p_org AND school_id=p_school)<>cardinality(ids) THEN
    RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN ids;
END $$;

-- 0455: due targets on a Google Business Profile are claimed like Facebook ones (otherwise the 0348 version).
CREATE OR REPLACE FUNCTION hon.claim_school_social_post_targets(p_limit integer,p_lease_seconds integer)
RETURNS TABLE(target_id uuid,lease_token uuid,organization_id uuid,school_id uuid,platform text,provider_account_id text,provider_profile_id text,
  body text,link_url text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE t hon.school_social_post_targets%ROWTYPE; a hon.school_social_accounts%ROWTYPE; p hon.school_social_posts%ROWTYPE;
  at timestamptz:=clock_timestamp(); token uuid; claimed integer:=0; live boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  FOR t IN SELECT * FROM hon.school_social_post_targets x WHERE x.status='PUBLISHING' AND x.lease_expires_at<=at ORDER BY x.lease_expires_at,x.id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
    UPDATE hon.school_social_post_targets x SET status='UNKNOWN',version=x.version+1,updated_at=at WHERE x.id=t.id RETURNING * INTO t;
    PERFORM hon.school_social_service_evidence(t.organization_id,t.school_id,'marketing.social.post.target_unknown','SCHOOL_SOCIAL_POST_TARGET',t.id,t.version,
      jsonb_build_object('postId',t.post_id,'reason','LEASE_EXPIRED'));
  END LOOP;
  FOR t IN SELECT * FROM hon.school_social_post_targets x WHERE x.status='PENDING' AND x.due_at<=at ORDER BY x.due_at,x.id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
    EXIT WHEN claimed>=p_limit;
    SELECT * INTO a FROM hon.school_social_accounts x WHERE x.id=t.account_id FOR SHARE;
    SELECT * INTO p FROM hon.school_social_posts x WHERE x.id=t.post_id;
    live:=EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=t.organization_id AND o.status='ACTIVE')
      AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=t.school_id AND s.organization_id=t.organization_id AND s.status='ACTIVE')
      AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=t.organization_id AND e.status='ACTIVE'
        AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=at AND (e.effective_until IS NULL OR e.effective_until>at));
    IF p.status<>'APPROVED' OR NOT live OR a.status<>'CONNECTED' OR NOT a.publish_enabled OR a.platform NOT IN ('FACEBOOK','GOOGLE_BUSINESS')
      OR a.organization_id<>t.organization_id OR a.school_id<>t.school_id THEN
      UPDATE hon.school_social_post_targets x SET status='SKIPPED',skip_reason=CASE WHEN live THEN 'ACCOUNT_OFF' ELSE 'SCHOOL_INACTIVE' END,
        settled_at=at,version=x.version+1,updated_at=at WHERE x.id=t.id RETURNING * INTO t;
      PERFORM hon.school_social_service_evidence(t.organization_id,t.school_id,'marketing.social.post.target_skipped','SCHOOL_SOCIAL_POST_TARGET',t.id,t.version,
        jsonb_build_object('postId',t.post_id,'reason',t.skip_reason));
      CONTINUE;
    END IF;
    token:=gen_random_uuid();
    UPDATE hon.school_social_post_targets x SET status='PUBLISHING',lease_token=token,lease_expires_at=at+make_interval(secs=>p_lease_seconds),
      attempted_at=at,version=x.version+1,updated_at=at WHERE x.id=t.id;
    claimed:=claimed+1;
    target_id:=t.id; lease_token:=token; organization_id:=t.organization_id; school_id:=t.school_id; platform:=a.platform;
    provider_account_id:=a.provider_account_id;
    provider_profile_id:=(SELECT f.provider_profile_id FROM hon.school_social_profiles f WHERE f.organization_id=t.organization_id AND f.school_id=t.school_id);
    body:=p.body; link_url:=p.link_url;
    RETURN NEXT;
  END LOOP;
END $$;

-- 0455: Zernio post receipts for a Google Business Profile settle its targets (otherwise the 0348 version).
CREATE OR REPLACE FUNCTION hon.record_school_social_post_event(p_event_id text,p_event_type text,p_platform text,p_provider_account_id text,p_provider_post_id text)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE t hon.school_social_post_targets%ROWTYPE; a hon.school_social_accounts%ROWTYPE; result text; at timestamptz:=clock_timestamp();
BEGIN
  IF p_event_id IS NULL OR p_event_id !~ '^[0-9A-Za-z_:.-]{1,128}$' OR p_event_type NOT IN ('post.published','post.failed','account.disconnected')
    OR p_platform NOT IN ('FACEBOOK','INSTAGRAM','GOOGLE_BUSINESS') OR p_provider_account_id IS NULL OR p_provider_account_id !~ '^[0-9A-Za-z_-]{1,64}$'
    OR (p_event_type='account.disconnected') IS DISTINCT FROM (p_provider_post_id IS NULL)
    OR (p_provider_post_id IS NOT NULL AND p_provider_post_id !~ '^[0-9A-Za-z_:.-]{1,128}$') THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('social-receipt:'||p_event_id,0));
  IF EXISTS(SELECT 1 FROM hon.school_social_post_receipts r WHERE r.event_id=p_event_id) THEN outcome:='REPLAYED'; RETURN NEXT; RETURN; END IF;
  SELECT * INTO a FROM hon.school_social_accounts x WHERE x.platform=p_platform AND x.provider_account_id=p_provider_account_id FOR UPDATE;
  IF a.id IS NULL THEN result:='UNMATCHED';
  ELSIF p_event_type='account.disconnected' THEN
    IF a.status='CONNECTED' THEN
      UPDATE hon.school_social_accounts x SET status='DISCONNECTED',publish_enabled=false,inbox_enabled=false,ads_enabled=false,
        version=x.version+1,updated_at=at,disconnected_at=at WHERE x.id=a.id RETURNING * INTO a;
      PERFORM hon.school_social_service_evidence(a.organization_id,a.school_id,'marketing.social.account.disconnected','SCHOOL_SOCIAL_ACCOUNT',a.id,a.version,
        jsonb_build_object('platform',a.platform,'reason','PROVIDER_REPORTED'));
      result:='APPLIED';
    ELSE result:='IGNORED'; END IF;
  ELSE
    SELECT * INTO t FROM hon.school_social_post_targets x WHERE x.provider_post_id=p_provider_post_id AND x.account_id=a.id FOR UPDATE;
    IF t.id IS NULL THEN result:='UNMATCHED';
    ELSIF t.resolved_by_principal_id IS NULL AND (t.status IN ('PUBLISHING','UNKNOWN') OR (t.status='PUBLISHED' AND p_event_type='post.failed')) THEN
      UPDATE hon.school_social_post_targets x SET status=CASE WHEN p_event_type='post.published' THEN 'PUBLISHED' ELSE 'FAILED' END,
        failure_code=CASE WHEN p_event_type='post.failed' THEN 'PROVIDER_REPORTED_FAILED' END,settled_at=at,version=x.version+1,updated_at=at
        WHERE x.id=t.id RETURNING * INTO t;
      PERFORM hon.school_social_service_evidence(t.organization_id,t.school_id,'marketing.social.post.target_'||lower(t.status),'SCHOOL_SOCIAL_POST_TARGET',t.id,t.version,
        jsonb_build_object('postId',t.post_id,'reason','PROVIDER_RECEIPT'));
      result:='APPLIED';
    ELSE result:='IGNORED'; END IF;
  END IF;
  INSERT INTO hon.school_social_post_receipts(event_id,event_type,outcome) VALUES(p_event_id,p_event_type,result);
  outcome:=result; RETURN NEXT;
END $$;

COMMIT;
