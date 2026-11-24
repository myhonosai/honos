import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import type { WalkInOverview, WalkInSettingsRead, WalkInTerminal, WalkInTrialClass } from '@hon/contracts';
import { WALK_IN_COPY } from '../src/components/walk-in-kiosk/copy';
import { settingsBody, settingsDraft, WalkInStaffView } from '../src/components/walk-in-kiosk/staff';
import {
  classOpen, detailsOk, emptyDraft, offerOpen, visitBody, visitSeats, WalkInVisitorView, type VisitDraft, type VisitorViewProps,
} from '../src/components/walk-in-kiosk/visitor';

// 0537 (WK4): a trial offer can list classes; the visitor picks one with room for everyone on the visit.
const pipe = '33333333-3333-4333-8333-333333333333', stage = '44444444-4444-4444-8444-444444444444';
const progA = '55555555-5555-4555-8555-555555555555', progB = '66666666-6666-4666-8666-666666666666';
const s1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', s2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const cls = (sessionId: string, spotsOpen: number, name = 'Kids class'): WalkInTrialClass =>
  ({ sessionId, name, startsAt: '2026-11-21T01:00:00.000Z', endsAt: '2026-11-21T02:00:00.000Z', spotsOpen });
const terminal = (classes: WalkInTrialClass[] | null): WalkInTerminal => ({
  schoolName: 'Synthetic Dojo', branding: { logoUrl: null, accentColor: null }, endsAt: '2099-01-01T00:00:00.000Z', settingsVersion: 3,
  waiver: { en: 'I accept the risks of training.' }, emergencyRequired: false, thankYou: { en: '' }, cardSurfaces: [],
  offers: [{ key: 'trial', kind: 'TRIAL', name: { en: 'Free trial class' }, description: { en: '' }, priceMinor: 0, currency: 'USD', classes },
    { key: 'day-pass', kind: 'DAY_PASS', name: { en: 'Day pass' }, description: { en: '' }, priceMinor: 2500, currency: 'USD', classes: null }],
});
const filled = (patch: Partial<VisitDraft> = {}): VisitDraft => ({
  ...emptyDraft(), who: 'BOTH', contact: { givenName: 'Sam', familyName: 'Example', birthDate: '1990-01-01', email: 'sam@example.test', mobile: '' },
  children: [{ givenName: 'Kai', familyName: 'Example', birthDate: '2017-05-05' }], signerName: 'Sam Example', strokes: [[[10, 10], [20, 20]]], agreed: true,
  offerKey: 'trial', ...patch,
});
const props = (read: WalkInTerminal, patch: Partial<VisitorViewProps> = {}): VisitorViewProps => ({
  read, mode: 'modern', language: 'en', step: 'OFFER', draft: filled(), today: '2026-11-19', tried: false, sending: false, outcome: null, countdown: 20, ...patch,
});
const sendDisabled = (html: string) => /<button[^>]*disabled=""[^>]*>Finish check-in<\/button>/.test(html);

