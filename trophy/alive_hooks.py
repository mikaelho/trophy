"""Live event handlers and data loading for the Trophy character sheet.

The whole sheet is one custom template (``character.html``) driven by a single
``event_handler``. All ORM access is wrapped in ``sync_to_async`` and every
value coming from a form field (blur / change / submit) is unwrapped from the
one-element list PyView sends.
"""

import secrets
from pathlib import Path
from random import randint, choice

from asgiref.sync import sync_to_async
from django.apps import apps
from markupsafe import Markup, escape

from alive.components.editable_field import render_markdown_safe
from alive.store import get_store, acquire_lock, release_lock, get_lock_holder

from .context import TrophyContext
from .models import (
    FREE_POWERS,
    FREE_SKILLS,
    BACKPACK_SLOTS,
    RUIN_MAX,
    HOARD_MAX,
    AMMO_MAX,
)

# kind -> model name for the reverse-FK child lists
CHILD_MODELS = {
    "power": "Power",
    "skill": "Skill",
    "household": "HouseholdMember",
    "combat": "CombatItem",
    "found": "FoundEquipment",
    "backpack": "BackpackItem",
}

# Scalar Character fields editable straight from the sheet
TEXT_FIELDS = {
    "name", "gender", "player_name", "occupation", "background", "look",
    "drive", "conditions", "notes",
}
INT_FIELDS = {"hoard", "coin", "hunt_tokens"}

# Placeholder shown for an empty markdown field (precomputed so the template
# needs no nested {% if %} inside a branch -- nested conditionals confuse the
# LiveView diff when a branch flips, rendering "undefined").
_CLICK_TO_EDIT = Markup('<span class="opacity-40 italic">click to edit</span>')


# --- edit locks -----------------------------------------------------------
# While a user has a field focused it holds an in-memory lock, so other viewers
# see that field as being edited (read-only + highlighted). Every lock for a
# sheet is namespaced under the Character model channel (item_id = char pk) so a
# single subscription and alive's disconnect cleanup cover the whole sheet;
# child-list rows use the key "<kind>:<row id>".

def _char_lock_label():
    return get_store(apps.get_model('trophy', 'Character')).model_label


def _apply_locks(data, char_id, sid):
    """Annotate the sheet dict with per-field ``*_locked`` / ``locked`` flags
    for anything currently held by another session."""
    label = _char_lock_label()
    cid = str(char_id)

    def held_by_other(key):
        holder = get_lock_holder(label, cid, key)
        return holder is not None and holder != sid

    char = data["char"]
    for f in TEXT_FIELDS | INT_FIELDS:
        char[f + "_locked"] = held_by_other(f)

    for list_key, kind in (("skills", "skill"), ("powers", "power"),
                           ("household", "household"), ("backpack", "backpack"),
                           ("combat", "combat"), ("found", "found")):
        for it in data[list_key]:
            it["locked"] = held_by_other(f"{kind}:{it['id']}")


def _val(payload, key, default=""):
    """Read a payload value, unwrapping the one-element list forms send."""
    v = payload.get(key, default)
    if isinstance(v, list):
        v = v[0] if v else default
    return v


def _int(value, default=0):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


# --- data loading ---------------------------------------------------------

@sync_to_async(thread_sensitive=False)
def _fetch_sheet(pk):
    Character = apps.get_model('trophy', 'Character')
    try:
        ch = Character.objects.get(pk=pk)
    except Character.DoesNotExist:
        return None

    def rows(items, free):
        return [
            {"id": it.id, "name": it.name, "over_free": idx >= free}
            for idx, it in enumerate(items)
        ]

    powers = list(ch.powers.all())
    skills = list(ch.skills.all())
    household = list(ch.household.all())
    combat = list(ch.combat.all())
    found = list(ch.found.all())
    backpack = list(ch.backpack.all())

    char = {
        "id": ch.id,
        "name": ch.name,
        "gender": ch.gender,
        "player_name": ch.player_name,
        "occupation": ch.occupation,
        "background": ch.background,
        "look": ch.look,
        "drive": ch.drive,
        "drive_display": render_markdown_safe(ch.drive) if ch.drive else _CLICK_TO_EDIT,
        "conditions": ch.conditions,
        "conditions_display": render_markdown_safe(ch.conditions) if ch.conditions else _CLICK_TO_EDIT,
        "notes": ch.notes,
        "notes_display": render_markdown_safe(ch.notes) if ch.notes else _CLICK_TO_EDIT,
        "hoard": ch.hoard,
        "coin": ch.coin,
        "hunt_tokens": ch.hunt_tokens,
        "hireling": ch.hireling,
        "archived": ch.archived,
    }

    return {
        "char": char,
        "char_id": ch.id,
        "powers": rows(powers, FREE_POWERS),
        "skills": rows(skills, FREE_SKILLS),
        "household": rows(household, 0),
        "found": [{"id": f.id, "name": f.name} for f in found],
        "combat": [
            {
                "id": c.id, "name": c.name, "kind": c.kind,
                "has_ammo": c.kind == "weapon",
                "marked": c.marked, "ammo": c.ammo,
                "ammo_boxes": [{"n": n, "on": n <= c.ammo} for n in range(1, AMMO_MAX + 1)],
            }
            for c in combat
        ],
        "backpack": [
            {"id": b.id, "name": b.name, "uses": b.uses}
            for b in backpack
        ],
        "ruin": ch.ruin,
        "burden": ch.burden,
        "ruin_boxes": [
            {"n": n, "on": n <= ch.ruin, "locked": n == 1}
            for n in range(1, RUIN_MAX + 1)
        ],
    }


