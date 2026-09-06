import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindings, canonicalRepository, findWorkspace, gitlink, makeManifest, manifestName, moduleDefinitions, readJson, releaseCatalog, safeChild, validateManifest, assertGitRoot, assertPhysicalDirectory } from './workspace.mjs';
import { fail, git, launch, powershell, run } from './process.mjs';

export const fwRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = `FW — workspace composition, not a game runtime

  fw new <directory> --preset godot|godot-agent|agent-ui|agent|editor [--with fws] [--apply]
  fw init [--project <Git root>] --preset <preset> [--apply]
  fw deps status|sync|install|verify [--project <root>] [--apply]
  fw deps update <fwc|fwe|fwa|fws> --to <revision> [--apply]
  fw deps push <component> [--apply]
  fw doctor [--project <root>]
  fw editor [--project <root>] [--port <1..65535>] [--allow-write]
  fw skills install --target <directory> [--apply]

new/init/install use the component commits recorded in this FW release's HEAD.
sync restores the host HEAD gitlinks; update requires an explicit target.
Mutating dependency/setup commands preview unless --apply. The FWA console is
read-only unless --allow-write. FWE domains control their own edit capabilities;
FWE-only workspaces need --editor-app <relative app config>.
No global skill installation, automatic host commit, or nested FW download.
`;

export function parseArgs(argv) {
  const positional = [];
  const options = {};
  const flags = new Set(['apply', 'allow-write', 'json', 'help']);
  const values = new Set(['project', 'preset', 'with', 'name', 'to', 'port', 'target', 'editor-app']);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (Object.hasOwn(options, key)) fail('invalid-arguments', `Repeated option: ${arg}`);
    if (flags.has(key)) options[key] = true;
    else if (values.has(key) && argv[index + 1] && !argv[index + 1].startsWith('--')) options[key] = argv[++index];
    else fail('invalid-arguments', `Unknown option or missing value: ${arg}`);
  }
  return { positional, options };
}

function only(options, names) {
  for (const key of Object.keys(options)) if (!names.includes(key) && !['json', 'help'].includes(key)) fail('invalid-arguments', `--${key} is not supported by this command.`);
}
function report(value) { console.log(JSON.stringify(value, null, 2)); return value; }
function psArgs(script, args) { return ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args]; }
function sync(args) { run(powershell(), psArgs(path.join(fwRoot, 'tools/sync.ps1'), args), { inherit: true }); }
function load(root) { return validateManifest(readJson(safeChild(root, manifestName))); }

function installArgs(root, catalog, apply) {
  const registered = moduleDefinitions(root);
  const args = ['new', '-ProjectRoot', root, '-Components', catalog.map(item => item.id).join(','), '-Json'];
  for (const item of catalog) {
    const prefix = item.id[0].toUpperCase() + item.id.slice(1);
    const existing = registered.find(entry => entry.id === item.id);
    if (existing && canonicalRepository(existing.url) !== canonicalRepository(item.url)) fail('source-conflict', `${item.id} is already registered from a different source; change .gitmodules explicitly after review.`);
    const committed = existing ? gitlink(root, existing.path) : null;
    const indexed = existing ? gitlink(root, existing.path, 'index') : null;
    if (committed && indexed !== committed) fail('staged-version-change', `${item.id} has a staged gitlink change. Review and commit it before install; install does not choose between HEAD and index.`);
    const revision = existing ? committed ?? indexed : item.revision;
    if (!revision) fail('unlocked-component', `Registered ${item.id} has no committed or staged gitlink; review it before install.`);
    if (existing) {
      const location = safeChild(root, existing.path);
      if (fs.existsSync(path.join(location, '.git')) && git(location, ['rev-parse', 'HEAD']).stdout !== revision) fail('working-version-change', `${item.id} worktree is at a different revision. Review it before install; install does not undo an uncommitted component update.`);
    }
    args.push(`-${prefix}Path`, existing?.path ?? item.path, `-${prefix}Url`, item.url, `-${prefix}Target`, revision);
  }
  if (apply) args.push('-Apply');
  return args;
}

export function planCreation(directory, options, source = fwRoot) {
  const root = path.resolve(directory);
  if (root === path.parse(root).root || directory.split(/[\\/]/).includes('..')) fail('unsafe-path', 'Choose a non-root project directory without parent traversal.');
  const manifest = makeManifest(options.preset ?? 'godot-agent', options.with?.split(',') ?? [], options['editor-app']);
  const name = options.name ?? path.basename(root);
  const scaffold = manifest.components.includes('fwc') && manifest.preset !== 'workbench';
  if (scaffold && !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) fail('invalid-name', 'Godot/C# project name must start with a letter and contain only letters, digits and underscores; use --name.');
  const catalog = releaseCatalog(source, manifest.components);
  return { ok: true, mode: options.apply ? 'apply' : 'preview', project: root, name, manifest, components: catalog, scaffold, skillsInstalled: false };
}

