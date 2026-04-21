/**
 * VLC Control - Frontend
 *
 * Browser UI for:
 * - seat admission / waiting room
 * - realtime VLC status via WebSocket
 * - control commands via HTTP endpoints
 */
//TODO: Need to optimize dom manipulation only update what needs to and make javascript similar so that less is passively happening when it doesn't need to.
window.uiConfig = window.uiConfig || {
    title: "VLC Control",
    subtitle: "Realtime now-playing + scrub seek",
    footerText: "Tip: keep the link private.",
    theme: {},
    layout: {
        showTitleBar: true,
        showNowPlaying: true,
        showSeekBar: true,
        showSeekPreview: true,
        showQuickStatusBar: true,
        showState: true,
        showClock: true,
        showClients: true,
        showWSStatus: true,
        showButtons: true,
        showIcons: true,
        showSystemStatus: true,
        showFooter: true,
        showPlaylist: true,
        showPlaylistPrevNext: true,
        showPlaylistProgressEntries: true,
        showPlaylistProgressTime: true,
        showPlaylistProgressTimeResume: true, //TODO: The accent color applied to resumable toggle
        showPlaylistSelectMulti: true, //TODO: Checkbox to multi select, when multi selected dropdown on bottom left? "With Selected"
        showFileBrowser: true,
        showFileBrowserSearch: true, //TODO: Search toggle
        showFileBrowserFileSize: true, //TODO: File Size Toggle
        showFileBrowserFileIcons: true, //TODO: File Icons Toggle
        showFileBrowserFileIndicator: true, //TODO: File Status Indicator Toggle
        showFileBrowserFoldersGrouped: true, //TODO: Make and toggle: when true each of the folders/directories are grouped away from the other files so when icons are not showing it is clear
        showFileBrowserSelectMulti: true //TODO: Checkbox to multi select, when multi selected dropdown on bottom left? "With Selected"
    },
    buttons: {
        playPause: true,
        stop: true,
        previous: true,
        next: true,
        seekJumps: true,
        playlist: true,
        clearPlaylist: true,
        removeTrack: true,
        addFile: true, //TODO: Add file to playlist button
        playFile: true //TODO: Play file directly button
    },
    features: {
        allowSeeking: true,
        keyboardEvents: true,
        updateTabTitle: true,
        playlistControl: true,
        fileBrowser: true, //TODO: controls if the file browser works or not (think if it as master toggle)
        resumePrompt: true, //TODO:
        removePrompt: true, //TODO:
        playlistUndo: true, //TODO:
        playlistSelectMulti: true, //TODO:
        fileBrowserSelectMulti: true //TODO:
    },
    config: {
        seekJumpBy: 10,
        clockShowRemaining: false,
        resumeMinPercent: 5,
        resumeMinSeconds: 10,
        resumeMaxPercent: 95,
        resumeTailSeconds: 300,
        fileBrowserAsGrid: false //TODO: Display toggle for how the file browser displays files
    }
};

function getUiConfigSafe(){
    return (typeof window !== "undefined" && window.uiConfig) ? window.uiConfig : {};
}

function getSeekJumpBy(){
    const cfg = getUiConfigSafe();
    const v = (cfg.config && Number(cfg.config.seekJumpBy)) ? Number(cfg.config.seekJumpBy) : 10;
    return Math.max(1, Math.min(600, Math.floor(v)));
}

function applyThemeVars(theme){
    if (!theme) return;
    const r = document.documentElement;
    const map = {
        background: "--bg",
        panel: "--panel",
        panel2: "--panel2",
        text: "--text",
        muted: "--muted",
        border: "--border",
        shadow: "--shadow",
        radius: "--radius",
        accent: "--accent",
        danger: "--danger",
        ok: "--ok",
    };
    for (const k of Object.keys(map)){
        if (theme[k] != null && theme[k] !== ""){
            r.style.setProperty(map[k], String(theme[k]));
        }
    }
}

function _normalizeButtonRowPairs(pairs){
    for (const [aId, bId] of pairs){
        const a = document.getElementById(aId);
        const b = document.getElementById(bId);
        if (!a || !b) continue;

        const aShown = a.style.display !== "none";
        const bShown = b.style.display !== "none";

        a.style.gridColumn = "";
        b.style.gridColumn = "";

        if (aShown && !bShown) a.style.gridColumn = "1 / -1";
        if (!aShown && bShown) b.style.gridColumn = "1 / -1";
    }
}

function applyUiConfigToDom(){
    const cfg = getUiConfigSafe();
    const layout = cfg.layout || {};
    const btns = cfg.buttons || {};
    const feat = cfg.features || {};

    const pageTitle = document.getElementById("pageTitle");
    const pageSubtitle = document.getElementById("pageSubtitle");
    const footer = document.getElementById("footerText");
    if (pageTitle && cfg.title) pageTitle.textContent = cfg.title;
    if (pageSubtitle && cfg.subtitle) pageSubtitle.textContent = cfg.subtitle;
    if (footer && cfg.footerText) footer.textContent = cfg.footerText;

    if (cfg.title) document.title = String(cfg.title);

    const header = document.querySelector("main header");
    if (header) header.style.display = (layout.showTitleBar === false) ? "none" : "";

    const now = document.querySelector(".now");
    if (now) now.style.display = (layout.showNowPlaying === false) ? "none" : "";

    const pwrapEl = document.getElementById("pwrap");
    if (pwrapEl) pwrapEl.style.display = (layout.showSeekBar === false) ? "none" : "";

    const previewEl = document.getElementById("preview");
    if (previewEl) previewEl.style.display = (layout.showSeekPreview === false) ? "none" : "";

    const meta = document.querySelector(".meta");
    if (meta) meta.style.display = (layout.showSystemStatus === false) ? "none" : "";

    const controls = document.querySelector(".grid");
    if (controls) controls.style.display = (layout.showButtons === false) ? "none" : "";

    const quick = document.querySelector(".status");
    if (quick) quick.style.display = (layout.showQuickStatusBar === false) ? "none" : "";

    if (footer) footer.style.display = (layout.showFooter === false) ? "none" : "";

    const stateChip = document.getElementById("state");
    if (stateChip) stateChip.style.display = (layout.showState === false) ? "none" : "";

    const clockChip = document.getElementById("clock");
    if (clockChip) clockChip.style.display = (layout.showClock === false) ? "none" : "";

    const clientsChip = document.getElementById("clients");
    if (clientsChip) clientsChip.style.display = (layout.showClients === false) ? "none" : "";

    const wsChip = document.getElementById("ws");
    if (wsChip) wsChip.style.display = (layout.showWSStatus === false) ? "none" : "";

    updatePlaylistCountChip();

    const setBtn = (id, on) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = on ? "" : "none";
    };
    setBtn("btnToggle", !(btns.playPause === false));
    setBtn("btnStop",   !(btns.stop === false));
    setBtn("btnPrev",   !(btns.previous === false));
    setBtn("btnNext",   !(btns.next === false));
    const seekJumps = !(btns.seekJumps === false);
    setBtn("btnBack", seekJumps);
    setBtn("btnFwd",  seekJumps);
    const showPlaylist = !(layout.showPlaylist === false) && !(btns.playlist === false);
    setBtn("btnPlaylist", showPlaylist);
    const playlistModalFooter = document.getElementById("playlistModalFooter");
    const clearBtn = document.getElementById("btnPlClear");
    const addBtn = document.getElementById("btnPlAddFiles");
    const playlistControl = !(feat.playlistControl === false);
    const showClear = playlistControl && !(btns.clearPlaylist === false);
    const showAddFiles = playlistControl && !(layout.showFileBrowser === false) && !(btns.addFiles === false);
    if (clearBtn) clearBtn.style.display = showClear ? "" : "none";
    if (addBtn) addBtn.style.display = showAddFiles ? "" : "none";
    if (playlistModalFooter) playlistModalFooter.style.display = (showClear || showAddFiles) ? "" : "none";

    const jump = getSeekJumpBy();
    const lb = document.getElementById("lblBack");
    const lf = document.getElementById("lblFwd");
    if (lb) lb.textContent = `-${jump}s`;
    if (lf) lf.textContent = `+${jump}s`;

    const showIcons = !(layout.showIcons === false);
    document.querySelectorAll(".grid button, #btnPlAddFiles").forEach(btn => {
        const first = btn.childNodes && btn.childNodes.length ? btn.childNodes[0] : null;
        if (first && first.nodeType === Node.TEXT_NODE){
            if (btn.dataset.iconText === undefined){
                btn.dataset.iconText = first.textContent;
            }
            first.textContent = showIcons ? btn.dataset.iconText : "";
            btn.style.gap = showIcons ? "10px" : "0px";
        }
    });

    const progressEl = document.getElementById("progress");
    const allowSeeking = !(feat.allowSeeking === false);
    if (progressEl){
        progressEl.dataset.readonly = allowSeeking ? "0" : "1";
        progressEl.style.pointerEvents = allowSeeking ? "" : "none";
        if (layout.showSeekBar === false) progressEl.style.pointerEvents = "none";
    }

    _normalizeButtonRowPairs([
        ["btnToggle","btnStop"],
        ["btnPrev","btnNext"],
        ["btnBack","btnFwd"],
    ]);
}

