// The ledger dialog of Ruin, Burdens or Coin: the value is the sum of its lines. Adding a line
// is the main thing, so its description is at the top and focused; the lines below (newest
// first) can be edited where they stand or removed (the message after has Undo). Ruin always
// ends with the "+1 Initial" line, which is not stored.
import { html, nothing } from '../../vendor/lit-html/lit-html.js';
import { repeat } from '../../vendor/lit-html/directives/repeat.js';
import { LEDGERS, LEDGER_START, ledgerEntries, ledgerTotal, ledgerProblem, parseAmount, formatAmount } from '../model/rules.js';
import { editValue, attempt, toast, modal } from '../ui.js';

const LOCKED_TITLE = 'Someone is editing this';
const BAD_AMOUNT = 'The amount must be a whole number, like +1 or -2.';

export const openLedger = (app, id, field) => { app.ledger = { id, field }; app.render(); };

export function ledgerDialog(app, c) {
  const { data } = app, field = app.ledger?.id === c.id ? app.ledger.field : null;
  if (!field || !(field in LEDGERS)) return nothing;
  const entries = [...ledgerEntries(data, c.id, field)].reverse(); // newest first
  const total = ledgerTotal(data, c.id, field);
  const name = c.name.trim() || 'Unnamed character';
  const close = e => { e.currentTarget.closest('dialog')?.close(); };

  const add = e => {
    e.preventDefault();
    const f = e.currentTarget, amount = f.elements.amount.value, description = f.elements.description.value.trim();
    if (parseAmount(amount) === null) { toast(BAD_AMOUNT); f.elements.amount.focus(); return; }
    const problem = ledgerProblem(data, c.id, field, parseAmount(amount));
    if (problem) { toast(problem); f.elements.amount.focus(); return; }
    data.edit('ledger_add', { id: c.id, field, amount, description });
    f.elements.amount.value = '+1'; f.elements.description.value = '';
    f.elements.description.focus();
  };

  const lockKey = (e, f) => `${c.id}:ledger:${e.id}:${f}`;
  const shown = (e, f) => data.queued('ledger_save', { entry: e.id, field: f }, 'value') ?? e[f];
  const cell = (e, f, cls) => {
    const k = lockKey(e, f), locked = data.lockedByOther(k);
    const value = f === 'amount' ? (() => { const n = parseAmount(shown(e, f)); return n === null ? shown(e, f) : formatAmount(n); })() : shown(e, f);
    return html`<input class="${cls} ${locked ? 'locked-field' : ''}" data-edit autocomplete="off"
      aria-label=${f === 'amount' ? 'Amount' : 'Description'} inputmode=${f === 'amount' ? 'numeric' : nothing}
      .value=${editValue(value)} ?disabled=${locked} title=${locked ? LOCKED_TITLE : nothing}
      @focus=${() => data.lock(k)}
      @blur=${ev => {
        const el = ev.target, v = el.value.trim();
        const same = f === 'amount' ? parseAmount(v) === parseAmount(shown(e, f)) : v === String(shown(e, f) ?? '').trim();
        if (same) { data.unlock(k); el.value = el.defaultValue; return; }
        const problem = f !== 'amount' ? null : parseAmount(v) === null ? BAD_AMOUNT
          : ledgerProblem(data, c.id, field, parseAmount(v) - (parseAmount(shown(e, f)) ?? 0));
        if (problem) { toast(problem); data.unlock(k); el.value = el.defaultValue; return; }
        data.edit('ledger_save', { entry: e.id, field: f, value: v }, k);
      }} />`;
  };
  const remove = e => attempt(data.op('ledger_remove', { entry: e.id })).finally(() => app.render());

  return html`<dialog class="ledger-dialog" ${modal()} aria-label=${`${LEDGERS[field]} of ${name}`}
    @close=${() => { app.ledger = null; app.render(); }}
    @click=${e => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>
    <div class="ledger-head">
      <div>
        <div class="field-label">${name}</div>
        <h2>${LEDGERS[field]}</h2>
      </div>
      <div class="ledger-total" title="Total">${total}</div>
      <button class="btn btn-ghost btn-sm" title="Close" @click=${close}>&times;</button>
    </div>
    <form class="ledger-add" @submit=${add}>
      <input class="input ledger-amount" name="amount" value="+1" autocomplete="off" aria-label="Amount" />
      <input class="input ledger-desc" name="description" autofocus autocomplete="off"
        placeholder="What for?" aria-label="Description" />
      <button class="btn btn-primary btn-sm" type="submit">Add</button>
    </form>
    <div class="ledger-rows">
      ${repeat(entries, e => e.id, e => html`<div class="ledger-row">
        ${cell(e, 'amount', 'row-input ledger-amount')}
        ${cell(e, 'description', 'row-input ledger-desc')}
        <button class="btn btn-ghost btn-xs" title="Remove line" @click=${() => remove(e)}>&times;</button>
      </div>`)}
      ${LEDGER_START[field] ? html`<div class="ledger-row fixed">
        <span class="ledger-amount">${formatAmount(LEDGER_START[field])}</span><span class="ledger-desc">Initial</span>
      </div>` : nothing}
      ${!entries.length && !LEDGER_START[field] ? html`<div class="hint ledger-empty">No lines yet.</div>` : nothing}
    </div>
  </dialog>`;
}
