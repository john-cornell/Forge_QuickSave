"""QuickMove - mark generated images with a checkbox and batch-move them later.

Adds a checkbox overlay to every image in the txt2img / img2img galleries.
Checked images are tracked in memory AND persisted to a JSON file inside the
extension folder (crash-safe). A dedicated "QuickMove" tab shows everything
that has been checked across any number of generation runs, and lets you move
all checked images to a configured destination folder in one click.

The tab grid is rendered entirely by javascript/quickmove.js from the
/quickmove/state endpoint, so there is exactly one source of truth for
checkbox state.
"""

import html
import json
import os
import shutil
import threading
import time
import urllib.parse

import gradio as gr
from fastapi import Body

from modules import script_callbacks

VERSION = "1.5.0"

EXT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(EXT_DIR, "quickmove_config.json")
STATE_PATH = os.path.join(EXT_DIR, "quickmove_selected.json")

_lock = threading.RLock()
_items = []  # list of {"path": str, "checked": bool}


# ---------------------------------------------------------------- persistence

def _load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def _load_state():
    global _items
    data = _load_json(STATE_PATH, {"items": []})
    _items = [
        {"path": it["path"], "checked": bool(it.get("checked", True))}
        for it in data.get("items", [])
        if isinstance(it, dict) and it.get("path")
    ]


def _save_state():
    _save_json(STATE_PATH, {"version": VERSION, "items": _items})


def get_config():
    return _load_json(CONFIG_PATH, {})


def set_config_value(key, value):
    cfg = _load_json(CONFIG_PATH, {})
    cfg[key] = value
    cfg["version"] = VERSION
    _save_json(CONFIG_PATH, cfg)


def get_destination():
    return get_config().get("destination", "")


def set_destination(dest):
    set_config_value("destination", dest.strip())


def _key(path):
    return os.path.normcase(os.path.normpath(path))


_load_state()


# ----------------------------------------------------------------- operations

def toggle_image(path, checked):
    """Three stored states for a path:
    - Not in _items: never selected (default, not shown on tab).
    - checked=True: selected for move (checked on preview and tab).
    - checked=False: remembered but excluded from move (greyed on tab, unchecked on preview).
    """
    with _lock:
        k = _key(path)
        for it in _items:
            if _key(it["path"]) == k:
                it["checked"] = bool(checked)
                _save_state()
                return
        if checked:
            _items.append({"path": path, "checked": True})
            _save_state()


def uncheck_all():
    with _lock:
        for it in _items:
            it["checked"] = False
        _save_state()
    return "Unchecked all images (still listed as excluded - use 'Clear Unchecked' to remove)."


def clear_unchecked():
    with _lock:
        before = len(_items)
        _items[:] = [it for it in _items if it["checked"]]
        removed = before - len(_items)
        _save_state()
    return f"Removed {removed} unchecked image(s) from the list."


def clear_all():
    with _lock:
        count = len(_items)
        _items.clear()
        _save_state()
    return f"Cleared all {count} image(s)."


def move_checked(dest):
    dest = (dest or "").strip()
    if not dest:
        return "ERROR: No destination folder configured."
    try:
        os.makedirs(dest, exist_ok=True)
    except Exception as e:
        return f"ERROR: Cannot create destination folder: {e}"

    moved, missing, errors = 0, 0, []
    with _lock:
        remaining = []
        for it in _items:
            if not it["checked"]:
                remaining.append(it)
                continue
            src = it["path"]
            if not os.path.isfile(src):
                missing += 1
                continue
            try:
                shutil.move(src, _unique_path(dest, os.path.basename(src)))
                moved += 1
            except Exception as e:
                errors.append(f"{os.path.basename(src)}: {e}")
                remaining.append(it)
        _items[:] = remaining
        _save_state()

    msg = f"Moved {moved} image(s) to {dest}."
    if missing:
        msg += f" {missing} file(s) were missing and removed from the list."
    if errors:
        msg += " Errors: " + "; ".join(errors)
    return msg


