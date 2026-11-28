import type { HqCallOutcome, SchoolCallFilter, SchoolCallStatus } from '@hon/contracts';
import { callsCopy } from './copy';

/** HQ Calls page wording (en / ko / es). Labels only; nothing here is authority or an outcome. */
export type HqCallsCopy = {
  title: string; intro: string; loading: string; hidden: string; show: string; refresh: string;
  deniedTitle: string; denied: string; sessionEnded: string; unavailable: string; unknownSave: string;
  hqNumber: string; noNumber: string; setUpNumber: string; askOwnerNumber: string; statusOn: string; statusOff: string;
  turnCallingOn: string; turnCallingOff: string; callingTurnedOn: string; callingTurnedOff: string; ringMeOnLabel: string; ringMeOffLabel: string; ringMeNeedsCalling: string; callingOn: string; callingOff: string; callingOffHint: string;
  missedToday: (n: number) => string; unheard: (n: number) => string;
  ringMe: string; ringMeHint: string; ringMeOn: string; ringMeOff: string; ringing: (names: string) => string; nobodyRings: string; voicemailNote: string;
  log: string; filters: Record<SchoolCallFilter, string>; empty: string; emptyFiltered: string; more: string;
  incoming: string; outgoing: string; unknownCaller: string; by: (name: string) => string; status: Record<SchoolCallStatus, string>; ownerOf: (schools: string) => string;
  voicemailNew: string; voicemailHeard: string; doNotCallBadge: string;
  card: (name: string) => string; outcome: string; outcomes: Record<HqCallOutcome, string>; clearOutcome: string; note: string; noteHint: string; save: string; saved: string;
  markHeard: string; markedHeard: string; listen: (seconds: string) => string; voicemailKept: string; notRecorded: string;
  doNotCallHint: string; addDoNotCall: string; removeDoNotCall: string; doNotCallAdded: string; doNotCallRemoved: string;
  settings: string; settingsHint: string; turnOn: string; greeting: string; greetingHint: string; saveSettings: string; settingsSaved: string; ownerOnly: string;
  refusal: Record<string, string>;
};

