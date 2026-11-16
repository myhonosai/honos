BEGIN;

-- Face check-in with parent consent (0409, coordinator-allocated 2026-11-16; owner approved the feature 2026-11-16;
-- docs/architecture/FACE_CHECKIN.md). A camera picture is matched to a student's 0390 profile photo and, after a staff
-- member confirms, attendance is written through the 0394 shared check-in path with method FACE.
--
-- * PROGRAM: hon.face_checkin_program is CLOSED. Only the migration owner of a test database can set TEST_MODE (the 0241
--   pattern). While CLOSED nothing can be turned on, signed, enrolled or matched; turning off and withdrawing always work.
-- * MATCHER: SYNTHETIC only. The "template" is the SHA-256 of the enrolled profile photo and a picture "matches" when the
--   API's SHA-256 of the metadata-stripped picture is identical. It is a stand-in, not face recognition. The picture and
--   its digest are never stored. A real matcher needs owner approval and a new migration.
-- * ONE STRICT BASELINE everywhere (written consent; a parent or guardian signs for anyone under 18 or without a birth
--   date; published retention; never sold or shared; refusing keeps every other check-in; staff confirm every match) plus
--   the 0392 jurisdiction profile's add-ons. All form text is TEST_ONLY_DRAFT for lawyer review; a change is a new migration.
-- * CITY LIMITS (0392 review P3): where the school's state has a city with its own rule (Portland OR ban, New York City),
--   turning face check-in on needs the owner to say whether the school is inside those city limits. An address whose
--   city already names that city cannot be answered "no". Inside Portland is refused (BLOCKED).
-- * RETENTION: a template is deleted at the earliest of consent withdrawn, photo removed or replaced, school turned off or
--   its address changed, 30 days after the student is no longer ACTIVE, or 12 months without a face check-in. Only an
--   identifier-only deletion record remains. The sweep runs on every read and match for the school, and
--   hon.purge_face_checkin_retention() must be scheduled daily before real use (deployment requirement, like 0388).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION '0409 requires a restricted runtime'; END IF;
  IF to_regprocedure('hon.attendance_check_in_student(text,uuid,uuid,text,uuid,text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.lock_attendance_actor(text,text)') IS NULL OR to_regclass('hon.person_photos') IS NULL
    OR to_regclass('hon.school_locations') IS NULL OR to_regprocedure('hon.biometric_profile_for(text,text,text)') IS NULL
    OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL THEN
    RAISE EXCEPTION '0409 requires 0390, 0392 and 0394'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('face_checkin.manage','Turn face check-in on or off, record and withdraw consent in person, and enroll students from their profile photo',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='face_checkin.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'face_checkin.manage already exists with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'face_checkin.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' ON CONFLICT DO NOTHING;

-- 0394 provenance rows gain the FACE method (method_ref is the confirmed match).
ALTER TABLE hon.attendance_check_ins DROP CONSTRAINT attendance_check_ins_method_check;
ALTER TABLE hon.attendance_check_ins ADD CONSTRAINT attendance_check_ins_method_check CHECK (method IN ('CARD','FACE'));

CREATE TABLE hon.face_checkin_program (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  status text NOT NULL CHECK (status IN ('CLOSED','TEST_MODE')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO hon.face_checkin_program(status) VALUES('CLOSED');

-- Draft form text, by language and part. BASELINE and TITLE are in every form; an add-on part is added when the profile
-- lists that add-on. Immutable.
CREATE TABLE hon.face_checkin_form_parts (
  language text NOT NULL CHECK (language IN ('en','ko','es')),
  part text NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 10 AND 2000),
  PRIMARY KEY (language,part)
);
INSERT INTO hon.face_checkin_form_parts(language,part,body) VALUES
 ('en','TITLE','Consent to face check-in (DRAFT: a lawyer has not reviewed this form)'),
 ('en','BASELINE','If you agree, this school makes a face template from the student''s profile photo and uses it only to check the student in to classes at this school. A staff member confirms every match before attendance is recorded. No camera picture is kept. The face template is never sold, shared or used for anything else. A parent or guardian must sign for anyone under 18. You may refuse or withdraw at any time: the student can still check in by card or by name, and refusing never affects classes or membership. The face template is deleted at once when you withdraw, when the profile photo is removed or replaced, or when the school turns face check-in off, and no later than 30 days after the student''s membership ends or 12 months after the last face check-in.'),
 ('en','LAWS','Laws this form is written for:'),
 ('en','WRITTEN_RELEASE','Illinois law requires this written release before any face data is made. It states the purpose (attendance check-in) and how long the face template is kept (above).'),
 ('en','PUBLIC_RETENTION_SCHEDULE','The school publishes this retention and deletion schedule and follows it.'),
 ('en','PRIVATE_RIGHT_OF_ACTION','Illinois law gives you rights you can enforce if this release is not followed.'),
 ('en','DESTROY_WITHIN_ONE_YEAR','Texas law requires the face template to be destroyed within one year after its purpose ends; it is deleted sooner, as described above.'),
 ('en','HEALTH_DATA_CONSENT','In Washington, face data is consumer health data. This is your consent to collect it for check-in only.'),
 ('en','SENSITIVE_DATA_NOTICE','Face data is sensitive personal information. It is collected only for check-in at this school.'),
 ('en','NO_DENIAL_FOR_REFUSAL','The school will not refuse service or change prices if you do not agree.'),
 ('en','ENTRANCE_SIGN','The school has posted a sign at its entrance saying that biometric identifier information is collected.'),
 ('en','IMPACT_ASSESSMENT','The school has completed a data protection impact assessment. Your consent is explicit, and you can withdraw it as easily as you gave it.'),
 ('en','RIGHT_TO_REFUSE_NOTICE','You have the right to refuse. If you refuse, the student checks in another way.'),
 ('en','SEPARATE_CONSENT','This is a separate consent for sensitive information: the item (a face template made from the profile photo), the purpose (attendance check-in), how long it is kept (above), and your right to refuse, which has no effect on classes.'),
 ('ko','TITLE','얼굴 출석 체크 동의서 (초안: 변호사 검토 전 양식입니다)'),
 ('ko','BASELINE','동의하시면 도장은 학생의 프로필 사진으로 얼굴 템플릿을 만들어 이 도장의 수업 출석 체크에만 사용합니다. 출석은 직원이 매번 확인한 뒤에 기록됩니다. 카메라 사진은 보관하지 않습니다. 얼굴 템플릿은 판매하거나 공유하거나 다른 용도로 쓰지 않습니다. 만 18세 미만은 부모나 보호자가 서명해야 합니다. 언제든지 거부하거나 철회할 수 있으며, 학생은 카드나 이름으로 계속 출석 체크할 수 있고 거부해도 수업이나 회원 자격에 영향이 없습니다. 얼굴 템플릿은 철회하거나, 프로필 사진을 지우거나 바꾸거나, 도장이 얼굴 출석 체크를 끄면 즉시 삭제되며, 늦어도 회원 자격이 끝난 뒤 30일 또는 마지막 얼굴 출석 체크 뒤 12개월에 삭제됩니다.'),
 ('ko','LAWS','이 양식이 따르는 법률:'),
 ('ko','WRITTEN_RELEASE','일리노이주 법은 얼굴 정보를 만들기 전에 이 서면 동의를 요구합니다. 목적(출석 체크)과 얼굴 템플릿 보관 기간(위 내용)을 밝힙니다.'),
 ('ko','PUBLIC_RETENTION_SCHEDULE','도장은 이 보관 및 삭제 일정을 공개하고 지킵니다.'),
 ('ko','PRIVATE_RIGHT_OF_ACTION','일리노이주 법은 이 동의가 지켜지지 않을 때 행사할 수 있는 권리를 보장합니다.'),
 ('ko','DESTROY_WITHIN_ONE_YEAR','텍사스주 법은 목적이 끝난 뒤 1년 안에 얼굴 템플릿을 파기하도록 요구하며, 위에 적힌 대로 그보다 빨리 삭제됩니다.'),
 ('ko','HEALTH_DATA_CONSENT','워싱턴주에서 얼굴 정보는 소비자 건강 정보입니다. 출석 체크에만 쓰도록 수집하는 데 대한 동의입니다.'),
 ('ko','SENSITIVE_DATA_NOTICE','얼굴 정보는 민감한 개인정보입니다. 이 도장의 출석 체크를 위해서만 수집합니다.'),
 ('ko','NO_DENIAL_FOR_REFUSAL','동의하지 않아도 도장은 서비스를 거절하거나 가격을 바꾸지 않습니다.'),
 ('ko','ENTRANCE_SIGN','도장은 입구에 생체 식별 정보를 수집한다는 안내문을 게시했습니다.'),
 ('ko','IMPACT_ASSESSMENT','도장은 개인정보 영향평가를 마쳤습니다. 이 동의는 명시적이며, 동의한 것만큼 쉽게 철회할 수 있습니다.'),
 ('ko','RIGHT_TO_REFUSE_NOTICE','거부할 권리가 있습니다. 거부하면 학생은 다른 방법으로 출석 체크합니다.'),
 ('ko','SEPARATE_CONSENT','민감정보 처리에 대한 별도 동의입니다. 항목(프로필 사진으로 만든 얼굴 템플릿), 목적(출석 체크), 보관 기간(위 내용), 거부할 권리와 거부 시 불이익(수업에 영향 없음)을 알려 드립니다.'),
 ('es','TITLE','Consentimiento para el registro facial de asistencia (BORRADOR: un abogado no ha revisado este formulario)'),
 ('es','BASELINE','Si usted acepta, esta escuela crea una plantilla facial a partir de la foto de perfil del estudiante y la usa solo para registrar su asistencia a clases en esta escuela. Un miembro del personal confirma cada coincidencia antes de registrar la asistencia. No se guarda ninguna foto de la cámara. La plantilla facial nunca se vende, se comparte ni se usa para otra cosa. Un padre, madre o tutor debe firmar por cualquier menor de 18 años. Puede negarse o retirar su consentimiento en cualquier momento: el estudiante puede seguir registrándose con tarjeta o por nombre, y negarse nunca afecta las clases ni la membresía. La plantilla facial se elimina de inmediato cuando usted retira el consentimiento, cuando se borra o se cambia la foto de perfil o cuando la escuela desactiva el registro facial, y a más tardar 30 días después de que termine la membresía o 12 meses después del último registro facial.'),
 ('es','LAWS','Leyes para las que está escrito este formulario:'),
 ('es','WRITTEN_RELEASE','La ley de Illinois exige esta autorización por escrito antes de crear datos faciales. Indica el propósito (registro de asistencia) y cuánto tiempo se guarda la plantilla facial (arriba).'),
 ('es','PUBLIC_RETENTION_SCHEDULE','La escuela publica este calendario de conservación y eliminación y lo cumple.'),
 ('es','PRIVATE_RIGHT_OF_ACTION','La ley de Illinois le da derechos que puede hacer valer si no se cumple esta autorización.'),
 ('es','DESTROY_WITHIN_ONE_YEAR','La ley de Texas exige destruir la plantilla facial dentro de un año después de que termine su propósito; se elimina antes, como se describe arriba.'),
 ('es','HEALTH_DATA_CONSENT','En Washington, los datos faciales son datos de salud del consumidor. Este es su consentimiento para recopilarlos solo para el registro de asistencia.'),
 ('es','SENSITIVE_DATA_NOTICE','Los datos faciales son información personal sensible. Se recopilan solo para el registro de asistencia en esta escuela.'),
 ('es','NO_DENIAL_FOR_REFUSAL','La escuela no negará el servicio ni cambiará los precios si usted no acepta.'),
 ('es','ENTRANCE_SIGN','La escuela colocó un aviso en su entrada que indica que se recopila información de identificadores biométricos.'),
 ('es','IMPACT_ASSESSMENT','La escuela completó una evaluación de impacto en la protección de datos. Su consentimiento es explícito y puede retirarlo con la misma facilidad con que lo dio.'),
 ('es','RIGHT_TO_REFUSE_NOTICE','Usted tiene derecho a negarse. Si se niega, el estudiante se registra de otra manera.'),
 ('es','SEPARATE_CONSENT','Este es un consentimiento separado para información sensible: el dato (una plantilla facial hecha a partir de la foto de perfil), el propósito (registro de asistencia), cuánto tiempo se guarda (arriba) y su derecho a negarse, que no afecta las clases.');

-- One immutable form per available profile and language, built from the parts above; the digest proves which exact text
-- a signer saw.
CREATE TABLE hon.face_checkin_forms (
  id smallint PRIMARY KEY,
  profile_code text NOT NULL REFERENCES hon.biometric_jurisdiction_profiles(code),
  language text NOT NULL CHECK (language IN ('en','ko','es')),
  version integer NOT NULL CHECK (version=1),
  title text NOT NULL, body text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  review_status text NOT NULL CHECK (review_status='TEST_ONLY_DRAFT'),
  UNIQUE (profile_code,language,version),
  CHECK (digest=encode(sha256(convert_to(title||E'\n\n'||body,'UTF8')),'hex'))
);
WITH built AS (
  SELECT p.code,l.language,
    (SELECT body FROM hon.face_checkin_form_parts WHERE language=l.language AND part='TITLE') title,
    (SELECT body FROM hon.face_checkin_form_parts WHERE language=l.language AND part='BASELINE')
      ||coalesce((SELECT E'\n\n'||string_agg(fp.body,E'\n\n' ORDER BY a.ord) FROM unnest(p.add_ons) WITH ORDINALITY a(code,ord)
        JOIN hon.face_checkin_form_parts fp ON fp.language=l.language AND fp.part=a.code),'')
      ||E'\n\n'||(SELECT body FROM hon.face_checkin_form_parts WHERE language=l.language AND part='LAWS')||' '||array_to_string(p.laws,'; ') body
  FROM hon.biometric_jurisdiction_profiles p CROSS JOIN (VALUES ('en'),('ko'),('es')) l(language)
  WHERE p.status='AVAILABLE_WITH_CONSENT')
INSERT INTO hon.face_checkin_forms(id,profile_code,language,version,title,body,digest,review_status)
SELECT row_number() OVER (ORDER BY code,language),code,language,1,title,body,encode(sha256(convert_to(title||E'\n\n'||body,'UTF8')),'hex'),'TEST_ONLY_DRAFT' FROM built;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.face_checkin_forms)<>3*(SELECT count(*) FROM hon.biometric_jurisdiction_profiles WHERE status='AVAILABLE_WITH_CONSENT')
    OR EXISTS(SELECT 1 FROM hon.biometric_jurisdiction_profiles p, unnest(p.add_ons) a WHERE p.status='AVAILABLE_WITH_CONSENT'
      AND NOT EXISTS(SELECT 1 FROM hon.face_checkin_form_parts fp WHERE fp.part=a AND fp.language='en')) THEN
    RAISE EXCEPTION '0409 forms do not cover every available profile and add-on'; END IF;
END $$;

-- The school's choice. ON names the profile it was turned on under, the city-limits answer and the acknowledgements.
-- Each ON starts a new activation: consents signed under an earlier activation must be signed again.
CREATE TABLE hon.face_checkin_settings (
  school_id uuid PRIMARY KEY, organization_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ON','OFF')),
  profile_code text REFERENCES hon.biometric_jurisdiction_profiles(code),
  city_limits text CHECK (city_limits IS NULL OR city_limits ~ '^[A-Z_]{2,40}$'),
  acknowledgements text[] NOT NULL DEFAULT '{}',
  activation integer NOT NULL CHECK (activation BETWEEN 1 AND 999999999),
  off_reason text CHECK (off_reason IN ('OWNER','LOCATION_CHANGED')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((status='ON')=(profile_code IS NOT NULL) AND (status='ON')=(off_reason IS NULL))
);

CREATE TABLE hon.face_checkin_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL, student_profile_id uuid NOT NULL,
  activation integer NOT NULL,
  form_id smallint NOT NULL REFERENCES hon.face_checkin_forms(id),
  form_digest text NOT NULL CHECK (form_digest ~ '^[a-f0-9]{64}$'),
  signer_kind text NOT NULL CHECK (signer_kind IN ('GUARDIAN','ADULT_STUDENT')),
  signer_name text NOT NULL CHECK (length(signer_name) BETWEEN 2 AND 200 AND btrim(signer_name)=signer_name AND signer_name !~ '[<>[:cntrl:]]'),
  method text NOT NULL CHECK (method IN ('PARENT_PORTAL','IN_PERSON')),
  signer_principal_id uuid REFERENCES hon.principals(id),
  witnessed_by_principal_id uuid REFERENCES hon.principals(id),
  status text NOT NULL DEFAULT 'GIVEN' CHECK (status IN ('GIVEN','WITHDRAWN')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  signed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz, withdrawn_by_principal_id uuid REFERENCES hon.principals(id),
  FOREIGN KEY (student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id),
  CHECK ((method='PARENT_PORTAL')=(signer_principal_id IS NOT NULL) AND (method='IN_PERSON')=(witnessed_by_principal_id IS NOT NULL)),
  CHECK (method='IN_PERSON' OR signer_kind='GUARDIAN'),
  CHECK ((status='WITHDRAWN')=(withdrawn_at IS NOT NULL) AND (withdrawn_at IS NULL)=(withdrawn_by_principal_id IS NULL))
);
CREATE UNIQUE INDEX face_checkin_consents_one_given ON hon.face_checkin_consents(student_profile_id) WHERE status='GIVEN';
CREATE INDEX face_checkin_consents_scope_idx ON hon.face_checkin_consents(organization_id,school_id,student_profile_id);

-- The face template (SYNTHETIC: the enrolled photo's SHA-256). Deleted outright when its time is up.
CREATE TABLE hon.face_templates (
  student_profile_id uuid PRIMARY KEY, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  consent_id uuid NOT NULL REFERENCES hon.face_checkin_consents(id),
  activation integer NOT NULL,
  photo_checksum text NOT NULL CHECK (photo_checksum ~ '^[a-f0-9]{64}$'),
  template bytea NOT NULL CHECK (octet_length(template)=32),
  matcher text NOT NULL CHECK (matcher='SYNTHETIC'),
  enrolled_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_matched_at timestamptz,
  FOREIGN KEY (student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id),
  UNIQUE (school_id,template)
);

-- What remains after a template is deleted: who, where, when and why. No face data.
CREATE TABLE hon.face_template_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL, student_profile_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('CONSENT_WITHDRAWN','PHOTO_CHANGED','SCHOOL_TURNED_OFF','LOCATION_CHANGED','NOT_ACTIVE_30_DAYS','NO_CHECK_IN_12_MONTHS','CONSENT_NOT_CURRENT')),
  enrolled_at timestamptz NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX face_template_deletions_scope_idx ON hon.face_template_deletions(organization_id,school_id,deleted_at);

-- One camera picture's outcome. No picture or digest is kept.
CREATE TABLE hon.face_checkin_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL, class_session_id uuid NOT NULL,
  student_profile_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('PROPOSED','NO_MATCH','CONFIRMED','REJECTED','EXPIRED')),
  proposed_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by_principal_id uuid REFERENCES hon.principals(id),
  decided_at timestamptz,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((outcome='NO_MATCH')=(student_profile_id IS NULL)),
  CHECK ((outcome IN ('CONFIRMED','REJECTED'))=(decided_at IS NOT NULL) AND (decided_at IS NULL)=(decided_by_principal_id IS NULL))
);
CREATE INDEX face_checkin_matches_scope_idx ON hon.face_checkin_matches(organization_id,school_id,class_session_id,proposed_at);