function initialize(kind, positional, options) {
  only(options, ['project', 'preset', 'with', 'name', 'editor-app', 'apply']);
  if (kind === 'new' && (positional.length !== 2 || options.project)) fail('invalid-arguments', 'Use fw new <directory> [--preset ...] [--apply].');
  if (kind === 'init' && positional.length !== 1) fail('invalid-arguments', 'Use fw init [--project <root>] [--preset ...] [--apply].');
  const plan = planCreation(kind === 'new' ? positional[1] : options.project ?? process.cwd(), options);
  const root = plan.project;
  assertPhysicalDirectory(root);
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) fail('unsafe-path', 'Project target must be a directory.');
  if (kind === 'new' && fs.existsSync(root) && fs.readdirSync(root).length) fail('nonempty-project', 'fw new requires an empty target. Use fw init deliberately for an existing Git root.');
  if (kind === 'init') {
    assertGitRoot(root);
    if (fs.existsSync(path.join(root, manifestName))) {
      const existing = load(root);
      if (JSON.stringify(existing) !== JSON.stringify(plan.manifest)) fail('manifest-conflict', 'Existing workspace selection differs. Edit it explicitly; init never replaces it.');
    }
    // Validate every registered source/path before any writes, including unrelated entries.
    moduleDefinitions(root);
    installArgs(root, plan.components, false);
    if (plan.manifest.components.includes('fwa')) safeChild(root, '.gitignore');
  }
  // Resolve prerequisites before writing a new directory.
  powershell();
  run('git', ['--version']);
  if (plan.scaffold) run('dotnet', ['--version']);
  report(plan);
  if (!options.apply) return;
  try {
    if (kind === 'new') {
      fs.mkdirSync(root, { recursive: true });
      git(root, ['init', '-b', 'main']);
    }
    const manifestFile = path.join(root, manifestName);
    if (!fs.existsSync(manifestFile)) fs.writeFileSync(manifestFile, `${JSON.stringify(plan.manifest, null, 2)}\n`, { flag: 'wx' });
    sync(installArgs(root, plan.components, true));
    bindings(root, plan.manifest); // Validate actual checked-out identity before invoking component code.
    if (plan.scaffold) {
      const component = moduleDefinitions(root).find(item => item.id === 'fwc');
      const script = safeChild(root, `${component.path}/tools/new.ps1`);
      run(powershell(), psArgs(script, ['-ProjectRoot', root, '-Name', plan.name, '-FrameworkPath', component.path]), { cwd: root, inherit: true });
    }
    if (plan.manifest.components.includes('fwa')) {
      const fwa = moduleDefinitions(root).find(item => item.id === 'fwa');
      const ignoreFile = safeChild(root, '.gitignore');
      const ignore = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : '';
      if (!ignore.split(/\r?\n/).includes('/.fwa/')) fs.appendFileSync(ignoreFile, `${ignore && !ignore.endsWith('\n') ? '\n' : ''}/.fwa/\n`);
      run(process.execPath, [safeChild(root, `${fwa.path}/bin/fwa.js`), 'init', '--project', root, '--json'], { cwd: root, inherit: true });
    }
    report({ ok: true, project: root, initialized: true, reproducible: false, next: 'Review and commit the host files, .gitmodules and staged component gitlinks. Then run fw deps verify. No host commit was created.' });
  } catch (error) {
    error.details = { ...error.details, project: root, partialInitialization: true, recovery: 'Files and successfully installed components are preserved. Fix the reported failure and rerun fw init with the same preset/selection. Nothing was recursively deleted.' };
    throw error;
  }
}

export function doctor(root) {
  const checks = [];
  const check = (id, action) => {
    try { const details = action(); checks.push({ id, ok: true, details }); return details; }
    catch (error) { checks.push({ id, ok: false, error: error.message }); return null; }
  };
  check('node', () => { const [major, minor] = process.versions.node.split('.').map(Number); if (major < 20 || (major === 20 && minor < 10)) fail('node-version', 'Node >=20.10.0 required.'); return process.version; });
  check('git', () => run('git', ['--version']).stdout);
  check('powershell', () => powershell());
  const manifest = check('manifest', () => load(root));
  const components = manifest ? check('bindings', () => bindings(root, manifest)) : null;
  if (components) for (const item of components) check(`pin:${item.id}`, () => {
    if (!item.committed) fail('uncommitted-host', 'Host HEAD has no gitlink; review and create the first host commit.');
    if (item.committed !== item.index || item.index !== item.actual) fail('version-drift', 'Host HEAD, index and component HEAD differ. Review before sync/update/commit.');
    if (item.dirty) fail('dirty-component', 'Component has uncommitted files.');
    return item.actual;
  });
  if (manifest?.components.includes('fwc')) {
    check('dotnet', () => run('dotnet', ['--version'], { cwd: root }).stdout);
    check('godot', () => run(process.env.GODOT_BIN || 'godot', ['--version'], { cwd: root }).stdout);
  }
  if (manifest?.editor?.kind === 'fwe') check('editor-app', () => {
    if (!manifest.editor.app) fail('missing-app', 'Set editor.app to your project-relative FWE app configuration.');
    return readJson(safeChild(root, manifest.editor.app)).id;
  });
  return { ok: checks.every(check => check.ok), project: root, checks, components, remoteVerified: false, note: 'doctor is local; deps verify fetches origin and checks publication. Build/runtime verification remains owned by each component.' };
}

