// Shared UI helpers: the editable-field behaviour of the sheet, markdown, small widgets.
import { html, svg, noChange } from '../vendor/lit-html/lit-html.js';
import { directive, Directive, PartType } from '../vendor/lit-html/directive.js';
import { unsafeHTML } from '../vendor/lit-html/directives/unsafe-html.js';
import { marked } from '../vendor/marked/marked.esm.js';
import DOMPurify from '../vendor/dompurify/purify.es.mjs';

// .value=${editValue(v)}: sets an input's value from the database, but never while the
// person is typing in it (the field is theirs until they leave it), and also when the
// stored value did not change but the input shows something else (e.g. "-5" saved as 0).
class EditValue extends Directive {
  constructor(part) {
    super(part);
    if (part.type !== PartType.PROPERTY) throw new Error('editValue() goes on .value');
  }
  render(v) { return v; }
  update(part, [v]) {
    const el = part.element, s = v == null ? '' : String(v);
    if (el !== document.activeElement && el.value !== s) el.value = s;
    el.defaultValue = s; // what Escape reverts to
    if (el.tagName === 'TEXTAREA') requestAnimationFrame(() => grow(el));
    return noChange;
  }
}
export const editValue = directive(EditValue);

// Make a textarea exactly as tall as its text.
export function grow(t) { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; }

// <span ${spin(key)}>: spins the element whenever key changes (a die being rolled),
// but not when it first appears.
class Spin extends Directive {
  constructor(part) {
    super(part);
    if (part.type !== PartType.ELEMENT) throw new Error('spin() goes on an element');
  }
  render() { return noChange; }
  update(part, [key]) {
    const el = part.element;
    if (el._spinKey !== undefined && el._spinKey !== key && key != null && el.animate) {
      el.animate([{ transform: 'rotate(0deg) scale(0.6)' }, { transform: 'rotate(380deg) scale(1)' }],
        { duration: 500, easing: 'ease-out' });
    }
    el._spinKey = key;
    return noChange;
  }
}
export const spin = directive(Spin);

// A fair random number from 0 up to (not including) 1, from the browser's secure random source.
export const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
// One d6 roll, 1 to 6.
export const rollD6 = () => 1 + Math.floor(random() * 6);

