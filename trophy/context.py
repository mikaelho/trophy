"""Trophy-specific context extending alive's ModelContext."""

from dataclasses import dataclass, field

from alive.views import ModelContext


@dataclass
class TrophyContext(ModelContext):
    """ModelContext carrying the loaded character sheet."""

    char: dict = field(default_factory=dict)
    char_id: int | None = None
    character_list: list[dict] = field(default_factory=list)

    powers: list[dict] = field(default_factory=list)
    skills: list[dict] = field(default_factory=list)
    household: list[dict] = field(default_factory=list)
    combat: list[dict] = field(default_factory=list)
    found: list[dict] = field(default_factory=list)
    backpack: list[dict] = field(default_factory=list)

    ruin: int = 1
    burden: int = 1
    ruin_boxes: list[dict] = field(default_factory=list)

    editing_field: str = ""

    # Static helpers for the template
    free_powers: int = 3
    free_skills: int = 4
    hoard_max: int = 50

    # Shared dice roller
    roller_mat: list[dict] = field(default_factory=list)
    roller_sections: list[dict] = field(default_factory=list)

    # Equipment tables page
    equipment_rows: list[dict] = field(default_factory=list)
    equipment_rolls: dict = field(default_factory=dict)