@sync_to_async(thread_sensitive=False)
def _fetch_character_list():
    """Return (player_characters, hirelings, archived) as three label lists."""
    Character = apps.get_model('trophy', 'Character')
    players, hirelings, archived = [], [], []
    for ch in Character.objects.all():
        name = ch.name.strip() or "Unnamed character"
        occ = ch.occupation.strip()
        item = {"id": ch.id, "label": f"{name} ({occ})" if occ else name}
        bucket = archived if ch.archived else (hirelings if ch.hireling else players)
        bucket.append(item)
    return players, hirelings, archived


async def _load_sheet(socket):
    """Populate the sheet context from the character in ``?detail=<pk>``.

    In list mode (no detail), load the character list instead."""
    ctx = socket.context
    pk = getattr(ctx, "detail_item_id", None)
    if not pk:
        ctx.char = {}
        ctx.char_id = None
        ctx.character_list, ctx.hireling_list, ctx.archived_list = await _fetch_character_list()
        return
    data = await _fetch_sheet(int(pk))
    if data is None:
        ctx.char = {}
        ctx.char_id = None
        ctx.character_list, ctx.hireling_list, ctx.archived_list = await _fetch_character_list()
        return
    _apply_locks(data, int(pk), ctx.session_id)
    for key, value in data.items():
        setattr(ctx, key, value)


async def _refresh(socket):
    await socket.liveview._refresh_view_async(socket)


async def _broadcast(socket):
    Character = apps.get_model('trophy', 'Character')
    await socket.broadcast(get_store(Character).channel, {"action": "state_changed"})


async def _sync(socket):
    """Reload the sheet locally and notify other connected clients."""
    await _refresh(socket)
    await _broadcast(socket)


# --- mutations ------------------------------------------------------------

@sync_to_async(thread_sensitive=False)
def _save_scalar(pk, field, value):
    Character = apps.get_model('trophy', 'Character')
    try:
        ch = Character.objects.get(pk=pk)
    except Character.DoesNotExist:
        return
    setattr(ch, field, value)
    ch.save(update_fields=[field])


@sync_to_async(thread_sensitive=False)
def _set_ruin(pk, n):
    Character = apps.get_model('trophy', 'Character')
    try:
        ch = Character.objects.get(pk=pk)
    except Character.DoesNotExist:
        return
    # Clicking the current level clears down to it; box 1 always stays ticked.
    new = n - 1 if n == ch.ruin else n
    ch.ruin = max(1, min(RUIN_MAX, new))
    ch.save(update_fields=["ruin"])


@sync_to_async(thread_sensitive=False)
def _bump_ruin(pk, delta):
    Character = apps.get_model('trophy', 'Character')
    ch = Character.objects.filter(pk=pk).first()
    if ch:
        ch.ruin = max(1, min(RUIN_MAX, ch.ruin + delta))
        ch.save(update_fields=["ruin"])


@sync_to_async(thread_sensitive=False)
def _add_child(pk, kind, name, extra=None):
    Model = apps.get_model('trophy', CHILD_MODELS[kind])
    last = Model.objects.filter(character_id=pk).order_by("-position").first()
    position = (last.position + 1) if last else 0
    fields = {"character_id": pk, "name": name, "position": position}
    if extra:
        fields.update(extra)
    Model.objects.create(**fields)


@sync_to_async(thread_sensitive=False)
def _rename_child(kind, item_id, name):
    Model = apps.get_model('trophy', CHILD_MODELS[kind])
    Model.objects.filter(pk=item_id).update(name=name)


@sync_to_async(thread_sensitive=False)
def _remove_child(kind, item_id):
    Model = apps.get_model('trophy', CHILD_MODELS[kind])
    Model.objects.filter(pk=item_id).delete()


@sync_to_async(thread_sensitive=False)
def _toggle_marked(item_id):
    CombatItem = apps.get_model('trophy', 'CombatItem')
    it = CombatItem.objects.filter(pk=item_id).first()
    if it:
        it.marked = not it.marked
        it.save(update_fields=["marked"])


@sync_to_async(thread_sensitive=False)
def _set_ammo(item_id, n):
    CombatItem = apps.get_model('trophy', 'CombatItem')
    it = CombatItem.objects.filter(pk=item_id).first()
    if it:
        new = n - 1 if n == it.ammo else n
        it.ammo = max(0, min(AMMO_MAX, new))
        it.save(update_fields=["ammo"])


