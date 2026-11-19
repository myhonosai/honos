import type { Language } from '@hon/design-system';
import type { SchoolCallFilter, SchoolCallOutcome, SchoolCallStatus } from '@hon/contracts';

export type CallsCopy = {
  title: string; intro: string; chooseSchool: string; loading: string; hidden: string; show: string; refresh: string;
  deniedTitle: string; denied: string; sessionEnded: string; unavailable: string; unknownSave: string;
  schoolNumber: string; noNumber: string; setUpNumber: string; callingOn: string; callingOff: string; callingOffHint: string;
  missedToday: (n: number) => string; unheard: (n: number) => string;
  ringMe: string; ringMeHint: string; ringMeOn: string; ringMeOff: string; ringing: (names: string) => string; nobodyRings: string; forwardingNote: string; textBackNote: string;
  log: string; filters: Record<SchoolCallFilter, string>; empty: string; emptyFiltered: string; more: string;
  incoming: string; outgoing: string; unknownCaller: string; by: (name: string) => string; status: Record<SchoolCallStatus, string>;
  voicemailNew: string; voicemailHeard: string; recorded: string; doNotCallBadge: string; open: string;
  card: (name: string) => string; outcome: string; outcomes: Record<SchoolCallOutcome, string>; clearOutcome: string; note: string; noteHint: string; save: string; saved: string;
  markHeard: string; markedHeard: string; recordingLater: string;
  doNotCall: string; doNotCallHint: string; addDoNotCall: string; removeDoNotCall: string; doNotCallAdded: string; doNotCallRemoved: string;
  settings: string; settingsHint: string; turnOn: string; greeting: string; greetingHint: string; recording: string; recordingHint: string;
  consentLabel: string; consentAccepted: (when: string) => string; saveSettings: string; settingsSaved: string; ownerOnly: string;
  refusal: Record<string, string>;
};

const STATUS_EN: Record<SchoolCallStatus, string> = {
  INITIATED: 'Starting', RINGING: 'Ringing', IN_PROGRESS: 'On the call', COMPLETED: 'Answered', NO_ANSWER: 'No answer', BUSY: 'Busy', FAILED: 'Did not connect',
  CANCELED: 'Cancelled', MISSED: 'Missed', VOICEMAIL: 'Voicemail', EXPIRED: 'Not connected',
};

