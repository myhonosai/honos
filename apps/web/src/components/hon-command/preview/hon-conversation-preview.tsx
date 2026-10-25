'use client';

import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import type { HonInterfaceTheme } from '@hon/design-system';
import type { HonCommandSnapshot } from '../hon-command-data';
import { HonConversationController } from '../hon-conversation-data';
import { HonWorkspaceView, type HonTab } from '../hon-workspace-view';
import { HON_PREVIEW_BANNER, HON_PREVIEW_MODES, HON_PREVIEW_SCENARIOS, HON_PREVIEW_SCENARIO_LABELS, HON_PREVIEW_VIEWS, SYNTHETIC_SCOPE, syntheticConversationSource, type HonPreviewScenario, type HonPreviewView } from './hon-conversation-fixtures';
import styles from '../hon-command.module.css';


/** A verified-looking scope with no school content, so only the conversation states are exercised. */
function previewCommandSnapshot(): HonCommandSnapshot {
  const empty = { state: 'EMPTY' as const, data: null, message: 'Synthetic preview: no school data is loaded.' };
  return {
    scope: { state: 'VERIFIED', ...SYNTHETIC_SCOPE, source: 'DASHBOARD', message: 'Synthetic preview school. Not a real school.' },
    theme: null,
    commandCenter: empty,
    draftWork: empty,
    approvals: empty,
  };
}

function PreviewWorkspace({ mode, scenario, view }: { mode: HonInterfaceTheme; scenario: HonPreviewScenario; view: HonPreviewView }): React.ReactElement {
  const controller = useRef<HonConversationController | null>(null);
  controller.current ??= new HonConversationController(syntheticConversationSource(scenario));
  const current = controller.current;
  const snapshot = useSyncExternalStore((listener) => current.subscribe(listener), () => current.snapshot(), () => current.snapshot());
  useEffect(() => {
    void current.open(SYNTHETIC_SCOPE).then(() => {
      const first = current.snapshot().threads.items.find((item) => item.title.includes('Campaign')) ?? current.snapshot().threads.items[0];
      if (first && scenario !== 'empty') void current.selectThread(first.id);
    });
    return () => current.reset();
  }, [current, scenario]);
  const [tab, setTab] = React.useState<HonTab>('team');
  const workspace = <HonWorkspaceView
    snapshot={previewCommandSnapshot()}
    variant={mode}
    presentation={view}
    tab={tab}
    selectedAgentId={null}
    headingId="hon-preview-heading"
    onTab={setTab}
    conversation={{
      snapshot,
      onDraft: (text) => current.draft(text),
      onSend: () => void current.send(),
      onNew: () => current.newConversation(),
      onSelect: (threadId) => void current.selectThread(threadId),
      onCheck: () => void current.check(),
    }}
  />;
  return view === 'panel'
    ? <div className={styles.previewPanelFrame}><div className={styles.panel} data-variant={mode}>{workspace}</div></div>
    : workspace;
}

export function HonConversationPreview({ mode, scenario, view }: { mode: HonInterfaceTheme; scenario: HonPreviewScenario; view: HonPreviewView }): React.ReactElement {
  const href = (next: Partial<{ mode: string; scenario: string; view: string }>) => {
    const params = new URLSearchParams({ mode, scenario, view, ...next });
    return `/reference/hon-conversation?${params.toString()}`;
  };
  return <main className={styles.page} data-preview="hon-conversation">
    <p className={styles.previewBanner} role="note"><strong>{HON_PREVIEW_BANNER}</strong></p>
    <nav className={styles.previewControls} aria-label="Preview options">
      <div><span>Mode</span>{HON_PREVIEW_MODES.map((item) => <a key={item} href={href({ mode: item })} aria-current={item === mode ? 'page' : undefined}>{item}</a>)}</div>
      <div><span>View</span>{HON_PREVIEW_VIEWS.map((item) => <a key={item} href={href({ view: item })} aria-current={item === view ? 'page' : undefined}>{item}</a>)}</div>
      <div><span>State</span>{HON_PREVIEW_SCENARIOS.map((item) => <a key={item} href={href({ scenario: item })} aria-current={item === scenario ? 'page' : undefined}>{HON_PREVIEW_SCENARIO_LABELS[item]}</a>)}</div>
    </nav>
    <PreviewWorkspace key={`${mode}-${scenario}-${view}`} mode={mode} scenario={scenario} view={view} />
  </main>;
}
