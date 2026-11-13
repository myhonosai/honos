/** HQ business numbers wording (en / ko / es). Amounts are recorded list prices: charges are not enabled. */
const en = {
  title: 'Business numbers', back: 'Subscriptions', refresh: 'Refresh',
  intro: "HON's own recurring revenue at list price, paying schools, and month-by-month new schools, sign-ups, trials and schools that started or stopped paying. Counts and sums only: no school or person is named. Nothing changes from here.",
  testMode: 'Charges are not enabled. Every amount is a recorded list price, not money collected.',
  loading: 'Reading business numbers…', denied: 'Your HQ access does not include business numbers. Nothing is shown.',
  unavailable: 'Business numbers could not be read or checked. Nothing is shown.',
  concealed: 'Business numbers are hidden while this tab is in the background.', reveal: 'Show again',
  range: 'Months shown', months: '{n} months',
  currentTitle: 'Right now', mrr: 'Monthly recurring revenue (list price)', arr: 'Annual run rate (MRR × 12)',
  paying: 'Paying schools', payingSplit: '{monthly} monthly, {annual} annual', sourceSplit: '{binding} HON OS plan, {v1} earlier subscription',
  lifetime: 'Lifetime schools (not in MRR)', unpriced: 'Active records without a readable price (not in MRR)',
  review: 'HON OS plans held for review', suspended: 'Suspended subscriptions', trials: 'Schools in a free trial now',
  monthsTitle: 'By month (UTC)', month: 'Month', toDate: '{month} (to date)',
  newSchools: 'New schools', signups: 'Public sign-ups', trialsStarted: 'Trials started', newPaying: 'Started paying',
  conversions: 'Of those, after a trial', stopped: 'Stopped paying',
  rules: 'How these are counted: each school counts once, from its HON OS plan if it has an active one, otherwise from its newest monthly subscription. Annual prices count as one twelfth a month. Lifetime purchases are counted but never added to monthly revenue.',
  noChurn: 'No churn rate is shown. "Stopped paying" counts only earlier subscriptions that were suspended or voided; HON OS plans have no recorded cancellation after payment yet.',
  asOf: 'Read {time} UTC.',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  title: '사업 지표', back: '구독', refresh: '새로 고침',
  intro: 'HON 자체의 정가 기준 반복 매출, 결제 중인 도장, 그리고 월별 새 도장, 가입, 체험, 결제를 시작하거나 멈춘 도장을 보여 줍니다. 숫자와 합계만 표시하며 도장이나 사람 이름은 없습니다. 여기서 바뀌는 것은 없습니다.',
  testMode: '결제가 활성화되어 있지 않습니다. 모든 금액은 기록된 정가이며 실제로 받은 돈이 아닙니다.',
  loading: '사업 지표를 읽는 중…', denied: 'HQ 권한에 사업 지표가 포함되어 있지 않습니다. 아무것도 표시되지 않습니다.',
  unavailable: '사업 지표를 읽거나 확인할 수 없습니다. 아무것도 표시되지 않습니다.',
  concealed: '이 탭이 백그라운드에 있는 동안 사업 지표가 숨겨집니다.', reveal: '다시 보기',
  range: '표시할 기간', months: '{n}개월',
  currentTitle: '현재', mrr: '월 반복 매출(정가)', arr: '연간 환산(MRR × 12)',
  paying: '결제 중인 도장', payingSplit: '월간 {monthly}, 연간 {annual}', sourceSplit: 'HON OS 플랜 {binding}, 이전 구독 {v1}',
  lifetime: '평생 이용 도장(MRR 제외)', unpriced: '가격을 읽을 수 없는 활성 기록(MRR 제외)',
  review: '검토 대기 중인 HON OS 플랜', suspended: '일시 중지된 구독', trials: '현재 무료 체험 중인 도장',
  monthsTitle: '월별(UTC)', month: '월', toDate: '{month}(현재까지)',
  newSchools: '새 도장', signups: '공개 가입', trialsStarted: '시작된 체험', newPaying: '결제 시작',
  conversions: '그중 체험 후', stopped: '결제 중단',
  rules: '집계 방법: 도장마다 한 번만 셉니다. 활성 HON OS 플랜이 있으면 그 플랜으로, 없으면 가장 최근 월간 구독으로 셉니다. 연간 가격은 매월 12분의 1로 셉니다. 평생 구매는 세지만 월 매출에는 더하지 않습니다.',
  noChurn: '이탈률은 표시하지 않습니다. "결제 중단"은 일시 중지되거나 무효 처리된 이전 구독만 셉니다. HON OS 플랜에는 아직 결제 후 해지 기록이 없습니다.',
  asOf: '{time} UTC에 읽음.',
};
const es: Record<Key, string> = {
  title: 'Cifras del negocio', back: 'Suscripciones', refresh: 'Actualizar',
  intro: 'Ingresos recurrentes propios de HON a precio de lista, escuelas que pagan y, mes a mes, escuelas nuevas, registros, pruebas y escuelas que empezaron o dejaron de pagar. Solo conteos y sumas: no se nombra ninguna escuela ni persona. Aquí no cambia nada.',
  testMode: 'Los cobros no están activados. Cada monto es un precio de lista registrado, no dinero cobrado.',
  loading: 'Leyendo las cifras del negocio…', denied: 'Tu acceso de HQ no incluye las cifras del negocio. No se muestra nada.',
  unavailable: 'No se pudieron leer ni comprobar las cifras del negocio. No se muestra nada.',
  concealed: 'Las cifras del negocio se ocultan mientras esta pestaña está en segundo plano.', reveal: 'Mostrar de nuevo',
  range: 'Meses mostrados', months: '{n} meses',
  currentTitle: 'Ahora', mrr: 'Ingreso recurrente mensual (precio de lista)', arr: 'Ritmo anual (MRR × 12)',
  paying: 'Escuelas que pagan', payingSplit: '{monthly} mensuales, {annual} anuales', sourceSplit: '{binding} plan HON OS, {v1} suscripción anterior',
  lifetime: 'Escuelas vitalicias (fuera del MRR)', unpriced: 'Registros activos sin precio legible (fuera del MRR)',
  review: 'Planes HON OS en revisión', suspended: 'Suscripciones suspendidas', trials: 'Escuelas en prueba gratuita ahora',
  monthsTitle: 'Por mes (UTC)', month: 'Mes', toDate: '{month} (hasta hoy)',
  newSchools: 'Escuelas nuevas', signups: 'Registros públicos', trialsStarted: 'Pruebas iniciadas', newPaying: 'Empezaron a pagar',
  conversions: 'De ellas, tras una prueba', stopped: 'Dejaron de pagar',
  rules: 'Cómo se cuentan: cada escuela cuenta una vez, por su plan HON OS si tiene uno activo, si no por su suscripción mensual más reciente. Los precios anuales cuentan como una doceava parte al mes. Las compras vitalicias se cuentan pero nunca se suman al ingreso mensual.',
  noChurn: 'No se muestra una tasa de cancelación. "Dejaron de pagar" cuenta solo suscripciones anteriores suspendidas o anuladas; los planes HON OS aún no tienen una cancelación registrada después del pago.',
  asOf: 'Leído {time} UTC.',
};
export type BusinessKey = Key;
export function businessText(language: string, key: Key, vars: Record<string, string> = {}): string {
  const text = (language === 'ko' ? ko : language === 'es' ? es : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '');
}
