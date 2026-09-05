from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('trophy', '0009_equipment'),
    ]

    operations = [
        migrations.RenameModel(
            old_name='Ritual',
            new_name='Power',
        ),
    ]