@sync_to_async(thread_sensitive=False)
def _adjust_uses(item_id, delta):
    BackpackItem = apps.get_model('trophy', 'BackpackItem')
    it = BackpackItem.objects.filter(pk=item_id).first()
    if it:
        it.uses = max(0, it.uses + delta)
        it.save(update_fields=["uses"])


@sync_to_async(thread_sensitive=False)
def _adjust_burden(pk, delta):
    Character = apps.get_model('trophy', 'Character')
    ch = Character.objects.filter(pk=pk).first()
    if not ch:
        return
    # +/- moves the displayed total (floored at 0); the offset absorbs the gap
    # so automatic list contributions still shift the total afterwards.
    new_total = max(0, ch.burden + delta)
    ch.burden_offset = new_total - ch.burden_base
    ch.save(update_fields=["burden_offset"])


@sync_to_async(thread_sensitive=False)
def _toggle_hireling(pk):
    Character = apps.get_model('trophy', 'Character')
    ch = Character.objects.filter(pk=pk).first()
    if ch:
        ch.hireling = not ch.hireling
        ch.save(update_fields=["hireling"])


@sync_to_async(thread_sensitive=False)
def _toggle_archived(pk):
    Character = apps.get_model('trophy', 'Character')
    ch = Character.objects.filter(pk=pk).first()
    if ch:
        ch.archived = not ch.archived
        ch.save(update_fields=["archived"])


@sync_to_async(thread_sensitive=False)
def _create_blank_character():
    Character = apps.get_model('trophy', 'Character')
    BackpackItem = apps.get_model('trophy', 'BackpackItem')
    ch = Character.objects.create(name="")
    for i in range(BACKPACK_SLOTS):
        BackpackItem.objects.create(character=ch, slot=i, position=i)
    return ch.id


# --- event handler --------------------------------------------------------

async def trophy_event_handler(event, payload, socket):
    ctx = socket.context
    pk = getattr(ctx, "detail_item_id", None)

    # Randomise the Look field: append one descriptor from anywhere in the file.
    if event == "randomise_look":
        if pk and _DESCRIPTORS:
            await _append_look(int(pk), _random_descriptor())
            await _sync(socket)
        return True

    # Toggle whether this character is a Hireling.
    if event == "toggle_hireling":
        if pk:
            await _toggle_hireling(int(pk))
            await _sync(socket)
        return True

    # Toggle whether this character is Archived.
    if event == "toggle_archived":
        if pk:
            await _toggle_archived(int(pk))
            await _sync(socket)
        return True

    # Create a blank character and open its sheet (no name prompt).
    if event == "new_character":
        new_id = await _create_blank_character()
        await socket.push_navigate("/alive/character/", {"detail": new_id})
        return True

    # Take the edit lock when a field gains focus, so other viewers see it as
    # being edited (read-only + highlighted). Released on blur below.
    if event == "lock_field":
        key = _val(payload, "key")
        if pk and key:
            acquire_lock(_char_lock_label(), str(pk), key, ctx.session_id)
            await _sync(socket)
        return True

    # Scalar field save (one-line inputs + markdown textareas on blur)
    if event == "save_field":
        field = _val(payload, "field")
        value = _val(payload, "value")
        if pk and field in TEXT_FIELDS:
            await _save_scalar(int(pk), field, value.strip() if isinstance(value, str) else value)
        elif pk and field in INT_FIELDS:
            n = max(0, _int(value, 0))
            if field == "hoard":
                n = min(n, HOARD_MAX)
            await _save_scalar(int(pk), field, n)
        if pk and field:
            release_lock(_char_lock_label(), str(pk), field, ctx.session_id)
        ctx.editing_field = ""
        await _sync(socket)
        return True

    # Click a markdown block to start editing it (only if no one else holds it)
    if event == "edit_field":
        field = _val(payload, "field")
        if pk and field and acquire_lock(_char_lock_label(), str(pk), field, ctx.session_id):
            ctx.editing_field = field
            await _sync(socket)
        return True

    if event == "stop_edit":
        field = ctx.editing_field
        if pk and field:
            release_lock(_char_lock_label(), str(pk), field, ctx.session_id)
        ctx.editing_field = ""
        await _sync(socket)
        return True

    # Burdens: manual +/- on top of the derived value
    if event == "adjust_burden":
        delta = _int(_val(payload, "delta"))
        if pk and delta:
            await _adjust_burden(int(pk), delta)
            await _sync(socket)
        return True

    # Ruin track
    if event == "set_ruin":
        n = _int(_val(payload, "n"))
        if pk and n:
            await _set_ruin(int(pk), n)
            await _sync(socket)
        return True

    # Add a list item
    if event in ("add_power", "add_skill", "add_household", "add_combat", "add_found"):
        kind = event[len("add_"):]
        name = _val(payload, "name").strip()
        if pk and name:
            extra = None
            if kind == "combat":
                requested = _val(payload, "kind")
                extra = {"kind": requested if requested in ("armor", "weapon") else "armor"}
            await _add_child(int(pk), kind, name, extra)
            if kind == "power":             # each power raises Ruin by 1
                await _bump_ruin(int(pk), 1)
            await _sync(socket)
        return True

    if event == "rename_child":
        kind = _val(payload, "kind")
        item_id = _int(_val(payload, "id"))
        if kind in CHILD_MODELS and item_id:
            await _rename_child(kind, item_id, _val(payload, "value").strip())
            if pk:
                release_lock(_char_lock_label(), str(pk), f"{kind}:{item_id}", ctx.session_id)
            await _sync(socket)
        return True

    if event == "remove_child":
        kind = _val(payload, "kind")
        item_id = _int(_val(payload, "id"))
        if kind in CHILD_MODELS and item_id:
            await _remove_child(kind, item_id)
            if kind == "power" and pk:       # removing a power lowers Ruin by 1
                await _bump_ruin(int(pk), -1)
            await _sync(socket)
        return True

    if event == "toggle_marked":
        item_id = _int(_val(payload, "id"))
        if item_id:
            await _toggle_marked(item_id)
            await _sync(socket)
        return True

    if event == "set_ammo":
        item_id = _int(_val(payload, "id"))
        n = _int(_val(payload, "n"))
        if item_id and n:
            await _set_ammo(item_id, n)
            await _sync(socket)
        return True

    if event == "adjust_uses":
        item_id = _int(_val(payload, "id"))
        delta = _int(_val(payload, "delta"))
        if item_id and delta:
            await _adjust_uses(item_id, delta)
            await _sync(socket)
        return True

    # Everything else (start_create/save_create/grid_navigate/delete_item ...)
    # falls through to alive's built-in handling.
    return False


