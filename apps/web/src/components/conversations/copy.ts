import type { Language } from '@hon/design-system';
import type { ConversationDeliveryState } from '@hon/contracts';

export type ConversationsCopy = {
  title: string; intro: string; chooseSchool: string; loading: string; hidden: string; show: string; refresh: string;
  deniedTitle: string; denied: string; sessionEnded: string; unavailable: string; unknownSend: string; unknownUpdate: string;
  inbox: string; unread: (n: number) => string; empty: string; emptyFiltered: string; more: string;
  filterStatus: string; statusOpen: string; statusClosed: string; statusAll: string; unreadOnly: string; search: string; searchHint: string; apply: string;
  unknownContact: string; theyWrote: string; youReplied: string; media: (n: number) => string; closedBadge: string; newBadge: (n: number) => string;
  thread: (name: string) => string; older: string; contact: string; staff: string; you: string;
  person: string; noPerson: string; twoPeople: (n: number) => string; lead: string; noLead: string; appointment: string; noAppointment: string;
  consent: string; consentIn: string; consentOut: string; consentNone: string; noSender: string; openLeads: string; openPeople: string;
  markRead: (n: number) => string; markedRead: string; close: string; reopen: string; closed: string; reopened: string;
  tags: string; tagsHint: string; saveTags: string; tagsSaved: string;
  reply: (name: string) => string; replyHint: string; send: string; sending: string; queued: string; cannotReply: string; readOnly: string;
  counter: (n: number, max: number) => string;
  delivery: Record<ConversationDeliveryState, string>;
  refusal: Record<string, string>;
};

const en: ConversationsCopy = {
  title: 'Conversations', chooseSchool: 'Choose a school to see its conversations.',
  intro: 'Texts people send to your school number. Replies go out from the school number through HON’s delivery queue, which checks texting consent, quiet hours and the number again before sending.',
  loading: 'Loading conversations…', hidden: 'Conversations are hidden.', show: 'Show conversations', refresh: 'Refresh',
  deniedTitle: 'Not available for your role', denied: 'You need the conversations permission at this school.', sessionEnded: 'Your session has ended. Sign in again.',
  unavailable: 'Conversations are unavailable right now. Try again in a moment.',
  unknownSend: 'We could not confirm the reply. It may or may not be queued. Refresh before sending again; sending the same text again will not send it twice.',
  unknownUpdate: 'We could not confirm the change. It may have been saved. Refresh to see the current state.',
  inbox: 'Inbox', unread: n => (n === 1 ? '1 unread' : `${n} unread`), empty: 'No one has texted the school number yet.', emptyFiltered: 'No conversations match these filters.', more: 'Show more',
  filterStatus: 'Status', statusOpen: 'Open', statusClosed: 'Closed', statusAll: 'All', unreadOnly: 'Unread only', search: 'Search', searchHint: 'Name, number or tag', apply: 'Apply',
  unknownContact: 'Unknown number', theyWrote: 'They wrote', youReplied: 'School replied', media: n => (n === 1 ? '1 picture' : `${n} pictures`), closedBadge: 'Closed', newBadge: n => `${n} new`,
  thread: name => `Conversation with ${name}`, older: 'Show earlier messages', contact: 'Contact', staff: 'School staff', you: 'You',
  person: 'Person', noPerson: 'Not linked to a person yet.', twoPeople: n => `${n} people at this school have this number, so HON did not pick one.`,
  lead: 'Lead', noLead: 'No open lead.', appointment: 'Next appointment', noAppointment: 'None booked.',
  consent: 'Texting consent', consentIn: 'Agreed to texts', consentOut: 'Opted out', consentNone: 'Not recorded', noSender: 'This school has no active texting number yet.',
  openLeads: 'Open Leads', openPeople: 'Open People',
  markRead: n => `Mark read (${n} new)`, markedRead: 'Marked read.', close: 'Close conversation', reopen: 'Reopen', closed: 'Conversation closed.', reopened: 'Conversation reopened.',
  tags: 'Tags', tagsHint: 'Up to 10, separated by commas', saveTags: 'Save tags', tagsSaved: 'Tags saved.',
  reply: name => `Reply to ${name}`, replyHint: 'Plain text, up to 1,600 characters. Long texts go out in several parts.', send: 'Send reply', sending: 'Sending…',
  queued: 'Reply queued. It is sent from the school number once the delivery checks pass.',
  cannotReply: 'Replies need a linked person who agreed to texts and an active school number.', readOnly: 'You can read conversations. Changing them needs the manage permission.',
  counter: (n, max) => `${n} / ${max}`,
  delivery: { QUEUED: 'Queued', CANCELLED: 'Cancelled', PENDING: 'Waiting to send', SENDING: 'Sending', ACCEPTED: 'Sent', DELIVERED: 'Delivered', BOUNCED: 'Not delivered', FAILED: 'Failed', SUPPRESSED: 'Not sent (opted out or quiet hours)', UNKNOWN: 'Unknown' },
  refusal: {
    VALIDATION_FAILED: 'That was not accepted. Replies are plain text of 1 to 1,600 characters; tags are letters, numbers, spaces or dashes.',
    CONVERSATION_NOT_FOUND: 'That conversation is not available.', CONVERSATION_VERSION_CONFLICT: 'The conversation changed. It has been reloaded; try again.',
    IDEMPOTENCY_KEY_REUSED: 'This could not be matched to the earlier attempt. Refresh and try again.',
    CONVERSATION_NOT_LINKED: 'Link this conversation to a person, or create a lead from it, before replying.',
    CONVERSATION_ADDRESS_MISMATCH: 'The linked person’s mobile number is not this conversation’s number.',
    CONVERSATION_NO_SENDER: 'This school has no active texting number yet.',
    CONVERSATION_CONSENT_REQUIRED: 'This person has not agreed to receive texts from the school. Record their texting consent first.',
    CONVERSATION_CHANNEL_UNSUPPORTED: 'Replies on this channel are not available yet.',
    CONVERSATION_ASSIGNEE_INVALID: 'That staff member cannot see conversations at this school.',
    CONVERSATION_LINK_INVALID: 'That person or lead does not belong to this conversation’s number at this school.',
    CONVERSATION_ALREADY_LINKED: 'This conversation is already linked to a person.',
    CONVERSATION_PIPELINE_INVALID: 'Choose an open stage of one of this school’s pipelines.',
  },
};