const en: HqCallsCopy = {
  title: 'HQ calls',
  intro: 'Calls to and from the HQ number, the same number HQ texts from. HQ calls are not recorded; callers who reach nobody can leave a voicemail.',
  loading: 'Loading HQ calls…', hidden: 'HQ calls are hidden while this tab is in the background.', show: 'Show again', refresh: 'Refresh',
  deniedTitle: 'Not available for your HQ access', denied: 'HQ calling needs HQ texting access (any purpose).', sessionEnded: 'Your session has ended. Sign in again.',
  unavailable: 'HQ calls are unavailable right now. Try again in a moment.',
  unknownSave: 'We could not confirm the change. It may have been saved. Refresh to see the current state.',
  hqNumber: 'HQ number', noNumber: 'HQ has no active texting number yet. Calls use the same number.', setUpNumber: 'Buy a number', askOwnerNumber: 'Ask the HQ owner to buy the HQ number.', statusOn: 'Calling on', statusOff: 'Calling off',
  turnCallingOn: 'Turn calling on', turnCallingOff: 'Turn calling off', callingTurnedOn: 'HQ calling is on.', callingTurnedOff: 'HQ calling is off.',
  ringMeOnLabel: 'On', ringMeOffLabel: 'Off', ringMeNeedsCalling: 'Turn HQ calling on first to use Ring me.',
  callingOn: 'HQ calling is on', callingOff: 'HQ calling is off', callingOffHint: 'Calls to the HQ number are turned away until the HQ owner switches calling on.',
  missedToday: n => (n === 1 ? '1 missed call today' : `${n} missed calls today`), unheard: n => (n === 1 ? '1 new voicemail' : `${n} new voicemails`),
  ringMe: 'Ring me', ringMeHint: 'When the HQ number is called, ring HON in this browser for you, along with everyone at HQ who has Ring me on.',
  ringMeOn: 'Ring me is on for you.', ringMeOff: 'Ring me is off for you.', ringing: names => `Rings for: ${names}`,
  nobodyRings: 'Nobody has Ring me on, so callers go straight to voicemail.', voicemailNote: 'If nobody answers in about 20 seconds, the caller hears the HQ voicemail greeting.',
  log: 'Call log', filters: { ALL: 'All', MISSED: 'Missed', VOICEMAIL: 'Voicemail', OUTGOING: 'Outgoing' },
  empty: 'No HQ calls yet.', emptyFiltered: 'No calls match this filter.', more: 'Show more',
  incoming: 'Incoming', outgoing: 'Outgoing', unknownCaller: 'Unknown caller', by: name => `by ${name}`, status: callsCopy('en').status,
  ownerOf: schools => `Owner of ${schools}`,
  voicemailNew: 'New voicemail', voicemailHeard: 'Voicemail', doNotCallBadge: 'Do not call',
  card: name => `Call with ${name}`, outcome: 'What happened?',
  outcomes: { RESOLVED: 'Resolved', CALL_BACK: 'Call back', FOLLOW_UP: 'Follow up', LEFT_VOICEMAIL: 'Left voicemail', WRONG_NUMBER: 'Wrong number', OTHER: 'Other' },
  clearOutcome: 'Clear', note: 'Note', noteHint: 'Up to 1,000 characters. Seen by HQ only.', save: 'Save', saved: 'Saved.',
  markHeard: 'Mark voicemail heard', markedHeard: 'Voicemail marked heard.', listen: seconds => (seconds ? `Listen (${seconds})` : 'Listen'),
  voicemailKept: 'Voicemail is kept 90 days. Each listen is logged.', notRecorded: 'HQ calls are not recorded.',
  doNotCallHint: 'HQ will not place calls to this number.', addDoNotCall: 'Add to do-not-call', removeDoNotCall: 'Remove from do-not-call',
  doNotCallAdded: 'Added to the HQ do-not-call list.', doNotCallRemoved: 'Removed from the HQ do-not-call list.',
  settings: 'HQ calling settings', settingsHint: 'Only the HQ owner can change these.', turnOn: 'Turn HQ calling on',
  greeting: 'Voicemail greeting', greetingHint: 'Plain text, up to 300 characters. HON reads it to callers. Leave blank for the standard greeting.',
  saveSettings: 'Save settings', settingsSaved: 'HQ calling settings saved.', ownerOnly: 'Ask the HQ owner to change HQ calling settings.',
  refusal: {
    VALIDATION_FAILED: 'That was not accepted. Check the note or greeting and try again.',
    CALLING_OFF: 'HQ calling is off. The HQ owner can turn it on in HQ calling settings.',
    CALL_NUMBER_NOT_READY: 'The HQ number is not active yet.',
    CALL_NUMBER_NOT_ALLOWED: 'HON calls US and Canada numbers only, never premium, Caribbean or special numbers, or HON’s own numbers.',
    CALL_DO_NOT_CALL: 'This number is on the HQ do-not-call list.',
    CALL_PERSON_PHONE_MISMATCH: 'That contact’s confirmed phone is a different number.',
    CALL_RATE_LIMITED: 'You have started 60 calls in the last hour. Try again a little later.',
    CALL_PERSON_NOT_FOUND: 'That contact is not available.', CALL_NOT_FOUND: 'That call is not available.',
    CALL_RECORDING_NOT_FOUND: 'That voicemail is not available. Voicemail is kept 90 days.',
    CALLING_VERSION_CONFLICT: 'Someone else changed the HQ calling settings. Showing the current ones.',
    CALL_VERSION_CONFLICT: 'This call changed. Showing the current version.', CALL_CONFLICT: 'Something changed at the same time. Try again.',
    IDEMPOTENCY_KEY_REUSED: 'That call was already started differently. Start a new call.',
  },
};

