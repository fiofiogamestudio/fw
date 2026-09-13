(function () {
  function disposePlayer(player) { try { player?.dispose(); } catch { /* Cleanup must not hide another side's usable preview. */ } }

  /** Stable whole-character comparison. Updating workflow metadata never reloads unchanged revisions. */
  window.FwvReskinPreview = function (host, ctx, options = {}) {
    const compare=options.compare!==false;
    const surface=ctx.createSurface('preview',{data:{prefix:'fwv-reskin-preview',showSkin:false,showSeek:false,compare,paneColumns:compare?2:1},actions:{togglePlay:()=>onPlay()}}),t=surface.text;
    const {animation,play,clock}=surface.refs; const root=surface.render('comparison'),status=root.refs.status,views=root.refs.views;
    root.refs.controls.append(surface.root);host.append(root);
    let disposed = false;
    let frame = 0;
    let lastTime = 0;
    let elapsed = 0;
    let playing = true;
    let selectedAnimation = null;
    let animationNames = [];
    const slots = [];
    function makeCanvas(which) {return surface.render('canvas',{testId:'fwv-reskin-'+which+'-canvas'});}
    for(const {which,label,emptyMessage} of ctx.getUiConfig('preview').comparisonSlots){
      const view=surface.render('pane',{label,emptyMessage,which,compare,testId:'fwv-reskin-'+which+'-canvas'});views.append(view);
      const {name,stage,canvas,placeholder}=view.refs;
      slots.push({which,label,emptyMessage,name,stage,canvas,placeholder,view,key:null,serial:0,player:null,phase:'empty',error:'',pending:Promise.resolve()});
    }

    function players() { return slots.filter(slot => slot.player); }
    function reportStatus() {
      if (disposed) return;
      const errors = slots.filter(slot => slot.phase === 'error');
      const loading = slots.filter(slot => slot.phase === 'loading');
      const count = players().length;
      let message;
      if (errors.length) message = errors.map(slot => `${slot.label}：${slot.error}`).join(' ');
      else if (loading.length) message = t('text1',{v0:(loading.map(slot => slot.label).join(t('nested1'))),v1:(count ? t('nested2') : '')});
      else if (count === 2) message = playing ? t('text2') : t('text3');
      else if (count === 1) message = slots[0].player ? t('text4') : t('text5');
      else message = t('text6');
      surface.update({statusMessage:message,statusError:errors.length>0},root);
      surface.update({canAnimate:count>0&&animationNames.length>0,canPlay:count>0,playing},surface.root);
    }
    function failSlot(slot, error) {
      disposePlayer(slot.player);
      slot.player = null;
      slot.phase = 'error';
      slot.error = error?.message || t('text9');
      surface.update({placeholder:t('text10',{v0:slot.error}),error:true,ready:false},slot.view);
    }
    function drawNow() {
      if (disposed) return;
      let failed = false;
      for (const slot of players()) {
        try { slot.player.draw(elapsed); } catch (error) { failSlot(slot, error); failed = true; }
      }
      surface.update({seconds:elapsed.toFixed(2)},surface.root);
      if (failed) reportStatus();
    }
    function tick(now) {
      frame = 0;
      if (disposed || !players().length) { lastTime = 0; return; }
      if (playing && lastTime) elapsed += Math.max(0, Math.min((now - lastTime) / 1000, 0.1));
      lastTime = now;
      drawNow();
      if (players().length) frame = requestAnimationFrame(tick);
    }
    function ensureClock() {
      if (disposed) return;
      if (players().length) { if (!frame) { lastTime = 0; frame = requestAnimationFrame(tick); } }
      else { cancelAnimationFrame(frame); frame = 0; lastTime = 0; }
    }
    function synchronizeAnimations() {
      const available = players();
      if (!available.length) {
        // No selection has been made until a real player exposes its animations.
        // Keep null distinct from the user's explicit empty-string setup pose.
        animationNames = [];
        surface.setOptions(animation,[{value:'',label:t('waiting')}]);
        animation.value = '';
        reportStatus();
        return;
      }
      const source = slots[0].player || available[0]?.player;
      let names = source?.animations?.map(item => item.name) || [];
      if (available.length > 1) names = names.filter(name => available.every(slot => slot.player.animations.some(item => item.name === name)));
      animationNames = names;
      const previous = selectedAnimation;
      if (selectedAnimation === null || selectedAnimation && !names.includes(selectedAnimation)) selectedAnimation = names[0] || '';
      surface.setOptions(animation,[{value:'',label:t('setup')},...names.map(name=>({value:name,label:name}))]);
      animation.value = selectedAnimation;
      if (previous !== selectedAnimation) {
        elapsed = 0;
        for (const slot of available) {
          try { slot.player.setAnimation(selectedAnimation); } catch (error) { failSlot(slot, error); }
        }
      }
      reportStatus();
    }
    function onAnimationChange() {
      selectedAnimation = animation.value;
      elapsed = 0;
      lastTime = 0;
      for (const slot of players()) {
        try { slot.player.setAnimation(selectedAnimation); } catch (error) { failSlot(slot, error); }
      }
      drawNow(); reportStatus(); ensureClock();
    }
    function onPlay() { playing = !playing; lastTime = 0; reportStatus(); drawNow(); ensureClock(); }
    animation.addEventListener('change', onAnimationChange);

    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => drawNow()) : null;
    resize?.observe(root);

    function resolve(snapshot, target) {
      if (!target) return { key: 'empty', empty: true };
      const identity = `${String(target.assetId || '')}/${String(target.revisionId || '')}`;
      const asset = snapshot?.assets?.find(asset => asset.id === target.assetId && asset.kind === 'spine');
      const revision = asset?.revisions?.find(revision => revision.id === target.revisionId);
      if (!asset || !revision) return { key: `missing:${identity}`, error: t('reskin3') };
      return { key: identity, asset, revision };
    }
    function updateSlot(slot, resolved) {
      if (slot.key === resolved.key) {
        if (resolved.asset) surface.update({name:resolved.asset.name},slot.view);
        return slot.pending;
      }
      slot.key = resolved.key;
      const serial = ++slot.serial;
      disposePlayer(slot.player);
      slot.player = null;
      slot.error = '';
      surface.update({name:resolved.asset?.name||''},slot.view);
      const canvas = makeCanvas(slot.which);
      slot.canvas.replaceWith(canvas);
      slot.canvas = canvas;
      surface.update({ready:false,error:false},slot.view);
      if (resolved.empty) {
        slot.phase = 'empty'; surface.update({placeholder:slot.emptyMessage},slot.view);
        slot.pending = Promise.resolve(); synchronizeAnimations(); ensureClock(); return slot.pending;
      }
      if (resolved.error) {
        failSlot(slot, new Error(resolved.error)); slot.pending = Promise.resolve(); synchronizeAnimations(); ensureClock(); return slot.pending;
      }
      slot.phase = 'loading'; surface.update({placeholder:t('reskin4',{v0:slot.label})},slot.view);
      reportStatus(); ensureClock();
      slot.pending = Promise.resolve().then(async () => {
        if (disposed || serial !== slot.serial) return;
        if (typeof window.FwvSpinePreview !== 'function') throw new Error(t('reskin5'));
        const player = await window.FwvSpinePreview(canvas, resolved.asset, resolved.revision, {text:surface.text});
        if (disposed || serial !== slot.serial) { disposePlayer(player); return; }
        slot.player = player;
        slot.phase = 'ready';
        surface.update({ready:true},slot.view);
        synchronizeAnimations();
        // A late candidate joins the existing shared clock without restarting the template.
        player.setAnimation(selectedAnimation || '');
        player.draw(elapsed);
        ensureClock();
      }).catch(error => {
        if (disposed || serial !== slot.serial) return;
        failSlot(slot, error); synchronizeAnimations(); ensureClock();
      });
      return slot.pending;
    }

    reportStatus();
    return {
      update({ snapshot, template, candidate } = {}) {
        if (disposed) return Promise.resolve();
        const original = resolve(snapshot, template);
        if (slots[0].key !== original.key) { elapsed = 0; selectedAnimation = null; lastTime = 0; }
        return Promise.all([updateSlot(slots[0], original), updateSlot(slots[1], resolve(snapshot, candidate))]).then(() => { reportStatus(); });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        cancelAnimationFrame(frame); frame = 0;
        resize?.disconnect();
        animation.removeEventListener('change', onAnimationChange);
        play.removeEventListener('click', onPlay);
        for (const slot of slots) { slot.serial++; disposePlayer(slot.player); slot.player = null; }
        surface.dispose(); root.remove();
      },
    };
  };
}());