// A d6 face. Light = pale face with dark marks, dark = the reverse, the same in both themes.
// 1-3 are hollow rings, 4-5 filled pips, and 6 is a dragon emblem (below). No value draws the six (an unrolled die; the roller dims those).
const PIPS = {
  1: [[20, 20]], 2: [[29, 11], [11, 29]], 3: [[29, 11], [20, 20], [11, 29]],
  4: [[11, 11], [29, 11], [11, 29], [29, 29]], 5: [[11, 11], [29, 11], [20, 20], [11, 29], [29, 29]],
};
// The dragon's head: the supplied emblem image, cut from its background, cleaned of the print texture,
// made symmetric and traced into one filled shape (holes by the even-odd rule) on a 40x40 face.
const DRAGON = 'M5.9 5L5.8 5.2L6.2 6.5L7.3 8.7L7.1 9L6.8 9L6.8 9L8 9.9L8.5 10.6L8.4 10.8L8 11.2L8.5 11.3L9.3 11.8L10.1 12.9L11.5 14.3L12.1 15.2L11.9 15.2L9.4 12.9L5.6 12L4.8 11.6L3.5 10.8L3.5 11L4.2 11.8L5.4 13L7.1 14.3L7.9 15L8 15L7.9 14.5L8.1 14.3L10.4 15L11.3 15.4L12 16L12.8 16.9L13.1 17L13.1 17.2L13.4 17.9L13.3 18.1L12.3 18.3L11.9 18.5L11.6 18.5L11.5 18.4L11.6 18.3L11.2 18.2L11 18L11.1 17.8L10.9 17.8L10.7 17.9L9.6 18.4L8 18.6L7.8 18.4L7.7 18.6L7.9 18.9L8.4 18.9L8.6 19.2L8.9 19.3L9.1 19.6L9.9 20L10.1 20L10.3 19.5L10.6 19.5L11.4 19.6L12.1 19.8L13.6 20.9L14.2 21.8L14.5 22L14.5 22.3L15.6 24.1L17 26.9L16.8 27L15.2 25.4L14.8 24.5L14.8 23.3L13.8 22L13.6 22L13.6 23.6L13.4 23.7L13.2 23.7L12.4 22.7L12.3 22.7L12.3 23.4L12.7 24L12.6 24.4L13.2 25.5L13.5 26L15.2 27.1L16.1 28.1L16.5 29L16.7 30.1L16.6 30.8L16.4 31.7L18 34.4L18.1 34.4L18.1 33.5L18.4 33.6L20 35L20.1 35L21.7 33.5L21.9 33.5L21.9 34.4L22 34.4L23.6 31.7L23.4 30.8L23.3 30.1L23.5 29L23.9 28.1L24.8 27.1L26.5 26L26.8 25.5L27.4 24.4L27.3 24L27.7 23.4L27.7 22.7L27.6 22.7L26.8 23.7L26.6 23.7L26.4 23.6L26.4 22L26.2 22L25.2 23.3L25.2 24.5L24.8 25.4L23.2 27L23 26.9L24.4 24.1L25.5 22.3L25.5 22L25.8 21.8L26.4 20.9L27.9 19.8L28.6 19.6L29.4 19.5L29.7 19.5L29.9 19.7L29.9 19.9L30.1 20L30.9 19.6L31.1 19.3L31.4 19.3L31.6 18.9L31.9 18.9L32.3 18.6L32.2 18.4L32 18.6L30.4 18.4L29.3 17.9L29.1 17.8L28.9 17.8L29 18L28.8 18.2L28.4 18.3L28.5 18.4L28.4 18.5L28.1 18.5L27.7 18.3L26.7 18.1L26.6 17.9L26.9 17.2L26.9 17L27.2 16.9L28 16L28.7 15.4L29.6 15L31.9 14.3L32.1 14.5L32 15L32.1 15L32.9 14.3L34.6 13L35.8 11.8L36.5 10.8L35.2 11.6L34.4 12L30.6 12.9L28.1 15.2L27.9 15.2L28.5 14.3L29.9 12.9L30.7 11.8L31.5 11.3L32 11.2L31.6 10.8L31.5 10.6L32 9.9L33.2 9L33.2 9L32.9 9L32.7 8.7L33.8 6.5L34.2 5L34 5.1L32.6 7.2L32.7 7.6L32.5 7.9L32.1 7.8L31.5 8.8L30.8 9.1L29 10.8L28.8 10.8L28.7 10.6L28.6 9.6L28.5 9.6L27.8 11.1L27.4 11.8L26.2 13.2L26 13.2L24.4 14.7L24.3 14.6L24.4 14.2L25.5 12.6L25.8 12L26 11.8L25.8 11.4L26.4 11.5L26.8 10.9L27 9.5L27.2 8.8L27.2 8.2L27.8 7L28.8 5.5L27.7 6.3L26.4 7.6L25.8 8.5L25.8 9.3L25.2 10.6L24 12.3L23.2 13.1L23.1 13L23.2 12.2L23.6 11.7L23.6 11.1L23.3 10L22.8 9L22.7 9L22.8 9.9L22.7 10.7L22.3 11.8L22 12.6L20.8 14L21 14.5L21.2 15.6L21.1 17.2L21.1 18.1L22 16.6L22 16.3L22.4 15.6L22.6 15.7L22.8 17.1L23.1 17.3L23.9 16.5L26.1 14.6L27.7 13.6L27.7 13.8L27 14.8L26.6 14.7L24.5 16.3L23.5 17.7L22.3 19.8L20.4 19.3L19.1 19.4L17.7 19.8L16.5 17.7L15.5 16.3L13.4 14.7L13 14.8L12.3 13.8L12.3 13.6L13.9 14.6L16.1 16.5L16.9 17.3L17.2 17.1L17.4 15.7L17.6 15.6L18 16.3L18 16.6L18.9 18.1L18.9 17.2L18.8 15.6L19 14.5L19.2 14L18 12.6L17.7 11.8L17.3 10.7L17.2 9.9L17.3 9L17.2 9L16.7 10L16.4 11.1L16.4 11.7L16.8 12.2L16.9 13L16.8 13.1L16 12.3L14.8 10.6L14.2 9.3L14.2 8.5L13.6 7.6L12.3 6.3L11.2 5.5L12.2 7L12.8 8.2L12.8 8.8L13 9.5L13.2 10.9L13.6 11.5L14.2 11.4L14 11.8L14.2 12L14.5 12.6L15.6 14.2L15.7 14.6L15.6 14.7L14 13.2L13.8 13.2L12.6 11.8L12.2 11.1L11.5 9.6L11.4 9.6L11.3 10.6L11.2 10.8L11 10.8L9.2 9.1L8.5 8.8L7.9 7.8L7.7 7.9L7.4 7.9L7.3 7.6L7.4 7.2ZM22.2 28.9L22.3 29L22.1 30L22.1 31L22.3 31L22.4 31.1L22.2 31.4L21.6 31.6L21.3 31.9L21 32.6L20.9 32.7L20.9 31.5L22.1 29ZM17.8 28.9L17.9 29L19.1 31.5L19.1 32.7L19 32.6L18.7 31.9L18.4 31.6L17.8 31.4L17.6 31.1L17.7 31L17.9 31L17.9 30L17.7 29ZM23.1 21.9L23.7 22.6L23.8 22.9L22.7 24.9L22.2 25.4L22.2 24.9L22.6 22.8L22.8 22.1ZM16.9 21.9L17.1 22L17.4 22.8L17.8 24.9L17.8 25.4L17.3 24.9L16.2 22.9L16.3 22.6ZM20 20.6L20.9 20.7L21.6 21L21.8 21.1L21.5 22L21.6 22.4L21.3 22.5L21 24.1L20.7 26.2L20.7 27.8L21.7 26L22 25.9L21.3 27.6L20 30.1L19.9 30L18.7 27.6L18.6 27.2L18 26L18.1 25.9L18.3 26L19.3 27.8L19.3 26.2L19 24.1L18.7 22.5L18.4 22.4L18.5 22L18.2 21.1L18.4 21L19.1 20.7ZM25.4 17.4L25.5 17.6L25.1 18.7L25 19.3L26.1 19.2L26.2 19.4L25.2 20.5L24.8 21.1L24.7 21.4L24.5 21.5L23.5 20.5L23.5 20.3L24.5 18.4ZM14.6 17.4L15.5 18.4L16.5 20.3L16.5 20.5L15.5 21.5L15.3 21.4L15.3 21.2L14.8 20.5L13.8 19.4L13.9 19.2L15 19.3L14.9 18.7L14.5 17.6Z';
const dragon = color => svg`<path d=${DRAGON} fill-rule="evenodd" class=${'die-pip-' + color}/>`;

