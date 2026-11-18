/** Agreement signing link wording (en / ko / es): the staff "Send agreement" card and the family's signing page. */
const en = {
  // staff card
  cardTitle: 'Membership agreement', cardIntro: 'Send the family a link to read and sign the agreement on their phone. Signing is optional; it does not hold the membership.',
  loading: 'Reading the agreement…', denied: 'Your access does not include sending the agreement.', unavailable: 'The agreement could not be read.', reload: 'Read again',
  notPublished: 'Your school has not published a membership agreement yet.', noFamily: 'This student is not in a family yet, so there is no one to send it to.',
  allSigned: 'Everyone in this family who needs to sign has signed the current agreement.', noGuardian: 'This family has no guardian on file to send it to.',
  covers: 'The link covers: {names}', sendTo: 'Send to', by: 'Send by',
  EMAIL: 'Email', SMS: 'Text message', noAddress_EMAIL: 'no email on file', noAddress_SMS: 'no phone on file',
  noConsent_EMAIL: 'has not agreed to email', noConsent_SMS: 'has not agreed to texts',
  send: 'Make link and send', sendCopyOnly: 'Make link to copy', sending: 'Making the link…',
  result: 'Link made for {name}. It works for 14 days and signs once.', QUEUED: 'queued to send', NO_CONSENT: 'not sent (no consent)', NO_ADDRESS: 'not sent (no address)',
  copy: 'Copy link', copied: 'Copied', linkHelp: 'You can also share this link yourself. It is shown only now.',
  latest_OPEN: 'A link sent {date} is waiting to be signed. Sending again replaces it.', latest_SIGNED: 'Signed through the link on {date}.',
  latest_REPLACED: 'The last link was replaced.', latest_EXPIRED: 'The last link expired on {date}.',
  e_DENIED: 'Your access does not include this. Nothing was sent.', e_INVALID: 'This was not accepted. Nothing was sent.',
  e_NOT_PUBLISHED: 'Publish the membership agreement first. Nothing was sent.', e_NOTHING: 'No one in this family needs to sign. Nothing was sent.',
  e_RECIPIENT: 'Choose a guardian of this family. Nothing was sent.', e_BUSY: 'This was busy and nothing was sent. Try again in a moment.',
  e_ORIGIN: 'Sending links is not set up on this server yet. Nothing was sent.',
  e_UNKNOWN: 'We could not confirm whether the link was made. Try again sends the same request; it is never made twice.', tryAgain: 'Try again',
  // family page
  pageTitle: 'Membership agreement', pageLoading: 'Opening your agreement…', pageUnavailable: 'The agreement could not be opened right now. Try again in a moment.',
  pageGone: 'This link is not valid. Ask the school for a new one.', pageExpired: 'This link from {school} has expired. Ask the school for a new one.',
  pageReplaced: '{school} sent a newer link. Use the newest message from the school.', pageSigned: 'This agreement from {school} has been signed. Thank you.',
  hello: 'Hello {name}. {school} asks you to read and sign its membership agreement.', noAgreement: '{school} has no agreement to sign right now.',
  nobody: 'Nobody here needs to sign right now.', language: 'Language', forWhom: 'I sign for', fullName: 'Your full name',
  esign: 'I agree to sign electronically. Typing my name is my signature.', signButton: 'Sign', signing: 'Signing…',
  done: 'Signed. Thank you. You can close this page.', changed: 'The school changed its agreement. Read the new version and sign again.',
  invalidSign: 'Check your name, choose at least one child and tick the box.', expires: 'This link works until {date}.',
  language_en: 'English', language_ko: '한국어', language_es: 'Español',
};
type Copy = Record<keyof typeof en, string>;
const ko: Partial<Copy> = {
  pageTitle: '회원 약관', pageLoading: '약관을 여는 중…', pageUnavailable: '지금은 약관을 열 수 없습니다. 잠시 후 다시 시도하세요.',
  pageGone: '유효하지 않은 링크입니다. 학교에 새 링크를 요청하세요.', pageExpired: '{school}의 링크가 만료되었습니다. 학교에 새 링크를 요청하세요.',
  pageReplaced: '{school}에서 새 링크를 보냈습니다. 가장 최근 메시지를 사용하세요.', pageSigned: '{school}의 약관에 서명이 완료되었습니다. 감사합니다.',
  hello: '{name}님, 안녕하세요. {school}에서 회원 약관을 읽고 서명해 주시기를 요청합니다.', noAgreement: '{school}에 지금 서명할 약관이 없습니다.',
  nobody: '지금 서명할 사람이 없습니다.', language: '언어', forWhom: '서명 대상', fullName: '성명',
  esign: '전자 서명에 동의합니다. 이름을 입력하면 서명이 됩니다.', signButton: '서명', signing: '서명 중…',
  done: '서명되었습니다. 감사합니다. 이 페이지를 닫아도 됩니다.', changed: '학교에서 약관을 변경했습니다. 새 약관을 읽고 다시 서명하세요.',
  invalidSign: '이름을 확인하고, 자녀를 한 명 이상 선택하고, 상자에 체크하세요.', expires: '이 링크는 {date}까지 사용할 수 있습니다.',
};
const es: Partial<Copy> = {
  pageTitle: 'Acuerdo de membresía', pageLoading: 'Abriendo su acuerdo…', pageUnavailable: 'No se pudo abrir el acuerdo ahora. Inténtelo de nuevo en un momento.',
  pageGone: 'Este enlace no es válido. Pida uno nuevo a la escuela.', pageExpired: 'Este enlace de {school} venció. Pida uno nuevo a la escuela.',
  pageReplaced: '{school} envió un enlace más reciente. Use el mensaje más nuevo de la escuela.', pageSigned: 'Este acuerdo de {school} ya fue firmado. Gracias.',
  hello: 'Hola, {name}. {school} le pide leer y firmar su acuerdo de membresía.', noAgreement: '{school} no tiene un acuerdo para firmar ahora.',
  nobody: 'Nadie necesita firmar ahora.', language: 'Idioma', forWhom: 'Firmo por', fullName: 'Su nombre completo',
  esign: 'Acepto firmar electrónicamente. Escribir mi nombre es mi firma.', signButton: 'Firmar', signing: 'Firmando…',
  done: 'Firmado. Gracias. Puede cerrar esta página.', changed: 'La escuela cambió su acuerdo. Lea la nueva versión y firme de nuevo.',
  invalidSign: 'Revise su nombre, elija al menos un niño y marque la casilla.', expires: 'Este enlace funciona hasta el {date}.',
};
export type AgreementLinkKey = keyof typeof en;
export function agreementLinkText(language: string, key: AgreementLinkKey, vars?: Record<string, string>): string {
  const lang = language.toLowerCase().split('-')[0];
  const table = lang === 'ko' ? ko : lang === 'es' ? es : {};
  let s = (table as Partial<Copy>)[key] ?? en[key];
  for (const [k, v] of Object.entries(vars ?? {})) s = s.split(`{${k}}`).join(v);
  return s;
}
