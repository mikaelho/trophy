# Trophy

A Trophy character-sheet app built on the **alive** framework (Starlette +
PyView LiveView + Django ORM + ibis templates), mirroring the structure of the
sibling `cardplay` app.

## What it does

Create Trophy characters and edit the full character sheet live:

- **One-line fields**: character name, pronouns, player name, occupation, background
- **Markdown note fields**: drive, conditions, found equipment
- **Powers / Skills**: unlimited lists; the first 3 powers and first 4 skills
  are free, each item beyond that adds 1 Burden
- **Household / Combat Equipment**: unlimited lists with no free items; each item
  adds 1 Burden
- **Combat equipment** items are either *Armor* (a Marked toggle) or *Weapon*
  (three Ammunition boxes)
- **Backpack equipment**: 6 fixed slots, each with a Uses counter
- **Ruin**: a 1–6 tick track; box 1 is always ticked
- **Hoard**: a number out of 50 · **Coin**: a number
- **Burden**: derived — starts at 1, plus every list item past its free allowance

## Running

```bash
uv sync
PYTHONPATH=. DJANGO_SETTINGS_MODULE=settings uv run django-admin migrate
uv run python app.py
```

Then open http://localhost:8002/alive/character/

## Django management commands

```bash
PYTHONPATH=. DJANGO_SETTINGS_MODULE=settings uv run django-admin <command>
```