export function dieSvg(color, value, cls = 'die-svg') {
  const face = PIPS[value] ? value : 6;
  return svg`<svg viewBox="0 0 40 40" class=${cls} role="img" aria-label=${`${color} die${value ? ' showing ' + value : ''}`}>
    <rect x="2" y="2" width="36" height="36" rx="6" class=${'die-face-' + color}/>
    ${face === 6 ? dragon(color) : PIPS[face].map(([x, y]) => face <= 3
      ? svg`<circle cx=${x} cy=${y} r="3.3" class=${'die-ring-' + color}/>`
      : svg`<circle cx=${x} cy=${y} r="3.6" class=${'die-pip-' + color}/>`)}
  </svg>`;
}

// Markdown -> sanitized HTML.
export function markdown(text) {
  return unsafeHTML(DOMPurify.sanitize(marked.parse(String(text || ''), { breaks: true })));
}
export function markdownInline(text) {
  return unsafeHTML(DOMPurify.sanitize(marked.parseInline(String(text || ''))));
}

// A message shown briefly at the bottom of the page.
// action: {label, fn} adds a button (e.g. Undo) and keeps the message up a little longer.
let toastTimer;
export function toast(msg, { action } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.replaceChildren(document.createTextNode(msg));
  if (action) {
    const b = Object.assign(document.createElement('button'), { className: 'toast-action', textContent: action.label });
    b.onclick = () => { el.hidden = true; action.fn(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 4000);
}
// Run an op and report a failure without throwing.
export function attempt(promise) {
  return Promise.resolve(promise).catch(e => { toast(e.message || String(e)); return undefined; });
}

// Keyboard handling for the sheet's edit fields, installed once for the whole page:
// Enter (inputs) or Cmd/Ctrl+Enter (textareas) commits by leaving the field, Escape
// reverts to the saved value and leaves. "+ add" inputs: Enter submits, Escape clears.
export function installKeys() {
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.matches('form.add-form input[name=name]')) {
      if (e.key === 'Escape') { e.preventDefault(); t.value = ''; t.blur(); }
      return;
    }
    if (!t.matches('[data-edit]')) return;
    const isTextarea = t.tagName === 'TEXTAREA';
    const commit = isTextarea ? e.key === 'Enter' && (e.metaKey || e.ctrlKey) : e.key === 'Enter';
    if (commit) { e.preventDefault(); t.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); t.value = t.defaultValue; t.blur(); }
  });
  // Auto-grow note textareas to fit their text.
  document.addEventListener('input', e => { if (e.target.matches?.('textarea[data-edit]')) grow(e.target); });
  document.addEventListener('focusin', e => { if (e.target.matches?.('textarea[data-edit]')) grow(e.target); });
}

export const dieIcon = html`<svg viewBox="0 0 40 40" class="icon" aria-hidden="true">
  <rect x="2" y="2" width="36" height="36" rx="6" fill="#ffffff" stroke="#6b7280" stroke-width="2"/>
  <circle cx="11" cy="11" r="3.6" fill="#18181b"/><circle cx="29" cy="11" r="3.6" fill="#18181b"/>
  <circle cx="11" cy="20" r="3.6" fill="#18181b"/><circle cx="29" cy="20" r="3.6" fill="#18181b"/>
  <circle cx="11" cy="29" r="3.6" fill="#18181b"/><circle cx="29" cy="29" r="3.6" fill="#18181b"/>
</svg>`;
