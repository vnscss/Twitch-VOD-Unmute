/*
 * Cross-browser WebExtension API wrapper.
 *
 * Firefox already exposes promise-based `browser.*` APIs. Chrome MV3 exposes
 * the equivalent `chrome.*` APIs with callbacks for several methods, so this
 * file normalises the small subset used by the background scripts and popup.
 */
(function (root) {
  'use strict';

  if (root.browser && root.browser.storage && root.browser.runtime) {
    root.TVUApi = root.browser;
    return;
  }

  const chrome = root.chrome;
  if (!chrome || !chrome.storage || !chrome.runtime) return;

  function lastError() {
    const error = chrome.runtime && chrome.runtime.lastError;
    return error ? new Error(error.message || String(error)) : null;
  }

  function promisify(fn, context) {
    return function () {
      const args = Array.prototype.slice.call(arguments);
      return new Promise(function (resolve, reject) {
        fn.apply(context, args.concat(function (result) {
          const error = lastError();
          if (error) reject(error);
          else resolve(result);
        }));
      });
    };
  }

  const sync = chrome.storage.sync;
  const sessionArea = chrome.storage.session || chrome.storage.local;
  const storageOnChanged = chrome.storage.onChanged;

  const api = {
    storage: {
      sync: {
        get: promisify(sync.get, sync),
        set: promisify(sync.set, sync)
      },
      session: {
        get: promisify(sessionArea.get, sessionArea),
        set: promisify(sessionArea.set, sessionArea)
      },
      onChanged: {
        addListener: function (listener) {
          storageOnChanged.addListener(function (changes, area) {
            // Normalise the local fallback used on very old Chrome builds so
            // the core can keep checking for the "session" area.
            if (sessionArea === chrome.storage.local && area === 'local') area = 'session';
            listener(changes, area);
          });
        }
      }
    },
    scripting: {
      executeScript: promisify(chrome.scripting.executeScript, chrome.scripting)
    },
    webRequest: {
      onCompleted: chrome.webRequest && chrome.webRequest.onCompleted
    },
    runtime: {
      onInstalled: chrome.runtime.onInstalled,
      onMessage: {
        addListener: function (listener) {
          chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
            let result;
            try {
              result = listener(message, sender);
            } catch (error) {
              sendResponse({ error: String(error && error.message || error) });
              return false;
            }

            if (result && typeof result.then === 'function') {
              result.then(sendResponse, function (error) {
                sendResponse({ error: String(error && error.message || error) });
              });
              return true;
            }
            return false;
          });
        }
      },
      sendMessage: promisify(chrome.runtime.sendMessage, chrome.runtime)
    },
    tabs: {
      onRemoved: chrome.tabs.onRemoved,
      query: promisify(chrome.tabs.query, chrome.tabs)
    },
    declarativeNetRequest: chrome.declarativeNetRequest
  };

  root.TVUApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
