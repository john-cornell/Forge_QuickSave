// QuickMove v1.1.0 - checkbox overlays on txt2img/img2img gallery thumbnails.
// Three states per image path:
//   (not in list)  default — unchecked on preview, not on tab
//   checked=true   selected for move — checked on preview and tab
//   checked=false  remembered — unchecked/greyed on tab, unchecked on preview
(function () {
    "use strict";

    const QM_VERSION = "1.1.0";
    const GALLERY_IDS = ["txt2img_gallery", "img2img_gallery"];

    // normKey -> true | false  (false = remembered but unchecked; absent = never added)
    let stateKeys = {};
    let lastFetch = 0;
    let fetching = null;

    function normKey(p) {
        if (/^[A-Za-z]:[\\/]/.test(p)) {
            return p.replace(/\//g, "\\").toLowerCase();
        }
        return p;
    }

    function decodeB64(b64) {
        const bytes = atob(b64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        return new TextDecoder("utf-8").decode(arr);
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
        const key = normKey(path);
        if (checked) {
            stateKeys[key] = true;
        } else if (key in stateKeys) {
            stateKeys[key] = false;
        }
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

    function removeDuplicateChecks(path, keepCb) {
        const key = normKey(path);
        gradioApp().querySelectorAll("input.quickmove-check").forEach((cb) => {
            if (cb !== keepCb && normKey(cb.dataset.qmPath || "") === key) {
                cb.remove();
            }
        });
    }

    function ensureThumbnailCheckbox(thumb) {
        if (!thumb || thumb.dataset.qmReady === "1") return;

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
            cb.addEventListener("change", (e) => {
                e.stopPropagation();
                sendToggle(cb.dataset.qmPath, cb.checked);
            });
            if (getComputedStyle(thumb).position === "static") {
                thumb.style.position = "relative";
            }
            thumb.appendChild(cb);
            removeDuplicateChecks(path, cb);
        }

        cb.dataset.qmPath = path;
        cb.checked = stateKeys[normKey(path)] === true;
        thumb.dataset.qmReady = "1";
    }

    function syncCheckboxes() {
        const app = gradioApp();
        for (const gid of GALLERY_IDS) {
            const gallery = app.querySelector("#" + gid);
            if (!gallery) continue;
            gallery.querySelectorAll(".thumbnail-item").forEach((thumb) => {
                thumb.dataset.qmReady = "";
                ensureThumbnailCheckbox(thumb);
            });
        }
    }

    function updateTabCard(cb) {
        const card = cb.closest(".quickmove-card");
        if (card) card.classList.toggle("unchecked", !cb.checked);
    }

    function onTabCheckboxChange(cb) {
        const path = decodeB64(cb.dataset.qmB64 || "");
        if (!path) return;
        sendToggle(path, cb.checked);
        updateTabCard(cb);
        syncCheckboxes();
    }

    function setupTabDelegation() {
        const app = gradioApp();
        if (app.dataset.qmTabDelegation === "1") return;
        app.dataset.qmTabDelegation = "1";
        app.addEventListener(
            "change",
            (e) => {
                if (!e.target.classList.contains("quickmove-tab-check")) return;
                onTabCheckboxChange(e.target);
            },
            true
        );
    }

    function scan() {
        setupTabDelegation();
        fetchState(false).then(syncCheckboxes);
        syncCheckboxes();
    }

    const register =
        typeof onAfterUiUpdate === "function" ? onAfterUiUpdate : onUiUpdate;
    register(scan);

    if (typeof onUiTabChange === "function") {
        onUiTabChange(function () {
            const app = gradioApp();
            const tab = app.querySelector("#tab_quickmove_tab");
            if (tab && tab.style.display !== "none") {
                fetchState(true).then(syncCheckboxes);
                const btn = app.querySelector("#quickmove_refresh");
                if (btn) btn.click();
            }
        });
    }

    console.log("[QuickMove] v" + QM_VERSION + " UI script loaded");
})();
