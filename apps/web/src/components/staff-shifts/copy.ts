import type { ShiftErrorKind } from './http';

/** Staff > Shifts copy (en, ko, es). ko and es are typed against en, so a missing key fails `pnpm check`. */
export type ShiftOutcomeKind = 'SAVING' | 'SAVED' | 'CANCELLED' | ShiftErrorKind;
export interface ShiftCopy {
  pageTitle: string; manageIntro: string; ownIntro: string; checking: string; hidden: string; chooseSchool: string; reading: string;
  denied: string; unavailable: string; refresh: string; tryAgain: string;
  previous: string; thisWeek: string; next: string; weekOf: (range: string) => string; timezone: (zone: string) => string;
  person: string; total: string; dayTotal: string; hours: (minutes: number) => string; noStaff: string; noShifts: string;
  add: string; addFor: (name: string, day: string) => string; edit: (name: string, time: string) => string;
  showCancelled: string; cancelledTag: string; outsideAvailability: string;
  formAdd: string; formEdit: string; fieldPerson: string; fieldDate: string; fieldStart: string; fieldEnd: string; fieldPosition: string; fieldNote: string;
  positionHint: string; save: string; close: string; cancelShift: string; confirmCancel: string; keepShift: string;
  problems: { person: string; date: string; times: string; position: string; note: string };
  outcomes: Record<ShiftOutcomeKind, string>;
  permissionsHint: string;
}

