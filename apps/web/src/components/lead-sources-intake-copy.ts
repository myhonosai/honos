import type { Language } from '@hon/design-system';

export type LeadIntakeCopy = {
  navCore: string;
  navForms: string;
  navLeads: string;
  navCampaigns: string;
  navImports: string;
  navChad: string;
  staffNavigation: string;
  signIn: string;
  currentSchoolRead: string;
  presentationOnly: string;
  verifiedRead: string;
  awaitingRead: string;
  notConnected: string;
  unavailableLabel: string;
  websiteResponseBacked: string;
  governedNextSteps: string;
  noInferredFunnel: string;
  humanReview: string;
  governedDraftsOnly: string;
  eyebrow: string;
  title: string;
  introduction: string;
  guardrail: string;
  load: string;
  loading: string;
  idle: string;
  sessionInvalid: string;
  denied: string;
  unavailable: string;
  viewLabel: string;
  viewNote: string;
  modern: string;
  classic: string;
  bigButton: string;
  sourceTitle: string;
  website: string;
  websiteReady: (count: string) => string;
  formCount: (count: string) => string;
  formEmpty: string;
  accepted: (count: string) => string;
  campaignRecorded: string;
  campaignMissing: string;
  zernioTitle: string;
  zernioBody: string;
  googleTitle: string;
  googleBody: string;
  conversionTitle: string;
  conversionBody: string;
  conversionUnavailable: string;
  duplicateTitle: string;
  duplicateBody: string;
  chadTitle: string;
  chadBody: string;
  openForms: string;
  openLeads: string;
  openTrials: string;
  openCampaigns: string;
  openImports: string;
  openChad: string;
  noEffects: string;
  formStatus: { DRAFT: string; PUBLISHED: string; DISABLED: string };
};

