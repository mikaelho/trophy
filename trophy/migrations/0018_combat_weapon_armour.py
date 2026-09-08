from django.db import migrations, models


def item_ammo_to_armor_weapon(apps, schema_editor):
    CombatItem = apps.get_model("trophy", "CombatItem")
    CombatItem.objects.filter(kind="ammo").update(kind="weapon")
    CombatItem.objects.filter(kind="item").update(kind="armor")


def armor_weapon_to_item_ammo(apps, schema_editor):
    CombatItem = apps.get_model("trophy", "CombatItem")
    CombatItem.objects.filter(kind="weapon").update(kind="ammo")
    CombatItem.objects.filter(kind="armor").update(kind="item")


class Migration(migrations.Migration):

    dependencies = [
        ("trophy", "0017_overview"),
    ]

    operations = [
        migrations.AlterField(
            model_name="combatitem",
            name="kind",
            field=models.CharField(
                choices=[("weapon", "Weapon"), ("armor", "Armour")],
                default="armor",
                max_length=10,
            ),
        ),
        migrations.RunPython(item_ammo_to_armor_weapon, armor_weapon_to_item_ammo),
    ]
