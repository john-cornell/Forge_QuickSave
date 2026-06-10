// QuickMove v1.0.0 - checkbox overlays on txt2img/img2img gallery images.
// Checked state is synced with the Python backend (memory + JSON file).
(function () {
    "use strict";

    const QM_VERSION = "1.0.0";
    const GALLERY_IDS = ["txt2img_gallery", "img2img_gallery"];

    // key -> checked  (mirrors backend state, keys normalized like Python's
    // os.path.normcase: lowercase + backslashes on Windows paths)
    let stateKeys = {};
    let lastFetch = 0;
    let fetching = null;

    function normKey(p) {
        if (/^[A-Za-z]:[\\/]/.test(p)) {
            return p.replace(/\//g, "\\").toLowerCase();
        }
        return p;
    }

    function fetchState(force) {
        const now = Date.now();
        if (!force && now - lastFetch < 1500) return fetching || Promise.resolve();
        lastFetch = now;
        fetching = fetch("./quickmove/state")
            .then((r) => r.json())
            .then((data) => {
                const fresh = {};
                for (const it of data.items || []) fresh[it.key] = !!it.checked;
                stateKeys = fresh;
            })
            .catch(() => {});
        return fetching;
    }

    function sendToggle(path, checked) {
        stateKeys[normKey(path)] = checked;
        fetch("./quickmove/toggle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: path, checked: checked }),
        }).catch(() => {});
    }

    function extractPath(img) {
        const m = (img.src || "").match(/[/=]file=([^?#]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    }

    function ensureCheckbox(img) {
        const container = img.closest(".thumbnail-item") || img.parentElement;
        if (!container || container.classList.contains("quickmove-card")) return;

        const path = extractPath(img);
        if (!path) return;

        let cb = container.querySelector("input.quickmove-check");
        if (!cb) {
            cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "quickmove-check";
            cb.title = "QuickMove: keep this image for batch move";
            cb.addEventListener("click", (e) => e.stopPropagation());
            cb.addEventListener("change", (e) => {
                e.stopPropagation();
                sendToggle(cb.dataset.qmPath, cb.checked);
                syncCheckboxes();
            });
            if (getComputedStyle(container).position === "static") {
                container.style.position = "relative";
            }
            container.appendChild(cb);
        }
        cb.dataset.qmPath = path;
        cb.checked = !!stateKeys[normKey(path)];
    }

    function syncCheckboxes() {
        const app = gradioApp();
        for (const gid of GALLERY_IDS) {
            const gallery = app.querySelector("#" + gid);
            if (!gallery) continue;
            // thumbnail strip
            gallery.querySelectorAll(".thumbnail-item img").forEach(ensureCheckbox);
            // large preview image (when a thumbnail is expanded)
            gallery
                .querySelectorAll("img[data-testid='detailed-image']")
                .forEach(ensureCheckbox);
        }
    }

    function scan() {
        fetchState(false).then(syncCheckboxes);
        syncCheckboxes();
    }

    // Called from inline handlers in the QuickMove tab grid (base64 path
    // avoids any quoting issues in generated HTML).
    window.quickmoveTabToggle = function (b64, checked, el) {
        const bytes = atob(b64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        const path = new TextDecoder("utf-8").decode(arr);
        sendToggle(path, checked);
        const card = el && el.closest(".quickmove-card");
        if (card) card.classList.toggle("unchecked", !checked);
        syncCheckboxes();
    };

    const register =
        typeof onAfterUiUpdate === "function" ? onAfterUiUpdate : onUiUpdate;
    register(scan);

    // Auto-refresh the QuickMove tab grid whenever the user switches to it.
    if (typeof onUiTabChange === "function") {
        onUiTabChange(function () {
            const app = gradioApp();
            const tab = app.querySelector("#tab_quickmove_tab");
            if (tab && tab.style.display !== "none") {
                fetchState(true);
                const btn = app.querySelector("#quickmove_refresh");
                if (btn) btn.click();
            }
        });
    }

    console.log("[QuickMove] v" + QM_VERSION + " UI script loaded");
})();
