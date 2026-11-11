/** Add-a-lead wording (en / ko / es). */
const en = {
  setupTitle: 'Set up lead stages', setupBody: 'Your school needs lead stages before you can add a lead. HON can add a simple set for you: New lead, Trial booked, Enrolled and Not now.',
  setupButton: 'Add the starter stages', setupWorking: 'Adding stages…', setupDenied: 'Only someone who manages CRM setup can add lead stages. Ask your school owner.',
  setupFailed: 'The stages could not be added. Nothing was changed. Try again.',
  pipelinesUnavailable: 'Lead stages could not be loaded, so leads cannot be added right now.', reload: 'Reload',
  addButton: 'Add a lead', addTitle: 'Add a lead', close: 'Close', givenName: 'First name', familyName: 'Last name', email: 'Email (optional)', phone: 'Mobile phone (optional)',
  phoneHelp: 'US numbers can be typed as (555) 555-0100. Other countries start with +.', stage: 'Stage', save: 'Add lead', saving: 'Adding…',
  saved: '{name} was added.', nameMissing: 'Type a first and last name.', emailInvalid: 'Check the email address.', phoneInvalid: 'Check the phone number.',
  stageMissing: 'Choose a stage.', rejected: 'The lead was not added. Check the details and try again.', denied: 'Your access does not include adding leads at this school.',
  uncertain: 'We could not confirm the lead was added. Try again sends the same lead, so it will not be added twice.', retry: 'Try again', discard: 'Start over',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  setupTitle: '문의 단계 설정', setupBody: '문의를 추가하려면 먼저 문의 단계가 필요합니다. HON이 기본 단계를 추가할 수 있습니다: 새 문의, 체험 예약, 등록, 보류.',
  setupButton: '기본 단계 추가', setupWorking: '단계를 추가하는 중…', setupDenied: 'CRM 설정 권한이 있는 사람만 문의 단계를 추가할 수 있습니다. 학교 대표에게 요청하세요.',
  setupFailed: '단계를 추가하지 못했습니다. 아무것도 바뀌지 않았습니다. 다시 시도하세요.',
  pipelinesUnavailable: '문의 단계를 불러올 수 없어 지금은 문의를 추가할 수 없습니다.', reload: '다시 불러오기',
  addButton: '문의 추가', addTitle: '문의 추가', close: '닫기', givenName: '이름', familyName: '성', email: '이메일 (선택)', phone: '휴대폰 (선택)',
  phoneHelp: '미국 번호는 (555) 555-0100처럼 입력할 수 있습니다. 다른 나라는 +로 시작하세요.', stage: '단계', save: '문의 추가', saving: '추가하는 중…',
  saved: '{name} 님을 추가했습니다.', nameMissing: '이름과 성을 입력하세요.', emailInvalid: '이메일 주소를 확인하세요.', phoneInvalid: '전화번호를 확인하세요.',
  stageMissing: '단계를 선택하세요.', rejected: '문의가 추가되지 않았습니다. 내용을 확인하고 다시 시도하세요.', denied: '이 학교에서 문의를 추가할 권한이 없습니다.',
  uncertain: '문의가 추가되었는지 확인하지 못했습니다. 다시 시도하면 같은 문의를 보내므로 두 번 추가되지 않습니다.', retry: '다시 시도', discard: '처음부터',
};
const es: Record<Key, string> = {
  setupTitle: 'Configura las etapas de prospectos', setupBody: 'Tu escuela necesita etapas de prospectos antes de agregar uno. HON puede agregar un conjunto sencillo: Nuevo prospecto, Prueba reservada, Inscrito y Por ahora no.',
  setupButton: 'Agregar las etapas iniciales', setupWorking: 'Agregando etapas…', setupDenied: 'Solo quien administra la configuración del CRM puede agregar etapas. Pídeselo al dueño de tu escuela.',
  setupFailed: 'No se pudieron agregar las etapas. No se cambió nada. Inténtalo de nuevo.',
  pipelinesUnavailable: 'No se pudieron cargar las etapas, así que ahora no se pueden agregar prospectos.', reload: 'Volver a cargar',
  addButton: 'Agregar un prospecto', addTitle: 'Agregar un prospecto', close: 'Cerrar', givenName: 'Nombre', familyName: 'Apellido', email: 'Correo (opcional)', phone: 'Celular (opcional)',
  phoneHelp: 'Los números de EE. UU. se pueden escribir como (555) 555-0100. Otros países empiezan con +.', stage: 'Etapa', save: 'Agregar prospecto', saving: 'Agregando…',
  saved: 'Se agregó a {name}.', nameMissing: 'Escribe nombre y apellido.', emailInvalid: 'Revisa el correo.', phoneInvalid: 'Revisa el número de teléfono.',
  stageMissing: 'Elige una etapa.', rejected: 'No se agregó el prospecto. Revisa los datos e inténtalo de nuevo.', denied: 'Tu acceso no incluye agregar prospectos en esta escuela.',
  uncertain: 'No pudimos confirmar que se agregó. Intentar de nuevo envía el mismo prospecto, así que no se agregará dos veces.', retry: 'Intentar de nuevo', discard: 'Empezar de nuevo',
};
export type AddLeadKey = Key;
export function addLeadText(language: string, key: Key, vars: Record<string, string> = {}): string {
  const text = (language === 'ko' ? ko : language === 'es' ? es : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '');
}
export const ADD_LEAD_LANGUAGES = { en, ko, es };
