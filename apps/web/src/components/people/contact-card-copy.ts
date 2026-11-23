/** Contact card wording (C2, 0522), en / ko / es. Labels only; nothing here is authority. */
const en = {
  editProfile: 'Edit profile', foldDetails: 'Details', foldMemberships: 'Memberships', foldStart: 'New or renew', foldInvoices: 'Invoices', foldEvents: 'Past events',
  tabsLabel: 'Contact sections', overview: 'Overview', family: 'Family', appointments: 'Appointments', tasks: 'Follow-ups', membership: 'Membership',
  billing: 'Billing', messages: 'Messages', timeline: 'Timeline', loading: 'Reading this contact…', unavailable: 'This contact’s card could not be loaded.',
  notAllowed: 'Your role doesn’t include this.', none: 'Nothing yet.', addedOn: 'Added {date}', openLead: 'Has an open lead',
  plan: 'Plan', program: 'Program', ends: 'Membership ends', belt: 'Belt', noPlan: 'No plan on file', noBelt: 'No belt yet',
  billingContact: 'billing contact', role_GUARDIAN: 'Guardian', role_STUDENT: 'Student', role_DEPENDENT: 'Dependent', role_OTHER: 'Other',
  due: 'Due {date}', openBalance: 'Open balance', nothingOwed: 'Nothing owed', paidOf: '{paid} paid of {total}',
  directMessages: 'Messages sent to this person: {n}', familyMessages: 'Family thread messages: {n}',
  kind_PERSON_ADDED: 'Added to the school', kind_LEAD_OPENED: 'Lead opened', kind_LEAD_WON: 'Lead won', kind_LEAD_LOST: 'Lead lost', kind_APPOINTMENT: 'Appointment',
  kind_MEMBERSHIP_STARTED: 'Membership started', kind_MEMBERSHIP_ENDED: 'Membership ended', kind_PAYMENT: 'Payment recorded', kind_ATTENDANCE: 'Attendance',
  timelineNote: 'Past events you may see, newest first.', added: 'In your records', priority_HIGH: 'High', priority_NORMAL: 'Normal', priority_LOW: 'Low',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  editProfile: '프로필 수정', foldDetails: '상세 정보', foldMemberships: '회원권', foldStart: '신규 또는 갱신', foldInvoices: '청구서', foldEvents: '지난 활동',
  tabsLabel: '연락처 항목', overview: '개요', family: '가족', appointments: '예약', tasks: '후속 조치', membership: '회원권',
  billing: '결제', messages: '메시지', timeline: '활동 기록', loading: '연락처를 읽는 중…', unavailable: '이 연락처 카드를 불러오지 못했습니다.',
  notAllowed: '내 역할에는 이 항목이 포함되지 않습니다.', none: '아직 없습니다.', addedOn: '{date} 등록', openLead: '진행 중인 리드 있음',
  plan: '플랜', program: '프로그램', ends: '회원권 종료', belt: '띠', noPlan: '등록된 플랜 없음', noBelt: '아직 띠 없음',
  billingContact: '결제 담당', role_GUARDIAN: '보호자', role_STUDENT: '학생', role_DEPENDENT: '피부양자', role_OTHER: '기타',
  due: '{date} 마감', openBalance: '미결제 금액', nothingOwed: '미결제 없음', paidOf: '{total} 중 {paid} 결제',
  directMessages: '이 사람에게 보낸 메시지: {n}', familyMessages: '가족 대화 메시지: {n}',
  kind_PERSON_ADDED: '학교에 등록됨', kind_LEAD_OPENED: '리드 생성', kind_LEAD_WON: '리드 성사', kind_LEAD_LOST: '리드 실패', kind_APPOINTMENT: '예약',
  kind_MEMBERSHIP_STARTED: '회원권 시작', kind_MEMBERSHIP_ENDED: '회원권 종료', kind_PAYMENT: '결제 기록', kind_ATTENDANCE: '출석',
  timelineNote: '볼 수 있는 지난 활동을 최신순으로 보여 줍니다.', added: '등록', priority_HIGH: '높음', priority_NORMAL: '보통', priority_LOW: '낮음',
};
const es: Record<Key, string> = {
  editProfile: 'Editar perfil', foldDetails: 'Detalles', foldMemberships: 'Membresías', foldStart: 'Nueva o renovación', foldInvoices: 'Facturas', foldEvents: 'Eventos pasados',
  tabsLabel: 'Secciones del contacto', overview: 'Resumen', family: 'Familia', appointments: 'Citas', tasks: 'Seguimientos', membership: 'Membresía',
  billing: 'Facturación', messages: 'Mensajes', timeline: 'Historial', loading: 'Leyendo este contacto…', unavailable: 'No se pudo cargar la ficha de este contacto.',
  notAllowed: 'Su rol no incluye esto.', none: 'Nada todavía.', addedOn: 'Agregado el {date}', openLead: 'Tiene un interesado abierto',
  plan: 'Plan', program: 'Programa', ends: 'La membresía termina', belt: 'Cinturón', noPlan: 'Sin plan registrado', noBelt: 'Sin cinturón todavía',
  billingContact: 'contacto de pago', role_GUARDIAN: 'Tutor', role_STUDENT: 'Alumno', role_DEPENDENT: 'Dependiente', role_OTHER: 'Otro',
  due: 'Vence el {date}', openBalance: 'Saldo pendiente', nothingOwed: 'Nada pendiente', paidOf: '{paid} pagado de {total}',
  directMessages: 'Mensajes enviados a esta persona: {n}', familyMessages: 'Mensajes del hilo familiar: {n}',
  kind_PERSON_ADDED: 'Agregado a la escuela', kind_LEAD_OPENED: 'Interesado abierto', kind_LEAD_WON: 'Interesado ganado', kind_LEAD_LOST: 'Interesado perdido', kind_APPOINTMENT: 'Cita',
  kind_MEMBERSHIP_STARTED: 'Membresía iniciada', kind_MEMBERSHIP_ENDED: 'Membresía terminada', kind_PAYMENT: 'Pago registrado', kind_ATTENDANCE: 'Asistencia',
  timelineNote: 'Eventos pasados que puede ver, del más reciente al más antiguo.', added: 'En sus registros', priority_HIGH: 'Alta', priority_NORMAL: 'Normal', priority_LOW: 'Baja',
};
export type CardKey = Key;
export function cardText(language: string, key: Key, vars: Readonly<Record<string, string | number>> = {}): string {
  const base = language.toLowerCase().split('-')[0];
  const text = (base === 'ko' ? ko : base === 'es' ? es : en)[key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}
export const CARD_COPY = { en, ko, es } as const;

/** Closed status codes on the card, in words. Unknown codes fall back to a readable form, never the raw code. */
const CODES: Readonly<Record<string, readonly [string, string, string]>> = {
  TRIAL: ['Trial', '체험', 'Prueba'], CONSULTATION: ['Consultation', '상담', 'Consulta'],
  SCHEDULED: ['Scheduled', '예정', 'Programada'], COMPLETED: ['Completed', '완료', 'Completada'], CANCELLED: ['Cancelled', '취소됨', 'Cancelada'], NO_SHOW: ['No-show', '불참', 'No asistió'],
  PRESENT: ['Present', '출석', 'Presente'], LATE: ['Late', '지각', 'Tarde'], EXCUSED_ABSENCE: ['Excused absence', '사유 결석', 'Ausencia justificada'],
  UNEXCUSED_ABSENCE: ['Absent', '결석', 'Ausente'], MAKEUP: ['Make-up class', '보강', 'Clase de recuperación'],
  DRAFT: ['Not started yet', '아직 시작 전', 'Aún sin empezar'], ACTIVE: ['Active', '활성', 'Activa'], FROZEN: ['Paused', '일시정지', 'En pausa'], CANCELLATION_PENDING: ['Cancelling', '취소 예정', 'Cancelación pendiente'], EXPIRED: ['Ended', '만료', 'Terminada'],
  ISSUED: ['Open', '미결제', 'Pendiente'], PAID: ['Paid', '결제 완료', 'Pagada'], VOID: ['Void', '무효', 'Anulada'], UNCOLLECTIBLE: ['Written off', '회수 불가', 'Incobrable'],
};
export function codeLabel(language: string, code: string): string {
  const base = language.toLowerCase().split('-')[0], i = base === 'ko' ? 1 : base === 'es' ? 2 : 0;
  const known = CODES[code];
  if (known) return known[i];
  const words = code.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
