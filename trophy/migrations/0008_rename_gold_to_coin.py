from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('trophy', '0007_hunt_tokens'),
    ]

    operations = [
        migrations.RenameField(
            model_name='character',
            old_name='gold',
            new_name='coin',
        ),
    ]
