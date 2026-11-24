BEGIN;

-- 0364 Conversation AI piece CA1 (allocated by the coordinator 2026-11-15; docs/architecture/CONVERSATION_AI.md §4).
-- One school inbox for two-way texting. Nothing here uses AI or sends on its own.
--   C1  Every text to an ACTIVE school number (0248) that is not STOP/START/HELP is stored as a conversation message for
--       that school (live school, organization and entitlement). One conversation per school, channel and address. A new
--       conversation, or one still unlinked, links the one person of the school with that mobile number and that
--       person's newest OPEN lead; two or more people with the number link nobody. No person is created from a number.
--       At most 300 inbound texts per school and 30 per conversation an hour are stored (exact under a per-school lock).
--   C2  Staff with conversation.read see the school's conversations (filters, search, keyset pages) and one thread with
--       the contact panel and each reply's delivery status (0243). Staff with conversation.manage reply, assign, tag,
--       open/close, mark read, link a person/lead, or create a lead from a conversation (that also needs crm.lead.create).
--   C3  A reply is a QUEUED 0047 SMS to the linked person, whose mobile must be the conversation's number and whose SMS
--       consent must be OPTED_IN, from a school with an ACTIVE text sender. The 0243 worker delivers it (consent, quiet
--       hours and address are checked again there).
--   C4  Messages are append-only; conversations are never deleted and keep their school, channel and address. Commands are
--       idempotent by key, version-checked and audited, authority is decided again after the writes, outbox events carry
--       ids only. The runtime and the worker gain no table privilege: entry points are SECURITY DEFINER.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School conversations require a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL OR to_regclass('hon.school_text_senders') IS NULL
    OR to_regclass('hon.communication_deliveries') IS NULL THEN
    RAISE EXCEPTION 'School conversations require 0077, 0177, 0224, 0243 and 0248';
  END IF;
END $$;

-- The fixed actor for intake evidence. No grants, roles or human user ever belong to it.
INSERT INTO hon.principals (id, principal_type, user_id, display_name, is_active)
VALUES ('00000000-0000-4000-8000-00000000c364', 'INTEGRATION', NULL, 'HON conversation intake', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('conversation.read','See the school''s conversations inbox: texts from contacts and the school''s replies',true,true),
  ('conversation.manage','Reply to, assign, tag, close and link the school''s conversations',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('conversation.read','conversation.manage') AND is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'conversation permissions already exist with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN (VALUES ('conversation.read'),('conversation.manage')) p(code)
WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- Message text: 1-1,600 characters, not blank, no control characters except line breaks and tabs.
CREATE FUNCTION hon.conversation_body_ok(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT v IS NOT NULL AND length(v) BETWEEN 1 AND 1600 AND btrim(v,E' \t\r\n')<>'' AND v !~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]'
$$;
-- Tags: at most 10, distinct, each 1-32 letters, digits, spaces or dashes, trimmed.
CREATE FUNCTION hon.conversation_tags_ok(v text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT v IS NOT NULL AND cardinality(v)<=10 AND array_position(v,NULL) IS NULL
    AND (SELECT count(DISTINCT lower(t))=count(*) AND bool_and(t ~ '^[[:alnum:]][[:alnum:] -]{0,30}[[:alnum:]]$|^[[:alnum:]]$') FROM unnest(v) t) IS NOT FALSE
$$;

CREATE TABLE hon.school_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('SMS','EMAIL','WEB_CHAT')),
  contact_address text NOT NULL CHECK (length(contact_address) BETWEEN 1 AND 320 AND contact_address !~ '[[:cntrl:][:space:]]'),
  person_id uuid,
  lead_id uuid,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  assigned_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  tags text[] NOT NULL DEFAULT '{}' CHECK (hon.conversation_tags_ok(tags)),
  unread integer NOT NULL DEFAULT 0 CHECK (unread BETWEEN 0 AND 100000),
  last_inbound_at timestamptz CHECK (last_inbound_at=date_trunc('milliseconds',last_inbound_at)),
  -- Whole milliseconds, like every time the API returns, so the list cursor (lastMessageAt, id) is exact.
  last_message_at timestamptz NOT NULL CHECK (last_message_at=date_trunc('milliseconds',last_message_at)),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (school_id,channel,contact_address),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (lead_id,organization_id,school_id) REFERENCES hon.crm_leads(id,organization_id,school_id) ON DELETE RESTRICT,
  CHECK (channel<>'SMS' OR contact_address ~ '^\+[1-9][0-9]{7,14}$'),
  CHECK (lead_id IS NULL OR person_id IS NOT NULL)
);
CREATE INDEX school_conversations_school_time ON hon.school_conversations(organization_id,school_id,last_message_at DESC,id DESC);
CREATE INDEX school_conversations_person ON hon.school_conversations(person_id) WHERE person_id IS NOT NULL;

CREATE TABLE hon.school_conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  author_kind text NOT NULL CHECK (author_kind IN ('CONTACT','STAFF')),
  body text NOT NULL,
  media_count integer NOT NULL DEFAULT 0 CHECK (media_count BETWEEN 0 AND 10),
  provider_message_id text UNIQUE CHECK (provider_message_id ~ '^(?:SM|MM)[0-9a-f]{32}$'),
  communication_message_id uuid UNIQUE,
  author_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id,organization_id,school_id) REFERENCES hon.school_conversations(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (communication_message_id,organization_id,school_id) REFERENCES hon.communication_messages(id,organization_id,school_id) ON DELETE RESTRICT,
  CHECK (hon.conversation_body_ok(body) OR (body='' AND media_count>0)),
  CHECK ((direction='INBOUND')=(author_kind='CONTACT')),
  CHECK ((direction='INBOUND')=(provider_message_id IS NOT NULL)),
  CHECK ((direction='OUTBOUND')=(communication_message_id IS NOT NULL AND author_principal_id IS NOT NULL)),
  CHECK (direction='INBOUND' OR media_count=0)
);
CREATE INDEX school_conversation_messages_time ON hon.school_conversation_messages(conversation_id,occurred_at DESC,id DESC);
CREATE INDEX school_conversation_messages_school_inbound ON hon.school_conversation_messages(school_id,created_at) WHERE direction='INBOUND';

