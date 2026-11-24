/** Settings summary copy. ko/es are typed against en, so a missing key fails `pnpm check`. */
const en = {
  title: 'Settings', lead: 'Everything set up for your school, in one place. Choose Change to edit any of it.', change: 'Change', open: 'Open',
  loading: 'Reading…', unavailable: 'Could not be read right now. Open it to check.', denied: 'Your role does not include this. A school owner can change it.',
  plan: 'HON plan', planNone: 'No HON plan yet', tierESSENTIAL: 'Essential', tierCORE: 'Core', tierCOMPLETE: 'Complete',
  subPENDING_ACTIVATION: 'Waiting for the first payment', subIN_SERVICE: 'Active', subSUSPENDED: 'Paused', subVOIDED: 'Ended', subNone: 'No subscription yet',
  planOtherSchool: 'Open the subscription page to see this school\'s plan.',
  usage: 'Account & usage', usageLine: 'Your account, AI credit use and limits.',
  branding: 'School branding', logoSet: 'Logo added', logoNone: 'No logo yet', accent: 'Accent color', accentNone: 'No accent color yet', contactNone: 'No contact line yet',
  owners: 'School owners', ownersCount: '{n} owner(s)', youPrimary: 'You are the primary owner', youOwner: 'You are an owner',
  language: 'Language & region', timeZone: 'Time zone', regionAuto: 'Region follows the language',
  texts: 'Texts from HON', textsOn: 'Texts on to {phone}', textsOff: 'Number {phone} confirmed, texts off', textsPending: 'Number {phone} waiting for its code', textsNone: 'No number added',
  automation: 'Automations', automationLine: 'Texts, emails and reminders that go out on their own: no-shows, new leads, missing students, birthdays and renewals.',
  help: 'Help & support', helpLine: 'Guides and a way to ask the HON team.',
  tour: 'App tour', tourLine: 'A two-minute walk through the menu and what each part is for.', start: 'Start',
  setupTitle: 'School setup', setupLine: 'Welcome questions, school launch and Founder Setup live in onboarding.', setupOpen: 'Open setup',
} as const;
export type SettingsKey = keyof typeof en;
const ko: Record<SettingsKey, string> = {
  title: '설정', lead: '도장에 설정된 모든 것을 한곳에서 확인하세요. 수정하려면 변경을 누르세요.', change: '변경', open: '열기',
  loading: '불러오는 중…', unavailable: '지금은 불러올 수 없습니다. 열어서 확인하세요.', denied: '내 역할로는 볼 수 없습니다. 도장 소유자가 변경할 수 있습니다.',
  plan: 'HON 요금제', planNone: '아직 HON 요금제가 없습니다', tierESSENTIAL: 'Essential', tierCORE: 'Core', tierCOMPLETE: 'Complete',
  subPENDING_ACTIVATION: '첫 결제 대기 중', subIN_SERVICE: '사용 중', subSUSPENDED: '일시 중지됨', subVOIDED: '종료됨', subNone: '아직 구독이 없습니다',
  planOtherSchool: '구독 페이지에서 이 도장의 요금제를 확인하세요.',
  usage: '계정 및 사용량', usageLine: '계정, AI 크레딧 사용량과 한도.',
  branding: '학교 브랜딩', logoSet: '로고 등록됨', logoNone: '아직 로고가 없습니다', accent: '강조 색상', accentNone: '아직 강조 색상이 없습니다', contactNone: '아직 연락처 문구가 없습니다',
  owners: '도장 소유자', ownersCount: '소유자 {n}명', youPrimary: '내가 대표 소유자입니다', youOwner: '나는 소유자입니다',
  language: '언어 및 지역', timeZone: '시간대', regionAuto: '지역은 언어를 따릅니다',
  texts: 'HON 문자', textsOn: '{phone}(으)로 문자 받는 중', textsOff: '{phone} 번호 확인됨, 문자 꺼짐', textsPending: '{phone} 번호 인증 코드 대기 중', textsNone: '등록된 번호 없음',
  automation: '자동화', automationLine: '자동으로 나가는 문자, 이메일, 알림: 체험 불참, 새 리드, 결석 학생, 생일, 갱신.',
  help: '도움말 및 지원', helpLine: '가이드와 HON 팀에 문의하는 방법.',
  tour: '앱 둘러보기', tourLine: '메뉴의 각 부분과 용도를 2분 만에 둘러봅니다.', start: '시작',
  setupTitle: '도장 설정 시작', setupLine: '환영 질문, 도장 시작, 파운더 설정은 온보딩에 있습니다.', setupOpen: '설정 시작 열기',
};
const es: Record<SettingsKey, string> = {
  title: 'Ajustes', lead: 'Todo lo configurado para tu escuela, en un solo lugar. Elige Cambiar para editar cualquier cosa.', change: 'Cambiar', open: 'Abrir',
  loading: 'Leyendo…', unavailable: 'No se pudo leer ahora. Ábrelo para comprobarlo.', denied: 'Tu rol no incluye esto. Un dueño de la escuela puede cambiarlo.',
  plan: 'Plan de HON', planNone: 'Aún no hay plan de HON', tierESSENTIAL: 'Essential', tierCORE: 'Core', tierCOMPLETE: 'Complete',
  subPENDING_ACTIVATION: 'Esperando el primer pago', subIN_SERVICE: 'Activo', subSUSPENDED: 'En pausa', subVOIDED: 'Terminado', subNone: 'Aún no hay suscripción',
  planOtherSchool: 'Abre la página de suscripción para ver el plan de esta escuela.',
  usage: 'Cuenta y uso', usageLine: 'Tu cuenta, el uso de créditos de IA y los límites.',
  branding: 'Marca de la escuela', logoSet: 'Logo agregado', logoNone: 'Aún no hay logo', accent: 'Color de acento', accentNone: 'Aún no hay color de acento', contactNone: 'Aún no hay línea de contacto',
  owners: 'Dueños de la escuela', ownersCount: '{n} dueño(s)', youPrimary: 'Eres el dueño principal', youOwner: 'Eres dueño',
  language: 'Idioma y región', timeZone: 'Zona horaria', regionAuto: 'La región sigue al idioma',
  texts: 'Mensajes de HON', textsOn: 'Mensajes activados a {phone}', textsOff: 'Número {phone} confirmado, mensajes desactivados', textsPending: 'Número {phone} esperando su código', textsNone: 'No hay número agregado',
  automation: 'Automatizaciones', automationLine: 'Textos, correos y recordatorios que salen solos: faltas a la prueba, nuevos prospectos, alumnos ausentes, cumpleaños y renovaciones.',
  help: 'Ayuda y soporte', helpLine: 'Guías y una forma de preguntar al equipo de HON.',
  tour: 'Recorrido por la app', tourLine: 'Dos minutos por el menú y para qué sirve cada parte.', start: 'Empezar',
  setupTitle: 'Configuración inicial', setupLine: 'Las preguntas de bienvenida, el lanzamiento y Founder Setup están en la configuración inicial.', setupOpen: 'Abrir configuración inicial',
};
const catalogs: Record<string, Record<SettingsKey, string>> = { en, ko, es };
export function settingsText(language: string, key: SettingsKey, params: Readonly<Record<string, string | number>> = {}): string {
  const text = (catalogs[language] ?? en)[key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}
