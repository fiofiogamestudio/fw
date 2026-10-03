import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureExport } from '../src/core/build.mjs';
import { fwcExportFilters, fwcLayoutCommand } from '../src/core/fw-layout.mjs';
import { sectionValue } from '../src/core/files.mjs';

const layouts = {
  shallow: { configPack: 'assets/config', configSchema: 'src/schema/config', configSource: 'src/config', systemSchema: 'src/schema/systems.toml', tools: 'src/tools', tests: 'src/tests', genGdscript: 'src/scripts/_gen' },
  legacy: { configPack: 'pack/config', configSchema: 'schema/config', configSource: 'data/config', systemSchema: 'schema/systems.toml', tools: 'tools', tests: 'tests', genGdscript: 'scripts/_gen' },
  custom: { configPack: 'content packs/tables', configSchema: 'authoring/types', configSource: 'authoring/tables', systemSchema: 'authoring/services.toml', tools: 'dev/commands', tests: 'dev/checks', genGdscript: 'game/generated', bridgeSchema: 'authoring/bridges', csharp: 'game/managed', genCsharp: 'game/managed/generated', genFwe: 'editor/generated' },
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, 'snapshot with spaces'); fs.mkdirSync(stage);
  const preset = '[preset.0]\nname="Web"\nplatform="Web"\ninclude_filter="keep/*.json"\nexclude_filter="private/*"\n[preset.0.options]\n';
  fs.writeFileSync(path.join(root, 'export_presets.cfg'), preset);
  fs.writeFileSync(path.join(stage, 'export_presets.cfg'), preset);
  fs.writeFileSync(path.join(stage, 'project.godot'), '[application]\nconfig/name="Fixture"\n');
  const project = { root, config: { targets: { web: { preset: 'Web' } } }, inspection: { fwc: { path: 'modules/code kit', generator: 'modules/code kit/csharp/FwGen/FwGen.csproj' } } };
  return { root, stage, preset, project };
}

for (const [name, layout] of Object.entries(layouts)) test(`${name} FWC layout packages actual config paths and excludes development resources only in the snapshot`, t => {
  const f = fixture(t);
  configureExport(f.project, f.stage, 'web', { release: true }, {}, layout);
  const result = fs.readFileSync(path.join(f.stage, 'export_presets.cfg'), 'utf8');
  const includes = sectionValue(result, 'preset.0', 'include_filter').split(',');
  const excludes = sectionValue(result, 'preset.0', 'exclude_filter').split(',');
  assert(includes.includes(`${layout.configPack}/*.bin`));
  assert(includes.includes('keep/*.json'));
  assert(excludes.includes('private/*'));
  assert(excludes.includes('modules/code kit/*'));
  for (const key of ['configSchema', 'configSource', 'tools', 'tests', 'bridgeSchema', 'genFwe']) {
    if (layout[key]) assert(excludes.includes(`${layout[key]}/*`), key);
  }
  assert(excludes.includes(layout.systemSchema));
  assert(excludes.includes(`${layout.genGdscript}/_fwgen_manifest.json`));
  assert(excludes.includes(`${layout.genGdscript}/_fw_sync_manifest.json`));
  assert(!excludes.includes(`${layout.genGdscript}/*`), 'runtime generated scripts must remain exportable');
  assert(!excludes.includes(`${layout.configPack}/*`), 'runtime config packs must remain exportable');
  assert.equal(fs.readFileSync(path.join(f.root, 'export_presets.cfg'), 'utf8'), f.preset);
  configureExport(f.project, f.stage, 'web', { release: true }, {}, layout);
  assert.equal(fs.readFileSync(path.join(f.stage, 'export_presets.cfg'), 'utf8'), result, 'filter merge is repeatable');
});

test('C# runtime bridge paths remain exportable while bridge schemas and generated manifests stay private', t => {
  const f = fixture(t), layout = layouts.custom;
  configureExport(f.project, f.stage, 'web', { release: true }, {}, layout);
  const filters = sectionValue(fs.readFileSync(path.join(f.stage, 'export_presets.cfg'), 'utf8'), 'preset.0', 'exclude_filter').split(',');
  const excluded = file => filters.some(filter => filter.endsWith('/*') ? file.startsWith(filter.slice(0, -1)) : file === filter);
  assert.equal(excluded(`${layout.csharp}/bridge/game_bridge.cs`), false, 'FWC creates this Godot Node by its res:// C# script path');
  assert.equal(excluded(`${layout.genCsharp}/_bridge_types.cs`), false);
  assert.equal(excluded(`${layout.genGdscript}/_bridge.gd`), false);
  assert.equal(excluded(`${layout.bridgeSchema}/game.proto`), true);
  assert.equal(excluded(`${layout.genCsharp}/_fwgen_manifest.json`), true);
});

test('layout discovery uses the already prepared snapshot generator and refuses the live source', t => {
  const f = fixture(t);
  const command = fwcLayoutCommand(f.project, f.stage);
  assert.equal(command.executable, 'dotnet');
  assert.deepEqual(command.args, ['run', '--no-build', '--project', path.join(f.stage, f.project.inspection.fwc.generator), '--', '--root', f.stage, 'layout']);
  assert.throws(() => fwcLayoutCommand(f.project, f.root), { code: 'unsafe-stage' });
});

test('missing, escaping or wildcard layouts cannot silently fall back to old config paths', t => {
  const f = fixture(t);
  assert.throws(() => configureExport(f.project, f.stage, 'web', { release: true }, {}), { code: 'fwc-layout-required' });
  for (const configPack of ['../outside', '/absolute', 'assets/*.bin', 'assets/config,private', undefined]) {
    assert.throws(() => fwcExportFilters(f.stage, { ...layouts.shallow, configPack }));
  }
  assert.equal(fs.readFileSync(path.join(f.stage, 'export_presets.cfg'), 'utf8'), f.preset);
});
