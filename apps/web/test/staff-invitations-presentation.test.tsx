import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ language: 'en' }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: h.language } }) }));
import { StaffInvitations } from '../src/components/staff-invitations/workbench';
import { staffInvitationText as t } from '../src/components/staff-invitations/copy';
it.each(['en', 'ko', 'es'])('%s keeps status announcements, three modes and truthful unavailable/delivery boundaries', language => {
  h.language = language; const f = vi.spyOn(globalThis, 'fetch');
  const html = renderToStaticMarkup(<StaffInvitations sessionSubject="synthetic-manager"/>);
  for (const key of ['title', 'modern', 'classic', 'big', 'boundary', 'selectors'] as const) expect(html).toContain(t(language, key));
  expect(html).toContain('role="status"'); expect(html).toContain('aria-atomic="true"'); expect(html).not.toContain('staff@example.test'); expect(f).not.toHaveBeenCalled(); f.mockRestore();
});
it.each(['en', 'ko', 'es'])('%s acceptance requires authentication, separate ID/token and explicit confirmation; no fake success', language => {
  h.language = language; const html = renderToStaticMarkup(<StaffInvitations sessionSubject="synthetic-invitee" acceptance/>);
  expect(html).toContain(t(language, 'acceptIntro')); expect(html).not.toContain('STAFF_ROLE_BOUND'); expect(html).not.toContain('?token='); expect(html).not.toContain('localStorage');
});
it('uses existing protected operational routes without depending silently on unmerged entry work', () => {
  h.language = 'en'; const html = renderToStaticMarkup(<StaffInvitations sessionSubject="synthetic-manager"/>);
  for (const path of ['/auth/login', '/staff/roles', '/staff/dashboard']) {
    expect(html).toContain(`href="${path}"`); expect(existsSync(`src/app${path}/page.tsx`) || existsSync(`src/app${path}/route.ts`)).toBe(true);
  }
});
