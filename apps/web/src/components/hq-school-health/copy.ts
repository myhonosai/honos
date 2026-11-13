/** HQ school health wording (en / ko / es). Signals are hints for a person to look; nothing here is an outcome. */
const en = {
  cardTitle: 'Activity health', cardIntro: 'Activity over the last 30 days compared with the 30 before. Signals are hints to take a look, not a judgment.',
  loading: 'Reading activity…', denied: 'Your HQ access does not include school health. Nothing is shown.',
  unavailable: 'Activity could not be read or checked. Nothing is shown.', gone: 'This school was not found.', invalid: 'This school link is not valid.',
  noSignals: 'No signals. Nothing here needs a look right now.',
  signalsLabel: 'Signals',
  NO_ACTIVE_STUDENTS: 'No active students', NO_ATTENDANCE_14_DAYS: 'No visits in 14 days', ATTENDANCE_DOWN: 'Visits down by more than half',
  NO_CLASSES_NEXT_14_DAYS: 'No classes in the next 14 days', NO_NEW_LEADS_30_DAYS: 'No new leads in 30 days', OPEN_SUPPORT_CASES: 'Open support cases',
  metric: 'Activity', last30: 'Last 30 days', previous30: '30 days before',
  visits: 'Visits (present, late, make-up)', classesHeld: 'Classes held', bookings: 'Bookings', newLeads: 'New leads', wonLeads: 'Leads won',
  lastVisit: 'Last visit', never: 'None recorded', upcoming: 'Classes in the next 14 days', openLeads: 'Open leads', activeStudents: 'Active students',
  openCases: 'Open support cases', notCompared: '—',
  asOf: 'Read {time} UTC.',
  // Needing attention page
  title: 'Schools needing attention', back: 'All schools', refresh: 'Refresh',
  intro: 'Active schools with at least one activity signal, most signals first. Counts only: no names, no money. Use this to decide where to look; nothing changes from here.',
  concealed: 'School activity is hidden while this tab is in the background.', reveal: 'Show again',
  summary: '{flagged} of {checked} active schools have signals.', truncated: 'Showing the first {limit}. More schools have signals.',
  showMore: 'Show up to {limit}', none: 'No active school has a signal right now.',
  school: 'School', organization: 'Organization', signals: 'Signals', details: 'Counts',
  openSchool: 'School detail', openSupport: 'Support cases',
  supportOnlyNote: 'School detail opens only for HQ owners and billing operators.',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  cardTitle: '활동 현황', cardIntro: '최근 30일 활동을 그 전 30일과 비교합니다. 신호는 살펴볼 만한 힌트이며 판단이 아닙니다.',
  loading: '활동을 읽는 중…', denied: 'HQ 권한에 도장 현황이 포함되어 있지 않습니다. 아무것도 표시되지 않습니다.',
  unavailable: '활동을 읽거나 확인할 수 없습니다. 아무것도 표시되지 않습니다.', gone: '이 도장을 찾을 수 없습니다.', invalid: '이 도장 링크가 올바르지 않습니다.',
  noSignals: '신호 없음. 지금 살펴볼 것이 없습니다.',
  signalsLabel: '신호',
  NO_ACTIVE_STUDENTS: '활성 학생 없음', NO_ATTENDANCE_14_DAYS: '14일 동안 출석 없음', ATTENDANCE_DOWN: '출석이 절반 넘게 감소',
  NO_CLASSES_NEXT_14_DAYS: '앞으로 14일 동안 수업 없음', NO_NEW_LEADS_30_DAYS: '30일 동안 새 리드 없음', OPEN_SUPPORT_CASES: '진행 중인 지원 건',
  metric: '활동', last30: '최근 30일', previous30: '그 전 30일',
  visits: '출석(출석, 지각, 보강)', classesHeld: '진행된 수업', bookings: '예약', newLeads: '새 리드', wonLeads: '성사된 리드',
  lastVisit: '마지막 출석', never: '기록 없음', upcoming: '앞으로 14일 수업', openLeads: '진행 중인 리드', activeStudents: '활성 학생',
  openCases: '진행 중인 지원 건', notCompared: '—',
  asOf: '{time} UTC에 읽음.',
  title: '살펴볼 도장', back: '모든 도장', refresh: '새로 고침',
  intro: '활동 신호가 하나 이상 있는 활성 도장을 신호가 많은 순서로 보여 줍니다. 숫자만 표시하며 이름이나 금액은 없습니다. 어디를 살펴볼지 정하는 용도이며 여기서 바뀌는 것은 없습니다.',
  concealed: '이 탭이 백그라운드에 있는 동안 도장 활동이 숨겨집니다.', reveal: '다시 보기',
  summary: '활성 도장 {checked}곳 중 {flagged}곳에 신호가 있습니다.', truncated: '처음 {limit}곳만 표시합니다. 신호가 있는 도장이 더 있습니다.',
  showMore: '최대 {limit}곳 보기', none: '지금 신호가 있는 활성 도장이 없습니다.',
  school: '도장', organization: '조직', signals: '신호', details: '숫자',
  openSchool: '도장 상세', openSupport: '지원 건',
  supportOnlyNote: '도장 상세는 HQ 소유자와 결제 담당 운영자만 열 수 있습니다.',
};
const es: Record<Key, string> = {
  cardTitle: 'Salud de la actividad', cardIntro: 'Actividad de los últimos 30 días comparada con los 30 anteriores. Las señales son pistas para revisar, no un juicio.',
  loading: 'Leyendo la actividad…', denied: 'Tu acceso de HQ no incluye la salud de las escuelas. No se muestra nada.',
  unavailable: 'No se pudo leer ni comprobar la actividad. No se muestra nada.', gone: 'No se encontró esta escuela.', invalid: 'El enlace de esta escuela no es válido.',
  noSignals: 'Sin señales. Nada aquí necesita revisión ahora.',
  signalsLabel: 'Señales',
  NO_ACTIVE_STUDENTS: 'Sin alumnos activos', NO_ATTENDANCE_14_DAYS: 'Sin asistencias en 14 días', ATTENDANCE_DOWN: 'Asistencias bajaron más de la mitad',
  NO_CLASSES_NEXT_14_DAYS: 'Sin clases en los próximos 14 días', NO_NEW_LEADS_30_DAYS: 'Sin nuevos prospectos en 30 días', OPEN_SUPPORT_CASES: 'Casos de soporte abiertos',
  metric: 'Actividad', last30: 'Últimos 30 días', previous30: '30 días anteriores',
  visits: 'Asistencias (presente, tarde, recuperación)', classesHeld: 'Clases dadas', bookings: 'Reservas', newLeads: 'Nuevos prospectos', wonLeads: 'Prospectos ganados',
  lastVisit: 'Última asistencia', never: 'Ninguna registrada', upcoming: 'Clases en los próximos 14 días', openLeads: 'Prospectos abiertos', activeStudents: 'Alumnos activos',
  openCases: 'Casos de soporte abiertos', notCompared: '—',
  asOf: 'Leído {time} UTC.',
  title: 'Escuelas que necesitan atención', back: 'Todas las escuelas', refresh: 'Actualizar',
  intro: 'Escuelas activas con al menos una señal de actividad, primero las que tienen más señales. Solo cifras: sin nombres ni dinero. Sirve para decidir dónde revisar; nada cambia desde aquí.',
  concealed: 'La actividad de las escuelas se oculta mientras esta pestaña está en segundo plano.', reveal: 'Mostrar de nuevo',
  summary: '{flagged} de {checked} escuelas activas tienen señales.', truncated: 'Se muestran las primeras {limit}. Hay más escuelas con señales.',
  showMore: 'Mostrar hasta {limit}', none: 'Ninguna escuela activa tiene señales ahora.',
  school: 'Escuela', organization: 'Organización', signals: 'Señales', details: 'Cifras',
  openSchool: 'Detalle de la escuela', openSupport: 'Casos de soporte',
  supportOnlyNote: 'El detalle de la escuela solo se abre para dueños de HQ y operadores de facturación.',
};
export type HealthKey = Key;
export function healthText(language: string, key: Key, vars: Record<string, string> = {}): string {
  const text = (language === 'ko' ? ko : language === 'es' ? es : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '');
}
