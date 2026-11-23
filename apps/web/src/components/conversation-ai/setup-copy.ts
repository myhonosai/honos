import type { Language } from '@hon/design-system';
import type { ConversationAiMode, ConversationAiProgramStatus } from '@hon/contracts';
import type { LengthKey, ModeSummary, QuickStartKey } from './setup-model';

/** CE1 easy-setup strings. Item form labels, refusals and channel names stay in copy.ts (0420). */
export type SetupCopy = {
  eyebrow: string; title: string; intro: string;
  now: Record<ModeSummary, string>; hq: Record<ConversationAiProgramStatus, string>;
  checklist: string; steps: { how: string; answers: (n: number) => string; handoff: string; tryIt: string }; tryItSoon: string; go: string;
  tabs: { how: string; knows: string; handoff: string }; tabsLabel: string;
  choice: Record<ConversationAiMode, { title: string; body: string }>; choiceLabel: string;
  perChannel: string; perChannelHide: string; mixed: string; languages: string; languagesHint: string;
  save: string; saving: string; unsaved: string; discard: string; readOnly: string;
  quickTitle: string; quickIntro: string; quickStart: Record<QuickStartKey, string>; quickDone: string; answerFor: (q: string) => string; answerPlaceholder: string; addAnswer: string;
  answersTitle: string; answersEmpty: string; addOwn: string; on: string; off: string; switchLabel: (title: string) => string;
  rulesTitle: string; rulesIntro: string; ruleExample: string; addRule: string; filesTitle: string; filesIntro: string;
  alsoReads: (plans: number, bookings: number, articles: number) => string; showAlso: string;
  handoffTitle: string; handoffIntro: string; addWord: string; wordPlaceholder: string; wordInvalid: string; remove: (word: string) => string; noWords: string;
  afterHoursTitle: string; afterHoursIntro: string; afterHoursExample: string; lengthTitle: string; lengthIntro: string; lengthTexts: string; lengthChat: string;
  preset: Record<LengthKey, string>; chars: (n: number) => string;
};

const en: SetupCopy = {
  eyebrow: 'AI', title: 'Conversation AI', intro: 'Your AI front desk answers texts, website chat and email the way your school would.',
  now: { OFF: 'The AI is off. Families only hear from your staff.', ASSIST: 'The AI writes suggested replies. Your staff check them and tap send.',
    AUTOMATIC: 'The AI replies for you and passes the conversation to staff when it should.', MIXED: 'The AI helps differently on each channel.' },
  hq: { OFF: 'HON hasn’t switched AI replies on for schools yet. You can set everything up now; it will be ready when it does.',
    TEST_MODE: 'Practice mode: AI replies are only shown to staff, never sent to families.', LIVE: 'AI replies are available for your school.' },
  checklist: 'Get set up', steps: { how: 'Choose how the AI helps', answers: n => `Add at least 5 answers (${n} so far)`, handoff: 'Check when it hands off to staff', tryIt: 'Try it with a question' },
  tryItSoon: 'Coming next', go: 'Go',
  tabs: { how: 'How it helps', knows: 'What it knows', handoff: 'When to hand off' }, tabsLabel: 'Conversation AI setup',
  choice: { OFF: { title: 'Off', body: 'No AI. Staff answer everything.' },
    ASSIST: { title: 'Suggest replies', body: 'The AI writes a reply. You check it and tap send. Best way to start.' },
    AUTOMATIC: { title: 'Reply for me', body: 'The AI answers by itself and hands the conversation to you when it should.' } },
  choiceLabel: 'How the AI helps', perChannel: 'Choose per channel', perChannelHide: 'Same for every channel', mixed: 'Each channel is set on its own below.',
  languages: 'Languages it can answer in', languagesHint: 'It replies in the language the family writes in, if it is on this list.',
  save: 'Save changes', saving: 'Saving…', unsaved: 'You have unsaved changes.', discard: 'Undo changes', readOnly: 'Only the school owner can change these settings. You can look around.',
  quickTitle: 'Quick start', quickIntro: 'Questions families ask martial arts schools most. Tap one and type your answer.',
  quickStart: { trial: 'Do you offer a free trial class?', price: 'How much are classes?', ages: 'What ages do you teach?', wear: 'What should I wear to the first class?',
    schedule: 'When are classes?', contract: 'Is there a contract?', adults: 'Do you have classes for adults?', belts: 'How does belt testing work?',
    makeup: 'Can I make up a missed class?', parking: 'Where do I park?' },
  quickDone: 'You have answered all the common questions. Add your own below.', answerFor: q => `Your answer to “${q}”`,
  answerPlaceholder: 'Write it the way you would text a parent.', addAnswer: 'Add answer',
  answersTitle: 'Your answers', answersEmpty: 'No answers yet. Start with the quick start above.', addOwn: 'Add your own question', on: 'On', off: 'Off',
  switchLabel: title => `Use “${title}”`,
  rulesTitle: 'Rules for the AI', rulesIntro: 'Short instructions it always follows.', ruleExample: 'For example: Always invite new families to a free trial class.', addRule: 'Add rule',
  filesTitle: 'Files', filesIntro: 'Upload your schedule, price sheet or scripts. The AI reads the text.',
  alsoReads: (p, b, a) => `It also reads these automatically: membership plans (${p}), booking types (${b}), school articles (${a}).`, showAlso: 'See exactly what it reads',
  handoffTitle: 'Hand-off words', handoffIntro: 'When a family writes one of these, the AI stops and your staff take over.', addWord: 'Add', wordPlaceholder: 'Add a word, e.g. injury',
  wordInvalid: 'Use letters, numbers, spaces or dashes, up to 20 words, no repeats.', remove: w => `Remove ${w}`, noWords: 'No hand-off words. The AI never stops by itself.',
  afterHoursTitle: 'After-hours reply', afterHoursIntro: 'Optional. Sent when someone writes while the school is closed.',
  afterHoursExample: 'Thanks for reaching out! We’re closed right now and will reply first thing tomorrow.',
  lengthTitle: 'Reply length', lengthIntro: 'Shorter replies feel more like a person texting.', lengthTexts: 'Texts', lengthChat: 'Website chat',
  preset: { short: 'Short', normal: 'Normal', long: 'Long' }, chars: n => `${n.toLocaleString('en-US')} characters`,
};

