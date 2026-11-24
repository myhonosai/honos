/** Team chat words in English, Korean and Spanish. Names stay as they are in every language. */
export type TeamChatKey =
  | 'title' | 'lead' | 'everyone' | 'talkTo' | 'talks' | 'throughHon' | 'notAvailable' | 'placeholder' | 'send' | 'newChat' | 'plan' | 'planHelp'
  | 'you' | 'toEveryone' | 'to' | 'asking' | 'waiting' | 'loading' | 'unavailable' | 'session' | 'forbidden' | 'concealed' | 'notReady'
  | 'empty' | 'retry' | 'dismiss' | 'unknown' | 'refused' | 'hidden' | 'notAnswered' | 'said' | 'planLabel' | 'help' | 'tipAddress'
  | 'whoMarcus' | 'whoChad' | 'whoMaya' | 'whoKai' | 'roleHon' | 'roleClaire' | 'roleAlex' | 'roleJordan' | 'roleLena' | 'roleMarcus' | 'roleChad'
  | 'roleMaya' | 'roleKai' | 'open' | 'included'
  | 'voicesTitle' | 'voicesLead' | 'voicesLoading' | 'voicesUnavailable' | 'voiceFor' | 'hearVoice' | 'voiceSaving' | 'voiceNotSaved' | 'voicesFree'
  | 'voicesNoSpeech' | 'voiceSample' | 'voice_standard' | 'voice_warm' | 'voice_bright' | 'voice_deep' | 'voice_calm' | 'voice_lively';

