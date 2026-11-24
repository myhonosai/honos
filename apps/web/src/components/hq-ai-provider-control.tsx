'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ControlWriteRefused, ControlWriteUnknown, prepareControlWrite, sendControlWrite, type ControlReceipt, type ControlWrite, type ControlWritePath } from './hq-ai-provider-commands';
import { HON_SESSION_INVALIDATED_EVENT } from './session-invalidation';
import styles from './hq-ai-provider-control.module.css';

const PROVIDER_IDS = ['OPENROUTER', 'DIRECT_LLM_API', 'HEYGEN', 'HIGGSFIELD'] as const;
const CONNECTION_STATES = ['DISABLED', 'CONFIGURED', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE'] as const;
const CAPABILITIES = ['TEXT', 'VOICE_INPUT', 'VOICE_OUTPUT', 'IMAGE', 'VIDEO', 'EMBEDDING', 'TOOL_EXECUTION'] as const;
const MODALITIES = ['TEXT', 'VOICE_INPUT', 'VOICE_OUTPUT', 'IMAGE', 'VIDEO', 'EMBEDDING'] as const;
const COST_UNITS = ['TOKEN', 'SECOND', 'IMAGE', 'VIDEO', 'REQUEST'] as const;
const PRIVACY_CONTROLS = ['NO_TRAINING', 'ZERO_RETENTION'] as const;
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
  privacyControls: (typeof PRIVACY_CONTROLS)[number][];
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
type OperationState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'success'; message: string } | { kind: 'error'; message: string } | { kind: 'uncertain'; message: string };

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
  privacyControls: (typeof PRIVACY_CONTROLS)[number][];
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
    catalogId: newUuid(), providerId: 'OPENROUTER', modelId: '', displayName: '', capabilities: ['TEXT'], modalities: ['TEXT'], privacyControls: [], active: true,
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

