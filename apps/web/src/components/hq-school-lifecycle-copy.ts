/** Copy for the HQ Schools toolbar, row menu and confirm dialogs (en / ko / es). */
const en = {
  search: 'Search schools', filter: 'Show', filterActive: 'Active and paused', filterPaused: 'Paused', filterArchived: 'Removed', filterAll: 'All',
  noMatches: 'No schools match.', actions: 'Actions for', open: 'Open', pause: 'Pause', resume: 'Resume', remove: 'Remove', restore: 'Restore',
  erasesOn: 'Erases on', cancel: 'Cancel', working: 'Working…',
  pauseTitle: 'Pause this school?', pauseBody: 'Staff, families and the AI team lose access until you resume it. Nothing is deleted.', pauseAck: 'I understand this school will be locked until I resume it.',
  resumeTitle: 'Resume this school?', resumeBody: 'Staff and families get their access back.',
  removeTitle: 'Remove this school?', removeBody: 'It is hidden and locked straight away. You can restore it for 30 days. After that its data is erased for good; billing and audit records are kept.',
  removeType: 'Type the school name to confirm', removeAck: 'I understand the data is erased after 30 days unless I restore it.',
  restoreTitle: 'Restore this school?', restoreBody: 'It comes back as active and the erase date is cancelled.',
  done: 'Done.', failSignedOut: 'Your session ended. Sign in again.', failForbidden: 'Only the HQ owner can do this.', failNameMismatch: 'That name does not match the school.',
  failChanged: 'This school changed since the list loaded. The list has been refreshed.', failBillingActive: 'This school has an active HON subscription. End its billing first.',
  failUnknown: 'We could not confirm the result. Try again; it will not be done twice.', failUnavailable: 'That did not work. Try again.',
};
type Copy = Record<keyof typeof en, string>;
const ko: Copy = {
  search: '도장 검색', filter: '보기', filterActive: '운영 중 및 일시 중지', filterPaused: '일시 중지', filterArchived: '삭제됨', filterAll: '전체',
  noMatches: '일치하는 도장이 없습니다.', actions: '작업:', open: '열기', pause: '일시 중지', resume: '재개', remove: '삭제', restore: '복원',
  erasesOn: '삭제 예정일', cancel: '취소', working: '처리 중…',
  pauseTitle: '이 도장을 일시 중지할까요?', pauseBody: '재개할 때까지 직원, 가족, AI 팀이 접근할 수 없습니다. 삭제되는 것은 없습니다.', pauseAck: '재개할 때까지 이 도장이 잠긴다는 것을 이해합니다.',
  resumeTitle: '이 도장을 재개할까요?', resumeBody: '직원과 가족이 다시 접근할 수 있습니다.',
  removeTitle: '이 도장을 삭제할까요?', removeBody: '즉시 숨겨지고 잠깁니다. 30일 동안 복원할 수 있습니다. 그 후 데이터는 영구 삭제되며, 청구 및 감사 기록은 보관됩니다.',
  removeType: '확인하려면 도장 이름을 입력하세요', removeAck: '복원하지 않으면 30일 후 데이터가 삭제된다는 것을 이해합니다.',
  restoreTitle: '이 도장을 복원할까요?', restoreBody: '운영 중 상태로 돌아오고 삭제 예정이 취소됩니다.',
  done: '완료했습니다.', failSignedOut: '세션이 종료되었습니다. 다시 로그인하세요.', failForbidden: 'HQ 소유자만 할 수 있습니다.', failNameMismatch: '도장 이름이 일치하지 않습니다.',
  failChanged: '목록을 불러온 후 도장이 변경되었습니다. 목록을 새로 고쳤습니다.', failBillingActive: '이 도장에는 활성 HON 구독이 있습니다. 먼저 청구를 종료하세요.',
  failUnknown: '결과를 확인할 수 없습니다. 다시 시도하세요. 두 번 실행되지 않습니다.', failUnavailable: '실패했습니다. 다시 시도하세요.',
};
const es: Copy = {
  search: 'Buscar escuelas', filter: 'Mostrar', filterActive: 'Activas y en pausa', filterPaused: 'En pausa', filterArchived: 'Eliminadas', filterAll: 'Todas',
  noMatches: 'Ninguna escuela coincide.', actions: 'Acciones para', open: 'Abrir', pause: 'Pausar', resume: 'Reanudar', remove: 'Eliminar', restore: 'Restaurar',
  erasesOn: 'Se borra el', cancel: 'Cancelar', working: 'Procesando…',
  pauseTitle: '¿Pausar esta escuela?', pauseBody: 'El personal, las familias y el equipo de IA pierden el acceso hasta que la reanudes. No se borra nada.', pauseAck: 'Entiendo que la escuela quedará bloqueada hasta que la reanude.',
  resumeTitle: '¿Reanudar esta escuela?', resumeBody: 'El personal y las familias recuperan el acceso.',
  removeTitle: '¿Eliminar esta escuela?', removeBody: 'Se oculta y bloquea de inmediato. Puedes restaurarla durante 30 días. Después sus datos se borran para siempre; los registros de facturación y auditoría se conservan.',
  removeType: 'Escribe el nombre de la escuela para confirmar', removeAck: 'Entiendo que los datos se borran a los 30 días si no la restauro.',
  restoreTitle: '¿Restaurar esta escuela?', restoreBody: 'Vuelve a estar activa y se cancela la fecha de borrado.',
  done: 'Hecho.', failSignedOut: 'Tu sesión terminó. Inicia sesión de nuevo.', failForbidden: 'Solo el propietario de HQ puede hacer esto.', failNameMismatch: 'El nombre no coincide con la escuela.',
  failChanged: 'La escuela cambió desde que se cargó la lista. La lista se actualizó.', failBillingActive: 'Esta escuela tiene una suscripción HON activa. Termina su facturación primero.',
  failUnknown: 'No pudimos confirmar el resultado. Inténtalo de nuevo; no se hará dos veces.', failUnavailable: 'No funcionó. Inténtalo de nuevo.',
};
export type HqSchoolLifecycleCopyKey = keyof typeof en;
export function hqSchoolLifecycleText(language: string, key: HqSchoolLifecycleCopyKey): string {
  return (language === 'ko' ? ko : language === 'es' ? es : en)[key];
}
