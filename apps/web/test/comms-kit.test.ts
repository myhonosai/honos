import { describe, expect, it } from 'vitest';
import { MERGE_TAGS, fillMergeTags, unknownMergeTags, insertAt, mergeTagsIn } from '../src/components/comms-kit/merge-tags';
import { smsSegments } from '../src/components/comms-kit/sms-segments';

// Texts and Email pages (TE3a): merge tags are the BL1 closed list, filled in the browser from the chosen contact for one-to-one sends.
describe('merge tags', () => {
  const values = { first_name: 'Ana', last_name: 'Rivera', school_name: 'Sunrise Dojo', staff_name: 'Sam' };
  it('is the closed BL1 list', () => {
    expect(MERGE_TAGS.map(t => t.tag)).toEqual(['{{first_name}}', '{{last_name}}', '{{school_name}}', '{{staff_name}}']);
  });
  it('fills known tags, tolerates spaces, and leaves plain text alone', () => {
    expect(fillMergeTags('Hi {{first_name}} {{ last_name }} from {{school_name}}, {{staff_name}}', values)).toBe('Hi Ana Rivera from Sunrise Dojo, Sam');
    expect(fillMergeTags('No tags here', values)).toBe('No tags here');
  });
  it('uses "there" for an empty first name and nothing for an empty last name, like blasts', () => {
    expect(fillMergeTags('Hi {{first_name}} {{last_name}}!', { ...values, first_name: ' ', last_name: '' })).toBe('Hi there !');
  });
  it('reports tags outside the closed list so the send can be refused', () => {
    expect(unknownMergeTags('Hi {{first_name}} {{program}} {{ Last_Name }}')).toEqual(['{{program}}', '{{ Last_Name }}']);
    expect(unknownMergeTags('Hi {{first_name}}')).toEqual([]);
  });
  it('inserts a tag at the cursor', () => {
    expect(insertAt('Hi !', 3, '{{first_name}}')).toEqual({ text: 'Hi {{first_name}}!', cursor: 17 });
    expect(insertAt('Hi', 99, '{{first_name}}').text).toBe('Hi{{first_name}}');
  });
});

describe('text segments', () => {
  it('counts plain texts in 160 then 153 characters', () => {
    expect(smsSegments('')).toEqual({ segments: 0, unicode: false, perSegment: 160 });
    expect(smsSegments('a'.repeat(160)).segments).toBe(1);
    expect(smsSegments('a'.repeat(161))).toEqual({ segments: 2, unicode: false, perSegment: 153 });
    expect(smsSegments('a'.repeat(306)).segments).toBe(2);
    expect(smsSegments('a'.repeat(307)).segments).toBe(3);
  });
  it('counts GSM extension characters as two', () => {
    expect(smsSegments('{'.repeat(80)).segments).toBe(1);
    expect(smsSegments('{'.repeat(81)).segments).toBe(2);
  });
  it('counts emoji and other non-GSM text in 70 then 67 units', () => {
    expect(smsSegments('é'.repeat(70)).segments).toBe(1); // é is GSM-7
    expect(smsSegments('한'.repeat(70))).toEqual({ segments: 1, unicode: true, perSegment: 70 });
    expect(smsSegments('한'.repeat(71))).toEqual({ segments: 2, unicode: true, perSegment: 67 });
    expect(smsSegments('🥋'.repeat(35)).segments).toBe(1);
    expect(smsSegments('🥋'.repeat(36)).segments).toBe(2);
  });
});

import { initials } from '../src/components/comms-kit/initials';
describe('list avatars', () => {
  it('uses the first and last initials, and # for a number', () => {
    expect(initials('Ana Rivera')).toBe('AR'); expect(initials('ana')).toBe('A'); expect(initials('Ana Maria de la Cruz')).toBe('AC');
    expect(initials('+15125550100')).toBe('#'); expect(initials('  ')).toBe('#'); expect(initials('김 민준')).toBe('김민');
  });
});

describe('shortWhen', () => {
  const now = new Date('2026-11-19T15:00:00Z');
  it('shows the time today, month and day this year, and the full date before', async () => {
    const { shortWhen } = await import('../src/components/comms-kit/short-when');
    expect(shortWhen('2026-11-19T08:30:00Z', { locale: 'en-US', timeZone: 'UTC', now })).toBe('8:30 AM');
    expect(shortWhen('2026-11-06T08:30:00Z', { locale: 'en-US', timeZone: 'UTC', now })).toBe('Nov 6');
    expect(shortWhen('2025-12-31T08:30:00Z', { locale: 'en-US', timeZone: 'UTC', now })).toBe('Dec 31, 2025');
    expect(shortWhen('not a date', { locale: 'en-US', now })).toBe('');
  });
  it('decides today in the school time zone', async () => {
    const { shortWhen } = await import('../src/components/comms-kit/short-when');
    // 03:00 UTC on Nov 19 is still Nov 18 in Los Angeles.
    expect(shortWhen('2026-11-19T03:00:00Z', { locale: 'en-US', timeZone: 'America/Los_Angeles', now })).toBe('Nov 18');
  });
});

describe('mergeTagsIn', () => {
  it('finds the written tags among the given keys, as written', () => {
    expect(mergeTagsIn('Hi {{first_name}} from {{ staff_name }} and {{staff_name}}', ['staff_name'])).toEqual(['{{ staff_name }}', '{{staff_name}}']);
    expect(mergeTagsIn('Hi {{first_name}}', ['staff_name', 'school_name'])).toEqual([]);
  });
});
