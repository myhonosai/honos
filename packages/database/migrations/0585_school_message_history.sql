BEGIN;

-- 0585 Texts and Email pages piece TE1 (0542, then 0572, renumbered to 0585 by the ledger rule 2026-11-19 after #483 landed 0574; docs/architecture/SCHOOL_TEXTS_AND_EMAIL_PAGES.md §4).
-- The school-wide History tab of the Texts and Email pages, and their Opted out tab. Read only.
--   T1  Staff with communication.message.read see every non-draft 0047 message of the session school, newest first: who it
--       went to (name and the address on file now), channel, the email subject sent (0424), a 160-character preview, the
--       delivery state (0424 hon.contact_message_delivery_state), where it came from (0424 hon.contact_message_origin) and
--       who sent it. Filters: channel, outcome (DELIVERED, FAILED, IN_PROGRESS, CANCELLED), origin, range (ALL, TODAY in the
--       school time zone, DAYS_7, DAYS_30) and a 1-60 character search of name, phone, email, subject and body. Keyset pages
--       of 50. Demo people (0459) are left out. One message's full email and resend stay on the 0424 per-contact reads.
--   T2  Staff with communication.consent.read see the people of the school whose consent for a channel is OPTED_OUT
--       (0046 staff, 0248 STOP, 0243 unsubscribe or spam report), with when and how, newest first, keyset pages of 50, and
--       the same search. Demo people are left out. Recording an opt-out or opt-in stays on the existing consent command.
--   T3  Both reads check the session actor again after reading. No table privilege for the runtime: the two entry points
--       are SECURITY DEFINER and only they are granted. Nothing here sends, changes consent or calls AI.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School message history requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.contact_message_delivery_state(hon.communication_messages)') IS NULL
    OR to_regprocedure('hon.contact_message_origin(hon.communication_messages)') IS NULL
    OR to_regprocedure('hon.contact_message_standard_subject(text)') IS NULL
    OR to_regprocedure('hon.conversation_staff_has(uuid,uuid,uuid,text)') IS NULL
    OR to_regprocedure('hon.demo_data_is_demo(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'School message history requires 0364, 0424 and 0459';
  END IF;
END $$;

CREATE INDEX communication_messages_school_history ON hon.communication_messages (organization_id,school_id,created_at DESC,id DESC)
  WHERE lifecycle<>'DRAFT';

-- The staff actor of the session school holding p_permission, or SCHOOL_MESSAGES_FORBIDDEN. Same session rules as 0364.
CREATE FUNCTION hon.require_school_messages_actor(subject text, p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL OR p_permission NOT IN ('communication.message.read','communication.consent.read') THEN
    RAISE EXCEPTION 'SCHOOL_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
  IF NOT hon.conversation_staff_has(actor,org,school,p_permission) THEN
    RAISE EXCEPTION 'SCHOOL_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- The shared shape of p: optional search (1-60, trimmed, no control characters) and before {at, id}; extra allowed keys.
CREATE FUNCTION hon.school_messages_args_ok(p jsonb, p_keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(p)='object'
    AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT k=ANY(p_keys||ARRAY['search','before']))
    AND (NOT p ? 'search' OR (jsonb_typeof(p->'search')='string' AND length(p->>'search') BETWEEN 1 AND 60
      AND btrim(p->>'search')=p->>'search' AND p->>'search' !~ '[[:cntrl:]]'))
    AND (NOT p ? 'before' OR (jsonb_typeof(p->'before')='object' AND (p->'before') ?& ARRAY['at','id']
      AND (SELECT count(*) FROM jsonb_object_keys(p->'before'))=2 AND hon.conversation_uuid_ok(p->'before'->'id')
      AND jsonb_typeof(p->'before'->'at')='string' AND p->'before'->>'at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'))
$$;

-- The outcome group of a delivery state.
CREATE FUNCTION hon.school_message_outcome(p_state text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN p_state IN ('ACCEPTED','DELIVERED') THEN 'DELIVERED' WHEN p_state IN ('BOUNCED','FAILED','SUPPRESSED') THEN 'FAILED'
    WHEN p_state='CANCELLED' THEN 'CANCELLED' ELSE 'IN_PROGRESS' END
$$;

-- T1 read. p: optional channel, outcome, origin, range, search, before {at, id} from nextCursor.
CREATE FUNCTION hon.read_school_message_history(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid; school uuid; v_channel text; v_outcome text; v_origin text; v_range text; v_search text;
  v_at timestamptz; v_id uuid; v_from timestamptz; tz text; school_name text; v_rows jsonb; v_more boolean;
BEGIN
  IF NOT coalesce(hon.school_messages_args_ok(p,ARRAY['channel','outcome','origin','range']),false)
    OR (p ? 'channel' AND (jsonb_typeof(p->'channel') IS DISTINCT FROM 'string' OR p->>'channel' NOT IN ('SMS','EMAIL')))
    OR (p ? 'outcome' AND (jsonb_typeof(p->'outcome') IS DISTINCT FROM 'string' OR p->>'outcome' NOT IN ('DELIVERED','FAILED','IN_PROGRESS','CANCELLED')))
    OR (p ? 'origin' AND (jsonb_typeof(p->'origin') IS DISTINCT FROM 'string' OR p->>'origin' NOT IN ('STAFF','CONVERSATION','CAMPAIGN','AUTOMATION')))
    OR (p ? 'range' AND (jsonb_typeof(p->'range') IS DISTINCT FROM 'string' OR p->>'range' NOT IN ('ALL','TODAY','DAYS_7','DAYS_30'))) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_messages_actor(subject,'communication.message.read');
  org:=hon.current_organization_id(); school:=hon.current_school_id();
  v_channel:=p->>'channel'; v_outcome:=p->>'outcome'; v_origin:=p->>'origin'; v_range:=coalesce(p->>'range','ALL'); v_search:=lower(p->>'search');
  IF p ? 'before' THEN v_at:=(p->'before'->>'at')::timestamptz; v_id:=(p->'before'->>'id')::uuid; END IF;
  SELECT s.timezone,s.name INTO tz,school_name FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  v_from:=CASE v_range WHEN 'TODAY' THEN (date_trunc('day',clock_timestamp() AT TIME ZONE tz)) AT TIME ZONE tz
    WHEN 'DAYS_7' THEN clock_timestamp()-interval '7 days' WHEN 'DAYS_30' THEN clock_timestamp()-interval '30 days' END;
  WITH r AS (
    SELECT m.id, date_trunc('milliseconds',m.created_at) AS at, m.channel::text AS channel, m.content, m.created_by_principal_id,
      CASE WHEN m.channel='EMAIL' THEN coalesce(m.email_subject,hon.contact_message_standard_subject(school_name)) END AS subj,
      hon.contact_message_delivery_state(m) AS state, hon.contact_message_origin(m) AS origin,
      pe.id AS person_id, btrim(pe.given_name||' '||pe.family_name) AS person_name,
      CASE WHEN m.channel='SMS' THEN pe.phone_e164 ELSE nullif(btrim(pe.email::text),'') END AS address
    FROM hon.communication_messages m
    JOIN hon.people pe ON pe.id=m.recipient_person_id AND pe.organization_id=m.organization_id AND pe.school_id=m.school_id
    WHERE m.organization_id=org AND m.school_id=school AND m.lifecycle<>'DRAFT'
      AND (v_channel IS NULL OR m.channel::text=v_channel)
      AND (v_from IS NULL OR m.created_at>=v_from)
      AND (v_at IS NULL OR (date_trunc('milliseconds',m.created_at),m.id)<(v_at,v_id))
      AND NOT hon.demo_data_is_demo('people',pe.id)
      AND (v_search IS NULL OR strpos(lower(pe.given_name||' '||pe.family_name),v_search)>0
        OR strpos(coalesce(pe.phone_e164,''),v_search)>0 OR strpos(lower(coalesce(pe.email::text,'')),v_search)>0
        OR strpos(lower(coalesce(m.email_subject,'')),v_search)>0 OR strpos(lower(m.content),v_search)>0)
  ), f AS (
    SELECT * FROM r WHERE (v_outcome IS NULL OR hon.school_message_outcome(r.state)=v_outcome) AND (v_origin IS NULL OR r.origin=v_origin)
    ORDER BY r.at DESC, r.id DESC LIMIT 51
  )
  SELECT (SELECT count(*)>50 FROM f),
    coalesce((SELECT jsonb_agg(jsonb_build_object('messageId',q.id,'personId',q.person_id,'personName',q.person_name,
      'address',q.address,'channel',q.channel,'subject',q.subj,
      'preview',left(btrim(regexp_replace(q.content,'[[:cntrl:][:space:]]+',' ','g')),160),
      'at',hon.conversation_time(q.at),'origin',q.origin,'delivery',q.state,'outcome',hon.school_message_outcome(q.state),
      'by',(SELECT pr.display_name FROM hon.principals pr WHERE pr.id=q.created_by_principal_id)) ORDER BY q.at DESC, q.id DESC)
      FROM (SELECT * FROM f ORDER BY f.at DESC, f.id DESC LIMIT 50) q),'[]'::jsonb)
  INTO v_more,v_rows;
  IF hon.require_school_messages_actor(subject,'communication.message.read') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('messages',v_rows,
    'nextCursor',CASE WHEN v_more THEN jsonb_build_object('at',v_rows->49->'at','id',v_rows->49->'messageId') END);
END $$;

-- T2 read. p: optional channel (SMS, EMAIL), search, before {at, id} from nextCursor (id is the consent row).
CREATE FUNCTION hon.read_school_opted_out_contacts(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid; school uuid; v_channel text; v_search text; v_at timestamptz; v_id uuid; v_rows jsonb; v_more boolean;
BEGIN
  IF NOT coalesce(hon.school_messages_args_ok(p,ARRAY['channel']),false)
    OR (p ? 'channel' AND (jsonb_typeof(p->'channel') IS DISTINCT FROM 'string' OR p->>'channel' NOT IN ('SMS','EMAIL'))) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_messages_actor(subject,'communication.consent.read');
  org:=hon.current_organization_id(); school:=hon.current_school_id();
  v_channel:=p->>'channel'; v_search:=lower(p->>'search');
  IF p ? 'before' THEN v_at:=(p->'before'->>'at')::timestamptz; v_id:=(p->'before'->>'id')::uuid; END IF;
  WITH f AS (
    SELECT k.id, date_trunc('milliseconds',k.updated_at) AS at, k.channel::text AS channel, k.source::text AS source,
      date_trunc('milliseconds',k.captured_at) AS captured, pe.id AS person_id, btrim(pe.given_name||' '||pe.family_name) AS person_name,
      CASE WHEN k.channel::text='SMS' THEN pe.phone_e164 ELSE nullif(btrim(pe.email::text),'') END AS address
    FROM hon.communication_consents k
    JOIN hon.people pe ON pe.id=k.person_id AND pe.organization_id=k.organization_id AND pe.school_id=k.school_id
    WHERE k.organization_id=org AND k.school_id=school AND k.status='OPTED_OUT'
      AND (v_channel IS NULL OR k.channel::text=v_channel)
      AND (v_at IS NULL OR (date_trunc('milliseconds',k.updated_at),k.id)<(v_at,v_id))
      AND NOT hon.demo_data_is_demo('people',pe.id)
      AND (v_search IS NULL OR strpos(lower(pe.given_name||' '||pe.family_name),v_search)>0
        OR strpos(coalesce(pe.phone_e164,''),v_search)>0 OR strpos(lower(coalesce(pe.email::text,'')),v_search)>0)
    ORDER BY 2 DESC, 1 DESC LIMIT 51
  )
  SELECT (SELECT count(*)>50 FROM f),
    coalesce((SELECT jsonb_agg(jsonb_build_object('consentId',q.id,'personId',q.person_id,'personName',q.person_name,'address',q.address,
      'channel',q.channel,'source',q.source,'optedOutAt',hon.conversation_time(q.captured),'at',hon.conversation_time(q.at))
      ORDER BY q.at DESC, q.id DESC) FROM (SELECT * FROM f ORDER BY f.at DESC, f.id DESC LIMIT 50) q),'[]'::jsonb)
  INTO v_more,v_rows;
  IF hon.require_school_messages_actor(subject,'communication.consent.read') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('contacts',v_rows,
    'nextCursor',CASE WHEN v_more THEN jsonb_build_object('at',v_rows->49->'at','id',v_rows->49->'consentId') END);
END $$;

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_school_message_history(text,jsonb)','hon.read_school_opted_out_contacts(text,jsonb)'];
  fns text[]:=ARRAY['hon.require_school_messages_actor(text,text)','hon.school_messages_args_ok(jsonb,text[])',
    'hon.school_message_outcome(text)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
