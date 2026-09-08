"""Trophy character-sheet models.

Only ``Character`` is an alive model (it gets a CRUD route and a custom sheet
template). The repeatable list items (powers, skills, household, combat and
backpack) are plain reverse-FK children edited entirely through the live sheet
events in ``alive_hooks.py`` -- they are not exposed as their own alive pages.
"""

from django.db import models

from alive import AliveMixin, AliveConf

# --- Sheet rules (from the Trophy character sheet) --------------------
FREE_POWERS = 3         # powers beyond this add 1 Burden each
FREE_SKILLS = 4         # skills beyond this add 1 Burden each
BACKPACK_SLOTS = 6      # fixed slots, each with a Uses counter
RUIN_MAX = 6            # Ruin track 1..6; box 1 is always ticked
HOARD_MAX = 50          # Hoard is a number out of 50
AMMO_MAX = 3            # weapon ammunition boxes
BASE_BURDEN = 1         # Burden starts from 1


class Character(models.Model, AliveMixin):
    """A Trophy scavenger."""

    alive = AliveConf(
        fields=("name",),
        create_fields=("name",),
        list_fields=("name",),
        title_field="name",
        template="character.html",
    )

    # One-line fields
    name = models.CharField(max_length=120)
    gender = models.CharField(max_length=60, blank=True)
    player_name = models.CharField(max_length=120, blank=True)
    occupation = models.CharField(max_length=200, blank=True)
    background = models.CharField(max_length=200, blank=True)
    look = models.CharField(max_length=200, blank=True)

    # Markdown note fields
    drive = models.TextField(blank=True)
    conditions = models.TextField(blank=True)
    notes = models.TextField(blank=True)

    # Numbers / tracks
    ruin = models.PositiveSmallIntegerField(default=1)
    hoard = models.PositiveSmallIntegerField(default=0)
    coin = models.PositiveIntegerField(default=0)
    hunt_tokens = models.PositiveIntegerField(default=0)
    burden_offset = models.IntegerField(default=0)   # manual +/- on top of the derived Burden

    hireling = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name", "id"]

    def __str__(self):
        return self.name

    @property
    def burden_base(self) -> int:
        """Derived Burden: base 1 + every list item past its free allowance.
        (Adding a power also raises Ruin, but that is separate from Burden.)"""
        extra_powers = max(0, self.powers.count() - FREE_POWERS)
        extra_skills = max(0, self.skills.count() - FREE_SKILLS)
        household = self.household.count()      # no free items
        combat = self.combat.count()            # no free items
        return BASE_BURDEN + extra_powers + extra_skills + household + combat

    @property
    def burden(self) -> int:
        """Derived Burden plus any manual adjustment, never below 0."""
        return max(0, self.burden_base + self.burden_offset)


class Roller(models.Model, AliveMixin):
    """A single shared dice mat. Dice live as JSON so the mat and its per-section
    (per-character) trays can hold any number of light/dark d6.

    mat:      [{"id": str, "color": "light"|"dark", "value": int|None}, ...]
    sections: [{"id": str, "name": str, "dice": [<die>, ...]}, ...]
    """

    alive = AliveConf(
        fields=("id",),
        list_fields=("id",),
        template="roller.html",
    )

    mat = models.JSONField(default=list, blank=True)
    sections = models.JSONField(default=list, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "roller"
        verbose_name_plural = "Roller"

    def __str__(self):
        return "Dice Roller"


class Equipment(models.Model, AliveMixin):
    """A routeless singleton page that rolls on the Markdown tables in
    ``trophy/lists/``. It stores nothing itself -- the tables come from files
    and each viewer's roll results live in the request context."""

    alive = AliveConf(
        fields=("id",),
        list_fields=("id",),
        template="equipment.html",
    )

    class Meta:
        verbose_name = "equipment"
        verbose_name_plural = "Equipment"

    def __str__(self):
        return "Equipment"


HABIT_COUNT = 6         # a monster's Habits are a d6 table (1-6)


class Monster(models.Model, AliveMixin):
    """A shared, party-wide bestiary entry (one box on the Trophy bestiary sheet)."""

    alive = AliveConf(
        fields=("id",),
        list_fields=("id",),
        template="bestiary.html",
    )

    endurance = models.PositiveSmallIntegerField(default=0)
    name = models.CharField(max_length=200, blank=True)
    description = models.CharField(max_length=400, blank=True)
    habits = models.JSONField(default=list, blank=True)   # up to 6 strings (d6 1-6)
    defences = models.TextField(blank=True)
    weakness = models.CharField(max_length=300, blank=True)
    position = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["position", "id"]
        verbose_name = "monster"
        verbose_name_plural = "Bestiary"

    def __str__(self):
        return self.name or "Monster"


class Overview(models.Model, AliveMixin):
    """Routeless singleton: a read-only, live table comparing all characters."""

    alive = AliveConf(
        fields=("id",),
        list_fields=("id",),
        template="overview.html",
    )

    class Meta:
        verbose_name = "overview"
        verbose_name_plural = "Overview"

    def __str__(self):
        return "Overview"


class Power(models.Model):
    character = models.ForeignKey(Character, on_delete=models.CASCADE, related_name="powers")
    name = models.CharField(max_length=200, blank=True)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self):
        return self.name


class Skill(models.Model):
    character = models.ForeignKey(Character, on_delete=models.CASCADE, related_name="skills")
    name = models.CharField(max_length=200, blank=True)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self):
        return self.name


class HouseholdMember(models.Model):
    character = models.ForeignKey(Character, on_delete=models.CASCADE, related_name="household")
    name = models.CharField(max_length=200, blank=True)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self):
        return self.name


class CombatItem(models.Model):
    WEAPON = "weapon"
    ARMOR = "armor"
    KIND_CHOICES = [(WEAPON, "Weapon"), (ARMOR, "Armour")]

    character = models.ForeignKey(Character, on_delete=models.CASCADE, related_name="combat")
    name = models.CharField(max_length=200, blank=True)
    kind = models.CharField(max_length=10, choices=KIND_CHOICES, default=ARMOR)
    marked = models.BooleanField(default=False)             # armour: marked when it soaks a hit
    ammo = models.PositiveSmallIntegerField(default=0)      # weapon: 0..AMMO_MAX
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self):
        return self.name


class FoundEquipment(models.Model):
    """Loot picked up on an incursion. Free list, no Burden impact."""

    character = models.ForeignKey(Character, on_delete=models.CASCADE, related_name="found")
    name = models.CharField(max_length=200, blank=True)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self):
        return self.name


class BackpackItem(models.Model):
    """One of the fixed backpack slots. Rows are pre-created per character."""

    character = models.ForeignKey(Character, on_delete=models.CASCADE, related_name="backpack")
    name = models.CharField(max_length=200, blank=True)
    uses = models.PositiveSmallIntegerField(default=0)
    slot = models.PositiveSmallIntegerField(default=0)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["slot", "position", "id"]

    def __str__(self):
        return self.name
