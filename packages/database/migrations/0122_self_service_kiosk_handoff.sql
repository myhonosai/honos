BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Kiosk requires trusted migration owner'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive) VALUES
 ('kiosk.terminal.manage','Direct human owner terminal lifecycle',true),
 ('kiosk.handoff.provision','Direct human exact known student/session claim provisioning',true),
 ('kiosk.handoff.read','Direct human exact claim UUID recovery only',true)
ON CONFLICT(code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
WHERE r.is_system_role AND r.code IN('OWNER','ADMIN') AND p.code IN('kiosk.terminal.manage','kiosk.handoff.provision','kiosk.handoff.read')
ON CONFLICT(role_id,permission_code) DO NOTHING;

CREATE TABLE hon.kiosk_terminals (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN('ACTIVE','RETIRED')), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), retired_at timestamptz,
 CHECK((state='RETIRED')=(retired_at IS NOT NULL)), UNIQUE(id,organization_id,school_id),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE TABLE hon.kiosk_terminal_sessions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, school_id uuid NOT NULL, terminal_id uuid NOT NULL,
 bearer_digest bytea NOT NULL UNIQUE CHECK(octet_length(bearer_digest)=32),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'), UNIQUE(id,organization_id,school_id),
 FOREIGN KEY(terminal_id,organization_id,school_id) REFERENCES hon.kiosk_terminals(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.kiosk_claims (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, school_id uuid NOT NULL, student_profile_id uuid NOT NULL, class_session_id uuid NOT NULL,
 bearer_digest bytea NOT NULL UNIQUE CHECK(octet_length(bearer_digest)=32),
 state text NOT NULL CHECK(state IN('ISSUED','CONSUMED','EXPIRED')), issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '10 minutes'), CHECK((state='CONSUMED')=(consumed_at IS NOT NULL)),
 UNIQUE(id,organization_id,school_id), UNIQUE(id,organization_id,school_id,student_profile_id,class_session_id),
 FOREIGN KEY(student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id) ON DELETE RESTRICT,
 FOREIGN KEY(class_session_id,organization_id,school_id) REFERENCES hon.class_sessions(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX kiosk_one_issued_claim ON hon.kiosk_claims(organization_id,school_id,student_profile_id,class_session_id) WHERE state='ISSUED';
CREATE TABLE hon.kiosk_handoffs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 claim_id uuid NOT NULL UNIQUE, terminal_session_id uuid NOT NULL, student_profile_id uuid NOT NULL, class_session_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'PENDING_STAFF_REVIEW' CHECK(state='PENDING_STAFF_REVIEW'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,school_id,claim_id,terminal_session_id),
 FOREIGN KEY(claim_id,organization_id,school_id,student_profile_id,class_session_id) REFERENCES hon.kiosk_claims(id,organization_id,school_id,student_profile_id,class_session_id) ON DELETE RESTRICT,
 FOREIGN KEY(terminal_session_id,organization_id,school_id) REFERENCES hon.kiosk_terminal_sessions(id,organization_id,school_id) ON DELETE RESTRICT
);
-- Private append-only evidence: IDs, a fixed non-admission result and time only.
CREATE TABLE hon.kiosk_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 handoff_id uuid NOT NULL UNIQUE, claim_id uuid NOT NULL, terminal_session_id uuid NOT NULL,
 result text NOT NULL CHECK(result='NEEDS_STAFF_ASSISTANCE'), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(handoff_id,organization_id,school_id,claim_id,terminal_session_id) REFERENCES hon.kiosk_handoffs(id,organization_id,school_id,claim_id,terminal_session_id) ON DELETE RESTRICT
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['kiosk_terminals','kiosk_terminal_sessions','kiosk_claims','kiosk_handoffs','kiosk_receipts'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  EXECUTE format('CREATE TRIGGER kiosk_no_delete BEFORE DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history()',t);
  EXECUTE format('CREATE TRIGGER kiosk_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history()',t);
 END LOOP;
END $$;
CREATE TRIGGER kiosk_handoff_immutable BEFORE UPDATE ON hon.kiosk_handoffs FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER kiosk_receipt_immutable BEFORE UPDATE ON hon.kiosk_receipts FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE FUNCTION hon.guard_kiosk_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_TABLE_NAME='kiosk_terminals' THEN
  IF OLD.state<>'ACTIVE' OR NEW.state<>'RETIRED' OR NEW.retired_at IS NULL OR (to_jsonb(NEW)-ARRAY['state','retired_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','retired_at']) THEN RAISE EXCEPTION 'KIOSK_IMMUTABLE' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME='kiosk_terminal_sessions' THEN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') THEN RAISE EXCEPTION 'KIOSK_IMMUTABLE' USING ERRCODE='42501'; END IF;
 ELSE
  IF OLD.state<>'ISSUED' OR NEW.state NOT IN('CONSUMED','EXPIRED') OR (to_jsonb(NEW)-ARRAY['state','consumed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','consumed_at']) THEN RAISE EXCEPTION 'KIOSK_IMMUTABLE' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER kiosk_terminal_transition BEFORE UPDATE ON hon.kiosk_terminals FOR EACH ROW EXECUTE FUNCTION hon.guard_kiosk_transition();
CREATE TRIGGER kiosk_session_transition BEFORE UPDATE ON hon.kiosk_terminal_sessions FOR EACH ROW EXECUTE FUNCTION hon.guard_kiosk_transition();
CREATE TRIGGER kiosk_claim_transition BEFORE UPDATE ON hon.kiosk_claims FOR EACH ROW EXECUTE FUNCTION hon.guard_kiosk_transition();

-- Canonical 32-byte base64url. Entropy is supplied by the human UI's CSPRNG, not inferable from syntax.
CREATE FUNCTION hon.kiosk_secret_valid(p_secret text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(p_secret ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$',false)
$$;
CREATE FUNCTION hon.lock_kiosk_actor(p_subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
 IF p_permission IS NULL OR p_permission NOT IN('kiosk.terminal.manage','kiosk.handoff.provision','kiosk.handoff.read')
  OR p_subject IS NULL OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
  OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
  OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.users WHERE external_subject=p_subject FOR SHARE;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
 WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true) AND p.principal_type='HUMAN_USER' AND p.is_active
 AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1 FOR SHARE OF p;
 IF actor IS NULL THEN RAISE EXCEPTION 'KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.family_access_grants WHERE principal_id=actor ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.hq_operator_grants WHERE principal_id=actor FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 IF EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor)
  OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()))
  OR NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
   WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code=p_permission
   AND r.code=ANY(CASE WHEN p_permission='kiosk.terminal.manage' THEN ARRAY['OWNER'] ELSE ARRAY['OWNER','ADMIN'] END)
   AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
   AND (r.management_school_id IS NULL OR r.management_school_id=school))
  OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND status='ACTIVE' AND tier IN('ESSENTIAL','CORE','COMPLETE') AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN
  RAISE EXCEPTION 'KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;

CREATE FUNCTION hon.manage_kiosk_terminal(p_subject text,p_action text,p_terminal uuid,p_session uuid,p_secret text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); terminal hon.kiosk_terminals%ROWTYPE; instant timestamptz;
BEGIN
 PERFORM hon.lock_kiosk_actor(p_subject,'kiosk.terminal.manage');
 IF p_terminal IS NULL OR p_action IS NULL OR p_action NOT IN('ACTIVATE','RETIRE') OR (p_action='ACTIVATE' AND (p_session IS NULL OR NOT hon.kiosk_secret_valid(p_secret))) OR (p_action='RETIRE' AND (p_session IS NOT NULL OR p_secret IS NOT NULL)) THEN RAISE EXCEPTION 'KIOSK_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('kiosk.terminal:'||p_terminal::text,0));
 SELECT * INTO terminal FROM hon.kiosk_terminals WHERE id=p_terminal AND organization_id=org AND school_id=school FOR UPDATE;
 PERFORM hon.lock_kiosk_actor(p_subject,'kiosk.terminal.manage');
 instant:=clock_timestamp();
 IF p_action='RETIRE' THEN
  IF terminal.id IS NULL OR terminal.state<>'ACTIVE' THEN RAISE EXCEPTION 'KIOSK_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  UPDATE hon.kiosk_terminals SET state='RETIRED',retired_at=instant WHERE id=terminal.id;
  RETURN jsonb_build_object('terminalId',terminal.id,'state','RETIRED','retiredAt',instant);
 END IF;
 IF terminal.state='RETIRED' THEN RAISE EXCEPTION 'KIOSK_UNAVAILABLE' USING ERRCODE='22023'; END IF;
 IF terminal.id IS NULL THEN INSERT INTO hon.kiosk_terminals(id,organization_id,school_id,state) VALUES(p_terminal,org,school,'ACTIVE'); END IF;
 UPDATE hon.kiosk_terminal_sessions SET revoked_at=instant WHERE terminal_id=p_terminal AND organization_id=org AND school_id=school AND revoked_at IS NULL;
 PERFORM hon.lock_kiosk_actor(p_subject,'kiosk.terminal.manage');
 INSERT INTO hon.kiosk_terminal_sessions(id,organization_id,school_id,terminal_id,bearer_digest,created_at,expires_at) VALUES(p_session,org,school,p_terminal,sha256(convert_to(p_secret,'UTF8')),instant,instant+interval '15 minutes');
 RETURN jsonb_build_object('terminalId',p_terminal,'terminalSessionId',p_session,'state','ACTIVE','createdAt',instant,'expiresAt',instant+interval '15 minutes');
END $$;

CREATE FUNCTION hon.provision_kiosk_claim(p_subject text,p_claim uuid,p_student uuid,p_class_session uuid,p_secret text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); instant timestamptz;
BEGIN
 PERFORM hon.lock_kiosk_actor(p_subject,'kiosk.handoff.provision');
 IF p_claim IS NULL OR p_student IS NULL OR p_class_session IS NULL OR NOT hon.kiosk_secret_valid(p_secret) THEN RAISE EXCEPTION 'KIOSK_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('kiosk.claim:'||school::text||':'||p_student::text||':'||p_class_session::text,0));
 PERFORM 1 FROM hon.class_sessions WHERE id=p_class_session AND organization_id=org AND school_id=school AND status='SCHEDULED' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'KIOSK_UNAVAILABLE' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM hon.student_profiles WHERE id=p_student AND organization_id=org AND school_id=school AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'KIOSK_UNAVAILABLE' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM hon.kiosk_claims WHERE organization_id=org AND school_id=school AND student_profile_id=p_student AND class_session_id=p_class_session ORDER BY id FOR UPDATE;
 PERFORM hon.lock_kiosk_actor(p_subject,'kiosk.handoff.provision');
 instant:=clock_timestamp();
 UPDATE hon.kiosk_claims SET state='EXPIRED' WHERE organization_id=org AND school_id=school AND student_profile_id=p_student AND class_session_id=p_class_session AND state='ISSUED' AND expires_at<=instant;
 IF EXISTS(SELECT 1 FROM hon.kiosk_claims WHERE organization_id=org AND school_id=school AND student_profile_id=p_student AND class_session_id=p_class_session AND state='ISSUED') THEN RAISE EXCEPTION 'KIOSK_UNAVAILABLE' USING ERRCODE='22023'; END IF;
 INSERT INTO hon.kiosk_claims(id,organization_id,school_id,student_profile_id,class_session_id,bearer_digest,state,issued_at,expires_at)
 VALUES(p_claim,org,school,p_student,p_class_session,sha256(convert_to(p_secret,'UTF8')),'ISSUED',instant,instant+interval '10 minutes');
 RETURN jsonb_build_object('claimId',p_claim,'studentProfileId',p_student,'classSessionId',p_class_session,'state','ISSUED','issuedAt',instant,'expiresAt',instant+interval '10 minutes');
END $$;

-- No caller scope, actor, audit, outbox, provider or other-domain authority.
CREATE FUNCTION hon.submit_kiosk_handoff(p_terminal_session text,p_claim text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE ts hon.kiosk_terminal_sessions%ROWTYPE; claim hon.kiosk_claims%ROWTYPE; handoff uuid; instant timestamptz;
BEGIN
 IF NOT hon.kiosk_secret_valid(p_terminal_session) OR NOT hon.kiosk_secret_valid(p_claim) THEN RETURN 'NEEDS_STAFF_ASSISTANCE'; END IF;
 SELECT * INTO ts FROM hon.kiosk_terminal_sessions WHERE bearer_digest=sha256(convert_to(p_terminal_session,'UTF8')) FOR UPDATE;
 IF ts.id IS NULL THEN RETURN 'NEEDS_STAFF_ASSISTANCE'; END IF;
 SELECT * INTO claim FROM hon.kiosk_claims WHERE bearer_digest=sha256(convert_to(p_claim,'UTF8')) FOR UPDATE;
 IF claim.id IS NULL OR claim.organization_id<>ts.organization_id OR claim.school_id<>ts.school_id THEN RETURN 'NEEDS_STAFF_ASSISTANCE'; END IF;
 -- Terminal lifecycle takes terminal -> terminal session; use NOWAIT here to avoid an inverse-order deadlock.
 PERFORM 1 FROM hon.kiosk_terminals WHERE id=ts.terminal_id AND organization_id=ts.organization_id AND school_id=ts.school_id AND state='ACTIVE' FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN 'NEEDS_STAFF_ASSISTANCE'; END IF;
 PERFORM 1 FROM hon.organizations WHERE id=ts.organization_id AND status='ACTIVE' FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN 'NEEDS_STAFF_ASSISTANCE'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=ts.school_id AND organization_id=ts.organization_id AND status='ACTIVE' FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN 'NEEDS_STAFF_ASSISTANCE'; END IF;
 PERFORM 1 FROM hon.class_sessions WHERE id=claim.class_session_id AND organization_id=claim.organization_id AND school_id=claim.school_id AND status='SCHEDULED' FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN 'NEEDS_STAFF_ASSISTANCE'; END IF;
 PERFORM 1 FROM hon.student_profiles WHERE id=claim.student_profile_id AND organization_id=claim.organization_id AND school_id=claim.school_id AND status='ACTIVE' FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN 'NEEDS_STAFF_ASSISTANCE'; END IF;
 instant:=clock_timestamp();
 IF ts.revoked_at IS NOT NULL OR ts.expires_at<=instant OR claim.state<>'ISSUED' OR claim.expires_at<=instant THEN RETURN 'NEEDS_STAFF_ASSISTANCE'; END IF;
 INSERT INTO hon.kiosk_handoffs(organization_id,school_id,claim_id,terminal_session_id,student_profile_id,class_session_id)
 VALUES(claim.organization_id,claim.school_id,claim.id,ts.id,claim.student_profile_id,claim.class_session_id) RETURNING id INTO handoff;
 INSERT INTO hon.kiosk_receipts(organization_id,school_id,handoff_id,claim_id,terminal_session_id,result)
 VALUES(claim.organization_id,claim.school_id,handoff,claim.id,ts.id,'NEEDS_STAFF_ASSISTANCE');
 UPDATE hon.kiosk_claims SET state='CONSUMED',consumed_at=instant WHERE id=claim.id;
 RETURN 'NEEDS_STAFF_ASSISTANCE';
EXCEPTION WHEN OTHERS THEN
 -- A subtransaction rolls back every write before the fixed public response. Never expose PG detail/parameters.
 RETURN 'NEEDS_STAFF_ASSISTANCE';
END $$;

CREATE FUNCTION hon.read_kiosk_handoff(p_subject text,p_claim uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); claim hon.kiosk_claims%ROWTYPE; result jsonb;
BEGIN
 PERFORM hon.lock_kiosk_actor(p_subject,'kiosk.handoff.read');
 SELECT * INTO claim FROM hon.kiosk_claims WHERE id=p_claim AND organization_id=org AND school_id=school FOR SHARE;
 PERFORM hon.lock_kiosk_actor(p_subject,'kiosk.handoff.read');
 IF claim.id IS NULL THEN RAISE EXCEPTION 'KIOSK_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 SELECT jsonb_build_object('claimId',claim.id,'studentProfileId',claim.student_profile_id,'classSessionId',claim.class_session_id,
 'state',CASE WHEN claim.state='ISSUED' AND claim.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE claim.state END,
 'issuedAt',claim.issued_at,'expiresAt',claim.expires_at,'consumedAt',claim.consumed_at,
 'handoff', (SELECT jsonb_build_object('id',h.id,'terminalSessionId',h.terminal_session_id,'state',h.state,'createdAt',h.created_at) FROM hon.kiosk_handoffs h WHERE h.claim_id=claim.id AND h.organization_id=org AND h.school_id=school)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION hon.guard_kiosk_transition(),hon.kiosk_secret_valid(text),hon.lock_kiosk_actor(text,text),hon.manage_kiosk_terminal(text,text,uuid,uuid,text),hon.provision_kiosk_claim(text,uuid,uuid,uuid,text),hon.submit_kiosk_handoff(text,text),hon.read_kiosk_handoff(text,uuid) FROM PUBLIC;
COMMIT;
