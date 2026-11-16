import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Design pass 2 (owner, 2026-11-14: "no internal jargon"): page headers say what the page is for in plain words; the
// list of what a page never does was removed on 2026-11-16 (owner).
const PAGES = ['invoice-workbench', 'curriculum-progress-workbench', 'testing-candidate-registration-workbench', 'testing-candidate-grade-workbench',
  'promotion-decision-workbench', 'class-booking-workbench', 'class-session-workbench', 'class-sessions-read',
  'staff-role-admin', 'planned-absence-review-workbench', 'trial-appointment-workbench', 'marketplace-workbench', 'lead-import-workbench', 'document-workbench',
  'public-form-workbench', 'attendance-workbench', 'campaign-workbench', 'teaching-studio-workbench', 'work-items-workbench', 'automation-rules-workbench',
  'community-workbench', 'achievements-workbench', 'instructor-qualifications-workbench', 'billing-renewals-workbench', 'revenue-planning-workbench',
  'action-approvals-workbench', 'crm-follow-ups-workbench', 'staff-availability-workbench'];

// Owner 2026-11-16 ("so many verification on page"): these pages carry no policy note at all.
describe('plain-language page headers', () => {
  for (const page of PAGES) it(page, () => {
    const source = readFileSync(`src/components/${page}.tsx`, 'utf8');
    const header = [...source.matchAll(/<header>.*?<\/header>/gs)].map(match => match[0]).join('');
    expect(header).not.toMatch(/HON \/|HUMAN|CONVENTIONAL|UUID|canonical|untrusted|idle|selector/i);
    // A lead that says "Choose" is only true where the page offers a list to choose from (#369 review P2).
    if (/Choose/.test(header)) expect(source).toMatch(/Picker|setSelected/);
    // Owner 2026-11-16 ("so many verification on page"): no policy disclosure; at most one short plain sentence.
    expect(source).not.toMatch(/What this page never does/);
    for (const note of source.matchAll(/<aside[^>]* data-plain-note="">(.*?)<\/aside>/gs)) expect(note[1]).toMatch(/^<strong>[^<]{20,140}<\/strong>$/);
  });
});
