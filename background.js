/*
 * Firefox background adapter.
 *
 * The shared playlist/probe pipeline lives in src/background-core.js. Firefox
 * Manifest V3 still supports blocking webRequest listeners, so this adapter
 * keeps the low-latency per-segment redirect path used by the original port.
 */
'use strict';

const api = globalThis.TVUApi || globalThis.browser;

globalThis.TVUInstance = globalThis.TVUBackgroundCore.createBackground({
  api,
  Core: globalThis.TVUCore,
  platform: { useBlocking: true }
});
