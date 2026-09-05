from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('trophy', '0013_pronouns_look'),
    ]

    operations = [
        migrations.RenameField(
            model_name='character',
            old_name='pronouns',
            new_name='gender',
        ),
    ]
