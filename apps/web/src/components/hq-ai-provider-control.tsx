'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import styles from './hq-ai-provider-control.module.css';

const PROVIDER_IDS = ['OPENROUTER', 'DIRECT_LLM_API', 'HEYGEN', 'HIGGSFIELD'] as const;
const CONNECTION_STATES = ['DISABLED', 'CONFIGURED', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE'] as const;
const CAPABILITIES = ['TEXT', 'VOICE_INPUT', 'VOICE_OUTPUT', 'IMAGE', 'VIDEO', 'EMBEDDING', 'TOOL_EXECUTION'] as const;
const MODALITIES = ['TEXT', 'VOICE_INPUT', 'VOICE_OUTPUT', 'IMAGE', 'VIDEO', 'EMBEDDING'] as const;
const COST_UNITS = ['TOKEN', 'SECOND', 'IMAGE', 'VIDEO', 'REQUEST'] as const;
const TIERS = ['ESSENTIAL', 'CORE', 'COMPLETE'] as const;

type ProviderId = (typeof PROVIDER_IDS)[number];
type ConnectionState = (typeof CONNECTION_STATES)[number];
type Capability = (typeof CAPABILITIES)[number];
type Modality = (typeof MODALITIES)[number];
type CostUnit = (typeof COST_UNITS)[number];
type Tier = (typeof TIERS)[number];

type ProviderConnection = {
  providerId: ProviderId;
  displayName: string;
  state: ConnectionState;
  credentialConfigured: boolean;
  version: number;
};

type CatalogEntry = {
  catalogId: string;
  providerId: ProviderId;
  modelId: string;
  displayName: string;
  capabilities: Capability[];
  modalities: Modality[];
  active: boolean;
  minimumTier: Tier;
  unitCostMicros: number;
  costUnit: CostUnit;
  effectiveFrom: string;
  effectiveUntil: string | null;
  version: number;
};

type RoutingPolicy = {
  policyId: string;
  organizationId: string;
  schoolId: string;
  capability: Capability;
  active: boolean;
  minimumTier: Tier;
  maxCostMicros: number;
  allowDegraded: boolean;
  catalogIds: string[];
  effectiveFrom: string;
  effectiveUntil: string | null;
  version: number;
};

type Snapshot = { providers: ProviderConnection[]; catalog: CatalogEntry[]; policies: RoutingPolicy[] };
type AccessState = 'checking' | 'available' | 'signed-out' | 'forbidden' | 'unavailable';
type OperationState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'success'; message: string } | { kind: 'error'; message: string };

type ProviderForm = {
  providerId: ProviderId;
  displayName: string;
  state: ConnectionState;
  credentialSecretRef: string;
  expectedVersion: number;
};

type CatalogForm = {
  catalogId: string;
  providerId: ProviderId;
  modelId: string;
  displayName: string;
  capabilities: Capability[];
  modalities: Modality[];
  active: boolean;
  minimumTier: Tier;
  unitCostMicros: string;
  costUnit: CostUnit;
  effectiveFrom: string;
  effectiveUntil: string;
  expectedVersion: number;
};

type PolicyForm = {
  policyId: string;
  organizationId: string;
  schoolId: string;
  capability: Capability;
  active: boolean;
  minimumTier: Tier;
  maxCostMicros: string;
  allowDegraded: boolean;
  catalogIds: string[];
  effectiveFrom: string;
  effectiveUntil: string;
  expectedVersion: number;
};

type PreviewForm = {
  policyId: string;
  organizationId: string;
  schoolId: string;
  capability: Capability;
  requiredModalities: Modality[];
  costUnit: CostUnit;
  estimatedUnits: string;
  budgetMicros: string;
};

type RouteCandidate = { catalogId: string; providerId: ProviderId; modelId: string; estimatedCostMicros: number; costUnit: CostUnit; state: 'HEALTHY' | 'DEGRADED' };
type RouteDecision = {
  status: 'SELECTED' | 'DENIED';
  reason: string;
  policyId: string;
  policyVersion: number | null;
  budgetMicros: number;
  authority: 'UNCHANGED';
  execution: 'NOT_PERFORMED';
  chosen: RouteCandidate | null;
  fallbackCandidates: RouteCandidate[];
};

class ControlPlaneError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

function newUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return '00000000-0000-4000-8000-000000000000';
}

function blankProvider(providerId: ProviderId = 'OPENROUTER'): ProviderForm {
  return { providerId, displayName: '', state: 'DISABLED', credentialSecretRef: '', expectedVersion: 0 };
}

function blankCatalog(): CatalogForm {
  return {
    catalogId: newUuid(), providerId: 'OPENROUTER', modelId: '', displayName: '', capabilities: ['TEXT'], modalities: ['TEXT'], active: true,
    minimumTier: 'CORE', unitCostMicros: '', costUnit: 'TOKEN', effectiveFrom: '', effectiveUntil: '', expectedVersion: 0,
  };
}

function blankPolicy(): PolicyForm {
  return {
    policyId: newUuid(), organizationId: '', schoolId: '', capability: 'TEXT', active: true, minimumTier: 'CORE', maxCostMicros: '',
    allowDegraded: false, catalogIds: [], effectiveFrom: '', effectiveUntil: '', expectedVersion: 0,
  };
}

