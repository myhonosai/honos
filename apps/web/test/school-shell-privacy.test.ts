import { describe, expect, it } from 'vitest';
import { SHELL_PRIVATE_ATTRIBUTE, concealShellPrivateNow } from '../src/components/school-shell/privacy';

describe('school shell privacy', () => {
  it('hides and inerts every marked node at once, without waiting for a render', () => {
    const nodes = [{ hidden: false, inert: false }, { hidden: false, inert: false }];
    let selector = '';
    concealShellPrivateNow({ querySelectorAll: (value: string) => { selector = value; return nodes; } } as unknown as ParentNode);
    expect(selector).toBe(`[${SHELL_PRIVATE_ATTRIBUTE}]`);
    expect(nodes.every(node => node.hidden && node.inert)).toBe(true);
  });
});