const en: CallsCopy = {
  title: 'Calls', chooseSchool: 'Choose a school to see its calls.',
  intro: 'Calls to and from your school number, the same number you text from. Missed calls, voicemail and what happened on each call stay with the contact.',
  loading: 'Loading calls…', hidden: 'Calls are hidden.', show: 'Show calls', refresh: 'Refresh',
  deniedTitle: 'Not available for your role', denied: 'You need the calling permission at this school.', sessionEnded: 'Your session has ended. Sign in again.',
  unavailable: 'Calls are unavailable right now. Try again in a moment.',
  unknownSave: 'We could not confirm the change. It may have been saved. Refresh to see the current state.',
  schoolNumber: 'School number', noNumber: 'This school has no texting number yet. Calls use the same number.', setUpNumber: 'Set up the school number',
  callingOn: 'Calling is on', callingOff: 'Calling is off',
  callingOffHint: 'Calls to the school number still forward to your forwarding phone, and missed-call text-back keeps working.',
  missedToday: n => (n === 1 ? '1 missed call today' : `${n} missed calls today`), unheard: n => (n === 1 ? '1 new voicemail' : `${n} new voicemails`),
  ringMe: 'Ring me', ringMeHint: 'When the school number is called, ring HON in this browser for you, along with everyone else who has Ring me on.',
  ringMeOn: 'Ring me is on for you.', ringMeOff: 'Ring me is off for you.', ringing: names => `Rings for: ${names}`, nobodyRings: 'Nobody has Ring me on, so calls go to the forwarding phone.',
  forwardingNote: 'If nobody answers in about 20 seconds, the caller hears your voicemail greeting.', textBackNote: 'Missed callers also get your missed-call text.',
  log: 'Call log', filters: { ALL: 'All', MISSED: 'Missed', VOICEMAIL: 'Voicemail', OUTGOING: 'Outgoing' },
  empty: 'No calls yet.', emptyFiltered: 'No calls match this filter.', more: 'Show more',
  incoming: 'Incoming', outgoing: 'Outgoing', unknownCaller: 'Unknown caller', by: name => `by ${name}`, status: STATUS_EN,
  voicemailNew: 'New voicemail', voicemailHeard: 'Voicemail', recorded: 'Recorded', doNotCallBadge: 'Do not call', open: 'Details',
  card: name => `Call with ${name}`, outcome: 'What happened?',
  outcomes: { TRIAL_BOOKED: 'Trial booked', CALL_BACK: 'Call back', INTERESTED: 'Interested', NOT_INTERESTED: 'Not interested', LEFT_VOICEMAIL: 'Left voicemail', WRONG_NUMBER: 'Wrong number', OTHER: 'Other' },
  clearOutcome: 'Clear', note: 'Note', noteHint: 'Up to 1,000 characters. Saved on this call and seen in the contact’s history.', save: 'Save', saved: 'Saved.',
  markHeard: 'Mark voicemail heard', markedHeard: 'Voicemail marked heard.', recordingLater: 'Playback of recordings and voicemail arrives with the browser phone.',
  doNotCall: 'Do not call', doNotCallHint: 'HON will not place calls to this number from this school.',
  addDoNotCall: 'Add to do-not-call', removeDoNotCall: 'Remove from do-not-call', doNotCallAdded: 'Added to the do-not-call list.', doNotCallRemoved: 'Removed from the do-not-call list.',
  settings: 'Calling settings', settingsHint: 'Only the school owner can change these.', turnOn: 'Turn calling on for this school',
  greeting: 'Voicemail greeting', greetingHint: 'Plain text, up to 300 characters. HON reads it to callers. Leave blank for the standard greeting.',
  recording: 'Record calls', recordingHint: 'Off by default. Recorded calls start with "This call may be recorded".',
  consentLabel: 'I accept this statement', consentAccepted: when => `Accepted ${when}`, saveSettings: 'Save settings', settingsSaved: 'Calling settings saved.',
  ownerOnly: 'Ask the school owner to change calling settings.',
  refusal: {
    VALIDATION_FAILED: 'That was not accepted. Check the note or greeting and try again.',
    CALLING_OFF: 'Calling is off at this school. The owner can turn it on in Calling settings.',
    CALL_NUMBER_NOT_READY: 'The school number is not active yet.',
    CALL_NUMBER_NOT_ALLOWED: 'HON calls US and Canada numbers only, never premium, Caribbean or special numbers, or the school’s own phones.',
    CALL_DO_NOT_CALL: 'This number is on the do-not-call list.',
    CALL_PERSON_PHONE_MISMATCH: 'That number is not this contact’s phone number.',
    RECORDING_CONSENT_REQUIRED: 'Accept the recording statement before turning recording on.',
    CALL_RATE_LIMITED: 'You have placed a lot of calls this hour. Try again later.',
    CALL_PERSON_NOT_FOUND: 'That contact is not available at this school.', CALL_NOT_FOUND: 'That call is not available.',
    CALLING_VERSION_CONFLICT: 'Calling settings changed. They have been reloaded; try again.', CALL_VERSION_CONFLICT: 'This call changed. It has been reloaded; try again.',
    IDEMPOTENCY_KEY_REUSED: 'This could not be matched to the earlier attempt. Refresh and try again.', CALL_CONFLICT: 'Something changed at the same time. Refresh and try again.',
  },
};

