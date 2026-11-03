import { activationText } from './membership-activation-catalog';
export const membershipRecoveryCopy = {
  title: ['Saved CRM memberships', 'CRM에서 생성된 회원권', 'Membresías guardadas del CRM'],
  intro: ['Find memberships created through this lead’s adult or guardian/child registration. This is not a school-wide directory.', '이 리드의 성인 또는 보호자·자녀 등록으로 생성된 회원권을 찾습니다. 학교 전체 회원 목록은 아닙니다.', 'Busca membresías creadas mediante el registro adulto o familiar de este lead. No es un directorio de toda la escuela.'],
  selectors: ['Lead reference · not authority', '리드 참조 정보 · 권한이 아님', 'Referencia del lead · no concede autoridad'],
  idle: ['No membership facts loaded. Verify access explicitly to read this lead’s saved memberships.', '불러온 회원권 정보가 없습니다. 접근 권한을 명시적으로 확인하여 저장된 회원권을 조회하세요.', 'No hay datos de membresía cargados. Verifica el acceso para consultar las membresías de este lead.'],
  load: ['Verify access and find memberships', '접근 권한 확인 및 회원권 찾기', 'Verificar acceso y buscar membresías'],
  refresh: ['Refresh verified memberships', '권한을 확인하고 회원권 새로 고침', 'Actualizar membresías verificadas'],
  loading: ['Verifying session and current-school memberships…', '세션 및 현재 학교 회원권 확인 중…', 'Verificando sesión y membresías de la escuela…'],
  loaded: ['Authorized membership read completed.', '권한이 확인된 회원권 조회가 완료되었습니다.', 'Consulta autorizada de membresías completada.'],
  empty: ['No memberships were returned for this lead’s own registration workflow.', '이 리드의 등록 과정에서 생성된 회원권이 조회되지 않았습니다.', 'No se devolvieron membresías del proceso de registro de este lead.'],
  bounded: ['The first 20 results are shown. More may exist; do not assume this is the complete list.', '처음 20개 결과만 표시됩니다. 추가 회원권이 있을 수 있으며 전체 목록으로 간주하지 마세요.', 'Se muestran los primeros 20 resultados. Puede haber más; no supongas que la lista está completa.'],
  limits: ['Lifecycle ACTIVE does not establish current effective dates, benefits, payment, agreement or completed enrollment. Details require another authorized read.', '수명 주기 ACTIVE만으로 현재 유효 기간, 혜택, 결제, 계약 또는 등록 완료가 확인되지는 않습니다. 상세 정보에는 별도 권한 확인이 필요합니다.', 'El estado ACTIVE no acredita vigencia actual, beneficios, pago, acuerdo ni inscripción completa. Los detalles requieren otra consulta autorizada.'],
  references: ['Student names and terms are not included in this minimal lookup. Open a record to review its separately authorized details.', '이 최소 조회에는 학생 이름과 조건이 포함되지 않습니다. 기록을 열어 별도 권한이 필요한 상세 정보를 검토하세요.', 'Esta consulta mínima no incluye nombres ni condiciones. Abre un registro para revisar sus detalles con autorización independiente.'],
  adult: ['Adult registration', '성인 등록', 'Registro adulto'],
  child: ['Guardian/child registration', '보호자·자녀 등록', 'Registro de tutor e hijo'],
  profile: ['Student profile reference', '학생 프로필 참조', 'Referencia del perfil del estudiante'],
  membership: ['Membership reference', '회원권 참조', 'Referencia de membresía'],
  created: ['Created', '생성일', 'Creación'],
  lifecycle: ['Lifecycle snapshot', '수명 주기 조회 시점 상태', 'Estado observado'],
  version: ['Observed version', '조회된 버전', 'Versión observada'],
  dates: ['Review current dates and history', '현재 기간 및 이력 검토', 'Revisar fechas e historial actuales'],
  draft: ['Review this DRAFT for activation', '이 초안의 활성화 검토', 'Revisar este borrador para activación'],
  back: ['Back to saved memberships', '저장된 회원권으로 돌아가기', 'Volver a las membresías guardadas'],
  crm: ['Return to this lead’s CRM workflow', '이 리드의 CRM 업무 흐름으로 돌아가기', 'Volver al flujo CRM de este lead'],
  crmNote: ['The CRM destination retains only these lead/school selectors and requires a fresh authorized read. Membership IDs are not placed in the URL.', 'CRM 화면에는 리드와 학교 선택값만 전달되며 새 권한 확인 조회가 필요합니다. 회원권 ID는 URL에 포함되지 않습니다.', 'El destino CRM conserva solo los selectores de lead y escuela y exige una consulta autorizada nueva. La URL no incluye IDs de membresía.'],
  hidden: ['Membership information hidden', '회원권 정보 숨김', 'Información de membresía oculta'],
  verify: ['Verify access and resume', '접근 권한 확인 후 계속', 'Verificar acceso y continuar'],
  privacy: ['Information stays hidden until a new signed-session and exact-school read succeeds. Focus alone never restores it.', '새 서명 세션 및 정확한 학교 권한 조회가 성공할 때까지 정보는 숨겨집니다. 창에 다시 초점을 맞추는 것만으로 복원되지 않습니다.', 'La información permanece oculta hasta verificar de nuevo la sesión y escuela exacta. Recuperar el foco no la restaura.'],
  SESSION: ['Your session expired or changed. Sign in again before verifying access. No membership result is assumed.', '세션이 만료되었거나 변경되었습니다. 다시 로그인한 후 접근 권한을 확인하세요. 회원권 결과를 추정하지 않습니다.', 'La sesión caducó o cambió. Inicia sesión antes de verificar el acceso. No se supone ningún resultado.'],
  DENIED: ['Current-school lead-read and membership activation permission are required. Access was denied; this is not an empty list.', '현재 학교의 리드 조회 및 회원권 활성화 권한이 필요합니다. 접근이 거부되었으며 빈 목록을 뜻하지 않습니다.', 'Se requieren permisos de lectura de leads y activación de membresías en esta escuela. Acceso denegado; no es una lista vacía.'],
  NOT_FOUND: ['This lead or its membership lookup is unavailable at the selected school. No empty result is assumed.', '선택한 학교에서 이 리드 또는 회원권 조회를 사용할 수 없습니다. 빈 결과로 간주하지 않습니다.', 'Este lead o su consulta de membresías no está disponible en la escuela seleccionada. No se supone un resultado vacío.'],
  CONFLICT: ['The server could not obtain a consistent current view. Explicitly retry this read; no membership state is assumed.', '서버에서 일관된 현재 정보를 확인하지 못했습니다. 직접 다시 조회하세요. 회원권 상태를 추정하지 않습니다.', 'El servidor no pudo obtener una vista actual coherente. Repite la consulta explícitamente; no se supone ningún estado.'],
  UNAVAILABLE: ['The membership service could not be verified. It may be unavailable or not yet deployed. Retry the read explicitly; this is not an empty result.', '회원권 서비스를 확인할 수 없습니다. 서비스를 사용할 수 없거나 아직 배포되지 않았을 수 있습니다. 직접 다시 조회하세요. 빈 결과를 뜻하지 않습니다.', 'No se pudo verificar el servicio de membresías. Puede estar indisponible o sin desplegar. Repite la consulta explícitamente; no es un resultado vacío.'],
  INVALID: ['The reference or server response could not be verified. No membership facts are available.', '참조 정보 또는 서버 응답을 확인할 수 없습니다. 확인된 회원권 정보가 없습니다.', 'No se pudo verificar la referencia o respuesta del servidor. No hay datos de membresía verificados.'],
} as const;
export type RecoveryTextKey = keyof typeof membershipRecoveryCopy;
export function membershipRecoveryText(language: string | undefined, key: RecoveryTextKey): string {
  return membershipRecoveryCopy[key][language === 'ko' ? 1 : language === 'es' ? 2 : 0];
}
export const recoveryLifecycleText = (language: string | undefined, code: string): string => activationText(language ?? 'en', code as Parameters<typeof activationText>[1]);
