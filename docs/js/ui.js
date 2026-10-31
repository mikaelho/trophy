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

// A d6 face. Light = pale face with dark pips, dark = the reverse, the same in both themes.
// No value draws the six face (an unrolled die).
const PIPS = {
  1: [[20, 20]], 2: [[29, 11], [11, 29]], 3: [[29, 11], [20, 20], [11, 29]],
  4: [[11, 11], [29, 11], [11, 29], [29, 29]], 5: [[11, 11], [29, 11], [20, 20], [11, 29], [29, 29]],
  6: [[11, 11], [29, 11], [11, 20], [29, 20], [11, 29], [29, 29]],
};
export function dieSvg(color, value, cls = 'die-svg') {
  const pips = PIPS[value] || PIPS[6];
  return svg`<svg viewBox="0 0 40 40" class=${cls} role="img" aria-label=${`${color} die${value ? ' showing ' + value : ''}`}>
    <rect x="2" y="2" width="36" height="36" rx="6" class=${'die-face-' + color}/>
    ${pips.map(([x, y]) => svg`<circle cx=${x} cy=${y} r="3.6" class=${'die-pip-' + color}/>`)}
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
let toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
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