const EN: Record<TeamChatKey, string> = {
  title: 'Team chat', lead: 'Talk to the whole AI team at once, or one teammate at a time as the topic changes. Then make one plan together.',
  everyone: 'Everyone', talkTo: 'Talk to', talks: 'Can chat', throughHon: 'Not in chat yet', notAvailable: 'Not for your role',
  placeholder: 'Ask the team… start with @Jordan to ask one teammate', send: 'Send', newChat: 'New team chat',
  plan: 'Make a plan together', planHelp: 'HON combines what everyone said into one plan with steps and who each point comes from.',
  you: 'You', toEveryone: 'to everyone', to: 'to', asking: 'Asking {name}…', waiting: 'Waiting for the team…', loading: 'Loading the team chat…',
  unavailable: 'The team chat could not be loaded right now. Nothing is shown in its place.', session: 'Your session ended. Sign in again.',
  forbidden: 'This account cannot use the AI team at this school.', concealed: 'Hidden while you were away. Open it again to continue.',
  notReady: 'The AI team cannot answer right now (not active for this school, paused by HON HQ, or this month’s included limit is reached). Nothing is charged.',
  empty: 'No messages yet. Ask something like “What should we focus on this week?”', retry: 'Retry', dismiss: 'Dismiss',
  unknown: 'It is not known whether {name} received this. Retry sends the exact same message and cannot create a second answer.',
  refused: '{name} could not take this message. Nothing was sent.', hidden: 'This answer is hidden because access changed. It shows again once access returns.',
  notAnswered: '{name} could not answer this one. Nothing is charged.', said: '{name} says:', planLabel: 'Team plan',
  help: 'Every message goes through the same checks as Ask HON. The team only reads and suggests; nothing is sent, scheduled or changed. Included in HON OS; nothing is charged per message.',
  tipAddress: 'Tip: start with a name (“Jordan, …” or “@Lena …”) to ask one teammate, or “Everyone, …” for the whole team.',
  whoMarcus: 'Marcus writes campaign drafts. Ask HON and confirm Marcus when HON suggests him.', whoChad: 'Chad writes follow-up drafts for one lead. Ask HON and confirm Chad when HON suggests him.',
  whoMaya: 'Maya answers about one student on the At-risk list. Open Retention to ask her.', whoKai: 'Kai prepares classes from your curriculum. Open Teaching to ask Kai.',
  roleHon: 'Your assistant', roleClaire: 'Business performance', roleAlex: 'General management', roleJordan: 'Operations', roleLena: 'Creative & commerce',
  roleMarcus: 'Marketing', roleChad: 'Enrollment', roleMaya: 'Retention', roleKai: 'Teaching', open: 'Open', included: 'Included in HON OS',
  voicesTitle: 'Choose voices', voicesLead: 'Pick how each teammate sounds. Tap ▶ to hear a voice first. Your choice is saved to your account for this school.',
  voicesLoading: 'Loading your voices…', voicesUnavailable: 'Your saved voices could not be loaded. Everyone uses their usual voice for now.',
  voiceFor: 'Voice for {name}', hearVoice: 'Hear {name} in the {voice} voice', voiceSaving: 'Saving…', voiceNotSaved: 'Not saved. The previous voice is back; try again.',
  voicesFree: 'These are your device’s own free voices, so they sound different on each phone or computer. Nothing is charged.',
  voicesNoSpeech: 'This browser cannot speak, so voices cannot be heard here. Your choices still apply on devices that can.',
  voiceSample: 'Hi, I’m {name}. This is how I will sound when I answer you.',
  voice_standard: 'Usual', voice_warm: 'Warm', voice_bright: 'Bright', voice_deep: 'Deep', voice_calm: 'Calm', voice_lively: 'Lively',
};
const KO: Record<TeamChatKey, string> = {
  title: '팀 채팅', lead: 'AI 팀 전체와 한 번에 이야기하거나, 주제가 바뀔 때마다 한 명씩 이야기하세요. 그리고 함께 하나의 계획을 만드세요.',
  everyone: '모두', talkTo: '대화 상대', talks: '채팅 가능', throughHon: '아직 채팅 전', notAvailable: '내 역할로는 사용 불가',
  placeholder: '팀에게 물어보세요… 한 명에게 물으려면 @Jordan 으로 시작', send: '보내기', newChat: '새 팀 채팅',
  plan: '함께 계획 만들기', planHelp: 'HON이 모두의 의견을 단계와 출처가 있는 하나의 계획으로 정리합니다.',
  you: '나', toEveryone: '모두에게', to: '받는 사람', asking: '{name}에게 묻는 중…', waiting: '팀을 기다리는 중…', loading: '팀 채팅을 불러오는 중…',
  unavailable: '지금은 팀 채팅을 불러올 수 없습니다. 대신 표시되는 내용은 없습니다.', session: '세션이 종료되었습니다. 다시 로그인하세요.',
  forbidden: '이 계정은 이 학교에서 AI 팀을 사용할 수 없습니다.', concealed: '자리를 비운 동안 숨겨졌습니다. 다시 열어 계속하세요.',
  notReady: '지금은 AI 팀이 답할 수 없습니다(이 학교에서 비활성, HON HQ 일시 중지 또는 이번 달 포함 한도 도달). 요금은 없습니다.',
  empty: '아직 메시지가 없습니다. “이번 주에 무엇에 집중할까요?” 처럼 물어보세요.', retry: '다시 시도', dismiss: '닫기',
  unknown: '{name}이(가) 받았는지 알 수 없습니다. 다시 시도하면 같은 메시지를 보내며 두 번째 답이 생기지 않습니다.',
  refused: '{name}이(가) 이 메시지를 받을 수 없습니다. 아무것도 보내지 않았습니다.', hidden: '접근 권한이 바뀌어 이 답은 숨겨졌습니다. 권한이 돌아오면 다시 보입니다.',
  notAnswered: '{name}이(가) 이번에는 답하지 못했습니다. 요금은 없습니다.', said: '{name}:', planLabel: '팀 계획',
  help: '모든 메시지는 HON에게 묻기와 같은 확인을 거칩니다. 팀은 읽고 제안만 하며, 보내거나 예약하거나 바꾸지 않습니다. HON OS에 포함되어 메시지당 요금이 없습니다.',
  tipAddress: '팁: 이름으로 시작하면(“Jordan, …” 또는 “@Lena …”) 한 명에게, “모두, …”로 시작하면 팀 전체에게 묻습니다.',
  whoMarcus: 'Marcus는 캠페인 초안을 씁니다. HON에게 묻고 HON이 제안하면 Marcus를 확인하세요.', whoChad: 'Chad는 리드 한 명의 후속 연락 초안을 씁니다. HON에게 묻고 HON이 제안하면 Chad를 확인하세요.',
  whoMaya: 'Maya는 위험 목록의 학생 한 명에 대해 답합니다. 유지 관리에서 물어보세요.', whoKai: 'Kai는 커리큘럼으로 수업을 준비합니다. 교육에서 Kai에게 물어보세요.',
  roleHon: '나의 비서', roleClaire: '사업 성과', roleAlex: '총괄 관리', roleJordan: '운영', roleLena: '크리에이티브 & 커머스',
  roleMarcus: '마케팅', roleChad: '등록', roleMaya: '유지', roleKai: '교육', open: '열기', included: 'HON OS에 포함',
  voicesTitle: '목소리 선택', voicesLead: '팀원마다 목소리를 고르세요. ▶를 눌러 먼저 들어 보세요. 선택은 이 학교의 내 계정에 저장됩니다.',
  voicesLoading: '목소리를 불러오는 중…', voicesUnavailable: '저장된 목소리를 불러올 수 없습니다. 지금은 모두 기본 목소리를 사용합니다.',
  voiceFor: '{name}의 목소리', hearVoice: '{name}의 {voice} 목소리 듣기', voiceSaving: '저장 중…', voiceNotSaved: '저장되지 않았습니다. 이전 목소리로 돌아갔습니다. 다시 시도하세요.',
  voicesFree: '기기에 있는 무료 목소리라서 휴대폰이나 컴퓨터마다 다르게 들립니다. 요금은 없습니다.',
  voicesNoSpeech: '이 브라우저는 말할 수 없어 여기서는 들을 수 없습니다. 선택은 말할 수 있는 기기에서 적용됩니다.',
  voiceSample: '안녕하세요, {name}입니다. 답할 때 이렇게 들립니다.',
  voice_standard: '기본', voice_warm: '따뜻한', voice_bright: '밝은', voice_deep: '낮은', voice_calm: '차분한', voice_lively: '활기찬',
};
const ES: Record<TeamChatKey, string> = {
  title: 'Chat del equipo', lead: 'Habla con todo el equipo de IA a la vez, o con uno a la vez según cambie el tema. Luego hagan un plan juntos.',
  everyone: 'Todos', talkTo: 'Hablar con', talks: 'Puede chatear', throughHon: 'Aún no en el chat', notAvailable: 'No para tu rol',
  placeholder: 'Pregunta al equipo… empieza con @Jordan para preguntar a uno', send: 'Enviar', newChat: 'Nuevo chat del equipo',
  plan: 'Hacer un plan juntos', planHelp: 'HON combina lo que dijo cada uno en un plan con pasos y de quién viene cada punto.',
  you: 'Tú', toEveryone: 'a todos', to: 'a', asking: 'Preguntando a {name}…', waiting: 'Esperando al equipo…', loading: 'Cargando el chat del equipo…',
  unavailable: 'No se pudo cargar el chat del equipo ahora. No se muestra nada en su lugar.', session: 'Tu sesión terminó. Inicia sesión de nuevo.',
  forbidden: 'Esta cuenta no puede usar el equipo de IA en esta escuela.', concealed: 'Oculto mientras no estabas. Ábrelo de nuevo para continuar.',
  notReady: 'El equipo de IA no puede responder ahora (no está activo para esta escuela, está en pausa por HON HQ o se alcanzó el límite incluido del mes). No se cobra nada.',
  empty: 'Aún no hay mensajes. Pregunta algo como “¿En qué nos enfocamos esta semana?”', retry: 'Reintentar', dismiss: 'Cerrar',
  unknown: 'No se sabe si {name} recibió esto. Reintentar envía exactamente el mismo mensaje y no puede crear una segunda respuesta.',
  refused: '{name} no pudo aceptar este mensaje. No se envió nada.', hidden: 'Esta respuesta está oculta porque cambió el acceso. Se mostrará cuando vuelva el acceso.',
  notAnswered: '{name} no pudo responder esta vez. No se cobra nada.', said: '{name} dice:', planLabel: 'Plan del equipo',
  help: 'Cada mensaje pasa por los mismos controles que Pregúntale a HON. El equipo solo lee y sugiere; no se envía, programa ni cambia nada. Incluido en HON OS; no se cobra por mensaje.',
  tipAddress: 'Consejo: empieza con un nombre (“Jordan, …” o “@Lena …”) para preguntar a uno, o “Todos, …” para todo el equipo.',
  whoMarcus: 'Marcus escribe borradores de campañas. Pregunta a HON y confirma a Marcus cuando HON lo sugiera.', whoChad: 'Chad escribe borradores de seguimiento para un prospecto. Pregunta a HON y confirma a Chad cuando HON lo sugiera.',
  whoMaya: 'Maya responde sobre un alumno de la lista en riesgo. Abre Retención para preguntarle.', whoKai: 'Kai prepara clases con tu currículo. Abre Enseñanza para preguntarle.',
  roleHon: 'Tu asistente', roleClaire: 'Rendimiento del negocio', roleAlex: 'Gerencia general', roleJordan: 'Operaciones', roleLena: 'Creatividad y comercio',
  roleMarcus: 'Marketing', roleChad: 'Inscripciones', roleMaya: 'Retención', roleKai: 'Enseñanza', open: 'Abrir', included: 'Incluido en HON OS',
  voicesTitle: 'Elegir voces', voicesLead: 'Elige cómo suena cada miembro del equipo. Toca ▶ para escuchar una voz primero. Tu elección se guarda en tu cuenta para esta escuela.',
  voicesLoading: 'Cargando tus voces…', voicesUnavailable: 'No se pudieron cargar tus voces guardadas. Por ahora todos usan su voz habitual.',
  voiceFor: 'Voz de {name}', hearVoice: 'Escuchar a {name} con la voz {voice}', voiceSaving: 'Guardando…', voiceNotSaved: 'No se guardó. Volvió la voz anterior; inténtalo de nuevo.',
  voicesFree: 'Son las voces gratuitas de tu dispositivo, así que suenan distinto en cada teléfono o computadora. No se cobra nada.',
  voicesNoSpeech: 'Este navegador no puede hablar, así que aquí no se pueden escuchar las voces. Tus elecciones se aplican en dispositivos que sí pueden.',
  voiceSample: 'Hola, soy {name}. Así sonaré cuando te responda.',
  voice_standard: 'Habitual', voice_warm: 'Cálida', voice_bright: 'Clara', voice_deep: 'Grave', voice_calm: 'Tranquila', voice_lively: 'Animada',
};
const TABLE: Record<string, Record<TeamChatKey, string>> = { en: EN, ko: KO, es: ES };

export function teamChatText(language: string | null | undefined, key: TeamChatKey, values: Record<string, string> = {}): string {
  const base = (language ?? '').slice(0, 2).toLowerCase();
  const text = (TABLE[base] ?? EN)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '');
}
