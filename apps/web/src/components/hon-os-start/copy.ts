import type { Language } from '@hon/design-system';

/**
 * Fixed copy for the public start page in every HON language. Server text never reaches the page: stable codes map to
 * these lines. LEGAL_TERMS_PENDING is a placeholder until David approves the legal sign-up and trial terms wording.
 */
export type StartCopy = Readonly<{
  codes: Readonly<Record<string, string>>;
  fallback: string; unknownOutcome: string; checking: string; checked: string; sending: string; begin: string;
  title: string; intro: string; checkFirst: string; checkAgain: string; otherAccount: string;
  retryNote: string; retryButton: string;
  step1: string; step2: string;
  registered: (school: string, at: string) => string;
  signupClosed: string; verifiedRequired: string; hasOtherAccess: string; openWorkspace: string; termsUnavailable: string;
  ownerName: string; schoolName: string; legalName: string; timezone: string;
  agree: (title: string, version: number, draft: boolean) => string;
  legalTermsPending: string; createButton: string;
  created: string; trialStarted: string;
  trialActive: string; trialEnded: string; trialReplaced: string;
  trialDates: (days: number, from: string, until: string) => string;
  aiUsage: (used: number, credits: number, daily: number, until: string) => string;
  noAi: string; founderSetup: string;
  trialClosed: string; noOffer: string;
  offer: (name: string, days: number) => string;
  offerAi: (credits: number, daily: number, expiryDays: number) => string;
  trialTermsPending: string;
  confirmTrial: (days: number) => string; startTrial: string;
}>;

const en: StartCopy = {
  codes: {
    SIGNUP_CLOSED: 'Self-serve sign-up is not open yet. Nothing was created.',
    SIGNUP_ALREADY_REGISTERED: 'This account already created a school. Check again to continue.',
    SIGNUP_TERMS_CHANGED: 'The sign-up terms changed. Check again to review the current terms.',
    SIGNUP_REVIEW_REQUIRED: 'This email is already used by another HON account. Contact HON support; nothing was created.',
    SIGNUP_OWNER_NOT_ELIGIBLE: 'This account already has HON access, so it cannot create a new school here.',
    SIGNUP_KEY_REUSED: 'That request changed after it was sent. Start again.',
    SIGNUP_BUSY: 'HON is busy. Nothing was submitted; try again in a moment.',
    TRIAL_CLOSED: 'Free trials are not open yet. Nothing was started.',
    TRIAL_ALREADY_USED: 'This school already used its free trial.',
    TRIAL_CAMPAIGN_UNAVAILABLE: 'That free trial is no longer offered. Check again.',
    TRIAL_CAMPAIGN_FULL: 'That free trial is full. Check again later.',
    TRIAL_NOT_ELIGIBLE: 'This school already has access, so a free trial cannot start.',
    TRIAL_KEY_REUSED: 'That request changed after it was sent. Start again.',
    TRIAL_BUSY: 'HON is busy. Nothing was submitted; try again in a moment.',
    ACCOUNT_FORBIDDEN: 'This account cannot do that.',
    ACCOUNT_INPUT_INVALID: 'Check the details and try again.',
    ACCOUNT_RATE_LIMITED: 'Please wait up to a minute, then retry. This attempt was not submitted.',
    ACCOUNT_CHANGED_RESTART_REQUIRED: 'You are signed in as a different account now. Reload this page to start again.',
    SIGN_IN_REQUIRED: 'Sign in to continue.',
  },
  fallback: 'HON could not complete that right now. Try again.',
  unknownOutcome: 'The outcome is unknown. Retry the exact request when ready; it cannot create a second school or trial.',
  checking: 'Checking your account…', checked: 'Account checked.', sending: 'Sending… keep this page open.', begin: 'Check your account to begin.',
  title: 'Start your school on HON OS',
  intro: 'Create your school account, then start a free trial. There is no charge and no payment method is needed.',
  checkFirst: 'Check my account', checkAgain: 'Check again', otherAccount: 'Sign in with a different account',
  retryNote: 'Your last request may not have reached HON. Retrying sends exactly the same request, so it cannot create a second school or trial.',
  retryButton: 'Retry exact request',
  step1: '1. Your school account', step2: '2. Your free trial',
  registered: (s, at) => `School account created for ${s} on ${at}.`,
  signupClosed: 'Self-serve sign-up is not open yet. Nothing has been created.',
  verifiedRequired: 'Sign in with an account whose email address is verified to create a school.',
  hasOtherAccess: 'This account already has HON access.', openWorkspace: 'Open my workspace',
  termsUnavailable: 'Sign-up terms are not available. Check again later.',
  ownerName: 'Your name', schoolName: 'School name', legalName: 'Legal business name', timezone: 'School time zone',
  agree: (t, v, d) => `I agree to ${t} (version ${v}${d ? ', a test-only draft' : ''}) and confirm I own or run this school.`,
  legalTermsPending: 'The final legal terms are still being prepared and will be shown here before sign-up opens.',
  createButton: 'Create my school account',
  created: 'Your school account is created. It has no access yet; start your free trial below.',
  trialStarted: 'Your free trial has started. Continue to Founder Setup to set up your school.',
  trialActive: 'Your free trial is on.', trialEnded: 'Your free trial has ended.', trialReplaced: 'Your free trial was replaced by other access.',
  trialDates: (d, f, u) => `${d} days, from ${f} until ${u}. No charge, and no payment method is needed. Nothing renews automatically.`,
  aiUsage: (used, c, daily, u) => `AI team: ${used} of ${c} trial credits used, up to ${daily} a day, until ${u}. Creative Studio images and video are not included.`,
  noAi: 'This trial does not include the AI team.', founderSetup: 'Continue to Founder Setup →',
  trialClosed: 'Free trials are not open yet. Your school account is saved; come back when HON opens them.',
  noOffer: 'No free trial is available right now. Check again later.',
  offer: (n, d) => `${n}: ${d} days. No charge, no payment method, nothing renews automatically.`,
  offerAi: (c, daily, e) => `Includes the AI team with ${c} trial credits (up to ${daily} a day) for the first ${e} days. Creative Studio images and video are not included.`,
  trialTermsPending: 'The free-trial terms are still being prepared and will be shown here before trials open.',
  confirmTrial: d => `Start my ${d}-day free trial now.`, startTrial: 'Start free trial',
};

