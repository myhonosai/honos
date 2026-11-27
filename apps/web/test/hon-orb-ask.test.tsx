import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS, type HqPlatformOverview } from '@hon/contracts';

// Ask HON in place from the dashboard orb card (owner 2026-11-27: "this should be working from here, not sent to workspace").
const overview: HqPlatformOverview = {
  asOf: '2026-10-18T00:00:00.000Z', callerHqRole: 'OWNER', organizationCount: 2, schoolCount: 3,
  onboarding: { availability: 'AVAILABLE', requestCount: 4, inProgressRequestCount: 1, completedRequestCount: 3 },
  configuredProviderStates: { disabled: 1, configured: 2, healthy: 0, degraded: 0, unavailable: 1 }, taskProfileCount: 5,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics },
  aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage },
  durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork },
};
vi.mock('../src/components/hq-modern/shell', () => ({
  useHqModern: () => ({ overview, art: 'realistic', view: 'modern', draft: '', setDraft: vi.fn(), openAssistant: vi.fn() }),
  HonCore: () => <span aria-label="HON Core"/>,
}));
import { HqModernDashboard } from '../src/components/hq-modern/dashboard';
import { HqHonOrbAsk } from '../src/components/hq-modern/hon-orb-ask';
import { HqHonPanelView, type HqHonPanelViewProps } from '../src/components/hq-hon/hq-hon-panel';
import { HonHomeAsk } from '../src/components/home/hon-ask';
import { HonVoiceControls } from '../src/components/hon-command/hon-voice-controls';
import { SchoolHomeView } from '../src/components/home/view';
import { homeText } from '../src/components/home/copy';
import { NOW, ORG, SCHOOL, ready } from './school-home-fixtures';
import { en } from '../../../packages/design-system/src/localization/en';
import { ko } from '../../../packages/design-system/src/localization/ko';
import { es } from '../../../packages/design-system/src/localization/es';

const read = (path: string) => readFileSync(path, 'utf8');

