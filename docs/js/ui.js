// Shared UI helpers: the editable-field behaviour of the sheet, markdown, small widgets.
import { html, noChange } from '../vendor/lit-html/lit-html.js';
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
    return noChange;
  }
}
export const editValue = directive(EditValue);

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
  const grow = t => { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; };
  document.addEventListener('input', e => { if (e.target.matches?.('textarea[data-edit]')) grow(e.target); });
  document.addEventListener('focusin', e => { if (e.target.matches?.('textarea[data-edit]')) grow(e.target); });
}

export const dieIcon = html`<svg viewBox="0 0 40 40" class="icon" aria-hidden="true">
  <rect x="2" y="2" width="36" height="36" rx="6" fill="#ffffff" stroke="#6b7280" stroke-width="2"/>
  <circle cx="11" cy="11" r="3.6" fill="#18181b"/><circle cx="29" cy="11" r="3.6" fill="#18181b"/>
  <circle cx="11" cy="20" r="3.6" fill="#18181b"/><circle cx="29" cy="20" r="3.6" fill="#18181b"/>
  <circle cx="11" cy="29" r="3.6" fill="#18181b"/><circle cx="29" cy="29" r="3.6" fill="#18181b"/>
</svg>`;
