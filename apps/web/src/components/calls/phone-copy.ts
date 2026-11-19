import type { Language } from '@hon/design-system';
import type { PhoneUnavailable } from './phone';

export type PhoneCopy = {
  open: string; close: string; title: string; loading: string; number: string; numberHint: string; call: string; calling: (who: string) => string;
  onCall: (who: string) => string; incoming: (who: string) => string; answer: string; decline: string; hangUp: string; mute: string; unmute: string;
  keypad: string; ended: (who: string) => string; addNotes: string; again: string; callsPage: string; ringMeOn: string; ringMeOff: string;
  unavailable: Record<Exclude<PhoneUnavailable, 'READY'>, string>;
  problemNumber: string; problemUnknown: string; problemMicrophone: string; problemDropped: string; unknownCaller: string;
  refusal: Record<string, string>;
};

const en: PhoneCopy = {
  open: 'Phone', close: 'Close phone', title: 'Call from the school number', loading: 'Getting the phone ready…',
  number: 'Number to call', numberHint: 'US and Canada numbers, for example (512) 555-0101.', call: 'Call', calling: who => `Calling ${who}…`,
  onCall: who => `On a call with ${who}`, incoming: who => `Incoming call from ${who}`, answer: 'Answer', decline: 'Decline', hangUp: 'Hang up', mute: 'Mute', unmute: 'Unmute',
  keypad: 'Keypad', ended: who => `Call with ${who} ended.`, addNotes: 'Add what happened', again: 'New call', callsPage: 'Open Calls',
  ringMeOn: 'Calls to the school number ring here.', ringMeOff: 'Turn on Ring me on the Calls page to answer calls here.',
  unavailable: {
    CALLING_OFF: 'Calling is off at this school. The owner can turn it on on the Calls page.',
    NUMBER_NOT_READY: 'The school number is not active yet.',
    PHONE_NOT_SET_UP: 'The browser phone is not set up for this school yet.',
    VOICE_NOT_APPROVED: 'Calling is built but switched off until HON approves voice calls for schools.',
    ERROR: 'The phone is unavailable right now. Try again in a moment.',
  },
  problemNumber: 'HON calls US and Canada numbers only. Check the number.',
  problemUnknown: 'We could not confirm the call started. Press Call again: the same number will not be called twice.',
  problemMicrophone: 'HON needs your microphone for calls. Allow it in your browser and try again.',
  problemDropped: 'The call did not connect. Try again.', unknownCaller: 'Unknown caller',
  refusal: {
    CALLING_OFF: 'Calling is off at this school.', CALL_NUMBER_NOT_READY: 'The school number is not active yet.',
    CALL_NUMBER_NOT_ALLOWED: 'HON calls US and Canada numbers only, never premium, Caribbean or special numbers, or the school’s own phones.',
    CALL_DO_NOT_CALL: 'This number is on the do-not-call list.', CALL_PERSON_PHONE_MISMATCH: 'That number is not this contact’s phone number.',
    CALL_RATE_LIMITED: 'You have placed a lot of calls this hour. Try again later.', CALL_PERSON_NOT_FOUND: 'That contact is not available at this school.',
    IDEMPOTENCY_KEY_REUSED: 'This could not be matched to the earlier attempt. Try again.', VALIDATION_FAILED: 'Check the number and try again.',
  },
};
const ko: PhoneCopy = {
  open: '전화', close: '전화 닫기', title: '학교 번호로 전화하기', loading: '전화를 준비하는 중…',
  number: '전화할 번호', numberHint: '미국과 캐나다 번호. 예: (512) 555-0101', call: '전화', calling: who => `${who}에게 전화하는 중…`,
  onCall: who => `${who}와(과) 통화 중`, incoming: who => `${who}에게서 전화가 왔습니다`, answer: '받기', decline: '거절', hangUp: '끊기', mute: '음소거', unmute: '음소거 해제',
  keypad: '키패드', ended: who => `${who}와(과)의 통화가 끝났습니다.`, addNotes: '통화 결과 남기기', again: '새 전화', callsPage: '전화 페이지 열기',
  ringMeOn: '학교 번호로 온 전화가 여기에서 울립니다.', ringMeOff: '여기에서 전화를 받으려면 전화 페이지에서 내게 울리기를 켜세요.',
  unavailable: {
    CALLING_OFF: '이 학교는 전화가 꺼져 있습니다. 원장이 전화 페이지에서 켤 수 있습니다.', NUMBER_NOT_READY: '학교 번호가 아직 활성화되지 않았습니다.',
    PHONE_NOT_SET_UP: '이 학교의 브라우저 전화가 아직 설정되지 않았습니다.', VOICE_NOT_APPROVED: '전화 기능은 준비되었지만 HON이 학교 음성 통화를 승인할 때까지 꺼져 있습니다.',
    ERROR: '지금은 전화를 사용할 수 없습니다. 잠시 후 다시 시도하세요.',
  },
  problemNumber: 'HON은 미국과 캐나다 번호로만 전화합니다. 번호를 확인하세요.',
  problemUnknown: '전화가 시작되었는지 확인하지 못했습니다. 다시 전화를 누르세요. 같은 번호로 두 번 걸리지 않습니다.',
  problemMicrophone: '전화에는 마이크가 필요합니다. 브라우저에서 허용한 후 다시 시도하세요.', problemDropped: '전화가 연결되지 않았습니다. 다시 시도하세요.', unknownCaller: '알 수 없는 발신자',
  refusal: {
    CALLING_OFF: '이 학교는 전화가 꺼져 있습니다.', CALL_NUMBER_NOT_READY: '학교 번호가 아직 활성화되지 않았습니다.',
    CALL_NUMBER_NOT_ALLOWED: 'HON은 미국과 캐나다 번호로만 전화하며, 유료·카리브해·특수 번호나 학교 자체 전화로는 걸지 않습니다.',
    CALL_DO_NOT_CALL: '이 번호는 전화 금지 목록에 있습니다.', CALL_PERSON_PHONE_MISMATCH: '이 번호는 해당 연락처의 전화번호가 아닙니다.',
    CALL_RATE_LIMITED: '이번 시간에 전화를 많이 걸었습니다. 나중에 다시 시도하세요.', CALL_PERSON_NOT_FOUND: '이 학교에서 해당 연락처를 사용할 수 없습니다.',
    IDEMPOTENCY_KEY_REUSED: '이전 시도와 맞출 수 없습니다. 다시 시도하세요.', VALIDATION_FAILED: '번호를 확인하고 다시 시도하세요.',
  },
};
const es: PhoneCopy = {
  open: 'Teléfono', close: 'Cerrar teléfono', title: 'Llamar desde el número de la escuela', loading: 'Preparando el teléfono…',
  number: 'Número a llamar', numberHint: 'Números de EE. UU. y Canadá, por ejemplo (512) 555-0101.', call: 'Llamar', calling: who => `Llamando a ${who}…`,
  onCall: who => `En llamada con ${who}`, incoming: who => `Llamada entrante de ${who}`, answer: 'Contestar', decline: 'Rechazar', hangUp: 'Colgar', mute: 'Silenciar', unmute: 'Activar sonido',
  keypad: 'Teclado', ended: who => `Terminó la llamada con ${who}.`, addNotes: 'Anotar qué pasó', again: 'Nueva llamada', callsPage: 'Abrir Llamadas',
  ringMeOn: 'Las llamadas al número de la escuela suenan aquí.', ringMeOff: 'Activa Llamarme en la página de Llamadas para contestar aquí.',
  unavailable: {
    CALLING_OFF: 'Las llamadas están desactivadas en esta escuela. El dueño puede activarlas en la página de Llamadas.', NUMBER_NOT_READY: 'El número de la escuela aún no está activo.',
    PHONE_NOT_SET_UP: 'El teléfono del navegador aún no está configurado para esta escuela.',
    VOICE_NOT_APPROVED: 'Las llamadas están listas pero desactivadas hasta que HON apruebe las llamadas de voz para escuelas.',
    ERROR: 'El teléfono no está disponible ahora. Inténtalo de nuevo en un momento.',
  },
  problemNumber: 'HON solo llama a números de EE. UU. y Canadá. Revisa el número.',
  problemUnknown: 'No pudimos confirmar que la llamada empezó. Presiona Llamar otra vez: no se llamará dos veces al mismo número.',
  problemMicrophone: 'HON necesita tu micrófono para llamar. Permítelo en tu navegador e inténtalo de nuevo.', problemDropped: 'La llamada no conectó. Inténtalo de nuevo.', unknownCaller: 'Número desconocido',
  refusal: {
    CALLING_OFF: 'Las llamadas están desactivadas en esta escuela.', CALL_NUMBER_NOT_READY: 'El número de la escuela aún no está activo.',
    CALL_NUMBER_NOT_ALLOWED: 'HON solo llama a números de EE. UU. y Canadá, nunca a números premium, del Caribe o especiales, ni a los teléfonos de la escuela.',
    CALL_DO_NOT_CALL: 'Este número está en la lista de no llamar.', CALL_PERSON_PHONE_MISMATCH: 'Ese número no es el teléfono de este contacto.',
    CALL_RATE_LIMITED: 'Hiciste muchas llamadas en esta hora. Inténtalo más tarde.', CALL_PERSON_NOT_FOUND: 'Ese contacto no está disponible en esta escuela.',
    IDEMPOTENCY_KEY_REUSED: 'No se pudo relacionar con el intento anterior. Inténtalo de nuevo.', VALIDATION_FAILED: 'Revisa el número e inténtalo de nuevo.',
  },
};
export function phoneCopy(language: Language | string): PhoneCopy { return language === 'ko' ? ko : language === 'es' ? es : en; }
