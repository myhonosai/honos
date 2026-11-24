import type { BiometricAddOn, FaceCheckInAvailability } from '@hon/contracts';

/**
 * 0392 copy (en, ko, es): the school address fields and the face check-in notice. The notice is a TEST-ONLY DRAFT that a
 * lawyer has not reviewed; it says so on every screen that shows it.
 */
export type LocationLanguage = 'en' | 'ko' | 'es';
export interface LocationCopy {
  addressTitle: string; addressHelp: string; country: string; chooseCountry: string; region: string; chooseRegion: string; city: string;
  postalCode: string; addressLine1: string; addressLine2: string; optional: string;
  noticeTitle: string; status: Record<FaceCheckInAvailability, string>; lawsIntro: string; baseline: string; addOns: Record<BiometricAddOn, string>;
  draft: string; regionNames: { US: string; CA: string };
  pageTitle: string; pageIntro: string; save: string; discard: string; refresh: string; tryAgain: string; checking: string; reading: string;
  chooseSchool: string; denied: string; unavailable: string; hidden: string; version: (v: number, at: string) => string; notSet: string; fix: string;
  problems: { country: string; region: string; city: string; postalCode: string; addressLine1: string; addressLine2: string };
  outcomes: Record<'SENDING' | 'DONE' | 'SESSION' | 'DENIED' | 'CHANGED' | 'INVALID' | 'RATE' | 'UNKNOWN', string>;
}

const en: LocationCopy = {
  addressTitle: 'School address', addressHelp: 'HON uses your address to tell you which local rules apply, for example to face check-in.',
  country: 'Country', chooseCountry: 'Choose a country', region: 'State or province', chooseRegion: 'Choose one', city: 'City',
  postalCode: 'Postal code', addressLine1: 'Street address', addressLine2: 'Suite, unit or floor', optional: '(optional)',
  noticeTitle: 'Face check-in at your address',
  status: {
    LOCATION_REQUIRED: 'Add your school address so HON can tell you which local rules apply to face check-in.',
    AVAILABLE_WITH_CONSENT: 'Face check-in is optional and stays off until you turn it on. If you use it, the rules below apply.',
    BLOCKED: 'Face check-in is not available at your address. Portland, Oregon does not allow businesses open to the public to use face recognition. Card and name check-in work as usual.',
    NOT_REVIEWED: 'Face check-in is not available in your area yet, because HON has not reviewed the privacy laws there. Card and name check-in work as usual.',
  },
  lawsIntro: 'Laws that cover face data where your school is:',
  baseline: 'Everywhere HON offers it: a parent or guardian signs a written consent form before HON makes face data for any student under 18 (adults sign for themselves), families see the deletion policy first, face data is never sold or shared, anyone can say no or withdraw and still check in another way, and staff confirm every match.',
  addOns: {
    WRITTEN_RELEASE: 'Illinois requires a signed written release that names the purpose and how long face data is kept.',
    PUBLIC_RETENTION_SCHEDULE: 'You must make the retention and deletion policy available to the public. HON gives you the text.',
    PRIVATE_RIGHT_OF_ACTION: 'Families can sue directly over mistakes, so every step matters.',
    DESTROY_WITHIN_ONE_YEAR: 'Face data must be destroyed within a year after it is no longer needed. HON deletes it sooner.',
    HEALTH_DATA_CONSENT: 'Washington also treats face data as consumer health data, which needs its own consent and privacy notice.',
    SENSITIVE_DATA_NOTICE: 'Face data is sensitive personal information: families must be told before it is collected.',
    NO_DENIAL_FOR_REFUSAL: 'You cannot refuse service to a family that says no. They check in another way.',
    ENTRANCE_SIGN: 'New York City requires a clear sign at your entrance saying face data is collected.',
    IMPACT_ASSESSMENT: 'You need a data protection impact assessment before you start.',
    SEPARATE_CONSENT: 'Consent for face data must be asked for separately from any other consent.',
    RIGHT_TO_REFUSE_NOTICE: 'Families must be told they may refuse and what happens if they do: nothing, they check in another way.',
    CITY_BAN: 'Your city does not allow this feature.',
  },
  draft: 'This notice is a draft that a lawyer has not reviewed yet. It is not legal advice.',
  regionNames: { US: 'State', CA: 'Province or territory' },
  pageTitle: 'School location', pageIntro: 'Your school address. HON uses it to show which local rules apply to features such as face check-in.',
  save: 'Save address', discard: 'Discard changes', refresh: 'Refresh', tryAgain: 'Try again', checking: 'Checking your school…', reading: 'Reading your address…',
  chooseSchool: 'Choose a school to see its address.', denied: 'You need the manage school location permission at this school to see this page.',
  unavailable: 'The school address is not available right now. Nothing changed.', hidden: 'Hidden while this tab was in the background. Return to the page to show it again.',
  version: (v, at) => `Version ${v}, saved ${at}.`, notSet: 'No address yet.', fix: 'Fix these before saving:',
  problems: { country: 'Choose a country.', region: 'Choose the state or province.', city: 'Enter the city (up to 100 characters, no < or >).',
    postalCode: 'The postal code can be up to 20 characters.', addressLine1: 'The street address can be up to 200 characters on one line.',
    addressLine2: 'Add the street address before the suite or unit.' },
  outcomes: {
    SENDING: 'Saving. Keep this page open.', DONE: 'Saved. The address and notice below were read again from the server.',
    SESSION: 'Your session ended. Sign in again; your edits were not saved.', DENIED: 'You are not allowed to change this school\'s address. Nothing changed.',
    CHANGED: 'Someone else saved the address since you opened it. Nothing changed. Save again replaces theirs, or Discard changes shows theirs.',
    INVALID: 'The address was not accepted as sent. Nothing changed; check it and try again.', RATE: 'Too many requests. Nothing changed; try again in a moment.',
    UNKNOWN: 'The result is not known yet. Try again sends the exact same save, so nothing happens twice.',
  },
};

