import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const sandbox = vm.createContext({ window: {} });
vm.runInContext(await fs.readFile(new URL('../ui/app/review-logic.js', import.meta.url), 'utf8'), sandbox);
const logic = sandbox.window.fwvUiReview;
const row = (id, number, reviewStatus = 'skipped', status = 'safe') => ({ id, number, reviewStatus, autoCheck: { status, summary: `Assessment ${id}` } });

test('skip cycles unresolved screenshots in stable number order and preserves decisions', () => {
  const rows = [row('later', 30), row('first', 5), row('passed', 10, 'accepted'), row('failed', 20, 'rejected')];
  const before = structuredClone(rows);
  assert.equal(logic.nextPending(rows, 'first').id, 'later');
  assert.equal(logic.nextPending(rows, 'later').id, 'first');
  assert.equal(logic.nextPending(rows, 'passed').id, 'later');
  assert.deepEqual(rows, before);
  rows[0].reviewStatus = 'accepted';
  assert.equal(logic.nextPending(rows, 'first').id, 'first', 'the last unresolved screenshot must remain actionable');
  rows[1].reviewStatus = 'rejected';
  assert.equal(logic.nextPending(rows, 'first'), null);
  assert.equal(logic.nextPending([], 'missing'), null);
});

test('bulk JSON includes AI concerns and manual failures, excludes accepted and historical records', () => {
  const rows = [row('A', 1), row('B', 2, 'skipped', 'risk'), row('C', 3, 'accepted', 'error'), row('D', 4, 'rejected'), row('E', 5, 'rejected', 'error'), {...row('F', 6, 'rejected', 'error'), historical: true}];
  assert.deepEqual(Array.from(logic.issues(rows), item => item.id), ['B', 'D', 'E']);
  assert.deepEqual(Array.from(logic.issues([row('approved', 1, 'accepted')])), []);
  const screenshot = {...rows[1], title: 'Long label', category: 'Inventory', sourcePath: 'images/B.png', width: 1920, height: 1080, sha256: 'fixture', reviewNote: 'Unsaved current draft', notes: 'Original capture observation', evidence: 'Fixture → Inventory', state: {tab: 2}};
  const result = JSON.parse(JSON.stringify(logic.issue({project: 'Game',run: {id: 'run'},manifestId: 'digest'}, screenshot)));
  assert.deepEqual(result, {schemaVersion: 1,project: 'Game',runId: 'run',manifestId: 'digest',id: 'B',number: 2,title: 'Long label',module: 'Inventory',image: {path: 'images/B.png',width: 1920,height: 1080,sha256: 'fixture'},autoCheck: {status: 'risk',summary: 'Assessment B'},review: {status: 'skipped',note: 'Unsaved current draft'},evidence: 'Fixture → Inventory',notes: 'Original capture observation',state: {tab: 2}});
});

test('legacy and missing assessments stay unresolved and conservatively included', () => {
  assert.equal(logic.status(row('old', 1, 'unreviewed')), 'skipped');
  assert.equal(logic.status(row('old', 1, 'issue')), 'rejected');
  const unknown = {id: 'unknown',number: 1};
  assert.equal(logic.issues([unknown]).length, 1);
  assert.equal(logic.issue({}, unknown).autoCheck.status, 'risk');
});

const queueData = manifestId => ({ project: 'Game', run: { id: 'run' }, manifestId });
const queueIds = (queue, rows) => Array.from(queue.pending(rows), item => item.id);
const plain = value => JSON.parse(JSON.stringify(value));
function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); }
  };
}

