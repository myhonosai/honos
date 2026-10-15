import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AchievementsWorkbench } from '../src/components/achievements-workbench';
import { ParentAchievements } from '../src/components/parent-achievements';
import { AchievementAccessError, loadAchievementAccess, loadAchievementAwards, loadAchievementDefinitions, loadAchievementHistory, loadParentAchievements, saveAchievement } from '../src/components/achievements-http';

const school = '11111111-1111-4111-8111-111111111111';
const student = '22222222-2222-4222-8222-222222222222';
const family = '33333333-3333-4333-8333-333333333333';
const definitionId = '44444444-4444-4444-8444-444444444444';
const awardId = '55555555-5555-4555-8555-555555555555';
const principal = '66666666-6666-4666-8666-666666666666';
const correctingPrincipal = '77777777-7777-4777-8777-777777777777';
const definition = { id: definitionId, version: 1, name: 'Careful practice', description: 'Recognition of sustained effort.', category: 'EFFORT', ageBand: 'CHILD', visualToken: 'RIBBON', status: 'ACTIVE' } as const;
const award = { id: awardId, version: 2, studentProfileId: student, definitionId, definitionVersion: 1, awardedByPrincipalId: principal, recordedByPrincipalId: correctingPrincipal, recordedAt: '2026-01-10T12:00:00.000Z', reason: 'Private staff observation', awardedOn: '2026-01-10', visibleToFamily: true, status: 'AWARDED', definition } as const;
const definitionInput = { expectedVersion: 0, name: definition.name, description: definition.description, category: definition.category, ageBand: definition.ageBand, visualToken: definition.visualToken, status: definition.status } as const;
const awardInput = { expectedVersion: 0, definitionId, definitionVersion: 1, reason: 'Private staff observation', awardedOn: '2026-01-10', visibleToFamily: true, status: 'AWARDED' } as const;
const response = (data: unknown) => ({ ok: true, json: async () => ({ data }) }) as Response;