CREATE TABLE hon.face_checkin_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('settings','consent','withdraw','enroll','match','confirm','family_sign','family_withdraw')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['face_checkin_program','face_checkin_form_parts','face_checkin_forms','face_checkin_settings','face_checkin_consents',
      'face_templates','face_template_deletions','face_checkin_matches','face_checkin_requests'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

-- Evidence guard. Form text, deletion records and the program row cannot be removed (the program status may change only
-- by the migration owner, who alone can write the table). Settings keep their school and step one version. A consent keeps
-- its facts and only goes GIVEN -> WITHDRAWN. A match only goes PROPOSED -> CONFIRMED/REJECTED/EXPIRED. A template changes
-- only its last match time (and is deleted outright). Requests record their response once. Nothing is truncated.
CREATE FUNCTION hon.guard_face_checkin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'FACE_CHECKIN_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' THEN
    IF TG_TABLE_NAME='face_templates' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'FACE_CHECKIN_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME IN ('face_checkin_form_parts','face_checkin_forms','face_template_deletions') THEN
    RAISE EXCEPTION 'FACE_CHECKIN_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='face_checkin_program' THEN
    IF NEW.singleton IS DISTINCT FROM OLD.singleton THEN RAISE EXCEPTION 'FACE_CHECKIN_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='face_checkin_settings' THEN
    IF NEW.version<>OLD.version+1 OR (NEW.school_id,NEW.organization_id) IS DISTINCT FROM (OLD.school_id,OLD.organization_id)
      OR NEW.activation NOT IN (OLD.activation,OLD.activation+1) OR (NEW.activation=OLD.activation+1 AND NOT (OLD.status='OFF' AND NEW.status='ON')) THEN
      RAISE EXCEPTION 'FACE_CHECKIN_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='face_checkin_consents' THEN
    IF OLD.status<>'GIVEN' OR NEW.status<>'WITHDRAWN' OR NEW.version<>OLD.version+1
      OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.student_profile_id,NEW.activation,NEW.form_id,NEW.form_digest,NEW.signer_kind,NEW.signer_name,
          NEW.method,NEW.signer_principal_id,NEW.witnessed_by_principal_id,NEW.signed_at)
        IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.student_profile_id,OLD.activation,OLD.form_id,OLD.form_digest,OLD.signer_kind,OLD.signer_name,
          OLD.method,OLD.signer_principal_id,OLD.witnessed_by_principal_id,OLD.signed_at) THEN
      RAISE EXCEPTION 'FACE_CHECKIN_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='face_checkin_matches' THEN
    IF OLD.outcome<>'PROPOSED' OR NEW.outcome NOT IN ('CONFIRMED','REJECTED','EXPIRED')
      OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.class_session_id,NEW.student_profile_id,NEW.proposed_by_principal_id,NEW.proposed_at)
        IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.class_session_id,OLD.student_profile_id,OLD.proposed_by_principal_id,OLD.proposed_at) THEN
      RAISE EXCEPTION 'FACE_CHECKIN_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='face_templates' THEN
    IF (NEW.student_profile_id,NEW.organization_id,NEW.school_id,NEW.consent_id,NEW.activation,NEW.photo_checksum,NEW.template,NEW.matcher,NEW.enrolled_by_principal_id,NEW.enrolled_at)
      IS DISTINCT FROM (OLD.student_profile_id,OLD.organization_id,OLD.school_id,OLD.consent_id,OLD.activation,OLD.photo_checksum,OLD.template,OLD.matcher,OLD.enrolled_by_principal_id,OLD.enrolled_at) THEN
      RAISE EXCEPTION 'FACE_CHECKIN_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  -- face_checkin_requests
  IF OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL
    OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.operation,NEW.fingerprint,NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.operation,OLD.fingerprint,OLD.created_at) THEN
    RAISE EXCEPTION 'FACE_CHECKIN_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['face_checkin_program','face_checkin_form_parts','face_checkin_forms','face_checkin_settings','face_checkin_consents',
      'face_templates','face_template_deletions','face_checkin_matches','face_checkin_requests'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_face_checkin()',t||'_guard',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_face_checkin()',t||'_no_truncate',t);
  END LOOP;
