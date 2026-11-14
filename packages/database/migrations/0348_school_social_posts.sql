BEGIN;

-- S2 (0348, coordinator-allocated 2026-11-14): school posts to the school's own Facebook Pages through Zernio
-- (docs/architecture/SOCIAL_POSTING_INBOX_ADS.md §4A). Builds on 0347 connections. Nothing is published unless the API
-- server has HON_ZERNIO_PUBLISH_APPROVED=true and a Zernio key; tests use the deterministic fake.
-- - Staff write drafts (marketing.social.post). A person with marketing.social.manage approves each post with a publish
--   time (now, or up to 90 days ahead) and can cancel it while nothing was sent.
-- - Instagram needs media on every post and HON has no reviewed real-media storage yet, so an Instagram target is
--   refused (SOCIAL_MEDIA_REQUIRED) until a later media piece.
-- - One target per (post, account). The publish worker (hon_communication_worker) leases a due target; at claim time
--   the account must still be CONNECTED with publishing on, and the school, organization and HON entitlement active,
--   or the target is SKIPPED. A lost answer, or a lease that ran out, is UNKNOWN and is never sent again. A person can
--   settle an UNKNOWN after checking the Page; a signed Zernio post.published / post.failed receipt can too.
-- - account.disconnected from Zernio turns the bound account DISCONNECTED with every switch off.
-- - Identifier-only audit and inert outbox. No provider text is stored; failure codes are HON's own.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.school_social_accounts') IS NULL OR to_regprocedure('hon.require_school_social_actor(text,text)') IS NULL THEN
    RAISE EXCEPTION '0348 requires the 0347 school social connections'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('marketing.social.post','Write and edit Facebook and Instagram post drafts for the school (a manager approves each post)',false,true)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,'marketing.social.post' FROM hon.roles r WHERE r.code='OWNER' AND r.is_system_role
  ON CONFLICT (role_id,permission_code) DO NOTHING;

-- The grant-free system service that records publish results and Zernio receipts.
INSERT INTO hon.principals (id,principal_type,user_id,display_name,is_active)
VALUES ('00000000-0000-4000-8000-00000000c348','SYSTEM_SERVICE',NULL,'Zernio social posting',true);

ALTER TABLE hon.school_social_commands DROP CONSTRAINT school_social_commands_operation_check;
ALTER TABLE hon.school_social_commands ADD CONSTRAINT school_social_commands_operation_check
  CHECK (operation IN ('CHANGE','POST_CREATE','POST_EDIT','POST_APPROVE','POST_CANCEL','POST_RESOLVE'));