const ko: CallsCopy = {
  title: '전화', chooseSchool: '전화 내역을 보려면 학교를 선택하세요.',
  intro: '문자를 보내는 학교 번호로 주고받은 전화입니다. 부재중 전화, 음성 메일, 통화 결과가 연락처에 함께 남습니다.',
  loading: '전화 내역을 불러오는 중…', hidden: '전화 내역이 숨겨져 있습니다.', show: '전화 내역 보기', refresh: '새로 고침',
  deniedTitle: '현재 역할로는 사용할 수 없습니다', denied: '이 학교의 전화 권한이 필요합니다.', sessionEnded: '세션이 끝났습니다. 다시 로그인하세요.',
  unavailable: '지금은 전화 기능을 사용할 수 없습니다. 잠시 후 다시 시도하세요.',
  unknownSave: '변경 내용을 확인하지 못했습니다. 저장되었을 수 있습니다. 새로 고침하여 현재 상태를 확인하세요.',
  schoolNumber: '학교 번호', noNumber: '이 학교에는 아직 문자 번호가 없습니다. 전화도 같은 번호를 사용합니다.', setUpNumber: '학교 번호 설정',
  callingOn: '전화 사용 중', callingOff: '전화 꺼짐',
  callingOffHint: '학교 번호로 온 전화는 계속 착신 전환 전화로 연결되고, 부재중 전화 문자 회신도 계속 작동합니다.',
  missedToday: n => `오늘 부재중 전화 ${n}건`, unheard: n => `새 음성 메일 ${n}건`,
  ringMe: '내게 울리기', ringMeHint: '학교 번호로 전화가 오면 이 브라우저의 HON에서 나에게도 울립니다. 내게 울리기를 켠 다른 직원에게도 함께 울립니다.',
  ringMeOn: '내게 울리기가 켜져 있습니다.', ringMeOff: '내게 울리기가 꺼져 있습니다.', ringing: names => `울리는 사람: ${names}`, nobodyRings: '내게 울리기를 켠 사람이 없어 전화는 착신 전환 전화로 갑니다.',
  forwardingNote: '약 20초 안에 아무도 받지 않으면 발신자는 음성 메일 인사말을 듣습니다.', textBackNote: '부재중 발신자에게는 부재중 전화 문자도 보내집니다.',
  log: '통화 기록', filters: { ALL: '전체', MISSED: '부재중', VOICEMAIL: '음성 메일', OUTGOING: '발신' },
  empty: '아직 통화가 없습니다.', emptyFiltered: '이 필터에 맞는 통화가 없습니다.', more: '더 보기',
  incoming: '수신', outgoing: '발신', unknownCaller: '알 수 없는 발신자', by: name => `${name} 처리`,
  status: { INITIATED: '시작 중', RINGING: '울리는 중', IN_PROGRESS: '통화 중', COMPLETED: '받음', NO_ANSWER: '응답 없음', BUSY: '통화 중이었음', FAILED: '연결 안 됨',
    CANCELED: '취소됨', MISSED: '부재중', VOICEMAIL: '음성 메일', EXPIRED: '연결되지 않음' },
  voicemailNew: '새 음성 메일', voicemailHeard: '음성 메일', recorded: '녹음됨', doNotCallBadge: '전화 금지', open: '자세히',
  card: name => `${name}와(과)의 통화`, outcome: '통화 결과는?',
  outcomes: { TRIAL_BOOKED: '체험 예약', CALL_BACK: '다시 전화', INTERESTED: '관심 있음', NOT_INTERESTED: '관심 없음', LEFT_VOICEMAIL: '음성 메일 남김', WRONG_NUMBER: '잘못된 번호', OTHER: '기타' },
  clearOutcome: '지우기', note: '메모', noteHint: '최대 1,000자. 이 통화에 저장되고 연락처 기록에서 볼 수 있습니다.', save: '저장', saved: '저장했습니다.',
  markHeard: '음성 메일 들음으로 표시', markedHeard: '음성 메일을 들음으로 표시했습니다.', recordingLater: '녹음과 음성 메일 재생은 브라우저 전화와 함께 제공됩니다.',
  doNotCall: '전화 금지', doNotCallHint: '이 학교에서는 이 번호로 전화를 걸지 않습니다.',
  addDoNotCall: '전화 금지에 추가', removeDoNotCall: '전화 금지에서 제거', doNotCallAdded: '전화 금지 목록에 추가했습니다.', doNotCallRemoved: '전화 금지 목록에서 제거했습니다.',
  settings: '전화 설정', settingsHint: '학교 원장만 변경할 수 있습니다.', turnOn: '이 학교의 전화 켜기',
  greeting: '음성 메일 인사말', greetingHint: '일반 텍스트, 최대 300자. HON이 발신자에게 읽어 줍니다. 비워 두면 기본 인사말을 사용합니다.',
  recording: '통화 녹음', recordingHint: '기본값은 꺼짐입니다. 녹음되는 통화는 "이 통화는 녹음될 수 있습니다" 안내로 시작합니다.',
  consentLabel: '이 내용에 동의합니다', consentAccepted: when => `${when} 동의함`, saveSettings: '설정 저장', settingsSaved: '전화 설정을 저장했습니다.',
  ownerOnly: '전화 설정 변경은 학교 원장에게 요청하세요.',
  refusal: {
    VALIDATION_FAILED: '받아들여지지 않았습니다. 메모나 인사말을 확인하고 다시 시도하세요.',
    CALLING_OFF: '이 학교는 전화가 꺼져 있습니다. 원장이 전화 설정에서 켤 수 있습니다.',
    CALL_NUMBER_NOT_READY: '학교 번호가 아직 활성화되지 않았습니다.',
    CALL_NUMBER_NOT_ALLOWED: 'HON은 미국과 캐나다 번호로만 전화하며, 유료·카리브해·특수 번호나 학교 자체 전화로는 걸지 않습니다.',
    CALL_DO_NOT_CALL: '이 번호는 전화 금지 목록에 있습니다.',
    CALL_PERSON_PHONE_MISMATCH: '이 번호는 해당 연락처의 전화번호가 아닙니다.',
    RECORDING_CONSENT_REQUIRED: '녹음을 켜기 전에 녹음 안내에 동의하세요.',
    CALL_RATE_LIMITED: '이번 시간에 전화를 많이 걸었습니다. 나중에 다시 시도하세요.',
    CALL_PERSON_NOT_FOUND: '이 학교에서 해당 연락처를 사용할 수 없습니다.', CALL_NOT_FOUND: '해당 통화를 사용할 수 없습니다.',
    CALLING_VERSION_CONFLICT: '전화 설정이 바뀌었습니다. 다시 불러왔으니 다시 시도하세요.', CALL_VERSION_CONFLICT: '이 통화가 바뀌었습니다. 다시 불러왔으니 다시 시도하세요.',
    IDEMPOTENCY_KEY_REUSED: '이전 시도와 맞출 수 없습니다. 새로 고침 후 다시 시도하세요.', CALL_CONFLICT: '동시에 다른 변경이 있었습니다. 새로 고침 후 다시 시도하세요.',
  },
};

