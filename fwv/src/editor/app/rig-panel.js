(function () {
  'use strict';
  const svgNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attributes = {}) { const node = document.createElementNS(svgNS, tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); return node; }
  const artifact = (assetId, revisionId, fileName) => '/api/fwv/artifact?' + new URLSearchParams({ assetId, revisionId, fileName });
  const clone = value => structuredClone(value);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const point = value => object(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
  function readableDocument(value) {
    if (!object(value) || !object(value.source) || !object(value.motion) || !Array.isArray(value.parts)) return false;
    if (!Number.isFinite(value.source.width) || value.source.width <= 0 || !Number.isFinite(value.source.height) || value.source.height <= 0) return false;
    if (!['assetId', 'revisionId', 'fileName'].every(key => typeof value.source[key] === 'string' && value.source[key])) return false;
    if (value.warnings !== undefined && (!Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string' || object(warning)))) return false;
    const ids = new Set();
    return value.parts.every(part => {
      if (!object(part) || typeof part.id !== 'string' || !part.id || ids.has(part.id) || typeof part.name !== 'string' || typeof part.role !== 'string') return false;
      ids.add(part.id);
      return (part.parentId === null || typeof part.parentId === 'string') && Array.isArray(part.polygon) && part.polygon.every(point) && object(part.pivot)
        && ['x', 'y'].every(key => part.pivot[key] === null || Number.isFinite(part.pivot[key]));
    });
  }
  function warningText(warning, document, t) {
    if (typeof warning === 'string') return warning;
    const name = document?.parts?.find(part => part.id === warning.partId)?.name || warning.partId || t('message18');
    const messages = {
      RIG_MANUAL_SEGMENTATION: t('message19'),
      RIG_OVERLAPPING_PARTS: t('message1',{v0:(warning.pixels || 0)}),
      RIG_MISSING_COVERAGE: t('message2',{v0:(warning.pixels || 0)}),
      RIG_EMPTY_PART: t('message3',{v0:(name)}),
      RIG_RULE_MOTION: t('message20'),
      RIG_WAVE_UNAVAILABLE: t('message21'),
    };
    return messages[warning.code] || warning.message || warning.code || t('message22');
  }
  function errorText(error, t) {
    const messages = {
      INVALID_RIG_POLYGON: t('message23'),
      INVALID_RIG_POINT: t('message24'),
      INVALID_RIG_NAME: t('message25'),
      INVALID_RIG_PARTS: t('message26'),
      INVALID_RIG_PARENT: t('message27'),
      RIG_PARENT_CYCLE: t('message28'),
      RIG_EMPTY_PART: t('message29'),
      RIG_EMPTY_SOURCE: t('message30'),
      RIG_SOURCE_ORIENTATION: t('message31'),
      RIG_SOURCE_NOT_FOUND: t('message32'),
      RIG_DRAFT_NOT_FOUND: t('message33'),
      RIG_REVISION_CONFLICT: t('message34'),
      RIG_PIXEL_LIMIT: t('message35'),
      RIG_ATLAS_LIMIT: t('message36'),
    };
    return messages[error.code] || error.message || t('message37');
  }

  (window.FwvPanels ||= []).push({ id: 'rig', mount(host, ctx) {
    const state = { snapshot: ctx.getSnapshot(), disposed: false, busy: false, initialized: false, asset: null, revision: null, document: null, saved: null,
      selectedPartId: '', sourceAssetId: '', sourceRevisionId: '', nameTouched: false, dirty: false, invalidDraft: false, mode: 'select', drawing: [], drag: null, candidate: null, loadToken: 0 };
    const handlers=new Map(); const actions={dispatch:({element})=>Promise.resolve().then(()=>handlers.get(element)?.()).catch(()=>{})};
    const surface = ctx.createSurface('rig', { actions }); const t = surface.text;
    const root = surface.root; host.append(root);
    const r = surface.refs;
    const status=r.status, sourceAsset=r['source-asset'], sourceRevision=r['source-revision'], name=r.name, importInput=r['import-input'], importButton=r.import, create=r.create;
    const draft=r.draft, draftRevision=r['draft-revision'], newDraft=r.new, dirty=r.dirty, stage=r.stage, sourceImage=r['source-image'], emptyStage=r.emptyStage;
    const selectMode=r['select-mode'], draw=r.draw, close=r.close, undo=r.undo, reset=r.reset, pivotMode=r['set-pivot'], coordinate=r.coordinate;
    const part=r.part, backward=r.backward, forward=r.forward, add=r.add, remove=r.delete;
    const partName=r['part-name'], role=r.role, parent=r.parent, pivotX=r['pivot-x'], pivotY=r['pivot-y'];
    const save=r.save, discard=r.discard, build=r.build, warnings=r.warnings, fork=r.fork;
    const previewStage=r.previewStage, previewEmpty=r.previewEmpty, previewStatus=r['preview-status']; let canvas=r['preview-canvas'];
    const candidateSelect=r.candidate, candidateInfo=r.candidateInfo, openSpine=r['open-spine'], openReskin=r['open-reskin'], exportButton=r.export, buildChecks=r['build-checks'];
    const playback = ctx.createSurface('preview', { data: { prefix:'fwv-rig', showSkin:false, showSeek:true }, actions:{togglePlay:()=>handlers.get(play)?.()} }); r.previewTransport.append(playback.root);
    const { animation, play, seek, clock } = playback.refs;
    const colors = ctx.getUiConfig('rig').geometry.colors;
    const overlay = svg('svg', { viewBox:'0 0 100 100', width:'100%',height:'100%',preserveAspectRatio:'xMidYMid meet',tabindex:'0' }); overlay.dataset.testid='fwv-rig-overlay'; overlay.setAttribute('aria-label',t('overlayLabel')); r['overlay-host'].append(overlay);
    const options = (node, list, value) => (node === animation ? playback : surface).setOptions(node, list.map(([value,label])=>({value,label})), value);
    const bind=(control,handler)=>handlers.set(control,handler);
    bind(importButton, () => importInput.click()); bind(create, () => run(createDraft));
    bind(newDraft, () => { stopPreview(); state.asset = state.revision = state.document = state.saved = state.candidate = null; state.selectedPartId=''; state.dirty=false; state.invalidDraft=false; state.mode='select'; state.drawing=[]; state.drag=null; surface.update({nameValue:''}); state.nameTouched=false; ctx.setSelection({assetId:'',revisionId:''}); restoreCached('new'); render(); notify(t('newReady')); });
    bind(selectMode, () => { if(state.drawing.length){notify(t('finishPolygon'),true);return;} state.mode='select';cache();renderOverlay();sync(); });
    bind(draw, () => {state.mode='draw';state.drawing=[];cache();renderOverlay();sync();notify(t('drawGuide'));});
    bind(close, () => {const selected=selectedPart();if(!selected||state.drawing.length<3)return;selected.polygon=clone(state.drawing);state.drawing=[];state.mode='select';markDirty();renderOverlay();renderPartFields();notify(t('polygonUpdated'));});
    bind(undo,()=>{state.drawing.pop();renderOverlay();sync();cache();});
    bind(reset,()=>{const selected=selectedPart(),original=state.saved?.parts.find(item=>item.id===selected?.id);if(state.mode==='draw'){state.drawing=[];state.mode='select';}else if(selected&&original){selected.polygon=clone(original.polygon);markDirty();}renderOverlay();sync();cache();});
    bind(pivotMode,()=>{if(state.drawing.length){notify(t('finishPolygon'),true);return;}state.mode='pivot';cache();renderOverlay();sync();notify(t('pivotGuide'));});
    bind(backward,()=>reorder(-1));bind(forward,()=>reorder(1));bind(add,addPart);bind(remove,deletePart);
    const motion = Object.fromEntries(['idle','walk','wave'].map(key=>[key,r['motion-'+key]]));
    for(const [key,node] of Object.entries(motion)) node.addEventListener('change',()=>{if(!state.document)return;state.document.motion[key]=node.checked;markDirty();});
    bind(save,()=>run(saveDraft));bind(discard,discardDraft);bind(build,()=>run(buildDraft));bind(fork,()=>run(forkDraft));
    bind(play,()=>{playing=!playing;playback.update({playing});});
    bind(openSpine,()=>navigateCandidate('spine'));bind(openReskin,()=>navigateCandidate('reskin'));
    bind(exportButton,()=>run(async()=>{const result=await ctx.command('asset.export',clone(state.candidate));notify(t('exported',{path:(ctx.getSession()?.projectRoot||'')+'/'+result.path}));}));
    let player = null, frame = 0, previewToken = 0, playing = true, time = 0, lastTime = 0, previewKey = '';
    function notify(text, error = false) { if (state.disposed) return; if (state.invalidDraft) { text = t('message38'); error = true; } surface.update({notice:text,noticeError:error}); }
    function selectedPart() { return state.document?.parts.find(item => item.id === state.selectedPartId); }
    const unsaved = () => state.dirty || state.drawing.length > 0;
    const historical = () => Boolean(state.asset && state.revision && state.snapshot.assets.find(item => item.id === state.asset.id)?.selectedRevisionId !== state.revision.id);
    function cache() {
      if (state.disposed || !state.initialized || state.invalidDraft) return;
      ctx.drafts.set('rigDrafts', state.asset?.id || 'new', {
        assetId: state.asset?.id || '', revisionId: state.revision?.id || '', document: clone(state.document), saved: clone(state.saved),
        selectedPartId: state.selectedPartId, candidate: clone(state.candidate), mode: state.mode, drawing: clone(state.drawing),
        sourceAssetId: state.sourceAssetId, sourceRevisionId: state.sourceRevisionId, name: name.value,
      });
    }
    function restoreCached(id, revisionId) {
      state.invalidDraft = false;
      const cached = ctx.drafts.get('rigDrafts', id); if (!cached) return false;
      if (id !== 'new') {
        const asset = state.snapshot.assets.find(item => item.id === cached.assetId && item.kind === 'rig'), revision = asset?.revisions.find(item => item.id === cached.revisionId);
        if (!asset || !revision || (revisionId && revision.id !== revisionId)) return false;
        if (!readableDocument(cached.document) || !readableDocument(cached.saved) || !Array.isArray(cached.drawing) || !cached.drawing.every(point)) { state.invalidDraft = true; return false; }
        state.asset = asset; state.revision = revision; state.document = clone(cached.document); state.saved = clone(cached.saved);
      } else {
        if (cached.document !== null || cached.saved !== null || !Array.isArray(cached.drawing) || !cached.drawing.every(point)) { state.invalidDraft = true; return false; }
        state.asset = state.revision = state.document = state.saved = null;
      }
      state.selectedPartId = cached.selectedPartId || state.document?.parts[0]?.id || ''; state.candidate = clone(cached.candidate || null);
      state.sourceAssetId = cached.sourceAssetId || ''; state.sourceRevisionId = cached.sourceRevisionId || ''; surface.update({nameValue:cached.name || ''}); state.nameTouched = true;
      state.mode = ['select', 'draw', 'pivot'].includes(cached.mode) ? cached.mode : 'select'; state.drawing = clone(cached.drawing || []); state.drag = null;
      state.dirty = JSON.stringify(state.document) !== JSON.stringify(state.saved); return true;
    }
    function markDirty() { state.dirty = JSON.stringify(state.document) !== JSON.stringify(state.saved); cache(); sync(); }
    function sync() {
      if (state.disposed) return; const locked = state.busy || !state.initialized || state.invalidDraft, history = historical(), editingLocked = locked || history, hasDraft = Boolean(state.document), selected = selectedPart(), unfinished = state.mode === 'draw' && state.drawing.length > 0;
      const index=state.document?.parts.findIndex(item=>item.id===selected?.id)??-1;
      const capabilities={
        source:!locked&&!hasDraft, create:!locked&&!hasDraft&&Boolean(state.sourceAssetId), navigate:!state.busy&&state.initialized,
        revision:!locked&&!unsaved(), selectPart:!locked&&hasDraft&&!unfinished, part:!editingLocked&&hasDraft&&!unfinished, tool:!editingLocked&&Boolean(selected),
        close:!editingLocked&&state.mode==='draw'&&state.drawing.length>=3,undo:!locked&&state.drawing.length>0,
        add:!editingLocked&&hasDraft&&!unfinished&&state.document.parts.length<16,remove:!editingLocked&&Boolean(selected)&&!unfinished&&state.document.parts.length>1,
        backward:!editingLocked&&!unfinished&&index>0,forward:!editingLocked&&!unfinished&&index>=0&&index<(state.document?.parts.length||0)-1,
        save:!editingLocked&&hasDraft&&state.dirty&&!unfinished,discard:!locked&&unsaved(),build:!locked&&hasDraft&&!unsaved(),fork:!locked&&history&&!unfinished,
        candidate:!locked&&Boolean(state.candidate)&&!unsaved(),selectCandidate:!locked&&candidateSelect.options.length>0,overlay:!locked&&hasDraft
      };
      // The dirty notice is frozen during a drag so changing text cannot move the image under the pointer.
      const notice=state.drag?{}:{hasDraft,hasUnsaved:unsaved(),partCount:state.document?.parts.length||0,imageWidth:state.document?.source.width||0,imageHeight:state.document?.source.height||0};
      const origin = state.document?.forkedFrom, sourceDraft = state.snapshot.assets.find(item => item.id === origin?.assetId);
      surface.update({...notice,capabilities,busy:state.busy,tool:state.mode,hasCandidate:Boolean(state.candidate),historical:history,
        forkOrigin:origin?t('forkOrigin',{name:sourceDraft?.name||origin.assetId,version:(sourceDraft?.revisions.findIndex(item=>item.id===origin.revisionId)??-1)+1}):''});
      playback.update({canAnimate:Boolean(player?.animations.length),canPlay:Boolean(player),playing});
    }
    async function run(action) { if (state.busy || state.disposed) return; state.busy = true; sync(); try { await action(); } catch (error) { if(error.code==='RIG_REVISION_CONFLICT') { try { await refresh(); } catch {} } notify(errorText(error, t), true); } finally { state.busy = false; sync(); } }
    async function refresh() { await ctx.refresh(); if (!state.disposed) state.snapshot = ctx.getSnapshot(); }
    function renderSources() {
      const images = state.snapshot.assets.filter(item => item.kind === 'image');
      if (state.document) { state.sourceAssetId = state.document.source.assetId; state.sourceRevisionId = state.document.source.revisionId; }
      if (!images.some(item => item.id === state.sourceAssetId)) state.sourceAssetId = images.at(-1)?.id || '';
      const source = images.find(item => item.id === state.sourceAssetId); if (!source?.revisions.some(rev => rev.id === state.sourceRevisionId)) state.sourceRevisionId = source?.selectedRevisionId || '';
      options(sourceAsset, images.length ? images.map(item => [item.id, item.name]) : [['', t('message41')]], state.sourceAssetId);
      options(sourceRevision, source?.revisions.map((rev, index) => [rev.id, t('message5',{v0:(index === 0 ? t('message42') : t('message43') + (index + 1)),v1:(rev.metadata.image?.width || '?'),v2:(rev.metadata.image?.height || '?')})]) || [], state.sourceRevisionId);
      if (state.asset) surface.update({nameValue:state.asset.name}); else if (!state.nameTouched && !name.value) surface.update({nameValue:source?.name || ''});
      sync();
    }
    function renderDrafts() {
      const assets = state.snapshot.assets.filter(item => item.kind === 'rig');
      options(draft, [['', t('message44')], ...assets.map(item => [item.id, item.name])], state.asset?.id || '');
      const asset = state.snapshot.assets.find(item => item.id === state.asset?.id);
      options(draftRevision, asset?.revisions.map((rev, index) => [rev.id, t('message6',{v0:(index + 1)})]) || [], state.revision?.id);
    }
    function renderPartFields() {
      const selected = selectedPart();surface.update({partFields:{name:selected?.name||'',role:selected?.role||'accessory',pivotX:selected?.pivot.x??'',pivotY:selected?.pivot.y??'',motion:state.document?.motion||{}},imageWidth:state.document?.source.width??0,imageHeight:state.document?.source.height??0});
      const forbidden = new Set(selected ? [selected.id] : []); let previous;
      do { previous = forbidden.size; for (const item of state.document?.parts || []) if (forbidden.has(item.parentId)) forbidden.add(item.id); } while (previous !== forbidden.size);
      options(parent, [['', t('message45')], ...(state.document?.parts || []).filter(item => !forbidden.has(item.id)).map(item => [item.id, item.name])], selected?.parentId || '');
      sync();
    }
    function renderPartList() {
      const parts = state.document?.parts || []; options(part, parts.map((item,index)=>[item.id,t('partOrder',{index:index+1,name:item.name})]), state.selectedPartId);
    }
    function choosePart(id) { if (state.busy || state.drawing.length) return; state.selectedPartId = id; state.mode = 'select'; renderPartFields(); renderPartList(); renderOverlay(); cache(); sync(); }
    function renderOverlay() {
      overlay.replaceChildren(); const document = state.document;
      if (!document) {surface.update({sourceUrl:null});return;}
      const { width, height } = document.source; overlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const sourceUrl = artifact(state.asset.id, state.revision.id, document.source.referenceFile);
      if (sourceImage.getAttribute('src') !== sourceUrl) surface.update({sourceUrl});
      const radius = Math.max(width, height) / 95, handles = svg('g');
      for (const [index, item] of document.parts.entries()) {
        const selected = item.id === state.selectedPartId, color = colors[index % colors.length];
        const shape = svg('polygon', { points: item.polygon.map(point => `${point.x},${point.y}`).join(' '), fill: color, 'fill-opacity': selected ? '.24' : '.07', stroke: color, 'stroke-width': selected ? 2 : 1, 'vector-effect': 'non-scaling-stroke' }); shape.dataset.partId = item.id; overlay.append(shape);
        if (selected && state.mode !== 'draw' && !historical()) {
          item.polygon.forEach((point, vertexIndex) => { const handle = svg('circle', { cx: point.x, cy: point.y, r: radius, fill: '#fff', stroke: color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }); handle.dataset.vertexIndex = String(vertexIndex); handle.setAttribute('aria-label', t('message7',{v0:(vertexIndex + 1)})); handles.append(handle); });
          const x = item.pivot.x, y = item.pivot.y;
          if (Number.isFinite(x) && Number.isFinite(y)) {
            const pivot = svg('g', { 'pointer-events': 'none' }); pivot.append(svg('path', { d: `M${x - radius * 2},${y}H${x + radius * 2} M${x},${y - radius * 2}V${y + radius * 2}`, stroke: '#1f3c36', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' })); handles.append(pivot);
            const pivotHandle = svg('circle', { cx: x, cy: y, r: radius * 1.15, fill: '#ffd66f', stroke: '#71542b', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }); pivotHandle.dataset.pivotHandle = 'true'; pivotHandle.setAttribute('aria-label', t('text1')); handles.append(pivotHandle);
          }
        }
      }
      // Handles stay above every region, including later foreground polygons.
      overlay.append(handles);
      if (state.mode === 'draw') {
        const points = state.drawing.map(point => `${point.x},${point.y}`).join(' '); overlay.append(svg('polyline', { points, fill: 'none', stroke: '#d97724', 'stroke-width': 2, 'stroke-dasharray': '5 3', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }));
        for (const point of state.drawing) overlay.append(svg('circle', { cx: point.x, cy: point.y, r: radius, fill: '#eaa660', stroke: '#fff', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }));
      }
      surface.update({coordinate:state.mode === 'draw' ? t('message9',{v0:(state.drawing.length)}) : t('message10',{v0:(selectedPart()?.name || ''),v1:(selectedPart()?.polygon.length || 0)})});
    }
    function pointFromEvent(event) { const matrix = overlay.getScreenCTM(); if (!matrix || !state.document) return null; const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()), { width, height } = state.document.source; if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) return null; return { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 }; }
    overlay.addEventListener('pointerdown', event => {
      if (state.busy || state.invalidDraft || !state.initialized || !selectedPart() || event.button !== 0) return; if(historical()) { if(event.target.dataset.partId) choosePart(event.target.dataset.partId); return; } const point = pointFromEvent(event); if (!point) return; event.preventDefault();
      if (state.mode === 'draw') { if (state.drawing.length >= 64) { notify(t('message46'), true); return; } state.drawing.push(point); renderOverlay(); cache(); sync(); return; }
      if (state.mode === 'pivot') { selectedPart().pivot = point; state.mode = 'select'; markDirty(); renderPartFields(); renderOverlay(); return; }
      const target = event.target; if (target.dataset.vertexIndex !== undefined || target.dataset.pivotHandle) { state.drag = { type: target.dataset.pivotHandle ? 'pivot' : 'vertex', index: Number(target.dataset.vertexIndex), pointerId: event.pointerId, before: clone(state.document) }; overlay.setPointerCapture(event.pointerId); }
      else if (target.dataset.partId) choosePart(target.dataset.partId);
    });
    overlay.addEventListener('pointermove', event => { const point = pointFromEvent(event); if (!point || state.busy) return; surface.update({coordinate:t('pointerCoordinate',{x:point.x.toFixed(1),y:point.y.toFixed(1)})}); if (!state.drag || state.drag.pointerId !== event.pointerId) return; if (state.drag.type === 'pivot') selectedPart().pivot = point; else selectedPart().polygon[state.drag.index] = point; state.dirty = JSON.stringify(state.document) !== JSON.stringify(state.saved); renderOverlay(); renderPartFields(); sync(); });
    function endDrag(event) {
      if (state.drag?.pointerId !== event.pointerId) return;
      const before = state.drag.before; state.drag = null;
      if (event.type !== 'pointerup') state.document = before;
      state.dirty = JSON.stringify(state.document) !== JSON.stringify(state.saved);
      if (event.type === 'pointerup' && JSON.stringify(before) !== JSON.stringify(state.document)) cache();
      if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
      renderOverlay(); renderPartFields(); sync();
    }
    overlay.addEventListener('pointerup', endDrag); overlay.addEventListener('pointercancel', endDrag); overlay.addEventListener('lostpointercapture', endDrag);

    function reorder(delta) { if (!state.document || state.busy) return; const index = state.document.parts.findIndex(item => item.id === state.selectedPartId); if (index + delta < 0 || index + delta >= state.document.parts.length) return; const [selected] = state.document.parts.splice(index, 1); state.document.parts.splice(index + delta, 0, selected); markDirty(); renderPartList(); renderOverlay(); sync(); }
    function addPart() { if (!state.document || state.document.parts.length >= 16) return; const { width, height } = state.document.source, x = width * .35, y = height * .35, w = width * .3, h = height * .3; const part = { id: `part_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, name: t('message11',{v0:(state.document.parts.length + 1)}), role: 'accessory', parentId: state.selectedPartId || null, polygon: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], pivot: { x: x + w / 2, y: y + h / 2 } }; state.document.parts.push(part); state.selectedPartId = part.id; markDirty(); renderPartList(); renderPartFields(); renderOverlay(); notify(t('message47')); }
    function deletePart() { const selected = selectedPart(); if (!selected || state.document.parts.length <= 1) return; state.document.parts = state.document.parts.filter(item => item.id !== selected.id); for (const item of state.document.parts) if (item.parentId === selected.id) item.parentId = selected.parentId; state.selectedPartId = state.document.parts.at(-1).id; markDirty(); renderPartList(); renderPartFields(); renderOverlay(); notify(t('message12',{v0:(selected.name)})); }
    part.addEventListener('change', () => choosePart(part.value));
    partName.addEventListener('input', () => { if (!selectedPart()) return; selectedPart().name = partName.value; markDirty(); renderPartList(); });
    role.addEventListener('change', () => { if (!selectedPart()) return; selectedPart().role = role.value; markDirty(); });
    parent.addEventListener('change', () => { if (!selectedPart()) return; selectedPart().parentId = parent.value || null; markDirty(); renderPartFields(); });
    for (const [key, node] of [['x', pivotX], ['y', pivotY]]) node.addEventListener('input', () => { if (!selectedPart()) return; selectedPart().pivot[key] = node.value.trim() && Number.isFinite(node.valueAsNumber) ? node.valueAsNumber : null; markDirty(); renderOverlay(); });
    sourceAsset.addEventListener('change', () => { state.sourceAssetId = sourceAsset.value; state.sourceRevisionId = ''; surface.update({nameValue:''}); state.nameTouched = false; renderSources(); cache(); });
    sourceRevision.addEventListener('change', () => { state.sourceRevisionId = sourceRevision.value; cache(); });
    name.addEventListener('input', () => { state.nameTouched = true; cache(); });
    draft.addEventListener('change', () => { if (!draft.value) { draft.value = state.asset?.id || ''; return; } void run(() => loadDraft(draft.value)); });
    draftRevision.addEventListener('change', () => { if (draftRevision.value) void run(() => loadDraft(state.asset.id, draftRevision.value)); });
    importInput.addEventListener('change', () => { const file = importInput.files[0]; importInput.value = ''; if (!file) return; void run(async () => { if (!/\.(png|jpe?g|webp)$/i.test(file.name) || !file.size || file.size > 20 * 1024 * 1024) throw new Error(t('message48'));
      const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error(t('message49'))); reader.readAsDataURL(file); });
      const asset = await ctx.command('image.import', { name: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, base64 }); await refresh(); if (state.disposed) return; state.sourceAssetId = asset.id; state.sourceRevisionId = asset.selectedRevisionId; surface.update({nameValue:asset.name}); renderSources(); cache(); notify(t('message50'));
    }); });

    function applyDraft(result, persist = false) {
      if (!result?.asset?.id || !result?.revision?.id || !result.revision.metadata?.rig) throw new Error(t('message51'));
      state.asset = result.asset; state.revision = result.revision; state.document = clone(result.document || result.revision.metadata.rig); state.saved = clone(state.document); state.dirty = false; state.mode = 'select'; state.drawing = [];
      if (!state.document.parts.some(item => item.id === state.selectedPartId)) state.selectedPartId = state.document.parts[0]?.id || '';
      render(); if (persist) cache(); ctx.setSelection({ assetId: state.asset.id, revisionId: state.revision.id });
    }
    async function loadDraft(assetId, revisionId, restoring = false) { const asset = state.snapshot.assets.find(item => item.id === assetId); const revision = revisionId || asset?.selectedRevisionId; if (!asset || !revision) throw new Error(t('message52')); const token = ++state.loadToken;
      if (restoreCached(assetId, restoring ? undefined : revisionId)) { ctx.setSelection({ assetId: state.asset.id, revisionId: state.revision.id }); render(); notify(historical() ? '' : unsaved() ? t('message53') : t('message54')); return; }
      const result = await ctx.api('/api/fwv/rig/draft?' + new URLSearchParams({ assetId, revisionId: revision })); if (state.disposed || token !== state.loadToken) return; state.candidate = null; applyDraft(result);
      notify(state.invalidDraft ? t('message55') : historical() ? '' : t('message56'), state.invalidDraft);
    }
    async function createDraft() { if (!state.sourceAssetId || !state.sourceRevisionId || !name.value.trim()) throw new Error(t('message57'));
      notify(t('message58')); const result = await ctx.command('rig.create', { sourceAssetId: state.sourceAssetId, sourceRevisionId: state.sourceRevisionId, name: name.value.trim(), preset: 'humanoid6' }); await refresh(); if (state.disposed) return; state.candidate = null; applyDraft(result, true); await ctx.drafts.save(); notify(t('message59'));
    }
    async function saveDraft() { if (!state.document || state.drawing.length) throw new Error(t('message60'));
      if (historical()) throw new Error(t('historyReadonly'));
      const result = await ctx.command('rig.save', { assetId: state.asset.id, revisionId: state.revision.id, parts: clone(state.document.parts), motion: clone(state.document.motion) }); await refresh(); if (state.disposed) return; applyDraft(result, true); await ctx.drafts.save(); notify(t('message61'));
    }
    async function forkDraft() {
      if (!state.document || !historical() || state.drawing.length) throw new Error(t('historyReadonly'));
      const result = await ctx.command('rig.fork', { assetId: state.asset.id, revisionId: state.revision.id, name:t('forkName',{name:state.asset.name.slice(0,140)}), parts:clone(state.document.parts), motion:clone(state.document.motion) });
      await refresh(); if(state.disposed)return; state.candidate=null; applyDraft(result,true); await ctx.drafts.save(); notify(t('forkCreated'));
    }
    function discardDraft() { if (!state.saved || state.busy) return; state.document = clone(state.saved); state.dirty = false; state.drawing = []; state.mode = 'select'; if (!state.document.parts.some(item => item.id === state.selectedPartId)) state.selectedPartId = state.document.parts[0]?.id || ''; cache(); render(); notify(t('message62')); }
    async function buildDraft() { if (!state.document || unsaved()) throw new Error(t('message63'));
      notify(t('message64')); const result = await ctx.command('rig.build', { assetId: state.asset.id, revisionId: state.revision.id }); await refresh(); if (state.disposed) return;
      if (!result?.asset?.id || !result?.revision?.id) throw new Error(t('message65')); state.candidate = { assetId: result.asset.id, revisionId: result.revision.id }; cache(); renderCandidates(); await loadPreview(); await ctx.drafts.save(); notify(t('message66'));
    }
    function candidates() { return state.snapshot.assets.filter(asset => asset.kind === 'spine').flatMap(asset => asset.revisions.filter(revision => revision.metadata.rigBuild?.draft?.assetId === state.asset?.id).map(revision => ({ asset, revision }))); }
    function selectedCandidate() { const asset = state.snapshot.assets.find(item => item.id === state.candidate?.assetId), revision = asset?.revisions.find(item => item.id === state.candidate?.revisionId); return asset && revision ? { asset, revision } : null; }
    function renderCandidates() {
      const list = candidates(); if (!list.some(item => item.asset.id === state.candidate?.assetId && item.revision.id === state.candidate?.revisionId)) { const latest = list.at(-1); state.candidate = latest ? { assetId: latest.asset.id, revisionId: latest.revision.id } : null; }
      options(candidateSelect, list.map((item, index) => [`${item.asset.id}/${item.revision.id}`, t('message13',{v0:(index + 1),v1:(item.asset.name)})]), state.candidate ? `${state.candidate.assetId}/${state.candidate.revisionId}` : '');
      const current = selectedCandidate(), builtFrom = current?.revision.metadata.rigBuild?.draft; surface.update({candidateInfo:current ? t('message14',{v0:(builtFrom?.revisionId === state.revision?.id ? t('message67') : t('message68')),v1:(current.asset.id),v2:(current.revision.id)}) : t('message69')});
      buildChecks.replaceChildren(); for (const check of current?.revision.metadata.rigBuild?.partChecks || []) buildChecks.append(surface.render('message',{message: t('message15',{v0:(check.name || check.partId || check.regionName || t('message70')),v1:(check.visiblePixels ?? check.outputVisiblePixels ?? '?')})}));
      for (const warning of current?.revision.metadata.rig?.warnings || []) buildChecks.append(surface.render('message',{message: warningText(warning, current.revision.metadata.rig, t)}));
      sync();
    }
    candidateSelect.addEventListener('change', () => { const [assetId, revisionId] = candidateSelect.value.split('/'); state.candidate = assetId && revisionId ? { assetId, revisionId } : null; renderCandidates(); void loadPreview(); cache(); });
    function navigateCandidate(panel) { if (!state.candidate || unsaved()) return; ctx.navigate(panel, panel === 'reskin' ? { templateAssetId: state.candidate.assetId, templateRevisionId: state.candidate.revisionId } : clone(state.candidate)); }
    function stopPreview() { ++previewToken; cancelAnimationFrame(frame); frame = 0; lastTime = 0; player?.dispose(); player = null; previewKey = ''; }
    function tick(now) { if (state.disposed || !player) return; if (playing) time += Math.min((now - (lastTime || now)) / 1000, .1); lastTime = now;
      try { player.draw(time); const duration = Number(seek.max); playback.update({seekTime:duration?time%duration:0,seconds:(duration?time%duration:time).toFixed(2)},playback.root); frame = requestAnimationFrame(tick); } catch (error) { surface.update({previewStatus:t('message16',{v0:error.message}),previewError:true}); stopPreview(); sync(); }
    }
    async function loadPreview() {
      const current = selectedCandidate(), key = current ? `${current.asset.id}/${current.revision.id}` : ''; if (key && key === previewKey) return; stopPreview();
      const token = previewToken; surface.update({previewReady:false,previewStatus:'',previewError:false}); options(animation, []);
      const next = surface.render('canvas'); canvas.replaceWith(next); canvas = next;
      if (!current) { surface.update({previewMessage:t('text2')}); sync(); return; }
      previewKey = key; surface.update({previewMessage:t('text3')}); sync();
      try { if (typeof window.FwvSpinePreview !== 'function') throw new Error(t('text4')); const loaded = await window.FwvSpinePreview(canvas, current.asset, current.revision, {text:playback.text}); if (state.disposed || token !== previewToken) { loaded.dispose(); return; }
        player = loaded; surface.update({previewReady:true}); options(animation, [['', t('text5')], ...loaded.animations.map(item => [item.name, item.name])], loaded.animations[0]?.name || ''); loaded.setAnimation(animation.value); playback.update({duration:loaded.animations[0]?.duration || 1},playback.root); time = 0; playing = true; playback.update({playing});surface.update({previewStatus:t('text7'),previewError:false}); frame = requestAnimationFrame(tick); sync();
      } catch (error) { if (state.disposed || token !== previewToken) return; surface.update({previewMessage:t('text8'),previewStatus:error.message,previewError:true}); sync(); }
    }
    animation.addEventListener('change', () => { if (!player) return; time = 0; player.setAnimation(animation.value); playback.update({duration:player.animations.find(item => item.name === animation.value)?.duration || 1},playback.root); });
    seek.addEventListener('input', () => { time = Number(seek.value); playing = false; playback.update({playing}); player?.draw(time); });
    const resize = new ResizeObserver(() => { if (player && !state.disposed) { try { player.draw(time); } catch {} } }); resize.observe(previewStage);
    function render() { renderSources(); renderDrafts(); renderPartList(); renderPartFields(); renderOverlay(); warnings.replaceChildren(); for (const warning of state.document?.warnings || []) warnings.append(surface.render('message',{message: warningText(warning, state.document, t)})); renderCandidates(); void loadPreview(); sync(); if (state.invalidDraft) notify('', true); }
    async function initialize() { try {
      await refresh(); if (state.disposed) return; state.initialized = true;
      const selected = state.snapshot.assets.find(item => item.id === ctx.selection?.assetId);
      if (selected?.kind === 'image') { restoreCached('new'); state.sourceAssetId = selected.id; state.sourceRevisionId = ctx.selection.revisionId || selected.selectedRevisionId; ctx.setSelection({ assetId: '', revisionId: '' }); render(); return; }
      if (ctx.selection?.assetId === '') { restoreCached('new'); render(); return; }
      const rig = selected?.kind === 'rig' ? selected : state.snapshot.assets.filter(item => item.kind === 'rig').at(-1);
      if (rig) await loadDraft(rig.id, selected?.kind === 'rig' ? ctx.selection.revisionId : undefined, true); else { restoreCached('new'); ctx.setSelection({ assetId: '', revisionId: '' }); render(); }
    } catch (error) { notify(t('text10',{v0:(errorText(error, t))}), true); } finally { sync(); } }
    render(); void initialize();
    const dispose = () => { state.disposed = true; ++state.loadToken; stopPreview(); resize.disconnect(); playback.dispose(); surface.dispose(); root.remove(); };
    dispose.canLeave = () => { if (state.busy) { notify(t('message71'), true); return false; } return true; };
    return dispose;
  } });
}());
