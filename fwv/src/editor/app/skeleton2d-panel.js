(function () {
  'use strict';
  const clone = value => structuredClone(value);
  const viewKeys = ['skin', 'animation', 'bone', 'slot', 'attachment', 'channel', 'frameIndex', 'frame', 'time', 'speed', 'showBones'];
  const views = new Map();
  let runtime;
  const getRuntime = () => runtime ||= import('/api/fwv/skeleton2d-runtime');
  function mount(host, ctx) {
    const state = { snapshot: ctx.getSnapshot(), asset: null, revision: null, document: null, saved: '', disposed: false, busy: false,
      skin: '', animation: '', bone: '', slot: '', attachment: '', channel: 'rotate', frameIndex: -1, frame: {}, time: 0, speed: 1,
      playing: false, showBones: true, images: new Map(), sampler: null, sampled: null, duration: 1, camera: null, sequence: 0,
      meshEdit: { vertex: 0, influences: '[]', uvs: '[]', triangles: '[]', vertices: '[]' }, validate: null, drawSlot: null };
    const gestures = new AbortController();
    const actions = { play: () => { state.playing = !state.playing; sync(); }, pauseForEdit: () => { if (state.playing) { state.playing = false; sync(); } },
      createRevision: () => run(createRevision), export: () => run(exportRevision), submitFrame: ({ event }) => editFrame(event.submitter?.value || 'add'), deleteFrame: () => editFrame('delete'),
      applyMeshVertex: () => applyMesh(true), applyMeshTopology: () => applyMesh(false) };
    const surface = ctx.createSurface('skeleton2d', { actions, onChange: changeField }), t = surface.text, r = surface.refs;
    host.append(surface.root);
    let boneGraphSignature = '';
    const boneGraph = window.fwe.ui.createGraph({ host: r.boneGraph, layout: 'dag', onSelect(name) {
      if (!name || !state.document || state.busy) return;
      state.bone = name; selectFrame(-1); renderSelection(); cache();
    } });
    // FWE owns backing resolution and resize lifecycle. Drawing and hit testing
    // below use CSS pixels so zoom/DPR never enlarge labels or alter hit radii.
    let canvasViewport, timelineViewport;
    canvasViewport = surface.bindCanvas(r.canvas, { onResize() { state.camera = null; draw(); } });
    timelineViewport = surface.bindCanvas(r.timeline, { height: 112, onResize() { if (state.document) drawTimeline(); } });
    const options = (ref, items, value) => surface.setOptions(r[ref], items.map(([value, label]) => ({ value, label })), String(value ?? ''));
    const dirty = () => Boolean(state.document && JSON.stringify(state.document) !== state.saved);
    const selectedBone = () => state.document?.bones.find(bone => bone.name === state.bone);
    const boneOverride = () => state.document?.skinBones?.[state.skin]?.find(bone => bone.name === state.bone);
    const effectiveBone = () => ({ ...selectedBone(), ...boneOverride() });
    const selectedSlot = () => state.document?.slots.find(slot => slot.name === state.slot);
    const selectedSkin = () => state.document?.skins.find(skin => skin.name === state.skin);
    const attachmentMap = () => selectedSkin()?.attachments?.[state.slot] || {};
    const selectedPart = () => attachmentMap()[state.attachment];
    function readMeshVertex() {
      const part = selectedPart(); if (part?.type !== 'mesh') return;
      state.meshEdit.vertex = Math.max(0, Math.min(part.uvs.length / 2 - 1, state.meshEdit.vertex));
      let offset = 0;
      for (let i = 0; i < state.meshEdit.vertex; i++) offset += 1 + part.vertices[offset] * 4;
      const count = part.vertices[offset++], influences = [];
      for (let i = 0; i < count; i++) influences.push({ bone: state.document.bones[part.vertices[offset++]].name, x: part.vertices[offset++], y: part.vertices[offset++], weight: part.vertices[offset++] });
      state.meshEdit.influences = JSON.stringify(influences, null, 2);
    }
    function readMesh() {
      const part = selectedPart(); if (part?.type !== 'mesh') return;
      for (const key of ['uvs', 'triangles', 'vertices']) state.meshEdit[key] = JSON.stringify(part[key]);
      readMeshVertex();
    }
    function applyMesh(vertexOnly) {
      if (state.busy || selectedPart()?.type !== 'mesh') return;
      try {
        const document = clone(state.document), part = document.skins.find(skin => skin.name === state.skin).attachments[state.slot][state.attachment];
        if (vertexOnly) {
          const influences = JSON.parse(state.meshEdit.influences);
          if (!Array.isArray(influences) || influences.length < 1 || influences.length > 4) throw new Error(t('meshInfluencesInvalid'));
          const encoded = [influences.length];
          for (const item of influences) {
            if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'bone,weight,x,y') throw new Error(t('meshInfluencesInvalid'));
            encoded.push(document.bones.findIndex(bone => bone.name === item.bone), item.x, item.y, item.weight);
          }
          let offset = 0;
          for (let i = 0; i < state.meshEdit.vertex; i++) offset += 1 + part.vertices[offset] * 4;
          part.vertices.splice(offset, 1 + part.vertices[offset] * 4, ...encoded);
        } else for (const key of ['uvs', 'triangles', 'vertices']) part[key] = JSON.parse(state.meshEdit[key]);
        state.validate(document); state.document = document; readMesh(); changed(); notify(t('meshApplied'));
      } catch (error) { notify(error.message, true); }
    }
    const animationMap = () => ({ ...(state.document?.animations || {}), ...(state.document?.skinAnimations?.[state.skin] || {}) });
    function editableAnimation() { return state.document?.animations?.[state.document?.skinAnimations?.[state.skin]?.[state.animation] || state.animation]; }
    function track(create = false) {
      const animation = editableAnimation(); if (!animation || !state.bone) return [];
      if (create) { animation.bones ||= {}; animation.bones[state.bone] ||= {}; animation.bones[state.bone][state.channel] ||= []; }
      return animation.bones?.[state.bone]?.[state.channel] || [];
    }
    function notify(notice, error = false) { if (!state.disposed) surface.update({ notice, error }); }
    function viewKey(assetId = state.asset.id, revisionId = state.revision.id) { return `${state.snapshot.id}:${assetId}:${revisionId}`; }
    function cache(write = false) {
      if (!state.document || state.disposed) return;
      const view = Object.fromEntries(viewKeys.map(key => [key, clone(state[key])]));
      // Selection and playback are browsing state. A document fingerprint keeps
      // a remembered view from overriding a different Undo/Redo draft.
      views.set(viewKey(), { signature: JSON.stringify(state.document), view });
      if (write === true) ctx.drafts.set('skeleton2dDrafts', state.asset.id, { assetId: state.asset.id, revisionId: state.revision.id, document: clone(state.document), ...view });
    }
    function sync() {
      if (state.disposed) return;
      const bone = effectiveBone(), part = selectedPart() || {}, modified = dirty();
      surface.update({ hasDocument: Boolean(state.document), playing: state.playing, busy: state.busy, dirty: modified,
        bone, part, mesh: part.type === 'mesh', meshEdit: state.meshEdit,
        meshSummary: part.type === 'mesh' ? t('meshSummary', { vertices: part.uvs.length / 2, triangles: part.triangles.length / 3 }) : '',
        bonePath: t('bonePath', { parent: bone.parent || t('rootBone') }), speed: state.speed, showBones: state.showBones,
        time: state.time, duration: Math.max(state.duration, 0.001), channel: state.channel, frame: state.frame,
        clock: t('clock', { time: state.time.toFixed(3), duration: state.duration.toFixed(3) }), hasFrame: state.frameIndex >= 0 && Boolean(track()[state.frameIndex]),
        canKey: Boolean(state.animation && state.bone), draftLabel: t(modified ? 'dirty' : 'clean'),
        revisionLabel: state.revision ? t('version', { number: state.asset.revisions.findIndex(revision => revision.id === state.revision.id) + 1, id: state.revision.id }) : '' });
    }
    function renderSelection() {
      if (!state.document) { sync(); return; }
      const d = state.document;
      if (!d.bones.some(bone => bone.name === state.bone)) state.bone = d.bones[0]?.name || '';
      if (!d.skins.some(skin => skin.name === state.skin)) state.skin = d.skins[0]?.name || '';
      if (!d.slots.some(slot => slot.name === state.slot)) state.slot = d.slots[0]?.name || '';
      if (state.animation && !animationMap()[state.animation]) state.animation = Object.keys(animationMap())[0] || '';
      const slot = selectedSlot(), attachments = attachmentMap();
      if (!attachments[state.attachment]) state.attachment = attachments[slot?.attachment] ? slot.attachment : Object.keys(attachments)[0] || '';
      options('revision', state.asset.revisions.map((revision, index) => [revision.id, t('version', { number: index + 1, id: revision.id })]), state.revision.id);
      options('skin', d.skins.map(skin => [skin.name, skin.name]), state.skin);
      options('animation', [['', t('setup')], ...Object.keys(animationMap()).map(name => [name, name])], state.animation);
      options('bone', d.bones.map(bone => [bone.name, bone.name]), state.bone);
      const nodes = d.bones.map(bone => ({ id: bone.name, title: bone.name }));
      const edges = d.bones.filter(bone => bone.parent).map(bone => ({ id: bone.name, source: bone.parent, target: bone.name }));
      const graphSignature = JSON.stringify({ nodes, edges });
      if (graphSignature !== boneGraphSignature) { boneGraph.update({ nodes, edges, selectedId: state.bone }); boneGraphSignature = graphSignature; }
      else boneGraph.select(state.bone);
      options('slot', d.slots.map(slot => [slot.name, slot.name]), state.slot);
      options('slotBone', d.bones.map(bone => [bone.name, bone.name]), slot?.bone || '');
      options('attachment', Object.keys(attachments).map(name => [name, name]), state.attachment);
      readMesh(); renderFrames(); sync(); draw();
    }
    function renderFrames() {
      const frames = track();
      if (!frames[state.frameIndex]) state.frameIndex = -1;
      options('frame', [[-1, t('noFrame')], ...frames.map((frame, index) => [index, t('frameLabel', { time: frame.time.toFixed(3), curve: frame.curve || 'linear' })])], state.frameIndex);
    }
    function selectFrame(index) {
      state.frameIndex = index; const key = track()[index];
      state.frame = key ? clone(key) : { time: state.time, x: state.channel === 'scale' ? 1 : 0, y: state.channel === 'scale' ? 1 : 0, value: 0, curve: 'linear' };
      if (key) { state.time = key.time; state.playing = false; }
      renderFrames(); sync(); draw();
    }
    function changed() { state.playing = false; cache(true); sync(); draw(); }
    async function run(action) {
      if (state.busy || state.disposed) return;
      state.busy = true; sync();
      try { await action(); } catch (error) { notify(error.message, true); }
      finally { state.busy = false; sync(); }
    }
    async function load(assetId, revisionId) {
      const sequence = ++state.sequence, asset = state.snapshot.assets.find(item => item.id === assetId && item.kind === 'skeleton2d');
      if (!asset) return;
      const revision = asset.revisions.find(item => item.id === (revisionId || asset.selectedRevisionId));
      if (!revision) return;
      notify(t('loading'));
      const [detail, module] = await Promise.all([ctx.api('/api/fwv/skeleton2d?' + new URLSearchParams({ assetId, revisionId: revision.id })), getRuntime()]);
      if (state.disposed || sequence !== state.sequence) return;
      const cached = ctx.drafts.get('skeleton2dDrafts', assetId), document = cached?.revisionId === revision.id && cached.document ? clone(cached.document) : clone(detail.document);
      state.sampler = module.sampleSkeleton2d; state.validate = module.validateSkeleton2dDocument; state.drawSlot = module.drawSkeleton2dSlot;
      state.validate(document);
      state.sampler(document, { skin: document.skins[0]?.name, animation: '', time: 0 });
      const images = new Map();
      await Promise.all(Object.entries(document.textures || {}).map(async ([region, fileName]) => {
        const texture = detail.textureData?.[fileName];
        if (texture?.mime !== 'image/png' || typeof texture.base64 !== 'string') throw new Error(t('missingTexture', { name: fileName }));
        const image = new Image(); image.src = 'data:image/png;base64,' + texture.base64; await image.decode(); images.set(region, image);
      }));
      if (state.disposed || sequence !== state.sequence) return;
      Object.assign(state, { asset, revision, document, saved: JSON.stringify(detail.document), images, camera: null, playing: false,
        skin: document.skins[0]?.name || '', animation: Object.keys(document.animations || {})[0] || '', bone: document.bones[0]?.name || '', slot: document.slots[0]?.name || '', attachment: '', frameIndex: -1, frame: {}, time: 0 });
      const remembered = views.get(viewKey(asset.id, revision.id));
      const view = remembered?.signature === JSON.stringify(document) ? remembered.view : cached?.revisionId === revision.id ? cached : null;
      if (view) for (const key of viewKeys) if (view[key] !== undefined) state[key] = clone(view[key]);
      if (!Object.keys(state.frame).length) selectFrame(-1);
      renderSelection(); notify(t('loaded', { name: asset.name }));
    }
    async function createRevision() {
      cache(true); await ctx.drafts.save();
      const expected = clone(state.document), asset = await ctx.command('skeleton2d.save', { assetId: state.asset.id, revisionId: state.revision.id, expectedRevisionId: state.revision.id, document: expected });
      const revisionId = asset.selectedRevisionId, readback = await ctx.api('/api/fwv/skeleton2d?' + new URLSearchParams({ assetId: asset.id, revisionId }));
      if (JSON.stringify(readback.document) !== JSON.stringify(expected)) throw new Error(t('revisionMismatch'));
      state.snapshot = ctx.getSnapshot(); state.asset = state.snapshot.assets.find(item => item.id === asset.id); state.revision = state.asset.revisions.find(item => item.id === revisionId); state.saved = JSON.stringify(readback.document);
      cache(true); await ctx.drafts.save(); renderSelection(); notify(t('created', { revision: revisionId }));
      ctx.refreshView?.();
    }
    async function exportRevision() {
      if (dirty()) return;
      const result = await ctx.command('skeleton2d.export', { assetId: state.asset.id, revisionId: state.revision.id });
      notify(t('exported', { path: result.path }));
    }
    function editFrame(mode) {
      try {
        if (!state.animation) throw new Error(t('selectAnimation'));
        const frames = track(true), index = state.frameIndex;
        if (mode === 'delete') { if (index < 0) return; frames.splice(index, 1); state.frameIndex = -1; }
        else {
          const time = state.frame.time; if (time > state.duration) throw new Error(t('frameOutsideClip'));
          if (frames.some((frame, other) => frame.time === time && (mode === 'add' || other !== index))) throw new Error(t('frameDuplicate'));
          const next = { time, ...(state.channel === 'rotate' ? { value: state.frame.value } : { x: state.frame.x, y: state.frame.y }), curve: state.frame.curve };
          if (mode === 'update') { if (index < 0) return; frames[index] = next; } else frames.push(next);
          frames.sort((a, b) => a.time - b.time); state.frameIndex = frames.indexOf(next);
        }
        selectFrame(state.frameIndex); changed(); renderFrames(); notify(t(mode === 'add' ? 'frameAdded' : mode === 'update' ? 'frameUpdated' : 'frameDeleted'));
      } catch (error) { notify(error.message, true); }
    }
    function changeField({ path, value }) {
      if (state.busy || state.disposed) return;
      // The empty animation option is the 2D setup pose; native optional
      // selects return undefined for it.
      if (value === undefined) { if (path === 'view.animation') value = ''; else return; }
      const [group, key] = path.split('.');
      if (group === 'meshEdit') {
        state.meshEdit[key] = value; state.playing = false;
        if (key === 'vertex') { readMeshVertex(); sync(); draw(); }
        return;
      }
      if (group === 'bone' || group === 'part' || group === 'slot') {
        const target = group === 'bone' ? boneOverride() || selectedBone() : group === 'part' ? selectedPart() : selectedSlot();
        if (target) { target[key] = value; changed(); }
        return;
      }
      if (group === 'frame') { state.frame[key] = value; state.playing = false; cache(); return; }
      if (key === 'revision') { cache(); void run(() => load(state.asset.id, value)); return; }
      if (key === 'frameIndex') { selectFrame(value); cache(); return; }
      state[key] = value; state.playing = false;
      if (key === 'time') { if (state.frameIndex < 0) state.frame.time = value; sync(); draw(); cache(); return; }
      if (key === 'channel') { selectFrame(-1); cache(); return; }
      if (key === 'speed' || key === 'showBones') { cache(); sync(); draw(); return; }
      if (key === 'animation' || key === 'skin') { state.time = 0; state.camera = null; }
      let attachmentChanged = false;
      if (key === 'attachment') { const slot = selectedSlot(); if (slot && slot.attachment !== value) { slot.attachment = value; attachmentChanged = true; } }
      if (['bone', 'animation', 'skin'].includes(key)) selectFrame(-1);
      renderSelection(); cache(attachmentChanged);
    }
    function camera(sample) {
      const b = state.document.bounds || sample.bounds, width = b?.width || 200, height = b?.height || 200;
      const viewport = canvasViewport.metrics;
      const scale = Math.min(viewport.width * 0.82 / width, viewport.height * 0.8 / height, 5);
      return { scale, x: viewport.width / 2 - ((b?.x ?? -100) + width / 2) * scale, y: viewport.height / 2 + ((b?.y ?? -100) + height / 2) * scale };
    }
    function draw() {
      if (!state.document || !state.sampler || state.disposed) return;
      const viewport = canvasViewport?.metrics;
      if (!viewport?.width || !viewport.height) return;
      try {
        const sample = state.sampler(state.document, { skin: state.skin, animation: state.animation, time: state.time, loop: state.playing });
        state.sampled = sample; state.duration = sample.duration || 1; state.camera ||= camera(sample);
        const c = r.canvas.getContext('2d'), view = state.camera;
        c.setTransform(viewport.scaleX, 0, 0, viewport.scaleY, 0, 0); c.clearRect(0, 0, viewport.width, viewport.height); c.fillStyle = '#181e2b'; c.fillRect(0, 0, viewport.width, viewport.height);
        c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
        c.translate(view.x, view.y); c.scale(view.scale, -view.scale); c.lineWidth = 1 / view.scale; c.strokeStyle = '#394251';
        c.beginPath(); c.moveTo(-1000, 0); c.lineTo(1000, 0); c.moveTo(0, -1000); c.lineTo(0, 1000); c.stroke();
        c.save();
        if (sample.clipBounds) { const b = sample.clipBounds; c.beginPath(); c.rect(b.x, b.y, b.width, b.height); c.clip(); }
        for (const slot of sample.slots) {
          for (const line of sample.lines || []) if (line.slot === slot.name && line.points.length) { c.strokeStyle = line.color; c.lineWidth = line.width; c.beginPath(); line.points.forEach((point, index) => index ? c.lineTo(point.x, point.y) : c.moveTo(point.x, point.y)); c.stroke(); }
          const image = state.images.get(slot.region); if (!image) continue; state.drawSlot(c, slot, image);
        }
        c.restore();
        if (state.showBones) {
          const selected = sample.slots.find(slot => slot.name === state.slot && slot.attachment === state.attachment && slot.type === 'mesh');
          if (selected) {
            c.strokeStyle = '#66dab777'; c.lineWidth = 0.6 / view.scale; c.beginPath();
            for (let i = 0; i < selected.triangles.length; i += 3) {
              const [a, b, d] = selected.triangles.slice(i, i + 3).map(index => selected.vertices[index]);
              c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.lineTo(d.x, d.y); c.closePath();
            }
            c.stroke();
            const point = selected.vertices[state.meshEdit.vertex];
            if (point) { c.fillStyle = '#6effcb'; c.beginPath(); c.arc(point.x, point.y, 5 / view.scale, 0, Math.PI * 2); c.fill(); }
          }
        }
        if (state.showBones) for (const bone of sample.bones) {
          const parent = sample.bones.find(item => item.name === bone.parent), m = bone.matrix, selected = bone.name === state.bone;
          c.strokeStyle = selected ? '#f8c96b' : '#a4c7e8'; c.lineWidth = (selected ? 2 : 1) / view.scale;
          if (parent) { c.beginPath(); c.moveTo(parent.matrix[4], parent.matrix[5]); c.lineTo(m[4], m[5]); c.stroke(); }
          c.fillStyle = selected ? '#ffd579' : '#9abfe7'; c.beginPath(); c.arc(m[4], m[5], (selected ? 5 : 3) / view.scale, 0, Math.PI * 2); c.fill();
        }
        r.canvas.dataset.ready = 'true'; r.canvas.dataset.assetId = state.asset.id; r.canvas.dataset.revisionId = state.revision.id;
        r.canvas.dataset.animation = state.animation; r.canvas.dataset.time = state.time.toFixed(3); drawTimeline();
      } catch (error) { notify(t('runtimeFailed', { message: error.message }), true); }
    }
    function timelineGeometry() {
      const viewport = timelineViewport.metrics;
      return { ...viewport, left: 84, length: Math.max(1, viewport.width - 104) };
    }
    function drawTimeline() {
      const viewport = timelineViewport?.metrics;
      if (state.disposed || !viewport?.width || !viewport.height) return;
      const canvas = r.timeline, c = canvas.getContext('2d'), duration = Math.max(0.001, state.duration), animation = editableAnimation();
      const geometry = timelineGeometry();
      c.setTransform(viewport.scaleX, 0, 0, viewport.scaleY, 0, 0);
      c.clearRect(0, 0, viewport.width, viewport.height); c.fillStyle = '#181e2b'; c.fillRect(0, 0, viewport.width, viewport.height); c.font = '12px sans-serif'; c.lineWidth = 1;
      for (const [row, name] of ['translate', 'rotate', 'scale'].entries()) {
        const y = 23 + row * 29; c.fillStyle = '#a4b6cf'; c.fillText(name, 8, y + 4); c.strokeStyle = '#36465e'; c.beginPath(); c.moveTo(geometry.left, y); c.lineTo(geometry.left + geometry.length, y); c.stroke();
        for (const [index, frame] of (animation?.bones?.[state.bone]?.[name] || []).entries()) { const x = geometry.left + frame.time / duration * geometry.length; c.fillStyle = state.channel === name && state.frameIndex === index ? '#ffcf75' : '#69b5d7'; c.beginPath(); c.moveTo(x, y - 5); c.lineTo(x + 5, y); c.lineTo(x, y + 5); c.lineTo(x - 5, y); c.closePath(); c.fill(); }
      }
      const x = geometry.left + Math.min(duration, state.time) / duration * geometry.length; c.strokeStyle = '#ef8491'; c.beginPath(); c.moveTo(x, 5); c.lineTo(x, 104); c.stroke();
    }
    r.timeline.addEventListener('pointerdown', event => {
      if (!state.document) return; const bounds = r.timeline.getBoundingClientRect(), geometry = timelineGeometry();
      if (!bounds.width || !bounds.height) return;
      const x = (event.clientX - bounds.left) / bounds.width * geometry.width, y = (event.clientY - bounds.top) / bounds.height * geometry.height;
      const duration = Math.max(0.001, state.duration);
      state.channel = ['translate', 'rotate', 'scale'][Math.min(2, Math.max(0, Math.round((y - 23) / 29)))]; state.time = Math.min(state.duration, Math.max(0, (x - geometry.left) / geometry.length * duration));
      const frames = track(), nearest = frames.findIndex(frame => Math.abs(frame.time - state.time) / duration * geometry.length < 9); selectFrame(nearest); state.playing = false; cache();
    }, { signal: gestures.signal });
    r.canvas.addEventListener('pointerdown', event => {
      if (!state.sampled || !state.camera) return;
      const bounds = r.canvas.getBoundingClientRect(), viewport = canvasViewport.metrics;
      if (!bounds.width || !bounds.height) return;
      const x = (event.clientX - bounds.left) / bounds.width * viewport.width, y = (event.clientY - bounds.top) / bounds.height * viewport.height, view = state.camera;
      if (event.shiftKey && selectedPart()?.type === 'mesh') {
        const slot = state.sampled.slots.find(slot => slot.name === state.slot && slot.attachment === state.attachment), vertices = slot?.vertices || [];
        let closest = -1, radius = 16;
        for (let i = 0; i < vertices.length; i++) { const point = vertices[i], d = Math.hypot(x - view.x - point.x * view.scale, y - view.y + point.y * view.scale); if (d < radius) { closest = i; radius = d; } }
        if (closest >= 0) { state.meshEdit.vertex = closest; state.playing = false; readMeshVertex(); sync(); draw(); }
        return;
      }
      let nearest, distance = 16;
      for (const bone of state.sampled.bones) { const d = Math.hypot(x - view.x - bone.matrix[4] * view.scale, y - view.y + bone.matrix[5] * view.scale); if (d < distance) { nearest = bone; distance = d; } }
      if (nearest) { state.bone = nearest.name; selectFrame(-1); renderSelection(); cache(); }
    }, { signal: gestures.signal });
    let animationFrame = 0, lastTime = 0;
    function tick(now) {
      if (state.disposed) return; const delta = Math.min(0.1, (now - (lastTime || now)) / 1000); lastTime = now;
      if (state.playing && state.document) { state.time = (state.time + delta * state.speed) % Math.max(0.001, state.duration); draw(); sync(); }
      animationFrame = requestAnimationFrame(tick);
    }
    animationFrame = requestAnimationFrame(tick);
    const chosen = state.snapshot.assets.find(asset => asset.kind === 'skeleton2d' && asset.id === ctx.selection?.assetId);
    if (chosen) void run(() => load(chosen.id, ctx.selection?.revisionId)).catch(error => notify(t('loadFailed', { message: error.message }), true)); else sync();
    const dispose = () => { cache(); state.disposed = true; state.sequence++; gestures.abort(); cancelAnimationFrame(animationFrame); boneGraph.destroy(); };
    dispose.canLeave = () => !state.busy;
    return dispose;
  }
  window.fwe.registerForm('fwv-skeleton2d', { render(context) { return window.createFwv2dForm(context, 'skeleton2d', mount); } });
}());
