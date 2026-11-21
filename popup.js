'use strict';

const KEYS = Object.keys(globalThis.TVUCore.DEFAULT_SETTINGS);
const TOGGLES = ['enabled', 'seekbar', 'quality'];
const COLOURS = ['unmuted', 'quality', 'muted'];

function $(id) {
  return document.getElementById(id);
}

async function loadSettings() {
  const values = await browser.storage.sync.get(KEYS);
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
  await browser.storage.sync.set(patch);
  renderSettings(await loadSettings());
}

function normaliseHex(value, fallback) {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(String(value).trim());
  return match ? '#' + match[1].toUpperCase() : fallback;
}

async function refreshStats() {
  const element = $('stats');
  try {
    const response = await browser.runtime.sendMessage({ type: 'tvu:stats' });
    const stats = response && response.stats;
    if (!stats) {
      element.textContent = 'No scan yet. Open a muted VOD and wait a few seconds.';
      return;
    }
    const extra = stats.lowerQuality ? ', ' + stats.lowerQuality + ' from a lower quality' : '';
    element.textContent = stats.restored + '/' + stats.total + ' segments recovered' + extra +
      ' (' + (stats.quality || 'unknown quality') + ').';
  } catch (error) {
    element.textContent = 'Could not read scan results: ' + (error && error.message || error);
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
    await browser.runtime.sendMessage({ type: 'tvu:stats', clear: true });
    await refreshStats();
  });
});
