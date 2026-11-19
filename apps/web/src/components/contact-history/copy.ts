import type { Language } from '@hon/design-system';
import type { ContactDeliveryState, ContactHistoryChannel, ContactHistoryOrigin, ContactHistoryRange, ContactResendBlock } from '@hon/contracts';

export type ContactHistoryCopy = {
  title: string; intro: string; show: string; hide: string; loading: string; refresh: string;
  denied: string; sessionEnded: string; unavailable: string; unknownResend: string;
  range: string; ranges: Record<ContactHistoryRange, string>; search: string; searchHint: string; apply: string;
  total: (n: number) => string; empty: string; emptyFiltered: string; more: string; familyHidden: string;
  sent: string; received: string; channel: Record<ContactHistoryChannel, string>; origin: Record<ContactHistoryOrigin, string>;
  delivery: Record<ContactDeliveryState, string>; resentCopy: string; viewEmail: string;
  emailTitle: string; subject: string; standardSubject: string; body: string; plainNote: string; sentAt: string; by: string;
  deliveryLabel: string; events: string; noEvents: string; savedAddress: string; noAddress: string; resends: string; resentFrom: string;
  resend: string; resending: string; resendHint: string; resendQueued: string; closeEmail: string;
  blocked: Record<ContactResendBlock, string>; refusal: Record<string, string>;
};

const en: ContactHistoryCopy = {
  title: 'Message history', intro: 'Every text, email and message with this person: from staff, conversations, campaigns, automations and the family app.',
  show: 'Show message history', hide: 'Hide message history', loading: 'Loading messages…', refresh: 'Refresh',
  denied: 'Message history needs the conversations permission at this school.', sessionEnded: 'Your session has ended. Sign in again.',
  unavailable: 'Message history is unavailable right now. Try again in a moment.',
  unknownResend: 'We could not confirm the resend. It may or may not be queued. Refresh before trying again; trying the same resend again will not send it twice.',
  range: 'Show', ranges: { ALL: 'All', TODAY: 'Today', DAYS_7: 'Last 7 days', DAYS_30: 'Last 30 days' }, search: 'Search', searchHint: 'Words in the message or subject', apply: 'Apply',
  total: n => (n === 1 ? '1 message' : `${n} messages`), empty: 'No messages with this person yet.', emptyFiltered: 'No messages match these filters.', more: 'Show more',
  familyHidden: 'Family app messages are not shown for your role.',
  sent: 'Sent', received: 'Received',
  channel: { SMS: 'Text', EMAIL: 'Email', PUSH: 'App notice', APP: 'Family app', WEB_CHAT: 'Web chat' },
  origin: { STAFF: 'Staff', CONVERSATION: 'Conversation', CAMPAIGN: 'Campaign', AUTOMATION: 'Automation', FAMILY: 'Family' },
  delivery: { QUEUED: 'Queued', CANCELLED: 'Cancelled', PENDING: 'Waiting to send', SENDING: 'Sending', ACCEPTED: 'Sent', DELIVERED: 'Delivered', BOUNCED: 'Not delivered', FAILED: 'Failed', SUPPRESSED: 'Not sent (no consent or address)', UNKNOWN: 'Unknown' },
  resentCopy: 'Resent copy', viewEmail: 'View email',
  emailTitle: 'Email sent', subject: 'Subject', standardSubject: 'the standard subject HON uses when none was written', body: 'Message',
  plainNote: 'This is the plain text exactly as stored and sent.', sentAt: 'Queued', by: 'By',
  deliveryLabel: 'Delivery', events: 'Delivery events', noEvents: 'No delivery events yet.', savedAddress: 'Saved address now', noAddress: 'No saved email address',
  resends: 'Sent again', resentFrom: 'This is a resent copy.',
  resend: 'Resend to saved address', resending: 'Queuing…', resendHint: 'Queues a new copy of this email to the address saved for this person now, after checking their email consent again.',
  resendQueued: 'Resend queued. It is sent once the delivery checks pass.', closeEmail: 'Close',
  blocked: {
    NOT_ALLOWED: 'Resending needs the conversations manage and message queue permissions.', NOT_SENT: 'Only an email that was queued can be sent again.',
    EMAIL_MISSING: 'This person has no saved email address.', CONSENT_REQUIRED: 'This person has not agreed to email from the school, or unsubscribed.',
    LIMIT_REACHED: 'This email was already sent again 3 times today, or this person got 10 resends today.',
  },
  refusal: {
    VALIDATION_FAILED: 'That was not accepted. Search is plain text of up to 60 characters.', CONTACT_NOT_FOUND: 'That person is not available.',
    CONTACT_MESSAGE_NOT_FOUND: 'That email is not available.', IDEMPOTENCY_KEY_REUSED: 'This could not be matched to the earlier attempt. Refresh and try again.',
    CONTACT_RESEND_NOT_SENT: 'Only an email that was queued can be sent again.', CONTACT_RESEND_EMAIL_MISSING: 'This person has no saved email address. Add one first.',
    CONTACT_RESEND_CONSENT_REQUIRED: 'This person has not agreed to email from the school, or unsubscribed. Record their email consent first.',
    CONTACT_RESEND_LIMIT_REACHED: 'This email was already sent again 3 times today, or this person got 10 resends today.',
  },
};

