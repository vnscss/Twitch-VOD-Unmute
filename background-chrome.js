/*
 * Chrome MV3 background service worker adapter.
 *
 * Chrome does not allow blocking webRequest listeners for normal Web Store
 * extensions, so redirects are applied with declarativeNetRequest rules. The
 * playlist/probe logic is identical to Firefox and lives in background-core.
 */
'use strict';

if (typeof importScripts === 'function') {
  importScripts(
    'src/core.js',
    'src/api.js',
    'src/background-core.js'
  );
}

const api = globalThis.TVUApi;
const dnr = api && api.declarativeNetRequest;

if (!api || !dnr || !dnr.updateSessionRules || !dnr.getSessionRules) {
  throw new Error('Chrome declarativeNetRequest session rules API is required');
}

const RULE_STATE_KEY = 'dnrRules';
const NEXT_RULE_KEY = 'dnrNextId';
const MAX_RULE_ID = 900000;
const RESOURCE_TYPES = ['xmlhttprequest', 'media', 'other'];
// Chrome only allows tabIds on session-scoped DNR rules, so both the rules and
// their IDs share the session lifecycle.
const ruleStore = api.storage.session;

let ruleState = null;
let nextRuleId = 1;

async function loadRuleState() {
  if (ruleState) return ruleState;
  const values = await ruleStore.get([RULE_STATE_KEY, NEXT_RULE_KEY]);
  ruleState = values[RULE_STATE_KEY] || {};
  nextRuleId = Number(values[NEXT_RULE_KEY]) || 1;
  return ruleState;
}

async function saveRuleState() {
  await ruleStore.set({
    [RULE_STATE_KEY]: ruleState,
    [NEXT_RULE_KEY]: nextRuleId
  });
}

function allocateRuleId() {
  const id = nextRuleId;
  nextRuleId = nextRuleId >= MAX_RULE_ID ? 1 : nextRuleId + 1;
  return id;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRule(id, key, target, tabId) {
  return {
    id,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: { url: target }
    },
    condition: {
      // `key` is origin + pathname. Tokens appended by the player are ignored.
      regexFilter: '^' + escapeRegExp(key) + '(?:[?#].*)?$',
      isUrlFilterCaseSensitive: true,
      tabIds: [tabId],
      resourceTypes: RESOURCE_TYPES
    }
  };
}

async function emitRedirect(key, target, tabId) {
  const state = await loadRuleState();
  const tabRules = state[tabId] || (state[tabId] = {});
  const oldId = tabRules[key];
  const id = oldId || allocateRuleId();

  await dnr.updateSessionRules({
    removeRuleIds: oldId ? [oldId] : [],
    addRules: [buildRule(id, key, target, tabId)]
  });

  tabRules[key] = id;
  await saveRuleState();
}

async function removeTabRules(tabId) {
  const state = await loadRuleState();
  const ids = Object.values(state[tabId] || {});
  if (ids.length) {
    await dnr.updateSessionRules({ removeRuleIds: ids, addRules: [] });
  }
  delete state[tabId];
  await saveRuleState();
}

async function clearAllRules() {
  try {
    const rules = await dnr.getSessionRules();
    if (rules && rules.length) {
      await dnr.updateSessionRules({
        removeRuleIds: rules.map(rule => rule.id),
        addRules: []
      });
    }
  } catch (error) {
    console.warn('[tvu] could not clear DNR rules', error && error.message);
  }
  ruleState = {};
  nextRuleId = 1;
  await saveRuleState();
}

globalThis.TVUInstance = globalThis.TVUBackgroundCore.createBackground({
  api,
  Core: globalThis.TVUCore,
  platform: {
    useBlocking: false,
    emitRedirect,
    removeTabRules,
    clearAllRules
  }
});
