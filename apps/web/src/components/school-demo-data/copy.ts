import type { SchoolDemoDataCountKey } from '@hon/contracts';
import type { DemoErrorKind } from './http';

/** Settings > Demo data copy (en, ko, es). ko and es are typed against en, so a missing key fails `pnpm check`. */
export type DemoLanguage = 'en' | 'ko' | 'es';
export type DemoOutcomeKind = 'LOADING' | 'REMOVING' | 'LOADED' | 'REMOVED' | DemoErrorKind;
export interface DemoCopy {
  pageTitle: string; pageIntro: string; checking: string; hidden: string; chooseSchool: string; reading: string; denied: string; unavailable: string;
  noneTitle: string; noneLead: string; includes: readonly string[]; safety: readonly string[]; load: string; lastRemoved: (at: string) => string;
  loadedTitle: string; loadedLead: (at: string) => string; countsTitle: string; counts: Record<SchoolDemoDataCountKey, string>;
  remove: string; confirmTitle: string; confirmLead: string; confirmYes: string; confirmNo: string; refresh: string; tryAgain: string;
  inUseTitle: string; inUseLead: string; table: (name: string) => string;
  outcomes: Record<DemoOutcomeKind, string>;
  banner: string; bannerLink: string; summaryTitle: string; summaryLine: string;
}

const humanTable = (name: string) => name.replace(/_/g, ' ');

const en: DemoCopy = {
  pageTitle: 'Demo data',
  pageIntro: 'Try every page of HON with a made-up school before you import your real students. When you are ready, remove the demo data with one button. Your real records are never touched.',
  checking: 'Checking your school…', hidden: 'Hidden while you were away.', chooseSchool: 'Choose a school first.', reading: 'Reading…',
  denied: 'Only a school owner can load or remove demo data, and the school needs an active plan or trial.',
  unavailable: 'Demo data could not be read right now. Refresh to try again.',
  noneTitle: 'No demo data loaded', noneLead: 'Loading adds a made-up school to your account:',
  includes: ['3 programs with a weekly class each, and class times for the last 4 weeks and the next 2', '20 families and 8 adult students (38 students in all)',
    'A membership for each student, with paid, due and 2 overdue invoices', 'Attendance for past classes', '15 open leads in your pipeline'],
  safety: ['Every name is made up. Phones are 555 numbers and emails end in @example.com.', 'Demo people are never texted, emailed, invited or charged, and no automation starts from them.',
    'Removing deletes only the demo records and anything you add to demo people while trying HON.'],
  load: 'Load demo data', lastRemoved: (at) => `Demo data was last removed ${at}.`,
  loadedTitle: 'Demo data is loaded', loadedLead: (at) => `Loaded ${at}. Remove it before you import your real students.`, countsTitle: 'What is loaded',
  counts: { programs: 'Programs', classes: 'Weekly classes', classSessions: 'Class times', families: 'Families', guardians: 'Parents and guardians', students: 'Students',
    adultStudents: 'Adult students', memberships: 'Memberships', invoices: 'Invoices', overdueInvoices: 'Overdue invoices', payments: 'Payments recorded', attendance: 'Attendance records', leads: 'Leads' },
  remove: 'Remove demo data', confirmTitle: 'Remove all demo data?',
  confirmLead: 'This deletes every demo contact, class, membership, invoice and lead, and what you added to demo people. Your real records stay. This cannot be undone.',
  confirmYes: 'Yes, remove demo data', confirmNo: 'Keep it', refresh: 'Refresh', tryAgain: 'Try again',
  inUseTitle: 'Nothing was removed', inUseLead: 'Some of your real records point at demo records, so HON kept everything. Remove or change these first, then try again:',
  table: humanTable,
  outcomes: {
    LOADING: 'Loading demo data. This takes a few seconds; keep this page open.', REMOVING: 'Removing demo data. Keep this page open.',
    LOADED: 'Demo data is loaded. Open Contacts, Classes or Billing to look around.', REMOVED: 'All demo data was removed. You can import your real students now.',
    SESSION: 'Your session ended. Sign in again; nothing changed.', DENIED: 'You are not allowed to do this at this school. Nothing changed.',
    CHANGED: 'Demo data changed since this page read it. Nothing changed; the page now shows what is there.',
    IN_USE: 'Nothing was removed because real records point at demo records.', INVALID: 'The request was not accepted. Nothing changed; refresh and try again.',
    RATE: 'Too many requests. Nothing changed; try again in a moment.',
    UNKNOWN: 'The result is not known yet. Try again sends exactly the same request, so nothing happens twice.',
  },
  banner: 'Demo data is loaded. The made-up contacts, classes and invoices you see are for trying HON.', bannerLink: 'Remove demo data',
  summaryTitle: 'Demo data', summaryLine: 'Try HON with a made-up school, then remove it with one button before you import.',
};