test('clearing and restoring the export queue preserves review data and unconditional single JSON', () => {
  const data = queueData('clear-and-restore');
  const rows = [row('safe', 1), row('risk', 2, 'skipped', 'risk'), row('passed', 3, 'accepted', 'error'),
    { ...row('rejected', 4, 'rejected'), reviewNote: 'Keep my note' },
    { ...row('historical', 5, 'rejected'), historical: true }];
  const before = structuredClone(rows), storage = memoryStorage();
  storage.setItem('unrelated-review-state', 'keep');
  const queue = logic.exportQueue(data, storage);
  assert.deepEqual(queueIds(queue, rows), ['risk', 'rejected']);
  assert.equal(queue.hasCleared(), false);
  assert.deepEqual(plain(queue.clear(rows)), { count: 2, persisted: true });
  assert.deepEqual(queueIds(queue, rows), []);
  assert.equal(queue.hasCleared(), true);
  assert.deepEqual(plain(queue.clear(rows)), { count: 0, persisted: true });
  assert.deepEqual(Array.from(logic.issues(rows), item => item.id), ['risk', 'rejected']);
  assert.deepEqual(plain(logic.issue(data, rows[3])).review, { status: 'rejected', note: 'Keep my note' });
  assert.deepEqual(rows, before);
  assert.deepEqual(plain(queue.restore()), { count: 2, persisted: true });
  assert.deepEqual(queueIds(queue, rows), ['risk', 'rejected']);
  assert.equal(queue.hasCleared(), false);
  assert.deepEqual(plain(queue.restore()), { count: 0, persisted: true });
  assert.equal(storage.values.get('unrelated-review-state'), 'keep');
  assert.deepEqual(rows, before);
});

test('a changed issue payload re-enters the queue and clearing only acknowledges pending payloads', () => {
  const data = queueData('payload-change'), storage = memoryStorage();
  const rows = [row('first', 1, 'rejected'), row('second', 2, 'skipped', 'risk')];
  const queue = logic.exportQueue(data, storage);
  queue.clear(rows);
  rows[0].reviewNote = 'New unsaved feedback';
  assert.deepEqual(queueIds(queue, rows), ['first']);
  assert.deepEqual(plain(queue.clear(rows)), { count: 1, persisted: true });
  assert.deepEqual(queueIds(queue, rows), []);
  rows[0].reviewStatus = 'skipped';
  assert.deepEqual(queueIds(queue, rows), [], 'a safe skipped row is no longer a problem');
  rows[0].autoCheck.status = 'risk';
  assert.deepEqual(queueIds(queue, rows), ['first']);
  queue.clear(rows);
  for (const mutate of [
    () => { rows[0].autoCheck.summary = 'Changed AI assessment'; },
    () => { rows[0].notes = 'New source observation'; },
    () => { rows[0].state = { tab: 2 }; },
    () => { rows[0].sha256 = 'updated-pixels'; }
  ]) {
    mutate();
    assert.deepEqual(queueIds(queue, rows), ['first']);
    queue.clear(rows);
  }
  rows.push(row('new', 3, 'rejected'));
  assert.deepEqual(queueIds(queue, rows), ['new']);
  rows[2].reviewStatus = 'accepted';
  assert.deepEqual(queueIds(queue, rows), []);
  rows[2].reviewStatus = 'rejected';
  rows[2].historical = true;
  assert.deepEqual(queueIds(queue, rows), []);
  const saved = JSON.parse(Array.from(storage.values.values())[0]);
  assert.equal(saved.cleared.length, 2, 'one current fingerprint is retained per screenshot');
});

test('export acknowledgements survive reopen and restore without crossing manifest identities', () => {
  const storage = memoryStorage(), data = queueData('manifest-one'), rows = [row('same-id', 1, 'rejected')];
  logic.exportQueue(data, storage).clear(rows);
  const reopened = logic.exportQueue(structuredClone(data), storage);
  assert.deepEqual(queueIds(reopened, rows), []);
  assert.equal(reopened.hasCleared(), true);
  const otherManifest = logic.exportQueue(queueData('manifest-two'), storage);
  assert.deepEqual(queueIds(otherManifest, rows), ['same-id']);
  assert.equal(otherManifest.hasCleared(), false);
  otherManifest.clear(rows);
  reopened.restore();
  assert.deepEqual(queueIds(logic.exportQueue(data, storage), rows), ['same-id']);
  assert.deepEqual(queueIds(logic.exportQueue(queueData('manifest-two'), storage), rows), []);
  assert.equal(storage.values.size, 2);
});

