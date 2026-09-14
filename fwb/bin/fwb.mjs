#!/usr/bin/env node
import { main } from '../src/cli.mjs';
try { await main(process.argv.slice(2)); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: error.code ?? 'fwb-error', message: error.message }, ...(error.artifactId ? { artifactId: error.artifactId } : {}) }, null, 2));
  process.exitCode = 1;
}
