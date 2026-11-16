import type { SchoolShellIcon } from './catalog';

/**
 * Guided tour copy (owner, 2026-11-14: "make tour sequence to go over what each section do"). Plain language only.
 * Describes what each area is for; it never claims a feature is switched on for this school.
 */
type TourCopy = {
  label: string; stepOf: string; back: string; next: string; done: string; close: string; open: string; inside: string; start: string;
  inviteTitle: string; inviteLine: string; notNow: string;
  welcomeTitle: string; welcomeBody: string; finishTitle: string; finishBody: string;
  areas: Record<SchoolShellIcon, string>;
};
const en: TourCopy = {
  label: 'Tour of your school app', stepOf: '{n} of {total}', back: 'Back', next: 'Next', done: 'Done', close: 'Close tour', open: 'Open {area}',
  inside: 'Inside', start: 'Take the tour',
  inviteTitle: 'New to HON OS?', inviteLine: 'Take a two-minute tour of the nine areas and what each one is for.', notNow: 'Not now',
  welcomeTitle: 'Welcome to HON OS',
  welcomeBody: 'This short tour walks through the nine areas in the menu and what each one is for. Nothing changes while you look around.',
  finishTitle: 'That is the tour',
  finishBody: 'Ask HON, in the corner of any page, when you are not sure where something is. You can take this tour again from the Menu or from Settings.',
  areas: {
    home: 'Your day at a glance: today’s classes, new leads, follow-ups and anything waiting on you. Start here each morning.',
    students: 'Everyone connected to your school: students, families and staff. Look someone up, give a family access or invite a team member.',
    crm: 'Turn interested people into members. Track leads and trial classes, follow up, and run your marketing: lead forms, campaigns, social accounts and Champions Club referrals.',
    classes: 'Run the mat: the class schedule and rosters, check-in and attendance, your curriculum, belt testing and promotions.',
    billing: 'Memberships and money: membership plans, activations, pauses and renewals, then invoices, balances and how families pay.',
    aiTeam: 'HON and your AI specialists. See what each one is for, ask for help, and review what they draft before you use it.',
    analytics: 'How the school is doing: school reports, the operations report, the health score and revenue planning.',
    community: 'The HON owner community: talk with other verified school owners and browse the private marketplace.',
    settings: 'Your school’s setup on one page: plan, branding, owners, language and texts from HON, each with a link to change it.',
  },
};
const ko: TourCopy = {
  label: '도장 앱 둘러보기', stepOf: '{total}단계 중 {n}', back: '이전', next: '다음', done: '완료', close: '둘러보기 닫기', open: '{area} 열기',
  inside: '포함된 페이지', start: '둘러보기 시작',
  inviteTitle: 'HON OS가 처음이신가요?', inviteLine: '아홉 개 영역과 각 영역의 용도를 2분 만에 둘러보세요.', notNow: '나중에',
  welcomeTitle: 'HON OS에 오신 것을 환영합니다',
  welcomeBody: '메뉴의 아홉 개 영역과 각각의 용도를 간단히 안내합니다. 둘러보는 동안에는 아무것도 바뀌지 않습니다.',
  finishTitle: '둘러보기를 마쳤습니다',
  finishBody: '무엇이 어디 있는지 모를 때는 모든 페이지 구석의 HON에게 물어보세요. 이 둘러보기는 메뉴나 설정에서 다시 볼 수 있습니다.',
  areas: {
    home: '하루를 한눈에: 오늘의 수업, 새 리드, 후속 연락, 확인이 필요한 일. 매일 아침 여기서 시작하세요.',
    students: '도장과 연결된 모든 사람: 수련생, 가족, 직원. 사람을 찾고, 가족에게 접근 권한을 주거나 팀원을 초대하세요.',
    crm: '관심 있는 사람을 회원으로. 리드와 체험 수업을 관리하고 후속 연락을 하며, 리드 양식, 캠페인, 소셜 계정, Champions Club 추천으로 마케팅을 운영하세요.',
    classes: '수업 운영: 수업 일정과 명단, 출석 체크, 커리큘럼, 승급 심사와 승급.',
    billing: '회원권과 결제: 회원권 플랜, 활성화, 일시정지와 갱신, 그리고 청구서, 잔액, 가족의 결제 방법.',
    aiTeam: 'HON과 AI 전문가 팀. 각자의 역할을 보고, 도움을 요청하고, 초안을 사용하기 전에 검토하세요.',
    analytics: '도장 현황: 도장 보고서, 운영 보고서, 건강 점수, 매출 계획.',
    community: 'HON 관장 커뮤니티: 인증된 다른 도장 관장들과 이야기하고 비공개 마켓플레이스를 둘러보세요.',
    settings: '도장 설정을 한 페이지에: 플랜, 브랜딩, 소유자, 언어, HON 문자. 각각 변경 링크가 있습니다.',
  },
};
const es: TourCopy = {
  label: 'Recorrido por la app de tu escuela', stepOf: '{n} de {total}', back: 'Atrás', next: 'Siguiente', done: 'Listo', close: 'Cerrar recorrido', open: 'Abrir {area}',
  inside: 'Incluye', start: 'Hacer el recorrido',
  inviteTitle: '¿Nuevo en HON OS?', inviteLine: 'Haz un recorrido de dos minutos por las nueve áreas y para qué sirve cada una.', notNow: 'Ahora no',
  welcomeTitle: 'Bienvenido a HON OS',
  welcomeBody: 'Este breve recorrido muestra las nueve áreas del menú y para qué sirve cada una. Nada cambia mientras miras.',
  finishTitle: 'Fin del recorrido',
  finishBody: 'Pregunta a HON, en la esquina de cualquier página, cuando no sepas dónde está algo. Puedes repetir este recorrido desde el Menú o desde Configuración.',
  areas: {
    home: 'Tu día de un vistazo: las clases de hoy, nuevos interesados, seguimientos y lo que te espera. Empieza aquí cada mañana.',
    students: 'Todas las personas de tu escuela: alumnos, familias y personal. Busca a alguien, da acceso a una familia o invita a alguien del equipo.',
    crm: 'Convierte a los interesados en miembros. Sigue interesados y clases de prueba, haz seguimiento y gestiona tu marketing: formularios, campañas, redes sociales y referidos del Champions Club.',
    classes: 'El día a día en el tatami: horario y listas de clase, asistencia, tu currículo, exámenes de cinturón y promociones.',
    billing: 'Membresías y dinero: planes, activaciones, pausas y renovaciones, además de facturas, saldos y cómo pagan las familias.',
    aiTeam: 'HON y tus especialistas de IA. Mira para qué sirve cada uno, pide ayuda y revisa lo que redactan antes de usarlo.',
    analytics: 'Cómo va la escuela: informes de la escuela, informe de operaciones, puntuación de salud y planificación de ingresos.',
    community: 'La comunidad de dueños de HON: habla con otros dueños de escuelas verificados y explora el mercado privado.',
    settings: 'La configuración de tu escuela en una página: plan, marca, propietarios, idioma y mensajes de HON, cada uno con un enlace para cambiarlo.',
  },
};
const COPY: Record<string, TourCopy> = { en, ko, es };
export const tourCopy = (language: string): TourCopy => COPY[language] ?? en;
