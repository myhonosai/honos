BEGIN;
-- Action Engine decisions are APPROVED/DENIED while the private Chad invocation
-- state machine is APPROVED/REJECTED. Never persist the Action Engine enum into
-- the invocation row: record the durable content-proposal result instead.
CREATE OR REPLACE FUNCTION hon.transition_chad_follow_up_draft(p_action uuid,p_decision text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.chad_follow_up_invocations%ROWTYPE;
BEGIN
 IF p_decision NOT IN('APPROVED','DENIED') OR NOT hon.human_action_reviewer() THEN RAISE EXCEPTION 'REVIEW_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO i FROM hon.chad_follow_up_invocations WHERE action_request_id=p_action AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR UPDATE;
 IF NOT FOUND OR i.status<>'AWAITING_APPROVAL' OR NOT EXISTS(SELECT 1 FROM hon.action_requests a JOIN hon.action_approvals ap ON ap.action_request_id=a.id WHERE a.id=p_action AND a.status=p_decision::hon.action_request_status AND ap.decision=p_decision::hon.approval_decision AND ap.reviewed_payload_hash=a.payload_hash AND ap.reviewed_policy_version=a.policy_version AND ap.reviewer_principal_id<>i.requested_by) THEN RAISE EXCEPTION 'CHAD_FOLLOW_UP_DECISION_BINDING' USING ERRCODE='42501'; END IF;
 UPDATE hon.chad_follow_up_invocations SET status=CASE WHEN p_decision='APPROVED' THEN 'APPROVED' ELSE 'REJECTED' END,updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status=CASE WHEN p_decision='APPROVED' THEN 'COMPLETED' ELSE 'FAILED' END,version=version+1,result=jsonb_build_object('invocationId',i.id,'leadId',i.lead_id,'contentProposalOnly',true,'delivery','NOT_CREATED_OR_SENT') WHERE id=i.work_item_id;
 PERFORM hon.chad_follow_up_event(i.id,CASE WHEN p_decision='APPROVED' THEN 'chad.follow_up_draft.approved' ELSE 'chad.follow_up_draft.rejected' END);
END $$;
REVOKE ALL ON FUNCTION hon.transition_chad_follow_up_draft(uuid,text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.transition_chad_follow_up_draft(uuid,text) TO hon_runtime; END IF;
END $$;
COMMIT;
