/** AI Team page copy. ko/es are typed against en, so a missing key fails `pnpm check`. Agent lines match the website (owner-approved). */
const en = {
  title: 'Your AI team', lead: 'Eight specialists, each with one job. Ask HON anything, or go straight to the person you need. Nobody sends, charges or changes anything without you.',
  workspace: 'Has a workspace', answers: 'Answers in Ask HON', open: 'Open workspace', ask: 'Ask {name}',
  noSchool: 'Choose your school to see who is available.', checking: 'Checking who is available…',
  denied: 'Your access does not include AI team availability. Ask a school owner if you need it.', unavailable: 'Availability could not be checked right now. Try again in a moment.',
  kai: 'Helps instructors pick curriculum. Fuller lesson planning is on the way.', chad: 'Drafts follow-ups for every lead so nobody goes cold.',
  marcus: 'Drafts campaigns and posts for your next promotion.', maya: 'Flags students at risk of leaving, with reasons and a suggested check-in.',
  alex: 'Answers whole-school questions and says what to focus on next.', jordan: 'Answers questions about your class schedule, attendance and absences.',
  claire: 'Reads your numbers and explains them in plain words.', lena: 'Ideas for your campaigns, membership plans and Creative Studio.',
} as const;
export type AiTeamKey = keyof typeof en;
const ko: Record<AiTeamKey, string> = {
  title: '나의 AI 팀', lead: '각자 한 가지 일을 맡은 여덟 명의 전문가입니다. HON에게 무엇이든 묻거나 필요한 사람에게 바로 가세요. 원장님 없이 보내거나 청구하거나 바꾸는 일은 없습니다.',
  workspace: '작업 공간 있음', answers: 'HON에게 묻기에서 답변', open: '작업 공간 열기', ask: '{name}에게 묻기',
  noSchool: '사용 가능한 팀원을 보려면 도장을 선택하세요.', checking: '사용 가능한 팀원을 확인하는 중…',
  denied: '내 권한에는 AI 팀 상태 보기가 포함되어 있지 않습니다. 필요하면 원장님께 요청하세요.', unavailable: '지금은 상태를 확인할 수 없습니다. 잠시 후 다시 시도하세요.',
  kai: '사범님의 커리큘럼 선정을 돕습니다. 더 완전한 수업 계획 기능도 준비 중입니다.', chad: '상담이 식지 않도록 모든 상담의 후속 연락 초안을 씁니다.',
  marcus: '다음 프로모션의 캠페인과 게시물 초안을 씁니다.', maya: '그만둘 위험이 있는 수련생을 이유와 추천 안부 연락과 함께 알려 줍니다.',
  alex: '도장 전반의 질문에 답하고 다음에 집중할 일을 알려 줍니다.', jordan: '수업 일정, 출석, 결석에 관한 질문에 답합니다.',
  claire: '도장의 숫자를 읽고 쉬운 말로 설명합니다.', lena: '캠페인, 회원 플랜, 크리에이티브 스튜디오를 위한 아이디어.',
};
const es: Record<AiTeamKey, string> = {
  title: 'Tu equipo de IA', lead: 'Ocho especialistas, cada uno con una tarea. Pregúntale a HON lo que quieras o ve directo a quien necesitas. Nadie envía, cobra ni cambia nada sin ti.',
  workspace: 'Tiene espacio de trabajo', answers: 'Responde en Preguntar a HON', open: 'Abrir espacio de trabajo', ask: 'Preguntar a {name}',
  noSchool: 'Elige tu escuela para ver quién está disponible.', checking: 'Comprobando quién está disponible…',
  denied: 'Tu acceso no incluye la disponibilidad del equipo de IA. Pídela a un dueño de la escuela si la necesitas.', unavailable: 'No se pudo comprobar la disponibilidad ahora. Inténtalo de nuevo en un momento.',
  kai: 'Ayuda a los instructores a elegir el currículo. La planificación completa de clases está en camino.', chad: 'Redacta seguimientos para cada prospecto para que ninguno se enfríe.',
  marcus: 'Redacta campañas y publicaciones para tu próxima promoción.', maya: 'Señala a los alumnos en riesgo de irse, con motivos y un contacto sugerido.',
  alex: 'Responde preguntas sobre toda la escuela y dice en qué enfocarte ahora.', jordan: 'Responde preguntas sobre tu horario de clases, la asistencia y las ausencias.',
  claire: 'Lee tus números y los explica con palabras sencillas.', lena: 'Ideas para tus campañas, planes de membresía y Creative Studio.',
};
const catalogs: Record<string, Record<AiTeamKey, string>> = { en, ko, es };
export function aiTeamText(language: string, key: AiTeamKey, values: Record<string, string> = {}): string {
  const text = (catalogs[language] ?? en)[key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '');
}