const ko: ContactHistoryCopy = {
  title: '메시지 기록', intro: '이 사람과 주고받은 모든 문자, 이메일, 메시지: 직원, 대화, 캠페인, 자동화, 가족 앱.',
  show: '메시지 기록 보기', hide: '메시지 기록 숨기기', loading: '메시지를 불러오는 중…', refresh: '새로고침',
  denied: '메시지 기록을 보려면 이 학교의 대화 권한이 필요합니다.', sessionEnded: '세션이 종료되었습니다. 다시 로그인하세요.',
  unavailable: '지금은 메시지 기록을 볼 수 없습니다. 잠시 후 다시 시도하세요.',
  unknownResend: '다시 보내기를 확인하지 못했습니다. 대기열에 들어갔을 수도 있습니다. 다시 시도하기 전에 새로고침하세요. 같은 다시 보내기를 반복해도 두 번 보내지지 않습니다.',
  range: '기간', ranges: { ALL: '전체', TODAY: '오늘', DAYS_7: '최근 7일', DAYS_30: '최근 30일' }, search: '검색', searchHint: '메시지 또는 제목의 단어', apply: '적용',
  total: n => `메시지 ${n}개`, empty: '이 사람과 주고받은 메시지가 아직 없습니다.', emptyFiltered: '조건에 맞는 메시지가 없습니다.', more: '더 보기',
  familyHidden: '현재 역할에서는 가족 앱 메시지가 표시되지 않습니다.',
  sent: '보냄', received: '받음',
  channel: { SMS: '문자', EMAIL: '이메일', PUSH: '앱 알림', APP: '가족 앱', WEB_CHAT: '웹 채팅' },
  origin: { STAFF: '직원', CONVERSATION: '대화', CAMPAIGN: '캠페인', AUTOMATION: '자동화', FAMILY: '가족' },
  delivery: { QUEUED: '대기 중', CANCELLED: '취소됨', PENDING: '발송 대기', SENDING: '보내는 중', ACCEPTED: '보냄', DELIVERED: '전달됨', BOUNCED: '전달 안 됨', FAILED: '실패', SUPPRESSED: '보내지 않음(동의 또는 주소 없음)', UNKNOWN: '알 수 없음' },
  resentCopy: '다시 보낸 사본', viewEmail: '이메일 보기',
  emailTitle: '보낸 이메일', subject: '제목', standardSubject: '제목을 쓰지 않았을 때 HON이 쓰는 기본 제목', body: '내용',
  plainNote: '저장되고 발송된 그대로의 일반 텍스트입니다.', sentAt: '대기열 등록', by: '보낸 사람',
  deliveryLabel: '전달', events: '전달 기록', noEvents: '아직 전달 기록이 없습니다.', savedAddress: '현재 저장된 주소', noAddress: '저장된 이메일 주소 없음',
  resends: '다시 보낸 기록', resentFrom: '다시 보낸 사본입니다.',
  resend: '저장된 주소로 다시 보내기', resending: '대기열에 넣는 중…', resendHint: '이메일 수신 동의를 다시 확인한 뒤, 지금 이 사람에게 저장된 주소로 이 이메일의 새 사본을 대기열에 넣습니다.',
  resendQueued: '다시 보내기가 대기열에 들어갔습니다. 전달 확인을 통과하면 발송됩니다.', closeEmail: '닫기',
  blocked: {
    NOT_ALLOWED: '다시 보내려면 대화 관리 권한과 메시지 대기열 권한이 필요합니다.', NOT_SENT: '대기열에 들어갔던 이메일만 다시 보낼 수 있습니다.',
    EMAIL_MISSING: '이 사람은 저장된 이메일 주소가 없습니다.', CONSENT_REQUIRED: '이 사람은 학교 이메일 수신에 동의하지 않았거나 수신을 거부했습니다.',
    LIMIT_REACHED: '이 이메일은 오늘 이미 3번 다시 보냈거나, 이 사람에게 오늘 10번 다시 보냈습니다.',
  },
  refusal: {
    VALIDATION_FAILED: '받아들여지지 않았습니다. 검색어는 60자 이하의 일반 텍스트입니다.', CONTACT_NOT_FOUND: '해당 사람을 볼 수 없습니다.',
    CONTACT_MESSAGE_NOT_FOUND: '해당 이메일을 볼 수 없습니다.', IDEMPOTENCY_KEY_REUSED: '이전 시도와 맞출 수 없습니다. 새로고침 후 다시 시도하세요.',
    CONTACT_RESEND_NOT_SENT: '대기열에 들어갔던 이메일만 다시 보낼 수 있습니다.', CONTACT_RESEND_EMAIL_MISSING: '이 사람은 저장된 이메일 주소가 없습니다. 먼저 추가하세요.',
    CONTACT_RESEND_CONSENT_REQUIRED: '이 사람은 학교 이메일 수신에 동의하지 않았거나 수신을 거부했습니다. 먼저 이메일 동의를 기록하세요.',
    CONTACT_RESEND_LIMIT_REACHED: '이 이메일은 오늘 이미 3번 다시 보냈거나, 이 사람에게 오늘 10번 다시 보냈습니다.',
  },
};

