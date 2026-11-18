/** Contacts list wording (C1, 0513), en / ko / es. Labels only; nothing here is authority. */
const en = {
  segmentsLabel: 'Show', ALL: 'All', STUDENT: 'Students', TRIAL: 'Trial', PROSPECT: 'Prospects', INACTIVE: 'Inactive', ARCHIVED: 'Archived', OTHER: 'Other contact',
  rowSTUDENT: 'Student', rowTRIAL: 'Trial booked', rowPROSPECT: 'Prospect', rowINACTIVE: 'Inactive', rowOTHER: 'Contact', rowARCHIVED: 'Archived',
  filters: 'Filters', filtersOn: 'Filters ({n})', belt: 'Belt', program: 'Program', plan: 'Membership plan', endsWithin: 'Membership ends within',
  any: 'Any', days: '{n} days', clear: 'Clear filters', filterHelp: 'Belt, program, plan and end date look at current students only.',
  ends: 'Ends {date}', endsSoon: 'Ends {date}', ended: 'Ended {date}', noPlan: 'No plan on file',
  showMore: 'Show more', loadingMore: 'Reading more…', moreFailed: 'More contacts could not be loaded.', tryMore: 'Try again',
  shown: 'Showing {shown} of {total}', none: 'No one matches. Try another search or clear the filters.',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  segmentsLabel: '보기', ALL: '전체', STUDENT: '학생', TRIAL: '체험', PROSPECT: '관심 고객', INACTIVE: '휴면', ARCHIVED: '보관됨', OTHER: '기타 연락처',
  rowSTUDENT: '학생', rowTRIAL: '체험 예약', rowPROSPECT: '관심 고객', rowINACTIVE: '휴면', rowOTHER: '연락처', rowARCHIVED: '보관됨',
  filters: '필터', filtersOn: '필터 ({n})', belt: '띠', program: '프로그램', plan: '회원권 플랜', endsWithin: '회원권 종료까지',
  any: '전체', days: '{n}일 이내', clear: '필터 지우기', filterHelp: '띠, 프로그램, 플랜, 종료일은 현재 학생에게만 적용됩니다.',
  ends: '{date} 종료', endsSoon: '{date} 종료', ended: '{date} 종료됨', noPlan: '등록된 플랜 없음',
  showMore: '더 보기', loadingMore: '더 읽는 중…', moreFailed: '연락처를 더 불러오지 못했습니다.', tryMore: '다시 시도',
  shown: '{total}명 중 {shown}명 표시', none: '일치하는 사람이 없습니다. 다른 검색어를 쓰거나 필터를 지우세요.',
};
const es: Record<Key, string> = {
  segmentsLabel: 'Mostrar', ALL: 'Todos', STUDENT: 'Alumnos', TRIAL: 'Prueba', PROSPECT: 'Interesados', INACTIVE: 'Inactivos', ARCHIVED: 'Archivados', OTHER: 'Otro contacto',
  rowSTUDENT: 'Alumno', rowTRIAL: 'Prueba reservada', rowPROSPECT: 'Interesado', rowINACTIVE: 'Inactivo', rowOTHER: 'Contacto', rowARCHIVED: 'Archivado',
  filters: 'Filtros', filtersOn: 'Filtros ({n})', belt: 'Cinturón', program: 'Programa', plan: 'Plan de membresía', endsWithin: 'La membresía termina en',
  any: 'Cualquiera', days: '{n} días', clear: 'Quitar filtros', filterHelp: 'Cinturón, programa, plan y fecha de fin solo miran a los alumnos actuales.',
  ends: 'Termina el {date}', endsSoon: 'Termina el {date}', ended: 'Terminó el {date}', noPlan: 'Sin plan registrado',
  showMore: 'Ver más', loadingMore: 'Leyendo más…', moreFailed: 'No se pudieron cargar más contactos.', tryMore: 'Reintentar',
  shown: 'Se muestran {shown} de {total}', none: 'Nadie coincide. Pruebe otra búsqueda o quite los filtros.',
};
export type ContactsKey = Key;
export function contactsText(language: string, key: Key, vars: Readonly<Record<string, string | number>> = {}): string {
  const base = language.toLowerCase().split('-')[0];
  const text = (base === 'ko' ? ko : base === 'es' ? es : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}
export const CONTACTS_COPY = { en, ko, es } as const;
