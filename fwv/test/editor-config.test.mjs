import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { loadAppConfig } = require('../../fwe/src/server.js');
const appDir = new URL('../src/editor/app/', import.meta.url);
const app = loadAppConfig(fileURLToPath(new URL('fwe.app.json', appDir)));
const domain = app.domains.find(item => item.id === 'fwv-authoring');
function resolveField(schemaPath) {
  const [collection, ...parts] = schemaPath.replaceAll('[]', '').split('.');
  let fields = domain.inspector.forms[collection]?.groups.flatMap(group => group.fields || []), field;
  for (const part of parts) { field = fields?.find(item => item.path === part); fields = field?.fields || field?.item?.fields; }
  return field;
}

test('all declared editor surfaces are JSON, resolve model fields and forbid private presentation code', async () => {
  const configs = Object.assign({}, ...app.domains.map(item => item.workbench.editor.configs));
  assert.deepEqual(Object.keys(configs).sort(), ['gallery2d', 'skeleton2d']);
  const surfaces = new Map();
  for (const [id, ref] of Object.entries(configs)) {
    const config = JSON.parse(await fs.readFile(new URL(ref, appDir), 'utf8'));
    surfaces.set(id, config);
    for (const field of Object.values(config.fields || {})) {
      if (field.schemaPath) assert.ok(resolveField(field.schemaPath), `${id}: ${field.schemaPath}`);
    }
    function inspect(value) {
      if (!value || typeof value !== 'object') return;
      if (value.schemaPath) assert.ok(resolveField(value.schemaPath), `${id}: ${value.schemaPath}`);
      for (const [key, child] of Object.entries(value)) {
        assert.ok(!['innerHTML', 'outerHTML', 'className', 'cssText', 'style'].includes(key), `${id}: private presentation ${key}`);
        inspect(child);
      }
    }
    inspect(config.templates);
  }
  for (const script of ['workbench', 'gallery2d-panel', 'skeleton2d-panel']) {
    const source = await fs.readFile(new URL(`${script}.js`, appDir), 'utf8');
    assert.doesNotMatch(source, /document\.createElement\(|\.innerHTML\s*=|\.cssText\s*=|new Option\(|\.className\s*=|\.style\.(?:display|width|height|margin|padding)\s*=/, script);
    assert.doesNotMatch(source, /[\u3400-\u9fff]/, `${script}: fixed UI text belongs in configuration`);
    assert.doesNotMatch(source, /\.(?:disabled|hidden|textContent)\s*=/, `${script}: UI state belongs in configuration bindings`);
  }
  assert.ok(app.clientExtensions.every(entry => entry.name !== 'workbench-style.js'));
  const workbench = await fs.readFile(new URL('workbench.js', appDir), 'utf8');
  assert.doesNotMatch(workbench, /fwv-parameters|fwv-production|data-panel|registerWorkbenchLayout|function el\(/);
  const gallery = await fs.readFile(new URL('gallery2d-panel.js', appDir), 'utf8');
  const skeleton = await fs.readFile(new URL('skeleton2d-panel.js', appDir), 'utf8');
  assert.match(gallery, /registerForm\('fwd-image-preview'/);
  assert.match(skeleton, /registerForm\('fwd-skeleton2d'/);
  assert.doesNotMatch(workbench + gallery + skeleton, /FwvPanels|registerWorkbenchLayout/);
  assert.doesNotMatch(skeleton, /s2d-save-draft|function finite\(|new Option\(/);
  assert.deepEqual(domain.actions.toolbar, ['undo', 'redo', 'save']);
  assert.deepEqual(app.navigation.workspaces.map(workspace => workspace.sections.map(section => section.id)), [['gallery2d', 'skeleton2d']]);
  assert.deepEqual(app.domains.map(item => item.id), ['fwv-catalog', 'fwv-authoring']);
  const declared = JSON.parse(await fs.readFile(new URL('fwe.app.json', appDir), 'utf8'));
  assert.ok(declared.domains.every(item => !item.workbench?.collections), 'native collections must have one declaration in their FWE domains');
  assert.deepEqual(domain.workbench.collections.map(item => item.id), ['skeleton2dDrafts']);
  assert.equal(domain.workbench.default.collection, 'skeleton2dDrafts');
  for (const entry of app.domains) {
    assert.equal(entry.workbench.layout, 'catalog');
    const collection = entry.workbench.collections[0];
    assert.deepEqual(collection.list, ['detail', 'grid']);
    assert.equal(collection.thumbnail.src, 'thumbnailUrl');
    assert.equal(collection.pageSize, 48);
  }
  const catalog = app.domains[0];
  assert.deepEqual(catalog.actions.toolbar, []);
  assert.equal(catalog.actions.save, false);
  assert.equal(catalog.workbench.default.list, 'grid');
  assert.ok(Array.isArray(catalog.workbench.collections[0].filters));
  assert.equal(catalog.workbench.collections[0].filters.length, 3);
  assert.equal(catalog.workbench.collections[0].filters[0].id, 'current');
  assert.deepEqual(catalog.workbench.collections[0].filters[0].default, ['current']);
  assert.equal(app.labels.save, '保存草稿');
  assert.equal(app.labels.undo, '撤销编辑');
  assert.ok(surfaces.get('gallery2d').templates && surfaces.get('skeleton2d').templates);
  assert.doesNotMatch(workbench, /glb|model\.import|reskin|generation|spineRepair/);
  assert.doesNotMatch(JSON.stringify([...surfaces.values()]), /"g2d-(?:list|search|asset|prev|next)"|"s2d-(?:search|asset)"/);
  const files = await fs.readdir(appDir);
  assert.deepEqual(files.sort(), ['authoring.fwe', 'catalog.fwe', 'extension.cjs', 'fwe.app.json', 'gallery2d-panel.js', 'gallery2d.ui.json', 'skeleton2d-panel.js', 'skeleton2d.ui.json', 'workbench.js'].sort());
});

test('editable draft structure and main control constraints share the compiled FWE model', () => {
  assert.equal(resolveField('skeleton2dDrafts[].data.document.bones[].rotation').type, 'number');
  for (const path of ['speed', 'frame.time', 'frame.value', 'document.bones[].x', 'attachmentTransform.rotation']) {
    assert.equal(resolveField(`skeleton2dDrafts[].data.${path}`)?.step, 'any', path);
  }
  assert.deepEqual(resolveField('skeleton2dDrafts[].data.frame.curve').options.map(item => item.value), ['linear', 'stepped']);
});
