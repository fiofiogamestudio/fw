(function () {
  'use strict';
  const API = '/api/fwv/ui-capture';
  const views = new Map();
  let configuration;
  const numbered = row => `#${String(row.number).padStart(3, '0')} · ${row.title}`;
  const logic = window.fwvUiReview;
  const ordered = context => logic.ordered(context.data.screenshots || []);
  const stateNames = { captured: '已采集', blocked: '待补拍 / 受阻', excluded: '有据排除' };

  async function loadConfiguration() {
    if (!configuration) configuration = fetch(`${API}/ui`, { cache: 'no-store', headers: window.fwe.session.headers() })
      .then(async response => { if (!response.ok) throw new Error('无法读取审阅界面配置。'); return response.json(); })
      .catch(error => { configuration = null; throw error; });
    return configuration;
  }

  function openScreenshot(context, id) {
    return context.navigation.navigate({ domainId: 'fwv-ui-capture', fileName: 'catalog.json', collectionId: 'screenshots', itemId: id, mode: 'review' }, { updateUrl: true });
  }

  // Collection selection, edits, undo and persistence remain owned by FWE.
  // These Forms own only their mounted preview and its asynchronous resources.
  function form(context, kind, mount) {
    const wrapper = window.fwe.ui.createSurface({ root: 'root', templates: { root: { type: 'stack', preset: 'compact', children: [
      { type: 'slot', ref: 'content' },
      { type: 'text', text: { $path: 'notice', default: '正在载入审阅界面…' }, tone: { $path: 'tone', default: 'muted' }, attrs: { role: 'status' } }
    ] } } });
    let disposed = false, release;
    const surfaces = new Set();
    void loadConfiguration().then(config => {
      if (disposed) return;
      const createSurface = options => {
        const surface = window.fwe.ui.createSurface(config[kind], options);
        surfaces.add(surface);
        wrapper.refs.content.append(surface.root);
        return surface;
      };
      release = mount(context, createSurface);
      wrapper.update({ notice: '' });
    }).catch(error => { if (!disposed) wrapper.update({ notice: error.message, tone: 'danger' }); });
    return { element: wrapper.root, dispose() {
      if (disposed) return;
      disposed = true; release?.();
      for (const surface of surfaces) surface.dispose();
      surfaces.clear(); wrapper.dispose();
    } };
  }

  function mountPreview(context, createSurface) {
    const row = context.target;
    const rows = ordered(context), index = rows.findIndex(item => item.id === row.id);
    const view = { mode: 'fit', scale: 1, x: 0, y: 0, ...views.get(row.id) };
    const controller = new AbortController();
    let image = null, metrics = null, disposed = false, drag = null;
    const meta = row.state || {};
    const surface = createSurface({
      data: {
        heading: numbered(row), number: row.number,
        first: index <= 0, last: index === rows.length - 1,
        position: `${index + 1} / ${rows.length} 张 · 编号固定`,
        scaleLabel: '适配', imageUrl: row.imageUrl,
        downloadUrl: `${API}/media?${new URLSearchParams({ id: row.id, download: '1' })}`,
        notice: '正在读取原始 PNG…', error: false,
        checkLabel: { safe: '🟢 安全', risk: '🟡 风险', error: '🔴 错误' }[row.autoCheck?.status] || '🟡 风险',
        checkTone: { safe: 'success', risk: 'warning', error: 'danger' }[row.autoCheck?.status] || 'warning',
        checkSummary: row.autoCheck?.summary || '尚未进行自动检查；此状态不代表安全。',
        basicInfo: [`#${String(row.number).padStart(3, '0')}`, row.category, `${row.width} × ${row.height}`, (meta.capturedAt || context.data.run?.capturedAt || '').replace('T', ' ').replace(/\.\d+(Z|[+-].*)$/, '$1')].filter(Boolean).join(' · '),
        issueCount: `全库问题 ${logic.issues(rows).length} 项 · 已通过的项目不计入`,
        copyNotice: '', copyFallbackVisible: false, copyFallback: ''
      },
      actions: {
        previous: () => navigate(index - 1), next: () => navigate(index + 1),
        go, numberKey: ({ event }) => { if (event.key === 'Enter') { event.preventDefault(); go(); } },
        fit: () => { view.mode = 'fit'; view.x = view.y = 0; draw(); },
        actual: () => { view.mode = 'scale'; view.scale = 1; view.x = view.y = 0; draw(); },
        zoomIn: () => zoom(1.25), zoomOut: () => zoom(0.8),
        copyIssue: () => copyJSON(logic.issue(context.data, row), '已复制当前截图 JSON。'),
        copyAll: () => {
          const problems = logic.issues(context.data.screenshots || []);
          return copyJSON(problems.map(item => logic.issue(context.data, item)), `已复制 ${problems.length} 项问题 JSON。`);
        }
      }
    });
    const canvas = surface.refs.canvas;
    const painter = canvas.getContext('2d');
    if (!painter) throw new Error('浏览器无法创建截图画布。');
    canvas.dataset.screenshotId = row.id;
    canvas.dataset.ready = 'false';
    canvas.style.touchAction = 'none';

    async function copyJSON(value, message) {
      const text = JSON.stringify(value, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        if (!disposed) surface.update({ copyNotice: message, copyFallbackVisible: false, copyFallback: '' });
      } catch {
        if (disposed) return;
        surface.update({ copyNotice: '浏览器未允许写入剪贴板，完整 JSON 已显示在下方。', copyFallbackVisible: true, copyFallback: text });
        surface.refs.copyFallback.focus(); surface.refs.copyFallback.select();
      }
    }

    function navigate(targetIndex) {
      if (disposed || !rows[targetIndex]) return;
      void openScreenshot(context, rows[targetIndex].id);
    }
    function go() {
      const number = Number(surface.refs.number.value);
      const target = rows.find(item => item.number === number);
      if (!target) { surface.update({ notice: `没有编号 ${surface.refs.number.value} 的截图。`, error: true }); return; }
      void openScreenshot(context, target.id);
    }
    function scale() {
      if (view.mode !== 'fit' || !image || !metrics) return view.scale;
      return Math.min((metrics.width - 16) / image.naturalWidth, (metrics.height - 16) / image.naturalHeight, 1);
    }
    function remember() { views.set(row.id, { ...view }); }
    function draw() {
      if (disposed || !metrics || !metrics.width || !metrics.height) return;
      const { width, height, scaleX, scaleY } = metrics;
      painter.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      painter.fillStyle = '#101216'; painter.fillRect(0, 0, width, height);
      if (!image) return;
      const currentScale = scale();
      const w = image.naturalWidth * currentScale, h = image.naturalHeight * currentScale;
      // Keep a visible part of the image within reach during free panning.
      view.x = Math.max(-Math.max(width, w) / 2 + 24, Math.min(Math.max(width, w) / 2 - 24, view.x));
      view.y = Math.max(-Math.max(height, h) / 2 + 24, Math.min(Math.max(height, h) / 2 - 24, view.y));
      painter.imageSmoothingEnabled = currentScale < 1;
      painter.drawImage(image, (width - w) / 2 + view.x, (height - h) / 2 + view.y, w, h);
      const scaleLabel = `${Math.round(currentScale * 100)}%${view.mode === 'fit' ? ' · 适配' : ''}`;
      surface.update({ scaleLabel });
      canvas.dataset.scale = String(currentScale); canvas.dataset.view = view.mode;
      remember();
    }
    function zoom(factor, point) {
      if (!image || !metrics) return;
      const before = scale(), after = Math.max(0.02, Math.min(8, before * factor));
      const x = (point?.x ?? metrics.width / 2) - metrics.width / 2;
      const y = (point?.y ?? metrics.height / 2) - metrics.height / 2;
      view.x = x - (x - view.x) * after / before;
      view.y = y - (y - view.y) * after / before;
      view.mode = 'scale'; view.scale = after; draw();
    }
    function bindPreviewSize() {
      // Use FWE's public logical-height contract; the Form owns no workbench CSS.
      const width = canvas.getBoundingClientRect().width || 800;
      const height = Math.round(Math.max(240, Math.min(560, window.innerHeight - 350, width * row.height / row.width + 16)));
      surface.bindCanvas(canvas, { height, onResize: next => { metrics = next; draw(); } });
    }
    bindPreviewSize();
    window.addEventListener('resize', bindPreviewSize, { signal: controller.signal });
    const listen = (name, handler, options = {}) => canvas.addEventListener(name, handler, { ...options, signal: controller.signal });
    listen('wheel', event => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoom(Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.003), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }, { passive: false });
    listen('pointerdown', event => {
      if (event.button !== 0 || !image) return;
      canvas.focus({ preventScroll: true });
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
      canvas.setPointerCapture(event.pointerId);
    });
    listen('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      view.x = drag.viewX + event.clientX - drag.x; view.y = drag.viewY + event.clientY - drag.y; draw();
    });
    const stopDrag = () => { drag = null; };
    listen('pointerup', stopDrag); listen('pointercancel', stopDrag); listen('lostpointercapture', stopDrag);
    listen('keydown', event => {
      const actions = { ArrowLeft: () => navigate(index - 1), ArrowRight: () => navigate(index + 1), '+': () => zoom(1.25), '=': () => zoom(1.25), '-': () => zoom(0.8), '0': () => { view.mode = 'fit'; view.x = view.y = 0; draw(); } };
      if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
    });
    void (async () => {
      let objectUrl;
      try {
        const response = await fetch(row.imageUrl, { headers: window.fwe.session.headers(), signal: controller.signal });
        if (!response.ok) throw new Error(`原图读取失败（HTTP ${response.status}）。`);
        const blob = await response.blob();
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        const loaded = new Image(); loaded.src = objectUrl; await loaded.decode();
        if (disposed) return;
        image = loaded; draw(); canvas.dataset.ready = 'true';
        const dimensionsMatch = loaded.naturalWidth === row.width && loaded.naturalHeight === row.height;
        surface.update({ notice: dimensionsMatch ? '' : `原图实际为 ${loaded.naturalWidth} × ${loaded.naturalHeight}，与清单尺寸不一致。`, error: !dimensionsMatch });
      } catch (error) {
        if (!disposed && error.name !== 'AbortError') surface.update({ notice: error.message, error: true });
      } finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
    })();
    return () => { disposed = true; remember(); controller.abort(); image = null; };
  }

  function mountCoverage(context, createSurface) {
    const row = context.target;
    const screenshots = (row.screenshotIds || []).map(id => context.data.screenshots.find(item => item.id === id)).filter(Boolean).map(item => ({ ...item, heading: numbered(item) }));
    const coverage = context.data.coverage || [];
    const counts = Object.fromEntries(['captured', 'blocked', 'excluded'].map(status => [status, coverage.filter(item => item.status === status).length]));
    createSurface({ data: {
      ...row, screenshots,
      summary: `全清单 ${coverage.length} 项 · 已采集 ${counts.captured} · 待补拍 / 受阻 ${counts.blocked} · 有据排除 ${counts.excluded}`,
      reason: row.reason || (row.status === 'captured' ? `本状态由 ${screenshots.length} 张已登记截图支撑。` : '清单没有提供原因，请核实采集记录。'),
      evidence: row.evidence || '',
      statusLabel: stateNames[row.status] || row.status,
      statusTone: row.status === 'captured' ? 'success' : row.status === 'blocked' ? 'warning' : 'muted'
    }, actions: { openScreenshot: ({ data }) => openScreenshot(context, data.id) } });
  }

  window.fwe.registerForm('fwv-ui-screenshot', { render: context => form(context, 'preview', mountPreview) });
  window.fwe.registerForm('fwv-ui-decision', { render(context) {
    const row = context.target, status = logic.status(row), rows = ordered(context);
    const pending = rows.filter(item => !logic.resolved(item));
    const surface = window.fwe.ui.createSurface({ root: 'root', templates: { root: { type: 'stack', preset: 'compact', children: [
      { type: 'toolbar', children: [
        { type: 'button', text: status === 'accepted' ? '✓ 通过' : '通过', tone: status === 'accepted' ? 'primary' : 'success', testId: 'review-accept', attrs: { 'aria-pressed': status === 'accepted' }, on: { click: 'accept' } },
        { type: 'button', text: '跳过 →', testId: 'review-skip', attrs: { disabled: pending.length === 0 }, on: { click: 'skip' } },
        { type: 'button', text: status === 'rejected' ? '✓ 不通过' : '不通过', tone: status === 'rejected' ? 'primary' : 'danger', testId: 'review-reject', attrs: { 'aria-pressed': status === 'rejected' }, on: { click: 'reject' } },
        { type: 'badge', text: { accepted: '通过', skipped: '跳过 · 待审阅', rejected: '不通过' }[status], tone: { accepted: 'success', skipped: 'muted', rejected: 'danger' }[status] }
      ] },
      { type: 'text', text: { $path: 'notice' }, tone: 'muted', attrs: { role: 'status' } }
    ] } } }, { data: { notice: pending.length ? `剩余 ${pending.length} 张待审阅；跳过会循环查找下一张。` : '全部截图已通过或不通过。' }, actions: {
      accept: () => context.setValue('accepted'), reject: () => context.setValue('rejected'),
      skip: () => {
        const next = logic.nextPending(context.data.screenshots || [], row.id);
        if (!next) surface.update({ notice: '全部截图已通过或不通过。' });
        else if (next.id === row.id) surface.update({ notice: '只剩当前这张待审阅；请选择通过或不通过。' });
        else void openScreenshot(context, next.id);
      }
    } });
    return { element: surface.root, dispose: () => surface.dispose() };
  } });
  window.fwe.registerForm('fwv-ui-coverage', { render: context => form(context, 'coverage', mountCoverage) });
}());
