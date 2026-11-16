BEGIN;

-- M-E (0410, allocated by the coordinator 2026-11-16): the digital membership agreement. Owner (David), 2026-11-16 16:08Z:
-- "Digital agreement is must. It doesn't need to be embedded into checkout page but option to send after student signs up
-- to make membership active".
--   The school writes one agreement (English required, Korean and Spanish optional), versioned and append-only, and chooses
--   whether a signature is required before a membership starts (billing.membership_agreement.manage, new, OWNER roles).
--   From the contact card, staff with billing.membership.create send it for one membership that has not started yet to the
--   adult student or a guardian of the student's primary family. The server keeps a snapshot of the exact agreement text and
--   the membership terms (plan, price, dates, payer); the signing link carries a random token the browser made, and only its
--   SHA-256 is stored. A new send replaces any open link for that membership. A link lasts 14 days and signs once.
--   The family opens the link without an account, reads the agreement in their language, types their name, signs with a
--   finger and says how they relate to the student (the walk-in kiosk 0396 signature shape). The signature is append-only
--   and bound to the exact SHA-256 of what was shown.
--   While the school requires a signature, a membership cannot go from not started to active without one (a trigger, so the
--   0177 start and every other path are covered). Memberships brought in by a reviewed billing import are exempt.
-- Nothing is charged or scheduled. Sending a message with the link uses the existing communication message path (its
-- consent and delivery rules); this migration sends nothing. Audit and outbox carry ids and codes only, never the token or
-- the signature. The runtime gains no table privilege: the six entry points are SECURITY DEFINER.

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('billing.membership_agreement.manage','Write the school''s membership agreement and choose whether a signature is required before a membership starts',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code='billing.membership_agreement.manage' AND is_sensitive AND is_staff_assignable)<>1 THEN
    RAISE EXCEPTION 'billing.membership_agreement.manage already exists with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'billing.membership_agreement.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- {en:{title,body}, ko?:{...}, es?:{...}}: titles 1..200, bodies 1..20000 characters, no control characters except newlines and tabs.
CREATE FUNCTION hon.membership_agreement_texts_ok(t jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(t)='object' AND t ? 'en'
    AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(t) k WHERE k NOT IN ('en','ko','es'))
    AND NOT EXISTS(SELECT 1 FROM jsonb_each(t) e WHERE jsonb_typeof(e.value)<>'object'
      OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e.value) k) IS DISTINCT FROM ARRAY['body','title']
      OR jsonb_typeof(e.value->'title')<>'string' OR jsonb_typeof(e.value->'body')<>'string'
      OR length(e.value->>'title') NOT BETWEEN 1 AND 200 OR btrim(e.value->>'title')<>(e.value->>'title') OR (e.value->>'title') ~ '[[:cntrl:]]'
      OR length(btrim(e.value->>'body')) NOT BETWEEN 1 AND 20000 OR (e.value->>'body') ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')
$$;

-- Every agreement the school has had; the current one is the highest version. Append-only.
CREATE TABLE hon.membership_agreement_texts (
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  text_version integer NOT NULL CHECK (text_version BETWEEN 1 AND 100000),
  texts jsonb NOT NULL CHECK (hon.membership_agreement_texts_ok(texts)),
  signature_required boolean NOT NULL,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (school_id,text_version),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id,school_id,actor_principal_id,idempotency_key)
);

-- One sent link for one membership. Only its state changes: OPEN to SIGNED or REPLACED, once.
CREATE TABLE hon.membership_agreement_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  signer_person_id uuid NOT NULL,
  signer_relation text NOT NULL CHECK (signer_relation IN ('SELF','GUARDIAN')),
  text_version integer NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object' AND octet_length(document::text)<=200000),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('OPEN','SIGNED','REPLACED')),
  expires_at timestamptz NOT NULL,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  FOREIGN KEY (membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (signer_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id,text_version) REFERENCES hon.membership_agreement_texts(school_id,text_version) ON DELETE RESTRICT,
  UNIQUE (id,organization_id,school_id),
  UNIQUE (organization_id,school_id,actor_principal_id,idempotency_key),
  CHECK ((state='OPEN')=(closed_at IS NULL)),
  CHECK (expires_at>created_at)
);
CREATE UNIQUE INDEX membership_agreement_requests_open ON hon.membership_agreement_requests(membership_id) WHERE state='OPEN';
CREATE INDEX membership_agreement_requests_membership ON hon.membership_agreement_requests(organization_id,school_id,membership_id,created_at DESC);

