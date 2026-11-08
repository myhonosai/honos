/** Marketing home wording (en / ko / es). Labels only; nothing here is authority or an outcome. */
const en = {
  title: 'Marketing', intro: 'Your school\'s campaign plans and the leads each one brought in over the last 30 days.',
  readOnly: 'This page only shows plans. Nothing here publishes, spends money or sends a message. Edit plans in the campaign planner, which checks your access again.',
  refresh: 'Refresh', tabsLabel: 'Campaign status', ACTIVE: 'Active', DRAFT: 'Draft', PAUSED: 'Paused', ARCHIVED: 'Archived', ALL: 'All',
  listTitle: 'Campaign plans', listLoading: 'Reading campaigns…', listNone: 'No campaigns with this status.', shown: '{n} shown',
  listDenied: 'Campaigns are shown only to staff with campaign access at exactly one school. Nothing is shown.',
  listUnavailable: 'Campaigns could not be loaded. Nothing is shown.',
  pick: 'Choose a campaign to see its plan and its recorded leads.', window: '{from} to {to}',
  channel: 'Channel', budget: 'Planned budget', budgetNote: 'Planned, not spent', offer: 'Offer', offerNone: 'None', goal: 'Goal', code: 'Code', dates: 'Runs',
  REFERRAL: 'Referral', EVENT: 'Event', PRINT: 'Print', EMAIL: 'Email', SMS: 'Text message', SOCIAL: 'Social', SEARCH: 'Search', WEBSITE: 'Website', OTHER: 'Other',
  funnelTitle: 'Last 30 days', funnelLoading: 'Counting recorded leads…', funnelUnavailable: 'Lead counts could not be loaded. Nothing is shown.',
  funnelDenied: 'Your access does not include these counts.',
  leads: 'Leads', trialLeads: 'Leads with a trial', completedTrialAppointments: 'Trials completed', wonLeads: 'Won',
  funnelNote: 'Counts of recorded CRM leads created in this window and linked to this campaign. Won is not enrollment or payment; revenue is not linked.',
  nextSteps: 'Next steps', edit: 'Edit in the campaign planner', marcus: 'Ask Marcus for a draft', marcusHelp: 'Drafts wait for your approval; nothing is published.',
  forms: 'Lead forms', intake: 'Lead intake', reload: 'Reload',
  waiting: 'Checking your school…', noSchool: 'Choose a school to see its campaigns.', concealed: 'Campaigns are hidden. Come back to this tab to check your school again.',
};
export type MarketingKey = keyof typeof en;
const ko: Record<MarketingKey, string> = {
  title: '마케팅', intro: '학교의 캠페인 계획과 지난 30일 동안 각 캠페인으로 들어온 문의.',
  readOnly: '이 페이지는 계획을 보여 주기만 합니다. 게시, 지출, 메시지 발송은 하지 않습니다. 계획은 캠페인 플래너에서 수정하며, 그곳에서 권한을 다시 확인합니다.',
  refresh: '새로 고침', tabsLabel: '캠페인 상태', ACTIVE: '진행 중', DRAFT: '초안', PAUSED: '일시 중지', ARCHIVED: '보관', ALL: '전체',
  listTitle: '캠페인 계획', listLoading: '캠페인을 읽는 중…', listNone: '이 상태의 캠페인이 없습니다.', shown: '{n}개 표시',
  listDenied: '캠페인은 정확히 한 학교의 캠페인 권한이 있는 직원에게만 표시됩니다. 아무것도 표시되지 않습니다.',
  listUnavailable: '캠페인을 불러올 수 없습니다. 아무것도 표시되지 않습니다.',
  pick: '캠페인을 선택하면 계획과 기록된 문의를 볼 수 있습니다.', window: '{from} ~ {to}',
  channel: '채널', budget: '계획 예산', budgetNote: '계획일 뿐 지출 아님', offer: '혜택', offerNone: '없음', goal: '목표', code: '코드', dates: '기간',
  REFERRAL: '추천', EVENT: '행사', PRINT: '인쇄물', EMAIL: '이메일', SMS: '문자 메시지', SOCIAL: '소셜', SEARCH: '검색', WEBSITE: '웹사이트', OTHER: '기타',
  funnelTitle: '지난 30일', funnelLoading: '기록된 문의를 세는 중…', funnelUnavailable: '문의 수를 불러올 수 없습니다. 아무것도 표시되지 않습니다.',
  funnelDenied: '이 수치에 대한 권한이 없습니다.',
  leads: '문의', trialLeads: '체험 수업 문의', completedTrialAppointments: '완료된 체험 수업', wonLeads: '등록',
  funnelNote: '이 기간에 만들어지고 이 캠페인에 연결된 CRM 문의 기록 수입니다. 등록은 수강 등록이나 결제가 아니며, 매출은 연결되지 않습니다.',
  nextSteps: '다음 단계', edit: '캠페인 플래너에서 수정', marcus: 'Marcus에게 초안 요청', marcusHelp: '초안은 승인을 기다리며 게시되지 않습니다.',
  forms: '문의 양식', intake: '문의 접수', reload: '다시 불러오기',
  waiting: '학교를 확인하는 중…', noSchool: '캠페인을 보려면 학교를 선택하세요.', concealed: '캠페인이 숨겨졌습니다. 이 탭으로 돌아오면 학교를 다시 확인합니다.',
};
const es: Record<MarketingKey, string> = {
  title: 'Marketing', intro: 'Los planes de campaña de su escuela y los prospectos que trajo cada uno en los últimos 30 días.',
  readOnly: 'Esta página solo muestra planes. Aquí no se publica, no se gasta dinero ni se envían mensajes. Edite los planes en el planificador de campañas, que vuelve a comprobar su acceso.',
  refresh: 'Actualizar', tabsLabel: 'Estado de la campaña', ACTIVE: 'Activas', DRAFT: 'Borradores', PAUSED: 'En pausa', ARCHIVED: 'Archivadas', ALL: 'Todas',
  listTitle: 'Planes de campaña', listLoading: 'Leyendo campañas…', listNone: 'No hay campañas con este estado.', shown: '{n} mostradas',
  listDenied: 'Las campañas solo se muestran al personal con acceso a campañas en exactamente una escuela. No se muestra nada.',
  listUnavailable: 'No se pudieron cargar las campañas. No se muestra nada.',
  pick: 'Elija una campaña para ver su plan y sus prospectos registrados.', window: 'del {from} al {to}',
  channel: 'Canal', budget: 'Presupuesto previsto', budgetNote: 'Previsto, no gastado', offer: 'Oferta', offerNone: 'Ninguna', goal: 'Objetivo', code: 'Código', dates: 'Vigencia',
  REFERRAL: 'Recomendación', EVENT: 'Evento', PRINT: 'Impreso', EMAIL: 'Correo', SMS: 'Mensaje de texto', SOCIAL: 'Redes sociales', SEARCH: 'Búsqueda', WEBSITE: 'Sitio web', OTHER: 'Otro',
  funnelTitle: 'Últimos 30 días', funnelLoading: 'Contando prospectos registrados…', funnelUnavailable: 'No se pudieron cargar los recuentos. No se muestra nada.',
  funnelDenied: 'Su acceso no incluye estos recuentos.',
  leads: 'Prospectos', trialLeads: 'Prospectos con clase de prueba', completedTrialAppointments: 'Clases de prueba completadas', wonLeads: 'Ganados',
  funnelNote: 'Recuentos de prospectos de CRM creados en este periodo y vinculados a esta campaña. Ganado no es inscripción ni pago; los ingresos no están vinculados.',
  nextSteps: 'Siguientes pasos', edit: 'Editar en el planificador de campañas', marcus: 'Pedir un borrador a Marcus', marcusHelp: 'Los borradores esperan su aprobación; no se publica nada.',
  forms: 'Formularios', intake: 'Entrada de prospectos', reload: 'Volver a cargar',
  waiting: 'Comprobando su escuela…', noSchool: 'Elija una escuela para ver sus campañas.', concealed: 'Las campañas están ocultas. Vuelva a esta pestaña para comprobar su escuela de nuevo.',
};
export const MARKETING_LANGUAGES = { en, ko, es } as const;
export function marketingText(language: string, key: MarketingKey, vars: Record<string, string> = {}): string {
  const text = (language === 'ko' ? ko : language === 'es' ? es : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '');
}
