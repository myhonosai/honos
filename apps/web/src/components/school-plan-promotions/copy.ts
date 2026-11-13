/** School plan promotion wording (en / ko / es). Labels only; the promotion text itself is written by HQ. */
const en = {
  region: 'Offers from HON', dismiss: 'Not now', dismissLabel: 'Hide this offer: {headline}', until: 'Until {date}',
  perMonth: 'per month', perYear: 'per year', oneTime: 'one time',
  note: 'Opening an offer only shows it on your subscription page. Nothing is bought or changed until you start checkout there.',
  highlighted: 'The offer you opened from HON',
};
export type SchoolPromotionKey = keyof typeof en;
const ko: Record<SchoolPromotionKey, string> = {
  region: 'HON의 혜택', dismiss: '나중에', dismissLabel: '이 혜택 숨기기: {headline}', until: '{date}까지',
  perMonth: '월', perYear: '연', oneTime: '1회',
  note: '혜택을 열면 구독 페이지에서 보여 줄 뿐입니다. 그곳에서 결제를 시작하기 전에는 아무것도 구매되거나 변경되지 않습니다.',
  highlighted: 'HON에서 연 혜택',
};
const es: Record<SchoolPromotionKey, string> = {
  region: 'Ofertas de HON', dismiss: 'Ahora no', dismissLabel: 'Ocultar esta oferta: {headline}', until: 'Hasta el {date}',
  perMonth: 'al mes', perYear: 'al año', oneTime: 'pago único',
  note: 'Abrir una oferta solo la muestra en tu página de suscripción. No se compra ni cambia nada hasta que inicies el pago allí.',
  highlighted: 'La oferta que abriste desde HON',
};
const tables: Record<string, Record<SchoolPromotionKey, string>> = { en, ko, es };
export function schoolPromotionText(language: string, key: SchoolPromotionKey, vars: Record<string, string> = {}): string {
  return ((tables[language] ?? en)[key] ?? en[key]).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}
