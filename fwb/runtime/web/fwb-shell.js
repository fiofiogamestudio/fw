(function () {
  'use strict';
  const words = {
    en: { retry: 'Retry loading', network: 'The game could not be downloaded. Check your connection and try again.', timeout: 'Loading took too long. Check your connection and try again.', unsupported: 'This browser does not support the features required by this game.', engine: 'The game could not start. Reload to try again.', loading: 'Loading game' },
    'zh-CN': { retry: '重新加载', network: '游戏资源下载失败，请检查网络后重试。', timeout: '游戏加载超时，请检查网络后重试。', unsupported: '当前浏览器缺少运行游戏所需的功能。', engine: '游戏启动失败，请重新加载。', loading: '正在加载游戏' },
  };
  let dispose = null;
  function classifyError(error) {
    if (['unsupported', 'network', 'timeout'].includes(error?.code)) return error.code;
    if (/fetch|network|download|http|load.*(?:wasm|pck)|failed to load/i.test(String(error?.message ?? error))) return 'network';
    return 'engine';
  }
  function attachViewport(options = {}) {
    const screen = document.getElementById('game-screen');
    const canvas = document.getElementById('canvas');
    const safe = document.getElementById('safe-viewport');
    if (!screen || !canvas || !safe) throw new Error('FWB shell elements are missing.');
    screen.style.maxWidth = options.maxWidth > 0 ? `${options.maxWidth}px` : 'none';
    screen.setAttribute('aria-label', options.label || 'Game');
    safe.style.inset = options.safeArea === false ? '0px' : '';
    document.body.style.backgroundColor = options.background || '#080b0b';
    document.documentElement.lang = options.locale || 'en';
    let pending = null;
    let disposed = false;
    function fit() {
      pending = null;
      if (disposed) return;
      const bounds = screen.getBoundingClientRect();
      const ratio = Math.min(options.maxDevicePixelRatio || 3, Math.max(1, window.devicePixelRatio || 1));
      const width = Math.max(1, Math.floor(bounds.width * ratio));
      const height = Math.max(1, Math.floor(bounds.height * ratio));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    }
    function schedule() { if (pending === null && !disposed) pending = requestAnimationFrame(fit); }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(screen);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    // Monitor changes in device scale, including moving a desktop window between monitors.
    let resolution;
    function watchRatio() {
      resolution?.removeEventListener?.('change', ratioChanged);
      resolution = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      resolution?.addEventListener?.('change', ratioChanged);
    }
    function ratioChanged() { schedule(); watchRatio(); }
    watchRatio();
    fit();
    return () => {
      disposed = true;
      if (pending !== null) cancelAnimationFrame(pending);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      resolution?.removeEventListener?.('change', ratioChanged);
    };
  }
  function boot({ config, threads = false, engineUrl, options = {}, Engine: providedEngine } = {}) {
    dispose?.();
    const cleanupViewport = attachViewport(options);
    const status = document.getElementById('status');
    const progress = document.getElementById('status-progress');
    const notice = document.getElementById('status-notice');
    const retry = document.getElementById('status-retry');
    const strings = words[options.locale] || words.en;
    progress.setAttribute('aria-label', strings.loading);
    retry.textContent = strings.retry;
    status.hidden = false; progress.hidden = false; notice.hidden = true; retry.hidden = true;
    progress.removeAttribute('value'); progress.removeAttribute('max');
    let settled = false;
    let script = null;
    let timer;
    const reload = () => window.location.reload();
    retry.addEventListener('click', reload);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error) { status.hidden = true; return; }
      const kind = classifyError(error);
      progress.hidden = true; notice.hidden = false;
      notice.textContent = strings[kind];
      notice.dataset.reason = kind;
      retry.hidden = kind === 'unsupported';
      console.error('[FWB shell]', kind, error);
    }
    function start(EngineClass) {
      if (settled) return;
      try {
        const missing = EngineClass.getMissingFeatures({ threads });
        if (missing.length) { finish({ code: 'unsupported', message: missing.join(', ') }); return; }
        const engine = new EngineClass(config);
        Promise.resolve(engine.startGame({ onProgress(current, total) {
          if (settled) return;
          if (Number.isFinite(current) && Number.isFinite(total) && total > 0 && current >= 0) { progress.max = total; progress.value = Math.min(current, total); }
          else { progress.removeAttribute('value'); progress.removeAttribute('max'); }
        } })).then(() => finish(), finish);
      } catch (error) { finish(error); }
    }
    timer = setTimeout(() => finish({ code: 'timeout' }), (options.startupTimeoutSeconds || 120) * 1000);
    if (providedEngine || window.Engine) start(providedEngine || window.Engine);
    else {
      script = document.createElement('script');
      script.src = engineUrl;
      script.onload = () => typeof window.Engine === 'function' ? start(window.Engine) : finish({ code: 'engine' });
      script.onerror = () => finish({ code: 'network' });
      document.body.append(script);
    }
    // Retry reloads the document: an abandoned WASM instance must not compete with a second one.
    dispose = () => { settled = true; clearTimeout(timer); cleanupViewport(); retry.removeEventListener('click', reload); if (script) { script.onload = null; script.onerror = null; script.remove(); } };
    return { dispose, classifyError };
  }
  window.FWBShell = Object.freeze({ boot, attachViewport, classifyError });
}());