const ko: HqCallsCopy = {
  ...en,
  title: 'HQ 전화',
  intro: 'HQ 번호로 걸고 받는 전화입니다. HQ가 문자를 보내는 번호와 같습니다. HQ 통화는 녹음되지 않으며, 아무도 받지 않으면 음성 메시지를 남길 수 있습니다.',
  loading: 'HQ 전화를 불러오는 중…', hidden: '이 탭이 백그라운드에 있는 동안 HQ 전화는 숨겨집니다.', show: '다시 보기', refresh: '새로고침',
  deniedTitle: 'HQ 권한으로 사용할 수 없습니다', denied: 'HQ 전화는 HQ 문자 권한(목적 무관)이 필요합니다.', sessionEnded: '세션이 끝났습니다. 다시 로그인하세요.',
  unavailable: '지금은 HQ 전화를 사용할 수 없습니다. 잠시 후 다시 시도하세요.',
  unknownSave: '변경을 확인할 수 없습니다. 저장되었을 수 있습니다. 새로고침해서 현재 상태를 확인하세요.',
  hqNumber: 'HQ 번호', noNumber: 'HQ에 아직 활성 문자 번호가 없습니다. 전화도 같은 번호를 씁니다.', setUpNumber: '번호 구입', askOwnerNumber: 'HQ 소유자에게 HQ 번호 구입을 요청하세요.', statusOn: '전화 켜짐', statusOff: '전화 꺼짐',
  turnCallingOn: '전화 켜기', turnCallingOff: '전화 끄기', callingTurnedOn: 'HQ 전화가 켜졌습니다.', callingTurnedOff: 'HQ 전화가 꺼졌습니다.',
  ringMeOnLabel: '켜짐', ringMeOffLabel: '꺼짐', ringMeNeedsCalling: '"나에게 울리기"를 쓰려면 먼저 HQ 전화를 켜세요.',
  callingOn: 'HQ 전화 켜짐', callingOff: 'HQ 전화 꺼짐', callingOffHint: 'HQ 소유자가 전화를 켤 때까지 HQ 번호로 오는 전화는 받지 않습니다.',
  missedToday: n => `오늘 부재중 전화 ${n}통`, unheard: n => `새 음성 메시지 ${n}개`,
  ringMe: '나에게 울리기', ringMeHint: 'HQ 번호로 전화가 오면 이 브라우저의 HON에서 나와 "나에게 울리기"를 켠 HQ 사람 모두에게 울립니다.',
  ringMeOn: '나에게 울리기가 켜져 있습니다.', ringMeOff: '나에게 울리기가 꺼져 있습니다.', ringing: names => `울리는 사람: ${names}`,
  nobodyRings: '"나에게 울리기"를 켠 사람이 없어 바로 음성 메시지로 연결됩니다.', voicemailNote: '약 20초 안에 아무도 받지 않으면 HQ 음성 메시지 인사말이 나옵니다.',
  log: '통화 기록', filters: { ALL: '전체', MISSED: '부재중', VOICEMAIL: '음성 메시지', OUTGOING: '발신' },
  empty: '아직 HQ 통화가 없습니다.', emptyFiltered: '이 필터에 맞는 통화가 없습니다.', more: '더 보기',
  incoming: '수신', outgoing: '발신', unknownCaller: '알 수 없는 발신자', by: name => `${name}`, status: callsCopy('ko').status, ownerOf: schools => `${schools} 소유자`,
  voicemailNew: '새 음성 메시지', voicemailHeard: '음성 메시지', doNotCallBadge: '전화 금지',
  card: name => `${name}와(과)의 통화`, outcome: '어떻게 되었나요?',
  outcomes: { RESOLVED: '해결됨', CALL_BACK: '다시 전화', FOLLOW_UP: '후속 조치', LEFT_VOICEMAIL: '음성 메시지 남김', WRONG_NUMBER: '잘못된 번호', OTHER: '기타' },
  clearOutcome: '지우기', note: '메모', noteHint: '최대 1,000자. HQ만 볼 수 있습니다.', save: '저장', saved: '저장했습니다.',
  markHeard: '음성 메시지 들음으로 표시', markedHeard: '음성 메시지를 들음으로 표시했습니다.', listen: seconds => (seconds ? `듣기 (${seconds})` : '듣기'),
  voicemailKept: '음성 메시지는 90일 동안 보관되며 들을 때마다 기록됩니다.', notRecorded: 'HQ 통화는 녹음되지 않습니다.',
  doNotCallHint: 'HQ는 이 번호로 전화하지 않습니다.', addDoNotCall: '전화 금지에 추가', removeDoNotCall: '전화 금지에서 제거',
  doNotCallAdded: 'HQ 전화 금지 목록에 추가했습니다.', doNotCallRemoved: 'HQ 전화 금지 목록에서 제거했습니다.',
  settings: 'HQ 전화 설정', settingsHint: 'HQ 소유자만 바꿀 수 있습니다.', turnOn: 'HQ 전화 켜기',
  greeting: '음성 메시지 인사말', greetingHint: '일반 텍스트, 최대 300자. HON이 발신자에게 읽어 줍니다. 비워 두면 기본 인사말을 씁니다.',
  saveSettings: '설정 저장', settingsSaved: 'HQ 전화 설정을 저장했습니다.', ownerOnly: 'HQ 전화 설정은 HQ 소유자에게 요청하세요.',
  refusal: {
    ...en.refusal,
    VALIDATION_FAILED: '받아들여지지 않았습니다. 메모나 인사말을 확인하고 다시 시도하세요.',
    CALLING_OFF: 'HQ 전화가 꺼져 있습니다. HQ 소유자가 HQ 전화 설정에서 켤 수 있습니다.',
    CALL_NUMBER_NOT_READY: 'HQ 번호가 아직 활성화되지 않았습니다.',
    CALL_NUMBER_NOT_ALLOWED: 'HON은 미국과 캐나다 번호만 걸며, 유료·카리브해·특수 번호나 HON 자체 번호로는 걸지 않습니다.',
    CALL_DO_NOT_CALL: '이 번호는 HQ 전화 금지 목록에 있습니다.',
    CALL_RATE_LIMITED: '최근 1시간 동안 60통을 걸었습니다. 잠시 후 다시 시도하세요.',
  },
};