END $$;

-- ---------- helpers (migration owner only) ----------
CREATE FUNCTION hon.face_checkin_open() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$ SELECT coalesce((SELECT status='TEST_MODE' FROM hon.face_checkin_program),false) $$;

-- Today's date in the school's own time zone, so an 18th birthday never depends on the database session TimeZone.
CREATE FUNCTION hon.face_checkin_today(p_org uuid,p_school uuid) RETURNS date
LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $$
  SELECT (clock_timestamp() AT TIME ZONE coalesce((SELECT timezone FROM hon.schools WHERE id=p_school AND organization_id=p_org),'UTC'))::date
$$;

-- Staff authority for face check-in management: the direct human of this request, one active human principal, active
-- organization and school, paid access, face_checkin.manage at this exact school through a staff role, no family access
-- at the school. Read-only.
CREATE FUNCTION hon.face_checkin_staff_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR p_subject IS NULL OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN
    RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
  WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true) AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1;
  IF actor IS NULL
    OR NOT EXISTS(SELECT 1 FROM hon.organizations WHERE id=org AND status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
      WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code='face_checkin.manage'
        AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school))
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor AND organization_id=org AND school_id=school
      AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()))
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND status='ACTIVE' AND tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- The one live family grant of the signed-in parent (same rules as 0329): it must match the tenant, principal and source
-- the API set; guardian=true also needs PRIMARY_GUARDIAN or SECONDARY_GUARDIAN.
CREATE FUNCTION hon.face_checkin_family_scope(p_subject text,p_guardian boolean)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid,family_id uuid,access_level text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; r record;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO n FROM (SELECT DISTINCT g.school_id,g.family_id FROM hon.users u
    JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    JOIN hon.family_access_grants g ON g.principal_id=p.id
    WHERE u.external_subject=p_subject AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) x;
  IF n<>1 THEN RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id pid,g.organization_id org,g.school_id school,g.family_id fam,g.access_level::text lvl INTO r FROM hon.users u
    JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    JOIN hon.family_access_grants g ON g.principal_id=p.id
  WHERE u.external_subject=p_subject AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
  ORDER BY CASE g.access_level WHEN 'PRIMARY_GUARDIAN' THEN 3 WHEN 'SECONDARY_GUARDIAN' THEN 2 ELSE 1 END DESC,g.effective_from DESC LIMIT 1;
  IF r.pid IS NULL OR r.pid::text IS DISTINCT FROM current_setting('app.hon_principal_id',true)
    OR r.org IS DISTINCT FROM hon.current_organization_id() OR r.school IS DISTINCT FROM hon.current_school_id()
    OR NOT EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=r.org AND o.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=r.school AND s.organization_id=r.org AND s.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=r.org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    OR (p_guardian AND r.lvl NOT IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN')) THEN
    RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT r.pid,r.org,r.school,r.fam,r.lvl;
END $$;

-- A child of the exact family (STUDENT member whose primary family it is) at the current school.
CREATE FUNCTION hon.face_checkin_child_ok(p_family uuid,p_child uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.student_profiles sp JOIN hon.family_members m ON m.person_id=sp.person_id
    AND m.organization_id=sp.organization_id AND m.school_id=sp.school_id AND m.family_id=p_family AND m.member_role='STUDENT'
    WHERE sp.id=p_child AND sp.primary_family_id=p_family AND sp.organization_id=hon.current_organization_id() AND sp.school_id=hon.current_school_id());
$$;

-- What the school must confirm before turning face check-in on under a profile (sorted).
CREATE FUNCTION hon.face_checkin_required_acks(p_profile text) RETURNS text[]
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT array_agg(x ORDER BY x) FROM (SELECT 'ALTERNATIVE_CHECK_IN_OFFERED' x UNION ALL SELECT 'RETENTION_POLICY_PUBLISHED'
    UNION ALL SELECT 'ENTRANCE_SIGN_POSTED' WHERE EXISTS(SELECT 1 FROM hon.biometric_jurisdiction_profiles WHERE code=p_profile AND 'ENTRANCE_SIGN'=ANY(add_ons))
    UNION ALL SELECT 'IMPACT_ASSESSMENT_DONE' WHERE EXISTS(SELECT 1 FROM hon.biometric_jurisdiction_profiles WHERE code=p_profile AND 'IMPACT_ASSESSMENT'=ANY(add_ons))) a
$$;

-- City-limits choices for the school's address: each city in its state with its own rule (e.g. Portland OR, New York
-- City) and 'NONE'. Empty when the state has none. The profile the address text already names, if any, is the only answer.
CREATE FUNCTION hon.face_checkin_choices(p_org uuid,p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  WITH l AS (SELECT * FROM hon.school_locations WHERE school_id=p_school AND organization_id=p_org),
  named AS (SELECT r.profile_code FROM hon.biometric_jurisdiction_rules r, l
    WHERE r.country_code=l.country_code AND r.region_code=l.region_code AND r.locality=hon.biometric_locality(l.city) LIMIT 1),
  cities AS (SELECT DISTINCT r.profile_code FROM hon.biometric_jurisdiction_rules r, l
    WHERE r.country_code=l.country_code AND r.region_code=l.region_code AND r.locality IS NOT NULL),
  answers AS (
    SELECT NULL::text answer,(SELECT hon.biometric_profile_for(l.country_code,l.region_code,l.city) FROM l) profile WHERE NOT EXISTS(SELECT 1 FROM cities)
    UNION ALL SELECT c.profile_code,c.profile_code FROM cities c WHERE NOT EXISTS(SELECT 1 FROM named) OR c.profile_code=(SELECT profile_code FROM named)
    UNION ALL SELECT 'NONE',(SELECT hon.biometric_profile_for(l.country_code,l.region_code,NULL) FROM l) WHERE EXISTS(SELECT 1 FROM cities) AND NOT EXISTS(SELECT 1 FROM named))
  -- Owner decision 2026-11-16: HON OS launches in the United States only, so face check-in cannot be turned on elsewhere
  -- yet (NOT_LAUNCHED). The other countries' draft forms stay, unused, for later.
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM l) THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('cityLimits',a.answer,'profile',a.profile,
      'status',CASE WHEN (SELECT country_code FROM l)<>'US' THEN 'NOT_LAUNCHED' ELSE p.status END,'acknowledgements',to_jsonb(hon.face_checkin_required_acks(a.profile))) ORDER BY a.answer NULLS FIRST)
    FROM answers a JOIN hon.biometric_jurisdiction_profiles p ON p.code=a.profile),'[]'::jsonb) END