const ko: LocationCopy = {
  addressTitle: '도장 주소', addressHelp: 'HON은 주소를 이용해 얼굴 인식 출석 같은 기능에 어떤 지역 법규가 적용되는지 알려 드립니다.',
  country: '국가', chooseCountry: '국가 선택', region: '주/도', chooseRegion: '선택', city: '도시',
  postalCode: '우편번호', addressLine1: '도로명 주소', addressLine2: '호수, 층', optional: '(선택)',
  noticeTitle: '이 주소에서의 얼굴 인식 출석',
  status: {
    LOCATION_REQUIRED: '도장 주소를 입력하시면 얼굴 인식 출석에 적용되는 지역 법규를 알려 드립니다.',
    AVAILABLE_WITH_CONSENT: '얼굴 인식 출석은 선택 기능이며 직접 켜기 전까지 꺼져 있습니다. 사용하시면 아래 규칙이 적용됩니다.',
    BLOCKED: '이 주소에서는 얼굴 인식 출석을 사용할 수 없습니다. 미국 오리건주 포틀랜드시는 일반인이 이용하는 업소의 얼굴 인식 사용을 금지합니다. 카드와 이름 출석은 그대로 사용할 수 있습니다.',
    NOT_REVIEWED: '이 지역에서는 아직 얼굴 인식 출석을 사용할 수 없습니다. HON이 해당 지역의 개인정보 법을 아직 검토하지 않았습니다. 카드와 이름 출석은 그대로 사용할 수 있습니다.',
  },
  lawsIntro: '도장 소재지에서 얼굴 정보에 적용되는 법:',
  baseline: 'HON이 제공하는 모든 곳에서: 만 18세 미만 수련생은 부모나 보호자가 서면 동의서에 서명해야 HON이 얼굴 정보를 만들고(성인은 본인이 서명), 가족은 먼저 삭제 정책을 확인하며, 얼굴 정보는 판매하거나 공유하지 않고, 누구나 거부하거나 철회해도 다른 방법으로 출석할 수 있으며, 모든 일치는 직원이 확인합니다.',
  addOns: {
    WRITTEN_RELEASE: '일리노이주는 목적과 보관 기간이 적힌 서면 동의서 서명이 필요합니다.',
    PUBLIC_RETENTION_SCHEDULE: '보관 및 삭제 정책을 일반에 공개해야 합니다. HON이 문구를 제공합니다.',
    PRIVATE_RIGHT_OF_ACTION: '가족이 위반에 대해 직접 소송을 할 수 있으므로 모든 절차가 중요합니다.',
    DESTROY_WITHIN_ONE_YEAR: '얼굴 정보는 더 이상 필요하지 않게 된 후 1년 안에 파기해야 합니다. HON은 더 빨리 삭제합니다.',
    HEALTH_DATA_CONSENT: '워싱턴주는 얼굴 정보를 소비자 건강 정보로도 보아 별도의 동의와 개인정보 고지가 필요합니다.',
    SENSITIVE_DATA_NOTICE: '얼굴 정보는 민감한 개인정보이므로 수집 전에 가족에게 알려야 합니다.',
    NO_DENIAL_FOR_REFUSAL: '거부한 가족에게 서비스를 거절할 수 없습니다. 다른 방법으로 출석합니다.',
    ENTRANCE_SIGN: '뉴욕시는 출입구에 얼굴 정보를 수집한다는 안내문을 명확히 붙여야 합니다.',
    IMPACT_ASSESSMENT: '시작하기 전에 개인정보 영향평가가 필요합니다.',
    SEPARATE_CONSENT: '얼굴 정보 동의는 다른 동의와 따로 받아야 합니다.',
    RIGHT_TO_REFUSE_NOTICE: '거부할 수 있다는 것과 거부해도 다른 방법으로 출석할 수 있다는 것을 가족에게 알려야 합니다.',
    CITY_BAN: '이 도시에서는 이 기능을 허용하지 않습니다.',
  },
  draft: '이 안내는 아직 변호사가 검토하지 않은 초안이며 법률 자문이 아닙니다.',
  regionNames: { US: '주', CA: '주/준주' },
  pageTitle: '도장 위치', pageIntro: '도장 주소입니다. HON은 이를 이용해 얼굴 인식 출석 같은 기능에 적용되는 지역 법규를 보여 드립니다.',
  save: '주소 저장', discard: '변경 취소', refresh: '새로 고침', tryAgain: '다시 시도', checking: '도장을 확인하는 중…', reading: '주소를 읽는 중…',
  chooseSchool: '주소를 보려면 도장을 선택하세요.', denied: '이 페이지를 보려면 이 도장의 도장 위치 관리 권한이 필요합니다.',
  unavailable: '지금은 도장 주소를 볼 수 없습니다. 변경된 것은 없습니다.', hidden: '탭이 백그라운드에 있는 동안 숨겼습니다. 페이지로 돌아오면 다시 보입니다.',
  version: (v, at) => `버전 ${v}, ${at} 저장.`, notSet: '아직 주소가 없습니다.', fix: '저장하기 전에 다음을 고쳐 주세요:',
  problems: { country: '국가를 선택하세요.', region: '주나 도를 선택하세요.', city: '도시를 입력하세요(100자 이내, < > 불가).',
    postalCode: '우편번호는 20자까지 입력할 수 있습니다.', addressLine1: '도로명 주소는 한 줄에 200자까지입니다.', addressLine2: '호수 앞에 도로명 주소를 먼저 입력하세요.' },
  outcomes: {
    SENDING: '저장하는 중입니다. 페이지를 닫지 마세요.', DONE: '저장했습니다. 아래 주소와 안내는 서버에서 다시 읽었습니다.',
    SESSION: '세션이 끝났습니다. 다시 로그인하세요. 수정 내용은 저장되지 않았습니다.', DENIED: '이 도장의 주소를 바꿀 권한이 없습니다. 변경된 것은 없습니다.',
    CHANGED: '다른 사람이 먼저 주소를 저장했습니다. 변경된 것은 없습니다. 다시 저장하면 덮어쓰고, 변경 취소를 누르면 그 내용을 보여 줍니다.',
    INVALID: '보낸 주소가 받아들여지지 않았습니다. 변경된 것은 없습니다. 확인 후 다시 시도하세요.', RATE: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
    UNKNOWN: '결과를 아직 알 수 없습니다. 다시 시도는 똑같은 저장을 보내므로 두 번 처리되지 않습니다.',
  },
};

