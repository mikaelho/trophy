// Character list and character sheet, ported from templates/character.html and the
// character part of trophy/alive_hooks.py.
import { html, nothing } from '../../vendor/lit-html/lit-html.js';
import { repeat } from '../../vendor/lit-html/directives/repeat.js';
import { live } from '../../vendor/lit-html/directives/live.js';
import { byPosition, bySlot } from '../data.js';
import { editValue, markdown, attempt, toast, dieIcon } from '../ui.js';

export const FREE_POWERS = 3, FREE_SKILLS = 4, RUIN_MAX = 6, HOARD_MAX = 50, AMMO_MAX = 3, BASE_BURDEN = 1;
const LOCKED_TITLE = 'Someone is editing this';

// --- derived values (same rules as Character.burden in models.py) ---------------

export function burdenOf(data, c) {
  const n = model => data.childrenOf(model, c.id).length;
  const base = BASE_BURDEN + Math.max(0, n('power') - FREE_POWERS) + Math.max(0, n('skill') - FREE_SKILLS)
    + n('householdmember') + n('combatitem');
  return Math.max(0, base + c.burden_offset);
}

export const characterLabel = c => {
  const name = c.name.trim() || 'Unnamed character', occ = c.occupation.trim();
  return occ ? `${name} (${occ})` : name;
};
export const sortedCharacters = data =>
  data.all('character').sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));

// --- list ------------------------------------------------------------------------

export function characterList(app) {
  const { data } = app;
  const all = sortedCharacters(data);
  const players = all.filter(c => !c.archived && !c.hireling);
  const hirelings = all.filter(c => !c.archived && c.hireling);
  const archived = all.filter(c => c.archived);
  const newCharacter = async () => {
    const r = await attempt(data.op('new_character'));
    if (r) app.nav({ view: 'character', id: r.id });
  };
  const cards = list => html`<div class="card-grid">${repeat(list, c => c.id, c => html`
    <a class="card" href=${app.href({ view: 'character', id: c.id })} @click=${app.link}>
      <h2>${characterLabel(c)}</h2>
    </a>`)}</div>`;
  return html`
    <div class="page-head">
      <h1>Trophy Characters</h1>
      <button class="btn btn-primary" @click=${newCharacter}>+ New Character</button>
    </div>
    ${all.length ? html`
      ${cards(players)}
      ${hirelings.length ? html`<h2 class="group-head">Hirelings</h2>${cards(hirelings)}` : nothing}
      ${archived.length ? html`<h2 class="group-head">Archived</h2><div class="dim">${cards(archived)}</div>` : nothing}
    ` : html`
      <div class="empty">
        <p class="big">No characters yet.</p>
        <p>Create a new character to get started.</p>
      </div>`}`;
}

// --- sheet -----------------------------------------------------------------------