$$;

-- Delete one template outright and keep an identifier-only record.
CREATE FUNCTION hon.face_checkin_delete_template(p_student uuid,p_reason text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE t hon.face_templates%ROWTYPE;
BEGIN
  DELETE FROM hon.face_templates WHERE student_profile_id=p_student RETURNING * INTO t;
  IF t.student_profile_id IS NULL THEN RETURN 0; END IF;
  INSERT INTO hon.face_template_deletions(organization_id,school_id,student_profile_id,reason,enrolled_at)
    VALUES(t.organization_id,t.school_id,t.student_profile_id,p_reason,t.enrolled_at);
  RETURN 1;
END $$;

-- Retention for one school: every template whose time is up is deleted (earliest reason first).
CREATE FUNCTION hon.face_checkin_sweep(p_org uuid,p_school uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r record; n integer:=0; st hon.face_checkin_settings%ROWTYPE;
BEGIN
  SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=p_school AND organization_id=p_org;
  FOR r IN SELECT t.student_profile_id,
      CASE WHEN st.status IS DISTINCT FROM 'ON' OR st.activation<>t.activation THEN 'SCHOOL_TURNED_OFF'
        WHEN c.status IS DISTINCT FROM 'GIVEN' THEN 'CONSENT_WITHDRAWN'
        WHEN c.activation<>t.activation OR f.profile_code IS DISTINCT FROM st.profile_code THEN 'CONSENT_NOT_CURRENT'
        WHEN ph.checksum IS DISTINCT FROM t.photo_checksum THEN 'PHOTO_CHANGED'
        WHEN sp.status<>'ACTIVE' AND sp.updated_at<=clock_timestamp()-interval '30 days' THEN 'NOT_ACTIVE_30_DAYS'
        WHEN coalesce(t.last_matched_at,t.enrolled_at)<=clock_timestamp()-interval '12 months' THEN 'NO_CHECK_IN_12_MONTHS' END reason
    FROM hon.face_templates t JOIN hon.student_profiles sp ON sp.id=t.student_profile_id
    LEFT JOIN hon.face_checkin_consents c ON c.id=t.consent_id LEFT JOIN hon.face_checkin_forms f ON f.id=c.form_id
    LEFT JOIN hon.person_photos ph ON ph.person_id=sp.person_id AND ph.organization_id=sp.organization_id AND ph.school_id=sp.school_id
    WHERE t.organization_id=p_org AND t.school_id=p_school ORDER BY t.student_profile_id LOOP
    IF r.reason IS NOT NULL THEN n:=n+hon.face_checkin_delete_template(r.student_profile_id,r.reason); END IF;
  END LOOP;
  RETURN n;
END $$;

-- Daily retention job for every school (deployment requirement; never granted to the app).
CREATE FUNCTION hon.purge_face_checkin_retention() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r record; n integer:=0;
BEGIN
  FOR r IN SELECT DISTINCT organization_id,school_id FROM hon.face_templates ORDER BY 1,2 LOOP
    n:=n+hon.face_checkin_sweep(r.organization_id,r.school_id);
  END LOOP;
  RETURN n;
END $$;

-- A consent counts only while GIVEN, signed under the school's current activation and current profile.
CREATE FUNCTION hon.face_checkin_consent_state(st hon.face_checkin_settings,c hon.face_checkin_consents) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN c.id IS NULL THEN 'NONE' WHEN c.status='WITHDRAWN' THEN 'WITHDRAWN'
    WHEN st.status='ON' AND c.activation=st.activation AND (SELECT profile_code FROM hon.face_checkin_forms WHERE id=c.form_id)=st.profile_code THEN 'GIVEN'
    ELSE 'RENEW' END
$$;

CREATE FUNCTION hon.face_checkin_settings_json(p_org uuid,p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('status',coalesce(s.status,'OFF'),'profile',s.profile_code,'cityLimits',s.city_limits,
    'acknowledgements',to_jsonb(coalesce(s.acknowledgements,'{}')),'offReason',s.off_reason,'version',coalesce(s.version,0),
    'updatedAt',hon.saas_ts(s.updated_at))
  FROM (SELECT 1) one LEFT JOIN hon.face_checkin_settings s ON s.school_id=p_school AND s.organization_id=p_org
$$;

CREATE FUNCTION hon.face_checkin_consent_json(st hon.face_checkin_settings,c hon.face_checkin_consents) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('consentId',c.id,'state',hon.face_checkin_consent_state(st,c),'formId',c.form_id,
    'signerKind',c.signer_kind,'method',c.method,'version',c.version,'signedAt',hon.saas_ts(c.signed_at),'withdrawnAt',hon.saas_ts(c.withdrawn_at)) END
$$;

-- Forms the school's current profile uses (all three languages); empty while off.
CREATE FUNCTION hon.face_checkin_forms_json(p_profile text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('formId',f.id,'profile',f.profile_code,'language',f.language,'version',f.version,'title',f.title,
    'body',f.body,'digest',f.digest,'reviewStatus',f.review_status) ORDER BY f.language),'[]'::jsonb)
  FROM hon.face_checkin_forms f WHERE f.profile_code=p_profile
$$;

-- Receipt (exact replay while authority is current). The caller has already decided authority. NULL means reserved now.
CREATE FUNCTION hon.face_checkin_begin(p_actor uuid,p_operation text,p_scope jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; prior hon.face_checkin_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'FACE_CHECKIN_INVALID' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_scope)::text,'UTF8')),'hex');
  INSERT INTO hon.face_checkin_requests(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(org,school,p_actor,p_key,p_operation,fp) ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.face_checkin_requests WHERE organization_id=org AND school_id=school AND principal_id=p_actor AND idempotency_key=p_key FOR UPDATE;
  IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.response IS NULL THEN RAISE EXCEPTION 'FACE_CHECKIN_BUSY' USING ERRCODE='55P03'; END IF;
  RETURN prior.response;
END $$;

-- Identifier-only audit and inert outbox, receipt completion.
CREATE FUNCTION hon.face_checkin_finish(p_actor uuid,p_operation text,p_entity_type text,p_entity uuid,p_payload jsonb,p_key text,
  p_request uuid,p_correlation uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); payload jsonb:=p_payload||jsonb_build_object('internalOnly',true);
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,p_actor,'HUMAN_UI','face_checkin.'||p_operation,p_entity_type,p_entity,payload,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'face_checkin.'||p_operation,1,p_entity_type,p_entity,coalesce((payload->>'version')::integer,1),p_correlation,p_request,payload);
  UPDATE hon.face_checkin_requests SET response=p_result,completed_at=clock_timestamp()
    WHERE organization_id=org AND school_id=school AND principal_id=p_actor AND idempotency_key=p_key;
  RETURN jsonb_build_object('record',p_result,'replayed',false);
END $$;

CREATE FUNCTION hon.face_checkin_uuid_ok(p jsonb,k text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(p->k)='string' AND p->>k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
CREATE FUNCTION hon.face_checkin_keys_ok(p jsonb,keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p)='object' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS NOT DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(keys) k)
$$;

