import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../runtime/web/fwb-taptap.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function bridge(tap, config = { taptap: { enabled: true, rewardedAdUnitId: 'reward' } }, fast = false) {
  const events = [];
  const context = vm.createContext({ tap, Uint8Array, ArrayBuffer, TextEncoder, atob, btoa,
    setTimeout: (fn, ms) => setTimeout(fn, fast ? 8 : ms), clearTimeout });
  vm.runInContext(source, context);
  context.FWBTapTap.initialize(json => events.push(JSON.parse(json)), JSON.stringify(config));
  assert.equal(events.length, 0, 'init must remain asynchronous');
  await tick();
  return { api: context.FWBTapTap, events };
}
function adSdk() {
  const state = { calls: 0, destroyed: 0 };
  const tap = { createRewardedVideoAd() {
    state.calls++;
    return { onClose(fn) { state.close = fn; }, onError(fn) { state.error = fn; },
      load: () => Promise.resolve(), show: () => Promise.resolve(), destroy() { state.destroyed++; } };
  } };
  return { tap, state };
}

test('disabled/missing TapTap never claims SDK capabilities or downloads a SDK', async () => {
  for (const [tap, config] of [[undefined, { taptap: { enabled: true } }], [{}, {}]]) {
    const { api, events } = await bridge(tap, config);
    assert.equal(events[0].status, 'unavailable');
    api.requestAd('rewarded', 'a');
    api.request('cloud_list', '{}', 'b');
    await tick();
    assert.ok(events.slice(1).every(event => event.status === 'unavailable'));
    assert.equal(events[0].login, false);
  }
});

test('ad show resolution grants nothing; only strict onClose isEnded true grants a reward once', async () => {
  const { tap, state } = adSdk();
  const { api, events } = await bridge(tap);
  api.requestAd('rewarded', '1');
  await tick();
  assert.equal(events.filter(event => event.type === 'ad').length, 0);
  state.close({ isEnded: true });
  state.close({ isEnded: true });
  assert.equal(events.filter(event => event.type === 'ad').length, 1);
  assert.equal(events.at(-1).reward_eligible, true);
  assert.equal(state.destroyed, 1);
});

test('cancel, SDK error, synchronous SDK callbacks and concurrent requests remain safe', async () => {
  const { tap, state } = adSdk();
  const { api, events } = await bridge(tap);
  api.requestAd('rewarded', '1');
  api.requestAd('rewarded', '2');
  assert.equal(events.length, 1, 'even busy/unavailable callbacks are deferred');
  await tick();
  assert.equal(state.calls, 1);
  assert.equal(events.find(event => event.request_id === '2').message, 'busy');
  state.close({ isEnded: 'true' });
  assert.equal(events.at(-1).status, 'cancelled');
  assert.equal(events.at(-1).reward_eligible, false);
  api.requestAd('rewarded', '3');
  await tick();
  state.error({ errMsg: 'offline' });
  assert.equal(events.at(-1).message, 'offline');
  const synchronous = await bridge({ createRewardedVideoAd() { let close; return {
    onClose(fn) { close = fn; }, onError() {}, load() {}, show() { close({ isEnded: true }); }, destroy() {},
  }; } });
  synchronous.api.requestAd('rewarded', 'sync');
  assert.equal(synchronous.events.length, 1);
  await tick();
  assert.equal(synchronous.events.at(-1).reward_eligible, true);
});

test('ad timeout retains SDK lock and late completion only clears interruption without reward', async () => {
  const { tap, state } = adSdk();
  const { api, events } = await bridge(tap, { taptap: { enabled: true, rewardedAdUnitId: 'reward' } }, true);
  api.requestAd('rewarded', '1');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.at(-1).pending, true);
  api.requestAd('rewarded', '2');
  await tick();
  assert.equal(events.at(-1).message, 'busy');
  state.close({ isEnded: true });
  assert.equal(events.at(-1).type, 'ad_settled');
  assert.equal(events.filter(event => event.type === 'ad' && event.request_id === '1').length, 1);
  assert.ok(events.every(event => event.reward_eligible !== true));
});

