'use client';

import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { DEFAULT_HON_INTERFACE_THEME, type HonInterfaceTheme } from '@hon/design-system';
import { HonCommandController, initialHonCommandSnapshot, type HonCommandApi, type HonCommandSnapshot, type HonScope } from './hon-command-data';
import { HonConversation } from './hon-conversation-panel';
import { HON_COMMAND_ROSTER, honAgent, safeHonReturnPath } from './roster';
import { AgentPortrait, AvailabilityBadge, HonMark, HonWorkspaceView, type HonTab } from './hon-workspace-view';
import styles from './hon-command.module.css';

const SERVER_SNAPSHOT = initialHonCommandSnapshot();

function useHonController(api?: HonCommandApi) {
  const controller = useRef<HonCommandController | null>(null);
  controller.current ??= new HonCommandController(api);
  const current = controller.current;
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => current.subscribe(listener), [current]),
    () => current.snapshot(),
    () => SERVER_SNAPSHOT,
  );
  return { controller: current, snapshot };
}

export function honExpandHref(returnPath: string, agentId: string | null): string {
  const params = new URLSearchParams({ return: safeHonReturnPath(returnPath) });
  if (honAgent(agentId)) params.set('agent', agentId!);
  return `/staff/hon?${params.toString()}`;
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface HonPanelProps {
  open: boolean;
  onClose: () => void;
  /** Only a scope the operations dashboard already verified. */
  scope?: HonScope | null;
  variant?: HonInterfaceTheme | null;
  initialAgentId?: string | null;
  returnPath: string;
  api?: HonCommandApi | undefined;
}

/** The live Ask HON conversation, only for a server-verified school; a school change remounts it. */
function verifiedConversation(scope: HonCommandSnapshot['scope'], presentation: 'panel' | 'full'): React.ReactNode {
  if (scope.state !== 'VERIFIED') return null;
  return <HonConversation key={`${scope.organizationId}/${scope.schoolId}`} school={{ organizationId: scope.organizationId, schoolId: scope.schoolId }} presentation={presentation} />;
}

/** Expandable HON panel: a modal side sheet that keeps the page underneath intact. */
export function HonPanel({ open, onClose, scope = null, variant = null, initialAgentId = null, returnPath, api }: HonPanelProps): React.ReactElement | null {
  const { controller, snapshot } = useHonController(api);
  const [tab, setTab] = useState<HonTab>('team');
  const [agentId, setAgentId] = useState<string | null>(initialAgentId);
  const dialog = useRef<HTMLDivElement>(null);
  const headingId = useId().replace(/:/g, '');
  const loadedFor = useRef<string | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => { if (open) { setAgentId(initialAgentId); setTab('team'); } }, [open, initialAgentId]);
  useEffect(() => {
    if (!open) return;
    const key = scope ? `${scope.organizationId}/${scope.schoolId}` : 'current';
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    void controller.open(scope, { loadTheme: !variant });
  }, [open, scope?.organizationId, scope?.schoolId, controller, variant]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.querySelector<HTMLElement>('h2')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (!items.length) return;
      const first = items[0]!, last = items[items.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; previous?.focus?.(); };
  }, [open]);

  if (!open) return null;
  const resolvedVariant = variant ?? snapshot.theme ?? DEFAULT_HON_INTERFACE_THEME;
  return <div className={styles.overlay} data-variant={resolvedVariant}>
    <button type="button" className={styles.scrim} aria-label="Close HON" tabIndex={-1} onClick={onClose} />
    <div ref={dialog} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={headingId} data-variant={resolvedVariant}>
      <HonWorkspaceView
        snapshot={snapshot}
        variant={resolvedVariant}
        presentation="panel"
        tab={tab}
        selectedAgentId={agentId}
        headingId={headingId}
        onTab={(next) => { setTab(next); if (next !== 'team') setAgentId(null); }}
        onSelectAgent={(id) => { setAgentId(id); setTab('team'); }}
        onRefresh={() => void controller.refresh()}
        onClose={onClose}
        expandHref={honExpandHref(returnPath, agentId)}
        conversation={verifiedConversation(snapshot.scope, 'panel')}
      />
    </div>
  </div>;
}

