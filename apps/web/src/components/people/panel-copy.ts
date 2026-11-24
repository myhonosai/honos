/** Wording for the slide-out contact card and the sections it holds (en / ko / es). Labels only; nothing here is authority. */
const en = {
  fullScreen: 'Full screen', keepSide: 'Keep at side', close: 'Close', panelLabel: 'Contact card',
  inboxes: 'Inboxes', textsInbox: 'Texts inbox', familyInbox: 'Family messages inbox',
  details: 'Details', textsTitle: 'Texts', textsCount: '{n} texts with this person.', textsOpen: 'Open the texts inbox',
  familyMessagesTitle: 'Family messages', familyMessagesLoading: 'Reading family messages…', familyMessagesNone: 'This family has not written yet.',
  familyMessagesDenied: 'Your role doesn’t include family messages.', familyMessagesUnavailable: 'Family messages could not be loaded.',
  newCount: '{n} new', familyWrote: 'Family wrote', schoolReplied: 'School replied', you: 'You', schoolStaff: 'School staff',
  markRead: 'Mark read', reply: 'Reply', send: 'Send reply', sending: 'Sending…', sent: 'Reply sent.', replyHint: 'Shows to the family as from the school, inside the HON app. Nothing is texted or emailed.',
  back: 'Back to threads', retry: 'Try again', sendUnknown: 'We could not confirm the reply was sent. Try again sends the same reply once.',
  accessTitle: 'Family app access', accessLoading: 'Reading app access…', accessDenied: 'Your role doesn’t include family app access.',
  accessUnavailable: 'App access could not be loaded.', accessNone: 'No invitations for this family yet.', accessRead: 'Show app access',
};
export type PanelKey = keyof typeof en;
const ko: Record<PanelKey, string> = {
  fullScreen: '전체 화면', keepSide: '옆에 두기', close: '닫기', panelLabel: '연락처 카드',
  inboxes: '받은편지함', textsInbox: '문자 받은편지함', familyInbox: '가족 메시지 받은편지함',
  details: '세부 정보', textsTitle: '문자', textsCount: '이 사람과의 문자 {n}건.', textsOpen: '문자 받은편지함 열기',
  familyMessagesTitle: '가족 메시지', familyMessagesLoading: '가족 메시지를 읽는 중…', familyMessagesNone: '이 가족은 아직 메시지를 보내지 않았습니다.',
  familyMessagesDenied: '내 역할에는 가족 메시지가 포함되지 않습니다.', familyMessagesUnavailable: '가족 메시지를 불러오지 못했습니다.',
  newCount: '새 메시지 {n}건', familyWrote: '가족이 보냄', schoolReplied: '학교가 답장함', you: '나', schoolStaff: '학교 직원',
  markRead: '읽음으로 표시', reply: '답장', send: '답장 보내기', sending: '보내는 중…', sent: '답장을 보냈습니다.', replyHint: 'HON 앱 안에서 학교 이름으로 가족에게 보입니다. 문자나 이메일은 보내지 않습니다.',
  back: '대화 목록으로', retry: '다시 시도', sendUnknown: '답장이 전송되었는지 확인하지 못했습니다. 다시 시도하면 같은 답장을 한 번만 보냅니다.',
  accessTitle: '가족 앱 접근', accessLoading: '앱 접근을 읽는 중…', accessDenied: '내 역할에는 가족 앱 접근이 포함되지 않습니다.',
  accessUnavailable: '앱 접근을 불러오지 못했습니다.', accessNone: '이 가족에 대한 초대가 아직 없습니다.', accessRead: '앱 접근 보기',
};
const es: Record<PanelKey, string> = {
  fullScreen: 'Pantalla completa', keepSide: 'Mantener al lado', close: 'Cerrar', panelLabel: 'Ficha de contacto',
  inboxes: 'Bandejas', textsInbox: 'Bandeja de textos', familyInbox: 'Bandeja de mensajes de familias',
  details: 'Datos', textsTitle: 'Textos', textsCount: '{n} textos con esta persona.', textsOpen: 'Abrir la bandeja de textos',
  familyMessagesTitle: 'Mensajes de la familia', familyMessagesLoading: 'Leyendo mensajes de la familia…', familyMessagesNone: 'Esta familia aún no ha escrito.',
  familyMessagesDenied: 'Su función no incluye los mensajes de familias.', familyMessagesUnavailable: 'No se pudieron cargar los mensajes de la familia.',
  newCount: '{n} nuevos', familyWrote: 'Escribió la familia', schoolReplied: 'Respondió la escuela', you: 'Usted', schoolStaff: 'Personal de la escuela',
  markRead: 'Marcar como leído', reply: 'Responder', send: 'Enviar respuesta', sending: 'Enviando…', sent: 'Respuesta enviada.', replyHint: 'La familia la ve como de la escuela, dentro de la app HON. No se envía ningún texto ni correo.',
  back: 'Volver a las conversaciones', retry: 'Reintentar', sendUnknown: 'No pudimos confirmar que se envió la respuesta. Reintentar envía la misma respuesta una sola vez.',
  accessTitle: 'Acceso de la familia a la app', accessLoading: 'Leyendo el acceso a la app…', accessDenied: 'Su función no incluye el acceso de familias a la app.',
  accessUnavailable: 'No se pudo cargar el acceso a la app.', accessNone: 'Aún no hay invitaciones para esta familia.', accessRead: 'Ver acceso a la app',
};
export const PANEL_COPY = { en, ko, es } as const;
export function panelText(language: string, key: PanelKey, vars: Readonly<Record<string, string | number>> = {}): string {
  const table = (PANEL_COPY as Record<string, Record<PanelKey, string>>)[language] ?? en;
  return table[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}
