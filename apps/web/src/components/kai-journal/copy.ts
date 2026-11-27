import type { KaiJournalSuggestion } from '@hon/contracts';
import type { JournalErrorKind } from './http';

/** Kai teaching journal copy (en, ko, es). ko and es are typed against en, so a missing key fails `pnpm check`. */
export type JournalOutcomeKind = 'SAVING' | 'SAVED' | 'REMOVED' | JournalErrorKind;
export interface JournalCopy {
  pageTitle: string; intro: string; privacy: string; checking: string; hidden: string; chooseSchool: string; reading: string;
  denied: string; unavailable: string; refresh: string; tryAgain: string;
  formNew: string; formEdit: string; fieldDate: string; fieldClass: string; classPlaceholder: string; fieldNotes: string; notesPlaceholder: string;
  fieldTopics: string; topicPlaceholder: string; addTopic: string; removeTopic: (topic: string) => string; usedBefore: string;
  speak: string; stopSpeaking: string; listening: string; speechFailed: string;
  save: string; cancelEdit: string; remove: string; confirmRemove: string; keepEntry: string;
  problems: { date: string; className: string; notes: string; topics: string };
  askTitle: string; askLabel: string; askPlaceholder: string; ask: string; examples: readonly string[];
  recallHeading: (from: string, to: string) => string; recallCount: (n: number) => string; recallNone: string; recallGuess: string; recallTopics: string;
  patternsTitle: string; patternsNote: string; patternsNone: string; suggestion: (s: KaiJournalSuggestion, date: (d: string) => string) => string;
  recentTitle: string; recentEmpty: string; edit: string; spokenTag: string;
  shareLabel: string; shareNote: string; sharedTag: string;
  teamTitle: string; teamNote: string; teamEmpty: string; teamUnavailable: string; teamDenied: string;
  outcomes: Record<JournalOutcomeKind, string>;
}

const en: JournalCopy = {
  pageTitle: 'Teaching journal',
  intro: 'Tell Kai what you taught, by voice or by typing. Ask Kai what you worked on, and see a few notes from the patterns in your journal. Your journal is private: other staff, including owners, see only the entries you choose to share.',
  privacy: 'Write about skills and drills. Avoid student names and personal details.',
  checking: 'Checking your school…', hidden: 'Hidden while you were away.', chooseSchool: 'Choose a school first.', reading: 'Reading your journal…',
  denied: 'You can’t keep a teaching journal at this school. It needs HON Complete, and the owner can give your role “Keep their own Kai teaching journal” in Roles & permissions.',
  unavailable: 'Your journal could not be read right now. Refresh to try again.', refresh: 'Refresh', tryAgain: 'Try again',
  formNew: 'Tell Kai about today’s class', formEdit: 'Edit this entry', fieldDate: 'Date', fieldClass: 'Class (optional)', classPlaceholder: 'For example: Kids 6-8',
  fieldNotes: 'What did you teach?', notesPlaceholder: 'For example: Roundhouse kicks on pads, partner blocking drills, then a forms review.',
  fieldTopics: 'Topics (up to 10)', topicPlaceholder: 'Add a topic, like Blocking', addTopic: 'Add', removeTopic: (t) => `Remove topic ${t}`, usedBefore: 'Topics you used before:',
  speak: 'Speak', stopSpeaking: 'Stop', listening: 'Listening… speak now.', speechFailed: 'Voice input stopped. You can type instead.',
  save: 'Save to journal', cancelEdit: 'Cancel', remove: 'Remove entry', confirmRemove: 'Remove this entry for good? Its notes are erased.', keepEntry: 'Keep it',
  problems: { date: 'Pick a date from the last 400 days, up to today.', className: 'Keep the class name to one line of 80 characters.', notes: 'Write what you taught (up to 2,000 characters, no < or >).', topics: 'Use up to 10 different topics of 40 characters each.' },
  askTitle: 'Ask Kai about your journal', askLabel: 'Your question', askPlaceholder: 'What did we work on last week?', ask: 'Ask Kai',
  examples: ['What did we work on last week?', 'What did I teach yesterday?', 'This month', 'Last 30 days'],
  recallHeading: (from, to) => from === to ? `Your journal for ${from}` : `Your journal from ${from} to ${to}`,
  recallCount: (n) => n === 1 ? '1 class logged.' : `${n} classes logged.`, recallNone: 'Nothing logged for these days.',
  recallGuess: 'I didn’t catch a time, so here are the last 14 days.', recallTopics: 'Topics you covered:',
  patternsTitle: 'Kai’s pattern notes', patternsNote: 'From your last 90 days of entries, by simple rules (not AI).', patternsNone: 'Log a few classes with topics and Kai will point out patterns here.',
  suggestion: (s, date) => {
    switch (s.kind) {
      case 'FOCUS': return `${s.topic} came up in ${s.count} of your last ${s.total} classes. Students may be ready to build on it, or balance it with other skills.`;
      case 'REVISIT': return `Revisit ${s.topic}: you last worked on it ${s.daysAgo} days ago.`;
      case 'LOG': return `You haven’t logged a class since ${date(s.lastDate)}. Tell Kai about your next one.`;
      case 'TAG': return 'Add topics to your entries so Kai can spot patterns.';
    }
  },
  recentTitle: 'Your recent entries', recentEmpty: 'No entries yet. Tell Kai about your first class above.', edit: 'Edit', spokenTag: 'spoken',
  shareLabel: 'Share this entry with my school’s teaching team', shareNote: 'Shared entries are read-only for staff who keep a journal at this school. They see your name, not your email.', sharedTag: 'shared',
  teamTitle: 'Team journal', teamNote: 'Entries other instructors at this school shared in the last 30 days. Read-only.', teamEmpty: 'Nobody has shared an entry in the last 30 days.',
  teamUnavailable: 'The team journal could not be read right now.', teamDenied: 'The team journal is not available to you at this school.',
  outcomes: {
    SAVING: 'Saving…', SAVED: 'Saved to your journal.', REMOVED: 'Entry removed.', SESSION: 'Your session ended. Sign in again.',
    DENIED: 'You can’t change this journal. Nothing was saved.', CHANGED: 'This entry changed somewhere else. Nothing was saved. Open it again.',
    GONE: 'This entry is gone. Nothing was saved.', INVALID: 'That could not be saved as written. Nothing was saved.', RATE: 'Too many saves. Wait a moment and try again.',
    UNKNOWN: 'We couldn’t confirm the save. Try again sends the same request, so nothing is saved twice.',
  },
};

