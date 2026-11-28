import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verifySchoolBlastRecipients } from '@hon/contracts';
import { BLAST_COPY, blastCopy } from '../src/components/school-blasts/copy';
import { BlastRecipientsView } from '../src/components/school-blasts/blast-recipients';
import { SentEmail } from '../src/components/texts/sent-email';
import { id } from './account-status-fixtures';

// 0716 (owner, 2026-11-28: "Emails also needs to be saved on history so we can go back and see what was sent").
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const BLAST = id(71), P1 = id(72), P2 = id(73), M1 = id(74);
const read = (channel: 'EMAIL' | 'SMS') => verifySchoolBlastRecipients({ blastId: BLAST, channel, status: 'QUEUED', items: [
  { personId: P1, name: 'Avery Kim', outcome: 'QUEUED', messageId: M1, delivery: 'BOUNCED', failureCode: 'MAILBOX_FULL' },
  { personId: P2, name: '', outcome: 'NO_CONSENT', messageId: null, delivery: null, failureCode: null }] }, { blastId: BLAST });
const c = blastCopy('en');

it('a sent blast lists who it went to, with delivery or why they were skipped, and opens each email', () => {
  expect(renderToStaticMarkup(<BlastRecipientsView c={c} read={{ state: 'CLOSED' }} openId={null}/>)).toContain('View recipients');
  const html = renderToStaticMarkup(<BlastRecipientsView c={c} read={{ state: 'READY', read: read('EMAIL') }} openId={M1}
    email={(person, message) => <i data-opened={`${person}/${message}`}/>}/>);
  expect(html).toContain('Who it went to'); expect(html).toContain('Avery Kim'); expect(html).toContain('Bounced'); expect(html).toContain('MAILBOX_FULL');
  expect(html).toContain('Contact without a name'); expect(html).toContain(c.outcomes.NO_CONSENT);
  expect(html).toContain(`data-open-email="${M1}"`); expect(html).toContain('Close email'); expect(html).toContain(`data-opened="${P1}/${M1}"`);
  expect(html).not.toContain('@');
  const sms = renderToStaticMarkup(<BlastRecipientsView c={c} read={{ state: 'READY', read: read('SMS') }} openId={null}/>);
  expect(sms).toContain('Avery Kim'); expect(sms).not.toContain('data-open-email');
  expect(renderToStaticMarkup(<BlastRecipientsView c={c} read={{ state: 'DENIED' }} openId={null}/>)).toContain(c.recipientsDenied);
  expect(renderToStaticMarkup(<BlastRecipientsView c={c} read={{ state: 'READY', read: { ...read('EMAIL'), items: [] } }} openId={null}/>)).toContain(c.recipientsEmpty);
});

it('the full email opens from History and from a blast; both reach it through the contact history read', () => {
  const html = renderToStaticMarkup(<SentEmail scope={{ organizationId: id(1), schoolId: id(2) }} personId={P1} messageId={M1} preview={null}
    when={{ short: (s) => s, full: (s) => s }}/>);
  expect(html).toContain('Opening the full email');
  const sent = readFileSync('src/components/texts/sent-email.tsx', 'utf8');
  expect(sent).toContain('loadContactEmail(scope, personId, messageId)'); expect(sent).toContain('onShellPrivacyEvent');
  expect(readFileSync('src/components/texts/message-history.tsx', 'utf8')).toMatch(/channel === 'EMAIL' \? <SentEmail key=\{open\.messageId\}/);
  const container = readFileSync('src/components/school-blasts/school-blasts.tsx', 'utf8');
  expect(container).toContain("selected.blast.status !== 'DRAFT' && orgId && schoolId");
  expect(readFileSync('src/components/school-blasts/http.ts', 'utf8')).toContain('/recipients`');
});

it('every language has the new words', () => {
  for (const copy of Object.values(BLAST_COPY)) {
    for (const key of ['recipientsTitle', 'viewRecipients', 'hideRecipients', 'recipientsEmpty', 'recipientsUnavailable', 'recipientsDenied', 'openEmail', 'closeEmail', 'noName', 'recipientsCapped'] as const) {
      expect(copy[key]).toBeTruthy();
    }
  }
});