/**
 * Persistent HON entry for every staff page. It does nothing until opened, then
 * resolves the current school from the signed-in session only.
 */
export function HonLauncher({ pathname }: { pathname: string }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  function close() { setOpen(false); requestAnimationFrame(() => button.current?.focus()); }
  // The dashboard embeds its own verified HON band and the full workspace is HON itself.
  if (!pathname.startsWith('/staff/') || pathname === '/staff/dashboard' || pathname.startsWith('/staff/hon')) return null;
  return <>
    <button ref={button} type="button" className={styles.launcher} data-hon-launcher aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <HonMark size="sm" /><span>Ask HON</span>
    </button>
    {open ? <HonPanel open onClose={close} returnPath={pathname} /> : null}
  </>;
}

/** Dashboard band: HON plus the seven employees, styled per verified presentation mode. */
export function HonTeamBand({ scope, variant, api }: { scope: HonScope; variant: HonInterfaceTheme; api?: HonCommandApi | undefined }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  function close() { setOpen(false); requestAnimationFrame(() => opener.current?.focus()); }
  function launch(event: React.MouseEvent<HTMLElement>, id: string | null) { opener.current = event.currentTarget; setAgentId(id); setOpen(true); }
  return <section className={styles.band} data-variant={variant} aria-labelledby="hon-band-title">
    <div className={styles.bandLead}>
      <HonMark size={variant === 'classic' ? 'sm' : 'lg'} />
      <div>
        <p className={styles.kicker}>AI management team</p>
        <h2 id="hon-band-title">HON</h2>
        <p className={styles.meta}>One place to reach your seven AI employees, recorded AI work and approvals for this verified school.</p>
      </div>
      <div className={styles.bandActions}>
        <button type="button" className={styles.primary} aria-haspopup="dialog" onClick={(event) => launch(event, null)}>Open HON</button>
        <a href={honExpandHref('/staff/dashboard', null)}>Full workspace</a>
      </div>
    </div>
    <ul className={styles.bandTeam} aria-label="AI employees">
      {HON_COMMAND_ROSTER.map((agent) => <li key={agent.id}>
        <button type="button" className={styles.bandAgent} style={{ '--agent': agent.color } as React.CSSProperties} aria-haspopup="dialog" onClick={(event) => launch(event, agent.id)} aria-label={`${agent.name}, ${agent.title}. ${agent.availability === 'GOVERNED_DRAFTS' ? 'Governed drafts available with approval' : 'Planned, not yet available'}`}>
          <AgentPortrait agent={agent} size={variant === 'classic' ? 'sm' : 'md'} />
          <span><strong>{agent.name}</strong><small>{agent.title}</small></span>
          <AvailabilityBadge agent={agent} compact={variant === 'classic'} />
        </button>
      </li>)}
    </ul>
    {open ? <HonPanel open onClose={close} scope={scope} variant={variant} initialAgentId={agentId} returnPath="/staff/dashboard" api={api} /> : null}
  </section>;
}

/** `/staff/hon` full workspace. URL values select presentation only. */
export function HonFullWorkspace({ returnPath, agentId: initialAgent, api }: { returnPath?: string | undefined; agentId?: string | undefined; api?: HonCommandApi | undefined }): React.ReactElement {
  const { controller, snapshot } = useHonController(api);
  const [tab, setTab] = useState<HonTab>('team');
  const [agentId, setAgentId] = useState<string | null>(honAgent(initialAgent)?.id ?? null);
  const started = useRef(false);
  useEffect(() => { if (started.current) return; started.current = true; void controller.open(null, { loadTheme: true }); }, [controller]);
  const variant = snapshot.theme ?? DEFAULT_HON_INTERFACE_THEME;
  return <main className={styles.page} data-variant={variant}>
    <HonWorkspaceView
      snapshot={snapshot}
      variant={variant}
      presentation="full"
      tab={tab}
      selectedAgentId={agentId}
      headingId="hon-full"
      onTab={(next) => { setTab(next); if (next !== 'team') setAgentId(null); }}
      onSelectAgent={(id) => { setAgentId(id); setTab('team'); }}
      onRefresh={() => void controller.refresh()}
      returnHref={safeHonReturnPath(returnPath)}
      conversation={verifiedConversation(snapshot.scope, 'full')}
    />
  </main>;
}