const ko: JournalCopy = {
  pageTitle: '수업 일지',
  intro: '오늘 가르친 내용을 Kai에게 말하거나 입력하세요. 무엇을 했는지 Kai에게 물어보고, 일지의 패턴에서 나온 몇 가지 메모를 확인하세요. 일지는 비공개이며, 소유자를 포함한 다른 직원은 내가 공유한 기록만 볼 수 있습니다.',
  privacy: '기술과 훈련 위주로 적어 주세요. 학생 이름과 개인 정보는 피해 주세요.',
  checking: '도장을 확인하는 중…', hidden: '자리를 비운 동안 숨겼습니다.', chooseSchool: '먼저 도장을 선택하세요.', reading: '일지를 읽는 중…',
  denied: '이 도장에서는 수업 일지를 쓸 수 없습니다. HON Complete가 필요하며, 소유자가 역할 및 권한에서 “본인 Kai 수업 일지 작성” 권한을 줄 수 있습니다.',
  unavailable: '지금은 일지를 읽을 수 없습니다. 새로고침해 다시 시도하세요.', refresh: '새로고침', tryAgain: '다시 시도',
  formNew: '오늘 수업을 Kai에게 알려 주세요', formEdit: '이 기록 수정', fieldDate: '날짜', fieldClass: '반 (선택)', classPlaceholder: '예: 어린이 6-8세',
  fieldNotes: '무엇을 가르쳤나요?', notesPlaceholder: '예: 미트 돌려차기, 짝 막기 훈련, 품새 복습.',
  fieldTopics: '주제 (최대 10개)', topicPlaceholder: '주제 추가, 예: 막기', addTopic: '추가', removeTopic: (t) => `주제 ${t} 삭제`, usedBefore: '전에 쓴 주제:',
  speak: '말하기', stopSpeaking: '멈추기', listening: '듣고 있어요… 말씀하세요.', speechFailed: '음성 입력이 멈췄습니다. 직접 입력해도 됩니다.',
  save: '일지에 저장', cancelEdit: '취소', remove: '기록 삭제', confirmRemove: '이 기록을 완전히 삭제할까요? 내용이 지워집니다.', keepEntry: '그대로 두기',
  problems: { date: '최근 400일 안에서 오늘까지의 날짜를 고르세요.', className: '반 이름은 80자 이내 한 줄로 적어 주세요.', notes: '가르친 내용을 적어 주세요 (2,000자 이내, < 또는 > 제외).', topics: '서로 다른 주제를 최대 10개, 각 40자 이내로 적어 주세요.' },
  askTitle: 'Kai에게 일지에 대해 물어보기', askLabel: '질문', askPlaceholder: '지난주에 무엇을 했지?', ask: 'Kai에게 묻기',
  examples: ['지난주에 무엇을 했지?', '어제 무엇을 가르쳤지?', '이번 달', '지난 30일'],
  recallHeading: (from, to) => from === to ? `${from} 일지` : `${from}부터 ${to}까지의 일지`,
  recallCount: (n) => `수업 ${n}개 기록.`, recallNone: '이 기간에는 기록이 없습니다.',
  recallGuess: '기간을 알아듣지 못해 최근 14일을 보여 드려요.', recallTopics: '다룬 주제:',
  patternsTitle: 'Kai의 패턴 메모', patternsNote: '최근 90일 기록에서 간단한 규칙으로 찾았습니다 (AI 아님).', patternsNone: '주제를 넣어 몇 개 수업을 기록하면 Kai가 여기에서 패턴을 알려 드려요.',
  suggestion: (s, date) => {
    switch (s.kind) {
      case 'FOCUS': return `최근 수업 ${s.total}개 중 ${s.count}개에서 ${s.topic}을(를) 다뤘어요. 다음 단계로 넘어가거나 다른 기술과 균형을 맞춰 보세요.`;
      case 'REVISIT': return `${s.topic} 복습: 마지막으로 다룬 지 ${s.daysAgo}일 됐어요.`;
      case 'LOG': return `${date(s.lastDate)} 이후 기록한 수업이 없어요. 다음 수업을 Kai에게 알려 주세요.`;
      case 'TAG': return '기록에 주제를 넣으면 Kai가 패턴을 찾을 수 있어요.';
    }
  },
  recentTitle: '최근 기록', recentEmpty: '아직 기록이 없습니다. 위에서 첫 수업을 알려 주세요.', edit: '수정', spokenTag: '음성',
  shareLabel: '이 기록을 우리 도장 지도팀과 공유', shareNote: '공유한 기록은 이 도장에서 일지를 쓰는 직원이 읽기만 할 수 있습니다. 이메일이 아닌 이름이 표시됩니다.', sharedTag: '공유됨',
  teamTitle: '팀 일지', teamNote: '최근 30일 동안 이 도장의 다른 사범이 공유한 기록입니다. 읽기 전용입니다.', teamEmpty: '최근 30일 동안 공유된 기록이 없습니다.',
  teamUnavailable: '지금은 팀 일지를 읽을 수 없습니다.', teamDenied: '이 도장에서는 팀 일지를 볼 수 없습니다.',
  outcomes: {
    SAVING: '저장하는 중…', SAVED: '일지에 저장했습니다.', REMOVED: '기록을 삭제했습니다.', SESSION: '세션이 끝났습니다. 다시 로그인하세요.',
    DENIED: '이 일지를 바꿀 수 없습니다. 저장되지 않았습니다.', CHANGED: '다른 곳에서 이 기록이 바뀌었습니다. 저장되지 않았습니다. 다시 여세요.',
    GONE: '이 기록은 없습니다. 저장되지 않았습니다.', INVALID: '입력한 대로 저장할 수 없습니다. 저장되지 않았습니다.', RATE: '저장이 너무 많습니다. 잠시 후 다시 시도하세요.',
    UNKNOWN: '저장을 확인하지 못했습니다. 다시 시도하면 같은 요청을 보내므로 두 번 저장되지 않습니다.',
  },
};

