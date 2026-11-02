import type {
  MembershipActivationWarningCode, MembershipActivationBlockCode, MembershipActivationSource, MembershipActivationReasonCode,
  MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED,
} from '@hon/contracts';

// English strings are stable lookup keys. Captions contain no stored participant, membership or request facts.
const rows = [
  ['Session verification failed before dispatch. No activation request was sent.', '요청 전 세션을 확인하지 못했습니다. 회원권 활성화 요청은 전송하지 않았습니다.', 'Falló la verificación de sesión antes del envío. No se envió ninguna solicitud de activación.'],
  ['Current membership state could not be verified. No current activation or effective status is assumed.', '현재 회원권 상태를 확인하지 못했습니다. 현재 활성화 또는 유효 상태를 추정하지 않습니다.', 'No se pudo verificar el estado actual de la membresía. No se supone ninguna activación ni vigencia actual.'],
  ['Open-ended · no last day', '종료일 없음 · 무기한', 'Sin fecha final · duración indefinida'],
  ['Session, school access or activation preview could not be verified. Sign in if your session expired, then review again.', '세션, 학교 접근 권한 또는 활성화 미리보기를 확인할 수 없습니다. 세션이 만료되었다면 로그인한 후 다시 검토하세요.', 'No se pudo verificar la sesión, el acceso escolar o la vista previa de activación. Si la sesión caducó, inicia sesión y revisa de nuevo.'],
  ['Enter valid school-local calendar dates to request a fresh preview.', '새 미리보기를 요청하려면 유효한 학교 현지 날짜를 입력하세요.', 'Introduce fechas válidas del calendario local de la escuela para solicitar una nueva vista previa.'],
  ['Acknowledge every warning and complete the required reasons and confirmations before reviewing the final summary.', '최종 요약을 검토하기 전에 모든 경고를 확인하고 필수 사유와 확인 항목을 작성하세요.', 'Reconoce todas las advertencias y completa los motivos y confirmaciones requeridos antes de revisar el resumen final.'],
  ['The outcome is unknown. Retry only the exact retained request.', '처리 결과를 알 수 없습니다. 보관된 동일 요청만 다시 시도하세요.', 'El resultado es desconocido. Reintenta únicamente la solicitud original conservada.'],
  ['Session and exact-school activation access verified. Review again before a new command; an unknown request can only be retried explicitly.', '세션과 해당 학교의 활성화 권한을 확인했습니다. 새 작업 전에 다시 검토하세요. 결과가 불확실한 요청은 직접 선택하여 동일하게 재시도할 수 있습니다.', 'Se verificaron la sesión y el acceso de activación para esta escuela. Revisa de nuevo antes de una nueva acción; una solicitud de resultado desconocido solo puede reintentarse explícitamente.'],
  ['Access could not be verified. Information remains hidden. Sign in again if your session expired, or ask your school owner to restore access.', '접근 권한을 확인할 수 없어 정보를 계속 숨깁니다. 세션이 만료되었다면 다시 로그인하거나 학교 소유자에게 접근 권한 복구를 요청하세요.', 'No se pudo verificar el acceso. La información sigue oculta. Si la sesión caducó, inicia sesión de nuevo o pide al propietario de la escuela que restablezca el acceso.'],
  ['Local recovery deliberately abandoned. No server action was canceled or undone. Verify current membership state before any new confirmation.', '기기의 복구 정보를 의도적으로 삭제했습니다. 서버 작업은 취소되거나 되돌려지지 않았습니다. 새 확인 전에 현재 회원권 상태를 조회하세요.', 'Se abandonó deliberadamente la recuperación local. No se canceló ni deshizo ninguna acción del servidor. Verifica el estado actual de la membresía antes de una nueva confirmación.'],
  ['days', '일', 'días'],
  ['Plan suggestion:', '회원권 제안:', 'Sugerencia del plan:'],
  ['Plan suggestion: {date}.', '회원권 제안: {date}.', 'Sugerencia del plan: {date}.'],
  ['Starts · school-local date', '시작일 · 학교 현지 날짜', 'Inicio · fecha local de la escuela'],
  ['Last valid day · inclusive', '마지막 유효일 · 당일 포함', 'Último día válido · inclusive'],
  ['Membership navigation', '회원권 메뉴', 'Navegación de membresías'],
  ['Staff dashboard', '직원 대시보드', 'Panel del personal'],
  ['CRM enrollment', 'CRM 등록', 'Inscripción en CRM'],
  ['DIRECT HUMAN STAFF · MEMBERSHIP LIFECYCLE', '직원의 직접 작업 · 회원권 수명주기', 'ACCIÓN DIRECTA DEL PERSONAL · CICLO DE VIDA DE LA MEMBRESÍA'],
  ['Review and confirm membership activation', '회원권 활성화 검토 및 확인', 'Revisar y confirmar la activación de membresía'],
  ['1. Review the server preview. 2. Confirm this membership and its exact dates.', '1. 서버 미리보기를 검토하세요. 2. 이 회원권과 정확한 날짜를 확인하세요.', '1. Revisa la vista previa del servidor. 2. Confirma esta membresía y sus fechas exactas.'],
  ['Membership confirmation is separate from financial enrollment.', '회원권 확인과 재정적 등록 절차는 별개입니다.', 'La confirmación de membresía es independiente de la inscripción financiera.'],
  ['This does not collect tuition, sign an agreement, record customer consent, authorize recurring payments or complete financial enrollment. No billing schedule is created. Card collection never authorizes recurring billing.', '이 작업은 수강료 수납, 계약 서명, 고객 동의 기록, 정기 결제 승인 또는 재정적 등록 완료를 수행하지 않습니다. 청구 일정도 생성하지 않습니다. 카드 정보를 받는 것만으로 정기 청구가 승인되지는 않습니다.', 'Esto no cobra cuotas, firma acuerdos, registra consentimiento del cliente, autoriza pagos recurrentes ni completa la inscripción financiera. No se crea un calendario de facturación. Recopilar una tarjeta nunca autoriza cobros recurrentes.'],
  ['Membership information hidden', '회원권 정보를 숨겼습니다', 'Información de membresía oculta'],
  ['Focus loss immediately conceals sensitive information. Verify your signed session and current exact-school activation access before revealing it. Commands are never resent automatically.', '화면에서 포커스가 벗어나면 민감한 정보를 즉시 숨깁니다. 표시하기 전에 로그인 세션과 해당 학교의 현재 활성화 권한을 확인하세요. 작업 요청은 자동으로 재전송되지 않습니다.', 'Al perder el foco se oculta inmediatamente la información sensible. Verifica tu sesión autenticada y el acceso actual de activación para esta escuela antes de mostrarla. Las acciones nunca se reenvían automáticamente.'],
  ['The in-flight command is settling safely. Verify access and Discard are unavailable until it settles.', '진행 중인 작업의 결과를 확인하고 있습니다. 처리가 끝날 때까지 접근 권한 확인과 로컬 정보 삭제를 사용할 수 없습니다.', 'La acción en curso está finalizando de forma segura. Verificar acceso y Descartar no están disponibles hasta que termine.'],
  ['Verify access and resume', '접근 권한 확인 후 계속', 'Verificar acceso y continuar'],
  ['Sign in again', '다시 로그인', 'Iniciar sesión de nuevo'],
  ['Discard local activation view', '로컬 활성화 화면 정보 삭제', 'Descartar vista local de activación'],
  ['One already-known membership', '이미 알고 있는 회원권 한 건', 'Una membresía ya conocida'],
  ['Enter known IDs. Every read and command independently verifies current school authority. No record is loaded or activated from URL parameters.', '알고 있는 ID를 입력하세요. 각 조회와 작업은 현재 학교 권한을 독립적으로 확인합니다. URL 매개변수로 기록을 불러오거나 활성화하지 않습니다.', 'Introduce los identificadores conocidos. Cada lectura y acción verifica de forma independiente la autoridad escolar actual. Los parámetros de URL no cargan ni activan registros.'],
  ['Organization ID', '조직 ID', 'ID de organización'],
  ['School ID', '학교 ID', 'ID de escuela'],
  ['Already-known membership ID', '이미 알고 있는 회원권 ID', 'ID de membresía ya conocido'],
  ['Review activation', '활성화 검토', 'Revisar activación'],
  ['Current membership observation', '현재 회원권 조회 결과', 'Observación actual de membresía'],
  ['version {version}', '버전 {version}', 'versión {version}'],
  ['This live observation is separate from any historical confirmation receipt. ACTIVE alone does not prove current effective dates, payment or agreement.', '이 현재 조회 결과는 과거 확인 기록과 별개입니다. ACTIVE 상태만으로 현재 유효 기간, 결제 또는 계약을 입증하지는 않습니다.', 'Esta observación actual es independiente de cualquier comprobante histórico. ACTIVE por sí solo no demuestra fechas efectivas actuales, pago ni acuerdo.'],
  ['Membership dates', '회원권 날짜', 'Fechas de membresía'],
  ['Dates use the school timezone. The end is the last valid membership day. Every valid edit requests a fresh preview and clears all previous acknowledgements.', '날짜는 학교 시간대를 사용합니다. 종료일은 회원권의 마지막 유효일입니다. 유효한 날짜를 수정할 때마다 새 미리보기를 요청하고 이전 확인 항목을 모두 초기화합니다.', 'Las fechas usan la zona horaria de la escuela. El final es el último día válido de la membresía. Cada edición válida solicita una nueva vista previa y borra todos los reconocimientos anteriores.'],
  ['Start date', '시작일', 'Fecha de inicio'],
  ['Last valid day (inclusive)', '마지막 유효일(당일 포함)', 'Último día válido (inclusive)'],
  ['Leave the last day blank to request an open-ended term. The backend decides whether this plan supports it.', '종료일이 없는 기간을 요청하려면 마지막 날짜를 비워 두세요. 이 회원권에서 허용되는지는 서버가 판단합니다.', 'Deja el último día en blanco para solicitar una duración indefinida. El servidor determina si este plan lo permite.'],
  ['Step 1 · Review activation', '1단계 · 활성화 검토', 'Paso 1 · Revisar activación'],
  ['Student', '학생', 'Alumno'],
  ['Name unavailable', '이름을 확인할 수 없음', 'Nombre no disponible'],
  ['Membership plan', '회원권 상품', 'Plan de membresía'],
  ['published version {version}', '공개된 버전 {version}', 'versión publicada {version}'],
  ['Membership source', '회원권 생성 경로', 'Origen de la membresía'],
  ['Current membership status', '현재 회원권 상태', 'Estado actual de la membresía'],
  ['School timezone', '학교 시간대', 'Zona horaria de la escuela'],
  ['Today:', '오늘:', 'Hoy:'],
  ['Suggested start', '제안된 시작일', 'Inicio sugerido'],
  ['Suggested last day (inclusive)', '제안된 마지막 유효일(당일 포함)', 'Último día sugerido (inclusive)'],
  ['Projected effective status if confirmed now', '지금 확인할 경우 예상 유효 상태', 'Estado efectivo previsto si se confirma ahora'],
  ['Unavailable', '확인할 수 없음', 'No disponible'],
  ['Confirmation would schedule this membership to begin {date}. It is not currently IN_EFFECT.', '확인하면 이 회원권은 {date}에 시작하도록 예정됩니다. 현재 IN_EFFECT 상태는 아닙니다.', 'La confirmación programaría el inicio de esta membresía para el {date}. Actualmente no está IN_EFFECT.'],
  ['Activation blockers', '활성화를 막는 항목', 'Bloqueos de activación'],
  ['Warnings requiring acknowledgement', '확인이 필요한 경고', 'Advertencias que requieren reconocimiento'],
  ['No warnings were returned.', '반환된 경고가 없습니다.', 'No se devolvieron advertencias.'],
  ['Authorized identity-review override', '권한이 확인된 신원 검토 예외 처리', 'Excepción autorizada de revisión de identidad'],
  ['Review remains unresolved. No identities will be merged, deleted or reassigned. A follow-up work item will be recorded.', '검토는 미해결 상태로 남습니다. 신원을 병합, 삭제 또는 재할당하지 않습니다. 후속 작업 항목이 기록됩니다.', 'La revisión sigue sin resolverse. No se fusionará, eliminará ni reasignará ninguna identidad. Se registrará una tarea de seguimiento.'],
  ['Identity override reason (10–500 characters)', '신원 검토 예외 처리 사유(10~500자)', 'Motivo de la excepción de identidad (10–500 caracteres)'],
  ['I separately confirm that this identity review remains unresolved.', '이 신원 검토가 미해결 상태로 남는다는 점을 별도로 확인합니다.', 'Confirmo por separado que esta revisión de identidad sigue sin resolverse.'],
  ['Your preview does not authorize an identity override. An appropriately authorized staff member must review; no override control is available.', '이 미리보기에서는 신원 검토 예외 처리가 허용되지 않습니다. 적절한 권한이 있는 직원이 검토해야 하며 예외 처리 기능은 제공되지 않습니다.', 'Tu vista previa no autoriza una excepción de identidad. Debe revisar una persona con los permisos adecuados; no hay un control de excepción disponible.'],
  ['A birth-date follow-up reminder will be created. No birth date or customer consent is fabricated.', '생년월일 확인을 위한 후속 알림이 생성됩니다. 생년월일이나 고객 동의를 임의로 기록하지 않습니다.', 'Se creará un recordatorio de seguimiento de la fecha de nacimiento. No se inventa ninguna fecha de nacimiento ni consentimiento del cliente.'],
  ['Optional: I attest that staff verified this participant is an adult.', '선택 사항: 직원이 이 참가자의 성인 여부를 확인했음을 증명합니다.', 'Opcional: declaro que el personal verificó que este participante es adulto.'],
  ['Adult verification method', '성인 확인 방법', 'Método de verificación de adulto'],
  ['Date adjustment reason', '날짜 조정 사유', 'Motivo del ajuste de fechas'],
  ['Activation reason', '활성화 사유', 'Motivo de activación'],
  ['Activation reason details', '활성화 사유 상세', 'Detalles del motivo de activación'],
  [' (required)', ' (필수)', ' (obligatorio)'],
  [' (optional)', ' (선택)', ' (opcional)'],
  ['Requirements not evaluated', '평가하지 않은 요건', 'Requisitos no evaluados'],
  ['Review final confirmation', '최종 확인 내용 검토', 'Revisar confirmación final'],
  ['Step 2 · Confirm activation', '2단계 · 활성화 확인', 'Paso 2 · Confirmar activación'],
  ['Projected effective status:', '예상 유효 상태:', 'Estado efectivo previsto:'],
  ['The server will revalidate these exact reviewed facts.', '서버가 검토한 이 사실들을 다시 검증합니다.', 'El servidor volverá a validar exactamente estos datos revisados.'],
  ['Reason:', '사유:', 'Motivo:'],
  ['Date adjustment:', '날짜 조정:', 'Ajuste de fechas:'],
  ['Acknowledged:', '확인한 경고:', 'Reconocido:'],
  ['Unresolved identity override:', '미해결 신원 검토 예외 처리:', 'Excepción de identidad sin resolver:'],
  ['Optional staff adult attestation:', '선택적 직원 성인 확인 진술:', 'Declaración opcional del personal sobre mayoría de edad:'],
  ['No birth date is recorded.', '생년월일은 기록되지 않습니다.', 'No se registra ninguna fecha de nacimiento.'],
  ['No agreement, signature, customer consent, payment or recurring-payment authorization is recorded.', '계약, 서명, 고객 동의, 결제 또는 정기 결제 승인은 기록되지 않습니다.', 'No se registra ningún acuerdo, firma, consentimiento del cliente, pago ni autorización de pagos recurrentes.'],
  ['I confirm this membership and the exact dates above, without recording agreement, consent or payment.', '계약, 동의 또는 결제를 기록하지 않고 이 회원권과 위의 정확한 날짜를 확인합니다.', 'Confirmo esta membresía y las fechas exactas anteriores, sin registrar acuerdo, consentimiento ni pago.'],
  ['Confirmation could not be prepared. Review the current preview again.', '확인 요청을 준비할 수 없습니다. 현재 미리보기를 다시 검토하세요.', 'No se pudo preparar la confirmación. Revisa de nuevo la vista previa actual.'],
  ['Confirm membership activation', '회원권 활성화 확인', 'Confirmar activación de membresía'],
  ['Back to review', '검토로 돌아가기', 'Volver a la revisión'],
  ['Activation request in progress', '활성화 요청 처리 중', 'Solicitud de activación en curso'],
  ['Activation outcome unknown', '활성화 결과 불확실', 'Resultado de activación desconocido'],
  ['No unverified activation is assumed. The immutable request and original idempotency key remain in memory only. There is no automatic retry.', '검증되지 않은 활성화를 완료로 간주하지 않습니다. 변경 불가능한 요청과 원래의 중복 방지 키는 메모리에만 보관됩니다. 자동 재시도는 하지 않습니다.', 'No se supone ninguna activación sin verificar. La solicitud inmutable y su clave original de idempotencia permanecen solo en memoria. No hay reintentos automáticos.'],
  ['Retry exact retained activation', '보관된 동일 활성화 요청 재시도', 'Reintentar la activación original conservada'],
  ['Discard activation retry', '활성화 재시도 정보 삭제', 'Descartar reintento de activación'],
  ['Membership confirmation receipt', '회원권 확인 기록', 'Comprobante de confirmación de membresía'],
  ['Membership confirmed — scheduled to begin {date}.', '회원권 확인 완료 — {date}에 시작 예정입니다.', 'Membresía confirmada — inicio programado para el {date}.'],
  ['Membership confirmed — its recorded effective period has ended.', '회원권 확인 완료 — 기록된 유효 기간이 종료되었습니다.', 'Membresía confirmada — su período efectivo registrado ha terminado.'],
  ['Membership confirmed — IN_EFFECT at the recorded confirmation time.', '회원권 확인 완료 — 기록된 확인 시점에 IN_EFFECT 상태였습니다.', 'Membresía confirmada — IN_EFFECT en el momento de confirmación registrado.'],
  ['Lifecycle ACTIVE · version {version}', '수명주기 ACTIVE · 버전 {version}', 'Ciclo de vida ACTIVE · versión {version}'],
  ['idempotent replay', '동일 요청의 저장된 결과', 'repetición idempotente'],
  ['This is historical confirmation evidence; it is not a new current-state read.', '이 정보는 과거 확인의 근거이며 새로 조회한 현재 상태가 아닙니다.', 'Esto es evidencia histórica de confirmación; no es una nueva lectura del estado actual.'],
  ['School timezone:', '학교 시간대:', 'Zona horaria de la escuela:'],
  ['Confirmation recorded:', '확인 기록 시각:', 'Confirmación registrada:'],
  ['Warnings acknowledged', '확인한 경고', 'Advertencias reconocidas'],
  ['Overrides used', '사용한 예외 처리', 'Excepciones utilizadas'],
  ['None.', '없음.', 'Ninguna.'],
  ['Identity-review override recorded. The review remains unresolved.', '신원 검토 예외 처리가 기록되었습니다. 검토는 미해결 상태로 남습니다.', 'Se registró una excepción de revisión de identidad. La revisión sigue sin resolverse.'],
  ['Follow-up reminders', '후속 알림', 'Recordatorios de seguimiento'],
  ['No reminders returned.', '반환된 알림이 없습니다.', 'No se devolvieron recordatorios.'],
  ['Record birth date for an activated membership', '활성화된 회원권의 생년월일 기록', 'Registrar fecha de nacimiento para una membresía activada'],
  ['Resolve outstanding identity review', '미해결 신원 검토 처리', 'Resolver la revisión de identidad pendiente'],
  ['Work item', '작업 항목', 'Tarea'],
  ['This is not payment, agreement, consent, recurring authorization or financially complete enrollment evidence.', '이 기록은 결제, 계약, 동의, 정기 결제 승인 또는 재정적 등록 완료의 근거가 아닙니다.', 'Esto no es evidencia de pago, acuerdo, consentimiento, autorización recurrente ni inscripción financiera completa.'],
  ['Verifying current session, school access and membership facts…', '현재 세션, 학교 접근 권한 및 회원권 정보를 확인 중입니다…', 'Verificando la sesión actual, el acceso escolar y los datos de membresía…'],
  ['Discard retry', '재시도 정보 삭제', 'Descartar reintento'],
  ['An action may already have completed. Discard permanently removes its local retry information; it does not cancel or undo a server action. Retry the exact request to resolve an unknown outcome, or deliberately abandon local recovery and verify saved setup before any new action.', '작업이 이미 완료되었을 수 있습니다. 삭제하면 기기의 재시도 정보만 영구적으로 제거되며 서버 작업은 취소되거나 되돌려지지 않습니다. 결과를 확인하려면 동일 요청을 다시 시도하거나, 로컬 복구를 의도적으로 포기하고 새 작업 전에 저장된 설정을 확인하세요.', 'Una acción puede haberse completado ya. Descartar elimina permanentemente su información local de reintento; no cancela ni deshace una acción del servidor. Reintenta la solicitud exacta para resolver un resultado desconocido, o abandona deliberadamente la recuperación local y verifica los datos guardados antes de una nueva acción.'],
  ['I understand and deliberately abandon local recovery.', '이 내용을 이해하며 로컬 복구를 의도적으로 포기합니다.', 'Lo entiendo y abandono deliberadamente la recuperación local.'],

  ['Review membership activation', '회원권 활성화 검토', 'Revisar activación de membresía'],
  ['Return to CRM registration', 'CRM 등록으로 돌아가기', 'Volver a la inscripción en CRM'],
  ['Membership reference selected from CRM; review current facts before confirming.', 'CRM에서 회원권 참조를 선택했습니다. 확인하기 전에 현재 정보를 검토하세요.', 'Referencia de membresía seleccionada desde CRM; revisa los datos actuales antes de confirmar.'],
  ['Check current membership status', '현재 회원권 상태 확인', 'Consultar el estado actual de la membresía'],
  ['Current lifecycle observation; effective status, payment and agreement are not verified by this read.', '현재 수명주기 조회 결과입니다. 이 조회는 유효 상태, 결제 또는 계약을 검증하지 않습니다.', 'Observación actual del ciclo de vida; esta lectura no verifica el estado efectivo, el pago ni el acuerdo.'],
  ['Continue school operations', '학교 운영 계속', 'Continuar las operaciones de la escuela'],
  ['Class bookings', '수업 예약', 'Reservas de clases'],
  ['Attendance', '출석', 'Asistencia'],
  ['These links do not book a class, record attendance or prove payment.', '이 링크는 수업을 예약하거나 출석을 기록하거나 결제를 입증하지 않습니다.', 'Estos enlaces no reservan clases, registran asistencia ni demuestran un pago.'],
  ['Presentation', '화면 모드', 'Presentación'],
  ['Modern', '모던', 'Moderno'],
  ['Classic', '클래식', 'Clásico'],
  ['Big Button', '큰 버튼', 'Botones grandes'],
  ['Verify access before retrying the exact original request.', '원래의 동일 요청을 재시도하기 전에 접근 권한을 확인하세요.', 'Verifica el acceso antes de reintentar la solicitud original exacta.'],

  ['Birth date is missing. A staff follow-up reminder will be created; this warning does not by itself block activation.', '생년월일이 없습니다. 직원의 후속 확인 알림이 생성되며 이 경고만으로 활성화가 차단되지는 않습니다.', 'Falta la fecha de nacimiento. Se creará un recordatorio de seguimiento para el personal; esta advertencia por sí sola no bloquea la activación.'],
  ['An identity review is unresolved. A documented, separately authorized override does not resolve or merge these identities.', '신원 검토가 미해결 상태입니다. 사유를 기록하고 별도로 권한을 확인한 예외 처리를 해도 신원 문제가 해결되거나 병합되지는 않습니다.', 'Hay una revisión de identidad sin resolver. Una excepción documentada y autorizada por separado no resuelve ni fusiona estas identidades.'],
  ['The proposed membership end date has already passed.', '제안된 회원권 종료일이 이미 지났습니다.', 'La fecha final propuesta de la membresía ya ha pasado.'],
  ['An existing invoice has not been evaluated. No payment or settlement is confirmed.', '기존 청구서를 평가하지 않았습니다. 결제나 정산이 확인된 것은 아닙니다.', 'No se ha evaluado una factura existente. No se confirma ningún pago ni liquidación.'],
  ['An existing payment schedule has not been evaluated or authorized.', '기존 결제 일정을 평가하거나 승인하지 않았습니다.', 'No se ha evaluado ni autorizado un calendario de pagos existente.'],
  ['The proposed term differs from the published plan suggestion.', '제안된 기간이 공개된 회원권의 제안과 다릅니다.', 'La duración propuesta difiere de la sugerencia del plan publicado.'],
  ['This membership uses a legacy free-text plan; no published catalog terms are implied.', '이 회원권은 기존의 자유 입력 상품을 사용하며 공개된 카탈로그 약관을 의미하지 않습니다.', 'Esta membresía usa un plan antiguo de texto libre; no implica condiciones de un catálogo publicado.'],
  ['An end date has been entered for an open-ended plan.', '종료일이 없는 상품에 종료일을 입력했습니다.', 'Se ha introducido una fecha final para un plan de duración indefinida.'],
  ['The proposed start date is in the past. A documented activation reason is required.', '제안된 시작일이 과거입니다. 활성화 사유를 기록해야 합니다.', 'La fecha de inicio propuesta está en el pasado. Se requiere un motivo de activación documentado.'],
  ['The membership is scheduled to start in the future; confirmation does not make it currently in effect.', '회원권은 미래에 시작할 예정이며 확인한다고 해서 현재 유효해지는 것은 아닙니다.', 'La membresía tiene un inicio programado en el futuro; confirmarla no hace que esté vigente ahora.'],
  ['The registered membership DRAFT changed. Recheck its current state through Resume setup.', '등록된 회원권 초안이 변경되었습니다. 설정 재개에서 현재 상태를 다시 확인하세요.', 'Cambió el BORRADOR de membresía registrado. Vuelve a consultar su estado mediante Continuar configuración.'],
  ['The last valid membership day must not be before its start.', '회원권의 마지막 유효일은 시작일보다 빠를 수 없습니다.', 'El último día válido de la membresía no puede ser anterior al inicio.'],
  ['The end date is outside the backend-supported date window.', '종료일이 서버에서 지원하는 날짜 범위를 벗어났습니다.', 'La fecha final está fuera del intervalo admitido por el servidor.'],
  ['This fixed-term plan requires an end date.', '이 고정 기간 상품에는 종료일이 필요합니다.', 'Este plan de duración fija requiere una fecha final.'],
  ['This membership is no longer a DRAFT and cannot be activated again.', '이 회원권은 더 이상 초안이 아니므로 다시 활성화할 수 없습니다.', 'Esta membresía ya no es un BORRADOR y no puede activarse de nuevo.'],
  ['A known minor requires a verified guardian of record. Authorized staff must review the registration; this screen cannot repair or relink identities.', '미성년자로 확인된 참가자에게는 검증된 보호자 기록이 필요합니다. 권한이 있는 직원이 등록을 검토해야 하며 이 화면에서는 신원을 수정하거나 다시 연결할 수 없습니다.', 'Un menor conocido requiere un tutor registrado y verificado. El personal autorizado debe revisar la inscripción; esta pantalla no puede corregir ni volver a vincular identidades.'],
  ['The membership’s original published plan binding could not be verified.', '회원권의 원래 공개 상품 연결을 검증할 수 없습니다.', 'No se pudo verificar el vínculo original de la membresía con el plan publicado.'],
  ['The bound plan and canonical billing-account currencies do not match.', '연결된 상품과 공식 청구 계정의 통화가 일치하지 않습니다.', 'Las monedas del plan vinculado y de la cuenta de facturación canónica no coinciden.'],
  ['The start date is outside the backend-supported date window.', '시작일이 서버에서 지원하는 날짜 범위를 벗어났습니다.', 'La fecha de inicio está fuera del intervalo admitido por el servidor.'],
  ['Agreement and signature', '계약 및 서명', 'Acuerdo y firma'],
  ['Tuition or other payment', '수강료 또는 기타 결제', 'Cuotas u otros pagos'],
  ['Recurring-payment authorization', '정기 결제 승인', 'Autorización de pagos recurrentes'],
  ['Financial responsibility', '재정적 책임', 'Responsabilidad financiera'],
  ['School activation policy', '학교 활성화 정책', 'Política de activación de la escuela'],
  ['Legacy membership', '기존 회원권', 'Membresía antigua'],
  ['Owner Launch', '학교 소유자 시작 설정', 'Configuración inicial del propietario'],
  ['Adult CRM · free-text plan', '성인 CRM · 자유 입력 상품', 'CRM de adultos · plan de texto libre'],
  ['Adult CRM · published plan', '성인 CRM · 공개 상품', 'CRM de adultos · plan publicado'],
  ['Guardian/child CRM · published plan', '보호자·자녀 CRM · 공개 상품', 'CRM de tutores e hijos · plan publicado'],
  ['Routine enrollment', '일반 등록', 'Inscripción habitual'],
  ['Documents pending', '서류 대기 중', 'Documentos pendientes'],
  ['Paper records held by school', '학교에서 종이 기록 보관', 'Documentación en papel conservada por la escuela'],
  ['Payment handled outside HON (not verified here)', 'HON 외부에서 결제 처리(여기서는 미확인)', 'Pago gestionado fuera de HON (no verificado aquí)'],
  ['Scholarship or complimentary membership', '장학 또는 무료 회원권', 'Beca o membresía de cortesía'],
  ['Staff or family membership', '직원 또는 가족 회원권', 'Membresía de personal o familiar'],
  ['Other documented reason', '기타 기록된 사유', 'Otro motivo documentado'],

  ['The reviewed facts changed. Review activation again and acknowledge the fresh preview before confirming.', '검토한 정보가 변경되었습니다. 활성화를 다시 검토하고 새 미리보기의 경고를 확인한 후 최종 확인하세요.', 'Cambiaron los datos revisados. Revisa de nuevo la activación y reconoce la nueva vista previa antes de confirmar.'],
  ['This request requires the two-step activation interface. Reload the current application.', '이 요청에는 2단계 활성화 화면이 필요합니다. 현재 앱을 새로 고치세요.', 'Esta solicitud requiere la interfaz de activación de dos pasos. Vuelve a cargar la aplicación actual.'],
  ['Acknowledge every warning in a fresh preview.', '새 미리보기의 모든 경고를 확인하세요.', 'Reconoce todas las advertencias en una nueva vista previa.'],
  ['This review requires an authorized identity override, a documented reason and secondary confirmation.', '이 검토에는 권한이 확인된 신원 예외 처리, 기록된 사유 및 별도의 두 번째 확인이 필요합니다.', 'Esta revisión requiere una excepción de identidad autorizada, un motivo documentado y una segunda confirmación.'],
  ['Your current school permissions do not allow this override. Ask an appropriately authorized staff member to review.', '현재 학교 권한으로는 이 예외 처리가 허용되지 않습니다. 적절한 권한이 있는 직원에게 검토를 요청하세요.', 'Tus permisos escolares actuales no permiten esta excepción. Pide que revise una persona con la autorización adecuada.'],
  ['Activation is blocked. Review the server-provided blockers; no activation is assumed.', '활성화가 차단되었습니다. 서버가 반환한 차단 항목을 검토하세요. 활성화되었다고 가정하지 마세요.', 'La activación está bloqueada. Revisa los bloqueos devueltos por el servidor; no se supone ninguna activación.'],
  ['The membership version changed. Review the current membership again.', '회원권 버전이 변경되었습니다. 현재 회원권을 다시 검토하세요.', 'Cambió la versión de la membresía. Revisa de nuevo la membresía actual.'],
  ['Only a current DRAFT can be activated. Review the current membership state.', '현재 초안인 회원권만 활성화할 수 있습니다. 현재 회원권 상태를 확인하세요.', 'Solo puede activarse un BORRADOR actual. Revisa el estado actual de la membresía.'],
  ['The request key conflicts with another request. Verify current state before starting a new confirmation.', '요청 키가 다른 요청과 충돌합니다. 새 확인을 시작하기 전에 현재 상태를 조회하세요.', 'La clave de solicitud entra en conflicto con otra solicitud. Verifica el estado actual antes de iniciar una nueva confirmación.'],
  ['The original request is still being processed. Retry only the exact retained request when ready.', '원래 요청을 아직 처리 중입니다. 준비되면 보관된 동일 요청만 다시 시도하세요.', 'La solicitud original sigue en proceso. Cuando esté listo, reintenta únicamente la solicitud exacta conservada.'],
  ['The date source changed. Request a new preview before confirming.', '날짜 출처가 변경되었습니다. 확인하기 전에 새 미리보기를 요청하세요.', 'Cambió el origen de las fechas. Solicita una nueva vista previa antes de confirmar.'],
  ['Provide the required activation reason, then review again.', '필수 활성화 사유를 입력한 후 다시 검토하세요.', 'Indica el motivo de activación requerido y revisa de nuevo.'],
  ['An adult attestation is only supported when the birth date is missing. Review again.', '성인 확인 진술은 생년월일이 없는 경우에만 지원됩니다. 다시 검토하세요.', 'La declaración de mayoría de edad solo se admite cuando falta la fecha de nacimiento. Revisa de nuevo.'],
  ['The school timezone is unavailable. An authorized administrator must correct it before activation.', '학교 시간대를 사용할 수 없습니다. 활성화하기 전에 권한이 있는 관리자가 수정해야 합니다.', 'La zona horaria de la escuela no está disponible. Un administrador autorizado debe corregirla antes de activar.'],
  ['Review the dates, required reasons and confirmations. The request was not accepted.', '날짜, 필수 사유 및 확인 항목을 검토하세요. 요청이 수락되지 않았습니다.', 'Revisa las fechas, los motivos y las confirmaciones requeridos. La solicitud no fue aceptada.'],
  ['This membership is unavailable in the selected school.', '선택한 학교에서 이 회원권을 확인할 수 없습니다.', 'Esta membresía no está disponible en la escuela seleccionada.'],
  ['Current staff activation permission or school access is unavailable.', '현재 직원의 활성화 권한 또는 학교 접근 권한을 확인할 수 없습니다.', 'No están disponibles los permisos actuales de activación del personal o el acceso escolar.'],
  ['Your session has expired. Sign in again before verifying access.', '세션이 만료되었습니다. 접근 권한을 확인하기 전에 다시 로그인하세요.', 'Tu sesión ha caducado. Inicia sesión de nuevo antes de verificar el acceso.'],
  ['Your current school access, activation permission or billing entitlement is unavailable.', '현재 학교 접근 권한, 활성화 권한 또는 청구 이용 권한을 확인할 수 없습니다.', 'No están disponibles tu acceso escolar actual, permiso de activación o derecho de facturación.'],
  ['The outcome is unknown. No activation is assumed. Retry only the exact retained request.', '처리 결과를 알 수 없습니다. 활성화되었다고 가정하지 마세요. 보관된 동일 요청만 다시 시도하세요.', 'El resultado es desconocido. No se supone ninguna activación. Reintenta únicamente la solicitud exacta conservada.'],
  ['The request was refused. Review current school access and membership facts before trying again.', '요청이 거부되었습니다. 다시 시도하기 전에 현재 학교 접근 권한과 회원권 정보를 검토하세요.', 'La solicitud fue rechazada. Revisa el acceso escolar actual y los datos de membresía antes de intentarlo de nuevo.'],

  ['DRAFT', '초안', 'BORRADOR'], ['ACTIVE', '활성(수명주기)', 'ACTIVA (ciclo de vida)'], ['FROZEN', '일시 정지', 'CONGELADA'],
  ['CANCELLATION_PENDING', '해지 대기', 'CANCELACIÓN PENDIENTE'], ['CANCELLED', '해지됨', 'CANCELADA'], ['EXPIRED', '만료됨', 'CADUCADA'],
  ['SCHEDULED', '시작 예정', 'INICIO PROGRAMADO'], ['IN_EFFECT', '유효', 'VIGENTE'], ['ENDED', '종료됨', 'FINALIZADA'],
  ['DRAFT START DATE', '초안 시작일', 'FECHA DE INICIO DEL BORRADOR'], ['TODAY IN SCHOOL TIMEZONE', '학교 시간대의 오늘', 'HOY EN LA ZONA HORARIA ESCOLAR'],
  ['PLAN FIXED TERM', '상품의 고정 기간', 'DURACIÓN FIJA DEL PLAN'], ['PLAN OPEN ENDED', '종료일 없는 상품', 'PLAN DE DURACIÓN INDEFINIDA'],
  ['DRAFT END DATE', '초안 종료일', 'FECHA FINAL DEL BORRADOR'], ['NO END DATE', '종료일 없음', 'SIN FECHA FINAL'],
  ['ID CHECKED IN PERSON', '대면 신분증 확인', 'IDENTIFICACIÓN COMPROBADA EN PERSONA'], ['DOCUMENT REVIEWED', '서류 검토', 'DOCUMENTO REVISADO'], ['SELF DECLARED TO STAFF', '직원에게 본인이 진술', 'DECLARADO POR LA PERSONA AL PERSONAL'],
] as const;

