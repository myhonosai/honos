/** CA1 (0615): commerce review wording (en / ko / es). */
const en = {
  reviewTitle: 'Ask Marcus how the store is doing',
  reviewHelp: 'Marcus reads your store totals for the last 30 days (sales, top products, low stock, margins and front-desk items not yet sent to Shopify) and writes a short review. He sees no customer names or addresses, and a review changes nothing in HON or Shopify.',
  focusLabel: 'What to look at', f_OVERVIEW: 'Everything', f_SALES: 'Sales', f_PRICING: 'Prices and margins', f_STOCK: 'Stock',
  questionLabel: 'Your question (optional)', questionHint: 'For example: which items should I reorder first? Up to 300 characters.',
  askReview: 'Ask Marcus for a review', askingReview: 'Marcus is reading the numbers…',
  reviewOff: 'Marcus is not switched on for this store yet.',
  reviewNotice: 'Marcus wrote this with AI from your store totals. Check the numbers on this page before you act on it.',
  reviewFor: 'Review: {focus} · {when}', reviewQuestion: 'Question: {question}',
  findingsTitle: 'What Marcus found', recommendationsTitle: 'What you could do', noRecommendations: 'Marcus had no recommendation this time.',
  a_SALES: 'Sales', a_PRICING: 'Prices', a_STOCK: 'Stock', a_PRODUCTS: 'Products', a_FRONT_DESK: 'Front desk',
  markReviewed: 'Mark as reviewed', dismissReview: 'Dismiss', reviewed: 'You marked this review as reviewed.', otherReview: 'Asked by someone else at your school.',
  reviewProblems: 'Marcus\'s answer could not be used:',
  ai_SESSION: 'Your session ended. Sign in again.', ai_NO_ACCESS: 'Asking Marcus needs Shopify management, Marcus and an active Complete plan. Nothing was sent.',
  ai_PAUSED: 'AI help is paused or not available for this school right now. Nothing was sent.', ai_NOT_CONNECTED: 'The store is not connected. Nothing was sent.',
  ai_GONE: 'That review was already closed.', ai_INVALID: 'That request was not accepted. Nothing was sent.',
  ai_UNKNOWN: 'HON could not confirm what happened. Press the button again to check: the same request is never sent twice.',
  ai_FAILED: 'Marcus could not write a review this time. Nothing was charged for an answer.', ai_BLOCKED: 'The request was stopped before it was sent.',
  ai_CONFIGURATION_REQUIRED: 'Marcus is not switched on for this store yet.', ai_HELD: 'The answer was lost on the way. It is held for review and is never sent again.',
} as const;
export type ReviewKey = keyof typeof en;
const ko: Record<ReviewKey, string> = {
  reviewTitle: 'Marcus에게 스토어 현황 물어보기',
  reviewHelp: 'Marcus가 최근 30일의 스토어 합계(매출, 인기 상품, 재고 부족, 마진, 아직 Shopify로 보내지 않은 프런트 데스크 항목)를 읽고 짧은 리뷰를 작성합니다. 고객 이름이나 주소는 보지 않으며, 리뷰는 HON이나 Shopify의 어떤 것도 변경하지 않습니다.',
  focusLabel: '살펴볼 내용', f_OVERVIEW: '전체', f_SALES: '매출', f_PRICING: '가격과 마진', f_STOCK: '재고',
  questionLabel: '질문 (선택)', questionHint: '예: 어떤 상품을 먼저 재주문해야 하나요? 최대 300자.',
  askReview: 'Marcus에게 리뷰 요청', askingReview: 'Marcus가 숫자를 읽는 중…',
  reviewOff: '이 스토어에서는 아직 Marcus가 켜져 있지 않습니다.',
  reviewNotice: 'Marcus가 스토어 합계를 바탕으로 AI로 작성했습니다. 실행하기 전에 이 페이지의 숫자를 확인하세요.',
  reviewFor: '리뷰: {focus} · {when}', reviewQuestion: '질문: {question}',
  findingsTitle: 'Marcus가 발견한 점', recommendationsTitle: '할 수 있는 일', noRecommendations: '이번에는 Marcus의 권장 사항이 없습니다.',
  a_SALES: '매출', a_PRICING: '가격', a_STOCK: '재고', a_PRODUCTS: '상품', a_FRONT_DESK: '프런트 데스크',
  markReviewed: '검토 완료로 표시', dismissReview: '닫기', reviewed: '이 리뷰를 검토 완료로 표시했습니다.', otherReview: '학교의 다른 사람이 요청한 리뷰입니다.',
  reviewProblems: 'Marcus의 답변을 사용할 수 없습니다:',
  ai_SESSION: '세션이 종료되었습니다. 다시 로그인하세요.', ai_NO_ACCESS: 'Marcus에게 요청하려면 Shopify 관리 권한, Marcus, 활성 Complete 플랜이 필요합니다. 아무것도 전송되지 않았습니다.',
  ai_PAUSED: '현재 이 학교의 AI 도움이 일시 중지되었거나 사용할 수 없습니다. 아무것도 전송되지 않았습니다.', ai_NOT_CONNECTED: '스토어가 연결되어 있지 않습니다. 아무것도 전송되지 않았습니다.',
  ai_GONE: '이미 닫힌 리뷰입니다.', ai_INVALID: '요청이 수락되지 않았습니다. 아무것도 전송되지 않았습니다.',
  ai_UNKNOWN: 'HON이 결과를 확인하지 못했습니다. 버튼을 다시 눌러 확인하세요. 같은 요청은 두 번 전송되지 않습니다.',
  ai_FAILED: '이번에는 Marcus가 리뷰를 작성하지 못했습니다. 답변 비용은 청구되지 않았습니다.', ai_BLOCKED: '요청이 전송되기 전에 중단되었습니다.',
  ai_CONFIGURATION_REQUIRED: '이 스토어에서는 아직 Marcus가 켜져 있지 않습니다.', ai_HELD: '답변이 전달 중에 유실되었습니다. 검토를 위해 보류되며 다시 전송되지 않습니다.',
};
const es: Record<ReviewKey, string> = {
  reviewTitle: 'Pregunte a Marcus cómo va la tienda',
  reviewHelp: 'Marcus lee los totales de su tienda de los últimos 30 días (ventas, productos más vendidos, poco inventario, márgenes y artículos de recepción aún no enviados a Shopify) y escribe una revisión breve. No ve nombres ni direcciones de clientes, y una revisión no cambia nada en HON ni en Shopify.',
  focusLabel: 'Qué revisar', f_OVERVIEW: 'Todo', f_SALES: 'Ventas', f_PRICING: 'Precios y márgenes', f_STOCK: 'Inventario',
  questionLabel: 'Su pregunta (opcional)', questionHint: 'Por ejemplo: ¿qué artículos debo reponer primero? Hasta 300 caracteres.',
  askReview: 'Pedir una revisión a Marcus', askingReview: 'Marcus está leyendo los números…',
  reviewOff: 'Marcus aún no está activado para esta tienda.',
  reviewNotice: 'Marcus escribió esto con IA a partir de los totales de su tienda. Verifique los números en esta página antes de actuar.',
  reviewFor: 'Revisión: {focus} · {when}', reviewQuestion: 'Pregunta: {question}',
  findingsTitle: 'Lo que encontró Marcus', recommendationsTitle: 'Lo que podría hacer', noRecommendations: 'Marcus no tuvo recomendaciones esta vez.',
  a_SALES: 'Ventas', a_PRICING: 'Precios', a_STOCK: 'Inventario', a_PRODUCTS: 'Productos', a_FRONT_DESK: 'Recepción',
  markReviewed: 'Marcar como revisada', dismissReview: 'Descartar', reviewed: 'Marcó esta revisión como revisada.', otherReview: 'Solicitada por otra persona de su escuela.',
  reviewProblems: 'No se pudo usar la respuesta de Marcus:',
  ai_SESSION: 'Su sesión terminó. Inicie sesión de nuevo.', ai_NO_ACCESS: 'Para preguntar a Marcus se necesita gestión de Shopify, Marcus y un plan Complete activo. No se envió nada.',
  ai_PAUSED: 'La ayuda de IA está en pausa o no está disponible para esta escuela ahora. No se envió nada.', ai_NOT_CONNECTED: 'La tienda no está conectada. No se envió nada.',
  ai_GONE: 'Esa revisión ya estaba cerrada.', ai_INVALID: 'La solicitud no fue aceptada. No se envió nada.',
  ai_UNKNOWN: 'HON no pudo confirmar lo que pasó. Pulse el botón otra vez para comprobar: la misma solicitud nunca se envía dos veces.',
  ai_FAILED: 'Marcus no pudo escribir una revisión esta vez. No se cobró ninguna respuesta.', ai_BLOCKED: 'La solicitud se detuvo antes de enviarse.',
  ai_CONFIGURATION_REQUIRED: 'Marcus aún no está activado para esta tienda.', ai_HELD: 'La respuesta se perdió en el camino. Queda retenida para revisión y nunca se envía de nuevo.',
};
export const REVIEW_LANGUAGES = { en, ko, es } as const;
export function reviewText(language: string, key: ReviewKey, vars: Record<string, string> = {}): string {
  const table = language === 'ko' ? ko : language === 'es' ? es : en;
  return table[key].replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}