ALTER TABLE hon.school_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_conversation_messages FORCE ROW LEVEL SECURITY;

-- Messages are append-only for every writer; nothing is truncated.
CREATE TRIGGER school_conversation_messages_immutable BEFORE UPDATE OR DELETE ON hon.school_conversation_messages
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_conversation_messages_no_truncate BEFORE TRUNCATE ON hon.school_conversation_messages
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_conversations_no_truncate BEFORE TRUNCATE ON hon.school_conversations
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Conversations are never deleted, keep their school, channel and address, and every update bumps the version by one.
-- A link, once made, only moves to another person/lead by a staff link command (never back to nobody).
CREATE FUNCTION hon.guard_school_conversation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'School conversations are never deleted' USING ERRCODE='55000'; END IF;
  -- Times are kept to whole milliseconds (the API's precision) so keyset pages never skip a conversation.
  NEW.last_message_at:=date_trunc('milliseconds',NEW.last_message_at);
  NEW.last_inbound_at:=date_trunc('milliseconds',NEW.last_inbound_at);
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 THEN RAISE EXCEPTION 'A new school conversation starts at version 1' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.channel<>OLD.channel
    OR NEW.contact_address<>OLD.contact_address OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
    OR (OLD.person_id IS NOT NULL AND NEW.person_id IS NULL) OR NEW.last_message_at<OLD.last_message_at THEN
    RAISE EXCEPTION 'School conversation scope and history are fixed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_conversations_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_conversations
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_conversation();

-- Live, direct, non-family, non-HQ staff of the current school holding the given permission now (the 0330 rules).
CREATE FUNCTION hon.conversation_staff_has(p_principal uuid, p_org uuid, p_school uuid, p_permission text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT p_principal IS NOT NULL AND EXISTS(SELECT 1 FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
    WHERE p.id=p_principal AND p.principal_type='HUMAN_USER' AND p.is_active
      AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1)
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=p_org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=p_school AND s.organization_id=p_org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p_principal)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p_principal AND f.effective_from<=clock_timestamp()
      AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p_principal AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p_principal,p_org,p_school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p_principal AND g.organization_id=p_org AND g.school_id=p_school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=p_school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=p_permission)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=p_org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
$$;

