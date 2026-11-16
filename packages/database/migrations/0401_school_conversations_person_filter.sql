BEGIN;

-- 0401 contact card texts (owner, 2026-11-16: one Contacts page; docs/architecture/CONTACTS_ONE_PAGE_SPEC.md slice B).
-- The staff inbox read (0364 C2) takes one more optional filter, personId: only that person's conversations in the caller's
-- current school, ANDed with every other filter. Nothing else changes: the same actor check before and after the read, the
-- same school scope from the verified session, the same rows, cursor and unread count. No grant changes (CREATE OR REPLACE
-- keeps the 0364 EXECUTE grant), no table changes.

CREATE OR REPLACE FUNCTION hon.read_school_conversations(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_status text; v_assigned text; v_unread boolean; v_tag text; v_search text; v_digits text; v_at timestamptz; v_id uuid; v_person uuid;
  rows jsonb; next jsonb; result jsonb; n integer;
BEGIN
  IF NOT hon.conversation_input_ok(p,ARRAY[]::text[],ARRAY['status','assigned','unreadOnly','tag','search','before','personId'])
    OR (p ? 'status' AND (jsonb_typeof(p->'status')<>'string' OR p->>'status' NOT IN ('OPEN','CLOSED','ALL')))
    OR (p ? 'assigned' AND (jsonb_typeof(p->'assigned')<>'string' OR p->>'assigned' NOT IN ('ANY','ME','NONE')))
    OR (p ? 'unreadOnly' AND jsonb_typeof(p->'unreadOnly')<>'boolean')
    OR (p ? 'tag' AND (jsonb_typeof(p->'tag')<>'string' OR NOT hon.conversation_tags_ok(ARRAY[p->>'tag'])))
    OR (p ? 'search' AND (jsonb_typeof(p->'search')<>'string' OR length(p->>'search') NOT BETWEEN 1 AND 60 OR btrim(p->>'search')<>p->>'search' OR p->>'search' ~ '[[:cntrl:]]'))
    OR (p ? 'personId' AND NOT hon.conversation_uuid_ok(p->'personId'))
    OR (p ? 'before' AND (jsonb_typeof(p->'before')<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p->'before') k) IS DISTINCT FROM ARRAY['at','id']
      OR NOT hon.conversation_uuid_ok(p->'before'->'id') OR jsonb_typeof(p->'before'->'at')<>'string'
      OR p->'before'->>'at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_conversation_actor(subject,false);
  v_status:=coalesce(p->>'status','OPEN'); v_assigned:=coalesce(p->>'assigned','ANY'); v_unread:=coalesce((p->>'unreadOnly')::boolean,false);
  v_tag:=p->>'tag'; v_search:=p->>'search'; v_digits:=nullif(regexp_replace(coalesce(v_search,''),'[^0-9]','','g'),'');
  v_at:=(p->'before'->>'at')::timestamptz; v_id:=(p->'before'->>'id')::uuid; v_person:=(p->>'personId')::uuid;
  SELECT coalesce(jsonb_agg(hon.conversation_row_json(x) ORDER BY x.last_message_at DESC, x.id DESC),'[]'), count(*) INTO rows, n FROM (
    SELECT c.* FROM hon.school_conversations c LEFT JOIN hon.people pe ON pe.id=c.person_id
    WHERE c.organization_id=hon.current_organization_id() AND c.school_id=hon.current_school_id()
      AND (v_status='ALL' OR c.status=v_status)
      AND (v_assigned='ANY' OR (v_assigned='ME' AND c.assigned_principal_id=actor) OR (v_assigned='NONE' AND c.assigned_principal_id IS NULL))
      AND (NOT v_unread OR c.unread>0)
      AND (v_tag IS NULL OR lower(v_tag)=ANY(SELECT lower(t) FROM unnest(c.tags) t))
      AND (v_search IS NULL OR strpos(lower(coalesce(pe.given_name,'')||' '||coalesce(pe.family_name,'')),lower(v_search))>0
        OR (v_digits IS NOT NULL AND strpos(c.contact_address,v_digits)>0) OR lower(v_search)=ANY(SELECT lower(t) FROM unnest(c.tags) t))
      AND (v_person IS NULL OR c.person_id=v_person)
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

COMMIT;
