// QuickMove v1.4.0
// Preview: a self-drawn check button (NOT a native checkbox) overlaid on each
// gallery thumbnail. We fully own its state and rendering, so Gradio can
// never swallow the click or reset the tick. Click toggles on/off.
//
// Tab: no checkboxes. Click an image card to include/exclude it from the
// move. Excluded cards grey out but stay listed until "Clear Unchecked".
//
// Three states per image path:
//   (not in state)  default — no tick on preview, not shown on tab
//   checked=true    will move — tick on preview, normal card on tab
//   checked=false   remembered/excluded — no tick, greyed card on tab
(function () {
    "use strict";

    const QM_VERSION = "1.4.0";
    const GALLERY_IDS = ["txt2img_gallery", "img2img_gallery"];

    // normKey -> {path, key, checked, name, url, missing}
    let state = {};
    let stateLoaded = false;
    let lastToggleAt = 0;
    let accordionOpen = true; // persisted to disk via /quickmove/config

    function normKey(p) {
        if (/^[A-Za-z]:[\\/]/.test(p)) {
            return p.replace(/\//g, "\\").toLowerCase();
        }
        return p;
    }

    function extractPath(img) {
        const m = (img.src || "").match(/[/=]file=([^?#]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    }

    function isChecked(path) {
        const it = state[normKey(path)];
        return !!(it && it.checked);
    }

    // ------------------------------------------------------------- backend

    async function fetchState() {
        const startedAt = Date.now();
        try {
            const r = await fetch("./quickmove/state");
            const data = await r.json();
            accordionOpen = data.accordion_open !== false;
            // Ignore responses that raced with a local toggle, so an
            // optimistic click is never reverted by stale server data.
            if (lastToggleAt > startedAt - 1000) return;
            const fresh = {};
            for (const it of data.items || []) fresh[it.key] = it;
            state = fresh;
        } catch (e) {
            /* server unreachable - keep local state */
        }
    }

    function sendToggle(path, checked) {
        lastToggleAt = Date.now();
        const key = normKey(path);
        if (state[key]) {
            state[key].checked = checked;
        } else if (checked) {
            state[key] = {
                path: path,
                key: key,
                checked: true,
                name: path.split(/[\\/]/).pop(),
                url: null,
                missing: false,
            };
        }
        fetch("./quickmove/toggle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: path, checked: checked }),
        }).catch(() => {});
    }

    // Toggle from anywhere (preview button or tab card): updates state,
    // backend, every preview button, and the tab card in one place.
    function toggle(path) {
        const newVal = !isChecked(path);
        sendToggle(path, newVal);
        syncGallery();
        updateTabCard(normKey(path), newVal);
        return newVal;
    }

    // ------------------------------------------- gallery (txt2img/img2img)

    function swallow(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }

    function makeCheckButton() {
        const btn = document.createElement("div");
        btn.className = "quickmove-check";
        btn.title = "QuickMove: click to mark/unmark this image for batch move";
        // Block every event the gallery might use, then toggle on click.
        ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart"].forEach(
            (ev) => btn.addEventListener(ev, (e) => e.stopPropagation())
        );
        btn.addEventListener("click", (e) => {
            swallow(e);
            const path = btn.dataset.qmPath;
            if (!path) return;
            const newVal = toggle(path);
            btn.classList.toggle("checked", newVal);
        });
        return btn;
    }

    // Idempotent: only writes to the DOM when something actually changed,
    // so repeated calls never cause flicker or mutation loops.
    function syncGallery() {
        const app = gradioApp();
        for (const gid of GALLERY_IDS) {
            const gallery = app.querySelector("#" + gid);
            if (!gallery) continue;
            gallery.querySelectorAll(".thumbnail-item").forEach((thumb) => {
                const img = thumb.querySelector("img");
                if (!img) return;
                const path = extractPath(img);
                if (!path) return;

                let btn = thumb.querySelector(".quickmove-check");
                if (!btn) {
                    btn = makeCheckButton();
                    if (getComputedStyle(thumb).position === "static") {
                        thumb.style.position = "relative";
                    }
                    thumb.appendChild(btn);
                }
                if (btn.dataset.qmPath !== path) btn.dataset.qmPath = path;
                const want = isChecked(path);
                if (btn.classList.contains("checked") !== want) {
                    btn.classList.toggle("checked", want);
                }
            });
        }
    }

    // ---------------------------------------------------- QuickMove tab UI

    function badgeText(checked) {
        return checked ? "\u2713 will move" : "excluded";
    }

    function updateTabCard(key, checked) {
        const card = gradioApp().querySelector(
            ".quickmove-card[data-qm-key='" + CSS.escape(key) + "']"
        );
        if (!card) return;
        card.classList.toggle("unchecked", !checked);
        const badge = card.querySelector(".quickmove-badge");
        if (badge) badge.textContent = badgeText(checked);
    }

    function buildCard(it) {
        const card = document.createElement("div");
        card.className = "quickmove-card" + (it.checked ? "" : " unchecked");
        card.dataset.qmKey = it.key;
        card.title = it.path + "\nClick to include/exclude from the move";

        const img = document.createElement("img");
        img.src = it.url;
        img.loading = "lazy";
        card.appendChild(img);

        const row = document.createElement("div");
        row.className = "quickmove-card-label";

        const badge = document.createElement("span");
        badge.className = "quickmove-badge";
        badge.textContent = badgeText(!!it.checked);
        row.appendChild(badge);

        const name = document.createElement("span");
        name.className = "quickmove-card-name";
        name.textContent = it.name;
        row.appendChild(name);

        if (it.missing) {
            const miss = document.createElement("span");
            miss.className = "quickmove-missing";
            miss.textContent = "missing";
            row.appendChild(miss);
        }

        card.appendChild(row);

        card.addEventListener("click", (e) => {
            swallow(e);
            const included = !card.classList.contains("unchecked");
            const target = !included;
            sendToggle(it.path, target);
            card.classList.toggle("unchecked", !target);
            badge.textContent = badgeText(target);
            syncGallery();
        });

        return card;
    }

    function saveAccordionState(open) {
        accordionOpen = open;
        fetch("./quickmove/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accordion_open: open }),
        }).catch(() => {});
    }

    async function renderTabGrid() {
        const container = gradioApp().querySelector("#quickmove_grid");
        if (!container) return;

        await fetchState();
        const items = Object.values(state);
        const checkedCount = items.filter((it) => it.checked).length;

        container.innerHTML = "";

        const acc = document.createElement("div");
        acc.className = "quickmove-accordion" + (accordionOpen ? " open" : "");

        const header = document.createElement("div");
        header.className = "quickmove-acc-header";

        const arrow = document.createElement("span");
        arrow.className = "quickmove-acc-arrow";
        arrow.textContent = "\u25B6";
        header.appendChild(arrow);

        const title = document.createElement("span");
        title.textContent =
            "Images (" + items.length + " listed, " + checkedCount + " will move)";
        header.appendChild(title);

        const body = document.createElement("div");
        body.className = "quickmove-acc-body";

        header.addEventListener("click", () => {
            const open = !acc.classList.contains("open");
            acc.classList.toggle("open", open);
            saveAccordionState(open);
        });

        const hint = document.createElement("div");
        hint.className = "quickmove-hint";
        hint.textContent =
            "Click an image to include/exclude it from the move. Greyed images " +
            "are excluded and stay here until you press 'Clear Unchecked'.";
        body.appendChild(hint);

        if (!items.length) {
            const empty = document.createElement("div");
            empty.className = "quickmove-empty";
            empty.textContent =
                "No images selected yet. Click the check button on generated " +
                "images in the txt2img / img2img galleries to add them here.";
            body.appendChild(empty);
        } else {
            const grid = document.createElement("div");
            grid.className = "quickmove-grid";
            for (const it of items) grid.appendChild(buildCard(it));
            body.appendChild(grid);
        }

        acc.appendChild(header);
        acc.appendChild(body);
        container.appendChild(acc);

        syncGallery();
    }

    // ----------------------------------------------------------- lifecycle

    function setup() {
        const app = gradioApp();

        // Re-render the grid whenever a tab button updates the status line.
        const status = app.querySelector("#quickmove_status");
        if (status && !status.dataset.qmObserved) {
            status.dataset.qmObserved = "1";
            new MutationObserver(() => renderTabGrid()).observe(status, {
                childList: true,
                subtree: true,
            });
        }

        const container = app.querySelector("#quickmove_grid");
        if (container && !container.dataset.qmInit) {
            container.dataset.qmInit = "1";
            renderTabGrid();
        }

        if (!stateLoaded) {
            stateLoaded = true;
            fetchState().then(syncGallery);
        }
    }

    function scan() {
        setup();
        syncGallery();
    }

    const register =
        typeof onAfterUiUpdate === "function" ? onAfterUiUpdate : onUiUpdate;
    register(scan);

    if (typeof onUiTabChange === "function") {
        onUiTabChange(function () {
            const tab = gradioApp().querySelector("#tab_quickmove_tab");
            if (tab && tab.style.display !== "none") {
                renderTabGrid();
            }
        });
    }

    console.log("[QuickMove] v" + QM_VERSION + " UI script loaded");
})();
