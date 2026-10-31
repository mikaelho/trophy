// Shared dice roller, ported from templates/roller.html and the roller part of
// trophy/alive_hooks.py. The browser whose Roll button is clicked rolls the dice and sends
// the faces to the room, which passes them to everybody, so all see the same result.
import { html, nothing } from '../../vendor/lit-html/lit-html.js';
import { repeat } from '../../vendor/lit-html/directives/repeat.js';
import { editValue, attempt, spin, dieSvg, rollD6 } from '../ui.js';

export function roller(app) {
  const { data } = app;
  const row = data.get('roller', 1) || { mat: [], sections: [] };
  const mat = Array.isArray(row.mat) ? row.mat : [];
  const sections = Array.isArray(row.sections) ? row.sections : [];
  const act = (op, args) => attempt(data.op(op, args)).finally(() => app.render());
  // Roll every die shown here: {dieId: face}.
  const roll = dice => Object.fromEntries(dice.map(d => [d.id, rollD6()]));

  const die = d => html`<span class="die" ${spin(d.value ? `${d.value}:${d.roll || 0}` : null)}>${dieSvg(d.color, d.value)}</span>`;
  const addButtons = (onAdd, size) => ['light', 'dark'].map(color => html`
    <button class="add-die" title=${`Add a ${color} die`} @click=${() => onAdd(color)}>${dieSvg(color, null, size)}</button>`);
  const hint = small => html`<span class="hint-text ${small ? 'small' : ''}">Add light or dark dice, then Roll.</span>`;

  return html`
    <div class="page narrow">
      <h1 class="page-title">Dice Roller</h1>

      <div class="roller-bar">
        <div class="add-row"><span class="hint-label">Add</span>${addButtons(color => act('roller_add_die', { color }), 'die-svg big')}</div>
        <div class="add-row">
          <button class="btn btn-sm btn-primary" @click=${() => act('roller_roll', { values: roll(mat) })}>Roll</button>
          <button class="btn btn-sm btn-ghost" @click=${() => act('roller_clear')}>Clear mat</button>
        </div>
      </div>

      <div class="mat">${mat.length ? repeat(mat, d => d.id, die) : hint(false)}</div>

      <div class="sections-head">
        <h2 class="group-head flush">Sections</h2>
        ${sections.length ? html`<button class="btn btn-xs btn-ghost" @click=${() => act('roller_clear_sections')}>Clear sections</button>` : nothing}
      </div>
      <div class="sections">${repeat(sections, s => s.id, s => {
        const name = data.queued('roller_rename_section', { sid: s.id }, 'name') ?? s.name;
        const dice = Array.isArray(s.dice) ? s.dice : [];
        return html`<div class="section-card">
          <div class="section-name">
            <input class="roller-input" data-edit autocomplete="off" .value=${editValue(name)}
              @blur=${e => { if (e.target.value.trim() !== String(name).trim()) data.edit('roller_rename_section', { sid: s.id, name: e.target.value }); }} />
            <button class="btn btn-ghost btn-xs" title="Remove section"
              @click=${() => act('roller_remove_section', { sid: s.id })}>&times;</button>
          </div>
          <div class="section-dice">${dice.length ? repeat(dice, d => d.id, die) : hint(true)}</div>
          <div class="section-actions">
            <div class="add-row">${addButtons(color => act('roller_section_add_die', { sid: s.id, color }), 'die-svg medium')}</div>
            <div class="add-row">
              <button class="btn btn-xs btn-primary" @click=${() => act('roller_section_roll', { sid: s.id, values: roll(dice) })}>Roll</button>
              <button class="btn btn-xs btn-ghost" @click=${() => act('roller_section_clear', { sid: s.id })}>Clear</button>
            </div>
          </div>
        </div>`;
      })}</div>
      <form class="add-form section-add" @submit=${e => {
        e.preventDefault();
        const input = e.target.elements.name, name = input.value.trim();
        if (name) { input.value = ''; data.edit('roller_add_section', { name }); }
      }}>
        <input class="input input-sm" name="name" autocomplete="off" placeholder="+ add section (e.g. a character)" />
      </form>

      <h2 class="group-head">Roll Reference</h2>
      <div class="ref-cards">${REFERENCE}</div>
    </div>`;
}

