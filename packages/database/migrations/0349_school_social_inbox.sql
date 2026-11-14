BEGIN;

-- S3 (0349, coordinator-allocated 2026-11-14): one school inbox for Messenger conversations, Instagram DMs and comments on
-- the school's own posts, through Zernio (docs/architecture/SOCIAL_POSTING_INBOX_ADS.md §4B). Builds on 0347/0348.
-- Nothing is received or sent unless the API server has HON_ZERNIO_INBOX_APPROVED=true and a Zernio key; tests use the
-- deterministic fake.
-- - Inbound messages arrive as signed Zernio receipts (worker role) and are stored only when the account is bound to a
--   school with its inbox switch on; otherwise not even the text is kept. Deduplicated by event id and provider id.
-- - Staff with marketing.social.inbox read, reply, hide or unhide comments, mark read, assign and link to a CRM lead or
--   person of the same school. A DM reply needs the person's last message within 24 hours (Meta's standard window).
-- - Each reply or comment action is sent at most once: the database records it as SENDING under a 60-second lease
--   before the API calls Zernio; a lost answer or a lease that ran out is UNKNOWN, never resent, and a person settles it.
-- - Message text is school-private CRM data and never enters audit or outbox. No Meta user id is stored.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.school_social_posts') IS NULL OR to_regprocedure('hon.school_social_command_begin(uuid,uuid,uuid,text,text,text)') IS NULL
    OR to_regclass('hon.crm_leads') IS NULL THEN RAISE EXCEPTION '0349 requires the 0347/0348 school social records and the CRM'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('marketing.social.inbox','Read and answer the school''s Facebook and Instagram messages and comments, and link them to CRM leads',true,true)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,'marketing.social.inbox' FROM hon.roles r WHERE r.code='OWNER' AND r.is_system_role
  ON CONFLICT (role_id,permission_code) DO NOTHING;

-- The grant-free system service that records inbound Zernio messages.
INSERT INTO hon.principals (id,principal_type,user_id,display_name,is_active)
VALUES ('00000000-0000-4000-8000-00000000c349','SYSTEM_SERVICE',NULL,'Zernio social inbox',true);

ALTER TABLE hon.school_social_commands DROP CONSTRAINT school_social_commands_operation_check;
ALTER TABLE hon.school_social_commands ADD CONSTRAINT school_social_commands_operation_check
  CHECK (operation IN ('CHANGE','POST_CREATE','POST_EDIT','POST_APPROVE','POST_CANCEL','POST_RESOLVE',
    'INBOX_REPLY','INBOX_CHANGE','INBOX_RESOLVE','INBOX_COMMENT'));

CREATE TABLE hon.school_social_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES hon.school_social_accounts(id),
  kind text NOT NULL CHECK (kind IN ('DM','COMMENT')),
  provider_conversation_id text NOT NULL CHECK (provider_conversation_id ~ '^[0-9A-Za-z_:.-]{1,128}$'),
  provider_post_id text CHECK (provider_post_id IS NULL OR provider_post_id ~ '^[0-9A-Za-z_:.-]{1,128}$'),
  participant_name text NOT NULL CHECK (length(participant_name) BETWEEN 1 AND 120 AND participant_name !~ '[[:cntrl:]]'),
  last_inbound_at timestamptz,
  last_message_at timestamptz NOT NULL,
  unread integer NOT NULL DEFAULT 0 CHECK (unread BETWEEN 0 AND 100000),
  assigned_principal_id uuid REFERENCES hon.principals(id),
  linked_lead_id uuid REFERENCES hon.crm_leads(id),
  linked_person_id uuid REFERENCES hon.people(id),
  comment_hidden boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id,provider_conversation_id),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK (kind='COMMENT' OR NOT comment_hidden),
  CHECK ((kind='COMMENT')=(provider_post_id IS NOT NULL))
);
CREATE INDEX school_social_conversations_school_idx ON hon.school_social_conversations (organization_id,school_id,last_message_at DESC,id DESC);

CREATE TABLE hon.school_social_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES hon.school_social_accounts(id),
  direction text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000 AND btrim(body)<>'' AND body !~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]'),
  provider_message_id text CHECK (provider_message_id IS NULL OR provider_message_id ~ '^[0-9A-Za-z_:.-]{1,128}$'),
  sent_by_principal_id uuid REFERENCES hon.principals(id),
  send_status text CHECK (send_status IN ('SENDING','SENT','FAILED','UNKNOWN')),
  lease_token uuid, lease_expires_at timestamptz,
  resolved_by_principal_id uuid REFERENCES hon.principals(id),
  occurred_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id,provider_message_id),
  FOREIGN KEY (conversation_id,organization_id,school_id) REFERENCES hon.school_social_conversations(id,organization_id,school_id),
  CHECK ((direction='INBOUND')=(send_status IS NULL) AND (direction='INBOUND')=(sent_by_principal_id IS NULL)),
  CHECK ((direction='OUTBOUND')=(lease_token IS NOT NULL) AND (direction='OUTBOUND')=(lease_expires_at IS NOT NULL)),
  CHECK (direction='OUTBOUND' OR provider_message_id IS NOT NULL),
  CHECK (send_status IS DISTINCT FROM 'SENT' OR provider_message_id IS NOT NULL OR resolved_by_principal_id IS NOT NULL)
);
CREATE INDEX school_social_messages_conversation_idx ON hon.school_social_messages (conversation_id,occurred_at DESC,id DESC);

