import { child, fail, physicalPath } from './files.mjs';
import { runProcess } from './process.mjs';

// FWC owns layout resolution, including legacy defaults and custom host paths.
export function fwcLayoutCommand(project, stage) {
  if (physicalPath(stage) === physicalPath(project.root)) fail('unsafe-stage', 'FWC layout must be read from the isolated snapshot.');
  return { executable: 'dotnet', args: ['run', '--no-build', '--project', child(stage, project.inspection.fwc.generator), '--', '--root', stage, 'layout'] };
}

export function fwcExportFilters(stage, layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) fail('fwc-layout-required', 'FWC must provide its layout before configuring export.');
  const required = ['configPack', 'configSchema', 'configSource', 'systemSchema', 'tools', 'tests', 'genGdscript'];
  const optional = ['bridgeSchema', 'genCsharp', 'genFwe'];
  for (const key of [...required, ...optional]) {
    if (!required.includes(key) && layout[key] == null) continue;
    child(stage, layout[key]);
    if (/[,?*]/.test(layout[key])) fail('invalid-fwc-layout', `FWC ${key} cannot be represented as a literal Godot export filter.`);
  }
  // [script].csharp contains runtime bridge Nodes loaded by their res:// path.
  // Only authoring inputs and editor outputs are whole-directory exclusions.
  const directories = ['configSchema', 'configSource', 'tools', 'tests', 'bridgeSchema', 'genFwe'];
  const generated = [layout.genGdscript, layout.genCsharp].filter(Boolean);
  return {
    include: [`${layout.configPack}/*.bin`],
    exclude: [layout.systemSchema, ...directories.filter(key => layout[key]).map(key => `${layout[key]}/*`),
      ...generated.flatMap(directory => [`${directory}/_fwgen_manifest.json`, `${directory}/_fw_sync_manifest.json`])],
  };
}

export async function readFwcLayout(project, stage, options = {}) {
  const command = fwcLayoutCommand(project, stage);
  const result = await runProcess(command.executable, command.args, { ...options, cwd: stage });
  let layout;
  try { layout = JSON.parse(result.output.trim()); }
  catch { fail('invalid-fwc-layout', 'FWC layout did not return a JSON object.'); }
  fwcExportFilters(stage, layout);
  return layout;
}