const es: ContactHistoryCopy = {
  title: 'Historial de mensajes', intro: 'Todos los textos, correos y mensajes con esta persona: del personal, conversaciones, campañas, automatizaciones y la app familiar.',
  show: 'Ver historial de mensajes', hide: 'Ocultar historial de mensajes', loading: 'Cargando mensajes…', refresh: 'Actualizar',
  denied: 'El historial de mensajes requiere el permiso de conversaciones en esta escuela.', sessionEnded: 'Tu sesión terminó. Inicia sesión de nuevo.',
  unavailable: 'El historial de mensajes no está disponible ahora. Inténtalo en un momento.',
  unknownResend: 'No pudimos confirmar el reenvío. Puede que se haya puesto en cola o no. Actualiza antes de intentarlo de nuevo; repetir el mismo reenvío no lo envía dos veces.',
  range: 'Mostrar', ranges: { ALL: 'Todo', TODAY: 'Hoy', DAYS_7: 'Últimos 7 días', DAYS_30: 'Últimos 30 días' }, search: 'Buscar', searchHint: 'Palabras del mensaje o del asunto', apply: 'Aplicar',
  total: n => (n === 1 ? '1 mensaje' : `${n} mensajes`), empty: 'Aún no hay mensajes con esta persona.', emptyFiltered: 'Ningún mensaje coincide con estos filtros.', more: 'Ver más',
  familyHidden: 'Los mensajes de la app familiar no se muestran para tu rol.',
  sent: 'Enviado', received: 'Recibido',
  channel: { SMS: 'Texto', EMAIL: 'Correo', PUSH: 'Aviso de la app', APP: 'App familiar', WEB_CHAT: 'Chat web' },
  origin: { STAFF: 'Personal', CONVERSATION: 'Conversación', CAMPAIGN: 'Campaña', AUTOMATION: 'Automatización', FAMILY: 'Familia' },
  delivery: { QUEUED: 'En cola', CANCELLED: 'Cancelado', PENDING: 'Esperando envío', SENDING: 'Enviando', ACCEPTED: 'Enviado', DELIVERED: 'Entregado', BOUNCED: 'No entregado', FAILED: 'Falló', SUPPRESSED: 'No enviado (sin consentimiento o dirección)', UNKNOWN: 'Desconocido' },
  resentCopy: 'Copia reenviada', viewEmail: 'Ver correo',
  emailTitle: 'Correo enviado', subject: 'Asunto', standardSubject: 'el asunto estándar que HON usa cuando no se escribió ninguno', body: 'Mensaje',
  plainNote: 'Este es el texto sin formato tal como se guardó y se envió.', sentAt: 'En cola', by: 'Por',
  deliveryLabel: 'Entrega', events: 'Eventos de entrega', noEvents: 'Aún no hay eventos de entrega.', savedAddress: 'Dirección guardada ahora', noAddress: 'Sin correo guardado',
  resends: 'Reenviado', resentFrom: 'Esta es una copia reenviada.',
  resend: 'Reenviar a la dirección guardada', resending: 'Poniendo en cola…', resendHint: 'Pone en cola una copia nueva de este correo a la dirección guardada ahora para esta persona, después de revisar otra vez su consentimiento de correo.',
  resendQueued: 'Reenvío en cola. Se envía cuando pasen las revisiones de entrega.', closeEmail: 'Cerrar',
  blocked: {
    NOT_ALLOWED: 'Reenviar requiere los permisos de administrar conversaciones y de cola de mensajes.', NOT_SENT: 'Solo se puede reenviar un correo que se puso en cola.',
    EMAIL_MISSING: 'Esta persona no tiene un correo guardado.', CONSENT_REQUIRED: 'Esta persona no aceptó correos de la escuela o se dio de baja.',
    LIMIT_REACHED: 'Este correo ya se reenvió 3 veces hoy, o esta persona ya recibió 10 reenvíos hoy.',
  },
  refusal: {
    VALIDATION_FAILED: 'No se aceptó. La búsqueda es texto simple de hasta 60 caracteres.', CONTACT_NOT_FOUND: 'Esa persona no está disponible.',
    CONTACT_MESSAGE_NOT_FOUND: 'Ese correo no está disponible.', IDEMPOTENCY_KEY_REUSED: 'No se pudo relacionar con el intento anterior. Actualiza e inténtalo de nuevo.',
    CONTACT_RESEND_NOT_SENT: 'Solo se puede reenviar un correo que se puso en cola.', CONTACT_RESEND_EMAIL_MISSING: 'Esta persona no tiene un correo guardado. Agrega uno primero.',
    CONTACT_RESEND_CONSENT_REQUIRED: 'Esta persona no aceptó correos de la escuela o se dio de baja. Registra primero su consentimiento de correo.',
    CONTACT_RESEND_LIMIT_REACHED: 'Este correo ya se reenvió 3 veces hoy, o esta persona ya recibió 10 reenvíos hoy.',
  },
};

const copy: Record<Language, ContactHistoryCopy> = { en, ko, es };
export function contactHistoryCopy(language: Language): ContactHistoryCopy { return copy[language] ?? en; }
