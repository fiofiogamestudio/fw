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
