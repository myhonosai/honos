/** Contacts list wording (C1, 0521), en / ko / es. Labels only; nothing here is authority. */
const en = {
  // C4 (0623): sort and the added filters.
  sortLabel: 'Sort by', sortNAME: 'Name A–Z', sortENDS_SOONEST: 'Membership ending soonest', sortBELT_HIGH: 'Highest belt first', sortBELT_LOW: 'Lowest belt first',
  sortAGE_YOUNGEST: 'Youngest first', sortAGE_OLDEST: 'Oldest first', sortNEWEST: 'Newest added',
  membership: 'Membership', memHAS: 'Has a membership', memNONE: 'No membership', memACTIVE: 'Active', memPAUSED: 'Paused', memCANCELLING: 'Cancelling',
  noBelt: 'No belt yet', age: 'Age', ageBand: '{min} to {max}', ageAdults: '18 and over', ageCustom: 'Choose ages…', ageFrom: 'Age from', ageTo: 'Age to',
  endsBetween: 'Between dates…', endsFrom: 'Ends on or after', endsTo: 'Ends on or before', tag: 'Tag', rowAge: 'Age {n}',
  statePAUSED: 'Paused', stateCANCELLING: 'Cancelling', badRange: 'Check the range: the first value must not be after the second.',
  segmentsLabel: 'Show', ALL: 'All', STUDENT: 'Students', TRIAL: 'Trial', PROSPECT: 'Prospects', INACTIVE: 'Inactive', ARCHIVED: 'Archived', OTHER: 'Other contact',
  rowSTUDENT: 'Student', rowTRIAL: 'Trial booked', rowPROSPECT: 'Prospect', rowINACTIVE: 'Inactive', rowOTHER: 'Contact', rowARCHIVED: 'Archived',
  filters: 'Filters', filtersOn: 'Filters ({n})', belt: 'Belt', program: 'Program', plan: 'Membership plan', endsWithin: 'Membership ends',
  any: 'Any', days: 'Within {n} days', clear: 'Clear filters', filterHelp: 'Program, plan and end date look at the current membership. Age comes from the student birth date.',
  ends: 'Ends {date}', endsSoon: 'Ends {date}', ended: 'Ended {date}', noPlan: 'No plan on file',
  showMore: 'Show more', loadingMore: 'Reading more…', moreFailed: 'More contacts could not be loaded.', tryMore: 'Try again',
  shown: 'Showing {shown} of {total}', none: 'No one matches. Try another search or clear the filters.',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  sortLabel: '정렬', sortNAME: '이름순', sortENDS_SOONEST: '회원권 종료 임박순', sortBELT_HIGH: '높은 띠 먼저', sortBELT_LOW: '낮은 띠 먼저',
  sortAGE_YOUNGEST: '어린 순', sortAGE_OLDEST: '나이 많은 순', sortNEWEST: '최근 추가순',
  membership: '회원권', memHAS: '회원권 있음', memNONE: '회원권 없음', memACTIVE: '이용 중', memPAUSED: '일시 정지', memCANCELLING: '해지 예정',
  noBelt: '띠 없음', age: '나이', ageBand: '{min}~{max}세', ageAdults: '18세 이상', ageCustom: '나이 직접 선택…', ageFrom: '최소 나이', ageTo: '최대 나이',
  endsBetween: '날짜 범위…', endsFrom: '이 날짜 이후 종료', endsTo: '이 날짜 이전 종료', tag: '태그', rowAge: '{n}세',
  statePAUSED: '일시 정지', stateCANCELLING: '해지 예정', badRange: '범위를 확인하세요. 앞의 값이 뒤의 값보다 클 수 없습니다.',
  segmentsLabel: '보기', ALL: '전체', STUDENT: '학생', TRIAL: '체험', PROSPECT: '관심 고객', INACTIVE: '휴면', ARCHIVED: '보관됨', OTHER: '기타 연락처',
  rowSTUDENT: '학생', rowTRIAL: '체험 예약', rowPROSPECT: '관심 고객', rowINACTIVE: '휴면', rowOTHER: '연락처', rowARCHIVED: '보관됨',
  filters: '필터', filtersOn: '필터 ({n})', belt: '띠', program: '프로그램', plan: '회원권 플랜', endsWithin: '회원권 종료',
  any: '전체', days: '{n}일 이내', clear: '필터 지우기', filterHelp: '프로그램, 플랜, 종료일은 현재 회원권 기준입니다. 나이는 학생 생년월일로 계산합니다.',
  ends: '{date} 종료', endsSoon: '{date} 종료', ended: '{date} 종료됨', noPlan: '등록된 플랜 없음',
  showMore: '더 보기', loadingMore: '더 읽는 중…', moreFailed: '연락처를 더 불러오지 못했습니다.', tryMore: '다시 시도',
  shown: '{total}명 중 {shown}명 표시', none: '일치하는 사람이 없습니다. 다른 검색어를 쓰거나 필터를 지우세요.',
};
const es: Record<Key, string> = {
  sortLabel: 'Ordenar por', sortNAME: 'Nombre A–Z', sortENDS_SOONEST: 'Membresía que termina antes', sortBELT_HIGH: 'Cinturón más alto primero', sortBELT_LOW: 'Cinturón más bajo primero',
  sortAGE_YOUNGEST: 'Más jóvenes primero', sortAGE_OLDEST: 'Mayores primero', sortNEWEST: 'Añadidos recientemente',
  membership: 'Membresía', memHAS: 'Con membresía', memNONE: 'Sin membresía', memACTIVE: 'Activa', memPAUSED: 'En pausa', memCANCELLING: 'Por cancelar',
  noBelt: 'Sin cinturón aún', age: 'Edad', ageBand: '{min} a {max}', ageAdults: '18 o más', ageCustom: 'Elegir edades…', ageFrom: 'Edad desde', ageTo: 'Edad hasta',
  endsBetween: 'Entre fechas…', endsFrom: 'Termina el o después de', endsTo: 'Termina el o antes de', tag: 'Etiqueta', rowAge: '{n} años',
  statePAUSED: 'En pausa', stateCANCELLING: 'Por cancelar', badRange: 'Revise el rango: el primer valor no puede ser mayor que el segundo.',
  segmentsLabel: 'Mostrar', ALL: 'Todos', STUDENT: 'Alumnos', TRIAL: 'Prueba', PROSPECT: 'Interesados', INACTIVE: 'Inactivos', ARCHIVED: 'Archivados', OTHER: 'Otro contacto',
  rowSTUDENT: 'Alumno', rowTRIAL: 'Prueba reservada', rowPROSPECT: 'Interesado', rowINACTIVE: 'Inactivo', rowOTHER: 'Contacto', rowARCHIVED: 'Archivado',
  filters: 'Filtros', filtersOn: 'Filtros ({n})', belt: 'Cinturón', program: 'Programa', plan: 'Plan de membresía', endsWithin: 'La membresía termina',
  any: 'Cualquiera', days: 'En {n} días', clear: 'Quitar filtros', filterHelp: 'Programa, plan y fecha de fin miran la membresía actual. La edad sale de la fecha de nacimiento del alumno.',
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
