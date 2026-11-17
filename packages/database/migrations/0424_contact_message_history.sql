BEGIN;

-- 0424 Conversation AI piece CA1b (allocated by the coordinator 2026-11-16; docs/architecture/CONVERSATION_AI.md §3.1 #2, #3).
-- One message history per contact, the exact email a contact was sent, and "Resend to saved address".
--   H1  Staff with conversation.read see one person's messages: every non-draft 0047 message to them (texts and emails,
--       from staff, conversations, campaigns and automations), the texts they sent the school's number (0364) and, for
--       staff who also hold family_messages.manage, their family's parent-app messages (0330). Each row says channel,
--       Sent or Received, where it came from and, for 0047 messages, the delivery result of the 0243 receipts. Search,
--       All / Today (school time zone) / 7 days / 30 days, a total count and keyset pages of 50.
--   H2  The email view shows the subject that is sent (the author's 0423 subject, or the standard subject the email adapter
--       uses) and the plain-text body exactly as stored, the delivery result with its provider events, and its resends.
--       From this migration the delivery worker is given the author's subject (hon.communication_email_subject), so the
--       subject shown is the subject sent.
--   H3  Resend queues a new QUEUED 0047 email with the same subject and body to the same person; the 0243 worker sends it
--       to the person's current saved address. It needs conversation.manage and communication.message.queue, the person's
--       current email address and EMAIL consent OPTED_IN (an unsubscribe or spam report records OPTED_OUT), a queued (never
--       draft or cancelled) original, and at most 3 resends of one message and 10 email resends to one person in 24 hours,
--       counted under a lock on the person. Idempotent by key, audited, outbox ids only, authority decided again after the
--       writes. Resends are recorded in hon.communication_message_resends (append-only).
--   H4  No table privilege for the runtime: the entry points are SECURITY DEFINER and only they are granted. Nothing here
--       sends, calls AI or changes consent.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Contact message history requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.require_conversation_actor(text,boolean)') IS NULL OR to_regclass('hon.family_messages') IS NULL
    OR to_regclass('hon.communication_deliveries') IS NULL OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='hon.communication_messages'::regclass AND attname='email_subject' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Contact message history requires 0224, 0243, 0330, 0364 and 0423';
  END IF;
END $$;

CREATE TABLE hon.communication_message_resends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  person_id uuid NOT NULL,
  original_message_id uuid NOT NULL,
  resent_message_id uuid NOT NULL UNIQUE,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (original_message_id,organization_id,school_id) REFERENCES hon.communication_messages(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (resent_message_id,organization_id,school_id) REFERENCES hon.communication_messages(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  CHECK (original_message_id<>resent_message_id)
);
CREATE INDEX communication_message_resends_original ON hon.communication_message_resends(original_message_id,created_at);
CREATE INDEX communication_message_resends_person ON hon.communication_message_resends(person_id,created_at);
ALTER TABLE hon.communication_message_resends ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.communication_message_resends FORCE ROW LEVEL SECURITY;
CREATE TRIGGER communication_message_resends_immutable BEFORE UPDATE OR DELETE ON hon.communication_message_resends
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER communication_message_resends_no_truncate BEFORE TRUNCATE ON hon.communication_message_resends
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- The subject the email adapter uses when the author wrote none (SendGridEmailProvider.requestBody, school deliveries).
CREATE FUNCTION hon.contact_message_standard_subject(school_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT 'A message from '||coalesce(nullif(left(btrim(regexp_replace(coalesce(school_name,''),E'[\\r\\n"<>]',' ','g'),E' \t\n\r\f\v'),80),''),'Your school')
$$;

-- Worker: the author's subject of the email a lease is sending (NULL: the adapter uses the standard subject). VOLATILE so
-- that, called in the same statement as hon.claim_communication_deliveries, it sees the lease that claim just took.
CREATE FUNCTION hon.communication_email_subject(p_delivery uuid, p_lease uuid) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT m.email_subject FROM hon.communication_deliveries d JOIN hon.communication_messages m
    ON m.id=d.message_id AND m.organization_id=d.organization_id AND m.school_id=d.school_id
  WHERE d.id=p_delivery AND p_lease IS NOT NULL AND d.lease_token=p_lease AND d.status='SENDING' AND d.channel='EMAIL' AND m.channel='EMAIL'
$$;

-- Delivery state of one 0047 message: the 0243 delivery status, else QUEUED or CANCELLED.
CREATE FUNCTION hon.contact_message_delivery_state(m hon.communication_messages) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT d.status::text FROM hon.communication_deliveries d WHERE d.message_id=m.id),
    CASE m.lifecycle WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'QUEUED' THEN 'QUEUED' ELSE 'DRAFT' END)
