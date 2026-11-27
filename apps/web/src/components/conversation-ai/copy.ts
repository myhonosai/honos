import type { Language } from '@hon/design-system';
import type { ConversationAiChannel, ConversationAiItemKind, ConversationAiLanguage, ConversationAiMode, ConversationAiProgramStatus } from '@hon/contracts';

export type TrainAiCopy = {
  title: string; intro: string; noAiYet: string; chooseSchool: string; loading: string; hidden: string; show: string; refresh: string;
  deniedTitle: string; denied: string; sessionEnded: string; unavailable: string; unknownSave: string; readOnly: string;
  program: Record<ConversationAiProgramStatus, string>; programLabel: string;
  settingsTitle: string; enabled: string; enabledHint: string; modesTitle: string; channel: Record<ConversationAiChannel, string>; mode: Record<ConversationAiMode, string>;
  modeHint: string; handoff: string; handoffHint: string; afterHours: string; afterHoursHint: string; smsMax: string; chatMax: string; maxHint: string;
  languages: string; language: Record<ConversationAiLanguage, string>; saveSettings: string; settingsSaved: string; settingsInvalid: string;
  libraryTitle: string; libraryIntro: string; libraryEmpty: string; kind: Record<ConversationAiItemKind, string>; allKinds: string; count: (n: number, max: number) => string;
  active: string; paused: string; pause: string; resume: string; remove: string; removeConfirm: (title: string) => string; edit: string; cancel: string;
  paused_: string; resumed: string; removed: string; openFile: string; noFile: string;
  addTitle: string; editTitle: (title: string) => string; kindLabel: string; itemTitle: string; question: string; questionHint: string; answer: string;
  body: string; staffNote: string; staffNoteHint: string; summary: string; save: string; saved: string; itemInvalid: string;
  uploadTitle: string; uploadHint: string; chooseFile: string; upload: string; uploading: string; uploaded: (name: string) => string; fileTooBig: string; fileType: string;
  extracted: string; noText: string; addFromFile: string;
  knowledgeTitle: string; knowledgeIntro: string; showKnowledge: string; tone: string; instructions: string; faqs: string; documents: string; articles: string;
  plans: string; bookingTypes: string; nothing: string;
  hqTitle: string; hqIntro: string; hqStatus: string; hqSchools: (n: number) => string; hqChange: string; hqReason: string; hqReasonHint: string; hqSave: string;
  hqSaved: (status: string) => string; hqLiveWarning: string; hqHistory: string; hqNoHistory: string; hqDenied: string; hqUnknown: string;
  refusal: Record<string, string>;
};

