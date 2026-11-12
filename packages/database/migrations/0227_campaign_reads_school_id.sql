BEGIN;

-- Campaign reads name their school (0227, owner-allocated 2026-11-09; P3 from the PR #173 review). The LIST, CURRENT and
-- FUNNEL reads of hon.read_campaigns now include "schoolId" (the session school every row is already scoped to) on each
-- campaign summary, so a screen can prove the campaigns it shows belong to the school it is showing. Nothing else
-- changes: same signature, same authority checks (lock_campaign_actor before, require_campaign_actor after), same
-- 100-row LIST bound and funnel counts. A SAVED read still returns the immutable version snapshot exactly as stored, and
-- hon.campaign_summary (stored in idempotent receipts and lead attribution snapshots) is unchanged.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.read_campaigns(text,text,uuid,text,text,integer)') IS NULL THEN RAISE EXCEPTION '0227 requires 0073'; END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.read_campaigns(p_subject text,p_kind text,p_id uuid,p_from text,p_to text,p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); asof timestamptz:=clock_timestamp();
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN('LIST','CURRENT','SAVED','FUNNEL') OR ((p_kind='LIST')<>(p_id IS NULL))
 OR (p_kind<>'FUNNEL' AND (p_from IS NOT NULL OR p_to IS NOT NULL)) OR (p_kind='FUNNEL' AND (p_from IS NULL OR p_to IS NULL))
 OR (p_kind<>'SAVED' AND p_version IS NOT NULL) OR (p_kind='SAVED' AND (p_version IS NULL OR p_version NOT BETWEEN 1 AND 999999999)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_campaign_actor(p_subject,'marketing.campaign.read');
 IF p_kind='LIST' THEN
  SELECT coalesce(jsonb_agg(hon.campaign_summary(id)||jsonb_build_object('schoolId',school) ORDER BY updated_at DESC,id),'[]') INTO result FROM(
   SELECT id,updated_at FROM hon.marketing_campaigns WHERE organization_id=org AND school_id=school AND (status='ACTIVE' OR updated_at>=asof-interval '90 days') ORDER BY updated_at DESC,id LIMIT 100
  ) safe;
 ELSE
  result:=hon.campaign_summary(p_id);
  IF result IS NULL THEN RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- The live reads name the school they were scoped to; a SAVED read stays the exact immutable version snapshot.
  result:=result||jsonb_build_object('schoolId',school);
  IF p_kind='SAVED' THEN
   SELECT snapshot INTO result FROM hon.marketing_campaign_versions WHERE campaign_id=p_id AND version=p_version AND organization_id=org AND school_id=school;
   IF NOT FOUND THEN RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  ELSIF p_kind='FUNNEL' THEN
   PERFORM hon.validate_campaign_window(p_from,p_to,true);
   WITH cohort AS MATERIALIZED(
    SELECT l.id,l.status FROM hon.crm_leads l JOIN hon.crm_lead_attributions a ON a.lead_id=l.id AND a.organization_id=l.organization_id AND a.school_id=l.school_id
    WHERE l.organization_id=org AND l.school_id=school AND a.campaign_id=p_id AND l.created_at>=p_from::timestamptz AND l.created_at<p_to::timestamptz
   ), trials AS MATERIALIZED(
    SELECT a.id,a.crm_lead_id,a.status FROM hon.crm_appointments a JOIN cohort l ON l.id=a.crm_lead_id
    WHERE a.organization_id=org AND a.school_id=school AND a.appointment_type='TRIAL' AND a.starts_at>=p_from::timestamptz AND a.starts_at<p_to::timestamptz
   ) SELECT jsonb_build_object('campaign',result,'from',p_from,'to',p_to,'asOf',asof,
    'leads',(SELECT count(*) FROM cohort),'trialLeads',(SELECT count(DISTINCT crm_lead_id) FROM trials),'trialAppointments',(SELECT count(*) FROM trials),
    'completedTrialAppointments',(SELECT count(*) FROM trials WHERE status='COMPLETED'),
    'wonLeads',(SELECT count(*) FROM cohort WHERE status='WON'),'lostLeads',(SELECT count(*) FROM cohort WHERE status='LOST'),'archivedLeads',(SELECT count(*) FROM cohort WHERE status='ARCHIVED'),
    'enrollmentLinkage','UNAVAILABLE','revenueLinkage','UNAVAILABLE') INTO result;
  END IF;
 END IF;
 actor:=hon.require_campaign_actor(p_subject,'marketing.campaign.read'); RETURN result;
END $$;

-- CREATE OR REPLACE keeps the existing ACL; restate it deny-first so the result is exact.
REVOKE ALL ON FUNCTION hon.read_campaigns(text,text,uuid,text,text,integer) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_campaigns(text,text,uuid,text,text,integer) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_campaigns(text,text,uuid,text,text,integer) TO hon_runtime;
  END IF;
END $$;

COMMIT;
