'use strict';

/*
 * Tests the seekbar painter against the nested markup Twitch currently uses:
 * div.seekbar-bar > div.seekbar-segment > span[style]. The inner span has its
 * own inline position/colour, so simply styling the outer div is not enough.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

class FakeStyle {
  constructor(initial = {}) {
    Object.assign(this, initial);
  }
}

class FakeNode {
  constructor(tag, { attrs = {}, style = {}, children = [] } = {}) {
    this.tag = tag;
    this.attrs = Object.assign({}, attrs);
    this.style = new FakeStyle(style);
    this.children = children.slice();
    for (const child of this.children) child.parentNode = this;
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  getAttribute(name) { return this.attrs[name]; }

  get firstElementChild() { return this.children[0]; }
  get lastElementChild() { return this.children[this.children.length - 1]; }

  _descendants() {
    const result = [];
    for (const child of this.children) {
      result.push(child, ...child._descendants());
    }
    return result;
  }

  querySelectorAll(selector) {
    if (selector.startsWith('[data-tvu-gen="')) {
      const wanted = /data-tvu-gen="([^"]+)"/.exec(selector)[1];
      return this._descendants().filter(node => node.attrs['data-tvu-gen'] === wanted);
    }
    if (selector === '[data-tvu-gen]') {
      return this._descendants().filter(node => 'data-tvu-gen' in node.attrs);
    }
    if (selector === '[style]') {
      return this._descendants().filter(node => node.style);
    }
    if (selector === '[data-test-selector]') {
      return this._descendants().filter(node => 'data-test-selector' in node.attrs);
    }
    return [];
  }

  cloneNode(deep) {
    return new FakeNode(this.tag, {
      attrs: this.attrs,
      style: this.style,
      children: deep ? this.children.map(child => child.cloneNode(true)) : []
    });
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  insertBefore(node, reference) {
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    node.parentNode = this;
  }
}

function loadPaintSeekbar(root) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'background-core.js'), 'utf8');
  const start = source.indexOf('function paintSeekbar(');
  const end = source.indexOf('\n    async function inject(', start);
  assert.ok(start >= 0 && end > start, 'paintSeekbar must exist in background-core.js');

  const context = vm.createContext({
    window: {},
    document: {
      querySelector: selector => selector === 'div.seekbar-bar' ? root : null,
      documentElement: {},
      body: {}
    },
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    requestAnimationFrame: callback => callback(),
    Array, Object, String, Number
  });
  vm.runInContext(
    source.slice(start, end) + '\nthis.paintSeekbar = paintSeekbar;',
    context,
    { filename: 'background-core.js#paintSeekbar' }
  );
  return context.paintSeekbar;
}

function twitchSeekBar() {
  const inner = new FakeNode('span', {
    attrs: { 'data-test-selector': 'seekbar-segment__segment' },
    style: { insetInlineStart: '0%', width: '100%', backgroundColor: '#ffffff' }
  });
  const template = new FakeNode('div', {
    attrs: { class: 'seekbar-segment' },
    children: [inner]
  });
  const thumb = new FakeNode('div', {
    children: [new FakeNode('span', { style: { insetInlineStart: '50%' } })]
  });
  const root = new FakeNode('div', {
    attrs: { class: 'seekbar-bar' },
    children: [template, thumb]
  });
  return { root, thumb, template };
}

test('highlight styling reaches Twitch\'s nested segment span', () => {
  const { root, thumb } = twitchSeekBar();
  const paintSeekbar = loadPaintSeekbar(root);
  const colours = {
    unmuted: '#00FF0080',
    quality: '#FFA50080',
    muted: '#FF000080'
  };
  const bands = [
    { left: 10, width: 20, quality: '720p60' },
    { left: 30, width: 25, quality: null },
    { left: 55, width: 20, quality: '480p30' }
  ];

  paintSeekbar(bands, colours, '720p60');

  const added = root.children.filter(node => node.attrs['data-tvu-gen']);
  assert.equal(added.length, 3);

  assert.equal(added[0].style.insetInlineStart, '10%');
  assert.equal(added[0].style.left, '10%');
  assert.equal(added[0].style.width, '20%');
  assert.equal(added[0].style.pointerEvents, 'none');

  const inner = added[0].children[0];
  assert.equal(inner.style.insetInlineStart, '0%');
  assert.equal(inner.style.width, '100%');
  assert.equal(inner.style.backgroundColor, colours.unmuted);
  assert.equal(inner.style.opacity, '1');
  assert.equal(inner.attrs['data-test-selector'], undefined);

  assert.equal(added[1].children[0].style.backgroundColor, colours.muted);
  assert.equal(added[2].children[0].style.backgroundColor, colours.quality);
  assert.equal(root.lastElementChild, thumb, 'the thumb stays last');

  // Repainting must replace the old highlights, not stack more on top.
  paintSeekbar(bands, colours, '720p60');
  assert.equal(root.children.filter(node => node.attrs['data-tvu-gen']).length, 3);
});
