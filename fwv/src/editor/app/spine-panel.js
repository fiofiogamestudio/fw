(function () {
  function fileBase64(file, t) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error(t('text1'))); reader.readAsDataURL(file); }); }
  function partUrl(assetId, revisionId, regionName) { return '/api/fwv/spine/part?' + new URLSearchParams({ assetId, revisionId, regionName }); }

  (window.FwvPanels ||= []).push({ id: 'spine', mount(host, ctx) {
    const handlers=new Map(),actions={dispatch:({element})=>handlers.get(element)?.()};
    const surface = ctx.createSurface('spine',{actions}); const t = surface.text; const root = surface.root; host.append(root);
    const r=surface.refs, status=r.status, importInput=r['import-input'], importButton=r.import, assetSelect=r.asset, revisionSelect=r.revision;
    const summary=r.summary, previewStatus=r['preview-status'], partSelect=r.region, basePart=r.basePart, currentPart=r.currentPart;
    const replaceInput=r['replacement-input'], replaceName=r.replaceName, chooseReplacement=r.choose, librarySelect=r['library-image'], useLibrary=r['use-library'];
    const inputs=Object.fromEntries(['scale','offsetX','offsetY','rotation'].map(key=>[key,r[key]])), flipX=r.flip, apply=r.replace, validate=r.validate, exportButton=r.export, issues=r.issues;
    const playback=ctx.createSurface('preview',{data:{prefix:'fwv-spine',showSkin:true,showSeek:true},actions:{togglePlay:()=>handlers.get(play)?.()}});r.transport.append(playback.root);
    const {animation,skin,play,seek,clock}=playback.refs;
    const originalPane=playback.render('pane',{label:t('originalLabel'),testId:'fwv-spine-original',emptyMessage:''}), currentPane=playback.render('pane',{label:t('currentLabel'),testId:'fwv-spine-current',emptyMessage:''});r.views.append(originalPane,currentPane);
    playback.update({ready:true},originalPane);playback.update({ready:true},currentPane);
    const originalCanvas=originalPane.refs.canvas,currentCanvas=currentPane.refs.canvas;
    const options=(node,entries,selected)=>(node===animation||node===skin?playback:surface).setOptions(node,entries,selected);
    const bind=(node,handler)=>handlers.set(node,handler);
    let snapshot, selectedAssetId = ctx.selection?.assetId, selectedRevisionId = ctx.selection?.revisionId, selectedRegion, replacement = null, replacementReference = null;
    let preferredAnimation = '', preferredSkin = '', partDrafts = [];
    let previewTimer, previewRequest, previewGeneration = 0, draftGeneration = 0;
    let players = [], frame = 0, lastTime = 0, time = 0, playing = true, generation = 0, disposed = false, busy = false;
    function notify(message, error = false) { if (!disposed) surface.update({notice:message,noticeError:error}); }
    function stopPlayers() { cancelAnimationFrame(frame); frame = 0; for (const player of players) player.dispose(); players = [];playback.update({canPlay:false,canAnimate:false},playback.root); }
    function asset() { return snapshot?.assets.find(item => item.id === selectedAssetId); }
    function revision() { return asset()?.revisions.find(item => item.id === selectedRevisionId); }
    function transform() { return { ...Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, Number(input.value)])), flipX: flipX.checked }; }
    function currentPartDraft() { return { revisionId: selectedRevisionId || '', regionName: selectedRegion || '',
      libraryImageId: librarySelect.value, replacementAssetId: replacementReference?.assetId || '', replacementRevisionId: replacementReference?.revisionId || '', replacementFileName: replacementReference?.fileName || '', transform: transform() }; }
    function saveDraft() {
      if (disposed || !selectedAssetId) return;
      const current = currentPartDraft();
      if (current.revisionId && current.regionName) {
        const index = partDrafts.findIndex(item => item.revisionId === current.revisionId && item.regionName === current.regionName);
        if (index < 0) partDrafts.push(current); else partDrafts[index] = current;
      }
      ctx.setSelection({ assetId: selectedAssetId, revisionId: selectedRevisionId || '' });
      // Preserve the legacy active-part fields so existing drafts remain readable.
      ctx.drafts.set('spineDrafts', selectedAssetId, { assetId: selectedAssetId, ...current, partDrafts,
        animation: animation.value || preferredAnimation, skin: skin.value || preferredSkin, playing, time });
    }
    function cancelPreview() { clearTimeout(previewTimer); previewRequest?.abort(); previewRequest = null; previewGeneration++; }
    async function restorePartDraft() {
      const token = ++draftGeneration; cancelPreview();
      const draft = partDrafts.find(item => item.revisionId === selectedRevisionId && item.regionName === selectedRegion);
      replacement = null; replacementReference = draft?.replacementAssetId && draft?.replacementRevisionId && draft?.replacementFileName
        ? { assetId: draft.replacementAssetId, revisionId: draft.replacementRevisionId, fileName: draft.replacementFileName } : null;
      surface.update({ transform: { scale: draft?.transform?.scale ?? 1, offsetX: draft?.transform?.offsetX ?? 0, offsetY: draft?.transform?.offsetY ?? 0, rotation: draft?.transform?.rotation ?? 0, flipX: Boolean(draft?.transform?.flipX) },
        replacementName: t('text17'), hasReplacement: false, calibrationPending: false, calibrationError: false, calibrationStatus: '' });
      librarySelect.value = draft?.libraryImageId || '';
      if (replacementReference) {
        try { const loaded = await readReplacement(replacementReference); if (disposed || token !== draftGeneration) return;
          replacement = loaded.file; surface.update({ replacementName: t('text18') + loaded.name, hasReplacement: true });
        } catch (error) { if (!disposed && token === draftGeneration) notify(error.message, true); }
      }
    }
    function schedulePreview(delay = 180) {
      cancelPreview(); const token = previewGeneration;
      const isCurrent = () => !disposed && token === previewGeneration;
      const player = players[1];
      if (!replacement || !asset() || !revision() || !selectedRegion) {
        player?.setPageOverrides({}, isCurrent).catch(error => { if (isCurrent()) notify(error.message, true); });
        currentCanvas.dataset.calibration = 'saved'; updateParts();
        playback.update({label:t('currentLabel')},currentPane);
        surface.update({calibrationPending:false,calibrationError:false,calibrationStatus:''}); return;
      }
      const payload = { assetId: selectedAssetId, revisionId: selectedRevisionId, regionName: selectedRegion, transform: transform() }, source = replacement;
      playback.update({label:t('pendingLabel')},currentPane);
      currentCanvas.dataset.calibration = 'pending';
      surface.update({hasReplacement:true,calibrationPending:true,calibrationError:false,calibrationStatus:t('previewPending')});
      previewTimer = setTimeout(async () => {
        const controller = new AbortController(); previewRequest = controller;
        try {
          payload.base64 = await fileBase64(source, t); if (!isCurrent()) return;
          // A read-only command bypasses the mutation refresh/busy wrapper, so typing and playback continue.
          const response = await ctx.api('/api/fwv/commands', { method:'POST', signal:controller.signal,
            headers:{'Content-Type':'application/json','X-FWV-CSRF':ctx.getSession().csrfToken}, body:JSON.stringify({type:'spine.preview',payload}) });
          if (!isCurrent()) return;
          const result = response.result;
          const activePlayer = players[1];
          if (activePlayer && !await activePlayer.setPageOverrides({[result.pageName]:'data:image/png;base64,'+result.pageBase64}, isCurrent)) return;
          if (!isCurrent()) return;
          surface.update({currentPartUrl:'data:image/png;base64,'+result.partBase64,calibrationPending:false,calibrationError:false,
            calibrationStatus:result.warnings.some(item=>item.code==='TRIM_CLIPPED')?t('previewClipped'):t('previewReady')});
          currentCanvas.dataset.calibration = 'ready';
        } catch (error) { if (isCurrent() && error.name !== 'AbortError') {
          currentCanvas.dataset.calibration = 'error';
          surface.update({calibrationPending:false,calibrationError:true,calibrationStatus:t('previewFailed',{error:error.message})});
        } } finally { if (previewRequest === controller) previewRequest = null; }
      }, delay);
    }
    function changeCalibration() { saveDraft(); schedulePreview(); }
    async function readReplacement(reference) {
      const source = snapshot?.assets.find(item => item.id === reference.assetId && item.kind === 'image');
      const sourceRevision = source?.revisions.find(item => item.id === reference.revisionId);
      const file = sourceRevision?.files.find(item => item.name === reference.fileName && ['image', 'source'].includes(item.role) && item.mime.startsWith('image/'));
      if (!file) throw new Error(t('text2'));
      const response = await fetch('/api/fwv/artifact?' + new URLSearchParams(reference), { headers: window.fwe.session.headers() });
      if (!response.ok) throw new Error(t('text3'));
      return { file: new File([await response.blob()], file.name, { type: file.mime }), name: source.name };
    }
    async function run(fn) { if (busy || disposed) return; busy = true; surface.update({busy}); try { await fn(); } catch (error) { notify(error.message, true); } finally { busy = false; if (!disposed) surface.update({busy,hasAsset:Boolean(asset()),hasReplacement:Boolean(replacement)}); } }

    bind(importButton,()=>importInput.click());bind(chooseReplacement,()=>replaceInput.click());
    bind(r.clear,()=>{replacement=null;replacementReference=null;surface.update({replacementName:t('text17'),hasReplacement:false});saveDraft();schedulePreview(0);});
    bind(play,()=>{playing=!playing;playback.update({playing},playback.root);saveDraft();});
    bind(useLibrary,()=>run(async()=>{
      const selected=snapshot?.assets.find(item=>item.id===librarySelect.value&&item.kind==='image');
      const selectedRevision=selected?.revisions.find(item=>item.id===selected.selectedRevisionId);
      const imageFile=selectedRevision?.files.find(item=>['image','source'].includes(item.role)&&item.mime.startsWith('image/'));
      if(!selected||!selectedRevision||!imageFile)throw new Error(t('noLibraryImage'));
      const reference={assetId:selected.id,revisionId:selectedRevision.id,fileName:imageFile.name},loaded=await readReplacement(reference);
      if(disposed)return;replacement=loaded.file;replacementReference=reference;surface.update({replacementName:t('libraryName',{name:loaded.name})});saveDraft();schedulePreview();notify(t('libraryReady'));
    }));
    bind(apply,()=>run(async()=>{if(!asset()||!revision()||!selectedRegion||!replacement)throw new Error(t('selectReplacement'));
      saveDraft(); cancelPreview(); const settings=transform();
      const result=await ctx.command('spine.replace',{assetId:selectedAssetId,revisionId:selectedRevisionId,regionName:selectedRegion,base64:await fileBase64(replacement,t),transform:settings});
      if(disposed)return;
      selectedRevisionId=result.selectedRevisionId;await reload(true,{restorePart:true});saveDraft();notify(t('replacementSaved'));
    }));
    bind(validate,()=>run(async()=>{if(!revision())throw new Error(t('importFirst'));const report=await ctx.command('revision.validate',{assetId:selectedAssetId,revisionId:selectedRevisionId});notify(report.status==='passed'?t('validationPassed'):t('validationFailed',{checks:JSON.stringify(report.checks)}),report.status!=='passed');await reload(false);}));
    bind(exportButton,()=>run(async()=>{if(!revision())throw new Error(t('importFirst'));const result=await ctx.command('asset.export',{assetId:selectedAssetId,revisionId:selectedRevisionId});notify(t('exported',{path:((ctx.getSession()?.projectRoot||'')+'/'+result.path).replaceAll('\\','/')}));}));
    for(const input of Object.values(inputs))input.addEventListener('input',changeCalibration);
    flipX.addEventListener('change',changeCalibration);librarySelect.addEventListener('change',saveDraft);
    importInput.addEventListener('change', () => run(async () => {
      const files = Array.from(importInput.files); if (!files.length) return;
      if (files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) throw new Error(t('text4'));
      notify(t('text5'));
      const result = await ctx.command('spine.import', { name: files.find(file => /\.json$/i.test(file.name))?.name.replace(/\.json$/i, '') || t('text6'), files: await Promise.all(files.map(async file => ({ name: file.name, base64: await fileBase64(file, t) }))) });
      if (disposed) return;
      selectedAssetId = result.id; selectedRevisionId = result.selectedRevisionId; ctx.setSelection({ assetId: selectedAssetId, revisionId: selectedRevisionId }); await reload(true, { restoreDraft: true }); if (disposed) return; saveDraft(); importInput.value = ''; notify(t('text7'));
    }));
    replaceInput.addEventListener('change', () => run(async () => {
      const file = replaceInput.files[0]; if (!file) return;
      notify(t('text8'));
      const imported = await ctx.command('image.import', { name: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, base64: await fileBase64(file, t) });
      const importedRevision = imported.revisions.find(item => item.id === imported.selectedRevisionId), importedFile = importedRevision?.files.find(item => ['source', 'image'].includes(item.role) && item.mime.startsWith('image/'));
      if (!importedFile) throw new Error(t('text9'));
      if (disposed) return; replacement = file; replacementReference = { assetId: imported.id, revisionId: importedRevision.id, fileName: importedFile.name };
      await reload(false); if (disposed) return; librarySelect.value = imported.id; surface.update({replacementName:t('text10') + imported.name}); saveDraft(); schedulePreview(); replaceInput.value = ''; notify(t('text11'));
    }));
    assetSelect.addEventListener('change', () => run(async () => { saveDraft(); selectedAssetId = assetSelect.value; selectedRevisionId = asset()?.selectedRevisionId; ctx.setSelection({ assetId: selectedAssetId, revisionId: '' }); await reload(true, { restoreDraft: true }); saveDraft(); }));
    revisionSelect.addEventListener('change', () => run(async () => { saveDraft(); selectedRevisionId = revisionSelect.value; await ctx.command('revision.select', { assetId: selectedAssetId, revisionId: selectedRevisionId }); await reload(true,{restorePart:true}); saveDraft(); }));
    partSelect.addEventListener('change', () => run(async () => { saveDraft(); selectedRegion = partSelect.value; await restorePartDraft(); if(disposed)return; updateParts(); saveDraft(); schedulePreview(); }));
    function updateParts() { if (!asset() || !revision() || !selectedRegion) return; surface.update({originalPartUrl:partUrl(selectedAssetId,asset().revisions[0].id,selectedRegion),currentPartUrl:partUrl(selectedAssetId,selectedRevisionId,selectedRegion)}); }
    animation.addEventListener('change', () => { time = 0; preferredAnimation = animation.value; for (const player of players) player.setAnimation(animation.value); playback.update({duration:players[0]?.animations.find(item => item.name === animation.value)?.duration || 1},playback.root); saveDraft(); });
    skin.addEventListener('change', () => { try { preferredSkin = skin.value; for (const player of players) player.setSkin(skin.value); saveDraft(); } catch (error) { notify(error.message, true); } });
    seek.addEventListener('input', () => { playing = false; playback.update({playing},playback.root); time = Number(seek.value); saveDraft(); });
    function tick(now) {
      if (disposed) return;
      if (playing) time += Math.min((now - (lastTime || now)) / 1000, .1);
      lastTime = now;
      try { for (const player of players) player.draw(time); }
      catch (error) { notify(error.message, true); stopPlayers(); return; }
      const duration = Number(seek.max); playback.update({seekTime:duration?time%duration:0,seconds:(duration?time%duration:time).toFixed(2)},playback.root);
      frame = requestAnimationFrame(tick);
    }
    async function loadPlayers() {
      const token = ++generation; cancelPreview(); stopPlayers(); if (!asset() || !revision()) return;
      const loaded = [];
      try {
        // Sequential acquisition guarantees a failed second preview releases the first.
        loaded.push(await window.FwvSpinePreview(originalCanvas, asset(), asset().revisions[0], {text:playback.text}));
        if (disposed || token !== generation) { loaded.forEach(player => player.dispose()); return; }
        loaded.push(await window.FwvSpinePreview(currentCanvas, asset(), revision(), {text:playback.text}));
        if (disposed || token !== generation) { loaded.forEach(player => player.dispose()); return; }
        players = loaded; surface.update({previewStatus:t('text13'),previewError:false});playback.update({canPlay:true,canAnimate:players[0].animations.length>0},playback.root);
        options(animation, players[0].animations.map(item => ({ value: item.name, label: item.name })), players[0].animations.some(item => item.name === preferredAnimation) ? preferredAnimation : players[0].animations[0]?.name);
        options(skin, players[0].skins.map(name => ({ value: name, label: name })), players[0].skins.includes(preferredSkin) ? preferredSkin : players[0].initialSkin);
        for (const player of players) { if (animation.value) player.setAnimation(animation.value); if (skin.value) player.setSkin(skin.value); }
        playback.update({duration:players[0].animations.find(item => item.name === animation.value)?.duration || 1},playback.root); lastTime = 0; playback.update({playing},playback.root); frame = requestAnimationFrame(tick); schedulePreview(0);
      } catch (error) { loaded.forEach(player => player.dispose()); if (!disposed && token === generation) { surface.update({previewStatus:t('text16')+error.message,previewError:true}); schedulePreview(0); } }
    }
    async function reload(previews = true, { restoreDraft = false, restorePart = false } = {}) {
      if (disposed) return;
      snapshot = await ctx.api('/api/fwv/snapshot');
      if (disposed) return;
      const assets = snapshot.assets.filter(item => item.kind === 'spine');
      if (!assets.some(item => item.id === selectedAssetId)) selectedAssetId = assets[0]?.id;
      const draft = restoreDraft && selectedAssetId ? ctx.drafts.get('spineDrafts', selectedAssetId) : null;
      if (restoreDraft) {
        if (draft?.revisionId && !(ctx.selection?.assetId === selectedAssetId && ctx.selection?.revisionId)) selectedRevisionId = draft.revisionId;
        selectedRegion = draft?.regionName;
        partDrafts = structuredClone(draft?.partDrafts || []);
        // Upgrade the one-part legacy draft without attaching it to another revision/region.
        if (draft?.revisionId && draft?.regionName && !partDrafts.some(item => item.revisionId === draft.revisionId && item.regionName === draft.regionName)) {
          partDrafts.push(Object.fromEntries(['revisionId','regionName','libraryImageId','replacementAssetId','replacementRevisionId','replacementFileName','transform'].filter(key => draft[key] !== undefined).map(key => [key,draft[key]])));
        }
        preferredAnimation = draft?.animation || ''; preferredSkin = draft?.skin || ''; playing = draft?.playing ?? true; time = Number.isFinite(draft?.time) ? draft.time : 0;
      }
      const images = snapshot.assets.filter(item => item.kind === 'image'), previousImage = draft?.libraryImageId || librarySelect.value;
      options(librarySelect, [{ value: '', label: t(images.length ? 'chooseLibrary' : 'text19') }, ...images.map(item => ({ value: item.id, label: item.name }))], images.some(item => item.id === previousImage) ? previousImage : '');
      if (!asset()?.revisions.some(item => item.id === selectedRevisionId)) selectedRevisionId = asset()?.selectedRevisionId;
      options(assetSelect, assets.length ? assets.map(item => ({ value: item.id, label: item.name })) : [{ value: '', label: t('text20') }], selectedAssetId);
      options(revisionSelect, asset()?.revisions.map((item, index) => ({ value: item.id, label: index === 0 ? t('text21') : t('text22') + (index + 1) })) || [], selectedRevisionId);
      const info = revision()?.metadata.spine;
      if (!info?.regions.some(item => item.name === selectedRegion)) selectedRegion = info?.regions[0]?.name;
      if (restoreDraft || restorePart) await restorePartDraft();
      if (disposed) return;
      options(partSelect, info?.regions.map(item => ({ value: item.name, label: item.name })) || [], selectedRegion);
      surface.update({summary:info ? t('resourceSummary',{version:info.version,bones:info.bones.length,slots:info.slots.length,animations:info.animations.length}) : t('text26')});
      surface.update({hasAsset:Boolean(asset()),hasReplacement:Boolean(replacement),issues:(info?.issues || []).map(item => item.code === 'TRIM_CLIPPED' ? t('text27') : item.message).join(' ')});
      ctx.setSelection({ assetId: selectedAssetId || '', revisionId: selectedRevisionId || '' }); updateParts(); if (previews) await loadPlayers(); else if (replacement) schedulePreview();
    }
    reload(true, { restoreDraft: true }).catch(error => notify(error.message, true));
    return () => { disposed = true; generation++; draftGeneration++; cancelPreview(); stopPlayers(); playback.dispose(); surface.dispose(); root.remove(); };
  } });
})();
