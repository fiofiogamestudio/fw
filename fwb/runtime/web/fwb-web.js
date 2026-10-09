/* Shared browser environment. No SDK, gameplay state or save data is stored here. */
(function installFWBWeb(root) {
  'use strict';
  let listener;
  const emit = payload => { if (listener) listener(JSON.stringify(payload)); };
  const visibility = () => emit({ type: 'environment', reason: 'page_hidden', active: root.document?.hidden === true });
  const lifecycle = (reason, active) => () => emit({ type: 'environment', reason, active });
  root.FWBWeb = {
    initialize(callback) {
      listener = callback;
      // Initial state is delivered after Godot has subscribed; hidden launches must start suspended.
      Promise.resolve().then(visibility);
    },
    storageStatus() {
      return JSON.stringify({ indexed_db_present: typeof root.indexedDB !== 'undefined', durability: 'unknown' });
    },
  };
  root.document?.addEventListener('visibilitychange', visibility);
  root.addEventListener?.('pagehide', lifecycle('page_hidden', true));
  root.addEventListener?.('pageshow', visibility);
  root.document?.addEventListener('freeze', lifecycle('page_frozen', true));
  root.document?.addEventListener('resume', lifecycle('page_frozen', false));
})(globalThis);
