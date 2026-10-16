export const KIOSK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const KIOSK_SECRET = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export function kioskExactInput(value: unknown, keys: readonly string[]): asserts value is Record<string, string> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('KIOSK_INVALID');
 const input = value as Record<string, unknown>;
 if (Object.keys(input).length !== keys.length || Object.keys(input).some(k => !keys.includes(k)) || keys.some(k => typeof input[k] !== 'string')) throw new Error('KIOSK_INVALID');
 for (const key of keys) if (!(key === 'claim' || key === 'terminalSession' ? KIOSK_SECRET : KIOSK_UUID).test(input[key] as string)) throw new Error('KIOSK_INVALID');
}
