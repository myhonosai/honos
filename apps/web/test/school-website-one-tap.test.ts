import { expect, it } from 'vitest';
import { buildWebsiteFromTemplate, WEBSITE_TEMPLATES, websiteStarterArtUrl, type WebsiteDocument, type WebsiteSection } from '@hon/contracts';

// One-tap site: the starting site is filled from what HON already holds about the school (programs, weekly classes,
// a published enquiry form and an active booking page). Every value still passes the same document validation, and the
// server re-checks that each form and booking page is this school's.
const FORM = 'f'.repeat(48), BOOK = 'b'.repeat(48);
const sections = (d: WebsiteDocument): WebsiteSection[] => d.pages.flatMap(p => p.sections);
const ofType = (d: WebsiteDocument, type: string) => sections(d).filter(s => s.type === type);

it('without school facts every template keeps its sample programs and empty schedule (unchanged behaviour)', () => {
  for (const template of WEBSITE_TEMPLATES) {
    const d = buildWebsiteFromTemplate(template, { schoolName: 'Tiger Dojo' });
    expect((ofType(d, 'PROGRAMS')[0]!.props.items as unknown[]).length).toBe(3);
    expect(ofType(d, 'SCHEDULE')[0]!.props.items).toEqual([]);
    for (const s of ofType(d, 'LEAD_FORM')) expect(s.props.publicFormId).toBe('');
  }
});

it('uses the school programs, with matching starter art, in order and without duplicates', () => {
  const d = buildWebsiteFromTemplate('MODERN_CLEAN', { schoolName: 'Tiger Dojo', programs: ['Little Tigers', 'Junior Karate', 'Adult Karate', 'little tigers', '  '] });
  const items = ofType(d, 'PROGRAMS')[0]!.props.items as { name: string; imageUrl: string; ages: string; description: string }[];
  expect(items.map(i => i.name)).toEqual(['Little Tigers', 'Junior Karate', 'Adult Karate']);
  expect(items.map(i => i.imageUrl)).toEqual([websiteStarterArtUrl('program-little'), websiteStarterArtUrl('program-kids'), websiteStarterArtUrl('program-adults')]);
  expect(items.every(i => i.ages === '' && i.description === '')).toBe(true);
});

it('keeps at most 12 programs and clips long names', () => {
  const names = Array.from({ length: 20 }, (_, n) => `Program ${n} ${'x'.repeat(100)}`);
  const items = ofType(buildWebsiteFromTemplate('BOLD_POWERFUL', { schoolName: 'x', programs: names }), 'PROGRAMS')[0]!.props.items as { name: string }[];
  expect(items).toHaveLength(12);
  expect(items.every(i => i.name.length <= 80)).toBe(true);
});

it('lists each weekly class on each of its days, Monday first, in school time', () => {
  const d = buildWebsiteFromTemplate('FAMILY_FRIENDLY', { schoolName: 'x', classes: [
    { name: 'Adult Karate', weekdays: [3, 1], localStartTime: '19:00' },
    { name: 'Little Tigers', weekdays: [1], localStartTime: '16:30' },
    { name: 'Open Mat', weekdays: [7], localStartTime: '09:05' },
    { name: 'Noon Class', weekdays: [5], localStartTime: '12:00' },
    { name: 'Late', weekdays: [5], localStartTime: '00:15' },
  ] });
  const schedule = ofType(d, 'SCHEDULE')[0]!;
  expect(schedule.props.items).toEqual([
    { day: 'Monday', time: '4:30 PM', className: 'Little Tigers' },
    { day: 'Monday', time: '7:00 PM', className: 'Adult Karate' },
    { day: 'Wednesday', time: '7:00 PM', className: 'Adult Karate' },
    { day: 'Friday', time: '12:15 AM', className: 'Late' },
    { day: 'Friday', time: '12:00 PM', className: 'Noon Class' },
    { day: 'Sunday', time: '9:05 AM', className: 'Open Mat' },
  ]);
  expect(schedule.props.note).toBe('');
});

it('caps the schedule at 24 rows and ignores classes that are not well formed', () => {
  const many = Array.from({ length: 10 }, (_, n) => ({ name: `Class ${n}`, weekdays: [1, 2, 3, 4, 5], localStartTime: '18:00' }));
  const bad = [{ name: '', weekdays: [1], localStartTime: '18:00' }, { name: 'Bad day', weekdays: [0, 8], localStartTime: '18:00' }, { name: 'Bad time', weekdays: [1], localStartTime: '25:00' }];
  const items = ofType(buildWebsiteFromTemplate('TRADITIONAL', { schoolName: 'x', classes: [...bad, ...many] }), 'SCHEDULE')[0]!.props.items as { className: string }[];
  expect(items).toHaveLength(24);
  expect(items.some(i => /^Bad|^$/.test(i.className))).toBe(false);
});

it('connects the enquiry form and booking page on every template, and the trial button goes to booking', () => {
  for (const template of WEBSITE_TEMPLATES) {
    const d = buildWebsiteFromTemplate(template, { schoolName: 'x', formPublicId: FORM, bookingPublicId: BOOK });
    const forms = ofType(d, 'LEAD_FORM'), bookings = ofType(d, 'BOOKING');
    expect(forms.length).toBeGreaterThan(0);
    expect(forms.every(s => s.props.publicFormId === FORM)).toBe(true);
    expect(bookings).toHaveLength(1);
    expect(bookings[0]!.props.bookingPublicId).toBe(BOOK);
    for (const s of ofType(d, 'TRIAL_CTA')) expect(s.props.ctaHref).toBe('#book');
  }
});

it('a booking page alone adds the booking section; a malformed id is ignored rather than refused', () => {
  const d = buildWebsiteFromTemplate('MODERN_CLEAN', { schoolName: 'x', bookingPublicId: BOOK, formPublicId: 'not an id' });
  expect(ofType(d, 'BOOKING')).toHaveLength(1);
  expect(ofType(d, 'LEAD_FORM').every(s => s.props.publicFormId === '')).toBe(true);
  const none = buildWebsiteFromTemplate('MODERN_CLEAN', { schoolName: 'x', bookingPublicId: '../x' });
  expect(ofType(none, 'BOOKING')).toHaveLength(0);
  expect(ofType(none, 'TRIAL_CTA')[0]!.props.ctaHref).toBe('#enquire');
});
