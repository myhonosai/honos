import type { SchoolShellSection } from './catalog';

/**
 * Guided tour copy (owner, 2026-11-14: "make tour sequence to go over what each section do"). Plain language only.
 * Describes what each area is for; it never claims a feature is switched on for this school.
 */
type TourCopy = {
  label: string; stepOf: string; back: string; next: string; done: string; close: string; open: string; inside: string; start: string;
  inviteTitle: string; inviteLine: string; notNow: string;
  welcomeTitle: string; welcomeBody: string; finishTitle: string; finishBody: string;
  /** One step per menu heading, then Settings at the bottom of the menu. */
  areas: Record<SchoolShellSection | 'settings', string>;
};
const en: TourCopy = {
  label: 'Tour of your school app', stepOf: '{n} of {total}', back: 'Back', next: 'Next', done: 'Done', close: 'Close tour', open: 'Open {area}',
  inside: 'Inside', start: 'Take the tour',
  inviteTitle: 'New to HON OS?', inviteLine: 'Take a two-minute tour of the menu and what each part is for.', notNow: 'Not now',
  welcomeTitle: 'Welcome to HON OS',
  welcomeBody: 'This short tour walks through each part of the menu and what each one is for. Nothing changes while you look around.',
  finishTitle: 'That is the tour',
  finishBody: 'Ask HON, in the corner of any page, when you are not sure where something is. You can take this tour again from the Menu or from Settings.',
  areas: {
    dashboard: 'Your day at a glance on the Dashboard, and HON to ask anything. Start here each morning.',
    ai: 'Your AI team and what each one drafts for you, and Conversation AI, which answers your school’s texts.',
    calendar: 'The class calendar, and attendance with check-in.',
    contacts: 'Everyone in your school on one contact list, and your staff.',
    leads: 'Your lead pipeline, which you can edit, and the automations that follow up for you.',
    communication: 'Texts and email with families, and your Facebook and Instagram messages.',
    finance: 'Checkout pages families pay on, and invoices with tuition balances.',
    marketing: 'Your website and forms, campaigns and referrals, and Creative Studio.',
    ranks: 'Rank setup and curriculum, belt tests, and promoting many students at once.',
    business: 'Membership plans and members, and your reports.',
    community: 'The owner community and marketplace.',
    settings: 'Your school’s setup at the bottom of the menu: location, branding, booking types, payments, language, account and help.',
  },
};
const ko: TourCopy = {
  label: '도장 앱 둘러보기', stepOf: '{total}단계 중 {n}', back: '이전', next: '다음', done: '완료', close: '둘러보기 닫기', open: '{area} 열기',
  inside: '포함된 페이지', start: '둘러보기 시작',
  inviteTitle: 'HON OS가 처음이신가요?', inviteLine: '메뉴의 각 부분과 용도를 2분 만에 둘러보세요.', notNow: '나중에',
  welcomeTitle: 'HON OS에 오신 것을 환영합니다',
  welcomeBody: '메뉴의 각 부분과 그 용도를 간단히 안내합니다. 둘러보는 동안에는 아무것도 바뀌지 않습니다.',
  finishTitle: '둘러보기를 마쳤습니다',
  finishBody: '무엇이 어디 있는지 모를 때는 모든 페이지 구석의 HON에게 물어보세요. 이 둘러보기는 메뉴나 설정에서 다시 볼 수 있습니다.',
  areas: {
    dashboard: '대시보드에서 하루를 한눈에 보고, HON에게 무엇이든 물어보세요. 매일 아침 여기서 시작하세요.',
    ai: 'AI 팀과 각자가 작성해 주는 초안, 그리고 도장 문자에 답하는 대화 AI.',
    calendar: '수업 캘린더, 출석과 체크인.',
    contacts: '도장의 모든 사람을 한 연락처 목록에서, 그리고 직원.',
    leads: '직접 편집할 수 있는 리드 파이프라인과 대신 후속 연락하는 자동화.',
    communication: '가족과 주고받는 문자와 이메일, 페이스북과 인스타그램 메시지.',
    finance: '가족이 결제하는 결제 페이지, 청구서와 수업료 잔액.',
    marketing: '웹사이트와 양식, 캠페인과 추천, 크리에이티브 스튜디오.',
    ranks: '띠 설정과 커리큘럼, 승급 심사, 여러 학생 일괄 승급.',
    business: '회원권 플랜과 회원, 보고서.',
    community: '관장 커뮤니티와 마켓플레이스.',
    settings: '메뉴 맨 아래의 도장 설정: 위치, 브랜딩, 예약 유형, 결제, 언어, 계정과 도움말.',
  },
};
const es: TourCopy = {
  label: 'Recorrido por la app de tu escuela', stepOf: '{n} de {total}', back: 'Atrás', next: 'Siguiente', done: 'Listo', close: 'Cerrar recorrido', open: 'Abrir {area}',
  inside: 'Incluye', start: 'Hacer el recorrido',
  inviteTitle: '¿Nuevo en HON OS?', inviteLine: 'Haz un recorrido de dos minutos por el menú y para qué sirve cada parte.', notNow: 'Ahora no',
  welcomeTitle: 'Bienvenido a HON OS',
  welcomeBody: 'Este breve recorrido muestra cada parte del menú y para qué sirve. Nada cambia mientras miras.',
  finishTitle: 'Fin del recorrido',
  finishBody: 'Pregunta a HON, en la esquina de cualquier página, cuando no sepas dónde está algo. Puedes repetir este recorrido desde el Menú o desde Configuración.',
  areas: {
    dashboard: 'Tu día de un vistazo en el Panel, y HON para preguntar lo que sea. Empieza aquí cada mañana.',
    ai: 'Tu equipo de IA y lo que cada uno redacta para ti, y la IA de conversación, que responde los textos de tu escuela.',
    calendar: 'El calendario de clases, y la asistencia con registro de entrada.',
    contacts: 'Todas las personas de tu escuela en una lista de contactos, y tu personal.',
    leads: 'Tu tablero de prospectos, que puedes editar, y las automatizaciones que hacen el seguimiento por ti.',
    communication: 'Textos y correos con las familias, y tus mensajes de Facebook e Instagram.',
    finance: 'Páginas de pago para las familias, y facturas con saldos de colegiatura.',
    marketing: 'Tu sitio web y formularios, campañas y referidos, y Creative Studio.',
    ranks: 'Configuración de cinturones y currículo, exámenes, y promoción de muchos alumnos a la vez.',
    business: 'Planes de membresía y miembros, y tus informes.',
    community: 'La comunidad de dueños y el mercado.',
    settings: 'La configuración de tu escuela al final del menú: ubicación, marca, tipos de reserva, pagos, idioma, cuenta y ayuda.',
  },
};
const COPY: Record<string, TourCopy> = { en, ko, es };
export const tourCopy = (language: string): TourCopy => COPY[language] ?? en;