-- One HIDE / UNHIDE request on a comment conversation, sent at most once.
CREATE TABLE hon.school_social_comment_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('HIDE','UNHIDE')),
  status text NOT NULL CHECK (status IN ('SENDING','DONE','FAILED','UNKNOWN')),
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  lease_token uuid NOT NULL, lease_expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id,organization_id,school_id) REFERENCES hon.school_social_conversations(id,organization_id,school_id)
);
CREATE UNIQUE INDEX school_social_comment_actions_open_idx ON hon.school_social_comment_actions (conversation_id) WHERE status='SENDING';

CREATE TABLE hon.school_social_inbox_receipts (
  event_id text PRIMARY KEY CHECK (event_id ~ '^[0-9A-Za-z_:.-]{1,128}$'),
  event_type text NOT NULL CHECK (event_type IN ('message.received','comment.received')),
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','IGNORED','UNMATCHED','DUPLICATE')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_social_conversations','school_social_messages','school_social_comment_actions','school_social_inbox_receipts'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

-- A conversation keeps its school, account, kind and provider ids. A message keeps its conversation, direction, text
-- and time; an outbound message moves once SENDING -> SENT | FAILED | UNKNOWN (UNKNOWN -> SENT | FAILED only by a late
-- answer under its own lease or a person). A comment action moves once SENDING -> DONE | FAILED | UNKNOWN. Receipts never
-- change. Nothing is deleted or truncated.
CREATE FUNCTION hon.guard_school_social_inbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='school_social_conversations' THEN
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.account_id,NEW.kind,NEW.provider_conversation_id,NEW.provider_post_id,NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.account_id,OLD.kind,OLD.provider_conversation_id,OLD.provider_post_id,OLD.created_at)
      AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='school_social_messages' THEN
    IF (NEW.id,NEW.conversation_id,NEW.organization_id,NEW.school_id,NEW.account_id,NEW.direction,NEW.body,NEW.sent_by_principal_id,NEW.occurred_at,NEW.created_at,NEW.lease_token,NEW.lease_expires_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.conversation_id,OLD.organization_id,OLD.school_id,OLD.account_id,OLD.direction,OLD.body,OLD.sent_by_principal_id,OLD.occurred_at,OLD.created_at,OLD.lease_token,OLD.lease_expires_at)
      AND OLD.direction='OUTBOUND' AND NEW.version=OLD.version+1
      AND ((OLD.send_status='SENDING' AND NEW.send_status IN ('SENT','FAILED','UNKNOWN'))
        OR (OLD.send_status='UNKNOWN' AND NEW.send_status IN ('SENT','FAILED')))
      AND (OLD.provider_message_id IS NULL OR NEW.provider_message_id=OLD.provider_message_id) THEN RETURN NEW; END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='school_social_comment_actions' THEN
    IF (NEW.id,NEW.conversation_id,NEW.organization_id,NEW.school_id,NEW.action,NEW.requested_by_principal_id,NEW.lease_token,NEW.lease_expires_at,NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.conversation_id,OLD.organization_id,OLD.school_id,OLD.action,OLD.requested_by_principal_id,OLD.lease_token,OLD.lease_expires_at,OLD.created_at)
      AND NEW.version=OLD.version+1 AND OLD.status='SENDING' AND NEW.status IN ('DONE','FAILED','UNKNOWN') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'SOCIAL_RECORD_IMMUTABLE' USING ERRCODE='42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_social_conversations','school_social_messages','school_social_comment_actions','school_social_inbox_receipts'] LOOP
    EXECUTE format('CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_school_social_inbox()',t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_social_inbox()',t);
  END LOOP;
END $$;

-- 0349 adds marketing.social.inbox to the permissions the 0347 actor check accepts (otherwise unchanged).
CREATE OR REPLACE FUNCTION hon.require_school_social_actor(p_subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF p_permission NOT IN ('marketing.social.manage','marketing.social.read','marketing.social.post','marketing.social.inbox')
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

CREATE FUNCTION hon.school_social_message_json(m hon.school_social_messages) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('messageId',m.id,'direction',m.direction,'text',m.body,
    -- A send whose lease ran out without an answer reads as UNKNOWN: it is never resent.
    'status',CASE WHEN m.direction='INBOUND' THEN 'RECEIVED' WHEN m.send_status='SENDING' AND m.lease_expires_at<=clock_timestamp() THEN 'UNKNOWN' ELSE m.send_status END,
    'sentByPerson',m.sent_by_principal_id IS NOT NULL,'resolvedByPerson',m.resolved_by_principal_id IS NOT NULL,
    'occurredAt',hon.saas_ts(m.occurred_at),'version',m.version);
$$;

CREATE FUNCTION hon.school_social_conversation_json(c hon.school_social_conversations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('conversationId',c.id,'accountId',c.account_id,'platform',a.platform,'accountName',a.display_name,'kind',c.kind,
    'participantName',c.participant_name,'lastInboundAt',hon.saas_ts(c.last_inbound_at),'lastMessageAt',hon.saas_ts(c.last_message_at),
    'unread',c.unread,'assignedPrincipalId',c.assigned_principal_id,'linkedLeadId',c.linked_lead_id,'linkedPersonId',c.linked_person_id,
    'commentHidden',c.comment_hidden,'inboxOn',a.status='CONNECTED' AND a.inbox_enabled,
    'replyWindowOpen',c.kind='COMMENT' OR (c.last_inbound_at IS NOT NULL AND c.last_inbound_at>clock_timestamp()-interval '24 hours'),
    'preview',(SELECT left(m.body,140) FROM hon.school_social_messages m WHERE m.conversation_id=c.id ORDER BY m.occurred_at DESC,m.id DESC LIMIT 1),
    'version',c.version)
  FROM hon.school_social_accounts a WHERE a.id=c.account_id;
$$;

CREATE FUNCTION hon.school_social_inbox_evidence(p_org uuid,p_school uuid,p_actor uuid,p_action text,p_entity_type text,p_entity uuid,p_version integer,p_state jsonb,p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $$
  SELECT hon.school_social_evidence(p_org,p_school,p_actor,p_action,p_entity_type,p_entity,p_version,p_state,p_request,p_correlation);
$$;

-- READ the inbox {view: ALL | UNREAD | MINE, before?: ISO time}: at most 50 conversations, newest activity first.
CREATE FUNCTION hon.read_school_social_inbox(p_subject text,p_filter jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; v_before timestamptz; rows jsonb;
BEGIN
  IF p_filter IS NULL OR jsonb_typeof(p_filter)<>'object' OR NOT (SELECT coalesce(array_agg(k),'{}') FROM jsonb_object_keys(p_filter) k)<@ARRAY['before','view']
    OR (p_filter->>'view') NOT IN ('ALL','UNREAD','MINE')
    OR (p_filter ? 'before' AND (jsonb_typeof(p_filter->'before')<>'string' OR (p_filter->>'before') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$')) THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  IF p_filter ? 'before' THEN BEGIN v_before:=(p_filter->>'before')::timestamptz; EXCEPTION WHEN others THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END; END IF;
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.inbox');
  SELECT coalesce(jsonb_agg(hon.school_social_conversation_json(x) ORDER BY x.last_message_at DESC,x.id DESC),'[]'::jsonb) INTO rows
    FROM (SELECT * FROM hon.school_social_conversations c WHERE c.organization_id=org AND c.school_id=school
      AND (v_before IS NULL OR c.last_message_at<v_before)
      AND (p_filter->>'view'<>'UNREAD' OR c.unread>0) AND (p_filter->>'view'<>'MINE' OR c.assigned_principal_id=actor)
      ORDER BY c.last_message_at DESC,c.id DESC LIMIT 50) x;
  RETURN jsonb_build_object('conversations',rows,'checkedAt',hon.saas_ts(clock_timestamp()));
END $$;

-- The school's conversation (locked when p_lock).
CREATE FUNCTION hon.school_social_conversation_at(p_org uuid,p_school uuid,p_conversation uuid,p_lock boolean) RETURNS hon.school_social_conversations
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE c hon.school_social_conversations%ROWTYPE;
BEGIN
  IF p_lock THEN SELECT * INTO c FROM hon.school_social_conversations WHERE id=p_conversation AND organization_id=p_org AND school_id=p_school FOR UPDATE;
  ELSE SELECT * INTO c FROM hon.school_social_conversations WHERE id=p_conversation AND organization_id=p_org AND school_id=p_school; END IF;
  IF c.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_CONVERSATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN c;
END $$;

-- READ one conversation and its last 200 messages, oldest first.
CREATE FUNCTION hon.read_school_social_conversation(p_subject text,p_conversation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); c hon.school_social_conversations%ROWTYPE;
BEGIN
  IF p_conversation IS NULL THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.require_school_social_actor(p_subject,'marketing.social.inbox');
  c:=hon.school_social_conversation_at(org,school,p_conversation,false);
  RETURN jsonb_build_object('conversation',hon.school_social_conversation_json(c),
    'messages',coalesce((SELECT jsonb_agg(hon.school_social_message_json(x) ORDER BY x.occurred_at,x.id) FROM
      (SELECT * FROM hon.school_social_messages m WHERE m.conversation_id=c.id ORDER BY m.occurred_at DESC,m.id DESC LIMIT 200) x),'[]'::jsonb),
    'checkedAt',hon.saas_ts(clock_timestamp()));
END $$;

-- CHANGE {expectedVersion, read?: true, assignedPrincipalId?: uuid|null, linkedLeadId?: uuid|null, linkedPersonId?: uuid|null}.
-- At least one change. The assignee must be an eligible staff member here; a lead or person must belong to this school.
CREATE FUNCTION hon.change_school_social_conversation(p_subject text,p_conversation uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; c hon.school_social_conversations%ROWTYPE;
  keys text[]; result jsonb; v uuid; k text;
BEGIN
  keys:=(SELECT coalesce(array_agg(x ORDER BY x),'{}') FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p_input)='object' THEN p_input ELSE '{}'::jsonb END) x);
  IF p_conversation IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR NOT keys<@ARRAY['assignedPrincipalId','expectedVersion','linkedLeadId','linkedPersonId','read']
    OR NOT 'expectedVersion'=ANY(keys) OR cardinality(keys)<2
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR (p_input ? 'read' AND (p_input->'read') IS DISTINCT FROM 'true'::jsonb) THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  FOREACH k IN ARRAY ARRAY['assignedPrincipalId','linkedLeadId','linkedPersonId'] LOOP
    IF p_input ? k AND NOT (jsonb_typeof(p_input->k)='null' OR (jsonb_typeof(p_input->k)='string'
      AND (p_input->>k) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.inbox');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'INBOX_CHANGE',
    encode(sha256(convert_to('marketing.social.inbox.change:'||p_conversation::text||':'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  c:=hon.school_social_conversation_at(org,school,p_conversation,true);
  IF c.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SOCIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p_input ? 'assignedPrincipalId' AND jsonb_typeof(p_input->'assignedPrincipalId')='string' THEN
    v:=(p_input->>'assignedPrincipalId')::uuid;
    IF NOT EXISTS(SELECT 1 FROM hon.principals p WHERE p.id=v AND p.principal_type='HUMAN_USER' AND p.is_active) OR NOT hon.staff_member_eligible(v,org,school)
      OR EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=v)
      -- Someone who is also a parent, guardian, student or family member is never an inbox assignee (same rule as the actor check).
      OR EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=v AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
      OR EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
        WHERE g.principal_id=v AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
          AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)') THEN RAISE EXCEPTION 'SOCIAL_ASSIGNEE_INVALID' USING ERRCODE='22023'; END IF;
  END IF;
  IF jsonb_typeof(p_input->'linkedLeadId')='string' AND NOT EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.id=(p_input->>'linkedLeadId')::uuid AND l.organization_id=org AND l.school_id=school) THEN
    RAISE EXCEPTION 'SOCIAL_LINK_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF jsonb_typeof(p_input->'linkedPersonId')='string' AND NOT EXISTS(SELECT 1 FROM hon.people x WHERE x.id=(p_input->>'linkedPersonId')::uuid AND x.organization_id=org AND x.school_id=school) THEN
    RAISE EXCEPTION 'SOCIAL_LINK_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  UPDATE hon.school_social_conversations SET
    unread=CASE WHEN p_input ? 'read' THEN 0 ELSE unread END,
    assigned_principal_id=CASE WHEN p_input ? 'assignedPrincipalId' THEN (p_input->>'assignedPrincipalId')::uuid ELSE assigned_principal_id END,
    linked_lead_id=CASE WHEN p_input ? 'linkedLeadId' THEN (p_input->>'linkedLeadId')::uuid ELSE linked_lead_id END,
    linked_person_id=CASE WHEN p_input ? 'linkedPersonId' THEN (p_input->>'linkedPersonId')::uuid ELSE linked_person_id END,
    version=version+1,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
  PERFORM hon.school_social_inbox_evidence(org,school,actor,'marketing.social.inbox.changed','SCHOOL_SOCIAL_CONVERSATION',c.id,c.version,
    jsonb_build_object('read',p_input ? 'read','assigned',c.assigned_principal_id IS NOT NULL,'linkedLead',c.linked_lead_id IS NOT NULL,'linkedPerson',c.linked_person_id IS NOT NULL),
    p_request,p_correlation);
  result:=hon.school_social_conversation_json(c);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.inbox') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- REPLY {text}: records the outbound message as SENDING under a 60-second lease and hands the API what Zernio needs to
-- send it once. A replay returns the recorded message with no send. The account must still be CONNECTED with inbox on;
-- a DM needs the person's last message within 24 hours.
CREATE FUNCTION hon.start_school_social_reply(p_subject text,p_conversation uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; c hon.school_social_conversations%ROWTYPE;
  a hon.school_social_accounts%ROWTYPE; m hon.school_social_messages%ROWTYPE; at timestamptz:=clock_timestamp(); result jsonb;
BEGIN
  IF p_conversation IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['text']
    OR jsonb_typeof(p_input->'text') IS DISTINCT FROM 'string' OR length(p_input->>'text') NOT BETWEEN 1 AND 2000 OR btrim(p_input->>'text')=''
    OR (p_input->>'text') ~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.inbox');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'INBOX_REPLY',
    encode(sha256(convert_to('marketing.social.inbox.reply:'||p_conversation::text||':'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  c:=hon.school_social_conversation_at(org,school,p_conversation,true);
  SELECT * INTO a FROM hon.school_social_accounts WHERE id=c.account_id FOR SHARE;
  IF a.status<>'CONNECTED' OR NOT a.inbox_enabled OR a.organization_id<>org OR a.school_id<>school THEN RAISE EXCEPTION 'SOCIAL_INBOX_OFF' USING ERRCODE='23514'; END IF;
  IF c.kind='DM' AND (c.last_inbound_at IS NULL OR c.last_inbound_at<=at-interval '24 hours') THEN RAISE EXCEPTION 'SOCIAL_REPLY_WINDOW_CLOSED' USING ERRCODE='55000'; END IF;
  INSERT INTO hon.school_social_messages(conversation_id,organization_id,school_id,account_id,direction,body,sent_by_principal_id,send_status,lease_token,lease_expires_at,occurred_at)
    VALUES(c.id,org,school,a.id,'OUTBOUND',p_input->>'text',actor,'SENDING',gen_random_uuid(),at+interval '60 seconds',at) RETURNING * INTO m;
  UPDATE hon.school_social_conversations SET last_message_at=at,unread=0,version=version+1,updated_at=at WHERE id=c.id RETURNING * INTO c;
  PERFORM hon.school_social_inbox_evidence(org,school,actor,'marketing.social.inbox.reply_started','SCHOOL_SOCIAL_MESSAGE',m.id,m.version,
    jsonb_build_object('conversationId',c.id,'kind',c.kind),p_request,p_correlation);
  result:=jsonb_build_object('conversation',hon.school_social_conversation_json(c),'message',hon.school_social_message_json(m));
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.inbox') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false,'send',jsonb_build_object('messageId',m.id,'leaseToken',m.lease_token,'platform',a.platform,'kind',c.kind,
    'providerAccountId',a.provider_account_id,'providerConversationId',c.provider_conversation_id));
END $$;

-- RESULT of one reply send: SENT (with the provider id), FAILED or UNKNOWN, only under that message's own lease token
-- and only while it is SENDING or UNKNOWN (a late answer). A provider id already used on the account stays UNKNOWN.
CREATE FUNCTION hon.record_school_social_reply_result(p_subject text,p_message uuid,p_lease_token uuid,p_outcome text,p_provider_message_id text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; m hon.school_social_messages%ROWTYPE; next_status text; accepted boolean:=false;
BEGIN
  IF p_message IS NULL OR p_lease_token IS NULL OR p_outcome NOT IN ('SENT','FAILED','UNKNOWN')
    OR (p_outcome='SENT') IS DISTINCT FROM (p_provider_message_id IS NOT NULL)
    OR (p_provider_message_id IS NOT NULL AND p_provider_message_id !~ '^[0-9A-Za-z_:.-]{1,128}$') THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.inbox');
  SELECT * INTO m FROM hon.school_social_messages WHERE id=p_message AND organization_id=org AND school_id=school FOR UPDATE;
  IF m.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_MESSAGE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF m.lease_token=p_lease_token AND m.resolved_by_principal_id IS NULL AND (m.send_status='SENDING' OR (m.send_status='UNKNOWN' AND p_outcome<>'UNKNOWN')) THEN
    next_status:=p_outcome;
    IF p_outcome='SENT' AND EXISTS(SELECT 1 FROM hon.school_social_messages x WHERE x.account_id=m.account_id AND x.provider_message_id=p_provider_message_id) THEN next_status:='UNKNOWN'; END IF;
    IF next_status<>m.send_status THEN
      UPDATE hon.school_social_messages SET send_status=next_status,provider_message_id=CASE WHEN next_status='SENT' THEN p_provider_message_id END,
        version=version+1,updated_at=clock_timestamp() WHERE id=m.id RETURNING * INTO m;
      PERFORM hon.school_social_inbox_evidence(org,school,actor,'marketing.social.inbox.reply_'||lower(m.send_status),'SCHOOL_SOCIAL_MESSAGE',m.id,m.version,
        jsonb_build_object('conversationId',m.conversation_id),p_request,p_correlation);
      accepted:=true;
    END IF;
  END IF;
  RETURN jsonb_build_object('message',hon.school_social_message_json(m),'accepted',accepted);
END $$;

-- RESOLVE an UNKNOWN reply {outcome: SENT | NOT_SENT, expectedVersion}: a person checked Messenger or Instagram. HON never
-- resends it either way. A SENDING reply whose lease ran out counts as UNKNOWN.
CREATE FUNCTION hon.resolve_school_social_message(p_subject text,p_message uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; m hon.school_social_messages%ROWTYPE; result jsonb;
BEGIN
  IF p_message IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedVersion','outcome']
    OR (p_input->>'outcome') NOT IN ('SENT','NOT_SENT') OR jsonb_typeof(p_input->'outcome')<>'string'
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.inbox');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'INBOX_RESOLVE',
    encode(sha256(convert_to('marketing.social.inbox.resolve:'||p_message::text||':'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  SELECT * INTO m FROM hon.school_social_messages WHERE id=p_message AND organization_id=org AND school_id=school FOR UPDATE;
  IF m.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_MESSAGE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF m.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SOCIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF m.direction<>'OUTBOUND' OR NOT coalesce(m.send_status='UNKNOWN' OR (m.send_status='SENDING' AND m.lease_expires_at<=clock_timestamp()),false) THEN
    RAISE EXCEPTION 'SOCIAL_INBOX_STATE' USING ERRCODE='55000'; END IF;
  IF m.send_status='SENDING' THEN
    UPDATE hon.school_social_messages SET send_status='UNKNOWN',version=version+1,updated_at=clock_timestamp() WHERE id=m.id RETURNING * INTO m;
  END IF;
  UPDATE hon.school_social_messages SET send_status=CASE WHEN p_input->>'outcome'='SENT' THEN 'SENT' ELSE 'FAILED' END,resolved_by_principal_id=actor,
    version=version+1,updated_at=clock_timestamp() WHERE id=m.id RETURNING * INTO m;
  PERFORM hon.school_social_inbox_evidence(org,school,actor,'marketing.social.inbox.reply_resolved','SCHOOL_SOCIAL_MESSAGE',m.id,m.version,
    jsonb_build_object('conversationId',m.conversation_id,'status',m.send_status),p_request,p_correlation);
  result:=hon.school_social_message_json(m);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.inbox') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- COMMENT ACTION {action: HIDE | UNHIDE}: one open action per comment conversation, sent at most once.
CREATE FUNCTION hon.start_school_social_comment_action(p_subject text,p_conversation uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; c hon.school_social_conversations%ROWTYPE;
  a hon.school_social_accounts%ROWTYPE; x hon.school_social_comment_actions%ROWTYPE; at timestamptz:=clock_timestamp(); result jsonb;
BEGIN
  IF p_conversation IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['action']
    OR jsonb_typeof(p_input->'action')<>'string' OR (p_input->>'action') NOT IN ('HIDE','UNHIDE') THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.inbox');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'INBOX_COMMENT',
    encode(sha256(convert_to('marketing.social.inbox.comment:'||p_conversation::text||':'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  c:=hon.school_social_conversation_at(org,school,p_conversation,true);
  IF c.kind<>'COMMENT' OR c.comment_hidden=((p_input->>'action')='HIDE') THEN RAISE EXCEPTION 'SOCIAL_INBOX_STATE' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM hon.school_social_comment_actions y WHERE y.conversation_id=c.id AND y.status='SENDING' AND y.lease_expires_at>at) THEN
    RAISE EXCEPTION 'SOCIAL_BUSY' USING ERRCODE='55P03'; END IF;
  -- An earlier action whose lease ran out without an answer becomes UNKNOWN before the next one starts.
  UPDATE hon.school_social_comment_actions SET status='UNKNOWN',version=version+1,updated_at=at WHERE conversation_id=c.id AND status='SENDING';
  SELECT * INTO a FROM hon.school_social_accounts WHERE id=c.account_id FOR SHARE;
  IF a.status<>'CONNECTED' OR NOT a.inbox_enabled THEN RAISE EXCEPTION 'SOCIAL_INBOX_OFF' USING ERRCODE='23514'; END IF;
  INSERT INTO hon.school_social_comment_actions(conversation_id,organization_id,school_id,action,status,requested_by_principal_id,lease_token,lease_expires_at)
    VALUES(c.id,org,school,p_input->>'action','SENDING',actor,gen_random_uuid(),at+interval '60 seconds') RETURNING * INTO x;
  PERFORM hon.school_social_inbox_evidence(org,school,actor,'marketing.social.inbox.comment_action_started','SCHOOL_SOCIAL_CONVERSATION',c.id,c.version,
    jsonb_build_object('action',x.action,'actionId',x.id),p_request,p_correlation);
  result:=jsonb_build_object('conversation',hon.school_social_conversation_json(c),'actionId',x.id,'action',x.action,'status',x.status);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.inbox') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false,'send',jsonb_build_object('actionId',x.id,'leaseToken',x.lease_token,'platform',a.platform,
    'providerAccountId',a.provider_account_id,'providerCommentId',c.provider_conversation_id,'hidden',x.action='HIDE'));
END $$;

-- RESULT of one comment action: DONE (the conversation then records the hidden state), FAILED or UNKNOWN, only under
-- its own lease token and only while SENDING.
CREATE FUNCTION hon.record_school_social_comment_action_result(p_subject text,p_action uuid,p_lease_token uuid,p_outcome text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; x hon.school_social_comment_actions%ROWTYPE;
  c hon.school_social_conversations%ROWTYPE; accepted boolean:=false;
BEGIN
  IF p_action IS NULL OR p_lease_token IS NULL OR p_outcome NOT IN ('DONE','FAILED','UNKNOWN') THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.inbox');
  -- Lock order: the conversation, then its action (the same order start_school_social_comment_action takes).
  SELECT * INTO x FROM hon.school_social_comment_actions WHERE id=p_action AND organization_id=org AND school_id=school;
  IF x.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_MESSAGE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  c:=hon.school_social_conversation_at(org,school,x.conversation_id,true);
  SELECT * INTO x FROM hon.school_social_comment_actions WHERE id=p_action FOR UPDATE;
  IF x.lease_token=p_lease_token AND x.status='SENDING' THEN
    UPDATE hon.school_social_comment_actions SET status=p_outcome,version=version+1,updated_at=clock_timestamp() WHERE id=x.id RETURNING * INTO x;
    IF p_outcome='DONE' THEN
      UPDATE hon.school_social_conversations SET comment_hidden=(x.action='HIDE'),version=version+1,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
    END IF;
    PERFORM hon.school_social_inbox_evidence(org,school,actor,'marketing.social.inbox.comment_action_'||lower(x.status),'SCHOOL_SOCIAL_CONVERSATION',c.id,c.version,
      jsonb_build_object('action',x.action,'actionId',x.id),p_request,p_correlation);
    accepted:=true;
  END IF;
  RETURN jsonb_build_object('conversation',hon.school_social_conversation_json(c),'actionId',x.id,'action',x.action,'status',x.status,'accepted',accepted);
END $$;

-- RECEIPT (worker role): one verified Zernio message.received / comment.received event. Stored only for an account bound
-- to a school with its inbox switch on; otherwise IGNORED with nothing kept. Deduplicated by event id and by the
-- provider message id on the account.
CREATE FUNCTION hon.record_school_social_inbox_event(p_event_id text,p_event_type text,p_platform text,p_provider_account_id text,
  p_provider_conversation_id text,p_provider_message_id text,p_provider_post_id text,p_participant_name text,p_body text,p_occurred_at timestamptz)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE a hon.school_social_accounts%ROWTYPE; c hon.school_social_conversations%ROWTYPE; m hon.school_social_messages%ROWTYPE; result text;
  at timestamptz:=clock_timestamp(); req uuid:=gen_random_uuid(); v_kind text; v_time timestamptz;
BEGIN
  IF p_event_id IS NULL OR p_event_id !~ '^[0-9A-Za-z_:.-]{1,128}$' OR p_event_type NOT IN ('message.received','comment.received')
    OR p_platform NOT IN ('FACEBOOK','INSTAGRAM') OR p_provider_account_id IS NULL OR p_provider_account_id !~ '^[0-9A-Za-z_-]{1,64}$'
    OR p_provider_conversation_id IS NULL OR p_provider_conversation_id !~ '^[0-9A-Za-z_:.-]{1,128}$'
    OR p_provider_message_id IS NULL OR p_provider_message_id !~ '^[0-9A-Za-z_:.-]{1,128}$'
    OR (p_event_type='comment.received') IS DISTINCT FROM (p_provider_post_id IS NOT NULL)
    OR (p_provider_post_id IS NOT NULL AND p_provider_post_id !~ '^[0-9A-Za-z_:.-]{1,128}$')
    OR p_participant_name IS NULL OR length(p_participant_name) NOT BETWEEN 1 AND 120 OR p_participant_name ~ '[[:cntrl:]]'
    OR p_body IS NULL OR length(p_body) NOT BETWEEN 1 AND 2000 OR btrim(p_body)='' OR p_body ~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]'
    OR p_occurred_at IS NULL THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  -- A provider time in the future, or long past, is replaced by the receipt time.
  v_time:=CASE WHEN p_occurred_at>at OR p_occurred_at<at-interval '7 days' THEN at ELSE p_occurred_at END;
  v_kind:=CASE WHEN p_event_type='comment.received' THEN 'COMMENT' ELSE 'DM' END;
  PERFORM pg_advisory_xact_lock(hashtextextended('social-inbox-receipt:'||p_event_id,0));
  IF EXISTS(SELECT 1 FROM hon.school_social_inbox_receipts r WHERE r.event_id=p_event_id) THEN outcome:='REPLAYED'; RETURN NEXT; RETURN; END IF;
  SELECT * INTO a FROM hon.school_social_accounts x WHERE x.platform=p_platform AND x.provider_account_id=p_provider_account_id FOR SHARE;
  IF a.id IS NULL THEN result:='UNMATCHED';
  ELSIF a.status<>'CONNECTED' OR NOT a.inbox_enabled THEN result:='IGNORED';
  ELSIF EXISTS(SELECT 1 FROM hon.school_social_messages x WHERE x.account_id=a.id AND x.provider_message_id=p_provider_message_id) THEN result:='DUPLICATE';
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('social-conversation:'||a.id::text||':'||p_provider_conversation_id,0));
    SELECT * INTO c FROM hon.school_social_conversations x WHERE x.account_id=a.id AND x.provider_conversation_id=p_provider_conversation_id FOR UPDATE;
    IF c.id IS NULL THEN
      INSERT INTO hon.school_social_conversations(organization_id,school_id,account_id,kind,provider_conversation_id,provider_post_id,participant_name,last_inbound_at,last_message_at,unread)
        VALUES(a.organization_id,a.school_id,a.id,v_kind,p_provider_conversation_id,p_provider_post_id,p_participant_name,v_time,v_time,1) RETURNING * INTO c;
    ELSIF c.kind<>v_kind THEN result:='IGNORED';
    ELSE
      UPDATE hon.school_social_conversations x SET participant_name=p_participant_name,last_inbound_at=greatest(coalesce(x.last_inbound_at,v_time),v_time),
        last_message_at=greatest(x.last_message_at,v_time),unread=least(x.unread+1,100000),version=x.version+1,updated_at=at WHERE x.id=c.id RETURNING * INTO c;
    END IF;
    IF result IS NULL THEN
      INSERT INTO hon.school_social_messages(conversation_id,organization_id,school_id,account_id,direction,body,provider_message_id,occurred_at)
        VALUES(c.id,c.organization_id,c.school_id,a.id,'INBOUND',p_body,p_provider_message_id,v_time) RETURNING * INTO m;
      PERFORM 1 FROM hon.principals x WHERE x.id='00000000-0000-4000-8000-00000000c349' AND x.principal_type='SYSTEM_SERVICE' AND x.user_id IS NULL AND x.is_active FOR SHARE;
      IF NOT FOUND OR EXISTS(SELECT 1 FROM hon.principal_role_grants g WHERE g.principal_id='00000000-0000-4000-8000-00000000c349')
        OR EXISTS(SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id='00000000-0000-4000-8000-00000000c349')
        OR EXISTS(SELECT 1 FROM hon.family_access_grants g WHERE g.principal_id='00000000-0000-4000-8000-00000000c349') THEN
        RAISE EXCEPTION 'SOCIAL_SERVICE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
      INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
        VALUES(c.organization_id,c.school_id,'00000000-0000-4000-8000-00000000c349','INTEGRATION','marketing.social.inbox.received','SCHOOL_SOCIAL_MESSAGE',m.id,
          jsonb_build_object('conversationId',c.id,'kind',c.kind),'SUCCEEDED',req,req);
      INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
        VALUES(c.organization_id,c.school_id,'marketing.social.inbox.received',1,'SCHOOL_SOCIAL_CONVERSATION',c.id,c.version,req,req,
          jsonb_build_object('conversationId',c.id,'messageId',m.id,'kind',c.kind,'internalOnly',true));
      result:='APPLIED';
    END IF;
  END IF;
  INSERT INTO hon.school_social_inbox_receipts(event_id,event_type,outcome) VALUES(p_event_id,p_event_type,result);
  outcome:=result; RETURN NEXT;
END $$;

DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['school_social_conversations','school_social_messages','school_social_comment_actions','school_social_inbox_receipts'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','hon_communication_worker','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.require_school_social_actor(text,text)','hon.guard_school_social_inbox()',
    'hon.school_social_message_json(hon.school_social_messages)','hon.school_social_conversation_json(hon.school_social_conversations)',
    'hon.school_social_inbox_evidence(uuid,uuid,uuid,text,text,uuid,integer,jsonb,uuid,uuid)','hon.read_school_social_inbox(text,jsonb)',
    'hon.school_social_conversation_at(uuid,uuid,uuid,boolean)','hon.read_school_social_conversation(text,uuid)',
    'hon.change_school_social_conversation(text,uuid,jsonb,text,uuid,uuid)','hon.start_school_social_reply(text,uuid,jsonb,text,uuid,uuid)',
    'hon.record_school_social_reply_result(text,uuid,uuid,text,text,uuid,uuid)','hon.resolve_school_social_message(text,uuid,jsonb,text,uuid,uuid)',
    'hon.start_school_social_comment_action(text,uuid,jsonb,text,uuid,uuid)','hon.record_school_social_comment_action_result(text,uuid,uuid,text,uuid,uuid)',
    'hon.record_school_social_inbox_event(text,text,text,text,text,text,text,text,text,timestamptz)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','hon_communication_worker','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_social_inbox(text,jsonb),hon.read_school_social_conversation(text,uuid),
      hon.change_school_social_conversation(text,uuid,jsonb,text,uuid,uuid),hon.start_school_social_reply(text,uuid,jsonb,text,uuid,uuid),
      hon.record_school_social_reply_result(text,uuid,uuid,text,text,uuid,uuid),hon.resolve_school_social_message(text,uuid,jsonb,text,uuid,uuid),
      hon.start_school_social_comment_action(text,uuid,jsonb,text,uuid,uuid),hon.record_school_social_comment_action_result(text,uuid,uuid,text,uuid,uuid) TO hon_runtime;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.record_school_social_inbox_event(text,text,text,text,text,text,text,text,text,timestamptz) TO hon_communication_worker;
  END IF;
END $$;

COMMIT;