# --- lifecycle hooks ------------------------------------------------------

async def trophy_mount_hook(socket, session):
    ctx = socket.context
    ctx.free_powers = FREE_POWERS
    ctx.free_skills = FREE_SKILLS
    ctx.hoard_max = HOARD_MAX


async def trophy_params_hook(socket, url, params):
    await _load_sheet(socket)


async def trophy_refresh_hook(socket):
    await _load_sheet(socket)


async def _character_post_create(socket, item):
    """Give every new character its fixed backpack slots."""
    @sync_to_async(thread_sensitive=False)
    def _seed():
        BackpackItem = apps.get_model('trophy', 'BackpackItem')
        for i in range(BACKPACK_SLOTS):
            BackpackItem.objects.create(character=item, slot=i, position=i)
    await _seed()


# ==========================================================================
# Shared dice roller
# ==========================================================================

_DIE_PIPS = {
    1: [(20, 20)],
    2: [(29, 11), (11, 29)],
    3: [(29, 11), (20, 20), (11, 29)],
    4: [(11, 11), (29, 11), (11, 29), (29, 29)],
    5: [(11, 11), (29, 11), (20, 20), (11, 29), (29, 29)],
    6: [(11, 11), (29, 11), (11, 20), (29, 20), (11, 29), (29, 29)],
}


def _uid():
    return secrets.token_hex(4)


def render_die(color, value):
    """SVG d6 face (pip layout borrowed from cardplay). Light = pale face with
    dark pips; dark = dark face with pale pips. No value -> blank face."""
    if color == "light":
        face = ('<rect x="2" y="2" width="36" height="36" rx="6" '
                'class="die-face-light"/>')
        pip_cls = "die-pip-light"
    else:
        face = ('<rect x="2" y="2" width="36" height="36" rx="6" '
                'class="die-face-dark"/>')
        pip_cls = "die-pip-dark"
    # An unrolled die shows a full six-pip face rather than a blank square.
    pips = "".join(
        f'<circle cx="{x}" cy="{y}" r="3.6" class="{pip_cls}"/>'
        for x, y in _DIE_PIPS.get(value or 6, [])
    )
    return Markup(
        f'<svg viewBox="0 0 40 40" class="w-9 h-9">{face}{pips}</svg>'
    )


def _die_view(d):
    return {
        "id": d["id"],
        "color": d["color"],
        "value": d.get("value"),
        "v": d.get("value") or "",
        "svg": render_die(d["color"], d.get("value")),
    }


@sync_to_async(thread_sensitive=False)
def _fetch_roller():
    Roller = apps.get_model('trophy', 'Roller')
    r, _ = Roller.objects.get_or_create(pk=1)
    return {
        "roller_mat": [_die_view(d) for d in r.mat],
        "roller_sections": [
            {"id": s["id"], "name": s.get("name", ""),
             "dice": [_die_view(d) for d in s.get("dice", [])]}
            for s in r.sections
        ],
    }


async def _load_roller(socket):
    data = await _fetch_roller()
    for key, value in data.items():
        setattr(socket.context, key, value)


def _roller():
    Roller = apps.get_model('trophy', 'Roller')
    r, _ = Roller.objects.get_or_create(pk=1)
    return r


@sync_to_async(thread_sensitive=False)
def _roller_add_die(color):
    r = _roller()
    r.mat.append({"id": _uid(), "color": color, "value": None})
    r.save(update_fields=["mat", "updated_at"])


@sync_to_async(thread_sensitive=False)
def _roller_roll():
    # Only the central mat is rolled here; each section has its own Roll.
    r = _roller()
    for d in r.mat:
        d["value"] = randint(1, 6)
    r.save(update_fields=["mat", "updated_at"])