-- The signature: append-only, bound to the exact text shown (SHA-256 of the language's document).
CREATE TABLE hon.membership_agreement_signatures (
  request_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  text_version integer NOT NULL,
  language text NOT NULL CHECK (language IN ('en','ko','es')),
  document_hash text NOT NULL CHECK (document_hash ~ '^[a-f0-9]{64}$'),
  signer_person_id uuid NOT NULL,
  signer_name text NOT NULL CHECK (hon.school_event_text_ok(signer_name,1,120)),
  signer_relationship text NOT NULL CHECK (signer_relationship IN ('SELF','PARENT','LEGAL_GUARDIAN')),
  strokes jsonb NOT NULL CHECK (jsonb_typeof(strokes)='array' AND jsonb_array_length(strokes) BETWEEN 1 AND 200 AND octet_length(strokes::text)<=16384),
  signed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (request_id,organization_id,school_id) REFERENCES hon.membership_agreement_requests(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (signer_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id,text_version) REFERENCES hon.membership_agreement_texts(school_id,text_version) ON DELETE RESTRICT
);
CREATE INDEX membership_agreement_signatures_membership ON hon.membership_agreement_signatures(membership_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['membership_agreement_texts','membership_agreement_requests','membership_agreement_signatures'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

-- Settings-free guards: texts and signatures never change; a request changes only OPEN -> SIGNED|REPLACED, once, with closed_at.
CREATE FUNCTION hon.guard_membership_agreement_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='membership_agreement_requests' THEN
    IF to_jsonb(OLD)->>'state'='OPEN' AND to_jsonb(NEW)->>'state' IN ('SIGNED','REPLACED') AND to_jsonb(NEW)->>'closed_at' IS NOT NULL
      AND (to_jsonb(NEW)-'state'-'closed_at')=(to_jsonb(OLD)-'state'-'closed_at') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_MEMBERSHIP_AGREEMENT' USING ERRCODE='42501';
END $$;
CREATE TRIGGER membership_agreement_texts_immutable BEFORE UPDATE OR DELETE ON hon.membership_agreement_texts FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_agreement_record();
CREATE TRIGGER membership_agreement_texts_no_truncate BEFORE TRUNCATE ON hon.membership_agreement_texts FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_agreement_record();
CREATE TRIGGER membership_agreement_requests_guard BEFORE UPDATE OR DELETE ON hon.membership_agreement_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_agreement_record();
CREATE TRIGGER membership_agreement_requests_no_truncate BEFORE TRUNCATE ON hon.membership_agreement_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_agreement_record();
CREATE TRIGGER membership_agreement_signatures_immutable BEFORE UPDATE OR DELETE ON hon.membership_agreement_signatures FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_agreement_record();
CREATE TRIGGER membership_agreement_signatures_no_truncate BEFORE TRUNCATE ON hon.membership_agreement_signatures FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_agreement_record();

-- The start gate. While the school's current agreement requires a signature, a membership goes from not started to active only
-- with a signature for it. A membership from a reviewed billing import (0334) is exempt.
CREATE FUNCTION hon.guard_membership_agreement_signed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF coalesce((SELECT t.signature_required FROM hon.membership_agreement_texts t WHERE t.school_id=NEW.school_id AND t.organization_id=NEW.organization_id
      ORDER BY t.text_version DESC LIMIT 1),false)
    AND NOT EXISTS(SELECT 1 FROM hon.membership_agreement_signatures s WHERE s.membership_id=NEW.id)
    AND NOT EXISTS(SELECT 1 FROM hon.membership_activation_decisions d WHERE d.membership_id=NEW.id AND d.evaluated_facts->>'origin'='BILLING_IMPORT') THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_REQUIRED' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER memberships_agreement_signed AFTER UPDATE OF state ON hon.memberships
  FOR EACH ROW WHEN (OLD.state='DRAFT' AND NEW.state='ACTIVE') EXECUTE FUNCTION hon.guard_membership_agreement_signed();

-- Live direct-human staff authority at the session school for one of the three permissions this feature uses (the 0387 rules).
CREATE FUNCTION hon.require_membership_agreement_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND permission IN ('billing.membership.create','billing.membership.read','billing.membership_agreement.manage') AND x.code=permission AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- The family signs as this code-owned service principal (audit and outbox only; it holds no role).
INSERT INTO hon.principals(id,principal_type,display_name)
  VALUES('00000000-0000-4000-8000-000000000410','SYSTEM_SERVICE','Code-owned membership agreement signing link');

-- The current agreement of the session school, or NULL.
CREATE FUNCTION hon.membership_agreement_current(p_org uuid,p_school uuid) RETURNS hon.membership_agreement_texts
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT t FROM hon.membership_agreement_texts t WHERE t.organization_id=p_org AND t.school_id=p_school ORDER BY t.text_version DESC LIMIT 1
$$;

-- The exact document the family signs: the school's agreement in each language it has, plus the membership terms. Each
-- language carries the SHA-256 of its own canonical JSON, which the signature repeats.
CREATE FUNCTION hon.membership_agreement_document(m hon.memberships,a hon.membership_agreement_texts,tz text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE terms jsonb; school_name text; langs jsonb:='{}'::jsonb; l text; one jsonb;
BEGIN
  SELECT s.name INTO school_name FROM hon.schools s WHERE s.id=m.school_id AND s.organization_id=m.organization_id;
  SELECT jsonb_build_object(
      'studentName',(SELECT left(p.given_name||' '||p.family_name,240) FROM hon.people p WHERE p.id=m.participant_person_id),
      'payerName',(SELECT left(p.given_name||' '||p.family_name,240) FROM hon.billing_accounts b JOIN hon.people p ON p.id=b.responsible_person_id WHERE b.id=m.billing_account_id),
      'planName',coalesce(v.display_name,m.plan_code),'planCode',m.plan_code,'priceMinor',v.price_minor,'currency',v.currency,
      'billingFrequency',v.billing_frequency,'termKind',v.term_kind,'termMonths',v.term_months,
      'startDate',CASE WHEN m.term_started_at IS NULL THEN NULL ELSE to_char(hon.membership_local_date(m.term_started_at,tz),'YYYY-MM-DD') END,
      'endDate',CASE WHEN m.term_ends_at IS NULL THEN NULL ELSE to_char(hon.membership_local_date(m.term_ends_at-interval '1 microsecond',tz),'YYYY-MM-DD') END)
    INTO terms
  FROM (SELECT 1) x LEFT JOIN hon.membership_plan_selections s ON s.membership_id=m.id
    LEFT JOIN hon.membership_plan_versions v ON v.plan_id=s.plan_id AND v.version=s.plan_version AND v.organization_id=s.organization_id AND v.school_id=s.school_id;
  FOR l IN SELECT k FROM jsonb_object_keys(a.texts) k ORDER BY k LOOP
    one:=jsonb_build_object('language',l,'schoolName',school_name,'textVersion',a.text_version,'title',a.texts->l->>'title','body',a.texts->l->>'body','terms',terms);
    langs:=langs||jsonb_build_object(l,jsonb_build_object('title',a.texts->l->>'title','body',a.texts->l->>'body',
      'documentHash',encode(sha256(convert_to(one::text,'UTF8')),'hex')));
  END LOOP;
  RETURN jsonb_build_object('schoolName',school_name,'textVersion',a.text_version,'languages',langs,'terms',terms);
END $$;

CREATE FUNCTION hon.membership_agreement_request_item(r hon.membership_agreement_requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('requestId',r.id,'state',CASE WHEN r.state='OPEN' AND r.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE r.state END,
    'signerPersonId',r.signer_person_id,'signerRelation',r.signer_relation,'textVersion',r.text_version,
    'createdAt',hon.saas_ts(r.created_at),'expiresAt',hon.saas_ts(r.expires_at),
    'signature',(SELECT jsonb_build_object('signedName',s.signer_name,'relationship',s.signer_relationship,'language',s.language,'signedAt',hon.saas_ts(s.signed_at))
      FROM hon.membership_agreement_signatures s WHERE s.request_id=r.id))
$$;

-- Staff read of the school agreement (billing.membership.read). Output: {textVersion, signatureRequired, texts, updatedAt}; all
-- null/false before the first one is saved.
CREATE FUNCTION hon.read_membership_agreement_template(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); a hon.membership_agreement_texts; result jsonb;
BEGIN
  PERFORM hon.require_membership_agreement_actor(p_subject,'billing.membership.read');
  a:=hon.membership_agreement_current(org,school);
  result:=jsonb_build_object('textVersion',a.text_version,'signatureRequired',coalesce(a.signature_required,false),'texts',a.texts,'updatedAt',hon.saas_ts(a.created_at));
  PERFORM hon.require_membership_agreement_actor(p_subject,'billing.membership.read');
  RETURN result;
END $$;

-- Save a new version (billing.membership_agreement.manage). Input: exactly {expectedVersion (null before the first), texts,
-- signatureRequired, confirmation}. Returns {agreement, replayed}.
CREATE FUNCTION hon.save_membership_agreement_template(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; a hon.membership_agreement_texts; n hon.membership_agreement_texts;
  prior hon.membership_agreement_texts; out jsonb;
BEGIN
  actor:=hon.require_membership_agreement_actor(p_subject,'billing.membership_agreement.manage');
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['confirmation','expectedVersion','signatureRequired','texts']
    OR (jsonb_typeof(p_input->'expectedVersion')<>'null' AND (jsonb_typeof(p_input->'expectedVersion')<>'number' OR (p_input->'expectedVersion')::text !~ '^[1-9][0-9]{0,4}$'))
    OR jsonb_typeof(p_input->'signatureRequired') IS DISTINCT FROM 'boolean' OR NOT hon.membership_agreement_texts_ok(p_input->'texts')
    OR p_input->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_MEMBERSHIP_AGREEMENT_TEXT' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','billing.membership_agreement.save','input',p_input)::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.membership_agreement_text:'||org||':'||school,0));
  SELECT * INTO prior FROM hon.membership_agreement_texts t WHERE t.organization_id=org AND t.school_id=school AND t.actor_principal_id=actor AND t.idempotency_key=p_key;
  IF FOUND THEN
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('agreement',jsonb_build_object('textVersion',prior.text_version,'signatureRequired',prior.signature_required,'texts',prior.texts,
      'updatedAt',hon.saas_ts(prior.created_at)),'replayed',true);
  END IF;
  a:=hon.membership_agreement_current(org,school);
  IF (p_input->'expectedVersion')::text IS DISTINCT FROM coalesce(a.text_version::text,'null') THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_STALE' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.membership_agreement_texts(organization_id,school_id,text_version,texts,signature_required,actor_principal_id,idempotency_key,request_fingerprint)
    VALUES(org,school,coalesce(a.text_version,0)+1,p_input->'texts',(p_input->>'signatureRequired')::boolean,actor,p_key,fp) RETURNING * INTO n;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership_agreement.manage','MEMBERSHIP_AGREEMENT',school,
      CASE WHEN a.text_version IS NULL THEN NULL ELSE jsonb_build_object('textVersion',a.text_version,'signatureRequired',a.signature_required) END,
      jsonb_build_object('textVersion',n.text_version,'signatureRequired',n.signature_required,'languages',(SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(n.texts) k)),
      'SUCCEEDED',p_request,p_correlation);
  IF hon.require_membership_agreement_actor(p_subject,'billing.membership_agreement.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  out:=jsonb_build_object('textVersion',n.text_version,'signatureRequired',n.signature_required,'texts',n.texts,'updatedAt',hon.saas_ts(n.created_at));
  RETURN jsonb_build_object('agreement',out,'replayed',false);
END $$;

-- The card's agreement panel for one membership (billing.membership.read). Input: exactly {membershipId}. Output:
-- {membershipId, membershipState, agreementVersion, signatureRequired, signed, signers, requests}.
CREATE FUNCTION hon.read_membership_agreement(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); m hon.memberships; a hon.membership_agreement_texts; tz text;
  signers jsonb:='[]'::jsonb; result jsonb;
BEGIN
  PERFORM hon.require_membership_agreement_actor(p_subject,'billing.membership.read');
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['membershipId']
    OR jsonb_typeof(p_input->'membershipId') IS DISTINCT FROM 'string' OR (p_input->>'membershipId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=(p_input->>'membershipId')::uuid AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  a:=hon.membership_agreement_current(org,school);
  IF m.state='DRAFT' THEN
    signers:=coalesce((SELECT jsonb_agg(jsonb_build_object('personId',x->>'personId','givenName',x->>'givenName','familyName',x->>'familyName','relation',x->>'relation'))
      FROM jsonb_array_elements(hon.person_membership_start_facts(m.participant_person_id,hon.membership_local_date(clock_timestamp(),tz))->'payers') x),'[]'::jsonb);
  END IF;
  result:=jsonb_build_object('membershipId',m.id,'membershipState',m.state::text,'agreementVersion',a.text_version,'signatureRequired',coalesce(a.signature_required,false),
    'signed',EXISTS(SELECT 1 FROM hon.membership_agreement_signatures s WHERE s.membership_id=m.id),'signers',signers,
    'requests',coalesce((SELECT jsonb_agg(hon.membership_agreement_request_item(r) ORDER BY r.created_at DESC,r.id) FROM
      (SELECT * FROM hon.membership_agreement_requests r WHERE r.organization_id=org AND r.school_id=school AND r.membership_id=m.id ORDER BY r.created_at DESC LIMIT 20) r),'[]'::jsonb));
  PERFORM hon.require_membership_agreement_actor(p_subject,'billing.membership.read');
  RETURN result;
END $$;

-- Make a signing link for one membership that has not started (billing.membership.create). Input: exactly {membershipId,
-- signerPersonId, token, confirmation}; token is 43 base64url characters made by the browser and never stored (only its
-- SHA-256). Replaces any open link for that membership. Returns {request, replayed}.
CREATE FUNCTION hon.send_membership_agreement(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; prior hon.membership_agreement_requests;
  m hon.memberships; a hon.membership_agreement_texts; tz text; signer jsonb; r hon.membership_agreement_requests; receipt jsonb; instant timestamptz:=clock_timestamp(); rid uuid:=gen_random_uuid();
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  actor:=hon.require_membership_agreement_actor(p_subject,'billing.membership.create');
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['confirmation','membershipId','signerPersonId','token']
    OR jsonb_typeof(p_input->'membershipId') IS DISTINCT FROM 'string' OR (p_input->>'membershipId') !~ uuid_re
    OR jsonb_typeof(p_input->'signerPersonId') IS DISTINCT FROM 'string' OR (p_input->>'signerPersonId') !~ uuid_re
    OR jsonb_typeof(p_input->'token') IS DISTINCT FROM 'string' OR (p_input->>'token') !~ '^[A-Za-z0-9_-]{43}$'
    OR p_input->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_SEND_MEMBERSHIP_AGREEMENT' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','billing.membership_agreement.send','input',p_input)::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.membership_agreement_requests x WHERE x.organization_id=org AND x.school_id=school AND x.actor_principal_id=actor AND x.idempotency_key=p_key;
  IF FOUND THEN
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('request',prior.receipt,'replayed',true);
  END IF;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=(p_input->>'membershipId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF m.state<>'DRAFT' THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_BLOCKED' USING ERRCODE='55000',HINT='["MEMBERSHIP_STARTED"]'; END IF;
  a:=hon.membership_agreement_current(org,school);
  IF a.text_version IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_BLOCKED' USING ERRCODE='55000',HINT='["NO_AGREEMENT"]'; END IF;
  IF EXISTS(SELECT 1 FROM hon.membership_agreement_signatures s WHERE s.membership_id=m.id) THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_BLOCKED' USING ERRCODE='55000',HINT='["ALREADY_SIGNED"]'; END IF;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  SELECT x INTO signer FROM jsonb_array_elements(hon.person_membership_start_facts(m.participant_person_id,hon.membership_local_date(instant,tz))->'payers') x
    WHERE x->>'personId'=p_input->>'signerPersonId';
  IF signer IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_BLOCKED' USING ERRCODE='55000',HINT='["SIGNER_NOT_ALLOWED"]'; END IF;
  UPDATE hon.membership_agreement_requests SET state='REPLACED',closed_at=instant WHERE membership_id=m.id AND state='OPEN';
  receipt:=jsonb_build_object('requestId',rid,'state','OPEN','signerPersonId',signer->>'personId','signerRelation',signer->>'relation','textVersion',a.text_version,
    'createdAt',hon.saas_ts(instant),'expiresAt',hon.saas_ts(instant+interval '14 days'),'signature',NULL,'membershipId',m.id);
  INSERT INTO hon.membership_agreement_requests(id,organization_id,school_id,membership_id,signer_person_id,signer_relation,text_version,document,token_hash,state,
      expires_at,actor_principal_id,idempotency_key,request_fingerprint,receipt,created_at)
    VALUES(rid,org,school,m.id,(signer->>'personId')::uuid,signer->>'relation',a.text_version,hon.membership_agreement_document(m,a,tz),
      encode(sha256(convert_to(p_input->>'token','UTF8')),'hex'),'OPEN',instant+interval '14 days',actor,p_key,fp,receipt,instant) RETURNING * INTO r;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership_agreement.send','MEMBERSHIP',m.id,NULL,
      jsonb_build_object('requestId',r.id,'textVersion',a.text_version,'signerPersonId',r.signer_person_id,'signerRelation',r.signer_relation),'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership_agreement.sent',1,'MEMBERSHIP',m.id,m.version,p_correlation,p_request,
      jsonb_build_object('requestId',r.id,'textVersion',a.text_version,'executionAllowed',false,'humanOnly',true));
  IF hon.require_membership_agreement_actor(p_subject,'billing.membership.create') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('request',receipt,'replayed',false);
END $$;

-- Public: what a signing link shows. NULL for an unknown token. A link that is no longer open shows only its state and the
-- school name. One fixed call with no tenant settings; the token is looked up by its SHA-256.
CREATE FUNCTION hon.read_membership_agreement_link(p_token text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r hon.membership_agreement_requests; state text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN RETURN NULL; END IF;
  SELECT * INTO r FROM hon.membership_agreement_requests x WHERE x.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  IF NOT FOUND THEN RETURN NULL; END IF;
  state:=CASE WHEN r.state='OPEN' AND r.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE r.state END;
  IF state<>'OPEN' THEN RETURN jsonb_build_object('state',state,'schoolName',r.document->>'schoolName'); END IF;
  RETURN jsonb_build_object('state','OPEN','schoolName',r.document->>'schoolName','signerRelation',r.signer_relation,
    'signerGivenName',(SELECT left(p.given_name,200) FROM hon.people p WHERE p.id=r.signer_person_id),'expiresAt',hon.saas_ts(r.expires_at),
    'languages',r.document->'languages','terms',r.document->'terms');
END $$;

-- Public: sign through the link. Input: exactly {language, documentHash, signerName, relationship, strokes, confirmation}.
-- Returns SIGNED, INVALID (the request does not match what the link shows) or GONE (unknown, expired, replaced or signed).
CREATE FUNCTION hon.sign_membership_agreement(p_token text,p_input jsonb,p_request uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r hon.membership_agreement_requests; m hon.memberships; svc constant uuid:='00000000-0000-4000-8000-000000000410'; lang text; instant timestamptz:=clock_timestamp();
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' OR p_request IS NULL THEN RETURN 'GONE'; END IF;
  SELECT * INTO r FROM hon.membership_agreement_requests x WHERE x.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') FOR UPDATE;
  IF NOT FOUND OR r.state<>'OPEN' OR r.expires_at<=instant THEN RETURN 'GONE'; END IF;
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['confirmation','documentHash','language','relationship','signerName','strokes']
    OR jsonb_typeof(p_input->'language') IS DISTINCT FROM 'string' OR NOT (r.document->'languages') ? (p_input->>'language')
    OR jsonb_typeof(p_input->'documentHash') IS DISTINCT FROM 'string' OR p_input->>'documentHash' IS DISTINCT FROM r.document->'languages'->(p_input->>'language')->>'documentHash'
    OR jsonb_typeof(p_input->'signerName') IS DISTINCT FROM 'string' OR NOT hon.school_event_text_ok(p_input->>'signerName',1,120)
    OR jsonb_typeof(p_input->'relationship') IS DISTINCT FROM 'string'
    OR (r.signer_relation='SELF' AND p_input->>'relationship'<>'SELF') OR (r.signer_relation='GUARDIAN' AND p_input->>'relationship' NOT IN ('PARENT','LEGAL_GUARDIAN'))
    OR jsonb_typeof(p_input->'strokes') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'strokes') NOT BETWEEN 1 AND 200 OR octet_length((p_input->'strokes')::text)>16384
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'strokes') s WHERE jsonb_typeof(s)<>'array' OR jsonb_array_length(s) NOT BETWEEN 2 AND 2000
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(s) v WHERE jsonb_typeof(v)<>'number' OR (v::text)::numeric NOT BETWEEN 0 AND 10000))
    OR p_input->>'confirmation' IS DISTINCT FROM 'I_AGREE_AND_SIGN_THIS_MEMBERSHIP_AGREEMENT' THEN RETURN 'INVALID'; END IF;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=r.membership_id FOR SHARE;
  IF m.state<>'DRAFT' THEN RETURN 'GONE'; END IF;
  PERFORM 1 FROM hon.principals WHERE id=svc AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  lang:=p_input->>'language';
  INSERT INTO hon.membership_agreement_signatures(request_id,organization_id,school_id,membership_id,text_version,language,document_hash,signer_person_id,
      signer_name,signer_relationship,strokes,signed_at)
    VALUES(r.id,r.organization_id,r.school_id,r.membership_id,r.text_version,lang,p_input->>'documentHash',r.signer_person_id,
      p_input->>'signerName',p_input->>'relationship',p_input->'strokes',instant);
  UPDATE hon.membership_agreement_requests SET state='SIGNED',closed_at=instant WHERE id=r.id AND state='OPEN';
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(r.organization_id,r.school_id,svc,'PUBLIC_API','billing.membership_agreement.sign','MEMBERSHIP',r.membership_id,NULL,
      jsonb_build_object('requestId',r.id,'textVersion',r.text_version,'language',lang,'relationship',p_input->>'relationship'),'SUCCEEDED',p_request,p_request);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(r.organization_id,r.school_id,'billing.membership_agreement.signed',1,'MEMBERSHIP',r.membership_id,m.version,p_request,p_request,
      jsonb_build_object('requestId',r.id,'textVersion',r.text_version,'executionAllowed',false,'humanOnly',true));
  RETURN 'SIGNED';
END $$;

DO $$ DECLARE r text; f text; t text;
  entry text[]:=ARRAY['hon.read_membership_agreement_template(text)','hon.save_membership_agreement_template(text,jsonb,text,uuid,uuid)',
    'hon.read_membership_agreement(text,jsonb)','hon.send_membership_agreement(text,jsonb,text,uuid,uuid)',
    'hon.read_membership_agreement_link(text)','hon.sign_membership_agreement(text,jsonb,uuid)'];
  fns text[]:=ARRAY['hon.membership_agreement_texts_ok(jsonb)','hon.guard_membership_agreement_record()','hon.guard_membership_agreement_signed()',
    'hon.require_membership_agreement_actor(text,text)','hon.membership_agreement_current(uuid,uuid)',
    'hon.membership_agreement_document(hon.memberships,hon.membership_agreement_texts,text)',
    'hon.membership_agreement_request_item(hon.membership_agreement_requests)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['membership_agreement_texts','membership_agreement_requests','membership_agreement_signatures'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
