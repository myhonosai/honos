BEGIN;

-- Membership agreement signing link by email and text (0499, coordinator-allocated 2026-11-18; owner request 2026-11-18:
-- "agreement must able to send via email and text with easy link"). Builds on the 0463 agreement: staff send a family a
-- one-time link, by email, text or both, and a guardian signs the current version from that link without signing in.
--
-- * WHO SENDS: a staff member with membership.agreement.manage AND communication.message.queue at the exact school, under
--   the 0463 staff rules (direct human, paid access, no family access at the school). The recipient must be a GUARDIAN
--   member of the student's own family.
-- * WHAT THE LINK COVERS: every child of that family the agreement covers (a DRAFT or ACTIVE membership), who is under 18
--   or has no birth date, and who has not signed the current version. At most 20 children.
-- * THE LINK: the browser makes a 43-character random token; only its SHA-256 is stored. A link works for 14 days and signs
--   once. A new send for the family replaces the open link. The token is in the queued message text, because the message
--   has to carry it to the guardian; it is never in a receipt, audit row or outbox payload.
-- * SENDING: each channel is queued in hon.communication_messages (origin MEMBERSHIP_AGREEMENT) only when the guardian has
--   an OPTED_IN consent and an address for it; otherwise that channel is reported as skipped and nothing is queued for it.
--   Delivery stays with the existing workers and their gates (a school's live sender, A2P approval, provider settings), so
--   this migration sends nothing by itself. With no channel queued, staff can still copy the link.
-- * SIGNING: the link page shows the school's current version; signing binds that version, language and digest exactly as
--   in the portal (method SIGNING_LINK, the code-owned link principal as signer principal, the link id on each row). No face
--   check-in box: face consent stays in the signed-in parent portal. An unsigned agreement still blocks nothing (D2, owner
--   decision 2026-11-18: signing stays optional).
-- * PRIVACY: the public read returns the school name, the guardian's given name, the children's given names and the
--   agreement text. Audit and outbox carry identifiers only; the typed name lives only in the signature row.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION '0499 requires a restricted runtime'; END IF;
  IF to_regprocedure('hon.sign_family_membership_agreement(text,jsonb,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.membership_agreement_staff_actor(text)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='hon.communication_messages'::regclass AND attname='origin_kind' AND NOT attisdropped)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.communication_messages'::regclass AND conname='communication_messages_origin_kind_check')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.membership_agreement_signatures'::regclass AND conname='membership_agreement_signatures_method_check')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.membership_agreement_requests'::regclass AND conname='membership_agreement_requests_operation_check') THEN
    RAISE EXCEPTION '0499 requires 0423 and 0463'; END IF;
END $$;

-- The code-owned principal that records a link signing (no user, never a login).
INSERT INTO hon.principals(id,principal_type,user_id,display_name,is_active)
  VALUES('00000000-0000-4000-8000-000000000499','SYSTEM_SERVICE',NULL,'HON membership agreement signing link',true) ON CONFLICT (id) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000499' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active) THEN
    RAISE EXCEPTION 'The signing link principal is not in the expected state'; END IF;
END $$;

-- One row per link. state OPEN until it is signed or replaced; an OPEN link past expires_at reads as EXPIRED.
CREATE TABLE hon.membership_agreement_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  family_id uuid NOT NULL, recipient_person_id uuid NOT NULL,
  student_profile_ids uuid[] NOT NULL CHECK (cardinality(student_profile_ids) BETWEEN 1 AND 20 AND array_position(student_profile_ids,NULL) IS NULL),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','SIGNED','REPLACED')),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  CHECK (expires_at=created_at+interval '14 days'),
  CHECK ((state='OPEN')=(closed_at IS NULL)),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  FOREIGN KEY (family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id),
  FOREIGN KEY (recipient_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id)
);
CREATE UNIQUE INDEX membership_agreement_links_one_open ON hon.membership_agreement_links(family_id) WHERE state='OPEN';
CREATE INDEX membership_agreement_links_family_idx ON hon.membership_agreement_links(organization_id,school_id,family_id,created_at DESC);
ALTER TABLE hon.membership_agreement_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_agreement_links FORCE ROW LEVEL SECURITY;

