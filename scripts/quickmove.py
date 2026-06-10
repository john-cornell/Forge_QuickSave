"""QuickMove - mark generated images with a checkbox and batch-move them later.

Adds a checkbox overlay to every image in the txt2img / img2img galleries.
Checked images are tracked in memory AND persisted to a JSON file inside the
extension folder (crash-safe). A dedicated "QuickMove" tab shows everything
that has been checked across any number of generation runs, and lets you move
all checked images to a configured destination folder in one click.
"""

import base64
import html
import json
import os
import shutil
import threading
import urllib.parse

import gradio as gr
from fastapi import Body

from modules import script_callbacks

VERSION = "1.0.0"

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


def get_destination():
    return _load_json(CONFIG_PATH, {}).get("destination", "")


def set_destination(dest):
    _save_json(CONFIG_PATH, {"version": VERSION, "destination": dest.strip()})


def _key(path):
    return os.path.normcase(os.path.normpath(path))


_load_state()


# ----------------------------------------------------------------- operations

def toggle_image(path, checked):
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
    return "Unchecked all images (still listed - use 'Clear Unchecked' to remove)."


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
    return f"Cleared all {count} image(s) - everything is now unchecked."


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

def render_grid():
    with _lock:
        items = [dict(it) for it in _items]

    checked_count = sum(1 for it in items if it["checked"])
    summary = (
        f"<div class='quickmove-summary'>{len(items)} image(s) listed, "
        f"{checked_count} checked</div>"
    )

    if not items:
        return summary + (
            "<div class='quickmove-empty'>No images selected yet. "
            "Tick the checkbox on generated images in the txt2img / img2img "
            "galleries to add them here.</div>"
        )

    cards = []
    for it in items:
        path = it["path"]
        b64 = base64.b64encode(path.encode("utf-8")).decode("ascii")
        url = "./file=" + urllib.parse.quote(path.replace("\\", "/"), safe="/:")
        checked_attr = "checked" if it["checked"] else ""
        card_cls = "quickmove-card" + ("" if it["checked"] else " unchecked")
        missing = "" if os.path.isfile(path) else "<span class='quickmove-missing'>missing</span>"
        name = html.escape(os.path.basename(path))
        cards.append(
            f"<div class='{card_cls}'>"
            f"<img src='{url}' loading='lazy' title='{html.escape(path)}'/>"
            f"<label class='quickmove-card-label'>"
            f"<input type='checkbox' {checked_attr} "
            f"onchange=\"quickmoveTabToggle('{b64}', this.checked, this)\"/>"
            f"<span class='quickmove-card-name'>{name}</span>{missing}"
            f"</label></div>"
        )
    return summary + "<div class='quickmove-grid'>" + "".join(cards) + "</div>"


def _status(msg):
    cls = "quickmove-status error" if msg.startswith("ERROR") else "quickmove-status"
    return f"<div class='{cls}'>{html.escape(msg)}</div>"


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
            refresh_btn = gr.Button("Refresh", elem_id="quickmove_refresh")
        status = gr.HTML("")
        grid = gr.HTML(render_grid())

        def do_save(dest):
            set_destination(dest)
            return _status(f"Destination folder saved: {dest.strip() or '(empty)'}")

        def do_move(dest):
            set_destination(dest)
            return _status(move_checked(dest)), render_grid()

        def do(fn):
            return _status(fn()), render_grid()

        save_btn.click(do_save, inputs=[dest_box], outputs=[status])
        move_btn.click(do_move, inputs=[dest_box], outputs=[status, grid])
        clear_unchecked_btn.click(lambda: do(clear_unchecked), outputs=[status, grid])
        uncheck_all_btn.click(lambda: do(uncheck_all), outputs=[status, grid])
        clear_all_btn.click(lambda: do(clear_all), outputs=[status, grid])
        refresh_btn.click(lambda: ("", render_grid()), outputs=[status, grid])

    return [(ui, "QuickMove", "quickmove_tab")]


# ----------------------------------------------------------------------- API

def on_app_started(demo, app):
    @app.get("/quickmove/state")
    async def quickmove_state():
        with _lock:
            items = [
                {"path": it["path"], "checked": it["checked"], "key": _key(it["path"])}
                for it in _items
            ]
        return {"version": VERSION, "destination": get_destination(), "items": items}

    @app.post("/quickmove/toggle")
    async def quickmove_toggle(payload: dict = Body(...)):
        path = payload.get("path", "")
        if path:
            toggle_image(path, bool(payload.get("checked")))
        return {"ok": bool(path)}


script_callbacks.on_ui_tabs(on_ui_tabs)
script_callbacks.on_app_started(on_app_started)

print(f"[QuickMove] v{VERSION} loaded")
