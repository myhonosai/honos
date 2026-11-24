import type { TimesheetFlag } from '@hon/contracts';
import type { HoursErrorKind } from './http';

/** Staff > Hours copy (en, ko, es). ko and es are typed against en, so a missing key fails `pnpm check`. */
export type HoursOutcomeKind = 'SAVING' | 'PUNCHED' | 'SAVED' | 'APPROVED_WEEK' | 'REOPENED' | HoursErrorKind;
export interface HoursCopy {
  pageTitle: string; intro: string; checking: string; hidden: string; chooseSchool: string; reading: string;
  denied: string; unavailable: string; refresh: string; tryAgain: string;
  clockTitle: string; offClock: string; onClock: (since: string) => string; serverTime: string;
  clockIn: string; clockOut: string; todayShift: (range: string) => string; noShiftToday: string;
  thisWeek: string; weekApproved: string; noEntries: string;
  sheetTitle: string; previous: string; current: string; next: string; weekOf: (range: string) => string; timezone: (zone: string) => string;
  person: string; worked: string; scheduled: string; checks: string; status: string; entries: string;
  inOut: (from: string, to: string) => string; stillIn: (from: string) => string; byManager: string;
  hours: (minutes: number) => string; approvedTag: string; openTag: string;
  approve: string; reopen: string; addEntry: (name: string) => string; fixEntry: string; exportCsv: string; noStaff: string;
  formAdd: string; formFix: string; fieldPerson: string; fieldIn: string; fieldOut: string;
  fieldReason: string; reasonHint: string; save: string; close: string;
  problems: { person: string; times: string; reason: string };
  flags: Record<TimesheetFlag, string>;
  csv: { header: string[]; total: string; clock: string; manager: string; fileName: (weekStart: string) => string };
  outcomes: Record<HoursOutcomeKind, string>;
  permissionsHint: string; noPay: string;
}

const hours = (locale: string) => (minutes: number) => `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(minutes / 60)} h`;