const REFERENCE = html`
  <div class="ref-card">
    <div class="ref-title">Hunt Roll</div>
    <div class="ref-sub">Explore your environment</div>
    <ul>
      <li>1 <b>light</b> die for exploring and asking the GM questions.</li>
      <li>+1 <b>light</b> die if a Skill or Equipment eases the hunt.</li>
      <li>Read the <b>highest</b> die:
        <ul>
          <li>1 — lose all Hunt Tokens; encounter something terrible.</li>
          <li>2–3 — encounter something terrible.</li>
          <li>4–5 — gain 1 Hunt Token, and encounter something terrible.</li>
          <li>6 — gain 1 Hunt Token.</li>
        </ul>
      </li>
      <li>The GM answers your questions regardless of the roll.</li>
    </ul>
  </div>
  <div class="ref-card">
    <div class="ref-title">Risk Roll</div>
    <div class="ref-sub">Before trying something risky</div>
    <ul>
      <li>Say what you hope <b>will happen</b>.</li>
      <li>Ask the GM and players <b>what could go wrong</b>.</li>
      <li>1 <b>light</b> die if skilled (Occupation/Background) or with useful Equipment.</li>
      <li>+1 <b>light</b> die for accepting a Devil's Bargain.</li>
      <li>1 <b>dark</b> die if risking mind or body (required for Powers).</li>
      <li>Did a <b>dark</b> die meet or beat the highest <b>light</b> die?
        <ul>
          <li>Yes — if that dark die beats your Ruin, mark 1 Ruin.</li>
          <li>No — you may risk mind/body to re-roll with +1 dark die.</li>
        </ul>
      </li>
      <li>Read the <b>highest</b> die: 1–3 fail · 4–5 success with a complication · 6 success.</li>
    </ul>
  </div>
  <div class="ref-card">
    <div class="ref-title">Combat Roll</div>
    <div class="ref-sub">Defeat a monster together</div>
    <ul>
      <li>Decide who participates.</li>
      <li>Each participant says how they're vulnerable and rolls 1 <b>light</b> die — their Weak Point.</li>
      <li>1 <b>dark</b> die per attacker with a usable weapon.</li>
      <li>Did any <b>dark</b> die match a Weak Point?
        <ul>
          <li>Mark 1 Ruin per match, or mark a piece of Armor to avoid all Ruin.</li>
        </ul>
      </li>
      <li>Do the two highest <b>dark</b> dice total the monster's Endurance or more?
        <ul>
          <li>Yes — success, the monster is defeated.</li>
          <li>No — risk more: +1 dark die and re-roll.</li>
        </ul>
      </li>
      <li>Harvest: roll dice equal to the monster's Endurance; each 6 scavenges 1 Coin.</li>
    </ul>
  </div>
  <div class="ref-card">
    <div class="ref-title">Contest Roll</div>
    <div class="ref-sub">Scavengers against each other</div>
    <ul>
      <li>Agree on what is at stake.</li>
      <li>Each player: 1 <b>light</b> die if a Skill or Equipment helps.</li>
      <li>+1 <b>light</b> die per mark of Ruin you currently have.</li>
      <li>1 <b>dark</b> die if the contest is deadly — take as many as you dare.</li>
      <li>Most 6s wins (ties: most 5s, then 4s, and so on).</li>
      <li>For each <b>dark</b> die showing a 1, mark 1 Ruin.</li>
    </ul>
  </div>
  <div class="ref-card">
    <div class="ref-title">Help Roll</div>
    <div class="ref-sub">Aid another player's Risk Roll</div>
    <ul>
      <li>You may help when their Risk Roll includes at least one <b>dark</b> die.</li>
      <li>Say how you expose yourself to danger, then roll 1 <b>light</b> die.</li>
      <li>They may use your <b>light</b> die in their roll.</li>
      <li>Does your <b>light</b> die match any <b>dark</b> die in their roll?
        <ul>
          <li>Yes — mark 1 Ruin.</li>
        </ul>
      </li>
    </ul>
  </div>`;