-- A link only closes (OPEN -> SIGNED or REPLACED, once, with its closing time); nothing else changes and nothing is removed.
CREATE FUNCTION hon.guard_membership_agreement_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') OR OLD.state<>'OPEN' OR NEW.state NOT IN ('SIGNED','REPLACED') OR NEW.closed_at IS NULL
    OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.family_id,NEW.recipient_person_id,NEW.student_profile_ids,NEW.token_hash,NEW.created_by_principal_id,
        NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.family_id,OLD.recipient_person_id,OLD.student_profile_ids,OLD.token_hash,
        OLD.created_by_principal_id,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_agreement_links_guard BEFORE UPDATE OR DELETE ON hon.membership_agreement_links FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_agreement_link();
CREATE TRIGGER membership_agreement_links_no_truncate BEFORE TRUNCATE ON hon.membership_agreement_links FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_agreement_link();

-- Signatures made through a link name it. Portal signatures are unchanged.
ALTER TABLE hon.membership_agreement_signatures ADD COLUMN link_id uuid REFERENCES hon.membership_agreement_links(id);
ALTER TABLE hon.membership_agreement_signatures DROP CONSTRAINT membership_agreement_signatures_method_check;
ALTER TABLE hon.membership_agreement_signatures ADD CONSTRAINT membership_agreement_signatures_method_check
  CHECK (method IN ('PARENT_PORTAL','SIGNING_LINK') AND (method='SIGNING_LINK')=(link_id IS NOT NULL)
    AND (method<>'SIGNING_LINK' OR (signer_principal_id='00000000-0000-4000-8000-000000000499' AND face_consent_id IS NULL)));
CREATE INDEX membership_agreement_signatures_link_idx ON hon.membership_agreement_signatures(link_id) WHERE link_id IS NOT NULL;

ALTER TABLE hon.membership_agreement_requests DROP CONSTRAINT membership_agreement_requests_operation_check;
ALTER TABLE hon.membership_agreement_requests ADD CONSTRAINT membership_agreement_requests_operation_check
  CHECK (operation IN ('draft','publish','family_sign','family_photo_set','family_photo_remove','link_send'));

-- A queued agreement message names its link.
ALTER TABLE hon.communication_messages DROP CONSTRAINT communication_messages_origin_kind_check;
ALTER TABLE hon.communication_messages ADD CONSTRAINT communication_messages_origin_kind_check
  CHECK (origin_kind IN ('STAFF','CONVERSATION_AI','CAMPAIGN','AUTOMATION','MEMBERSHIP_AGREEMENT'));

-- ---------- helpers (migration owner only) ----------
-- 0463 staff rules plus communication.message.queue at this exact school through a staff role. Read-only.
CREATE FUNCTION hon.membership_agreement_link_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  actor:=hon.membership_agreement_staff_actor(p_subject);
  IF NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
      WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code='communication.message.queue'
        AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)) THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- The children a link may cover right now: covered, under 18 (or no birth date), not signed for the current version.
CREATE FUNCTION hon.membership_agreement_link_children(p_org uuid,p_school uuid,p_family uuid,p_current uuid) RETURNS uuid[]
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(array_agg(x.id ORDER BY x.id),'{}') FROM (
    SELECT sp.id FROM hon.student_profiles sp JOIN hon.family_members m ON m.person_id=sp.person_id AND m.organization_id=sp.organization_id
      AND m.school_id=sp.school_id AND m.family_id=p_family AND m.member_role='STUDENT'
    WHERE sp.organization_id=p_org AND sp.school_id=p_school AND sp.primary_family_id=p_family
      AND hon.membership_agreement_covered(p_org,p_school,sp.person_id) AND hon.membership_agreement_minor(p_org,p_school,sp.birth_date)
      AND NOT EXISTS(SELECT 1 FROM hon.membership_agreement_signatures s WHERE s.version_id=p_current AND s.student_profile_id=sp.id)
    ORDER BY sp.id LIMIT 20) x
