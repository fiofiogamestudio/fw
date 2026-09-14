/* FWB thin bridge. Official API: https://developers.poki.com/guide/sdk-html5
 * No SDK polyfill or successful-ad mock is installed when Poki is unavailable.
 */
(function installFWBPoki(root) {
  'use strict';
  let listener;
  let sdk;
  let ready = false;
  let pending = false;
  let initialized;
  const emit = (event) => { if (listener) listener(JSON.stringify(event)); };
  const message = (error) => String(error?.message || error || 'SDK error');
  const deadline = (promise, milliseconds) => new Promise((resolve, reject) => {
    const timer = root.setTimeout(() => reject(new Error('SDK timeout')), milliseconds);
    Promise.resolve(promise).then(
      value => { root.clearTimeout(timer); resolve(value); },
      error => { root.clearTimeout(timer); reject(error); },
    );
  });
  root.FWBPoki = {
    initialize(callback) {
      listener = callback;
      if (!initialized) initialized = Promise.resolve().then(async () => {
        sdk = root.PokiSDK;
        if (!sdk || typeof sdk.init !== 'function') {
          return { type: 'init', status: 'unavailable', message: 'Poki SDK 未加载，游戏可继续' };
        }
        try {
          await deadline(sdk.init(), 10000);
          ready = true;
          return { type: 'init', status: 'ready', message: 'Poki SDK 已初始化，广告仍需实际验收',
            rewarded_ads: typeof sdk.rewardedBreak === 'function', commercial_ads: typeof sdk.commercialBreak === 'function' };
        } catch (error) {
          return { type: 'init', status: 'error', message: message(error) };
        }
      });
      initialized.then(emit);
    },
    event(name) {
      if (!ready || !['gameLoadingFinished', 'gameplayStart', 'gameplayStop'].includes(name)) return;
      try {
        if (typeof sdk[name] === 'function') sdk[name]();
        else emit({ type: 'error', event: name, message: 'SDK method unavailable' });
      } catch (error) { emit({ type: 'error', event: name, message: message(error) }); }
    },
    requestAd(kind, requestId) {
      // Defer even early failures so Godot can await its signal before delivery.
      Promise.resolve().then(async () => {
        const base = { type: 'ad', kind, request_id: String(requestId), simulated: false, reward_eligible: false };
        const method = kind === 'rewarded' ? 'rewardedBreak' : kind === 'commercial' ? 'commercialBreak' : null;
        if (!ready || !method || typeof sdk[method] !== 'function') {
          emit({ ...base, status: 'unavailable', message: 'SDK capability unavailable' });
          return;
        }
        if (pending) {
          emit({ ...base, status: 'error', message: 'busy' });
          return;
        }
        pending = true;
        let sdkRequestStarted = false;
        try {
          const sdkRequest = Promise.resolve(sdk[method](() => emit({ type: 'ad_started', kind, request_id: String(requestId) })));
          sdkRequestStarted = true;
          // Timeout cannot cancel the SDK itself. Keep its lock until settlement
          // so a retry cannot display a second ad over an outstanding first one.
          sdkRequest.then(() => { pending = false; }, () => { pending = false; });
          const reward = await deadline(sdkRequest, 120000);
          if (kind === 'rewarded') {
            emit({ ...base, status: reward === true ? 'success' : 'cancelled', reward_eligible: reward === true,
              message: reward === true ? 'SDK confirmed reward' : 'SDK returned no reward' });
          } else {
            // A resolved commercial break does not confirm an ad was displayed.
            emit({ ...base, status: 'success', message: 'Break completed; ad display is not guaranteed' });
          }
        } catch (error) {
          if (!sdkRequestStarted) pending = false;
          emit({ ...base, status: 'error', message: message(error) });
        }
      });
    },
  };
  root.document?.addEventListener('visibilitychange', () => emit({
    type: 'lifecycle', event: root.document.hidden ? 'background' : 'foreground',
  }));
})(globalThis);