export function editorCommand(root, manifest, options) {
  if (!manifest.editor) fail('missing-editor', 'This preset has no editor. Select fwe (and optionally fwa) explicitly.');
  const components = bindings(root, manifest);
  const fwe = components.find(item => item.id === 'fwe');
  const args = [];
  if (options.port !== undefined && (!/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535)) fail('invalid-port', '--port must be 1..65535.');
  if (manifest.editor.kind === 'fwa') {
    const fwa = components.find(item => item.id === 'fwa');
    args.push(path.join(fwa.root, 'bin/fwa.js'), 'editor', '--project', root, '--fwe-path', fwe.root);
    if (options['allow-write']) args.push('--allow-write');
  } else {
    if (options['allow-write']) fail('invalid-arguments', '--allow-write only applies to the FWA console; FWE domains own their editing capabilities.');
    if (!manifest.editor.app) fail('missing-app', 'Set editor.app to your project-relative FWE app configuration.');
    const app = safeChild(root, manifest.editor.app);
    if (!fs.existsSync(app)) fail('missing-app', `FWE app does not exist: ${app}`);
    args.push(path.join(fwe.root, 'bin/fwe.js'), '--app', app, '--host', '127.0.0.1');
  }
  if (options.port) args.push('--port', options.port);
  return { executable: process.execPath, args };
}

export async function main(argv) {
  const { positional, options } = parseArgs(argv);
  if (options.help || positional.length === 0) { console.log(usage); return; }
  const command = positional[0];
  if (command === 'new' || command === 'init') return initialize(command, positional, options);
  if (!['deps', 'doctor', 'editor', 'skills'].includes(command)) fail('invalid-arguments', usage);
  const root = findWorkspace(options.project ?? process.cwd());
  if (command === 'doctor') {
    only(options, ['project']);
    if (positional.length !== 1) fail('invalid-arguments', 'doctor takes no positional arguments.');
    const result = report(doctor(root));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const manifest = load(root);
  if (command === 'deps') {
    only(options, ['project', 'apply', 'to']);
    const action = positional[1];
    if (!['status', 'sync', 'install', 'verify', 'update', 'push'].includes(action)) fail('invalid-arguments', usage);
    const targeted = ['update', 'push'].includes(action);
    if (positional.length !== (targeted ? 3 : 2)) fail('invalid-arguments', 'Unexpected or missing component argument.');
    if (targeted && !manifest.components.includes(positional[2])) fail('unknown-component', 'Select an enabled component ID.');
    if (action === 'update' ? !options.to : options.to !== undefined) fail('invalid-arguments', '--to <revision> is required only for deps update.');
    if (['status', 'verify'].includes(action) && options.apply) fail('invalid-arguments', `${action} is read-only; remove --apply.`);
    if (action === 'install') return sync(installArgs(root, releaseCatalog(fwRoot, manifest.components), options.apply));
    const args = [action === 'update' ? 'pull' : action, '-ProjectRoot', root, '-Components', targeted ? positional[2] : manifest.components.join(','), '-Json'];
    if (action === 'update') args.push(`-${positional[2][0].toUpperCase()}${positional[2].slice(1)}Target`, options.to);
    if (options.apply) args.push('-Apply');
    return sync(args);
  }
  if (command === 'editor') {
    only(options, ['project', 'port', 'allow-write']);
    if (positional.length !== 1) fail('invalid-arguments', 'editor takes no positional arguments.');
    const invocation = editorCommand(root, manifest, options);
    return launch(invocation.executable, invocation.args, root);
  }
  only(options, ['project', 'target', 'apply']);
  if (positional.length !== 2 || positional[1] !== 'install' || !options.target) fail('invalid-arguments', 'Use fw skills install --target <directory> [--apply].');
  const fws = bindings(root, manifest).find(item => item.id === 'fws');
  if (!fws) fail('missing-component', 'FWS is not selected. Add fws to the manifest, then fw deps install.');
  run(process.execPath, [path.join(fws.root, 'tools/install.mjs'), '--target', path.resolve(options.target), ...(options.apply ? ['--apply'] : [])], { cwd: root, inherit: true });
}
