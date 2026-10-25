import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ActionReviewItem, AiDraftWorkItem, SchoolCommandCenterSnapshot } from '@hon/contracts';
import { HON_AI_TEAM } from '@hon/design-system';
import { CommandCenterAccessError } from '../src/components/command-center-http';
import { ActionReviewAccessError } from '../src/components/action-approvals-http';
import { HonCommandController, initialHonCommandSnapshot, type HonCommandApi, type HonCommandSnapshot } from '../src/components/hon-command/hon-command-data';
import { HON_CONVERSATION_BOUNDARY, HON_TURN_STATUSES, honComposerEnabled, honTurnStatusPresentation } from '../src/components/hon-command/hon-conversation';
import { HonLauncher, HonTeamBand, honExpandHref } from '../src/components/hon-command/hon-command';
import { HonWorkspaceView, type HonTab } from '../src/components/hon-command/hon-workspace-view';
import { HON_COMMAND_ROSTER, HON_DRAFT_WORK_SOURCES, HON_TEACHING_AI, HON_TEACHING_AI_PORTRAITS, approvalSourceLabel, safeHonReturnPath, teachingAiPortrait } from '../src/components/hon-command/roster';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { organizationId: id(1), schoolId: id(2) };
const work = (n: number, agentKey: AiDraftWorkItem['agentKey'], schoolId = scope.schoolId, status: AiDraftWorkItem['status'] = 'AWAITING_APPROVAL'): AiDraftWorkItem => ({ id: id(n), agentKey, schoolId, sourceRecordId: id(n + 100), workItemId: id(n + 200), status, reason: null, actionRequestId: id(n + 300), updatedAt: '2026-10-24T12:00:00.000Z' });
const approval = (n: number, actionCode: string): ActionReviewItem => ({ id: id(n), actionCode, status: 'AWAITING_APPROVAL', requestedByPrincipalId: id(60), effectiveAuthorityMode: 'CONFIRM', policyVersion: 1, approvalExpiresAt: '2026-10-26T12:00:00.000Z', createdAt: '2026-10-24T12:00:00.000Z' });
function commandCenter(recommendations = true, tier: SchoolCommandCenterSnapshot['entitlementTier'] = 'COMPLETE'): SchoolCommandCenterSnapshot {
  const window = { availability: 'AVAILABLE' as const, windowFrom: '2026-10-23T12:00:00.000Z', windowTo: '2026-10-24T12:00:00.000Z', count: 0 };
  const unavailable = { availability: 'UNAVAILABLE' as const, reason: 'x' };
  return {
    ...scope, entitlementTier: tier, generatedAt: '2026-10-24T12:00:00.000Z',
    metrics: { newLeads24h: window, upcomingTrials24h: window, upcomingTestingEvents30d: window, pendingActionApprovals: { availability: 'AVAILABLE', count: 2 }, outstandingWorkItems: { availability: 'AVAILABLE', count: 0 }, membershipTermsEnding30d: window, paidInvoicesCreated30d: { ...window, amountsByCurrency: [] }, unansweredInquiries: unavailable, attendanceDecline: { availability: 'INSUFFICIENT_DATA', reason: 'x' }, trialConversion: unavailable, revenue: unavailable },
    dailyBriefing: 'Daily briefing: 2 action approvals awaiting review.',
    recommendations: recommendations ? [{ id: 'REVIEW_PENDING_APPROVALS', title: 'Review pending approvals', why: '2 current action requests are awaiting a qualified human review.', route: '/staff/action-center/approvals', action: 'NAVIGATE', automaticExecution: false }] : [],
  } as SchoolCommandCenterSnapshot;
}
function api(overrides: Partial<HonCommandApi> = {}): HonCommandApi & Record<string, ReturnType<typeof vi.fn>> {
  return {
    resolveScope: vi.fn(async () => ({ state: 'RESOLVED' as const, ...scope })),
    theme: vi.fn(async () => 'classic' as const),
    commandCenter: vi.fn(async () => commandCenter()),
    draftWork: vi.fn(async () => ({ items: [work(31, 'chad'), work(32, 'marcus'), work(33, 'claire'), work(34, 'chad', id(99))], unavailable: [] })),
    approvals: vi.fn(async () => ({ items: [approval(41, 'crm.follow_up_draft.propose'), approval(42, 'teaching.draft.save')], more: false })),
    ...overrides,
  } as HonCommandApi & Record<string, ReturnType<typeof vi.fn>>;
}
async function loaded(overrides: Partial<HonCommandApi> = {}, dashboardScope: typeof scope | null = scope) {
  const value = api(overrides); const controller = new HonCommandController(value);
  await controller.open(dashboardScope, { loadTheme: dashboardScope === null });
  return { controller, api: value, snapshot: controller.snapshot() };
}
function view(snapshot: HonCommandSnapshot, tab: HonTab = 'team', selectedAgentId: string | null = null, variant: 'modern' | 'big-button' | 'classic' = 'modern') {
  return renderToStaticMarkup(<HonWorkspaceView snapshot={snapshot} variant={variant} presentation="panel" tab={tab} selectedAgentId={selectedAgentId} headingId="t" expandHref="/staff/hon?return=%2Fstaff%2Fdashboard" />);
}

