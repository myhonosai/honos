/** HQ Ask HON wording (en / ko / es). Labels only; nothing here is authority or an outcome. */
import type { Language } from '@hon/design-system';

const en = {
  askTitle: 'Ask {name}', askIntro: '{name} answers from aggregate HQ numbers only. No school, person or record is shown to the AI. Answers are suggestions: nothing is sent, changed or charged.',
  question: 'Your question', questionHelp: '1 to 2,000 characters.', mode: 'Answer length', STANDARD: 'Standard (10 credits)', DETAILED: 'Detailed (15 credits)',
  ask: 'Ask', asking: 'Asking…', loading: 'Reading HQ Ask HON…', unavailable: 'HQ Ask HON could not be read. Nothing is shown.',
  denied: 'Your HQ access does not include HQ Ask HON. Nothing is shown.',
  notYours: 'Your HQ access does not include {name}\'s area, so you cannot ask {name}. Ask HON instead, or ask the HQ owner.',
  providerOff: "No AI text provider is connected, so questions are turned off. Connecting a paid provider needs David's approval first.",
  budget: 'HQ AI text budget this month: {available} of {cap} credits available ({used} used, {held} held).', noBudget: 'No HQ AI text budget is set for this month. The HQ owner sets it first.',
  history: 'Your questions to {name}', none: 'No questions to {name} yet.', concealed: 'Hidden: you no longer hold the access this answer used.',
  truncated: 'The answer stopped at its length limit.', charged: '{n} credits',
  ANSWERING: 'Answering', ANSWERED: 'Answered', FAILED: 'Not answered, not charged', UNDER_REVIEW: 'Held for HQ owner review',
  RESOLVED_CHARGED: 'Resolved by the HQ owner, charged', RESOLVED_NOT_CHARGED: 'Resolved by the HQ owner, not charged',
  DONE: 'Answered.', REFUSED: 'Not asked: {reason}', UNKNOWN: 'We could not confirm the result. Refresh before asking again.', SESSION: 'Your session ended. Sign in again.',
  INVALID: 'Check the question and try again.', CHANGED: 'Another question is still in progress. Try again shortly.', KEY_REUSED: 'This attempt was already used. Refresh and ask again.',
  HQ_HON_PAUSED_BY_HQ: 'AI is paused platform-wide.', HQ_HON_NO_ELIGIBLE_ROUTE: 'No eligible AI model is available.', HQ_HON_BUDGET_NOT_SET: 'no budget is set this month.',
  HQ_HON_TOO_MANY_IN_PROGRESS: 'three questions are already in progress.', HQ_HON_BUDGET_EXHAUSTED: 'the monthly budget is used up.',
  HQ_HON_PROVIDER_NOT_CONNECTED: 'no AI provider is connected.', refresh: 'Refresh',
};
type Copy = typeof en;
const ko: Copy = {
  askTitle: '{name}에게 질문', askIntro: '{name}은(는) HQ 집계 수치만으로 답합니다. 학교, 사람, 기록은 AI에 보이지 않습니다. 답변은 제안일 뿐이며 아무것도 보내거나 바꾸거나 청구하지 않습니다.',
  question: '질문', questionHelp: '1~2,000자.', mode: '답변 길이', STANDARD: '기본 (10 크레딧)', DETAILED: '자세히 (15 크레딧)',
  ask: '질문하기', asking: '질문 중…', loading: 'HQ Ask HON을 읽는 중…', unavailable: 'HQ Ask HON을 읽을 수 없습니다. 아무것도 표시하지 않습니다.',
  denied: 'HQ 권한에 HQ Ask HON이 포함되어 있지 않습니다. 아무것도 표시하지 않습니다.',
  notYours: 'HQ 권한에 {name}의 영역이 없어 {name}에게 질문할 수 없습니다. HON에게 묻거나 HQ 소유자에게 문의하세요.',
  providerOff: 'AI 텍스트 제공자가 연결되지 않아 질문이 꺼져 있습니다. 유료 제공자 연결에는 David의 승인이 먼저 필요합니다.',
  budget: '이번 달 HQ AI 텍스트 예산: {cap} 크레딧 중 {available} 사용 가능 (사용 {used}, 보류 {held}).', noBudget: '이번 달 HQ AI 텍스트 예산이 없습니다. HQ 소유자가 먼저 설정합니다.',
  history: '{name}에게 한 질문', none: '{name}에게 한 질문이 아직 없습니다.', concealed: '숨김: 이 답변에 쓰인 권한이 더 이상 없습니다.',
  truncated: '답변이 길이 한도에서 멈췄습니다.', charged: '{n} 크레딧',
  ANSWERING: '답변 중', ANSWERED: '답변됨', FAILED: '답변 안 됨, 청구 없음', UNDER_REVIEW: 'HQ 소유자 검토 대기',
  RESOLVED_CHARGED: 'HQ 소유자 처리, 청구됨', RESOLVED_NOT_CHARGED: 'HQ 소유자 처리, 청구 없음',
  DONE: '답변되었습니다.', REFUSED: '질문하지 않음: {reason}', UNKNOWN: '결과를 확인할 수 없습니다. 다시 묻기 전에 새로고침하세요.', SESSION: '세션이 끝났습니다. 다시 로그인하세요.',
  INVALID: '질문을 확인하고 다시 시도하세요.', CHANGED: '다른 질문이 아직 진행 중입니다. 잠시 후 다시 시도하세요.', KEY_REUSED: '이미 사용된 시도입니다. 새로고침 후 다시 질문하세요.',
  HQ_HON_PAUSED_BY_HQ: 'AI가 플랫폼 전체에서 일시 중지되었습니다.', HQ_HON_NO_ELIGIBLE_ROUTE: '사용할 수 있는 AI 모델이 없습니다.', HQ_HON_BUDGET_NOT_SET: '이번 달 예산이 없습니다.',
  HQ_HON_TOO_MANY_IN_PROGRESS: '이미 세 개의 질문이 진행 중입니다.', HQ_HON_BUDGET_EXHAUSTED: '월 예산을 다 썼습니다.',
  HQ_HON_PROVIDER_NOT_CONNECTED: 'AI 제공자가 연결되지 않았습니다.', refresh: '새로고침',
};
const es: Copy = {
  askTitle: 'Preguntar a {name}', askIntro: '{name} responde solo con cifras agregadas de HQ. La IA no ve ninguna escuela, persona ni registro. Las respuestas son sugerencias: no se envía, cambia ni cobra nada.',
  question: 'Tu pregunta', questionHelp: 'De 1 a 2.000 caracteres.', mode: 'Extensión de la respuesta', STANDARD: 'Estándar (10 créditos)', DETAILED: 'Detallada (15 créditos)',
  ask: 'Preguntar', asking: 'Preguntando…', loading: 'Leyendo HQ Ask HON…', unavailable: 'No se pudo leer HQ Ask HON. No se muestra nada.',
  denied: 'Tu acceso de HQ no incluye HQ Ask HON. No se muestra nada.',
  notYours: 'Tu acceso de HQ no incluye el área de {name}, así que no puedes preguntarle. Pregunta a HON o al propietario de HQ.',
  providerOff: 'No hay un proveedor de texto de IA conectado, así que las preguntas están desactivadas. Conectar un proveedor de pago requiere primero la aprobación de David.',
  budget: 'Presupuesto de texto de IA de HQ este mes: {available} de {cap} créditos disponibles ({used} usados, {held} retenidos).', noBudget: 'No hay presupuesto de texto de IA de HQ este mes. El propietario de HQ lo fija primero.',
  history: 'Tus preguntas a {name}', none: 'Aún no hay preguntas a {name}.', concealed: 'Oculta: ya no tienes el acceso que usó esta respuesta.',
  truncated: 'La respuesta se detuvo en su límite de extensión.', charged: '{n} créditos',
  ANSWERING: 'Respondiendo', ANSWERED: 'Respondida', FAILED: 'Sin respuesta, sin cobro', UNDER_REVIEW: 'Retenida para revisión del propietario de HQ',
  RESOLVED_CHARGED: 'Resuelta por el propietario de HQ, cobrada', RESOLVED_NOT_CHARGED: 'Resuelta por el propietario de HQ, sin cobro',
  DONE: 'Respondida.', REFUSED: 'No se preguntó: {reason}', UNKNOWN: 'No pudimos confirmar el resultado. Actualiza antes de volver a preguntar.', SESSION: 'Tu sesión terminó. Vuelve a iniciar sesión.',
  INVALID: 'Revisa la pregunta e inténtalo de nuevo.', CHANGED: 'Otra pregunta sigue en curso. Inténtalo en un momento.', KEY_REUSED: 'Este intento ya se usó. Actualiza y vuelve a preguntar.',
  HQ_HON_PAUSED_BY_HQ: 'la IA está en pausa en toda la plataforma.', HQ_HON_NO_ELIGIBLE_ROUTE: 'no hay un modelo de IA disponible.', HQ_HON_BUDGET_NOT_SET: 'no hay presupuesto este mes.',
  HQ_HON_TOO_MANY_IN_PROGRESS: 'ya hay tres preguntas en curso.', HQ_HON_BUDGET_EXHAUSTED: 'el presupuesto mensual se agotó.',
  HQ_HON_PROVIDER_NOT_CONNECTED: 'no hay un proveedor de IA conectado.', refresh: 'Actualizar',
};
const COPY: Readonly<Record<Language, Copy>> = { en, ko, es } as Readonly<Record<Language, Copy>>;
export type HqHonCopyKey = keyof Copy;
export function hqHonText(language: Language, key: HqHonCopyKey, params: Readonly<Record<string, string | number>> = {}): string {
  const table = COPY[language] ?? en;
  return (table[key] ?? en[key]).replace(/\{(\w+)\}/g, (_, k: string) => (Object.hasOwn(params, k) ? String(params[k]) : `{${k}}`));
}
export const HQ_HON_COPY_TABLES = { en, ko, es };
