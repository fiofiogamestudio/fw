# Browser shell and media

FWB supplies an opt-in Godot Web shell for `web`, `poki` and `taptap-h5`. It does not replace a project's custom shell unless enabled. It is independent of the optional Godot runtime addon and contains no game paths, rules, credentials or SDK success simulation.

```json
{
  "webShell": {
    "enabled": true,
    "maxWidth": 540,
    "maxDevicePixelRatio": 3,
    "safeArea": true,
    "background": "#080b0b",
    "label": "Game title",
    "locale": "zh-CN",
    "startupTimeoutSeconds": 120
  },
  "targets": {
    "poki": { "webShell": { "maxWidth": 0 } }
  }
}
```

`targets.<id>.webShell` overrides individual global options. Omitted configuration defaults to disabled; `maxWidth: 0` removes the width cap. The permitted width range is 0–8192 CSS pixels, DPR cap 1–4, timeout 10–600 seconds, locale `en` or `zh-CN`, and background a three- or six-digit hexadecimal CSS color. Other target families ignore the global shell and cannot explicitly enable one.

`src/core/web-shell.mjs` exposes `validateWebShell(config)`, `resolveWebShell(config,target)`, `prepareWebShell({project,stage,target})` and `copyWebShellOutput({project,stage,out,target})`. Preparation writes the template and JavaScript into `stage/addons/fwb_web/` and returns the shell path, canvas policy 0, options and hashes. The actual build copies JavaScript from this frozen stage into the export root. An omitted `stage` in the copy helper is only for standalone tooling. Host and generated `_fw` sources are untouched.

The shell applies CSS safe-area insets once and sizes the canvas backing store from its actual displayed rectangle, with a bounded device pixel ratio. ResizeObserver, window resize, visual viewport events and device-scale changes refresh that size. This does not promise an orientation lock or soft-keyboard avoidance on every WebView. Hosts should not apply a second safe-area inset to the same viewport.

The startup overlay reports download progress, distinguishes missing browser features, download failure, timeout and engine startup failure, and offers a full-document reload for recoverable failures. It never starts a second WASM instance as an in-page retry. Engine startup completion hides this overlay; the host remains responsible for reporting platform `loading_complete()` when its gameplay is actually ready. No service-worker or shared-memory recovery is attempted: FWB browser exports use the single-threaded non-PWA path.

## Media interface

`window.FWBMedia` is a singleton presentation backend:

```js
const id = FWBMedia.playSequence([
  { sources: [
    { src: 'films/arrival.webm', type: 'video/webm; codecs="vp8"' },
    { src: 'films/arrival.mp4', type: 'video/mp4' }
  ] },
  'films/next.mp4'
], (status, detail) => {
  // status: ready | blocked | playing | ended | error | cancelled
}, {
  containerId: 'game-screen', canvasId: 'canvas',
  rect: [0, 0, 1, 1], timeoutMs: 15000,
  label: 'Transition', retryLabel: 'Tap to play',
  muted: true, blockInput: true, holdLastFrame: true
});
```

Sequences also accept JSON text for Godot JavaScriptBridge callers. `play(source,callback,options)` plays one string source or `{src,type}` source. URLs resolve against the document URL and must use HTTP(S) or blob without embedded credentials. The host supplies its own allowed content paths and ordered encoding candidates; `type` is descriptive metadata, and actual decoder success decides fallback. The backend does not invent `.webm`/`.mp4` variants, download files at build time, or select story branches.

There are at most two video decoders. The previous final frame remains visible until the next decoder submits a frame, then the covered decoder is recycled. `requestVideoFrameCallback` is preferred; browsers lacking it fall back to `loadeddata` readiness. `getProgress()` is a read-only `clip index + media-time fraction`, held at the previous endpoint during buffering. It does not advance from elapsed wall time. `setRect(left,top,width,height)` updates finite normalized coordinates relative to the container. Videos stay under the transparent canvas (z-index 0 versus canvas 1); the optional input shield is at 50. The backend never changes canvas opacity.

`ready` is emitted once after the first decoded frame becomes visible. `NotAllowedError` produces the intermediate `blocked` state and a visible retry button; the watchdog is suspended while awaiting a user gesture. `retry()` invokes playback synchronously and returns whether a blocked attempt was retried. Successful retry emits `playing`; other playback errors, decoder errors and stalls try the next source before reporting `error`. The watchdog measures lack of decoded/progress activity per candidate, not total movie duration.

Each session has exactly one terminal result (`ended`, `error` or `cancelled`), with `detail.sessionId`, `detail.index` and a reason. All timers, decoder listeners, source generations and late promises are guarded. A new play cancels the old session. `stop()` cancels active playback and releases all media elements/listeners. Hidden documents and `pagehide` cancel with `reason: 'background'`; they never produce successful completion or resume automatically. Other host interruptions such as advertisements must explicitly call `stop()` because disabling Godot processing does not stop a DOM video.

The default `holdLastFrame: false` releases resources immediately on terminal results. With `true`, successful `ended` holds its last frame, final progress and input shield until the host has committed/rendered its destination and calls `stop()`. That cleanup does not emit a second terminal result. Backgrounding also releases an already held frame. Failed/cancelled sessions always release immediately. Hosts must decide whether failure means retry, a still-image alternative, or an explicit player-controlled skip; it is never a successful film completion.

## Validation boundary

`node --test test/web-shell.test.mjs test/web-media.test.mjs` exercises state transitions with a deterministic DOM/media boundary, including candidate failures, stale callbacks/timers, gesture retry, background cancellation, final-frame hold, viewport sizing and startup failures. It does not prove real codecs, GPU compositing, autoplay policy, touch behavior, TapTap WebView behavior or platform acceptance. Those require running the exported package in browsers and target devices.
