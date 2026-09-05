"""URL configuration for trophy (Django admin only; the app is served by PyView)."""

from django.contrib import admin
from django.urls import path

urlpatterns = [
    path('', admin.site.urls),
]
