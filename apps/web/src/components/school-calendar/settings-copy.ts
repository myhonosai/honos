/** Calendar settings and public shared calendar copy (0552). Every language has every key. */
const en = {
  settingsTitle: 'Calendar settings', settingsIntro: 'Closed days, links families can open or embed on your website, and QR codes.',
  sectionsLabel: 'Settings sections', secPrograms: 'Programs', secBlockOuts: 'Block-out dates', secShare: 'Share links', secQr: 'QR codes',
  loading: 'Loading settings…', denied: 'Your access at this school does not include calendar settings.', unavailable: 'Settings are not available right now. Try again.',
  retry: 'Try again',
  programsIntro: 'Programs group your classes. Each shared calendar shows one program, or several in a group.', programsNone: 'This school has no programs yet.',
  programsManage: 'Manage programs', upcoming: '{n} upcoming class times',
  contactTitle: 'Contact details on shared calendars', address: 'Address', phone: 'Phone', saveContact: 'Save contact details', contactSaved: 'Contact details saved.',
  blockIntro: 'Mark days the school is closed. Classes on those days are hidden from shared calendars. Nothing is cancelled for you.',
  blockNone: 'No block-out dates.', blockLabel: 'Reason', blockFirst: 'First day', blockLast: 'Last day', blockAdd: 'Add block-out',
  blockAdded: 'Block-out added.', blockRemove: 'Remove', blockRemoved: 'Block-out removed.', blockRange: '{first} to {last}', blockOneDay: '{first}',
  shareIntro: 'A link for one program, or a group of programs under one link. Families pick a calendar and see its class times.',
  shareNone: 'No shared calendars yet.', shareNew: 'New shared calendar', shareKind: 'Type', kindPROGRAM: 'One program', kindGROUP: 'Group of programs',
  shareName: 'Name', shareDescription: 'Description', shareProgram: 'Program', shareChooseProgram: 'Choose a program', shareAgeMin: 'Youngest age', shareAgeMax: 'Oldest age',
  shareMembers: 'Calendars in this group', shareMembersHelp: 'Choose at least two program calendars.', shareEnabled: 'On', shareSave: 'Save calendar',
  shareCancel: 'Cancel', shareEdit: 'Edit', shareDelete: 'Delete', shareDeleteAsk: 'Delete {name}? Its link stops working. This cannot be undone.',
  shareDeleteYes: 'Delete', shareDeleteNo: 'Keep it', shareSaved: '{name} saved.', shareDeleted: '{name} deleted.', shareOn: 'On', shareOff: 'Off',
  shareToggle: 'Show {name} to families', copyLink: 'Copy link', copyEmbed: 'Copy embed code', copied: 'Copied.', openLink: 'Open',
  ages: 'Ages {min} to {max}', agesFrom: 'Ages {min} and up', agesTo: 'Up to age {max}', groupOf: 'Group of {n}',
  qrIntro: 'Print a QR code so families can open a calendar from their phone.', qrNone: 'Make a shared calendar first.',
  qrLabel: 'QR code for {name}', qrDownload: 'Download SVG',
  errSESSION: 'Your session ended. Sign in again.', errDENIED: 'Your access does not allow this. Nothing changed.',
  errGONE: 'That item or program is no longer available. Nothing changed.', errCHANGED: 'This changed since you opened it. The latest is shown. Nothing changed.',
  errLIMIT: 'This school already has the most allowed. Remove one first.', errINVALID: 'Check the fields and try again. Nothing changed.',
  errRATE: 'Too many requests. Wait a moment and try again.', errUNKNOWN: 'We could not confirm this. Reload before trying again.',
  errLOCKED: 'This cannot be changed now.', errPAST: 'The last day has already passed.', saving: 'Saving…',
  pubLoading: 'Loading calendar…', pubNotFound: 'This calendar is not available.', pubUnavailable: 'The calendar could not be loaded. Try again soon.',
  pubChoose: 'Choose a calendar', pubTimes: 'Class times', pubNoTimes: 'No class times in the next four weeks.', pubSpots: '{n} spots left',
  pubFull: 'Full', pubUpcoming: '{n} upcoming class times', pubAddress: 'Address', pubPhone: 'Phone', pubCall: 'To book, call {phone}.', pubCallNoPhone: 'Contact the school to book.', pubBack: 'All calendars', pubTimesNote: 'Times are in the school\'s time zone ({zone}).',
};
export type SettingsKey = keyof typeof en;
const ko: Record<SettingsKey, string> = {
  settingsTitle: '캘린더 설정', settingsIntro: '휴무일, 가족이 열거나 웹사이트에 넣을 수 있는 링크, QR 코드.',
  sectionsLabel: '설정 메뉴', secPrograms: '프로그램', secBlockOuts: '휴무일', secShare: '공유 링크', secQr: 'QR 코드',
  loading: '설정을 불러오는 중…', denied: '이 학교에서의 권한에는 캘린더 설정이 포함되어 있지 않습니다.', unavailable: '지금은 설정을 사용할 수 없습니다. 다시 시도하세요.',
  retry: '다시 시도',
  programsIntro: '프로그램은 수업을 묶습니다. 공유 캘린더는 프로그램 하나 또는 여러 개를 그룹으로 보여 줍니다.', programsNone: '아직 프로그램이 없습니다.',
  programsManage: '프로그램 관리', upcoming: '예정 수업 {n}개',
  contactTitle: '공유 캘린더에 표시할 연락처', address: '주소', phone: '전화', saveContact: '연락처 저장', contactSaved: '연락처를 저장했습니다.',
  blockIntro: '학교가 쉬는 날을 표시하세요. 그날 수업은 공유 캘린더에서 숨겨집니다. 자동으로 취소되지는 않습니다.',
  blockNone: '휴무일이 없습니다.', blockLabel: '사유', blockFirst: '첫날', blockLast: '마지막 날', blockAdd: '휴무일 추가',
  blockAdded: '휴무일을 추가했습니다.', blockRemove: '삭제', blockRemoved: '휴무일을 삭제했습니다.', blockRange: '{first} ~ {last}', blockOneDay: '{first}',
  shareIntro: '프로그램 하나 또는 여러 프로그램을 묶은 링크입니다. 가족은 캘린더를 골라 수업 시간을 봅니다.',
  shareNone: '아직 공유 캘린더가 없습니다.', shareNew: '새 공유 캘린더', shareKind: '종류', kindPROGRAM: '프로그램 하나', kindGROUP: '프로그램 그룹',
  shareName: '이름', shareDescription: '설명', shareProgram: '프로그램', shareChooseProgram: '프로그램 선택', shareAgeMin: '최소 나이', shareAgeMax: '최대 나이',
  shareMembers: '그룹에 넣을 캘린더', shareMembersHelp: '프로그램 캘린더를 두 개 이상 고르세요.', shareEnabled: '켜기', shareSave: '캘린더 저장',
  shareCancel: '취소', shareEdit: '수정', shareDelete: '삭제', shareDeleteAsk: '{name}을(를) 삭제할까요? 링크가 더 이상 열리지 않으며 되돌릴 수 없습니다.',
  shareDeleteYes: '삭제', shareDeleteNo: '유지', shareSaved: '{name}을(를) 저장했습니다.', shareDeleted: '{name}을(를) 삭제했습니다.', shareOn: '켜짐', shareOff: '꺼짐',
  shareToggle: '{name}을(를) 가족에게 보이기', copyLink: '링크 복사', copyEmbed: '임베드 코드 복사', copied: '복사했습니다.', openLink: '열기',
  ages: '{min}~{max}세', agesFrom: '{min}세 이상', agesTo: '{max}세까지', groupOf: '{n}개 그룹',
  qrIntro: 'QR 코드를 인쇄하면 가족이 휴대폰으로 캘린더를 열 수 있습니다.', qrNone: '먼저 공유 캘린더를 만드세요.',
  qrLabel: '{name} QR 코드', qrDownload: 'SVG 다운로드',
  errSESSION: '세션이 끝났습니다. 다시 로그인하세요.', errDENIED: '권한이 없습니다. 변경된 것은 없습니다.',
  errGONE: '해당 항목이나 프로그램을 더 이상 사용할 수 없습니다. 변경된 것은 없습니다.', errCHANGED: '연 이후 변경되었습니다. 최신 내용을 표시합니다. 변경된 것은 없습니다.',
  errLIMIT: '허용된 최대 개수입니다. 먼저 하나를 삭제하세요.', errINVALID: '입력 내용을 확인하고 다시 시도하세요. 변경된 것은 없습니다.',
  errRATE: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', errUNKNOWN: '결과를 확인하지 못했습니다. 다시 불러온 뒤 시도하세요.',
  errLOCKED: '지금은 변경할 수 없습니다.', errPAST: '마지막 날이 이미 지났습니다.', saving: '저장 중…',
  pubLoading: '캘린더를 불러오는 중…', pubNotFound: '이 캘린더는 사용할 수 없습니다.', pubUnavailable: '캘린더를 불러오지 못했습니다. 잠시 후 다시 시도하세요.',
  pubChoose: '캘린더 선택', pubTimes: '수업 시간', pubNoTimes: '앞으로 4주 동안 수업이 없습니다.', pubSpots: '{n}자리 남음',
  pubFull: '마감', pubUpcoming: '예정된 수업 {n}개', pubAddress: '주소', pubPhone: '전화', pubCall: '예약하려면 {phone}로 전화하세요.', pubCallNoPhone: '예약하려면 학교에 연락하세요.', pubBack: '전체 캘린더', pubTimesNote: '시간은 학교 시간대({zone}) 기준입니다.',
};
const es: Record<SettingsKey, string> = {
  settingsTitle: 'Configuración del calendario', settingsIntro: 'Días cerrados, enlaces que las familias pueden abrir o insertar en su sitio web, y códigos QR.',
  sectionsLabel: 'Secciones de configuración', secPrograms: 'Programas', secBlockOuts: 'Días bloqueados', secShare: 'Enlaces para compartir', secQr: 'Códigos QR',
  loading: 'Cargando configuración…', denied: 'Su acceso en esta escuela no incluye la configuración del calendario.', unavailable: 'La configuración no está disponible ahora. Inténtelo de nuevo.',
  retry: 'Reintentar',
  programsIntro: 'Los programas agrupan sus clases. Cada calendario compartido muestra un programa o varios en un grupo.', programsNone: 'Esta escuela aún no tiene programas.',
  programsManage: 'Administrar programas', upcoming: '{n} horarios próximos',
  contactTitle: 'Datos de contacto en los calendarios compartidos', address: 'Dirección', phone: 'Teléfono', saveContact: 'Guardar contacto', contactSaved: 'Contacto guardado.',
  blockIntro: 'Marque los días en que la escuela cierra. Las clases de esos días no aparecen en los calendarios compartidos. No se cancela nada por usted.',
  blockNone: 'No hay días bloqueados.', blockLabel: 'Motivo', blockFirst: 'Primer día', blockLast: 'Último día', blockAdd: 'Añadir bloqueo',
  blockAdded: 'Bloqueo añadido.', blockRemove: 'Quitar', blockRemoved: 'Bloqueo quitado.', blockRange: '{first} a {last}', blockOneDay: '{first}',
  shareIntro: 'Un enlace para un programa o para un grupo de programas. Las familias eligen un calendario y ven sus horarios.',
  shareNone: 'Aún no hay calendarios compartidos.', shareNew: 'Nuevo calendario compartido', shareKind: 'Tipo', kindPROGRAM: 'Un programa', kindGROUP: 'Grupo de programas',
  shareName: 'Nombre', shareDescription: 'Descripción', shareProgram: 'Programa', shareChooseProgram: 'Elija un programa', shareAgeMin: 'Edad mínima', shareAgeMax: 'Edad máxima',
  shareMembers: 'Calendarios del grupo', shareMembersHelp: 'Elija al menos dos calendarios de programa.', shareEnabled: 'Activo', shareSave: 'Guardar calendario',
  shareCancel: 'Cancelar', shareEdit: 'Editar', shareDelete: 'Eliminar', shareDeleteAsk: '¿Eliminar {name}? Su enlace dejará de funcionar. No se puede deshacer.',
  shareDeleteYes: 'Eliminar', shareDeleteNo: 'Conservar', shareSaved: '{name} guardado.', shareDeleted: '{name} eliminado.', shareOn: 'Activo', shareOff: 'Inactivo',
  shareToggle: 'Mostrar {name} a las familias', copyLink: 'Copiar enlace', copyEmbed: 'Copiar código para insertar', copied: 'Copiado.', openLink: 'Abrir',
  ages: 'De {min} a {max} años', agesFrom: 'Desde {min} años', agesTo: 'Hasta {max} años', groupOf: 'Grupo de {n}',
  qrIntro: 'Imprima un código QR para que las familias abran un calendario desde el teléfono.', qrNone: 'Primero cree un calendario compartido.',
  qrLabel: 'Código QR de {name}', qrDownload: 'Descargar SVG',
  errSESSION: 'Su sesión terminó. Inicie sesión de nuevo.', errDENIED: 'Su acceso no lo permite. No cambió nada.',
  errGONE: 'Ese elemento o programa ya no está disponible. No cambió nada.', errCHANGED: 'Esto cambió desde que lo abrió. Se muestra lo último. No cambió nada.',
  errLIMIT: 'Esta escuela ya tiene el máximo permitido. Quite uno primero.', errINVALID: 'Revise los campos e inténtelo de nuevo. No cambió nada.',
  errRATE: 'Demasiadas solicitudes. Espere un momento.', errUNKNOWN: 'No pudimos confirmarlo. Recargue antes de intentarlo de nuevo.',
  errLOCKED: 'Esto no se puede cambiar ahora.', errPAST: 'El último día ya pasó.', saving: 'Guardando…',
  pubLoading: 'Cargando calendario…', pubNotFound: 'Este calendario no está disponible.', pubUnavailable: 'No se pudo cargar el calendario. Inténtelo pronto.',
  pubChoose: 'Elija un calendario', pubTimes: 'Horarios de clase', pubNoTimes: 'No hay clases en las próximas cuatro semanas.', pubSpots: 'Quedan {n} lugares',
  pubFull: 'Lleno', pubUpcoming: '{n} horarios próximos', pubAddress: 'Dirección', pubPhone: 'Teléfono', pubCall: 'Para reservar, llame al {phone}.', pubCallNoPhone: 'Contacte a la escuela para reservar.', pubBack: 'Todos los calendarios', pubTimesNote: 'Horarios en la zona horaria de la escuela ({zone}).',
};
export const SETTINGS_LANGUAGES = { en, ko, es } as const;
export function settingsText(language: string, key: SettingsKey, vars: Record<string, string | number> = {}): string {
  const text = (language === 'ko' ? ko : language === 'es' ? es : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}

/** "Ages 5 to 12", "Ages 16 and up", "Up to age 6", or nothing. */
export function agesText(t: (key: SettingsKey, vars?: Record<string, string | number>) => string, min: number | null, max: number | null): string {
  if (min !== null && max !== null) return t('ages', { min, max });
  if (min !== null) return t('agesFrom', { min });
  if (max !== null) return t('agesTo', { max });
  return '';
}