const ko: ConversationsCopy = {
  title: '대화', chooseSchool: '대화를 보려면 학교를 선택하세요.',
  intro: '학교 번호로 받은 문자입니다. 답장은 HON 발송 대기열을 거쳐 학교 번호로 나가며, 보내기 전에 문자 수신 동의, 조용한 시간, 번호를 다시 확인합니다.',
  loading: '대화를 불러오는 중…', hidden: '대화가 숨겨져 있습니다.', show: '대화 보기', refresh: '새로고침',
  deniedTitle: '현재 역할로는 사용할 수 없습니다', denied: '이 학교의 대화 권한이 필요합니다.', sessionEnded: '세션이 끝났습니다. 다시 로그인하세요.',
  unavailable: '지금은 대화를 불러올 수 없습니다. 잠시 후 다시 시도하세요.',
  unknownSend: '답장을 확인하지 못했습니다. 대기열에 들어갔는지 알 수 없습니다. 다시 보내기 전에 새로고침하세요. 같은 내용을 다시 보내도 두 번 발송되지 않습니다.',
  unknownUpdate: '변경 사항을 확인하지 못했습니다. 저장되었을 수 있습니다. 새로고침하여 현재 상태를 확인하세요.',
  inbox: '받은 대화', unread: n => `읽지 않음 ${n}`, empty: '아직 학교 번호로 문자를 보낸 사람이 없습니다.', emptyFiltered: '조건에 맞는 대화가 없습니다.', more: '더 보기',
  filterStatus: '상태', statusOpen: '진행 중', statusClosed: '종료', statusAll: '전체', unreadOnly: '읽지 않은 대화만', search: '검색', searchHint: '이름, 번호 또는 태그', apply: '적용',
  unknownContact: '알 수 없는 번호', theyWrote: '받은 문자', youReplied: '학교 답장', media: n => `사진 ${n}장`, closedBadge: '종료', newBadge: n => `새 문자 ${n}`,
  thread: name => `${name} 님과의 대화`, older: '이전 메시지 보기', contact: '연락처', staff: '학교 직원', you: '나',
  person: '사람', noPerson: '아직 연결된 사람이 없습니다.', twoPeople: n => `이 학교에 이 번호를 가진 사람이 ${n}명이라 HON이 한 명을 고르지 않았습니다.`,
  lead: '리드', noLead: '진행 중인 리드가 없습니다.', appointment: '다음 예약', noAppointment: '예약 없음.',
  consent: '문자 수신 동의', consentIn: '문자 수신 동의함', consentOut: '수신 거부', consentNone: '기록 없음', noSender: '이 학교에는 아직 사용 중인 문자 번호가 없습니다.',
  openLeads: '리드 열기', openPeople: '사람 열기',
  markRead: n => `읽음으로 표시 (새 문자 ${n})`, markedRead: '읽음으로 표시했습니다.', close: '대화 종료', reopen: '다시 열기', closed: '대화를 종료했습니다.', reopened: '대화를 다시 열었습니다.',
  tags: '태그', tagsHint: '쉼표로 구분, 최대 10개', saveTags: '태그 저장', tagsSaved: '태그를 저장했습니다.',
  reply: name => `${name} 님에게 답장`, replyHint: '일반 텍스트, 최대 1,600자. 긴 문자는 여러 개로 나뉘어 발송됩니다.', send: '답장 보내기', sending: '보내는 중…',
  queued: '답장이 대기열에 들어갔습니다. 발송 확인을 통과하면 학교 번호로 보내집니다.',
  cannotReply: '답장하려면 문자 수신에 동의한 연결된 사람과 사용 중인 학교 번호가 필요합니다.', readOnly: '대화를 볼 수 있습니다. 변경하려면 관리 권한이 필요합니다.',
  counter: (n, max) => `${n} / ${max}`,
  delivery: { QUEUED: '대기 중', CANCELLED: '취소됨', PENDING: '발송 대기', SENDING: '보내는 중', ACCEPTED: '보냄', DELIVERED: '전달됨', BOUNCED: '전달 안 됨', FAILED: '실패', SUPPRESSED: '보내지 않음 (수신 거부 또는 조용한 시간)', UNKNOWN: '알 수 없음' },
  refusal: {
    VALIDATION_FAILED: '받아들여지지 않았습니다. 답장은 1~1,600자의 일반 텍스트이고, 태그는 글자, 숫자, 공백, 하이픈만 쓸 수 있습니다.',
    CONVERSATION_NOT_FOUND: '이 대화를 사용할 수 없습니다.', CONVERSATION_VERSION_CONFLICT: '대화가 바뀌어 다시 불러왔습니다. 다시 시도하세요.',
    IDEMPOTENCY_KEY_REUSED: '이전 시도와 맞출 수 없습니다. 새로고침 후 다시 시도하세요.',
    CONVERSATION_NOT_LINKED: '답장하기 전에 이 대화를 사람과 연결하거나 리드를 만드세요.',
    CONVERSATION_ADDRESS_MISMATCH: '연결된 사람의 휴대폰 번호가 이 대화의 번호와 다릅니다.',
    CONVERSATION_NO_SENDER: '이 학교에는 아직 사용 중인 문자 번호가 없습니다.',
    CONVERSATION_CONSENT_REQUIRED: '이 사람은 학교 문자 수신에 동의하지 않았습니다. 먼저 문자 수신 동의를 기록하세요.',
    CONVERSATION_CHANNEL_UNSUPPORTED: '이 채널의 답장은 아직 지원되지 않습니다.',
    CONVERSATION_ASSIGNEE_INVALID: '그 직원은 이 학교의 대화를 볼 수 없습니다.',
    CONVERSATION_LINK_INVALID: '그 사람이나 리드는 이 학교에서 이 대화의 번호와 맞지 않습니다.',
    CONVERSATION_ALREADY_LINKED: '이 대화는 이미 사람과 연결되어 있습니다.',
    CONVERSATION_PIPELINE_INVALID: '이 학교 파이프라인의 진행 중인 단계를 고르세요.',
  },
};

