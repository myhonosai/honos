import type { CustomToolDefinition } from '@hon/contracts';

/**
 * Starting designs for the Tool Maker. Each is an ordinary closed definition (0415) that the owner edits before saving;
 * none is published or shared with staff until the owner adds access and publishes it. Text is English with Korean and
 * Spanish where the meaning is fixed; owners can change every label.
 */
export type ToolTemplateKey = 'demo_team' | 'leadership_points' | 'tournament' | 'blank';
export type ToolTemplate = Readonly<{ key: ToolTemplateKey; toolKey: string; definition: CustomToolDefinition }>;

const demoTeam: CustomToolDefinition = {
  schemaVersion: 1, icon: 'star',
  name: { en: 'Demo Team', ko: '시범단', es: 'Equipo de exhibición' },
  description: { en: 'Members, practices and performances for the school demo team.' },
  entities: [
    { key: 'member', label: { en: 'Member', ko: '단원', es: 'Miembro' }, fields: [
      { key: 'student', label: { en: 'Student', ko: '학생', es: 'Alumno' }, type: 'STUDENT_REF', required: true },
      { key: 'role', label: { en: 'Role', ko: '역할', es: 'Función' }, type: 'CHOICE', choices: [
        { key: 'performer', label: { en: 'Performer', ko: '시범단원', es: 'Ejecutante' } }, { key: 'captain', label: { en: 'Captain', ko: '주장', es: 'Capitán' } },
        { key: 'alternate', label: { en: 'Alternate', ko: '예비', es: 'Suplente' } }] },
      { key: 'joined_on', label: { en: 'Joined on', ko: '가입일', es: 'Fecha de ingreso' }, type: 'DATE' },
      { key: 'uniform_size', label: { en: 'Uniform size', ko: '도복 사이즈', es: 'Talla de uniforme' }, type: 'TEXT', maxLength: 20 },
      { key: 'active', label: { en: 'Active', ko: '활동 중', es: 'Activo' }, type: 'BOOLEAN' },
    ] },
    { key: 'event', label: { en: 'Practice or show', ko: '연습 또는 공연', es: 'Práctica o presentación' }, fields: [
      { key: 'title', label: { en: 'Title', ko: '제목', es: 'Título' }, type: 'TEXT', required: true, maxLength: 120 },
      { key: 'kind', label: { en: 'Kind', ko: '종류', es: 'Tipo' }, type: 'CHOICE', required: true, choices: [
        { key: 'practice', label: { en: 'Practice', ko: '연습', es: 'Práctica' } }, { key: 'performance', label: { en: 'Performance', ko: '공연', es: 'Presentación' } }] },
      { key: 'held_on', label: { en: 'Date', ko: '날짜', es: 'Fecha' }, type: 'DATE', required: true },
      { key: 'notes', label: { en: 'Notes', ko: '메모', es: 'Notas' }, type: 'LONG_TEXT', maxLength: 2000 },
    ] },
  ],
  views: [
    { key: 'members', label: { en: 'Members', ko: '단원', es: 'Miembros' }, type: 'TABLE', entity: 'member', columns: ['student', 'role', 'joined_on', 'active'] },
    { key: 'add_member', label: { en: 'Add member', ko: '단원 추가', es: 'Añadir miembro' }, type: 'FORM', entity: 'member', fields: ['student', 'role', 'joined_on', 'uniform_size', 'active'] },
    { key: 'events', label: { en: 'Practices and shows', ko: '연습과 공연', es: 'Prácticas y presentaciones' }, type: 'TABLE', entity: 'event', columns: ['title', 'kind', 'held_on'], sort: { field: 'held_on', direction: 'DESC' } },
    { key: 'add_event', label: { en: 'Add practice or show', ko: '연습 또는 공연 추가', es: 'Añadir práctica o presentación' }, type: 'FORM', entity: 'event', fields: ['title', 'kind', 'held_on', 'notes'] },
  ],
  navigation: ['members', 'events'], access: [],
};

const leadership: CustomToolDefinition = {
  schemaVersion: 1, icon: 'trophy',
  name: { en: 'Leadership Points', ko: '리더십 포인트', es: 'Puntos de liderazgo' },
  description: { en: 'Award points to students for leadership, with a leaderboard.' },
  entities: [
    { key: 'award', label: { en: 'Award', ko: '포인트 지급', es: 'Premio' }, fields: [
      { key: 'student', label: { en: 'Student', ko: '학생', es: 'Alumno' }, type: 'STUDENT_REF', required: true },
      { key: 'points', label: { en: 'Points', ko: '포인트', es: 'Puntos' }, type: 'INTEGER', required: true, min: 1, max: 100 },
      { key: 'reason', label: { en: 'Reason', ko: '사유', es: 'Motivo' }, type: 'CHOICE', required: true, choices: [
        { key: 'helping', label: { en: 'Helping others', ko: '다른 사람 돕기', es: 'Ayudar a otros' } },
        { key: 'leading', label: { en: 'Leading warm-up', ko: '준비운동 지도', es: 'Dirigir el calentamiento' } },
        { key: 'attitude', label: { en: 'Great attitude', ko: '훌륭한 태도', es: 'Gran actitud' } }] },
      { key: 'awarded_by', label: { en: 'Awarded by', ko: '지급자', es: 'Otorgado por' }, type: 'STAFF_REF' },
      { key: 'awarded_on', label: { en: 'Date', ko: '날짜', es: 'Fecha' }, type: 'DATE', required: true },
    ] },
  ],
  views: [
    { key: 'board', label: { en: 'Leaderboard', ko: '순위표', es: 'Clasificación' }, type: 'DASHBOARD', entity: 'award', cards: [
      { key: 'awards', label: { en: 'Awards given', ko: '지급 횟수', es: 'Premios otorgados' }, kind: 'COUNT' },
      { key: 'total', label: { en: 'Total points', ko: '총 포인트', es: 'Puntos totales' }, kind: 'SUM', field: 'points' },
      { key: 'top', label: { en: 'Top students', ko: '상위 학생', es: 'Mejores alumnos' }, kind: 'LEADERBOARD', field: 'points', groupBy: 'student' }] },
    { key: 'awards', label: { en: 'Awards', ko: '지급 기록', es: 'Premios' }, type: 'TABLE', entity: 'award', columns: ['student', 'points', 'reason', 'awarded_on'], sort: { field: 'awarded_on', direction: 'DESC' } },
    { key: 'give', label: { en: 'Give points', ko: '포인트 주기', es: 'Dar puntos' }, type: 'FORM', entity: 'award', fields: ['student', 'points', 'reason', 'awarded_by', 'awarded_on'] },
  ],
  navigation: ['board', 'awards'], access: [],
};