/** Selection-only reads (route preview). Writes go through hq-ai-provider-commands, which keeps one key per save. */
async function postControl(path: string, body: object): Promise<unknown> {
  const response = await fetch(`/api/v1/hq/ai-providers/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await readBody(response);
  if (!response.ok) throw new ControlPlaneError(detailFrom(payload, 'That didn\'t save. Nothing changed. Try again.'), response.status);
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
  if (state.kind === 'idle' || state.kind === 'submitting' || state.kind === 'uncertain') return null;
  return <output className={state.kind === 'error' ? styles.errorNotice : styles.successNotice} role="status">{state.message}</output>;
}

/** Outside the locked fieldset: an unconfirmed save offers only its same-request retry, or discarding it. */
function UncertainNotice({ state, onRetry, onDiscard }: { state: OperationState; onRetry: () => void; onDiscard: () => void }): React.ReactElement | null {
  if (state.kind !== 'uncertain') return null;
  return <div className={styles.errorNotice} role="alert"><p>{state.message} The form stays locked until HON confirms this save or you discard it.</p>
    <div className={styles.formActions}><button type="button" onClick={onRetry}>Retry the same save →</button><button type="button" onClick={onDiscard}>Discard and edit again</button></div></div>;
}

const EMPTY_SNAPSHOT: Snapshot = Object.freeze({ providers: [], catalog: [], policies: [] }) as unknown as Snapshot;
const NO_WRITES = (): Record<ControlWritePath, ControlWrite | null> => ({ connections: null, catalog: null, 'routing-policies': null });

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
  // Review [18]/[19]: each read has a generation and an abort, so only the newest read can land; the session epoch
  // retires every read and write answer that started before a session ended. Unconfirmed writes are held here.
  const readGeneration = useRef(0), readAbort = useRef<AbortController | null>(null), epoch = useRef(0), mounted = useRef(true);
  const retained = useRef<Record<ControlWritePath, ControlWrite | null>>(NO_WRITES());

  const loadConfiguration = useCallback(async (quiet = false): Promise<boolean> => {
    const mine = ++readGeneration.current, shown = epoch.current;
    readAbort.current?.abort();
    const abort = new AbortController(); readAbort.current = abort;
    const current = () => mounted.current && mine === readGeneration.current && shown === epoch.current;
    if (!quiet) setAccess('checking');
    try {
      const response = await fetch('/api/v1/hq/ai-providers/configuration', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
      const payload = await readBody(response) as { data?: unknown } | undefined;
      if (!current()) return false;
      // Any refusal or failure retires the shown registry: it never stays on screen as if still verified.
      if (response.status === 401) { setSnapshot(EMPTY_SNAPSHOT); setAccess('signed-out'); return false; }
      if (response.status === 403) { setSnapshot(EMPTY_SNAPSHOT); setAccess('forbidden'); return false; }
      if (!response.ok || !isSnapshot(payload?.data)) { setSnapshot(EMPTY_SNAPSHOT); setAccess('unavailable'); return false; }
      setSnapshot(payload.data);
      setAccess('available');
      return true;
    } catch {
      if (current()) { setSnapshot(EMPTY_SNAPSHOT); setAccess('unavailable'); }
      return false;
    }
  }, []);

  useEffect(() => { mounted.current = true; void loadConfiguration(); return () => { mounted.current = false; epoch.current++; readAbort.current?.abort(); }; }, [loadConfiguration]);

  // A session end drops the registry, every form, every held write and the preview at once.
  useEffect(() => {
    const retire = () => {
      epoch.current++; readGeneration.current++; readAbort.current?.abort(); retained.current = NO_WRITES();
      setSnapshot(EMPTY_SNAPSHOT); setAccess('signed-out'); setManageBlocked(false);
      setProviderForm(blankProvider()); setCatalogForm(blankCatalog()); setPolicyForm(blankPolicy()); setPreviewForm(blankPreview()); setPreview(null);
      for (const set of [setProviderState, setCatalogState, setPolicyState, setPreviewState]) set({ kind: 'idle' });
    };
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, retire);
    return () => window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, retire);
  }, []);

  const providerById = useMemo(() => new Map(snapshot.providers.map((provider) => [provider.providerId, provider])), [snapshot.providers]);
  const activeCatalogCount = snapshot.catalog.filter((entry) => entry.active).length;
  const activePolicyCount = snapshot.policies.filter((policy) => policy.active).length;
  const canManage = access === 'available' && !manageBlocked;

  function handleAccessError(error: unknown, setState: (state: OperationState) => void, fallback: string, mutation = true): void {
    const message = error instanceof Error ? error.message : fallback;
    if (error instanceof ControlPlaneError && error.status === 401) { setSnapshot(EMPTY_SNAPSHOT); setAccess('signed-out'); }
    if (error instanceof ControlPlaneError && error.status === 403) {
      if (!mutation) {
        setAccess('forbidden');
        setState({ kind: 'error', message: 'Your HQ role can no longer see AI providers. Sign in again or ask the HQ owner.' });
        return;
      }
      setManageBlocked(true);
      setState({ kind: 'error', message: 'You can look at AI providers, but only the HQ owner can change them.' });
      return;
    }
    setState({ kind: 'error', message });
  }

  /**
   * One save: the held request for this form if its answer was lost, otherwise a new frozen request with a new key.
   * A receipt moves the editor to the server's version before the registry is re-read; a lost answer keeps the request
   * and locks the form; a definite refusal drops it.
   */
  async function runWrite(path: ControlWritePath, body: object | null, setState: (state: OperationState) => void, onReceipt: (receipt: ControlReceipt) => void, success: string, fallback: string): Promise<void> {
    let write = retained.current[path];
    if (!write) {
      if (!body) return;
      try { write = prepareControlWrite(path, body, newUuid()); } catch { setState({ kind: 'error', message: fallback }); return; }
      retained.current[path] = write;
    }
    const shown = epoch.current, held = write;
    const settle = () => { if (retained.current[path] === held) retained.current[path] = null; };
    setState({ kind: 'submitting' });
    try {
      const receipt = await sendControlWrite(held);
      if (shown !== epoch.current) return;
      settle(); onReceipt(receipt);
      setState({ kind: 'success', message: receipt.replayed ? `${success} (HON had already applied this exact save.)` : success });
      await loadConfiguration(true);
    } catch (error) {
      if (shown !== epoch.current) return;
      if (error instanceof ControlWriteUnknown) { setState({ kind: 'uncertain', message: error.message }); return; }
      settle();
      handleAccessError(error instanceof ControlWriteRefused ? new ControlPlaneError(error.message, error.status) : error, setState, fallback);
    }
  }
  const atVersion = <T extends { expectedVersion: number }>(matches: (form: T) => boolean, receipt: ControlReceipt) => (form: T): T =>
    matches(form) ? { ...form, expectedVersion: receipt.version } : form;
  const onProviderReceipt = (receipt: ControlReceipt) => setProviderForm(atVersion<ProviderForm>((f) => f.providerId === receipt.recordId, receipt));
  const onCatalogReceipt = (receipt: ControlReceipt) => setCatalogForm(atVersion<CatalogForm>((f) => f.catalogId.toLowerCase() === receipt.recordId, receipt));
  const onPolicyReceipt = (receipt: ControlReceipt) => setPolicyForm(atVersion<PolicyForm>((f) => f.policyId.toLowerCase() === receipt.recordId, receipt));
  const discard = (path: ControlWritePath, setState: (state: OperationState) => void) => { retained.current[path] = null; setState({ kind: 'idle' }); };
  const PROVIDER_SAVED = 'Saved. The connection details are updated.', CATALOG_SAVED = 'Saved. The model is on the list. Nothing was sent to it.',
    POLICY_SAVED = 'Saved. The routing rule is updated.';

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
      modalities: entry.modalities, privacyControls: entry.privacyControls, active: entry.active, minimumTier: entry.minimumTier, unitCostMicros: String(entry.unitCostMicros),
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
      setProviderState({ kind: 'error', message: 'Enter the secret\'s reference ID (a hon-secret UUID), never the key itself.' });
      return;
    }
    await runWrite('connections', { ...providerForm, displayName: providerForm.displayName.trim(), credentialSecretRef: ref }, setProviderState, onProviderReceipt,
      PROVIDER_SAVED, 'The connection didn\'t save. Nothing changed.');
  }

  async function submitCatalog(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canManage) return;
    const effectiveFrom = toIso(catalogForm.effectiveFrom);
    const effectiveUntil = catalogForm.effectiveUntil ? toIso(catalogForm.effectiveUntil) : null;
    const unitCostMicros = Number(catalogForm.unitCostMicros);
    if (!effectiveFrom || (catalogForm.effectiveUntil && !effectiveUntil) || catalogForm.capabilities.length === 0 || catalogForm.modalities.length === 0 || !Number.isSafeInteger(unitCostMicros) || unitCostMicros < 0) {
      setCatalogState({ kind: 'error', message: 'Fill in at least one capability, one input type, the dates, and a cost (a whole number, 0 or more).' });
      return;
    }
    await runWrite('catalog', { ...catalogForm, modelId: catalogForm.modelId.trim(), displayName: catalogForm.displayName.trim(), unitCostMicros, effectiveFrom, effectiveUntil },
      setCatalogState, onCatalogReceipt, CATALOG_SAVED, 'The model didn\'t save. Nothing changed.');
  }

  async function submitPolicy(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canManage) return;
    const effectiveFrom = toIso(policyForm.effectiveFrom);
    const effectiveUntil = policyForm.effectiveUntil ? toIso(policyForm.effectiveUntil) : null;
    const maxCostMicros = Number(policyForm.maxCostMicros);
    if (!effectiveFrom || (policyForm.effectiveUntil && !effectiveUntil) || policyForm.catalogIds.length === 0 || policyForm.catalogIds.length > 8 || !Number.isSafeInteger(maxCostMicros) || maxCostMicros < 0) {
      setPolicyState({ kind: 'error', message: 'Pick 1 to 8 models, the dates, and a cost limit (a whole number, 0 or more).' });
      return;
    }
    await runWrite('routing-policies', { ...policyForm, organizationId: policyForm.organizationId.trim(), schoolId: policyForm.schoolId.trim(), maxCostMicros, effectiveFrom, effectiveUntil },
      setPolicyState, onPolicyReceipt, POLICY_SAVED, 'The routing rule didn\'t save. Nothing changed.');
  }

  async function submitPreview(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (access !== 'available') return;
    const estimatedUnits = Number(previewForm.estimatedUnits);
    const budgetMicros = Number(previewForm.budgetMicros);
    if (previewForm.requiredModalities.length === 0 || !Number.isSafeInteger(estimatedUnits) || estimatedUnits < 1 || !Number.isSafeInteger(budgetMicros) || budgetMicros < 0) {
      setPreviewState({ kind: 'error', message: 'Fill in at least one input type, an estimated size, and a budget limit (whole numbers).' });
      return;
    }
    setPreviewState({ kind: 'submitting' });
    setPreview(null);
    try {
      const payload = await postControl('route-preview', {
        ...previewForm, organizationId: previewForm.organizationId.trim(), schoolId: previewForm.schoolId.trim(), policyId: previewForm.policyId.trim(), estimatedUnits, budgetMicros,
      }) as { data?: RouteDecision };
      if (!payload.data || (payload.data.status !== 'SELECTED' && payload.data.status !== 'DENIED')) throw new Error('The test result couldn\'t be read. Try again.');
      setPreview(payload.data);
      setPreviewState({ kind: 'success', message: 'Test done. This only shows which model would be picked; no AI was called.' });
    } catch (error) {
      handleAccessError(error, setPreviewState, 'The test didn\'t run. Try again.', false);
    }
  }

  const accessMessage = access === 'checking' ? 'Checking your access…'
    : access === 'signed-out' ? 'Sign in to see AI providers.'
      : access === 'forbidden' ? 'Your HQ role can\'t see AI providers. Ask the HQ owner.'
        : 'AI providers couldn\'t load right now. Nothing changed. Try again.';

  return <div className={styles.page}>
    <aside className={styles.rail} aria-label="Provider control gate and sections">
      <div className={styles.gateCard}><span>WHO CAN USE THIS</span><strong>HQ owner only</strong><p>Choose which AI services and models HON uses. Schools never see this page.</p></div>
      <nav aria-label="AI provider control sections">
        <a href="#registry"><i>·</i>Overview</a>
        <a href="#connection-form"><i>1</i>Connect a service</a>
        <a href="#catalog-form"><i>2</i>Allowed models</a>
        <a href="#policy-form"><i>3</i>Routing rules</a>
        <a href="#routing-preview"><i>4</i>Test a request</a>
      </nav>
      <div className={styles.railFoot}><span className={access === 'available' ? styles.liveDot : styles.dimDot} />{access === 'available' ? 'You can view this page' : 'Waiting for access'}</div>
    </aside>

    <section className={styles.workspace}>
      <header className={styles.header}>
        <div><p>SETTINGS / AI PROVIDERS</p><h2>Pick the AI services HON uses.<br /><em>Set the order and the cost limits.</em></h2></div>
        <div className={styles.sessionCard}><span>HQ SESSION</span><strong>{access === 'available' ? 'Ready' : access === 'checking' ? 'Checking access…' : 'No access'}</strong></div>
      </header>

      <section className={styles.safetyBand} aria-label="Control-plane limits">
        <div><span className={styles.signal} />HOW IT WORKS</div>
        <p><b>1.</b> Connect a provider (paste its secret reference ID, never the key). <b>2.</b> Add the models you allow. <b>3.</b> Make a routing rule that picks models in order. <b>4.</b> Test which model a request would use. Nothing on this page calls an AI or spends money.</p>
      </section>

      {access !== 'available' ? <section className={styles.accessPanel} aria-live="polite">
        <span>AI PROVIDERS</span><h2>{accessMessage}</h2>
        {access === 'signed-out' ? <a href="/auth/login">Sign in <b>→</b></a> : <button type="button" onClick={() => void loadConfiguration()}>{access === 'checking' ? 'Checking access…' : 'Try again'}</button>}

      </section> : <>
        {manageBlocked ? <section className={styles.manageNotice}><strong>You can look but not change.</strong><span>The last change was refused, so the forms are locked. You can still view everything and run tests.</span></section> : null}

        <section id="registry" className={styles.heroGrid}>
          <article className={styles.heroCopy}><p>AT A GLANCE</p><h2>Your AI services, allowed models and routing rules.</h2><span>A status here is what HQ saved, not a live check of the service.</span></article>
          <div className={styles.metrics}>
            <article><span>REGISTERED</span><strong>{snapshot.providers.length}</strong><small>connected services</small></article>
            <article><span>ACTIVE CATALOG</span><strong>{activeCatalogCount}</strong><small>allowed models</small></article>
            <article><span>ACTIVE POLICIES</span><strong>{activePolicyCount}</strong><small>routing rules</small></article>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}><div><span>OVERVIEW</span><h2>AI services</h2></div><p>Shows only whether a secret is linked, never the secret itself.</p></div>
          <div className={styles.providerGrid}>{PROVIDER_IDS.map((providerId) => {
            const provider = providerById.get(providerId);
            return <article key={providerId} className={styles.providerCard}>
              <header><code>{providerId}</code><StatePill state={provider?.state ?? 'NOT REGISTERED'} /></header>
              <strong>{provider?.displayName || 'No connection record'}</strong>
              <p>{provider?.credentialConfigured ? 'Secret linked' : 'No secret linked'}</p>
              <footer><span>v{provider?.version ?? 0}</span><button type="button" onClick={() => { chooseProvider(providerId); document.getElementById('connection-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>Edit <b>→</b></button></footer>
            </article>;
          })}</div>
        </section>

        <section id="connection-form" className={`${styles.section} ${styles.formSection}`}>
          <div className={styles.sectionHeading}><div><span>STEP 1</span><h2>Connect or edit a service</h2></div><p>If someone else changed it first, your save is refused instead of overwriting theirs.</p></div>
          <form onSubmit={submitProvider} className={styles.formCard}>
            <fieldset disabled={!canManage || providerState.kind === 'submitting' || providerState.kind === 'uncertain'}>
              <div className={styles.formTopline}><div><strong>{providerForm.expectedVersion === 0 ? 'Connect a service' : 'Edit service'}</strong><small>Expected version <code>{providerForm.expectedVersion}</code></small></div><span>NO PROVIDER CALLS</span></div>
              <div className={styles.formGrid}>
                <label>Provider type<select value={providerForm.providerId} onChange={(event) => chooseProvider(event.target.value as ProviderId)}>{PROVIDER_IDS.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
                <label>Connection status<select value={providerForm.state} onChange={(event) => setProviderForm({ ...providerForm, state: event.target.value as ConnectionState, credentialSecretRef: event.target.value === 'DISABLED' ? '' : providerForm.credentialSecretRef })}>{CONNECTION_STATES.map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
                <label>Display name<input required maxLength={80} value={providerForm.displayName} onChange={(event) => setProviderForm({ ...providerForm, displayName: event.target.value })} placeholder="Approved provider label" autoComplete="off" /></label>
                <label>Secret reference ID <input required={providerForm.state !== 'DISABLED'} disabled={providerForm.state === 'DISABLED'} value={providerForm.credentialSecretRef} onChange={(event) => setProviderForm({ ...providerForm, credentialSecretRef: event.target.value.toLowerCase() })} placeholder="hon-secret:UUID-v4" autoComplete="off" spellCheck={false} /></label>
              </div>
              <p className={styles.referenceRule}><b>Paste the reference ID, never the key.</b> Turning a service on needs a <code>hon-secret:</code> reference ID. Never paste a key, token, password or URL.</p>
              <div className={styles.formActions}><button type="submit">{providerState.kind === 'submitting' ? 'Saving…' : 'Save →'}</button><span>Saving doesn't contact the service.</span></div>
              <OperationNotice state={providerState} />
            </fieldset>
            <UncertainNotice state={providerState} onRetry={() => void runWrite('connections', null, setProviderState, onProviderReceipt, PROVIDER_SAVED, 'The connection didn\'t save. Nothing changed.')} onDiscard={() => discard('connections', setProviderState)} />
          </form>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}><div><span>STEP 2</span><h2>Allowed models</h2></div><p>The models HON may use, what each can do, and its cost.</p></div>
          {snapshot.catalog.length === 0 ? <div className={styles.emptyState}><strong>No models added yet.</strong><span>Add one below.</span></div> : <div className={styles.catalogGrid}>{snapshot.catalog.map((entry) => <article key={entry.catalogId} className={styles.catalogCard}>
            <header><div><code>{entry.providerId}</code><strong>{entry.displayName}</strong></div><StatePill state={entry.active ? 'ACTIVE' : 'INACTIVE'} /></header>
            <p className={styles.modelId}>{entry.modelId}</p>
            <dl><div><dt>Capabilities</dt><dd>{entry.capabilities.join(' · ')}</dd></div><div><dt>Modalities</dt><dd>{entry.modalities.join(' · ')}</dd></div><div><dt>Economics</dt><dd>{entry.unitCostMicros.toLocaleString()} µUSD / {entry.costUnit}</dd></div><div><dt>Window</dt><dd>{new Date(entry.effectiveFrom).toLocaleString()} {entry.effectiveUntil ? `→ ${new Date(entry.effectiveUntil).toLocaleString()}` : '→ open'}</dd></div></dl>
            <footer><span>v{entry.version} · {shortId(entry.catalogId)}</span><button type="button" onClick={() => editCatalog(entry)}>Edit <b>→</b></button></footer>
          </article>)}</div>}
        </section>

        <section id="catalog-form" className={`${styles.section} ${styles.formSection}`}>
          <div className={styles.sectionHeading}><div><span>03A / CATALOG RECORD</span><h2>{catalogForm.expectedVersion === 0 ? 'Add a model' : 'Revise catalog metadata'}</h2></div><button className={styles.textButton} type="button" onClick={newCatalog}>Add a model +</button></div>
          <form onSubmit={submitCatalog} className={styles.formCard}>
            <fieldset disabled={!canManage || catalogState.kind === 'submitting' || catalogState.kind === 'uncertain'}>
              <div className={styles.formTopline}><div><strong>Catalog ID <code>{shortId(catalogForm.catalogId)}</code></strong><small>Expected version <code>{catalogForm.expectedVersion}</code></small></div><span>DETAILS</span></div>
              <div className={styles.formGrid}>
                <label>Provider type<select disabled={catalogForm.expectedVersion > 0} value={catalogForm.providerId} onChange={(event) => setCatalogForm({ ...catalogForm, providerId: event.target.value as ProviderId })}>{PROVIDER_IDS.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
                <label>Model ID<input required disabled={catalogForm.expectedVersion > 0} maxLength={120} value={catalogForm.modelId} onChange={(event) => setCatalogForm({ ...catalogForm, modelId: event.target.value })} placeholder="approved/model-v1" autoComplete="off" spellCheck={false} /></label>
                <label>Display name<input required maxLength={80} value={catalogForm.displayName} onChange={(event) => setCatalogForm({ ...catalogForm, displayName: event.target.value })} placeholder="Approved text model" autoComplete="off" /></label>
                <label>Minimum HON tier<select value={catalogForm.minimumTier} onChange={(event) => setCatalogForm({ ...catalogForm, minimumTier: event.target.value as Tier })}>{TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}</select></label>
                <label>Cost (USD micro-units, whole number)<input required min="0" step="1" inputMode="numeric" value={catalogForm.unitCostMicros} onChange={(event) => setCatalogForm({ ...catalogForm, unitCostMicros: event.target.value })} placeholder="e.g. 10" /></label>
                <label>Billable unit<select disabled={catalogForm.expectedVersion > 0} value={catalogForm.costUnit} onChange={(event) => setCatalogForm({ ...catalogForm, costUnit: event.target.value as CostUnit })}>{COST_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
                <label>Effective from<input required type="datetime-local" value={catalogForm.effectiveFrom} onChange={(event) => setCatalogForm({ ...catalogForm, effectiveFrom: event.target.value })} /></label>
                <label>Effective until <small>Optional</small><input type="datetime-local" value={catalogForm.effectiveUntil} onChange={(event) => setCatalogForm({ ...catalogForm, effectiveUntil: event.target.value })} /></label>
              </div>
              <div className={styles.switchRow}><label><input type="checkbox" checked={catalogForm.active} onChange={(event) => setCatalogForm({ ...catalogForm, active: event.target.checked })} /> Active for policy selection</label><span>Service, model and billing unit can't change later. Add a new model instead.</span></div>
              <p>Privacy boxes record what HQ believes about this model. Leave empty if unsure.</p>
              <CheckboxList label="Privacy attestations" options={PRIVACY_CONTROLS} selected={catalogForm.privacyControls} onChange={(privacyControls) => setCatalogForm({ ...catalogForm, privacyControls })} disabled={!canManage || catalogState.kind === 'submitting' || catalogState.kind === 'uncertain'} />
              <div className={styles.checkboxGrid}><CheckboxList label="Capabilities" options={CAPABILITIES} selected={catalogForm.capabilities} onChange={(capabilities) => setCatalogForm({ ...catalogForm, capabilities })} disabled={!canManage || catalogState.kind === 'submitting' || catalogState.kind === 'uncertain'} /><CheckboxList label="Modalities" options={MODALITIES} selected={catalogForm.modalities} onChange={(modalities) => setCatalogForm({ ...catalogForm, modalities })} disabled={!canManage || catalogState.kind === 'submitting' || catalogState.kind === 'uncertain'} /></div>
              <div className={styles.formActions}><button type="submit">{catalogState.kind === 'submitting' ? 'Saving…' : 'Save catalog record →'}</button><span>Nothing is sent to the model.</span></div>
              <OperationNotice state={catalogState} />
            </fieldset>
            <UncertainNotice state={catalogState} onRetry={() => void runWrite('catalog', null, setCatalogState, onCatalogReceipt, CATALOG_SAVED, 'The model didn\'t save. Nothing changed.')} onDiscard={() => discard('catalog', setCatalogState)} />
          </form>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}><div><span>STEP 3</span><h2>Which model to use, in order</h2></div><p>A rule tries the models in the order you list. It doesn't give anyone extra access.</p></div>
          {snapshot.policies.length === 0 ? <div className={styles.emptyState}><strong>No routing rules yet.</strong><span>HON can't pick a model until you add one.</span></div> : <div className={styles.policyGrid}>{snapshot.policies.map((policy) => <article key={policy.policyId} className={styles.policyCard}>
            <header><StatePill state={policy.active ? 'ACTIVE' : 'INACTIVE'} /><code>v{policy.version}</code></header><h3>{policy.capability.replaceAll('_', ' ')} route policy</h3>
            <p>{shortId(policy.organizationId)} / {shortId(policy.schoolId)}</p><div className={styles.policyFacts}><span>Tier <b>{policy.minimumTier}</b></span><span>Ceiling <b>{policy.maxCostMicros.toLocaleString()} µUSD</b></span><span>Degraded <b>{policy.allowDegraded ? 'Allowed' : 'Blocked'}</b></span></div>
            <ol>{policy.catalogIds.map((id, index) => <li key={id}><i>{String(index + 1).padStart(2, '0')}</i>{shortId(id)}</li>)}</ol><footer><button type="button" onClick={() => editPolicy(policy)}>Edit <b>→</b></button><button type="button" onClick={() => applyPolicyToPreview(policy.policyId)}>Test <b>↗</b></button></footer>
          </article>)}</div>}
        </section>

        <section id="policy-form" className={`${styles.section} ${styles.formSection}`}>
          <div className={styles.sectionHeading}><div><span>04A / POLICY RECORD</span><h2>{policyForm.expectedVersion === 0 ? 'Add a routing rule' : 'Edit routing rule'}</h2></div><button className={styles.textButton} type="button" onClick={newPolicy}>Add a routing rule +</button></div>
          <form onSubmit={submitPolicy} className={styles.formCard}>
            <fieldset disabled={!canManage || policyState.kind === 'submitting' || policyState.kind === 'uncertain'}>
              <div className={styles.formTopline}><div><strong>Policy ID <code>{shortId(policyForm.policyId)}</code></strong><small>Expected version <code>{policyForm.expectedVersion}</code></small></div><span>SELECTION ONLY</span></div>
              <div className={styles.formGrid}>
                <label>Organization UUID<input required disabled={policyForm.expectedVersion > 0} value={policyForm.organizationId} onChange={(event) => setPolicyForm({ ...policyForm, organizationId: event.target.value.toLowerCase() })} placeholder="organization UUID" autoComplete="off" spellCheck={false} /></label>
                <label>School UUID<input required disabled={policyForm.expectedVersion > 0} value={policyForm.schoolId} onChange={(event) => setPolicyForm({ ...policyForm, schoolId: event.target.value.toLowerCase() })} placeholder="school UUID" autoComplete="off" spellCheck={false} /></label>
                <label>What it's for<select disabled={policyForm.expectedVersion > 0} value={policyForm.capability} onChange={(event) => setPolicyForm({ ...policyForm, capability: event.target.value as Capability })}>{CAPABILITIES.map((capability) => <option key={capability} value={capability}>{capability}</option>)}</select></label>
                <label>Minimum HON tier<select value={policyForm.minimumTier} onChange={(event) => setPolicyForm({ ...policyForm, minimumTier: event.target.value as Tier })}>{TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}</select></label>
                <label>Cost limit per request (micro-units)<input required min="0" step="1" inputMode="numeric" value={policyForm.maxCostMicros} onChange={(event) => setPolicyForm({ ...policyForm, maxCostMicros: event.target.value })} placeholder="e.g. 500000" /></label>
                <label>Effective from<input required type="datetime-local" value={policyForm.effectiveFrom} onChange={(event) => setPolicyForm({ ...policyForm, effectiveFrom: event.target.value })} /></label>
                <label>Effective until <small>Optional</small><input type="datetime-local" value={policyForm.effectiveUntil} onChange={(event) => setPolicyForm({ ...policyForm, effectiveUntil: event.target.value })} /></label>
              </div>
              <div className={styles.switchRow}><label><input type="checkbox" checked={policyForm.active} onChange={(event) => setPolicyForm({ ...policyForm, active: event.target.checked })} /> Active policy</label><label><input type="checkbox" checked={policyForm.allowDegraded} onChange={(event) => setPolicyForm({ ...policyForm, allowDegraded: event.target.checked })} /> Allow a service marked as having problems</label></div>
              <fieldset className={styles.catalogPicker}><legend>Models, in order <small>Choose up to 8</small></legend>{snapshot.catalog.length === 0 ? <p>Add models in step 2 first.</p> : snapshot.catalog.map((entry) => <label key={entry.catalogId}><input type="checkbox" checked={policyForm.catalogIds.includes(entry.catalogId)} onChange={() => setPolicyForm({ ...policyForm, catalogIds: toggle(policyForm.catalogIds, entry.catalogId) })} /><span><b>{entry.displayName}</b><small>{entry.providerId} · {entry.modelId} · {shortId(entry.catalogId)}</small></span><i>{policyForm.catalogIds.indexOf(entry.catalogId) >= 0 ? String(policyForm.catalogIds.indexOf(entry.catalogId) + 1).padStart(2, '0') : '—'}</i></label>)}</fieldset>
              <div className={styles.formActions}><button type="submit">{policyState.kind === 'submitting' ? 'Saving routing policy…' : 'Save routing policy →'}</button><span>Organization and purpose can't change after saving.</span></div>
              <OperationNotice state={policyState} />
            </fieldset>
            <UncertainNotice state={policyState} onRetry={() => void runWrite('routing-policies', null, setPolicyState, onPolicyReceipt, POLICY_SAVED, 'The routing rule didn\'t save. Nothing changed.')} onDiscard={() => discard('routing-policies', setPolicyState)} />
          </form>
        </section>

        <section id="routing-preview" className={`${styles.section} ${styles.previewSection}`}>
          <div className={styles.sectionHeading}><div><span>STEP 4</span><h2>Test a request</h2></div><p>Shows which model a request would use. No AI is called and no money is spent.</p></div>
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
  </div>;
}