-- ---------- triggers on 0390 photos and 0392 locations ----------
-- A removed or replaced photo deletes the template at once (re-enroll from the new photo).
CREATE FUNCTION hon.face_checkin_photo_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r record;
BEGIN
  IF TG_OP='UPDATE' AND NEW.checksum=OLD.checksum THEN RETURN NULL; END IF;
  FOR r IN SELECT t.student_profile_id FROM hon.face_templates t JOIN hon.student_profiles sp ON sp.id=t.student_profile_id
    WHERE sp.person_id=OLD.person_id AND sp.organization_id=OLD.organization_id AND sp.school_id=OLD.school_id ORDER BY 1 LOOP
    PERFORM hon.face_checkin_delete_template(r.student_profile_id,'PHOTO_CHANGED');
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER face_checkin_photo_changed AFTER UPDATE OR DELETE ON hon.person_photos FOR EACH ROW EXECUTE FUNCTION hon.face_checkin_photo_changed();

-- A changed school address turns face check-in off and deletes every template; the owner turns it on again (and answers
-- the city-limits question) under the profile of the new address. Consents must then be signed again.
CREATE FUNCTION hon.face_checkin_location_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r record;
BEGIN
  IF (NEW.country_code,NEW.region_code,NEW.city,NEW.postal_code,NEW.address_line1,NEW.address_line2)
    IS NOT DISTINCT FROM (OLD.country_code,OLD.region_code,OLD.city,OLD.postal_code,OLD.address_line1,OLD.address_line2) THEN RETURN NULL; END IF;
  UPDATE hon.face_checkin_settings SET status='OFF',profile_code=NULL,city_limits=NULL,acknowledgements='{}',off_reason='LOCATION_CHANGED',
    version=version+1,updated_by_principal_id=NEW.updated_by_principal_id,updated_at=clock_timestamp()
    WHERE school_id=NEW.school_id AND organization_id=NEW.organization_id AND status='ON';
  FOR r IN SELECT student_profile_id FROM hon.face_templates WHERE school_id=NEW.school_id AND organization_id=NEW.organization_id ORDER BY 1 LOOP
    PERFORM hon.face_checkin_delete_template(r.student_profile_id,'LOCATION_CHANGED');
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER face_checkin_location_changed AFTER UPDATE ON hon.school_locations FOR EACH ROW EXECUTE FUNCTION hon.face_checkin_location_changed();

-- ---------- staff entry points ----------
-- Read: program, address notice, the city-limits choices, settings, the current forms, students (at most 500, by name)
-- with consent and enrollment, and template deletions in the last 30 days. Runs the retention sweep first.
CREATE FUNCTION hon.read_face_checkin(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); st hon.face_checkin_settings%ROWTYPE; l hon.school_locations%ROWTYPE; result jsonb;
BEGIN
  PERFORM hon.face_checkin_staff_actor(p_subject);
  PERFORM hon.face_checkin_sweep(org,school);
  SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=school AND organization_id=org;
  SELECT * INTO l FROM hon.school_locations WHERE school_id=school AND organization_id=org;
  SELECT jsonb_build_object('program',(SELECT status FROM hon.face_checkin_program),'matcher','SYNTHETIC',
    'addressNotice',hon.biometric_notice_json(CASE WHEN l.school_id IS NULL THEN NULL ELSE hon.biometric_profile_for(l.country_code,l.region_code,l.city) END),
    'choices',hon.face_checkin_choices(org,school),'settings',hon.face_checkin_settings_json(org,school),
    'forms',CASE WHEN st.status='ON' THEN hon.face_checkin_forms_json(st.profile_code) ELSE '[]'::jsonb END,
    'deletionsLast30Days',(SELECT count(*) FROM hon.face_template_deletions WHERE organization_id=org AND school_id=school AND deleted_at>clock_timestamp()-interval '30 days'),
    'students',coalesce(jsonb_agg(jsonb_build_object('studentProfileId',x.id,'givenName',x.given_name,'familyName',x.family_name,'studentStatus',x.status,
      'adult',x.adult,'hasPhoto',x.has_photo,'consent',hon.face_checkin_consent_json(st,x.consent),'enrolled',x.enrolled,'enrolledAt',x.enrolled_at)
      ORDER BY x.family_name,x.given_name,x.id),'[]'::jsonb)) INTO result
  FROM (SELECT sp.id,p.given_name,p.family_name,sp.status::text status,
      coalesce(sp.birth_date<=(hon.face_checkin_today(org,school)-interval '18 years')::date,false) adult,
      EXISTS(SELECT 1 FROM hon.person_photos ph WHERE ph.person_id=sp.person_id AND ph.organization_id=org AND ph.school_id=school) has_photo,
      (SELECT c FROM hon.face_checkin_consents c WHERE c.student_profile_id=sp.id AND c.organization_id=org AND c.school_id=school ORDER BY c.signed_at DESC,c.id LIMIT 1) consent,
      EXISTS(SELECT 1 FROM hon.face_templates t WHERE t.student_profile_id=sp.id AND t.organization_id=org AND t.school_id=school) enrolled,
      (SELECT hon.saas_ts(t.enrolled_at) FROM hon.face_templates t WHERE t.student_profile_id=sp.id AND t.organization_id=org AND t.school_id=school) enrolled_at
    FROM hon.student_profiles sp JOIN hon.people p ON p.id=sp.person_id AND p.organization_id=sp.organization_id AND p.school_id=sp.school_id
    WHERE sp.organization_id=org AND sp.school_id=school ORDER BY p.family_name,p.given_name,sp.id LIMIT 500) x;
  RETURN result;
END $$;

-- Input: {expectedVersion, enabled, cityLimits, acknowledgements}. On: program open, an address, the city-limits answer
-- that is one of the choices, a profile that is AVAILABLE_WITH_CONSENT, and exactly its acknowledgements; starts a new
-- activation. Off (cityLimits null, acknowledgements []): always allowed; deletes every template of the school.
CREATE FUNCTION hon.save_face_checkin_settings(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; cur hon.face_checkin_settings%ROWTYPE;
  nxt hon.face_checkin_settings%ROWTYPE; enabled boolean; answer text; choice jsonb; acks text[]; r record; removed integer:=0;
BEGIN
  actor:=hon.face_checkin_staff_actor(p_subject);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['acknowledgements','cityLimits','enabled','expectedVersion'])
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$'
    OR jsonb_typeof(p_input->'enabled') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_input->'cityLimits') NOT IN ('null','string') OR (jsonb_typeof(p_input->'cityLimits')='string' AND p_input->>'cityLimits' !~ '^[A-Z_]{2,40}$')
    OR jsonb_typeof(p_input->'acknowledgements') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'acknowledgements')>8
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'acknowledgements') a WHERE jsonb_typeof(a)<>'string' OR a#>>'{}' !~ '^[A-Z_]{2,40}$') THEN
    RAISE EXCEPTION 'FACE_CHECKIN_INVALID' USING ERRCODE='22023'; END IF;
  replay:=hon.face_checkin_begin(actor,'settings',p_input,p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  enabled:=(p_input->>'enabled')::boolean; answer:=p_input->>'cityLimits';
  SELECT array_agg(a ORDER BY a) INTO acks FROM jsonb_array_elements_text(p_input->'acknowledgements') a;
  PERFORM pg_advisory_xact_lock(hashtextextended('face-checkin:'||school::text,0));
  PERFORM 1 FROM hon.school_locations WHERE school_id=school AND organization_id=org FOR SHARE;
  SELECT * INTO cur FROM hon.face_checkin_settings WHERE school_id=school AND organization_id=org FOR UPDATE;
  IF coalesce(cur.version,0)<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF enabled THEN
    IF coalesce(cur.status,'OFF')='ON' THEN RAISE EXCEPTION 'FACE_CHECKIN_ALREADY_ON' USING ERRCODE='40001'; END IF;
    IF NOT hon.face_checkin_open() THEN RAISE EXCEPTION 'FACE_CHECKIN_CLOSED' USING ERRCODE='42501'; END IF;
    IF NOT EXISTS(SELECT 1 FROM hon.school_locations WHERE school_id=school AND organization_id=org) THEN
      RAISE EXCEPTION 'FACE_CHECKIN_LOCATION_REQUIRED' USING ERRCODE='22023'; END IF;
    SELECT c.value INTO choice FROM jsonb_array_elements(hon.face_checkin_choices(org,school)) c WHERE c.value->>'cityLimits' IS NOT DISTINCT FROM answer;
    IF choice IS NULL THEN RAISE EXCEPTION 'FACE_CHECKIN_CITY_LIMITS_REQUIRED' USING ERRCODE='22023'; END IF;
    IF choice->>'status'<>'AVAILABLE_WITH_CONSENT' THEN RAISE EXCEPTION 'FACE_CHECKIN_NOT_AVAILABLE' USING ERRCODE='42501'; END IF;
    IF coalesce(acks,'{}') IS DISTINCT FROM hon.face_checkin_required_acks(choice->>'profile') THEN
      RAISE EXCEPTION 'FACE_CHECKIN_ACKNOWLEDGEMENTS_REQUIRED' USING ERRCODE='22023'; END IF;
    IF cur.school_id IS NULL THEN
      INSERT INTO hon.face_checkin_settings(school_id,organization_id,status,profile_code,city_limits,acknowledgements,activation,updated_by_principal_id)
        VALUES(school,org,'ON',choice->>'profile',answer,acks,1,actor) RETURNING * INTO nxt;
    ELSE
      UPDATE hon.face_checkin_settings SET status='ON',profile_code=choice->>'profile',city_limits=answer,acknowledgements=acks,activation=activation+1,
        off_reason=NULL,version=version+1,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE school_id=school RETURNING * INTO nxt;
    END IF;
  ELSE
    IF answer IS NOT NULL OR acks IS NOT NULL THEN RAISE EXCEPTION 'FACE_CHECKIN_INVALID' USING ERRCODE='22023'; END IF;
    IF coalesce(cur.status,'OFF')<>'ON' THEN RAISE EXCEPTION 'FACE_CHECKIN_ALREADY_OFF' USING ERRCODE='40001'; END IF;
    UPDATE hon.face_checkin_settings SET status='OFF',profile_code=NULL,city_limits=NULL,acknowledgements='{}',off_reason='OWNER',
      version=version+1,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE school_id=school RETURNING * INTO nxt;
    FOR r IN SELECT student_profile_id FROM hon.face_templates WHERE school_id=school AND organization_id=org ORDER BY 1 LOOP
      removed:=removed+hon.face_checkin_delete_template(r.student_profile_id,'SCHOOL_TURNED_OFF');
    END LOOP;
  END IF;
  replay:=hon.face_checkin_finish(actor,'settings','FACE_CHECKIN_SETTINGS',school,
    jsonb_build_object('status',nxt.status,'profile',nxt.profile_code,'version',nxt.version,'templatesDeleted',removed),p_key,p_request,p_correlation,
    hon.face_checkin_settings_json(org,school)||jsonb_build_object('templatesDeleted',removed));
  IF hon.face_checkin_staff_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- Shared consent write. The form must be one of the school's current profile and its digest must match what was shown.
-- A stale GIVEN consent (earlier activation or profile) is withdrawn by the new signature.
CREATE FUNCTION hon.face_checkin_write_consent(p_actor uuid,p_student uuid,p_input jsonb,p_method text,p_signer_kind text) RETURNS hon.face_checkin_consents
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); st hon.face_checkin_settings%ROWTYPE; f hon.face_checkin_forms%ROWTYPE;
  cur hon.face_checkin_consents%ROWTYPE; nxt hon.face_checkin_consents%ROWTYPE; birth date;