export function characterSheet(app, id) {
  const { data } = app;
  const c = data.get('character', id);
  if (!c) return html`<p class="empty">This character no longer exists.
    <a href=${app.href({})} @click=${app.link}>All characters</a></p>`;

  const key = k => `${c.id}:${k}`;
  const locked = k => data.lockedByOther(key(k));
  const op = (name, args = {}, release) => attempt(data.op(name, { id: c.id, ...args }, release));

  // Leaving an edited field saves it (and frees its lock); unchanged fields just free the lock.
  const save = (field, lockKey, stored, el, send) => {
    if (el.value.trim() === String(stored ?? '').trim()) { data.unlock(lockKey); el.value = el.defaultValue; return; }
    send(el.value, lockKey);
  };
  const saveField = (field, el) => save(field, key(field), c[field], el,
    (value, k) => op('save_field', { field, value }, k));

  const lineInput = (field, cls = '', extra = {}) => html`
    <input class="input line-input ${cls} ${locked(field) ? 'locked-field' : ''}" data-edit
      type=${extra.type || 'text'} min=${extra.min ?? nothing} max=${extra.max ?? nothing}
      placeholder=${extra.placeholder ?? nothing} autocomplete="off"
      .value=${editValue(c[field])} ?disabled=${locked(field)} title=${locked(field) ? LOCKED_TITLE : nothing}
      @focus=${() => data.lock(key(field))} @blur=${e => saveField(field, e.target)} />`;

  // Markdown notes: click to edit (only when nobody else is editing), leave to save.
  const noteField = (field, rows = 2) => {
    if (app.editing === key(field)) return html`
      <textarea class="textarea" rows=${rows} data-edit data-key=${key(field)}
        .value=${editValue(c[field])}
        @blur=${e => { app.editing = null; saveField(field, e.target); app.render(); }}></textarea>`;
    const isLocked = locked(field);
    const start = async () => {
      if (isLocked) return;
      if (await data.lock(key(field))) { app.editing = key(field); app.focus(`[data-key="${key(field)}"]`); app.render(); }
      else toast(LOCKED_TITLE + '.');
    };
    return html`<div class="note-box prose ${isLocked ? 'locked-field' : ''}" title=${isLocked ? LOCKED_TITLE : nothing}
      @click=${start}>${c[field] ? markdown(c[field]) : html`<span class="placeholder">click to edit</span>`}</div>`;
  };

  // A row of a child list.
  const rowInput = (kind, item) => {
    const k = key(`${kind}:${item.id}`), isLocked = data.lockedByOther(k);
    return html`<input class="row-input ${isLocked ? 'locked-field' : ''}" data-edit autocomplete="off"
      .value=${editValue(item.name)} ?disabled=${isLocked} title=${isLocked ? LOCKED_TITLE : nothing}
      @focus=${() => data.lock(k)}
      @blur=${e => save(null, k, item.name, e.target,
        (value, lk) => attempt(data.op('rename_child', { kind, item: item.id, name: value }, lk)))} />`;
  };
  const removeBtn = (kind, item) => html`<button class="btn btn-ghost btn-xs" title="Remove"
    @click=${() => attempt(data.op('remove_child', { kind, item: item.id }))}>&times;</button>`;

  // "+ add" form: Enter adds; leaving the field with text in it adds too.
  const addForm = (kind, placeholder, withKind = false) => html`
    <form class="add-form ${withKind ? 'with-kind' : ''}"
      @submit=${e => {
        e.preventDefault();
        const f = e.target, input = f.elements.name, name = input.value.trim();
        if (!name) return;
        input.value = '';
        op('add_child', { kind, name, combat_kind: withKind ? f.elements.kind.value : undefined });
      }}
      @focusout=${e => { if (e.target.name === 'name' && e.target.value.trim()) e.currentTarget.requestSubmit(); }}>
      ${withKind ? html`<select name="kind" class="select">
        <option value="weapon">Weapon</option><option value="armor">Armour</option></select>` : nothing}
      <input class="input input-xs" name="name" placeholder=${placeholder} autocomplete="off" />
    </form>`;

  const listCard = (title, note, kind, model, free, placeholder, alwaysBurden = false) => {
    const items = data.childrenOf(model, c.id);
    return html`<div class="sheet-card">
      <div class="card-head"><div class="field-label">${title}</div><div class="hint">${note}</div></div>
      <div class="rows">${repeat(items, r => r.id, (r, i) => html`
        <div class="list-row">
          <div class="burden-bar ${alwaysBurden || i >= free ? 'on' : ''}"></div>
          ${rowInput(kind, r)}${removeBtn(kind, r)}
        </div>`)}</div>
      ${addForm(kind, placeholder)}
    </div>`;
  };

  const randomiseLook = async () => {
    const word = await app.randomDescriptor();
    if (word) op('append_look', { word });
  };
  const deleteCharacter = async () => {
    if (!confirm('Delete this character?')) return;
    if (await attempt(data.op('delete_character', { id: c.id })) !== undefined) app.nav({});
  };

  const burden = burdenOf(data, c);
  const combat = data.childrenOf('combatitem', c.id);
  const backpack = data.childrenOf('backpackitem', c.id, bySlot);
  const found = data.childrenOf('foundequipment', c.id, byPosition);

  return html`
    <div class="sheet-head">
      <a class="btn btn-ghost btn-sm" href=${app.href({})} @click=${app.link}>&larr; All characters</a>
      <div class="actions">
        <label class="check"><input type="checkbox" class="checkbox" .checked=${live(c.hireling)}
          @click=${() => op('toggle_flag', { field: 'hireling' })} /> Hireling</label>
        <label class="check"><input type="checkbox" class="checkbox" .checked=${live(c.archived)}
          @click=${() => op('toggle_flag', { field: 'archived' })} /> Archived</label>
        <button class="btn btn-ghost btn-sm text-error" @click=${deleteCharacter}>Delete</button>
      </div>
    </div>

    <div class="sheet-columns">
      <div class="sheet-card">
        <div class="name-row">
          <div class="grow"><div class="field-label">Character Name</div>${lineInput('name')}</div>
          <div class="narrow"><div class="field-label">Gender</div>${lineInput('gender')}</div>
        </div>
        <div class="field-label">Player Name</div>${lineInput('player_name', 'mb')}
        <div class="field-label">Occupation</div>${lineInput('occupation', 'mb')}
        <div class="field-label">Background</div>${lineInput('background', 'mb')}
        <div class="card-head center">
          <div class="field-label">Look</div>
          <button class="btn btn-ghost btn-xs" title="Randomise: add a descriptor" @click=${randomiseLook}>${dieIcon}</button>
        </div>
        ${lineInput('look', 'mb', { placeholder: 'a few descriptive words' })}
        <div class="field-label">Drive</div>${noteField('drive')}
      </div>

      <div class="sheet-card">
        <div class="card-head"><div class="field-label">Ruin</div><div class="field-label">Burdens</div></div>
        <div class="ruin-row">
          <div class="ruin-track">${Array.from({ length: RUIN_MAX }, (_, i) => i + 1).map(n => html`
            <div class="ruin-box ${n <= c.ruin ? 'on' : ''}" @click=${() => op('set_ruin', { n })}>${n}</div>`)}</div>
          <div class="burden">
            <button class="btn btn-ghost btn-xs" title="Lower Burdens" @click=${() => op('adjust_burden', { delta: -1 })}>&minus;</button>
            <div class="burden-value">${burden}</div>
            <button class="btn btn-ghost btn-xs" title="Raise Burdens" @click=${() => op('adjust_burden', { delta: 1 })}>+</button>
          </div>
        </div>
        <div class="number-grid">
          <span class="field-label">Coin</span>${lineInput('coin', 'number', { type: 'number', min: 0 })}
          <span class="field-label">Hunt Tokens</span>${lineInput('hunt_tokens', 'number', { type: 'number', min: 0 })}
        </div>
      </div>

      ${listCard('Skills', `${FREE_SKILLS} free`, 'skill', 'skill', FREE_SKILLS, '+ add skill')}
      ${listCard('Powers', `${FREE_POWERS} free/Ruin for all`, 'power', 'power', FREE_POWERS, '+ add power')}

      <div class="sheet-card"><div class="field-label">Conditions</div>${noteField('conditions')}</div>

      <div class="sheet-card">
        <div class="field-label">Hoard</div>
        <div class="hoard">${lineInput('hoard', 'number', { type: 'number', min: 0, max: HOARD_MAX })}
          <span class="dim-text">/ ${HOARD_MAX}</span></div>
      </div>

      ${listCard('Household', '0 free', 'household', 'householdmember', 0, '+ add detail', true)}

      <div class="sheet-card">
        <div class="card-head center"><div class="field-label">Backpack Equipment</div><div class="field-label">Uses</div></div>
        <div class="rows">${repeat(backpack, b => b.id, b => html`
          <div class="list-row center">
            ${rowInput('backpack', b)}
            <div class="stepper">
              <button class="btn btn-ghost btn-xs" @click=${() => attempt(data.op('adjust_uses', { item: b.id, delta: -1 }))}>&minus;</button>
              <span class="count">${b.uses}</span>
              <button class="btn btn-ghost btn-xs" @click=${() => attempt(data.op('adjust_uses', { item: b.id, delta: 1 }))}>+</button>
            </div>
          </div>`)}</div>
      </div>

      <div class="sheet-card">
        <div class="card-head"><div class="field-label">Combat Equipment</div><div class="hint">0 free</div></div>
        <div class="rows">${repeat(combat, r => r.id, r => html`
          <div class="list-row center">
            <div class="burden-bar on"></div>
            ${rowInput('combat', r)}
            <div class="stepper">
              ${r.kind === 'weapon' ? html`
                <span class="hint">ammo</span>
                ${Array.from({ length: AMMO_MAX }, (_, i) => i + 1).map(n => html`
                  <div class="box-btn ${n <= r.ammo ? 'on' : ''}" @click=${() => attempt(data.op('set_ammo', { item: r.id, n }))}></div>`)}
              ` : html`
                <label class="check small"><input type="checkbox" class="checkbox small" .checked=${live(r.marked)}
                  @click=${() => attempt(data.op('toggle_marked', { item: r.id }))} /> Marked</label>`}
              ${removeBtn('combat', r)}
            </div>
          </div>`)}</div>
        ${addForm('combat', '+ add combat equipment', true)}
      </div>

      <div class="sheet-card">
        <div class="field-label">Found Equipment</div>
        <div class="rows">${repeat(found, r => r.id, r => html`
          <div class="list-row">${rowInput('found', r)}${removeBtn('found', r)}</div>`)}</div>
        ${addForm('found', '+ add found equipment')}
      </div>
    </div>

    <div class="sheet-card wide">
      <div class="field-label">Notes</div>${noteField('notes', 3)}
    </div>`;
}
