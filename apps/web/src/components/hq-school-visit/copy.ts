/** Words for HQ going inside a school (owner, 2026-11-25). Plain language, en/ko/es. */
const copy = {
  en: {
    goInside: 'Go inside', going: 'Going inside…', bannerTitle: 'HON HQ is inside this school', until: 'Until', leave: 'Leave', leaving: 'Leaving…',
    bannerHelp: 'Everything you do here is logged under your name. Card charges, saved payment methods, refunds and payout settings stay with the owner.',
    failForbidden: 'Only the HQ owner or HQ staff who manage schools can go inside a school.', failUnavailable: 'This school is paused or removed, so you can\'t go inside.',
    failUnknown: 'We couldn\'t confirm that. Try again.', failSignedOut: 'Sign in again, then try again.',
  },
  ko: {
    goInside: '도장에 들어가기', going: '들어가는 중…', bannerTitle: 'HON HQ가 이 도장 안에 있습니다', until: '종료', leave: '나가기', leaving: '나가는 중…',
    bannerHelp: '여기서 하는 모든 작업은 본인 이름으로 기록됩니다. 카드 결제, 저장된 결제 수단, 환불, 정산 설정은 원장님만 할 수 있습니다.',
    failForbidden: 'HQ 대표 또는 도장 관리 권한이 있는 HQ 직원만 들어갈 수 있습니다.', failUnavailable: '이 도장은 일시 중지되었거나 삭제되어 들어갈 수 없습니다.',
    failUnknown: '확인하지 못했습니다. 다시 시도하세요.', failSignedOut: '다시 로그인한 뒤 시도하세요.',
  },
  es: {
    goInside: 'Entrar', going: 'Entrando…', bannerTitle: 'HON HQ está dentro de esta escuela', until: 'Hasta', leave: 'Salir', leaving: 'Saliendo…',
    bannerHelp: 'Todo lo que hagas aquí queda registrado con tu nombre. Los cobros con tarjeta, los métodos de pago guardados, los reembolsos y los ajustes de pagos siguen con el dueño.',
    failForbidden: 'Solo el dueño de HQ o el personal de HQ que gestiona escuelas puede entrar.', failUnavailable: 'Esta escuela está en pausa o eliminada, así que no puedes entrar.',
    failUnknown: 'No pudimos confirmarlo. Inténtalo de nuevo.', failSignedOut: 'Inicia sesión de nuevo y vuelve a intentarlo.',
  },
} as const;
export type HqSchoolVisitCopyKey = keyof typeof copy.en;
export function hqSchoolVisitText(language: string, key: HqSchoolVisitCopyKey): string {
  return (language === 'ko' ? copy.ko : language === 'es' ? copy.es : copy.en)[key];
}