BEGIN
  IF NOT hon.face_checkin_open() THEN RAISE EXCEPTION 'FACE_CHECKIN_CLOSED' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('face-checkin:'||school::text,0));
  PERFORM 1 FROM hon.school_locations WHERE school_id=school AND organization_id=org FOR SHARE;
  SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=school AND organization_id=org;
  IF st.status IS DISTINCT FROM 'ON' THEN RAISE EXCEPTION 'FACE_CHECKIN_OFF' USING ERRCODE='42501'; END IF;
  SELECT birth_date INTO birth FROM hon.student_profiles WHERE id=p_student AND organization_id=org AND school_id=school FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FACE_CHECKIN_STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- Under 18, or no birth date on file: only a parent or guardian signs. 18 or older: only the student signs.
  IF p_signer_kind='ADULT_STUDENT' AND (birth IS NULL OR birth>(hon.face_checkin_today(org,school)-interval '18 years')::date) THEN
    RAISE EXCEPTION 'FACE_CHECKIN_GUARDIAN_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_signer_kind='GUARDIAN' AND birth IS NOT NULL AND birth<=(hon.face_checkin_today(org,school)-interval '18 years')::date THEN
    RAISE EXCEPTION 'FACE_CHECKIN_ADULT_SIGNS' USING ERRCODE='22023'; END IF;
  SELECT * INTO f FROM hon.face_checkin_forms WHERE id=(p_input->>'formId')::smallint;
  IF f.id IS NULL OR f.profile_code<>st.profile_code OR f.digest<>p_input->>'formDigest' THEN RAISE EXCEPTION 'FACE_CHECKIN_FORM_CHANGED' USING ERRCODE='40001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('face-checkin-student:'||p_student::text,0));
  SELECT * INTO cur FROM hon.face_checkin_consents WHERE student_profile_id=p_student AND status='GIVEN' FOR UPDATE;
  IF cur.id IS NOT NULL THEN
    IF hon.face_checkin_consent_state(st,cur)='GIVEN' THEN RAISE EXCEPTION 'FACE_CHECKIN_CONSENT_EXISTS' USING ERRCODE='40001'; END IF;
    UPDATE hon.face_checkin_consents SET status='WITHDRAWN',version=version+1,withdrawn_at=clock_timestamp(),withdrawn_by_principal_id=p_actor WHERE id=cur.id;
    PERFORM hon.face_checkin_delete_template(p_student,'CONSENT_NOT_CURRENT');
  END IF;
  INSERT INTO hon.face_checkin_consents(organization_id,school_id,student_profile_id,activation,form_id,form_digest,signer_kind,signer_name,method,
      signer_principal_id,witnessed_by_principal_id)
    VALUES(org,school,p_student,st.activation,f.id,f.digest,p_signer_kind,p_input->>'signerName',p_method,
      CASE WHEN p_method='PARENT_PORTAL' THEN p_actor END,CASE WHEN p_method='IN_PERSON' THEN p_actor END) RETURNING * INTO nxt;
  RETURN nxt;
END $$;

CREATE FUNCTION hon.face_checkin_name_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(p->'signerName')='string' AND length(p->>'signerName') BETWEEN 2 AND 200 AND btrim(p->>'signerName')=p->>'signerName'
    AND p->>'signerName' !~ '[<>[:cntrl:]]' AND jsonb_typeof(p->'formId')='number' AND p->>'formId' ~ '^[1-9][0-9]{0,3}$'
    AND jsonb_typeof(p->'formDigest')='string' AND p->>'formDigest' ~ '^[a-f0-9]{64}$'
$$;

-- Staff record a consent signed in person. Input: {studentProfileId, formId, formDigest, signerKind GUARDIAN|ADULT_STUDENT,
-- signerName, witnessAttested true}: the staff member attests they saw the signer and checked who they are.
CREATE FUNCTION hon.record_face_checkin_consent(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; c hon.face_checkin_consents%ROWTYPE; st hon.face_checkin_settings%ROWTYPE;
BEGIN
  actor:=hon.face_checkin_staff_actor(p_subject);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['formDigest','formId','signerKind','signerName','studentProfileId','witnessAttested'])
    OR NOT hon.face_checkin_uuid_ok(p_input,'studentProfileId') OR NOT hon.face_checkin_name_ok(p_input)
    OR jsonb_typeof(p_input->'signerKind') IS DISTINCT FROM 'string' OR p_input->>'signerKind' NOT IN ('GUARDIAN','ADULT_STUDENT')
    OR p_input->'witnessAttested' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FACE_CHECKIN_INVALID' USING ERRCODE='22023'; END IF;
  replay:=hon.face_checkin_begin(actor,'consent',p_input,p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  c:=hon.face_checkin_write_consent(actor,(p_input->>'studentProfileId')::uuid,p_input,'IN_PERSON',p_input->>'signerKind');
  SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=school AND organization_id=org;
  replay:=hon.face_checkin_finish(actor,'consent','FACE_CHECKIN_CONSENT',c.id,
    jsonb_build_object('consentId',c.id,'studentProfileId',c.student_profile_id,'method',c.method,'formId',c.form_id,'version',c.version),
    p_key,p_request,p_correlation,jsonb_build_object('studentProfileId',c.student_profile_id,'consent',hon.face_checkin_consent_json(st,c)));
  IF hon.face_checkin_staff_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- Shared withdrawal: the GIVEN consent at its exact version becomes WITHDRAWN and the template is deleted at once.
-- Allowed whatever the program or school switch says.
CREATE FUNCTION hon.face_checkin_withdraw(p_actor uuid,p_input jsonb,p_family uuid) RETURNS hon.face_checkin_consents
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); c hon.face_checkin_consents%ROWTYPE;
BEGIN
  SELECT * INTO c FROM hon.face_checkin_consents WHERE id=(p_input->>'consentId')::uuid AND organization_id=org AND school_id=school;
  IF c.id IS NULL OR (p_family IS NOT NULL AND NOT hon.face_checkin_child_ok(p_family,c.student_profile_id)) THEN
    RAISE EXCEPTION 'FACE_CHECKIN_CONSENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('face-checkin-student:'||c.student_profile_id::text,0));
  SELECT * INTO c FROM hon.face_checkin_consents WHERE id=c.id FOR UPDATE;
  IF c.status<>'GIVEN' OR c.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  UPDATE hon.face_checkin_consents SET status='WITHDRAWN',version=version+1,withdrawn_at=clock_timestamp(),withdrawn_by_principal_id=p_actor
    WHERE id=c.id RETURNING * INTO c;
  PERFORM hon.face_checkin_delete_template(c.student_profile_id,'CONSENT_WITHDRAWN');
  RETURN c;
END $$;

