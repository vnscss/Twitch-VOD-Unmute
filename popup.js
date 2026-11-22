'use strict';

const KEYS = Object.keys(globalThis.TVUCore.DEFAULT_SETTINGS);
const TOGGLES = ['enabled', 'seekbar', 'quality'];
const COLOURS = ['unmuted', 'quality', 'muted'];

function $(id) {
  return document.getElementById(id);
}

async function loadSettings() {
  const values = await TVUApi.storage.sync.get(KEYS);
  return globalThis.TVUCore.normaliseSettings(values);
}

function renderSettings(settings) {
  for (const key of TOGGLES) $(key).checked = Boolean(settings[key]);

  for (const key of COLOURS) {
    const value = settings[key + 'Colour'];
    $(key + 'Colour').value = value;
    $(key + 'ColourPicker').value = value;
  }

  $('opacity').value = settings.opacity;
  $('opacityText').textContent = Number(settings.opacity).toFixed(2);
  $('colours').style.display = settings.seekbar ? '' : 'none';
}

async function saveSettings(patch) {
  await TVUApi.storage.sync.set(patch);
  renderSettings(await loadSettings());
}

function normaliseHex(value, fallback) {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(String(value).trim());
  return match ? '#' + match[1].toUpperCase() : fallback;
}

async function refreshStats() {
  const element = $('stats');
  const detail = $('diagnostics');
  try {
    const response = await TVUApi.runtime.sendMessage({ type: 'tvu:stats' });
    if (response && response.error) throw new Error(response.error);
    const stats = response && response.stats;
    const info = response && response.diagnostics;

    if (!stats) {
      if (info && info.mode === 'live') {
        element.textContent = 'Live stream detected — ignored.';
        detail.textContent = 'No media requests were delayed, probed, or redirected.';
      } else if (info && info.activeScan) {
        element.textContent = 'Scanning VOD…';
        detail.textContent = 'Segment requests are waiting only for this VOD.';
      } else if (info && info.mode === 'vod') {
        element.textContent = 'VOD page detected — waiting for media.';
        detail.textContent = 'The VOD playlist has not been scanned yet.';
      } else if (info && info.mode === 'unknown') {
        element.textContent = 'No scan for this page.';
        detail.textContent = info.reason || 'No VOD playlist observed.';
      } else {
        element.textContent = 'No scan yet. Open a muted VOD and wait a few seconds.';
        detail.textContent = '';
      }
      return;
    }

    const extra = stats.lowerQuality ? ', ' + stats.lowerQuality + ' from a lower quality' : '';
    const dvr = stats.dvrRestored ? ', ' + stats.dvrRestored + ' via index-dvr' : '';
    element.textContent = stats.restored + '/' + stats.total + ' segments recovered' + extra + dvr +
      ' (' + (stats.quality || 'unknown quality') + ').';

    const parts = [];
    if (stats.dvrStatus) {
      parts.push('DVR: ' + stats.dvrStatus +
        (stats.dvrNames ? ' (' + stats.dvrNames + ' names)' : ''));
    }
    if (stats.requests) parts.push(stats.requests + ' probes');
    if (stats.waitedSegments) parts.push(stats.waitedSegments + ' held requests');
    if (stats.durationMs) parts.push('scan ' + Math.round(stats.durationMs / 100) / 10 + 's');
    detail.textContent = parts.length ? parts.join(' · ') : (info && info.reason) || '';
  } catch (error) {
    element.textContent = 'Could not read scan results: ' + (error && error.message || error);
    detail.textContent = '';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  renderSettings(await loadSettings());
  await refreshStats();

  for (const key of TOGGLES) {
    $(key).addEventListener('change', event => {
      saveSettings({ [key]: event.target.checked });
    });
  }

  for (const key of COLOURS) {
    const text = $(key + 'Colour');
    const picker = $(key + 'ColourPicker');
    const setting = key + 'Colour';

    text.addEventListener('change', () => {
      const value = normaliseHex(text.value, picker.value);
      saveSettings({ [setting]: value });
    });
    picker.addEventListener('input', () => {
      saveSettings({ [setting]: picker.value.toUpperCase() });
    });
  }

  $('opacity').addEventListener('input', event => {
    const value = Number(event.target.value);
    $('opacityText').textContent = value.toFixed(2);
  });
  $('opacity').addEventListener('change', event => {
    saveSettings({ opacity: Number(event.target.value) });
  });

  $('reset').addEventListener('click', async () => {
    const response = await TVUApi.runtime.sendMessage({ type: 'tvu:stats', clear: true });
    if (response && response.error) throw new Error(response.error);
    await refreshStats();
  });
});