const es: JournalCopy = {
  pageTitle: 'Diario de clases',
  intro: 'Cuéntale a Kai lo que enseñaste, hablando o escribiendo. Pregúntale a Kai en qué trabajaste y mira algunas notas de los patrones de tu diario. Tu diario es privado: el resto del personal, incluidos los propietarios, solo ve las entradas que decidas compartir.',
  privacy: 'Escribe sobre técnicas y ejercicios. Evita nombres de alumnos y datos personales.',
  checking: 'Comprobando tu escuela…', hidden: 'Oculto mientras no estabas.', chooseSchool: 'Primero elige una escuela.', reading: 'Leyendo tu diario…',
  denied: 'No puedes llevar un diario de clases en esta escuela. Necesita HON Complete, y el propietario puede dar a tu rol “Llevar su propio diario de clases de Kai” en Roles y permisos.',
  unavailable: 'No se pudo leer tu diario ahora. Actualiza para intentarlo de nuevo.', refresh: 'Actualizar', tryAgain: 'Intentar de nuevo',
  formNew: 'Cuéntale a Kai la clase de hoy', formEdit: 'Editar esta entrada', fieldDate: 'Fecha', fieldClass: 'Clase (opcional)', classPlaceholder: 'Por ejemplo: Niños 6-8',
  fieldNotes: '¿Qué enseñaste?', notesPlaceholder: 'Por ejemplo: patadas circulares con paos, bloqueos en pareja y repaso de formas.',
  fieldTopics: 'Temas (hasta 10)', topicPlaceholder: 'Añade un tema, como Bloqueos', addTopic: 'Añadir', removeTopic: (t) => `Quitar el tema ${t}`, usedBefore: 'Temas que usaste antes:',
  speak: 'Hablar', stopSpeaking: 'Parar', listening: 'Escuchando… habla ahora.', speechFailed: 'La entrada de voz se detuvo. Puedes escribir.',
  save: 'Guardar en el diario', cancelEdit: 'Cancelar', remove: 'Quitar entrada', confirmRemove: '¿Quitar esta entrada para siempre? Sus notas se borran.', keepEntry: 'Conservarla',
  problems: { date: 'Elige una fecha de los últimos 400 días, hasta hoy.', className: 'El nombre de la clase debe ser una línea de 80 caracteres.', notes: 'Escribe lo que enseñaste (hasta 2.000 caracteres, sin < ni >).', topics: 'Usa hasta 10 temas distintos de 40 caracteres cada uno.' },
  askTitle: 'Pregúntale a Kai por tu diario', askLabel: 'Tu pregunta', askPlaceholder: '¿En qué trabajamos la semana pasada?', ask: 'Preguntar a Kai',
  examples: ['¿En qué trabajamos la semana pasada?', '¿Qué enseñé ayer?', 'Este mes', 'Últimos 30 días'],
  recallHeading: (from, to) => from === to ? `Tu diario del ${from}` : `Tu diario del ${from} al ${to}`,
  recallCount: (n) => n === 1 ? '1 clase registrada.' : `${n} clases registradas.`, recallNone: 'No hay nada registrado en estos días.',
  recallGuess: 'No entendí el periodo, así que aquí tienes los últimos 14 días.', recallTopics: 'Temas que cubriste:',
  patternsTitle: 'Notas de patrones de Kai', patternsNote: 'De tus entradas de los últimos 90 días, con reglas simples (no es IA).', patternsNone: 'Registra algunas clases con temas y Kai te mostrará patrones aquí.',
  suggestion: (s, date) => {
    switch (s.kind) {
      case 'FOCUS': return `${s.topic} apareció en ${s.count} de tus últimas ${s.total} clases. Los alumnos quizá estén listos para avanzar, o para equilibrarlo con otras técnicas.`;
      case 'REVISIT': return `Repasa ${s.topic}: lo trabajaste por última vez hace ${s.daysAgo} días.`;
      case 'LOG': return `No has registrado una clase desde el ${date(s.lastDate)}. Cuéntale a Kai la próxima.`;
      case 'TAG': return 'Añade temas a tus entradas para que Kai encuentre patrones.';
    }
  },
  recentTitle: 'Tus entradas recientes', recentEmpty: 'Aún no hay entradas. Cuéntale a Kai tu primera clase arriba.', edit: 'Editar', spokenTag: 'por voz',
  shareLabel: 'Compartir esta entrada con el equipo de instructores de mi escuela', shareNote: 'Las entradas compartidas son de solo lectura para el personal que lleva un diario en esta escuela. Ven tu nombre, no tu correo.', sharedTag: 'compartida',
  teamTitle: 'Diario del equipo', teamNote: 'Entradas que otros instructores de esta escuela compartieron en los últimos 30 días. Solo lectura.', teamEmpty: 'Nadie ha compartido una entrada en los últimos 30 días.',
  teamUnavailable: 'No se pudo leer el diario del equipo ahora.', teamDenied: 'El diario del equipo no está disponible para ti en esta escuela.',
  outcomes: {
    SAVING: 'Guardando…', SAVED: 'Guardado en tu diario.', REMOVED: 'Entrada quitada.', SESSION: 'Tu sesión terminó. Vuelve a iniciar sesión.',
    DENIED: 'No puedes cambiar este diario. No se guardó nada.', CHANGED: 'Esta entrada cambió en otro lugar. No se guardó nada. Ábrela de nuevo.',
    GONE: 'Esta entrada ya no existe. No se guardó nada.', INVALID: 'No se pudo guardar tal como está escrito. No se guardó nada.', RATE: 'Demasiados guardados. Espera un momento y vuelve a intentarlo.',
    UNKNOWN: 'No pudimos confirmar el guardado. Intentar de nuevo envía la misma solicitud, así que nada se guarda dos veces.',
  },
};

export const JOURNAL_COPY: Readonly<Record<'en' | 'ko' | 'es', JournalCopy>> = { en, ko, es };
export function journalCopy(language: string | null | undefined): JournalCopy {
  const base = (language ?? '').toLowerCase().slice(0, 2);
  return base === 'ko' ? ko : base === 'es' ? es : en;
}
/** A school-local date shown in the page language (the date itself is never shifted by a time zone). */
export function journalDate(value: string, language: string | null | undefined): string {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const tag = (language ?? '').toLowerCase().startsWith('ko') ? 'ko-KR' : (language ?? '').toLowerCase().startsWith('es') ? 'es-US' : 'en-US';
  return new Intl.DateTimeFormat(tag, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}