const ko: SetupCopy = {
  eyebrow: 'AI', title: '대화 AI', intro: 'AI 프런트 데스크가 문자, 웹사이트 채팅, 이메일에 학원처럼 답합니다.',
  now: { OFF: 'AI가 꺼져 있습니다. 가족에게는 직원만 답합니다.', ASSIST: 'AI가 답장을 제안합니다. 직원이 확인하고 보내기를 누릅니다.',
    AUTOMATIC: 'AI가 대신 답하고, 필요할 때 직원에게 대화를 넘깁니다.', MIXED: '채널마다 AI가 다르게 돕습니다.' },
  hq: { OFF: 'HON이 아직 학원용 AI 답장을 켜지 않았습니다. 지금 모두 설정해 두면 켜질 때 바로 준비됩니다.',
    TEST_MODE: '연습 모드: AI 답장은 직원에게만 보이고 가족에게는 보내지 않습니다.', LIVE: '학원에서 AI 답장을 사용할 수 있습니다.' },
  checklist: '설정하기', steps: { how: 'AI가 돕는 방식 선택', answers: n => `답변 5개 이상 추가 (현재 ${n}개)`, handoff: '직원에게 넘기는 때 확인', tryIt: '질문으로 시험해 보기' },
  tryItSoon: '곧 제공', go: '이동',
  tabs: { how: '돕는 방식', knows: 'AI가 아는 것', handoff: '직원에게 넘기기' }, tabsLabel: '대화 AI 설정',
  choice: { OFF: { title: '끄기', body: 'AI 없음. 직원이 모두 답합니다.' },
    ASSIST: { title: '답장 제안', body: 'AI가 답장을 쓰고, 직원이 확인한 뒤 보냅니다. 처음 시작하기에 가장 좋습니다.' },
    AUTOMATIC: { title: '대신 답하기', body: 'AI가 스스로 답하고 필요할 때 직원에게 대화를 넘깁니다.' } },
  choiceLabel: 'AI가 돕는 방식', perChannel: '채널별로 선택', perChannelHide: '모든 채널 동일', mixed: '아래에서 채널마다 따로 설정되어 있습니다.',
  languages: '답할 수 있는 언어', languagesHint: '가족이 쓴 언어가 이 목록에 있으면 그 언어로 답합니다.',
  save: '변경 저장', saving: '저장 중…', unsaved: '저장하지 않은 변경이 있습니다.', discard: '변경 취소', readOnly: '설정은 원장만 바꿀 수 있습니다. 둘러보실 수는 있습니다.',
  quickTitle: '빠른 시작', quickIntro: '무술 학원에 가족들이 가장 많이 묻는 질문입니다. 하나를 누르고 답만 쓰세요.',
  quickStart: { trial: '무료 체험 수업이 있나요?', price: '수업료는 얼마인가요?', ages: '몇 살부터 배울 수 있나요?', wear: '첫 수업에 무엇을 입어야 하나요?',
    schedule: '수업은 언제 있나요?', contract: '계약이 있나요?', adults: '성인 수업이 있나요?', belts: '승급 심사는 어떻게 하나요?',
    makeup: '빠진 수업을 보충할 수 있나요?', parking: '주차는 어디에 하나요?' },
  quickDone: '자주 묻는 질문에 모두 답했습니다. 아래에 직접 추가하세요.', answerFor: q => `“${q}”에 대한 답변`,
  answerPlaceholder: '학부모에게 문자 보내듯 써 주세요.', addAnswer: '답변 추가',
  answersTitle: '내 답변', answersEmpty: '아직 답변이 없습니다. 위의 빠른 시작부터 해 보세요.', addOwn: '직접 질문 추가', on: '켜짐', off: '꺼짐',
  switchLabel: title => `“${title}” 사용`,
  rulesTitle: 'AI 규칙', rulesIntro: 'AI가 항상 따르는 짧은 지시입니다.', ruleExample: '예: 새 가족에게는 항상 무료 체험 수업을 권하세요.', addRule: '규칙 추가',
  filesTitle: '파일', filesIntro: '시간표, 가격표, 스크립트를 올리세요. AI가 글을 읽습니다.',
  alsoReads: (p, b, a) => `자동으로 함께 읽는 것: 회원권 (${p}), 예약 유형 (${b}), 학원 글 (${a}).`, showAlso: 'AI가 읽는 내용 정확히 보기',
  handoffTitle: '넘기기 단어', handoffIntro: '가족이 이 단어를 쓰면 AI가 멈추고 직원이 이어받습니다.', addWord: '추가', wordPlaceholder: '단어 추가, 예: 부상',
  wordInvalid: '글자, 숫자, 공백, 대시만 쓸 수 있고 최대 20개, 중복은 안 됩니다.', remove: w => `${w} 삭제`, noWords: '넘기기 단어가 없습니다. AI가 스스로 멈추지 않습니다.',
  afterHoursTitle: '영업시간 외 답장', afterHoursIntro: '선택 사항. 학원이 닫혀 있을 때 연락이 오면 보냅니다.',
  afterHoursExample: '연락 주셔서 감사합니다! 지금은 문을 닫았고 내일 아침에 바로 답드리겠습니다.',
  lengthTitle: '답장 길이', lengthIntro: '짧은 답장이 사람이 보낸 문자처럼 느껴집니다.', lengthTexts: '문자', lengthChat: '웹사이트 채팅',
  preset: { short: '짧게', normal: '보통', long: '길게' }, chars: n => `${n.toLocaleString('ko-KR')}자`,
};