const en: TrainAiCopy = {
  title: 'Train AI',
  intro: 'Teach the conversation AI how your school answers: questions and answers, your schedule and scripts, coaching cards and pictures. It only uses what is switched on here, plus your school’s approved facts, plans and booking types.',
  noAiYet: 'Nothing here calls an AI yet. AI drafts and automatic replies come in a later update and stay off until HQ turns the program on.',
  chooseSchool: 'Choose a school to train its conversation AI.', loading: 'Loading training…', hidden: 'Training is hidden.', show: 'Show training', refresh: 'Refresh',
  deniedTitle: 'Not available for your role', denied: 'You need the conversations permission at this school.', sessionEnded: 'Your session has ended. Sign in again.',
  unavailable: 'Training is unavailable right now. Try again in a moment.',
  unknownSave: 'We could not confirm the change. It may have been saved. Refresh before trying again; sending the same change again will not save it twice.',
  readOnly: 'Only the school owner can change the training.',
  program: { OFF: 'Off for every school (set by HQ)', TEST_MODE: 'Test mode (set by HQ): staff can try it, nothing goes to families', LIVE: 'Live (set by HQ)' }, programLabel: 'HON program',
  settingsTitle: 'Settings', enabled: 'Use the conversation AI at this school', enabledHint: 'Turning this on does not send anything by itself. Each channel below has its own mode.',
  modesTitle: 'Mode by channel', channel: { SMS: 'Text messages', WEB_CHAT: 'Website chat', EMAIL: 'Email' },
  mode: { OFF: 'Off', ASSIST: 'Assist (AI drafts, staff send)', AUTOMATIC: 'Automatic (AI replies)' },
  modeHint: 'Automatic replies only run once HQ allows it, and always stop for hand-off words.',
  handoff: 'Hand-off words', handoffHint: 'Comma-separated, lower case, up to 20. When a contact writes one, the AI stops and staff are told.',
  afterHours: 'After-hours text', afterHoursHint: 'Optional, up to 320 characters.', smsMax: 'Longest AI text', chatMax: 'Longest AI chat reply', maxHint: '160 to 1,600 characters',
  languages: 'Languages the AI may answer in', language: { en: 'English', ko: 'Korean', es: 'Spanish' }, saveSettings: 'Save settings', settingsSaved: 'Settings saved.',
  settingsInvalid: 'Check the hand-off words, lengths and languages.',
  libraryTitle: 'Training library', libraryIntro: 'Switch an item off to keep it without the AI using it.', libraryEmpty: 'Nothing here yet. Add a question and answer, or upload your schedule.',
  kind: { FAQ: 'Question and answer', DOCUMENT: 'Document', IMAGE: 'Picture', INSTRUCTION: 'Instruction', COACHING: 'Coaching card' }, allKinds: 'All',
  count: (n, max) => `${n} of ${max} items`,
  active: 'On', paused: 'Off', pause: 'Switch off', resume: 'Switch on', remove: 'Delete', removeConfirm: title => `Delete “${title}” from the training library?`, edit: 'Edit', cancel: 'Cancel',
  paused_: 'Switched off. The AI no longer uses it.', resumed: 'Switched on.', removed: 'Deleted.', openFile: 'Open original file', noFile: 'No file',
  addTitle: 'Add to the library', editTitle: title => `Edit “${title}”`, kindLabel: 'Type', itemTitle: 'Title', question: 'Question', questionHint: 'What a contact might ask.',
  answer: 'Answer', body: 'Text', staffNote: 'Coach’s note', staffNoteHint: 'Why this is the right answer. The AI follows it but never quotes it.', summary: 'Short summary (optional)',
  save: 'Save', saved: 'Saved.', itemInvalid: 'Fill in the title and text. Questions and coaching cards need a question.',
  uploadTitle: 'Upload a schedule, script or picture', uploadHint: 'Text, CSV, Markdown, PDF, Word, PNG, JPEG or WebP, up to 1 MB. Then add it to the library.',
  chooseFile: 'File', upload: 'Upload', uploading: 'Uploading…', uploaded: name => `Uploaded ${name}.`, fileTooBig: 'That file is larger than 1 MB.',
  fileType: 'That file type is not accepted.', extracted: 'Text found in the file', noText: 'No text could be read from this file. Describe it in the text box.', addFromFile: 'Add this file to the library',
  knowledgeTitle: 'What the AI knows', knowledgeIntro: 'Exactly what the AI will be given to answer from, built from your switched-on training and school records.',
  showKnowledge: 'Show what the AI knows', tone: 'Tone', instructions: 'Instructions', faqs: 'Questions and coaching', documents: 'Documents', articles: 'Approved articles',
  plans: 'Membership plans', bookingTypes: 'Booking types', nothing: 'None',
  hqTitle: 'Conversation AI program', hqIntro: 'One switch for every school. Off: no school can use the conversation AI. Test mode: staff can try it and nothing reaches families. Live: schools that turned it on can use it.',
  hqStatus: 'Now', hqSchools: n => (n === 1 ? '1 school has it turned on' : `${n} schools have it turned on`), hqChange: 'Change to', hqReason: 'Reason',
  hqReasonHint: '10 to 500 characters, kept in the history.', hqSave: 'Change program', hqSaved: status => `Program is now: ${status}.`,
  hqLiveWarning: 'Live lets the AI answer families for schools that switched automatic mode on. Only the HON owner should turn it live.',
  hqHistory: 'History', hqNoHistory: 'No changes yet.', hqDenied: 'Only HQ staff can see this, and only the HQ owner can change it.',
  hqUnknown: 'We could not confirm the change. Refresh to see the current state; sending the same change again will not apply it twice.',
  refusal: {
    VALIDATION_FAILED: 'That was not accepted as sent. Check the fields and try again.',
    CONVERSATION_VERSION_CONFLICT: 'This changed since you opened it. Refresh and try again.',
    IDEMPOTENCY_KEY_REUSED: 'That change conflicts with an earlier one. Refresh and try again.',
    CONVERSATION_AI_ITEM_NOT_FOUND: 'That item or file is no longer available.',
    CONVERSATION_AI_FILE_TYPE_MISMATCH: 'The file’s contents do not match its type.',
    CONVERSATION_AI_LIBRARY_FULL: 'The library holds 200 items. Delete one before adding another.',
    CONVERSATION_AI_SELECTORS_NOT_ACCEPTED: 'That request was not accepted.',
    INVALID_SAAS_INPUT: 'That was not accepted as sent.',
    SAAS_VERSION_CONFLICT: 'The program changed since you opened it. Refresh and try again.',
    CONVERSATION_AI_PROGRAM_UNCHANGED: 'The program is already set to that.',
    CONVERSATION_AI_TEST_INVALID: 'Type a question of up to 500 characters.',
    CONVERSATION_AI_TEST_BUSY: 'That’s a lot of tests in a few minutes. Wait a moment and try again.',
  },
};