const en: HoursCopy = {
  pageTitle: 'Hours',
  intro: 'Clock in and out here. Managers review, fix and approve the team’s weekly hours. Times are in the school’s time zone.',
  checking: 'Checking your school…', hidden: 'Hidden while you were away.', chooseSchool: 'Choose a school first.', reading: 'Reading…',
  denied: 'You can’t use the time clock at this school. Ask the owner to give your role “Clock in and out” in Roles & permissions.',
  unavailable: 'Hours could not be read right now. Refresh to try again.', refresh: 'Refresh', tryAgain: 'Try again',
  clockTitle: 'Time clock', offClock: 'Off the clock', onClock: (since) => `On the clock since ${since}`,
  serverTime: 'The time is taken from HON’s clock, not your device.',
  clockIn: 'Clock in', clockOut: 'Clock out',
  todayShift: (range) => `Today’s shift: ${range}`, noShiftToday: 'No shift scheduled today.',
  thisWeek: 'This week', weekApproved: 'This week is approved. Ask a manager to reopen it to clock in.', noEntries: 'No time this week yet.',
  sheetTitle: 'Timesheets', previous: 'Previous week', current: 'This week', next: 'Next week', weekOf: (range) => `Week of ${range}`, timezone: (zone) => `Times in ${zone}`,
  person: 'Staff', worked: 'Worked', scheduled: 'Scheduled', checks: 'Checks', status: 'Status', entries: 'Entries',
  inOut: (from, to) => `${from} – ${to}`, stillIn: (from) => `${from} – still clocked in`, byManager: 'added by a manager',
  hours: hours('en'), approvedTag: 'Approved', openTag: 'Not approved',
  approve: 'Approve week', reopen: 'Reopen week', addEntry: (name) => `Add time for ${name}`, fixEntry: 'Fix', exportCsv: 'Export CSV', noStaff: 'No staff at this school yet.',
  formAdd: 'Add missed time', formFix: 'Fix an entry', fieldPerson: 'Staff member', fieldIn: 'Clock in', fieldOut: 'Clock out',
  fieldReason: 'Reason (required)', reasonHint: 'For example: forgot to clock out.', save: 'Save entry', close: 'Close',
  problems: { person: 'Choose a staff member.', times: 'Clock out must be after clock in, and the entry at most 24 hours.',
    reason: 'Give a reason of 3 to 300 characters, no < or >.' },
  flags: { STILL_CLOCKED_IN: 'Still clocked in', LONG_ENTRY: 'An entry over 16 h' },
  csv: { header: ['Staff', 'Date', 'Clock in', 'Clock out', 'Worked hours', 'Scheduled hours', 'Notes'],
    total: 'Week total', clock: 'Time clock', manager: 'Added by a manager', fileName: (w) => `hours-week-of-${w}.csv` },
  outcomes: {
    SAVING: 'Saving…', PUNCHED: 'Done.', SAVED: 'Entry saved.', APPROVED_WEEK: 'Week approved.', REOPENED: 'Week reopened.',
    SESSION: 'Your session ended. Sign in again.', DENIED: 'Not saved: you can’t do this here (the person may no longer be staff).',
    CHANGED: 'Not saved: this changed on another screen or device. It was read again.', OVERLAP: 'Not saved: this overlaps another entry for this person.',
    APPROVED: 'Not saved: this week is approved. Reopen it first.', OPEN_ENTRY: 'Not approved: someone is still clocked in that week.',
    TOO_LONG: 'Not clocked out: this entry is over 24 hours. Ask a manager to fix it.', GONE: 'Not saved: this entry is gone. It was read again.',
    INVALID: 'Not saved: check the entry and try again.', RATE: 'Too many requests. Wait a moment, then try again.',
    UNKNOWN: 'We could not confirm this. Try again sends the same request; it will not record the time twice.',
  },
  permissionsHint: 'To let instructors and front-desk staff clock in, give their role “Clock in and out” in Roles & permissions.',
  noPay: 'HON tracks hours only. It does not calculate pay.',
};
const ko: HoursCopy = {
  pageTitle: '근무 시간',
  intro: '여기에서 출근과 퇴근을 기록하세요. 관리자는 팀의 주간 근무 시간을 검토, 수정, 승인합니다. 시간은 도장 시간대 기준입니다.',
  checking: '도장을 확인하는 중…', hidden: '자리를 비운 동안 숨겼습니다.', chooseSchool: '먼저 도장을 선택하세요.', reading: '불러오는 중…',
  denied: '이 도장에서 출퇴근 기록을 사용할 수 없습니다. 소유자에게 역할 및 권한에서 “출퇴근 기록”을 요청하세요.',
  unavailable: '지금은 근무 시간을 불러올 수 없습니다. 새로 고쳐 다시 시도하세요.', refresh: '새로 고침', tryAgain: '다시 시도',
  clockTitle: '출퇴근 기록', offClock: '근무 중 아님', onClock: (since) => `${since}부터 근무 중`,
  serverTime: '시간은 기기가 아닌 HON 시계 기준으로 기록됩니다.',
  clockIn: '출근', clockOut: '퇴근',
  todayShift: (range) => `오늘 근무: ${range}`, noShiftToday: '오늘 배정된 근무가 없습니다.',
  thisWeek: '이번 주', weekApproved: '이번 주는 승인되었습니다. 출근하려면 관리자에게 다시 열어 달라고 요청하세요.', noEntries: '이번 주 기록이 아직 없습니다.',
  sheetTitle: '근무 기록표', previous: '이전 주', current: '이번 주', next: '다음 주', weekOf: (range) => `${range} 주`, timezone: (zone) => `시간대: ${zone}`,
  person: '직원', worked: '근무', scheduled: '배정', checks: '확인', status: '상태', entries: '기록',
  inOut: (from, to) => `${from} – ${to}`, stillIn: (from) => `${from} – 아직 근무 중`, byManager: '관리자가 추가',
  hours: hours('ko'), approvedTag: '승인됨', openTag: '미승인',
  approve: '주간 승인', reopen: '주간 다시 열기', addEntry: (name) => `${name} 시간 추가`, fixEntry: '수정', exportCsv: 'CSV 내보내기', noStaff: '아직 직원이 없습니다.',
  formAdd: '누락된 시간 추가', formFix: '기록 수정', fieldPerson: '직원', fieldIn: '출근', fieldOut: '퇴근',
  fieldReason: '사유(필수)', reasonHint: '예: 퇴근 기록을 잊음.', save: '기록 저장', close: '닫기',
  problems: { person: '직원을 선택하세요.', times: '퇴근은 출근 이후여야 하며 기록은 최대 24시간입니다.',
    reason: '3~300자 사유를 입력하세요. < > 불가.' },
  flags: { STILL_CLOCKED_IN: '아직 근무 중', LONG_ENTRY: '16시간 넘는 기록' },
  csv: { header: ['직원', '날짜', '출근', '퇴근', '근무(시간)', '배정(시간)', '비고'],
    total: '주간 합계', clock: '출퇴근 기록', manager: '관리자가 추가', fileName: (w) => `hours-week-of-${w}.csv` },
  outcomes: {
    SAVING: '저장 중…', PUNCHED: '완료.', SAVED: '기록을 저장했습니다.', APPROVED_WEEK: '주간을 승인했습니다.', REOPENED: '주간을 다시 열었습니다.',
    SESSION: '세션이 끝났습니다. 다시 로그인하세요.', DENIED: '저장되지 않음: 여기에서 할 수 없습니다(더 이상 직원이 아닐 수 있음).',
    CHANGED: '저장되지 않음: 다른 화면이나 기기에서 변경되었습니다. 다시 불러왔습니다.', OVERLAP: '저장되지 않음: 이 사람의 다른 기록과 겹칩니다.',
    APPROVED: '저장되지 않음: 이 주는 승인되었습니다. 먼저 다시 여세요.', OPEN_ENTRY: '승인되지 않음: 그 주에 아직 근무 중인 사람이 있습니다.',
    TOO_LONG: '퇴근되지 않음: 이 기록은 24시간을 넘었습니다. 관리자에게 수정을 요청하세요.', GONE: '저장되지 않음: 이 기록이 없습니다. 다시 불러왔습니다.',
    INVALID: '저장되지 않음: 기록을 확인하고 다시 시도하세요.', RATE: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
    UNKNOWN: '확인하지 못했습니다. 다시 시도하면 같은 요청을 보내며 시간이 두 번 기록되지 않습니다.',
  },
  permissionsHint: '사범과 프런트 직원이 출퇴근을 기록하게 하려면 역할 및 권한에서 “출퇴근 기록”을 주세요.',
  noPay: 'HON은 근무 시간만 기록합니다. 급여는 계산하지 않습니다.',
};
const es: HoursCopy = {
  pageTitle: 'Horas',
  intro: 'Marca tu entrada y salida aquí. Los encargados revisan, corrigen y aprueban las horas semanales del equipo. Las horas están en la zona horaria de la escuela.',
  checking: 'Comprobando tu escuela…', hidden: 'Oculto mientras no estabas.', chooseSchool: 'Primero elige una escuela.', reading: 'Leyendo…',
  denied: 'No puedes usar el reloj en esta escuela. Pide al propietario que dé a tu rol “Marcar entrada y salida” en Roles y permisos.',
  unavailable: 'No se pudieron leer las horas ahora. Actualiza para intentarlo de nuevo.', refresh: 'Actualizar', tryAgain: 'Intentar de nuevo',
  clockTitle: 'Reloj', offClock: 'Fuera de turno', onClock: (since) => `Trabajando desde las ${since}`,
  serverTime: 'La hora se toma del reloj de HON, no de tu dispositivo.',
  clockIn: 'Marcar entrada', clockOut: 'Marcar salida',
  todayShift: (range) => `Turno de hoy: ${range}`, noShiftToday: 'No hay turno hoy.',
  thisWeek: 'Esta semana', weekApproved: 'Esta semana está aprobada. Pide a un encargado que la reabra para marcar entrada.', noEntries: 'Aún no hay horas esta semana.',
  sheetTitle: 'Hojas de horas', previous: 'Semana anterior', current: 'Esta semana', next: 'Semana siguiente', weekOf: (range) => `Semana del ${range}`, timezone: (zone) => `Horas en ${zone}`,
  person: 'Personal', worked: 'Trabajado', scheduled: 'Programado', checks: 'Revisar', status: 'Estado', entries: 'Registros',
  inOut: (from, to) => `${from} – ${to}`, stillIn: (from) => `${from} – aún trabajando`, byManager: 'añadido por un encargado',
  hours: hours('es'), approvedTag: 'Aprobada', openTag: 'Sin aprobar',
  approve: 'Aprobar semana', reopen: 'Reabrir semana', addEntry: (name) => `Añadir horas para ${name}`, fixEntry: 'Corregir', exportCsv: 'Exportar CSV', noStaff: 'Aún no hay personal.',
  formAdd: 'Añadir horas olvidadas', formFix: 'Corregir un registro', fieldPerson: 'Miembro del personal', fieldIn: 'Entrada', fieldOut: 'Salida',
  fieldReason: 'Motivo (obligatorio)', reasonHint: 'Por ejemplo: olvidó marcar la salida.', save: 'Guardar registro', close: 'Cerrar',
  problems: { person: 'Elige a un miembro del personal.', times: 'La salida debe ser después de la entrada, y el registro de 24 horas como máximo.',
    reason: 'Escribe un motivo de 3 a 300 caracteres, sin < ni >.' },
  flags: { STILL_CLOCKED_IN: 'Aún trabajando', LONG_ENTRY: 'Un registro de más de 16 h' },
  csv: { header: ['Personal', 'Fecha', 'Entrada', 'Salida', 'Horas trabajadas', 'Horas programadas', 'Notas'],
    total: 'Total de la semana', clock: 'Reloj', manager: 'Añadido por un encargado', fileName: (w) => `hours-week-of-${w}.csv` },
  outcomes: {
    SAVING: 'Guardando…', PUNCHED: 'Hecho.', SAVED: 'Registro guardado.', APPROVED_WEEK: 'Semana aprobada.', REOPENED: 'Semana reabierta.',
    SESSION: 'Tu sesión terminó. Inicia sesión de nuevo.', DENIED: 'No se guardó: no puedes hacer esto aquí (puede que la persona ya no sea personal).',
    CHANGED: 'No se guardó: esto cambió en otra pantalla o dispositivo. Se leyó de nuevo.', OVERLAP: 'No se guardó: se solapa con otro registro de esta persona.',
    APPROVED: 'No se guardó: esta semana está aprobada. Reábrela primero.', OPEN_ENTRY: 'No se aprobó: alguien aún está trabajando esa semana.',
    TOO_LONG: 'No se marcó la salida: este registro supera las 24 horas. Pide a un encargado que lo corrija.', GONE: 'No se guardó: este registro ya no existe. Se leyó de nuevo.',
    INVALID: 'No se guardó: revisa el registro e inténtalo de nuevo.', RATE: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.',
    UNKNOWN: 'No pudimos confirmarlo. Intentar de nuevo envía la misma solicitud; no registrará la hora dos veces.',
  },
  permissionsHint: 'Para que instructores y recepción marquen entrada, da a su rol “Marcar entrada y salida” en Roles y permisos.',
  noPay: 'HON solo registra horas. No calcula salarios.',
};
export const HOURS_COPY = { en, ko, es } as const;
export function hoursCopy(language: string): HoursCopy { return language === 'ko' ? ko : language === 'es' ? es : en; }