const hours = (locale: string) => (minutes: number) => {
  const h = minutes / 60;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(h)} h`;
};

const en: ShiftCopy = {
  pageTitle: 'Shifts',
  manageIntro: 'Put your team on shifts for the week. Times are in the school’s time zone. Staff see their own shifts on this page.',
  ownIntro: 'Your shifts for the week, in the school’s time zone.',
  checking: 'Checking your school…', hidden: 'Hidden while you were away.', chooseSchool: 'Choose a school first.', reading: 'Reading…',
  denied: 'You can’t see shifts at this school. Ask the owner to give your role “See their own shifts” in Roles & permissions.',
  unavailable: 'Shifts could not be read right now. Refresh to try again.', refresh: 'Refresh', tryAgain: 'Try again',
  previous: 'Previous week', thisWeek: 'This week', next: 'Next week', weekOf: (range) => `Week of ${range}`, timezone: (zone) => `Times in ${zone}`,
  person: 'Staff', total: 'Week', dayTotal: 'Day total', hours: hours('en'), noStaff: 'No staff at this school yet. Invite your team under Staff > Team & invitations.',
  noShifts: 'No shifts this week.',
  add: 'Add shift', addFor: (name, day) => `Add a shift for ${name} on ${day}`, edit: (name, time) => `Change ${name}’s shift ${time}`,
  showCancelled: 'Show cancelled shifts', cancelledTag: 'Cancelled', outsideAvailability: 'Outside availability',
  formAdd: 'Add a shift', formEdit: 'Change shift', fieldPerson: 'Staff member', fieldDate: 'Date', fieldStart: 'Start', fieldEnd: 'End',
  fieldPosition: 'Position (optional)', fieldNote: 'Note (optional)', positionHint: 'For example Front desk or Instructor.',
  save: 'Save shift', close: 'Close', cancelShift: 'Cancel this shift', confirmCancel: 'Yes, cancel the shift', keepShift: 'Keep it',
  problems: { person: 'Choose a staff member.', date: 'Choose a date.', times: 'End must be 15 minutes to 16 hours after start, on the same day.',
    position: 'Position: up to 40 characters, no < or >.', note: 'Note: up to 300 characters, no < or >.' },
  outcomes: {
    SAVING: 'Saving…', SAVED: 'Shift saved.', CANCELLED: 'Shift cancelled.', SESSION: 'Your session ended. Sign in again.',
    DENIED: 'Not saved: you can’t schedule this person here (they may no longer be staff).', CHANGED: 'Not saved: someone changed this shift. The week was read again.',
    OVERLAP: 'Not saved: this person already has a shift at that time.', GONE: 'Not saved: this shift was cancelled or removed. The week was read again.',
    INVALID: 'Not saved: check the shift and try again.', RATE: 'Too many requests. Wait a moment, then try again.',
    UNKNOWN: 'We could not confirm the save. Try again sends the same request; it will not make a second shift.',
  },
  permissionsHint: 'To let instructors and front-desk staff see their own shifts, give their role “See their own shifts” in Roles & permissions.',
};
const ko: ShiftCopy = {
  pageTitle: '근무 일정',
  manageIntro: '이번 주 직원 근무를 배정하세요. 시간은 도장 시간대 기준입니다. 직원은 이 페이지에서 자신의 근무를 봅니다.',
  ownIntro: '이번 주 내 근무 일정입니다(도장 시간대 기준).',
  checking: '도장을 확인하는 중…', hidden: '자리를 비운 동안 숨겼습니다.', chooseSchool: '먼저 도장을 선택하세요.', reading: '불러오는 중…',
  denied: '이 도장의 근무 일정을 볼 수 없습니다. 소유자에게 역할 및 권한에서 “자신의 근무 보기”를 요청하세요.',
  unavailable: '지금은 근무 일정을 불러올 수 없습니다. 새로 고쳐 다시 시도하세요.', refresh: '새로 고침', tryAgain: '다시 시도',
  previous: '이전 주', thisWeek: '이번 주', next: '다음 주', weekOf: (range) => `${range} 주`, timezone: (zone) => `시간대: ${zone}`,
  person: '직원', total: '주간', dayTotal: '일 합계', hours: hours('ko'), noStaff: '아직 직원이 없습니다. 직원 > 팀 및 초대에서 팀을 초대하세요.',
  noShifts: '이번 주 근무가 없습니다.',
  add: '근무 추가', addFor: (name, day) => `${day} ${name} 근무 추가`, edit: (name, time) => `${name} 근무 ${time} 변경`,
  showCancelled: '취소된 근무 보기', cancelledTag: '취소됨', outsideAvailability: '근무 가능 시간 밖',
  formAdd: '근무 추가', formEdit: '근무 변경', fieldPerson: '직원', fieldDate: '날짜', fieldStart: '시작', fieldEnd: '종료',
  fieldPosition: '담당(선택)', fieldNote: '메모(선택)', positionHint: '예: 프런트 데스크, 사범.',
  save: '근무 저장', close: '닫기', cancelShift: '이 근무 취소', confirmCancel: '네, 근무를 취소합니다', keepShift: '유지',
  problems: { person: '직원을 선택하세요.', date: '날짜를 선택하세요.', times: '종료는 같은 날 시작 후 15분~16시간이어야 합니다.',
    position: '담당: 40자 이내, < > 불가.', note: '메모: 300자 이내, < > 불가.' },
  outcomes: {
    SAVING: '저장 중…', SAVED: '근무를 저장했습니다.', CANCELLED: '근무를 취소했습니다.', SESSION: '세션이 끝났습니다. 다시 로그인하세요.',
    DENIED: '저장되지 않음: 이 사람을 여기에서 배정할 수 없습니다(더 이상 직원이 아닐 수 있음).', CHANGED: '저장되지 않음: 누군가 이 근무를 변경했습니다. 주간을 다시 불러왔습니다.',
    OVERLAP: '저장되지 않음: 이 사람은 그 시간에 이미 근무가 있습니다.', GONE: '저장되지 않음: 이 근무는 취소되었거나 없습니다. 주간을 다시 불러왔습니다.',
    INVALID: '저장되지 않음: 근무를 확인하고 다시 시도하세요.', RATE: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
    UNKNOWN: '저장을 확인하지 못했습니다. 다시 시도하면 같은 요청을 보내며 근무가 두 번 생기지 않습니다.',
  },
  permissionsHint: '사범과 프런트 직원이 자신의 근무를 보게 하려면 역할 및 권한에서 “자신의 근무 보기”를 주세요.',
};
const es: ShiftCopy = {
  pageTitle: 'Turnos',
  manageIntro: 'Asigna turnos a tu equipo para la semana. Las horas están en la zona horaria de la escuela. El personal ve sus propios turnos en esta página.',
  ownIntro: 'Tus turnos de la semana, en la zona horaria de la escuela.',
  checking: 'Comprobando tu escuela…', hidden: 'Oculto mientras no estabas.', chooseSchool: 'Primero elige una escuela.', reading: 'Leyendo…',
  denied: 'No puedes ver los turnos de esta escuela. Pide al propietario que dé a tu rol “Ver sus propios turnos” en Roles y permisos.',
  unavailable: 'No se pudieron leer los turnos ahora. Actualiza para intentarlo de nuevo.', refresh: 'Actualizar', tryAgain: 'Intentar de nuevo',
  previous: 'Semana anterior', thisWeek: 'Esta semana', next: 'Semana siguiente', weekOf: (range) => `Semana del ${range}`, timezone: (zone) => `Horas en ${zone}`,
  person: 'Personal', total: 'Semana', dayTotal: 'Total del día', hours: hours('es'), noStaff: 'Aún no hay personal. Invita a tu equipo en Personal > Equipo e invitaciones.',
  noShifts: 'No hay turnos esta semana.',
  add: 'Añadir turno', addFor: (name, day) => `Añadir un turno para ${name} el ${day}`, edit: (name, time) => `Cambiar el turno de ${name} ${time}`,
  showCancelled: 'Mostrar turnos cancelados', cancelledTag: 'Cancelado', outsideAvailability: 'Fuera de disponibilidad',
  formAdd: 'Añadir un turno', formEdit: 'Cambiar turno', fieldPerson: 'Miembro del personal', fieldDate: 'Fecha', fieldStart: 'Inicio', fieldEnd: 'Fin',
  fieldPosition: 'Puesto (opcional)', fieldNote: 'Nota (opcional)', positionHint: 'Por ejemplo Recepción o Instructor.',
  save: 'Guardar turno', close: 'Cerrar', cancelShift: 'Cancelar este turno', confirmCancel: 'Sí, cancelar el turno', keepShift: 'Mantenerlo',
  problems: { person: 'Elige a un miembro del personal.', date: 'Elige una fecha.', times: 'El fin debe ser de 15 minutos a 16 horas después del inicio, el mismo día.',
    position: 'Puesto: hasta 40 caracteres, sin < ni >.', note: 'Nota: hasta 300 caracteres, sin < ni >.' },
  outcomes: {
    SAVING: 'Guardando…', SAVED: 'Turno guardado.', CANCELLED: 'Turno cancelado.', SESSION: 'Tu sesión terminó. Inicia sesión de nuevo.',
    DENIED: 'No se guardó: no puedes asignar a esta persona aquí (puede que ya no sea personal).', CHANGED: 'No se guardó: alguien cambió este turno. La semana se leyó de nuevo.',
    OVERLAP: 'No se guardó: esta persona ya tiene un turno a esa hora.', GONE: 'No se guardó: este turno fue cancelado o eliminado. La semana se leyó de nuevo.',
    INVALID: 'No se guardó: revisa el turno e inténtalo de nuevo.', RATE: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.',
    UNKNOWN: 'No pudimos confirmar el guardado. Intentar de nuevo envía la misma solicitud; no creará un segundo turno.',
  },
  permissionsHint: 'Para que instructores y recepción vean sus propios turnos, da a su rol “Ver sus propios turnos” en Roles y permisos.',
};
export const SHIFT_COPY = { en, ko, es } as const;
export function shiftCopy(language: string): ShiftCopy { return language === 'ko' ? ko : language === 'es' ? es : en; }