describe('HQ dashboard HON card', () => {
  it('offers ask, microphone and expand on the card; nothing opens until pressed', () => {
    const html = renderToStaticMarkup(<HqHonOrbAsk/>);
    expect(html).toContain('data-hon-orb-ask="closed"');
    expect(html).toMatch(/<button type="button"[^>]*aria-label="Talk to HON"[^>]*data-hon-orb-mic=""/);
    expect(html).toMatch(/<button type="button"[^>]*aria-expanded="false"[^>]*data-hon-orb-open=""><span>Ask HON anything<\/span><\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*aria-label="Expand HON conversation"[^>]*data-hon-orb-expand=""/);
    expect(html).not.toContain('data-hon-orb-chat');
  });

  it('the dashboard uses the in-place card instead of one button that opens the assistant', () => {
    const html = renderToStaticMarkup(<HqModernDashboard/>);
    expect(html).toContain('data-hon-orb-ask="closed"');
    const source = read('src/components/hq-modern/dashboard.tsx');
    expect(source).toContain('<HqHonOrbAsk/>');
    expect(source).not.toMatch(/className=\{styles\.honEntry\} onClick=\{openAssistant\}/);
  });

  it('the in-place chat is the real HQ Ask HON for agent hon, with voice; only expand opens the full assistant', () => {
    const source = read('src/components/hq-modern/hon-orb-ask.tsx');
    expect(source).toContain('<HqHonPanel agentKey="hon" name="HON" compact voice startVoice={listen} focusQuestion={listen === 0}/>');
    expect(source.match(/openAssistant\(\)/g)).toHaveLength(1);
    expect(source).toContain('const expand = () => { setOpen(false); openAssistant(); };');
  });

  it('a spoken question takes the same ask path as a typed one and never clears the typed box', () => {
    const source = read('src/components/hq-hon/hq-hon-panel.tsx');
    expect(source).toContain('const onAsk = useCallback((e: React.FormEvent) => { e.preventDefault(); void askText(question, false); }, [askText, question]);');
    expect(source).toContain('void askTextRef.current(text, true)');
    expect(source).toContain('if (!spoken) setQuestion(\'\')');
    // One HQ ask call in the file: the shared askText.
    expect(source.match(/api\.ask\(/g)).toHaveLength(1);
  });

  const viewProps = (patch: Partial<HqHonPanelViewProps> = {}): HqHonPanelViewProps => ({
    agentKey: 'hon', name: 'HON', language: 'en', number: String, question: '', mode: 'STANDARD', outcome: null, onQuestion: () => {}, onMode: () => {},
    onAsk: () => {}, onRefresh: () => {}, budgetOutcome: null, onBudget: () => {}, compact: true,
    state: { kind: 'READY', view: { provider: 'CONNECTED', availableAgents: ['hon'], turns: [], budgetHistory: [], underReview: [], limit: 50, asOf: NOW.toISOString(),
      viewer: { principalId: ORG, displayName: 'Synthetic Owner', isOwner: true },
      budget: { periodStart: '2026-11-01', creditCap: 100, usedCredits: 0, heldCredits: 0, availableCredits: 100, inProgress: 0, version: 1, setBy: null, setAt: null } } } as never,
    ...patch,
  });
  it('shows voice inside the question form only when this agent can be asked', () => {
    const voice = <p data-test-voice="">voice</p>;
    expect(renderToStaticMarkup(<HqHonPanelView {...viewProps({ voice })}/>)).toMatch(/<form>[\s\S]*data-test-voice[\s\S]*<\/form>/);
    const off = viewProps({ voice }); (off.state as { view: { provider: string } }).view.provider = 'NOT_CONFIGURED';
    expect(renderToStaticMarkup(<HqHonPanelView {...off}/>)).not.toContain('data-test-voice');
    expect(renderToStaticMarkup(<HqHonPanelView {...viewProps({ focusQuestion: true })}/>)).toMatch(/<textarea id="hq-hon-hon-q" autofocus=""/);
  });

  it('every new HQ phrase has Korean and Spanish copy', () => {
    for (const key of ['HON conversation', 'Close HON chat'] as const) {
      expect(en[key]).toBe(key);
      expect(ko[key]).toBeTruthy(); expect(ko[key]).not.toBe(key);
      expect(es[key]).toBeTruthy(); expect(es[key]).not.toBe(key);
    }
  });
});

describe('school Home HON card', () => {
  it('offers ask, microphone and expand on the card; expand is the full workspace', () => {
    const html = renderToStaticMarkup(<HonHomeAsk school={{ organizationId: ORG, schoolId: SCHOOL }} language="en"/>);
    expect(html).toContain('data-hon-home-ask="closed"');
    expect(html).toMatch(/<button type="button"[^>]*aria-label="Talk to HON"[^>]*data-hon-orb-mic=""/);
    expect(html).toMatch(/<button type="button"[^>]*aria-expanded="false"[^>]*data-hon-orb-open="">[\s\S]*<span>Ask HON anything<\/span><\/button>/);
    expect(html).toContain('href="/staff/hon?return=%2Fstaff%2Fdashboard" aria-label="Open the full HON workspace"');
    expect(html).not.toContain('data-hon-orb-chat');
  });

  it('the Home card shows the in-place ask when given, else the plain link', () => {
    const base = { language: 'en', mode: 'modern', schoolName: 'Sunrise Taekwondo', selection: { organizationId: ORG, schoolId: SCHOOL }, sources: ready(), now: NOW } as const;
    const withAsk = renderToStaticMarkup(<SchoolHomeView {...base} honAsk={<div data-test-ask=""/>}/>);
    expect(withAsk).toContain('data-test-ask');
    expect(withAsk).not.toMatch(/<a class="[^"]*" href="\/staff\/hon"><svg[\s\S]*?<span>Ask HON<\/span><\/a>/);
    expect(renderToStaticMarkup(<SchoolHomeView {...base}/>)).toContain('<span>Ask HON</span></a>');
  });

  it('uses the shell-verified school, the real conversation (dock) and voice through the same send path', () => {
    const home = read('src/components/home/home.tsx');
    expect(home).toContain("honAsk={shell.phase === 'READY' && selection ? <HonHomeAsk key={`${selection.organizationId}:${selection.schoolId}`} school={{ organizationId: selection.organizationId, schoolId: selection.schoolId }}");
    const card = read('src/components/home/hon-ask.tsx');
    expect(card).toContain('<HonConversation school={school} presentation="dock" startVoice={listen}/>');
    expect(card).not.toMatch(/fetch\(|HON_CONVERSATION_API/);
    const panel = read('src/components/hon-command/hon-conversation-panel.tsx');
    expect(panel).toContain('voiceStarted.current = startVoice; talkNow();');
    expect(panel).toContain('if (startVoice <= voiceStarted.current || !voiceReady || !canVoice) return;');
  });

  it('the microphone turns voice on (remembered) and listens, like Turn on voice then Talk', () => {
    const voice = read('src/components/hon-command/hon-voice-controls.tsx');
    expect(voice).toContain('const talkNow = useCallback(() => { remember(true); setEnabled(true); controller.current?.talk(); }, []);');
  });

  it('keeps the voice privacy facts on screen while voice is on (it can be turned on from the card)', () => {
    const html = renderToStaticMarkup(<HonVoiceControls support={{ checked: true, recognition: true, synthesis: true }} enabled canAsk onDeviceStatus="unavailable"
      snapshot={{ state: 'IDLE', handsFree: false, onDevice: false, heard: '', message: null }} onEnable={() => {}} onDisable={() => {}} onTalk={() => {}}
      onCancelListening={() => {}} onHandsFree={() => {}} onStopSpeaking={() => {}} onInstall={() => {}}/>);
    expect(html).toContain('data-voice-privacy');
    expect(html).toContain('HON gets only the text, like typing. No audio is recorded or saved by HON.');
  });

  it.each(['ko', 'es'] as const)('has %s copy for the card', language => {
    for (const key of ['honAskAnything', 'honTalk', 'honExpand', 'honChat', 'honClose'] as const) expect(homeText(language, key)).not.toBe(homeText('en', key));
  });
});
