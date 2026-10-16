import { HON_INTERFACE_THEME_IDS, type HonInterfaceTheme } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SELECTED_VIA = ['DEFAULT', 'ONBOARDING', 'SETTINGS'] as const;

type SelectedVia = (typeof SELECTED_VIA)[number];
type SavedSelectedVia = Exclude<SelectedVia, 'DEFAULT'>;
export type InterfaceThemeScope = { organizationId: string; schoolId: string };
export type InterfaceThemePreference = {
  interfaceTheme: HonInterfaceTheme;
  selectedVia: SelectedVia;
  updatedAt?: string;
  replayed?: boolean;
};

export class InterfaceThemePreferenceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function invalid(): never { throw new Error('The interface preference was not verified for the current user and school. No presentation change is assumed.'); }
function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(row, key)) || Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function scopeId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!UUID.test(id)) throw new Error('A verified organization and school scope is required before changing an interface preference.');
  return id;
}
function requireScope(scope: InterfaceThemeScope): { organizationId: string; schoolId: string } {
  return { organizationId: scopeId(scope.organizationId), schoolId: scopeId(scope.schoolId) };
}
function requireTheme(value: HonInterfaceTheme): HonInterfaceTheme {
  if (!HON_INTERFACE_THEME_IDS.includes(value)) throw new Error('Choose one of the shared HON interface themes.');
  return value;
}
function requireSavedSelectedVia(value: SavedSelectedVia): SavedSelectedVia {
  if (value !== 'ONBOARDING' && value !== 'SETTINGS') throw new Error('The interface preference source must be the closed ONBOARDING or SETTINGS value.');
  return value;
}
function requireKey(value: string): string {
  if (!UUID.test(value)) throw new Error('A generated preference retry key is required.');
  return value;
}

/** Existing scoped preference endpoint; scope must come from verified current launch context, never form input. */
export function interfaceThemePreferencePath(scope: InterfaceThemeScope): string {
  const verified = requireScope(scope);
  return `/api/v1/organizations/${verified.organizationId}/schools/${verified.schoolId}/interface-theme`;
}

function verifyPreference(value: unknown): InterfaceThemePreference {
  const row = exactRecord(value, ['interfaceTheme', 'selectedVia'], ['updatedAt', 'replayed']);
  if (!HON_INTERFACE_THEME_IDS.includes(row.interfaceTheme as HonInterfaceTheme) || !SELECTED_VIA.includes(row.selectedVia as SelectedVia)) invalid();
  if (row.updatedAt !== undefined && (typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt)))) invalid();
  if (row.replayed !== undefined && typeof row.replayed !== 'boolean') invalid();
  return {
    interfaceTheme: row.interfaceTheme as HonInterfaceTheme,
    selectedVia: row.selectedVia as SelectedVia,
    ...(row.updatedAt === undefined ? {} : { updatedAt: new Date(row.updatedAt as string).toISOString() }),
    ...(row.replayed === undefined ? {} : { replayed: row.replayed as boolean }),
  };
}

async function request(path: string, options: RequestInit): Promise<InterfaceThemePreference> {
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!response.ok) {
    const message = response.status === 401
      ? 'Sign in with your verified human session before changing your personal presentation preference.'
      : response.status === 403
        ? 'Your personal interface preference is unavailable for this verified school. No presentation change was saved.'
        : response.status === 409
          ? 'The interface preference could not be saved because its retry conflicted. No presentation change is assumed.'
          : 'The interface preference is unavailable. No presentation change is assumed.';
    throw new InterfaceThemePreferenceError(message, response.status);
  }
  let body: unknown;
  try { body = await response.json(); } catch { invalid(); }
  return verifyPreference(exactRecord(body, ['data', 'meta']).data);
}

export async function loadInterfaceThemePreference(scope: InterfaceThemeScope): Promise<InterfaceThemePreference> {
  return request(interfaceThemePreferencePath(scope), { method: 'GET', headers: { Accept: 'application/json' } });
}

/** Presentation-only save; the ONBOARDING default preserves OwnerLaunch's fixed transport. */
export async function saveInterfaceThemePreference(scope: InterfaceThemeScope, interfaceTheme: HonInterfaceTheme, idempotencyKey: string, selectedVia: SavedSelectedVia = 'ONBOARDING'): Promise<InterfaceThemePreference> {
  const theme = requireTheme(interfaceTheme);
  const key = requireKey(idempotencyKey);
  const via = requireSavedSelectedVia(selectedVia);
  return request(interfaceThemePreferencePath(scope), {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ interfaceTheme: theme, selectedVia: via }),
  });
}
