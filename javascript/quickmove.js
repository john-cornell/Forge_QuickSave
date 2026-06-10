// QuickMove v1.3.0
// JS owns ALL checkbox rendering. One source of truth: `state`, mirrored from
// the backend. Checkboxes are simple: click to toggle on/off, no flicker.
//
// Three states per image path:
//   (not in state)  default — unchecked on preview, not shown on tab
//   checked=true    selected for move — checked on preview and tab
//   checked=false   remembered — unchecked + greyed on tab, unchecked on preview
(function () {
    "use strict";

    const QM_VERSION = "1.3.0";
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

    // ------------------------------------------- gallery (txt2img/img2img)

    function isChecked(path) {
        const it = state[normKey(path)];
        return !!(it && it.checked);
    }

    function onGalleryToggle(e) {
        e.stopPropagation();
        const cb = e.target;
        const path = cb.dataset.qmPath;
        if (!path) return;
        sendToggle(path, cb.checked);
        updateTabCard(normKey(path), cb.checked);
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

                let cb = thumb.querySelector("input.quickmove-check");
                if (!cb) {
                    cb = document.createElement("input");
                    cb.type = "checkbox";
                    cb.className = "quickmove-check";
                    cb.title = "QuickMove: keep this image for batch move";
                    cb.addEventListener("click", (e) => e.stopPropagation());
                    cb.addEventListener("change", onGalleryToggle);
                    if (getComputedStyle(thumb).position === "static") {
                        thumb.style.position = "relative";
                    }
                    thumb.appendChild(cb);
                }
                if (cb.dataset.qmPath !== path) cb.dataset.qmPath = path;
                const want = isChecked(path);
                if (cb.checked !== want) cb.checked = want;
            });
        }
    }

    // ---------------------------------------------------- QuickMove tab UI

    function updateTabCard(key, checked) {
        const card = gradioApp().querySelector(
            ".quickmove-card[data-qm-key='" + CSS.escape(key) + "']"
        );
        if (!card) return;
        card.classList.toggle("unchecked", !checked);
        const cb = card.querySelector("input.quickmove-tab-check");
        if (cb && cb.checked !== checked) cb.checked = checked;
    }

    function buildCard(it) {
        const card = document.createElement("div");
        card.className = "quickmove-card" + (it.checked ? "" : " unchecked");
        card.dataset.qmKey = it.key;

        const img = document.createElement("img");
        img.src = it.url;
        img.loading = "lazy";
        img.title = it.path;
        card.appendChild(img);

        const label = document.createElement("label");
        label.className = "quickmove-card-label";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "quickmove-tab-check";
        cb.checked = !!it.checked;
        cb.addEventListener("change", () => {
            sendToggle(it.path, cb.checked);
            card.classList.toggle("unchecked", !cb.checked);
            syncGallery();
        });
        label.appendChild(cb);

        const name = document.createElement("span");
        name.className = "quickmove-card-name";
        name.textContent = it.name;
        label.appendChild(name);

        if (it.missing) {
            const miss = document.createElement("span");
            miss.className = "quickmove-missing";
            miss.textContent = "missing";
            label.appendChild(miss);
        }

        card.appendChild(label);
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
            "Images (" + items.length + " listed, " + checkedCount + " checked)";
        header.appendChild(title);

        const body = document.createElement("div");
        body.className = "quickmove-acc-body";

        header.addEventListener("click", () => {
            const open = !acc.classList.contains("open");
            acc.classList.toggle("open", open);
            saveAccordionState(open);
        });

        if (!items.length) {
            const empty = document.createElement("div");
            empty.className = "quickmove-empty";
            empty.textContent =
                "No images selected yet. Tick the checkbox on generated images " +
                "in the txt2img / img2img galleries to add them here.";
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