const ko: DemoCopy = {
  pageTitle: '데모 데이터',
  pageIntro: '실제 수련생을 가져오기 전에 가상의 도장으로 HON의 모든 페이지를 사용해 보세요. 준비되면 버튼 하나로 데모 데이터를 삭제할 수 있습니다. 실제 기록은 절대 건드리지 않습니다.',
  checking: '도장을 확인하는 중…', hidden: '자리를 비운 동안 숨겨졌습니다.', chooseSchool: '먼저 도장을 선택하세요.', reading: '불러오는 중…',
  denied: '도장 소유자만 데모 데이터를 불러오거나 삭제할 수 있으며, 도장에 사용 중인 요금제나 체험이 있어야 합니다.',
  unavailable: '지금은 데모 데이터를 불러올 수 없습니다. 새로고침해서 다시 시도하세요.',
  noneTitle: '불러온 데모 데이터 없음', noneLead: '불러오면 계정에 가상의 도장이 추가됩니다:',
  includes: ['프로그램 3개와 각 주간 수업, 지난 4주와 앞으로 2주의 수업 시간', '가족 20곳과 성인 수련생 8명(총 38명)',
    '수련생마다 회원권, 결제 완료·예정 청구서와 연체 2건', '지난 수업의 출석 기록', '파이프라인의 진행 중 리드 15건'],
  safety: ['모든 이름은 가상입니다. 전화번호는 555 번호이고 이메일은 @example.com으로 끝납니다.', '데모 인원에게는 문자, 이메일, 초대, 결제가 절대 가지 않으며 자동화도 시작되지 않습니다.',
    '삭제하면 데모 기록과, HON을 사용해 보며 데모 인원에게 추가한 내용만 지워집니다.'],
  load: '데모 데이터 불러오기', lastRemoved: (at) => `데모 데이터를 마지막으로 삭제한 시각: ${at}`,
  loadedTitle: '데모 데이터가 불러와져 있습니다', loadedLead: (at) => `${at}에 불러왔습니다. 실제 수련생을 가져오기 전에 삭제하세요.`, countsTitle: '불러온 내용',
  counts: { programs: '프로그램', classes: '주간 수업', classSessions: '수업 시간', families: '가족', guardians: '부모 및 보호자', students: '수련생',
    adultStudents: '성인 수련생', memberships: '회원권', invoices: '청구서', overdueInvoices: '연체 청구서', payments: '기록된 결제', attendance: '출석 기록', leads: '리드' },
  remove: '데모 데이터 삭제', confirmTitle: '데모 데이터를 모두 삭제할까요?',
  confirmLead: '모든 데모 연락처, 수업, 회원권, 청구서, 리드와 데모 인원에게 추가한 내용이 삭제됩니다. 실제 기록은 그대로 남습니다. 되돌릴 수 없습니다.',
  confirmYes: '네, 데모 데이터 삭제', confirmNo: '유지하기', refresh: '새로고침', tryAgain: '다시 시도',
  inUseTitle: '아무것도 삭제되지 않았습니다', inUseLead: '실제 기록 일부가 데모 기록을 가리키고 있어 HON이 모두 그대로 두었습니다. 먼저 아래 항목을 삭제하거나 바꾼 뒤 다시 시도하세요:',
  table: humanTable,
  outcomes: {
    LOADING: '데모 데이터를 불러오는 중입니다. 몇 초 걸리니 이 페이지를 열어 두세요.', REMOVING: '데모 데이터를 삭제하는 중입니다. 이 페이지를 열어 두세요.',
    LOADED: '데모 데이터를 불러왔습니다. 연락처, 수업, 결제 메뉴를 둘러보세요.', REMOVED: '데모 데이터를 모두 삭제했습니다. 이제 실제 수련생을 가져올 수 있습니다.',
    SESSION: '세션이 끝났습니다. 다시 로그인하세요. 변경된 것은 없습니다.', DENIED: '이 도장에서 이 작업을 할 권한이 없습니다. 변경된 것은 없습니다.',
    CHANGED: '이 페이지를 불러온 뒤 데모 데이터가 바뀌었습니다. 변경된 것은 없으며 지금 상태를 보여 줍니다.',
    IN_USE: '실제 기록이 데모 기록을 가리키고 있어 아무것도 삭제하지 않았습니다.', INVALID: '요청이 받아들여지지 않았습니다. 변경된 것은 없으니 새로고침 후 다시 시도하세요.',
    RATE: '요청이 너무 많습니다. 변경된 것은 없으니 잠시 후 다시 시도하세요.',
    UNKNOWN: '아직 결과를 알 수 없습니다. 다시 시도하면 똑같은 요청을 보내므로 두 번 처리되지 않습니다.',
  },
  banner: '데모 데이터가 불러와져 있습니다. 보이는 가상의 연락처, 수업, 청구서는 HON 체험용입니다.', bannerLink: '데모 데이터 삭제',
  summaryTitle: '데모 데이터', summaryLine: '가상의 도장으로 HON을 사용해 보고, 가져오기 전에 버튼 하나로 삭제하세요.',
};