describe('trial class on the tablet', () => {
  it('counts a seat for everyone who trains', () => {
    expect(visitSeats(filled())).toBe(2);
    expect(visitSeats(filled({ who: 'ME', children: [] }))).toBe(1);
    expect(visitSeats(filled({ who: 'KIDS', children: [filled().children[0]!, filled().children[0]!] }))).toBe(2);
    expect(classOpen(cls(s1, 2), filled())).toBe(true);
    expect(classOpen(cls(s1, 1), filled())).toBe(false);
    expect(offerOpen(terminal([cls(s1, 1)]).offers[0]!, filled())).toBe(false);
    expect(offerOpen(terminal([]).offers[0]!, filled())).toBe(false);
    expect(offerOpen(terminal(null).offers[0]!, filled())).toBe(true);
  });
  it('sends the picked class only for an offer that lists classes', () => {
    const read = terminal([cls(s1, 5), cls(s2, 1)]);
    expect(visitBody(filled({ trialSessionId: s1 }), read, 'en', '2026-11-19').trialSessionId).toBe(s1);
    expect(() => visitBody(filled(), read, 'en', '2026-11-19')).toThrow(); // no class picked
    expect(() => visitBody(filled({ trialSessionId: s2 }), read, 'en', '2026-11-19')).toThrow(); // not enough room
    expect(() => visitBody(filled({ trialSessionId: '99999999-9999-4999-8999-999999999999' }), read, 'en', '2026-11-19')).toThrow();
    expect('trialSessionId' in visitBody(filled({ offerKey: 'day-pass', trialSessionId: s1 }), read, 'en', '2026-11-19')).toBe(false);
    expect('trialSessionId' in visitBody(filled(), terminal(null), 'en', '2026-11-19')).toBe(false);
    // The details step never depends on classes picked later, even when the only trial has none open.
    expect(detailsOk(filled({ offerKey: '' }), terminal([]), 'en', '2026-11-19')).toBe(true);
  });
  it('lists classes under the trial, disables full ones, and waits for a pick', () => {
    const html = renderToStaticMarkup(<WalkInVisitorView {...props(terminal([cls(s1, 5, 'Little dragons'), cls(s2, 1, 'Teens')]))}/>);
    expect(html).toContain('data-testid="walkin-classes"');
    expect(html).toContain(WALK_IN_COPY.en.vClassTitle);
    expect(html).toContain('Little dragons'); expect(html).toContain(WALK_IN_COPY.en.vClassSpots); expect(html).not.toContain('5 spots');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*><strong>Teens<\/strong>/);
    expect(html).toContain(WALK_IN_COPY.en.vClassFull);
    expect(sendDisabled(html)).toBe(true);
    const picked = renderToStaticMarkup(<WalkInVisitorView {...props(terminal([cls(s1, 5)]), { draft: filled({ trialSessionId: s1 }) })}/>);
    expect(picked).toMatch(/aria-checked="true"[^>]*><strong>Kids class/);
    expect(sendDisabled(picked)).toBe(false);
  });
  it('shows no class list for other offers and disables a trial with no open class', () => {
    const day = renderToStaticMarkup(<WalkInVisitorView {...props(terminal([cls(s1, 5)]), { draft: filled({ offerKey: 'day-pass' }) })}/>);
    expect(day).not.toContain('data-testid="walkin-classes"'); expect(sendDisabled(day)).toBe(false);
    const none = renderToStaticMarkup(<WalkInVisitorView {...props(terminal([]), { draft: filled({ offerKey: '' }) })}/>);
    expect(none).toContain(WALK_IN_COPY.en.vNoClasses);
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*><strong>Free trial class<\/strong>/);
  });
  it('says when the class filled up and keeps the visitor on the choice', () => {
    const html = renderToStaticMarkup(<WalkInVisitorView {...props(terminal([cls(s1, 5)]), { outcome: { result: 'CLASS_FULL' } })}/>);
    expect(html).toContain(WALK_IN_COPY.en.vCLASS_FULL);
    expect(html).not.toContain(WALK_IN_COPY.en.vStartOver);
    for (const language of ['ko', 'es'] as const) {
      expect(renderToStaticMarkup(<WalkInVisitorView {...props(terminal([cls(s1, 5)]), { language, outcome: { result: 'CLASS_FULL' } })}/>)).toContain(WALK_IN_COPY[language].vCLASS_FULL);
    }
  });
  it('names the booked class on the done screen', () => {
    const html = renderToStaticMarkup(<WalkInVisitorView {...props(terminal([cls(s1, 5)]), { step: 'DONE', outcome: { result: 'RECORDED', firstName: 'Sam', paymentState: 'FREE', priceMinor: 0,
      thankYou: null, trialClass: { sessionId: s1, name: 'Little dragons', startsAt: '2026-11-21T01:00:00.000Z', endsAt: '2026-11-21T02:00:00.000Z', status: 'SCHEDULED' } } })}/>);
    expect(html).toContain('data-testid="walkin-done-class"'); expect(html).toContain('Your trial class: Little dragons');
  });
  it('clears the picked class when another offer is chosen (draft wiring)', () => {
    const src = readFileSync('src/components/walk-in-kiosk/visitor.tsx', 'utf8');
    expect(src).toContain("set({ offerKey: o.key, trialSessionId: o.key === d.offerKey ? d.trialSessionId : '' })");
    expect(src).toContain("if (answer.result === 'CLASS_FULL') { setDraft(x => ({ ...x, trialSessionId: '' })); void load(); }");
  });
  it('#494 P3: choosing another way, a finished form or a form error makes an in-flight card answer stale', () => {
    const src = readFileSync('src/components/walk-in-kiosk/visitor.tsx', 'utf8');
    for (const handler of ['onOther', 'onFormDone', 'onFormError']) expect(src).toMatch(new RegExp(`${handler}=\\{\\(\\) => \\{ if \\(pay\\) \\{ generation\\.current \\+= 1;`));
  });
});

