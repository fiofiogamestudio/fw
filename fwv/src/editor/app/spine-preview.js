(function () {
  let runtime;
  function loadRuntime(t) {
    if (!runtime) runtime = new Promise((resolve, reject) => {
      if (window.spine) { resolve(window.spine); return; }
      const script = document.createElement('script');
      script.src = '/api/fwv/spine-runtime';
      script.onload = () => window.spine ? resolve(window.spine) : reject(new Error(t('runtime1')));
      script.onerror = () => { runtime = null; reject(new Error(t('runtime2'))); };
      document.head.append(script);
    });
    return runtime;
  }
  function artifactUrl(assetId, revisionId, fileName) {
    return '/api/fwv/artifact?' + new URLSearchParams({ assetId, revisionId, fileName });
  }
  async function readText(url, t) {
    const response = await fetch(url, { headers: window.fwe?.session?.headers?.() || {} });
    if (!response.ok) throw new Error(t('runtime3') + response.status);
    return response.text();
  }
  function image(url, t) { return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error(t('runtime4'))); img.src = url; }); }

  // Uses the unmodified matching official runtime, not an approximation of Spine timelines.
  window.FwvSpinePreview = async function (canvas, asset, revision, options = {}) {
    const t=options.text; if(typeof t!=='function')throw new Error('PREVIEW_TEXT_PROVIDER_REQUIRED');
    const s = await loadRuntime(t);
    const json = revision.files.find(file => file.name === revision.metadata?.spine?.jsonFile) || revision.files.find(file => file.role === 'skeleton');
    const atlasFile = revision.files.find(file => file.name === revision.metadata?.spine?.atlasFile) || revision.files.find(file => file.role === 'atlas');
    if (!json || !atlasFile) throw new Error(t('runtime5'));
    const [jsonText, atlasText] = await Promise.all([readText(artifactUrl(asset.id, revision.id, json.name), t), readText(artifactUrl(asset.id, revision.id, atlasFile.name), t)]);
    const atlas = new s.TextureAtlas(atlasText);
    let context, renderer, disposed = false, textureGeneration = 0;
    const baseTextures = new Map();
    try {
      context = new s.ManagedWebGLRenderingContext(canvas, { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
      renderer = new s.SceneRenderer(canvas, context);
      for (const page of atlas.pages) {
        const img = await image(artifactUrl(asset.id, revision.id, page.name), t);
        page.setTexture(new s.GLTexture(context, img));
        baseTextures.set(page.name, page.texture);
      }
      const data = new s.SkeletonJson(new s.AtlasAttachmentLoader(atlas)).readSkeletonData(JSON.parse(jsonText));
      const skeleton = new s.Skeleton(data);
      const initialSkin = data.defaultSkin || data.skins[0];
      if (initialSkin) skeleton.setSkin(initialSkin);
      skeleton.setToSetupPose();
      skeleton.updateWorldTransform(s.Physics.update);
      const state = new s.AnimationState(new s.AnimationStateData(data));
      const bounds = skeleton.getBoundsRect();
      let centerX = Number.isFinite(bounds.x) ? bounds.x + bounds.width / 2 : 0;
      let centerY = Number.isFinite(bounds.y) ? bounds.y + bounds.height / 2 : 0;
      let frameWidth = Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width * 1.55 : 200;
      let frameHeight = Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height * 1.55 : 200;
      const pma = atlas.pages[0]?.pma || false;
      if (atlas.pages.some(page => page.pma !== pma)) throw new Error(t('runtime6'));
      let animation = data.animations[0]?.name || '';
      if (animation) state.setAnimation(0, animation, true);
      let elapsed = 0;
      let debug = { bones: false, mesh: false, selectedBone: '' };
      function draw(time) {
        if (disposed) return;
        elapsed = time;
        skeleton.setToSetupPose();
        const entry = state.getCurrent(0);
        if (entry) entry.trackTime = time;
        state.apply(skeleton);
        skeleton.updateWorldTransform(s.Physics.reset);
        const ratio = Math.max(0.1, canvas.clientWidth / Math.max(1, canvas.clientHeight));
        const width = Math.max(frameWidth, frameHeight * ratio), height = width / ratio;
        renderer.camera.position.set(centerX, centerY, 0);
        renderer.camera.viewportWidth = width;
        renderer.camera.viewportHeight = height;
        renderer.resize(s.ResizeMode.Fit);
        context.gl.clearColor(0, 0, 0, 0);
        context.gl.clear(context.gl.COLOR_BUFFER_BIT);
        renderer.begin(); renderer.drawSkeleton(skeleton, pma);
        if (debug.bones || debug.mesh) {
          renderer.skeletonDebugRenderer.drawBones = debug.bones;
          renderer.skeletonDebugRenderer.drawMeshHull = debug.mesh;
          renderer.skeletonDebugRenderer.drawMeshTriangles = debug.mesh;
          renderer.skeletonDebugRenderer.drawRegionAttachments = false;
          renderer.skeletonDebugRenderer.drawPaths = false;
          renderer.drawSkeletonDebug(skeleton, pma);
          const bone = debug.selectedBone && skeleton.findBone(debug.selectedBone);
          if (bone) {
            const color = new s.Color(1, 0.25, 0.5, 1), radius = Math.max(1, width / Math.max(1, canvas.width) * 5);
            renderer.line(bone.worldX, bone.worldY, bone.worldX + bone.data.length * bone.a, bone.worldY + bone.data.length * bone.c, color);
            renderer.circle(true, bone.worldX, bone.worldY, radius, color);
          }
        }
        renderer.end();
        canvas.dataset.rendered = 'true';
        canvas.dataset.time = time.toFixed(3);
        canvas.dataset.frame = JSON.stringify({ centerX, centerY, width, height });
      }
      draw(0);
      return {
        animations: data.animations.map(item => ({ name: item.name, duration: item.duration })),
        draw,
        setAnimation(name) { animation = name; state.clearTracks(); if (name) state.setAnimation(0, name, true); draw(0); },
        setSkin(name) { skeleton.setSkinByName(name); draw(elapsed); },
        getFrame() { return { centerX, centerY, width: frameWidth, height: frameHeight }; },
        setFrame(frame) {
          if (!frame || ![frame.centerX, frame.centerY, frame.width, frame.height].every(Number.isFinite) || frame.width <= 0 || frame.height <= 0) throw new Error('INVALID_SPINE_PREVIEW_FRAME');
          centerX = frame.centerX; centerY = frame.centerY; frameWidth = frame.width; frameHeight = frame.height; draw(elapsed);
        },
        setDebug(value = {}) { debug = { ...debug, ...value }; draw(elapsed); },
        skins: data.skins.map(item => item.name),
        initialSkin: initialSkin?.name || '',
        // Swap only texture pixels; skeleton, bindings, animation and camera remain unchanged.
        async setPageOverrides(overrides = {}, isCurrent = () => true) {
          const token = ++textureGeneration, loaded = [];
          try {
            for (const page of atlas.pages) if (overrides[page.name]) {
              const img = await image(overrides[page.name], t);
              if (disposed || token !== textureGeneration || !isCurrent()) { loaded.forEach(item => item.texture.dispose()); return false; }
              loaded.push({ page, texture: new s.GLTexture(context, img) });
            }
            if (disposed || token !== textureGeneration || !isCurrent()) { loaded.forEach(item => item.texture.dispose()); return false; }
            for (const page of atlas.pages) {
              const previous = page.texture;
              page.setTexture(loaded.find(item => item.page === page)?.texture || baseTextures.get(page.name));
              if (previous !== baseTextures.get(page.name)) previous.dispose();
            }
            draw(elapsed); return true;
          } catch (error) { loaded.forEach(item => item.texture.dispose()); throw error; }
        },
        dispose() { if (disposed) return; disposed = true; textureGeneration++;
          for (const page of atlas.pages) if (page.texture !== baseTextures.get(page.name)) baseTextures.get(page.name).dispose();
          atlas.dispose(); renderer.dispose(); context.dispose(); },
      };
    } catch (error) {
      atlas.dispose(); renderer?.dispose(); context?.dispose(); throw error;
    }
  };
})();
