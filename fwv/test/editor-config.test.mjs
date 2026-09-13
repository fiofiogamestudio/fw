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
  const configs = domain.workbench.editor.configs;
  assert.equal(Object.keys(configs).length, 10);
  const surfaces = new Map();
  for (const [id, ref] of Object.entries(configs)) {
    const config = JSON.parse(await fs.readFile(new URL(ref, appDir), 'utf8'));
    surfaces.set(id, config);
    for (const field of Object.values(config.fields || {})) {
      if (field.schemaPath) assert.ok(resolveField(field.schemaPath), `${id}: ${field.schemaPath}`);
    }
    function inspect(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        assert.ok(!['innerHTML', 'outerHTML', 'className', 'cssText', 'style'].includes(key), `${id}: private presentation ${key}`);
        inspect(child);
      }
    }
    inspect(config.templates);
  }
  for (const script of ['workbench', 'asset-panel', 'spine-repair-panel', 'image-panel', 'reskin-panel', 'generation-panel', 'rig-panel', 'spine-panel', 'reskin-preview']) {
    const source = await fs.readFile(new URL(`${script}.js`, appDir), 'utf8');
    assert.doesNotMatch(source, /document\.createElement\(|\.innerHTML\s*=|\.cssText\s*=|new Option\(|\.className\s*=|\.style\.(?:display|width|height|margin|padding)\s*=/, script);
    assert.doesNotMatch(source, /[\u3400-\u9fff]/, `${script}: fixed UI text belongs in configuration`);
    assert.doesNotMatch(source, /\.(?:disabled|hidden|textContent)\s*=/, `${script}: UI state belongs in configuration bindings`);
  }
  assert.ok(app.clientExtensions.every(entry => entry.name !== 'workbench-style.js'));
  const workbench = await fs.readFile(new URL('workbench.js', appDir), 'utf8');
  assert.doesNotMatch(workbench, /fwv-parameters|fwv-production|data-panel|registerForm|function el\(/);
  assert.deepEqual(domain.actions.toolbar, ['undo', 'redo', 'save']);
  assert.deepEqual(app.navigation.workspaces.map(workspace => workspace.sections.map(section => section.id)), [['assets'], ['reskin', 'rig', 'images', 'generate', 'spine']]);
  assert.equal(app.labels.save, '保存草稿');
  assert.equal(app.labels.undo, '撤销草稿');
  assert.ok(surfaces.get('rig').templates && surfaces.get('spine').templates && surfaces.get('preview').templates);
});

test('editable draft structure and main control constraints share the compiled FWE model', () => {
  assert.equal(resolveField('generationDrafts[].data.prompt').maxLength, 8000);
  assert.deepEqual(resolveField('generationDrafts[].data.quality').options.map(item => item.value), ['auto', 'low', 'medium', 'high', 'standard', 'hd']);
  assert.deepEqual(resolveField('imageDrafts[].data.recipe.fit').options.map(item => item.value), ['contain', 'cover', 'fill']);
  assert.equal(resolveField('imageDrafts[].data.recipe.width').max, 8192);
  assert.equal(resolveField('imageDrafts[].data.recipe.removeBackground.tolerance').max, 255);
  assert.equal(resolveField('rigDrafts[].data.document.parts[].name').maxLength, 100);
  assert.equal(resolveField('rigDrafts[].data.document.parts[].pivot.x').type, 'number');
  assert.equal(resolveField('rigDrafts[].data.document.motion.walk').type, 'checkbox');
});
