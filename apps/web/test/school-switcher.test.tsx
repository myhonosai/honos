import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SchoolSwitcherView, schoolHomeHref } from '../src/components/school-switcher/switcher';

const a = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222', organizationName: 'Ideal Org', schoolName: 'Ideal Martial Arts' };
const b = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '33333333-3333-4333-8333-333333333333', organizationName: 'Ideal Org', schoolName: 'Ideal North' };

it('HQ people see HON HQ plus their schools, from HQ and from inside a school', () => {
  const fromHq = renderToStaticMarkup(<SchoolSwitcherView language="en" current={{ kind: 'hq' }} isHq schools={[a]} />);
  expect(fromHq).toContain('data-switch-to="hq"'); expect(fromHq).toContain(`href="${schoolHomeHref(a).replace('&', '&amp;')}"`);
  expect(fromHq).toMatch(/aria-current="true"[^>]*><strong>HON HQ|data-switch-to="hq" aria-current="true"/);
  const inside = renderToStaticMarkup(<SchoolSwitcherView language="en" current={{ kind: 'school', schoolId: a.schoolId, schoolName: 'Ideal Martial Arts' }} isHq schools={[a]} />);
  expect(inside).toContain('href="/hq"'); expect(inside).toContain('Switch account: Ideal Martial Arts');
  expect(schoolHomeHref(a)).toContain(`schoolId=${a.schoolId}`);
});

it('non-HQ people never see HQ; one school shows nothing, several locations show their own locations', () => {
  expect(renderToStaticMarkup(<SchoolSwitcherView language="en" current={{ kind: 'school', schoolId: a.schoolId, schoolName: null }} isHq={false} schools={[a]} />)).toBe('');
  const multi = renderToStaticMarkup(<SchoolSwitcherView language="ko" current={{ kind: 'school', schoolId: b.schoolId, schoolName: null }} isHq={false} schools={[a, b]} />);
  expect(multi).not.toContain('/hq'); expect(multi).toContain('Ideal North'); expect(multi).toContain('계정 전환');
});

it('filters by the search text and is mounted under the logo in both shells', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...a, schoolId: `22222222-2222-4222-8222-22222222222${i}`, schoolName: `Dojo ${i}` }));
  const html = renderToStaticMarkup(<SchoolSwitcherView language="en" current={{ kind: 'hq' }} isHq schools={many} query="dojo 3" />);
  expect(html).toContain('Dojo 3'); expect(html).not.toContain('Dojo 4'); expect(html).toContain('type="search"');
  expect(readFileSync('src/components/hq-modern/shell.tsx', 'utf8')).toContain("<SchoolSwitcher language={preferences?.language ?? 'en'} current={{ kind: 'hq' }} inHq />");
  expect(readFileSync('src/components/school-shell/frame.tsx', 'utf8')).toContain('{props.switcher}');
});
