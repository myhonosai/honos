/** Leads screen wording (en / ko / es). */
const en = {
  title: 'Leads', intro: 'Every lead at your school in one place: who is new, who needs a follow-up, and which trials are booked.',
  readOnly: 'You can add a lead here. Other changes happen in the CRM journey and follow-ups, which check your access again.',
  refresh: 'Refresh', tabsLabel: 'Lead status', OPEN: 'Open', WON: 'Won', LOST: 'Lost', ARCHIVED: 'Archived', ALL: 'All',
  filterLabel: 'Filter the shown leads by name or email', listTitle: 'Leads at this school', listLoading: 'Reading leads…',
  listDenied: 'Your access does not include CRM leads at this school. Nothing is shown.', listUnavailable: 'Leads could not be loaded. Nothing is shown.',
  listNone: 'No leads with this status.', filterNone: 'No shown lead matches this filter.', listCapped: 'Showing up to {n} leads. Use the status tabs to narrow the list.',
  shown: '{n} shown', nextFollowUp: 'Next follow-up {date}', noFollowUp: 'No follow-up scheduled', added: 'Added {date}',
  pick: 'Choose a lead to see contact details, trials and next steps.', followUpLabel: 'Follow-up', addedLabel: 'Added', email: 'Email', phone: 'Phone', notRecorded: 'Not recorded',
  trialsTitle: 'Trials', trialsLoading: 'Reading trials…', trialsDenied: 'Your role does not include trial appointments at this school.',
  trialsUnavailable: 'Trials could not be loaded. Nothing is shown.', trialsNone: 'No trials booked yet.', upcoming: 'Upcoming trial',
  SCHEDULED: 'Scheduled', COMPLETED: 'Completed', NO_SHOW: 'No-show', CANCELLED: 'Cancelled', moreTrials: 'Showing the latest {n} trials.',
  nextSteps: 'Next steps', journey: 'Open in the CRM journey', journeyHelp: 'Book or record a trial, register, and set up a membership.',
  followUp: 'Plan a follow-up', membership: 'Membership setup and recovery', reload: 'Reload',
  waiting: 'Checking your school…', noSchool: 'Choose a school to see its leads.', concealed: 'Leads are hidden. Come back to this tab to check your school again.',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  title: '문의', intro: '학교의 모든 문의를 한곳에서: 새 문의, 후속 연락이 필요한 문의, 예약된 체험 수업.',
  readOnly: '여기서 문의를 추가할 수 있습니다. 다른 변경은 CRM 여정과 후속 연락에서 하며, 그곳에서 권한을 다시 확인합니다.',
  refresh: '새로 고침', tabsLabel: '문의 상태', OPEN: '진행 중', WON: '등록', LOST: '종료', ARCHIVED: '보관', ALL: '전체',
  filterLabel: '표시된 문의를 이름이나 이메일로 거르기', listTitle: '이 학교의 문의', listLoading: '문의를 읽는 중…',
  listDenied: '이 학교의 CRM 문의에 대한 권한이 없습니다. 아무것도 표시되지 않습니다.', listUnavailable: '문의를 불러올 수 없습니다. 아무것도 표시되지 않습니다.',
  listNone: '이 상태의 문의가 없습니다.', filterNone: '이 조건에 맞는 문의가 없습니다.', listCapped: '최대 {n}개의 문의를 표시합니다. 상태 탭으로 범위를 좁히세요.',
  shown: '{n}개 표시', nextFollowUp: '다음 후속 연락 {date}', noFollowUp: '예정된 후속 연락 없음', added: '{date} 추가',
  pick: '문의를 선택하면 연락처, 체험 수업, 다음 단계를 볼 수 있습니다.', followUpLabel: '후속 연락', addedLabel: '추가일', email: '이메일', phone: '전화', notRecorded: '기록 없음',
  trialsTitle: '체험 수업', trialsLoading: '체험 수업을 읽는 중…', trialsDenied: '이 학교의 체험 수업 예약에 대한 권한이 없습니다.',
  trialsUnavailable: '체험 수업을 불러올 수 없습니다. 아무것도 표시되지 않습니다.', trialsNone: '아직 예약된 체험 수업이 없습니다.', upcoming: '예정된 체험 수업',
  SCHEDULED: '예약됨', COMPLETED: '완료', NO_SHOW: '불참', CANCELLED: '취소', moreTrials: '최근 체험 수업 {n}개를 표시합니다.',
  nextSteps: '다음 단계', journey: 'CRM 여정에서 열기', journeyHelp: '체험 수업 예약·기록, 등록, 멤버십 설정.',
  followUp: '후속 연락 계획', membership: '멤버십 설정 및 복구', reload: '다시 불러오기',
  waiting: '학교를 확인하는 중…', noSchool: '문의를 보려면 학교를 선택하세요.', concealed: '문의가 숨겨졌습니다. 이 탭으로 돌아오면 학교를 다시 확인합니다.',
};
const es: Record<Key, string> = {
  title: 'Prospectos', intro: 'Todos los prospectos de tu escuela en un lugar: quién es nuevo, quién necesita seguimiento y qué clases de prueba están reservadas.',
  readOnly: 'Aquí puedes agregar un prospecto. Los demás cambios se hacen en el recorrido de CRM y en los seguimientos, que vuelven a comprobar tu acceso.',
  refresh: 'Actualizar', tabsLabel: 'Estado del prospecto', OPEN: 'Abiertos', WON: 'Ganados', LOST: 'Perdidos', ARCHIVED: 'Archivados', ALL: 'Todos',
  filterLabel: 'Filtra los prospectos mostrados por nombre o correo', listTitle: 'Prospectos de esta escuela', listLoading: 'Leyendo prospectos…',
  listDenied: 'Tu acceso no incluye los prospectos de CRM de esta escuela. No se muestra nada.', listUnavailable: 'No se pudieron cargar los prospectos. No se muestra nada.',
  listNone: 'No hay prospectos con este estado.', filterNone: 'Ningún prospecto mostrado coincide con este filtro.', listCapped: 'Se muestran hasta {n} prospectos. Usa las pestañas de estado para acotar la lista.',
  shown: '{n} mostrados', nextFollowUp: 'Próximo seguimiento {date}', noFollowUp: 'Sin seguimiento programado', added: 'Agregado {date}',
  pick: 'Elige un prospecto para ver su contacto, clases de prueba y próximos pasos.', followUpLabel: 'Seguimiento', addedLabel: 'Agregado', email: 'Correo', phone: 'Teléfono', notRecorded: 'Sin registrar',
  trialsTitle: 'Clases de prueba', trialsLoading: 'Leyendo clases de prueba…', trialsDenied: 'Tu función no incluye las citas de prueba de esta escuela.',
  trialsUnavailable: 'No se pudieron cargar las clases de prueba. No se muestra nada.', trialsNone: 'Aún no hay clases de prueba reservadas.', upcoming: 'Próxima clase de prueba',
  SCHEDULED: 'Programada', COMPLETED: 'Completada', NO_SHOW: 'No asistió', CANCELLED: 'Cancelada', moreTrials: 'Se muestran las últimas {n} clases de prueba.',
  nextSteps: 'Próximos pasos', journey: 'Abrir en el recorrido de CRM', journeyHelp: 'Reserva o registra una clase de prueba, inscribe y configura una membresía.',
  followUp: 'Planear un seguimiento', membership: 'Configuración y recuperación de membresía', reload: 'Volver a cargar',
  waiting: 'Comprobando tu escuela…', noSchool: 'Elige una escuela para ver sus prospectos.', concealed: 'Los prospectos están ocultos. Vuelve a esta pestaña para comprobar tu escuela de nuevo.',
};
export type LeadsKey = Key;
export function leadsText(language: string, key: Key, vars: Record<string, string> = {}): string {
  const text = (language === 'ko' ? ko : language === 'es' ? es : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '');
}
export const LEADS_LANGUAGES = { en, ko, es };
