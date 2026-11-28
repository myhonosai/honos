import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en' } }) }));
import { SchoolHomeView, type SchoolHomeViewProps } from '../src/components/home/view';
import { HOME_LOADING } from '../src/components/home/model';
import { NOW, ORG, SCHOOL, ready } from './school-home-fixtures';

const root = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const web = (rel: string) => read(`apps/web/src/components/${rel}`);

describe('impeccable pass: one blue, readable text, honest landmarks', () => {
  it('the design tokens carry no cyan second accent and a blue focus ring', () => {
    const tokens = read('packages/design-system/src/tokens.css');
    expect(tokens).toMatch(/--hon-accent-2: #6fa5ff;/);
    expect(tokens).toMatch(/--hon-focus: 0 0 0 2px var\(--hon-bg\), 0 0 0 4px rgba\(47, 123, 255, 0\.9\);/);
    expect(tokens).not.toMatch(/34d6e8|52, 214, 232/);
  });

  it('white text only sits on the strong blue, and the Upgrade card uses real tokens', () => {
    const shell = web('school-shell/shell.module.css');
    expect(shell).not.toContain('--hon-color-');
    expect(shell).toMatch(/\.skip \{[^}]*background: var\(--hon-accent-strong\)/);
    expect(shell).toMatch(/\.planUpgrade \{[^}]*background: var\(--hon-accent-strong\)/);
    expect(shell).toMatch(/\.searchField:focus-within \{ box-shadow: var\(--hon-focus\); \}/);
    expect(web('school-shell/shell-global.css')).not.toContain('#050a18');
  });

  it('no text below 12px in the school shell, Home, team chat, HQ or Champions', () => {
    for (const file of ['school-shell/shell.module.css', 'home/home.module.css', 'hon-command/hon-command.module.css', 'hon-command/hon-team-chat.module.css',
      'hq-modern/hq-modern.module.css', 'hq-modern/champions-management.module.css', 'hq-modern/champions-school-rewards.module.css',
      'hq-modern/pricing-offers.module.css', 'hq-modern/pricing-plan-builder.module.css'])
      expect(web(file), file).not.toMatch(/font-size:\s?(?:[0-9]|1[01])(?:\.\d+)?px/);
  });

  it('HQ current page, focus and Champions use ink and blue, not the old teal', () => {
    const hq = web('hq-modern/hq-modern.module.css');
    const tail = hq.slice(hq.lastIndexOf('/* Impeccable pass'));
    expect(tail).toContain('.shell{--hon-accent-2:#6fa5ff;');
    expect(tail).toMatch(/\.navigation a\[aria-current=page\],\.moduleLinks a\[aria-current=page\]\{color:#eef0f5;background:#1a1e28;[^}]*box-shadow:none\}/);
    expect(hq).toContain(':is(a,button,summary,textarea,input,select):focus-visible');
    expect(hq).not.toMatch(/color:#(85dfff|8ce7ff|9cecff|a0eaff)/);
    for (const file of ['hq-modern/champions-management.module.css', 'hq-modern/champions-school-rewards.module.css']) {
      const css = web(file);
      expect(css, file).not.toMatch(/gradient/);
      expect(css, file).not.toMatch(/#(0c3446|a8f6fc|84e8f0|a1eff7|103548)/i);
    }
  });

  it('team chat buttons are the strong blue with no gradient or side stripe', () => {
    const chat = web('hon-command/hon-team-chat.module.css');
    expect(chat).not.toMatch(/linear-gradient/);
    expect(chat).not.toMatch(/border-left: 4px/);
    expect(chat).toMatch(/\.chat button \{[^}]*background: var\(--hon-accent-strong/);
  });

  it('custom tools pages have a main landmark', () => {
    expect(web('custom-tools/frame.tsx')).toContain('<main className={styles.page}');
  });

  it('Home says a shared team state once instead of on every card', () => {
    const base: SchoolHomeViewProps = { language: 'en', mode: 'modern', schoolName: 'Sunrise Taekwondo', selection: { organizationId: ORG, schoolId: SCHOOL }, sources: ready(), now: NOW };
    const mixed = renderToStaticMarkup(<SchoolHomeView {...base} />);
    expect(mixed.match(/class="[^"]*agentStatus/g)?.length ?? 0).toBeGreaterThan(1);
    const shared = renderToStaticMarkup(<SchoolHomeView {...base} sources={{ ...ready(), readiness: HOME_LOADING.readiness }} />);
    expect(shared.match(/class="[^"]*agentStatus/g)).toBeNull();
    expect(shared.match(/class="[^"]*teamStatus/g)?.length).toBe(1);
  });
});
