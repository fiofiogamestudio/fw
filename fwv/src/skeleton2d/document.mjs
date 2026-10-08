/** Versioned, engine-independent region/weighted-mesh skeleton contract. */
export const SKELETON2D_FORMAT = 'fwv-skeleton2d';
const fail = message => { throw Object.assign(new Error(`Skeleton2D: ${message}`), { status: 400, code: 'SKELETON2D_INVALID' }); };
const own = (value, key) => Object.hasOwn(value, key);
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(`${label} contains a reserved key.`);
  return value;
};
const fields = (value, allowed, label) => { object(value, label); for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}.${key} is unsupported.`); };
const name = (value, label) => { if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\x00-\x1f]/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail(`${label} must be a readable identifier.`); return value; };
const number = (value, label, min = -1000000, max = 1000000) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be finite and between ${min} and ${max}.`); return value; };
const array = (value, label, max, min = 0) => { if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${label} must contain ${min}..${max} entries.`); return value; };
const reference = (value, set, label) => { name(value, label); if (!set.has(value)) fail(`${label} references missing ${value}.`); };
function rectangle(value, label) { fields(value, ['x', 'y', 'width', 'height'], label); number(value.x, `${label}.x`); number(value.y, `${label}.y`); number(value.width, `${label}.width`, 0.000001); number(value.height, `${label}.height`, 0.000001); }
function vector(value, label) { fields(value, ['x', 'y'], label); number(value.x, `${label}.x`); number(value.y, `${label}.y`); }
function json(value, label, depth = 0) {
  if (depth > 32) fail(`${label} exceeds nesting limit.`);
  if (typeof value === 'number' && !Number.isFinite(value)) fail(`${label} contains a nonfinite number.`);
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') fail(`${label} is not JSON.`);
  if (value && typeof value === 'object') {
    if (!Array.isArray(value)) object(value, label);
    for (const [key, entry] of Object.entries(value)) json(entry, `${label}.${key}`, depth + 1);
  }
}
function bones(value, label) {
  const names = new Set(), depths = new Map();
  for (const bone of array(value, label, 256, 1)) {
    fields(bone, ['name', 'parent', 'x', 'y', 'rotation', 'scaleX', 'scaleY', 'rotationLimit', 'length'], label);
    name(bone.name, `${label}.name`);
    if (names.has(bone.name)) fail(`${label} contains duplicate ${bone.name}.`);
    if (bone.parent !== undefined) reference(bone.parent, names, `${label}.${bone.name}.parent (parents must precede children)`);
    const depth = bone.parent === undefined ? 1 : depths.get(bone.parent) + 1;
    if (depth > 64) fail(`${label} exceeds 64 hierarchy levels.`); depths.set(bone.name, depth);
    for (const key of ['x', 'y', 'rotation', 'scaleX', 'scaleY']) if (bone[key] !== undefined) number(bone[key], `${label}.${bone.name}.${key}`, key.startsWith('scale') ? -100 : -1000000, key.startsWith('scale') ? 100 : 1000000);
    if (bone.rotationLimit !== undefined) number(bone.rotationLimit, `${label}.rotationLimit`, 0, 36000);
    if (bone.length !== undefined) number(bone.length, `${label}.length`, 0);
    names.add(bone.name);
  }
  return names;
}
function timeline(value, label, duration, callback, sameTime = false) {
  let previous = -1;
  for (const frame of array(value, label, 10000)) {
    object(frame, label); const time = frame.time ?? 0;
    number(time, `${label}.time`, 0, duration);
    if (sameTime ? time < previous : time <= previous) fail(`${label} key times must be ${sameTime ? 'nondecreasing' : 'strictly increasing'}.`);
    previous = time; callback(frame);
  }
}

/** Spine weighted vertices: [count, boneIndex, localX, localY, weight, ...].
 * UV origin is the image's top left; local and sampled coordinates remain y-up.
 * Attachment transforms do not apply to weighted vertices: each influence is
 * already expressed in its named bone's local coordinates.
 */
export function validateSkeleton2dMesh(attachment, boneCount) {
  const uvs = array(attachment.uvs, 'mesh.uvs', 8192, 6);
  if (uvs.length % 2) fail('mesh.uvs requires complete coordinate pairs.');
  for (const value of uvs) number(value, 'mesh.uv', 0, 1);
  const vertexCount = uvs.length / 2;
  const vertices = array(attachment.vertices, 'mesh.vertices', vertexCount * 17, vertexCount * 5);
  let cursor = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const count = vertices[cursor++], seen = new Set(); let total = 0;
    if (!Number.isInteger(count) || count < 1 || count > 4) fail('mesh vertex requires 1..4 bone influences.');
    for (let influence = 0; influence < count; influence++) {
      const index = vertices[cursor++];
      if (!Number.isInteger(index) || index < 0 || index >= boneCount || seen.has(index)) fail('mesh influence references an invalid or repeated bone index.');
      seen.add(index);
      number(vertices[cursor++], 'mesh.localX'); number(vertices[cursor++], 'mesh.localY');
      const weight = number(vertices[cursor++], 'mesh.weight', Number.MIN_VALUE, 1); total += weight;
    }
    if (Math.abs(total - 1) > 0.00001) fail('mesh vertex weights must sum to one.');
  }
  if (cursor !== vertices.length) fail('mesh.vertices does not match the UV vertex count.');
  const triangles = array(attachment.triangles, 'mesh.triangles', 8192 * 3, 3), used = new Set(), faces = new Set();
  if (triangles.length % 3) fail('mesh.triangles requires complete triangles.');
  for (let i = 0; i < triangles.length; i += 3) {
    const indices = triangles.slice(i, i + 3);
    if (indices.some(index => !Number.isInteger(index) || index < 0 || index >= vertexCount) || new Set(indices).size !== 3) fail('mesh triangle references invalid or repeated vertices.');
    const key = [...indices].sort((a, b) => a - b).join(',');
    if (faces.has(key)) fail('mesh contains duplicate triangles.'); faces.add(key);
    const [a, b, c] = indices.map(index => [uvs[index * 2], uvs[index * 2 + 1]]);
    if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-12) fail('mesh triangle has degenerate UV coordinates.');
    indices.forEach(index => used.add(index));
  }
  if (used.size !== vertexCount) fail('mesh contains vertices unused by its triangles.');
  for (const key of ['x', 'y', 'rotation', 'scaleX', 'scaleY']) if (attachment[key] !== undefined && attachment[key] !== (key.startsWith('scale') ? 1 : 0)) fail(`mesh.${key} must be identity; weighted coordinates are bone-local.`);
  return triangles.length / 3;
}

/** Read older serialized documents without rewriting immutable revision bytes. */
export function validateSkeleton2dDocument(input) {
  json(input, 'document');
  if (input.format === 'fwd-skeleton2d') input = { ...input, format: SKELETON2D_FORMAT };
  if (new TextEncoder().encode(JSON.stringify(input)).length > 4 * 1024 * 1024) fail('Document exceeds 4 MiB.');
  fields(input, ['format', 'schemaVersion', 'coordinateSystem', 'bones', 'slots', 'skins', 'animations', 'animationDurations', 'loopAnimations', 'skinAnimations', 'skinBones', 'skinSockets', 'textures', 'events', 'bounds', 'clipBounds', 'lines', 'metadata'], 'document');
  if (input.format !== SKELETON2D_FORMAT || input.schemaVersion !== 1 || input.coordinateSystem !== 'y-up') fail('Expected fwv-skeleton2d schemaVersion 1 with y-up coordinates.');
  const boneNames = bones(input.bones, 'bones'), slotNames = new Set(), skinNames = new Set();
  for (const slot of array(input.slots, 'slots', 256, 1)) {
    fields(slot, ['name', 'bone', 'attachment'], 'slot'); name(slot.name, 'slot.name');
    if (slotNames.has(slot.name)) fail(`Duplicate slot ${slot.name}.`);
    reference(slot.bone, boneNames, `slot.${slot.name}.bone`);
    if (slot.attachment !== undefined && slot.attachment !== null) name(slot.attachment, 'slot.attachment');
    slotNames.add(slot.name);
  }
  object(input.textures, 'textures');
  if (!Object.keys(input.textures).length || Object.keys(input.textures).length > 2048) fail('textures must contain 1..2048 region mappings.');
  const fileNames = new Set();
  for (const [region, fileName] of Object.entries(input.textures)) {
    name(region, 'texture region');
    if (typeof fileName !== 'string' || fileName.length > 120 || !/\.png$/i.test(fileName) || /[<>:"/\\|?*\x00-\x1f]/.test(fileName) || /[. ]$/.test(fileName) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fileName)) fail(`Unsafe PNG texture filename ${fileName}.`);
    fileNames.add(fileName.toLowerCase());
  }
  if (fileNames.size > 63) fail('At most 63 distinct texture files fit one immutable revision.');
  let meshTriangles = 0;
  for (const skin of array(input.skins, 'skins', 128, 1)) {
    fields(skin, ['name', 'attachments'], 'skin'); name(skin.name, 'skin.name');
    if (skinNames.has(skin.name)) fail(`Duplicate skin ${skin.name}.`);
    skinNames.add(skin.name); object(skin.attachments, `skin.${skin.name}.attachments`);
    for (const [slot, entries] of Object.entries(skin.attachments)) {
      reference(slot, slotNames, `skin.${skin.name}.slot`); object(entries, `attachments.${slot}`);
      for (const [attachmentName, region] of Object.entries(entries)) {
        name(attachmentName, 'attachment.name'); fields(region, ['type', 'path', 'width', 'height', 'x', 'y', 'rotation', 'scaleX', 'scaleY', 'tip', ...(region.type === 'mesh' ? ['uvs', 'triangles', 'vertices'] : [])], `attachment.${attachmentName}`);
        if (!['region', 'mesh'].includes(region.type)) fail(`Attachment ${attachmentName}: only region and weighted mesh attachments are supported.`);
        if (!own(input.textures, region.path)) fail(`Attachment ${attachmentName} references missing texture region ${region.path}.`);
        number(region.width, 'attachment.width', 0.000001); number(region.height, 'attachment.height', 0.000001);
        for (const key of ['x', 'y', 'rotation', 'scaleX', 'scaleY']) if (region[key] !== undefined) number(region[key], `attachment.${key}`, key.startsWith('scale') ? -100 : -1000000, key.startsWith('scale') ? 100 : 1000000);
        if (region.tip !== undefined) vector(region.tip, 'attachment.tip');
        if (region.type === 'mesh') meshTriangles += validateSkeleton2dMesh(region, input.bones.length);
        if (meshTriangles > 65536) fail('Document exceeds 65536 mesh triangles.');
      }
    }
  }
  object(input.animations, 'animations'); const animationNames = new Set(Object.keys(input.animations));
  if (!animationNames.size || animationNames.size > 512) fail('animations must contain 1..512 clips.');
  object(input.animationDurations, 'animationDurations');
  for (const key of Object.keys(input.animationDurations)) reference(key, animationNames, 'animationDurations');
  object(input.events ?? {}, 'events'); const eventNames = new Set(Object.keys(input.events ?? {}));
  for (const [eventName, event] of Object.entries(input.events ?? {})) {
    name(eventName, 'event name'); fields(event, ['int', 'float', 'string'], `events.${eventName}`);
    for (const key of ['int', 'float']) if (event[key] !== undefined) { number(event[key], `event.${key}`); if (key === 'int' && !Number.isInteger(event[key])) fail('event.int must be an integer.'); }
    if (event.string !== undefined && (typeof event.string !== 'string' || event.string.length > 4096)) fail('event.string must be a bounded string.');
  }
  let keyCount = 0;
  for (const [clipName, clip] of Object.entries(input.animations)) {
    name(clipName, 'animation name'); fields(clip, ['bones', 'slots', 'drawOrder', 'events'], `animation.${clipName}`);
    const duration = number(input.animationDurations[clipName], `duration.${clipName}`, 0.000001, 3600);
    object(clip.bones ?? {}, 'animation.bones');
    for (const [bone, tracks] of Object.entries(clip.bones ?? {})) {
      reference(bone, boneNames, 'animation.bone'); fields(tracks, ['translate', 'rotate', 'scale'], `animation.${bone}`);
      for (const [track, frames] of Object.entries(tracks)) timeline(frames, `${clipName}.${bone}.${track}`, duration, frame => {
        keyCount++;
        fields(frame, track === 'rotate' ? ['time', 'value', 'curve'] : ['time', 'x', 'y', 'curve'], 'bone keyframe');
        if (frame.curve !== undefined && !['linear', 'stepped'].includes(frame.curve)) fail('Only linear and stepped curves are supported.');
        for (const key of track === 'rotate' ? ['value'] : ['x', 'y']) if (frame[key] !== undefined) number(frame[key], `keyframe.${key}`, track === 'scale' ? -100 : -1000000, track === 'scale' ? 100 : 1000000);
      });
    }
    object(clip.slots ?? {}, 'animation.slots');
    for (const [slot, tracks] of Object.entries(clip.slots ?? {})) {
      reference(slot, slotNames, 'animation.slot'); fields(tracks, ['attachment'], 'slot tracks');
      if (tracks.attachment !== undefined) timeline(tracks.attachment, `${clipName}.${slot}.attachment`, duration, frame => {
        keyCount++; fields(frame, ['time', 'name'], 'attachment keyframe');
        if (frame.name !== null) name(frame.name, 'attachment keyframe.name');
        // Missing attachments on a sparse skin intentionally hide a slot, as in region skeleton runtimes.
      });
    }
    if (clip.events !== undefined) timeline(clip.events, `${clipName}.events`, duration, frame => {
      keyCount++; fields(frame, ['time', 'name', 'int', 'float', 'string'], 'event keyframe'); reference(frame.name, eventNames, 'event keyframe.name');
      for (const key of ['int', 'float']) if (frame[key] !== undefined) { number(frame[key], `event.${key}`); if (key === 'int' && !Number.isInteger(frame[key])) fail('event.int must be an integer.'); }
      if (frame.string !== undefined && (typeof frame.string !== 'string' || frame.string.length > 4096)) fail('event.string must be a bounded string.');
    }, true);
    if (clip.drawOrder !== undefined) timeline(clip.drawOrder, `${clipName}.drawOrder`, duration, frame => {
      keyCount++; fields(frame, ['time', 'offsets'], 'drawOrder keyframe'); const seen = new Set(), destinations = new Set(); let previousIndex = -1;
      for (const entry of array(frame.offsets ?? [], 'drawOrder.offsets', input.slots.length)) {
        fields(entry, ['slot', 'offset'], 'drawOrder offset'); reference(entry.slot, slotNames, 'drawOrder.slot');
        const index = input.slots.findIndex(slot => slot.name === entry.slot), destination = index + entry.offset;
        if (!Number.isInteger(entry.offset) || destination < 0 || destination >= input.slots.length || seen.has(entry.slot) || destinations.has(destination) || index <= previousIndex) fail('drawOrder offsets must be unique, ordered by setup slot, and remain in bounds.');
        seen.add(entry.slot); destinations.add(destination); previousIndex = index;
      }
    });
  }
  if (keyCount > 100000) fail('Document exceeds 100000 keyframes.');
  const loops = new Set();
  for (const clip of array(input.loopAnimations ?? [], 'loopAnimations', 512)) { reference(clip, animationNames, 'loopAnimations'); if (loops.has(clip)) fail('Duplicate looping animation.'); loops.add(clip); }
  object(input.skinBones ?? {}, 'skinBones');
  for (const [skin, overrides] of Object.entries(input.skinBones ?? {})) {
    reference(skin, skinNames, 'skinBones.skin'); bones(overrides, `skinBones.${skin}`);
    if (overrides.length !== input.bones.length || overrides.some((bone, i) => bone.name !== input.bones[i].name)) fail('skinBones must preserve the base bone names and order.');
  }
  for (const [field, values, targets] of [['skinAnimations', input.skinAnimations ?? {}, animationNames], ['skinSockets', input.skinSockets ?? {}, slotNames]]) {
    object(values, field);
    for (const [skin, aliases] of Object.entries(values)) {
      reference(skin, skinNames, `${field}.skin`); object(aliases, field);
      for (const [alias, target] of Object.entries(aliases)) { name(alias, `${field}.alias`); reference(target, targets, `${field}.${alias}`); }
    }
  }
  if (input.bounds !== undefined) rectangle(input.bounds, 'bounds');
  object(input.clipBounds ?? {}, 'clipBounds');
  for (const [clip, rect] of Object.entries(input.clipBounds ?? {})) { reference(clip, animationNames, 'clipBounds.animation'); rectangle(rect, 'clipBounds'); }
  const lineNames = new Set();
  for (const line of array(input.lines ?? [], 'lines', 256)) {
    fields(line, ['name', 'slot', 'attachment', 'skin', 'color', 'width', 'points'], 'line'); name(line.name, 'line.name');
    if (lineNames.has(line.name)) fail('Duplicate line name.'); lineNames.add(line.name); reference(line.slot, slotNames, 'line.slot'); name(line.attachment, 'line.attachment');
    if (line.skin !== undefined) reference(line.skin, skinNames, 'line.skin');
    if (typeof line.color !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(line.color)) fail('line.color must be #RRGGBB or #RRGGBBAA.');
    number(line.width, 'line.width', 0.000001, 10000);
    for (const point of array(line.points, 'line.points', 256, 2)) { fields(point, ['bone', 'x', 'y'], 'line point'); reference(point.bone, boneNames, 'line point.bone'); number(point.x, 'line point.x'); number(point.y, 'line point.y'); }
  }
  if (input.metadata !== undefined) object(input.metadata, 'metadata');
  return structuredClone(input);
}

export function summarizeSkeleton2d(document) {
  return { format: SKELETON2D_FORMAT, schemaVersion: 1, bones: document.bones.length, slots: document.slots.length,
    skins: document.skins.map(skin => skin.name), animations: Object.keys(document.animations), textures: new Set(Object.values(document.textures)).size };
}
