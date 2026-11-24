import { RANK_CHART_COMMAND, isRankSetupId, validateRankChartBrief, verifyRankChartView, type RankChartBrief, type RankChartCurrent, type RankChartView } from '@hon/contracts';

/**
 * Rank chart AI draft calls (0636, docs/architecture/RANK_SETUP_AND_PLAIN_CURRICULUM_PAGES.md section 5b). Same-origin only; the
 * school in the path is the shell's verified school. The server decides who may ask, whether AI is switched on and what it costs.
 */
const MESSAGES: Record<string, string> = {
  RANK_CHART_FORBIDDEN: 'AI drafting needs rank setup and Kai on your account, and the Complete plan. Use the choices below instead.',
  RANK_CHART_SPEND_STOPPED: 'AI help is paused or not available for this school right now. Nothing was sent.',
  RANK_CHART_INVALID: 'Kai could not take that. Use up to 600 characters, and if the list is very long, change it by hand below.',
  RANK_CHART_CONFLICT: 'That request is still being handled. Wait a moment before trying again.',
  RANK_CHART_PERSISTENCE_UNKNOWN: 'The draft could not be saved. It is held for HON to check and is never sent again.',
};
const base = (school: string) => { if (!isRankSetupId(school)) throw new Error('Rank setup is unavailable right now.'); return `/api/v1/staff/schools/${school.toLowerCase()}/rank-setup/ai-drafts`; };

async function call(url: string, body?: object, key?: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Hon-Human-Command': RANK_CHART_COMMAND };
  if (body) { headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = key ?? ''; }
  const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');
  const value: unknown = json ? await response.json().catch(() => null) : null;
  const root = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!response.ok) {
    const code = String(root?.code ?? '');
    if (response.status === 401) throw new Error('Your session has ended. Sign in again.');
    throw new Error(MESSAGES[code] ?? (response.status === 403 ? MESSAGES.RANK_CHART_FORBIDDEN! : 'The AI draft could not be confirmed. Use the choices below, or try again later.'));
  }
  if (!root || !Object.hasOwn(root, 'data')) throw new Error('The AI draft answer could not be verified.');
  return root.data;
}

export const rankChartApi = {
  /** Whether AI drafting is switched on for this server. Any failure reads as "not available": the box then explains and stays off. */
  async available(school: string): Promise<boolean> {
    try { const data = await call(base(school)) as { aiAvailable?: unknown } | null; return data?.aiAvailable === true; } catch { return false; }
  },
  /** One turn of the conversation: what the person said and, when a list is on screen, that list for Kai to change. */
  async draft(school: string, description: string, current: RankChartCurrent | null, key: string): Promise<RankChartView> {
    let brief: RankChartBrief;
    try { brief = validateRankChartBrief({ description, current }); } catch { throw new Error(MESSAGES.RANK_CHART_INVALID!); }
    return verifyRankChartView(await call(base(school), brief, key));
  },
  async close(school: string, id: string, status: 'APPLIED' | 'DISMISSED', key: string): Promise<void> {
    if (!isRankSetupId(id)) return; await call(`${base(school)}/${id.toLowerCase()}/close`, { status }, key);
  },
};

/** Why a draft that came back cannot be shown, in plain words; '' when it can. */
export function rankChartOutcome(view: RankChartView): string {
  if (view.draft) return '';
  if (view.status === 'CONFIGURATION_REQUIRED') return 'AI drafting is not switched on yet. Nothing was sent. Use the choices below for now.';
  if (view.status === 'BLOCKED') return 'AI help is not available for this school right now. Nothing was sent. Use the choices below.';
  if (view.status === 'RESULT_REJECTED') return 'The answer was not a usable rank chart, so nothing changed. Try saying it a little differently, or use the choices below.';
  if (view.status === 'FAILED') return 'The AI could not draft this. Try again, or use the choices below.';
  return 'The draft did not come back. It is held for HON to check and is not sent again. Use the choices below.';
}