describe('trial programs in the staff settings', () => {
  const read: WalkInSettingsRead = { settings: null, pipelines: [{ pipelineId: pipe, name: 'Walk-ins', stages: [{ stageId: stage, name: 'New' }] }],
    programs: [{ programId: progA, name: 'Little dragons' }, { programId: progB, name: 'Teens' }] };
  const base = { language: 'en', waiting: false, hasSchool: true, detail: null, outcome: null, busy: false, label: 'Front desk', hours: 8,
    scope: { organizationId: pipe, schoolId: stage }, settings: { state: 'READY' as const, read },
    overview: { state: 'READY' as const, read: { canManage: true, configured: false, enabled: false, devices: [], visits: [] } as WalkInOverview } };
  it('offers the school programs as checkboxes on trial offers only', () => {
    const html = renderToStaticMarkup(<WalkInStaffView {...base} draft={settingsDraft(read)}/>);
    expect(html.match(/data-testid="walkin-trial-programs"/g)?.length).toBe(1); // the default trial, not the day pass
    expect(html).toContain(WALK_IN_COPY.en.sTrialPrograms); expect(html).toContain('Little dragons'); expect(html).toContain('Teens');
    const none = renderToStaticMarkup(<WalkInStaffView {...base} settings={{ state: 'READY', read: { ...read, programs: [] } }} draft={settingsDraft({ ...read, programs: [] })}/>);
    expect(none).not.toContain('data-testid="walkin-trial-programs"');
  });
  it('saves programIds only for a trial with programs ticked', () => {
    const d = settingsDraft(read);
    const waiver = { en: 'Risks.', ko: '', es: '' };
    const ticked = { ...d, waiver, offers: d.offers.map(o => o.kind === 'TRIAL' ? { ...o, programIds: [progA] } : { ...o, programIds: [progB] }) };
    const body = settingsBody(ticked, null);
    expect(body.offers[0]?.programIds).toEqual([progA]);
    expect(body.offers[1]?.programIds).toBeUndefined(); // a day pass never names programs
    expect(settingsBody({ ...d, waiver }, null).offers[0]?.programIds).toBeUndefined();
    const back = settingsDraft({ ...read, settings: { ...body, waiverVersion: 1, version: 1, updatedAt: '2026-11-19T00:00:00.000Z' } });
    expect(back.offers[0]?.programIds).toEqual([progA]); expect(back.offers[1]?.programIds).toEqual([]);
  });
  it('shows the booked class on a walk-in', () => {
    const visit = { visitId: s1, leadId: s2, version: 1, createdAt: '2026-11-19T09:00:00.000Z', localDate: '2026-11-19', language: 'en',
      contact: { givenName: 'Sam', familyName: 'Example', email: null, mobile: '+15552010000' },
      participants: [{ givenName: 'Sam', familyName: 'Example', birthDate: '1990-01-01', isContact: true, isMinor: false }],
      offer: { key: 'trial', kind: 'TRIAL', name: 'Free trial class', priceMinor: 0, currency: 'USD' }, paymentState: 'FREE', deskMethod: null, deskPaidAt: null, cardPaidAt: null,
      emergencyName: '', emergencyPhone: '', marketingOptIn: false, heardFrom: '', waiverSignedAt: '2026-11-19T09:00:00.000Z',
      trialClass: { sessionId: s1, name: 'Little dragons', startsAt: '2026-11-21T01:00:00.000Z', endsAt: '2026-11-21T02:00:00.000Z', status: 'CANCELLED' } } as WalkInOverview['visits'][number];
    const html = renderToStaticMarkup(<WalkInStaffView {...base} draft={settingsDraft(read)}
      overview={{ state: 'READY', read: { canManage: true, configured: true, enabled: true, devices: [], visits: [visit] } }}/>);
    expect(html).toContain('data-testid="walkin-trial-class"'); expect(html).toContain('Trial class: Little dragons'); expect(html).toContain(WALK_IN_COPY.en.aCANCELLED);
  });
});