$$;

CREATE FUNCTION hon.membership_agreement_link_json(l hon.membership_agreement_links) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object('linkId',l.id,
    'state',CASE WHEN l.state='OPEN' AND l.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE l.state END,
    'recipientPersonId',l.recipient_person_id,'studentProfileIds',to_jsonb(l.student_profile_ids),
    'createdAt',hon.saas_ts(l.created_at),'expiresAt',hon.saas_ts(l.expires_at),'closedAt',hon.saas_ts(l.closed_at)) END
$$;

-- A link works only while it still could have been sent: the organization, school and family are ACTIVE, the
-- organization has a live ESSENTIAL/CORE/COMPLETE entitlement (the 0463 paid-access rule), and the recipient is still a
-- GUARDIAN member of the link's family. Decided at every public read and sign, and again after the last sign write.
CREATE FUNCTION hon.membership_agreement_link_live(l hon.membership_agreement_links) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT l.id IS NOT NULL
    AND EXISTS(SELECT 1 FROM hon.organizations WHERE id=l.organization_id AND status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools WHERE id=l.school_id AND organization_id=l.organization_id AND status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.families WHERE id=l.family_id AND organization_id=l.organization_id AND school_id=l.school_id AND status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=l.organization_id AND status='ACTIVE' AND tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()))
    AND EXISTS(SELECT 1 FROM hon.family_members m WHERE m.family_id=l.family_id AND m.person_id=l.recipient_person_id
      AND m.organization_id=l.organization_id AND m.school_id=l.school_id AND m.member_role='GUARDIAN')
$$;

-- ---------- staff entry points ----------
-- Read for one student: the current version, the family's guardians (whether each has an address and an OPTED_IN consent
-- per channel), the children a link would cover now, and the family's latest link. Input: {personId} (the student's person).
CREATE FUNCTION hon.read_membership_agreement_send(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); sp hon.student_profiles%ROWTYPE; cur uuid; latest hon.membership_agreement_links;
  kids uuid[];
BEGIN
  PERFORM hon.membership_agreement_link_actor(p_subject);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['personId']) OR NOT hon.face_checkin_uuid_ok(p_input,'personId') THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO sp FROM hon.student_profiles WHERE person_id=(p_input->>'personId')::uuid AND organization_id=org AND school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  cur:=hon.membership_agreement_current(org,school);
  IF sp.primary_family_id IS NULL THEN
    RETURN jsonb_build_object('current',CASE WHEN cur IS NULL THEN NULL ELSE (SELECT jsonb_build_object('versionId',v.id,'number',v.number) FROM hon.membership_agreement_versions v WHERE v.id=cur) END,
      'familyId',NULL,'guardians','[]'::jsonb,'children','[]'::jsonb,'latestLink',NULL);
  END IF;
  kids:=CASE WHEN cur IS NULL THEN '{}' ELSE hon.membership_agreement_link_children(org,school,sp.primary_family_id,cur) END;
  SELECT * INTO latest FROM hon.membership_agreement_links l WHERE l.organization_id=org AND l.school_id=school AND l.family_id=sp.primary_family_id
    ORDER BY l.created_at DESC,l.id LIMIT 1;
  RETURN jsonb_build_object(
    'current',CASE WHEN cur IS NULL THEN NULL ELSE (SELECT jsonb_build_object('versionId',v.id,'number',v.number) FROM hon.membership_agreement_versions v WHERE v.id=cur) END,
    'familyId',sp.primary_family_id,
    'guardians',coalesce((SELECT jsonb_agg(jsonb_build_object('personId',p.id,'givenName',p.given_name,'familyName',p.family_name,
        'email',jsonb_build_object('address',p.email IS NOT NULL,'consent',EXISTS(SELECT 1 FROM hon.communication_consents k WHERE k.organization_id=org AND k.school_id=school
          AND k.person_id=p.id AND k.channel='EMAIL' AND k.status='OPTED_IN')),
        'text',jsonb_build_object('address',p.phone_e164 IS NOT NULL,'consent',EXISTS(SELECT 1 FROM hon.communication_consents k WHERE k.organization_id=org AND k.school_id=school
          AND k.person_id=p.id AND k.channel='SMS' AND k.status='OPTED_IN'))) ORDER BY p.given_name,p.family_name,p.id)
      FROM hon.family_members m JOIN hon.people p ON p.id=m.person_id AND p.organization_id=m.organization_id AND p.school_id=m.school_id
      WHERE m.organization_id=org AND m.school_id=school AND m.family_id=sp.primary_family_id AND m.member_role='GUARDIAN'),'[]'::jsonb),
    'children',coalesce((SELECT jsonb_agg(jsonb_build_object('studentProfileId',x.id,'givenName',p.given_name,'familyName',p.family_name) ORDER BY p.given_name,x.id)
      FROM hon.student_profiles x JOIN hon.people p ON p.id=x.person_id AND p.organization_id=x.organization_id AND p.school_id=x.school_id
      WHERE x.id=ANY(kids)),'[]'::jsonb),
    'latestLink',hon.membership_agreement_link_json(latest));
