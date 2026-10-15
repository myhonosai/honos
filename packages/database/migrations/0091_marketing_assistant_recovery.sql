BEGIN;
CREATE FUNCTION hon.marketing_planning_reference(p_subject text,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.marketing_owner(p_subject); i hon.marketing_ai_invocations%ROWTYPE; w hon.work_items%ROWTYPE;
BEGIN
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MARKETING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '30 seconds' THEN UPDATE hon.marketing_ai_invocations SET status='UNKNOWN',reason='PROVIDER_UNKNOWN',updated_at=clock_timestamp() WHERE id=i.id; UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1 WHERE id=i.work_item_id; PERFORM hon.marketing_event(i.id,'marketing.assistant.unknown'); RETURN NULL; END IF;
 IF i.status NOT IN('PENDING','CONFIGURATION_REQUIRED','BLOCKED') THEN RETURN NULL; END IF;
 SELECT * INTO STRICT w FROM hon.work_items WHERE id=i.work_item_id AND organization_id=i.organization_id AND school_id=i.school_id FOR UPDATE;
 IF i.plan_id IS NULL AND w.status<>'READY' THEN UPDATE hon.work_items SET status='READY',version=version+1 WHERE id=w.id RETURNING * INTO w; END IF;
 RETURN jsonb_build_object('planId',i.plan_id,'workItemId',w.id,'workVersion',w.version);
END $$;
CREATE FUNCTION hon.read_marketing_campaign_content(p_subject text,p_campaign uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.lock_campaign_actor(p_subject,'marketing.campaign.read'); result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM hon.marketing_campaigns WHERE id=p_campaign AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()) THEN RAISE EXCEPTION 'MARKETING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('title',title,'content',content,'savedAt',saved_at) ORDER BY saved_at,invocation_id),'[]'::jsonb) INTO result FROM (SELECT * FROM hon.marketing_campaign_content WHERE campaign_id=p_campaign AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() ORDER BY saved_at DESC,invocation_id LIMIT 100) c; RETURN result;
END $$;
REVOKE ALL ON FUNCTION hon.marketing_planning_reference(text,uuid),hon.read_marketing_campaign_content(text,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.marketing_planning_reference(text,uuid),hon.read_marketing_campaign_content(text,uuid) TO hon_runtime; END IF; END $$;
COMMIT;