async function loadFrontendConfig(){
    const loaderText = document.getElementById("loaderText");
    try{
        if (loaderText) loaderText.textContent = "Loading config…";
        const r = await fetch("/frontend.json", { cache: "no-store" });
        if (!r.ok) return false;
        const cfg = await r.json();
        window.uiConfig = Object.assign({}, window.uiConfig, cfg || {});
        return true;
    }catch(e){
        if (loaderText) loaderText.textContent = "Config error (frontend.json)";
        console.warn("frontend.json load failed:", e);
        return false;
    }
}

function showAppAndHideLoader(){
    const root = document.getElementById("appRoot");
    const loader = document.getElementById("loader");
    if (root) root.classList.remove("app-hidden");
    if (loader) loader.style.display = "none";
}

function setUiBusy(on, label){
    const ids = ["btnToggle","btnStop","btnPrev","btnNext","btnBack","btnFwd","progress"];
    for (const id of ids){
        const el = document.getElementById(id);
        if (!el) continue;
        el.disabled = !!on;
    }

    document.querySelectorAll(".modal button").forEach(btn => { btn.disabled = !!on; });
    const plModal = document.getElementById("playlistModal");
    if (plModal) plModal.classList.toggle("busy", !!on);
    const fbModal = document.getElementById("fileBrowserModal");
    if (fbModal) fbModal.classList.toggle("busy", !!on);

    const outEl = document.getElementById("out");
    const pillEl = document.getElementById("pill");

    if (on){
        if (outEl && outEl.dataset.prevText === undefined) outEl.dataset.prevText = outEl.textContent || "";
        if (pillEl && pillEl.dataset.prevText === undefined){
            pillEl.dataset.prevText = pillEl.textContent || "";
            pillEl.dataset.prevClass = pillEl.className || "";
        }
        if (outEl) outEl.textContent = label || "Sending…";
        if (pillEl){
            pillEl.textContent = "WORKING";
            pillEl.className = "pill warn";
        }
    } else {
        if (outEl && outEl.dataset.prevText !== undefined){
            outEl.textContent = outEl.dataset.prevText;
            delete outEl.dataset.prevText;
        }
        if (pillEl && pillEl.dataset.prevText !== undefined){
            pillEl.textContent = pillEl.dataset.prevText;
            pillEl.className = pillEl.dataset.prevClass || "pill ok";
            delete pillEl.dataset.prevText;
            delete pillEl.dataset.prevClass;
        }
    }
}

function getTokenSafe(){
    try{
        const p = new URLSearchParams(location.search);
        return p.get("t") || window.__token || "";
    }catch(_e){ return window.__token || ""; }
}

function getSidSafe(){ return window.__sid || ""; }