@sync_to_async(thread_sensitive=False)
def _roller_clear():
    r = _roller()
    r.mat = []                      # section dice are left untouched
    r.save(update_fields=["mat", "updated_at"])


@sync_to_async(thread_sensitive=False)
def _roller_section_add_die(sid, color):
    # Add an unrolled die to the section (rolled later via the section's Roll).
    r = _roller()
    for s in r.sections:
        if s["id"] == sid:
            s.setdefault("dice", []).append({"id": _uid(), "color": color, "value": None})
    r.save(update_fields=["sections", "updated_at"])


@sync_to_async(thread_sensitive=False)
def _roller_section_roll(sid):
    r = _roller()
    for s in r.sections:
        if s["id"] == sid:
            for d in s.get("dice", []):
                d["value"] = randint(1, 6)
    r.save(update_fields=["sections", "updated_at"])


@sync_to_async(thread_sensitive=False)
def _roller_section_clear(sid):
    r = _roller()
    for s in r.sections:            # keep the section name, drop its dice
        if s["id"] == sid:
            s["dice"] = []
    r.save(update_fields=["sections", "updated_at"])


@sync_to_async(thread_sensitive=False)
def _roller_clear_sections():
    r = _roller()
    for s in r.sections:            # keep the section names, drop their dice
        s["dice"] = []
    r.save(update_fields=["sections", "updated_at"])


@sync_to_async(thread_sensitive=False)
def _roller_add_section(name):
    r = _roller()
    r.sections.append({"id": _uid(), "name": name, "dice": []})
    r.save(update_fields=["sections", "updated_at"])


@sync_to_async(thread_sensitive=False)
def _roller_remove_section(sid):
    r = _roller()
    r.sections = [s for s in r.sections if s["id"] != sid]
    r.save(update_fields=["sections", "updated_at"])


@sync_to_async(thread_sensitive=False)
def _roller_rename_section(sid, name):
    r = _roller()
    for s in r.sections:
        if s["id"] == sid:
            s["name"] = name
    r.save(update_fields=["sections", "updated_at"])


async def _roller_sync(socket):
    """Reload locally and notify every other client on the Roller channel."""
    await _refresh(socket)
    Roller = apps.get_model('trophy', 'Roller')
    await socket.broadcast(get_store(Roller).channel, {"action": "state_changed"})


async def roller_event_handler(event, payload, socket):
    if event == "roller_add_die":
        color = _val(payload, "color")
        if color in ("light", "dark"):
            await _roller_add_die(color)
            await _roller_sync(socket)
        return True

    if event == "roller_roll":
        await _roller_roll()
        await _roller_sync(socket)
        return True

    if event == "roller_clear":
        await _roller_clear()
        await _roller_sync(socket)
        return True

    if event == "roller_section_add_die":
        sid = _val(payload, "id")
        color = _val(payload, "color")
        if sid and color in ("light", "dark"):
            await _roller_section_add_die(sid, color)
            await _roller_sync(socket)
        return True

    if event == "roller_section_roll":
        sid = _val(payload, "id")
        if sid:
            await _roller_section_roll(sid)
            await _roller_sync(socket)
        return True

    if event == "roller_section_clear":
        sid = _val(payload, "id")
        if sid:
            await _roller_section_clear(sid)
            await _roller_sync(socket)
        return True

    if event == "roller_clear_sections":
        await _roller_clear_sections()
        await _roller_sync(socket)
        return True

    if event == "roller_add_section":
        name = _val(payload, "name").strip()
        if name:
            await _roller_add_section(name)
            await _roller_sync(socket)
        return True

    if event == "roller_remove_section":
        sid = _val(payload, "id")
        if sid:
            await _roller_remove_section(sid)
            await _roller_sync(socket)
        return True

    if event == "roller_rename_section":
        sid = _val(payload, "id")
        name = _val(payload, "value").strip()
        if sid:
            await _roller_rename_section(sid, name)
            await _roller_sync(socket)
        return True

    return False


async def roller_load_hook(socket, *args):
    await _load_roller(socket)


# ==========================================================================
# Equipment tables (rolled from the Markdown files in trophy/lists/)
# ==========================================================================

LISTS_DIR = Path(__file__).resolve().parent / "lists"

# Display order on the Equipment page (unknown files fall to the end, A-Z).
_EQUIPMENT_ORDER = ["expedition_items", "weaponry", "backpack_items"]

# {key: {"title": str, "rows": [(d1, ("exact"|"range", ...), [items])]}}
_EQUIPMENT_TABLES = {}


def _parse_table_md(text, fallback_title):
    title = fallback_title
    got_title = False
    rows = []
    for line in text.splitlines():
        stripped = line.strip()
        if not got_title and stripped.startswith("#"):
            title = stripped.lstrip("#").strip()
            got_title = True
            continue
        if not stripped.startswith("|"):
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if len(cells) < 3:
            continue
        try:
            d1 = int(cells[0])
        except ValueError:
            continue  # header or separator row
        d2raw = cells[1].replace("–", "-").replace("—", "-")
        if "-" in d2raw:
            lo, hi = d2raw.split("-", 1)
            try:
                spec = ("range", int(lo), int(hi))
            except ValueError:
                continue
        else:
            try:
                spec = ("exact", int(d2raw))
            except ValueError:
                continue
        items = [c for c in cells[2:] if c]
        rows.append((d1, spec, items))
    return {"title": title, "rows": rows}


