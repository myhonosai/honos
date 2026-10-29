// Shared, dependency-free redaction for operational telemetry (API logs, web server logs and
// browser error reports). Telemetry is allowlist-first: callers emit only fixed operational fields,
// and any free text that must be kept (an error message) passes through redactTelemetryText first.
// Student, parent, school-contact and payment details and every credential are replaced, never hashed.

export const TELEMETRY_REDACTED = '[REDACTED]';
export const TELEMETRY_TEXT_LIMIT = 300;

const TEXT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Connection strings and any URL carrying credentials.
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]*@[^\s]*/gi, `${TELEMETRY_REDACTED}_URL`],
  [/\bpostgres(?:ql)?:\/\/[^\s]+/gi, `${TELEMETRY_REDACTED}_URL`],
  // PEM blocks (keys or certificates).
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, `${TELEMETRY_REDACTED}_PEM`],
  // Authorization headers, cookies and key=value secrets.
  [/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `${TELEMETRY_REDACTED}_AUTH`],
  [/\b(?:authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|secret|token|session)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi, `${TELEMETRY_REDACTED}_SECRET`],
  // JWTs, provider keys and webhook secrets.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, `${TELEMETRY_REDACTED}_JWT`],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, `${TELEMETRY_REDACTED}_KEY`],
  [/\bwhsec_[A-Za-z0-9]{8,}\b/g, `${TELEMETRY_REDACTED}_KEY`],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, `${TELEMETRY_REDACTED}_KEY`],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g, `${TELEMETRY_REDACTED}_KEY`],
  [/\bAKIA[0-9A-Z]{16}\b/g, `${TELEMETRY_REDACTED}_KEY`],
  // Personal contact details.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, `${TELEMETRY_REDACTED}_EMAIL`],
  // Card-like numbers (13-19 digits with optional separators), before generic phone numbers.
  [/\b(?:\d[ -]?){12,18}\d\b/g, `${TELEMETRY_REDACTED}_NUMBER`],
  [/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?\b/g, `${TELEMETRY_REDACTED}_PHONE`],
  [/\+\d{8,15}\b/g, `${TELEMETRY_REDACTED}_PHONE`],
  // Long opaque secrets. UUIDs (longest group 12) and diagnostic ids remain as references.
  // A run of 24+ base64/hex characters (with any attached '-' / '=' pieces) is treated as a secret.
  // '/' and '.' are excluded so file paths in stack frames survive.
  [/[A-Za-z0-9_+=-]*[A-Za-z0-9_+]{24,}[A-Za-z0-9_+=-]*/g, `${TELEMETRY_REDACTED}_OPAQUE`],
];

// PostgreSQL error text quotes offending values ("Key (email)=(x@y.z) already exists") and HON
// command errors can quote input. Quoted values are removed wholesale.
const UUID_REFERENCE = /\b(?:hon-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const QUOTED_VALUE = /\((?:[^()]{0,200})\)=\((?:[^()]*)\)|"[^"]{0,500}"|'[^']{0,500}'/g;

export function redactTelemetryText(value: unknown, limit = TELEMETRY_TEXT_LIMIT): string {
  let text = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value ?? '');
  // Bound work before applying patterns to attacker-influenced input.
  if (text.length > limit * 8) text = text.slice(0, limit * 8);
  text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  text = text.replace(QUOTED_VALUE, TELEMETRY_REDACTED);
  // UUIDs and diagnostic ids are opaque references, not personal data: shield them from the
  // number/phone rules (their digit groups would otherwise look like phone numbers).
  const shielded: string[] = [];
  text = text.replace(UUID_REFERENCE, (match) => `\u0001${shielded.push(match) - 1}\u0001`);
  for (const [pattern, replacement] of TEXT_RULES) text = text.replace(pattern, replacement);
  text = text.replace(/\u0001(\d+)\u0001/g, (_match, index: string) => shielded[Number(index)] ?? TELEMETRY_REDACTED);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// Property names whose values are never emitted, regardless of content.
const SENSITIVE_KEY = /pass(word)?|secret|token|authori[sz]ation|cookie|session|api[-_]?key|credential|signature|private|jwt|dsn|connection|database[-_]?url|email|phone|mobile|address|street|postal|zip|birth|dob|first[-_]?name|last[-_]?name|full[-_]?name|display[-_]?name|guardian|parent|student|child|family|medical|allerg|note|comment|message[-_]?body|card|iban|account[-_]?number|routing|bank|ssn|tax[-_]?id/i;

export function isSensitiveTelemetryKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

// Redacts a small structured value for logging. Depth, breadth and string size are bounded.
export function redactTelemetryValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactTelemetryText(value);
  if (depth >= 3) return TELEMETRY_REDACTED;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactTelemetryValue(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      output[key] = isSensitiveTelemetryKey(key) ? TELEMETRY_REDACTED : redactTelemetryValue(item, depth + 1);
    }
    return output;
  }
  return TELEMETRY_REDACTED;
}

// A request path for logs: query and fragment dropped, and any segment that is not an obvious
// route word or opaque identifier (for example an email, token or phone number) replaced.
export function redactTelemetryPath(path: unknown): string {
  if (typeof path !== 'string' || !path.startsWith('/')) return 'unknown';
  const bare = path.split(/[?#]/, 1)[0]!.slice(0, 512);
  return bare.split('/').map((segment) => {
    if (segment === '' || /^:[A-Za-z][A-Za-z0-9_]*$/.test(segment)) return segment;
    // Route words are lowercase letters and dashes (identifiers and tokens contain digits).
    if (/^[a-z][a-z-]{0,62}$/.test(segment)) return segment;
    if (/^v\d{1,2}$/.test(segment)) return segment;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':id';
    return ':value';
  }).join('/');
}

// A diagnostic identifier is opaque, random and safe to show to a customer.
export const DIAGNOSTIC_ID_PATTERN = /^hon-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