$$;

-- Where a 0047 message came from.
CREATE FUNCTION hon.contact_message_origin(m hon.communication_messages) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN m.origin_kind='CONVERSATION_AI' OR EXISTS(SELECT 1 FROM hon.school_conversation_messages x WHERE x.communication_message_id=m.id)
    THEN 'CONVERSATION' WHEN m.origin_kind IN ('CAMPAIGN','AUTOMATION') THEN m.origin_kind ELSE 'STAFF' END
$$;

-- Every history row of one person of the session school. Family rows only when asked for (the reader may see them).
CREATE FUNCTION hon.contact_message_rows(p_person uuid, p_family boolean)
RETURNS TABLE(message_id uuid, source text, channel text, direction text, origin text, body text, subj text, occurred timestamptz,
  by_name text, delivery text, failure_code text, resent_from uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT m.id,'QUEUE',m.channel::text,'SENT',hon.contact_message_origin(m),m.content,
    CASE WHEN m.channel='EMAIL' THEN coalesce(m.email_subject,hon.contact_message_standard_subject((SELECT s.name FROM hon.schools s WHERE s.id=m.school_id))) END,
    date_trunc('milliseconds',m.created_at),(SELECT p.display_name FROM hon.principals p WHERE p.id=m.created_by_principal_id),
    hon.contact_message_delivery_state(m),(SELECT d.failure_code FROM hon.communication_deliveries d WHERE d.message_id=m.id),
    (SELECT r.original_message_id FROM hon.communication_message_resends r WHERE r.resent_message_id=m.id)
  FROM hon.communication_messages m
  WHERE m.organization_id=hon.current_organization_id() AND m.school_id=hon.current_school_id() AND m.recipient_person_id=p_person AND m.lifecycle<>'DRAFT'
  UNION ALL
  SELECT x.id,'CONVERSATION',c.channel,'RECEIVED','CONVERSATION',x.body,NULL,date_trunc('milliseconds',x.occurred_at),NULL,NULL,NULL,NULL
  FROM hon.school_conversation_messages x JOIN hon.school_conversations c ON c.id=x.conversation_id
  WHERE c.organization_id=hon.current_organization_id() AND c.school_id=hon.current_school_id() AND c.person_id=p_person AND x.direction='INBOUND'
  UNION ALL
  SELECT f.id,'FAMILY','APP',CASE f.author_kind WHEN 'FAMILY' THEN 'RECEIVED' ELSE 'SENT' END,'FAMILY',f.body,NULL,date_trunc('milliseconds',f.created_at),
    (SELECT p.display_name FROM hon.principals p WHERE p.id=f.author_principal_id),NULL,NULL,NULL
  FROM hon.family_messages f
  WHERE p_family AND f.organization_id=hon.current_organization_id() AND f.school_id=hon.current_school_id()
    AND f.family_id IN (SELECT fm.family_id FROM hon.family_members fm WHERE fm.person_id=p_person
      AND fm.organization_id=hon.current_organization_id() AND fm.school_id=hon.current_school_id())
$$;

-- The person of the session school, or CONTACT_NOT_FOUND.
CREATE FUNCTION hon.contact_message_person(p_person uuid) RETURNS hon.people
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE pe hon.people;
BEGIN
  SELECT * INTO pe FROM hon.people x WHERE x.id=p_person AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTACT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN pe;
END $$;

-- H1 read. p: optional range (ALL, TODAY, DAYS_7, DAYS_30), search (1-60 characters) and before {at, id} from nextCursor.
CREATE FUNCTION hon.read_contact_message_history(subject text, p_person uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; pe hon.people; v_range text; v_search text; v_at timestamptz; v_id uuid; v_from timestamptz; tz text; family boolean;
  v_rows jsonb; v_total integer; v_more boolean;
BEGIN
  IF p_person IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('range','search','before'))
    OR (p ? 'range' AND (jsonb_typeof(p->'range') IS DISTINCT FROM 'string' OR p->>'range' NOT IN ('ALL','TODAY','DAYS_7','DAYS_30')))
    OR (p ? 'search' AND (jsonb_typeof(p->'search') IS DISTINCT FROM 'string' OR length(p->>'search') NOT BETWEEN 1 AND 60
      OR btrim(p->>'search')<>p->>'search' OR p->>'search' ~ '[[:cntrl:]]'))
    OR (p ? 'before' AND (jsonb_typeof(p->'before') IS DISTINCT FROM 'object' OR NOT (p->'before') ?& ARRAY['at','id']
      OR (SELECT count(*) FROM jsonb_object_keys(p->'before'))<>2 OR NOT hon.conversation_uuid_ok(p->'before'->'id')
      OR jsonb_typeof(p->'before'->'at') IS DISTINCT FROM 'string' OR p->'before'->>'at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_conversation_actor(subject,false);
  pe:=hon.contact_message_person(p_person);
  family:=hon.conversation_staff_has(actor,pe.organization_id,pe.school_id,'family_messages.manage');
  v_range:=coalesce(p->>'range','ALL'); v_search:=lower(p->>'search');
  IF p ? 'before' THEN v_at:=(p->'before'->>'at')::timestamptz; v_id:=(p->'before'->>'id')::uuid; END IF;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=pe.school_id;
  v_from:=CASE v_range WHEN 'TODAY' THEN (date_trunc('day',clock_timestamp() AT TIME ZONE tz)) AT TIME ZONE tz
    WHEN 'DAYS_7' THEN clock_timestamp()-interval '7 days' WHEN 'DAYS_30' THEN clock_timestamp()-interval '30 days' END;
  WITH r AS (SELECT * FROM hon.contact_message_rows(pe.id,family) x
    WHERE (v_from IS NULL OR x.occurred>=v_from)
      AND (v_search IS NULL OR strpos(lower(x.body),v_search)>0 OR strpos(lower(coalesce(x.subj,'')),v_search)>0)),
  page AS (SELECT * FROM r WHERE v_at IS NULL OR (r.occurred,r.message_id)<(v_at,v_id) ORDER BY r.occurred DESC, r.message_id DESC LIMIT 51)
  SELECT (SELECT count(*) FROM r),
    (SELECT count(*)>50 FROM page),
    coalesce((SELECT jsonb_agg(jsonb_build_object('messageId',q.message_id,'source',q.source,'channel',q.channel,'direction',q.direction,
      'origin',q.origin,'subject',q.subj,'preview',left(btrim(regexp_replace(q.body,'[[:cntrl:][:space:]]+',' ','g')),160),'at',hon.conversation_time(q.occurred),
      'by',q.by_name,'delivery',q.delivery,'failureCode',q.failure_code,'resentFrom',q.resent_from) ORDER BY q.occurred DESC, q.message_id DESC)
      FROM (SELECT * FROM page ORDER BY page.occurred DESC, page.message_id DESC LIMIT 50) q),'[]'::jsonb)
  INTO v_total,v_more,v_rows;
  IF hon.require_conversation_actor(subject,false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('personId',pe.id,'total',v_total,'messages',v_rows,'includesFamily',family,
    'nextCursor',CASE WHEN v_more THEN jsonb_build_object('at',v_rows->49->'at','id',v_rows->49->'messageId') END);
END $$;

-- Why a resend of m to its person cannot happen now (NULL: it can). The caller holds the person lock for counting.
CREATE FUNCTION hon.contact_email_resend_block(m hon.communication_messages, pe hon.people) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE
    WHEN m.channel<>'EMAIL' OR m.lifecycle<>'QUEUED' THEN 'NOT_SENT'
    WHEN pe.email IS NULL OR btrim(pe.email::text)='' THEN 'EMAIL_MISSING'
    WHEN (SELECT k.status::text FROM hon.communication_consents k WHERE k.person_id=pe.id AND k.organization_id=pe.organization_id
      AND k.school_id=pe.school_id AND k.channel='EMAIL') IS DISTINCT FROM 'OPTED_IN' THEN 'CONSENT_REQUIRED'
    WHEN (SELECT count(*) FROM hon.communication_message_resends r WHERE r.original_message_id=m.id AND r.created_at>clock_timestamp()-interval '24 hours')>=3
      OR (SELECT count(*) FROM hon.communication_message_resends r WHERE r.person_id=pe.id AND r.created_at>clock_timestamp()-interval '24 hours')>=10
      THEN 'LIMIT_REACHED' END
$$;

-- The 0047 email message of the person in the session school, or CONTACT_MESSAGE_NOT_FOUND.
CREATE FUNCTION hon.contact_email_message(p_person uuid, p_message uuid) RETURNS hon.communication_messages
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE m hon.communication_messages;
BEGIN
  SELECT * INTO m FROM hon.communication_messages x WHERE x.id=p_message AND x.organization_id=hon.current_organization_id()
    AND x.school_id=hon.current_school_id() AND x.recipient_person_id=p_person AND x.channel='EMAIL' AND x.lifecycle<>'DRAFT';
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTACT_MESSAGE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN m;
END $$;

-- H2 read: one email exactly as stored and sent.
CREATE FUNCTION hon.read_contact_message_email(subject text, p_person uuid, p_message uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; pe hon.people; m hon.communication_messages; d hon.communication_deliveries; can boolean; block text; result jsonb;
BEGIN
  IF p_person IS NULL OR p_message IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_conversation_actor(subject,false);
  pe:=hon.contact_message_person(p_person);
  m:=hon.contact_email_message(pe.id,p_message);
  SELECT * INTO d FROM hon.communication_deliveries x WHERE x.message_id=m.id;
  can:=hon.conversation_staff_has(actor,pe.organization_id,pe.school_id,'conversation.manage')
    AND hon.conversation_staff_has(actor,pe.organization_id,pe.school_id,'communication.message.queue');
  block:=CASE WHEN NOT can THEN 'NOT_ALLOWED' ELSE hon.contact_email_resend_block(m,pe) END;
  result:=jsonb_build_object(
    'message',jsonb_build_object('messageId',m.id,'personId',pe.id,'origin',hon.contact_message_origin(m),
      'subject',coalesce(m.email_subject,hon.contact_message_standard_subject((SELECT s.name FROM hon.schools s WHERE s.id=m.school_id))),
      'subjectStandard',m.email_subject IS NULL,'body',m.content,'at',hon.conversation_time(m.created_at),
      'by',(SELECT p.display_name FROM hon.principals p WHERE p.id=m.created_by_principal_id)),
    'delivery',jsonb_build_object('status',hon.contact_message_delivery_state(m),'failureCode',d.failure_code,'attempts',coalesce(d.attempt_count,0),
      'acceptedAt',hon.conversation_time(d.accepted_at),'finalAt',hon.conversation_time(d.final_at),
      'events',coalesce((SELECT jsonb_agg(jsonb_build_object('type',e.event_type::text,'at',hon.conversation_time(e.occurred_at)) ORDER BY e.occurred_at,e.id)
        FROM (SELECT * FROM hon.communication_delivery_events e0 WHERE e0.delivery_id=d.id ORDER BY e0.occurred_at,e0.id LIMIT 50) e),'[]'::jsonb)),
    'savedAddress',nullif(btrim(pe.email::text),''),
    'emailConsent',coalesce((SELECT k.status::text FROM hon.communication_consents k WHERE k.person_id=pe.id AND k.organization_id=pe.organization_id
      AND k.school_id=pe.school_id AND k.channel='EMAIL'),'NONE'),
    'resentFrom',(SELECT r.original_message_id FROM hon.communication_message_resends r WHERE r.resent_message_id=m.id),
    'resends',coalesce((SELECT jsonb_agg(jsonb_build_object('messageId',r.resent_message_id,'at',hon.conversation_time(r.created_at),
      'by',(SELECT p.display_name FROM hon.principals p WHERE p.id=r.principal_id)) ORDER BY r.created_at,r.id)
      FROM hon.communication_message_resends r WHERE r.original_message_id=m.id),'[]'::jsonb),
    'canResend',block IS NULL,'resendBlocked',block);
  IF hon.require_conversation_actor(subject,false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- The resend actor: conversation.manage (require_conversation_actor) and communication.message.queue, now.
CREATE FUNCTION hon.require_contact_resend_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.require_conversation_actor(subject,true);
BEGIN
  IF NOT hon.conversation_staff_has(actor,hon.current_organization_id(),hon.current_school_id(),'communication.message.queue') THEN
    RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- H3 command. p: {personId, messageId}.
CREATE FUNCTION hon.resend_contact_message_email(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior jsonb; pe hon.people; m hon.communication_messages; block text; v_new uuid; v_at timestamptz; ids jsonb; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['personId','messageId'] OR (SELECT count(*) FROM jsonb_object_keys(p))<>2
    OR NOT hon.conversation_uuid_ok(p->'personId') OR NOT hon.conversation_uuid_ok(p->'messageId')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_contact_resend_actor(subject);
  prior:=hon.conversation_command_begin(actor,key,encode(sha256(convert_to('contact.email.resend:'||(p->>'personId')||':'||(p->>'messageId'),'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_contact_resend_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  -- The person lock serializes the 24-hour counts of every resend to this person.
  SELECT * INTO pe FROM hon.people x WHERE x.id=(p->>'personId')::uuid AND x.organization_id=hon.current_organization_id()
    AND x.school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTACT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  m:=hon.contact_email_message(pe.id,(p->>'messageId')::uuid);
  PERFORM 1 FROM hon.communication_consents k WHERE k.person_id=pe.id AND k.organization_id=pe.organization_id AND k.school_id=pe.school_id
    AND k.channel='EMAIL' FOR SHARE;
  block:=hon.contact_email_resend_block(m,pe);
  IF block IS NOT NULL THEN RAISE EXCEPTION '%', 'CONTACT_RESEND_'||block USING ERRCODE='55000'; END IF;
  INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,lifecycle,created_by_principal_id,queued_by_principal_id,email_subject)
    VALUES(m.organization_id,m.school_id,pe.id,'EMAIL',m.content,'QUEUED',actor,actor,m.email_subject) RETURNING id,created_at INTO v_new,v_at;
  INSERT INTO hon.communication_message_resends(organization_id,school_id,person_id,original_message_id,resent_message_id,principal_id)
    VALUES(m.organization_id,m.school_id,pe.id,m.id,v_new,actor);
  ids:=jsonb_build_object('messageId',v_new,'resentFrom',m.id,'personId',pe.id);
  result:=jsonb_build_object('messageId',v_new,'resentFrom',m.id,'personId',pe.id,'channel','EMAIL','delivery','QUEUED','at',hon.conversation_time(v_at));
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(m.organization_id,m.school_id,actor,'HUMAN_UI','communication.message.resend','COMMUNICATION_MESSAGE',v_new,
      jsonb_build_object('messageId',m.id),ids,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(m.organization_id,m.school_id,'communication.message.resent',1,'COMMUNICATION_MESSAGE',v_new,1,correlation,request,ids);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=m.organization_id AND school_id=m.school_id AND principal_id=actor AND idempotency_key=key;
  IF hon.require_contact_resend_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_contact_message_history(text,uuid,jsonb)','hon.read_contact_message_email(text,uuid,uuid)',
    'hon.resend_contact_message_email(text,jsonb,text,uuid,uuid)'];
  worker text:='hon.communication_email_subject(uuid,uuid)';
  fns text[]:=ARRAY['hon.contact_message_standard_subject(text)','hon.contact_message_delivery_state(hon.communication_messages)',
    'hon.contact_message_origin(hon.communication_messages)','hon.contact_message_rows(uuid,boolean)','hon.contact_message_person(uuid)',
    'hon.contact_email_resend_block(hon.communication_messages,hon.people)','hon.contact_email_message(uuid,uuid)',
    'hon.require_contact_resend_actor(text)']||entry||worker; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.communication_message_resends FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.communication_message_resends FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_communication_worker',worker);
  END IF;
END $$;

COMMIT;