type RowKey = typeof rows[number][0];
function catalog(column: 0 | 1 | 2): Readonly<Record<RowKey, string>> {
  return Object.freeze(Object.fromEntries(rows.map(row => [row[0], row[column]]))) as Readonly<Record<RowKey, string>>;
}
export const activationEnglish = catalog(0);
export type ActivationTextKey = keyof typeof activationEnglish;
export type ActivationLanguage = 'en' | 'ko' | 'es';
export type ActivationVariables = Readonly<Partial<Record<'name' | 'date' | 'version', string | number>>>;
export const activationCatalogs = Object.freeze({ en: activationEnglish, ko: catalog(1), es: catalog(2) });

export function activationText(language: string, key: ActivationTextKey, vars?: ActivationVariables): string {
  const selected = Object.hasOwn(activationCatalogs, language) ? activationCatalogs[language as ActivationLanguage] : activationEnglish;
  const template = Object.hasOwn(selected, key) ? selected[key] : selected.Unavailable;
  return template.replace(/\{(name|date|version)\}/g, (placeholder, name: keyof ActivationVariables) => {
    if (!vars || !Object.hasOwn(vars, name)) return placeholder;
    const value = vars[name];
    return typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) ? String(value) : placeholder;
  });
}

const warningKeys = {
  BIRTH_DATE_MISSING: 'Birth date is missing. A staff follow-up reminder will be created; this warning does not by itself block activation.',
  CRM_IDENTITY_REVIEW_PENDING: 'An identity review is unresolved. A documented, separately authorized override does not resolve or merge these identities.',
  END_DATE_PASSED: 'The proposed membership end date has already passed.',
  EXISTING_INVOICE_NOT_EVALUATED: 'An existing invoice has not been evaluated. No payment or settlement is confirmed.',
  EXISTING_PAYMENT_SCHEDULE_NOT_EVALUATED: 'An existing payment schedule has not been evaluated or authorized.',
  FIXED_TERM_DIFFERS_FROM_PLAN: 'The proposed term differs from the published plan suggestion.',
  LEGACY_FREE_TEXT_PLAN: 'This membership uses a legacy free-text plan; no published catalog terms are implied.',
  OPEN_ENDED_PLAN_HAS_END_DATE: 'An end date has been entered for an open-ended plan.',
  START_DATE_BACKDATED: 'The proposed start date is in the past. A documented activation reason is required.',
  START_DATE_IN_FUTURE: 'The membership is scheduled to start in the future; confirmation does not make it currently in effect.',
} as const satisfies Record<MembershipActivationWarningCode, ActivationTextKey>;
const blockKeys = {
  CRM_DRAFT_CHANGED: 'The registered membership DRAFT changed. Recheck its current state through Resume setup.',
  END_DATE_BEFORE_START: 'The last valid membership day must not be before its start.', END_DATE_OUT_OF_RANGE: 'The end date is outside the backend-supported date window.',
  FIXED_TERM_END_DATE_REQUIRED: 'This fixed-term plan requires an end date.', MEMBERSHIP_NOT_DRAFT: 'This membership is no longer a DRAFT and cannot be activated again.',
  MINOR_GUARDIAN_OF_RECORD_REQUIRED: 'A known minor requires a verified guardian of record. Authorized staff must review the registration; this screen cannot repair or relink identities.',
  PLAN_BINDING_INVALID: 'The membership’s original published plan binding could not be verified.', PLAN_CURRENCY_MISMATCH: 'The bound plan and canonical billing-account currencies do not match.',
  START_DATE_OUT_OF_RANGE: 'The start date is outside the backend-supported date window.',
} as const satisfies Record<MembershipActivationBlockCode, ActivationTextKey>;
const requirementKeys = { AGREEMENT: 'Agreement and signature', PAYMENT: 'Tuition or other payment', RECURRING_PAYMENT_AUTHORIZATION: 'Recurring-payment authorization', FINANCIAL_RESPONSIBILITY: 'Financial responsibility', SCHOOL_ACTIVATION_POLICY: 'School activation policy' } as const satisfies Record<typeof MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED[number], ActivationTextKey>;
const sourceKeys = { GENERIC_LEGACY: 'Legacy membership', OWNER_LAUNCH: 'Owner Launch', CRM_ADULT_FREE_TEXT: 'Adult CRM · free-text plan', CRM_ADULT_PLAN: 'Adult CRM · published plan', CRM_GUARDIAN_CHILD_PLAN: 'Guardian/child CRM · published plan' } as const satisfies Record<MembershipActivationSource, ActivationTextKey>;
const reasonKeys = { ROUTINE_ENROLLMENT: 'Routine enrollment', DOCUMENTS_PENDING: 'Documents pending', PAPER_RECORDS_HELD_BY_SCHOOL: 'Paper records held by school', PAYMENT_HANDLED_OUTSIDE_HON: 'Payment handled outside HON (not verified here)', LEGACY_MEMBERSHIP: 'Legacy membership', SCHOLARSHIP_OR_COMP: 'Scholarship or complimentary membership', STAFF_FAMILY: 'Staff or family membership', OTHER: 'Other documented reason' } as const satisfies Record<MembershipActivationReasonCode, ActivationTextKey>;
const errorKeys = {
  ACTIVATION_PREVIEW_STALE: 'The reviewed facts changed. Review activation again and acknowledge the fresh preview before confirming.',
  ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED: 'This request requires the two-step activation interface. Reload the current application.',
  ACTIVATION_ACKNOWLEDGEMENT_REQUIRED: 'Acknowledge every warning in a fresh preview.',
  ACTIVATION_OVERRIDE_REQUIRED: 'This review requires an authorized identity override, a documented reason and secondary confirmation.',
  ACTIVATION_OVERRIDE_FORBIDDEN: 'Your current school permissions do not allow this override. Ask an appropriately authorized staff member to review.',
  ACTIVATION_BLOCKED: 'Activation is blocked. Review the server-provided blockers; no activation is assumed.',
  VERSION_CONFLICT: 'The membership version changed. Review the current membership again.',
  MEMBERSHIP_NOT_DRAFT: 'Only a current DRAFT can be activated. Review the current membership state.',
  IDEMPOTENCY_KEY_REUSED: 'The request key conflicts with another request. Verify current state before starting a new confirmation.',
  IDEMPOTENCY_IN_PROGRESS: 'The original request is still being processed. Retry only the exact retained request when ready.',
  DATE_SOURCE_MISMATCH: 'The date source changed. Request a new preview before confirming.',
  ACTIVATION_REASON_TEXT_REQUIRED: 'Provide the required activation reason, then review again.',
  ADULT_VERIFICATION_NOT_APPLICABLE: 'An adult attestation is only supported when the birth date is missing. Review again.',
  SCHOOL_TIMEZONE_INVALID: 'The school timezone is unavailable. An authorized administrator must correct it before activation.',
  VALIDATION_FAILED: 'Review the dates, required reasons and confirmations. The request was not accepted.',
  BILLING_MEMBERSHIP_NOT_FOUND: 'This membership is unavailable in the selected school.',
  MEMBERSHIP_ACTIVATION_FORBIDDEN: 'Current staff activation permission or school access is unavailable.',
} as const satisfies Record<string, ActivationTextKey>;

