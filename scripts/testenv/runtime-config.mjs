// Isolated lab configuration. PUBLIC_ORIGIN requires explicit temporary-site approval.
const defaults = Object.freeze({ gateway: 3443, web: 3100, api: 3001, postgres: 55440 });
export function testEnvironmentRuntime(env = process.env) {
  const ports = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const input = env[`HON_TESTENV_${key.toUpperCase()}_PORT`];
    if (input !== undefined && !/^[1-9][0-9]{3,4}$/.test(input)) throw new Error('Private test port must be an integer from 1024 through 65535.');
    const value = input === undefined ? fallback : Number(input);
    if (value < 1024 || value > 65535) throw new Error('Private test port is outside the permitted range.');
    ports[key] = value;
  }
  if (new Set(Object.values(ports)).size !== 4) throw new Error('Private test ports must be distinct.');
  const privateOrigin = `https://localhost:${ports.gateway}`;
  let origin = privateOrigin;
  if (env.HON_TESTENV_PUBLIC_ORIGIN !== undefined) {
    if (env.HON_TESTENV_PUBLIC_ACCESS_APPROVAL !== 'temporary-passcode-site-v1') throw new Error('Public test access requires explicit temporary-site approval.');
    const url = new URL(env.HON_TESTENV_PUBLIC_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/' || env.HON_TESTENV_PUBLIC_ORIGIN !== url.origin) throw new Error('Public test origin must be one exact HTTPS origin.');
    origin = url.origin;
  }
  return Object.freeze({ ports: Object.freeze(ports), origin, privateOrigin, issuer: `${origin}/__test-idp` });
}