def _unique_path(dest_dir, name):
    base, ext = os.path.splitext(name)
    candidate = os.path.join(dest_dir, name)
    i = 1
    while os.path.exists(candidate):
        candidate = os.path.join(dest_dir, f"{base}_{i}{ext}")
        i += 1
    return candidate


# -------------------------------------------------------------------- tab UI

def _status(msg):
    """Status HTML. A hidden timestamp guarantees the DOM changes on every
    update, which the JS mutation observer uses to re-render the grid."""
    cls = "quickmove-status error" if msg.startswith("ERROR") else "quickmove-status"
    stamp = f"<span style='display:none'>{time.time()}</span>"
    return f"<div class='{cls}'>{html.escape(msg)}{stamp}</div>"


def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as ui:
        gr.HTML(
            f"<div class='quickmove-header'>QuickMove "
            f"<span class='quickmove-version'>v{VERSION}</span></div>"
        )
        with gr.Row():
            dest_box = gr.Textbox(
                value=get_destination(),
                label="Destination folder (persistent)",
                placeholder=r"e.g. C:\Pictures\Keepers",
                scale=4,
            )
            save_btn = gr.Button("Save Folder", scale=1)
        with gr.Row():
            move_btn = gr.Button("Move Checked", variant="primary")
            clear_unchecked_btn = gr.Button("Clear Unchecked")
            uncheck_all_btn = gr.Button("Uncheck All")
            clear_all_btn = gr.Button("Clear All", variant="stop")
            refresh_btn = gr.Button("Refresh")
        status = gr.HTML("", elem_id="quickmove_status")
        gr.HTML("<div id='quickmove_grid'></div>")

        def do_save(dest):
            set_destination(dest)
            return _status(f"Destination folder saved: {dest.strip() or '(empty)'}")

        def do_move(dest):
            set_destination(dest)
            return _status(move_checked(dest))

        save_btn.click(do_save, inputs=[dest_box], outputs=[status])
        move_btn.click(do_move, inputs=[dest_box], outputs=[status])
        clear_unchecked_btn.click(lambda: _status(clear_unchecked()), outputs=[status])
        uncheck_all_btn.click(lambda: _status(uncheck_all()), outputs=[status])
        clear_all_btn.click(lambda: _status(clear_all()), outputs=[status])
        refresh_btn.click(lambda: _status("Refreshed."), outputs=[status])

    return [(ui, "QuickMove", "quickmove_tab")]


# ----------------------------------------------------------------------- API

def _item_dto(it):
    path = it["path"]
    return {
        "path": path,
        "key": _key(path),
        "checked": bool(it["checked"]),
        "name": os.path.basename(path),
        "url": "./file=" + urllib.parse.quote(path.replace("\\", "/"), safe="/:"),
        "missing": not os.path.isfile(path),
    }


def on_app_started(demo, app):
    @app.get("/quickmove/state")
    async def quickmove_state():
        with _lock:
            items = [_item_dto(it) for it in _items]
        return {
            "version": VERSION,
            "destination": get_destination(),
            "accordion_open": bool(get_config().get("accordion_open", True)),
            "items": items,
        }

    @app.post("/quickmove/toggle")
    async def quickmove_toggle(payload: dict = Body(...)):
        path = payload.get("path", "")
        if path:
            toggle_image(path, bool(payload.get("checked")))
        return {"ok": bool(path)}

    @app.post("/quickmove/config")
    async def quickmove_config(payload: dict = Body(...)):
        if "accordion_open" in payload:
            set_config_value("accordion_open", bool(payload["accordion_open"]))
        return {"ok": True}


script_callbacks.on_ui_tabs(on_ui_tabs)
script_callbacks.on_app_started(on_app_started)

print(f"[QuickMove] v{VERSION} loaded")
