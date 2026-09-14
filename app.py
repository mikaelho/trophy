"""Main entry point for the Trophy application (PyView + alive + Django)."""

import os
import sys
from pathlib import Path

# Add current directory to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Initialize Django BEFORE importing models
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'settings')
import django
django.setup()

from pyview import PyView
from pyview.template import RootTemplateContext
from starlette.middleware.sessions import SessionMiddleware
from starlette.staticfiles import StaticFiles
from starlette.middleware.wsgi import WSGIMiddleware
from django.core.wsgi import get_wsgi_application
import uvicorn

import settings as django_settings
from alive import (
    setup_alive,
    set_event_loop,
    get_registered_models,
    render_theme_picker,
    render_theme_script,
    collect_static,
    static_url,
)


async def get_frame_context(session):
    """Provide frame data for alive's LiveView templates."""
    sidebar = [{"url": m["url"], "title": m["title"]} for m in get_registered_models()]
    return {
        "app_title": "Trophy",
        "app_url": "/alive/character/",
        "sidebar_models": sidebar,
        "theme_picker_html": render_theme_picker(),
    }


def custom_root_template(context: RootTemplateContext) -> str:
    suffix = " | Trophy"
    title = context.get("title") or "Trophy"
    render_title = (title + suffix) if title else "Trophy"

    additional_head_elements = "\n".join(context["additional_head_elements"])
    theme_script = render_theme_script("trophy-theme")

    return f"""<!DOCTYPE html>
<html lang="en" data-theme="light">
    <head>
      <title data-suffix="{suffix}">{render_title}</title>
      <meta name="csrf-token" content="{context["csrf_token"]}" />
      <meta charset="utf-8">
      <meta http-equiv="X-UA-Compatible" content="IE=edge">
      <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
      <link href="https://cdn.jsdelivr.net/npm/daisyui@5.5.19" rel="stylesheet" type="text/css" />
      <link href="https://cdn.jsdelivr.net/npm/daisyui@5.5.19/themes.css" rel="stylesheet" type="text/css" />
      <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.2.2"></script>
      <link rel="stylesheet" href="{static_url('/django-static/alive/css/alive.css')}">
      <style>
        /* Responsive drawer: DaisyUI drawer-open via media query
           (Tailwind v4 browser build can't generate responsive variants of DaisyUI classes) */
        @media (min-width: 1024px) {{
            .drawer > .drawer-toggle {{ display: none !important; }}
            .drawer > .drawer-toggle ~ .drawer-side {{
                pointer-events: auto !important;
                visibility: visible !important;
                overscroll-behavior: auto !important;
                opacity: 1 !important;
                width: auto !important;
                display: block !important;
                position: sticky !important;
                overflow-y: auto !important;
            }}
            .drawer > .drawer-toggle ~ .drawer-side > .drawer-overlay {{
                cursor: default !important;
                background-color: transparent !important;
            }}
            .drawer > .drawer-toggle ~ .drawer-side > :not(.drawer-overlay) {{
                translate: 0% !important;
            }}
        }}
      </style>
      <script src="{static_url('/django-static/alive/js/dragdrop.js')}"></script>
      <script src="{static_url('/django-static/alive/js/keyboard.js')}"></script>
      <script defer type="text/javascript" src="/static/assets/app.js"></script>
      <script>
        // Keyboard commit/cancel for the sheet's inline edit fields. Edit fields
        // carry a phx-blur (save on blur); the "+ add" inputs do not, so they
        // keep their native Enter-to-submit behaviour.
        // Commit an editable field's current value. PyView's phx-blur listens
        // for the bubbling `focusout`; a programmatic .blur() does not reliably
        // dispatch it, so fire it explicitly, then drop focus.
        function trophyCommit(t) {{
          t.dispatchEvent(new FocusEvent("focusout", {{ bubbles: true }}));
          t.blur();
        }}
        document.addEventListener("keydown", function (e) {{
          const t = e.target;
          if (!t || !t.tagName) return;
          // "+ add ..." inputs: Enter submits (native form), Escape cancels the
          // in-progress entry (clearing it so blur does not add it).
          if (t.tagName === "INPUT" && t.name === "name" &&
              t.closest && t.closest('form[phx-submit*="add_"]')) {{
            if (e.key === "Escape") {{
              e.preventDefault();
              t.value = "";
              t.blur();
            }}
            return;
          }}
          if (!t.hasAttribute || !t.hasAttribute("phx-blur")) return;
          // Editable fields: commit on Enter (inputs), Cmd/Ctrl+Enter (textareas)
          // or navigating away; Escape reverts to the saved value.
          const isTextarea = t.tagName === "TEXTAREA";
          const commitKey = isTextarea
            ? (e.key === "Enter" && (e.metaKey || e.ctrlKey))
            : (e.key === "Enter");
          if (commitKey) {{
            e.preventDefault();
            trophyCommit(t);
          }} else if (e.key === "Escape") {{
            e.preventDefault();
            t.value = t.defaultValue;
            trophyCommit(t);
          }}
        }});

        // Auto-grow the note textareas so they take exactly the space they need.
        function trophyAutogrow(t) {{
          t.style.height = "auto";
          t.style.height = (t.scrollHeight + 2) + "px";
        }}
        function trophyIsNote(el) {{
          return el && el.tagName === "TEXTAREA" && el.hasAttribute("phx-blur");
        }}
        document.addEventListener("input", function (e) {{
          if (trophyIsNote(e.target)) trophyAutogrow(e.target);
        }});
        document.addEventListener("focusin", function (e) {{
          if (trophyIsNote(e.target)) trophyAutogrow(e.target);
        }});

        // Commit an unfinished "+ add ..." entry when its input loses focus
        // (e.g. when navigating away), so a typed item still gets added.
        // requestSubmit() reuses the form's phx-submit, preserving fields like
        // the combat "kind" select.
        document.addEventListener("focusout", function (e) {{
          const t = e.target;
          if (t && t.tagName === "INPUT" && t.name === "name" && t.value.trim() !== "") {{
            const form = t.closest('form[phx-submit*="add_"]');
            if (form) form.requestSubmit();
          }}
        }});

        window.Hooks = window.Hooks || {{}};

        // When a character sheet is opened from the Overview (URL carries the
        // #from-overview fragment, which the server never sees), point its back
        // link at the Overview instead of the character list.
        window.Hooks.BackLink = {{
          mounted() {{ this.apply(); }},
          updated() {{ this.apply(); }},
          apply() {{
            if (window.location.hash === "#from-overview") {{
              this.el.setAttribute("href", "/alive/overview/");
              this.el.textContent = "← Overview";
            }}
          }},
        }};

        // Overview: collapse/expand the Hirelings and Archived column groups.
        // Pure per-viewer view state (localStorage), applied by toggling a class
        // on the table wrapper -- a static element the live per-cell diffs never
        // touch, so the collapse survives character updates. Re-applied on every
        // `updated()` as a belt-and-suspenders.
        window.Hooks.OverviewGroups = {{
          mounted() {{ this.bind(); this.apply(); }},
          updated() {{ this.bind(); this.apply(); }},
          key(g) {{ return "trophy-ov-hide-" + g; }},
          hidden(g) {{
            try {{ return localStorage.getItem(this.key(g)) === "1"; }} catch (e) {{ return false; }}
          }},
          apply() {{
            const wrap = this.el.parentElement.querySelector(".ov-wrap");
            ["hirelings", "archived"].forEach((g) => {{
              const h = this.hidden(g);
              if (wrap) wrap.classList.toggle("ov-hide-" + g, h);
              const btn = this.el.querySelector('.ov-grp-btn[data-group="' + g + '"]');
              if (btn) {{
                btn.textContent = btn.dataset.label + (h ? " \\u25B8" : " \\u25BE");
                btn.classList.toggle("btn-outline", h);
              }}
            }});
          }},
          bind() {{
            this.el.querySelectorAll(".ov-grp-btn").forEach((btn) => {{
              if (btn._ovBound) return;
              btn._ovBound = true;
              btn.addEventListener("click", () => {{
                const g = btn.dataset.group;
                const now = !this.hidden(g);
                try {{ localStorage.setItem(this.key(g), now ? "1" : "0"); }} catch (e) {{}}
                this.apply();
              }});
            }});
          }},
        }};

        // Spin a die on the mat whenever its value changes (i.e. on a roll),
        // the way cardplay's dice tumble.
        window.Hooks.DieSpin = {{
          mounted() {{ this._v = this.el.dataset.v; }},
          updated() {{
            if (this.el.dataset.v !== this._v) {{
              this._v = this.el.dataset.v;
              if (this._v) this.spin();
            }}
          }},
          spin() {{
            this.el.animate(
              [{{ transform: "rotate(0deg) scale(0.6)" }},
               {{ transform: "rotate(380deg) scale(1)" }}],
              {{ duration: 500, easing: "ease-out" }}
            );
          }},
        }};

        // Override alive's ConfirmClick so the click listener is bound at most
        // once per element. The stock hook re-adds a listener every time it
        // mounts on a persisted element (e.g. on websocket reconnect), which
        // made the delete confirmation pop up more than once.
        window.Hooks.ConfirmClick = {{
          mounted() {{ this._bindConfirm(); }},
          updated() {{ this._bindConfirm(); }},
          _bindConfirm() {{
            if (this.el._confirmBound) return;
            this.el._confirmBound = true;
            this.el.addEventListener("click", function (e) {{
              const message = this.dataset.confirm || "Are you sure?";
              if (!window.confirm(message)) {{
                e.preventDefault();
                e.stopPropagation();
              }}
            }}, true);
          }},
        }};
      </script>
      {additional_head_elements}
    </head>
    <body class="bg-base-200 min-h-screen">
      <div
        data-phx-main="true"
        data-phx-session="{context["session"]}"
        data-phx-static=""
        id="phx-{context["id"]}"
        >
        {context["content"]}
      </div>
      {theme_script}
    </body>
</html>
"""


def create_app():
    import asyncio
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(app):
        loop = asyncio.get_running_loop()
        set_event_loop(loop)
        yield

    app = PyView(lifespan=lifespan)
    app.rootTemplate = custom_root_template

    collect_static()

    app.mount("/static", StaticFiles(packages=[("pyview", "static")]), name="static")
    app.mount("/django-static", StaticFiles(directory="staticfiles"), name="django-static")

    django_wsgi_app = get_wsgi_application()
    app.mount("/admin", WSGIMiddleware(django_wsgi_app))

    # Register trophy hooks before alive discovers models
    from trophy.alive_hooks import register_hooks
    register_hooks()

    trophy_templates = str(Path(__file__).resolve().parent / "templates")
    setup_alive(app, url_prefix="/alive", frame_context_provider=get_frame_context,
                template_dirs=[trophy_templates])

    app.add_middleware(SessionMiddleware, secret_key=django_settings.SECRET_KEY)

    return app


app = create_app()


if __name__ == "__main__":
    import alive
    alive_dir = str(Path(alive.__file__).resolve().parent)
    uvicorn.run("app:app", host="0.0.0.0", port=8002, reload=True, reload_dirs=[".", alive_dir])