async function apiGet(path){
    const t = getTokenSafe();
    const s = getSidSafe();
    const join = path.includes("?") ? "&" : "?";
    const url = `${path}${join}t=${encodeURIComponent(t)}&sid=${encodeURIComponent(s)}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
}

async function refreshStatusOnce(){
    try{
        const r = await apiGet("/api/status");
        const data = await r.json();
        window.__lastStatus = data;
        applyStatus(data || {});
    }catch(_e){}
}

const token = new URLSearchParams(location.search).get("t") || "";
window.__token = token;

const CID_KEY = "vlc_control_cid";
const CLOCK_KEY = "vlc_clock_mode"; // elapsed_total | elapsed_remaining

function randomId(){
    return (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
}
let cid = localStorage.getItem(CID_KEY);
if (!cid){
    cid = randomId();
    localStorage.setItem(CID_KEY, cid);
}

function applyClockDefaultFromConfig(){
    const cfg = getUiConfigSafe();
    const def = !!(cfg.config && cfg.config.clockShowRemaining);
    try{
        if (localStorage.getItem(CLOCK_KEY) == null){
            localStorage.setItem(CLOCK_KEY, def ? "elapsed_remaining" : "elapsed_total");
        }
    }catch(_e){}
}

const out = document.getElementById("out");
const pill = document.getElementById("pill");

const titleEl = document.getElementById("title");
const stateEl = document.getElementById("state");
const clockEl = document.getElementById("clock");
const wsEl = document.getElementById("ws");
const clientsEl = document.getElementById("clients");

const progress = document.getElementById("progress");
const pwrap = document.getElementById("pwrap");
const preview = document.getElementById("preview");

const buttons = [
    document.getElementById("btnToggle"),
    document.getElementById("btnPrev"),
    document.getElementById("btnNext"),
    document.getElementById("btnStop"),
    document.getElementById("btnBack"),
    document.getElementById("btnFwd"),
];

let sid = "";
let ws = null;
let pollTimer = null;

let lastStatus = { title:"", state:"", time: 0, length: 0, progress: 0 };

let dragging = false;
let seekTargetSec = null;

let showRemaining = (localStorage.getItem(CLOCK_KEY) || "elapsed_total") === "elapsed_remaining";

function setBusy(busy){ buttons.forEach(b => { if (b) b.disabled = busy; }); }
function setPill(kind, text){
    pill.classList.remove("ok", "err", "warn");
    if (kind) pill.classList.add(kind);
    pill.textContent = text;
}
function fmtTime(s){
    s = Math.max(0, Number(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const mm = (h > 0) ? String(m).padStart(2, "0") : String(m);
    const ss = String(sec).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function tabTitleFromStatus(s){
    const mediaTitle = (s.title && String(s.title).trim()) ? String(s.title).trim() : "Nothing playing";
    const emoji = (s.state === "playing") ? "▶️" : (s.state === "paused") ? "⏸️" : "🎬";
    return (s.state === "error") ? "VLC ⚠️ not reachable" : `VLC: ${emoji} ${mediaTitle}`;
}

function updatePlayPauseButtonFromState(state){
    const btn = document.getElementById("btnToggle");
    if (!btn) return;
    const span = btn.querySelector("span");
    const s = String(state || "").toLowerCase();

    const setPrefix = (emoji) => {
        const first = btn.childNodes && btn.childNodes.length ? btn.childNodes[0] : null;
        if (first && first.nodeType === Node.TEXT_NODE){
            first.textContent = emoji ? (emoji + " ") : "";
        }
    };

    if (s === "playing"){
        setPrefix("⏸️");
        if (span) span.textContent = "Pause";
    } else if (s === "paused" || s === "stopped"){
        setPrefix("▶️");
        if (span) span.textContent = "Play";
    } else {
        setPrefix("⏯️");
        if (span) span.textContent = "Play / Pause";
    }
}

function renderClockFromStatus(){
    const t = Number(lastStatus.time || 0);
    const L = Number(lastStatus.length || 0);

    if (!clockEl) return;

    if (seekTargetSec != null && L > 0){
        const target = Math.max(0, Math.min(L, Number(seekTargetSec)));
        if (showRemaining){
            const remAtTarget = Math.max(0, L - target);
            clockEl.textContent = `Seek to ${fmtTime(target)} / -${fmtTime(remAtTarget)}`;
        } else {
            clockEl.textContent = `Seek to ${fmtTime(target)} / ${fmtTime(L)}`;
        }
        return;
    }

    if (!L){
        clockEl.textContent = `${fmtTime(t)} / ${fmtTime(L)}`;
        return;
    }

    if (showRemaining){
        const rem = Math.max(0, L - t);
        clockEl.textContent = `${fmtTime(t)} / -${fmtTime(rem)}`;
    } else {
        clockEl.textContent = `${fmtTime(t)} / ${fmtTime(L)}`;
    }
}

if (clockEl){
    clockEl.addEventListener("click", () => {
        showRemaining = !showRemaining;
        try{ localStorage.setItem(CLOCK_KEY, showRemaining ? "elapsed_remaining" : "elapsed_total"); }catch(_e){}
        renderClockFromStatus();
    });
}

function lockUI(reason, cooldownSec=0){
    sid = "";
    setBusy(true);
    if (progress) progress.disabled = true;

    closePlaylist();
    closeFileBrowser();
    const plm = document.getElementById("playlistModal");
    if (plm) plm.classList.add("busy");
    const fbm = document.getElementById("fileBrowserModal");
    if (fbm) fbm.classList.add("busy");

    dragging = false;
    seekTargetSec = null;
    if (preview) preview.classList.remove("show");

    if (!wsEl || !titleEl || !stateEl) return;

    if (reason === "full"){
        wsEl.textContent = "ws: waiting";
        titleEl.textContent = "Server full";
        stateEl.textContent = "state: full";
        if (clockEl) clockEl.textContent = "";
        document.title = "VLC Control — FULL";
        if (out) out.textContent = "Server full — waiting for a slot…";
        setPill("err", "FULL");
    } else if (reason === "cooldown"){
        wsEl.textContent = "ws: waiting";
        titleEl.textContent = "Waiting for grace…";
        stateEl.textContent = `state: grace (${cooldownSec}s)`;
        if (clockEl) clockEl.textContent = "";
        document.title = "VLC Control — WAITING";
        if (out) out.textContent = `Seat reserved — grace remaining (${cooldownSec}s)…`;
        setPill("", "WAIT");
    } else {
        wsEl.textContent = "ws: waiting";
        titleEl.textContent = "Waiting for a slot…";
        stateEl.textContent = "state: waiting";
        if (clockEl) clockEl.textContent = "";
        document.title = "VLC Control — WAITING";
        if (out) out.textContent = "Waiting…";
        setPill("", "WAIT");
    }
}

function unlockUI(){
    setBusy(false);
    if (progress) progress.disabled = false;
    if (out) out.textContent = "Admitted";
    setPill("ok", "OK");
    if (wsEl) wsEl.textContent = "ws: connected";
    const plm = document.getElementById("playlistModal");
    if (plm) plm.classList.remove("busy");
    const fbm = document.getElementById("fileBrowserModal");
    if (fbm) fbm.classList.remove("busy");
    updatePlayPauseButtonFromState((lastStatus && lastStatus.state) || "unknown");
}

function applyStatus(s){
    const prevState = (lastStatus && lastStatus.state) || "";
    lastStatus = s || lastStatus;
    const newState = (lastStatus && lastStatus.state) || "";

    const mediaTitle = (lastStatus.title && String(lastStatus.title).trim()) ? String(lastStatus.title).trim() : "Nothing playing";
    if (titleEl) titleEl.textContent = mediaTitle;
    if (stateEl) stateEl.textContent = `state: ${lastStatus.state || "unknown"}`;

    updatePlayPauseButtonFromState(lastStatus.state);

    const cfgT = getUiConfigSafe();
    if (sid && !(cfgT.features && cfgT.features.updateTabTitle === false)){
        document.title = tabTitleFromStatus(lastStatus);
    }

    renderClockFromStatus();

    if (!dragging && progress){
        const p = Math.max(0, Math.min(1, Number(lastStatus.progress || 0)));
        progress.value = String(Math.round(p * 1000));
    }

    updatePrevNextHints();
    if (newState !== prevState) renderPlaylist();
}

function setPreviewFromSlider(){
    const cfgUi = getUiConfigSafe();
    const layout = cfgUi.layout || {};
    if (layout.showSeekPreview === false) return;

    const p = clamp01(Number(progress.value) / 1000);
    const L = Number(lastStatus.length || 0);
    const targetSec = Math.round(L * p);
    seekTargetSec = targetSec;

    if (preview){
        preview.textContent = `Seek to ${fmtTime(targetSec)}`;
        const rect = progress.getBoundingClientRect();
        const x = rect.left + rect.width * p;
        const wrapRect = pwrap.getBoundingClientRect();
        preview.style.left = `${x - wrapRect.left}px`;
    }
    renderClockFromStatus();
}

async function seekVal(val){
    if (!sid) return;
    const cfg = getUiConfigSafe();
    if (cfg.features && cfg.features.allowSeeking === false) return;

    setUiBusy(true, "Sending…");
    try{
        await apiGet(`/api/seek?val=${encodeURIComponent(val)}`);
    }catch(e){
        console.error("seekVal failed", e);
    }finally{
        setUiBusy(false);
    }
}

async function seekBy(deltaSeconds){
    const cfg = getUiConfigSafe();
    if (cfg.features && cfg.features.allowSeeking === false) return;

    const st = window.__lastStatus || {};
    const t = Number(st.time || 0);
    const len = Number(st.length || 0);
    const jump = Number(deltaSeconds || 0);
    const target = (len > 0) ? Math.max(0, Math.min(len, t + jump)) : Math.max(0, t + jump);

    setUiBusy(true, "Sending…");
    try{
        await apiGet(`/api/seek?val=${encodeURIComponent(String(Math.floor(target)))}`);
    }catch(e){
        console.error("seekBy failed", e);
    }finally{
        setUiBusy(false);
    }
}

async function finishSeek(commit){
    if (commit && sid){
        const p = clamp01(Number(progress.value) / 1000);
        const pct = Math.round(p * 100);
        await seekVal(`${pct}%`);
    }
    if (preview) preview.classList.remove("show");
    dragging = false;
    seekTargetSec = null;
    renderClockFromStatus();
}

if (progress){
    progress.addEventListener("pointerdown", (e) => {
        if (!sid) return;
        const cfgA = getUiConfigSafe();
        if (cfgA.features && cfgA.features.allowSeeking === false) return;

        dragging = true;
        const lay = (cfgA.layout || {});
        if (!(lay.showSeekPreview === false) && preview) preview.classList.add("show");
        progress.setPointerCapture?.(e.pointerId);
        seekTargetSec = seekTargetSec ?? 0;
        setPreviewFromSlider();
    });

    progress.addEventListener("input", () => { if (dragging) setPreviewFromSlider(); });
    progress.addEventListener("pointermove", () => { if (dragging) setPreviewFromSlider(); });
    progress.addEventListener("pointerup", () => finishSeek(true));
    progress.addEventListener("pointercancel", () => finishSeek(false));
    progress.addEventListener("lostpointercapture", () => { if (dragging) finishSeek(false); });
}

async function hit(which){
    if (!sid) return;
    setUiBusy(true, "Sending…");
    try{
        await apiGet(`/api/${which}`);
    } catch (e){
        console.error("command failed", which, e);
    } finally {
        setUiBusy(false);
    }
}

const btnToggle = document.getElementById("btnToggle");
const btnPrev = document.getElementById("btnPrev");
const btnNext = document.getElementById("btnNext");
const btnStop = document.getElementById("btnStop");
const btnBack = document.getElementById("btnBack");
const btnFwd  = document.getElementById("btnFwd");
const btnPlaylist = document.getElementById("btnPlaylist");

if (btnToggle) btnToggle.addEventListener("click", () => hit("toggle"));
if (btnPrev)   btnPrev.addEventListener("click", () => hit("prev"));
if (btnNext)   btnNext.addEventListener("click", () => hit("next"));
if (btnStop)   btnStop.addEventListener("click", () => hit("stop"));

if (btnBack) btnBack.addEventListener("click", () => seekBy(-getSeekJumpBy()));
if (btnFwd)  btnFwd.addEventListener("click", () => seekBy(getSeekJumpBy()));

//TODO: Improve modal display, fade/animation?
//TODO: Global modal handler.
let playlistItems = [];
const playlistModal = document.getElementById("playlistModal");
const playlistItemsEl = document.getElementById("playlistItems");
const playlistEmptyEl = document.getElementById("playlistEmpty");
const btnPlClose = document.getElementById("btnPlClose");
const btnPlClear = document.getElementById("btnPlClear");
const playlistCountChip = document.getElementById("playlistCountChip");

function canOpenPlaylist(){
    const cfg = getUiConfigSafe();
    const layout = cfg.layout || {};
    const btns = cfg.buttons || {};
    return !(layout.showPlaylist === false) && !(btns.playlist === false);
}

function updatePlaylistCountChip(){
    if (!playlistCountChip) return;
    const cfg = getUiConfigSafe();
    const layout = cfg.layout || {};
    const enabled = !(layout.showPlaylistProgressEntries === false);
    if (!enabled){
        playlistCountChip.hidden = true;
        return;
    }
    const n = playlistItems.length;
    playlistCountChip.hidden = false;
    playlistCountChip.textContent = String(n);
    playlistCountChip.title = `${n} in playlist`;
}

function openPlaylist() {
    if(!playlistModal) return;
    playlistModal.hidden = false;
    if (isKeyboardInput()) requestAnimationFrame(() => focusFirstPlaylistItem());
}
function closePlaylist() {
    if(!playlistModal) return;
    playlistModal.hidden = true;
}
function isPlaylistOpen(){ return playlistModal && !playlistModal.hidden; }

function isAnyModalOpen(){
    return isResumeOpen() || isPlaylistOpen() || isFileBrowserOpen();
}

let __lastInputMode = "mouse";
document.addEventListener("pointerdown", () => { __lastInputMode = "mouse"; }, true);
document.addEventListener("keydown", (e) => {
    if (e.key === "Tab" || e.key === "Enter" || e.key === " " || e.key === "Escape" || e.key === "q" || e.key.startsWith("Arrow")){
        __lastInputMode = "keyboard";
    }
}, true);
function isKeyboardInput(){ return __lastInputMode === "keyboard"; }

function modalFocusables(modal){
    if (!modal) return [];
    const sel = "button, input, select, textarea, [tabindex]:not([tabindex='-1'])";
    return Array.from(modal.querySelectorAll(sel)).filter(el => {
        if (el.hidden || el.disabled) return false;
        const rect = el.getBoundingClientRect();
        if (!rect.width && !rect.height) return false;
        return true;
    });
}

function trapTab(modal, e){
    if (e.key !== "Tab") return false;
    const items = modalFocusables(modal);
    if (!items.length) return false;
    const first = items[0];
    const last = items[items.length - 1];
    const ae = document.activeElement;
    if (e.shiftKey){
        if (ae === first || !items.includes(ae)){
            e.preventDefault();
            last.focus();
            return true;
        }
    } else if (ae === last){
        e.preventDefault();
        first.focus();
        return true;
    }
    return false;
}

function listArrowNav(listEl, e){
    const items = Array.from(listEl.querySelectorAll("li[tabindex='0']"));
    if (!items.length) return false;
    const ae = document.activeElement;
    let idx = items.indexOf(ae);
    if (e.key === "ArrowDown"){
        e.preventDefault();
        idx = (idx < 0) ? 0 : Math.min(items.length - 1, idx + 1);
        items[idx].focus();
        return true;
    }
    if (e.key === "ArrowUp"){
        e.preventDefault();
        idx = (idx < 0) ? items.length - 1 : Math.max(0, idx - 1);
        items[idx].focus();
        return true;
    }
    if (e.key === "Home"){
        e.preventDefault();
        items[0].focus();
        return true;
    }
    if (e.key === "End"){
        e.preventDefault();
        items[items.length - 1].focus();
        return true;
    }
    return false;
}

function focusFirstPlaylistItem(){
    if (!playlistItemsEl) return;
    const first = playlistItemsEl.querySelector("li[tabindex='0']");
    if (first) { first.focus(); return; }
    if (btnPlClose) btnPlClose.focus();
}

function updatePrevNextHints() {
    const cfg = getUiConfigSafe();
    const layout = cfg.layout || {};
    const showHints = !(layout.showPlaylistPrevNext === false);
    if (!showHints){
        btnPrev.title = "Previous";
        btnNext.title = "Next";
        return;
    }

    const n = playlistItems.length;
    const idx = playlistItems.findIndex(it => it.isCurrent);
    const random = !!(window.__lastStatus && window.__lastStatus.random);

    if (n === 0 || idx < 0){
        btnPrev.title = "Previous";
        btnNext.title = "Next";
        return;
    }

    if (random){
        btnPrev.title = "Previous: (random)";
        btnNext.title = "Next: (random)";
        return;
    }

    const prevItem = (idx === 0) ? playlistItems[n - 1] : playlistItems[idx - 1];
    const nextItem = (idx === n - 1) ? playlistItems[0] : playlistItems[idx + 1];
    const prevWraps = (idx === 0);
    const nextWraps = (idx === n - 1);

    btnPrev.title = `Previous: ${prevItem.name}${prevWraps ? " (wrap to end)" : ""}`;
    btnNext.title = `Next: ${nextItem.name}${nextWraps ? " (wrap to start)" : ""}`;
}

function renderPlaylist(){
    if(!playlistItemsEl || !playlistEmptyEl) return;

    const cfg = getUiConfigSafe();
    const layout = cfg.layout || {};
    const btns = cfg.buttons || {};
    const feat = cfg.features || {};
    const controlEnabled = !(feat.playlistControl === false);
    const showRemove = controlEnabled && !(btns.removeTrack === false);
    const showProgressTime = !(layout.showPlaylistProgressTime === false);

    updatePlaylistCountChip();

    playlistItemsEl.innerHTML = "";
    if (!playlistItems.length){
        playlistEmptyEl.style.display = "";
        playlistItemsEl.style.display = "none";
        updatePrevNextHints();
        return;
    }
    playlistEmptyEl.style.display = "none";
    playlistItemsEl.style.display = "";

    const playbackState = String((window.__lastStatus && window.__lastStatus.state) || "").toLowerCase();

    for (const item of playlistItems){
        const li = document.createElement("li");
        let cls = "playlist-item";
        let indicator = "";
        let isActiveRow = false;
        let iconAction = null;

        if (item.isCurrent){
            if (playbackState === "playing"){
                cls += " current";
                indicator = "▶️";
                isActiveRow = true;
                iconAction = "toggle";
            } else if (playbackState === "paused"){
                cls += " current";
                indicator = "⏸️";
                isActiveRow = true;
                iconAction = "toggle";
            } else {
                cls += " last-played";
                indicator = "⏹️";
                iconAction = "resume";
            }
        }

        li.className = cls;
        li.dataset.id = item.id;
        li.tabIndex = 0;
        li.setAttribute("role", "option");

        let ind;
        if (iconAction && controlEnabled){
            ind = document.createElement("button");
            ind.type = "button";
            ind.setAttribute("aria-label", iconAction === "toggle" ? "Play / pause" : "Resume track");
        } else {
            ind = document.createElement("span");
        }
        ind.className = "pl-indicator";
        ind.textContent = indicator;
        if (controlEnabled && iconAction === "toggle"){
            ind.addEventListener("click", (e) => {
                e.stopPropagation();
                hit("toggle");
            });
        } else if (controlEnabled && iconAction === "resume"){
            ind.addEventListener("click", (e) => {
                e.stopPropagation();
                requestPlaylistPlay(item);
            });
        }
        li.appendChild(ind);

        const name = document.createElement("span");
        name.className = "pl-name";
        const nameValue = item.name || item.uri || "(untitled)";
        name.textContent = nameValue
        name.title = nameValue;
        li.appendChild(name);

        if(showProgressTime && (item.duration > 0 || item.progress)){
            const dur = document.createElement("span");
            dur.className = "pl-duration"; //TODO: maybe add similar clock toggle that main ui has to playlist clocks. Or some way to see time left.
            if (isSignificantProgress(item)) dur.classList.add("resumable");
            const total = (item.progress && item.progress.duration > 0)
                ? item.progress.duration
                : item.duration;
            if (item.progress && typeof item.progress.watched === "number" && total > 0){
                dur.textContent = `${fmtTime(item.progress.watched)} / ${fmtTime(total)}`;
            } else if(total > 0){
                dur.textContent = fmtTime(total);
            }
            li.appendChild(dur);
        }

        if (showRemove){
            const rm = document.createElement("button");
            rm.className = "pl-remove";
            rm.type = "button";
            rm.setAttribute("aria-label", "Remove from playlist");
            rm.textContent = "✕";
            rm.addEventListener("click", (e) => {
                e.stopPropagation();
                playlistRemove(item.id);
            });
            li.appendChild(rm);
        }

        if (controlEnabled && !isActiveRow){
            li.addEventListener("click", () => requestPlaylistPlay(item));
        } else if (!controlEnabled){
            li.style.cursor = "default";
        }

        playlistItemsEl.appendChild(li);
    }

    updatePrevNextHints();
}

function isSignificantProgress(item){
    if(!item || !item.progress) return false;
    const cfg = getUiConfigSafe().config || {};
    const watched = Number(item.progress.watched) || 0;
    const duration = Number(item.progress.duration) || Number(item.duration) || 0;
    if(duration <= 0 || watched <= 0) return false;
    const minPct  = Number(cfg.resumeMinPercent ?? 5);
    const minSec  = Number(cfg.resumeMinSeconds ?? 10);
    const maxPct  = Number(cfg.resumeMaxPercent ?? 95);
    const tailSec = Number(cfg.resumeTailSeconds ?? 300);
    const floor = Math.max(duration * minPct / 100, minSec);
    const ceil  = Math.min(duration * maxPct / 100, duration - tailSec);
    return watched > floor && watched < ceil;
}

const resumeModal = document.getElementById("resumeModal");
const resumeBody = document.getElementById("resumeBody");
const btnResumeClose = document.getElementById("btnResumeClose");
const btnResumeCancel = document.getElementById("btnResumeCancel");
const btnResumeRestart = document.getElementById("btnResumeRestart");
const btnResumeContinue = document.getElementById("btnResumeContinue");
let resumeResolver = null;

function openResumeModal(item){
    const watched = Math.max(0, Math.floor(Number(item.progress.watched) || 0));
    const total = Math.max(0, Math.floor(Number(item.progress.duration) || Number(item.duration) || 0));
    resumeBody.innerHTML = "";
    const nameEl = document.createElement("div");
    nameEl.className = "resume-name";
    nameEl.textContent = item.name || item.uri || "(untitled)";
    const msg = document.createElement("div");
    msg.textContent = total > 0
        ? `Last position: ${fmtTime(watched)} of ${fmtTime(total)}.`
        : `Last position: ${fmtTime(watched)}.`;
    resumeBody.appendChild(nameEl);
    resumeBody.appendChild(msg);
    resumeModal.hidden = false;
    if (isKeyboardInput()) requestAnimationFrame(() => { if (btnResumeContinue) btnResumeContinue.focus(); });
    return new Promise((resolve) => { resumeResolver = resolve; });
}

function closeResumeModal(choice){
    resumeModal.hidden = true;
    const r = resumeResolver;
    resumeResolver = null;
    if(r) r(choice);
}

function isResumeOpen(){ return resumeModal && !resumeModal.hidden; }

btnResumeClose.addEventListener("click", () => closeResumeModal("cancel"));
btnResumeCancel.addEventListener("click", () => closeResumeModal("cancel"));
btnResumeRestart.addEventListener("click", () => closeResumeModal("restart"));
btnResumeContinue.addEventListener("click", () => closeResumeModal("resume"));
resumeModal.addEventListener("click", (e) => {
    if(e.target === resumeModal) closeResumeModal("cancel");
});

async function requestPlaylistPlay(item){
    if(!sid || !item) return;
    const features = getUiConfigSafe().features || {};
    if(features.resumePrompt !== false && isSignificantProgress(item)){
        const choice = await openResumeModal(item);
        if(choice === "cancel") return;
        if(choice === "resume"){
            await playlistPlay(item.id, Math.floor(Number(item.progress.watched) || 0));
            return;
        }
    }
    await playlistPlay(item.id);
}

async function playlistPlay(id, resumeAt){
    if(!sid) return;
    setUiBusy(true, "Sending…");
    try{
        let url = `/api/playlist/play?id=${encodeURIComponent(id)}`;
        if(Number.isFinite(resumeAt) && resumeAt > 0){
            url += `&resume_at=${encodeURIComponent(Math.floor(resumeAt))}`;
        }
        await apiGet(url);
        closePlaylist();
    }catch(e){
        console.error("playlist play failed", e);
    }finally{
        setUiBusy(false);
    }
}

async function playlistRemove(id){
    if(!sid) return;
    try{
        await apiGet(`/api/playlist/remove?id=${encodeURIComponent(id)}`);
    }catch(e){
        console.error("playlist remove failed", e);
    }
}

async function playlistClear() {
    if(!sid) return;
    if (!confirm("Clear the entire playlist?")) return;
    setUiBusy(true, "Sending…");
    try{
        await apiGet("/api/playlist/clear");
    }catch(e){
        console.error("playlist clear failed", e);
    }finally{
        setUiBusy(false);
    }
}

if(btnPlaylist) btnPlaylist.addEventListener("click", openPlaylist);
if(playlistCountChip) playlistCountChip.addEventListener("click", () => {
    if (canOpenPlaylist()) openPlaylist();
});
if(btnPlClose) btnPlClose.addEventListener("click", closePlaylist);
if(btnPlClear) btnPlClear.addEventListener("click", playlistClear);
if(playlistModal){
    playlistModal.addEventListener("click", (e) => {
        if(e.target === playlistModal) closePlaylist();
    });
}
document.addEventListener("keydown", (e) => {
    if (isResumeOpen()){
        if (trapTab(resumeModal, e)) return;
        if (e.key === "Escape"){ e.preventDefault(); closeResumeModal("cancel"); return; }
        if (e.key === "Backspace"){ e.preventDefault(); closeResumeModal("restart"); return; }
        if (e.key === " " || e.key === "Spacebar"){
            e.preventDefault(); e.stopPropagation();
            closeResumeModal("resume");
            return;
        }
        const ae = document.activeElement;
        const actionBtns = [btnResumeCancel, btnResumeRestart, btnResumeContinue].filter(Boolean);
        const targeted = actionBtns.includes(ae);
        if (e.key === "Enter"){
            if (!targeted){
                e.preventDefault();
                closeResumeModal("resume");
            }
            return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight"){
            if (!actionBtns.length) return;
            e.preventDefault();
            let idx = targeted ? actionBtns.indexOf(ae) : actionBtns.length - 1;
            idx = (e.key === "ArrowRight") ? (idx + 1) % actionBtns.length
                                           : (idx - 1 + actionBtns.length) % actionBtns.length;
            actionBtns[idx].focus();
            return;
        }
        return;
    }
    if (isFileBrowserOpen()){
        if (trapTab(fileBrowserModal, e)) return;
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
        const inSearch = (tag === "input" || tag === "textarea");
        if (e.key === "Escape"){ e.preventDefault(); closeFileBrowser(); return; }
        if (e.key === "Backspace" && !inSearch){ e.preventDefault(); fbBack(); return; }
        if (inSearch && e.key === "ArrowDown"){
            const first = fbItemsEl && fbItemsEl.querySelector("li[tabindex='0']");
            if (first){ e.preventDefault(); first.focus(); return; }
        }
        if (!inSearch && fbItemsEl && listArrowNav(fbItemsEl, e)) return;
        if (!inSearch && e.key === "Enter"){
            const ae = document.activeElement;
            if (ae && ae.tagName === "LI" && fbItemsEl.contains(ae)){
                e.preventDefault();
                ae.click();
            }
            return;
        }
        if (!inSearch && (e.key === " " || e.key === "Spacebar")){
            const ae = document.activeElement;
            if (ae && ae.tagName === "LI" && fbItemsEl.contains(ae)){
                const playBtn = ae.querySelector(".fb-btn.play");
                if (playBtn){
                    e.preventDefault(); e.stopPropagation();
                    playBtn.click();
                }
            }
            return;
        }
        return;
    }
    if (isPlaylistOpen()){
        if (trapTab(playlistModal, e)) return;
        if (e.key === "Escape"){ e.preventDefault(); closePlaylist(); return; }
        if (e.key === " " || e.key === "Spacebar"){
            e.preventDefault(); e.stopPropagation();
            const state = String((window.__lastStatus && window.__lastStatus.state) || "").toLowerCase();
            const current = playlistItems.find(it => it.isCurrent);
            if (current && state !== "playing" && state !== "paused"){
                requestPlaylistPlay(current);
            } else if (btnToggle && btnToggle.style.display !== "none"){
                btnToggle.click();
            }
            return;
        }
        if (playlistItemsEl && listArrowNav(playlistItemsEl, e)) return;
        const ae = document.activeElement;
        const onItem = ae && ae.tagName === "LI" && playlistItemsEl && playlistItemsEl.contains(ae);
        if (onItem && e.key === "Enter"){
            e.preventDefault();
            ae.click();
            return;
        }
        if (onItem && (e.key === "Delete" || e.key === "Backspace")){
            const rm = ae.querySelector(".pl-remove");
            if (rm){ e.preventDefault(); rm.click(); }
            return;
        }
    }
});

const fileBrowserModal = document.getElementById("fileBrowserModal");
const fbItemsEl = document.getElementById("fbItems");
const fbEmptyEl = document.getElementById("fbEmpty");
const fbCrumbsEl = document.getElementById("fbCrumbs");
const fbSearchEl = document.getElementById("fbSearch");
const btnFbClose = document.getElementById("btnFbClose");
const btnPlAddFiles = document.getElementById("btnPlAddFiles");
const toastHost = document.getElementById("toastHost");

function showToast(msg, kind, ms){
    if (!toastHost) return;
    const t = document.createElement("div");
    t.className = "toast" + (kind ? ` ${kind}` : "");
    t.textContent = String(msg || "");
    toastHost.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    const life = Number(ms) > 0 ? Number(ms) : 2800;
    setTimeout(() => {
        t.classList.remove("show");
        const done = () => { try { t.remove(); } catch(_e){} };
        t.addEventListener("transitionend", done, { once: true });
        setTimeout(done, 400);
    }, life);
}

let fbState = { rootId: null, rootLabel: "", path: "", entries: [], roots: [] };

function openFileBrowser(){
    if (!fileBrowserModal) return;
    fileBrowserModal.hidden = false;
    fbState = { rootId: null, rootLabel: "", path: "", entries: [], roots: [] };
    if (fbSearchEl) fbSearchEl.value = "";
    loadFbRoots();
    if (isKeyboardInput()) requestAnimationFrame(() => { if (fbSearchEl) fbSearchEl.focus(); });
}
function closeFileBrowser(){
    if (!fileBrowserModal) return;
    fileBrowserModal.hidden = true;
}
function isFileBrowserOpen(){ return fileBrowserModal && !fileBrowserModal.hidden; }

function fileStatus(e){
    if (!e || e.type !== "file") return null;
    if (e.isCurrent) return { kind: "playing", icon: "▶", title: "Playing now" };
    const p = e.progress;
    if (p){
        const watched = Number(p.watched) || 0;
        const duration = Number(p.duration) || Number(e.duration) || 0;
        if (duration > 0 && watched > 0){
            const cfg = getUiConfigSafe().config || {};
            const minPct  = Number(cfg.resumeMinPercent ?? 5);
            const minSec  = Number(cfg.resumeMinSeconds ?? 10);
            const maxPct  = Number(cfg.resumeMaxPercent ?? 95);
            const tailSec = Number(cfg.resumeTailSeconds ?? 300);
            const floor = Math.max(duration * minPct / 100, minSec);
            const ceil  = Math.min(duration * maxPct / 100, duration - tailSec);
            if (watched >= ceil) return { kind: "completed", icon: "✓", title: "Played - completed" };
            if (watched > floor) return { kind: "partial", icon: "◐", title: `Partial - ${fmtTime(Math.floor(watched))} of ${fmtTime(Math.floor(duration))}` };
        }
    }
    if (e.inPlaylist) return { kind: "queued", icon: "📥", title: "In playlist" };
    return null;
}

function fmtSize(n){
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    const u = ["KB", "MB", "GB", "TB"];
    let i = -1; let v = n;
    do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
    return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

async function loadFbRoots(){
    if (!sid) return;
    try{
        const r = await apiGet("/api/files/roots");
        const data = await r.json();
        fbState.roots = Array.isArray(data) ? data : [];
        if (fbState.roots.length === 1){
            await loadFbDir(fbState.roots[0].id, "");
        } else {
            fbState.rootId = null;
            fbState.rootLabel = "";
            fbState.path = "";
            fbState.entries = fbState.roots.map(x => ({ name: x.label, type: "root", rootId: x.id }));
            renderFb();
        }
    }catch(e){
        console.error("roots load failed", e);
        fbState.entries = [];
        renderFb();
    }
}

async function loadFbDir(rootId, path){
    if (!sid) return;
    try{
        const r = await apiGet(`/api/files?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path || "")}`);
        const data = await r.json();
        fbState.rootId = data.root.id;
        fbState.rootLabel = data.root.label;
        fbState.path = data.path || "";
        fbState.entries = Array.isArray(data.entries) ? data.entries : [];
        renderFb();
    }catch(e){
        console.error("dir load failed", e);
    }
}

function fbParentPath(p){
    if (!p) return "";
    const parts = p.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
}

function fbChildPath(name){
    return fbState.path ? `${fbState.path}/${name}` : name;
}

function renderFbCrumbs(){
    if (!fbCrumbsEl) return;
    fbCrumbsEl.innerHTML = "";

    const addCrumb = (label, onClick, isCurrent) => {
        const el = document.createElement(onClick ? "button" : "span");
        el.className = "fb-crumb" + (isCurrent ? " current" : "");
        el.textContent = label;
        if (onClick){ el.type = "button"; el.addEventListener("click", onClick); }
        fbCrumbsEl.appendChild(el);
    };
    const addSep = () => {
        const s = document.createElement("span");
        s.className = "fb-crumb-sep"; s.textContent = "›";
        fbCrumbsEl.appendChild(s);
    };

    const multiRoot = fbState.roots.length > 1;

    if (!fbState.rootId){
        addCrumb("Root", null, true);
        return;
    }
    if (multiRoot){
        addCrumb("Root", () => loadFbRoots(), false);
        addSep();
    }

    const parts = (fbState.path || "").split("/").filter(Boolean);
    if (parts.length === 0){
        addCrumb(fbState.rootLabel, null, true);
    } else {
        addCrumb(fbState.rootLabel, () => loadFbDir(fbState.rootId, ""), false);
        let acc = "";
        parts.forEach((seg, i) => {
            addSep();
            acc = acc ? `${acc}/${seg}` : seg;
            const last = (i === parts.length - 1);
            if (last){
                addCrumb(seg, null, true);
            } else {
                const target = acc;
                addCrumb(seg, () => loadFbDir(fbState.rootId, target), false);
            }
        });
    }
}

function renderFb(){
    if (!fbItemsEl || !fbEmptyEl) return;
    renderFbCrumbs();
    fbItemsEl.innerHTML = "";

    const filter = (fbSearchEl && fbSearchEl.value || "").trim().toLowerCase();
    const base = fbState.entries.filter(e => !filter || e.name.toLowerCase().includes(filter));
    const multiRoot = fbState.roots.length > 1;
    const inSubdir = !!fbState.rootId && !!fbState.path;
    const atRootTop = !!fbState.rootId && !fbState.path;
    const showUp = inSubdir || (atRootTop && multiRoot);
    const entries = showUp ? [{ name: "Up one level", type: "up" }, ...base] : base;

    if (!entries.length){
        fbEmptyEl.style.display = "";
        fbItemsEl.style.display = "none";
        return;
    }
    fbEmptyEl.style.display = "none";
    fbItemsEl.style.display = "";

    for (const e of entries){
        const li = document.createElement("li");
        const isDirish = (e.type === "dir" || e.type === "root");
        const isUp = (e.type === "up");
        li.className = "playlist-item fb-item" + (isDirish ? " dir" : "") + (isUp ? " up" : "");
        li.tabIndex = 0;
        li.setAttribute("role", "option");

        const ind = document.createElement("span");
        ind.className = "pl-indicator";
        ind.textContent = isUp ? "⬆" : (isDirish ? "📁" : "🎬");
        li.appendChild(ind);

        const name = document.createElement("span");
        name.className = "pl-name";
        const nameValue = e.name || "(untitled)";
        name.textContent = nameValue;
        name.title = nameValue;
        li.appendChild(name);

        if (e.type === "file"){
            const st = fileStatus(e);
            if (st){
                const badge = document.createElement("span");
                badge.className = `fb-status ${st.kind}`;
                badge.textContent = st.icon;
                badge.title = st.title;
                li.appendChild(badge);
            }
            if (e.size != null){
                const sz = document.createElement("span");
                sz.className = "fb-size";
                sz.textContent = fmtSize(e.size);
                li.appendChild(sz);
            }
        }

        if (isUp){
            li.addEventListener("click", () => fbBack());
        } else if (isDirish){
            li.addEventListener("click", () => {
                if (e.type === "root") loadFbDir(e.rootId, "");
                else loadFbDir(fbState.rootId, fbChildPath(e.name));
            });
        } else {
            const actions = document.createElement("span");
            actions.className = "fb-actions";

            const addBtn = document.createElement("button");
            addBtn.className = "fb-btn add";
            addBtn.type = "button";
            addBtn.textContent = "➕";
            addBtn.title = "Add to playlist";
            addBtn.addEventListener("click", (ev) => { ev.stopPropagation(); filesAdd(e.name); });

            const playBtn = document.createElement("button");
            playBtn.className = "fb-btn play";
            playBtn.type = "button";
            playBtn.textContent = "▶";
            playBtn.title = "Play now";
            playBtn.addEventListener("click", (ev) => { ev.stopPropagation(); filesPlay(e.name); });

            actions.appendChild(addBtn);
            actions.appendChild(playBtn);
            li.appendChild(actions);

            li.addEventListener("click", () => filesAdd(e.name));
        }

        fbItemsEl.appendChild(li);
    }
}

async function filesAdd(name){
    if (!sid || !fbState.rootId) return;
    const rel = fbChildPath(name);
    setUiBusy(true, "Adding…");
    try{
        const r = await apiGet(`/api/files/add?root=${encodeURIComponent(fbState.rootId)}&path=${encodeURIComponent(rel)}`);
        const data = await r.json().catch(() => ({}));
        if (data.status === "already_present"){
            showToast(`Already in playlist: ${name}`, "info");
        } else {
            showToast(`Added: ${name}`, "ok");
        }
    }catch(e){
        console.error("files add failed", e);
        showToast(`Failed to add: ${name}`, "err");
    }finally{
        setUiBusy(false);
    }
}

async function filesPlay(name){
    if (!sid || !fbState.rootId) return;
    const rel = fbChildPath(name);
    setUiBusy(true, "Sending…");
    try{
        const r = await apiGet(`/api/files/play?root=${encodeURIComponent(fbState.rootId)}&path=${encodeURIComponent(rel)}`);
        const data = await r.json().catch(() => ({}));
        if (data.status === "jumped"){
            showToast(`Playing existing entry: ${name}`, "info");
        } else {
            showToast(`Added & playing: ${name}`, "ok");
        }
        closeFileBrowser();
        closePlaylist();
    }catch(e){
        console.error("files play failed", e);
        showToast(`Failed to play: ${name}`, "err");
    }finally{
        setUiBusy(false);
    }
}

function fbBack(){
    if (!fbState.rootId){ closeFileBrowser(); return; }
    if (!fbState.path){
        if (fbState.roots.length > 1) loadFbRoots();
        else closeFileBrowser();
        return;
    }
    loadFbDir(fbState.rootId, fbParentPath(fbState.path));
}

if (btnPlAddFiles) btnPlAddFiles.addEventListener("click", openFileBrowser);
if (btnFbClose) btnFbClose.addEventListener("click", closeFileBrowser);
if (fileBrowserModal){
    fileBrowserModal.addEventListener("click", (e) => {
        if (e.target === fileBrowserModal) closeFileBrowser();
    });
}
if (fbSearchEl) fbSearchEl.addEventListener("input", () => renderFb());

async function fetchClients(){
    try{
        const res = await fetch(`/api/clients?t=${encodeURIComponent(token)}&cid=${encodeURIComponent(cid)}`, { cache: "no-store" });
        if (!res.ok) return null;
        const data = await res.json();
        if (clientsEl) clientsEl.textContent = `clients: ${data.clients}/${data.max}`;
        return data;
    }catch{
        return null;
    }
}

function stopPolling(){
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
}

function startPolling(){
    if (pollTimer) return;

    const tick = async () => {
        if (sid){ stopPolling(); return; }

        const data = await fetchClients();
        if (data){
            const cd = Number(data.cooldown || 0);
            if (data.admit_for_cid){
                if (wsEl) wsEl.textContent = "ws: connecting";
                connectWS();
            } else {
                if (data.clients >= data.max) lockUI("full", cd);
                else if (cd > 0) lockUI("cooldown", cd);
                else lockUI("waiting", 0);
                if (ws){ try{ ws.close(); }catch{} ws = null; }
            }
        }

        const delay = 2000 + Math.floor(Math.random() * 1500);
        pollTimer = setTimeout(() => { pollTimer = null; tick(); }, delay);
    };

    tick();
}

function connectWS(){
    if (sid) return;
    if (ws) return;

    const proto = (location.protocol === "https:") ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&cid=${encodeURIComponent(cid)}`;
    ws = new WebSocket(url);

    ws.onopen = () => { if (wsEl) wsEl.textContent = "ws: connected"; };

    ws.onclose = () => {
        ws = null;
        if (sid){
            sid = "";
            lockUI("waiting");
        } else {
            if (wsEl) wsEl.textContent = "ws: waiting";
        }
        startPolling();
    };

    ws.onerror = () => { if (wsEl) wsEl.textContent = "ws: waiting"; };

    ws.onmessage = (ev) => {
        try{
            const msg = JSON.parse(ev.data);

            if (msg.type === "clients"){
                const d = msg.data || {};
                if (clientsEl) clientsEl.textContent = `clients: ${d.clients}/${d.max}`;
            }

            if (msg.type === "error"){
                lockUI("full");
                try{ ws.close(); }catch{}
                ws = null;
                startPolling();
                return;
            }

            if (msg.type === "auth" && msg.sid){
                sid = msg.sid;
                window.__sid = sid;
                stopPolling();
                unlockUI();
                refreshStatusOnce();
                return;
            }

            if (msg.type === "status"){
                window.__lastStatus = msg.data;
                if (sid) applyStatus(msg.data || {});
            }

            if (msg.type === "playlist"){
                playlistItems = Array.isArray(msg.data) ? msg.data : [];
                window.__playlist = playlistItems;
                renderPlaylist();
                if (isFileBrowserOpen() && fbState.rootId){
                    loadFbDir(fbState.rootId, fbState.path);
                }
            }
        }catch{}
    };
}