const ko: StartCopy = {
  codes: {
    SIGNUP_CLOSED: '셀프 가입은 아직 열리지 않았습니다. 아무것도 만들어지지 않았습니다.',
    SIGNUP_ALREADY_REGISTERED: '이 계정은 이미 도장을 만들었습니다. 다시 확인하여 계속하세요.',
    SIGNUP_TERMS_CHANGED: '가입 약관이 변경되었습니다. 다시 확인하여 현재 약관을 검토하세요.',
    SIGNUP_REVIEW_REQUIRED: '이 이메일은 이미 다른 HON 계정에서 사용 중입니다. HON 지원팀에 문의하세요. 아무것도 만들어지지 않았습니다.',
    SIGNUP_OWNER_NOT_ELIGIBLE: '이 계정은 이미 HON 접근 권한이 있어 여기서 새 도장을 만들 수 없습니다.',
    SIGNUP_KEY_REUSED: '보낸 후 요청이 변경되었습니다. 처음부터 다시 시작하세요.',
    SIGNUP_BUSY: 'HON이 바쁩니다. 제출되지 않았습니다. 잠시 후 다시 시도하세요.',
    TRIAL_CLOSED: '무료 체험은 아직 열리지 않았습니다. 아무것도 시작되지 않았습니다.',
    TRIAL_ALREADY_USED: '이 도장은 이미 무료 체험을 사용했습니다.',
    TRIAL_CAMPAIGN_UNAVAILABLE: '해당 무료 체험은 더 이상 제공되지 않습니다. 다시 확인하세요.',
    TRIAL_CAMPAIGN_FULL: '해당 무료 체험은 마감되었습니다. 나중에 다시 확인하세요.',
    TRIAL_NOT_ELIGIBLE: '이 도장은 이미 접근 권한이 있어 무료 체험을 시작할 수 없습니다.',
    TRIAL_KEY_REUSED: '보낸 후 요청이 변경되었습니다. 처음부터 다시 시작하세요.',
    TRIAL_BUSY: 'HON이 바쁩니다. 제출되지 않았습니다. 잠시 후 다시 시도하세요.',
    ACCOUNT_FORBIDDEN: '이 계정으로는 할 수 없습니다.',
    ACCOUNT_INPUT_INVALID: '입력 내용을 확인하고 다시 시도하세요.',
    ACCOUNT_RATE_LIMITED: '최대 1분 기다린 후 다시 시도하세요. 이번 시도는 제출되지 않았습니다.',
    ACCOUNT_CHANGED_RESTART_REQUIRED: '지금 다른 계정으로 로그인되어 있습니다. 이 페이지를 새로 고쳐 다시 시작하세요.',
    SIGN_IN_REQUIRED: '계속하려면 로그인하세요.',
  },
  fallback: 'HON이 지금 처리하지 못했습니다. 다시 시도하세요.',
  unknownOutcome: '결과를 알 수 없습니다. 준비되면 같은 요청을 그대로 다시 보내세요. 두 번째 도장이나 체험이 만들어지지 않습니다.',
  checking: '계정을 확인하는 중…', checked: '계정을 확인했습니다.', sending: '보내는 중… 이 페이지를 열어 두세요.', begin: '시작하려면 계정을 확인하세요.',
  title: 'HON OS에서 도장 시작하기',
  intro: '도장 계정을 만든 다음 무료 체험을 시작하세요. 요금이 없으며 결제 수단도 필요 없습니다.',
  checkFirst: '내 계정 확인', checkAgain: '다시 확인', otherAccount: '다른 계정으로 로그인',
  retryNote: '마지막 요청이 HON에 도달하지 않았을 수 있습니다. 다시 시도하면 똑같은 요청을 보내므로 두 번째 도장이나 체험이 만들어지지 않습니다.',
  retryButton: '같은 요청 다시 보내기',
  step1: '1. 도장 계정', step2: '2. 무료 체험',
  registered: (s, at) => `${at}에 ${s}의 도장 계정이 만들어졌습니다.`,
  signupClosed: '셀프 가입은 아직 열리지 않았습니다. 아무것도 만들어지지 않았습니다.',
  verifiedRequired: '도장을 만들려면 이메일 주소가 인증된 계정으로 로그인하세요.',
  hasOtherAccess: '이 계정은 이미 HON 접근 권한이 있습니다.', openWorkspace: '내 업무 공간 열기',
  termsUnavailable: '가입 약관을 불러올 수 없습니다. 나중에 다시 확인하세요.',
  ownerName: '이름', schoolName: '도장 이름', legalName: '법적 사업자명', timezone: '도장 시간대',
  agree: (t, v, d) => `${t}(버전 ${v}${d ? ', 테스트 전용 초안' : ''})에 동의하며 이 도장을 소유하거나 운영하고 있음을 확인합니다.`,
  legalTermsPending: '최종 법적 약관은 준비 중이며 가입이 열리기 전에 여기에 표시됩니다.',
  createButton: '내 도장 계정 만들기',
  created: '도장 계정이 만들어졌습니다. 아직 접근 권한은 없습니다. 아래에서 무료 체험을 시작하세요.',
  trialStarted: '무료 체험이 시작되었습니다. 창업자 설정으로 이동하여 도장을 설정하세요.',
  trialActive: '무료 체험 중입니다.', trialEnded: '무료 체험이 끝났습니다.', trialReplaced: '무료 체험이 다른 접근 권한으로 대체되었습니다.',
  trialDates: (d, f, u) => `${d}일, ${f}부터 ${u}까지. 요금이 없고 결제 수단이 필요 없습니다. 자동으로 갱신되지 않습니다.`,
  aiUsage: (used, c, daily, u) => `AI 팀: 체험 크레딧 ${c} 중 ${used} 사용, 하루 최대 ${daily}, ${u}까지. 크리에이티브 스튜디오 이미지와 동영상은 포함되지 않습니다.`,
  noAi: '이 체험에는 AI 팀이 포함되지 않습니다.', founderSetup: '창업자 설정으로 계속 →',
  trialClosed: '무료 체험은 아직 열리지 않았습니다. 도장 계정은 저장되었습니다. HON이 체험을 열면 다시 오세요.',
  noOffer: '지금은 이용 가능한 무료 체험이 없습니다. 나중에 다시 확인하세요.',
  offer: (n, d) => `${n}: ${d}일. 요금 없음, 결제 수단 없음, 자동 갱신 없음.`,
  offerAi: (c, daily, e) => `처음 ${e}일 동안 체험 크레딧 ${c}(하루 최대 ${daily})으로 AI 팀이 포함됩니다. 크리에이티브 스튜디오 이미지와 동영상은 포함되지 않습니다.`,
  trialTermsPending: '무료 체험 약관은 준비 중이며 체험이 열리기 전에 여기에 표시됩니다.',
  confirmTrial: d => `지금 ${d}일 무료 체험을 시작합니다.`, startTrial: '무료 체험 시작',
};