def _order_key(key):
    idx = _EQUIPMENT_ORDER.index(key) if key in _EQUIPMENT_ORDER else len(_EQUIPMENT_ORDER)
    return (idx, key)


def load_equipment_tables():
    """Parse every trophy/lists/*.md d6/d6 table (called at startup). Files with
    no table rows (e.g. character_descriptors.md) are skipped."""
    _EQUIPMENT_TABLES.clear()
    if not LISTS_DIR.is_dir():
        return
    for path in sorted(LISTS_DIR.glob("*.md"), key=lambda p: _order_key(p.stem)):
        key = path.stem
        fallback = key.replace("_", " ").title()
        table = _parse_table_md(path.read_text(encoding="utf-8"), fallback)
        if table["rows"]:
            _EQUIPMENT_TABLES[key] = table


# --- Character descriptors (for the Look randomiser) ----------------------

# section name -> [descriptor words]
_DESCRIPTORS = {}


def load_descriptors():
    """Parse trophy/lists/character_descriptors.md into its sections
    (LOOK / SOUND / SMELL), each a flat list of words."""
    _DESCRIPTORS.clear()
    path = LISTS_DIR / "character_descriptors.md"
    if not path.exists():
        return
    current = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        s = raw.strip()
        if not s or all(c == "-" for c in s):
            continue  # blank line or a --- separator
        if s.isupper():                     # section header (LOOK, SOUND, SMELL)
            current = s.title()
            _DESCRIPTORS[current] = []
            continue
        if current:
            _DESCRIPTORS[current].append(s)


def _random_descriptor():
    """One random descriptor from anywhere in the file (any section)."""
    pool = [w for words in _DESCRIPTORS.values() for w in words]
    return choice(pool) if pool else ""


@sync_to_async(thread_sensitive=False)
def _append_look(pk, word):
    Character = apps.get_model('trophy', 'Character')
    ch = Character.objects.filter(pk=pk).first()
    if not ch or not word:
        return
    existing = ch.look.strip()
    ch.look = (existing + ", " + word) if existing else word
    ch.save(update_fields=["look"])


def _lookup_equipment(key, d1, d2):
    """Return (items, is_range) for the matched row."""
    table = _EQUIPMENT_TABLES.get(key)
    if not table:
        return [], False
    for row_d1, spec, items in table["rows"]:
        if row_d1 != d1:
            continue
        if spec[0] == "exact" and spec[1] == d2:
            return items, False
        if spec[0] == "range" and spec[1] <= d2 <= spec[2]:
            return items, True
    return [], False


def _roll_equipment(key):
    """Roll 2d6 and resolve the result once (stored so it is stable on refresh).

    Range tables (e.g. Expedition Items) yield a deliberate set of items -> show
    all; exact tables yield a single item (a lone item, or one random column)."""
    d1, d2 = randint(1, 6), randint(1, 6)
    items, is_range = _lookup_equipment(key, d1, d2)
    if not items:
        result = "—"
    elif is_range:
        result = " · ".join(items)
    else:
        result = choice(items)
    return {"d1": d1, "d2": d2, "result": result}


async def _load_equipment(socket):
    ctx = socket.context
    rows = []
    for key, table in _EQUIPMENT_TABLES.items():
        roll = ctx.equipment_rolls.get(key)
        d1 = d2 = None
        result = ""
        if roll:
            d1, d2, result = roll["d1"], roll["d2"], roll["result"]
        rows.append({
            "key": key,
            "title": table["title"],
            "d1_id": f"eq-{key}-1",
            "d2_id": f"eq-{key}-2",
            "d1_svg": render_die("light", d1),
            "d2_svg": render_die("light", d2),
            "d1_v": d1 or "",
            "d2_v": d2 or "",
            "result": result,
        })
    ctx.equipment_rows = rows


async def equipment_event_handler(event, payload, socket):
    if event == "equipment_roll":
        key = _val(payload, "key")
        if key in _EQUIPMENT_TABLES:
            rolls = dict(socket.context.equipment_rolls)
            rolls[key] = _roll_equipment(key)
            socket.context.equipment_rolls = rolls
            await _load_equipment(socket)
            await _refresh(socket)
        return True
    return False


async def equipment_load_hook(socket, *args):
    await _load_equipment(socket)


# ==========================================================================
# Bestiary (shared, party-wide list of monster boxes)
# ==========================================================================

from .models import HABIT_COUNT

BESTIARY_TEXT_FIELDS = {"name", "description", "defences", "weakness"}