const es: LocationCopy = {
  addressTitle: 'Dirección de la escuela', addressHelp: 'HON usa su dirección para indicarle qué reglas locales se aplican, por ejemplo al registro de asistencia por rostro.',
  country: 'País', chooseCountry: 'Elija un país', region: 'Estado o provincia', chooseRegion: 'Elija uno', city: 'Ciudad',
  postalCode: 'Código postal', addressLine1: 'Dirección', addressLine2: 'Oficina, unidad o piso', optional: '(opcional)',
  noticeTitle: 'Asistencia por rostro en su dirección',
  status: {
    LOCATION_REQUIRED: 'Agregue la dirección de su escuela para que HON le indique qué reglas locales se aplican a la asistencia por rostro.',
    AVAILABLE_WITH_CONSENT: 'La asistencia por rostro es opcional y está apagada hasta que usted la active. Si la usa, se aplican las reglas de abajo.',
    BLOCKED: 'La asistencia por rostro no está disponible en su dirección. Portland, Oregón, no permite que los negocios abiertos al público usen reconocimiento facial. La asistencia con tarjeta y por nombre funciona como siempre.',
    NOT_REVIEWED: 'La asistencia por rostro aún no está disponible en su zona, porque HON no ha revisado las leyes de privacidad de allí. La asistencia con tarjeta y por nombre funciona como siempre.',
  },
  lawsIntro: 'Leyes que cubren los datos faciales donde está su escuela:',
  baseline: 'En todo lugar donde HON la ofrece: un padre, madre o tutor firma un consentimiento por escrito antes de que HON cree datos faciales de cualquier alumno menor de 18 años (los adultos firman por sí mismos), las familias ven primero la política de eliminación, los datos faciales nunca se venden ni se comparten, cualquiera puede negarse o retirar su consentimiento y registrarse de otra forma, y el personal confirma cada coincidencia.',
  addOns: {
    WRITTEN_RELEASE: 'Illinois exige una autorización escrita firmada que indique el propósito y cuánto tiempo se guardan los datos faciales.',
    PUBLIC_RETENTION_SCHEDULE: 'Debe poner la política de conservación y eliminación a disposición del público. HON le da el texto.',
    PRIVATE_RIGHT_OF_ACTION: 'Las familias pueden demandar directamente por errores, así que cada paso importa.',
    DESTROY_WITHIN_ONE_YEAR: 'Los datos faciales deben destruirse dentro del año siguiente a que dejen de necesitarse. HON los elimina antes.',
    HEALTH_DATA_CONSENT: 'Washington también considera los datos faciales como datos de salud del consumidor, que necesitan su propio consentimiento y aviso de privacidad.',
    SENSITIVE_DATA_NOTICE: 'Los datos faciales son información personal sensible: hay que avisar a las familias antes de recogerlos.',
    NO_DENIAL_FOR_REFUSAL: 'No puede negar el servicio a una familia que diga que no. Se registra de otra forma.',
    ENTRANCE_SIGN: 'La ciudad de Nueva York exige un letrero claro en la entrada que diga que se recogen datos faciales.',
    IMPACT_ASSESSMENT: 'Necesita una evaluación de impacto de protección de datos antes de empezar.',
    SEPARATE_CONSENT: 'El consentimiento para datos faciales debe pedirse aparte de cualquier otro consentimiento.',
    RIGHT_TO_REFUSE_NOTICE: 'Hay que decir a las familias que pueden negarse y qué pasa si lo hacen: nada, se registran de otra forma.',
    CITY_BAN: 'Su ciudad no permite esta función.',
  },
  draft: 'Este aviso es un borrador que todavía no ha revisado un abogado. No es asesoramiento legal.',
  regionNames: { US: 'Estado', CA: 'Provincia o territorio' },
  pageTitle: 'Ubicación de la escuela', pageIntro: 'La dirección de su escuela. HON la usa para mostrar qué reglas locales se aplican a funciones como la asistencia por rostro.',
  save: 'Guardar dirección', discard: 'Descartar cambios', refresh: 'Actualizar', tryAgain: 'Intentar de nuevo', checking: 'Revisando su escuela…', reading: 'Leyendo su dirección…',
  chooseSchool: 'Elija una escuela para ver su dirección.', denied: 'Necesita el permiso de administrar la ubicación de la escuela para ver esta página.',
  unavailable: 'La dirección de la escuela no está disponible ahora. No cambió nada.', hidden: 'Oculto mientras la pestaña estaba en segundo plano. Vuelva a la página para verlo.',
  version: (v, at) => `Versión ${v}, guardada ${at}.`, notSet: 'Todavía no hay dirección.', fix: 'Corrija esto antes de guardar:',
  problems: { country: 'Elija un país.', region: 'Elija el estado o la provincia.', city: 'Escriba la ciudad (hasta 100 caracteres, sin < ni >).',
    postalCode: 'El código postal puede tener hasta 20 caracteres.', addressLine1: 'La dirección puede tener hasta 200 caracteres en una línea.',
    addressLine2: 'Escriba la dirección antes de la oficina o unidad.' },
  outcomes: {
    SENDING: 'Guardando. Mantenga esta página abierta.', DONE: 'Guardado. La dirección y el aviso de abajo se leyeron de nuevo del servidor.',
    SESSION: 'Su sesión terminó. Inicie sesión de nuevo; sus cambios no se guardaron.', DENIED: 'No tiene permiso para cambiar la dirección de esta escuela. No cambió nada.',
    CHANGED: 'Otra persona guardó la dirección después de que usted la abrió. No cambió nada. Guardar de nuevo reemplaza la suya, o Descartar cambios muestra la suya.',
    INVALID: 'La dirección no se aceptó como se envió. No cambió nada; revísela e intente de nuevo.', RATE: 'Demasiadas solicitudes. No cambió nada; intente en un momento.',
    UNKNOWN: 'Todavía no se sabe el resultado. Intentar de nuevo envía exactamente lo mismo, así que nada pasa dos veces.',
  },
};

export const LOCATION_COPY: Record<LocationLanguage, LocationCopy> = { en, ko, es };
export const locationCopy = (language: string): LocationCopy => LOCATION_COPY[(language in LOCATION_COPY ? language : 'en') as LocationLanguage];

/** Countries offered in the picker (names come from the browser in the reader's language). Others: not reviewed. */
export const LOCATION_COUNTRIES = ['US', 'CA', 'KR', 'GB', 'IE', 'DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'AT', 'PT', 'SE', 'DK', 'FI', 'NO', 'IS', 'PL', 'CZ',
  'GR', 'HU', 'RO', 'BG', 'HR', 'SI', 'SK', 'LT', 'LV', 'EE', 'LU', 'MT', 'CY', 'LI', 'CH', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'JP', 'CN', 'TW', 'HK',
  'SG', 'PH', 'VN', 'TH', 'MY', 'ID', 'IN', 'AU', 'NZ', 'ZA', 'AE', 'IL', 'TR'] as const;
export function countryName(code: string, language: string): string {
  try { return new Intl.DisplayNames([language], { type: 'region' }).of(code) ?? code; } catch { return code; }
}
