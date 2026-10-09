/* TapTap H5 provider. The TapTap App supplies globalThis.tap; no SDK is downloaded.
 * Contract: official @taptap/instant-games-open-mcp 1.24.14 (2026-10-08),
 * docs://cloud-save/overview and get_ad_integration_guide. See docs/runtime.md.
 */
(function installFWBTapTap(root) {
  'use strict';
  let listener;
  let sdk;
  let cloud;
  let filesystem;
  let config = {};
  let initialized;
  let adPending = false;
  let cloudPending = false;
  let lastUploadAt = null;
  let ready = false;
  const emit = event => { if (listener) listener(JSON.stringify(event)); };
  const message = error => String(error?.errMsg || error?.message || error || 'TapTap API error');
  const timeoutMs = () => config.requestTimeoutMs || 30000;
  const callbackCall = (target, method, options) => new Promise((resolve, reject) => {
    try {
      // Tap filesystem calls are callback-only; archive calls additionally support Promises.
      const result = target[method]({ ...options, success: resolve, fail: reject });
      if (result && typeof result.then === 'function') result.then(resolve, reject);
    } catch (error) { reject(error); }
  });
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(value);
  const capabilities = () => ({
    rewarded_ads: ready && Boolean(config.taptap?.rewardedAdUnitId) && typeof sdk?.createRewardedVideoAd === 'function',
    commercial_ads: ready && Boolean(config.taptap?.interstitialAdUnitId) && typeof sdk?.createInterstitialAd === 'function',
    cloud_save: ready && config.taptap?.cloudSave === true && Boolean(cloud && filesystem)
      && ['createArchive', 'updateArchive', 'getArchiveList', 'getArchiveData'].every(name => typeof cloud[name] === 'function')
      && ['writeFile', 'readFile', 'unlink'].every(name => typeof filesystem[name] === 'function')
      && typeof sdk?.env?.TEMP_DATA_PATH === 'string',
    login: false,
  });
  const decode = base64 => {
    if (typeof base64 !== 'string' || base64.length > 14 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Invalid or oversized archive bytes');
    const binary = root.atob(base64);
    if (binary.length > 10 * 1024 * 1024) throw new Error('Archive exceeds 10 MiB');
    return Uint8Array.from(binary, char => char.charCodeAt(0)).buffer;
  };
  const encode = data => {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error('Expected archive bytes');
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length > 10 * 1024 * 1024) throw new Error('Archive exceeds 10 MiB');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return root.btoa(binary);
  };
  function metadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['name', 'summary', 'extra', 'playtime'].includes(key))) throw new Error('Invalid archive metadata');
    const length = text => new TextEncoder().encode(text).length;
    if (typeof value.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,60}$/.test(value.name)) throw new Error('Invalid archive name');
    if (typeof value.summary !== 'string' || length(value.summary) > 500) throw new Error('Invalid archive summary');
    if (value.extra !== undefined && (typeof value.extra !== 'string' || length(value.extra) > 1000)) throw new Error('Invalid archive extra');
    if (value.playtime !== undefined && (!Number.isFinite(value.playtime) || value.playtime < 0)) throw new Error('Invalid archive playtime');
    return value;
  }
  function archive(value) {
    // The H5 SDK names and timestamps differ from FWB's provider-neutral fields.
    // Retain the documented source fields for existing callers. Never turn a bad
    // response into an empty list, which could be mistaken for a new account.
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !validId(value.uuid) || !validId(value.fileId)) throw new Error('Invalid archive list entry');
    const text = key => {
      if (value[key] === undefined || value[key] === null) return '';
      if (typeof value[key] !== 'string') throw new Error(`Invalid archive ${key}`);
      return value[key];
    };
    const number = key => {
      if (value[key] === undefined || value[key] === null) return 0;
      if (!Number.isFinite(value[key]) || value[key] < 0) throw new Error(`Invalid archive ${key}`);
      return value[key];
    };
    return { ...value, archive_uuid: value.uuid, file_id: value.fileId,
      name: text('name'), summary: text('summary'), extra: text('extra'), playtime: number('playtime'),
      // Official createdTime and modifiedTime are Unix seconds, not milliseconds.
      created_at: number('createdTime'), updated_at: number('modifiedTime'),
      save_size: number('saveSize'), cover_size: number('coverSize') };
  }
  root.FWBTapTap = {
    initialize(callback, settings = '{}') {
      listener = callback;
      if (!initialized) initialized = Promise.resolve().then(() => {
        try {
          config = JSON.parse(settings);
          sdk = root.tap;
          if (config.taptap?.enabled !== true || config.sdk?.mock === true) return { type: 'init', status: 'unavailable', message: 'TapTap H5 integration is disabled', ...capabilities() };
          if (!sdk) return { type: 'init', status: 'unavailable', message: 'TapTap H5 container is unavailable', ...capabilities() };
          if (config.taptap.cloudSave === true && typeof sdk.getCloudSaveManager === 'function' && typeof sdk.getFileSystemManager === 'function') {
            cloud = sdk.getCloudSaveManager();
            filesystem = sdk.getFileSystemManager();
          }
          ready = true;
          return { type: 'init', status: 'ready', message: 'TapTap container detected; capabilities require platform acceptance', ...capabilities() };
        } catch (error) { return { type: 'init', status: 'error', message: message(error) }; }
      });
      initialized.then(emit);
    },
    // H5 documentation has no equivalents to Poki gameplay reporting. Do not invent them.
    event() {},
    requestAd(kind, requestId) {
      Promise.resolve().then(async () => {
        const base = { type: 'ad', kind, request_id: String(requestId), reward_eligible: false, simulated: false };
        if (!capabilities()[kind === 'rewarded' ? 'rewarded_ads' : kind === 'commercial' ? 'commercial_ads' : 'unsupported']) {
          emit({ ...base, status: 'unavailable', message: 'TapTap ad capability unavailable' }); return;
        }
        if (adPending) { emit({ ...base, status: 'error', message: 'busy' }); return; }
        adPending = true;
        let ad;
        let finished = false;
        let timedOut = false;
        let timer;
        const finish = (status, eligible, error) => {
          if (finished) return;
          finished = true;
          root.clearTimeout(timer);
          adPending = false;
          try { ad?.destroy?.(); } catch (_) { /* Already detached by container. */ }
          if (timedOut) emit({ type: 'ad_settled', request_id: String(requestId) });
          else emit({ ...base, status, reward_eligible: eligible, message: error || '' });
        };
        timer = root.setTimeout(() => {
          if (finished) return;
          timedOut = true;
          // The SDK cannot be cancelled. Retain the lock and interruption until settlement.
          emit({ ...base, status: 'error', message: 'TapTap ad timeout', pending: true });
        }, config.requestTimeoutMs || 120000);
        try {
          const rewarded = kind === 'rewarded';
          ad = sdk[rewarded ? 'createRewardedVideoAd' : 'createInterstitialAd']({ adUnitId: config.taptap[rewarded ? 'rewardedAdUnitId' : 'interstitialAdUnitId'] });
          if (!ad || !['onClose', 'onError', 'load', 'show'].every(name => typeof ad[name] === 'function')) throw new Error('Incomplete TapTap ad instance');
          ad.onClose(result => finish(rewarded && result?.isEnded !== true ? 'cancelled' : 'success', rewarded && result?.isEnded === true));
          ad.onError(error => finish('error', false, message(error)));
          await ad.load();
          if (finished) return;
          if (timedOut) { finish('error', false, 'expired'); return; }
          // A resolved show() is not a reward. Only onClose({isEnded:true}) qualifies.
          emit({ type: 'ad_started', kind, request_id: String(requestId) });
          await ad.show();
        } catch (error) { finish('error', false, message(error)); }
      });
    },
    request(operation, payloadJson, requestId) {
      Promise.resolve().then(async () => {
        const base = { type: 'request', operation, request_id: String(requestId) };
        if (!capabilities().cloud_save) { emit({ ...base, status: 'unavailable' }); return; }
        if (!['cloud_list', 'cloud_write', 'cloud_read'].includes(operation)) { emit({ ...base, status: 'unavailable' }); return; }
        if (cloudPending) { emit({ ...base, status: 'error', message: 'busy' }); return; }
        cloudPending = true;
        let expired = false;
        let tempPath;
        let uploadStarted = false;
        const check = () => { if (expired) throw new Error('request expired'); };
        const timer = root.setTimeout(() => {
          expired = true;
          emit({ ...base, status: 'error', message: 'TapTap request timeout', remote_outcome: uploadStarted ? 'unknown' : 'not_started' });
        }, timeoutMs());
        try {
          const payload = JSON.parse(payloadJson);
          let result;
          if (operation === 'cloud_list') {
            const response = await callbackCall(cloud, 'getArchiveList', {});
            if (!Array.isArray(response?.saves)) throw new Error('Invalid archive list response');
            result = { archives: response.saves.map(archive) };
          } else if (operation === 'cloud_write') {
            const retryAfter = lastUploadAt === null ? 0 : Math.max(0, 60000 - (Date.now() - lastUploadAt));
            if (retryAfter > 0) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited', retry_after_ms: retryAfter });
            const archiveMetaData = metadata(payload.metadata);
            const data = decode(payload.data_base64);
            if (payload.archive_uuid && !validId(payload.archive_uuid)) throw new Error('Invalid archive UUID');
            tempPath = `${sdk.env.TEMP_DATA_PATH}/fwb-${Date.now()}-${String(requestId).replace(/[^a-zA-Z0-9_-]/g, '')}.bin`;
            await callbackCall(filesystem, 'writeFile', { filePath: tempPath, data });
            check();
            uploadStarted = true;
            // Official archive upload quota is once per minute, including unknown outcomes.
            lastUploadAt = Date.now();
            const options = { archiveMetaData, archiveFilePath: tempPath };
            const response = await callbackCall(cloud, payload.archive_uuid ? 'updateArchive' : 'createArchive', payload.archive_uuid ? { ...options, archiveUUID: payload.archive_uuid } : options);
            if (!validId(response?.uuid) || !validId(response?.fileId)) throw new Error('Invalid archive write response');
            result = { archive_uuid: response.uuid, file_id: response.fileId, remote_outcome: 'confirmed' };
          } else {
            if (!validId(payload.archive_uuid) || !validId(payload.file_id)) throw new Error('Invalid archive identity');
            const downloaded = await callbackCall(cloud, 'getArchiveData', { archiveUUID: payload.archive_uuid, archiveFileId: payload.file_id });
            if (typeof downloaded?.filePath !== 'string' || !downloaded.filePath.startsWith(sdk.env.TEMP_DATA_PATH + '/')
              || /[\\\x00-\x1f]/.test(downloaded.filePath)
              || downloaded.filePath.slice(sdk.env.TEMP_DATA_PATH.length + 1).split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('Expected temporary archive download');
            tempPath = downloaded.filePath;
            check();
            const response = await callbackCall(filesystem, 'readFile', { filePath: tempPath });
            result = { data_base64: encode(response?.data) };
          }
          check();
          emit({ ...base, status: 'success', ...result });
        } catch (error) {
          const sdkError = Number.isSafeInteger(error?.errno) ? error.errno : undefined;
          if (!expired) emit({ ...base, status: 'error', message: message(error),
            code: error?.code || (sdkError === 400001 ? 'rate_limited' : sdkError === 400007 ? 'busy' : undefined), sdk_errno: sdkError,
            retry_after_ms: error?.retry_after_ms, remote_outcome: uploadStarted ? 'unknown' : 'not_started' });
        } finally {
          root.clearTimeout(timer);
          cloudPending = false;
          // Temporary transfer bytes are never a second authoritative local save.
          if (tempPath) { try { filesystem.unlink({ filePath: tempPath, fail() {} }); } catch (_) { /* Container owns temp cleanup. */ } }
        }
      });
    },
  };
})(globalThis);