@sync_to_async(thread_sensitive=False)
def _fetch_monsters():
    Monster = apps.get_model('trophy', 'Monster')
    out = []
    for m in Monster.objects.order_by("-position", "-id"):   # newest first
        habits = list(m.habits or [])
        habits = (habits + [""] * HABIT_COUNT)[:HABIT_COUNT]
        out.append({
            "id": m.id,
            "endurance": m.endurance,
            "name": m.name,
            "description": m.description,
            "defences": m.defences,
            "weakness": m.weakness,
            "habits": [
                {"n": i + 1, "text": habits[i], "svg": render_die("light", i + 1)}
                for i in range(HABIT_COUNT)
            ],
        })
    return out


def _monster_lock_label():
    return get_store(apps.get_model('trophy', 'Monster')).model_label


async def _load_bestiary(socket):
    monsters = await _fetch_monsters()
    sid = socket.context.session_id
    label = _monster_lock_label()

    def held_by_other(mid, key):
        holder = get_lock_holder(label, str(mid), key)
        return holder is not None and holder != sid

    for m in monsters:
        for f in BESTIARY_TEXT_FIELDS | {"endurance"}:
            m[f + "_locked"] = held_by_other(m["id"], f)
        for h in m["habits"]:
            h["locked"] = held_by_other(m["id"], f"habit:{h['n']}")
    socket.context.monsters = monsters


async def _bestiary_sync(socket):
    await _refresh(socket)
    Monster = apps.get_model('trophy', 'Monster')
    await socket.broadcast(get_store(Monster).channel, {"action": "state_changed"})


@sync_to_async(thread_sensitive=False)
def _bestiary_add():
    Monster = apps.get_model('trophy', 'Monster')
    last = Monster.objects.order_by("-position").first()
    pos = (last.position + 1) if last else 0
    Monster.objects.create(position=pos, habits=[""] * HABIT_COUNT)


@sync_to_async(thread_sensitive=False)
def _bestiary_remove(mid):
    apps.get_model('trophy', 'Monster').objects.filter(pk=mid).delete()


@sync_to_async(thread_sensitive=False)
def _bestiary_save(mid, field, value):
    apps.get_model('trophy', 'Monster').objects.filter(pk=mid).update(**{field: value})


@sync_to_async(thread_sensitive=False)
def _bestiary_save_habit(mid, n, value):
    Monster = apps.get_model('trophy', 'Monster')
    m = Monster.objects.filter(pk=mid).first()
    if not m:
        return
    habits = list(m.habits or [])
    habits = (habits + [""] * HABIT_COUNT)[:HABIT_COUNT]
    habits[n - 1] = value
    m.habits = habits
    m.save(update_fields=["habits"])


async def bestiary_event_handler(event, payload, socket):
    if event == "bestiary_add":
        await _bestiary_add()
        await _bestiary_sync(socket)
        return True

    if event == "bestiary_remove":
        mid = _int(_val(payload, "id"))
        if mid:
            await _bestiary_remove(mid)
            await _bestiary_sync(socket)
        return True

    # Take the edit lock when a monster field gains focus; released on blur.
    if event == "bestiary_lock":
        mid = _int(_val(payload, "id"))
        key = _val(payload, "key")
        if mid and key:
            acquire_lock(_monster_lock_label(), str(mid), key, socket.context.session_id)
            await _bestiary_sync(socket)
        return True

    if event == "bestiary_save":
        mid = _int(_val(payload, "id"))
        field = _val(payload, "field")
        value = _val(payload, "value")
        if mid and field in BESTIARY_TEXT_FIELDS:
            await _bestiary_save(mid, field, value.strip() if isinstance(value, str) else value)
        elif mid and field == "endurance":
            await _bestiary_save(mid, "endurance", max(0, _int(value)))
        if mid and field:
            release_lock(_monster_lock_label(), str(mid), field, socket.context.session_id)
        await _bestiary_sync(socket)
        return True

    if event == "bestiary_save_habit":
        mid = _int(_val(payload, "id"))
        n = _int(_val(payload, "n"))
        value = _val(payload, "value")
        if mid and 1 <= n <= HABIT_COUNT:
            await _bestiary_save_habit(mid, n, value.strip() if isinstance(value, str) else value)
            release_lock(_monster_lock_label(), str(mid), f"habit:{n}", socket.context.session_id)
            await _bestiary_sync(socket)
        return True

    return False


async def bestiary_load_hook(socket, *args):
    await _load_bestiary(socket)


# ==========================================================================
# Character overview (read-only, live table comparing all characters)
# ==========================================================================

def _overview_col(ch):
    return {"id": ch.id, "name": ch.name.strip() or "Unnamed"}


def _names(items):
    return [x.name.strip() for x in items if x.name.strip()]


def _backpack_items(ch):
    out = []
    for b in ch.backpack.all():
        if b.name.strip():
            out.append(f"{b.name} ({b.uses})" if b.uses else b.name)
    return out


def _ul(items):
    """Render a list of strings as a <ul>, or an em dash when empty."""
    if not items:
        return "—"
    lis = "".join(f"<li>{escape(i)}</li>" for i in items)
    return Markup(f'<ul class="ov-list">{lis}</ul>')


