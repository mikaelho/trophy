// Shared bestiary, ported from templates/bestiary.html and the bestiary part of
// trophy/alive_hooks.py. Fields lock while someone edits them, like the character sheet.
import { html, nothing } from '../../vendor/lit-html/lit-html.js';
import { repeat } from '../../vendor/lit-html/directives/repeat.js';
import { editValue, attempt, dieSvg } from '../ui.js';

const HABIT_COUNT = 6;
const LOCKED_TITLE = 'Someone is editing this';

export function bestiary(app) {
  const { data } = app;
  const monsters = data.all('monster').sort((a, b) => b.position - a.position || b.id - a.id); // newest first
  const act = (op, args) => attempt(data.op(op, args)).finally(() => app.render());

  const box = m => {
    const key = f => `monster:${m.id}:${f}`;
    const locked = f => data.lockedByOther(key(f));
    // Leaving a field saves it when changed (through the outbox) and frees its lock.
    const field = (f, current, send, render) => {
      const isLocked = locked(f);
      return render({
        cls: isLocked ? 'locked-field' : '',
        disabled: isLocked, title: isLocked ? LOCKED_TITLE : nothing,
        value: editValue(current),
        focus: () => data.lock(key(f)),
        blur: e => {
          if (e.target.value.trim() === String(current ?? '').trim()) { data.unlock(key(f)); e.target.value = e.target.defaultValue; return; }
          send(e.target.value, key(f));
        },
      });
    };
    const shown = f => data.queued('monster_save', { id: m.id, field: f }, 'value') ?? m[f];
    const save = f => (value, k) => data.edit('monster_save', { id: m.id, field: f, value }, k);
    const input = (f, cls = '', extra = {}) => field(f, shown(f), save(f), p => html`
      <input class="input ${cls} ${p.cls}" data-edit autocomplete="off" type=${extra.type || 'text'} min=${extra.min ?? nothing}
        .value=${p.value} ?disabled=${p.disabled} title=${p.title} @focus=${p.focus} @blur=${p.blur} />`);
    const habits = [...(Array.isArray(m.habits) ? m.habits : []), ...Array(HABIT_COUNT).fill('')].slice(0, HABIT_COUNT);

    return html`<div class="monster-box">
      <div class="monster-top">
        <div class="endurance"><div class="field-label">Endurance</div>${input('endurance', 'center', { type: 'number', min: 0 })}</div>
        <div class="grow"><div class="field-label">Name</div>${input('name')}</div>
        <div class="grow2"><div class="field-label">Description</div>${input('description')}</div>
        <button class="btn btn-ghost btn-xs text-error" title="Remove"
          @click=${() => { if (confirm('Remove?')) act('monster_remove', { id: m.id }); }}>&times;</button>
      </div>
      <div class="field-label">Habits</div>
      <div class="habits">${habits.map((text, i) => {
        const n = i + 1;
        const current = data.queued('monster_save_habit', { id: m.id, n }, 'value') ?? text;
        return html`<div class="habit"><span class="die habit-die">${dieSvg('light', n)}</span>${field(`habit:${n}`, current,
          (value, k) => data.edit('monster_save_habit', { id: m.id, n, value }, k), p => html`
          <input class="input input-xs ${p.cls}" data-edit autocomplete="off" .value=${p.value}
            ?disabled=${p.disabled} title=${p.title} @focus=${p.focus} @blur=${p.blur} />`)}</div>`;
      })}</div>
      <div class="monster-bottom">
        <div class="grow"><div class="field-label">Defences</div>${field('defences', shown('defences'), save('defences'), p => html`
          <textarea class="textarea ${p.cls}" rows="1" data-edit .value=${p.value}
            ?disabled=${p.disabled} title=${p.title} @focus=${p.focus} @blur=${p.blur}></textarea>`)}</div>
        <div class="weakness"><div class="field-label">Weakness</div>${input('weakness')}</div>
      </div>
    </div>`;
  };

  return html`
    <div class="page medium">
      <div class="page-head tight">
        <h1>Bestiary</h1>
        <button class="btn btn-primary btn-sm" @click=${() => act('monster_add')}>+ Add</button>
      </div>
      <div class="monsters">
        ${monsters.length ? repeat(monsters, m => m.id, box) : html`<div class="hint-text">Nothing here yet.</div>`}
      </div>
    </div>`;
}
