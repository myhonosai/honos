const en = {
  title: 'Steps to enroll', registration: 'Set up the membership', activation: 'Review and activate',
  review: 'Review membership activation',
  dates: 'Dates and history',
  current: 'Current DRAFT verified. Activation requires a separate authorized preview and confirmation; payment is not verified.',
  note: 'Setting up a membership saves a draft. Nothing is active until you review and activate it in step 2; payment is a separate step.',
};
const ko: Record<keyof typeof en, string> = {
  title: '등록 단계', registration: '회원권 설정', activation: '검토 및 활성화',
  review: '멤버십 활성화 검토',
  dates: '날짜 및 이력',
  current: '현재 초안을 확인했습니다. 활성화하려면 별도의 권한 확인, 미리보기 및 최종 확인이 필요합니다. 결제는 확인되지 않았습니다.',
  note: '회원권 설정은 초안으로 저장됩니다. 2단계에서 검토하고 활성화하기 전까지는 활성화되지 않으며, 결제는 별도 단계입니다.',
};
const es: Record<keyof typeof en, string> = {
  title: 'Pasos para inscribir', registration: 'Preparar la membresía', activation: 'Revisar y activar',
  review: 'Revisar activación de membresía',
  dates: 'Fechas e historial',
  current: 'DRAFT actual verificado. La activación requiere una vista previa autorizada y una confirmación independientes; el pago no está verificado.',
  note: 'Preparar la membresía guarda un borrador. Nada queda activo hasta que lo revises y actives en el paso 2; el pago es un paso aparte.',
};
export const membershipJourneyCopy = { en, ko, es };
export function membershipJourneyText(language: string | undefined, key: keyof typeof en): string {
  return membershipJourneyCopy[language as keyof typeof membershipJourneyCopy]?.[key] ?? en[key];
}
