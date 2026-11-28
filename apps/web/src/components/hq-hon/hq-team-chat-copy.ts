/** HQ team chat wording (en / ko / es). Labels only; nothing here is authority or an outcome. */
import type { Language } from '@hon/design-system';

const en = {
  title: 'Talk to your team', lead: 'Ask HON and your executives together, or one of them. Answers are suggestions from HQ numbers: nothing is sent, changed or charged.',
  everyone: 'Everyone', talkTo: 'Who to talk to', you: 'You', toEveryone: 'to everyone', to: 'to', asking: 'Asking {name}…', empty: 'Ask the whole team a question to start.',
  placeholder: 'Ask your team…', send: 'Send', tipAddress: 'Tip: start with a name ("Mia, …") or "Everyone, …".',
  loading: 'Loading the team chat…', unavailable: 'The team chat could not be read. Nothing is shown.', denied: 'Your HQ access does not include HQ Ask HON.',
  providerOff: "No AI text provider is connected, so the team can't answer yet.", noBudget: 'No HQ AI text budget is set for this month, so the team cannot answer yet.',
  retry: 'Retry', dismiss: 'Dismiss', refresh: 'Refresh', said: '{name} says:', notAnswered: '{name} did not answer.', hidden: 'Hidden: you no longer hold the access this answer used.',
  answering: 'Answering…', held: 'Held for HQ owner review.', failed: 'Not answered, not charged.',
  unknown: 'It is not known whether {name} received this. Retry sends the exact same question, never a second one.',
  refused: '{name} could not answer: {reason}', busyServer: 'three HQ questions are already answering. Try again in a moment.',
  roleHon: 'Executive AI coordinator', roleChase: 'Growth', roleMia: 'Customer success', roleEthan: 'Product', roleOlivia: 'Finance', roleRyan: 'Revenue', roleSophia: 'Operations',
};
export type HqTeamChatKey = keyof typeof en;
const ko: Record<HqTeamChatKey, string> = {
  title: '팀과 대화', lead: 'HON과 임원들에게 함께, 또는 한 명에게 물어보세요. 답은 HQ 숫자에 기반한 제안이며 아무것도 보내거나 바꾸거나 청구하지 않습니다.',
  everyone: '모두', talkTo: '대화 상대', you: '나', toEveryone: '모두에게', to: '받는 사람', asking: '{name}에게 묻는 중…', empty: '팀 전체에게 질문해 시작하세요.',
  placeholder: '팀에게 질문하기…', send: '보내기', tipAddress: '팁: 이름("Mia, …")이나 "모두, …"로 시작하세요.',
  loading: '팀 채팅을 불러오는 중…', unavailable: '팀 채팅을 읽을 수 없습니다. 아무것도 표시하지 않습니다.', denied: 'HQ 권한에 HQ Ask HON이 없습니다.',
  providerOff: 'AI 텍스트 제공자가 연결되지 않아 팀이 아직 답할 수 없습니다.', noBudget: '이번 달 HQ AI 텍스트 예산이 없어 팀이 아직 답할 수 없습니다.',
  retry: '다시 시도', dismiss: '닫기', refresh: '새로고침', said: '{name}:', notAnswered: '{name}이(가) 답하지 않았습니다.', hidden: '숨김: 이 답이 사용한 권한이 더 이상 없습니다.',
  answering: '답하는 중…', held: 'HQ 소유자 검토를 위해 보류됨.', failed: '답하지 않음, 청구 안 됨.',
  unknown: '{name}이(가) 받았는지 알 수 없습니다. 다시 시도하면 같은 질문을 그대로 보내며, 두 번 묻지 않습니다.',
  refused: '{name}이(가) 답할 수 없습니다: {reason}', busyServer: 'HQ 질문 세 개가 이미 답하는 중입니다. 잠시 후 다시 시도하세요.',
  roleHon: '임원 AI 코디네이터', roleChase: '성장', roleMia: '고객 성공', roleEthan: '제품', roleOlivia: '재무', roleRyan: '매출', roleSophia: '운영',
};
const es: Record<HqTeamChatKey, string> = {
  title: 'Habla con tu equipo', lead: 'Pregunta a HON y a tus ejecutivos juntos, o a uno. Las respuestas son sugerencias con números de HQ: nada se envía, cambia ni cobra.',
  everyone: 'Todos', talkTo: 'Con quién hablar', you: 'Tú', toEveryone: 'a todos', to: 'a', asking: 'Preguntando a {name}…', empty: 'Haz una pregunta a todo el equipo para empezar.',
  placeholder: 'Pregunta a tu equipo…', send: 'Enviar', tipAddress: 'Consejo: empieza con un nombre ("Mia, …") o "Todos, …".',
  loading: 'Cargando el chat del equipo…', unavailable: 'No se pudo leer el chat del equipo. No se muestra nada.', denied: 'Tu acceso a HQ no incluye HQ Ask HON.',
  providerOff: 'No hay un proveedor de texto con IA conectado, así que el equipo aún no puede responder.', noBudget: 'No hay presupuesto de texto con IA de HQ este mes, así que el equipo aún no puede responder.',
  retry: 'Reintentar', dismiss: 'Cerrar', refresh: 'Actualizar', said: '{name} dice:', notAnswered: '{name} no respondió.', hidden: 'Oculto: ya no tienes el acceso que usó esta respuesta.',
  answering: 'Respondiendo…', held: 'Retenida para revisión del dueño de HQ.', failed: 'Sin respuesta, sin cargo.',
  unknown: 'No se sabe si {name} recibió esto. Reintentar envía exactamente la misma pregunta, nunca una segunda.',
  refused: '{name} no pudo responder: {reason}', busyServer: 'ya hay tres preguntas de HQ respondiéndose. Inténtalo en un momento.',
  roleHon: 'Coordinador ejecutivo de IA', roleChase: 'Crecimiento', roleMia: 'Éxito del cliente', roleEthan: 'Producto', roleOlivia: 'Finanzas', roleRyan: 'Ingresos', roleSophia: 'Operaciones',
};
const TABLE: Readonly<Record<string, Record<HqTeamChatKey, string>>> = { en, ko, es };
export function hqTeamChatText(language: Language | string, key: HqTeamChatKey, values: Readonly<Record<string, string>> = {}): string {
  const text = (TABLE[language] ?? en)[key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? `{${k}}`);
}
