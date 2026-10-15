BEGIN;
CREATE FUNCTION hon.guard_curriculum_structure_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id
  OR (TG_TABLE_NAME='curriculum_ranks' AND to_jsonb(NEW)->>'curriculum_id' IS DISTINCT FROM to_jsonb(OLD)->>'curriculum_id') THEN
  RAISE EXCEPTION 'IMMUTABLE_CURRICULUM_STRUCTURE' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER curriculum_structure_identity BEFORE UPDATE ON hon.curricula FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_structure_identity();
CREATE TRIGGER rank_structure_identity BEFORE UPDATE ON hon.curriculum_ranks FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_structure_identity();
-- Live guardian scope: one active human, explicit grant and active topology.
CREATE OR REPLACE FUNCTION hon.resolve_parent_family_scope(p_external_subject text,p_school_id uuid)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid,family_id uuid,access_level hon.family_access_level)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT DISTINCT ON(g.family_id) p.id,g.organization_id,g.school_id,g.family_id,g.access_level
 FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
 JOIN hon.family_access_grants g ON g.principal_id=p.id AND g.school_id=p_school_id
 JOIN hon.families f ON f.id=g.family_id AND f.organization_id=g.organization_id AND f.school_id=g.school_id
 JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id
 JOIN hon.organizations o ON o.id=s.organization_id
 WHERE u.external_subject=p_external_subject AND f.status='ACTIVE' AND s.status='ACTIVE' AND o.status='ACTIVE'
 AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active AND x.principal_type='HUMAN_USER')=1
 AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 ORDER BY g.family_id,CASE g.access_level WHEN 'PRIMARY_GUARDIAN' THEN 3 WHEN 'SECONDARY_GUARDIAN' THEN 2 ELSE 1 END DESC,g.effective_from DESC,g.id;
$$;
-- Preserve the shared permission boundary's principal types; tighten human
-- ambiguity, school-managed roles and live expiry for its existing RLS callers.
CREATE OR REPLACE FUNCTION hon.principal_has_school_permission(p_principal_id uuid,p_organization_id uuid,p_school_id uuid,p_permission_code text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT EXISTS(SELECT 1 FROM hon.principals p JOIN hon.principal_role_grants g ON g.principal_id=p.id
 JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
 JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
 JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id JOIN hon.organizations o ON o.id=s.organization_id
 WHERE p.id=p_principal_id AND p.is_active AND g.organization_id=p_organization_id AND g.school_id=p_school_id
 AND (p.principal_type<>'HUMAN_USER' OR (SELECT count(*) FROM hon.principals x WHERE x.user_id=p.user_id AND x.is_active AND x.principal_type='HUMAN_USER')=1)
 AND (r.management_school_id IS NULL OR r.management_school_id=s.id) AND s.status='ACTIVE' AND o.status='ACTIVE'
 AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()) AND rp.permission_code=p_permission_code);
$$;