END $$;

-- Send a new link. Input: {personId (the student's person), recipientPersonId, channels: [] | ['EMAIL'] | ['SMS'] | ['EMAIL','SMS'], token,
-- confirmation}. p_origin is the HON web origin from the API's configuration (never the browser), used only to write the
-- link into the message. Replaces the family's open link. Returns the link and, per asked channel, QUEUED (with the
-- message id), NO_CONSENT or NO_ADDRESS.
CREATE FUNCTION hon.send_membership_agreement_link(p_subject text,p_input jsonb,p_origin text,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; sp hon.student_profiles%ROWTYPE; cur uuid;
  rcp hon.people%ROWTYPE; kids uuid[]; names text; sname text; l hon.membership_agreement_links; ch text; url text; msg uuid; outcome text;
  deliveries jsonb:='[]'::jsonb; instant timestamptz:=clock_timestamp(); replaced uuid;
BEGIN
  actor:=hon.membership_agreement_link_actor(p_subject);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['channels','confirmation','personId','recipientPersonId','token'])
    OR NOT hon.face_checkin_uuid_ok(p_input,'personId') OR NOT hon.face_checkin_uuid_ok(p_input,'recipientPersonId')
    OR jsonb_typeof(p_input->'token') IS DISTINCT FROM 'string' OR p_input->>'token' !~ '^[A-Za-z0-9_-]{43}$'
    OR p_input->'confirmation' IS DISTINCT FROM '"I_CONFIRM_SEND_MEMBERSHIP_AGREEMENT_LINK"'::jsonb
    OR jsonb_typeof(p_input->'channels') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'channels')>2
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'channels') x WHERE x NOT IN ('"EMAIL"'::jsonb,'"SMS"'::jsonb))
    OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(p_input->'channels') x)<>jsonb_array_length(p_input->'channels')
    OR p_origin IS NULL OR p_origin !~ '^https?://[A-Za-z0-9.-]{1,200}(:[0-9]{1,5})?$' THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_INVALID' USING ERRCODE='22023'; END IF;
  replay:=hon.membership_agreement_begin(actor,'link_send',p_input,p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  SELECT * INTO sp FROM hon.student_profiles WHERE person_id=(p_input->>'personId')::uuid AND organization_id=org AND school_id=school;
  IF NOT FOUND OR sp.primary_family_id IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- One send at a time per family; the version must stay current while the link is made (a publish takes this lock exclusively).
  PERFORM pg_advisory_xact_lock(hashtextextended('membership-agreement-link:'||sp.primary_family_id::text,0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('membership-agreement:'||school::text,0));
  cur:=hon.membership_agreement_current(org,school);
  IF cur IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_NOT_PUBLISHED' USING ERRCODE='22023'; END IF;
  SELECT p.* INTO rcp FROM hon.people p JOIN hon.family_members m ON m.person_id=p.id AND m.organization_id=p.organization_id AND m.school_id=p.school_id
    WHERE p.id=(p_input->>'recipientPersonId')::uuid AND p.organization_id=org AND p.school_id=school AND m.family_id=sp.primary_family_id AND m.member_role='GUARDIAN';
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_RECIPIENT_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
  kids:=hon.membership_agreement_link_children(org,school,sp.primary_family_id,cur);
  IF cardinality(kids)=0 THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_NOTHING_TO_SIGN' USING ERRCODE='22023'; END IF;
  UPDATE hon.membership_agreement_links SET state='REPLACED',closed_at=instant
    WHERE organization_id=org AND school_id=school AND family_id=sp.primary_family_id AND state='OPEN' RETURNING id INTO replaced;
  INSERT INTO hon.membership_agreement_links(organization_id,school_id,family_id,recipient_person_id,student_profile_ids,token_hash,created_by_principal_id,created_at,expires_at)
    VALUES(org,school,sp.primary_family_id,rcp.id,kids,encode(sha256(convert_to(p_input->>'token','UTF8')),'hex'),actor,instant,instant+interval '14 days')
    RETURNING * INTO l;
  SELECT left(s.name,100) INTO sname FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  SELECT string_agg(p.given_name,', ' ORDER BY p.given_name,x.id) INTO names FROM hon.student_profiles x
    JOIN hon.people p ON p.id=x.person_id AND p.organization_id=x.organization_id AND p.school_id=x.school_id WHERE x.id=ANY(kids);
  names:=left(names,600);
  url:=p_origin||'/agreement/'||(p_input->>'token');
  FOR ch IN SELECT x FROM jsonb_array_elements_text(p_input->'channels') x ORDER BY 1 LOOP
    msg:=NULL;
    outcome:=CASE
      WHEN NOT EXISTS(SELECT 1 FROM hon.communication_consents k WHERE k.organization_id=org AND k.school_id=school AND k.person_id=rcp.id
        AND k.channel::text=ch AND k.status='OPTED_IN') THEN 'NO_CONSENT'
      WHEN (ch='SMS' AND rcp.phone_e164 IS NULL) OR (ch='EMAIL' AND rcp.email IS NULL) THEN 'NO_ADDRESS' ELSE 'QUEUED' END;
    IF outcome='QUEUED' THEN
      INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,lifecycle,created_by_principal_id,queued_by_principal_id,
          origin_kind,origin_id,email_subject)
        VALUES(org,school,rcp.id,ch::hon.communication_message_channel,
          CASE ch WHEN 'EMAIL' THEN 'Hello '||rcp.given_name||E',\n\n'||sname||' asks you to read and sign the membership agreement for '||names
              ||E'. Open this link to sign it on your phone or computer:\n\n'||url||E'\n\nThe link works for 14 days and can be used once.'
            ELSE sname||': please read and sign the membership agreement for '||names||'. '||url||' (works for 14 days)' END,
          'QUEUED',actor,actor,'MEMBERSHIP_AGREEMENT',l.id,CASE ch WHEN 'EMAIL' THEN left('Membership agreement from '||sname,150) END)
        RETURNING id INTO msg;
    END IF;
    deliveries:=deliveries||jsonb_build_array(jsonb_build_object('channel',ch,'outcome',outcome,'messageId',msg));
  END LOOP;
  replay:=hon.membership_agreement_finish(actor,'membership_agreement.link_send','MEMBERSHIP_AGREEMENT_LINK',l.id,
    jsonb_build_object('linkId',l.id,'familyId',l.family_id,'recipientPersonId',l.recipient_person_id,'versionId',cur,'studentProfileIds',to_jsonb(kids),
      'replacedLinkId',replaced,'deliveries',deliveries,'version',1),p_key,p_request,p_correlation,
    hon.membership_agreement_link_json(l)||jsonb_build_object('deliveries',deliveries));
  IF hon.membership_agreement_link_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- ---------- public entry points (no account; the token is the only key) ----------
-- What a link shows. NULL for an unknown token. A link that is not open shows only its state and the school name.
CREATE FUNCTION hon.read_membership_agreement_link(p_token text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE l hon.membership_agreement_links; sname text; cur uuid; kids uuid[];
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN RETURN NULL; END IF;
  SELECT * INTO l FROM hon.membership_agreement_links x WHERE x.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  IF NOT FOUND OR NOT hon.membership_agreement_link_live(l) THEN RETURN NULL; END IF;
  SELECT s.name INTO sname FROM hon.schools s WHERE s.id=l.school_id AND s.organization_id=l.organization_id;
  IF l.state<>'OPEN' OR l.expires_at<=clock_timestamp() THEN
    RETURN jsonb_build_object('state',hon.membership_agreement_link_json(l)->>'state','schoolName',sname); END IF;
  cur:=hon.membership_agreement_current(l.organization_id,l.school_id);
  kids:=ARRAY(SELECT x FROM unnest(l.student_profile_ids) x WHERE x=ANY(hon.membership_agreement_link_children(l.organization_id,l.school_id,l.family_id,cur)) ORDER BY x);
  RETURN jsonb_build_object('state','OPEN','schoolName',sname,
    'recipientGivenName',(SELECT p.given_name FROM hon.people p WHERE p.id=l.recipient_person_id),'expiresAt',hon.saas_ts(l.expires_at),
    'agreement',hon.membership_agreement_version_json(cur),
    'children',coalesce((SELECT jsonb_agg(jsonb_build_object('studentProfileId',x.id,'givenName',p.given_name) ORDER BY p.given_name,x.id)
      FROM hon.student_profiles x JOIN hon.people p ON p.id=x.person_id AND p.organization_id=x.organization_id AND p.school_id=x.school_id
      WHERE x.id=ANY(kids)),'[]'::jsonb));
END $$;

-- Sign through a link. Input: exactly {versionId, language, digest, signerName, eSignConsent: true, studentProfileIds}
-- (a non-empty subset of the children the link shows). Returns SIGNED, ALREADY_SIGNED (this link was signed, e.g. a
-- retry), CHANGED (the school changed its agreement or a child no longer needs it: reload), INVALID or GONE (unknown,
-- expired or replaced).
CREATE FUNCTION hon.sign_membership_agreement_link(p_token text,p_input jsonb,p_request uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE l hon.membership_agreement_links; svc constant uuid:='00000000-0000-4000-8000-000000000499'; cur uuid; v hon.membership_agreement_versions%ROWTYPE;
  student uuid; signing uuid:=gen_random_uuid(); instant timestamptz:=clock_timestamp(); kids uuid[];
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' OR p_request IS NULL THEN RETURN 'GONE'; END IF;
  SELECT * INTO l FROM hon.membership_agreement_links x WHERE x.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') FOR UPDATE;
  IF NOT FOUND OR l.state='REPLACED' OR (l.state='OPEN' AND l.expires_at<=instant) OR NOT hon.membership_agreement_link_live(l) THEN RETURN 'GONE'; END IF;
  IF l.state='SIGNED' THEN RETURN 'ALREADY_SIGNED'; END IF;
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['digest','eSignConsent','language','signerName','studentProfileIds','versionId'])
    OR NOT hon.face_checkin_uuid_ok(p_input,'versionId') OR NOT hon.membership_agreement_name_ok(p_input) OR p_input->'eSignConsent' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(p_input->'language') IS DISTINCT FROM 'string' OR p_input->>'language' NOT IN ('en','ko','es')
    OR jsonb_typeof(p_input->'digest') IS DISTINCT FROM 'string' OR p_input->>'digest' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_input->'studentProfileIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'studentProfileIds') NOT BETWEEN 1 AND 20
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'studentProfileIds') x WHERE jsonb_typeof(x)<>'string'
      OR x#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR NOT (x#>>'{}')::uuid=ANY(l.student_profile_ids))
    OR (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(p_input->'studentProfileIds') x)<>jsonb_array_length(p_input->'studentProfileIds') THEN
    RETURN 'INVALID'; END IF;
  PERFORM 1 FROM hon.principals WHERE id=svc AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('membership-agreement:'||l.school_id::text,0));
  cur:=hon.membership_agreement_current(l.organization_id,l.school_id);
  SELECT * INTO v FROM hon.membership_agreement_versions WHERE id=cur;
  IF cur IS NULL OR cur<>(p_input->>'versionId')::uuid OR NOT EXISTS(SELECT 1 FROM hon.membership_agreement_texts t
      WHERE t.version_id=cur AND t.language=p_input->>'language' AND t.digest=p_input->>'digest') THEN RETURN 'CHANGED'; END IF;
  FOR student IN SELECT x::uuid FROM jsonb_array_elements_text(p_input->'studentProfileIds') x ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('membership-agreement-student:'||student::text,0));
  END LOOP;
  kids:=hon.membership_agreement_link_children(l.organization_id,l.school_id,l.family_id,cur);
  FOR student IN SELECT x::uuid FROM jsonb_array_elements_text(p_input->'studentProfileIds') x ORDER BY 1 LOOP
    IF NOT student=ANY(kids) THEN RETURN 'CHANGED'; END IF;
    PERFORM 1 FROM hon.student_profiles WHERE id=student FOR KEY SHARE;
    INSERT INTO hon.membership_agreement_signatures(organization_id,school_id,signing_id,version_id,language,digest,student_profile_id,family_id,signer_kind,
        signer_name,esign_consent,method,signer_principal_id,face_consent_id,link_id)
      VALUES(l.organization_id,l.school_id,signing,cur,p_input->>'language',p_input->>'digest',student,l.family_id,'GUARDIAN',p_input->>'signerName',true,
        'SIGNING_LINK',svc,NULL,l.id);
  END LOOP;
  UPDATE hon.membership_agreement_links SET state='SIGNED',closed_at=instant WHERE id=l.id AND state='OPEN';
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(l.organization_id,l.school_id,svc,'PUBLIC_API','membership_agreement.link_sign','MEMBERSHIP_AGREEMENT_SIGNING',signing,
      jsonb_build_object('signingId',signing,'linkId',l.id,'versionId',cur,'number',v.number,'language',p_input->>'language',
        'studentProfileIds',p_input->'studentProfileIds','internalOnly',true),'SUCCEEDED',p_request,p_request);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(l.organization_id,l.school_id,'membership_agreement.link_sign',1,'MEMBERSHIP_AGREEMENT_SIGNING',signing,1,p_request,p_request,
      jsonb_build_object('signingId',signing,'linkId',l.id,'versionId',cur,'number',v.number,'studentProfileIds',p_input->'studentProfileIds','internalOnly',true));
  -- Decided again after the last write: a guardian removed or a school stopped while this waited commits nothing.
  IF NOT hon.membership_agreement_link_live(l) THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_LINK_GONE' USING ERRCODE='P0002'; END IF;
  RETURN 'SIGNED';
END $$;

-- Deny first, then exactly the four entry points for the runtime role. No table privilege for any client role.
DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_membership_agreement_send(text,jsonb)','hon.send_membership_agreement_link(text,jsonb,text,text,uuid,uuid)',
    'hon.read_membership_agreement_link(text)','hon.sign_membership_agreement_link(text,jsonb,uuid)'];
  fns text[]:=ARRAY['hon.guard_membership_agreement_link()','hon.membership_agreement_link_actor(text)',
    'hon.membership_agreement_link_children(uuid,uuid,uuid,uuid)',
    'hon.membership_agreement_link_json(hon.membership_agreement_links)','hon.membership_agreement_link_live(hon.membership_agreement_links)']||entry; BEGIN
  REVOKE ALL ON TABLE hon.membership_agreement_links FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.membership_agreement_links FROM %I',r); END LOOP;
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
