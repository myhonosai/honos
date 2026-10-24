import React, { type ReactElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CrmEnrollmentDiscard } from '../src/components/crm-enrollment-discard';
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
  useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return [hooks.values[i], (value: unknown) => { hooks.values[i] = value; }]; },
  useEffect: (effect: () => void, dependencies: unknown[]) => { const i = hooks.cursor++, old = hooks.values[i] as unknown[] | undefined; if (!old || dependencies.some((v,j) => v !== old[j])) { hooks.values[i] = dependencies; hooks.effects.push(effect); } },
}; });
type Element = ReactElement<Record<string, any>>;
function elements(n: unknown): Element[] { if (Array.isArray(n)) return n.flatMap(elements); if (React.isValidElement(n)) return [n as Element, ...elements((n as Element).props.children)]; return []; }
let disabled: boolean; const onDiscard = vi.fn();
function render(): Element { hooks.cursor=0; const tree=CrmEnrollmentDiscard({disabled,onDiscard}); hooks.effects.splice(0).forEach(run=>run()); return tree as Element; }
const button = () => elements(render()).find(e=>e.type==='button')!;
const agree = () => elements(render()).find(e=>e.type==='input')!.props.onChange({target:{checked:true}});
beforeEach(()=>{hooks.values=[];hooks.cursor=0;hooks.effects=[];disabled=false;onDiscard.mockClear();});
it('requires deliberate acknowledgement and explains that Discard neither cancels nor undoes a server action',()=>{
  const tree=render(); expect(JSON.stringify(tree)).toContain('does not cancel or undo'); expect(button().props.disabled).toBe(true);
  button().props.onClick(); expect(onDiscard).not.toHaveBeenCalled(); agree(); expect(button().props.disabled).toBe(false); button().props.onClick(); expect(onDiscard).toHaveBeenCalledOnce(); expect(button().props.disabled).toBe(true);
});
it('disables Discard while unsettled and requires a new acknowledgement after settlement',()=>{
  agree();disabled=true;render();expect(button().props.disabled).toBe(true);button().props.onClick();expect(onDiscard).not.toHaveBeenCalled();disabled=false;render();expect(button().props.disabled).toBe(true);
});