const es: SetupCopy = {
  eyebrow: 'IA', title: 'IA de conversaciones', intro: 'Tu recepción con IA responde mensajes de texto, chat del sitio web y correo como lo haría tu escuela.',
  now: { OFF: 'La IA está apagada. Las familias solo reciben respuestas de tu personal.', ASSIST: 'La IA escribe respuestas sugeridas. Tu personal las revisa y las envía.',
    AUTOMATIC: 'La IA responde por ti y pasa la conversación al personal cuando debe.', MIXED: 'La IA ayuda de forma distinta en cada canal.' },
  hq: { OFF: 'HON todavía no ha activado las respuestas de IA para las escuelas. Puedes dejar todo listo ahora; funcionará cuando se active.',
    TEST_MODE: 'Modo práctica: las respuestas de la IA solo las ve el personal, nunca se envían a las familias.', LIVE: 'Las respuestas de IA están disponibles para tu escuela.' },
  checklist: 'Configúralo', steps: { how: 'Elige cómo ayuda la IA', answers: n => `Agrega al menos 5 respuestas (${n} hasta ahora)`, handoff: 'Revisa cuándo pasa al personal', tryIt: 'Pruébala con una pregunta' },
  tryItSoon: 'Muy pronto', go: 'Ir',
  tabs: { how: 'Cómo ayuda', knows: 'Lo que sabe', handoff: 'Cuándo pasar al personal' }, tabsLabel: 'Configuración de la IA de conversaciones',
  choice: { OFF: { title: 'Apagada', body: 'Sin IA. El personal responde todo.' },
    ASSIST: { title: 'Sugerir respuestas', body: 'La IA escribe una respuesta. La revisas y la envías. La mejor forma de empezar.' },
    AUTOMATIC: { title: 'Responder por mí', body: 'La IA responde sola y te pasa la conversación cuando debe.' } },
  choiceLabel: 'Cómo ayuda la IA', perChannel: 'Elegir por canal', perChannelHide: 'Igual en todos los canales', mixed: 'Cada canal está configurado por separado abajo.',
  languages: 'Idiomas en los que puede responder', languagesHint: 'Responde en el idioma en que escribe la familia, si está en esta lista.',
  save: 'Guardar cambios', saving: 'Guardando…', unsaved: 'Tienes cambios sin guardar.', discard: 'Deshacer cambios', readOnly: 'Solo el dueño de la escuela puede cambiar esta configuración. Puedes mirar.',
  quickTitle: 'Inicio rápido', quickIntro: 'Las preguntas que más hacen las familias a una escuela de artes marciales. Toca una y escribe tu respuesta.',
  quickStart: { trial: '¿Ofrecen una clase de prueba gratis?', price: '¿Cuánto cuestan las clases?', ages: '¿Desde qué edad enseñan?', wear: '¿Qué me pongo para la primera clase?',
    schedule: '¿Cuándo son las clases?', contract: '¿Hay que firmar un contrato?', adults: '¿Tienen clases para adultos?', belts: '¿Cómo funcionan los exámenes de cinturón?',
    makeup: '¿Puedo recuperar una clase perdida?', parking: '¿Dónde me estaciono?' },
  quickDone: 'Ya respondiste todas las preguntas comunes. Agrega las tuyas abajo.', answerFor: q => `Tu respuesta a “${q}”`,
  answerPlaceholder: 'Escríbela como le enviarías un mensaje a un padre.', addAnswer: 'Agregar respuesta',
  answersTitle: 'Tus respuestas', answersEmpty: 'Todavía no hay respuestas. Empieza con el inicio rápido.', addOwn: 'Agregar tu propia pregunta', on: 'Sí', off: 'No',
  switchLabel: title => `Usar “${title}”`,
  rulesTitle: 'Reglas para la IA', rulesIntro: 'Instrucciones cortas que siempre sigue.', ruleExample: 'Por ejemplo: Invita siempre a las familias nuevas a una clase de prueba gratis.', addRule: 'Agregar regla',
  filesTitle: 'Archivos', filesIntro: 'Sube tu horario, lista de precios o guiones. La IA lee el texto.',
  alsoReads: (p, b, a) => `También lee esto automáticamente: planes de membresía (${p}), tipos de cita (${b}), artículos de la escuela (${a}).`, showAlso: 'Ver exactamente lo que lee',
  handoffTitle: 'Palabras para pasar al personal', handoffIntro: 'Si una familia escribe una de estas, la IA se detiene y tu personal continúa.', addWord: 'Agregar', wordPlaceholder: 'Agrega una palabra, p. ej. lesión',
  wordInvalid: 'Usa letras, números, espacios o guiones, hasta 20 palabras, sin repetir.', remove: w => `Quitar ${w}`, noWords: 'No hay palabras. La IA nunca se detiene sola.',
  afterHoursTitle: 'Respuesta fuera de horario', afterHoursIntro: 'Opcional. Se envía cuando alguien escribe con la escuela cerrada.',
  afterHoursExample: '¡Gracias por escribirnos! Ahora estamos cerrados y te responderemos mañana a primera hora.',
  lengthTitle: 'Largo de la respuesta', lengthIntro: 'Las respuestas cortas se sienten más como un mensaje de una persona.', lengthTexts: 'Mensajes de texto', lengthChat: 'Chat del sitio web',
  preset: { short: 'Corta', normal: 'Normal', long: 'Larga' }, chars: n => `${n.toLocaleString('es-US')} caracteres`,
};

const copies: Record<Language, SetupCopy> = { en, ko, es };
export function setupCopy(language: Language): SetupCopy { return copies[language] ?? en; }
