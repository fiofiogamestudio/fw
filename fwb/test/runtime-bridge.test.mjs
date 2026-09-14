import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../runtime/web/fwb-poki.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function bridge(sdk, options = {}) {
  const events = [];
  const handlers = {};
  const context = vm.createContext({
    PokiSDK: sdk,
    setTimeout: (fn, ms) => setTimeout(fn, options.fastTimeout ? 5 : ms),
    clearTimeout,
    document: { hidden: false, addEventListener: (name, fn) => { handlers[name] = fn; } },
  });
  vm.runInContext(source, context);
  context.FWBPoki.initialize(json => events.push(JSON.parse(json)));
  await tick();
  return { api: context.FWBPoki, events, handlers, context };
}

test('missing SDK reports unavailable, keeps game loading and never manufactures a reward', async () => {
  const { api, events } = await bridge(undefined);
  assert.equal(events[0].status, 'unavailable');
  api.event('gameLoadingFinished');
  api.requestAd('rewarded', 'no-sdk');
  await tick();
  assert.equal(events.at(-1).status, 'unavailable');
  assert.equal(events.at(-1).reward_eligible, false);
});

test('initialization rejects without throwing into the game', async () => {
  const { events } = await bridge({ init: () => Promise.reject(new Error('blocked')) });
  assert.equal(events[0].status, 'error');
  assert.equal(events[0].message, 'blocked');
});

test('initialized SDK only advertises methods it actually provides', async () => {
  const { events } = await bridge({ init: () => Promise.resolve(), commercialBreak: () => Promise.resolve() });
  assert.equal(events[0].status, 'ready');
  assert.equal(events[0].rewarded_ads, false);
  assert.equal(events[0].commercial_ads, true);
});

test('loading and gameplay calls map only to documented SDK methods', async () => {
  const calls = [];
  const sdk = { init: () => Promise.resolve() };
  for (const name of ['gameLoadingFinished', 'gameplayStart', 'gameplayStop']) sdk[name] = () => calls.push(name);
  const { api } = await bridge(sdk);
  for (const name of ['gameLoadingFinished', 'gameplayStart', 'gameplayStop', 'unknown']) api.event(name);
  assert.deepEqual(calls, ['gameLoadingFinished', 'gameplayStart', 'gameplayStop']);
});

for (const [value, status, eligible] of [[true, 'success', true], [false, 'cancelled', false], [undefined, 'cancelled', false], ['true', 'cancelled', false]]) {
  test(`reward result ${String(value)} (${typeof value}) maps to ${status}, eligible=${eligible}`, async () => {
    const { api, events } = await bridge({ init: () => Promise.resolve(), rewardedBreak: onStart => { onStart(); return Promise.resolve(value); } });
    api.requestAd('rewarded', '42');
    await tick();
    assert.equal(events.at(-2).type, 'ad_started');
    assert.equal(events.at(-1).status, status);
    assert.equal(events.at(-1).reward_eligible, eligible);
    assert.equal(events.at(-1).request_id, '42');
    assert.equal(events.filter(event => event.type === 'ad').length, 1);
  });
}

test('commercial completion is never reward eligibility or proof of ad display', async () => {
  const { api, events } = await bridge({ init: () => Promise.resolve(), commercialBreak: () => Promise.resolve() });
  api.requestAd('commercial', 'commercial-1');
  await tick();
  assert.equal(events.at(-1).status, 'success');
  assert.equal(events.at(-1).reward_eligible, false);
  assert.match(events.at(-1).message, /not guaranteed/);
});

test('ad rejection gives error and a subsequent request can proceed', async () => {
  let fail = true;
  const { api, events } = await bridge({ init: () => Promise.resolve(), rewardedBreak: () => fail ? Promise.reject(new Error('offline')) : Promise.resolve(true) });
  api.requestAd('rewarded', 'a');
  await tick();
  assert.equal(events.at(-1).status, 'error');
  fail = false;
  api.requestAd('rewarded', 'b');
  await tick();
  assert.equal(events.at(-1).status, 'success');
});

test('concurrent ad requests do not call the SDK twice', async () => {
  let resolveAd;
  let calls = 0;
  const { api, events } = await bridge({ init: () => Promise.resolve(), rewardedBreak: () => { calls += 1; return new Promise(resolve => { resolveAd = resolve; }); } });
  api.requestAd('rewarded', 'first');
  api.requestAd('rewarded', 'second');
  await tick();
  assert.equal(calls, 1);
  assert.equal(events.at(-1).request_id, 'second');
  assert.equal(events.at(-1).message, 'busy');
  resolveAd(true);
  await tick();
  assert.equal(events.at(-1).request_id, 'first');
});

test('ad timeout cannot grant a late reward', async () => {
  let resolveAd;
  const { api, events } = await bridge({ init: () => Promise.resolve(), rewardedBreak: () => new Promise(resolve => { resolveAd = resolve; }) }, { fastTimeout: true });
  api.requestAd('rewarded', 'timeout');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(events.at(-1).status, 'error');
  assert.equal(events.at(-1).reward_eligible, false);
  api.requestAd('rewarded', 'retry-while-outstanding');
  await tick();
  assert.equal(events.at(-1).message, 'busy');
  resolveAd(true);
  await tick();
  assert.equal(events.filter(event => event.type === 'ad' && event.request_id === 'timeout').length, 1);
});

test('browser visibility is delivered as lifecycle data', async () => {
  const { handlers, context, events } = await bridge(undefined);
  context.document.hidden = true;
  handlers.visibilitychange();
  assert.deepEqual(events.at(-1), { type: 'lifecycle', event: 'background' });
  context.document.hidden = false;
  handlers.visibilitychange();
  assert.deepEqual(events.at(-1), { type: 'lifecycle', event: 'foreground' });
});