const ko: TrainAiCopy = {
  title: 'AI 학습',
  intro: '대화 AI가 학원처럼 답하도록 가르쳐 주세요. 질문과 답변, 시간표와 스크립트, 코칭 카드, 사진을 넣을 수 있습니다. AI는 여기서 켜 둔 항목과 학원의 승인된 정보, 회원권, 예약 유형만 사용합니다.',
  noAiYet: '아직 여기서 AI를 호출하지 않습니다. AI 초안과 자동 답장은 이후 업데이트에서 제공되며 HQ가 프로그램을 켜기 전까지 꺼져 있습니다.',
  chooseSchool: '대화 AI를 학습시킬 학원을 선택하세요.', loading: '학습 내용을 불러오는 중…', hidden: '학습 내용이 숨겨져 있습니다.', show: '학습 내용 보기', refresh: '새로 고침',
  deniedTitle: '현재 역할로는 사용할 수 없습니다', denied: '이 학원의 대화 권한이 필요합니다.', sessionEnded: '세션이 종료되었습니다. 다시 로그인하세요.',
  unavailable: '지금은 학습 내용을 사용할 수 없습니다. 잠시 후 다시 시도하세요.',
  unknownSave: '변경을 확인하지 못했습니다. 저장되었을 수 있습니다. 다시 시도하기 전에 새로 고침하세요. 같은 변경을 다시 보내도 두 번 저장되지 않습니다.',
  readOnly: '학원 원장만 학습 내용을 변경할 수 있습니다.',
  program: { OFF: '모든 학원에서 꺼짐 (HQ 설정)', TEST_MODE: '테스트 모드 (HQ 설정): 직원만 사용해 볼 수 있으며 가족에게는 아무것도 전송되지 않습니다', LIVE: '운영 중 (HQ 설정)' }, programLabel: 'HON 프로그램',
  settingsTitle: '설정', enabled: '이 학원에서 대화 AI 사용', enabledHint: '켜도 자동으로 아무것도 보내지 않습니다. 아래 채널마다 모드가 따로 있습니다.',
  modesTitle: '채널별 모드', channel: { SMS: '문자 메시지', WEB_CHAT: '웹사이트 채팅', EMAIL: '이메일' },
  mode: { OFF: '꺼짐', ASSIST: '보조 (AI 초안, 직원 전송)', AUTOMATIC: '자동 (AI 답장)' },
  modeHint: '자동 답장은 HQ가 허용한 후에만 작동하며, 전달 단어가 나오면 항상 멈춥니다.',
  handoff: '직원 전달 단어', handoffHint: '쉼표로 구분, 소문자, 최대 20개. 연락처가 이 단어를 쓰면 AI가 멈추고 직원에게 알립니다.',
  afterHours: '업무 시간 외 안내 문자', afterHoursHint: '선택 사항, 최대 320자.', smsMax: 'AI 문자 최대 길이', chatMax: 'AI 채팅 답장 최대 길이', maxHint: '160~1,600자',
  languages: 'AI가 답할 수 있는 언어', language: { en: '영어', ko: '한국어', es: '스페인어' }, saveSettings: '설정 저장', settingsSaved: '설정을 저장했습니다.',
  settingsInvalid: '전달 단어, 길이, 언어를 확인하세요.',
  libraryTitle: '학습 자료실', libraryIntro: '항목을 끄면 보관은 되지만 AI는 사용하지 않습니다.', libraryEmpty: '아직 항목이 없습니다. 질문과 답변을 추가하거나 시간표를 올려 주세요.',
  kind: { FAQ: '질문과 답변', DOCUMENT: '문서', IMAGE: '사진', INSTRUCTION: '지침', COACHING: '코칭 카드' }, allKinds: '전체',
  count: (n, max) => `${max}개 중 ${n}개`,
  active: '켜짐', paused: '꺼짐', pause: '끄기', resume: '켜기', remove: '삭제', removeConfirm: title => `학습 자료실에서 “${title}”을(를) 삭제할까요?`, edit: '수정', cancel: '취소',
  paused_: '껐습니다. AI가 더 이상 사용하지 않습니다.', resumed: '켰습니다.', removed: '삭제했습니다.', openFile: '원본 파일 열기', noFile: '파일 없음',
  addTitle: '자료실에 추가', editTitle: title => `“${title}” 수정`, kindLabel: '유형', itemTitle: '제목', question: '질문', questionHint: '연락처가 물어볼 만한 내용.',
  answer: '답변', body: '내용', staffNote: '코치 메모', staffNoteHint: '이 답이 맞는 이유. AI는 따르지만 그대로 인용하지 않습니다.', summary: '짧은 요약 (선택)',
  save: '저장', saved: '저장했습니다.', itemInvalid: '제목과 내용을 입력하세요. 질문과 답변, 코칭 카드에는 질문이 필요합니다.',
  uploadTitle: '시간표, 스크립트 또는 사진 올리기', uploadHint: '텍스트, CSV, Markdown, PDF, Word, PNG, JPEG, WebP, 최대 1MB. 올린 뒤 자료실에 추가하세요.',
  chooseFile: '파일', upload: '올리기', uploading: '올리는 중…', uploaded: name => `${name}을(를) 올렸습니다.`, fileTooBig: '파일이 1MB보다 큽니다.',
  fileType: '허용되지 않는 파일 형식입니다.', extracted: '파일에서 찾은 텍스트', noText: '이 파일에서 텍스트를 읽지 못했습니다. 내용 칸에 설명해 주세요.', addFromFile: '이 파일을 자료실에 추가',
  knowledgeTitle: 'AI가 아는 내용', knowledgeIntro: '켜 둔 학습 자료와 학원 기록으로 만든, AI가 답할 때 받는 내용 그대로입니다.',
  showKnowledge: 'AI가 아는 내용 보기', tone: '말투', instructions: '지침', faqs: '질문과 코칭', documents: '문서', articles: '승인된 글',
  plans: '회원권', bookingTypes: '예약 유형', nothing: '없음',
  hqTitle: '대화 AI 프로그램', hqIntro: '모든 학원에 적용되는 하나의 스위치입니다. 꺼짐: 어떤 학원도 대화 AI를 사용할 수 없습니다. 테스트 모드: 직원만 사용해 볼 수 있고 가족에게는 전달되지 않습니다. 운영 중: 켜 둔 학원이 사용할 수 있습니다.',
  hqStatus: '현재', hqSchools: n => `${n}개 학원이 켜 두었습니다`, hqChange: '변경할 상태', hqReason: '사유',
  hqReasonHint: '10~500자, 기록에 남습니다.', hqSave: '프로그램 변경', hqSaved: status => `프로그램 상태: ${status}.`,
  hqLiveWarning: '운영 중으로 바꾸면 자동 모드를 켠 학원에서 AI가 가족에게 답합니다. HON 소유자만 운영 중으로 바꿔야 합니다.',
  hqHistory: '기록', hqNoHistory: '아직 변경 기록이 없습니다.', hqDenied: 'HQ 직원만 볼 수 있으며 HQ 소유자만 변경할 수 있습니다.',
  hqUnknown: '변경을 확인하지 못했습니다. 새로 고침하여 현재 상태를 확인하세요. 같은 변경을 다시 보내도 두 번 적용되지 않습니다.',
  refusal: {
    VALIDATION_FAILED: '보낸 내용이 받아들여지지 않았습니다. 항목을 확인하고 다시 시도하세요.',
    CONVERSATION_VERSION_CONFLICT: '연 뒤에 변경되었습니다. 새로 고침하고 다시 시도하세요.',
    IDEMPOTENCY_KEY_REUSED: '이전 변경과 충돌합니다. 새로 고침하고 다시 시도하세요.',
    CONVERSATION_AI_ITEM_NOT_FOUND: '해당 항목이나 파일을 더 이상 사용할 수 없습니다.',
    CONVERSATION_AI_FILE_TYPE_MISMATCH: '파일 내용이 파일 형식과 맞지 않습니다.',
    CONVERSATION_AI_LIBRARY_FULL: '자료실에는 200개까지 저장됩니다. 하나를 삭제한 뒤 추가하세요.',
    CONVERSATION_AI_SELECTORS_NOT_ACCEPTED: '요청이 받아들여지지 않았습니다.',
    INVALID_SAAS_INPUT: '보낸 내용이 받아들여지지 않았습니다.',
    SAAS_VERSION_CONFLICT: '연 뒤에 프로그램이 변경되었습니다. 새로 고침하고 다시 시도하세요.',
    CONVERSATION_AI_PROGRAM_UNCHANGED: '이미 그 상태입니다.',
    CONVERSATION_AI_TEST_INVALID: '500자 이내로 질문을 입력하세요.',
    CONVERSATION_AI_TEST_BUSY: '몇 분 사이에 시험을 많이 했습니다. 잠시 후 다시 해 보세요.',
  },
};