const es: ConversationsCopy = {
  title: 'Conversaciones', chooseSchool: 'Elige una escuela para ver sus conversaciones.',
  intro: 'Mensajes de texto que la gente envía al número de tu escuela. Las respuestas salen desde el número de la escuela por la cola de envío de HON, que vuelve a revisar el consentimiento, el horario de silencio y el número antes de enviar.',
  loading: 'Cargando conversaciones…', hidden: 'Las conversaciones están ocultas.', show: 'Mostrar conversaciones', refresh: 'Actualizar',
  deniedTitle: 'No disponible para tu función', denied: 'Necesitas el permiso de conversaciones en esta escuela.', sessionEnded: 'Tu sesión terminó. Inicia sesión otra vez.',
  unavailable: 'Las conversaciones no están disponibles ahora. Inténtalo de nuevo en un momento.',
  unknownSend: 'No pudimos confirmar la respuesta. Puede que esté o no en la cola. Actualiza antes de enviarla otra vez; enviar el mismo texto otra vez no la enviará dos veces.',
  unknownUpdate: 'No pudimos confirmar el cambio. Puede que se haya guardado. Actualiza para ver el estado actual.',
  inbox: 'Bandeja', unread: n => (n === 1 ? '1 sin leer' : `${n} sin leer`), empty: 'Nadie ha escrito todavía al número de la escuela.', emptyFiltered: 'Ninguna conversación coincide con estos filtros.', more: 'Mostrar más',
  filterStatus: 'Estado', statusOpen: 'Abiertas', statusClosed: 'Cerradas', statusAll: 'Todas', unreadOnly: 'Solo sin leer', search: 'Buscar', searchHint: 'Nombre, número o etiqueta', apply: 'Aplicar',
  unknownContact: 'Número desconocido', theyWrote: 'Escribió', youReplied: 'La escuela respondió', media: n => (n === 1 ? '1 imagen' : `${n} imágenes`), closedBadge: 'Cerrada', newBadge: n => `${n} nuevos`,
  thread: name => `Conversación con ${name}`, older: 'Mostrar mensajes anteriores', contact: 'Contacto', staff: 'Personal de la escuela', you: 'Tú',
  person: 'Persona', noPerson: 'Todavía no está vinculada a una persona.', twoPeople: n => `${n} personas de esta escuela tienen este número, así que HON no eligió a ninguna.`,
  lead: 'Prospecto', noLead: 'Ningún prospecto abierto.', appointment: 'Próxima cita', noAppointment: 'Ninguna reservada.',
  consent: 'Consentimiento de textos', consentIn: 'Aceptó recibir textos', consentOut: 'Se dio de baja', consentNone: 'No registrado', noSender: 'Esta escuela todavía no tiene un número de texto activo.',
  openLeads: 'Abrir Prospectos', openPeople: 'Abrir Personas',
  markRead: n => `Marcar como leída (${n} nuevos)`, markedRead: 'Marcada como leída.', close: 'Cerrar conversación', reopen: 'Reabrir', closed: 'Conversación cerrada.', reopened: 'Conversación reabierta.',
  tags: 'Etiquetas', tagsHint: 'Hasta 10, separadas por comas', saveTags: 'Guardar etiquetas', tagsSaved: 'Etiquetas guardadas.',
  reply: name => `Responder a ${name}`, replyHint: 'Texto simple, hasta 1,600 caracteres. Los textos largos salen en varias partes.', send: 'Enviar respuesta', sending: 'Enviando…',
  queued: 'Respuesta en cola. Se envía desde el número de la escuela cuando pasan las revisiones de envío.',
  cannotReply: 'Para responder hace falta una persona vinculada que aceptó recibir textos y un número de escuela activo.', readOnly: 'Puedes leer las conversaciones. Para cambiarlas necesitas el permiso de gestión.',
  counter: (n, max) => `${n} / ${max}`,
  delivery: { QUEUED: 'En cola', CANCELLED: 'Cancelado', PENDING: 'Esperando envío', SENDING: 'Enviando', ACCEPTED: 'Enviado', DELIVERED: 'Entregado', BOUNCED: 'No entregado', FAILED: 'Falló', SUPPRESSED: 'No enviado (baja u horario de silencio)', UNKNOWN: 'Desconocido' },
  refusal: {
    VALIDATION_FAILED: 'No se aceptó. Las respuestas son texto simple de 1 a 1,600 caracteres; las etiquetas usan letras, números, espacios o guiones.',
    CONVERSATION_NOT_FOUND: 'Esa conversación no está disponible.', CONVERSATION_VERSION_CONFLICT: 'La conversación cambió y se volvió a cargar. Inténtalo otra vez.',
    IDEMPOTENCY_KEY_REUSED: 'No se pudo relacionar con el intento anterior. Actualiza e inténtalo otra vez.',
    CONVERSATION_NOT_LINKED: 'Vincula esta conversación a una persona, o crea un prospecto con ella, antes de responder.',
    CONVERSATION_ADDRESS_MISMATCH: 'El celular de la persona vinculada no es el número de esta conversación.',
    CONVERSATION_NO_SENDER: 'Esta escuela todavía no tiene un número de texto activo.',
    CONVERSATION_CONSENT_REQUIRED: 'Esta persona no aceptó recibir textos de la escuela. Registra primero su consentimiento.',
    CONVERSATION_CHANNEL_UNSUPPORTED: 'Las respuestas en este canal todavía no están disponibles.',
    CONVERSATION_ASSIGNEE_INVALID: 'Esa persona del personal no puede ver las conversaciones de esta escuela.',
    CONVERSATION_LINK_INVALID: 'Esa persona o prospecto no corresponde al número de esta conversación en esta escuela.',
    CONVERSATION_ALREADY_LINKED: 'Esta conversación ya está vinculada a una persona.',
    CONVERSATION_PIPELINE_INVALID: 'Elige una etapa abierta de uno de los embudos de esta escuela.',
  },
};

const copy: Record<Language, ConversationsCopy> = { en, ko, es };
export function conversationsCopy(language: Language): ConversationsCopy { return copy[language] ?? en; }
