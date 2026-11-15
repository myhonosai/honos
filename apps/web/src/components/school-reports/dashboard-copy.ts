/** Reports dashboard wording (R3, 0371), en / ko / es. Labels only; nothing here is authority or an outcome. */
const en = {
  viewOverview: 'Overview', viewMonthly: 'Month by month', viewLabel: 'Report',
  rangeLabel: 'Range', THIS_MONTH: 'This month', LAST_MONTH: 'Last month', D30: '30 days', D90: '90 days', M12: '12 months', ALL: 'All time',
  overviewIntro: 'The main numbers for this school over the range you pick, in school time, compared with the period just before it.',
  loading: 'Reading the numbers…', span: '{from} to {to} ({zone})', spanAll: 'Everything up to {to} ({zone})',
  vsPrevious: 'vs {from} to {to}', noCompare: 'No earlier period to compare with.',
  up: 'up {n}', down: 'down {n}', same: 'no change', upPoints: 'up {n} points', downPoints: 'down {n} points',
  details: 'View details',
  kpiActive: 'Active students', kpiActiveHelp: 'People with a membership at the end of the range. Paused memberships count.',
  kpiNew: 'New students', kpiNewHelp: 'People whose first membership started in the range.',
  kpiAppointments: 'Appointments', kpiAppointmentsHelp: 'Trial and intro appointments that started in the range, not cancelled.',
  kpiConversion: 'Lead conversion', kpiConversionHelp: 'Leads won out of leads closed (won or lost) in the range.', conversionOf: '{won} won of {closed} closed', noClosed: 'No leads closed',
  kpiIncome: 'Income', kpiIncomeHelp: 'Payments recorded or taken online, minus recorded refunds. HON records, not bank figures.', noIncome: 'No payments', otherCurrencies: 'Also: {list}',
  incomeTitle: 'Income over time', incomeTop: 'Tallest bar: {amount}', incomeDAY: 'Per day', incomeWEEK: 'Per 7 days', incomeMONTH: 'Per month',
  incomeTruncated: 'Showing the last 36 months.', incomeOnly: 'Shown in {currency}. Other currencies are in the income card.',
  colPeriod: 'Period', colNet: 'Net income', colPayments: 'Payments', colRefunds: 'Refunds', chartTable: 'Show as a table',
  beltsTitle: 'Belt mix today', beltsHelp: 'Active students by the rank they hold now. A student in two curricula counts in each.',
  beltsEmpty: 'No active students hold a rank yet.', unranked: 'No rank yet: {n}', beltsTruncated: 'Showing the first 100 ranks.', students: '{n} students',
  pipelineTitle: 'Open leads by stage', pipelineHelp: 'Leads still open today, by where they are in your pipeline.', pipelineEmpty: 'No open leads.', leads: '{n} leads',
  winsTitle: 'Won and lost', winsHelp: 'Leads closed in the range.', won: 'Won', lost: 'Lost', winRate: 'Win rate {n}%',
  nextTitle: 'Plan ahead', renewals: 'Renewals due', renewalsLine: 'Memberships coming up for renewal.', goal: 'Monthly goal', goalLine: 'Break this month\'s goal into leads, appointments, renewals and upgrades.',
  revenue: 'Revenue planning', revenueLine: 'Try what-if numbers for your funnel.',
};
export type DashboardKey = keyof typeof en;
const ko: Record<DashboardKey, string> = {
  viewOverview: '개요', viewLabel: '보고서', viewMonthly: '월별',
  rangeLabel: '기간', THIS_MONTH: '이번 달', LAST_MONTH: '지난달', D30: '30일', D90: '90일', M12: '12개월', ALL: '전체',
  overviewIntro: '선택한 기간 동안 이 학교의 주요 수치입니다(학교 시간 기준). 바로 앞 기간과 비교합니다.',
  loading: '수치를 읽는 중…', span: '{from} ~ {to} ({zone})', spanAll: '{to}까지 전체 ({zone})',
  vsPrevious: '비교: {from} ~ {to}', noCompare: '비교할 이전 기간이 없습니다.',
  up: '{n} 증가', down: '{n} 감소', same: '변동 없음', upPoints: '{n}%p 증가', downPoints: '{n}%p 감소',
  details: '자세히 보기',
  kpiActive: '활동 학생', kpiActiveHelp: '기간 말에 회원권이 있는 사람입니다. 일시정지 중인 회원권도 포함됩니다.',
  kpiNew: '신규 학생', kpiNewHelp: '첫 회원권이 이 기간에 시작된 사람입니다.',
  kpiAppointments: '상담·체험 예약', kpiAppointmentsHelp: '이 기간에 시작했고 취소되지 않은 체험·상담 예약입니다.',
  kpiConversion: '리드 전환율', kpiConversionHelp: '이 기간에 종료된(성사 또는 실패) 리드 중 성사된 비율입니다.', conversionOf: '종료 {closed}건 중 성사 {won}건', noClosed: '종료된 리드 없음',
  kpiIncome: '수입', kpiIncomeHelp: '기록되었거나 온라인으로 받은 결제에서 기록된 환불을 뺀 금액입니다. 은행 수치가 아닌 HON 기록입니다.', noIncome: '결제 없음', otherCurrencies: '그 외: {list}',
  incomeTitle: '기간별 수입', incomeTop: '가장 높은 막대: {amount}', incomeDAY: '일별', incomeWEEK: '7일별', incomeMONTH: '월별',
  incomeTruncated: '최근 36개월을 보여 줍니다.', incomeOnly: '{currency} 기준입니다. 다른 통화는 수입 카드에 있습니다.',
  colPeriod: '기간', colNet: '순수입', colPayments: '결제', colRefunds: '환불', chartTable: '표로 보기',
  beltsTitle: '오늘의 띠 분포', beltsHelp: '활동 학생을 지금 가진 급수별로 셉니다. 두 과정에 있는 학생은 각각 셉니다.',
  beltsEmpty: '아직 급수가 있는 활동 학생이 없습니다.', unranked: '급수 없음: {n}', beltsTruncated: '처음 100개 급수를 보여 줍니다.', students: '학생 {n}명',
  pipelineTitle: '단계별 진행 중 리드', pipelineHelp: '오늘 아직 열려 있는 리드를 파이프라인 단계별로 보여 줍니다.', pipelineEmpty: '진행 중인 리드가 없습니다.', leads: '리드 {n}건',
  winsTitle: '성사와 실패', winsHelp: '이 기간에 종료된 리드입니다.', won: '성사', lost: '실패', winRate: '성사율 {n}%',
  nextTitle: '미리 계획하기', renewals: '갱신 예정', renewalsLine: '곧 갱신할 회원권입니다.', goal: '월 목표', goalLine: '이번 달 목표를 리드, 예약, 갱신, 업그레이드 수로 나눕니다.',
  revenue: '매출 계획', revenueLine: '퍼널 수치를 바꿔 가며 시험해 봅니다.',
};
const es: Record<DashboardKey, string> = {
  viewOverview: 'Resumen', viewLabel: 'Informe', viewMonthly: 'Mes a mes',
  rangeLabel: 'Periodo', THIS_MONTH: 'Este mes', LAST_MONTH: 'Mes pasado', D30: '30 días', D90: '90 días', M12: '12 meses', ALL: 'Todo',
  overviewIntro: 'Las cifras principales de esta escuela en el periodo que elija, en la hora de la escuela, comparadas con el periodo anterior.',
  loading: 'Leyendo las cifras…', span: 'Del {from} al {to} ({zone})', spanAll: 'Todo hasta el {to} ({zone})',
  vsPrevious: 'frente al {from} al {to}', noCompare: 'No hay un periodo anterior para comparar.',
  up: 'sube {n}', down: 'baja {n}', same: 'sin cambio', upPoints: 'sube {n} puntos', downPoints: 'baja {n} puntos',
  details: 'Ver detalle',
  kpiActive: 'Alumnos activos', kpiActiveHelp: 'Personas con una membresía al final del periodo. Las membresías en pausa cuentan.',
  kpiNew: 'Alumnos nuevos', kpiNewHelp: 'Personas cuya primera membresía empezó en el periodo.',
  kpiAppointments: 'Citas', kpiAppointmentsHelp: 'Citas de prueba e introducción que empezaron en el periodo, sin las canceladas.',
  kpiConversion: 'Conversión de interesados', kpiConversionHelp: 'Interesados ganados entre los cerrados (ganados o perdidos) en el periodo.', conversionOf: '{won} ganados de {closed} cerrados', noClosed: 'Ningún interesado cerrado',
  kpiIncome: 'Ingresos', kpiIncomeHelp: 'Pagos registrados o en línea, menos los reembolsos registrados. Registros de HON, no cifras bancarias.', noIncome: 'Sin pagos', otherCurrencies: 'También: {list}',
  incomeTitle: 'Ingresos en el tiempo', incomeTop: 'Barra más alta: {amount}', incomeDAY: 'Por día', incomeWEEK: 'Por 7 días', incomeMONTH: 'Por mes',
  incomeTruncated: 'Se muestran los últimos 36 meses.', incomeOnly: 'En {currency}. Las otras monedas están en la tarjeta de ingresos.',
  colPeriod: 'Periodo', colNet: 'Ingreso neto', colPayments: 'Pagos', colRefunds: 'Reembolsos', chartTable: 'Ver como tabla',
  beltsTitle: 'Cinturones hoy', beltsHelp: 'Alumnos activos según el rango que tienen ahora. Un alumno en dos programas cuenta en cada uno.',
  beltsEmpty: 'Ningún alumno activo tiene rango todavía.', unranked: 'Sin rango: {n}', beltsTruncated: 'Se muestran los primeros 100 rangos.', students: '{n} alumnos',
  pipelineTitle: 'Interesados abiertos por etapa', pipelineHelp: 'Interesados todavía abiertos hoy, según su etapa.', pipelineEmpty: 'No hay interesados abiertos.', leads: '{n} interesados',
  winsTitle: 'Ganados y perdidos', winsHelp: 'Interesados cerrados en el periodo.', won: 'Ganados', lost: 'Perdidos', winRate: 'Tasa de éxito {n}%',
  nextTitle: 'Planificar', renewals: 'Renovaciones', renewalsLine: 'Membresías que vencen pronto.', goal: 'Meta mensual', goalLine: 'Divida la meta del mes en interesados, citas, renovaciones y mejoras de plan.',
  revenue: 'Planificación de ingresos', revenueLine: 'Pruebe cifras del embudo.',
};

export function dashboardText(language: string, key: DashboardKey, vars: Readonly<Record<string, string | number>> = {}): string {
  const base = language.toLowerCase().split('-')[0];
  const text = (base === 'ko' ? ko : base === 'es' ? es : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}
export const DASHBOARD_COPY = { en, ko, es } as const;
