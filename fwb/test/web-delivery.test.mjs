import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { digest } from '../src/core/files.mjs';
import { validateWebDelivery } from '../src/core/web-delivery.mjs';
import { finalizeExport } from '../src/core/build.mjs';
import { validateConfig, initProject } from '../src/core/project.mjs';
import { pckFixture, wasmFixture } from './fixtures/web-output.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-gzip-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const out = path.join(directory, 'out'); fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><title>Fixture</title>');
  fs.writeFileSync(path.join(out, 'index.js'), '// fixture loader');
  const names = new Set(['out/index.html','out/index.js','out/web-delivery.json']);
  const manifest = {schemaVersion:1, encoding:'gzip', files:{}, packs:{}};
  for (const [name, bytes] of [['index.wasm', wasmFixture()], ['index.pck', pckFixture()], ['actor', pckFixture(4)]]) {
    const gzip = gzipSync(bytes); const url = name + '.gz';
    fs.writeFileSync(path.join(out,url),gzip); names.add('out/'+url);
    const record = {url, bytes:bytes.length, compressedBytes:gzip.length, sha256:digest(bytes), gzipSha256:digest(gzip)};
    (name === 'actor' ? manifest.packs : manifest.files)[name] = record;
  }
  return {directory, names, manifest, check() {
    fs.writeFileSync(path.join(out,'web-delivery.json'),JSON.stringify(manifest));
    return validateWebDelivery({directory},names);
  }};
}

test('gzip delivery validates both representations and all deferred packs', t => {
  const f = fixture(t); const checks = f.check();
  assert.equal(checks.length,6); assert(checks.every(c => c.status === 'pass'));
});

test('gzip delivery rejects corrupt, duplicate, escaped, missing, oversized and inconsistent files', t => {
  for (const mutate of [
    f => {f.manifest.files['index.pck'].sha256 = '0'.repeat(64);},
    f => {f.manifest.files['index.pck'].gzipSha256 = '0'.repeat(64);},
    f => {f.manifest.files['index.pck'].bytes = 4;},
    f => {f.manifest.files['index.pck'].bytes = 257*1024*1024;},
    f => {f.manifest.files['index.pck'].url = '../escape.gz';},
    f => {f.manifest.packs.actor.url = f.manifest.files['index.pck'].url;},
    f => {f.names.delete('out/actor.gz');},
    f => {f.names.add('out/index.wasm');},
  ]) { const f=fixture(t); mutate(f); assert(f.check().some(c=>c.status==='fail')); }
});

for (const encoding of ['raw', 'gzip']) {
  test(`${encoding} delivery rejects empty loaders and truncated or inconsistent engine headers`, t => {
    const cases = [
      ['index.html', Buffer.alloc(0)], ['index.js', Buffer.alloc(0)],
      ['index.wasm', Buffer.from([0,97,115,109])],
      ['index.wasm', Buffer.from([0,97,115,109,2,0,0,0])],
      ['index.pck', Buffer.from('not-a-pck')],
      ['index.pck', pckFixture().subarray(0,96)],
      ['index.pck', (()=>{const bytes=pckFixture(4);bytes.writeBigUInt64LE(999999n,32);return bytes;})()],
      ['index.pck', (()=>{const bytes=pckFixture();bytes.writeBigUInt64LE(999999n,24);return bytes;})()],
      ['index.pck', (()=>{const bytes=pckFixture();bytes.writeUInt32LE(99,4);return bytes;})()],
    ];
    for (const [name, bytes] of cases) {
      const f = fixture(t), out = path.join(f.directory,'out');
      if (encoding === 'raw') {
        f.names.delete('out/web-delivery.json');
        for (const [engine, value] of [['index.wasm',wasmFixture()],['index.pck',pckFixture()]]) {fs.writeFileSync(path.join(out,engine),value);f.names.add('out/'+engine);}
      }
      if (encoding === 'gzip' && f.manifest.files[name]) {
        const gzip=gzipSync(bytes), record=f.manifest.files[name];fs.writeFileSync(path.join(out,record.url),gzip);
        Object.assign(record,{bytes:bytes.length,compressedBytes:gzip.length,sha256:digest(bytes),gzipSha256:digest(gzip)});
      } else fs.writeFileSync(path.join(out,name),bytes);
      assert(f.check().some(check=>check.status==='fail'),`${encoding} accepted corrupt ${name}`);
    }
  });
}

test('raw and gzip delivery accept header-valid Godot 4 PCK versions 2, 3 and 4', t => {
  for (const encoding of ['raw','gzip']) for (const version of [2,3,4]) {
    const f=fixture(t),out=path.join(f.directory,'out'),bytes=pckFixture(version);
    if (encoding==='gzip') {const gzip=gzipSync(bytes),record=f.manifest.files['index.pck'];fs.writeFileSync(path.join(out,record.url),gzip);Object.assign(record,{bytes:bytes.length,compressedBytes:gzip.length,sha256:digest(bytes),gzipSha256:digest(gzip)});}
    else {f.names.delete('out/web-delivery.json');for(const [name,value] of [['index.wasm',wasmFixture()],['index.pck',bytes]]){fs.writeFileSync(path.join(out,name),value);f.names.add('out/'+name);}}
    assert(f.check().every(check=>check.status==='pass'),`${encoding}, PCK version ${version}`);
  }
});

test('finalization executes the snapshot hook against its artifact output and validates hook paths', async t => {
  const f=fixture(t);
  const live=path.join(f.directory,'live'); const stage=path.join(f.directory,'project'); fs.mkdirSync(live);fs.mkdirSync(stage);
  fs.writeFileSync(path.join(live,'project.godot'),'[application]\nconfig/name="test"\n');
  const project=initProject(live); project.config.targets.web.finalizeScript='final.mjs';
  fs.writeFileSync(path.join(stage,'final.mjs'),'import fs from "node:fs";fs.writeFileSync(process.env.FWB_OUTPUT_ROOT+"/result.json",JSON.stringify({cwd:process.cwd(),stage:process.env.FWB_SNAPSHOT_ROOT,args:process.argv.slice(2)}));');
  const result=await finalizeExport(project,stage,path.join(f.directory,'out'),'web','release');
  const report=JSON.parse(fs.readFileSync(path.join(f.directory,'out/result.json')));
  assert.equal(result.status,'passed');assert.equal(report.cwd,stage);assert.equal(report.stage,stage);
  assert.deepEqual(report.args,['--project',stage,'--output',path.join(f.directory,'out'),'--target','web','--profile','release']);
  await assert.rejects(finalizeExport(project,live,path.join(f.directory,'out'),'web','release'),{code:'unsafe-stage'});
  await assert.rejects(finalizeExport(project,stage,stage,'web','release'),{code:'unsafe-stage'});
  for(const hook of ['../bad.mjs','C:/bad.mjs','a\\bad.mjs','bad.js']) {
    project.config.targets.web.finalizeScript=hook;
    assert.throws(()=>validateConfig(project.config),{code:'invalid-config'});
  }
});