const copy: Record<Language, LeadIntakeCopy> = {
  en: {
    navCore: 'HON Core', navForms: 'Lead forms', navLeads: 'CRM leads', navCampaigns: 'Campaign plans', navImports: 'Duplicate review', navChad: 'Chad drafts',
    staffNavigation: 'Staff navigation', signIn: 'Sign in', currentSchoolRead: 'CURRENT SCHOOL / EXPLICIT READ', presentationOnly: 'PRESENTATION ONLY', verifiedRead: 'VERIFIED READ', awaitingRead: 'AWAITING READ', notConnected: 'NOT CONNECTED', unavailableLabel: 'UNAVAILABLE', websiteResponseBacked: 'WEBSITE INTAKE / RESPONSE-BACKED', governedNextSteps: 'Governed next steps', noInferredFunnel: 'NO INFERRED FUNNEL', humanReview: 'HUMAN REVIEW', governedDraftsOnly: 'GOVERNED DRAFTS ONLY',
    eyebrow: 'SCHOOL GROWTH / VERIFIED FORM INTAKE', title: 'Lead Sources & Intake Monitor',
    introduction: 'A deliberate, read-only intake view. Load your current authorized form facts, then continue into the workflow that owns each next step.',
    guardrail: 'This monitor never reads provider accounts, contact submissions, consent, leads, trials, enrollment, payments, or revenue. A CRM WON state is not enrollment or payment.',
    load: 'Load authorized intake facts', loading: 'Verifying current school form access…', idle: 'No verified intake facts are loaded.', sessionInvalid: 'Your signed session has ended. Returned intake facts were cleared. Sign in again, then make a new authorized read.',
    denied: 'Current human school permission is required. Returned intake facts were cleared.', unavailable: 'Current intake facts are unavailable. Returned facts were cleared; no outcome is assumed.',
    viewLabel: 'Presentation mode', viewNote: 'Presentation only for this open page. It does not save a preference or change data, scope, permissions, or actions.',
    modern: 'Modern HON', classic: 'Classic CRM', bigButton: 'Big-Button / Phone',
    sourceTitle: 'Source lanes', website: 'Website forms', websiteReady: count => `${count} accepted new ${count === '1' ? 'enquiry' : 'enquiries'} returned from current authorized forms.`,
    formCount: count => `${count} current form${count === '1' ? '' : 's'} returned`, formEmpty: 'No current forms were returned for this authorized school.', accepted: count => `${count} accepted new enquiries`,
    campaignRecorded: 'Campaign association recorded', campaignMissing: 'No campaign association recorded',
    zernioTitle: 'Facebook & Instagram via Zernio', zernioBody: 'NOT CONNECTED. No Zernio account, webhook, lead sync, delivery, or provider health fact is configured or called here.',
    googleTitle: 'Google Ads attribution', googleBody: 'UNAVAILABLE. This page makes no Google Ads call. Existing form configuration may record a school campaign association; spend and provider conversions are not verified here.',
    conversionTitle: 'Lead → trial → enrollment reporting', conversionBody: 'Use the existing CRM and campaign workbenches for authorized facts. This monitor does not infer a trial conversion, enrollment, membership, payment, revenue, or ROI.', conversionUnavailable: 'Enrollment/revenue linkage is not authoritative yet.',
    duplicateTitle: 'Duplicate review & CRM handoff', duplicateBody: 'The existing Lead Migration Center owns explicit human duplicate suggestions and import/skip decisions. No match, merge, or handoff is performed here.',
    chadTitle: 'Chad follow-up drafts', chadBody: 'Open the separate governed draft guide for a known lead. No AI task, automation, message, or customer contact is started from this monitor.',
    openForms: 'Open lead forms', openLeads: 'Open CRM leads', openTrials: 'Open trial appointments', openCampaigns: 'Open campaign planning', openImports: 'Open duplicate review', openChad: 'Open Chad drafts',
    noEffects: 'Read-only monitor. No provider, communication, advertising, billing, payment, Action Engine, automation, or AI effect occurs on this page.',
    formStatus: { DRAFT: 'Draft', PUBLISHED: 'Published', DISABLED: 'Disabled' }
  },
  ko: {
    navCore: 'HON Core', navForms: '리드 양식', navLeads: 'CRM 리드', navCampaigns: '캠페인 계획', navImports: '중복 검토', navChad: 'Chad 초안',
    staffNavigation: '직원 탐색', signIn: '로그인', currentSchoolRead: '현재 학교 / 명시적 조회', presentationOnly: '표시 전용', verifiedRead: '확인된 조회', awaitingRead: '조회 대기', notConnected: '연결되지 않음', unavailableLabel: '사용 불가', websiteResponseBacked: '웹사이트 유입 / 응답 기반', governedNextSteps: '통제된 다음 단계', noInferredFunnel: '추정 전환 없음', humanReview: '사람 검토', governedDraftsOnly: '통제된 초안만',
    eyebrow: '학교 성장 / 확인된 양식 유입', title: '리드 소스 및 유입 모니터',
    introduction: '의도적인 읽기 전용 유입 화면입니다. 현재 권한이 확인된 양식 정보를 불러온 뒤, 각 다음 단계를 담당하는 업무 화면으로 이동하세요.',
    guardrail: '이 모니터는 제공업체 계정, 문의 제출, 동의, 리드, 체험, 등록, 결제 또는 매출을 읽지 않습니다. CRM의 WON 상태는 등록이나 결제를 의미하지 않습니다.',
    load: '권한이 확인된 유입 정보 불러오기', loading: '현재 학교의 양식 권한 확인 중…', idle: '확인된 유입 정보가 아직 없습니다.', sessionInvalid: '서명된 세션이 종료되었습니다. 반환된 유입 정보가 지워졌습니다. 다시 로그인한 뒤 새 권한 확인 조회를 실행하세요.',
    denied: '현재 사람 사용자에게 학교 권한이 필요합니다. 반환된 유입 정보가 지워졌습니다.', unavailable: '현재 유입 정보를 사용할 수 없습니다. 반환된 정보가 지워졌으며 결과를 추정하지 않습니다.',
    viewLabel: '표시 모드', viewNote: '현재 열린 페이지에만 적용되는 표시 방식입니다. 환경설정을 저장하거나 데이터, 범위, 권한 또는 작업을 변경하지 않습니다.',
    modern: '모던 HON', classic: '클래식 CRM', bigButton: '큰 버튼 / 휴대폰',
    sourceTitle: '유입 소스', website: '웹사이트 양식', websiteReady: count => `현재 권한이 확인된 양식에서 새 문의 ${count}건이 반환되었습니다.`,
    formCount: count => `현재 양식 ${count}개 반환됨`, formEmpty: '이 권한 범위의 학교에서 현재 양식이 반환되지 않았습니다.', accepted: count => `새 문의 ${count}건 수락됨`,
    campaignRecorded: '캠페인 연결 기록됨', campaignMissing: '캠페인 연결 기록 없음',
    zernioTitle: 'Zernio를 통한 Facebook 및 Instagram', zernioBody: '연결되지 않음. 이 화면에서는 Zernio 계정, 웹훅, 리드 동기화, 전송 또는 제공업체 상태를 설정하거나 호출하지 않습니다.',
    googleTitle: 'Google Ads 기여도', googleBody: '사용 불가. 이 페이지는 Google Ads를 호출하지 않습니다. 기존 양식 설정에는 학교 캠페인 연결이 기록될 수 있지만 지출 및 제공업체 전환은 여기서 확인되지 않습니다.',
    conversionTitle: '리드 → 체험 → 등록 보고', conversionBody: '권한이 확인된 정보는 기존 CRM 및 캠페인 업무 화면을 사용하세요. 이 모니터는 체험 전환, 등록, 멤버십, 결제, 매출 또는 ROI를 추정하지 않습니다.', conversionUnavailable: '등록/매출 연결은 아직 권한 있는 사실이 아닙니다.',
    duplicateTitle: '중복 검토 및 CRM 전달', duplicateBody: '기존 리드 이전 센터가 사람 사용자의 명시적 중복 제안과 가져오기/건너뛰기 결정을 담당합니다. 이 화면에서는 일치, 병합 또는 전달을 수행하지 않습니다.',
    chadTitle: 'Chad 후속 조치 초안', chadBody: '알려진 리드에 대한 별도 통제 초안 도구를 여세요. 이 모니터는 AI 작업, 자동화, 메시지 또는 고객 연락을 시작하지 않습니다.',
    openForms: '리드 양식 열기', openLeads: 'CRM 리드 열기', openTrials: '체험 약속 열기', openCampaigns: '캠페인 계획 열기', openImports: '중복 검토 열기', openChad: 'Chad 초안 열기',
    noEffects: '읽기 전용 모니터입니다. 이 페이지에서 제공업체, 연락, 광고, 청구, 결제, Action Engine, 자동화 또는 AI 효과는 발생하지 않습니다.',
    formStatus: { DRAFT: '초안', PUBLISHED: '게시됨', DISABLED: '비활성화됨' }
  },
  es: {
    navCore: 'HON Core', navForms: 'Formularios de leads', navLeads: 'Leads CRM', navCampaigns: 'Planes de campaña', navImports: 'Revisión de duplicados', navChad: 'Borradores de Chad',
    staffNavigation: 'Navegación del personal', signIn: 'Iniciar sesión', currentSchoolRead: 'ESCUELA ACTUAL / LECTURA EXPLÍCITA', presentationOnly: 'SOLO PRESENTACIÓN', verifiedRead: 'LECTURA VERIFICADA', awaitingRead: 'LECTURA PENDIENTE', notConnected: 'SIN CONEXIÓN', unavailableLabel: 'NO DISPONIBLE', websiteResponseBacked: 'ENTRADA WEB / RESPALDADA POR RESPUESTA', governedNextSteps: 'Siguientes pasos gobernados', noInferredFunnel: 'SIN EMBUDO INFERIDO', humanReview: 'REVISIÓN HUMANA', governedDraftsOnly: 'SOLO BORRADORES GOBERNADOS',
    eyebrow: 'CRECIMIENTO ESCOLAR / ENTRADA DE FORMULARIOS VERIFICADA', title: 'Monitor de fuentes y entrada de leads',
    introduction: 'Una vista de entrada deliberada y de solo lectura. Carga los datos actuales de formularios autorizados y continúa al flujo que gestiona cada paso siguiente.',
    guardrail: 'Este monitor nunca consulta cuentas de proveedores, envíos de contacto, consentimientos, leads, pruebas, inscripciones, pagos ni ingresos. Un estado CRM WON no es una inscripción ni un pago.',
    load: 'Cargar datos de entrada autorizados', loading: 'Verificando acceso a formularios de la escuela actual…', idle: 'No hay datos de entrada verificados cargados.', sessionInvalid: 'Tu sesión firmada terminó. Se borraron los datos de entrada devueltos. Inicia sesión de nuevo y realiza una nueva lectura autorizada.',
    denied: 'Se requiere permiso actual de usuario humano de la escuela. Se borraron los datos de entrada devueltos.', unavailable: 'Los datos actuales de entrada no están disponibles. Se borraron los datos devueltos; no se presupone ningún resultado.',
    viewLabel: 'Modo de presentación', viewNote: 'Solo presentación en esta página abierta. No guarda una preferencia ni cambia datos, ámbito, permisos o acciones.',
    modern: 'HON moderno', classic: 'CRM clásico', bigButton: 'Botones grandes / teléfono',
    sourceTitle: 'Canales de origen', website: 'Formularios web', websiteReady: count => `${count} consultas nuevas aceptadas devueltas de los formularios autorizados actuales.`,
    formCount: count => `${count} formulario${count === '1' ? '' : 's'} actual${count === '1' ? '' : 'es'} devuelto${count === '1' ? '' : 's'}`, formEmpty: 'No se devolvieron formularios actuales para esta escuela autorizada.', accepted: count => `${count} consultas nuevas aceptadas`,
    campaignRecorded: 'Asociación de campaña registrada', campaignMissing: 'No hay asociación de campaña registrada',
    zernioTitle: 'Facebook e Instagram mediante Zernio', zernioBody: 'SIN CONEXIÓN. No se configura ni llama aquí ninguna cuenta Zernio, webhook, sincronización de leads, entrega o dato de salud del proveedor.',
    googleTitle: 'Atribución de Google Ads', googleBody: 'NO DISPONIBLE. Esta página no realiza ninguna llamada a Google Ads. La configuración existente de formularios puede registrar una asociación de campaña escolar; el gasto y las conversiones del proveedor no se verifican aquí.',
    conversionTitle: 'Informes de lead → prueba → inscripción', conversionBody: 'Usa los espacios existentes de CRM y campañas para los datos autorizados. Este monitor no infiere una conversión de prueba, inscripción, membresía, pago, ingresos ni ROI.', conversionUnavailable: 'La vinculación de inscripción/ingresos aún no es autoritativa.',
    duplicateTitle: 'Revisión de duplicados y traspaso a CRM', duplicateBody: 'El Centro de migración de leads existente gestiona sugerencias explícitas de duplicados y decisiones humanas de importar/omitir. Aquí no se realiza coincidencia, fusión ni traspaso.',
    chadTitle: 'Borradores de seguimiento de Chad', chadBody: 'Abre la guía de borradores gobernada para un lead conocido. Este monitor no inicia una tarea de IA, automatización, mensaje ni contacto con el cliente.',
    openForms: 'Abrir formularios de leads', openLeads: 'Abrir leads CRM', openTrials: 'Abrir citas de prueba', openCampaigns: 'Abrir planificación de campañas', openImports: 'Abrir revisión de duplicados', openChad: 'Abrir borradores de Chad',
    noEffects: 'Monitor de solo lectura. En esta página no ocurre ningún efecto de proveedor, comunicación, publicidad, facturación, pago, Action Engine, automatización o IA.',
    formStatus: { DRAFT: 'Borrador', PUBLISHED: 'Publicado', DISABLED: 'Desactivado' }
  }
};

export function leadIntakeCopy(language: Language): LeadIntakeCopy {
  return copy[language];
}
