(function () {
  let modules;
  const dependencies = () => modules ||= Promise.all(['three', 'loader', 'orbit'].map(name => import('/api/fwv/model-runtime?module=' + name)));
  function artifact(source) {
    const file = source.files.find(file => file.role === 'model'); if (!file) throw new Error('模型文件缺失。');
    return '/api/fwv/artifact?' + new URLSearchParams({ assetId: source.assetId, revisionId: source.revisionId, fileName: file.name });
  }
  window.FwvModelPreview = { async create(canvases, sources, { signal, onTime = () => {} } = {}) {
    const [T, { GLTFLoader }, { OrbitControls }] = await dependencies(); signal?.throwIfAborted();
    const players = []; let frame = 0, disposed = false, playing = false, time = 0, animation = -1, syncing = false;
    function release(player) {
      player.controls?.dispose(); player.mixer?.stopAllAction(); if (player.gltf) player.mixer?.uncacheRoot(player.gltf.scene);
      const geometries = new Set(), materials = new Set(), textures = new Set();
      player.scene?.traverse(object => { if (object.geometry) geometries.add(object.geometry); for (const material of [].concat(object.material || [])) { materials.add(material); for (const value of Object.values(material)) if (value?.isTexture) textures.add(value); } });
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => { t.source?.data?.close?.(); t.dispose(); });
      // The same configured canvases host the next exact revision. Keep their
      // contexts alive while releasing all GPU objects owned by this player.
      player.renderer?.dispose();
    }
    const dispose = () => { if (disposed) return; disposed = true; cancelAnimationFrame(frame); players.forEach(release); };
    signal?.addEventListener('abort', dispose, { once: true });
    try {
      canvases.forEach(canvas => { delete canvas.dataset.ready; });
      for (let i = 0; i < sources.length; i++) {
        const response = await fetch(artifact(sources[i]), { signal, headers: window.fwe.session.headers() });
        if (!response.ok) throw new Error('无法读取确切模型文件。');
        const bytes = await response.arrayBuffer(); signal?.throwIfAborted();
        const gltf = await new GLTFLoader().parseAsync(bytes, '');
        const player = { gltf, scene: new T.Scene() }; players.push(player);
        player.scene.add(gltf.scene); if (disposed) { release(player); signal?.throwIfAborted(); throw new Error('预览已关闭。'); }
        player.renderer = new T.WebGLRenderer({ canvas: canvases[i], antialias: true, alpha: false, preserveDrawingBuffer: true });
        player.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); player.renderer.setClearColor(0x17212b); player.renderer.outputColorSpace = T.SRGBColorSpace;
        player.camera = new T.PerspectiveCamera(38, 1, .01, 10000); player.controls = new OrbitControls(player.camera, canvases[i]); player.controls.enableDamping = false;
        player.scene.add(new T.HemisphereLight(0xffffff, 0x596878, 2)); const light = new T.DirectionalLight(0xffffff, 2.5); light.position.set(3, 5, 5); player.scene.add(light);
        player.helper = new T.SkeletonHelper(gltf.scene); player.helper.material.depthTest = false; player.helper.renderOrder = 10; player.helper.visible = false; player.scene.add(player.helper);
        player.mixer = new T.AnimationMixer(gltf.scene);
        player.controls.addEventListener('change', () => {
          if (syncing || disposed) return; syncing = true;
          for (const other of players) if (other !== player && other.controls) { other.camera.position.copy(player.camera.position); other.camera.quaternion.copy(player.camera.quaternion); other.controls.target.copy(player.controls.target); other.controls.update(); }
          syncing = false;
        });
      }
      players.forEach(p => p.gltf.scene.updateMatrixWorld(true));
      const bounds = new T.Box3().setFromObject(players[0].gltf.scene);
      if (bounds.isEmpty()) throw new Error('模型没有可显示的几何体。');
      const center = bounds.getCenter(new T.Vector3()), size = Math.max(...bounds.getSize(new T.Vector3()).toArray(), .01), distance = size * 2.6;
      for (const player of players) { player.camera.near = Math.max(size / 1000, .00001); player.camera.far = size * 1000; player.camera.position.set(center.x + size * .35, center.y + size * .1, center.z + distance); player.controls.target.copy(center); player.controls.update(); }
      function applyTime() { for (const player of players) player.mixer.setTime(time); onTime(time); }
      let previous = performance.now(), lastNotice = 0;
      function draw(timestamp) {
        if (disposed) return;
        const delta = Math.min((timestamp - previous) / 1000, .1); previous = timestamp;
        if (playing && animation >= 0) { const duration = Math.max(...players.map(p => p.activeClip?.duration || 0), .001); time = (time + delta) % duration; for (const p of players) p.mixer.setTime(time); if (timestamp - lastNotice > 100) { onTime(time); lastNotice = timestamp; } }
        for (let i = 0; i < players.length; i++) { const p = players[i], rect = canvases[i].getBoundingClientRect(), width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
          if (p.width !== width || p.height !== height) { p.width = width; p.height = height; p.renderer.setSize(width, height, false); p.camera.aspect = width / height; p.camera.updateProjectionMatrix(); }
          p.renderer.render(p.scene, p.camera); canvases[i].dataset.ready = 'true';
        }
        frame = requestAnimationFrame(draw);
      }
      frame = requestAnimationFrame(draw);
      return { dispose() { signal?.removeEventListener('abort', dispose); dispose(); },
        animation(index) {
          playing = false; animation = -1; time = 0; players.forEach(p => p.mixer.stopAllAction());
          if (index < 0) { applyTime(); return; }
          const sourceClip = players[0].gltf.animations[index];
          if (!sourceClip) throw new Error('原模型没有所选动作。');
          const clips = players.map(p => p.gltf.animations.filter(clip => clip.name === sourceClip.name));
          if (clips.some(matches => matches.length !== 1)) throw new Error('修改后的模型缺少可唯一匹配的动作“' + sourceClip.name + '”，已停止动作对比。');
          animation = index; players.forEach((p, i) => { p.activeClip = clips[i][0]; p.mixer.clipAction(p.activeClip).play(); }); applyTime();
        },
        play(value) { playing = Boolean(value); }, seek(value) { playing = false; time = Math.max(0, Number(value) || 0); applyTime(); },
        skeleton(value) { players.forEach(p => { p.helper.visible = Boolean(value); }); },
        wireframe(value) { players.forEach(p => p.gltf.scene.traverse(o => { for (const material of [].concat(o.material || [])) material.wireframe = Boolean(value); })); },
        setView(value) { if (![value?.camera, value?.target].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) return;
          syncing = true; for (const p of players) { p.camera.position.fromArray(value.camera); p.controls.target.fromArray(value.target); p.controls.update(); } syncing = false; },
        conditions() { return { animation, time, camera: players[0].camera.position.toArray(), target: players[0].controls.target.toArray() }; },
      };
    } catch (error) { dispose(); signal?.removeEventListener('abort', dispose); throw error; }
  } };
}());
