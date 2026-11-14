/** Wording for AI on access exceptions (0353), en / ko / es. Labels only; nothing here is authority or an outcome. */
const en = {
  title: 'AI on free-access schools',
  intro: 'A school on an access exception has no AI unless the HQ owner sets a monthly AI limit for it. With a limit, HON and the AI team answer until this month\'s AI cost reaches it. Images and videos stay off. This is HON\'s own cost, never a charge to the school.',
  loading: 'Reading AI limits…', unavailable: 'AI limits could not be read or checked. Nothing is shown.', denied: 'Your HQ access does not include AI limits.', none: 'No school has an access exception right now.',
  aiOn: 'AI on', aiOff: 'AI off', aiScheduled: 'Limit set, starts with the exception',
  limit: 'Monthly AI limit', noLimit: 'None', used: 'Used this month', of: '{used} of {limit}', ends: 'Exception ends {date}',
  NORMAL: 'Under 75%', WARNING_75: 'Over 75%', WARNING_90: 'Over 90%', CEILING_REACHED: 'Limit reached: AI paused until next month or a higher limit', NO_CEILING: '',
  ownerOnly: 'Only the HQ owner can set or remove an AI limit.',
  setOpen: 'Turn on AI with a limit', changeOpen: 'Change limit', clearOpen: 'Turn off AI',
  setTitle: 'Monthly AI limit for {school}', clearTitle: 'Turn off AI for {school}', amount: 'Dollars per month', amountHelp: '$1 to $1,000. Suggested: ${dflt}.',
  reason: 'Reason', reasonHelp: '10 to 500 characters. Saved in the audit record.', save: 'Save limit', clear: 'Turn off AI', cancel: 'Cancel',
  clearNote: 'HON and the AI team stop answering for this school at once.',
  sending: 'Sending… keep this tab open.', done: 'Saved. The list was read again.',
  unknown: 'We could not confirm whether this went through. Try again sends the same request; it never applies twice.', tryAgain: 'Try again',
  changed: 'This school changed since it was read (or its exception ended), so nothing was done. The list was read again.',
  notAllowed: 'Only the HQ owner can do this. Nothing was changed.', invalid: 'This was not accepted. Check the details and try again.',
  localInvalid: 'Enter $1 to $1,000 and a reason of 10 to 500 characters.', localInvalidClear: 'Give a reason of 10 to 500 characters.',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  title: '무료 접근 도장의 AI',
  intro: '접근 예외 중인 도장은 HQ 소유자가 월 AI 한도를 정하지 않으면 AI를 쓸 수 없습니다. 한도를 정하면 이번 달 AI 비용이 한도에 닿을 때까지 HON과 AI 팀이 답합니다. 이미지와 동영상은 계속 꺼져 있습니다. HON의 자체 비용이며 도장에 청구되지 않습니다.',
  loading: 'AI 한도를 읽는 중…', unavailable: 'AI 한도를 읽거나 확인할 수 없습니다. 아무것도 표시되지 않습니다.', denied: 'HQ 권한에 AI 한도가 포함되어 있지 않습니다.', none: '지금 접근 예외 중인 도장이 없습니다.',
  aiOn: 'AI 켜짐', aiOff: 'AI 꺼짐', aiScheduled: '한도 설정됨, 예외 시작 시 적용',
  limit: '월 AI 한도', noLimit: '없음', used: '이번 달 사용', of: '{limit} 중 {used}', ends: '예외 종료 {date}',
  NORMAL: '75% 미만', WARNING_75: '75% 초과', WARNING_90: '90% 초과', CEILING_REACHED: '한도 도달: 다음 달 또는 한도 상향까지 AI 중지', NO_CEILING: '',
  ownerOnly: 'AI 한도 설정과 해제는 HQ 소유자만 할 수 있습니다.',
  setOpen: '한도를 정해 AI 켜기', changeOpen: '한도 변경', clearOpen: 'AI 끄기',
  setTitle: '{school}의 월 AI 한도', clearTitle: '{school}의 AI 끄기', amount: '월 달러', amountHelp: '$1~$1,000. 권장: ${dflt}.',
  reason: '사유', reasonHelp: '10~500자. 감사 기록에 저장됩니다.', save: '한도 저장', clear: 'AI 끄기', cancel: '취소',
  clearNote: '이 도장에서 HON과 AI 팀이 즉시 답을 멈춥니다.',
  sending: '보내는 중… 이 탭을 열어 두세요.', done: '저장했습니다. 목록을 다시 읽었습니다.',
  unknown: '처리되었는지 확인할 수 없습니다. 다시 시도하면 같은 요청을 보내며 두 번 적용되지 않습니다.', tryAgain: '다시 시도',
  changed: '읽은 뒤 이 도장이 바뀌었거나 예외가 끝나 아무것도 하지 않았습니다. 목록을 다시 읽었습니다.',
  notAllowed: 'HQ 소유자만 할 수 있습니다. 바뀐 것은 없습니다.', invalid: '받아들여지지 않았습니다. 세부 정보를 확인하고 다시 시도하세요.',
  localInvalid: '$1~$1,000과 10~500자의 사유를 입력하세요.', localInvalidClear: '10~500자의 사유를 입력하세요.',
};
const es: Record<Key, string> = {
  title: 'IA en escuelas con acceso gratuito',
  intro: 'Una escuela con una excepción de acceso no tiene IA a menos que el dueño de HQ le fije un límite mensual de IA. Con un límite, HON y el equipo de IA responden hasta que el costo de IA del mes lo alcance. Las imágenes y los videos siguen desactivados. Es un costo propio de HON, nunca un cobro a la escuela.',
  loading: 'Leyendo los límites de IA…', unavailable: 'No se pudieron leer ni comprobar los límites de IA. No se muestra nada.', denied: 'Tu acceso de HQ no incluye los límites de IA.', none: 'Ninguna escuela tiene una excepción de acceso ahora.',
  aiOn: 'IA activa', aiOff: 'IA desactivada', aiScheduled: 'Límite fijado, empieza con la excepción',
  limit: 'Límite mensual de IA', noLimit: 'Ninguno', used: 'Usado este mes', of: '{used} de {limit}', ends: 'La excepción termina el {date}',
  NORMAL: 'Menos del 75%', WARNING_75: 'Más del 75%', WARNING_90: 'Más del 90%', CEILING_REACHED: 'Límite alcanzado: IA en pausa hasta el próximo mes o un límite mayor', NO_CEILING: '',
  ownerOnly: 'Solo el dueño de HQ puede fijar o quitar un límite de IA.',
  setOpen: 'Activar IA con un límite', changeOpen: 'Cambiar límite', clearOpen: 'Desactivar IA',
  setTitle: 'Límite mensual de IA para {school}', clearTitle: 'Desactivar IA para {school}', amount: 'Dólares al mes', amountHelp: 'De $1 a $1,000. Sugerido: ${dflt}.',
  reason: 'Motivo', reasonHelp: 'De 10 a 500 caracteres. Se guarda en el registro de auditoría.', save: 'Guardar límite', clear: 'Desactivar IA', cancel: 'Cancelar',
  clearNote: 'HON y el equipo de IA dejan de responder para esta escuela al instante.',
  sending: 'Enviando… mantén esta pestaña abierta.', done: 'Guardado. La lista se volvió a leer.',
  unknown: 'No pudimos confirmar si se realizó. Reintentar envía la misma solicitud; nunca se aplica dos veces.', tryAgain: 'Reintentar',
  changed: 'Esta escuela cambió desde que se leyó (o su excepción terminó), así que no se hizo nada. La lista se volvió a leer.',
  notAllowed: 'Solo el dueño de HQ puede hacer esto. No se cambió nada.', invalid: 'No se aceptó. Revisa los datos e inténtalo de nuevo.',
  localInvalid: 'Indica de $1 a $1,000 y un motivo de 10 a 500 caracteres.', localInvalidClear: 'Indica un motivo de 10 a 500 caracteres.',
};
export type ExceptionAiKey = Key;
export function exceptionAiText(language: string, key: Key, vars: Record<string, string> = {}): string {
  const text = (language === 'ko' ? ko : language === 'es' ? es : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '');
}