function cloudSdk(overrides = {}) {
  const writes = [];
  const deleted = [];
  const fs = { writeFile(options) { writes.push(options); options.success(); }, readFile(options) { options.success({ data: Uint8Array.from([0, 255, 7]).buffer }); }, unlink(options) { deleted.push(options.filePath); options.success?.(); } };
  const cloud = { createArchive(options) { options.success({ uuid: 'uuid', fileId: 'file' }); }, updateArchive(options) { options.success({ uuid: options.archiveUUID, fileId: 'new' }); },
    getArchiveList(options) { options.success({ saves: [{ uuid: 'uuid', fileId: 'file' }] }); },
    getArchiveData(options) { options.success({ filePath: 'tapfile://tmp/download.bin' }); }, ...overrides };
  return { tap: { env: { TEMP_DATA_PATH: 'tapfile://tmp' }, getCloudSaveManager: () => cloud, getFileSystemManager: () => fs }, writes, deleted, fs };
}
const cloudConfig = { taptap: { enabled: true, cloudSave: true } };

test('cloud transfers opaque bytes using temporary files and never writes the local authoritative save', async () => {
  const { tap, writes, deleted } = cloudSdk();
  const { api, events } = await bridge(tap, cloudConfig);
  assert.equal(events[0].cloud_save, true);
  api.request('cloud_write', JSON.stringify({ data_base64: 'AP8H', metadata: { name: 'slot_1', summary: 'test' } }), '1');
  await tick();
  assert.equal(events.at(-1).status, 'success');
  assert.deepEqual([...new Uint8Array(writes[0].data)], [0, 255, 7]);
  assert.match(writes[0].filePath, /^tapfile:\/\/tmp\/fwb-/);
  assert.equal(deleted[0], writes[0].filePath);
  api.request('cloud_read', JSON.stringify({ archive_uuid: 'uuid', file_id: 'file' }), '2');
  await tick();
  assert.equal(events.at(-1).data_base64, 'AP8H');
  assert.equal(deleted.at(-1), 'tapfile://tmp/download.bin');
});

test('cloud upload timeout is unknown, blocks overlapping writes and suppresses late success', async () => {
  let upload;
  const { tap } = cloudSdk({ createArchive(options) { upload = options; } });
  const { api, events } = await bridge(tap, cloudConfig, true);
  const payload = JSON.stringify({ data_base64: 'AQ==', metadata: { name: 'slot_1', summary: '' } });
  api.request('cloud_write', payload, '1');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.at(-1).remote_outcome, 'unknown');
  api.request('cloud_write', payload, '2');
  await tick();
  assert.equal(events.at(-1).message, 'busy');
  upload.success({ uuid: 'uuid', fileId: 'file' });
  await tick();
  assert.equal(events.filter(event => event.request_id === '1').length, 1);
});

test('validation failure and file-write failure never start remote upload', async () => {
  let uploads = 0;
  const { tap, fs } = cloudSdk({ createArchive() { uploads++; } });
  const { api, events } = await bridge(tap, cloudConfig);
  api.request('cloud_write', JSON.stringify({ data_base64: '!', metadata: { name: 'slot', summary: '' } }), '1');
  await tick();
  assert.equal(events.at(-1).status, 'error');
  fs.writeFile = options => options.fail({ errMsg: 'quota' });
  api.request('cloud_write', JSON.stringify({ data_base64: 'AQ==', metadata: { name: 'slot', summary: '' } }), '2');
  await tick();
  assert.equal(events.at(-1).message, 'quota');
  assert.equal(uploads, 0);
});

test('successful and unknown uploads are rate limited for one minute', async () => {
  const { tap, writes } = cloudSdk();
  const { api, events } = await bridge(tap, cloudConfig);
  const payload = JSON.stringify({ data_base64: 'AQ==', metadata: { name: 'slot', summary: '' } });
  api.request('cloud_write', payload, '1');
  await tick();
  api.request('cloud_write', payload, '2');
  await tick();
  assert.equal(events.at(-1).code, 'rate_limited');
  assert.ok(events.at(-1).retry_after_ms > 59000);
  assert.equal(writes.length, 1);
});

