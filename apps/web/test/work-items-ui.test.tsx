import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { WorkItemsWorkbench } from '../src/components/work-items-workbench';
import { WorkAccessError, loadHumanWork, mutateHumanWork, readHumanWork } from '../src/components/work-items-http';

const school = '11111111-1111-4111-8111-111111111111';
const principal = '22222222-2222-4222-8222-222222222222';
const workItemId = '33333333-3333-4333-8333-333333333333';
const planId = '44444444-4444-4444-8444-444444444444';
const createdAt = '2026-10-15T16:00:00.000Z';
const queueItem = { title: 'Inspect mats', workItemId, version: 1, status: 'READY', priority: 'NORMAL', dueAt: null, assigneeId: principal };
const queue = { schoolId: school, principalId: principal, canManage: false, canCreate: true, humanOnly: true, executionAllowed: false, queue: 'mine' as const, status: 'ACTIVE' as const, items: [queueItem], nextAfter: null };
const record = { ...queueItem, schoolId: school, description: 'Inspect the clean training area.', createdBy: principal, createdAt, updatedAt: createdAt, humanOnly: true as const, executionAllowed: false as const, canEdit: false, canTransition: true, aiPlanIds: [planId], history: [{ version: 1, operation: 'CREATE', status: 'READY', assigneeId: principal, actorId: principal, recordedAt: createdAt }], nextBeforeVersion: null };
const response = (data: unknown) => ({ ok: true, json: async () => ({ data }) }) as Response;

describe('human work-item workbench', () => {
 it('starts empty and truthful, without AI execution, a directory, scheduling, or a network request', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  try {
   const html = renderToStaticMarkup(<WorkItemsWorkbench />);
   expect(fetchSpy).not.toHaveBeenCalled();
   for (const text of ['Human work, not an AI execution queue.', 'Authorized school queue', 'Load / refresh queue', 'Due dates are UTC planning metadata only.', 'No AI, Action Engine, payments, marketing or communication execution.']) expect(html).toContain(text);
   expect(html).not.toContain('Inspect mats');
   expect(html).not.toContain('provider connected');
   expect(html).not.toMatch(/type="(?:email|file)"/);
  } finally { fetchSpy.mockRestore(); }
 });

 it('uses only fixed same-origin work routes and verifies queue/detail/create responses', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(queue));
  vi.stubGlobal('fetch', fetcher);
  try {
   expect(await loadHumanWork('mine', 'ACTIVE')).toEqual(queue);
   expect(fetcher).toHaveBeenLastCalledWith('/api/v1/staff/work?queue=mine&status=ACTIVE', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
   fetcher.mockResolvedValue(response(record));
   expect(await readHumanWork(workItemId)).toEqual(record);
   expect(fetcher).toHaveBeenLastCalledWith(`/api/v1/staff/work/${workItemId}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
   const input = { expectedVersion: 0, title: queueItem.title, description: record.description, priority: 'NORMAL' as const, dueAt: null, assigneeId: principal };
   expect(await mutateHumanWork('CREATE', null, input, 'retained-key')).toEqual(record);
   const [url, options] = fetcher.mock.calls.at(-1)!;
   expect(url).toBe('/api/v1/staff/work');
   expect(options).toEqual(expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: expect.objectContaining({ 'X-HON-Human-Command': 'human-work', 'Idempotency-Key': 'retained-key' }) }));
   expect(JSON.parse(options.body)).toEqual(input);
   const calls = fetcher.mock.calls.length;
   for (const unsafe of ['https://evil.test', '../work', `${workItemId}?schoolId=${school}`]) await expect(readHumanWork(unsafe)).rejects.toThrow();
   expect(fetcher.mock.calls).toHaveLength(calls);
  } finally { vi.unstubAllGlobals(); }
 });

 it('fails closed on expanded, forged, cross-scope, terminal, and denied responses', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  try {
   for (const patch of [
    { humanOnly: false }, { executionAllowed: true }, { items: [{ ...queueItem, description: 'private' }] },
    { items: [{ ...queueItem, status: 'COMPLETED' }] }, { nextAfter: workItemId }, { principalId: 'not-a-uuid' },
   ]) { fetcher.mockResolvedValue(response({ ...queue, ...patch })); await expect(loadHumanWork('mine', 'ACTIVE')).rejects.toThrow(); }
   for (const patch of [
    { executionAllowed: true }, { aiPlanIds: [planId, planId] }, { history: [{ ...record.history[0], actorId: 'not-a-uuid' }] },
    { status: 'COMPLETED', canTransition: true }, { providerResult: 'private' }, { schoolId: 'not-a-uuid' },
   ]) { fetcher.mockResolvedValue(response({ ...record, ...patch })); await expect(readHumanWork(workItemId)).rejects.toThrow(); }
   fetcher.mockResolvedValue({ ok: false, status: 403, json: async () => ({ detail: 'PRIVATE_DIRECTORY' }) } as Response);
   await expect(loadHumanWork('mine', 'ACTIVE')).rejects.toBeInstanceOf(WorkAccessError);
  } finally { vi.unstubAllGlobals(); }
 });

 it('retains only manual in-memory retries, protects the page, and preserves the legacy planner as a fixed reference lock', () => {
  const workbench = readFileSync(new URL('../src/components/work-items-workbench.tsx', import.meta.url), 'utf8');
  for (const text of ['retry.current', 'Retry exact retained request', 'Discard retry and clear private view', 'setSelected(null)', 'No AI execution or AI employee completion is implied', 'Reload current detail']) expect(workbench).toContain(text);
  expect(workbench).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|executeAction|fetch\(['"]https?:\/\//);
  const page = readFileSync(new URL('../src/app/staff/work/page.tsx', import.meta.url), 'utf8');
  for (const text of ['verifySession', "redirect('/auth/login')", 'force-dynamic', 'index: false']) expect(page).toContain(text);
  const planner = readFileSync(new URL('../../api/src/ai/ai-invocation-plan.service.ts', import.meta.url), 'utf8');
  expect(planner).toContain('hon.lock_ai_planning_work_reference($1::uuid)');
  expect(planner).not.toContain('FROM hon.work_items');
  expect(planner).not.toMatch(/invokeProvider|ActionEngineService|executeAction|fetch\(['"]https?:\/\//);
  const manifest = JSON.parse(readFileSync(new URL('../public/manus-routes.json', import.meta.url), 'utf8'));
  expect(manifest.routes.filter((route: { path: string }) => route.path === '/staff/work')).toHaveLength(1);
 });
});
