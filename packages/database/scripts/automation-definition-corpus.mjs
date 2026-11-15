// Shared AU-1 (0367) corpus: every case is checked against BOTH validateAutomationDefinition (@hon/contracts) and
// hon.validate_automation_definition (PostgreSQL), which must agree. Synthetic ids only.
const U = '3f0b6a2e-5d1c-4e8f-9a7b-2c4d6e8f0a1b';
const smsFixed = (id, next, text = 'Hi {{first_name}}, thanks for your interest in {{school_name}}!') => ({ id, type: 'SEND_SMS', content: { mode: 'FIXED', text }, next });

/** "Whenever someone submits a free evaluation form, text them immediately, notify my staff, and if they don't book within 24 hours, send a follow-up." */
export const evaluationFollowUp = {
  schemaVersion: 1,
  trigger: { kind: 'FORM_LEAD_RECEIVED', config: { formId: null } },
  entry: { reentry: 'ONCE_PER_PERIOD', reentryDays: 30, conditions: [{ kind: 'HAS_CONSENT', negate: false, channel: 'SMS' }] },
  exitWhen: ['OPTED_OUT', 'LEAD_CLOSED'],
  steps: [
    smsFixed('welcome', 'tell_staff'),
    { id: 'tell_staff', type: 'NOTIFY_STAFF', to: 'SCHOOL_OWNERS', text: 'New evaluation request from {{first_name}}.', next: 'wait_booking' },
    { id: 'wait_booking', type: 'WAIT_FOR', event: 'TRIAL_BOOKED', timeoutMinutes: 1440, yes: null, no: 'follow_up' },
    { id: 'follow_up', type: 'SEND_SMS', content: { mode: 'AI', purpose: 'TRIAL_REMINDER', guidance: 'Friendly, short, offer two evaluation times.', fallbackText: 'Hi {{first_name}}, would you like to book your free evaluation? {{booking_link}}' }, next: null },
  ],
};

const base = () => JSON.parse(JSON.stringify(evaluationFollowUp));
const withStep = (patch) => { const d = base(); d.steps[0] = { ...d.steps[0], ...patch }; return d; };
const minimal = (steps, trigger = { kind: 'LEAD_CREATED', config: {} }) => ({ schemaVersion: 1, trigger, entry: { reentry: 'ONCE_EVER', reentryDays: null, conditions: [] }, exitWhen: [], steps });

export const validDefinitions = [
  ['evaluation follow-up', evaluationFollowUp],
  ['single stop', minimal([{ id: 's', type: 'STOP' }])],
  ['every step type', minimal([
    { id: 'a', type: 'SEND_EMAIL', content: { mode: 'FIXED', subject: 'Welcome to {{school_name}}', text: 'Hello {{first_name}},\n\nSee you on the mat.' }, next: 'b' },
    { id: 'b', type: 'SEND_EMAIL', content: { mode: 'AI', purpose: 'INTRODUCTION', guidance: '', fallbackSubject: 'Welcome', fallbackText: 'Hello!' }, next: 'c' },
    { id: 'c', type: 'CREATE_TASK', title: 'Call {{first_name}}', details: '', dueInHours: 24, assignTo: 'LEAD_ASSIGNEE', next: 'd' },
    { id: 'd', type: 'ASSIGN_LEAD', staffPrincipalId: U, next: 'e' },
    { id: 'e', type: 'ADD_TAG', tag: 'Evaluation lead', next: 'f' },
    { id: 'f', type: 'REMOVE_TAG', tag: 'cold', next: 'g' },
    { id: 'g', type: 'MOVE_STAGE', stageId: U, next: 'h' },
    { id: 'h', type: 'START_WORKFLOW', workflowId: U, next: 'i' },
    { id: 'i', type: 'WAIT', minutes: 60, localTime: null, next: 'j' },
    { id: 'j', type: 'WAIT', minutes: null, localTime: '09:30', next: 'k' },
    { id: 'k', type: 'IF', condition: { kind: 'ATTENDED_AT_LEAST', negate: true, count: 2, days: 14 }, yes: 'l', no: 'm' },
    { id: 'l', type: 'REQUEST_APPROVAL', question: 'Offer a make-up class?', yes: 'm', no: null },
    { id: 'm', type: 'STOP' },
  ])],
  ['schedule weekly audience', minimal([{ id: 's', type: 'STOP' }], { kind: 'SCHEDULE', config: { mode: 'WEEKLY', date: null, weekdays: [1, 3, 5], localTime: '16:00', audience: { groups: ['ACTIVE_STUDENTS'], tags: ['Demo team'], rankIds: [U] } } })],
  ['schedule once', minimal([{ id: 's', type: 'STOP' }], { kind: 'SCHEDULE', config: { mode: 'ONCE', date: '2026-12-24', weekdays: null, localTime: '10:00', audience: { groups: ['ALL_CONTACTS', 'PROSPECTS'], tags: [], rankIds: [] } } })],
  ['custom tool trigger', minimal([{ id: 's', type: 'STOP' }], { kind: 'CUSTOM_TOOL_RECORD', config: { toolKey: 'demo_team', change: 'CREATED' } })],
  ['absent days', minimal([{ id: 's', type: 'STOP' }], { kind: 'ABSENT_DAYS', config: { days: 14 } })],
  ['tag added', minimal([{ id: 's', type: 'STOP' }], { kind: 'TAG_ADDED', config: { tag: 'VIP' } })],
  ['all conditions', { ...minimal([{ id: 's', type: 'STOP' }]), entry: { reentry: 'EVERY_TIME', reentryDays: null, conditions: [
    { kind: 'LEAD_IS_OPEN', negate: false }, { kind: 'IS_ACTIVE_STUDENT', negate: true }, { kind: 'TRIAL_BOOKED', negate: true }, { kind: 'REPLIED', negate: false },
    { kind: 'LEAD_STAGE_IS', negate: false, stageId: U }, { kind: 'IN_PROGRAM', negate: false, programId: U }, { kind: 'MEMBERSHIP_ENDS_WITHIN', negate: false, days: 30 },
    { kind: 'HAS_TAG', negate: false, tag: 'a' }, { kind: 'CUSTOM_FIELD_EQUALS', negate: false, toolKey: 'demo_team', field: 'level', value: 'Gold' },
    { kind: 'HAS_CONSENT', negate: false, channel: 'EMAIL' }] } }],
];