-- Staff withdraw a consent on the signer's request. Input: {consentId, expectedVersion}.
CREATE FUNCTION hon.withdraw_face_checkin_consent(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; c hon.face_checkin_consents%ROWTYPE; st hon.face_checkin_settings%ROWTYPE;
BEGIN
  actor:=hon.face_checkin_staff_actor(p_subject);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['consentId','expectedVersion']) OR NOT hon.face_checkin_uuid_ok(p_input,'consentId')
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'FACE_CHECKIN_INVALID' USING ERRCODE='22023'; END IF;
  replay:=hon.face_checkin_begin(actor,'withdraw',p_input,p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  c:=hon.face_checkin_withdraw(actor,p_input,NULL);
  SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=school AND organization_id=org;
  replay:=hon.face_checkin_finish(actor,'withdraw','FACE_CHECKIN_CONSENT',c.id,
    jsonb_build_object('consentId',c.id,'studentProfileId',c.student_profile_id,'version',c.version),
    p_key,p_request,p_correlation,jsonb_build_object('studentProfileId',c.student_profile_id,'consent',hon.face_checkin_consent_json(st,c)));
  IF hon.face_checkin_staff_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- Enroll one student from the current profile photo. Input: {studentProfileId}. Needs the program open, the school ON, a
-- current consent, an ACTIVE student and a photo. A current template from the same photo is kept (ALREADY_ENROLLED).
CREATE FUNCTION hon.enroll_face_checkin_student(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; student uuid; st hon.face_checkin_settings%ROWTYPE;
  c hon.face_checkin_consents%ROWTYPE; sp hon.student_profiles%ROWTYPE; ph hon.person_photos%ROWTYPE; t hon.face_templates%ROWTYPE; outcome text:='ENROLLED';
BEGIN
  actor:=hon.face_checkin_staff_actor(p_subject);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['studentProfileId']) OR NOT hon.face_checkin_uuid_ok(p_input,'studentProfileId') THEN
    RAISE EXCEPTION 'FACE_CHECKIN_INVALID' USING ERRCODE='22023'; END IF;
  replay:=hon.face_checkin_begin(actor,'enroll',p_input,p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  IF NOT hon.face_checkin_open() THEN RAISE EXCEPTION 'FACE_CHECKIN_CLOSED' USING ERRCODE='42501'; END IF;
  student:=(p_input->>'studentProfileId')::uuid;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('face-checkin:'||school::text,0));
  PERFORM 1 FROM hon.school_locations WHERE school_id=school AND organization_id=org FOR SHARE;
  SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=school AND organization_id=org;
  IF st.status IS DISTINCT FROM 'ON' THEN RAISE EXCEPTION 'FACE_CHECKIN_OFF' USING ERRCODE='42501'; END IF;
  SELECT * INTO sp FROM hon.student_profiles WHERE id=student AND organization_id=org AND school_id=school FOR KEY SHARE;
  IF sp.id IS NULL THEN RAISE EXCEPTION 'FACE_CHECKIN_STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF sp.status<>'ACTIVE' THEN RAISE EXCEPTION 'FACE_CHECKIN_STUDENT_NOT_ACTIVE' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('face-checkin-student:'||student::text,0));
  SELECT * INTO c FROM hon.face_checkin_consents WHERE student_profile_id=student AND status='GIVEN' FOR SHARE;
  IF c.id IS NULL OR hon.face_checkin_consent_state(st,c)<>'GIVEN' THEN RAISE EXCEPTION 'FACE_CHECKIN_CONSENT_REQUIRED' USING ERRCODE='42501'; END IF;
  SELECT * INTO ph FROM hon.person_photos WHERE person_id=sp.person_id AND organization_id=org AND school_id=school FOR SHARE;
  IF ph.person_id IS NULL THEN RAISE EXCEPTION 'FACE_CHECKIN_PHOTO_REQUIRED' USING ERRCODE='22023'; END IF;
  SELECT * INTO t FROM hon.face_templates WHERE student_profile_id=student FOR UPDATE;
  IF t.student_profile_id IS NOT NULL AND t.photo_checksum=ph.checksum AND t.consent_id=c.id AND t.activation=st.activation THEN
    outcome:='ALREADY_ENROLLED';
  ELSE
    IF t.student_profile_id IS NOT NULL THEN PERFORM hon.face_checkin_delete_template(student,'CONSENT_NOT_CURRENT'); END IF;
    BEGIN
      INSERT INTO hon.face_templates(student_profile_id,organization_id,school_id,consent_id,activation,photo_checksum,template,matcher,enrolled_by_principal_id)
        VALUES(student,org,school,c.id,st.activation,ph.checksum,decode(ph.checksum,'hex'),'SYNTHETIC',actor) RETURNING * INTO t;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'FACE_TEMPLATE_DUPLICATE' USING ERRCODE='23505';
    END;
  END IF;
  replay:=hon.face_checkin_finish(actor,'enroll','FACE_TEMPLATE',student,jsonb_build_object('studentProfileId',student,'outcome',outcome,'version',1),
    p_key,p_request,p_correlation,jsonb_build_object('studentProfileId',student,'outcome',outcome,'enrolledAt',hon.saas_ts(t.enrolled_at),'matcher','SYNTHETIC'));
  IF hon.face_checkin_staff_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- One camera picture for a class session. Input: {pictureDigest} = SHA-256 of the metadata-stripped picture, made by the
-- API (which discards the picture). Live attendance.record authority comes first, then the retention sweep. At most one
-- enrolled, currently consented, ACTIVE student is proposed; staff then confirm or reject. Neither the picture nor the
-- digest is stored.
CREATE FUNCTION hon.match_face_checkin(p_subject text,p_session uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; st hon.face_checkin_settings%ROWTYPE;
  student uuid; m hon.face_checkin_matches%ROWTYPE; who jsonb;
BEGIN
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['pictureDigest']) OR jsonb_typeof(p_input->'pictureDigest') IS DISTINCT FROM 'string'
    OR p_input->>'pictureDigest' !~ '^[a-f0-9]{64}$' OR p_session IS NULL THEN RAISE EXCEPTION 'FACE_CHECKIN_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.lock_attendance_actor(p_subject,'attendance.record');
  -- The receipt fingerprint covers the session and a hash of the digest: the same key with another picture is a reused key.
  replay:=hon.face_checkin_begin(actor,'match',jsonb_build_object('session',p_session,'picture',encode(sha256(decode(p_input->>'pictureDigest','hex')),'hex')),
    p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  IF NOT hon.face_checkin_open() THEN RAISE EXCEPTION 'FACE_CHECKIN_CLOSED' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM hon.class_sessions WHERE id=p_session AND organization_id=org AND school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('face-checkin:'||school::text,0));
  PERFORM 1 FROM hon.school_locations WHERE school_id=school AND organization_id=org FOR SHARE;
  SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=school AND organization_id=org;
  IF st.status IS DISTINCT FROM 'ON' THEN RAISE EXCEPTION 'FACE_CHECKIN_OFF' USING ERRCODE='42501'; END IF;
  PERFORM hon.face_checkin_sweep(org,school);
  SELECT t.student_profile_id INTO student FROM hon.face_templates t JOIN hon.face_checkin_consents c ON c.id=t.consent_id
    JOIN hon.student_profiles sp ON sp.id=t.student_profile_id
    WHERE t.organization_id=org AND t.school_id=school AND t.template=decode(p_input->>'pictureDigest','hex') AND t.activation=st.activation
      AND hon.face_checkin_consent_state(st,c)='GIVEN' AND sp.status='ACTIVE';
  INSERT INTO hon.face_checkin_matches(organization_id,school_id,class_session_id,student_profile_id,outcome,proposed_by_principal_id)
    VALUES(org,school,p_session,student,CASE WHEN student IS NULL THEN 'NO_MATCH' ELSE 'PROPOSED' END,actor) RETURNING * INTO m;
  SELECT jsonb_build_object('studentProfileId',sp.id,'givenName',p.given_name,'familyName',p.family_name) INTO who
    FROM hon.student_profiles sp JOIN hon.people p ON p.id=sp.person_id AND p.organization_id=sp.organization_id AND p.school_id=sp.school_id WHERE sp.id=student;
  replay:=hon.face_checkin_finish(actor,'match','FACE_CHECKIN_MATCH',m.id,jsonb_build_object('matchId',m.id,'sessionId',p_session,'outcome',m.outcome,'version',1),
    p_key,p_request,p_correlation,jsonb_build_object('matchId',m.id,'sessionId',p_session,'outcome',m.outcome,'student',who,'proposedAt',hon.saas_ts(m.proposed_at)));
  IF hon.lock_attendance_actor(p_subject,'attendance.record') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'ATTENDANCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- Staff decide a proposal. Input: {matchId, accept, status PRESENT|LATE}. A proposal older than 10 minutes, or one whose
-- student is no longer enrolled with a current consent, is EXPIRED and records nothing. Accept writes attendance through
-- the 0394 shared path with method FACE (method_ref = the match).
CREATE FUNCTION hon.confirm_face_checkin_match(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; m hon.face_checkin_matches%ROWTYPE;
  st hon.face_checkin_settings%ROWTYPE; attendance jsonb:=NULL; outcome text;
BEGIN
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['accept','matchId','status']) OR NOT hon.face_checkin_uuid_ok(p_input,'matchId')
    OR jsonb_typeof(p_input->'accept') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string'
    OR p_input->>'status' NOT IN ('PRESENT','LATE') THEN RAISE EXCEPTION 'FACE_CHECKIN_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.lock_attendance_actor(p_subject,'attendance.record');
  replay:=hon.face_checkin_begin(actor,'confirm',p_input,p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  SELECT * INTO m FROM hon.face_checkin_matches WHERE id=(p_input->>'matchId')::uuid AND organization_id=org AND school_id=school FOR UPDATE;
  IF m.id IS NULL THEN RAISE EXCEPTION 'FACE_CHECKIN_MATCH_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF m.outcome<>'PROPOSED' THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('face-checkin:'||school::text,0));
  PERFORM 1 FROM hon.school_locations WHERE school_id=school AND organization_id=org FOR SHARE;
  SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=school AND organization_id=org;
  IF m.proposed_at<=clock_timestamp()-interval '10 minutes' OR NOT hon.face_checkin_open() OR st.status IS DISTINCT FROM 'ON'
    OR NOT EXISTS(SELECT 1 FROM hon.face_templates t JOIN hon.face_checkin_consents c ON c.id=t.consent_id
      WHERE t.student_profile_id=m.student_profile_id AND t.activation=st.activation AND hon.face_checkin_consent_state(st,c)='GIVEN') THEN
    UPDATE hon.face_checkin_matches SET outcome='EXPIRED' WHERE id=m.id RETURNING * INTO m;
  ELSIF (p_input->>'accept')::boolean THEN
    attendance:=hon.attendance_check_in_student(p_subject,m.class_session_id,m.student_profile_id,'FACE',m.id,p_input->>'status',p_key,p_request,p_correlation);
    UPDATE hon.face_checkin_matches SET outcome='CONFIRMED',decided_by_principal_id=actor,decided_at=clock_timestamp() WHERE id=m.id RETURNING * INTO m;
    UPDATE hon.face_templates SET last_matched_at=clock_timestamp() WHERE student_profile_id=m.student_profile_id;
  ELSE
    UPDATE hon.face_checkin_matches SET outcome='REJECTED',decided_by_principal_id=actor,decided_at=clock_timestamp() WHERE id=m.id RETURNING * INTO m;
  END IF;
  replay:=hon.face_checkin_finish(actor,'confirm','FACE_CHECKIN_MATCH',m.id,jsonb_build_object('matchId',m.id,'outcome',m.outcome,'version',2),
    p_key,p_request,p_correlation,jsonb_build_object('matchId',m.id,'sessionId',m.class_session_id,'studentProfileId',m.student_profile_id,'outcome',m.outcome,
      'checkIn',attendance));
  IF hon.lock_attendance_actor(p_subject,'attendance.record') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'ATTENDANCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- ---------- family (parent portal) entry points ----------
-- The family's children with their consent, whether the school has face check-in on, and the forms to read and sign.
CREATE FUNCTION hon.read_family_face_checkin(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; st hon.face_checkin_settings%ROWTYPE; result jsonb;
BEGIN
  SELECT * INTO sc FROM hon.face_checkin_family_scope(p_subject,false);
  SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=sc.school_id AND organization_id=sc.organization_id;
  SELECT jsonb_build_object('program',(SELECT status FROM hon.face_checkin_program),'schoolStatus',coalesce(st.status,'OFF'),
    'canSign',sc.access_level IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN') AND st.status='ON' AND hon.face_checkin_open(),
    'canWithdraw',sc.access_level IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN'),
    'forms',CASE WHEN st.status='ON' THEN hon.face_checkin_forms_json(st.profile_code) ELSE '[]'::jsonb END,
    'children',coalesce(jsonb_agg(jsonb_build_object('studentProfileId',x.id,'givenName',x.given_name,'familyName',x.family_name,
      'consent',hon.face_checkin_consent_json(st,x.consent),'enrolled',x.enrolled) ORDER BY x.given_name,x.id),'[]'::jsonb)) INTO result
  FROM (SELECT sp.id,p.given_name,p.family_name,
      (SELECT c FROM hon.face_checkin_consents c WHERE c.student_profile_id=sp.id ORDER BY c.signed_at DESC,c.id LIMIT 1) consent,
      EXISTS(SELECT 1 FROM hon.face_templates t WHERE t.student_profile_id=sp.id) enrolled
    FROM hon.student_profiles sp JOIN hon.people p ON p.id=sp.person_id AND p.organization_id=sp.organization_id AND p.school_id=sp.school_id
    WHERE sp.organization_id=sc.organization_id AND sp.school_id=sc.school_id AND hon.face_checkin_child_ok(sc.family_id,sp.id) LIMIT 20) x;
  RETURN result;
END $$;

-- A guardian signs for their child. Input: {studentProfileId, formId, formDigest, signerName} (typed full name).
CREATE FUNCTION hon.sign_family_face_checkin_consent(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; replay jsonb; c hon.face_checkin_consents%ROWTYPE; st hon.face_checkin_settings%ROWTYPE; live uuid;
BEGIN
  SELECT * INTO sc FROM hon.face_checkin_family_scope(p_subject,true);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['formDigest','formId','signerName','studentProfileId']) OR NOT hon.face_checkin_uuid_ok(p_input,'studentProfileId')
    OR NOT hon.face_checkin_name_ok(p_input) THEN RAISE EXCEPTION 'FACE_CHECKIN_INVALID' USING ERRCODE='22023'; END IF;
  replay:=hon.face_checkin_begin(sc.principal_id,'family_sign',p_input,p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  IF NOT hon.face_checkin_child_ok(sc.family_id,(p_input->>'studentProfileId')::uuid) THEN RAISE EXCEPTION 'FACE_CHECKIN_STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  c:=hon.face_checkin_write_consent(sc.principal_id,(p_input->>'studentProfileId')::uuid,p_input,'PARENT_PORTAL','GUARDIAN');
  SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=sc.school_id AND organization_id=sc.organization_id;
  replay:=hon.face_checkin_finish(sc.principal_id,'family_sign','FACE_CHECKIN_CONSENT',c.id,
    jsonb_build_object('consentId',c.id,'studentProfileId',c.student_profile_id,'method',c.method,'formId',c.form_id,'version',c.version),
    p_key,p_request,p_correlation,jsonb_build_object('studentProfileId',c.student_profile_id,'consent',hon.face_checkin_consent_json(st,c)));
  SELECT principal_id INTO live FROM hon.face_checkin_family_scope(p_subject,true);
  IF live IS DISTINCT FROM sc.principal_id THEN RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- A guardian withdraws their child's consent. Input: {consentId, expectedVersion}. Always allowed.
CREATE FUNCTION hon.withdraw_family_face_checkin_consent(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; replay jsonb; c hon.face_checkin_consents%ROWTYPE; st hon.face_checkin_settings%ROWTYPE; live uuid;
BEGIN
  SELECT * INTO sc FROM hon.face_checkin_family_scope(p_subject,true);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['consentId','expectedVersion']) OR NOT hon.face_checkin_uuid_ok(p_input,'consentId')
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'FACE_CHECKIN_INVALID' USING ERRCODE='22023'; END IF;
  replay:=hon.face_checkin_begin(sc.principal_id,'family_withdraw',p_input,p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  c:=hon.face_checkin_withdraw(sc.principal_id,p_input,sc.family_id);
  SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=sc.school_id AND organization_id=sc.organization_id;
  replay:=hon.face_checkin_finish(sc.principal_id,'family_withdraw','FACE_CHECKIN_CONSENT',c.id,
    jsonb_build_object('consentId',c.id,'studentProfileId',c.student_profile_id,'version',c.version),
    p_key,p_request,p_correlation,jsonb_build_object('studentProfileId',c.student_profile_id,'consent',hon.face_checkin_consent_json(st,c)));
  SELECT principal_id INTO live FROM hon.face_checkin_family_scope(p_subject,true);
  IF live IS DISTINCT FROM sc.principal_id THEN RAISE EXCEPTION 'FACE_CHECKIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- Deny first, then exactly the ten entry points for the runtime role. No table privilege for any client role.
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['face_checkin_program','face_checkin_form_parts','face_checkin_forms','face_checkin_settings','face_checkin_consents',
      'face_templates','face_template_deletions','face_checkin_matches','face_checkin_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace
      AND (p.proname LIKE 'face\_checkin\_%' OR p.proname IN ('guard_face_checkin','purge_face_checkin_retention','read_face_checkin','save_face_checkin_settings',
        'record_face_checkin_consent','withdraw_face_checkin_consent','enroll_face_checkin_student','match_face_checkin','confirm_face_checkin_match',
        'read_family_face_checkin','sign_family_face_checkin_consent','withdraw_family_face_checkin_consent')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_face_checkin(text),hon.save_face_checkin_settings(text,jsonb,text,uuid,uuid),
      hon.record_face_checkin_consent(text,jsonb,text,uuid,uuid),hon.withdraw_face_checkin_consent(text,jsonb,text,uuid,uuid),
      hon.enroll_face_checkin_student(text,jsonb,text,uuid,uuid),hon.match_face_checkin(text,uuid,jsonb,text,uuid,uuid),
      hon.confirm_face_checkin_match(text,jsonb,text,uuid,uuid),hon.read_family_face_checkin(text),
      hon.sign_family_face_checkin_consent(text,jsonb,text,uuid,uuid),hon.withdraw_family_face_checkin_consent(text,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
