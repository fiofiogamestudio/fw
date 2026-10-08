(function () {
  'use strict';
  function mount(host, ctx) {
    let reference = ctx.selection;
    const asset = ctx.getSnapshot().assets.find(item => item.id === reference.assetId);
    const variants = ctx.variants?.length ? ctx.variants : [{ state: 'base', file: reference.file, reference }];
    const state = { image: null, zoom: 1, background: 'checker', pan: { x: 0, y: 0 }, drag: null, disposed: false };
    const surface = ctx.createSurface('gallery2d', {
      data: { zoom: state.zoom, background: state.background, variant: reference.file },
      onChange({ path, value }) {
        if (path === 'variant') {
          const selected = variants.find(item => item.file === value);
          if (selected) { reference = selected.reference; state.pan = { x: 0, y: 0 }; void loadImage(); }
          return;
        }
        state[path] = value;
        if (path === 'zoom') state.pan = { x: 0, y: 0 };
        draw();
      },
      actions: {
        resetView: () => { state.zoom = 1; state.pan = { x: 0, y: 0 }; surface.update({ zoom: state.zoom }); draw(); },
        openSkeleton: () => ctx.navigate('skeleton2d', { assetId: reference.assetId, revisionId: reference.revisionId })
      }
    }), r = surface.refs;
    host.append(surface.root); r.canvas.width = 960; r.canvas.height = 600;
    const controller = new AbortController(); let imageController, loadSequence = 0;
    surface.setOptions(r.variant, variants.map(item => ({ value: item.file, label: surface.text('variant-' + item.state) })), reference.file);
    surface.update({ hasVariants: variants.length > 1, variantSummary: surface.text('variants', { count: variants.length - 1 }) });
    surface.update({ skeleton: asset?.kind === 'skeleton2d', notice: surface.text('loading'), revisionLabel: surface.text('revision', { asset: asset?.name || '', revision: reference.revisionId }) });
    const resize = new ResizeObserver(() => {
      if (state.disposed) return;
      const bounds = r.canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
      if (!bounds.width || !bounds.height) return;
      const width = Math.max(1, Math.round(bounds.width * ratio)), height = Math.max(1, Math.round(bounds.height * ratio));
      if (width === r.canvas.width && height === r.canvas.height) return;
      r.canvas.width = width; r.canvas.height = height; state.pan = { x: 0, y: 0 }; draw();
    });
    resize.observe(r.canvas);
    function draw() {
      if (state.disposed) return;
      const canvas = r.canvas, c = canvas.getContext('2d'), width = canvas.width, height = canvas.height;
      c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = state.background === 'dark' ? '#202735' : '#f5f6fa'; c.fillRect(0, 0, width, height);
      if (state.background === 'checker') for (let y = 0; y < height; y += 20) for (let x = 0; x < width; x += 20) {
        c.fillStyle = (Math.floor(x / 20) + Math.floor(y / 20)) % 2 ? '#d9dfe9' : '#f1f4f8'; c.fillRect(x, y, 20, 20);
      }
      const image = state.image;
      if (image) {
        const scale = Math.min(width * 0.9 / image.naturalWidth, height * 0.9 / image.naturalHeight, 2) * state.zoom;
        c.imageSmoothingEnabled = true;
        c.drawImage(image, (width - image.naturalWidth * scale) / 2 + state.pan.x, (height - image.naturalHeight * scale) / 2 + state.pan.y, image.naturalWidth * scale, image.naturalHeight * scale);
      }
      Object.assign(canvas.dataset, { assetId: reference.assetId, revisionId: reference.revisionId, fileName: reference.file, ready: String(Boolean(image)), zoom: String(state.zoom) });
    }
    // Image panning is a canvas gesture; ordinary fields use FWE's typed change
    // and action bindings. Abort releases the gesture listeners with the Form.
    r.canvas.addEventListener('pointerdown', event => { state.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: { ...state.pan } }; r.canvas.setPointerCapture(event.pointerId); }, { signal: controller.signal });
    r.canvas.addEventListener('pointermove', event => {
      if (state.drag?.id !== event.pointerId) return;
      const rect = r.canvas.getBoundingClientRect(); state.pan = { x: state.drag.pan.x + (event.clientX - state.drag.x) * r.canvas.width / rect.width, y: state.drag.pan.y + (event.clientY - state.drag.y) * r.canvas.height / rect.height }; draw();
    }, { signal: controller.signal });
    r.canvas.addEventListener('pointerup', () => { state.drag = null; }, { signal: controller.signal });
    r.canvas.addEventListener('pointercancel', () => { state.drag = null; }, { signal: controller.signal });
    async function loadImage() {
      if (state.disposed) return;
      imageController?.abort(); imageController = new AbortController();
      const sequence = ++loadSequence, selected = reference;
      state.image = null; draw();
      surface.update({ variant: selected.file, notice: surface.text('loading'), previewLabel: '', error: false });
      let objectUrl;
      try {
        const response = await fetch('/api/fwv/image?' + new URLSearchParams(selected), { signal: imageController.signal, headers: window.fwe.session.headers() });
        if (!response.ok) { const error = await response.json(); throw new Error(error.error || surface.text('invalidImage')); }
        const blob = await response.blob(); if (state.disposed || sequence !== loadSequence) return;
        objectUrl = URL.createObjectURL(blob); const image = new Image(); image.src = objectUrl; await image.decode();
        if (state.disposed || sequence !== loadSequence) return;
        state.image = image; draw(); surface.update({ notice: surface.text('loaded'), previewLabel: surface.text('preview', { name: selected.file, width: image.naturalWidth, height: image.naturalHeight, format: blob.type.replace('image/', '').toUpperCase() }) });
      } catch (error) {
        if (!state.disposed && sequence === loadSequence && error.name !== 'AbortError') surface.update({ notice: error.message, error: true });
      } finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
    }
    void loadImage();
    draw();
    return () => { if (state.disposed) return; state.disposed = true; controller.abort(); imageController?.abort(); resize.disconnect(); state.image = null; };
  }
  window.fwe.registerForm('fwv-image-preview', {
    render(context) { return window.createFwv2dForm(context, 'gallery2d', mount); }
  });
}());
