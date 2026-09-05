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
from markupsafe import Markup

from alive.components.editable_field import render_markdown_safe
from alive.store import get_store

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
        "drive_html": render_markdown_safe(ch.drive) if ch.drive else "",
        "conditions": ch.conditions,
        "conditions_html": render_markdown_safe(ch.conditions) if ch.conditions else "",
        "notes": ch.notes,
        "notes_html": render_markdown_safe(ch.notes) if ch.notes else "",
        "hoard": ch.hoard,
        "coin": ch.coin,
        "hunt_tokens": ch.hunt_tokens,
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
                "has_ammo": c.kind == "ammo",
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
    Character = apps.get_model('trophy', 'Character')
    result = []
    for ch in Character.objects.all():
        name = ch.name.strip() or "Unnamed character"
        occ = ch.occupation.strip()
        label = f"{name} ({occ})" if occ else name
        result.append({"id": ch.id, "label": label})
    return result


async def _load_sheet(socket):
    """Populate the sheet context from the character in ``?detail=<pk>``.

    In list mode (no detail), load the character list instead."""
    ctx = socket.context
    pk = getattr(ctx, "detail_item_id", None)
    if not pk:
        ctx.char = {}
        ctx.char_id = None
        ctx.character_list = await _fetch_character_list()
        return
    data = await _fetch_sheet(int(pk))
    if data is None:
        ctx.char = {}
        ctx.char_id = None
        ctx.character_list = await _fetch_character_list()
        return
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

    # Create a blank character and open its sheet (no name prompt).
    if event == "new_character":
        new_id = await _create_blank_character()
        await socket.push_navigate("/alive/character/", {"detail": new_id})
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
        ctx.editing_field = ""
        await _sync(socket)
        return True

    # Click a markdown block to start editing it
    if event == "edit_field":
        ctx.editing_field = _val(payload, "field")
        return True

    if event == "stop_edit":
        ctx.editing_field = ""
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
                extra = {"kind": requested if requested in ("item", "ammo") else "item"}
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
    # Only the central mat is rolled; section dice are rolled as they are added.
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
def _roller_section_add_die(sid):
    # A section die is rolled the moment it is added.
    r = _roller()
    for s in r.sections:
        if s["id"] == sid and not s.get("dice"):   # at most one die per section
            s["dice"] = [{"id": _uid(), "color": "light", "value": randint(1, 6)}]
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
        if sid:
            await _roller_section_add_die(sid)
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
        else:
            conf.event_handler = trophy_event_handler
            conf.mount_hook = trophy_mount_hook
            conf.params_hook = trophy_params_hook
            conf.refresh_hook = trophy_refresh_hook
            conf.post_create_hook = _character_post_create
