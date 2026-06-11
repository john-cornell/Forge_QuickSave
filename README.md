# QuickMove (v1.5.1)

A Stable Diffusion WebUI **Forge** / A1111 extension that lets you tick generated
images as they appear and later move all ticked images to a folder of your
choice in one click — no more saving, hunting and moving files one by one.

## Features

- **Check button on every generated image** in the txt2img and img2img
  galleries — click to mark/unmark an image for the batch move. When the
  enlarged preview is open, a single button sits to the right of the image,
  vertically centred, and always tracks the displayed image.
- **Crash-safe**: the checked list is kept in memory *and* written to
  `quickmove_selected.json` inside the extension folder on every change, so a
  Forge crash loses nothing.
- **Survives many runs**: selections accumulate across any number of
  generations until you move or clear them.
- **QuickMove tab** showing every listed image — click an image card to
  include/exclude it from the move (excluded cards grey out). Buttons:
  - **Move Checked** — moves all checked images to the destination folder
    (name collisions are auto-renamed `name_1.png`, `name_2.png`, …).
  - **Clear Unchecked** — removes unchecked images from the list. Until you
    press this, unchecked images stay visible (dimmed) so you can re-check
    them.
  - **Uncheck All** — unchecks everything but keeps it listed.
  - **Clear All** — empties the whole list (unchecks everything).
  - **Refresh** — re-reads the list (also happens automatically when you open
    the tab).
- **Persistent destination folder** stored in `quickmove_config.json` inside
  the extension folder.
- **Image accordion** — the tab grid lives inside a collapsible accordion
  whose expand/collapse state is also remembered in `quickmove_config.json`.

## Install

Copy (or clone) this folder into your Forge installation:

```
<forge>/extensions/QuickMove
```

Restart Forge (a full restart, not just "Reload UI", so the API routes are
registered).

## Usage

1. Generate images in txt2img or img2img.
2. Tick the checkbox in the top-left corner of any image you want to keep.
3. Keep generating — ticks accumulate across runs.
4. Open the **QuickMove** tab, set the destination folder once (press
   **Save Folder**), review your picks, then press **Move Checked**.

## Files created at runtime

| File | Purpose |
| --- | --- |
| `quickmove_config.json` | Persistent settings (destination folder) |
| `quickmove_selected.json` | Crash-safe list of selected image paths |

## Version

Version **1.5.1** — shown at the top of the QuickMove tab and logged to the
browser console and Forge console on load.
