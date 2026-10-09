import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeConfig, runtimeHeadScripts } from '../src/core/runtime-dev.mjs';

test('save flow and ad placement configuration are opt-in and platform-neutral', () => {
  validateRuntimeConfig({ saveFlow: { enabled: true, platforms: ['taptap-h5'], autoUpload: true, debounceSeconds: 5 }, ads: { enabled: true, placements: { revive: 'rewarded', between_runs: 'interstitial' }, interstitialCooldownSeconds: 120 } });
  validateRuntimeConfig({ saveFlow: { enabled: false, platforms: [] }, ads: { enabled: false } });
  assert.deepEqual(runtimeHeadScripts('web'), ['fwb-web.js']);
  assert.ok(!runtimeHeadScripts('poki').includes('fwb-taptap.js'));
});

test('save/ads configuration rejects implicit account bindings and unsafe pacing', () => {
  for (const config of [
    { saveFlow: { archiveUuid: 'stale' } }, { saveFlow: { enabled: 1 } },
    { saveFlow: { platforms: ['taptap-h5', 'taptap-h5'] } }, { saveFlow: { platforms: '*' } },
    { saveFlow: { debounceSeconds: 0 } }, { saveFlow: { autoUpload: 'true' } },
    { ads: { enabled: 'yes' } }, { ads: { placements: { revive: 'give_reward' } } },
    { ads: { placements: [] } }, { ads: { interstitialCooldownSeconds: 1 } },
    { ads: { accountId: 'player' } },
  ]) assert.throws(() => validateRuntimeConfig(config), { code: 'invalid-config' });
});