test('download paths cannot escape platform temporary storage', async () => {
  for (const filePath of ['tapfile://tmp/../usr/save.bin', 'tapfile://tmp/a\\..\\usr/save', 'tapfile://usr/save.bin']) {
    const { tap, deleted, fs } = cloudSdk({ getArchiveData(options) { options.success({ filePath }); } });
    fs.readFile = () => assert.fail('unsafe path must not be read');
    const { api, events } = await bridge(tap, cloudConfig);
    api.request('cloud_read', JSON.stringify({ archive_uuid: 'uuid', file_id: 'file' }), 'read');
    await tick();
    assert.equal(events.at(-1).status, 'error');
    assert.equal(deleted.length, 0);
  }
});

test('official archive list fields normalize to reusable provider fields with Unix seconds', async () => {
  const entry = { uuid: 'save-1', fileId: 'file-2', name: 'slot_1', summary: 'Chapter 2',
    extra: '{"fwb":1,"game_id":"demo","slot":"main"}', playtime: 90,
    saveSize: 24, coverSize: 0, createdTime: 1791400000, modifiedTime: 1791400050 };
  const { tap } = cloudSdk({ getArchiveList() { return Promise.resolve({ saves: [entry] }); } });
  const { api, events } = await bridge(tap, cloudConfig);
  api.request('cloud_list', '{}', 'list');
  await tick();
  assert.equal(events.at(-1).status, 'success');
  assert.deepEqual(events.at(-1).archives, [{ ...entry, archive_uuid: 'save-1', file_id: 'file-2',
    created_at: 1791400000, updated_at: 1791400050, save_size: 24, cover_size: 0 }]);
});

test('malformed cloud lists fail explicitly instead of becoming a new empty cloud account', async () => {
  for (const saves of [null, {}, [{ uuid: 'save-1' }], [null],
    [{ uuid: 'save-1', fileId: 'file-2', modifiedTime: '1791400050' }],
    [{ uuid: 'save-1', fileId: 'file-2', extra: { game_id: 'demo' } }]]) {
    const { tap } = cloudSdk({ getArchiveList(options) { options.success({ saves }); } });
    const { api, events } = await bridge(tap, cloudConfig);
    api.request('cloud_list', '{}', 'list');
    await tick();
    assert.equal(events.at(-1).status, 'error');
    assert.equal(events.at(-1).archives, undefined);
  }
});

test('SDK cloud error identity and quota errors survive the provider boundary', async () => {
  for (const [errno, code] of [[400001, 'rate_limited'], [400007, 'busy'], [400100, undefined]]) {
    const { tap } = cloudSdk({ getArchiveList(options) { options.fail({ errMsg: 'SDK rejected', errno }); } });
    const { api, events } = await bridge(tap, cloudConfig);
    api.request('cloud_list', '{}', 'list');
    await tick();
    assert.equal(events.at(-1).sdk_errno, errno);
    assert.equal(events.at(-1).code, code);
    assert.equal(events.at(-1).status, 'error');
  }
});

test('archive custom metadata is limited by UTF-8 bytes before upload', async () => {
  for (const [extra, expected] of [['存'.repeat(333), 'success'], ['存'.repeat(334), 'error']]) {
    let uploads = 0;
    const { tap } = cloudSdk({ createArchive(options) {
      uploads++;
      assert.equal(options.archiveMetaData.extra, extra);
      options.success({ uuid: 'uuid', fileId: 'file' });
    } });
    const { api, events } = await bridge(tap, cloudConfig);
    api.request('cloud_write', JSON.stringify({ data_base64: 'AQ==', metadata: { name: 'slot', summary: '', extra } }), 'write');
    await tick();
    assert.equal(events.at(-1).status, expected);
    assert.equal(uploads, expected === 'success' ? 1 : 0);
  }
});

test('invalid archive write identity never reports confirmed remote success', async () => {
  const { tap } = cloudSdk({ createArchive(options) { options.success({ uuid: {}, fileId: 'file' }); } });
  const { api, events } = await bridge(tap, cloudConfig);
  api.request('cloud_write', JSON.stringify({ data_base64: 'AQ==', metadata: { name: 'slot', summary: '' } }), 'write');
  await tick();
  assert.equal(events.at(-1).status, 'error');
  assert.equal(events.at(-1).remote_outcome, 'unknown');
});