-- Existing instructor services need locked dependencies, not broader table ACLs.
CREATE FUNCTION hon.lock_human_testing_authority(p_permission text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
BEGIN
 IF p_permission IS NULL OR p_permission NOT IN('testing.manage','testing.promotion.decide')
 OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
 RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
 IF NOT hon.principal_has_school_permission(actor,org,school,p_permission) OR NOT EXISTS(SELECT 1 FROM hon.principals WHERE id=actor AND principal_type='HUMAN_USER' AND is_active) THEN RAISE EXCEPTION 'TESTING_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.organizations WHERE id=org FOR UPDATE;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org FOR UPDATE;
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor AND principal_type='HUMAN_USER' AND is_active FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'TESTING_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 IF NOT hon.principal_has_school_permission(actor,org,school,p_permission) THEN RAISE EXCEPTION 'TESTING_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION hon.lock_human_testing_record(p_permission text,p_kind text,p_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
 PERFORM hon.lock_human_testing_authority(p_permission);
 IF p_id IS NULL OR p_kind IS NULL OR p_kind NOT IN('EVENT','RANK','CANDIDATE') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p_kind='EVENT' THEN
  PERFORM 1 FROM hon.testing_events WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR SHARE;
 ELSIF p_kind='RANK' THEN
  PERFORM 1 FROM hon.curriculum_ranks WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR SHARE;
 ELSE
  PERFORM 1 FROM hon.testing_candidates WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR UPDATE;
 END IF;
 -- Scoped subsequent RLS SELECTs own the API's clean absent-record response.
END $$;
REVOKE ALL ON FUNCTION hon.lock_human_testing_authority(text),hon.lock_human_testing_record(text,text,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.lock_human_testing_authority(text),hon.lock_human_testing_record(text,text,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.lock_human_testing_authority(text),hon.lock_human_testing_record(text,text,uuid) TO hon_runtime;
  REVOKE UPDATE ON hon.testing_candidates FROM hon_runtime;
  GRANT UPDATE(result,instructor_notes,version,updated_at) ON hon.testing_candidates TO hon_runtime;
 END IF;
END $$;

-- A column UPDATE grant is necessary even for SELECT ... FOR UPDATE/KEY SHARE.
-- USING permits testing's dependency locks; WITH CHECK permits only promotion.
-- A deferred evidence trigger below prevents a permitted human from using that
-- grant as an unrecorded rank-placement command. Definer placements supply their
-- own append-only history, audit and inert outbox within the same transaction.
REVOKE INSERT,UPDATE,DELETE ON hon.student_curriculum_enrollments FROM PUBLIC;
CREATE POLICY enrollment_human_promotion_update ON hon.student_curriculum_enrollments AS RESTRICTIVE FOR UPDATE
 USING(current_setting('app.hon_principal_type',true)='HUMAN_USER' AND current_setting('app.hon_source',true)='HUMAN_UI'
 AND nullif(current_setting('app.hon_action_request_id',true),'') IS NULL AND nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NULL
 AND (hon.principal_has_school_permission(nullif(current_setting('app.hon_principal_id',true),'')::uuid,organization_id,school_id,'testing.promotion.decide')
 OR hon.principal_has_school_permission(nullif(current_setting('app.hon_principal_id',true),'')::uuid,organization_id,school_id,'testing.manage')))
 WITH CHECK(current_setting('app.hon_principal_type',true)='HUMAN_USER' AND current_setting('app.hon_source',true)='HUMAN_UI'
 AND nullif(current_setting('app.hon_action_request_id',true),'') IS NULL AND nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NULL
 AND hon.principal_has_school_permission(nullif(current_setting('app.hon_principal_id',true),'')::uuid,organization_id,school_id,'testing.promotion.decide'));
CREATE FUNCTION hon.verify_curriculum_enrollment_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
 request uuid:=nullif(current_setting('app.hon_request_id',true),'')::uuid;
 xid_text text:=(pg_current_xact_id()::text::bigint % 4294967296)::text;
BEGIN
 IF NEW.version<>OLD.version+1 OR NEW.status<>OLD.status OR NEW.enrolled_at<>OLD.enrolled_at OR NEW.created_at<>OLD.created_at
 OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'RECORDED_HUMAN_ENROLLMENT_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM hon.curriculum_enrollment_history h
 JOIN hon.audit_events a ON a.entity_id=h.enrollment_id AND a.organization_id=h.organization_id AND a.school_id=h.school_id
 JOIN hon.outbox_events b ON b.aggregate_id=h.enrollment_id AND b.organization_id=h.organization_id AND b.school_id=h.school_id
 WHERE h.enrollment_id=NEW.id AND h.enrollment_version=NEW.version AND h.current_rank_id IS NOT DISTINCT FROM NEW.current_rank_id
 AND h.operation='SET_RANK' AND h.source='HUMAN_UI' AND h.actor_principal_id=actor AND h.request_id=request AND h.xmin::text=xid_text
 AND a.action_code='curriculum.enrollment.set_rank' AND a.source='HUMAN_UI' AND a.actor_principal_id=actor AND a.request_id=request AND a.result='SUCCEEDED' AND a.xmin::text=xid_text
 AND b.event_type='curriculum.human_recorded' AND b.aggregate_version=NEW.version AND b.causation_id=request AND b.xmin::text=xid_text
 AND hon.principal_has_school_permission(actor,NEW.organization_id,NEW.school_id,'curriculum.progress.record')) THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM hon.promotion_decisions d
 JOIN hon.testing_candidates c ON c.id=d.testing_candidate_id AND c.organization_id=d.organization_id AND c.school_id=d.school_id
 JOIN hon.audit_events a ON a.entity_id=d.id AND a.organization_id=d.organization_id AND a.school_id=d.school_id
 JOIN hon.outbox_events b ON b.aggregate_id=d.id AND b.organization_id=d.organization_id AND b.school_id=d.school_id
 WHERE d.student_curriculum_enrollment_id=NEW.id AND d.status='PROMOTED' AND d.instructor_principal_id=actor AND d.decided_at IS NOT NULL AND length(btrim(d.rationale))>0
 AND d.prior_rank_id IS NOT DISTINCT FROM OLD.current_rank_id AND d.target_rank_id=NEW.current_rank_id AND d.xmin::text=xid_text
 AND c.result='PASSED' AND c.student_curriculum_enrollment_id=NEW.id AND c.target_rank_id=NEW.current_rank_id
 AND a.action_code='testing.promotion.decide' AND a.source='HUMAN_UI' AND a.actor_principal_id=actor AND a.request_id=request AND a.result='SUCCEEDED' AND a.xmin::text=xid_text
 AND a.next_state->>'enrollmentVersion'=NEW.version::text AND a.next_state->>'resultingRankId'=NEW.current_rank_id::text
 AND b.event_type='testing.promotion.decided' AND b.causation_id=request AND b.xmin::text=xid_text
 AND b.payload->>'enrollmentVersion'=NEW.version::text AND b.payload->>'resultingRankId'=NEW.current_rank_id::text
 AND hon.principal_has_school_permission(actor,NEW.organization_id,NEW.school_id,'testing.promotion.decide')) THEN RETURN NULL; END IF;
 RAISE EXCEPTION 'RECORDED_HUMAN_ENROLLMENT_COMMAND_REQUIRED' USING ERRCODE='42501';
END $$;
CREATE CONSTRAINT TRIGGER enrollment_recorded_human_evidence AFTER UPDATE ON hon.student_curriculum_enrollments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.verify_curriculum_enrollment_evidence();

CREATE FUNCTION hon.validate_curriculum_observation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE e hon.student_curriculum_enrollments%ROWTYPE; r hon.curriculum_requirements%ROWTYPE; subject text; actor uuid;
BEGIN
 SELECT * INTO e FROM hon.student_curriculum_enrollments WHERE id=NEW.enrollment_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id FOR UPDATE;
 SELECT * INTO r FROM hon.curriculum_requirements WHERE id=NEW.requirement_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id FOR SHARE;
 IF e.id IS NULL OR r.id IS NULL OR e.status<>'ACTIVE' OR e.curriculum_id<>NEW.curriculum_id OR e.current_rank_id IS DISTINCT FROM NEW.curriculum_rank_id
  OR r.curriculum_rank_id<>NEW.curriculum_rank_id OR e.version<>NEW.enrollment_version OR r.version<>NEW.requirement_version THEN
  RAISE EXCEPTION 'INVALID_REQUIREMENT_ENROLLMENT' USING ERRCODE='23514'; END IF;
 SELECT u.external_subject INTO subject FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE p.id=NEW.actor_principal_id;
 actor:=hon.require_curriculum_actor(subject,'curriculum.progress.record');
 IF actor IS DISTINCT FROM NEW.actor_principal_id OR NEW.source<>'HUMAN_UI' OR NEW.request_id::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
  OR NEW.version<>(SELECT coalesce(max(version),0)+1 FROM hon.curriculum_progress_observations WHERE enrollment_id=e.id AND requirement_id=r.id) THEN
  RAISE EXCEPTION 'INVALID_HUMAN_OBSERVATION' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER curriculum_observation_integrity BEFORE INSERT ON hon.curriculum_progress_observations FOR EACH ROW EXECUTE FUNCTION hon.validate_curriculum_observation();

-- Explicit IDs only, no staff directory or generic table/query interface.
CREATE FUNCTION hon.read_staff_curriculum_progress(p_subject text,p_kind text,p_curriculum uuid,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE e hon.student_curriculum_enrollments%ROWTYPE; result jsonb;
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN('REQUIREMENTS','ENROLLMENT') OR p_curriculum IS NULL OR p_id IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 PERFORM hon.require_curriculum_actor(p_subject,CASE WHEN p_kind='REQUIREMENTS' THEN 'curriculum.manage' ELSE 'curriculum.progress.record' END);
 PERFORM 1 FROM hon.curricula WHERE id=p_curriculum AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
 IF NOT FOUND THEN RAISE EXCEPTION 'CURRICULUM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF p_kind='REQUIREMENTS' THEN
  PERFORM 1 FROM hon.curriculum_ranks WHERE id=p_id AND curriculum_id=p_curriculum AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'RANK_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 ELSE
  SELECT * INTO e FROM hon.student_curriculum_enrollments WHERE id=p_id AND curriculum_id=p_curriculum AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'ENROLLMENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'rankId',r.curriculum_rank_id,'code',r.requirement_code,'kind',r.requirement_kind,
  'definition',r.definition,'required',r.is_required,'version',r.version,'progressVersion',coalesce(o.version,0),
  'status',CASE WHEN o.requirement_version=r.version AND o.enrollment_version=e.version THEN o.status ELSE NULL END,
  'recordedAt',CASE WHEN o.requirement_version=r.version AND o.enrollment_version=e.version THEN o.recorded_at ELSE NULL END) ORDER BY r.requirement_code),'[]') INTO result
 FROM hon.curriculum_requirements r LEFT JOIN LATERAL(SELECT version,status,recorded_at,requirement_version,enrollment_version FROM hon.curriculum_progress_observations
  WHERE enrollment_id=e.id AND requirement_id=r.id ORDER BY version DESC LIMIT 1) o ON true
 WHERE r.curriculum_rank_id=CASE WHEN p_kind='REQUIREMENTS' THEN p_id ELSE e.current_rank_id END AND r.organization_id=hon.current_organization_id() AND r.school_id=hon.current_school_id();
 PERFORM hon.require_curriculum_actor(p_subject,CASE WHEN p_kind='REQUIREMENTS' THEN 'curriculum.manage' ELSE 'curriculum.progress.record' END);
 IF p_kind='REQUIREMENTS' THEN RETURN result; END IF;
 RETURN jsonb_build_object('enrollment',jsonb_build_object('id',e.id,'curriculumId',e.curriculum_id,'studentProfileId',e.student_profile_id,'currentRankId',e.current_rank_id,'version',e.version,'status',e.status,'enrolledAt',e.enrolled_at),'requirements',result);
END $$;
REVOKE ALL ON FUNCTION hon.guard_curriculum_structure_identity(),hon.verify_curriculum_enrollment_evidence(),hon.validate_curriculum_observation(),hon.read_staff_curriculum_progress(text,text,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE INSERT,UPDATE,DELETE ON hon.student_curriculum_enrollments FROM %I',role_name);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_curriculum_structure_identity(),hon.verify_curriculum_enrollment_evidence(),hon.validate_curriculum_observation(),hon.read_staff_curriculum_progress(text,text,uuid,uuid) FROM %I',role_name);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  REVOKE UPDATE ON hon.student_curriculum_enrollments FROM hon_runtime;
  GRANT UPDATE(current_rank_id,version,updated_at) ON hon.student_curriculum_enrollments TO hon_runtime;
  GRANT EXECUTE ON FUNCTION hon.read_staff_curriculum_progress(text,text,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
