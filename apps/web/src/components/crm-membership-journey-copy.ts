const en = {
  title: 'Registration and membership review', registration: 'CRM registration and membership draft', activation: 'Separate membership activation review',
  review: 'Review membership activation',
  current: 'Current DRAFT verified. Activation requires a separate authorized preview and confirmation; payment is not verified.',
  note: 'Only organization, school and membership selectors pass to the next step. Review does not activate membership or establish payment, an agreement or completed enrollment.',
};
const ko: Record<keyof typeof en, string> = {
  title: '등록 및 멤버십 검토', registration: 'CRM 등록 및 멤버십 초안', activation: '별도의 멤버십 활성화 검토',
  review: '멤버십 활성화 검토',
  current: '현재 초안을 확인했습니다. 활성화하려면 별도의 권한 확인, 미리보기 및 최종 확인이 필요합니다. 결제는 확인되지 않았습니다.',
  note: '다음 단계에는 조직, 학교 및 멤버십 선택값만 전달됩니다. 검토만으로 멤버십 활성화, 결제, 계약 또는 등록 완료가 성립하지 않습니다.',
};
const es: Record<keyof typeof en, string> = {
  title: 'Registro y revisión de membresía', registration: 'Registro CRM y borrador de membresía', activation: 'Revisión independiente de activación de membresía',
  review: 'Revisar activación de membresía',
  current: 'DRAFT actual verificado. La activación requiere una vista previa autorizada y una confirmación independientes; el pago no está verificado.',
  note: 'Solo se transfieren selectores de organización, escuela y membresía. La revisión no activa la membresía ni acredita pago, acuerdo o inscripción completa.',
};
export const membershipJourneyCopy = { en, ko, es };
export function membershipJourneyText(language: string | undefined, key: keyof typeof en): string {
  return membershipJourneyCopy[language as keyof typeof membershipJourneyCopy]?.[key] ?? en[key];
}