test('export storage treats prototype-like screenshot and manifest keys as plain data', () => {
  const data = queueData('__proto__'), storage = memoryStorage();
  const rows = [row('__proto__', 1, 'rejected'), row('constructor', 2, 'rejected'), row('toString', 3, 'rejected')];
  const queue = logic.exportQueue(data, storage);
  assert.deepEqual(plain(queue.clear(rows)), { count: 3, persisted: true });
  assert.deepEqual(queueIds(logic.exportQueue(data, storage), rows), []);
  rows[0].reviewNote = '__proto__';
  assert.deepEqual(queueIds(queue, rows), ['__proto__']);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(plain(queue.restore()), { count: 3, persisted: true });
  assert.deepEqual(queueIds(queue, rows), ['__proto__', 'constructor', 'toString']);
});

test('malformed, foreign and unsupported export storage is ignored safely', () => {
  const data = queueData('stored-input'), rows = [row('first', 1, 'rejected')];
  const valid = { schemaVersion: 1, manifestId: data.manifestId, cleared: [['first', JSON.stringify(logic.issue(data, rows[0]))]] };
  const invalid = [
    '{invalid', 'null', '[]', '42', '"text"',
    JSON.stringify({ ...valid, schemaVersion: 2 }),
    JSON.stringify({ ...valid, manifestId: 'foreign' }),
    JSON.stringify({ ...valid, unexpected: true }),
    JSON.stringify({ ...valid, cleared: {} }),
    JSON.stringify({ ...valid, cleared: [['first']] }),
    JSON.stringify({ ...valid, cleared: [['first', null]] }),
    JSON.stringify({ ...valid, cleared: [[{}, valid.cleared[0][1]]] }),
    JSON.stringify({ ...valid, cleared: [null] }),
    '{"schemaVersion":1,"manifestId":"stored-input","cleared":[],"__proto__":{"polluted":true}}',
    { not: 'a localStorage string' }
  ];
  for (const raw of invalid) {
    const storage = { getItem() { return raw; }, setItem() {} };
    const queue = logic.exportQueue(data, storage);
    assert.deepEqual(queueIds(queue, rows), ['first']);
    assert.equal(queue.hasCleared(), false);
    assert.deepEqual(plain(queue.clear(rows)), { count: 1, persisted: true });
    assert.deepEqual(queueIds(queue, rows), []);
  }
  assert.equal({}.polluted, undefined);
});

test('null, throwing and quota-limited storage retain in-session clear and restore', () => {
  const data = queueData('unavailable'), rows = [row('first', 1, 'rejected')];
  const throwing = () => { throw new Error('Storage denied'); };
  for (const storage of [null, undefined, {}, { getItem: throwing, setItem: throwing },
    { get getItem() { throw new Error('Getter denied'); }, setItem: throwing },
    { getItem() { return null; }, setItem: throwing }]) {
    const queue = logic.exportQueue(data, storage);
    assert.deepEqual(plain(queue.clear(rows)), { count: 1, persisted: false });
    assert.deepEqual(queueIds(queue, rows), []);
    assert.equal(queue.hasCleared(), true);
    assert.deepEqual(plain(queue.restore()), { count: 1, persisted: false });
    assert.deepEqual(queueIds(queue, rows), ['first']);
    assert.equal(queue.hasCleared(), false);
  }
  const storage = memoryStorage();
  logic.exportQueue(data, storage).clear(rows);
  storage.setItem = throwing;
  const reopened = logic.exportQueue(data, storage);
  assert.deepEqual(queueIds(reopened, rows), []);
  assert.deepEqual(plain(reopened.restore()), { count: 1, persisted: false });
  assert.deepEqual(queueIds(reopened, rows), ['first']);
  const noIdentity = logic.exportQueue({}, memoryStorage());
  assert.deepEqual(plain(noIdentity.clear(rows)), { count: 1, persisted: false });
  assert.deepEqual(queueIds(noIdentity, rows), []);
});