const tournament: CustomToolDefinition = {
  schemaVersion: 1, icon: 'flag',
  name: { en: 'Tournament scoring', ko: '대회 채점', es: 'Puntuación de torneo' },
  description: { en: 'Divisions and scores for an in-school tournament.' },
  entities: [
    { key: 'division', label: { en: 'Division', ko: '부문', es: 'División' }, fields: [
      { key: 'name', label: { en: 'Name', ko: '이름', es: 'Nombre' }, type: 'TEXT', required: true, maxLength: 80 },
      { key: 'event', label: { en: 'Event', ko: '종목', es: 'Prueba' }, type: 'CHOICE', required: true, choices: [
        { key: 'forms', label: { en: 'Forms', ko: '품새', es: 'Formas' } }, { key: 'sparring', label: { en: 'Sparring', ko: '겨루기', es: 'Combate' } },
        { key: 'breaking', label: { en: 'Breaking', ko: '격파', es: 'Rompimiento' } }] },
    ] },
    { key: 'score', label: { en: 'Score', ko: '점수', es: 'Puntuación' }, fields: [
      { key: 'competitor', label: { en: 'Competitor', ko: '선수', es: 'Competidor' }, type: 'STUDENT_REF', required: true },
      { key: 'division', label: { en: 'Division', ko: '부문', es: 'División' }, type: 'RECORD_REF', entity: 'division', required: true },
      { key: 'score', label: { en: 'Score', ko: '점수', es: 'Puntuación' }, type: 'NUMBER', required: true, min: 0, max: 10 },
      { key: 'judge', label: { en: 'Judge', ko: '심판', es: 'Juez' }, type: 'STAFF_REF' },
    ] },
  ],
  views: [
    { key: 'results', label: { en: 'Results', ko: '결과', es: 'Resultados' }, type: 'DASHBOARD', entity: 'score', cards: [
      { key: 'entries', label: { en: 'Scores entered', ko: '입력된 점수', es: 'Puntuaciones' }, kind: 'COUNT' },
      { key: 'average', label: { en: 'Average score', ko: '평균 점수', es: 'Puntuación media' }, kind: 'AVERAGE', field: 'score' },
      { key: 'leaders', label: { en: 'Leaders', ko: '선두', es: 'Líderes' }, kind: 'LEADERBOARD', field: 'score', groupBy: 'competitor' }] },
    { key: 'scores', label: { en: 'Scores', ko: '점수', es: 'Puntuaciones' }, type: 'TABLE', entity: 'score', columns: ['competitor', 'division', 'score', 'judge'], sort: { field: 'score', direction: 'DESC' } },
    { key: 'enter_score', label: { en: 'Enter a score', ko: '점수 입력', es: 'Anotar puntuación' }, type: 'FORM', entity: 'score', fields: ['competitor', 'division', 'score', 'judge'] },
    { key: 'divisions', label: { en: 'Divisions', ko: '부문', es: 'Divisiones' }, type: 'TABLE', entity: 'division', columns: ['name', 'event'] },
    { key: 'add_division', label: { en: 'Add division', ko: '부문 추가', es: 'Añadir división' }, type: 'FORM', entity: 'division', fields: ['name', 'event'] },
  ],
  navigation: ['results', 'scores', 'divisions'], access: [],
};

const blank: CustomToolDefinition = {
  schemaVersion: 1, icon: 'clipboard', name: { en: 'New tool' },
  entities: [{ key: 'entry', label: { en: 'Entry' }, fields: [{ key: 'title', label: { en: 'Title' }, type: 'TEXT', required: true }] }],
  views: [
    { key: 'entries', label: { en: 'Entries' }, type: 'TABLE', entity: 'entry', columns: ['title'] },
    { key: 'add_entry', label: { en: 'Add entry' }, type: 'FORM', entity: 'entry', fields: ['title'] },
  ],
  navigation: ['entries'], access: [],
};

export const TOOL_TEMPLATES: readonly ToolTemplate[] = [
  { key: 'demo_team', toolKey: 'demo_team', definition: demoTeam },
  { key: 'leadership_points', toolKey: 'leadership_points', definition: leadership },
  { key: 'tournament', toolKey: 'tournament_scoring', definition: tournament },
  { key: 'blank', toolKey: 'new_tool', definition: blank },
];
/** A fresh copy, so edits never change the template. */
export const templateCopy = (key: ToolTemplateKey): ToolTemplate => {
  const t = TOOL_TEMPLATES.find(x => x.key === key) ?? TOOL_TEMPLATES[TOOL_TEMPLATES.length - 1]!;
  return { ...t, definition: structuredClone(t.definition) };
};
