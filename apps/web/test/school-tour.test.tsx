import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SchoolShellFrame, type SchoolShellFrameProps } from '../src/components/school-shell/frame';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { shellText } from '../src/components/school-shell/copy';
import { SCHOOL_TOUR_STEPS, SchoolTourDialog, TourInviteView, schoolTourInside } from '../src/components/school-shell/tour';
import { tourCopy } from '../src/components/school-shell/tour-copy';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const verified = { organizationId: A, schoolId: B };
const dialog = (step: number, language = 'en') => renderToStaticMarkup(
  <SchoolTourDialog language={language} step={step} verified={verified} onStep={() => {}} onClose={() => {}} />);
const esc = (value: string) => value.replaceAll('&', '&amp;').replaceAll('’', '’');
const base: SchoolShellFrameProps = {
  path: '/staff/dashboard', language: 'en', phase: 'READY', selection: verified, schoolName: null,
  choices: [], mode: 'modern', viewState: 'LOCAL', menuOpen: false,
  onMode: () => {}, onMenu: () => {}, onSwitch: () => {}, onChoose: () => {}, onRestore: () => {},
};

describe('school guided tour', () => {
  it('walks welcome, every menu area in menu order, then a closing step', () => {
    expect(SCHOOL_TOUR_STEPS[0]).toEqual({ kind: 'welcome' });
    expect(SCHOOL_TOUR_STEPS.at(-1)).toEqual({ kind: 'finish' });
    expect(SCHOOL_TOUR_STEPS.slice(1, -1).map(step => step.kind === 'area' ? step.item.key : null)).toEqual(SCHOOL_SHELL_NAV.map(item => item.key));
  });

  it('says what every area is for in English, Korean and Spanish', () => {
    for (const language of ['en', 'ko', 'es']) {
      const c = tourCopy(language);
      for (const item of SCHOOL_SHELL_NAV) expect(c.areas[item.key].length).toBeGreaterThan(30);
      if (language !== 'en') for (const item of SCHOOL_SHELL_NAV) expect(c.areas[item.key]).not.toBe(tourCopy('en').areas[item.key]);
    }
  });

  it('opens on a welcome step with Back disabled and Next focused', () => {
    const html = dialog(0);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Welcome to HON OS');
    expect(html).toContain('1 of 10');
    expect(html).toMatch(/<button type="button" disabled="">Back<\/button>/);
    expect(html).toMatch(/data-tour-next=""[^>]*>Next</);
  });

  it('shows an area with what it holds and a link to it, prefilled for the verified school', () => {
    const html = dialog(1);
    expect(html).toContain('data-tour-step="home"');
    expect(html).toContain(esc(tourCopy('en').areas.home));
    expect(html).toContain(`href="/staff/dashboard?organizationId=${A}&amp;schoolId=${B}"`);
    expect(html).toContain('Open Home');
    const classes = dialog(1 + SCHOOL_SHELL_NAV.findIndex(item => item.key === 'classes'));
    for (const name of ['Schedule', 'Attendance', 'Curriculum &amp; testing', 'Community']) expect(classes).toContain(`<li>${name}</li>`);
    // A flat area lists its pages, never hidden onboarding routes.
    const home = schoolTourInside(SCHOOL_SHELL_NAV[0]!, 'en');
    expect(home).not.toContain(shellText('en', 'routeWelcome'));
  });

  it('ends with Done and never leaves the step range', () => {
    expect(dialog(SCHOOL_TOUR_STEPS.length - 1)).toMatch(/data-tour-next=""[^>]*>Done</);
    expect(dialog(99)).toContain('That is the tour');
    expect(dialog(-3)).toContain('Welcome to HON OS');
    expect(dialog(2, 'ko')).toContain(esc(tourCopy('ko').areas.students));
    expect(dialog(2, 'es')).toContain('Cerrar recorrido');
  });

  it('in the shell, is modal, outlines the area in the menu, and is offered from the Menu', () => {
    const open = renderToStaticMarkup(<SchoolShellFrame {...base} tourStep={2} onTour={() => {}}><p>page</p></SchoolShellFrame>);
    expect(open).toContain('data-school-tour=""');
    expect(open).toMatch(/data-nav="students"[^>]*data-tour-current="true"/);
    expect(open).toMatch(/class="[^"]*workspace[^"]*" inert=""/);
    const closed = renderToStaticMarkup(<SchoolShellFrame {...base}><p>page</p></SchoolShellFrame>);
    expect(closed).not.toContain('data-school-tour');
    expect(closed).not.toContain('data-tour-current');
    const menu = renderToStaticMarkup(<SchoolShellFrame {...base} menuOpen><p>page</p></SchoolShellFrame>);
    expect(menu).toMatch(/data-tour-start=""[^>]*>Take the tour</);
  });

  it('invites new staff from Home with a way to say not now', () => {
    const html = renderToStaticMarkup(<TourInviteView language="en" onStart={() => {}} onDismiss={() => {}} />);
    expect(html).toContain('New to HON OS?');
    expect(html).toContain('>Take the tour<');
    expect(html).toContain('>Not now<');
  });
});
