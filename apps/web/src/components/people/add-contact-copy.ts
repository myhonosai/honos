/** Add contact wording (en / ko / es). Labels only; nothing here is authority. */
const en = {
  button: 'Add contact', title: 'Add a contact', close: 'Close', kindLabel: 'Who are you adding?', kindFAMILY: 'A child student', kindADULT: 'One adult',
  parentHead: 'Parent or guardian (optional)', adultHead: 'Adult', childHead: 'Student',
  parentOptional: 'Good to have for texts, email and the family app, but you can skip it and add them later.',
  givenName: 'First name', familyName: 'Last name', email: 'Email (optional)', phone: 'Mobile phone (optional)',
  phoneHelp: 'US numbers can be typed as (555) 555-0100. Other countries start with +.',
  childGivenName: 'Student first name', childFamilyName: 'Student last name',
  adultStudent: 'This adult is a student', adultStudentHelp: 'Ticked, HON also makes their family record so they can have a membership and the family app.',
  consent: 'Record email and text consent', consentHelp: 'The adult agreed to hear from the school by email and text. Untick if they did not. Nothing is recorded for a child.',
  emailTip: 'Add the parent email if they will use the family app: the app invitation is for that email.',
  save: 'Add contact', saving: 'Adding…', retry: 'Try again', discard: 'Start over',
  saved: '{name} was added with their parent or guardian. The student card is open on the Family tab: use Family app access there to invite the parent to the family app.', savedPlain: '{name} was added.',
  nameMissing: 'Type a first and last name.', childNameMissing: 'Type the student first and last name.', parentNameMissing: 'Type the parent or guardian first and last name, or leave all their boxes empty.', emailInvalid: 'Check the email address.', phoneInvalid: 'Check the phone number.',
  denied: 'Your access does not include adding contacts at this school.',
  rejected: 'The contact was not added. Check the details and try again.',
  uncertain: 'We could not confirm everything was saved. Try again sends the same request, so nobody is added twice.',
  partialDenied: '{name} was added, but your access does not include linking the family. Ask the school owner to finish it.',
  partialRejected: '{name} was added, but the family link did not go through. Try again sends the same request, so nobody is added twice.',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  button: '연락처 추가', title: '연락처 추가', close: '닫기', kindLabel: '누구를 추가하나요?', kindFAMILY: '자녀 수련생', kindADULT: '성인 한 명',
  parentHead: '학부모 또는 보호자 (선택)', adultHead: '성인', childHead: '수련생',
  parentOptional: '문자, 이메일, 가족 앱에 필요하지만 건너뛰고 나중에 추가해도 됩니다.',
  givenName: '이름', familyName: '성', email: '이메일 (선택)', phone: '휴대전화 (선택)',
  phoneHelp: '미국 번호는 (555) 555-0100 형식으로 입력할 수 있습니다. 다른 국가는 +로 시작합니다.',
  childGivenName: '수련생 이름', childFamilyName: '수련생 성',
  adultStudent: '이 성인은 수련생입니다', adultStudentHelp: '선택하면 회원권과 가족 앱을 쓸 수 있도록 가족 기록도 만듭니다.',
  consent: '이메일 및 문자 수신 동의 기록', consentHelp: '이 성인이 학교의 이메일과 문자 수신에 동의했습니다. 동의하지 않았다면 선택을 해제하세요. 자녀에 대해서는 기록하지 않습니다.',
  emailTip: '가족 앱을 사용할 학부모라면 이메일을 입력하세요. 앱 초대는 그 이메일로 만듭니다.',
  save: '연락처 추가', saving: '추가하는 중…', retry: '다시 시도', discard: '처음부터',
  saved: '{name} 님과 학부모/보호자를 추가했습니다. 수련생 카드의 가족 탭이 열려 있습니다. 거기서 가족 앱 접근으로 학부모를 가족 앱에 초대하세요.', savedPlain: '{name} 님을 추가했습니다.',
  nameMissing: '이름과 성을 입력하세요.', childNameMissing: '수련생 이름과 성을 입력하세요.', parentNameMissing: '학부모/보호자 이름과 성을 입력하거나 모든 칸을 비워 두세요.', emailInvalid: '이메일 주소를 확인하세요.', phoneInvalid: '전화번호를 확인하세요.',
  denied: '이 학교에서 연락처를 추가할 권한이 없습니다.',
  rejected: '연락처를 추가하지 못했습니다. 내용을 확인하고 다시 시도하세요.',
  uncertain: '모두 저장되었는지 확인하지 못했습니다. 다시 시도하면 같은 요청을 보내므로 중복으로 추가되지 않습니다.',
  partialDenied: '{name} 님은 추가했지만 가족을 연결할 권한이 없습니다. 학교 대표에게 마무리를 요청하세요.',
  partialRejected: '{name} 님은 추가했지만 가족 연결이 완료되지 않았습니다. 다시 시도하면 같은 요청을 보내므로 중복으로 추가되지 않습니다.',
};
const es: Record<Key, string> = {
  button: 'Añadir contacto', title: 'Añadir un contacto', close: 'Cerrar', kindLabel: '¿A quién añades?', kindFAMILY: 'Un alumno menor', kindADULT: 'Un adulto',
  parentHead: 'Padre, madre o tutor (opcional)', adultHead: 'Adulto', childHead: 'Alumno',
  parentOptional: 'Conviene para mensajes, correo y la app familiar, pero puedes omitirlo y añadirlo después.',
  givenName: 'Nombre', familyName: 'Apellido', email: 'Correo (opcional)', phone: 'Móvil (opcional)',
  phoneHelp: 'Los números de EE. UU. se pueden escribir como (555) 555-0100. Otros países empiezan con +.',
  childGivenName: 'Nombre del alumno', childFamilyName: 'Apellido del alumno',
  adultStudent: 'Este adulto es alumno', adultStudentHelp: 'Marcado, HON también crea su registro familiar para que pueda tener membresía y la app familiar.',
  consent: 'Registrar consentimiento de correo y SMS', consentHelp: 'El adulto aceptó recibir correos y mensajes de la escuela. Desmárcalo si no fue así. No se registra nada para un menor.',
  emailTip: 'Añade el correo del padre si usará la app familiar: la invitación a la app es para ese correo.',
  save: 'Añadir contacto', saving: 'Añadiendo…', retry: 'Reintentar', discard: 'Empezar de nuevo',
  saved: 'Se añadió a {name} con su padre, madre o tutor. La ficha del alumno está abierta en la pestaña Familia: usa Acceso de la familia a la app para invitar al padre o madre.', savedPlain: 'Se añadió a {name}.',
  nameMissing: 'Escribe nombre y apellido.', childNameMissing: 'Escribe nombre y apellido del alumno.', parentNameMissing: 'Escribe nombre y apellido del padre, madre o tutor, o deja vacías todas sus casillas.', emailInvalid: 'Revisa el correo.', phoneInvalid: 'Revisa el número de teléfono.',
  denied: 'Tu acceso no incluye añadir contactos en esta escuela.',
  rejected: 'No se añadió el contacto. Revisa los datos e inténtalo de nuevo.',
  uncertain: 'No pudimos confirmar que todo se guardó. Reintentar envía la misma solicitud, así que nadie se añade dos veces.',
  partialDenied: 'Se añadió a {name}, pero tu acceso no incluye vincular la familia. Pide al dueño de la escuela que lo termine.',
  partialRejected: 'Se añadió a {name}, pero el vínculo familiar no se completó. Reintentar envía la misma solicitud, así que nadie se añade dos veces.',
};
export type AddContactKey = Key;
const ALL: Record<string, Record<Key, string>> = { en, ko, es };
export function addContactText(language: string, key: Key, vars: Record<string, string> = {}): string {
  const text = (ALL[language] ?? en)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '');
}