function setupKeyboardShortcuts(){
    const cfg = getUiConfigSafe();
    const enabled = !(cfg.features && cfg.features.keyboardEvents === false);

    if (window.__vlcKbHandler){
        document.removeEventListener("keydown", window.__vlcKbHandler, true);
        window.__vlcKbHandler = null;
    }
    if (!enabled) return;

    const throttle = { last: 0, lastKey: "" };

    window.__vlcKbHandler = (e) => {
        if (e.repeat) return;
        if (isAnyModalOpen()) return;
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
        if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) return;
        if (e.altKey || e.ctrlKey || e.metaKey) return;

        const now = Date.now();
        const key = e.key;
        if (throttle.lastKey === key && (now - throttle.last) < 250) return;
        throttle.lastKey = key;
        throttle.last = now;

        const cfg2 = getUiConfigSafe();
        const btns = cfg2.buttons || {};
        const feat = cfg2.features || {};
        const allowSeeking = !(feat.allowSeeking === false);
        const seekJumpsEnabled = !(btns.seekJumps === false);

        if (key === " " || key === "Spacebar"){
            e.preventDefault(); e.stopPropagation();
            if (btnToggle && btnToggle.style.display !== "none") btnToggle.click();
            return;
        }
        if (key === "n" || key === "N"){
            if (btnNext && btnNext.style.display !== "none") btnNext.click();
            return;
        }
        if (key === "p" || key === "P"){
            if (btnPrev && btnPrev.style.display !== "none") btnPrev.click();
            return;
        }
        if (key === "q" || key === "Q"){
            if (isResumeOpen()) return;
            const playlistAllowed = !(feat.playlistControl === false) && !(btns.playlist === false);
            if (!playlistAllowed) return;
            e.preventDefault(); e.stopPropagation();
            if (isPlaylistOpen()) closePlaylist(); else openPlaylist();
            return;
        }

        if (!allowSeeking || !seekJumpsEnabled) return;

        if (key === "ArrowLeft"){
            e.preventDefault(); e.stopPropagation();
            seekBy(-getSeekJumpBy());
            return;
        }
        if (key === "ArrowRight"){
            e.preventDefault(); e.stopPropagation();
            seekBy(getSeekJumpBy());
            return;
        }
    };

    document.addEventListener("keydown", window.__vlcKbHandler, true);
}

lockUI("waiting");
fetchClients();
startPolling();

(async function bootstrap(){
    const loaderText = document.getElementById("loaderText");
    try{
        if (loaderText) loaderText.textContent = "Loading…";

        if (!token){
            if (loaderText) loaderText.textContent = "Missing token in URL (add ?t=...)";
            return;
        }

        await loadFrontendConfig();
        applyThemeVars(getUiConfigSafe().theme);
        applyUiConfigToDom();
        applyClockDefaultFromConfig();

        try{
            showRemaining = (localStorage.getItem(CLOCK_KEY) || "elapsed_total") === "elapsed_remaining";
        }catch(_e){}

        setupKeyboardShortcuts();
        showAppAndHideLoader();
    } catch (e){
        console.error("Bootstrap failed:", e);
        if (loaderText){
            const msg = (e && (e.message || String(e))) ? (e.message || String(e)) : "Unknown error";
            loaderText.textContent = `Error loading UI: ${msg}`;
        }
        return;
    }
})();