import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/components/hon-reference-suite.tsx', 'utf8');
const styles = readFileSync('src/components/hon-reference-suite.module.css', 'utf8');

describe('HON AI portrait presentation variants', () => {
  it('keeps all approved team members available in each requested reference style', () => {
    for (const style of ['realistic', 'anime', 'chibi']) {
      for (const agent of ['alex', 'chad', 'maya', 'marcus', 'jordan', 'claire', 'lena']) {
        expect(source).toContain(`${style}:`);
        expect(source).toContain(`${agent}: '/manus-storage/async-images/`);
      }
    }
    for (const label of ['3D Realistic', 'Modern Anime', 'Chibi Cute']) expect(source).toContain(label);
  });

  it('applies a selected style across modern, classic, big-button, HQ, and mobile reference presentations', () => {
    for (const text of ['portraitFor(agent, portraitStyle)', 'PortraitStyleSwitcher', 'classicAgentStack', 'portraitStyle={portraitStyle}', 'AgentVisual agent={member}']) expect(source).toContain(text);
    expect(styles).toContain('.portraitStyleSwitcher');
    expect(styles).toContain('.classicAgentStack');
  });

  it('states and preserves the presentation-only boundary', () => {
    expect(source).toContain('Presentation assets only · agent identity, authority, routes, and tools never change.');
    expect(source).toContain('onError={() => setFailed(true)}');
    expect(source).toContain('portraitFallback');
    expect(styles).toContain('.portraitFallback');
    expect(styles).toContain('.heroPortraitFallback');
    expect(source).not.toMatch(/portraitStyle.*(?:modelId|providerId|toolGrant|authorityMode)/s);
  });
});
