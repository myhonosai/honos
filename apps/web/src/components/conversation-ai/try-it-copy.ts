import type { Language } from '@hon/design-system';
import type { ConversationAiTestReason, ConversationAiTestUnavailable } from '@hon/contracts';

/** CE2 "Try it" strings. */
export type TryItCopy = {
  title: string; intro: string; privacy: string; label: string; placeholder: string; ask: string; asking: string; samples: string;
  you: string; ai: string; needsStaff: string; empty: string; unavailable: Record<ConversationAiTestUnavailable, string>;
  reason: Record<ConversationAiTestReason, string>; working: string; better: string; betterLabel: string; betterSave: string; betterSaved: string; cancel: string;
  invalid: string; busy: string; refused: string; unknown: string; denied: string; readOnly: string; history: string;
};

const en: TryItCopy = {
  title: 'Try it', intro: 'Ask a question the way a parent would text it. See how the AI answers from what you taught it.',
  privacy: 'Only you see these tests. Nothing is sent to anyone. Each answer uses a little of your school’s AI allowance.',
  label: 'Your test question', placeholder: 'e.g. Hi! How much are classes for my 7 year old?', ask: 'Ask', asking: 'Thinking…', samples: 'Try one of these',
  you: 'You', ai: 'AI', needsStaff: 'Would hand off to staff', empty: 'No tests yet. Ask your first question above.',
  unavailable: { NOT_INCLUDED: 'Testing the AI is part of the Complete plan and needs AI permission for your role.', PAUSED: 'AI is paused for your school right now.',
    NOT_CONFIGURED: 'HON hasn’t connected the AI service yet. Your setup is saved and testing will open when it does.', BUDGET_REACHED: 'Your school has used its AI allowance for this month.' },
  reason: { BUDGET_REACHED: 'Your school has used its AI allowance for this month.', PAUSED: 'AI is paused for your school right now.',
    NOT_CONFIGURED: 'The AI service is not connected yet. Nothing was used.', OUTCOME_UNKNOWN: 'We couldn’t confirm this answer. It won’t be retried; HON reviews it.',
    NOT_ANSWERED: 'The AI didn’t give a usable answer. Try asking a different way.' },
  working: 'Still working on this one. Refresh in a moment.',
  better: 'Use a better answer', betterLabel: 'The answer it should give', betterSave: 'Save so the AI learns it', betterSaved: 'Saved. The AI will use this answer from now on.', cancel: 'Cancel',
  invalid: 'Type a question of up to 500 characters.', busy: 'That’s a lot of tests in a few minutes. Wait a moment and try again.',
  refused: 'The AI can’t be tested right now.', unknown: 'We couldn’t confirm the answer. Tap Ask again: the same question won’t be charged twice.',
  denied: 'You don’t have permission to test the AI at this school.', readOnly: 'Only the school owner can test the AI.', history: 'Your recent tests',
};

