/** Creative Studio wording (en / ko / es). Creative credits are for images and video only; the AI team never uses them. */
const en = {
  title: 'Creative Studio', intro: 'Images and video for your school’s marketing. Creative Studio uses your school’s creative credits. Conversations with HON and the AI team never use them.',
  createTitle: 'Create', createStatus: 'Not connected yet',
  createNote: 'Image and video creation is not connected yet. HON has not connected a creative provider, so nothing can be created here and nothing is charged.',
  createPlanned: 'When it is connected, you will describe what you need, HON will show the credits it uses before anything starts, and the result will appear here.',
  creditsTitle: 'Creative credits', available: 'Available', held: 'Held for work in progress', monthly: 'Included each month',
  programOff: 'Creative credits are not switched on for HON OS yet. Your balance is shown as recorded.',
  ineligible: 'Your school cannot use creative credits right now', windowLabel: 'Current month (UTC)',
  ratesTitle: 'What each creation uses', ratesNone: 'No creative rates are published yet.', provisional: 'Provisional',
  perImage: 'credits per image', perSecond: 'credits per second of video', perRequest: 'credits per request', maxUnits: 'Up to {n} per request',
  historyTitle: 'Recent credit activity', historyNone: 'No credit activity is recorded yet.',
  topupsTitle: 'Top-ups', topupsNote: 'Buying top-ups is not connected yet. No card is charged.', bonus: 'includes {n} bonus',
  IMAGE: 'Image', VIDEO: 'Video',
  waiting: 'Checking your school…', noSchool: 'Choose a school to open Creative Studio.', concealed: 'Creative Studio is hidden. Return to this tab to check your school again.',
  loading: 'Reading your school’s creative credits…', denied: 'Your access does not include creative credits at this school. Nothing is shown.',
  unavailable: 'Creative credits could not be read or checked. No numbers are shown.', refresh: 'Refresh',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  title: '크리에이티브 스튜디오', intro: '도장 마케팅용 이미지와 동영상입니다. 크리에이티브 스튜디오는 도장의 크리에이티브 크레딧을 사용합니다. HON 및 AI 팀과의 대화는 이 크레딧을 사용하지 않습니다.',
  createTitle: '만들기', createStatus: '아직 연결되지 않음',
  createNote: '이미지와 동영상 생성은 아직 연결되지 않았습니다. HON이 크리에이티브 제공업체를 연결하지 않았으므로 여기서는 아무것도 만들 수 없으며 요금도 청구되지 않습니다.',
  createPlanned: '연결되면 필요한 내용을 설명하고, 시작 전에 사용할 크레딧을 HON이 보여 주며, 결과가 여기에 표시됩니다.',
  creditsTitle: '크리에이티브 크레딧', available: '사용 가능', held: '진행 중인 작업에 예약됨', monthly: '매월 포함',
  programOff: 'HON OS의 크리에이티브 크레딧이 아직 켜지지 않았습니다. 기록된 잔액을 표시합니다.',
  ineligible: '현재 도장에서 크리에이티브 크레딧을 사용할 수 없습니다', windowLabel: '이번 달 (UTC)',
  ratesTitle: '생성별 사용 크레딧', ratesNone: '아직 게시된 크리에이티브 요율이 없습니다.', provisional: '잠정',
  perImage: '이미지당 크레딧', perSecond: '동영상 1초당 크레딧', perRequest: '요청당 크레딧', maxUnits: '요청당 최대 {n}',
  historyTitle: '최근 크레딧 활동', historyNone: '아직 기록된 크레딧 활동이 없습니다.',
  topupsTitle: '추가 크레딧', topupsNote: '추가 크레딧 구매는 아직 연결되지 않았습니다. 카드에 청구되지 않습니다.', bonus: '보너스 {n} 포함',
  IMAGE: '이미지', VIDEO: '동영상',
  waiting: '도장을 확인하는 중…', noSchool: '크리에이티브 스튜디오를 열려면 도장을 선택하세요.', concealed: '크리에이티브 스튜디오가 숨겨졌습니다. 이 탭으로 돌아오면 도장을 다시 확인합니다.',
  loading: '도장의 크리에이티브 크레딧을 읽는 중…', denied: '이 도장의 크리에이티브 크레딧에 대한 접근 권한이 없습니다. 아무것도 표시하지 않습니다.',
  unavailable: '크리에이티브 크레딧을 읽거나 확인할 수 없습니다. 숫자를 표시하지 않습니다.', refresh: '새로 고침',
};
const es: Record<Key, string> = {
  title: 'Estudio creativo', intro: 'Imágenes y video para el marketing de tu escuela. El Estudio creativo usa los créditos creativos de tu escuela. Las conversaciones con HON y el equipo de IA nunca los usan.',
  createTitle: 'Crear', createStatus: 'Aún no conectado',
  createNote: 'La creación de imágenes y video aún no está conectada. HON no ha conectado un proveedor creativo, así que aquí no se puede crear nada y no se cobra nada.',
  createPlanned: 'Cuando esté conectada, describirás lo que necesitas, HON mostrará los créditos que usará antes de empezar y el resultado aparecerá aquí.',
  creditsTitle: 'Créditos creativos', available: 'Disponibles', held: 'Reservados para trabajo en curso', monthly: 'Incluidos cada mes',
  programOff: 'Los créditos creativos aún no están activados en HON OS. El saldo se muestra tal como está registrado.',
  ineligible: 'Tu escuela no puede usar créditos creativos ahora', windowLabel: 'Mes actual (UTC)',
  ratesTitle: 'Lo que usa cada creación', ratesNone: 'Aún no hay tarifas creativas publicadas.', provisional: 'Provisional',
  perImage: 'créditos por imagen', perSecond: 'créditos por segundo de video', perRequest: 'créditos por solicitud', maxUnits: 'Hasta {n} por solicitud',
  historyTitle: 'Actividad reciente de créditos', historyNone: 'Aún no hay actividad de créditos registrada.',
  topupsTitle: 'Recargas', topupsNote: 'La compra de recargas aún no está conectada. No se cobra ninguna tarjeta.', bonus: 'incluye {n} de bonificación',
  IMAGE: 'Imagen', VIDEO: 'Video',
  waiting: 'Comprobando tu escuela…', noSchool: 'Elige una escuela para abrir el Estudio creativo.', concealed: 'El Estudio creativo está oculto. Vuelve a esta pestaña para comprobar tu escuela de nuevo.',
  loading: 'Leyendo los créditos creativos de tu escuela…', denied: 'Tu acceso no incluye los créditos creativos de esta escuela. No se muestra nada.',
  unavailable: 'No se pudieron leer ni comprobar los créditos creativos. No se muestran cifras.', refresh: 'Actualizar',
};
export type StudioKey = Key;
export function studioText(language: string, key: Key, vars: Record<string, string> = {}): string {
  const text = (language === 'ko' ? ko : language === 'es' ? es : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '');
}

const entry: Record<string, [string, string, string]> = {
  GRANT: ['Credits added', '크레딧 추가', 'Créditos añadidos'], RESERVE: ['Held for a creation', '생성용 예약', 'Reservados para una creación'],
  FINALIZE: ['Used by a creation', '생성에 사용됨', 'Usados en una creación'], RELEASE: ['Returned', '반환됨', 'Devueltos'],
  EXPIRE: ['Expired', '만료됨', 'Vencidos'], DEBIT: ['Correction', '정정', 'Corrección'],
};
export function studioEntryText(language: string, kind: string): string { return entry[kind]?.[language === 'ko' ? 1 : language === 'es' ? 2 : 0] ?? kind; }