const fifty = Array.from({ length: 51 }, (_, i) => ({ id: 's' + i, type: 'WAIT', minutes: 1, localTime: null, next: i < 50 ? 's' + (i + 1) : null }));
export const invalidDefinitions = [
  ['not an object', 'x'], ['null', null], ['array', []],
  ['schema version 2', { ...base(), schemaVersion: 2 }],
  ['extra top-level key', { ...base(), code: 'DROP TABLE' }],
  ['missing exitWhen', (() => { const d = base(); delete d.exitWhen; return d; })()],
  ['unknown trigger', { ...base(), trigger: { kind: 'WEBHOOK', config: {} } }],
  ['event trigger with config', { ...base(), trigger: { kind: 'LEAD_CREATED', config: { url: 'https://x' } } }],
  ['form id not uuid', { ...base(), trigger: { kind: 'FORM_LEAD_RECEIVED', config: { formId: 'abc' } } }],
  ['absent days too low', minimal([{ id: 's', type: 'STOP' }], { kind: 'ABSENT_DAYS', config: { days: 2 } })],
  ['schedule bad date', minimal([{ id: 's', type: 'STOP' }], { kind: 'SCHEDULE', config: { mode: 'ONCE', date: '2026-02-30', weekdays: null, localTime: '10:00', audience: { groups: ['TRIAL'], tags: [], rankIds: [] } } })],
  ['schedule bad time', minimal([{ id: 's', type: 'STOP' }], { kind: 'SCHEDULE', config: { mode: 'WEEKLY', date: null, weekdays: [1], localTime: '24:00', audience: { groups: ['TRIAL'], tags: [], rankIds: [] } } })],
  ['schedule duplicate weekday', minimal([{ id: 's', type: 'STOP' }], { kind: 'SCHEDULE', config: { mode: 'WEEKLY', date: null, weekdays: [1, 1], localTime: '10:00', audience: { groups: ['TRIAL'], tags: [], rankIds: [] } } })],
  ['schedule empty audience', minimal([{ id: 's', type: 'STOP' }], { kind: 'SCHEDULE', config: { mode: 'WEEKLY', date: null, weekdays: [1], localTime: '10:00', audience: { groups: [], tags: [], rankIds: [] } } })],
  ['custom tool bad key', minimal([{ id: 's', type: 'STOP' }], { kind: 'CUSTOM_TOOL_RECORD', config: { toolKey: 'Demo Team', change: 'CREATED' } })],
  ['reentry days without period', { ...base(), entry: { reentry: 'ONCE_EVER', reentryDays: 3, conditions: [] } }],
  ['period without days', { ...base(), entry: { reentry: 'ONCE_PER_PERIOD', reentryDays: null, conditions: [] } }],
  ['unknown condition', { ...base(), entry: { reentry: 'EVERY_TIME', reentryDays: null, conditions: [{ kind: 'SQL', negate: false, where: '1=1' }] } }],
  ['condition missing negate', { ...base(), entry: { reentry: 'EVERY_TIME', reentryDays: null, conditions: [{ kind: 'REPLIED' }] } }],
  ['eleven conditions', { ...base(), entry: { reentry: 'EVERY_TIME', reentryDays: null, conditions: Array.from({ length: 11 }, () => ({ kind: 'REPLIED', negate: false })) } }],
  ['duplicate exit', { ...base(), exitWhen: ['REPLIED', 'REPLIED'] }],
  ['unknown exit', { ...base(), exitWhen: ['PAID'] }],
  ['no steps', { ...base(), steps: [] }],
  ['fifty-one steps', minimal(fifty)],
  ['duplicate step id', { ...base(), steps: [smsFixed('a', 'a2'), smsFixed('a', null)] }],
  ['bad step id', withStep({ id: 'Welcome' })],
  ['unknown step type', withStep({ type: 'RUN_SQL' })],
  ['unknown merge field', withStep({ content: { mode: 'FIXED', text: 'Hi {{password}}' } })],
  ['stray braces', withStep({ content: { mode: 'FIXED', text: 'Hi {{ first_name }}' } })],
  ['sms too long', withStep({ content: { mode: 'FIXED', text: 'x'.repeat(1001) } })],
  ['padded text', withStep({ content: { mode: 'FIXED', text: ' hi' } })],
  ['control character', withStep({ content: { mode: 'FIXED', text: 'bell\u0007' } })],
  ['email without subject', minimal([{ id: 'a', type: 'SEND_EMAIL', content: { mode: 'FIXED', text: 'Hello' }, next: null }])],
  ['ai unknown purpose', withStep({ content: { mode: 'AI', purpose: 'DISCOUNT', guidance: '', fallbackText: 'x' } })],
  ['ai without fallback', withStep({ content: { mode: 'AI', purpose: 'CHECK_IN', guidance: '' } })],
  ['ai guidance with merge braces', withStep({ content: { mode: 'AI', purpose: 'CHECK_IN', guidance: 'use {{first_name}}', fallbackText: 'x' } })],
  ['content extra key', withStep({ content: { mode: 'FIXED', text: 'hi', to: '+15555550100' } })],
  ['link to unknown step', withStep({ next: 'nowhere' })],
  ['self link', withStep({ next: 'welcome' })],
  ['unreached step', { ...base(), steps: [...base().steps, { id: 'orphan', type: 'STOP' }] }],
  ['loop', minimal([{ id: 'a', type: 'WAIT', minutes: 5, localTime: null, next: 'b' }, { id: 'b', type: 'WAIT', minutes: 5, localTime: null, next: 'a' }])],
  ['first step linked to', minimal([{ id: 'a', type: 'WAIT', minutes: 5, localTime: null, next: 'b' }, { id: 'b', type: 'IF', condition: { kind: 'REPLIED', negate: false }, yes: 'a', no: null }])],
  ['wait both set', minimal([{ id: 'a', type: 'WAIT', minutes: 5, localTime: '09:00', next: null }])],
  ['wait neither set', minimal([{ id: 'a', type: 'WAIT', minutes: null, localTime: null, next: null }])],
  ['wait zero minutes', minimal([{ id: 'a', type: 'WAIT', minutes: 0, localTime: null, next: null }])],
  ['wait fractional', minimal([{ id: 'a', type: 'WAIT', minutes: 1.5, localTime: null, next: null }])],
  ['wait-for unknown event', minimal([{ id: 'a', type: 'WAIT_FOR', event: 'PAID', timeoutMinutes: 10, yes: null, no: null }])],
  ['if with next', minimal([{ id: 'a', type: 'IF', condition: { kind: 'REPLIED', negate: false }, next: null }])],
  ['stop with next', minimal([{ id: 'a', type: 'STOP', next: null }])],
  ['task bad assignee', minimal([{ id: 'a', type: 'CREATE_TASK', title: 'Call', details: '', dueInHours: 1, assignTo: 'EVERYONE', next: null }])],
  ['tag with punctuation', minimal([{ id: 'a', type: 'ADD_TAG', tag: 'vip!', next: null }])],
  ['tag too long', minimal([{ id: 'a', type: 'ADD_TAG', tag: 'x'.repeat(41), next: null }])],
  ['assign not uuid', minimal([{ id: 'a', type: 'ASSIGN_LEAD', staffPrincipalId: 'owner', next: null }])],
  ['next is number', minimal([{ id: 'a', type: 'STOP' }, { id: 'b', type: 'WAIT', minutes: 1, localTime: null, next: 1 }])],
];
