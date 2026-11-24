import { verifyParentJourneyView } from '@hon/contracts/parent-journey-view';
import { answer, childrenFor, classify, resolve } from '../src/eian/eian-engine';
import { createSampleApi } from '../src/sample/sample-api';
import { journeyBody, NOW } from './fixtures';

const journey = verifyParentJourneyView(journeyBody());
const base = { journey, timeZone: 'America/Los_Angeles', now: new Date(NOW) };

describe('Eian guided answers', () => {
  it.each([
    ["When is the next class?", 'next-class'], ["What's on this week?", 'schedule'], ['What does she need for her next belt?', 'belt'],
    ['When is the next belt test?', 'testing'], ['Do we have any unpaid invoices?', 'billing'], ['What did the school say?', 'messages'],
    ['My son is sick tomorrow', 'absence'], ['Book a class for Leo', 'book'], ['Tell me a joke', 'help'],
  ])('%s -> %s', (q, intent) => expect(classify(q)).toBe(intent));

  it('next class comes from the verified schedule, in the school time zone, with its real status', () => {
    const a = answer('When is the next class?', base);
    expect(a.lines[0]).toBe("Test Child B's next class is Juniors on Wed, Nov 18, 2:00 PM. Status: Booked.");
    expect(a.source).toBe('Your class schedule');
  });

  it('a named child narrows the answer', async () => {
    const sample = await createSampleApi(() => new Date(NOW)).journey();
    if (!sample.ok) throw new Error('sample journey');
    expect(childrenFor('when is leo next class', sample.data)).toEqual([1]);
    expect(childrenFor('when is the next class', sample.data)).toEqual([0, 1]);
    expect(answer('What does Mia need for her next belt?', { ...base, journey: sample.data }).lines).toHaveLength(1);
  });

  it('belt answers list what is still to do from the progress record', () => {
    const lines = answer('What does she need for her next belt?', base).lines;
    expect(lines[0]).toBe('Test Child A, Little Dragons (Yellow Belt): 1 of 3 requirements met. Still to do: Form 1.');
    expect(lines[1]).toBe('Test Child B, Juniors: requirements are not shared right now.');
  });

  it('says plainly when a record cannot be read, and never claims to pay or book', () => {
    expect(answer('any invoices?', { ...base, billing: null }).lines).toEqual(["I can't see billing records right now."]);
    const absence = answer('She is sick tomorrow', base);
    expect(absence.action).toEqual({ label: 'Report an absence', tab: 'Schedule' });
    expect(absence.lines.join(' ')).toMatch(/nothing is sent until you tap Send/);
  });

  it('billing lists only open invoices and says payments happen with the school', async () => {
    const billing = await createSampleApi(() => new Date(NOW)).billing();
    if (!billing.ok) throw new Error('sample billing should verify');
    const a = answer('Do we have any open invoices?', { ...base, billing: billing.data });
    expect(a.lines[0]).toBe('You have 1 open invoice:');
    expect(a.lines[1]).toMatch(/^\$149\.00 for Mia Sample, due /);
    expect(a.lines[2]).toMatch(/can't take payments/);
  });
});

describe('Eian follow-up questions', () => {
  const sample = async () => { const r = await createSampleApi(() => new Date(NOW)).journey(); if (!r.ok) throw new Error('sample journey'); return r.data; };

  it('"and for Leo?" keeps the topic and changes the child', async () => {
    const view = await sample();
    const first = resolve('What does Mia need for her next belt?', view);
    expect(first).toMatchObject({ intent: 'belt', children: [0], followUp: false, memory: { intent: 'belt', children: [view.children[0]!.name] } });
    const next = resolve('And for Leo?', view, first.memory);
    expect(next).toMatchObject({ intent: 'belt', children: [1], followUp: true });
    expect(resolve('Leo?', view, first.memory)).toMatchObject({ intent: 'belt', children: [1], followUp: true });
    const a = answer('And for Leo?', { ...base, journey: view, last: first.memory });
    expect(a.intent).toBe('belt');
    expect(a.lines.every(l => l.startsWith(view.children[1]!.name))).toBe(true);
  });

  it('"when is his next class?" changes the topic and keeps the child', async () => {
    const view = await sample();
    const first = resolve('What does Leo need for his next belt?', view);
    const next = resolve('When is his next class?', view, first.memory);
    expect(next).toMatchObject({ intent: 'next-class', children: [1], followUp: false, memory: { intent: 'next-class', children: [view.children[1]!.name] } });
    expect(resolve('And the schedule?', view, first.memory)).toMatchObject({ intent: 'schedule', children: [1] });
  });

  it('a question that stands on its own is read on its own', async () => {
    const view = await sample();
    const first = resolve('What does Leo need for his next belt?', view);
    expect(resolve("What's on this week?", view, first.memory)).toMatchObject({ intent: 'schedule', children: [0, 1], memory: { intent: 'schedule', children: null } });
    expect(resolve('Tell me a joke', view, first.memory)).toMatchObject({ intent: 'help', followUp: false, memory: first.memory });
    expect(resolve('Tell me a long story about Leo and dragons', view, first.memory).intent).toBe('help');
  });

  it('nothing is carried without a first question, or for a child no longer shared', async () => {
    const view = await sample();
    expect(resolve('And for Leo?', view)).toMatchObject({ intent: 'help', followUp: false, memory: null });
    expect(resolve('When is their next class?', view, { intent: 'belt', children: ['Someone Else'] })).toMatchObject({ intent: 'next-class', children: [0, 1] });
    expect(resolve('What about them?', view, { intent: 'belt', children: null })).toMatchObject({ intent: 'belt', children: [0, 1], followUp: true });
  });
});

describe('sample family', () => {
  it('every read passes the same contract verifiers as live data', async () => {
    const api = createSampleApi(() => new Date(NOW));
    for (const read of [api.journey(), api.classBookings(), api.schoolMessages(), api.absenceContext(), api.billing(), api.classPass(), api.testingStatus(), api.curriculumLibrary()]) {
      expect((await read).ok).toBe(true);
    }
  });

  it('writes stay in memory and are reflected by the next read', async () => {
    const api = createSampleApi(() => new Date(NOW));
    const sent = await api.sendSchoolMessage('Hello from the sample', 'k-00000000000000001');
    expect(sent.ok).toBe(true);
    const thread = await api.schoolMessages();
    expect(thread.ok && thread.data.messages.at(-1)!.body).toBe('Hello from the sample');
    const choices = await api.classBookings();
    if (!choices.ok) throw new Error('choices');
    const open = choices.data.children.flatMap(ch => ch.sessions.map(s => ({ ch, s }))).find(x => !x.s.booking && x.s.spotsLeft > 0)!;
    expect((await api.bookClass({ studentProfileId: open.ch.studentProfileId, sessionId: open.s.sessionId }, 'k-00000000000000002')).ok).toBe(true);
    expect(await api.bookClass({ studentProfileId: open.ch.studentProfileId, sessionId: open.s.sessionId }, 'k-00000000000000003')).toEqual({ ok: false, state: 'refused', code: 'PARENT_CLASS_BOOKING_ALREADY_BOOKED' });
  });
});
