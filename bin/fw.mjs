#!/usr/bin/env node
import { main } from '../src/cli.mjs';

try { await main(process.argv.slice(2)); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.code ?? 'fw-error', message: error.message, ...(error.details ? { details: error.details } : {}) }, null, 2));
  process.exitCode = 1;
}