CREATE TABLE hon.school_social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2200 AND btrim(body)<>'' AND body !~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]'),
  link_url text CHECK (link_url IS NULL OR (length(link_url)<=2000 AND link_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(/[!-~]*)?$')),
  account_ids uuid[] NOT NULL CHECK (cardinality(account_ids) BETWEEN 1 AND 4),
  status text NOT NULL CHECK (status IN ('DRAFT','APPROVED','CANCELLED')),
  publish_at timestamptz,
  drafted_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  approved_by_principal_id uuid REFERENCES hon.principals(id),
  approved_at timestamptz,
  cancelled_by_principal_id uuid REFERENCES hon.principals(id),
  cancelled_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((approved_at IS NULL)=(approved_by_principal_id IS NULL) AND (approved_at IS NULL)=(publish_at IS NULL)),
  CHECK ((cancelled_at IS NULL)=(cancelled_by_principal_id IS NULL) AND (status='CANCELLED')=(cancelled_at IS NOT NULL)),
  CHECK (status<>'APPROVED' OR approved_at IS NOT NULL),
  CHECK (status<>'DRAFT' OR approved_at IS NULL)
);
CREATE INDEX school_social_posts_school_idx ON hon.school_social_posts (organization_id,school_id,(coalesce(publish_at,created_at)),id);

CREATE TABLE hon.school_social_post_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES hon.school_social_accounts(id),
  status text NOT NULL CHECK (status IN ('PENDING','PUBLISHING','PUBLISHED','FAILED','UNKNOWN','SKIPPED','CANCELLED')),
  due_at timestamptz NOT NULL,
  lease_token uuid, lease_expires_at timestamptz,
  attempted_at timestamptz,
  provider_post_id text UNIQUE CHECK (provider_post_id IS NULL OR provider_post_id ~ '^[0-9A-Za-z_:.-]{1,128}$'),
  failure_code text CHECK (failure_code IN ('PROVIDER_REJECTED','PROVIDER_REPORTED_FAILED','CONFIRMED_NOT_PUBLISHED')),
  skip_reason text CHECK (skip_reason IN ('ACCOUNT_OFF','SCHOOL_INACTIVE')),
  resolved_by_principal_id uuid REFERENCES hon.principals(id),
  settled_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (post_id,account_id),
  FOREIGN KEY (post_id,organization_id,school_id) REFERENCES hon.school_social_posts(id,organization_id,school_id),
  CHECK ((status='FAILED')=(failure_code IS NOT NULL)),
  CHECK ((status='SKIPPED')=(skip_reason IS NOT NULL)),
  CHECK (status<>'PUBLISHING' OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((lease_token IS NULL)=(attempted_at IS NULL)),
  CHECK (status NOT IN ('PENDING','SKIPPED','CANCELLED') OR lease_token IS NULL),
  CHECK (status<>'PUBLISHED' OR provider_post_id IS NOT NULL OR resolved_by_principal_id IS NOT NULL),
  CHECK ((status IN ('PUBLISHED','FAILED','SKIPPED','CANCELLED'))=(settled_at IS NOT NULL))
);
CREATE INDEX school_social_post_targets_due_idx ON hon.school_social_post_targets (due_at,id) WHERE status='PENDING';
CREATE INDEX school_social_post_targets_lease_idx ON hon.school_social_post_targets (lease_expires_at) WHERE status='PUBLISHING';

-- One row per signed Zernio event id, so a redelivery changes nothing twice.
CREATE TABLE hon.school_social_post_receipts (
  event_id text PRIMARY KEY CHECK (event_id ~ '^[0-9A-Za-z_:.-]{1,128}$'),
  event_type text NOT NULL CHECK (event_type IN ('post.published','post.failed','account.disconnected')),
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','IGNORED','UNMATCHED')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE hon.school_social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_social_posts FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_social_post_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_social_post_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_social_post_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_social_post_receipts FORCE ROW LEVEL SECURITY;

-- A post keeps its school, author and creation; its words and accounts change only as a DRAFT; status moves
-- DRAFT -> APPROVED | CANCELLED and APPROVED -> CANCELLED. A target keeps its post and account and moves only forward:
-- PENDING -> PUBLISHING | SKIPPED | CANCELLED; PUBLISHING -> PUBLISHED | FAILED | UNKNOWN; UNKNOWN -> PUBLISHED | FAILED;
-- PUBLISHED -> FAILED only on Zernio's own post.failed receipt (never after a person settled it).
-- Receipts never change. Nothing is deleted or truncated.
CREATE FUNCTION hon.guard_school_social_post() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='school_social_posts' THEN
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.drafted_by_principal_id,NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.drafted_by_principal_id,OLD.created_at)
      AND NEW.version=OLD.version+1
      AND ((OLD.status='DRAFT' AND NEW.status IN ('DRAFT','APPROVED','CANCELLED'))
        OR (OLD.status='APPROVED' AND NEW.status='CANCELLED' AND (NEW.publish_at,NEW.approved_at,NEW.approved_by_principal_id)
          IS NOT DISTINCT FROM (OLD.publish_at,OLD.approved_at,OLD.approved_by_principal_id)))
      AND (OLD.status='DRAFT' OR (NEW.body,NEW.link_url,NEW.account_ids) IS NOT DISTINCT FROM (OLD.body,OLD.link_url,OLD.account_ids)) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='school_social_post_targets' THEN
    IF (NEW.id,NEW.post_id,NEW.organization_id,NEW.school_id,NEW.account_id,NEW.due_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.post_id,OLD.organization_id,OLD.school_id,OLD.account_id,OLD.due_at)
      AND NEW.version=OLD.version+1
      AND ((OLD.status='PENDING' AND NEW.status IN ('PUBLISHING','SKIPPED','CANCELLED'))
        OR (OLD.status='PUBLISHING' AND NEW.status IN ('PUBLISHED','FAILED','UNKNOWN') AND NEW.lease_token=OLD.lease_token)
        OR (OLD.status='UNKNOWN' AND NEW.status IN ('PUBLISHED','FAILED') AND NEW.lease_token=OLD.lease_token)
        -- Zernio accepted the post, then reported that the platform refused it.
        OR (OLD.status='PUBLISHED' AND NEW.status='FAILED' AND NEW.failure_code='PROVIDER_REPORTED_FAILED' AND OLD.resolved_by_principal_id IS NULL
          AND NEW.resolved_by_principal_id IS NULL AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token))
      AND (OLD.provider_post_id IS NULL OR NEW.provider_post_id=OLD.provider_post_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SOCIAL_RECORD_IMMUTABLE' USING ERRCODE='42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_social_posts','school_social_post_targets','school_social_post_receipts'] LOOP
    EXECUTE format('CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_school_social_post()',t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_social_post()',t);
  END LOOP;
END $$;

-- 0348 adds marketing.social.post to the permissions the 0347 actor check accepts (otherwise unchanged).
CREATE OR REPLACE FUNCTION hon.require_school_social_actor(p_subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF p_permission NOT IN ('marketing.social.manage','marketing.social.read','marketing.social.post')
    OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 2048 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=p_permission AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.school_social_post_json(p hon.school_social_posts) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('postId',p.id,'text',p.body,'linkUrl',p.link_url,'status',p.status,'publishAt',hon.saas_ts(p.publish_at),
    'accountIds',to_jsonb(p.account_ids),'version',p.version,'createdAt',hon.saas_ts(p.created_at),'updatedAt',hon.saas_ts(p.updated_at),
    'approvedAt',hon.saas_ts(p.approved_at),'cancelledAt',hon.saas_ts(p.cancelled_at),
    'targets',coalesce((SELECT jsonb_agg(jsonb_build_object('targetId',t.id,'accountId',t.account_id,'platform',a.platform,'displayName',a.display_name,
        'status',t.status,'failureCode',t.failure_code,'skipReason',t.skip_reason,'resolvedByPerson',t.resolved_by_principal_id IS NOT NULL,
        'settledAt',hon.saas_ts(t.settled_at),'version',t.version) ORDER BY a.platform,a.display_name,t.id)
      FROM hon.school_social_post_targets t JOIN hon.school_social_accounts a ON a.id=t.account_id WHERE t.post_id=p.id),'[]'::jsonb));
$$;

-- Idempotency: NULL when this (person, key) is new; the stored response when it is a replay of the same command.
CREATE FUNCTION hon.school_social_command_begin(p_org uuid,p_school uuid,p_actor uuid,p_key text,p_operation text,p_fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE prior hon.school_social_commands%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.school_social_commands(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(p_org,p_school,p_actor,p_key,p_operation,p_fp) ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.school_social_commands WHERE organization_id=p_org AND school_id=p_school AND principal_id=p_actor AND idempotency_key=p_key FOR UPDATE;
  IF prior.fingerprint<>p_fp OR prior.operation<>p_operation THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.response IS NULL THEN RAISE EXCEPTION 'SOCIAL_BUSY' USING ERRCODE='55P03'; END IF;
  RETURN prior.response;
END $$;

CREATE FUNCTION hon.school_social_command_finish(p_org uuid,p_school uuid,p_actor uuid,p_key text,p_response jsonb) RETURNS void
LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $$
  UPDATE hon.school_social_commands SET response=p_response,completed_at=clock_timestamp()
  WHERE organization_id=p_org AND school_id=p_school AND principal_id=p_actor AND idempotency_key=p_key;
$$;

-- Draft fields {text, linkUrl?, accountIds} (plus expectedVersion on edit). accountIds: 1 to 4 distinct CONNECTED
-- accounts of this exact school. Instagram needs media, which S2 does not carry.
CREATE FUNCTION hon.school_social_post_fields(p_org uuid,p_school uuid,p_input jsonb,p_edit boolean) RETURNS uuid[]
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
  END LOOP;
  IF (SELECT count(*) FROM hon.school_social_accounts WHERE id=ANY(ids) AND organization_id=p_org AND school_id=p_school)<>cardinality(ids) THEN
    RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN ids;
END $$;

-- READ: posts whose publish time (or creation, for drafts) is in [from, to), at most 100 days wide and 200 posts.
CREATE FUNCTION hon.read_school_social_posts(p_subject text,p_from timestamptz,p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to<=p_from OR p_to-p_from>interval '100 days' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.require_school_social_actor(p_subject,'marketing.social.read');
  RETURN jsonb_build_object('posts',coalesce((SELECT jsonb_agg(hon.school_social_post_json(x) ORDER BY coalesce(x.publish_at,x.created_at),x.id)
      FROM (SELECT * FROM hon.school_social_posts p WHERE p.organization_id=org AND p.school_id=school
        AND coalesce(p.publish_at,p.created_at)>=p_from AND coalesce(p.publish_at,p.created_at)<p_to
        ORDER BY coalesce(p.publish_at,p.created_at),p.id LIMIT 200) x),'[]'::jsonb),
    'checkedAt',hon.saas_ts(clock_timestamp()));
END $$;

-- CREATE a DRAFT.
CREATE FUNCTION hon.create_school_social_post(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; ids uuid[]; p hon.school_social_posts%ROWTYPE; result jsonb;
BEGIN
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.post');
  ids:=hon.school_social_post_fields(org,school,p_input,false);
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'POST_CREATE',
    encode(sha256(convert_to('marketing.social.post.create:'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  INSERT INTO hon.school_social_posts(organization_id,school_id,body,link_url,account_ids,status,drafted_by_principal_id)
    VALUES(org,school,p_input->>'text',nullif(p_input->>'linkUrl',''),ids,'DRAFT',actor) RETURNING * INTO p;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.post.drafted','SCHOOL_SOCIAL_POST',p.id,p.version,
    jsonb_build_object('accounts',cardinality(ids),'hasLink',p.link_url IS NOT NULL),p_request,p_correlation);
  result:=hon.school_social_post_json(p);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.post') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- The school's post, locked, at the expected version.
CREATE FUNCTION hon.school_social_post_for_change(p_org uuid,p_school uuid,p_post uuid,p_version jsonb) RETURNS hon.school_social_posts
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE p hon.school_social_posts%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_version) IS DISTINCT FROM 'number' OR (p_version#>>'{}') !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO p FROM hon.school_social_posts WHERE id=p_post AND organization_id=p_org AND school_id=p_school FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_POST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p.version<>(p_version#>>'{}')::integer THEN RAISE EXCEPTION 'SOCIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  RETURN p;
END $$;

-- EDIT a DRAFT {text, linkUrl?, accountIds, expectedVersion}.
CREATE FUNCTION hon.edit_school_social_post(p_subject text,p_post uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; ids uuid[]; p hon.school_social_posts%ROWTYPE; result jsonb;
BEGIN
  IF p_post IS NULL THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.post');
  ids:=hon.school_social_post_fields(org,school,p_input,true);
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'POST_EDIT',
    encode(sha256(convert_to('marketing.social.post.edit:'||p_post::text||':'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  p:=hon.school_social_post_for_change(org,school,p_post,p_input->'expectedVersion');
  IF p.status<>'DRAFT' THEN RAISE EXCEPTION 'SOCIAL_POST_STATE' USING ERRCODE='55000'; END IF;
  UPDATE hon.school_social_posts SET body=p_input->>'text',link_url=nullif(p_input->>'linkUrl',''),account_ids=ids,version=version+1,updated_at=clock_timestamp()
    WHERE id=p.id RETURNING * INTO p;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.post.edited','SCHOOL_SOCIAL_POST',p.id,p.version,
    jsonb_build_object('accounts',cardinality(ids),'hasLink',p.link_url IS NOT NULL),p_request,p_correlation);
  result:=hon.school_social_post_json(p);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.post') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- APPROVE a DRAFT {expectedVersion, publishAt?}: publishAt null/absent means now, otherwise an ISO time from now to
-- 90 days ahead (a time up to a minute in the past is taken as now). Every account must still be CONNECTED, at this
-- school, with publishing on. One PENDING target per account.
CREATE FUNCTION hon.approve_school_social_post(p_subject text,p_post uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; p hon.school_social_posts%ROWTYPE;
  result jsonb; at timestamptz:=clock_timestamp(); due timestamptz; keys text[]; a hon.school_social_accounts%ROWTYPE;
BEGIN
  keys:=(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p_input)='object' THEN p_input ELSE '{}'::jsonb END) k);
  IF p_post IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR NOT keys<@ARRAY['expectedVersion','publishAt'] OR NOT 'expectedVersion'=ANY(keys)
    OR (p_input ? 'publishAt' AND jsonb_typeof(p_input->'publishAt') NOT IN ('string','null'))
    OR (jsonb_typeof(p_input->'publishAt')='string' AND (p_input->>'publishAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$') THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_input->'publishAt')='string' THEN
    BEGIN due:=(p_input->>'publishAt')::timestamptz; EXCEPTION WHEN others THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END;
    IF due<at-interval '1 minute' OR due>at+interval '90 days' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
    due:=greatest(due,at);
  ELSE due:=at; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.manage');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'POST_APPROVE',
    encode(sha256(convert_to('marketing.social.post.approve:'||p_post::text||':'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  p:=hon.school_social_post_for_change(org,school,p_post,p_input->'expectedVersion');
  IF p.status<>'DRAFT' THEN RAISE EXCEPTION 'SOCIAL_POST_STATE' USING ERRCODE='55000'; END IF;
  IF (SELECT count(*) FROM hon.school_social_accounts WHERE id=ANY(p.account_ids) AND organization_id=org AND school_id=school)<>cardinality(p.account_ids) THEN
    RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  FOR a IN SELECT * FROM hon.school_social_accounts WHERE id=ANY(p.account_ids) AND organization_id=org AND school_id=school ORDER BY id FOR SHARE LOOP
    IF a.status<>'CONNECTED' THEN RAISE EXCEPTION 'SOCIAL_ACCOUNT_DISCONNECTED' USING ERRCODE='23514'; END IF;
    IF a.platform='INSTAGRAM' THEN RAISE EXCEPTION 'SOCIAL_MEDIA_REQUIRED' USING ERRCODE='0A000'; END IF;
    IF NOT a.publish_enabled THEN RAISE EXCEPTION 'SOCIAL_PUBLISH_OFF' USING ERRCODE='23514'; END IF;
    INSERT INTO hon.school_social_post_targets(post_id,organization_id,school_id,account_id,status,due_at) VALUES(p.id,org,school,a.id,'PENDING',due);
  END LOOP;
  UPDATE hon.school_social_posts SET status='APPROVED',publish_at=due,approved_by_principal_id=actor,approved_at=at,version=version+1,updated_at=at
    WHERE id=p.id RETURNING * INTO p;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.post.approved','SCHOOL_SOCIAL_POST',p.id,p.version,
    jsonb_build_object('accounts',cardinality(p.account_ids),'scheduled',due>at),p_request,p_correlation);
  result:=hon.school_social_post_json(p);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- CANCEL {expectedVersion}: a DRAFT (marketing.social.post), or an APPROVED post while every target is still PENDING
-- (marketing.social.manage). Pending targets become CANCELLED.
CREATE FUNCTION hon.cancel_school_social_post(p_subject text,p_post uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; p hon.school_social_posts%ROWTYPE;
  result jsonb; permission text; at timestamptz:=clock_timestamp();
BEGIN
  IF p_post IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedVersion'] THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  -- The permission depends on the post's state, so read it first (the change re-reads it under lock).
  permission:=CASE WHEN (SELECT status FROM hon.school_social_posts WHERE id=p_post AND organization_id=org AND school_id=school)='DRAFT'
    THEN 'marketing.social.post' ELSE 'marketing.social.manage' END;
  actor:=hon.require_school_social_actor(p_subject,permission);
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'POST_CANCEL',
    encode(sha256(convert_to('marketing.social.post.cancel:'||p_post::text||':'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  p:=hon.school_social_post_for_change(org,school,p_post,p_input->'expectedVersion');
  IF p.status='CANCELLED' OR (p.status='APPROVED' AND permission<>'marketing.social.manage') THEN RAISE EXCEPTION 'SOCIAL_POST_STATE' USING ERRCODE='55000'; END IF;
  IF p.status='APPROVED' THEN
    PERFORM 1 FROM hon.school_social_post_targets WHERE post_id=p.id ORDER BY id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM hon.school_social_post_targets WHERE post_id=p.id AND status<>'PENDING') THEN RAISE EXCEPTION 'SOCIAL_POST_STATE' USING ERRCODE='55000'; END IF;
    UPDATE hon.school_social_post_targets SET status='CANCELLED',settled_at=at,version=version+1,updated_at=at WHERE post_id=p.id;
  END IF;
  UPDATE hon.school_social_posts SET status='CANCELLED',cancelled_by_principal_id=actor,cancelled_at=at,version=version+1,updated_at=at
    WHERE id=p.id RETURNING * INTO p;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.post.cancelled','SCHOOL_SOCIAL_POST',p.id,p.version,
    jsonb_build_object('wasApproved',p.approved_at IS NOT NULL),p_request,p_correlation);
  result:=hon.school_social_post_json(p);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,permission) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- RESOLVE an UNKNOWN target {outcome: PUBLISHED | NOT_PUBLISHED, expectedVersion}: a person checked the Page. HON
-- never sends it again either way.
CREATE FUNCTION hon.resolve_school_social_post_target(p_subject text,p_target uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; t hon.school_social_post_targets%ROWTYPE;
  p hon.school_social_posts%ROWTYPE; result jsonb; at timestamptz:=clock_timestamp();
BEGIN
  IF p_target IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedVersion','outcome']
    OR jsonb_typeof(p_input->'outcome') IS DISTINCT FROM 'string' OR (p_input->>'outcome') NOT IN ('PUBLISHED','NOT_PUBLISHED')
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.manage');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'POST_RESOLVE',
    encode(sha256(convert_to('marketing.social.post.resolve:'||p_target::text||':'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  SELECT * INTO t FROM hon.school_social_post_targets WHERE id=p_target AND organization_id=org AND school_id=school FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_POST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF t.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SOCIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF t.status<>'UNKNOWN' THEN RAISE EXCEPTION 'SOCIAL_POST_STATE' USING ERRCODE='55000'; END IF;
  UPDATE hon.school_social_post_targets SET status=CASE WHEN p_input->>'outcome'='PUBLISHED' THEN 'PUBLISHED' ELSE 'FAILED' END,
    failure_code=CASE WHEN p_input->>'outcome'='PUBLISHED' THEN NULL ELSE 'CONFIRMED_NOT_PUBLISHED' END,
    resolved_by_principal_id=actor,settled_at=at,version=version+1,updated_at=at WHERE id=t.id RETURNING * INTO t;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.post.target_resolved','SCHOOL_SOCIAL_POST_TARGET',t.id,t.version,
    jsonb_build_object('postId',t.post_id,'status',t.status),p_request,p_correlation);
  SELECT * INTO p FROM hon.school_social_posts WHERE id=t.post_id;
  result:=hon.school_social_post_json(p);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- ===== Worker (hon_communication_worker) =====

-- Identifier-only evidence written by the posting service principal.
CREATE FUNCTION hon.school_social_service_evidence(p_org uuid,p_school uuid,p_action text,p_entity_type text,p_entity uuid,p_version integer,p_state jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE req uuid:=gen_random_uuid();
BEGIN
  PERFORM 1 FROM hon.principals x WHERE x.id='00000000-0000-4000-8000-00000000c348' AND x.principal_type='SYSTEM_SERVICE' AND x.user_id IS NULL AND x.is_active FOR SHARE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM hon.principal_role_grants g WHERE g.principal_id='00000000-0000-4000-8000-00000000c348')
    OR EXISTS(SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id='00000000-0000-4000-8000-00000000c348')
    OR EXISTS(SELECT 1 FROM hon.family_access_grants g WHERE g.principal_id='00000000-0000-4000-8000-00000000c348') THEN
    RAISE EXCEPTION 'SOCIAL_SERVICE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(p_org,p_school,'00000000-0000-4000-8000-00000000c348','INTEGRATION',p_action,p_entity_type,p_entity,p_state,'SUCCEEDED',req,req);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(p_org,p_school,p_action,1,p_entity_type,p_entity,p_version,req,req,p_state||jsonb_build_object('internalOnly',true));
END $$;

-- CLAIM up to p_limit (1-25) due PENDING targets with a lease of p_lease_seconds (30-300). First, a PUBLISHING target
-- whose lease ran out becomes UNKNOWN (never claimed again). A due target whose account is no longer CONNECTED with
-- publishing on, or whose school, organization or HON entitlement is not active, becomes SKIPPED.
CREATE FUNCTION hon.claim_school_social_post_targets(p_limit integer,p_lease_seconds integer)
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
    IF p.status<>'APPROVED' OR NOT live OR a.status<>'CONNECTED' OR NOT a.publish_enabled OR a.platform<>'FACEBOOK'
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

-- RESULT for a leased target: PUBLISHED (with the provider post id), FAILED (PROVIDER_REJECTED) or UNKNOWN. Taken
-- while the target is PUBLISHING under this lease, or UNKNOWN only because this lease ran out (a late answer). A
-- provider post id already held by another target is not trusted, and the target stays UNKNOWN.
CREATE FUNCTION hon.record_school_social_post_result(p_target uuid,p_lease_token uuid,p_outcome text,p_provider_post_id text,p_failure_code text)
RETURNS TABLE(status text,accepted boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE t hon.school_social_post_targets%ROWTYPE; next_status text; at timestamptz:=clock_timestamp();
BEGIN
  IF p_target IS NULL OR p_lease_token IS NULL OR p_outcome NOT IN ('PUBLISHED','FAILED','UNKNOWN')
    OR (p_outcome='PUBLISHED' AND (p_provider_post_id IS NULL OR p_provider_post_id !~ '^[0-9A-Za-z_:.-]{1,128}$'))
    OR (p_outcome<>'PUBLISHED' AND p_provider_post_id IS NOT NULL)
    OR (p_outcome='FAILED') IS DISTINCT FROM coalesce(p_failure_code='PROVIDER_REJECTED',false) THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO t FROM hon.school_social_post_targets x WHERE x.id=p_target FOR UPDATE;
  IF t.id IS NULL OR t.lease_token IS DISTINCT FROM p_lease_token OR t.status NOT IN ('PUBLISHING','UNKNOWN') OR t.resolved_by_principal_id IS NOT NULL
    OR (t.status='UNKNOWN' AND p_outcome='UNKNOWN') THEN
    status:=t.status; accepted:=false; RETURN NEXT; RETURN;
  END IF;
  next_status:=p_outcome;
  IF p_outcome='PUBLISHED' AND EXISTS(SELECT 1 FROM hon.school_social_post_targets x WHERE x.provider_post_id=p_provider_post_id AND x.id<>t.id) THEN
    next_status:='UNKNOWN'; END IF;
  IF next_status=t.status THEN status:=t.status; accepted:=false; RETURN NEXT; RETURN; END IF;
  UPDATE hon.school_social_post_targets x SET status=next_status,
    provider_post_id=CASE WHEN next_status='PUBLISHED' THEN p_provider_post_id ELSE x.provider_post_id END,
    failure_code=CASE WHEN next_status='FAILED' THEN p_failure_code END,
    settled_at=CASE WHEN next_status IN ('PUBLISHED','FAILED') THEN at END,
    version=x.version+1,updated_at=at WHERE x.id=t.id RETURNING * INTO t;
  PERFORM hon.school_social_service_evidence(t.organization_id,t.school_id,'marketing.social.post.target_'||lower(t.status),'SCHOOL_SOCIAL_POST_TARGET',t.id,t.version,
    jsonb_build_object('postId',t.post_id));
  status:=t.status; accepted:=true; RETURN NEXT;
END $$;

-- RECEIPT: one verified Zernio event, once per event id. post.published / post.failed settle the target that holds
-- that provider post id on that platform account: a PUBLISHING or UNKNOWN target moves to the reported outcome, and a
-- PUBLISHED target moves to FAILED when Zernio later reports the platform refused it. A person's resolution stands and
-- nothing ever moves back to PUBLISHED from FAILED. account.disconnected turns the bound account DISCONNECTED with
-- every switch off.
CREATE FUNCTION hon.record_school_social_post_event(p_event_id text,p_event_type text,p_platform text,p_provider_account_id text,p_provider_post_id text)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE t hon.school_social_post_targets%ROWTYPE; a hon.school_social_accounts%ROWTYPE; result text; at timestamptz:=clock_timestamp();
BEGIN
  IF p_event_id IS NULL OR p_event_id !~ '^[0-9A-Za-z_:.-]{1,128}$' OR p_event_type NOT IN ('post.published','post.failed','account.disconnected')
    OR p_platform NOT IN ('FACEBOOK','INSTAGRAM') OR p_provider_account_id IS NULL OR p_provider_account_id !~ '^[0-9A-Za-z_-]{1,64}$'
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

DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['school_social_posts','school_social_post_targets','school_social_post_receipts'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','hon_communication_worker','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.require_school_social_actor(text,text)','hon.guard_school_social_post()','hon.school_social_post_json(hon.school_social_posts)',
    'hon.school_social_command_begin(uuid,uuid,uuid,text,text,text)','hon.school_social_command_finish(uuid,uuid,uuid,text,jsonb)',
    'hon.school_social_post_fields(uuid,uuid,jsonb,boolean)','hon.read_school_social_posts(text,timestamptz,timestamptz)',
    'hon.create_school_social_post(text,jsonb,text,uuid,uuid)','hon.school_social_post_for_change(uuid,uuid,uuid,jsonb)',
    'hon.edit_school_social_post(text,uuid,jsonb,text,uuid,uuid)','hon.approve_school_social_post(text,uuid,jsonb,text,uuid,uuid)',
    'hon.cancel_school_social_post(text,uuid,jsonb,text,uuid,uuid)','hon.resolve_school_social_post_target(text,uuid,jsonb,text,uuid,uuid)',
    'hon.school_social_service_evidence(uuid,uuid,text,text,uuid,integer,jsonb)','hon.claim_school_social_post_targets(integer,integer)',
    'hon.record_school_social_post_result(uuid,uuid,text,text,text)','hon.record_school_social_post_event(text,text,text,text,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','hon_communication_worker','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_social_posts(text,timestamptz,timestamptz),hon.create_school_social_post(text,jsonb,text,uuid,uuid),
      hon.edit_school_social_post(text,uuid,jsonb,text,uuid,uuid),hon.approve_school_social_post(text,uuid,jsonb,text,uuid,uuid),
      hon.cancel_school_social_post(text,uuid,jsonb,text,uuid,uuid),hon.resolve_school_social_post_target(text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.claim_school_social_post_targets(integer,integer),hon.record_school_social_post_result(uuid,uuid,text,text,text),
      hon.record_school_social_post_event(text,text,text,text,text) TO hon_communication_worker;
  END IF;
END $$;

COMMIT;