const ko: TryItCopy = {
  title: '시험해 보기', intro: '학부모가 문자 보내듯 질문해 보세요. 가르친 내용으로 AI가 어떻게 답하는지 볼 수 있습니다.',
  privacy: '이 시험은 본인에게만 보입니다. 아무에게도 보내지지 않습니다. 답변마다 학원의 AI 사용량이 조금 쓰입니다.',
  label: '시험 질문', placeholder: '예: 안녕하세요! 7살 아이 수업료가 얼마인가요?', ask: '질문하기', asking: '생각하는 중…', samples: '이 질문으로 해 보세요',
  you: '나', ai: 'AI', needsStaff: '직원에게 넘김', empty: '아직 시험이 없습니다. 위에서 첫 질문을 해 보세요.',
  unavailable: { NOT_INCLUDED: 'AI 시험은 Complete 플랜에 포함되며, 역할에 AI 권한이 필요합니다.', PAUSED: '지금 학원의 AI가 일시 중지되어 있습니다.',
    NOT_CONFIGURED: 'HON이 아직 AI 서비스를 연결하지 않았습니다. 설정은 저장되어 있고, 연결되면 시험할 수 있습니다.', BUDGET_REACHED: '이번 달 학원의 AI 사용량을 모두 썼습니다.' },
  reason: { BUDGET_REACHED: '이번 달 학원의 AI 사용량을 모두 썼습니다.', PAUSED: '지금 학원의 AI가 일시 중지되어 있습니다.',
    NOT_CONFIGURED: 'AI 서비스가 아직 연결되지 않았습니다. 사용량은 쓰이지 않았습니다.', OUTCOME_UNKNOWN: '이 답변을 확인하지 못했습니다. 다시 시도하지 않으며 HON이 검토합니다.',
    NOT_ANSWERED: 'AI가 쓸 수 있는 답을 주지 못했습니다. 다르게 물어보세요.' },
  working: '아직 처리 중입니다. 잠시 후 새로 고쳐 보세요.',
  better: '더 나은 답변 쓰기', betterLabel: 'AI가 해야 할 답변', betterSave: '저장해서 AI가 배우게 하기', betterSaved: '저장했습니다. 이제부터 AI가 이 답변을 씁니다.', cancel: '취소',
  invalid: '500자 이내로 질문을 입력하세요.', busy: '몇 분 사이에 시험을 많이 했습니다. 잠시 후 다시 해 보세요.',
  refused: '지금은 AI를 시험할 수 없습니다.', unknown: '답변을 확인하지 못했습니다. 다시 질문하기를 누르세요. 같은 질문은 두 번 청구되지 않습니다.',
  denied: '이 학원에서 AI를 시험할 권한이 없습니다.', readOnly: '학원 원장만 AI를 시험할 수 있습니다.', history: '최근 시험',
};

const es: TryItCopy = {
  title: 'Pruébala', intro: 'Haz una pregunta como la escribiría un padre. Mira cómo responde la IA con lo que le enseñaste.',
  privacy: 'Solo tú ves estas pruebas. No se envía nada a nadie. Cada respuesta usa un poco de la asignación de IA de tu escuela.',
  label: 'Tu pregunta de prueba', placeholder: 'p. ej. ¡Hola! ¿Cuánto cuestan las clases para mi hijo de 7 años?', ask: 'Preguntar', asking: 'Pensando…', samples: 'Prueba una de estas',
  you: 'Tú', ai: 'IA', needsStaff: 'Pasaría al personal', empty: 'Aún no hay pruebas. Haz tu primera pregunta arriba.',
  unavailable: { NOT_INCLUDED: 'Probar la IA es parte del plan Complete y requiere permiso de IA para tu rol.', PAUSED: 'La IA está en pausa para tu escuela en este momento.',
    NOT_CONFIGURED: 'HON aún no ha conectado el servicio de IA. Tu configuración está guardada y podrás probar cuando se conecte.', BUDGET_REACHED: 'Tu escuela ya usó su asignación de IA de este mes.' },
  reason: { BUDGET_REACHED: 'Tu escuela ya usó su asignación de IA de este mes.', PAUSED: 'La IA está en pausa para tu escuela en este momento.',
    NOT_CONFIGURED: 'El servicio de IA aún no está conectado. No se usó nada.', OUTCOME_UNKNOWN: 'No pudimos confirmar esta respuesta. No se reintenta; HON la revisa.',
    NOT_ANSWERED: 'La IA no dio una respuesta útil. Prueba a preguntarlo de otra forma.' },
  working: 'Todavía en proceso. Actualiza en un momento.',
  better: 'Usar una mejor respuesta', betterLabel: 'La respuesta que debería dar', betterSave: 'Guardar para que la IA la aprenda', betterSaved: 'Guardado. La IA usará esta respuesta desde ahora.', cancel: 'Cancelar',
  invalid: 'Escribe una pregunta de hasta 500 caracteres.', busy: 'Son muchas pruebas en pocos minutos. Espera un momento e inténtalo de nuevo.',
  refused: 'No se puede probar la IA en este momento.', unknown: 'No pudimos confirmar la respuesta. Toca Preguntar otra vez: la misma pregunta no se cobra dos veces.',
  denied: 'No tienes permiso para probar la IA en esta escuela.', readOnly: 'Solo el dueño de la escuela puede probar la IA.', history: 'Tus pruebas recientes',
};

const copies: Record<Language, TryItCopy> = { en, ko, es };
export function tryItCopy(language: Language): TryItCopy { return copies[language] ?? en; }