function coded(language: string, keys: Readonly<Record<string, ActivationTextKey>>, code: string): string {
  return activationText(language, Object.hasOwn(keys, code) ? keys[code]! : 'Unavailable');
}
export function activationWarning(language: string, code: MembershipActivationWarningCode): string { return coded(language, warningKeys, code); }
export function activationBlock(language: string, code: MembershipActivationBlockCode): string { return coded(language, blockKeys, code); }
export function activationRequirement(language: string, code: typeof MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED[number]): string { return coded(language, requirementKeys, code); }
export function activationSource(language: string, code: MembershipActivationSource): string { return coded(language, sourceKeys, code); }
export function activationReason(language: string, code: MembershipActivationReasonCode): string { return coded(language, reasonKeys, code); }
export function activationError(language: string, error: Readonly<{ status: number; code?: string; uncertain?: boolean }>): string {
  const key: ActivationTextKey = error.status === 401 ? 'Your session has expired. Sign in again before verifying access.'
    : error.code && Object.hasOwn(errorKeys, error.code) ? errorKeys[error.code as keyof typeof errorKeys]
    : error.status === 403 ? 'Your current school access, activation permission or billing entitlement is unavailable.'
    : error.uncertain ? 'The outcome is unknown. No activation is assumed. Retry only the exact retained request.'
    : 'The request was refused. Review current school access and membership facts before trying again.';
  return activationText(language, key);
}