# (label, value function) for plain scalar rows
_OVERVIEW_FIELDS = [
    ("Player", lambda ch: ch.player_name),
    ("Gender", lambda ch: ch.gender),
    ("Occupation", lambda ch: ch.occupation),
    ("Background", lambda ch: ch.background),
    ("Look", lambda ch: ch.look),
    ("Ruin", lambda ch: ch.ruin),
    ("Burden", lambda ch: ch.burden),
    ("Hoard", lambda ch: f"{ch.hoard} / {HOARD_MAX}"),
    ("Coin", lambda ch: ch.coin),
    ("Hunt Tokens", lambda ch: ch.hunt_tokens),
]
# (label, items function) for rows rendered as a bulleted list
_OVERVIEW_LIST_FIELDS = [
    ("Skills", lambda ch: _names(ch.skills.all())),
    ("Powers", lambda ch: _names(ch.powers.all())),
    ("Combat", lambda ch: _names(ch.combat.all())),
    ("Backpack", lambda ch: _backpack_items(ch)),
    ("Household", lambda ch: _names(ch.household.all())),
    ("Found", lambda ch: _names(ch.found.all())),
]
_OVERVIEW_MD_FIELDS = [("Drive", "drive"), ("Conditions", "conditions"), ("Notes", "notes")]


@sync_to_async(thread_sensitive=False)
def _fetch_overview():
    Character = apps.get_model('trophy', 'Character')
    players, hirelings, archived = [], [], []
    for ch in Character.objects.all():
        bucket = archived if ch.archived else (hirelings if ch.hireling else players)
        bucket.append(ch)

    def scalar(fn, ch):
        v = str(fn(ch)).strip()
        return v if v else "—"

    def md(attr, ch):
        raw = getattr(ch, attr)
        return render_markdown_safe(raw) if raw and raw.strip() else "—"

    rows = []
    for label, fn in _OVERVIEW_FIELDS:
        rows.append({
            "label": label, "md": False,
            "player_values": [scalar(fn, ch) for ch in players],
            "hireling_values": [scalar(fn, ch) for ch in hirelings],
            "archived_values": [scalar(fn, ch) for ch in archived],
        })
    for label, fn in _OVERVIEW_LIST_FIELDS:
        rows.append({
            "label": label, "md": False,
            "player_values": [_ul(fn(ch)) for ch in players],
            "hireling_values": [_ul(fn(ch)) for ch in hirelings],
            "archived_values": [_ul(fn(ch)) for ch in archived],
        })
    for label, attr in _OVERVIEW_MD_FIELDS:
        rows.append({
            "label": label, "md": True,
            "player_values": [md(attr, ch) for ch in players],
            "hireling_values": [md(attr, ch) for ch in hirelings],
            "archived_values": [md(attr, ch) for ch in archived],
        })
    return {
        "overview_players": [_overview_col(ch) for ch in players],
        "overview_hirelings": [_overview_col(ch) for ch in hirelings],
        "overview_archived": [_overview_col(ch) for ch in archived],
        "overview_rows": rows,
        "overview_player_count": len(players),
        "overview_hireling_count": len(hirelings),
        "overview_archived_count": len(archived),
    }


async def _load_overview(socket):
    data = await _fetch_overview()
    for key, value in data.items():
        setattr(socket.context, key, value)


async def overview_load_hook(socket, *args):
    await _load_overview(socket)


async def overview_extra_subscriptions(socket):
    # React live to any character change (saves broadcast on the Character channel).
    Character = apps.get_model('trophy', 'Character')
    return [get_store(Character).channel]


async def overview_info_hook(event, socket):
    Character = apps.get_model('trophy', 'Character')
    if event.name == get_store(Character).channel:
        await socket.liveview._refresh_view_async(socket)


# ==========================================================================


def register_hooks():
    """Attach the per-model hooks to each AliveMixin model's AliveConf."""
    from alive.mixin import AliveMixin

    load_equipment_tables()
    load_descriptors()

    for model in apps.get_models():
        if not issubclass(model, AliveMixin):
            continue
        conf = model.get_alive_conf()
        conf.context_class = TrophyContext

        if model.__name__ == "Roller":
            conf.event_handler = roller_event_handler
            conf.params_hook = roller_load_hook
            conf.refresh_hook = roller_load_hook
        elif model.__name__ == "Equipment":
            conf.event_handler = equipment_event_handler
            conf.params_hook = equipment_load_hook
            conf.refresh_hook = equipment_load_hook
        elif model.__name__ == "Monster":
            conf.event_handler = bestiary_event_handler
            conf.params_hook = bestiary_load_hook
            conf.refresh_hook = bestiary_load_hook
        elif model.__name__ == "Overview":
            conf.params_hook = overview_load_hook
            conf.refresh_hook = overview_load_hook
            conf.extra_subscriptions = overview_extra_subscriptions
            conf.info_hook = overview_info_hook
        else:
            conf.event_handler = trophy_event_handler
            conf.mount_hook = trophy_mount_hook
            conf.params_hook = trophy_params_hook
            conf.refresh_hook = trophy_refresh_hook
            conf.post_create_hook = _character_post_create