const es: TrainAiCopy = {
  title: 'Entrenar la IA',
  intro: 'Enseñe a la IA de conversaciones a responder como su escuela: preguntas y respuestas, su horario y guiones, tarjetas de coaching e imágenes. Solo usa lo que esté activado aquí, junto con los datos aprobados, planes y tipos de reserva de su escuela.',
  noAiYet: 'Aquí todavía no se llama a ninguna IA. Los borradores y las respuestas automáticas llegarán en una actualización posterior y seguirán apagados hasta que HQ active el programa.',
  chooseSchool: 'Elija una escuela para entrenar su IA de conversaciones.', loading: 'Cargando el entrenamiento…', hidden: 'El entrenamiento está oculto.', show: 'Mostrar entrenamiento', refresh: 'Actualizar',
  deniedTitle: 'No disponible para su rol', denied: 'Necesita el permiso de conversaciones en esta escuela.', sessionEnded: 'Su sesión terminó. Inicie sesión de nuevo.',
  unavailable: 'El entrenamiento no está disponible ahora. Inténtelo de nuevo en un momento.',
  unknownSave: 'No pudimos confirmar el cambio. Puede que se haya guardado. Actualice antes de intentarlo de nuevo; enviar el mismo cambio otra vez no lo guardará dos veces.',
  readOnly: 'Solo el dueño de la escuela puede cambiar el entrenamiento.',
  program: { OFF: 'Apagado para todas las escuelas (lo define HQ)', TEST_MODE: 'Modo de prueba (lo define HQ): el personal puede probarlo y nada llega a las familias', LIVE: 'Activo (lo define HQ)' }, programLabel: 'Programa HON',
  settingsTitle: 'Configuración', enabled: 'Usar la IA de conversaciones en esta escuela', enabledHint: 'Activarla no envía nada por sí sola. Cada canal tiene su propio modo.',
  modesTitle: 'Modo por canal', channel: { SMS: 'Mensajes de texto', WEB_CHAT: 'Chat del sitio web', EMAIL: 'Correo' },
  mode: { OFF: 'Apagado', ASSIST: 'Asistente (la IA redacta, el personal envía)', AUTOMATIC: 'Automático (la IA responde)' },
  modeHint: 'Las respuestas automáticas solo funcionan cuando HQ lo permite y siempre se detienen ante las palabras de traspaso.',
  handoff: 'Palabras de traspaso', handoffHint: 'Separadas por comas, en minúsculas, hasta 20. Si un contacto escribe una, la IA se detiene y avisa al personal.',
  afterHours: 'Texto fuera de horario', afterHoursHint: 'Opcional, hasta 320 caracteres.', smsMax: 'Texto de la IA más largo', chatMax: 'Respuesta de chat más larga', maxHint: 'De 160 a 1.600 caracteres',
  languages: 'Idiomas en que puede responder la IA', language: { en: 'Inglés', ko: 'Coreano', es: 'Español' }, saveSettings: 'Guardar configuración', settingsSaved: 'Configuración guardada.',
  settingsInvalid: 'Revise las palabras de traspaso, los largos y los idiomas.',
  libraryTitle: 'Biblioteca de entrenamiento', libraryIntro: 'Apague un elemento para conservarlo sin que la IA lo use.', libraryEmpty: 'Aún no hay nada. Agregue una pregunta y respuesta o suba su horario.',
  kind: { FAQ: 'Pregunta y respuesta', DOCUMENT: 'Documento', IMAGE: 'Imagen', INSTRUCTION: 'Instrucción', COACHING: 'Tarjeta de coaching' }, allKinds: 'Todos',
  count: (n, max) => `${n} de ${max} elementos`,
  active: 'Activado', paused: 'Apagado', pause: 'Apagar', resume: 'Activar', remove: 'Eliminar', removeConfirm: title => `¿Eliminar «${title}» de la biblioteca?`, edit: 'Editar', cancel: 'Cancelar',
  paused_: 'Apagado. La IA ya no lo usa.', resumed: 'Activado.', removed: 'Eliminado.', openFile: 'Abrir el archivo original', noFile: 'Sin archivo',
  addTitle: 'Agregar a la biblioteca', editTitle: title => `Editar «${title}»`, kindLabel: 'Tipo', itemTitle: 'Título', question: 'Pregunta', questionHint: 'Lo que un contacto podría preguntar.',
  answer: 'Respuesta', body: 'Texto', staffNote: 'Nota del coach', staffNoteHint: 'Por qué esta es la respuesta correcta. La IA la sigue pero nunca la cita.', summary: 'Resumen breve (opcional)',
  save: 'Guardar', saved: 'Guardado.', itemInvalid: 'Complete el título y el texto. Las preguntas y las tarjetas de coaching necesitan una pregunta.',
  uploadTitle: 'Subir un horario, guion o imagen', uploadHint: 'Texto, CSV, Markdown, PDF, Word, PNG, JPEG o WebP, hasta 1 MB. Luego agréguelo a la biblioteca.',
  chooseFile: 'Archivo', upload: 'Subir', uploading: 'Subiendo…', uploaded: name => `Se subió ${name}.`, fileTooBig: 'Ese archivo supera 1 MB.',
  fileType: 'Ese tipo de archivo no se acepta.', extracted: 'Texto encontrado en el archivo', noText: 'No se pudo leer texto de este archivo. Descríbalo en el cuadro de texto.', addFromFile: 'Agregar este archivo a la biblioteca',
  knowledgeTitle: 'Lo que sabe la IA', knowledgeIntro: 'Exactamente lo que recibirá la IA para responder, a partir de su entrenamiento activado y los registros de la escuela.',
  showKnowledge: 'Mostrar lo que sabe la IA', tone: 'Tono', instructions: 'Instrucciones', faqs: 'Preguntas y coaching', documents: 'Documentos', articles: 'Artículos aprobados',
  plans: 'Planes de membresía', bookingTypes: 'Tipos de reserva', nothing: 'Ninguno',
  hqTitle: 'Programa de IA de conversaciones', hqIntro: 'Un solo interruptor para todas las escuelas. Apagado: ninguna escuela puede usarla. Modo de prueba: el personal puede probarla y nada llega a las familias. Activo: las escuelas que la activaron pueden usarla.',
  hqStatus: 'Ahora', hqSchools: n => (n === 1 ? '1 escuela la tiene activada' : `${n} escuelas la tienen activada`), hqChange: 'Cambiar a', hqReason: 'Motivo',
  hqReasonHint: 'De 10 a 500 caracteres; queda en el historial.', hqSave: 'Cambiar programa', hqSaved: status => `El programa ahora está: ${status}.`,
  hqLiveWarning: 'Activo permite que la IA responda a las familias en las escuelas que activaron el modo automático. Solo el dueño de HON debe activarlo.',
  hqHistory: 'Historial', hqNoHistory: 'Aún no hay cambios.', hqDenied: 'Solo el personal de HQ puede verlo y solo el dueño de HQ puede cambiarlo.',
  hqUnknown: 'No pudimos confirmar el cambio. Actualice para ver el estado actual; enviar el mismo cambio otra vez no lo aplicará dos veces.',
  refusal: {
    VALIDATION_FAILED: 'No se aceptó tal como se envió. Revise los campos e inténtelo de nuevo.',
    CONVERSATION_VERSION_CONFLICT: 'Esto cambió desde que lo abrió. Actualice e inténtelo de nuevo.',
    IDEMPOTENCY_KEY_REUSED: 'Ese cambio choca con uno anterior. Actualice e inténtelo de nuevo.',
    CONVERSATION_AI_ITEM_NOT_FOUND: 'Ese elemento o archivo ya no está disponible.',
    CONVERSATION_AI_FILE_TYPE_MISMATCH: 'El contenido del archivo no coincide con su tipo.',
    CONVERSATION_AI_LIBRARY_FULL: 'La biblioteca admite 200 elementos. Elimine uno antes de agregar otro.',
    CONVERSATION_AI_SELECTORS_NOT_ACCEPTED: 'La solicitud no se aceptó.',
    INVALID_SAAS_INPUT: 'No se aceptó tal como se envió.',
    SAAS_VERSION_CONFLICT: 'El programa cambió desde que lo abrió. Actualice e inténtelo de nuevo.',
    CONVERSATION_AI_PROGRAM_UNCHANGED: 'El programa ya está así.',
    CONVERSATION_AI_TEST_INVALID: 'Escribe una pregunta de hasta 500 caracteres.',
    CONVERSATION_AI_TEST_BUSY: 'Son muchas pruebas en pocos minutos. Espera un momento e inténtalo de nuevo.',
  },
};

const copy: Record<Language, TrainAiCopy> = { en, ko, es };
export function trainAiCopy(language: Language): TrainAiCopy { return copy[language] ?? en; }