const es: DemoCopy = {
  pageTitle: 'Datos de demostración',
  pageIntro: 'Pruebe cada página de HON con una escuela inventada antes de importar a sus estudiantes reales. Cuando esté listo, quite los datos de demostración con un botón. Sus registros reales nunca se tocan.',
  checking: 'Revisando su escuela…', hidden: 'Oculto mientras no estaba.', chooseSchool: 'Primero elija una escuela.', reading: 'Leyendo…',
  denied: 'Solo el dueño de la escuela puede cargar o quitar datos de demostración, y la escuela necesita un plan activo o una prueba.',
  unavailable: 'No se pudieron leer los datos de demostración ahora. Actualice para intentar de nuevo.',
  noneTitle: 'No hay datos de demostración', noneLead: 'Cargar agrega una escuela inventada a su cuenta:',
  includes: ['3 programas con una clase semanal cada uno, y horarios de las últimas 4 semanas y las próximas 2', '20 familias y 8 estudiantes adultos (38 estudiantes en total)',
    'Una membresía por estudiante, con facturas pagadas, por vencer y 2 vencidas', 'Asistencia de clases pasadas', '15 prospectos abiertos en su embudo'],
  safety: ['Todos los nombres son inventados. Los teléfonos son números 555 y los correos terminan en @example.com.',
    'Nunca se envían textos, correos, invitaciones ni cobros a personas de demostración, y ninguna automatización empieza por ellas.',
    'Quitar borra solo los registros de demostración y lo que usted agregue a personas de demostración al probar HON.'],
  load: 'Cargar datos de demostración', lastRemoved: (at) => `Los datos de demostración se quitaron por última vez el ${at}.`,
  loadedTitle: 'Hay datos de demostración cargados', loadedLead: (at) => `Cargados el ${at}. Quítelos antes de importar a sus estudiantes reales.`, countsTitle: 'Lo que está cargado',
  counts: { programs: 'Programas', classes: 'Clases semanales', classSessions: 'Horarios de clase', families: 'Familias', guardians: 'Padres y tutores', students: 'Estudiantes',
    adultStudents: 'Estudiantes adultos', memberships: 'Membresías', invoices: 'Facturas', overdueInvoices: 'Facturas vencidas', payments: 'Pagos registrados', attendance: 'Registros de asistencia', leads: 'Prospectos' },
  remove: 'Quitar datos de demostración', confirmTitle: '¿Quitar todos los datos de demostración?',
  confirmLead: 'Esto borra cada contacto, clase, membresía, factura y prospecto de demostración, y lo que agregó a personas de demostración. Sus registros reales se quedan. No se puede deshacer.',
  confirmYes: 'Sí, quitar datos de demostración', confirmNo: 'Conservarlos', refresh: 'Actualizar', tryAgain: 'Intentar de nuevo',
  inUseTitle: 'No se quitó nada', inUseLead: 'Algunos de sus registros reales apuntan a registros de demostración, así que HON conservó todo. Quite o cambie estos primero y vuelva a intentar:',
  table: humanTable,
  outcomes: {
    LOADING: 'Cargando datos de demostración. Tarda unos segundos; mantenga esta página abierta.', REMOVING: 'Quitando datos de demostración. Mantenga esta página abierta.',
    LOADED: 'Los datos de demostración están cargados. Abra Contactos, Clases o Facturación para verlos.', REMOVED: 'Se quitaron todos los datos de demostración. Ya puede importar a sus estudiantes reales.',
    SESSION: 'Su sesión terminó. Inicie sesión de nuevo; no cambió nada.', DENIED: 'No tiene permiso para hacer esto en esta escuela. No cambió nada.',
    CHANGED: 'Los datos de demostración cambiaron después de que esta página los leyó. No cambió nada; la página muestra lo que hay ahora.',
    IN_USE: 'No se quitó nada porque hay registros reales que apuntan a registros de demostración.', INVALID: 'La solicitud no se aceptó. No cambió nada; actualice e intente de nuevo.',
    RATE: 'Demasiadas solicitudes. No cambió nada; intente en un momento.',
    UNKNOWN: 'Todavía no se sabe el resultado. Intentar de nuevo envía exactamente lo mismo, así que nada pasa dos veces.',
  },
  banner: 'Hay datos de demostración cargados. Los contactos, clases y facturas inventados que ve son para probar HON.', bannerLink: 'Quitar datos de demostración',
  summaryTitle: 'Datos de demostración', summaryLine: 'Pruebe HON con una escuela inventada y quítela con un botón antes de importar.',
};

export const DEMO_COPY: Record<DemoLanguage, DemoCopy> = { en, ko, es };
export const demoCopy = (language: string): DemoCopy => DEMO_COPY[(language in DEMO_COPY ? language : 'en') as DemoLanguage];