describe('HON command roster', () => {
  it('preserves the seven approved identities, roles and original portraits in order', () => {
    expect(HON_COMMAND_ROSTER.map((agent) => [agent.name, agent.title, agent.portrait])).toEqual(HON_AI_TEAM.map((member) => [member.name, member.title, member.portrait]));
    expect(HON_COMMAND_ROSTER.map((agent) => `${agent.name} — ${agent.title}`)).toEqual([
      'Alex — General Manager', 'Chad — Enrollment Director', 'Maya — Student Success Manager', 'Marcus — Marketing Director',
      'Jordan — Operations Manager', 'Claire — Business Performance Manager', 'Lena — Creative & Commerce Manager',
    ]);
  });

  it('marks only Chad and Marcus as having real governed draft workspaces', () => {
    expect(HON_COMMAND_ROSTER.filter((agent) => agent.availability === 'GOVERNED_DRAFTS').map((agent) => agent.id)).toEqual(['chad', 'marcus']);
    expect(HON_COMMAND_ROSTER.filter((agent) => agent.workspace).map((agent) => agent.workspace!.href)).toEqual(['/staff/leads/assistant', '/staff/marketing/assistant']);
    for (const agent of HON_COMMAND_ROSTER.filter((item) => item.availability === 'PLANNED')) {
      expect(agent.capabilities.every((capability) => capability.state === 'BACKEND_REQUIRED' && !capability.href), agent.id).toBe(true);
      expect(agent.draftWorkKey).toBeNull();
    }
  });

  it('never maps the legacy claire draft key to Claire or to the teaching assistant from her card', () => {
    const claire = HON_COMMAND_ROSTER.find((agent) => agent.id === 'claire')!;
    expect(claire.title).toBe('Business Performance Manager');
    expect(claire.draftWorkKey).toBeNull();
    expect(JSON.stringify(claire)).not.toMatch(/teaching|curriculum/i);
    expect(HON_DRAFT_WORK_SOURCES.claire).toEqual(expect.objectContaining({ agentId: null, destination: '/staff/teaching-assistant', label: 'Teaching draft assistant (legacy)' }));
    expect(approvalSourceLabel('teaching.draft.save')).toBe('Teaching draft assistant (legacy)');
    expect(approvalSourceLabel('crm.follow_up_draft.propose')).toBe('Chad · Follow-up draft');
    expect(approvalSourceLabel('marketing.draft.save')).toBe('Marcus · Marketing draft');
    expect(approvalSourceLabel('anything.else')).toBe('School workflow');
  });

  it('links only to existing staff routes', () => {
    const hrefs = HON_COMMAND_ROSTER.flatMap((agent) => [...agent.workflows.map((w) => w.href), ...agent.capabilities.flatMap((c) => c.href ? [c.href] : []), ...(agent.workspace ? [agent.workspace.href] : [])]);
    hrefs.push(...Object.values(HON_DRAFT_WORK_SOURCES).map((source) => source.destination), HON_CONVERSATION_BOUNDARY.handoff.href, ...HON_TEACHING_AI.tools.map((tool) => tool.href));
    for (const href of new Set(hrefs)) expect(existsSync(join('src/app', href, 'page.tsx')), href).toBe(true);
  });

  it('keeps the provisional Teaching AI separate from the seven and from legacy claire records', () => {
    expect(HON_AI_TEAM.map((member) => member.name)).not.toContain(HON_TEACHING_AI.name);
    expect(HON_COMMAND_ROSTER.map((agent) => agent.name)).not.toContain(HON_TEACHING_AI.name);
    expect(HON_COMMAND_ROSTER).toHaveLength(7);
    expect(JSON.stringify(HON_DRAFT_WORK_SOURCES)).not.toContain(HON_TEACHING_AI.name);
    expect(approvalSourceLabel('teaching.draft.save')).not.toContain(HON_TEACHING_AI.name);
    expect(HON_TEACHING_AI.boundary).toMatch(/never mark student proficiency, promotions, testing results or curriculum completion/);
    expect(HON_TEACHING_AI.portrait).toBe('/ai/kai.webp');
    expect(existsSync(join('public', HON_TEACHING_AI.portrait))).toBe(true);
    expect(HON_AI_TEAM.map((member) => member.portrait)).not.toContain(HON_TEACHING_AI.portrait);
    expect(HON_TEACHING_AI.tools.map((tool) => tool.label)).toEqual(['Teaching Studio', 'Curriculum library', 'Curriculum progress', 'Scheduled classes', 'Teaching draft assistant (legacy)']);
  });

  it('maps only server-reported conversation states and keeps the composer off without full readiness', () => {
    expect(HON_TURN_STATUSES).toEqual(['READY', 'PROCESSING', 'DELEGATING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'UNKNOWN']);
    expect(honTurnStatusPresentation('AWAITING_APPROVAL')).toEqual(expect.objectContaining({ status: 'AWAITING_APPROVAL', label: 'Awaiting approval' }));
    for (const odd of [undefined, null, 'DONE', 'completed', 42, { status: 'COMPLETED' }]) expect(honTurnStatusPresentation(odd).status).toBe('UNKNOWN');
    expect(honComposerEnabled(null)).toBe(false);
    const ready = { contract: true, providerRoute: true, entitlement: true, authorization: true };
    expect(honComposerEnabled(ready)).toBe(true);
    for (const key of Object.keys(ready)) expect(honComposerEnabled({ ...ready, [key]: false })).toBe(false);
  });

  it('maps each presentation mode to its owner-approved Kai style without touching the seven', () => {
    expect(HON_TEACHING_AI_PORTRAITS).toEqual({ modern: '/ai/kai.webp', classic: '/ai/kai-illustrated.webp', 'big-button': '/ai/kai-chibi.webp' });
    for (const src of Object.values(HON_TEACHING_AI_PORTRAITS)) {
      expect(existsSync(join('public', src)), src).toBe(true);
      expect(HON_AI_TEAM.map((member) => member.portrait)).not.toContain(src);
    }
    expect(teachingAiPortrait('classic')).toBe('/ai/kai-illustrated.webp');
    for (const odd of ['retro', '', undefined, null, 'toString', '__proto__']) expect(teachingAiPortrait(odd)).toBe('/ai/kai.webp');
    expect(HON_COMMAND_ROSTER.map((agent) => agent.portrait)).toEqual(['/ai/alex.webp', '/ai/chad.webp', '/ai/maya.webp', '/ai/marcus.webp', '/ai/jordan.webp', '/ai/claire.webp', '/ai/lena.webp']);
  });

  it('accepts only bounded same-origin staff return paths', () => {
    expect(safeHonReturnPath('/staff/crm/follow-ups')).toBe('/staff/crm/follow-ups');
    for (const bad of ['https://evil.example', '//evil.example', '/staff/../hq', '/hq', '/staff/hon', '/staff/dashboard?x=1', 'javascript:alert(1)', undefined, 42]) expect(safeHonReturnPath(bad)).toBe('/staff/dashboard');
    expect(honExpandHref('/staff/crm/leads', 'chad')).toBe('/staff/hon?return=%2Fstaff%2Fcrm%2Fleads&agent=chad');
    expect(honExpandHref('https://evil.example', 'root')).toBe('/staff/hon?return=%2Fstaff%2Fdashboard');
  });
});

describe('HON command data layer', () => {
  it('starts idle and loads only existing reads for a dashboard-verified school', async () => {
    expect(initialHonCommandSnapshot().scope.state).toBe('IDLE');
    const { snapshot, api: calls } = await loaded();
    expect(calls.resolveScope).not.toHaveBeenCalled();
    expect(calls.theme).not.toHaveBeenCalled();
    expect(calls.commandCenter).toHaveBeenCalledWith(scope);
    expect(calls.approvals).toHaveBeenCalledWith(scope);
    expect(snapshot.scope).toEqual(expect.objectContaining({ state: 'VERIFIED', source: 'DASHBOARD' }));
    expect(snapshot.commandCenter.state).toBe('READY');
    expect(snapshot.approvals.state).toBe('READY');
    expect(snapshot.draftWork.state).toBe('READY');
    expect(snapshot.draftWork.data!.items.map((item) => item.id)).toEqual([id(31), id(32), id(33)]);
  });

  it('resolves the current school from the session when no dashboard scope is supplied, and loads the theme', async () => {
    const { snapshot, api: calls } = await loaded({}, null);
    expect(calls.resolveScope).toHaveBeenCalledTimes(1);
    expect(snapshot.scope).toEqual(expect.objectContaining({ state: 'VERIFIED', source: 'CURRENT_SCHOOL' }));
    expect(snapshot.theme).toBe('classic');
  });

  it('requires an explicit dashboard choice when the school is not resolved automatically', async () => {
    const { snapshot, api: calls } = await loaded({ resolveScope: vi.fn(async () => ({ state: 'MANUAL_ENTRY_REQUIRED' as const })) }, null);
    expect(snapshot.scope.state).toBe('SELECTION_REQUIRED');
    expect(calls.commandCenter).not.toHaveBeenCalled();
    expect(calls.draftWork).not.toHaveBeenCalled();
    expect(calls.approvals).not.toHaveBeenCalled();
    expect(view(snapshot)).toContain('Choose a school first');
  });

  it('keeps each section independent: denied, error and empty states never borrow data', async () => {
    const { snapshot } = await loaded({
      commandCenter: vi.fn(async () => { throw new CommandCenterAccessError('no', 403); }),
      approvals: vi.fn(async () => { throw new ActionReviewAccessError('no'); }),
      draftWork: vi.fn(async () => { throw new Error('boom'); }),
    });
    expect(snapshot.commandCenter).toEqual(expect.objectContaining({ state: 'DENIED', data: null }));
    expect(snapshot.approvals).toEqual(expect.objectContaining({ state: 'DENIED', data: null }));
    expect(snapshot.draftWork).toEqual(expect.objectContaining({ state: 'ERROR', data: null }));
    const empty = (await loaded({ commandCenter: vi.fn(async () => commandCenter(false)), approvals: vi.fn(async () => ({ items: [], more: false })), draftWork: vi.fn(async () => ({ items: [], unavailable: [] })) })).snapshot;
    expect([empty.commandCenter.state, empty.approvals.state, empty.draftWork.state]).toEqual(['EMPTY', 'EMPTY', 'EMPTY']);
  });

  it('treats draft work as denied only when every governed source is unavailable', async () => {
    const all = await loaded({ draftWork: vi.fn(async () => ({ items: [], unavailable: ['marcus', 'claire', 'chad'] as const })) as unknown as HonCommandApi['draftWork'] });
    expect(all.snapshot.draftWork.state).toBe('DENIED');
    const some = await loaded({ draftWork: vi.fn(async () => ({ items: [work(31, 'chad')], unavailable: ['marcus'] as const })) as unknown as HonCommandApi['draftWork'] });
    expect(some.snapshot.draftWork.state).toBe('READY');
    expect(view(some.snapshot, 'work')).toContain('Your access does not include some draft sources here: Marcus · Marketing draft');
  });

  it('discards stale results after reset and reloads on refresh', async () => {
    let release!: () => void;
    const slow = api({ commandCenter: vi.fn(() => new Promise<SchoolCommandCenterSnapshot>((resolve) => { release = () => resolve(commandCenter()); })) });
    const controller = new HonCommandController(slow);
    const pending = controller.open(scope);
    expect(controller.snapshot().commandCenter.state).toBe('LOADING');
    controller.reset();
    release(); await pending;
    expect(controller.snapshot().scope.state).toBe('IDLE');
    expect(controller.snapshot().commandCenter.state).toBe('IDLE');
    const ready = await loaded();
    await ready.controller.refresh();
    expect(ready.api.commandCenter).toHaveBeenCalledTimes(2);
  });
});

describe('HON workspace presentation', () => {
  it('renders an honest not-connected conversation with a disabled composer', async () => {
    const html = view((await loaded()).snapshot);
    expect(html).toContain('HON conversation is not connected yet');
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).toMatch(/<button type="button" disabled="">Send<\/button>/);
    expect(html).toContain('href="/staff/voice"');
    expect(html).toContain('No conversation history exists to show.');
    expect(html).not.toMatch(/Processing|Delegating|Completed/);
  });

  it('shows all seven employees with truthful availability and no fabricated activity in every mode', async () => {
    const { snapshot } = await loaded();
    for (const variant of ['modern', 'big-button', 'classic'] as const) {
      const html = view(snapshot, 'team', null, variant);
      expect(html).toContain(`data-variant="${variant}"`);
      for (const agent of HON_COMMAND_ROSTER) { expect(html).toContain(`>${agent.name}<`); expect(html).toContain(agent.title.replace('&', '&amp;')); }
      // Five planned management employees plus the separate provisional Teaching AI.
      expect(html.match(/Planned · not yet available/g)).toHaveLength(6);
      expect(html.match(/Drafts · approval required/g)).toHaveLength(2);
      expect(html).toContain('1 recent draft');
      for (const fabricated of ['Working now', 'Thinking', 'Online', 'Completed today', 'is ready', 'READY']) expect(html).not.toContain(fabricated);
    }
  });

  it('shows Kai only as a separate, provisional, planned Teaching AI with existing human tools', async () => {
    const html = view((await loaded()).snapshot, 'team');
    expect(html).toContain('Separate instructional AI · not part of the management team');
    expect(html).toContain('Kai <small>(provisional name)</small>');
    expect(html).toContain('Teaching &amp; Curriculum AI');
    expect(html).toContain('never mark student proficiency');
    expect(html).toContain('src="/ai/kai.webp"');
    const { snapshot } = await loaded();
    for (const [variant, src] of Object.entries(HON_TEACHING_AI_PORTRAITS)) {
      const html = view(snapshot, 'team', null, variant as 'modern' | 'big-button' | 'classic');
      expect(html).toContain(`data-kai-style="${variant}"`);
      expect(html).toContain(`src="${src}"`);
      for (const other of Object.values(HON_TEACHING_AI_PORTRAITS).filter((value) => value !== src)) expect(html).not.toContain(`src="${other}"`);
      expect(html).toContain('never mark student proficiency');
    }
    for (const tool of HON_TEACHING_AI.tools) expect(html).toContain(`href="${tool.href}"`);
    expect(view((await loaded()).snapshot, 'work')).not.toContain('Kai');
  });

  it('shows no management team, work, approvals or Kai until the server verifies a management scope', async () => {
    const unresolved = (await loaded({ resolveScope: vi.fn(async () => ({ state: 'MANUAL_ENTRY_REQUIRED' as const })) }, null)).snapshot;
    const denied = (await loaded({ resolveScope: vi.fn(async () => { throw new CommandCenterAccessError('no', 403); }) }, null)).snapshot;
    const idle = initialHonCommandSnapshot();
    for (const snapshot of [unresolved, denied, idle]) {
      for (const tab of ['team', 'work', 'approvals', 'suggested'] as const) {
        const html = view(snapshot, tab);
        for (const agent of HON_COMMAND_ROSTER) expect(html).not.toContain(`>${agent.name}<`);
        expect(html).not.toContain('role="tablist"');
        expect(html).not.toContain('Kai');
        expect(html).not.toContain('Teaching draft assistant');
      }
    }
    expect(view(unresolved)).toContain('Teaching-only access does not include it.');
  });

  it('presents Claire as Business Performance Manager with no recorded work and no teaching link', async () => {
    const html = view((await loaded()).snapshot, 'team', 'claire');
    expect(html).toContain('Business Performance Manager');
    expect(html).toContain('Claire has no AI work contract yet');
    expect(html).not.toContain('/staff/teaching-assistant');
    expect(html).not.toMatch(/Curriculum support/i);
  });

  it('shows Chad’s verified history, workspace and approval requirement', async () => {
    const html = view((await loaded()).snapshot, 'team', 'chad');
    expect(html).toContain('Open Chad’s follow-up draft workspace');
    expect(html).toContain(`/staff/leads/assistant#invocation=${id(31)}`);
    expect(html).not.toContain(id(34));
    expect(html).toContain('A different qualified human must approve the exact payload in Action Center');
  });

  it('never implies a complete AI work history', async () => {
    const { snapshot } = await loaded();
    expect(view(snapshot, 'work')).toContain('This is not a complete history.');
    expect(view(snapshot, 'team', 'chad')).toContain('This is not a complete history.');
    expect(view(snapshot, 'team', 'alex')).not.toContain('This is not a complete history.');
  });

  it('labels legacy claire-keyed work as teaching drafts and approvals by their source workflow', async () => {
    const { snapshot } = await loaded();
    const work = view(snapshot, 'work');
    expect(work).toContain('Teaching draft assistant (legacy)');
    expect(work).toContain(`/staff/teaching-assistant#invocation=${id(33)}`);
    expect(work).not.toContain('Claire ·');
    const approvals = view(snapshot, 'approvals');
    expect(approvals).toContain('Chad · Follow-up draft');
    expect(approvals).toContain('Teaching draft assistant (legacy)');
    expect(approvals).toContain('href="/staff/action-center/approvals"');
    expect(approvals).not.toMatch(/Approve exact|Refuse exact/);
  });

  it('shows deterministic suggestions and a Core entitlement note without inferring authority', async () => {
    const html = view((await loaded({ commandCenter: vi.fn(async () => commandCenter(true, 'CORE')) })).snapshot, 'suggested');
    expect(html).toContain('Review pending approvals');
    expect(html).toContain('Team area: Alex · General Manager');
    expect(html).toContain('reports this school on CORE');
  });

  it('renders loading, denied and error states explicitly', async () => {
    const controller = new HonCommandController(api({ approvals: vi.fn(() => new Promise<never>(() => {})) }));
    void controller.open(scope);
    expect(view(controller.snapshot(), 'approvals')).toContain('Loading approvals awaiting review');
    const denied = (await loaded({ approvals: vi.fn(async () => { throw new ActionReviewAccessError('no'); }) })).snapshot;
    expect(view(denied, 'approvals')).toContain('Approvals: not available for your access');
    const failed = (await loaded({ commandCenter: vi.fn(async () => { throw new Error('down'); }) })).snapshot;
    expect(view(failed, 'suggested')).toContain('role="alert"');
  });

  it('exposes accessible tabs with roving tabindex', async () => {
    const html = view((await loaded()).snapshot, 'work');
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html).toMatch(/aria-selected="true" tabindex="0"[^>]*>AI work/);
    expect(html.match(/tabindex="-1"/g)!.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('role="tabpanel"');
  });
});

describe('HON integration boundaries', () => {
  it('offers the persistent launcher on staff pages except the dashboard band and the full workspace', () => {
    expect(renderToStaticMarkup(<HonLauncher pathname="/staff/crm/leads" />)).toContain('Ask HON');
    expect(renderToStaticMarkup(<HonLauncher pathname="/staff/dashboard" />)).toBe('');
    expect(renderToStaticMarkup(<HonLauncher pathname="/staff/hon" />)).toBe('');
    for (const outside of ['/', '/complete-mobile', '/reference/classic-dashboard', '/parent', '/hq', '/auth/login', '/staffing']) expect(renderToStaticMarkup(<HonLauncher pathname={outside} />)).toBe('');
    expect(readFileSync('src/app/layout.tsx', 'utf8')).toContain('<HonLauncherSlot/>');
    expect(readFileSync('src/app/staff/layout.tsx', 'utf8')).toContain('requireVerifiedWebSession');
  });

  it('renders the dashboard band per mode without fetching before it is opened', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      for (const variant of ['modern', 'big-button', 'classic'] as const) {
        const html = renderToStaticMarkup(<HonTeamBand scope={scope} variant={variant} />);
        expect(html).toContain(`data-variant="${variant}"`);
        expect(html).toContain('Open HON');
        for (const agent of HON_COMMAND_ROSTER) expect(html).toContain(`>${agent.name}<`);
      }
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
    const dashboard = readFileSync('src/components/staff-dashboard.tsx', 'utf8');
    expect(dashboard).toContain('{snapshot && selection && <HonTeamBand scope={{ organizationId: selection.organizationId, schoolId: selection.schoolId }} variant={interfaceTheme} />}');
  });

  it('declares a session-gated no-index workspace route whose query never selects a school', () => {
    const page = readFileSync('src/app/staff/hon/page.tsx', 'utf8');
    expect(page).toContain("dynamic = 'force-dynamic'");
    expect(page).toContain('index: false');
    expect(page).toContain('requireVerifiedWebSession');
    expect(page).not.toMatch(/schoolId|organizationId/);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
    expect(manifest.routes.filter((route) => route.path === '/staff/hon')).toHaveLength(1);
  });

  it('adds no endpoint, write, storage or provider path of its own', () => {
    const source = ['roster.ts', 'hon-command-data.ts', 'hon-conversation.ts', 'hon-workspace-view.tsx', 'hon-command.tsx', 'hon-launcher-slot.tsx']
      .map((file) => readFileSync(join('src/components/hon-command', file), 'utf8')).join('\n');
    expect(source).not.toMatch(/fetch\(|localStorage|sessionStorage|method:\s*'(POST|PUT|PATCH|DELETE)'|openrouter|invokeLLM|Idempotency-Key/i);
    expect(source).not.toMatch(/Curriculum support/);
  });

  it('keeps the legacy teaching slice truthful without renaming its record key', () => {
    const inbox = readFileSync('src/components/ai-draft-work-inbox.tsx', 'utf8');
    expect(inbox).toContain("claire: { name: 'Teaching drafts', role: 'Legacy curriculum drafts'");
    expect(inbox).not.toContain("name: 'Claire'");
    const teaching = readFileSync('src/components/teaching-assistant-workbench.tsx', 'utf8');
    expect(teaching).toContain('not the work of Claire, HON’s Business Performance Manager');
    expect(teaching).not.toContain('CLAIRE — CURRICULUM SUPPORT GUIDE');
    expect(readFileSync('src/components/ai-draft-work-http.ts', 'utf8')).toContain("claire: '/api/v1/staff/teaching-assistant/mine'");
  });
});
