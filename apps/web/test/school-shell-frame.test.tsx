import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SchoolShellFrame, type SchoolShellFrameProps } from '../src/components/school-shell/frame';
import { shellText } from '../src/components/school-shell/copy';
import { SCHOOL_SHELL_NAV, SCHOOL_SHELL_SECTIONS } from '../src/components/school-shell/catalog';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const base: SchoolShellFrameProps = {
  path: '/staff/dashboard', language: 'en', phase: 'READY', selection: { organizationId: A, schoolId: B }, schoolName: null,
  choices: [], mode: 'modern', viewState: 'LOCAL', menuOpen: false,
  onMode: () => {}, onMenu: () => {}, onSwitch: () => {}, onChoose: () => {}, onRestore: () => {},
};
const esc = (value: string) => value.replaceAll('&', '&amp;');
const render = (props: Partial<SchoolShellFrameProps> = {}) => renderToStaticMarkup(
  <SchoolShellFrame {...base} {...props}><p data-testid="page">private page</p></SchoolShellFrame>);

describe('school shell frame', () => {
  it('wraps the exact page after a skip link and the primary navigation, leaving the main landmark to the page', () => {
    const html = render();
    expect(html).toContain('href="#hon-main"');
    expect(html).toMatch(/<div[^>]*id="hon-main"[^>]*>.*<p data-testid="page">private page<\/p>/s);
    // Pages render their own <main>; a second one around them would duplicate the landmark.
    expect(html).not.toContain('<main');
    for (const item of SCHOOL_SHELL_NAV) expect(html).toContain(esc(shellText('en', item.titleKey)));
    for (const section of SCHOOL_SHELL_SECTIONS) expect(html).toContain(`>${esc(shellText('en', section.titleKey))}</p>`);
  });

  it('marks the active primary item and its section tab', () => {
    const html = render({ path: '/staff/crm/follow-ups' });
    expect(html).toMatch(/aria-current="page"[^>]*data-nav="crm"|data-nav="crm"[^>]*aria-current="page"/);
    expect(html).toMatch(/<nav[^>]*aria-label="Pages in this section"/);
    expect(html).toMatch(/href="\/staff\/crm\/follow-ups"[^>]*aria-current="page"/);
  });

  it('adds the verified prefill to scoped links only when READY', () => {
    const ready = render();
    expect(ready).toContain(`href="/staff/dashboard?organizationId=${A}&amp;schoolId=${B}"`);
    expect(ready).toContain('href="/staff/billing/membership-plans"');
    for (const phase of ['IDLE', 'LOADING', 'CHOICE', 'CONCEALED', 'SESSION', 'DENIED', 'UNAVAILABLE', 'IDENTITY'] as const) {
      const html = render({ phase, selection: phase === 'CONCEALED' ? null : base.selection });
      expect(html, phase).not.toContain('organizationId=');
      expect(html, phase).toContain(shellText('en', phase));
    }
  });

  it('names the school card region distinctly from any page field labelled School', () => {
    expect(render()).toContain('aria-label="Current school"');
    expect(render()).not.toContain('aria-label="School"');
  });

  it('never prints school identifiers, only a verified name when one is known', () => {
    expect(render()).not.toMatch(new RegExp(`>[^<]*${B}`));
    expect(render({ schoolName: 'Sunrise Taekwondo' })).toContain('Sunrise Taekwondo');
    expect(render({ phase: 'CONCEALED', selection: null, schoolName: null })).not.toContain('Sunrise');
  });

  it('lists named school choices only in CHOICE', () => {
    const choices = [{ organizationId: A, schoolId: B, organizationName: 'Org', schoolName: 'North Dojang' },
      { organizationId: A, schoolId: '33333333-3333-4333-8333-333333333333', organizationName: 'Org', schoolName: 'South Dojang' }];
    expect(render({ phase: 'CHOICE', selection: null, choices })).toContain('South Dojang');
    expect(render({ phase: 'READY', choices })).not.toContain('South Dojang');
  });

  it('offers sign-in instead of school controls when the session or identity ended', () => {
    for (const phase of ['SESSION', 'IDENTITY'] as const) {
      const html = render({ phase, selection: null });
      expect(html).toContain('href="/auth/login"');
      expect(html).not.toContain(shellText('en', 'switchSchool'));
    }
  });

  it('exposes the three platform views as pressed buttons and sets the mode on the root', () => {
    for (const mode of ['modern', 'classic', 'big-button'] as const) {
      const html = render({ mode });
      expect(html).toMatch(new RegExp(`data-hon-ui="school"[^>]*data-hon-mode="${mode}"|data-hon-mode="${mode}"[^>]*data-hon-ui="school"`));
      expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>${shellText('en', mode)}<`));
      // Distinct names: a page's own view picker keeps its plain "Modern"/"Classic" buttons.
      expect(html).toContain(`aria-label="${shellText('en', 'view')}: ${shellText('en', mode)}"`);
    }
  });

  it.each(['ko', 'es'] as const)('renders %s navigation copy', language => {
    const html = render({ language, path: '/staff/work' });
    expect(html).toContain(esc(shellText(language, 'navCrm')));
    expect(html).toContain(shellText(language, 'askHon'));
    expect(html).not.toContain('>CRM &amp; Sales<');
  });

  it('performs no network read while rendering', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    render(); expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
  });

  it('lays out Classic as a sidebar, Modern as a top bar and Big Button as cards, with one school region each', () => {
    const layout = (mode: 'modern' | 'classic' | 'big-button') => render({ mode }).match(/data-hon-layout="([^"]+)"/)?.[1];
    expect([layout('classic'), layout('modern'), layout('big-button')]).toEqual(['sidebar', 'topnav', 'cards']);
    for (const mode of ['modern', 'classic', 'big-button'] as const) expect(render({ mode }).match(/aria-label="Current school"/g)).toHaveLength(1);
  });

  it('opens a menu panel of every area outside Classic, and the sidebar drawer in Classic', () => {
    const panel = render({ mode: 'modern', menuOpen: true });
    expect(panel).toMatch(/role="dialog"[^>]*aria-label="Menu"/);
    for (const key of ['navHome', 'navCrm', 'navSettings'] as const) expect(panel.split('aria-label="Menu"')[1]).toContain(esc(shellText('en', key)));
    expect(render({ mode: 'big-button', menuOpen: true })).toContain('aria-label="Menu"');
    expect(render({ mode: 'classic', menuOpen: true })).not.toContain('aria-label="Menu"');
    expect(render({ mode: 'modern' })).not.toContain('role="dialog"');
  });

  it('lists every menu page under its heading in the Menu, like the owner\'s CRM, and keeps tabs inside the pages', () => {
    for (const mode of ['modern', 'big-button'] as const) {
      const panel = render({ mode, menuOpen: true }).split('aria-label="Menu"')[1]!;
      for (const section of SCHOOL_SHELL_SECTIONS) {
        const block = panel.match(new RegExp(`data-menu-section="${section.key}"[^>]*>(.*?)</section>`, 's'))?.[1] ?? '';
        expect(block, section.key).toContain(`>${esc(shellText('en', section.titleKey))}</h2>`);
        for (const item of SCHOOL_SHELL_NAV.filter(candidate => candidate.section === section.key)) expect(block, item.key).toContain(`data-menu="${item.key}"`);
      }
      expect(panel).toContain('data-menu="settings"');
      // Second-level tabs are not repeated in the Menu: one link per page.
      expect(panel).not.toContain('href="/staff/crm/follow-ups"');
    }
  });

  it('shows the headings in the Classic sidebar with their pages under them, and Settings at the bottom', () => {
    const html = render({ mode: 'classic' });
    const ai = html.match(/data-nav-section="ai"[^>]*>(.*?)<\/div>/s)?.[1] ?? '';
    expect(ai).toContain('>AI</p>'); expect(ai).toContain('data-nav="aiTeam"'); expect(ai).toContain('data-nav="conversationAi"');
    expect(html).toMatch(/data-nav-section="footer"[^>]*><a[^>]*data-nav="settings"/);
  });

  it('marks only the everyday pages for the Modern top bar; the rest stay in the Menu', () => {
    const html = render({ mode: 'modern' });
    for (const key of ['home', 'classes', 'attendance', 'students', 'crm', 'conversationAi']) expect(html).toMatch(new RegExp(`data-nav="${key}" data-everyday="true"`));
    expect(html).toMatch(/data-nav="billing" data-everyday="false"/);
  });

  it('keeps onboarding pages out of tabs and the menu while Home still owns them for "where am I"', () => {
    const html = render({ path: '/staff/welcome' });
    expect(html).toMatch(/aria-current="page"[^>]*data-nav="home"|data-nav="home"[^>]*aria-current="page"/);
    expect(html).toContain('>Welcome and setup</p>');
    const tabs = html.match(/data-shell-tabs="">(.*?)<\/nav>/s)?.[1] ?? '';
    expect(tabs).not.toContain('/staff/welcome'); expect(tabs).not.toContain('/staff/launch'); expect(tabs).not.toContain('/staff/founder-setup');
    const settings = render({ path: '/staff/settings' });
    expect(settings.match(/data-shell-tabs="">(.*?)<\/nav>/s)?.[1]).toMatch(/href="\/staff\/settings" aria-current="page">Summary</);
    expect(render({ path: '/staff/settings/branding' }).match(/data-shell-tabs="">(.*?)<\/nav>/s)?.[1]).toMatch(/aria-current="page">School branding</);
  });

  it('offers a More button in the Modern top bar so areas that do not fit stay one click away', () => {
    expect(render({ mode: 'modern' })).toMatch(/data-nav-more=""[^>]*aria-expanded="false"/);
    expect(render({ mode: 'modern' })).toContain(`>${shellText('en', 'more')}</span></button>`);
    expect(render({ mode: 'classic' })).not.toContain('data-nav-more');
    expect(render({ mode: 'big-button' })).not.toContain('data-nav-more');
  });

  it('makes the page behind the Menu panel inert and marks private school content for synchronous concealment', () => {
    const open = render({ mode: 'modern', menuOpen: true, path: '/staff/work' });
    expect(open).toContain('aria-modal="true"');
    expect((open.match(/ inert=""/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(render({ mode: 'modern', path: '/staff/work' })).not.toContain(' inert=""');
    const ready = render({ phase: 'READY', schoolName: 'Sunrise Taekwondo' });
    expect(ready).toMatch(/<strong data-shell-private="">Sunrise Taekwondo<\/strong>/);
    expect(render({ phase: 'CONCEALED', schoolName: null })).not.toContain('data-shell-private');
  });
  it('keeps HON in the corner on other pages, but not on the dashboard or in HON itself', () => {
    const launcher = /class="[^"]*honLauncher[^"]*" href="\/staff\/hon"/;
    expect(render({ path: '/staff/crm/leads' })).toMatch(launcher);
    expect(render({ path: '/staff/work', phase: 'SESSION', selection: null })).toMatch(launcher);
    expect(render({ path: '/staff/dashboard' })).not.toMatch(launcher);
    expect(render({ path: '/staff/hon' })).not.toMatch(launcher);
  });

  it('keeps the drawer closed unless the menu is open', () => {
    expect(render()).not.toMatch(/<dialog[^>]* open/);
    expect(render({ menuOpen: true })).toContain('data-drawer="open"');
  });

  it('shows only the current page\'s tabs, with no group row (two levels only)', () => {
    const tabs = (html: string) => [...(html.match(/data-shell-tabs="">(.*?)<\/nav>/s)?.[1] ?? '').matchAll(/>([^<]+)<\/a>/g)].map(m => m[1]);
    const progress = render({ path: '/staff/curriculum/progress' });
    expect(progress).not.toContain('data-shell-groups');
    expect(tabs(progress)).toEqual(['Curriculum library', 'Curriculum progress', 'Teaching studio', 'Achievements']);
    expect(tabs(render({ path: '/staff/billing/invoices' }))).toEqual(['Invoices', 'Tuition balances']);
    // A one-page item shows no tab row at all.
    expect(render({ path: '/staff/billing/checkout-pages' })).not.toContain('data-shell-tabs');
  });

  it('shows Tests as numbered steps in order, not tabs, with the current step marked (L3)', () => {
    for (const mode of ['modern', 'classic', 'big-button'] as const) {
      const html = render({ path: '/staff/testing/candidates/grade', mode });
      expect(html).not.toContain('data-shell-tabs');
      const row = html.match(/data-shell-steps="">(.*?)<\/nav>/s)?.[1] ?? '';
      expect(row).toMatch(/^<ol>/);
      const steps = [...row.matchAll(/<a href="([^"]+)"([^>]*)><span data-step-number="">(\d)<\/span>([^<]+)<\/a>/g)].map(m => [m[1], m[3], m[4], (m[2] ?? '').includes('aria-current="step"')]);
      expect(steps).toEqual([
        ['/staff/testing/readiness', '1', 'Who is ready', false], ['/staff/testing/registrations', '2', 'Sign-ups', false],
        ['/staff/testing/candidates/register', '3', 'Register', false], ['/staff/testing/candidates/grade', '4', 'Grade', true],
        ['/staff/testing/scorecards', '5', 'Scorecards', false], ['/staff/testing/certificates', '6', 'Certificates', false],
      ]);
      expect(html).toContain('aria-label="Test steps"');
    }
    // Other pages keep a plain tab row and no step row.
    expect(render({ path: '/staff/billing/invoices' })).not.toContain('data-shell-steps');
    expect(shellText('ko', 'stepsNav')).not.toBe(shellText('en', 'stepsNav'));
    expect(shellText('es', 'routeTestRegister')).not.toBe(shellText('en', 'routeTestRegister'));
  });

  it('names the current area in the phone bar when it is not one of the four shortcuts', () => {
    const mobile = (html: string) => html.match(/aria-label="Quick navigation"[^>]*>(.*?)<\/nav>/s)?.[1] ?? '';
    const billing = mobile(render({ path: '/staff/billing/invoices' }));
    expect(billing).toContain('data-mobile-current=""'); expect(billing).toContain('<span>Invoices</span>'); expect(billing).not.toContain('<span>More</span>');
    expect(billing).toContain('aria-label="More: You are in Invoices"');
    const classes = mobile(render({ path: '/staff/schedule' }));
    expect(classes).not.toContain('data-mobile-current'); expect(classes).toContain('<span>More</span>');
    expect(classes).toMatch(/aria-current="page"[^>]*>.*?<span>Calendar<\/span>/s);
  });
});