const es: StartCopy = {
  codes: {
    SIGNUP_CLOSED: 'El registro por cuenta propia aún no está abierto. No se creó nada.',
    SIGNUP_ALREADY_REGISTERED: 'Esta cuenta ya creó una escuela. Vuelva a comprobar para continuar.',
    SIGNUP_TERMS_CHANGED: 'Los términos de registro cambiaron. Vuelva a comprobar para revisar los términos actuales.',
    SIGNUP_REVIEW_REQUIRED: 'Este correo ya lo usa otra cuenta de HON. Contacte con el soporte de HON; no se creó nada.',
    SIGNUP_OWNER_NOT_ELIGIBLE: 'Esta cuenta ya tiene acceso a HON, así que no puede crear una escuela nueva aquí.',
    SIGNUP_KEY_REUSED: 'Esa solicitud cambió después de enviarse. Empiece de nuevo.',
    SIGNUP_BUSY: 'HON está ocupado. No se envió nada; inténtelo de nuevo en un momento.',
    TRIAL_CLOSED: 'Las pruebas gratuitas aún no están abiertas. No se inició nada.',
    TRIAL_ALREADY_USED: 'Esta escuela ya usó su prueba gratuita.',
    TRIAL_CAMPAIGN_UNAVAILABLE: 'Esa prueba gratuita ya no se ofrece. Vuelva a comprobar.',
    TRIAL_CAMPAIGN_FULL: 'Esa prueba gratuita está completa. Vuelva a comprobar más tarde.',
    TRIAL_NOT_ELIGIBLE: 'Esta escuela ya tiene acceso, así que no puede iniciar una prueba gratuita.',
    TRIAL_KEY_REUSED: 'Esa solicitud cambió después de enviarse. Empiece de nuevo.',
    TRIAL_BUSY: 'HON está ocupado. No se envió nada; inténtelo de nuevo en un momento.',
    ACCOUNT_FORBIDDEN: 'Esta cuenta no puede hacer eso.',
    ACCOUNT_INPUT_INVALID: 'Revise los datos e inténtelo de nuevo.',
    ACCOUNT_RATE_LIMITED: 'Espere hasta un minuto y vuelva a intentarlo. Este intento no se envió.',
    ACCOUNT_CHANGED_RESTART_REQUIRED: 'Ahora ha iniciado sesión con otra cuenta. Recargue esta página para empezar de nuevo.',
    SIGN_IN_REQUIRED: 'Inicie sesión para continuar.',
  },
  fallback: 'HON no pudo completar eso ahora. Inténtelo de nuevo.',
  unknownOutcome: 'El resultado es desconocido. Reintente exactamente la misma solicitud cuando quiera; no puede crear una segunda escuela ni prueba.',
  checking: 'Comprobando su cuenta…', checked: 'Cuenta comprobada.', sending: 'Enviando… mantenga esta página abierta.', begin: 'Compruebe su cuenta para empezar.',
  title: 'Empiece su escuela en HON OS',
  intro: 'Cree la cuenta de su escuela y luego inicie una prueba gratuita. No hay cargo ni se necesita método de pago.',
  checkFirst: 'Comprobar mi cuenta', checkAgain: 'Comprobar de nuevo', otherAccount: 'Iniciar sesión con otra cuenta',
  retryNote: 'Es posible que su última solicitud no llegara a HON. Reintentar envía exactamente la misma solicitud, así que no puede crear una segunda escuela ni prueba.',
  retryButton: 'Reintentar la misma solicitud',
  step1: '1. La cuenta de su escuela', step2: '2. Su prueba gratuita',
  registered: (s, at) => `Cuenta de escuela creada para ${s} el ${at}.`,
  signupClosed: 'El registro por cuenta propia aún no está abierto. No se ha creado nada.',
  verifiedRequired: 'Inicie sesión con una cuenta cuyo correo esté verificado para crear una escuela.',
  hasOtherAccess: 'Esta cuenta ya tiene acceso a HON.', openWorkspace: 'Abrir mi espacio de trabajo',
  termsUnavailable: 'Los términos de registro no están disponibles. Vuelva a comprobar más tarde.',
  ownerName: 'Su nombre', schoolName: 'Nombre de la escuela', legalName: 'Razón social', timezone: 'Zona horaria de la escuela',
  agree: (t, v, d) => `Acepto ${t} (versión ${v}${d ? ', un borrador solo de prueba' : ''}) y confirmo que soy dueño o dirijo esta escuela.`,
  legalTermsPending: 'Los términos legales definitivos aún se están preparando y se mostrarán aquí antes de abrir el registro.',
  createButton: 'Crear la cuenta de mi escuela',
  created: 'La cuenta de su escuela está creada. Aún no tiene acceso; inicie su prueba gratuita abajo.',
  trialStarted: 'Su prueba gratuita ha comenzado. Continúe a la configuración inicial para preparar su escuela.',
  trialActive: 'Su prueba gratuita está activa.', trialEnded: 'Su prueba gratuita ha terminado.', trialReplaced: 'Su prueba gratuita fue sustituida por otro acceso.',
  trialDates: (d, f, u) => `${d} días, desde ${f} hasta ${u}. Sin cargo y sin método de pago. Nada se renueva automáticamente.`,
  aiUsage: (used, c, daily, u) => `Equipo de IA: ${used} de ${c} créditos de prueba usados, hasta ${daily} al día, hasta ${u}. No incluye imágenes ni video de Creative Studio.`,
  noAi: 'Esta prueba no incluye el equipo de IA.', founderSetup: 'Continuar a la configuración inicial →',
  trialClosed: 'Las pruebas gratuitas aún no están abiertas. La cuenta de su escuela está guardada; vuelva cuando HON las abra.',
  noOffer: 'No hay ninguna prueba gratuita disponible ahora. Vuelva a comprobar más tarde.',
  offer: (n, d) => `${n}: ${d} días. Sin cargo, sin método de pago, nada se renueva automáticamente.`,
  offerAi: (c, daily, e) => `Incluye el equipo de IA con ${c} créditos de prueba (hasta ${daily} al día) durante los primeros ${e} días. No incluye imágenes ni video de Creative Studio.`,
  trialTermsPending: 'Los términos de la prueba gratuita aún se están preparando y se mostrarán aquí antes de abrir las pruebas.',
  confirmTrial: d => `Iniciar ahora mi prueba gratuita de ${d} días.`, startTrial: 'Iniciar prueba gratuita',
};

export const START_COPY: Readonly<Record<Language, StartCopy>> = { en, ko, es };

/**
 * An instant shown as date, time and zone. School-facing instants use the school's own zone when it is a real IANA
 * zone (the sign-up stored it), otherwise the browser's zone, and always name the zone so nobody misreads a day.
 */
export function instant(iso: string, locale: string, zone?: string): string {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  const at = new Date(iso);
  if (zone) { try { return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }).format(at); } catch { /* not a zone this browser knows */ } }
  try { return new Intl.DateTimeFormat(locale, options).format(at); } catch { return new Intl.DateTimeFormat('en-US', options).format(at); }
}
