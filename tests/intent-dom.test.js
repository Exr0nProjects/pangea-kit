// The DOM end of intent (lib/intent-dom.js) over jsdom: the one place focus moves, driven only by the record.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, declare } from '../lib/model.js';
import { declareComponent } from '../lib/components.js';
import { intent, threadFocus } from '../lib/intent.js';
import { addressOf, installIntent } from '../lib/intent-dom.js';

const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v }, removeItem: (k) => { delete m[k] } }; };
const html = (panes = ['p1']) => panes.map((p) => `
  <section data-focus-pane="${p}">
    <div data-testid="${p}-transcript" data-focus-at="transcript"><p id="${p}-text">hello world</p></div>
    <div id="${p}-card" data-focus-at="thread:t1"><p id="${p}-body">a reply</p><button id="${p}-x">x</button><textarea id="${p}-thread" data-focus-field></textarea></div>
    <div data-focus-at="composer:c-${p}"><textarea id="${p}-composer" data-focus-field></textarea></div>
  </section>`).join('');
const press = (el) => el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

let store, owner, frames;
beforeEach(() => {
  document.body.innerHTML = html(['p1', 'p2']);
  store = createApp({ storage: mem(), device: 'd' }).use(declare(declareComponent('intent', intent(), { scope: 'ephemeral' })));
  frames = [];
  owner = installIntent({ store, root: document, frame: (fn) => frames.push(fn) });
});
afterEach(() => { owner.stop(); document.body.innerHTML = ''; });
const flush = (n = 5) => { for (let i = 0; i < n && frames.length; i++) frames.shift()(); };

describe('intent-dom', () => {
  it('type-to-focus: a key typed into an extension overlay (an input inside a foreign shadow root) is the overlay\'s, never pulled into the composer', () => {
    const host = document.createElement('arc-palette');
    document.body.append(host);
    const input = host.attachShadow({ mode: 'open' }).appendChild(document.createElement('input'));
    press(document.getElementById('p1-body')); // a pane owns focus, as in the live page
    input.focus();
    flush();
    input.focus();
    const seq = store.get().seq;
    const ev = new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true, cancelable: true });
    input.dispatchEvent(ev);
    flush();
    expect(ev.target).toBe(host); // the page sees the host, not the input
    expect(store.get().seq).toBe(seq); // no move was asked
    expect(document.activeElement).toBe(host); // focus is still in the overlay
    host.remove();
  });

  it('addresses: a node inside a pane reads as (pane, element, inside), outside every pane as null', () => {
    expect(addressOf(document.getElementById('p1-body'))).toMatchObject({ pane: 'p1', at: { kind: 'thread', id: 't1' }, inside: false });
    expect(addressOf(document.getElementById('p1-thread'))).toMatchObject({ pane: 'p1', at: { kind: 'thread', id: 't1' }, inside: true });
    expect(addressOf(document.body)).toBeNull();
  });

  it('click-into-box: a click on the card body focuses its field; the caret is in the DOM only because the record said so', () => {
    press(document.getElementById('p1-body'));
    expect(store.get()).toMatchObject({ pane: 'p1', pending: false });
    click(document.getElementById('p1-body'));
    expect(document.activeElement.id).toBe('p1-thread');
    expect(store.get()).toMatchObject({ pane: 'p1', at: { kind: 'thread', id: 't1' }, pending: false });
    // a click on a button in the card does not pull the caret in
    document.getElementById('p1-composer').focus();
    click(document.getElementById('p1-x'));
    expect(document.activeElement.id).toBe('p1-composer');
  });

  it('a click that ends a text selection in the card leaves the selection alone', () => {
    const range = document.createRange(); range.selectNodeContents(document.getElementById('p1-body'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
    click(document.getElementById('p1-body'));
    expect(document.activeElement.id).not.toBe('p1-thread');
    getSelection().removeAllRanges();
  });

  it('opening a pane carries focus into it even though the old box still holds DOM focus, and the next keystroke lands there', () => {
    document.getElementById('p1-thread').focus();
    expect(store.get()).toMatchObject({ pane: 'p1', at: { kind: 'thread', id: 't1' } });
    store.dispatch('openPane', { pane: 'p2' });
    flush();
    expect(document.activeElement.id).toBe('p2-composer');
    expect(store.get()).toMatchObject({ pane: 'p2', at: { kind: 'composer', id: 'c-p2' }, pending: false });
    key(document.activeElement, 'x');
    expect(document.activeElement.id).toBe('p2-composer');
  });

  it('a pane that has not mounted yet is waited for, frame by frame', () => {
    document.body.innerHTML = html(['p1']);
    store.dispatch('openPane', { pane: 'p3' });
    flush();
    expect(store.get().pending).toBe(true);
    document.body.insertAdjacentHTML('beforeend', html(['p3']));
    flush();
    expect(document.activeElement.id).toBe('p3-composer');
    expect(store.get().pending).toBe(false);
  });

  it('the caret follows typed text: after words are put in a box and focus leaves, the next keystroke lands at their end, not at the start', () => {
    const box = document.getElementById('p1-composer');
    box.focus();
    box.value = 'a message I was in the middle of';
    box.setSelectionRange(box.value.length, box.value.length);
    box.dispatchEvent(new Event('input', { bubbles: true })); // a fill or a paste: `input`, with no keyup or select
    box.blur();
    key(document.body, '!');
    flush();
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe('a message I was in the middle of!');
  });

  it('type-to-focus: a printable key with nothing editable focused lands in the owner box, in the same keystroke', () => {
    store.dispatch('openThread', { pane: 'p1', id: 't1' });
    flush();
    expect(document.activeElement.id).toBe('p1-thread');
    document.getElementById('p1-thread').blur?.call(document.getElementById('p1-thread')); // (the test, not an app: an app never calls blur)
    document.body.focus();
    key(document.body, 'h');
    expect(document.activeElement.id).toBe('p1-thread');
    expect(document.getElementById('p1-thread').value).toBe('h'); // the keystroke itself arrives, not only the focus

    // a key on a button is the button's
    document.getElementById('p1-x').focus();
    key(document.getElementById('p1-x'), ' ');
    expect(document.activeElement.id).toBe('p1-x');
  });

  it('the thread highlight follows the record: a press in another pane leaves it, a press outside every pane clears the pane', () => {
    store.dispatch('openThread', { pane: 'p1', id: 't1' });
    flush();
    expect(threadFocus(store.get(), 'p1')).toBe('t1');
    press(document.getElementById('p2-text'));
    expect(threadFocus(store.get(), 'p1')).toBeNull();
    expect(store.get().pane).toBe('p2');
    press(document.body);
    expect(store.get().pane).toBeNull();
  });

  it('caret and selection are recorded from the field and restored when the record puts focus back', () => {
    const t = document.getElementById('p1-composer');
    t.value = 'abcdef'; t.focus(); t.setSelectionRange(2, 4);
    t.dispatchEvent(new Event('select', { bubbles: true }));
    expect(store.get().caret).toEqual({ start: 2, end: 4 });
    store.dispatch('press', { pane: 'p1', at: { kind: 'transcript' }, inside: true });
    store.dispatch('openPane', { pane: 'p1', at: { kind: 'composer', id: 'c-p1' } });
    flush();
    expect(document.activeElement.id).toBe('p1-composer');
  });
});