const es: HqCallsCopy = {
  ...en,
  title: 'Llamadas de HQ',
  intro: 'Llamadas hacia y desde el número de HQ, el mismo número desde el que HQ envía textos. Las llamadas de HQ no se graban; quien no encuentra a nadie puede dejar un buzón de voz.',
  loading: 'Cargando llamadas de HQ…', hidden: 'Las llamadas de HQ se ocultan mientras esta pestaña está en segundo plano.', show: 'Mostrar de nuevo', refresh: 'Actualizar',
  deniedTitle: 'No disponible con tu acceso de HQ', denied: 'Las llamadas de HQ requieren acceso a textos de HQ (cualquier propósito).', sessionEnded: 'Tu sesión terminó. Inicia sesión de nuevo.',
  unavailable: 'Las llamadas de HQ no están disponibles ahora. Inténtalo en un momento.',
  unknownSave: 'No pudimos confirmar el cambio. Puede que se haya guardado. Actualiza para ver el estado actual.',
  hqNumber: 'Número de HQ', noNumber: 'HQ todavía no tiene un número de texto activo. Las llamadas usan el mismo número.', setUpNumber: 'Comprar un número', askOwnerNumber: 'Pide al dueño de HQ que compre el número de HQ.', statusOn: 'Llamadas activadas', statusOff: 'Llamadas desactivadas',
  turnCallingOn: 'Activar llamadas', turnCallingOff: 'Desactivar llamadas', callingTurnedOn: 'Las llamadas de HQ están activadas.', callingTurnedOff: 'Las llamadas de HQ están desactivadas.',
  ringMeOnLabel: 'Activado', ringMeOffLabel: 'Desactivado', ringMeNeedsCalling: 'Activa primero las llamadas de HQ para usar Llamarme.',
  callingOn: 'Llamadas de HQ activadas', callingOff: 'Llamadas de HQ desactivadas', callingOffHint: 'Las llamadas al número de HQ se rechazan hasta que el dueño de HQ active las llamadas.',
  missedToday: n => (n === 1 ? '1 llamada perdida hoy' : `${n} llamadas perdidas hoy`), unheard: n => (n === 1 ? '1 buzón de voz nuevo' : `${n} buzones de voz nuevos`),
  ringMe: 'Llamarme', ringMeHint: 'Cuando llamen al número de HQ, HON sonará en este navegador para ti y para todos en HQ que tengan Llamarme activado.',
  ringMeOn: 'Llamarme está activado para ti.', ringMeOff: 'Llamarme está desactivado para ti.', ringing: names => `Suena para: ${names}`,
  nobodyRings: 'Nadie tiene Llamarme activado, así que las llamadas van directo al buzón de voz.', voicemailNote: 'Si nadie contesta en unos 20 segundos, quien llama oye el saludo del buzón de HQ.',
  log: 'Registro de llamadas', filters: { ALL: 'Todas', MISSED: 'Perdidas', VOICEMAIL: 'Buzón de voz', OUTGOING: 'Salientes' },
  empty: 'Todavía no hay llamadas de HQ.', emptyFiltered: 'Ninguna llamada coincide con este filtro.', more: 'Mostrar más',
  incoming: 'Entrante', outgoing: 'Saliente', unknownCaller: 'Número desconocido', by: name => `por ${name}`, status: callsCopy('es').status, ownerOf: schools => `Dueño de ${schools}`,
  voicemailNew: 'Buzón de voz nuevo', voicemailHeard: 'Buzón de voz', doNotCallBadge: 'No llamar',
  card: name => `Llamada con ${name}`, outcome: '¿Qué pasó?',
  outcomes: { RESOLVED: 'Resuelto', CALL_BACK: 'Devolver llamada', FOLLOW_UP: 'Dar seguimiento', LEFT_VOICEMAIL: 'Dejé mensaje', WRONG_NUMBER: 'Número equivocado', OTHER: 'Otro' },
  clearOutcome: 'Borrar', note: 'Nota', noteHint: 'Hasta 1,000 caracteres. Solo la ve HQ.', save: 'Guardar', saved: 'Guardado.',
  markHeard: 'Marcar buzón como escuchado', markedHeard: 'Buzón marcado como escuchado.', listen: seconds => (seconds ? `Escuchar (${seconds})` : 'Escuchar'),
  voicemailKept: 'El buzón de voz se guarda 90 días. Cada escucha queda registrada.', notRecorded: 'Las llamadas de HQ no se graban.',
  doNotCallHint: 'HQ no llamará a este número.', addDoNotCall: 'Agregar a no llamar', removeDoNotCall: 'Quitar de no llamar',
  doNotCallAdded: 'Agregado a la lista de no llamar de HQ.', doNotCallRemoved: 'Quitado de la lista de no llamar de HQ.',
  settings: 'Ajustes de llamadas de HQ', settingsHint: 'Solo el dueño de HQ puede cambiarlos.', turnOn: 'Activar llamadas de HQ',
  greeting: 'Saludo del buzón de voz', greetingHint: 'Texto simple, hasta 300 caracteres. HON lo lee a quien llama. Déjalo vacío para el saludo estándar.',
  saveSettings: 'Guardar ajustes', settingsSaved: 'Ajustes de llamadas de HQ guardados.', ownerOnly: 'Pide al dueño de HQ que cambie los ajustes de llamadas.',
  refusal: {
    ...en.refusal,
    VALIDATION_FAILED: 'No se aceptó. Revisa la nota o el saludo e inténtalo de nuevo.',
    CALLING_OFF: 'Las llamadas de HQ están desactivadas. El dueño de HQ puede activarlas en los ajustes.',
    CALL_NUMBER_NOT_READY: 'El número de HQ todavía no está activo.',
    CALL_NUMBER_NOT_ALLOWED: 'HON llama solo a números de EE. UU. y Canadá, nunca a números premium, del Caribe, especiales ni a los de HON.',
    CALL_DO_NOT_CALL: 'Este número está en la lista de no llamar de HQ.',
    CALL_RATE_LIMITED: 'Iniciaste 60 llamadas en la última hora. Inténtalo un poco más tarde.',
  },
};

export function hqCallsCopy(language: string): HqCallsCopy {
  return language === 'ko' ? ko : language === 'es' ? es : en;
}