function blankPreview(): PreviewForm {
  return { policyId: '', organizationId: '', schoolId: '', capability: 'TEXT', requiredModalities: ['TEXT'], costUnit: 'TOKEN', estimatedUnits: '1', budgetMicros: '' };
}

function toDateTimeInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toIso(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function toggle<T extends string>(items: T[], item: T): T[] {
  return items.includes(item) ? items.filter((value) => value !== item) : [...items, item];
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false;
  const data = value as { providers?: unknown; catalog?: unknown; policies?: unknown };
  return Array.isArray(data.providers) && Array.isArray(data.catalog) && Array.isArray(data.policies);
}

function detailFrom(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const value = body as { detail?: unknown; message?: unknown };
  if (typeof value.detail === 'string' && value.detail.length <= 300) return value.detail;
  if (typeof value.message === 'string' && value.message.length <= 300) return value.message;
  return fallback;
}

async function readBody(response: Response): Promise<unknown> {
  try { return await response.json() as unknown; } catch { return undefined; }
}

async function postControl(path: string, body: object, idempotent = true): Promise<unknown> {
  const response = await fetch(`/api/v1/hq/ai-providers/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(idempotent ? { 'Idempotency-Key': newUuid() } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await readBody(response);
  if (!response.ok) throw new ControlPlaneError(detailFrom(payload, 'HON could not complete the governed control-plane request.'), response.status);
  return payload;
}

function StatePill({ state }: { state: string }): React.ReactElement {
  const tone = state === 'HEALTHY' || state === 'ACTIVE' || state === 'SELECTED' ? styles.healthy : state === 'DEGRADED' ? styles.degraded : state === 'CONFIGURED' ? styles.configured : state === 'UNAVAILABLE' || state === 'DENIED' ? styles.unavailable : state === 'DISABLED' || state === 'INACTIVE' ? styles.disabled : styles.unregistered;
  return <span className={`${styles.statePill} ${tone}`}>{state.replaceAll('_', ' ')}</span>;
}

function CheckboxList<T extends string>({ label, options, selected, onChange, disabled }: { label: string; options: readonly T[]; selected: T[]; onChange: (next: T[]) => void; disabled: boolean }): React.ReactElement {
  return <fieldset className={styles.checkField} disabled={disabled}>
    <legend>{label}</legend>
    <div>{options.map((option) => <label key={option}><input type="checkbox" checked={selected.includes(option)} onChange={() => onChange(toggle(selected, option))} /> <span>{option.replaceAll('_', ' ')}</span></label>)}</div>
  </fieldset>;
}

function OperationNotice({ state }: { state: OperationState }): React.ReactElement | null {
  if (state.kind === 'idle' || state.kind === 'submitting') return null;
  return <output className={state.kind === 'error' ? styles.errorNotice : styles.successNotice} role="status">{state.message}</output>;
}

export function HqAiProviderControl(): React.ReactElement {
  const [access, setAccess] = useState<AccessState>('checking');
  const [snapshot, setSnapshot] = useState<Snapshot>({ providers: [], catalog: [], policies: [] });
  const [manageBlocked, setManageBlocked] = useState(false);
  const [providerForm, setProviderForm] = useState<ProviderForm>(() => blankProvider());
  const [catalogForm, setCatalogForm] = useState<CatalogForm>(() => blankCatalog());
  const [policyForm, setPolicyForm] = useState<PolicyForm>(() => blankPolicy());
  const [previewForm, setPreviewForm] = useState<PreviewForm>(() => blankPreview());
  const [providerState, setProviderState] = useState<OperationState>({ kind: 'idle' });
  const [catalogState, setCatalogState] = useState<OperationState>({ kind: 'idle' });
  const [policyState, setPolicyState] = useState<OperationState>({ kind: 'idle' });
  const [previewState, setPreviewState] = useState<OperationState>({ kind: 'idle' });
  const [preview, setPreview] = useState<RouteDecision | null>(null);

  const loadConfiguration = useCallback(async (quiet = false): Promise<boolean> => {
    if (!quiet) setAccess('checking');
    try {
      const response = await fetch('/api/v1/hq/ai-providers/configuration', { credentials: 'same-origin', cache: 'no-store' });
      const payload = await readBody(response) as { data?: unknown } | undefined;
      if (response.status === 401) { setAccess('signed-out'); return false; }
      if (response.status === 403) { setAccess('forbidden'); return false; }
      if (!response.ok || !isSnapshot(payload?.data)) { setAccess('unavailable'); return false; }
      setSnapshot(payload.data);
      setAccess('available');
      return true;
    } catch {
      setAccess('unavailable');
      return false;
    }
  }, []);

  useEffect(() => { void loadConfiguration(); }, [loadConfiguration]);

  const providerById = useMemo(() => new Map(snapshot.providers.map((provider) => [provider.providerId, provider])), [snapshot.providers]);
  const activeCatalogCount = snapshot.catalog.filter((entry) => entry.active).length;
  const activePolicyCount = snapshot.policies.filter((policy) => policy.active).length;
  const canManage = access === 'available' && !manageBlocked;

  function handleAccessError(error: unknown, setState: (state: OperationState) => void, fallback: string, mutation = true): void {
    const message = error instanceof Error ? error.message : fallback;
    if (error instanceof ControlPlaneError && error.status === 401) setAccess('signed-out');
    if (error instanceof ControlPlaneError && error.status === 403) {
      if (!mutation) {
        setAccess('forbidden');
        setState({ kind: 'error', message: 'The HQ provider read permission is no longer available for this session.' });
        return;
      }
      setManageBlocked(true);
      setState({ kind: 'error', message: 'This verified HQ account can view the registry but does not have provider-management authority.' });
      return;
    }
    setState({ kind: 'error', message });
  }

  function chooseProvider(providerId: ProviderId): void {
    const provider = providerById.get(providerId);
    setProviderState({ kind: 'idle' });
    setProviderForm(provider
      ? { providerId, displayName: provider.displayName, state: provider.state, credentialSecretRef: '', expectedVersion: provider.version }
      : blankProvider(providerId));
  }

  function editCatalog(entry: CatalogEntry): void {
    setCatalogState({ kind: 'idle' });
    setCatalogForm({
      catalogId: entry.catalogId, providerId: entry.providerId, modelId: entry.modelId, displayName: entry.displayName, capabilities: entry.capabilities,
      modalities: entry.modalities, active: entry.active, minimumTier: entry.minimumTier, unitCostMicros: String(entry.unitCostMicros),
      costUnit: entry.costUnit, effectiveFrom: toDateTimeInput(entry.effectiveFrom), effectiveUntil: toDateTimeInput(entry.effectiveUntil), expectedVersion: entry.version,
    });
    document.getElementById('catalog-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function newCatalog(): void {
    setCatalogState({ kind: 'idle' });
    setCatalogForm(blankCatalog());
  }

  function editPolicy(policy: RoutingPolicy): void {
    setPolicyState({ kind: 'idle' });
    setPolicyForm({
      policyId: policy.policyId, organizationId: policy.organizationId, schoolId: policy.schoolId, capability: policy.capability, active: policy.active,
      minimumTier: policy.minimumTier, maxCostMicros: String(policy.maxCostMicros), allowDegraded: policy.allowDegraded, catalogIds: policy.catalogIds,
      effectiveFrom: toDateTimeInput(policy.effectiveFrom), effectiveUntil: toDateTimeInput(policy.effectiveUntil), expectedVersion: policy.version,
    });
    document.getElementById('policy-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function newPolicy(): void {
    setPolicyState({ kind: 'idle' });
    setPolicyForm(blankPolicy());
  }

  function applyPolicyToPreview(policyId: string): void {
    const policy = snapshot.policies.find((item) => item.policyId === policyId);
    if (!policy) return;
    const candidate = snapshot.catalog.find((entry) => entry.catalogId === policy.catalogIds[0]);
    setPreviewState({ kind: 'idle' });
    setPreview(null);
    setPreviewForm({
      policyId: policy.policyId, organizationId: policy.organizationId, schoolId: policy.schoolId, capability: policy.capability,
      requiredModalities: candidate?.modalities.includes('TEXT') ? ['TEXT'] : (candidate?.modalities.slice(0, 1) ?? ['TEXT']),
      costUnit: candidate?.costUnit ?? 'TOKEN', estimatedUnits: '1', budgetMicros: String(policy.maxCostMicros),
    });
    document.getElementById('routing-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function submitProvider(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canManage) return;
    const ref = providerForm.state === 'DISABLED' ? null : providerForm.credentialSecretRef.trim();
    if (ref !== null && !/^hon-secret:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ref)) {
      setProviderState({ kind: 'error', message: 'Use only the opaque hon-secret UUID reference issued outside HON UI; do not enter a credential value.' });
      return;
    }
    setProviderState({ kind: 'submitting' });
    try {
      await postControl('connections', { ...providerForm, displayName: providerForm.displayName.trim(), credentialSecretRef: ref });
      await loadConfiguration(true);
      setProviderState({ kind: 'success', message: 'Provider connection metadata was saved through the governed HQ boundary.' });
    } catch (error) {
      handleAccessError(error, setProviderState, 'HON could not save provider connection metadata.');
    }
  }

  async function submitCatalog(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canManage) return;
    const effectiveFrom = toIso(catalogForm.effectiveFrom);
    const effectiveUntil = catalogForm.effectiveUntil ? toIso(catalogForm.effectiveUntil) : null;
    const unitCostMicros = Number(catalogForm.unitCostMicros);
    if (!effectiveFrom || (catalogForm.effectiveUntil && !effectiveUntil) || catalogForm.capabilities.length === 0 || catalogForm.modalities.length === 0 || !Number.isSafeInteger(unitCostMicros) || unitCostMicros < 0) {
      setCatalogState({ kind: 'error', message: 'Provide at least one capability and modality, an effective window, and a whole non-negative micro-unit cost.' });
      return;
    }
    setCatalogState({ kind: 'submitting' });
    try {
      await postControl('catalog', {
        ...catalogForm, modelId: catalogForm.modelId.trim(), displayName: catalogForm.displayName.trim(), unitCostMicros,
        effectiveFrom, effectiveUntil,
      });
      await loadConfiguration(true);
      setCatalogState({ kind: 'success', message: 'Approved catalog metadata was saved. This does not verify or invoke a model.' });
    } catch (error) {
      handleAccessError(error, setCatalogState, 'HON could not save the catalog record.');
    }
  }

  async function submitPolicy(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canManage) return;
    const effectiveFrom = toIso(policyForm.effectiveFrom);
    const effectiveUntil = policyForm.effectiveUntil ? toIso(policyForm.effectiveUntil) : null;
    const maxCostMicros = Number(policyForm.maxCostMicros);
    if (!effectiveFrom || (policyForm.effectiveUntil && !effectiveUntil) || policyForm.catalogIds.length === 0 || policyForm.catalogIds.length > 8 || !Number.isSafeInteger(maxCostMicros) || maxCostMicros < 0) {
      setPolicyState({ kind: 'error', message: 'Choose one to eight approved catalog records, an effective window, and a whole non-negative cost ceiling.' });
      return;
    }
    setPolicyState({ kind: 'submitting' });
    try {
      await postControl('routing-policies', {
        ...policyForm, organizationId: policyForm.organizationId.trim(), schoolId: policyForm.schoolId.trim(), maxCostMicros, effectiveFrom, effectiveUntil,
      });
      await loadConfiguration(true);
      setPolicyState({ kind: 'success', message: 'Routing policy metadata was saved. Selection remains permission-neutral and non-executing.' });
    } catch (error) {
      handleAccessError(error, setPolicyState, 'HON could not save the routing policy.');
    }
  }

  async function submitPreview(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (access !== 'available') return;
    const estimatedUnits = Number(previewForm.estimatedUnits);
    const budgetMicros = Number(previewForm.budgetMicros);
    if (previewForm.requiredModalities.length === 0 || !Number.isSafeInteger(estimatedUnits) || estimatedUnits < 1 || !Number.isSafeInteger(budgetMicros) || budgetMicros < 0) {
      setPreviewState({ kind: 'error', message: 'Provide at least one required modality, whole estimated units, and a whole non-negative budget ceiling.' });
      return;
    }
    setPreviewState({ kind: 'submitting' });
    setPreview(null);
    try {
      const payload = await postControl('route-preview', {
        ...previewForm, organizationId: previewForm.organizationId.trim(), schoolId: previewForm.schoolId.trim(), policyId: previewForm.policyId.trim(), estimatedUnits, budgetMicros,
      }, false) as { data?: RouteDecision };
      if (!payload.data || (payload.data.status !== 'SELECTED' && payload.data.status !== 'DENIED')) throw new Error('HON returned an unreadable routing preview.');
      setPreview(payload.data);
      setPreviewState({ kind: 'success', message: 'Selection preview completed. No provider, worker, tool, or model was invoked.' });
    } catch (error) {
      handleAccessError(error, setPreviewState, 'HON could not create the selection-only routing preview.', false);
    }
  }

  const accessMessage = access === 'checking' ? 'Verifying the separate HQ provider-control gate…'
    : access === 'signed-out' ? 'Sign in to verify a human HQ session before this registry can be read.'
      : access === 'forbidden' ? 'This account does not have the separate HQ AI-provider read permission.'
        : 'The HQ provider-control gate is temporarily unavailable. HON remains fail-closed.';

  return <main className={styles.page}>
    <aside className={styles.rail}>
      <a className={styles.backLink} href="/hq">← HQ command center</a>
      <div className={styles.brand}><span>HON</span><strong>Provider<br />Control</strong><small>HQ registry · human operated</small></div>
      <div className={styles.gateCard}><span>AUTHORIZATION GATE</span><strong>Separate from school access</strong><p>Only the existing verified human HQ scope can read or change this control plane.</p></div>
      <nav aria-label="AI provider control sections">
        <a href="#registry"><i>01</i>Registry</a>
        <a href="#connection-form"><i>02</i>Connections</a>
        <a href="#catalog-form"><i>03</i>Catalog</a>
        <a href="#policy-form"><i>04</i>Routing policy</a>
        <a href="#routing-preview"><i>05</i>Selection preview</a>
      </nav>
      <div className={styles.railFoot}><span className={access === 'available' ? styles.liveDot : styles.dimDot} />{access === 'available' ? 'HQ provider read scope verified' : 'Provider control remains gated'}</div>
    </aside>

    <section className={styles.workspace}>
      <header className={styles.header}>
        <div><p>HON HQ / GOVERNED AI REGISTRY</p><h1>Control the route.<br /><em>Never run the provider.</em></h1></div>
        <div className={styles.sessionCard}><span>HQ SESSION</span><strong>{access === 'available' ? 'Provider registry available' : access === 'checking' ? 'Verifying session…' : 'Access not granted'}</strong><small>API origin: <code>/api/v1</code></small></div>
      </header>

      <section className={styles.safetyBand} aria-label="Control-plane limits">
        <div><span className={styles.signal} />HUMAN-ONLY CONFIGURATION</div>
        <p><b>Secret reference only — managed outside HON UI.</b> This screen accepts approved metadata and an opaque reference identifier only; it never asks for, stores, resolves, or displays a credential value.</p>
      </section>

      {access !== 'available' ? <section className={styles.accessPanel} aria-live="polite">
        <span>HQ PROVIDER CONTROL</span><h2>{accessMessage}</h2>
        {access === 'signed-out' ? <a href="/auth/login">Sign in with Manus <b>→</b></a> : <button type="button" onClick={() => void loadConfiguration()}>{access === 'checking' ? 'Checking access…' : 'Retry governed access check'}</button>}
        <small>School roles, AI employees, and caller-supplied authority cannot unlock this surface.</small>
      </section> : <>
        {manageBlocked ? <section className={styles.manageNotice}><strong>Read scope verified; manage scope unavailable.</strong><span>Forms have been locked after the backend rejected a management request. Your session may still inspect the redacted registry and selection previews.</span></section> : null}

        <section id="registry" className={styles.heroGrid}>
          <article className={styles.heroCopy}><p>APPROVED CONTROL PLANE</p><h2>Connection health, catalog economics, and policy order—kept intentionally separate from execution.</h2><span>Provider state is HQ-attested metadata. A configured connection is not automatically healthy, and no action on this page probes it.</span></article>
          <div className={styles.metrics}>
            <article><span>REGISTERED</span><strong>{snapshot.providers.length}</strong><small>provider connections</small></article>
            <article><span>ACTIVE CATALOG</span><strong>{activeCatalogCount}</strong><small>approved model records</small></article>
            <article><span>ACTIVE POLICIES</span><strong>{activePolicyCount}</strong><small>ordered route rules</small></article>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}><div><span>01 / CONNECTION REGISTRY</span><h2>Approved provider types</h2></div><p>Read projection is redacted: it reports only whether an opaque managed reference exists.</p></div>
          <div className={styles.providerGrid}>{PROVIDER_IDS.map((providerId) => {
            const provider = providerById.get(providerId);
            return <article key={providerId} className={styles.providerCard}>
              <header><code>{providerId}</code><StatePill state={provider?.state ?? 'NOT REGISTERED'} /></header>
              <strong>{provider?.displayName || 'No connection record'}</strong>
              <p>{provider?.credentialConfigured ? 'Opaque credential reference recorded' : 'No opaque credential reference recorded'}</p>
              <footer><span>v{provider?.version ?? 0}</span><button type="button" onClick={() => { chooseProvider(providerId); document.getElementById('connection-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>Configure metadata <b>→</b></button></footer>
            </article>;
          })}</div>
        </section>

        <section id="connection-form" className={`${styles.section} ${styles.formSection}`}>
          <div className={styles.sectionHeading}><div><span>02 / HUMAN ATTESTATION</span><h2>Connection metadata</h2></div><p>Use the expected version shown here; concurrent changes are rejected by the backend rather than overwritten.</p></div>
          <form onSubmit={submitProvider} className={styles.formCard}>
            <fieldset disabled={!canManage || providerState.kind === 'submitting'}>
              <div className={styles.formTopline}><div><strong>{providerForm.expectedVersion === 0 ? 'Register approved provider type' : 'Update approved connection record'}</strong><small>Expected version <code>{providerForm.expectedVersion}</code></small></div><span>NO PROVIDER CALLS</span></div>
              <div className={styles.formGrid}>
                <label>Provider type<select value={providerForm.providerId} onChange={(event) => chooseProvider(event.target.value as ProviderId)}>{PROVIDER_IDS.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
                <label>Connection status<select value={providerForm.state} onChange={(event) => setProviderForm({ ...providerForm, state: event.target.value as ConnectionState, credentialSecretRef: event.target.value === 'DISABLED' ? '' : providerForm.credentialSecretRef })}>{CONNECTION_STATES.map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
                <label>Display name<input required maxLength={80} value={providerForm.displayName} onChange={(event) => setProviderForm({ ...providerForm, displayName: event.target.value })} placeholder="Approved provider label" autoComplete="off" /></label>
                <label>Opaque credential reference ID <input required={providerForm.state !== 'DISABLED'} disabled={providerForm.state === 'DISABLED'} value={providerForm.credentialSecretRef} onChange={(event) => setProviderForm({ ...providerForm, credentialSecretRef: event.target.value.toLowerCase() })} placeholder="hon-secret:UUID-v4" autoComplete="off" spellCheck={false} /></label>
              </div>
              <p className={styles.referenceRule}><b>Secret reference only — managed outside HON UI.</b> Entering a non-disabled state requires an opaque <code>hon-secret:</code> UUID reference, never a raw key, token, password, URL, or credential payload.</p>
              <div className={styles.formActions}><button type="submit">{providerState.kind === 'submitting' ? 'Saving governed metadata…' : 'Save connection metadata →'}</button><span>Saving records metadata only; status changes never invoke a provider.</span></div>
              <OperationNotice state={providerState} />
            </fieldset>
          </form>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}><div><span>03 / APPROVED CATALOG</span><h2>Registered model capabilities</h2></div><p>Catalog records describe approved routing metadata—not availability, a prompt, or a reachable provider model.</p></div>
          {snapshot.catalog.length === 0 ? <div className={styles.emptyState}><strong>No model catalog entries are registered.</strong><span>Create only an approved non-secret catalog record below.</span></div> : <div className={styles.catalogGrid}>{snapshot.catalog.map((entry) => <article key={entry.catalogId} className={styles.catalogCard}>
            <header><div><code>{entry.providerId}</code><strong>{entry.displayName}</strong></div><StatePill state={entry.active ? 'ACTIVE' : 'INACTIVE'} /></header>
            <p className={styles.modelId}>{entry.modelId}</p>
            <dl><div><dt>Capabilities</dt><dd>{entry.capabilities.join(' · ')}</dd></div><div><dt>Modalities</dt><dd>{entry.modalities.join(' · ')}</dd></div><div><dt>Economics</dt><dd>{entry.unitCostMicros.toLocaleString()} µUSD / {entry.costUnit}</dd></div><div><dt>Window</dt><dd>{new Date(entry.effectiveFrom).toLocaleString()} {entry.effectiveUntil ? `→ ${new Date(entry.effectiveUntil).toLocaleString()}` : '→ open'}</dd></div></dl>
            <footer><span>v{entry.version} · {shortId(entry.catalogId)}</span><button type="button" onClick={() => editCatalog(entry)}>Edit safe metadata <b>→</b></button></footer>
          </article>)}</div>}
        </section>

        <section id="catalog-form" className={`${styles.section} ${styles.formSection}`}>
          <div className={styles.sectionHeading}><div><span>03A / CATALOG RECORD</span><h2>{catalogForm.expectedVersion === 0 ? 'Add an approved model record' : 'Revise catalog metadata'}</h2></div><button className={styles.textButton} type="button" onClick={newCatalog}>New catalog record +</button></div>
          <form onSubmit={submitCatalog} className={styles.formCard}>
            <fieldset disabled={!canManage || catalogState.kind === 'submitting'}>
              <div className={styles.formTopline}><div><strong>Catalog ID <code>{shortId(catalogForm.catalogId)}</code></strong><small>Expected version <code>{catalogForm.expectedVersion}</code></small></div><span>APPROVAL METADATA</span></div>
              <div className={styles.formGrid}>
                <label>Provider type<select disabled={catalogForm.expectedVersion > 0} value={catalogForm.providerId} onChange={(event) => setCatalogForm({ ...catalogForm, providerId: event.target.value as ProviderId })}>{PROVIDER_IDS.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
                <label>Approved model ID<input required disabled={catalogForm.expectedVersion > 0} maxLength={120} value={catalogForm.modelId} onChange={(event) => setCatalogForm({ ...catalogForm, modelId: event.target.value })} placeholder="approved/model-v1" autoComplete="off" spellCheck={false} /></label>
                <label>Catalog display name<input required maxLength={80} value={catalogForm.displayName} onChange={(event) => setCatalogForm({ ...catalogForm, displayName: event.target.value })} placeholder="Approved text model" autoComplete="off" /></label>
                <label>Minimum HON tier<select value={catalogForm.minimumTier} onChange={(event) => setCatalogForm({ ...catalogForm, minimumTier: event.target.value as Tier })}>{TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}</select></label>
                <label>Cost (integer USD micro-units)<input required min="0" step="1" inputMode="numeric" value={catalogForm.unitCostMicros} onChange={(event) => setCatalogForm({ ...catalogForm, unitCostMicros: event.target.value })} placeholder="e.g. 10" /></label>
                <label>Billable unit<select disabled={catalogForm.expectedVersion > 0} value={catalogForm.costUnit} onChange={(event) => setCatalogForm({ ...catalogForm, costUnit: event.target.value as CostUnit })}>{COST_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
                <label>Effective from<input required type="datetime-local" value={catalogForm.effectiveFrom} onChange={(event) => setCatalogForm({ ...catalogForm, effectiveFrom: event.target.value })} /></label>
                <label>Effective until <small>Optional</small><input type="datetime-local" value={catalogForm.effectiveUntil} onChange={(event) => setCatalogForm({ ...catalogForm, effectiveUntil: event.target.value })} /></label>
              </div>
              <div className={styles.switchRow}><label><input type="checkbox" checked={catalogForm.active} onChange={(event) => setCatalogForm({ ...catalogForm, active: event.target.checked })} /> Active for policy selection</label><span>Provider, model identity, and billable unit are immutable after approval; register a new ID to change them.</span></div>
              <div className={styles.checkboxGrid}><CheckboxList label="Capabilities" options={CAPABILITIES} selected={catalogForm.capabilities} onChange={(capabilities) => setCatalogForm({ ...catalogForm, capabilities })} disabled={!canManage || catalogState.kind === 'submitting'} /><CheckboxList label="Modalities" options={MODALITIES} selected={catalogForm.modalities} onChange={(modalities) => setCatalogForm({ ...catalogForm, modalities })} disabled={!canManage || catalogState.kind === 'submitting'} /></div>
              <div className={styles.formActions}><button type="submit">{catalogState.kind === 'submitting' ? 'Saving catalog metadata…' : 'Save catalog record →'}</button><span>No model prompt is collected or sent.</span></div>
              <OperationNotice state={catalogState} />
            </fieldset>
          </form>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}><div><span>04 / ROUTING POLICY</span><h2>Ordered, tenant-bound policy records</h2></div><p>Policies select only from registered catalog IDs in exact order. They do not grant tool, tenant, approval, or execution authority.</p></div>
          {snapshot.policies.length === 0 ? <div className={styles.emptyState}><strong>No routing policies are registered.</strong><span>Selection remains unavailable until an HQ operator records a scoped policy.</span></div> : <div className={styles.policyGrid}>{snapshot.policies.map((policy) => <article key={policy.policyId} className={styles.policyCard}>
            <header><StatePill state={policy.active ? 'ACTIVE' : 'INACTIVE'} /><code>v{policy.version}</code></header><h3>{policy.capability.replaceAll('_', ' ')} route policy</h3>
            <p>{shortId(policy.organizationId)} / {shortId(policy.schoolId)}</p><div className={styles.policyFacts}><span>Tier <b>{policy.minimumTier}</b></span><span>Ceiling <b>{policy.maxCostMicros.toLocaleString()} µUSD</b></span><span>Degraded <b>{policy.allowDegraded ? 'Allowed' : 'Blocked'}</b></span></div>
            <ol>{policy.catalogIds.map((id, index) => <li key={id}><i>{String(index + 1).padStart(2, '0')}</i>{shortId(id)}</li>)}</ol><footer><button type="button" onClick={() => editPolicy(policy)}>Edit safe metadata <b>→</b></button><button type="button" onClick={() => applyPolicyToPreview(policy.policyId)}>Preview selection <b>↗</b></button></footer>
          </article>)}</div>}
        </section>

        <section id="policy-form" className={`${styles.section} ${styles.formSection}`}>
          <div className={styles.sectionHeading}><div><span>04A / POLICY RECORD</span><h2>{policyForm.expectedVersion === 0 ? 'Add a scoped routing policy' : 'Revise routing policy metadata'}</h2></div><button className={styles.textButton} type="button" onClick={newPolicy}>New policy record +</button></div>
          <form onSubmit={submitPolicy} className={styles.formCard}>
            <fieldset disabled={!canManage || policyState.kind === 'submitting'}>
              <div className={styles.formTopline}><div><strong>Policy ID <code>{shortId(policyForm.policyId)}</code></strong><small>Expected version <code>{policyForm.expectedVersion}</code></small></div><span>SELECTION ONLY</span></div>
              <div className={styles.formGrid}>
                <label>Organization UUID<input required disabled={policyForm.expectedVersion > 0} value={policyForm.organizationId} onChange={(event) => setPolicyForm({ ...policyForm, organizationId: event.target.value.toLowerCase() })} placeholder="organization UUID" autoComplete="off" spellCheck={false} /></label>
                <label>School UUID<input required disabled={policyForm.expectedVersion > 0} value={policyForm.schoolId} onChange={(event) => setPolicyForm({ ...policyForm, schoolId: event.target.value.toLowerCase() })} placeholder="school UUID" autoComplete="off" spellCheck={false} /></label>
                <label>Requested capability<select disabled={policyForm.expectedVersion > 0} value={policyForm.capability} onChange={(event) => setPolicyForm({ ...policyForm, capability: event.target.value as Capability })}>{CAPABILITIES.map((capability) => <option key={capability} value={capability}>{capability}</option>)}</select></label>
                <label>Minimum HON tier<select value={policyForm.minimumTier} onChange={(event) => setPolicyForm({ ...policyForm, minimumTier: event.target.value as Tier })}>{TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}</select></label>
                <label>Per-decision ceiling (micro-units)<input required min="0" step="1" inputMode="numeric" value={policyForm.maxCostMicros} onChange={(event) => setPolicyForm({ ...policyForm, maxCostMicros: event.target.value })} placeholder="e.g. 500000" /></label>
                <label>Effective from<input required type="datetime-local" value={policyForm.effectiveFrom} onChange={(event) => setPolicyForm({ ...policyForm, effectiveFrom: event.target.value })} /></label>
                <label>Effective until <small>Optional</small><input type="datetime-local" value={policyForm.effectiveUntil} onChange={(event) => setPolicyForm({ ...policyForm, effectiveUntil: event.target.value })} /></label>
              </div>
              <div className={styles.switchRow}><label><input type="checkbox" checked={policyForm.active} onChange={(event) => setPolicyForm({ ...policyForm, active: event.target.checked })} /> Active policy</label><label><input type="checkbox" checked={policyForm.allowDegraded} onChange={(event) => setPolicyForm({ ...policyForm, allowDegraded: event.target.checked })} /> Allow degraded connection state</label></div>
              <fieldset className={styles.catalogPicker}><legend>Ordered approved catalog records <small>Choose up to 8</small></legend>{snapshot.catalog.length === 0 ? <p>Register catalog metadata before selecting policy candidates.</p> : snapshot.catalog.map((entry) => <label key={entry.catalogId}><input type="checkbox" checked={policyForm.catalogIds.includes(entry.catalogId)} onChange={() => setPolicyForm({ ...policyForm, catalogIds: toggle(policyForm.catalogIds, entry.catalogId) })} /><span><b>{entry.displayName}</b><small>{entry.providerId} · {entry.modelId} · {shortId(entry.catalogId)}</small></span><i>{policyForm.catalogIds.indexOf(entry.catalogId) >= 0 ? String(policyForm.catalogIds.indexOf(entry.catalogId) + 1).padStart(2, '0') : '—'}</i></label>)}</fieldset>
              <div className={styles.formActions}><button type="submit">{policyState.kind === 'submitting' ? 'Saving routing policy…' : 'Save routing policy →'}</button><span>Tenant scope and capability are immutable after policy approval.</span></div>
              <OperationNotice state={policyState} />
            </fieldset>
          </form>
        </section>

        <section id="routing-preview" className={`${styles.section} ${styles.previewSection}`}>
          <div className={styles.sectionHeading}><div><span>05 / DETERMINISTIC SELECTION</span><h2>Routing preview</h2></div><p>A read-only policy decision. It never reserves budget, invokes a provider, executes a model, calls a tool, or changes authority.</p></div>
          <form onSubmit={submitPreview} className={styles.previewCard}>
            <fieldset disabled={previewState.kind === 'submitting'}>
              <div className={styles.previewPolicyRow}><label>Registered policy<select value={previewForm.policyId} onChange={(event) => applyPolicyToPreview(event.target.value)}><option value="">Select an existing policy</option>{snapshot.policies.map((policy) => <option key={policy.policyId} value={policy.policyId}>{policy.capability} · {shortId(policy.policyId)}</option>)}</select></label><span>Live tier and entitlement are resolved by HON; this form cannot supply them.</span></div>
              <div className={styles.formGrid}>
                <label>Organization UUID<input required value={previewForm.organizationId} onChange={(event) => setPreviewForm({ ...previewForm, organizationId: event.target.value.toLowerCase() })} placeholder="organization UUID" autoComplete="off" spellCheck={false} /></label>
                <label>School UUID<input required value={previewForm.schoolId} onChange={(event) => setPreviewForm({ ...previewForm, schoolId: event.target.value.toLowerCase() })} placeholder="school UUID" autoComplete="off" spellCheck={false} /></label>
                <label>Capability<select value={previewForm.capability} onChange={(event) => setPreviewForm({ ...previewForm, capability: event.target.value as Capability })}>{CAPABILITIES.map((capability) => <option key={capability} value={capability}>{capability}</option>)}</select></label>
                <label>Billable unit<select value={previewForm.costUnit} onChange={(event) => setPreviewForm({ ...previewForm, costUnit: event.target.value as CostUnit })}>{COST_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
                <label>Estimated units<input required min="1" step="1" inputMode="numeric" value={previewForm.estimatedUnits} onChange={(event) => setPreviewForm({ ...previewForm, estimatedUnits: event.target.value })} /></label>
                <label>Budget ceiling (micro-units)<input required min="0" step="1" inputMode="numeric" value={previewForm.budgetMicros} onChange={(event) => setPreviewForm({ ...previewForm, budgetMicros: event.target.value })} /></label>
              </div>
              <CheckboxList label="Required modalities" options={MODALITIES} selected={previewForm.requiredModalities} onChange={(requiredModalities) => setPreviewForm({ ...previewForm, requiredModalities })} disabled={previewState.kind === 'submitting'} />
              <div className={styles.formActions}><button type="submit" disabled={access !== 'available'}>{previewState.kind === 'submitting' ? 'Resolving selection…' : 'Preview policy selection →'}</button><span>Execution is deliberately not available here.</span></div>
              <OperationNotice state={previewState} />
            </fieldset>
          </form>
          {preview ? <section className={`${styles.decisionCard} ${preview.status === 'SELECTED' ? styles.decisionSelected : styles.decisionDenied}`} aria-live="polite">
            <header><StatePill state={preview.status} /><span>Policy v{preview.policyVersion ?? '—'} · Effective budget {preview.budgetMicros.toLocaleString()} µUSD</span></header>
            <h3>{preview.status === 'SELECTED' ? 'Registered candidate selected' : 'No eligible registered candidate'}</h3><p>Reason: <code>{preview.reason}</code></p>
            {preview.chosen ? <div className={styles.choice}><span>CHOSEN CANDIDATE</span><strong>{preview.chosen.providerId} / {preview.chosen.modelId}</strong><small>{shortId(preview.chosen.catalogId)} · {preview.chosen.estimatedCostMicros.toLocaleString()} µUSD / {preview.chosen.costUnit} · {preview.chosen.state}</small></div> : null}
            {preview.fallbackCandidates.length > 0 ? <div className={styles.fallbacks}><span>ELIGIBLE FALLBACKS</span>{preview.fallbackCandidates.map((candidate) => <p key={candidate.catalogId}>{candidate.providerId} / {candidate.modelId}<small>{candidate.estimatedCostMicros.toLocaleString()} µUSD · {candidate.state}</small></p>)}</div> : null}
            <footer><span>Authority: <b>{preview.authority}</b></span><span>Execution: <b>{preview.execution}</b></span></footer>
          </section> : null}
        </section>
      </>}
    </section>
  </main>;
}
