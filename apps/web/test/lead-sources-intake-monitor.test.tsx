import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadSourcesIntakeMonitor } from '../src/components/lead-sources-intake-monitor';
import { leadIntakeCopy } from '../src/components/lead-sources-intake-copy';
import { loadLeadIntakeMonitor } from '../src/components/public-form-client';

const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, pending: [] as (() => void)[] }));
const locale = vi.hoisted(() => ({ language: 'en' as 'en' | 'ko' | 'es' }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual,
    useState(initial: any) { const index = hooks.cursor++; if (!hooks.slots[index]) hooks.slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks.slots[index].value, (next: any) => { hooks.slots[index].value = typeof next === 'function' ? next(hooks.slots[index].value) : next; }]; },
    useRef(initial: any) { const index = hooks.cursor++; return hooks.slots[index] ??= { current: initial }; },
    useEffect(effect: () => any, deps: any[]) { const index = hooks.cursor++, old = hooks.slots[index]; if (!old || deps.some((value, i) => value !== old.deps[i])) { old?.cleanup?.(); hooks.slots[index] = { deps }; hooks.pending.push(() => { hooks.slots[index].cleanup = effect(); }); } }
  };
});
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: locale.language }, number: (value: number) => String(value) }) }));

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const monitorForm = { title: 'Website enquiries', status: 'PUBLISHED', acceptedCount: 7, hasCampaignAssociation: true } as const;
const genericForm = { id, publicId: 'a'.repeat(48), version: 2, status: 'PUBLISHED', title: 'Website enquiries', description: 'PRIVATE_CONFIGURATION', pipelineId: other, pipelineStageId: id, campaignId: other, optionalFields: ['ageBand'], acceptedCount: 7, updatedAt: '2026-10-25T00:00:00.000Z' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const listeners = new Map<string, () => void>();
const visibility = { state: 'visible' };
function render(): any { hooks.cursor = 0; return LeadSourcesIntakeMonitor(); }
function all(node: any): any[] { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(all); return [node, ...all(node.props?.children)]; }
function text(node: any): string { if (typeof node === 'string' || typeof node === 'number') return String(node); if (!node) return ''; if (Array.isArray(node)) return node.map(text).join(''); return text(node.props?.children); }
function button(tree: any, label: string): any { const found = all(tree).find(node => node.type === 'button' && text(node) === label); expect(found, label).toBeTruthy(); return found; }
function hrefs(tree: any): string[] { return all(tree).filter(node => node.type === 'a').map(node => node.props.href); }
async function settle(): Promise<void> { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
async function effects(): Promise<void> { for (const run of hooks.pending.splice(0)) run(); await settle(); }
function main(tree: any): any { const value = all(tree).find(node => node.type === 'main'); expect(value).toBeTruthy(); return value; }

beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.pending = []; locale.language = 'en'; listeners.clear(); visibility.state = 'visible';
  vi.stubGlobal('window', { location: { origin: 'http://hon.invalid' }, addEventListener: (name: string, callback: () => void) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name) });
  vi.stubGlobal('document', { get visibilityState() { return visibility.state; }, addEventListener: (name: string, callback: () => void) => listeners.set(`document:${name}`, callback), removeEventListener: (name: string) => listeners.delete(`document:${name}`) });
});
afterEach(() => { for (const slot of hooks.slots) slot?.cleanup?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Lead Sources & Intake Monitor', () => {
  it('starts idle with no automatic read, provider call, lead list, or mutable action', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const html = renderToStaticMarkup(render());
    expect(fetcher).not.toHaveBeenCalled();
    expect(html).toContain('No verified intake facts are loaded.');
    expect(html).toContain('NOT CONNECTED');
    expect(html).toContain('UNAVAILABLE');
    expect(html).toContain('CRM WON state is not enrollment or payment');
    expect(html).toContain('Modern HON');
    expect(html).toContain('Classic CRM');
    expect(html).toContain('Big-Button / Phone');
    expect(html).not.toContain('Website enquiries');
  });

  it('uses only the server-minimal same-origin monitor projection and rejects generic form configuration', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ data: [monitorForm] }));
    expect(await loadLeadIntakeMonitor()).toEqual([monitorForm]);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/marketing/forms/intake-monitor', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
    fetcher.mockResolvedValueOnce(response({ data: [genericForm] }));
    await expect(loadLeadIntakeMonitor()).rejects.toThrow('No verified intake-monitor response');
    fetcher.mockResolvedValueOnce(response({ data: [monitorForm] }));
    let tree = render();
    button(tree, 'Load authorized intake facts').props.onClick(); await settle(); tree = render();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('Website enquiries');
    expect(html).toContain('7 accepted new enquiries');
    expect(html).toContain('Campaign association recorded');
    expect(html).not.toContain(id);
    expect(html).not.toContain(other);
    expect(html).not.toContain('PRIVATE_CONFIGURATION');
    expect(html).not.toContain('ageBand');
  });

  it('clears stale monitor facts on denied or unavailable response and never renders server error text', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ data: [monitorForm] }));
    let tree = render();
    button(tree, 'Load authorized intake facts').props.onClick(); await settle(); tree = render();
    expect(text(tree)).toContain('Website enquiries');
    fetcher.mockResolvedValueOnce(response({ detail: 'PRIVATE_CONTACT should never render' }, 403));
    button(tree, 'Load authorized intake facts').props.onClick(); await settle(); tree = render();
    let html = renderToStaticMarkup(tree);
    expect(html).toContain('Current human school permission is required');
    expect(html).not.toContain('Website enquiries');
    expect(html).not.toContain('PRIVATE_CONTACT');
    fetcher.mockResolvedValueOnce(response({ detail: 'PRIVATE_PROVIDER failure' }, 503));
    button(tree, 'Load authorized intake facts').props.onClick(); await settle(); tree = render();
    html = renderToStaticMarkup(tree);
    expect(html).toContain('Current intake facts are unavailable');
    expect(html).not.toContain('PRIVATE_PROVIDER');
  });

  it('clears and invalidates an in-flight read on browser privacy boundaries', async () => {
    let resolve: (value: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    let tree = render(); await effects();
    button(tree, 'Load authorized intake facts').props.onClick();
    listeners.get('blur')?.();
    resolve(response({ data: [monitorForm] })); await settle(); tree = render();
    expect(renderToStaticMarkup(tree)).toContain('No verified intake facts are loaded.');
    expect(renderToStaticMarkup(tree)).not.toContain('Website enquiries');
    visibility.state = 'hidden'; listeners.get('document:visibilitychange')?.(); tree = render();
    expect(renderToStaticMarkup(tree)).toContain('No verified intake facts are loaded.');
  });

  it('changes only local presentation density after an authorized read', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ data: [monitorForm] }));
    let tree = render();
    button(tree, 'Load authorized intake facts').props.onClick(); await settle(); tree = render();
    const expectedLinks = hrefs(tree); const requested = fetcher.mock.calls.length;
    expect(main(tree).props['data-presentation']).toBe('modern');
    button(tree, 'Classic CRM').props.onClick(); tree = render();
    expect(main(tree).props['data-presentation']).toBe('classic');
    expect(text(tree)).toContain('Website enquiries'); expect(hrefs(tree)).toEqual(expectedLinks);
    button(tree, 'Big-Button / Phone').props.onClick(); tree = render();
    expect(main(tree).props['data-presentation']).toBe('big-button');
    expect(text(tree)).toContain('Website enquiries'); expect(hrefs(tree)).toEqual(expectedLinks);
    expect(fetcher.mock.calls).toHaveLength(requested);
  });

  it('renders Korean and Spanish chrome rather than English fallbacks while retaining unavailable provider truthfulness', () => {
    locale.language = 'ko'; let html = renderToStaticMarkup(render());
    expect(html).toContain('직원 탐색'); expect(html).toContain('연결되지 않음'); expect(html).toContain('통제된 다음 단계'); expect(html).not.toContain('Staff navigation');
    locale.language = 'es'; html = renderToStaticMarkup(render());
    expect(html).toContain('Navegación del personal'); expect(html).toContain('SIN CONEXIÓN'); expect(html).toContain('Siguientes pasos gobernados'); expect(html).not.toContain('Staff navigation');
    for (const language of ['en', 'ko', 'es'] as const) {
      const value = leadIntakeCopy(language);
      expect(value.zernioBody).not.toMatch(/connected account|live sync/i);
      expect(value.googleBody).toMatch(/Google/);
      expect(value.conversionUnavailable).toBeTruthy();
    }
  });

  it('keeps the route manifest and source free of persistence, AI, provider and generic CRM/form-list implementation', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    const component = readFileSync('src/components/lead-sources-intake-monitor.tsx', 'utf8');
    const css = readFileSync('src/components/lead-sources-intake-monitor.module.css', 'utf8');
    const route = readFileSync('src/app/staff/marketing/intake/page.tsx', 'utf8');
    expect(manifest.routes.filter((entry: { path: string }) => entry.path === '/staff/marketing/intake')).toHaveLength(1);
    expect(route).toContain("dynamic = 'force-dynamic'");
    expect(component).toContain('loadLeadIntakeMonitor');
    expect(component).not.toMatch(/StaffLeadForm|formStaffRequest|localStorage|sessionStorage|invokeLLM|ActionEngine|PaymentService|loadCrmLeads|fetch\(/);
    expect(css).toContain('.bigButton'); expect(css).toContain('.classic'); expect(css).toContain('.modern');
  });
});
