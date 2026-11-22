import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentVoiceBar, appendHeard } from '../src/components/hon-command/agent-voice-bar';

const recognition = { start: () => ({ stop() {}, abort() {} }) };
const speech = { speak() {}, cancel() {} };
const bar = (deps: import('../src/components/hon-command/agent-voice-bar').AgentVoiceDeps, answer: string | null = null) =>
  renderToStaticMarkup(<AgentVoiceBar agentKey="maya" name="Maya" value="" max={300} onChange={() => undefined} answer={answer} deps={deps} />);

it('adds what was heard to what is already typed, within the box limit', () => {
  expect(appendHeard('', '  summer   break starts soon ', 300)).toBe('summer break starts soon');
  expect(appendHeard('Belt test', 'is on Saturday', 300)).toBe('Belt test is on Saturday');
  expect(appendHeard('abc', '', 300)).toBe('abc');
  expect(appendHeard('x'.repeat(298), 'hello', 300)).toHaveLength(300);
});

it('offers Speak when the browser can listen and Hear only when there is an answer', () => {
  expect(bar({ recognition, speech })).toContain('aria-label="Speak to Maya"');
  expect(bar({ recognition, speech })).not.toContain('Hear Maya');
  expect(bar({ recognition, speech }, 'Two renewals this month.')).toContain('Hear Maya');
  expect(bar({ recognition: null, speech }, 'Two renewals.')).not.toContain('Speak to Maya');
  expect(bar({ recognition: null, speech: null }, 'x')).toBe('');
});

it('is on every agent panel, and voice never presses the panel buttons', () => {
  for (const [file, key] of [['alex-plan-panel', 'alex'], ['jordan-follow-up-panel', 'jordan'], ['marcus-review-panel', 'marcus'], ['claire-kpi-panel', 'claire'], ['maya-renewal-panel', 'maya']]) {
    const src = readFileSync(join(__dirname, `../src/components/hon-command/${file}.tsx`), 'utf8');
    expect(src).toContain(`<AgentVoiceBar agentKey="${key}"`);
  }
  const bar = readFileSync(join(__dirname, '../src/components/hon-command/agent-voice-bar.tsx'), 'utf8');
  expect(bar).not.toMatch(/\.submit\(|requestSubmit\(|onApply|\.approve\(|decide\(/);
});
