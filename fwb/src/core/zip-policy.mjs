import { fail } from './files.mjs';

// TapTap H5 upload UI, verified 2026-10-09: one enclosing directory and
// index.html inside it; the uploaded ZIP is checked against 300 * 1024 * 1024.
// Sources and scope are recorded in docs/build-delivery.md.
export function zipPolicy(artifact) {
  const entry = (artifact.entry ?? 'out/index.html').replace(/^out\//, '');
  if (artifact.target !== 'taptap-h5') return { rootDirectory: '', entry, maxBytes: null };
  if (entry !== 'index.html' || !artifact.outputs.some(file => file.path === 'out/index.html')) {
    fail('invalid-package', 'TapTap H5 ZIP requires index.html directly inside its enclosing game directory.');
  }
  return { rootDirectory: 'game', entry: 'game/index.html', maxBytes: 300 * 1024 * 1024 };
}

export function validateZipSize(policy, bytes) {
  if (policy.maxBytes !== null && bytes > policy.maxBytes) {
    fail('package-too-large', `TapTap H5 upload ZIP exceeds the observed 300 MiB limit (${bytes} bytes).`);
  }
}
