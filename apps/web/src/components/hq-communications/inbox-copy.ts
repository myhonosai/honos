/** HQ inbox wording (en / ko / es). Labels only; nothing here is authority or an outcome. */
const en = {
  title: 'Texts and email',
  intro: 'Write to a school\'s owners and see every HQ text and email to that school, and the owners\' text replies, in one place. Addresses are never shown here.',
  settings: 'Sender settings', numbers: 'School texting numbers', refresh: 'Refresh', newMessage: 'New message',
  search: 'Search schools', conversations: 'Conversations', empty: 'No HQ messages yet. Choose New message to write to a school\'s owners.',
  emptySearch: 'No conversation matches this search.', more: 'Show older conversations', moreFailed: 'Older conversations could not be read. Try again.',
  loading: 'Reading HQ messages…', denied: 'Your HQ access does not include texting or email. Nothing is shown.',
  unavailable: 'HQ messages could not be read or checked. Nothing is shown.',
  concealed: 'Hidden because your session ended. Sign in again, then choose Show again.', reveal: 'Show again',
  back: 'Conversations', owners: 'Owners of {school}', messages: '{n} messages', details: 'Details',
  threadLoading: 'Reading this conversation…', threadEmpty: 'No messages to this school yet. Write the first one below.',
  threadFailed: 'This conversation could not be read. Try again.', older: 'Show earlier messages',
  you: 'HQ', pickTitle: 'New message', pickHelp: 'Choose the school whose owners you want to write to.', pickSearch: 'Search all schools',
  pickLoading: 'Reading schools…', pickFailed: 'Schools could not be read. Try again.', pickNone: 'No school matches.', pickCancel: 'Cancel',
  opening: 'Opening {school}…', openFailed: 'This school could not be opened. Try again.',
  sendAs: 'Send as', purpose: 'Purpose', message: 'Message to {school}\'s owners', send: 'Send', supportCase: 'Linked to a support case.',
  noPurposes: 'Your HQ access cannot send texts or email. You can read only.',
  saving: 'Saving…', sending: 'Sending to the owners…', sent: 'Sent to {n} owners. Owners who opted out are held back.',
  saved: 'Saved but not sent: {why} Open Details to see it.', failed: 'Nothing was sent: {why}',
  unknown: 'We could not confirm the answer. Try again sends the exact same message; it will not go twice.', tryAgain: 'Try again',
  localInvalid: 'Write a message within the limit and choose a purpose you hold.',
  w_REFUSED: 'a rule stopped it.', w_DENIED: 'your HQ access does not allow this purpose.', w_CHANGED: 'it changed since it was read.',
  w_GONE: 'the school or its owners were not found.', w_INVALID: 'the request was not accepted.', w_KEY_REUSED: 'it was already used for another send.',
  w_SESSION: 'your session ended.', w_HQ_MESSAGE_NO_RECIPIENTS: 'this school has no owners to write to.', w_HQ_MESSAGE_NOT_DRAFT: 'it was already sent or cancelled.',
  pending: 'waiting', delivered: 'delivered', heldBack: 'held back', failedCount: 'failed',
  reply: 'Owner reply', repliesFailed: 'Owners\' replies could not be read right now. HQ messages are still shown.',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  title: '문자 및 이메일',
  intro: '도장 원장님께 메시지를 쓰고, 그 도장에 보낸 HQ 문자와 이메일, 원장님의 문자 답장을 한곳에서 봅니다. 주소는 표시되지 않습니다.',
  settings: '발신자 설정', numbers: '도장 문자 번호', refresh: '새로 고침', newMessage: '새 메시지',
  search: '도장 검색', conversations: '대화', empty: '아직 HQ 메시지가 없습니다. 새 메시지를 눌러 원장님께 쓰세요.',
  emptySearch: '검색과 일치하는 대화가 없습니다.', more: '이전 대화 더 보기', moreFailed: '이전 대화를 읽지 못했습니다. 다시 시도하세요.',
  loading: 'HQ 메시지를 읽는 중…', denied: 'HQ 권한에 문자나 이메일이 없습니다. 표시할 내용이 없습니다.',
  unavailable: 'HQ 메시지를 읽거나 확인할 수 없습니다. 표시할 내용이 없습니다.',
  concealed: '세션이 종료되어 숨겼습니다. 다시 로그인한 뒤 다시 보기를 선택하세요.', reveal: '다시 보기',
  back: '대화', owners: '{school} 원장님', messages: '메시지 {n}개', details: '자세히',
  threadLoading: '대화를 읽는 중…', threadEmpty: '이 도장에 보낸 메시지가 아직 없습니다. 아래에 첫 메시지를 쓰세요.',
  threadFailed: '이 대화를 읽지 못했습니다. 다시 시도하세요.', older: '이전 메시지 보기',
  you: 'HQ', pickTitle: '새 메시지', pickHelp: '메시지를 보낼 원장님의 도장을 고르세요.', pickSearch: '모든 도장 검색',
  pickLoading: '도장을 읽는 중…', pickFailed: '도장을 읽지 못했습니다. 다시 시도하세요.', pickNone: '일치하는 도장이 없습니다.', pickCancel: '취소',
  opening: '{school} 여는 중…', openFailed: '이 도장을 열 수 없습니다. 다시 시도하세요.',
  sendAs: '보내는 방법', purpose: '목적', message: '{school} 원장님께 보낼 메시지', send: '보내기', supportCase: '지원 건과 연결됨.',
  noPurposes: 'HQ 권한으로 문자나 이메일을 보낼 수 없습니다. 읽기만 가능합니다.',
  saving: '저장 중…', sending: '원장님께 보내는 중…', sent: '원장님 {n}명에게 보냈습니다. 수신 거부한 분은 제외됩니다.',
  saved: '저장했지만 보내지 않았습니다: {why} 자세히에서 확인하세요.', failed: '보내지 않았습니다: {why}',
  unknown: '결과를 확인하지 못했습니다. 다시 시도는 똑같은 메시지를 보내며 두 번 가지 않습니다.', tryAgain: '다시 시도',
  localInvalid: '제한 안에서 메시지를 쓰고 가진 권한의 목적을 고르세요.',
  w_REFUSED: '규칙에 따라 멈췄습니다.', w_DENIED: 'HQ 권한으로 이 목적을 쓸 수 없습니다.', w_CHANGED: '읽은 뒤 바뀌었습니다.',
  w_GONE: '도장이나 원장님을 찾지 못했습니다.', w_INVALID: '요청이 받아들여지지 않았습니다.', w_KEY_REUSED: '이미 다른 전송에 쓰였습니다.',
  w_SESSION: '세션이 종료되었습니다.', w_HQ_MESSAGE_NO_RECIPIENTS: '이 도장에는 메시지를 받을 원장님이 없습니다.', w_HQ_MESSAGE_NOT_DRAFT: '이미 보냈거나 취소되었습니다.',
  pending: '대기', delivered: '전달됨', heldBack: '보류', failedCount: '실패',
  reply: '원장님 답장', repliesFailed: '지금은 원장님 답장을 읽지 못했습니다. HQ 메시지는 계속 표시됩니다.',
};
const es: Record<Key, string> = {
  title: 'Mensajes y correo',
  intro: 'Escriba a los dueños de una escuela y vea todos los mensajes y correos de HQ a esa escuela, y las respuestas de texto de los dueños, en un solo lugar. Nunca se muestran direcciones.',
  settings: 'Ajustes del remitente', numbers: 'Números de texto de escuelas', refresh: 'Actualizar', newMessage: 'Nuevo mensaje',
  search: 'Buscar escuelas', conversations: 'Conversaciones', empty: 'Aún no hay mensajes de HQ. Elija Nuevo mensaje para escribir a los dueños de una escuela.',
  emptySearch: 'Ninguna conversación coincide.', more: 'Ver conversaciones anteriores', moreFailed: 'No se pudieron leer las conversaciones anteriores. Inténtelo de nuevo.',
  loading: 'Leyendo mensajes de HQ…', denied: 'Su acceso de HQ no incluye mensajes ni correo. No se muestra nada.',
  unavailable: 'No se pudieron leer ni comprobar los mensajes de HQ. No se muestra nada.',
  concealed: 'Oculto porque su sesión terminó. Inicie sesión de nuevo y elija Mostrar de nuevo.', reveal: 'Mostrar de nuevo',
  back: 'Conversaciones', owners: 'Dueños de {school}', messages: '{n} mensajes', details: 'Detalles',
  threadLoading: 'Leyendo esta conversación…', threadEmpty: 'Aún no hay mensajes a esta escuela. Escriba el primero abajo.',
  threadFailed: 'No se pudo leer esta conversación. Inténtelo de nuevo.', older: 'Ver mensajes anteriores',
  you: 'HQ', pickTitle: 'Nuevo mensaje', pickHelp: 'Elija la escuela a cuyos dueños quiere escribir.', pickSearch: 'Buscar todas las escuelas',
  pickLoading: 'Leyendo escuelas…', pickFailed: 'No se pudieron leer las escuelas. Inténtelo de nuevo.', pickNone: 'Ninguna escuela coincide.', pickCancel: 'Cancelar',
  opening: 'Abriendo {school}…', openFailed: 'No se pudo abrir esta escuela. Inténtelo de nuevo.',
  sendAs: 'Enviar como', purpose: 'Motivo', message: 'Mensaje para los dueños de {school}', send: 'Enviar', supportCase: 'Vinculado a un caso de soporte.',
  noPurposes: 'Su acceso de HQ no puede enviar mensajes ni correos. Solo puede leer.',
  saving: 'Guardando…', sending: 'Enviando a los dueños…', sent: 'Enviado a {n} dueños. Quienes se dieron de baja quedan excluidos.',
  saved: 'Guardado pero no enviado: {why} Abra Detalles para verlo.', failed: 'No se envió nada: {why}',
  unknown: 'No pudimos confirmar la respuesta. Reintentar envía exactamente el mismo mensaje; no saldrá dos veces.', tryAgain: 'Reintentar',
  localInvalid: 'Escriba un mensaje dentro del límite y elija un motivo que tenga permitido.',
  w_REFUSED: 'una regla lo detuvo.', w_DENIED: 'su acceso de HQ no permite este motivo.', w_CHANGED: 'cambió desde que se leyó.',
  w_GONE: 'no se encontró la escuela o sus dueños.', w_INVALID: 'la solicitud no fue aceptada.', w_KEY_REUSED: 'ya se usó para otro envío.',
  w_SESSION: 'su sesión terminó.', w_HQ_MESSAGE_NO_RECIPIENTS: 'esta escuela no tiene dueños a quienes escribir.', w_HQ_MESSAGE_NOT_DRAFT: 'ya se envió o se canceló.',
  pending: 'en espera', delivered: 'entregados', heldBack: 'retenidos', failedCount: 'fallidos',
  reply: 'Respuesta del dueño', repliesFailed: 'No se pudieron leer las respuestas de los dueños. Los mensajes de HQ siguen visibles.',
};
const catalogs: Record<string, Record<Key, string>> = { en, ko, es };
export type InboxKey = Key;
export function inboxText(language: string, key: Key, vars: Record<string, string> = {}): string {
  const text = (catalogs[language] ?? en)[key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`);
}
/** Why a send stopped: the refusal code when it has wording, else the kind. */
export function inboxWhyKey(kind: string, code: string | null): Key {
  const byCode = code ? `w_${code}` : '';
  if (byCode && byCode in en) return byCode as Key;
  const byKind = `w_${kind}`;
  return (byKind in en ? byKind : 'w_REFUSED') as Key;
}
export const inboxCatalogs = catalogs;