describe('human student achievements UI', () => {
  it('starts empty without a network call, directory, auto-award, social, or execution controls', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const staff = renderToStaticMarkup(<AchievementsWorkbench/>);
      const parent = renderToStaticMarkup(<ParentAchievements/>);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const text of ['Recognize effort. Keep judgment human.', 'Known school and student', 'No child social feed, AI, actions, providers, communications or payments.', 'These selectors are not authorization']) expect(staff).toContain(text);
      for (const text of ['Your child’s human-recorded achievements', 'No social feed or sibling records.', 'Private staff reasons and revision history are never shared here.', 'Current authorized child']) expect(parent).toContain(text);
      expect(staff).not.toContain('Careful practice');
      expect(parent).not.toContain('Private staff observation');
      expect(staff).not.toMatch(/type="(?:email|file)"/);
    } finally { fetchSpy.mockRestore(); }
  });

  it('uses only exact same-origin read, parent, and explicitly human save routes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ canReadDefinitions: true, canManageDefinitions: true, canReadAwards: true, canRecordAwards: true }));
    try {
      await expect(loadAchievementAccess(school)).resolves.toEqual({ canReadDefinitions: true, canManageDefinitions: true, canReadAwards: true, canRecordAwards: true });
      expect(fetchSpy).toHaveBeenLastCalledWith(`/api/v1/staff/students/achievements/access?schoolId=${school}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
      fetchSpy.mockResolvedValue(response({ items: [definition], nextAfter: null }));
      await expect(loadAchievementDefinitions(school)).resolves.toEqual({ items: [definition], nextAfter: null });
      fetchSpy.mockResolvedValue(response({ items: [award], nextAfter: null }));
      await expect(loadAchievementAwards(school, student)).resolves.toEqual({ items: [award], nextAfter: null });
      fetchSpy.mockResolvedValue(response({ id: awardId, items: [award], nextBefore: null }));
      await expect(loadAchievementHistory(school, 'AWARD', awardId, student)).resolves.toEqual({ id: awardId, items: [award], nextBefore: null });
      fetchSpy.mockResolvedValue(response({ studentProfileId: student, items: [{ id: awardId, awardedOn: award.awardedOn, definition }], nextAfter: null }));
      await expect(loadParentAchievements(school, family, student)).resolves.toEqual({ items: [{ id: awardId, awardedOn: award.awardedOn, definition }], nextAfter: null });
      expect(fetchSpy).toHaveBeenLastCalledWith(`/api/v1/parent/students/${student}/achievements?schoolId=${school}&familyId=${family}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));

      const create = { op: 'DEFINITION' as const, id: null, input: definitionInput };
      const createdDefinition = { ...definition, version: 1 };
      fetchSpy.mockResolvedValue({ ok: false, status: 503 } as Response);
      await expect(saveAchievement(school, create, 'retained-key')).rejects.toThrow('No verified result');
      fetchSpy.mockResolvedValue(response(createdDefinition));
      await expect(saveAchievement(school, create, 'retained-key')).resolves.toEqual(createdDefinition);
      const previous = fetchSpy.mock.calls.at(-2), last = fetchSpy.mock.calls.at(-1);
      expect(last).toEqual(previous);
      expect(last).toEqual([`/api/v1/staff/students/achievements/definitions?schoolId=${school}`, expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(definitionInput), headers: expect.objectContaining({ 'X-HON-Human-Command': 'student-achievements', 'Idempotency-Key': 'retained-key' }) })]);

      const createAward = { op: 'AWARD' as const, id: null, student, input: awardInput };
      const createdAward = { ...award, version: 1, recordedByPrincipalId: principal };
      fetchSpy.mockResolvedValue(response(createdAward));
      await expect(saveAchievement(school, createAward, 'award-key')).resolves.toEqual(createdAward);
      expect(fetchSpy).toHaveBeenLastCalledWith(`/api/v1/staff/students/achievements/students/${student}/awards?schoolId=${school}`, expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'X-HON-Human-Command': 'student-achievements', 'Idempotency-Key': 'award-key' }) }));
    } finally { fetchSpy.mockRestore(); }
  });

  it('fails closed on forged attribution, private parent data, invalid paths, and access loss', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ items: [award], nextAfter: null }));
    try {
      await expect(loadAchievementAwards(school, student)).resolves.toEqual({ items: [award], nextAfter: null });
      for (const patch of [{ awardedByPrincipalId: 'not-a-uuid' }, { recordedByPrincipalId: 'not-a-uuid' }, { actorEmail: 'private@example.test' }, { score: 100 }, { definition: { ...definition, status: 'ARCHIVED' } }]) {
        fetchSpy.mockResolvedValue(response({ items: [{ ...award, ...patch }], nextAfter: null }));
        await expect(loadAchievementAwards(school, student)).rejects.toThrow();
      }
      fetchSpy.mockResolvedValue(response({ studentProfileId: student, items: [{ id: awardId, awardedOn: award.awardedOn, definition, reason: 'PRIVATE' }], nextAfter: null }));
      await expect(loadParentAchievements(school, family, student)).rejects.toThrow();
      fetchSpy.mockResolvedValue({ ok: false, status: 403 } as Response);
      await expect(loadAchievementAccess(school)).rejects.toBeInstanceOf(AchievementAccessError);
      const count = fetchSpy.mock.calls.length;
      for (const unsafe of ['https://evil.test', '../achievements', `${school}?after=${awardId}`]) await expect(loadAchievementAccess(unsafe)).rejects.toThrow();
      expect(fetchSpy.mock.calls.length).toBe(count);
    } finally { fetchSpy.mockRestore(); }
  });

  it('clears scope on failures, keeps retries manual, presents original/revision attribution only to staff, and protects non-indexable routes', () => {
    const workbench = readFileSync('src/components/achievements-workbench.tsx', 'utf8');
    for (const text of ['setAccess(null)', 'setDefinitions([])', 'setAwards([])', 'setHistory(null)', 'setPending(null)', 'generation.current !== token', 'Retry unchanged request', 'Nothing is automatically retried', 'Originally awarded by human principal', 'This revision was recorded by human principal', 'Private staff reason']) expect(workbench).toContain(text);
    expect(workbench).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|executeAction|dangerouslySetInnerHTML|fetch\(['"]https?:\/\//);
    const parent = readFileSync('src/components/parent-achievements.tsx', 'utf8');
    expect(parent).not.toMatch(/\.reason|reason\s*:|recordedByPrincipalId|awardedByPrincipalId|items\.map\([^)]*version/);
    const staffRoute = readFileSync('src/app/staff/students/achievements/page.tsx', 'utf8');
    const parentRoute = readFileSync('src/app/parent/achievements/page.tsx', 'utf8');
    for (const route of [staffRoute, parentRoute]) for (const text of ['verifySession', "redirect('/auth/login')", 'index: false', 'force-dynamic']) expect(route).toContain(text);
    const http = readFileSync('src/components/achievements-http.ts', 'utf8');
    expect(http).toContain("credentials: 'same-origin'");
    expect(http).not.toMatch(/https:\/\/|provider|invokeLLM|executeAction|sendMessage|payment/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((route: { path: string }) => route.path === '/staff/students/achievements')).toHaveLength(1);
    expect(manifest.routes.filter((route: { path: string }) => route.path === '/parent/achievements')).toHaveLength(1);
  });
});
