#!/usr/bin/env node
// Fails unless the running Node.js is a supported release line at or above its latest security
// release. CI runs this immediately after actions/setup-node so a job can never silently fall
// back to an unpatched runtime (for example a runner image's cached 22.x).
//
// Usage: node .github/scripts/verify-node-runtime.mjs [--expect <exact x.y.z>]
//   --expect additionally requires the exact version a workflow pinned, so a pin and the
//   runtime that actually executed cannot drift apart.
//
// Raise a floor only after the Node.js project publishes the new security release:
// https://nodejs.org/en/blog/vulnerability/
//
// Plain Node.js only: no dependencies, network, files, environment variables or credentials.

import { pathToFileURL } from 'node:url';

// Minimum patched release per supported line: Node.js security releases of 2026-10-21
// (https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), including
// CVE-2026-111497 (Brotli decoder out-of-bounds write, high) on 22.x, 24.x and 26.x.
export const MINIMUM_PATCHED = Object.freeze({ 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' });

const parse = (version) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  return match ? match.slice(1, 4).map(Number) : null;
};

const compare = (left, right) => {
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
};

/** Returns null when `version` is acceptable, otherwise the reason it is refused. */
export function nodeRuntimeRefusal(version, expected = null) {
  const actual = parse(version);
  if (!actual) return `unrecognized Node.js version "${version}"`;
  if (expected !== null) {
    const pinned = parse(expected);
    if (!pinned) return `unrecognized expected Node.js version "${expected}"`;
    if (compare(actual, pinned) !== 0) return `Node.js ${actual.join('.')} is running but the workflow pinned ${pinned.join('.')}`;
  }
  const floor = MINIMUM_PATCHED[actual[0]];
  if (!floor) return `Node.js ${actual[0]}.x is not a supported release line (supported: ${Object.keys(MINIMUM_PATCHED).map((major) => `${major}.x`).join(', ')})`;
  if (compare(actual, parse(floor)) < 0) return `Node.js ${actual.join('.')} predates the ${actual[0]}.x security release ${floor}`;
  return null;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let expected = null;
  if (args.length === 2 && args[0] === '--expect') expected = args[1];
  else if (args.length !== 0) {
    console.error('Usage: verify-node-runtime.mjs [--expect <x.y.z>]');
    process.exit(2);
  }
  const refusal = nodeRuntimeRefusal(process.versions.node, expected);
  if (refusal) {
    console.error(`Refusing: ${refusal}.`);
    process.exit(1);
  }
  console.log(`Node.js ${process.versions.node} is a patched supported release (floor ${MINIMUM_PATCHED[process.versions.node.split('.')[0]]}).`);
}