const es: CallsCopy = {
  title: 'Llamadas', chooseSchool: 'Elige una escuela para ver sus llamadas.',
  intro: 'Llamadas hacia y desde el número de tu escuela, el mismo con el que envías textos. Las llamadas perdidas, el buzón de voz y lo que pasó en cada llamada quedan con el contacto.',
  loading: 'Cargando llamadas…', hidden: 'Las llamadas están ocultas.', show: 'Mostrar llamadas', refresh: 'Actualizar',
  deniedTitle: 'No disponible para tu rol', denied: 'Necesitas el permiso de llamadas en esta escuela.', sessionEnded: 'Tu sesión terminó. Inicia sesión de nuevo.',
  unavailable: 'Las llamadas no están disponibles ahora. Inténtalo de nuevo en un momento.',
  unknownSave: 'No pudimos confirmar el cambio. Es posible que se haya guardado. Actualiza para ver el estado actual.',
  schoolNumber: 'Número de la escuela', noNumber: 'Esta escuela aún no tiene número de textos. Las llamadas usan el mismo número.', setUpNumber: 'Configurar el número de la escuela',
  callingOn: 'Las llamadas están activadas', callingOff: 'Las llamadas están desactivadas',
  callingOffHint: 'Las llamadas al número de la escuela siguen desviándose a tu teléfono de desvío y el texto por llamada perdida sigue funcionando.',
  missedToday: n => (n === 1 ? '1 llamada perdida hoy' : `${n} llamadas perdidas hoy`), unheard: n => (n === 1 ? '1 mensaje de voz nuevo' : `${n} mensajes de voz nuevos`),
  ringMe: 'Llamarme', ringMeHint: 'Cuando llamen al número de la escuela, HON sonará para ti en este navegador, junto con todos los que tengan Llamarme activado.',
  ringMeOn: 'Llamarme está activado para ti.', ringMeOff: 'Llamarme está desactivado para ti.', ringing: names => `Suena para: ${names}`, nobodyRings: 'Nadie tiene Llamarme activado, así que las llamadas van al teléfono de desvío.',
  forwardingNote: 'Si nadie contesta en unos 20 segundos, quien llama oye tu saludo del buzón de voz.', textBackNote: 'Quien llamó y no fue atendido también recibe tu texto de llamada perdida.',
  log: 'Registro de llamadas', filters: { ALL: 'Todas', MISSED: 'Perdidas', VOICEMAIL: 'Buzón de voz', OUTGOING: 'Salientes' },
  empty: 'Aún no hay llamadas.', emptyFiltered: 'Ninguna llamada coincide con este filtro.', more: 'Mostrar más',
  incoming: 'Entrante', outgoing: 'Saliente', unknownCaller: 'Número desconocido', by: name => `por ${name}`,
  status: { INITIATED: 'Iniciando', RINGING: 'Sonando', IN_PROGRESS: 'En la llamada', COMPLETED: 'Contestada', NO_ANSWER: 'Sin respuesta', BUSY: 'Ocupado', FAILED: 'No conectó',
    CANCELED: 'Cancelada', MISSED: 'Perdida', VOICEMAIL: 'Buzón de voz', EXPIRED: 'No conectada' },
  voicemailNew: 'Mensaje de voz nuevo', voicemailHeard: 'Mensaje de voz', recorded: 'Grabada', doNotCallBadge: 'No llamar', open: 'Detalles',
  card: name => `Llamada con ${name}`, outcome: '¿Qué pasó?',
  outcomes: { TRIAL_BOOKED: 'Clase de prueba reservada', CALL_BACK: 'Volver a llamar', INTERESTED: 'Interesado', NOT_INTERESTED: 'No interesado', LEFT_VOICEMAIL: 'Dejé mensaje', WRONG_NUMBER: 'Número equivocado', OTHER: 'Otro' },
  clearOutcome: 'Borrar', note: 'Nota', noteHint: 'Hasta 1.000 caracteres. Se guarda en esta llamada y se ve en el historial del contacto.', save: 'Guardar', saved: 'Guardado.',
  markHeard: 'Marcar mensaje de voz como escuchado', markedHeard: 'Mensaje de voz marcado como escuchado.', recordingLater: 'La reproducción de grabaciones y mensajes de voz llega con el teléfono del navegador.',
  doNotCall: 'No llamar', doNotCallHint: 'HON no hará llamadas a este número desde esta escuela.',
  addDoNotCall: 'Agregar a no llamar', removeDoNotCall: 'Quitar de no llamar', doNotCallAdded: 'Agregado a la lista de no llamar.', doNotCallRemoved: 'Quitado de la lista de no llamar.',
  settings: 'Configuración de llamadas', settingsHint: 'Solo el dueño de la escuela puede cambiarla.', turnOn: 'Activar las llamadas para esta escuela',
  greeting: 'Saludo del buzón de voz', greetingHint: 'Texto simple, hasta 300 caracteres. HON lo lee a quien llama. Déjalo en blanco para el saludo estándar.',
  recording: 'Grabar llamadas', recordingHint: 'Desactivado por defecto. Las llamadas grabadas empiezan con "Esta llamada puede ser grabada".',
  consentLabel: 'Acepto esta declaración', consentAccepted: when => `Aceptada ${when}`, saveSettings: 'Guardar configuración', settingsSaved: 'Configuración de llamadas guardada.',
  ownerOnly: 'Pide al dueño de la escuela que cambie la configuración de llamadas.',
  refusal: {
    VALIDATION_FAILED: 'No se aceptó. Revisa la nota o el saludo e inténtalo de nuevo.',
    CALLING_OFF: 'Las llamadas están desactivadas en esta escuela. El dueño puede activarlas en Configuración de llamadas.',
    CALL_NUMBER_NOT_READY: 'El número de la escuela aún no está activo.',
    CALL_NUMBER_NOT_ALLOWED: 'HON solo llama a números de EE. UU. y Canadá, nunca a números premium, del Caribe o especiales, ni a los teléfonos de la escuela.',
    CALL_DO_NOT_CALL: 'Este número está en la lista de no llamar.',
    CALL_PERSON_PHONE_MISMATCH: 'Ese número no es el teléfono de este contacto.',
    RECORDING_CONSENT_REQUIRED: 'Acepta la declaración de grabación antes de activar la grabación.',
    CALL_RATE_LIMITED: 'Hiciste muchas llamadas en esta hora. Inténtalo más tarde.',
    CALL_PERSON_NOT_FOUND: 'Ese contacto no está disponible en esta escuela.', CALL_NOT_FOUND: 'Esa llamada no está disponible.',
    CALLING_VERSION_CONFLICT: 'La configuración de llamadas cambió. Se volvió a cargar; inténtalo de nuevo.', CALL_VERSION_CONFLICT: 'Esta llamada cambió. Se volvió a cargar; inténtalo de nuevo.',
    IDEMPOTENCY_KEY_REUSED: 'No se pudo relacionar con el intento anterior. Actualiza e inténtalo de nuevo.', CALL_CONFLICT: 'Algo cambió al mismo tiempo. Actualiza e inténtalo de nuevo.',
  },
};

export function callsCopy(language: Language): CallsCopy { return language === 'ko' ? ko : language === 'es' ? es : en; }
