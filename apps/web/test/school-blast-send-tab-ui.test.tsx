import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newBlastDraft } from '../src/components/school-blasts/format';
import { SchoolBlastsView, type SchoolBlastsViewProps } from '../src/components/school-blasts/view';
import { id } from './account-status-fixtures';

// TE5: blasts are the first tab of Texts > Send and Email > Send (owner, 2026-11-28: "I don't see any filter or way to send blast").
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const summary = (n: number, channel: 'SMS' | 'EMAIL', name: string) => ({ blastId: id(n), name, channel, status: 'DRAFT', version: 1, sendAt: null, queuedAt: null,
  recipientCount: null, updatedAt: '2026-11-28T08:00:00.000Z' }) as never;
function props(over: Partial<SchoolBlastsViewProps> = {}): SchoolBlastsViewProps {
  return { language: 'en', waiting: false, concealed: false, hasSchool: true, list: { state: 'READY', blasts: [summary(1, 'SMS', 'Text one'), summary(2, 'EMAIL', 'Email one')] },
    selected: null, draft: { ...newBlastDraft('SMS'), name: 'Renewals', body: 'Hi', tags: 'vip' }, dirty: true, problems: [], preview: null, scheduleLocal: '', scheduleValid: false,
    ask: null, outcome: null, locked: false, canRetry: false, pictures: { state: 'READY', assets: [] },
    filterOptions: { state: 'READY', options: { ranks: [], programs: [], plans: [], tags: ['vip', 'demo'] } }, ...over };
}

it('inside Texts > Send it shows the composer first, only text blasts, only a New text button, and no page heading of its own', () => {
  const html = renderToStaticMarkup(<SchoolBlastsView {...props({ embedded: 'SMS' })} />);
  expect(html).toContain('data-testid="blast-embedded"'); expect(html).not.toContain('<main'); expect(html).not.toContain('<h1');
  expect(html.indexOf('data-testid="blast-composer"')).toBeLessThan(html.indexOf('data-testid="blast-list"'));
  expect(html).toContain('Text one'); expect(html).not.toContain('Email one');
  expect(html).toContain('data-new="SMS"'); expect(html).not.toContain('data-new="EMAIL"');
  const email = renderToStaticMarkup(<SchoolBlastsView {...props({ embedded: 'EMAIL', draft: { ...newBlastDraft('EMAIL'), name: 'x', subject: 'y', body: 'z' } })} />);
  expect(email).toContain('Email one'); expect(email).not.toContain('Text one'); expect(email).toContain('data-new="EMAIL"'); expect(email).not.toContain('data-new="SMS"');
  // Marketing > Email & text blasts keeps its own page.
  const full = renderToStaticMarkup(<SchoolBlastsView {...props()} />);
  expect(full).toContain('<main'); expect(full).toContain('<h1'); expect(full).toContain('Email one');
});

it('audience groups are chips that show which are on, and the school tags are chips too', () => {
  const html = renderToStaticMarkup(<SchoolBlastsView {...props({ embedded: 'SMS' })} />);
  expect(html).toMatch(/aria-pressed="true"[^>]*data-group="ACTIVE_STUDENTS"/); expect(html).toMatch(/aria-pressed="false"[^>]*data-group="PROSPECTS"/);
  expect(html).toContain('data-testid="blast-tag-chips"');
  expect(html).toMatch(/aria-pressed="true"[^>]*data-tag="vip"/); expect(html).toMatch(/aria-pressed="false"[^>]*data-tag="demo"/);
  expect(renderToStaticMarkup(<SchoolBlastsView {...props({ filterOptions: { state: 'DENIED' } })} />)).not.toContain('blast-tag-chips');
});

it('Texts > Send and Email > Send open on New blast, with One person as the second tab; a template link opens One person', () => {
  const send = readFileSync('src/components/texts/texts-send.tsx', 'utf8');
  expect(send).toContain("useState<SendMode>(templateId ? 'ONE' : 'BLAST')");
  expect(send).toMatch(/<SchoolBlasts key=\{scopeKey\} channel=\{channel\} \/>/);
  expect(send).toContain("(['BLAST', 'ONE'] as const)");
  const container = readFileSync('src/components/school-blasts/school-blasts.tsx', 'utf8');
  expect(container).toMatch(/if \(channel && list\.state === 'READY' && !draft && selected === null && lock === 'NONE'\) setDraft\(newBlastDraft\(channel\)\)/);
  expect(container).toMatch(/outcome\?\.kind === 'SAVED' && draft\?\.blastId && !dirty && preview === null && lock === 'NONE'\) onPreview\(\)/);
});