-- The signed-in direct human at the session school with conversation.read (p_manage false) or conversation.manage (true).
CREATE FUNCTION hon.require_conversation_actor(subject text, p_manage boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL OR p_manage IS NULL THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
  IF NOT hon.conversation_staff_has(actor,org,school,CASE WHEN p_manage THEN 'conversation.manage' ELSE 'conversation.read' END) THEN
    RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.conversation_time(t timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN t IS NULL THEN NULL ELSE to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
$$;

-- One conversation as an inbox row.
CREATE FUNCTION hon.conversation_row_json(c hon.school_conversations) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('conversationId',c.id,'channel',c.channel,'contactAddress',c.contact_address,
    'contactName',(SELECT nullif(btrim(p.given_name||' '||p.family_name),'') FROM hon.people p WHERE p.id=c.person_id),
    'personId',c.person_id,'leadId',c.lead_id,
    'leadStatus',(SELECT l.status::text FROM hon.crm_leads l WHERE l.id=c.lead_id),
    'leadStage',(SELECT st.name FROM hon.crm_leads l JOIN hon.crm_pipeline_stages st ON st.id=l.pipeline_stage_id WHERE l.id=c.lead_id),
    'status',c.status,'unread',c.unread,'tags',to_jsonb(c.tags),
    'assignedTo',(SELECT jsonb_build_object('principalId',p.id,'name',p.display_name) FROM hon.principals p WHERE p.id=c.assigned_principal_id),
    'lastMessage',(SELECT jsonb_build_object('direction',m.direction,'preview',left(m.body,120),'mediaCount',m.media_count,'at',hon.conversation_time(m.occurred_at))
      FROM hon.school_conversation_messages m WHERE m.conversation_id=c.id ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1),
    'lastMessageAt',hon.conversation_time(c.last_message_at),'lastInboundAt',hon.conversation_time(c.last_inbound_at),'version',c.version)
$$;

-- One message. A reply carries the delivery state of its 0047 message (QUEUED until the 0243 worker claims it).
CREATE FUNCTION hon.conversation_message_json(m hon.school_conversation_messages) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('messageId',m.id,'direction',m.direction,'author',m.author_kind,
    'staffName',(SELECT p.display_name FROM hon.principals p WHERE p.id=m.author_principal_id AND m.direction='OUTBOUND'),
    'body',m.body,'mediaCount',m.media_count,'at',hon.conversation_time(m.occurred_at),
    'delivery',CASE WHEN m.direction='OUTBOUND' THEN coalesce(
      (SELECT d.status::text FROM hon.communication_deliveries d WHERE d.message_id=m.communication_message_id),
      (SELECT CASE cm.lifecycle WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'QUEUED' END FROM hon.communication_messages cm WHERE cm.id=m.communication_message_id)) END)
$$;

-- The contact panel: who it is, their lead, their next appointment and their texting consent.
CREATE FUNCTION hon.conversation_contact_json(c hon.school_conversations) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object(
    'person',(SELECT jsonb_build_object('personId',p.id,'givenName',p.given_name,'familyName',p.family_name,'phone',p.phone_e164,'email',p.email::text,
      'smsConsent',coalesce((SELECT k.status::text FROM hon.communication_consents k WHERE k.person_id=p.id AND k.channel='SMS'),'NONE'))
      FROM hon.people p WHERE p.id=c.person_id),
    'lead',(SELECT jsonb_build_object('leadId',l.id,'status',l.status::text,'pipeline',pl.name,'stage',st.name,'source',l.source_code,'createdAt',hon.conversation_time(l.created_at))
      FROM hon.crm_leads l JOIN hon.crm_pipelines pl ON pl.id=l.pipeline_id JOIN hon.crm_pipeline_stages st ON st.id=l.pipeline_stage_id WHERE l.id=c.lead_id),
    'nextAppointment',(SELECT jsonb_build_object('appointmentId',a.id,'type',a.appointment_type::text,'startsAt',hon.conversation_time(a.starts_at))
      FROM hon.crm_appointments a WHERE a.crm_lead_id=c.lead_id AND a.status='SCHEDULED' AND a.starts_at>clock_timestamp() ORDER BY a.starts_at LIMIT 1),
    'peopleWithNumber',(SELECT count(*) FROM hon.people p WHERE p.organization_id=c.organization_id AND p.school_id=c.school_id
      AND c.channel='SMS' AND p.phone_e164=c.contact_address),
    'schoolCanText',EXISTS(SELECT 1 FROM hon.school_text_senders s WHERE s.school_id=c.school_id AND s.status='ACTIVE'))
$$;

-- Exact-request idempotency for one actor: NULL when reserved now, else the earlier exact result.
CREATE FUNCTION hon.conversation_command_begin(actor uuid, key text, fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  RETURN prior.response_body;
END $$;

-- Audit, outbox (ids only) and the recorded result of one staff command on a conversation.
CREATE FUNCTION hon.conversation_command_finish(actor uuid, key text, c hon.school_conversations, action text, prior jsonb, ids jsonb,
  event text, result jsonb, request uuid, correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(c.organization_id,c.school_id,actor,'HUMAN_UI',action,'SCHOOL_CONVERSATION',c.id,prior,ids||jsonb_build_object('version',c.version),'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(c.organization_id,c.school_id,event,1,'SCHOOL_CONVERSATION',c.id,c.version,correlation,request,ids||jsonb_build_object('conversationId',c.id,'version',c.version));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=c.organization_id AND school_id=c.school_id AND principal_id=actor AND idempotency_key=key;
END $$;

-- The conversation of the session school, locked, at the expected version.
CREATE FUNCTION hon.conversation_lock(p_conversation uuid, p_expected integer) RETURNS hon.school_conversations
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.school_conversations;
BEGIN
  SELECT * INTO c FROM hon.school_conversations x WHERE x.id=p_conversation AND x.organization_id=hon.current_organization_id()
    AND x.school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_expected IS NOT NULL AND c.version<>p_expected THEN RAISE EXCEPTION 'CONVERSATION_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  RETURN c;
END $$;

-- Shared input frame of every command: an object with exactly the listed keys (optional ones may be absent).
CREATE FUNCTION hon.conversation_input_ok(p jsonb, required text[], optional text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_typeof(p)='object' AND p ?& required
    AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>ALL(required||optional))
    AND (NOT p ? 'conversationId' OR (jsonb_typeof(p->'conversationId')='string' AND p->>'conversationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    AND (NOT p ? 'expectedVersion' OR (jsonb_typeof(p->'expectedVersion')='number' AND p->>'expectedVersion' ~ '^[1-9][0-9]{0,8}$'))
$$;
CREATE FUNCTION hon.conversation_uuid_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_typeof(v)='string' AND v#>>'{}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- C1 inbound text, called by the communication worker login after the webhook signature and number checks.
CREATE FUNCTION hon.record_inbound_conversation_text(p_to_e164 text, p_from_e164 text, p_body text, p_media_count integer,
  p_provider_message_id text, p_received_at timestamptz)
RETURNS TABLE (outcome text, conversation_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE v_sender hon.school_text_senders; c hon.school_conversations; m hon.school_conversation_messages; v_body text; v_req uuid:=gen_random_uuid();
  v_person uuid; v_lead uuid; v_n integer; v_new boolean:=false; v_prior jsonb;
BEGIN
  IF p_from_e164 IS NULL OR p_from_e164 !~ '^\+[1-9][0-9]{7,14}$' OR p_to_e164 IS NULL OR p_to_e164 !~ '^\+[1-9][0-9]{7,14}$'
    OR p_provider_message_id IS NULL OR p_provider_message_id !~ '^(?:SM|MM)[0-9a-f]{32}$' OR p_media_count IS NULL OR p_media_count NOT BETWEEN 0 AND 10
    OR p_body IS NULL OR length(p_body)>1600
    OR p_received_at IS NULL OR p_received_at > now() + interval '10 minutes' OR p_received_at < now() - interval '7 days' THEN
    RAISE EXCEPTION 'HON inbound conversation text is invalid.' USING ERRCODE='22023';
  END IF;
  -- Control characters other than line breaks and tabs are dropped; a blank text counts only with media.
  v_body:=btrim(regexp_replace(p_body,E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]','','g'),E' \t\r\n');
  IF v_body='' AND p_media_count=0 THEN outcome:='EMPTY'; conversation_id:=NULL; RETURN NEXT; RETURN; END IF;
  IF upper(regexp_replace(v_body,'[.!]+$','')) IN ('STOP','START','HELP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','OPTOUT','REVOKE','UNSTOP','YES','INFO')
    AND p_media_count=0 THEN outcome:='KEYWORD'; conversation_id:=NULL; RETURN NEXT; RETURN; END IF;
  SELECT x.conversation_id INTO conversation_id FROM hon.school_conversation_messages x WHERE x.provider_message_id=p_provider_message_id;
  IF FOUND THEN outcome:='REPLAYED'; RETURN NEXT; RETURN; END IF;

  SELECT * INTO v_sender FROM hon.school_text_senders s WHERE s.phone_e164=p_to_e164;
  IF v_sender.id IS NULL OR v_sender.status<>'ACTIVE' THEN outcome:='UNROUTED'; conversation_id:=NULL; RETURN NEXT; RETURN; END IF;
  -- Same lock order as public intake: organization, school, then this school's conversation lock.
  PERFORM 1 FROM hon.organizations o WHERE o.id=v_sender.organization_id AND o.status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN outcome:='UNROUTED'; conversation_id:=NULL; RETURN NEXT; RETURN; END IF;
  PERFORM 1 FROM hon.schools s WHERE s.id=v_sender.school_id AND s.organization_id=v_sender.organization_id AND s.status='ACTIVE' FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=v_sender.organization_id AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN
    outcome:='UNROUTED'; conversation_id:=NULL; RETURN NEXT; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_conversations:'||v_sender.school_id::text,0));
  -- A concurrent delivery of the same Twilio message waited on the lock above.
  SELECT x.conversation_id INTO conversation_id FROM hon.school_conversation_messages x WHERE x.provider_message_id=p_provider_message_id;
  IF FOUND THEN outcome:='REPLAYED'; RETURN NEXT; RETURN; END IF;
  IF (SELECT count(*) FROM hon.school_conversation_messages x WHERE x.school_id=v_sender.school_id AND x.direction='INBOUND'
      AND x.created_at>clock_timestamp()-interval '1 hour')>=300 THEN outcome:='RATE_LIMITED'; conversation_id:=NULL; RETURN NEXT; RETURN; END IF;

  SELECT * INTO c FROM hon.school_conversations x WHERE x.school_id=v_sender.school_id AND x.channel='SMS' AND x.contact_address=p_from_e164 FOR UPDATE;
  IF FOUND AND (SELECT count(*) FROM hon.school_conversation_messages x WHERE x.conversation_id=c.id AND x.direction='INBOUND'
      AND x.created_at>clock_timestamp()-interval '1 hour')>=30 THEN outcome:='RATE_LIMITED'; conversation_id:=c.id; RETURN NEXT; RETURN; END IF;
  IF NOT FOUND THEN
    INSERT INTO hon.school_conversations(organization_id,school_id,channel,contact_address,last_inbound_at,last_message_at)
      VALUES(v_sender.organization_id,v_sender.school_id,'SMS',p_from_e164,p_received_at,p_received_at) RETURNING * INTO c;
    v_new:=true;
  END IF;
  v_prior:=CASE WHEN v_new THEN NULL ELSE jsonb_build_object('status',c.status,'unread',c.unread,'version',c.version) END;
  -- Match an unlinked conversation: exactly one person of this school with this mobile, and that person's newest OPEN lead.
  IF c.person_id IS NULL THEN
    SELECT count(*), min(p.id::text)::uuid INTO v_n, v_person FROM hon.people p
      WHERE p.organization_id=c.organization_id AND p.school_id=c.school_id AND p.phone_e164=p_from_e164;
    IF v_n=1 THEN
      SELECT l.id INTO v_lead FROM hon.crm_leads l WHERE l.organization_id=c.organization_id AND l.school_id=c.school_id
        AND l.primary_person_id=v_person AND l.status='OPEN' ORDER BY l.created_at DESC, l.id DESC LIMIT 1;
    ELSE v_person:=NULL; END IF;
  END IF;
  INSERT INTO hon.school_conversation_messages(conversation_id,organization_id,school_id,direction,author_kind,body,media_count,provider_message_id,occurred_at)
    VALUES(c.id,c.organization_id,c.school_id,'INBOUND','CONTACT',v_body,p_media_count,p_provider_message_id,p_received_at) RETURNING * INTO m;
  UPDATE hon.school_conversations x SET status='OPEN',unread=least(x.unread+1,100000),last_inbound_at=greatest(coalesce(x.last_inbound_at,m.occurred_at),m.occurred_at),
    last_message_at=greatest(x.last_message_at,m.occurred_at),person_id=coalesce(x.person_id,v_person),lead_id=CASE WHEN x.person_id IS NULL THEN v_lead ELSE x.lead_id END,
    version=x.version+1,updated_at=clock_timestamp()
    WHERE x.id=c.id RETURNING * INTO c;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(c.organization_id,c.school_id,'00000000-0000-4000-8000-00000000c364','INTEGRATION','conversation.message.receive','SCHOOL_CONVERSATION',c.id,v_prior,
      jsonb_build_object('messageId',m.id,'channel','SMS','personId',c.person_id,'leadId',c.lead_id,'status',c.status,'unread',c.unread,'version',c.version),'SUCCEEDED',v_req,v_req);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(c.organization_id,c.school_id,'conversation.message.received',1,'SCHOOL_CONVERSATION',c.id,c.version,v_req,v_req,
      jsonb_build_object('conversationId',c.id,'messageId',m.id,'channel','SMS','personId',c.person_id,'leadId',c.lead_id,'newConversation',v_new));
  outcome:='RECORDED'; conversation_id:=c.id;
  RETURN NEXT;
END $$;

-- C2 inbox list. p: optional status OPEN|CLOSED|ALL (default OPEN), assigned ANY|ME|NONE, unreadOnly, tag, search (1-60),
-- before {at, id} from the previous page. 50 rows, newest first.
CREATE FUNCTION hon.read_school_conversations(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_status text; v_assigned text; v_unread boolean; v_tag text; v_search text; v_digits text; v_at timestamptz; v_id uuid;
  rows jsonb; next jsonb; result jsonb; n integer;
BEGIN
  IF NOT hon.conversation_input_ok(p,ARRAY[]::text[],ARRAY['status','assigned','unreadOnly','tag','search','before'])
    OR (p ? 'status' AND (jsonb_typeof(p->'status')<>'string' OR p->>'status' NOT IN ('OPEN','CLOSED','ALL')))
    OR (p ? 'assigned' AND (jsonb_typeof(p->'assigned')<>'string' OR p->>'assigned' NOT IN ('ANY','ME','NONE')))
    OR (p ? 'unreadOnly' AND jsonb_typeof(p->'unreadOnly')<>'boolean')
    OR (p ? 'tag' AND (jsonb_typeof(p->'tag')<>'string' OR NOT hon.conversation_tags_ok(ARRAY[p->>'tag'])))
    OR (p ? 'search' AND (jsonb_typeof(p->'search')<>'string' OR length(p->>'search') NOT BETWEEN 1 AND 60 OR btrim(p->>'search')<>p->>'search' OR p->>'search' ~ '[[:cntrl:]]'))
    OR (p ? 'before' AND (jsonb_typeof(p->'before')<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p->'before') k) IS DISTINCT FROM ARRAY['at','id']
      OR NOT hon.conversation_uuid_ok(p->'before'->'id') OR jsonb_typeof(p->'before'->'at')<>'string'
      OR p->'before'->>'at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_conversation_actor(subject,false);
  v_status:=coalesce(p->>'status','OPEN'); v_assigned:=coalesce(p->>'assigned','ANY'); v_unread:=coalesce((p->>'unreadOnly')::boolean,false);
  v_tag:=p->>'tag'; v_search:=p->>'search'; v_digits:=nullif(regexp_replace(coalesce(v_search,''),'[^0-9]','','g'),'');
  v_at:=(p->'before'->>'at')::timestamptz; v_id:=(p->'before'->>'id')::uuid;
  SELECT coalesce(jsonb_agg(hon.conversation_row_json(x) ORDER BY x.last_message_at DESC, x.id DESC),'[]'), count(*) INTO rows, n FROM (
    SELECT c.* FROM hon.school_conversations c LEFT JOIN hon.people pe ON pe.id=c.person_id
    WHERE c.organization_id=hon.current_organization_id() AND c.school_id=hon.current_school_id()
      AND (v_status='ALL' OR c.status=v_status)
      AND (v_assigned='ANY' OR (v_assigned='ME' AND c.assigned_principal_id=actor) OR (v_assigned='NONE' AND c.assigned_principal_id IS NULL))
      AND (NOT v_unread OR c.unread>0)
      AND (v_tag IS NULL OR lower(v_tag)=ANY(SELECT lower(t) FROM unnest(c.tags) t))
      AND (v_search IS NULL OR strpos(lower(coalesce(pe.given_name,'')||' '||coalesce(pe.family_name,'')),lower(v_search))>0
        OR (v_digits IS NOT NULL AND strpos(c.contact_address,v_digits)>0) OR lower(v_search)=ANY(SELECT lower(t) FROM unnest(c.tags) t))
      AND (v_at IS NULL OR (c.last_message_at,c.id)<(v_at,v_id))
    ORDER BY c.last_message_at DESC, c.id DESC LIMIT 50) x;
  next:=CASE WHEN n=50 THEN jsonb_build_object('at',rows->49->>'lastMessageAt','id',rows->49->>'conversationId') END;
  result:=jsonb_build_object('conversations',rows,'nextCursor',next,
    'unreadConversations',(SELECT count(*) FROM hon.school_conversations c WHERE c.organization_id=hon.current_organization_id()
      AND c.school_id=hon.current_school_id() AND c.status='OPEN' AND c.unread>0),
    'canManage',hon.conversation_staff_has(actor,hon.current_organization_id(),hon.current_school_id(),'conversation.manage'));
  IF hon.require_conversation_actor(subject,false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- C2 one conversation: the row, the contact panel and up to 100 messages before p_before (oldest first).
CREATE FUNCTION hon.read_school_conversation(subject text, p_conversation uuid, p_before uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; c hon.school_conversations; b hon.school_conversation_messages; msgs jsonb; n integer; result jsonb;
BEGIN
  IF p_conversation IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_conversation_actor(subject,false);
  SELECT * INTO c FROM hon.school_conversations x WHERE x.id=p_conversation AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_before IS NOT NULL THEN
    SELECT * INTO b FROM hon.school_conversation_messages x WHERE x.id=p_before AND x.conversation_id=c.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  END IF;
  SELECT coalesce(jsonb_agg(hon.conversation_message_json(x) ORDER BY x.occurred_at, x.id),'[]'), count(*) INTO msgs, n FROM (
    SELECT * FROM hon.school_conversation_messages m WHERE m.conversation_id=c.id
      AND (b.id IS NULL OR (m.occurred_at,m.id)<(b.occurred_at,b.id))
    ORDER BY m.occurred_at DESC, m.id DESC LIMIT 101) x;
  IF n=101 THEN msgs:=msgs-0; END IF;
  result:=jsonb_build_object('conversation',hon.conversation_row_json(c),'contact',hon.conversation_contact_json(c),'messages',msgs,'hasOlder',n=101,
    'canManage',hon.conversation_staff_has(actor,c.organization_id,c.school_id,'conversation.manage'));
  IF hon.require_conversation_actor(subject,false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- C3 staff reply: a QUEUED 0047 SMS to the linked person at this conversation's number.
CREATE FUNCTION hon.reply_school_conversation(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior jsonb; c hon.school_conversations; before jsonb; pe hon.people; cm uuid; m hon.school_conversation_messages; result jsonb;
BEGIN
  IF NOT hon.conversation_input_ok(p,ARRAY['body','conversationId','expectedVersion'],ARRAY[]::text[])
    OR jsonb_typeof(p->'body') IS DISTINCT FROM 'string' OR NOT hon.conversation_body_ok(p->>'body')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_conversation_actor(subject,true);
  prior:=hon.conversation_command_begin(actor,key,encode(sha256(convert_to('conversation.reply:'||(p->>'conversationId')||':'||(p->>'expectedVersion')||':'||(p->>'body'),'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_conversation_actor(subject,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  c:=hon.conversation_lock((p->>'conversationId')::uuid,(p->>'expectedVersion')::integer);
  IF c.channel<>'SMS' THEN RAISE EXCEPTION 'CONVERSATION_CHANNEL_UNSUPPORTED' USING ERRCODE='55000'; END IF;
  IF c.person_id IS NULL THEN RAISE EXCEPTION 'CONVERSATION_NOT_LINKED' USING ERRCODE='55000'; END IF;
  SELECT * INTO pe FROM hon.people x WHERE x.id=c.person_id FOR SHARE;
  IF pe.phone_e164 IS DISTINCT FROM c.contact_address THEN RAISE EXCEPTION 'CONVERSATION_ADDRESS_MISMATCH' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.school_text_senders s WHERE s.school_id=c.school_id AND s.status='ACTIVE') THEN
    RAISE EXCEPTION 'CONVERSATION_NO_SENDER' USING ERRCODE='55000'; END IF;
  IF (SELECT k.status::text FROM hon.communication_consents k WHERE k.person_id=pe.id AND k.channel='SMS' FOR SHARE) IS DISTINCT FROM 'OPTED_IN' THEN
    RAISE EXCEPTION 'CONVERSATION_CONSENT_REQUIRED' USING ERRCODE='55000'; END IF;
  before:=jsonb_build_object('unread',c.unread,'version',c.version);
  INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,lifecycle,created_by_principal_id,queued_by_principal_id)
    VALUES(c.organization_id,c.school_id,pe.id,'SMS',p->>'body','QUEUED',actor,actor) RETURNING id INTO cm;
  INSERT INTO hon.school_conversation_messages(conversation_id,organization_id,school_id,direction,author_kind,body,communication_message_id,author_principal_id,occurred_at)
    VALUES(c.id,c.organization_id,c.school_id,'OUTBOUND','STAFF',p->>'body',cm,actor,clock_timestamp()) RETURNING * INTO m;
  UPDATE hon.school_conversations x SET unread=0,last_message_at=greatest(x.last_message_at,m.occurred_at),version=x.version+1,updated_at=clock_timestamp()
    WHERE x.id=c.id RETURNING * INTO c;
  result:=jsonb_build_object('conversation',hon.conversation_row_json(c),'message',hon.conversation_message_json(m));
  PERFORM hon.conversation_command_finish(actor,key,c,'conversation.reply',before,
    jsonb_build_object('messageId',m.id,'communicationMessageId',cm,'personId',pe.id),'conversation.reply.queued',result,request,correlation);
  IF hon.require_conversation_actor(subject,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- C2 staff changes: any of status, assignedPrincipalId (a staff member with conversation.read, or null) and tags.
CREATE FUNCTION hon.update_school_conversation(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior jsonb; c hon.school_conversations; before jsonb; v_tags text[]; v_assignee uuid; result jsonb;
BEGIN
  IF NOT hon.conversation_input_ok(p,ARRAY['conversationId','expectedVersion'],ARRAY['status','assignedPrincipalId','tags'])
    OR NOT (p ? 'status' OR p ? 'assignedPrincipalId' OR p ? 'tags')
    OR (p ? 'status' AND (jsonb_typeof(p->'status')<>'string' OR p->>'status' NOT IN ('OPEN','CLOSED')))
    OR (p ? 'assignedPrincipalId' AND jsonb_typeof(p->'assignedPrincipalId')<>'null' AND NOT hon.conversation_uuid_ok(p->'assignedPrincipalId'))
    OR (p ? 'tags' AND (jsonb_typeof(p->'tags')<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'tags') e WHERE jsonb_typeof(e)<>'string')))
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p ? 'tags' THEN
    SELECT coalesce(array_agg(e ORDER BY o),'{}') INTO v_tags FROM jsonb_array_elements_text(p->'tags') WITH ORDINALITY x(e,o);
    IF NOT hon.conversation_tags_ok(v_tags) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END IF;
  actor:=hon.require_conversation_actor(subject,true);
  prior:=hon.conversation_command_begin(actor,key,encode(sha256(convert_to('conversation.update:'||p::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_conversation_actor(subject,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  c:=hon.conversation_lock((p->>'conversationId')::uuid,(p->>'expectedVersion')::integer);
  IF p ? 'assignedPrincipalId' AND jsonb_typeof(p->'assignedPrincipalId')='string' THEN
    v_assignee:=(p->>'assignedPrincipalId')::uuid;
    IF NOT hon.conversation_staff_has(v_assignee,c.organization_id,c.school_id,'conversation.read') THEN
      RAISE EXCEPTION 'CONVERSATION_ASSIGNEE_INVALID' USING ERRCODE='55000'; END IF;
  END IF;
  before:=jsonb_build_object('status',c.status,'assignedPrincipalId',c.assigned_principal_id,'tags',to_jsonb(c.tags),'version',c.version);
  UPDATE hon.school_conversations x SET
    status=CASE WHEN p ? 'status' THEN p->>'status' ELSE x.status END,
    assigned_principal_id=CASE WHEN p ? 'assignedPrincipalId' THEN v_assignee ELSE x.assigned_principal_id END,
    tags=CASE WHEN p ? 'tags' THEN v_tags ELSE x.tags END,
    version=x.version+1,updated_at=clock_timestamp()
    WHERE x.id=c.id RETURNING * INTO c;
  result:=jsonb_build_object('conversation',hon.conversation_row_json(c));
  PERFORM hon.conversation_command_finish(actor,key,c,'conversation.update',before,
    jsonb_build_object('status',c.status,'assignedPrincipalId',c.assigned_principal_id,'tagCount',cardinality(c.tags)),'conversation.updated',result,request,correlation);
  IF hon.require_conversation_actor(subject,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- C2 mark read up to the newest message the staff member loaded; contact texts after it stay unread. No key: repeatable.
CREATE FUNCTION hon.mark_school_conversation_read(subject text, p jsonb, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; c hon.school_conversations; t hon.school_conversation_messages; v_unread integer;
BEGIN
  IF NOT hon.conversation_input_ok(p,ARRAY['conversationId','throughMessageId'],ARRAY[]::text[]) OR NOT hon.conversation_uuid_ok(p->'throughMessageId')
    OR request IS NULL OR correlation IS NULL OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_conversation_actor(subject,false);
  c:=hon.conversation_lock((p->>'conversationId')::uuid,NULL);
  SELECT * INTO t FROM hon.school_conversation_messages x WHERE x.id=(p->>'throughMessageId')::uuid AND x.conversation_id=c.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT least(count(*),c.unread) INTO v_unread FROM hon.school_conversation_messages x WHERE x.conversation_id=c.id AND x.direction='INBOUND'
    AND (x.occurred_at,x.id)>(t.occurred_at,t.id);
  IF v_unread<c.unread THEN
    UPDATE hon.school_conversations x SET unread=v_unread,version=x.version+1,updated_at=clock_timestamp() WHERE x.id=c.id RETURNING * INTO c;
  END IF;
  IF hon.require_conversation_actor(subject,false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('conversationId',c.id,'unread',c.unread,'version',c.version);
END $$;

-- C2 link a person of this school whose mobile is this number, and optionally one of that person's leads.
CREATE FUNCTION hon.link_school_conversation(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior jsonb; c hon.school_conversations; before jsonb; pe hon.people; v_lead uuid; result jsonb;
BEGIN
  IF NOT hon.conversation_input_ok(p,ARRAY['conversationId','expectedVersion','personId','leadId'],ARRAY[]::text[])
    OR NOT hon.conversation_uuid_ok(p->'personId') OR (jsonb_typeof(p->'leadId')<>'null' AND NOT hon.conversation_uuid_ok(p->'leadId'))
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_conversation_actor(subject,true);
  prior:=hon.conversation_command_begin(actor,key,encode(sha256(convert_to('conversation.link:'||p::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_conversation_actor(subject,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  c:=hon.conversation_lock((p->>'conversationId')::uuid,(p->>'expectedVersion')::integer);
  SELECT * INTO pe FROM hon.people x WHERE x.id=(p->>'personId')::uuid AND x.organization_id=c.organization_id AND x.school_id=c.school_id FOR SHARE;
  IF NOT FOUND OR (c.channel='SMS' AND pe.phone_e164 IS DISTINCT FROM c.contact_address) THEN
    RAISE EXCEPTION 'CONVERSATION_LINK_INVALID' USING ERRCODE='55000'; END IF;
  IF jsonb_typeof(p->'leadId')='string' THEN
    SELECT l.id INTO v_lead FROM hon.crm_leads l WHERE l.id=(p->>'leadId')::uuid AND l.organization_id=c.organization_id AND l.school_id=c.school_id
      AND l.primary_person_id=pe.id;
    IF v_lead IS NULL THEN RAISE EXCEPTION 'CONVERSATION_LINK_INVALID' USING ERRCODE='55000'; END IF;
  END IF;
  before:=jsonb_build_object('personId',c.person_id,'leadId',c.lead_id,'version',c.version);
  UPDATE hon.school_conversations x SET person_id=pe.id,lead_id=v_lead,version=x.version+1,updated_at=clock_timestamp() WHERE x.id=c.id RETURNING * INTO c;
  result:=jsonb_build_object('conversation',hon.conversation_row_json(c),'contact',hon.conversation_contact_json(c));
  PERFORM hon.conversation_command_finish(actor,key,c,'conversation.link',before,jsonb_build_object('personId',c.person_id,'leadId',c.lead_id),
    'conversation.linked',result,request,correlation);
  IF hon.require_conversation_actor(subject,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- C2 create the person (with this number) and an OPEN lead from an unlinked conversation, then link both.
-- Needs conversation.manage and crm.lead.create; the lead's source is CONVERSATION_SMS.
CREATE FUNCTION hon.create_school_conversation_lead(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior jsonb; c hon.school_conversations; before jsonb; v_person uuid; l hon.crm_leads; v_stage hon.crm_pipeline_stages; result jsonb; v_ids jsonb;
BEGIN
  IF NOT hon.conversation_input_ok(p,ARRAY['conversationId','expectedVersion','givenName','familyName','pipelineId','stageId'],ARRAY[]::text[])
    OR jsonb_typeof(p->'givenName')<>'string' OR length(p->>'givenName') NOT BETWEEN 1 AND 100 OR btrim(p->>'givenName')<>p->>'givenName' OR p->>'givenName' ~ '[[:cntrl:]]'
    OR jsonb_typeof(p->'familyName')<>'string' OR length(p->>'familyName')>100 OR btrim(p->>'familyName')<>p->>'familyName' OR p->>'familyName' ~ '[[:cntrl:]]'
    OR NOT hon.conversation_uuid_ok(p->'pipelineId') OR NOT hon.conversation_uuid_ok(p->'stageId')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_conversation_actor(subject,true);
  IF NOT hon.conversation_staff_has(actor,hon.current_organization_id(),hon.current_school_id(),'crm.lead.create') THEN
    RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  prior:=hon.conversation_command_begin(actor,key,encode(sha256(convert_to('conversation.create_lead:'||p::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_conversation_actor(subject,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  c:=hon.conversation_lock((p->>'conversationId')::uuid,(p->>'expectedVersion')::integer);
  IF c.person_id IS NOT NULL THEN RAISE EXCEPTION 'CONVERSATION_ALREADY_LINKED' USING ERRCODE='55000'; END IF;
  IF c.channel<>'SMS' THEN RAISE EXCEPTION 'CONVERSATION_CHANNEL_UNSUPPORTED' USING ERRCODE='55000'; END IF;
  SELECT st.* INTO v_stage FROM hon.crm_pipeline_stages st JOIN hon.crm_pipelines pl ON pl.id=st.pipeline_id AND pl.organization_id=st.organization_id AND pl.school_id=st.school_id
    WHERE st.id=(p->>'stageId')::uuid AND st.pipeline_id=(p->>'pipelineId')::uuid AND st.organization_id=c.organization_id AND st.school_id=c.school_id;
  IF v_stage.id IS NULL OR v_stage.terminal_status IS NOT NULL THEN RAISE EXCEPTION 'CONVERSATION_PIPELINE_INVALID' USING ERRCODE='55000'; END IF;
  before:=jsonb_build_object('personId',NULL,'leadId',NULL,'version',c.version);
  INSERT INTO hon.people(organization_id,school_id,given_name,family_name,phone_e164)
    VALUES(c.organization_id,c.school_id,p->>'givenName',p->>'familyName',c.contact_address) RETURNING id INTO v_person;
  INSERT INTO hon.crm_leads(organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,source_code,attribution)
    VALUES(c.organization_id,c.school_id,v_person,v_stage.pipeline_id,v_stage.id,'CONVERSATION_SMS',jsonb_build_object('source','CONVERSATION','channel','SMS','conversationId',c.id))
    RETURNING * INTO l;
  v_ids:=jsonb_build_object('leadId',l.id,'primaryPersonId',v_person,'pipelineId',l.pipeline_id,'pipelineStageId',l.pipeline_stage_id,'sourceCode','CONVERSATION_SMS','programInterestCode',NULL);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(l.organization_id,l.school_id,actor,'HUMAN_UI','crm.lead.create','CRM_LEAD',l.id,NULL,v_ids||jsonb_build_object('version',l.version),'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(l.organization_id,l.school_id,'crm.lead.created',1,'CRM_LEAD',l.id,l.version,correlation,request,v_ids);
  UPDATE hon.school_conversations x SET person_id=v_person,lead_id=l.id,version=x.version+1,updated_at=clock_timestamp() WHERE x.id=c.id RETURNING * INTO c;
  result:=jsonb_build_object('conversation',hon.conversation_row_json(c),'contact',hon.conversation_contact_json(c));
  PERFORM hon.conversation_command_finish(actor,key,c,'conversation.create_lead',before,jsonb_build_object('personId',v_person,'leadId',l.id),
    'conversation.linked',result,request,correlation);
  IF hon.require_conversation_actor(subject,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

DO $$ DECLARE r text; f text; t text;
  entry text[]:=ARRAY['hon.read_school_conversations(text,jsonb)','hon.read_school_conversation(text,uuid,uuid)',
    'hon.reply_school_conversation(text,jsonb,text,uuid,uuid)','hon.update_school_conversation(text,jsonb,text,uuid,uuid)',
    'hon.mark_school_conversation_read(text,jsonb,uuid,uuid)','hon.link_school_conversation(text,jsonb,text,uuid,uuid)',
    'hon.create_school_conversation_lead(text,jsonb,text,uuid,uuid)'];
  worker text:='hon.record_inbound_conversation_text(text,text,text,integer,text,timestamp with time zone)';
  fns text[]:=ARRAY['hon.conversation_body_ok(text)','hon.conversation_tags_ok(text[])','hon.guard_school_conversation()',
    'hon.conversation_staff_has(uuid,uuid,uuid,text)','hon.require_conversation_actor(text,boolean)','hon.conversation_time(timestamp with time zone)',
    'hon.conversation_row_json(hon.school_conversations)','hon.conversation_message_json(hon.school_conversation_messages)',
    'hon.conversation_contact_json(hon.school_conversations)','hon.conversation_command_begin(uuid,text,text)',
    'hon.conversation_command_finish(uuid,text,hon.school_conversations,text,jsonb,jsonb,text,jsonb,uuid,uuid)',
    'hon.conversation_lock(uuid,integer)','hon.conversation_input_ok(jsonb,text[],text[])','hon.conversation_uuid_ok(jsonb)']||entry||worker; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['school_conversations','school_conversation_messages'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_communication_worker',worker);
  END IF;
END $$;

COMMIT;
