"""Admin configuration for trophy."""

from django.contrib import admin

from .models import (
    Character,
    Power,
    Skill,
    HouseholdMember,
    CombatItem,
    BackpackItem,
)


@admin.register(Character)
class CharacterAdmin(admin.ModelAdmin):
    list_display = ['name', 'player_name', 'occupation', 'ruin', 'hoard', 'coin']


for _model in (Power, Skill, HouseholdMember, CombatItem, BackpackItem):
    admin.site.register(_model)
