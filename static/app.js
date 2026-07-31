/**
 * VLC Control - Frontend
 *
 * Browser UI for:
 * - seat admission / waiting room
 * - realtime VLC status via WebSocket
 * - control commands via HTTP/WS endpoints
 */
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
        showPlaylistProgressTimeResume: true,
        showPlaylistSelectMulti: true,
        showFileBrowser: true,
        showFileBrowserSearch: true,
        showFileBrowserFileSize: true,
        showFileBrowserFileIcons: true,
        showFileBrowserFileIndicator: true,
        showFileBrowserFilesGrouped: true,
        showFileBrowserSelectMulti: true
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
        addFile: true,
        playFile: true
    },
    features: {
        allowSeeking: true,
        keyboardEvents: true,
        updateTabTitle: true,
        playlistControl: true,
        fileBrowser: true,
        resumePrompt: true,
        removePrompt: true,
        playlistUndo: true, //TODO: Undo system, this is the toggle
        playlistSelectMulti: true,
        fileBrowserSelectMulti: true
    },
    config: {
        seekJumpBy: 10,
        clockShowRemaining: false,
        resumeMinPercent: 5,
        resumeMinSeconds: 10,
        resumeMaxPercent: 95,
        resumeTailSeconds: 300,
        fileBrowserAsGrid: false,
        nicknameMaxLength: 24
    }
};

let playlistMultiActive = false;
const playlistSelected = new Set();
let fileBrowserMultiActive = false;
const fileBrowserSelected = new Set();

function getSeekJumpBy(){
    const config = window.uiConfig.config;
    const val = (config && Number(config.seekJumpBy)) ? Number(config.seekJumpBy) : 10;
    return Math.max(1, Math.min(600, Math.floor(val)));
}

function applyThemeVars(theme){
    if (!theme) return;
    const cssRoot = document.documentElement;
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
            cssRoot.style.setProperty(map[k], String(theme[k]));
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
    const layout = window.uiConfig.layout || {};
    const buttonsConfig = window.uiConfig.buttons || {};
    const features = window.uiConfig.features || {};

    const pageTitle = document.getElementById("pageTitle");
    const pageSubtitle = document.getElementById("pageSubtitle");
    const footer = document.getElementById("footerText");
    if (pageTitle && window.uiConfig.title) pageTitle.textContent = window.uiConfig.title;
    if (pageSubtitle){
        pageSubtitle.textContent = window.uiConfig.subtitle || "";
        pageSubtitle.hidden = !window.uiConfig.subtitle;
    }
    if (footer){
        footer.textContent = window.uiConfig.footerText || "";
        footer.hidden = !window.uiConfig.footerText;
    }

    if (window.uiConfig.title) document.title = String(window.uiConfig.title);

    const header = document.querySelector("main header");
    if (header) header.style.display = (layout.showTitleBar === false) ? "none" : "";

    const nowPlayingEl = document.getElementById("nowPlaying");
    if (nowPlayingEl) nowPlayingEl.style.display = (layout.showNowPlaying === false) ? "none" : "";

    const seekBarWrapEl = document.getElementById("seekBarWrap");
    if (seekBarWrapEl) seekBarWrapEl.style.display = (layout.showSeekBar === false) ? "none" : "";

    const seekPreviewEl = document.getElementById("seekPreview");
    if (seekPreviewEl) seekPreviewEl.style.display = (layout.showSeekPreview === false) ? "none" : "";

    const nowPlayingMetaEl = document.getElementById("nowPlayingMeta");
    if (nowPlayingMetaEl) nowPlayingMetaEl.style.display = (layout.showSystemStatus === false) ? "none" : "";

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

    const nicknameMaxLength = Number(window.uiConfig.config?.nicknameMaxLength) || 24;
    if (clientNicknameInput) clientNicknameInput.maxLength = nicknameMaxLength;
    const nicknameLabelHint = document.querySelector(".client-nickname-label small");
    if (nicknameLabelHint) nicknameLabelHint.textContent = `${nicknameMaxLength} characters`;

    updatePlaylistCountChip();

    const setBtn = (id, on) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = on ? "" : "none";
    };
    setBtn("btnToggle", !(buttonsConfig.playPause === false));
    setBtn("btnStop",   !(buttonsConfig.stop === false));
    setBtn("btnPrev",   !(buttonsConfig.previous === false));
    setBtn("btnNext",   !(buttonsConfig.next === false));
    const seekJumps = !(buttonsConfig.seekJumps === false);
    setBtn("btnBack", seekJumps);
    setBtn("btnFwd",  seekJumps);
    const showPlaylist = !(layout.showPlaylist === false) && !(buttonsConfig.playlist === false);
    setBtn("btnPlaylist", showPlaylist);
    const playlistModalFooter = document.getElementById("playlistModalFooter");
    const clearBtn = document.getElementById("btnPlaylistClear");
    const addBtn = document.getElementById("btnPlaylistAddFiles");
    const playlistControl = !(features.playlistControl === false);
    const showClear = playlistControl && !(buttonsConfig.clearPlaylist === false);
    const showAddFiles = playlistControl
        && !(features.fileBrowser === false)
        && !(layout.showFileBrowser === false);
    if (clearBtn) clearBtn.style.display = showClear ? "" : "none";
    if (addBtn) addBtn.style.display = showAddFiles ? "" : "none";
    if (playlistModalFooter) playlistModalFooter.style.display = (showClear || showAddFiles) ? "" : "none";

    const fileBrowserSearchInput = document.getElementById("fileBrowserSearch");
    if (fileBrowserSearchInput) fileBrowserSearchInput.style.display = (layout.showFileBrowserSearch === false) ? "none" : "";

    const jump = getSeekJumpBy();
    const lb = document.getElementById("lblBack");
    const lf = document.getElementById("lblFwd");
    if (lb) lb.textContent = `-${jump}s`;
    if (lf) lf.textContent = `+${jump}s`;

    const showIcons = !(layout.showIcons === false);
    document.querySelectorAll(".grid button, #btnPlaylistAddFiles").forEach(btn => {
        const first = btn.childNodes && btn.childNodes.length ? btn.childNodes[0] : null;
        if (first && first.nodeType === Node.TEXT_NODE){
            if (btn.dataset.iconText === undefined){
                btn.dataset.iconText = first.textContent;
            }
            first.textContent = showIcons ? btn.dataset.iconText : "";
            btn.style.gap = showIcons ? "10px" : "0px";
        }
    });

    const seekBarEl = document.getElementById("seekBar");
    const allowSeeking = !(features.allowSeeking === false);
    if (seekBarEl){
        seekBarEl.dataset.readonly = allowSeeking ? "0" : "1";
        seekBarEl.style.pointerEvents = allowSeeking ? "" : "none";
    }

    _normalizeButtonRowPairs([
        ["btnToggle","btnStop"],
        ["btnPrev","btnNext"],
        ["btnBack","btnFwd"],
    ]);

    const canRemove = !(features.playlistControl === false) && !(buttonsConfig.removeTrack === false);
    const canAdd = !(buttonsConfig.addFile === false);
    if (fileBrowserWithSelectedEl){
        const addOpt = fileBrowserWithSelectedEl.querySelector("option[value='add']");
        const removeOpt = fileBrowserWithSelectedEl.querySelector("option[value='remove']");
        if (addOpt) addOpt.hidden = !canAdd;
        if (removeOpt) removeOpt.hidden = !canRemove;
    }
    if (playlistWithSelectedEl){
        const removeOpt = playlistWithSelectedEl.querySelector("option[value='remove']");
        if (removeOpt) removeOpt.hidden = !canRemove;
    }
}

function deepMerge(target, source) {
    for (const key of Object.keys(source)) {
        const sv = source[key];
        const tv = target[key];
        if (sv !== null && typeof sv === "object" && !Array.isArray(sv) &&
            tv !== null && typeof tv === "object" && !Array.isArray(tv)) {
            deepMerge(tv, sv);
        } else {
            target[key] = sv;
        }
    }
    return target;
}

async function loadFrontendConfig(){
    const loaderText = document.getElementById("loaderText");
    try{
        if (loaderText) loaderText.textContent = "Loading config…";
        const t = new URLSearchParams(location.search).get("t") || "";
        if (!t) return false;
        const response = await fetch(`/api/config?t=${encodeURIComponent(t)}`, { cache: "no-store" });
        if (!response.ok) return false;
        const fetchedConfig = await response.json();
        deepMerge(window.uiConfig, fetchedConfig || {});
        return true;
    }catch(err){
        if (loaderText) loaderText.textContent = "Config error (/api/config)";
        console.warn("/api/config load failed:", err);
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
    const ids = ["btnToggle","btnStop","btnPrev","btnNext","btnBack","btnFwd","seekBar"];
    for (const id of ids){
        const el = document.getElementById(id);
        if (!el) continue;
        el.disabled = !!on;
    }

    document.querySelectorAll(".modal button").forEach(btn => { btn.disabled = !!on; });
    const playlistModalEl = document.getElementById("playlistModal");
    if (playlistModalEl) playlistModalEl.classList.toggle("busy", !!on);
    const fileBrowserModalEl = document.getElementById("fileBrowserModal");
    if (fileBrowserModalEl) fileBrowserModalEl.classList.toggle("busy", !!on);

    const statusTextEl = document.getElementById("statusText");
    const statusPillEl = document.getElementById("statusPill");

    if (on){
        if (statusTextEl && statusTextEl.dataset.prevText === undefined) statusTextEl.dataset.prevText = statusTextEl.textContent || "";
        if (statusPillEl && statusPillEl.dataset.prevText === undefined){
            statusPillEl.dataset.prevText = statusPillEl.textContent || "";
            statusPillEl.dataset.prevClass = statusPillEl.className || "";
        }
        if (statusTextEl) statusTextEl.textContent = label || "Sending…";
        if (statusPillEl){
            statusPillEl.textContent = "WORKING";
            statusPillEl.className = "status-pill warn";
        }
    } else {
        if (statusTextEl && statusTextEl.dataset.prevText !== undefined){
            statusTextEl.textContent = statusTextEl.dataset.prevText;
            delete statusTextEl.dataset.prevText;
        }
        if (statusPillEl && statusPillEl.dataset.prevText !== undefined){
            statusPillEl.textContent = statusPillEl.dataset.prevText;
            statusPillEl.className = statusPillEl.dataset.prevClass || "status-pill ok";
            delete statusPillEl.dataset.prevText;
            delete statusPillEl.dataset.prevClass;
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
    const join = path.includes("?") ? "&" : "?";
    const url = `${path}${join}t=${encodeURIComponent(t)}`;
    const response = await fetch(url, {
        cache: "no-store",
        headers: { "X-Session-Id": getSidSafe() },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
}

async function apiPost(path, body = {}){
    const t = getTokenSafe();
    const url = `${path}?t=${encodeURIComponent(t)}`;
    const response = await fetch(url, {
        method: "POST",
        cache: "no-store",
        headers: {
            "Content-Type": "application/json",
            "X-Session-Id": getSidSafe(),
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
}

let _cmdLock = null;
let _optimisticSeekSec = null;

function wsSend(op, params = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "cmd", op, ...params }));
    return true;
}

function _unlockCommand() {
    if (!_cmdLock) return;
    clearTimeout(_cmdLock.fallback);
    _cmdLock = null;
    setUiBusy(false);
}

function lockForCommand(expect, seekTarget = null) {
    if (_cmdLock) {
        clearTimeout(_cmdLock.fallback);
        if (_cmdLock.expect === 'seek' && expect !== 'seek') _optimisticSeekSec = null;
    }
    const isSeek = expect === "seek";
    const fallback = setTimeout(() => {
        _cmdLock = null;
        if (isSeek) _optimisticSeekSec = null;
        setUiBusy(false);
        showToast("VLC is not responding", "err");
        console.warn("vlc cmd timeout: no confirmation received");
    }, 2500);
    _cmdLock = { expect, target: seekTarget, fallback };
    setUiBusy(true, "Sending…");
}

async function refreshStatusOnce(){
    try{
        const response = await apiGet("/api/status");
        const data = await response.json();
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
    const config = window.uiConfig.config;
    const defaultShowRemaining = !!(config && config.clockShowRemaining);
    try{
        if (localStorage.getItem(CLOCK_KEY) == null){
            localStorage.setItem(CLOCK_KEY, defaultShowRemaining ? "elapsed_remaining" : "elapsed_total");
        }
    }catch(_e){}
}

const statusTextEl = document.getElementById("statusText");
const statusPillEl = document.getElementById("statusPill");

const titleEl = document.getElementById("title");
const stateEl = document.getElementById("state");
const clockEl = document.getElementById("clock");
const wsEl = document.getElementById("ws");
const clientsEl = document.getElementById("clients");

const seekBarEl = document.getElementById("seekBar");
const seekBarWrapEl = document.getElementById("seekBarWrap");
const seekPreviewEl = document.getElementById("seekPreview");

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
let shutdownNotified = false;
let lostConnectionToast = null;
let pollTimer = null;

let lastStatus = { title:"", state:"", time: 0, length: 0, progress: 0 };

let dragging = false;
let seekTargetSec = null;

let showRemaining = (localStorage.getItem(CLOCK_KEY) || "elapsed_total") === "elapsed_remaining";

function setControlsBusy(busy){ buttons.forEach(b => { if (b) b.disabled = busy; }); }
function setStatusPill(kind, text){
    statusPillEl.classList.remove("ok", "err", "warn");
    if (kind) statusPillEl.classList.add(kind);
    statusPillEl.textContent = text;
}
function formatTime(s){
    s = Math.max(0, Number(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const mm = (h > 0) ? String(m).padStart(2, "0") : String(m);
    const ss = String(sec).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function clampZeroToOne(x){ return Math.max(0, Math.min(1, x)); }

function setText(el, val){
    if (!el) return;
    if (el.textContent !== val) el.textContent = val;
}
function setAttrIfChanged(el, name, val){
    if (!el) return;
    if (el.getAttribute(name) !== val) el.setAttribute(name, val);
}
function setClass(el, cls, on){
    if (!el) return;
    const has = el.classList.contains(cls);
    if (!!on !== has) el.classList.toggle(cls, !!on);
}

function tabTitleFromStatus(status){
    const mediaTitle = (status.title && String(status.title).trim()) ? String(status.title).trim() : "Nothing playing";
    const emoji = (status.state === "playing") ? "▶️" : (status.state === "paused") ? "⏸️" : "🎬";
    return (status.state === "error") ? "VLC ⚠️ not reachable" : `VLC: ${emoji} ${mediaTitle}`;
}

function updatePlayPauseButtonFromState(state){
    const btn = document.getElementById("btnToggle");
    if (!btn) return;
    const span = btn.querySelector("span");
    const s = String(state || "").toLowerCase();

    const setPrefix = (emoji) => {
        const first = btn.childNodes && btn.childNodes.length ? btn.childNodes[0] : null;
        if (first && first.nodeType === Node.TEXT_NODE){
            const iconText = emoji ? (emoji + " ") : "";
            if (btn.dataset.iconText !== iconText) btn.dataset.iconText = iconText;
            const showIcons = !(window.uiConfig?.layout?.showIcons === false);
            const desired = showIcons ? iconText : "";
            if (first.textContent !== desired) first.textContent = desired;
        }
    };

    if (s === "playing"){
        setPrefix("⏸️");
        setText(span, "Pause");
    } else if (s === "paused" || s === "stopped"){
        setPrefix("▶️");
        setText(span, "Play");
    } else {
        setPrefix("⏯️");
        setText(span, "Play / Pause");
    }
}

function renderClockFromStatus(){
    if (!clockEl) return;
    const t = Number(lastStatus.time || 0);
    const totalLengthSec = Number(lastStatus.length || 0);
    let text;

    if (seekTargetSec != null && totalLengthSec > 0){
        const target = Math.max(0, Math.min(totalLengthSec, Number(seekTargetSec)));
        if (showRemaining){
            const remAtTarget = Math.max(0, totalLengthSec - target);
            text = `Seek to ${formatTime(target)} / -${formatTime(remAtTarget)}`;
        } else {
            text = `Seek to ${formatTime(target)} / ${formatTime(totalLengthSec)}`;
        }
    } else if (!totalLengthSec){
        text = `${formatTime(t)} / ${formatTime(totalLengthSec)}`;
    } else if (showRemaining){
        const rem = Math.max(0, totalLengthSec - t);
        text = `${formatTime(t)} / -${formatTime(rem)}`;
    } else {
        text = `${formatTime(t)} / ${formatTime(totalLengthSec)}`;
    }

    setText(clockEl, text);
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
    setControlsBusy(true);
    if (seekBarEl) seekBarEl.disabled = true;

    closePlaylist();
    closeFileBrowser();
    const playlistModalEl = document.getElementById("playlistModal");
    if (playlistModalEl) playlistModalEl.classList.add("busy");
    const fileBrowserModalEl = document.getElementById("fileBrowserModal");
    if (fileBrowserModalEl) fileBrowserModalEl.classList.add("busy");

    dragging = false;
    seekTargetSec = null;
    if (seekPreviewEl) seekPreviewEl.classList.remove("show");

    if (!wsEl || !titleEl || !stateEl) return;

    if (reason === "full"){
        wsEl.textContent = "ws: waiting";
        titleEl.textContent = "Server full";
        setAttrIfChanged(titleEl, "title", "Server full");
        stateEl.textContent = "state: full";
        if (clockEl) clockEl.textContent = "0:00 / 0:00";
        document.title = "VLC Control - FULL";
        if (statusTextEl) statusTextEl.textContent = "Server full - waiting for a slot…";
        setStatusPill("err", "FULL");
    } else if (reason === "cooldown"){
        wsEl.textContent = "ws: waiting";
        titleEl.textContent = "Waiting for grace…";
        setAttrIfChanged(titleEl, "title", "Waiting for grace…");
        stateEl.textContent = `state: grace (${cooldownSec}s)`;
        if (clockEl) clockEl.textContent = "0:00 / 0:00";
        document.title = "VLC Control - WAITING";
        if (statusTextEl) statusTextEl.textContent = `Seat reserved - grace remaining (${cooldownSec}s)…`;
        setStatusPill("", "WAIT");
    } else {
        wsEl.textContent = "ws: waiting";
        titleEl.textContent = "Waiting for a slot…";
        setAttrIfChanged(titleEl, "title", "Waiting for a slot…");
        stateEl.textContent = "state: waiting";
        if (clockEl) clockEl.textContent = "0:00 / 0:00";
        document.title = "VLC Control — WAITING";
        if (statusTextEl) statusTextEl.textContent = "Waiting…";
        setStatusPill("", "WAIT");
    }
}

function unlockUI(){
    setControlsBusy(false);
    if (seekBarEl) seekBarEl.disabled = false;
    if (statusTextEl) statusTextEl.textContent = "Admitted";
    setStatusPill("ok", "OK");
    if (wsEl) wsEl.textContent = "ws: connected";
    const playlistModalEl = document.getElementById("playlistModal");
    if (playlistModalEl) playlistModalEl.classList.remove("busy");
    const fileBrowserModalEl = document.getElementById("fileBrowserModal");
    if (fileBrowserModalEl) fileBrowserModalEl.classList.remove("busy");
    updatePlayPauseButtonFromState((lastStatus && lastStatus.state) || "unknown");
}

function applyStatus(status){
    const prevState = (lastStatus && lastStatus.state) || "";
    const prevTitle = (lastStatus && lastStatus.title) || "";
    lastStatus = status || lastStatus;
    const newState = (lastStatus && lastStatus.state) || "";
    const newTitle = (lastStatus && lastStatus.title) || "";

    const mediaTitle = (lastStatus.title && String(lastStatus.title).trim()) ? String(lastStatus.title).trim() : "Nothing playing";
    setText(titleEl, mediaTitle);
    setAttrIfChanged(titleEl, "title", mediaTitle);
    setText(stateEl, `state: ${lastStatus.state || "unknown"}`);

    if (newState !== prevState) {
        updatePlayPauseButtonFromState(newState);
        if (_cmdLock && _cmdLock.expect === "state") _unlockCommand();
    }
    if (_cmdLock && _cmdLock.expect === "title" && newTitle && newTitle !== prevTitle) {
        _unlockCommand();
    }
    if (_cmdLock && _cmdLock.expect === "nav" && (newState !== prevState || (newTitle && newTitle !== prevTitle))) {
        _unlockCommand();
    }
    if (_cmdLock && _cmdLock.expect === "seek") {
        const newTime = Number(lastStatus.time || 0);
        const t = _cmdLock.target;
        if (t === null || Math.abs(newTime - t) <= 5) {
            _optimisticSeekSec = null;
            _unlockCommand();
        }
    }

    const features = window.uiConfig.features;
    if (sid && !(features && features.updateTabTitle === false)){
        const tabTitle = tabTitleFromStatus(lastStatus);
        if (document.title !== tabTitle) document.title = tabTitle;
    }

    renderClockFromStatus();

    if (!dragging && seekBarEl){
        let displayP = Number(lastStatus.progress || 0);
        if (_optimisticSeekSec !== null) {
            const length = Number(lastStatus.length || 0);
            if (length > 0) displayP = _optimisticSeekSec / length;
        }
        const p = Math.max(0, Math.min(1, displayP));
        const v = String(Math.round(p * 1000));
        if (seekBarEl.value !== v) seekBarEl.value = v;
    }

    updatePrevNextHints();
    if (newState !== prevState) renderPlaylist();
}

function setPreviewFromSlider(){
    const layout = window.uiConfig.layout || {};
    if (layout.showSeekPreview === false) return;

    const p = clampZeroToOne(Number(seekBarEl.value) / 1000);
    const L = Number(lastStatus.length || 0);
    const targetSec = Math.round(L * p);
    seekTargetSec = targetSec;

    if (seekPreviewEl){
        seekPreviewEl.textContent = `Seek to ${formatTime(targetSec)}`;
        const rect = seekBarEl.getBoundingClientRect();
        const x = rect.left + rect.width * p;
        const wrapRect = seekBarWrapEl.getBoundingClientRect();
        seekPreviewEl.style.left = `${x - wrapRect.left}px`;
    }
    renderClockFromStatus();
}

function seekVal(val){
    if (!sid) return;
    if (window.uiConfig.features?.allowSeeking === false) return;
    if (_cmdLock && _cmdLock.expect === "seek") return;

    let targetSec = null;
    const st = window.__lastStatus || {};
    const length = Number(st.length || 0);
    const cur = Number(st.time || 0);
    try {
        const s = String(val);
        if (s.endsWith("%")) {
            targetSec = length > 0 ? Math.round((parseFloat(s) / 100) * length) : 0;
        } else if (s.startsWith("+") || s.startsWith("-")) {
            targetSec = Math.max(0, cur + parseInt(s, 10));
        } else {
            targetSec = parseInt(s, 10);
        }
        if (length > 0 && targetSec !== null) targetSec = Math.max(0, Math.min(length, targetSec));
    } catch(_e) {}

    if (!wsSend("seek", { val: String(val) })) return;
    if (targetSec !== null) _optimisticSeekSec = targetSec;
    lockForCommand("seek", targetSec);
}

function seekBy(deltaSeconds){
    if (window.uiConfig.features?.allowSeeking === false) return;
    if (_cmdLock && _cmdLock.expect === "seek") return;
    const status = window.__lastStatus || {};
    const currentTime = Number(status.time || 0);
    const totalLength = Number(status.length || 0);
    const jump = Number(deltaSeconds || 0);
    const raw = totalLength > 0 ? Math.max(0, Math.min(totalLength, currentTime + jump)) : Math.max(0, currentTime + jump);
    const targetSec = Math.floor(raw);
    if (!wsSend("seek", { val: String(targetSec) })) return;
    _optimisticSeekSec = targetSec;
    lockForCommand("seek", targetSec);
}

function finishSeek(commit){
    if (commit && sid){
        const p = clampZeroToOne(Number(seekBarEl.value) / 1000);
        const pct = Math.round(p * 100);
        seekVal(`${pct}%`);
    }
    if (seekPreviewEl) seekPreviewEl.classList.remove("show");
    dragging = false;
    seekTargetSec = null;
    renderClockFromStatus();
}

if (seekBarEl){
    seekBarEl.addEventListener("pointerdown", (e) => {
        if (!sid) return;
        const features = window.uiConfig.features;
        if (features && features.allowSeeking === false) return;
        if (_cmdLock && _cmdLock.expect === "seek") return;

        dragging = true;
        const layout = window.uiConfig.layout || {};
        if (!(layout.showSeekPreview === false) && seekPreviewEl) seekPreviewEl.classList.add("show");
        seekBarEl.setPointerCapture?.(e.pointerId);
        seekTargetSec = seekTargetSec ?? 0;
        setPreviewFromSlider();
    });

    seekBarEl.addEventListener("input", () => { if (dragging) setPreviewFromSlider(); });
    seekBarEl.addEventListener("pointermove", () => { if (dragging) setPreviewFromSlider(); });
    seekBarEl.addEventListener("pointerup", () => finishSeek(true));
    seekBarEl.addEventListener("pointercancel", () => finishSeek(false));
    seekBarEl.addEventListener("lostpointercapture", () => { if (dragging) finishSeek(false); });
}

function sendApiCommand(which){
    if (!sid) return;
    const expectMap = { toggle: "state", stop: "state", next: "nav", prev: "nav" };
    const expect = expectMap[which] || "state";
    if (!wsSend(which)) return;
    lockForCommand(expect);
}

const btnToggle = document.getElementById("btnToggle");
const btnPrev = document.getElementById("btnPrev");
const btnNext = document.getElementById("btnNext");
const btnStop = document.getElementById("btnStop");
const btnBack = document.getElementById("btnBack");
const btnFwd  = document.getElementById("btnFwd");
const btnPlaylist = document.getElementById("btnPlaylist");

if (btnToggle) btnToggle.addEventListener("click", () => sendApiCommand("toggle"));
if (btnPrev)   btnPrev.addEventListener("click", () => sendApiCommand("prev"));
if (btnNext)   btnNext.addEventListener("click", () => sendApiCommand("next"));
if (btnStop)   btnStop.addEventListener("click", () => sendApiCommand("stop"));

if (btnBack) btnBack.addEventListener("click", () => seekBy(-getSeekJumpBy()));
if (btnFwd)  btnFwd.addEventListener("click", () => seekBy(getSeekJumpBy()));

//TODO: Improve modal display, fade/animation?
//TODO: Global modal handler.
let playlistItems = [];
const playlistModal = document.getElementById("playlistModal");
const playlistItemsEl = document.getElementById("playlistItems");
const playlistEmptyEl = document.getElementById("playlistEmpty");
const btnPlaylistClose = document.getElementById("btnPlaylistClose");
const btnPlaylistClear = document.getElementById("btnPlaylistClear");
const playlistCountChip = document.getElementById("playlistCountChip");
const playlistMultiselectBarEl = document.getElementById("playlistMultiselectBar");
const playlistMultiselectCheckEl = document.getElementById("playlistMultiselectCheck");
const playlistSelectAllEl = document.getElementById("playlistSelectAll");
const playlistWithSelectedEl = document.getElementById("playlistWithSelected");

function canOpenPlaylist(){
    return !(window.uiConfig.features?.playlistControl === false);
}

function updatePlaylistCountChip(){
    if (!playlistCountChip) return;
    const layout = window.uiConfig.layout || {};
    const enabled = !(layout.showPlaylistProgressEntries === false);
    if (!enabled){
        if (!playlistCountChip.hidden) playlistCountChip.hidden = true;
        return;
    }
    if (playlistCountChip.hidden) playlistCountChip.hidden = false;
    const count = playlistItems.length;
    const countStr = String(count);
    if (playlistCountChip.textContent !== countStr) playlistCountChip.textContent = countStr;
    const title = `${count} in playlist`;
    if (playlistCountChip.title !== title) playlistCountChip.title = title;
}

function openPlaylist() {
    if(!playlistModal) return;
    playlistModal.hidden = false;
    if (isKeyboardInput()) requestAnimationFrame(() => focusFirstPlaylistItem());
}
function closePlaylist() {
    if(!playlistModal) return;
    playlistModal.hidden = true;
    if (playlistMultiActive) exitPlaylistMulti();
}
function isPlaylistOpen(){ return playlistModal && !playlistModal.hidden; }

function isAnyModalOpen(){
    return isResumeOpen() || isPlaylistOpen() || isFileBrowserOpen() || isClientsOpen();
}

let __lastInputMode = "mouse";
document.addEventListener("pointerdown", () => { __lastInputMode = "mouse"; }, true);
document.addEventListener("touchstart", () => { __lastInputMode = "touch"; }, true);
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

    const isGrid = listEl.classList.contains("grid");

    if (isGrid){
        if (e.key === "ArrowLeft"){
            e.preventDefault();
            idx = (idx < 0) ? items.length - 1 : Math.max(0, idx - 1);
            items[idx].focus();
            return true;
        }
        if (e.key === "ArrowRight"){
            e.preventDefault();
            idx = (idx < 0) ? 0 : Math.min(items.length - 1, idx + 1);
            items[idx].focus();
            return true;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp"){
            e.preventDefault();
            if (idx < 0){
                items[e.key === "ArrowUp" ? items.length - 1 : 0].focus();
                return true;
            }
            const dir = e.key === "ArrowDown" ? 1 : -1;
            const cur = items[idx].getBoundingClientRect();
            const cx = cur.left + cur.width / 2;
            const cy = cur.top + cur.height / 2;
            let best = null;
            let bestScore = Infinity;
            for (let i = 0; i < items.length; i++){
                if (i === idx) continue;
                const r = items[i].getBoundingClientRect();
                const ry = r.top + r.height / 2;
                const vdiff = (ry - cy) * dir;
                if (vdiff <= 2) continue;
                const rx = r.left + r.width / 2;
                const score = vdiff * 1000 + Math.abs(rx - cx);
                if (score < bestScore){ bestScore = score; best = items[i]; }
            }
            if (best) best.focus();
            return true;
        }
        return false;
    }

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
    return false;
}

function focusFirstPlaylistItem(){
    if (!playlistItemsEl) return;
    const first = playlistItemsEl.querySelector("li[tabindex='0']");
    if (first) { first.focus(); return; }
    if (btnPlaylistClose) btnPlaylistClose.focus();
}

function updatePrevNextHints() {
    const layout = window.uiConfig.layout || {};
    const showHints = !(layout.showPlaylistPrevNext === false);

    let prevTitle = "Previous";
    let nextTitle = "Next";

    if (showHints){
        const count = playlistItems.length;
        const currentIndex = playlistItems.findIndex(it => it.isCurrent);
        const random = !!(window.__lastStatus && window.__lastStatus.random);

        if (random && count > 0 && currentIndex >= 0){
            prevTitle = "Previous: (random)";
            nextTitle = "Next: (random)";
        } else if (count > 0 && currentIndex >= 0){
            const prevItem = (currentIndex === 0) ? playlistItems[count - 1] : playlistItems[currentIndex - 1];
            const nextItem = (currentIndex === count - 1) ? playlistItems[0] : playlistItems[currentIndex + 1];
            const prevWraps = (currentIndex === 0);
            const nextWraps = (currentIndex === count - 1);
            prevTitle = `Previous: ${prevItem.name}${prevWraps ? " (wrap to end)" : ""}`;
            nextTitle = `Next: ${nextItem.name}${nextWraps ? " (wrap to start)" : ""}`;
        }
    }

    if (btnPrev && btnPrev.title !== prevTitle) btnPrev.title = prevTitle;
    if (btnNext && btnNext.title !== nextTitle) btnNext.title = nextTitle;
}

function playlistRowShape(item, playbackState, controlEnabled, showRemove, showProgressTime){
    let iconAction = "none";
    let status = "normal";
    if (item.isCurrent){
        if (playbackState === "playing" || playbackState === "paused"){
            status = "current";
            iconAction = controlEnabled ? "toggle" : "none";
        } else {
            status = "last";
            iconAction = controlEnabled ? "resume" : "none";
        }
    }
    const hasDur = !!(showProgressTime && (item.duration > 0 || item.progress));
    return `${status}|${iconAction}|${showRemove?1:0}|${hasDur?1:0}|${controlEnabled?1:0}`;
}

function playlistRowDurationText(item){
    const total = (item.progress && item.progress.duration > 0)
        ? item.progress.duration
        : item.duration;
    if (item.progress && typeof item.progress.watched === "number" && total > 0){
        return `${formatTime(item.progress.watched)} / ${formatTime(total)}`;
    }
    if (total > 0) return formatTime(total);
    return "";
}

function playlistRowIndicator(item, playbackState){
    if (!item.isCurrent) return "";
    if (playbackState === "playing") return "▶️";
    if (playbackState === "paused") return "⏸️";
    return "⏹️";
}

function buildPlaylistRow(item, shape, playbackState, controlEnabled, showRemove, showProgressTime, showResumeAccent){
    const li = document.createElement("li");
    li.dataset.id = item.id;
    li.dataset.shape = shape;
    li.tabIndex = 0;
    li.setAttribute("role", "option");

    const parts = shape.split("|");
    const status = parts[0];
    const iconAction = parts[1];
    const isActiveRow = (status === "current");

    let cls = "playlist-item";
    if (status === "current") cls += " current";
    else if (status === "last") cls += " last-played";
    li.className = cls;

    let indicatorEl;
    if (iconAction !== "none"){
        indicatorEl = document.createElement("button");
        indicatorEl.type = "button";
        indicatorEl.setAttribute("aria-label", iconAction === "toggle" ? "Play / pause" : "Resume track");
        if (iconAction === "toggle"){
            indicatorEl.addEventListener("click", (e) => { e.stopPropagation(); sendApiCommand("toggle"); });
        } else {
            indicatorEl.addEventListener("click", (e) => {
                e.stopPropagation();
                const cur = playlistItems.find(it => String(it.id) === li.dataset.id);
                if (cur) requestPlaylistPlay(cur);
            });
        }
    } else {
        indicatorEl = document.createElement("span");
    }
    indicatorEl.className = "playlist-indicator";
    indicatorEl.textContent = playlistRowIndicator(item, playbackState);
    li.appendChild(indicatorEl);

    const name = document.createElement("span");
    name.className = "playlist-name";
    const nameValue = item.name || item.uri || "(untitled)";
    name.textContent = nameValue;
    name.title = nameValue;
    li.appendChild(name);

    if (showProgressTime && (item.duration > 0 || item.progress)){
        const durationEl = document.createElement("span");
        durationEl.className = "playlist-duration";
        if (showResumeAccent && isSignificantProgress(item)) durationEl.classList.add("resumable");
        durationEl.textContent = playlistRowDurationText(item);
        li.appendChild(durationEl);
    }

    if (showRemove){
        const removeBtn = document.createElement("button");
        removeBtn.className = "playlist-remove";
        removeBtn.type = "button";
        removeBtn.setAttribute("aria-label", "Remove from playlist");
        removeBtn.textContent = "✕";
        removeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const features = window.uiConfig.features || {};
            if (!(features.removePrompt === false)){
                const itemName = li.querySelector(".playlist-name")?.textContent || "this item";
                if (!confirm(`Remove "${itemName}" from playlist?`)) return;
            }
            playlistRemove(li.dataset.id);
        });
        li.appendChild(removeBtn);
    }

    li.addEventListener("click", (e) => {
        if (e.shiftKey && playlistMultiAvailable()){
            e.stopPropagation();
            enterPlaylistMulti();
            togglePlaylistItem(li.dataset.id);
            return;
        }
        if (playlistMultiActive){
            togglePlaylistItem(li.dataset.id);
            return;
        }
        if (controlEnabled && !isActiveRow){
            const cur = playlistItems.find(it => String(it.id) === li.dataset.id);
            if (cur) requestPlaylistPlay(cur);
        }
    });
    if (!controlEnabled && !playlistMultiAvailable()) li.style.cursor = "default";

    return li;
}

function updatePlaylistRow(li, item, playbackState, showProgressTime, showResumeAccent){
    const indicator = playlistRowIndicator(item, playbackState);
    const indicatorEl = li.querySelector(".playlist-indicator");
    if (indicatorEl && indicatorEl.textContent !== indicator) indicatorEl.textContent = indicator;

    const name = li.querySelector(".playlist-name");
    const nameValue = item.name || item.uri || "(untitled)";
    if (name){
        if (name.textContent !== nameValue) name.textContent = nameValue;
        if (name.title !== nameValue) name.title = nameValue;
    }

    if (showProgressTime){
        const durationEl = li.querySelector(".playlist-duration");
        if (durationEl){
            const text = playlistRowDurationText(item);
            if (durationEl.textContent !== text) durationEl.textContent = text;
            setClass(durationEl, "resumable", showResumeAccent && isSignificantProgress(item));
        }
    }
}

function playlistMultiAvailable(){
    if (window.uiConfig.features?.playlistSelectMulti === false) return false;
    const features = window.uiConfig.features || {};
    const buttons = window.uiConfig.buttons || {};
    return !(features.playlistControl === false) && !(buttons.removeTrack === false);
}

function updatePlaylistMultiToolbar(){
    if (!playlistMultiselectBarEl) return;
    const layout = window.uiConfig.layout || {};
    const available = playlistMultiAvailable();
    const showCheckbox = available && !(layout.showPlaylistSelectMulti === false);
    const hasContent = playlistItems.length > 0;
    const showBar = (showCheckbox && hasContent) || playlistMultiActive;
    playlistMultiselectBarEl.hidden = !showBar;
    playlistMultiselectBarEl.classList.toggle("is-overlay", playlistMultiActive && !showCheckbox);

    if (playlistMultiselectCheckEl) {
        const labelEl = playlistMultiselectCheckEl.closest("label");
        if (labelEl) labelEl.style.display = showCheckbox ? "" : "none";
    }
    const showControls = playlistMultiActive;
    if (playlistSelectAllEl) {
        playlistSelectAllEl.style.display = showControls ? "" : "none";
        const allCount = playlistItems.length;
        playlistSelectAllEl.textContent = (playlistSelected.size > 0 && playlistSelected.size === allCount) ? "Deselect all" : "Select all";
    }
    if (playlistWithSelectedEl) {
        playlistWithSelectedEl.style.display = showControls ? "" : "none";
        playlistWithSelectedEl.disabled = playlistSelected.size === 0;
    }
}

function enterPlaylistMulti(){
    if (!playlistMultiAvailable()) return;
    playlistMultiActive = true;
    playlistSelected.clear();
    if (playlistMultiselectCheckEl) playlistMultiselectCheckEl.checked = true;
    if (playlistItemsEl) playlistItemsEl.classList.add("multiselect-active");
    updatePlaylistMultiToolbar();
}

function exitPlaylistMulti(){
    playlistMultiActive = false;
    playlistSelected.clear();
    if (playlistMultiselectCheckEl) playlistMultiselectCheckEl.checked = false;
    if (playlistItemsEl) playlistItemsEl.classList.remove("multiselect-active");
    if (playlistItemsEl) {
        for (const li of playlistItemsEl.querySelectorAll(".is-selected")) li.classList.remove("is-selected");
    }
    updatePlaylistMultiToolbar();
}

function togglePlaylistItem(id){
    if (playlistSelected.has(id)) playlistSelected.delete(id);
    else playlistSelected.add(id);
    if (playlistItemsEl) {
        const li = playlistItemsEl.querySelector(`li[data-id="${CSS.escape(id)}"]`);
        if (li) li.classList.toggle("is-selected", playlistSelected.has(id));
    }
    updatePlaylistMultiToolbar();
}

function selectAllPlaylistItems(){
    if (playlistSelected.size > 0 && playlistSelected.size === playlistItems.length){
        playlistSelected.clear();
        if (playlistItemsEl) {
            for (const li of playlistItemsEl.querySelectorAll(".is-selected")) li.classList.remove("is-selected");
        }
    } else {
        for (const item of playlistItems) playlistSelected.add(String(item.id));
        if (playlistItemsEl) {
            for (const li of playlistItemsEl.querySelectorAll("li[data-id]")) li.classList.add("is-selected");
        }
    }
    updatePlaylistMultiToolbar();
}

async function playlistMultiRemove(){
    if (!sid || playlistSelected.size === 0) return;
    const features = window.uiConfig.features || {};
    const selectedIds = [...playlistSelected];

    if (!(features.removePrompt === false)){
        const names = selectedIds.map(id => {
            const item = playlistItems.find(it => String(it.id) === id);
            return item ? (item.name || item.uri || "(untitled)") : id;
        });
        const listText = names.map(n => `• ${n}`).join("\n");
        if (!confirm(`Remove ${selectedIds.length} item${selectedIds.length !== 1 ? "s" : ""} from playlist?\n\n${listText}`)) return;
    }

    const failed = [];
    for (const id of selectedIds){
        try{
            await apiPost("/api/playlist/remove", { id });
            playlistSelected.delete(id);
        }catch(e){
            const item = playlistItems.find(it => String(it.id) === id);
            failed.push(item ? (item.name || item.uri || id) : id);
        }
    }

    if (failed.length) showToast(`Failed to remove: ${failed.join(", ")}`, "err");
    if (playlistWithSelectedEl) playlistWithSelectedEl.value = "";
    updatePlaylistMultiToolbar();
}

function renderPlaylist(){
    if(!playlistItemsEl || !playlistEmptyEl) return;

    const layout = window.uiConfig.layout || {};
    const buttonsConfig = window.uiConfig.buttons || {};
    const features = window.uiConfig.features || {};
    const controlEnabled = !(features.playlistControl === false);
    const showRemove = controlEnabled && !(buttonsConfig.removeTrack === false);
    const showProgressTime = !(layout.showPlaylistProgressTime === false);
    const showResumeAccent = showProgressTime && !(layout.showPlaylistProgressTimeResume === false);
    const playbackState = String((window.__lastStatus && window.__lastStatus.state) || "").toLowerCase();

    updatePlaylistCountChip();
    updatePlaylistMultiToolbar();

    if (!playlistItems.length){
        if (playlistItemsEl.firstChild) playlistItemsEl.innerHTML = "";
        if (playlistEmptyEl.style.display !== "") playlistEmptyEl.style.display = "";
        if (playlistItemsEl.style.display !== "none") playlistItemsEl.style.display = "none";
        updatePrevNextHints();
        return;
    }
    if (playlistEmptyEl.style.display !== "none") playlistEmptyEl.style.display = "none";
    if (playlistItemsEl.style.display !== "") playlistItemsEl.style.display = "";

    const existing = new Map();
    for (const li of Array.from(playlistItemsEl.children)){
        if (li.dataset && li.dataset.id) existing.set(li.dataset.id, li);
    }

    const seen = new Set();
    let cursor = playlistItemsEl.firstChild;

    for (const item of playlistItems){
        const id = String(item.id);
        seen.add(id);
        const shape = playlistRowShape(item, playbackState, controlEnabled, showRemove, showProgressTime);

        let li = existing.get(id);
        if (!li || li.dataset.shape !== shape){
            const fresh = buildPlaylistRow(item, shape, playbackState, controlEnabled, showRemove, showProgressTime, showResumeAccent);
            if (li){
                playlistItemsEl.replaceChild(fresh, li);
            } else if (cursor){
                playlistItemsEl.insertBefore(fresh, cursor);
            } else {
                playlistItemsEl.appendChild(fresh);
            }
            existing.set(id, fresh);
            li = fresh;
        } else {
            updatePlaylistRow(li, item, playbackState, showProgressTime, showResumeAccent);
            if (cursor !== li) playlistItemsEl.insertBefore(li, cursor);
        }
        if (playlistMultiActive) li.classList.toggle("is-selected", playlistSelected.has(id));
        cursor = li.nextSibling;
    }

    for (const [id, li] of existing){
        if (!seen.has(id)) li.remove();
    }

    updatePrevNextHints();
}

function isSignificantProgress(item){
    if(!item || !item.progress) return false;
    const config = window.uiConfig.config || {};
    const watched = Number(item.progress.watched) || 0;
    const duration = Number(item.progress.duration) || Number(item.duration) || 0;
    if(duration <= 0 || watched <= 0) return false;
    const minPct  = Number(config.resumeMinPercent ?? 5);
    const minSec  = Number(config.resumeMinSeconds ?? 10);
    const maxPct  = Number(config.resumeMaxPercent ?? 95);
    const tailSec = Number(config.resumeTailSeconds ?? 300);
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
        ? `Last position: ${formatTime(watched)} of ${formatTime(total)}.`
        : `Last position: ${formatTime(watched)}.`;
    resumeBody.appendChild(nameEl);
    resumeBody.appendChild(msg);
    resumeModal.hidden = false;
    if (isKeyboardInput()) requestAnimationFrame(() => { if (btnResumeContinue) btnResumeContinue.focus(); });
    return new Promise((resolve) => { resumeResolver = resolve; });
}

function closeResumeModal(choice){
    resumeModal.hidden = true;
    const resolver = resumeResolver;
    resumeResolver = null;
    if(resolver) resolver(choice);
}

function isResumeOpen(){ return resumeModal && !resumeModal.hidden; }

btnResumeClose.addEventListener("click", () => closeResumeModal("cancel"));
btnResumeCancel.addEventListener("click", () => closeResumeModal("cancel"));
btnResumeRestart.addEventListener("click", () => closeResumeModal("restart"));
btnResumeContinue.addEventListener("click", () => closeResumeModal("resume"));
resumeModal.addEventListener("click", (e) => {
    if(e.target === resumeModal) closeResumeModal("cancel");
});

const NICKNAME_PROMPTED_KEY = "vlc_control_nickname_prompted";
const NICKNAME_KEY = "vlc_control_nickname";
const clientsModal = document.getElementById("clientsModal");
const clientsModalHint = document.getElementById("clientsModalHint");
const clientRosterEl = document.getElementById("clientRoster");
const btnClientsClose = document.getElementById("btnClientsClose");
const clientNicknameInput = document.getElementById("clientNicknameInput");
const btnClientNicknameSave = document.getElementById("btnClientNicknameSave");
const clientNicknameError = document.getElementById("clientNicknameError");
let clientRoster = [];
const clientRosterMap = new Map();
let clientsModalIsFirstConnect = false;
let clientsModalPendingSave = false;

let clientRosterTicker = null;

function mergeClientRoster(newList){
    const seen = new Set();
    for (const entry of newList){
        seen.add(entry.cid);
        clientRosterMap.set(entry.cid, { ...entry, disconnected: false });
    }
    for (const [existingCid, existingEntry] of clientRosterMap){
        if (!seen.has(existingCid) && existingEntry.reserved && !existingEntry.disconnected){
            clientRosterMap.set(existingCid, { ...existingEntry, reserved: false, disconnected: true });
        }
    }
    clientRoster = Array.from(clientRosterMap.values()).sort((a, b) => a.joined_at - b.joined_at);
}

function formatAgo(seconds){
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    if (seconds < 5) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function formatClock(epochSeconds){
    return new Date(epochSeconds * 1000).toLocaleTimeString();
}

function rosterMetaText(entry, nowSec){
    const parts = [];
    if (entry.disconnected){
        parts.push("disconnected", `joined ${formatAgo(nowSec - entry.joined_at)}`);
        if (entry.left_at != null) parts.push(`left ${formatAgo(nowSec - entry.left_at)}`);
    } else if (entry.reserved && entry.reserved_until != null && entry.reserved_until <= nowSec){
        parts.push("disconnected", `joined ${formatAgo(nowSec - entry.joined_at)}`);
        if (entry.left_at != null) parts.push(`left ${formatAgo(nowSec - entry.left_at)}`);
    } else if (entry.reserved){
        const graceLeft = entry.reserved_until != null ? Math.max(0, Math.round(entry.reserved_until - nowSec)) : null;
        parts.push(`reconnecting${graceLeft != null ? ` (${graceLeft}s left)` : ""}`, `joined ${formatAgo(nowSec - entry.joined_at)}`);
    } else {
        parts.push("connected", `joined ${formatAgo(nowSec - entry.joined_at)}`);
    }
    return parts.join(" · ");
}

function rosterTitleText(entry){
    const titleLines = [`joined at ${formatClock(entry.joined_at)}`];
    if (entry.left_at != null && (entry.reserved || entry.disconnected)){
        titleLines.push(`left at ${formatClock(entry.left_at)}`);
    }
    if (entry.reserved && entry.reserved_until != null){
        titleLines.push(`can reconnect until ${formatClock(entry.reserved_until)}`);
    }
    return titleLines.join("\n");
}

const clientRosterRowEls = new Map();

function buildClientRosterRow(entry){
    const li = document.createElement("li");
    li.className = "client-roster-item";
    li.dataset.cid = entry.cid;
    if (entry.cid === cid) li.classList.add("is-you");

    const dot = document.createElement("span");
    dot.className = "client-roster-status-dot";
    li.appendChild(dot);

    const main = document.createElement("div");
    main.className = "client-roster-main";

    const nameRow = document.createElement("div");
    nameRow.className = "client-roster-name";
    const nameText = document.createElement("span");
    nameRow.appendChild(nameText);
    if (entry.cid === cid){
        const youBadge = document.createElement("span");
        youBadge.className = "client-roster-you-badge";
        youBadge.textContent = "you";
        nameRow.appendChild(youBadge);
    }

    const meta = document.createElement("div");
    meta.className = "client-roster-meta";

    main.appendChild(nameRow);
    main.appendChild(meta);
    li.appendChild(main);
    return li;
}

function updateClientRosterRow(li, entry, nowSec){
    const isReserved = !!(entry.reserved || entry.disconnected);
    setClass(li, "is-reserved", isReserved);
    const dot = li.querySelector(".client-roster-status-dot");
    setClass(dot, "is-reserved", isReserved);

    const nameText = li.querySelector(".client-roster-name span");
    setText(nameText, entry.identity);

    const meta = li.querySelector(".client-roster-meta");
    setText(meta, rosterMetaText(entry, nowSec));
    const title = rosterTitleText(entry);
    if (meta.title !== title) meta.title = title;
    clientRosterRowEls.set(entry.cid, meta);
}

function renderClientRoster(){
    const nowSec = Date.now() / 1000;

    const existing = new Map();
    for (const li of Array.from(clientRosterEl.children)){
        if (li.dataset && li.dataset.cid) existing.set(li.dataset.cid, li);
    }

    const seen = new Set();
    let cursor = clientRosterEl.firstChild;

    for (const entry of clientRoster){
        seen.add(entry.cid);
        let li = existing.get(entry.cid);
        if (!li){
            li = buildClientRosterRow(entry);
            if (cursor) clientRosterEl.insertBefore(li, cursor);
            else clientRosterEl.appendChild(li);
            existing.set(entry.cid, li);
        } else if (cursor !== li){
            clientRosterEl.insertBefore(li, cursor);
        }
        updateClientRosterRow(li, entry, nowSec);
        cursor = li.nextSibling;
    }

    for (const [rowCid, li] of existing){
        if (!seen.has(rowCid)){
            li.remove();
            clientRosterRowEls.delete(rowCid);
        }
    }

    if (document.activeElement !== clientNicknameInput){
        const mine = clientRoster.find(entry => entry.cid === cid);
        clientNicknameInput.value = (mine && mine.nickname) || "";
    }
}

function tickClientRosterTimes(){
    const nowSec = Date.now() / 1000;
    for (const entry of clientRoster){
        const meta = clientRosterRowEls.get(entry.cid);
        if (meta) meta.textContent = rosterMetaText(entry, nowSec);
    }
}

function startClientRosterTicker(){
    if (clientRosterTicker) return;
    clientRosterTicker = setInterval(() => {
        if (isClientsOpen()) tickClientRosterTimes();
        else stopClientRosterTicker();
    }, 1000);
}

function stopClientRosterTicker(){
    if (!clientRosterTicker) return;
    clearInterval(clientRosterTicker);
    clientRosterTicker = null;
}

function openClientsModal(showHint, nicknameTaken){
    clientNicknameError.hidden = true;
    clientsModalIsFirstConnect = showHint;
    clientsModalPendingSave = false;
    clientsModalHint.hidden = !showHint;
    clientsModalHint.textContent = nicknameTaken
        ? "Someone else has the nickname you last used - pick a new one."
        : "Set a nickname so others can see who's who (optional).";
    renderClientRoster();
    clientsModal.hidden = false;
    startClientRosterTicker();
    if (isKeyboardInput()) requestAnimationFrame(() => clientNicknameInput.focus());
}

function closeClientsModal(){
    clientsModal.hidden = true;
    clientsModalPendingSave = false;
    stopClientRosterTicker();
    localStorage.setItem(NICKNAME_PROMPTED_KEY, "1");
}

function isClientsOpen(){ return clientsModal && !clientsModal.hidden; }

let nicknameSavePending = false;
let nicknameSaveValue = "";

function saveClientNickname(){
    const nickname = clientNicknameInput.value.trim();
    clientNicknameError.hidden = true;
    clientsModalPendingSave = clientsModalIsFirstConnect;
    nicknameSavePending = true;
    nicknameSaveValue = nickname;
    wsSend("set_nickname", { nickname });
}

clientsEl.addEventListener("click", () => openClientsModal(false));
btnClientsClose.addEventListener("click", closeClientsModal);
btnClientNicknameSave.addEventListener("click", saveClientNickname);
clientNicknameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter"){ e.preventDefault(); saveClientNickname(); }
});
clientsModal.addEventListener("click", (e) => {
    if (e.target === clientsModal) closeClientsModal();
});

async function requestPlaylistPlay(item){
    if(!sid || !item) return;
    const features = window.uiConfig.features || {};
    if(features.resumePrompt !== false && isSignificantProgress(item)){
        const choice = await openResumeModal(item);
        if(choice === "cancel") return;
        if(choice === "resume"){
            playlistPlay(item.id, Math.floor(Number(item.progress.watched) || 0));
            return;
        }
    }
    playlistPlay(item.id);
}

function playlistPlay(id, resumeAt){
    if (!sid) return;
    const body = { id };
    if (Number.isFinite(resumeAt) && resumeAt > 0) body.resume_at = Math.floor(resumeAt);
    if (!wsSend("playlist/play", body)) return;
    closePlaylist();
    lockForCommand("title");
}

function playlistRemove(id){
    if (!sid) return;
    if (!wsSend("playlist/remove", { id })) return;
    lockForCommand("playlist");
}

function playlistClear() {
    if (!sid) return;
    if (!confirm("Clear the entire playlist?")) return;
    if (!wsSend("playlist/clear")) return;
    lockForCommand("playlist");
}

if(btnPlaylist) btnPlaylist.addEventListener("click", openPlaylist);
if(playlistCountChip) playlistCountChip.addEventListener("click", () => {
    if (canOpenPlaylist()) openPlaylist();
});
if(btnPlaylistClose) btnPlaylistClose.addEventListener("click", closePlaylist);
if(btnPlaylistClear) btnPlaylistClear.addEventListener("click", playlistClear);
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
        if (e.key === "Backspace" && !inSearch){ e.preventDefault(); fileBrowserGoBack(); return; }
        if (inSearch && e.key === "ArrowDown"){
            const first = fileBrowserItemsEl && fileBrowserItemsEl.querySelector("li[tabindex='0']");
            if (first){ e.preventDefault(); first.focus(); return; }
        }
        if (!inSearch && fileBrowserItemsEl && listArrowNav(fileBrowserItemsEl, e)) return;
        if (!inSearch && e.key === "Enter"){
            const ae = document.activeElement;
            if (ae && ae.tagName === "LI" && fileBrowserItemsEl.contains(ae)){
                e.preventDefault();
                ae.click();
            }
            return;
        }
        if (!inSearch && (e.key === " " || e.key === "Spacebar")){
            if (e.shiftKey && fileBrowserMultiAvailable()){
                e.preventDefault(); e.stopPropagation();
                if (fileBrowserMultiActive) exitFileBrowserMulti();
                else enterFileBrowserMulti();
                return;
            }
            const ae = document.activeElement;
            if (ae && ae.tagName === "LI" && fileBrowserItemsEl.contains(ae)){
                const playBtn = ae.querySelector(".file-browser-btn.play");
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
        if ((e.key === " " || e.key === "Spacebar") && e.shiftKey && playlistMultiAvailable()){
            e.preventDefault(); e.stopPropagation();
            if (playlistMultiActive) exitPlaylistMulti();
            else enterPlaylistMulti();
            return;
        }
        if (e.key === " " || e.key === "Spacebar"){
            e.preventDefault(); e.stopPropagation();
            const state = String((window.__lastStatus && window.__lastStatus.state) || "").toLowerCase();
            const current = playlistItems.find(it => it.isCurrent);
            if (current && state !== "playing" && state !== "paused"){
                requestPlaylistPlay(current);
            } else {
                sendApiCommand("toggle");
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
            const removeBtn = ae.querySelector(".playlist-remove");
            if (removeBtn){ e.preventDefault(); removeBtn.click(); }
            return;
        }
    }
    if (isClientsOpen()){
        if (trapTab(clientsModal, e)) return;
        if (e.key === "Escape"){ e.preventDefault(); closeClientsModal(); return; }
    }
});

const fileBrowserModal = document.getElementById("fileBrowserModal");
const fileBrowserItemsEl = document.getElementById("fileBrowserItems");
const fileBrowserEmptyEl = document.getElementById("fileBrowserEmpty");
const fileBrowserCrumbsEl = document.getElementById("fileBrowserCrumbs");
const fileBrowserSearchEl = document.getElementById("fileBrowserSearch");
const btnFileBrowserClose = document.getElementById("btnFileBrowserClose");
const btnFileBrowserView = document.getElementById("btnFileBrowserView");
const btnPlaylistAddFiles = document.getElementById("btnPlaylistAddFiles");
const fileBrowserMultiselectBarEl = document.getElementById("fileBrowserMultiselectBar");
const fileBrowserMultiselectCheckEl = document.getElementById("fileBrowserMultiselectCheck");
const fileBrowserSelectAllEl = document.getElementById("fileBrowserSelectAll");
const fileBrowserWithSelectedEl = document.getElementById("fileBrowserWithSelected");

const FILE_BROWSER_VIEW_KEY = "vlc_fb_view"; // "grid" | "list"
function getFileBrowserViewMode(){
    try {
        const v = localStorage.getItem(FILE_BROWSER_VIEW_KEY);
        if (v === "grid" || v === "list") return v;
    } catch(_e){}
    const config = window.uiConfig.config || {};
    return config.fileBrowserAsGrid ? "grid" : "list";
}
function setFileBrowserViewMode(mode){
    const normalized = (mode === "grid") ? "grid" : "list";
    try { localStorage.setItem(FILE_BROWSER_VIEW_KEY, normalized); } catch(_e){}
    applyFileBrowserViewMode();
}
function applyFileBrowserViewMode(){
    if (!fileBrowserItemsEl) return;
    const mode = getFileBrowserViewMode();
    const isGrid = mode === "grid";
    setClass(fileBrowserItemsEl, "grid", isGrid);
    if (btnFileBrowserView){
        const icon = isGrid ? "≣" : "▦";
        const label = isGrid ? "Switch to list view" : "Switch to grid view";
        if (btnFileBrowserView.textContent !== icon) btnFileBrowserView.textContent = icon;
        if (btnFileBrowserView.title !== label) btnFileBrowserView.title = label;
        btnFileBrowserView.setAttribute("aria-label", label);
    }
}
const toastHost = document.getElementById("toastHost");

function showToast(msg, kind, ms){
    if (!toastHost) return;
    const t = document.createElement("div");
    t.className = "toast" + (kind ? ` ${kind}` : "");
    t.textContent = String(msg || "");
    toastHost.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    if (ms === Infinity) return t;
    const life = Number(ms) > 0 ? Number(ms) : 2800;
    setTimeout(() => {
        t.classList.remove("show");
        const done = () => { try { t.remove(); } catch(_e){} };
        t.addEventListener("transitionend", done, { once: true });
        setTimeout(done, 400);
    }, life);
    return t;
}

function dismissToast(t){
    if (!t) return;
    t.classList.remove("show");
    const done = () => { try { t.remove(); } catch(_e){} };
    t.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 400);
}

let fileBrowserState = { rootId: null, rootLabel: "", path: "", entries: [], roots: [] };

function openFileBrowser(){
    if (!fileBrowserModal) return;
    if (window.uiConfig.features?.fileBrowser === false) return;
    fileBrowserModal.hidden = false;
    fileBrowserState = { rootId: null, rootLabel: "", path: "", entries: [], roots: [] };
    if (fileBrowserSearchEl) fileBrowserSearchEl.value = "";
    applyFileBrowserViewMode();
    loadFileBrowserRoots();
    if (isKeyboardInput()) requestAnimationFrame(() => { if (fileBrowserSearchEl) fileBrowserSearchEl.focus(); });
}
function closeFileBrowser(){
    if (!fileBrowserModal) return;
    fileBrowserModal.hidden = true;
    if (fileBrowserMultiActive) exitFileBrowserMulti();
}
function isFileBrowserOpen(){ return fileBrowserModal && !fileBrowserModal.hidden; }

function fileStatus(entry){
    if (!entry || entry.type !== "file") return null;
    if (entry.isCurrent) return { kind: "playing", icon: "▶", title: "Playing now" };
    const p = entry.progress;
    if (p){
        const watched = Number(p.watched) || 0;
        const duration = Number(p.duration) || Number(entry.duration) || 0;
        if (duration > 0 && watched > 0){
            const config = window.uiConfig.config || {};
            const minPct  = Number(config.resumeMinPercent ?? 5);
            const minSec  = Number(config.resumeMinSeconds ?? 10);
            const maxPct  = Number(config.resumeMaxPercent ?? 95);
            const tailSec = Number(config.resumeTailSeconds ?? 300);
            const floor = Math.max(duration * minPct / 100, minSec);
            const ceil  = Math.min(duration * maxPct / 100, duration - tailSec);
            if (watched >= ceil) return { kind: "completed", icon: "✓", title: "Played - completed" };
            if (watched > floor) return { kind: "partial", icon: "◐", title: `Partial - ${formatTime(Math.floor(watched))} of ${formatTime(Math.floor(duration))}` };
        }
    }
    if (entry.inPlaylist) return { kind: "queued", icon: "📥", title: "In playlist" };
    return null;
}

function formatFileSize(n){
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    const u = ["KB", "MB", "GB", "TB"];
    let i = -1; let v = n;
    do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
    return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

//TODO: make a page loader & disable while transitioning
async function loadFileBrowserRoots(){
    if (!sid) return;
    try{
        const response = await apiGet("/api/files/roots");
        const data = await response.json();
        fileBrowserState.roots = Array.isArray(data) ? data : [];
        if (fileBrowserState.roots.length === 1){
            await loadFileBrowserDirectory(fileBrowserState.roots[0].id, "");
        } else {
            fileBrowserState.rootId = null;
            fileBrowserState.rootLabel = "";
            fileBrowserState.path = "";
            fileBrowserState.entries = fileBrowserState.roots.map(x => ({ name: x.label, type: "root", rootId: x.id }));
            renderFileBrowser();
        }
    }catch(e){
        console.error("roots load failed", e);
        fileBrowserState.entries = [];
        renderFileBrowser();
    }
}

function reconcileFileBrowserEntriesFromPlaylist(){
    if (!Array.isArray(fileBrowserState.entries) || !fileBrowserState.entries.length) return;
    const byUri = new Map();
    const byId = new Map();
    for (const it of playlistItems){
        if (it.uri) byUri.set(it.uri, it);
        if (it.id != null) byId.set(String(it.id), it);
    }
    for (const entry of fileBrowserState.entries){
        if (entry.type !== "file") continue;
        const match = (entry.uri && byUri.get(entry.uri)) || (entry.playlistId && byId.get(String(entry.playlistId))) || null;
        if (match){
            entry.inPlaylist = true;
            if (match.id != null) entry.playlistId = String(match.id);
            entry.isCurrent = !!match.isCurrent;
            if (match.progress) entry.progress = Object.assign({}, match.progress);
            else delete entry.progress;
            if (match.duration && !entry.progress) entry.duration = match.duration;
        } else {
            delete entry.inPlaylist;
            delete entry.playlistId;
            delete entry.isCurrent;
            delete entry.progress;
        }
    }
}

async function loadFileBrowserDirectory(rootId, path){
    if (!sid) return;
    try{
        const response = await apiGet(`/api/files?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path || "")}`);
        const data = await response.json();
        fileBrowserState.rootId = data.root.id;
        fileBrowserState.rootLabel = data.root.label;
        fileBrowserState.path = data.path || "";
        fileBrowserState.entries = Array.isArray(data.entries) ? data.entries : [];
        if (fileBrowserMultiActive) fileBrowserSelected.clear();
        renderFileBrowser();
    }catch(e){
        console.error("dir load failed", e);
    }
}

function fileBrowserParentPath(p){
    if (!p) return "";
    const parts = p.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
}

function fileBrowserChildPath(name){
    return fileBrowserState.path ? `${fileBrowserState.path}/${name}` : name;
}

function renderFileBrowserBreadcrumbs(){
    if (!fileBrowserCrumbsEl) return;
    const sig = `${fileBrowserState.rootId || ""}|${fileBrowserState.path || ""}|${fileBrowserState.roots.length}|${fileBrowserState.rootLabel || ""}`;
    if (fileBrowserCrumbsEl.dataset.sig === sig) return;
    fileBrowserCrumbsEl.dataset.sig = sig;
    fileBrowserCrumbsEl.innerHTML = "";

    const addCrumb = (label, onClick, isCurrent) => {
        const el = document.createElement(onClick ? "button" : "span");
        el.className = "file-browser-crumb" + (isCurrent ? " current" : "");
        el.textContent = label;
        if (onClick){ el.type = "button"; el.addEventListener("click", onClick); }
        fileBrowserCrumbsEl.appendChild(el);
    };
    const addSep = () => {
        const s = document.createElement("span");
        s.className = "file-browser-crumb-sep"; s.textContent = "›";
        fileBrowserCrumbsEl.appendChild(s);
    };

    const multiRoot = fileBrowserState.roots.length > 1;

    if (!fileBrowserState.rootId){
        addCrumb("Root", null, true);
        return;
    }
    if (multiRoot){
        addCrumb("Root", () => loadFileBrowserRoots(), false);
        addSep();
    }

    const parts = (fileBrowserState.path || "").split("/").filter(Boolean);
    if (parts.length === 0){
        addCrumb(fileBrowserState.rootLabel, null, true);
    } else {
        addCrumb(fileBrowserState.rootLabel, () => loadFileBrowserDirectory(fileBrowserState.rootId, ""), false);
        let acc = "";
        parts.forEach((seg, i) => {
            addSep();
            acc = acc ? `${acc}/${seg}` : seg;
            const last = (i === parts.length - 1);
            if (last){
                addCrumb(seg, null, true);
            } else {
                const target = acc;
                addCrumb(seg, () => loadFileBrowserDirectory(fileBrowserState.rootId, target), false);
            }
        });
    }
}

function fileBrowserEntryKey(entry){
    if (entry.type === "up") return "up";
    if (entry.type === "root") return `root:${entry.rootId}`;
    if (entry.type === "group-header") return `group-header:${entry.label}`;
    return `${entry.type}:${entry.name}`;
}

function buildFileBrowserRow(entry){
    if (entry.type === "group-header"){
        const li = document.createElement("li");
        li.className = "file-browser-group-header";
        li.dataset.key = fileBrowserEntryKey(entry);
        li.dataset.type = "group-header";
        li.setAttribute("aria-hidden", "true");
        li.addEventListener("click", () => toggleFileBrowserGroup(li));
        const labelEl = document.createElement("span");
        labelEl.className = "file-browser-group-label";
        labelEl.textContent = entry.label;
        li.appendChild(labelEl);
        return li;
    }

    const li = document.createElement("li");
    const isDirish = (entry.type === "dir" || entry.type === "root");
    const isUp = (entry.type === "up");
    li.className = "playlist-item file-browser-item" + (isDirish ? " dir" : "") + (isUp ? " up" : "");
    li.tabIndex = 0;
    li.setAttribute("role", "option");
    li.dataset.key = fileBrowserEntryKey(entry);
    li.dataset.type = entry.type;

    const layout = window.uiConfig.layout || {};
    const buttonsConfig = window.uiConfig.buttons || {};
    const showIcons = !(layout.showFileBrowserFileIcons === false);
    const showSize = !(layout.showFileBrowserFileSize === false);
    const showIndicator = !(layout.showFileBrowserFileIndicator === false);

    const indicatorEl = document.createElement("span");
    indicatorEl.className = "playlist-indicator";
    indicatorEl.textContent = isUp ? "⬆" : (isDirish ? "📁" : "🎬");
    if (!showIcons) indicatorEl.style.display = "none";
    li.appendChild(indicatorEl);

    const name = document.createElement("span");
    name.className = "playlist-name";
    const nameValue = entry.name || "(untitled)";
    const nameDisplay = (!showIcons && entry.type === "dir") ? `/${nameValue}` : nameValue;
    name.textContent = nameDisplay;
    name.title = nameValue;
    li.appendChild(name);
    const showAdd = !(buttonsConfig.addFile === false);
    const showPlay = !(buttonsConfig.playFile === false);

    if (entry.type === "file"){
        const badge = document.createElement("span");
        badge.className = "file-browser-status";
        badge.hidden = true;
        if (!showIndicator) badge.style.display = "none";
        li.appendChild(badge);

        const sizeEl = document.createElement("span");
        sizeEl.className = "file-browser-size";
        if (entry.size == null) sizeEl.hidden = true;
        else sizeEl.textContent = formatFileSize(entry.size);
        if (!showSize) sizeEl.style.display = "none";
        li.appendChild(sizeEl);
    }

    if (isUp){
        li.addEventListener("click", () => fileBrowserGoBack());
    } else if (isDirish){
        li.addEventListener("click", () => {
            const type = li.dataset.type;
            const name = li.dataset.entryName;
            if (type === "root") loadFileBrowserDirectory(li.dataset.rootId, "");
            else loadFileBrowserDirectory(fileBrowserState.rootId, fileBrowserChildPath(name));
        });
    } else {
        li.addEventListener("click", (e) => {
            if (e.shiftKey && fileBrowserMultiAvailable()){
                e.stopPropagation();
                enterFileBrowserMulti();
                toggleFileBrowserItem(li.dataset.key);
                return;
            }
            if (fileBrowserMultiActive){
                toggleFileBrowserItem(li.dataset.key);
            }
        });

        const actions = document.createElement("span");
        actions.className = "file-browser-actions";

        if (showAdd){
            const addBtn = document.createElement("button");
            addBtn.className = "file-browser-btn add";
            addBtn.type = "button";
            addBtn.textContent = "➕";
            addBtn.title = "Add to playlist";
            addBtn.addEventListener("click", (ev) => { ev.stopPropagation(); filesAdd(li.dataset.entryName); });
            actions.appendChild(addBtn);
        }

        if (showPlay){
            const playBtn = document.createElement("button");
            playBtn.className = "file-browser-btn play";
            playBtn.type = "button";
            playBtn.textContent = "▶";
            playBtn.title = "Play now";
            playBtn.addEventListener("click", (ev) => { ev.stopPropagation(); filesPlay(li.dataset.entryName); });
            actions.appendChild(playBtn);
        }

        li.appendChild(actions);
    }

    updateFileBrowserRow(li, entry);
    return li;
}

function updateFileBrowserRow(li, entry){
    if (entry.type === "group-header") return;
    li.dataset.entryName = entry.name || "";
    if (entry.type === "root" && entry.rootId) li.dataset.rootId = entry.rootId;

    const name = li.querySelector(".playlist-name");
    const nameValue = entry.name || "(untitled)";
    if (name){
        const showIcons = !((window.uiConfig.layout || {}).showFileBrowserFileIcons === false);
        const nameDisplay = (!showIcons && entry.type === "dir") ? `/${nameValue}` : nameValue;
        if (name.textContent !== nameDisplay) name.textContent = nameDisplay;
        if (name.title !== nameValue) name.title = nameValue;
    }

    if (entry.type === "file"){
        const badge = li.querySelector(".file-browser-status");
        const st = fileStatus(entry);
        if (badge){
            if (st){
                const cls = `file-browser-status ${st.kind}`;
                if (badge.className !== cls) badge.className = cls;
                if (badge.textContent !== st.icon) badge.textContent = st.icon;
                if (badge.title !== st.title) badge.title = st.title;
                if (badge.hidden) badge.hidden = false;
            } else {
                if (!badge.hidden) badge.hidden = true;
            }
        }
        const sizeEl = li.querySelector(".file-browser-size");
        if (sizeEl){
            if (entry.size != null){
                const text = formatFileSize(entry.size);
                if (sizeEl.textContent !== text) sizeEl.textContent = text;
                if (sizeEl.hidden) sizeEl.hidden = false;
            } else if (!sizeEl.hidden){
                sizeEl.hidden = true;
            }
        }
    }
}

function fileBrowserMultiAvailable(){
    if (window.uiConfig.features?.fileBrowserSelectMulti === false) return false;
    const features = window.uiConfig.features || {};
    const buttons = window.uiConfig.buttons || {};
    const canAdd = !(buttons.addFile === false);
    const canRemove = !(features.playlistControl === false) && !(buttons.removeTrack === false);
    return canAdd || canRemove;
}

function updateFileBrowserMultiToolbar(){
    if (!fileBrowserMultiselectBarEl) return;
    const layout = window.uiConfig.layout || {};
    const available = fileBrowserMultiAvailable();
    const showCheckbox = available && !(layout.showFileBrowserSelectMulti === false);
    const hasContent = fileBrowserState.entries.some(e => e.type === "file");
    const showBar = (showCheckbox && hasContent) || fileBrowserMultiActive;
    fileBrowserMultiselectBarEl.hidden = !showBar;
    fileBrowserMultiselectBarEl.classList.toggle("is-overlay", fileBrowserMultiActive && !showCheckbox);

    if (fileBrowserMultiselectCheckEl) {
        const labelEl = fileBrowserMultiselectCheckEl.closest("label");
        if (labelEl) labelEl.style.display = showCheckbox ? "" : "none";
    }
    const showControls = fileBrowserMultiActive;
    if (fileBrowserSelectAllEl) {
        fileBrowserSelectAllEl.style.display = showControls ? "" : "none";
        const fileItems = fileBrowserItemsEl ? Array.from(fileBrowserItemsEl.querySelectorAll("li[data-type='file']")) : [];
        const allSelected = fileItems.length > 0 && fileItems.every(li => fileBrowserSelected.has(li.dataset.key));
        fileBrowserSelectAllEl.textContent = allSelected ? "Deselect all" : "Select all";
    }
    if (fileBrowserWithSelectedEl) {
        fileBrowserWithSelectedEl.style.display = showControls ? "" : "none";
        fileBrowserWithSelectedEl.disabled = fileBrowserSelected.size === 0;
    }
}

function updateFileBrowserGroupHeaders(){
    if (!fileBrowserItemsEl) return;
    const headers = fileBrowserItemsEl.querySelectorAll("li[data-type='group-header']");
    for (const header of headers){
        const items = [];
        let sib = header.nextSibling;
        while (sib && sib.dataset.type !== "group-header"){
            if (sib.dataset && sib.dataset.type === "file") items.push(sib);
            sib = sib.nextSibling;
        }
        const keys = items.map(el => el.dataset.key);
        const allSelected = keys.length > 0 && keys.every(k => fileBrowserSelected.has(k));
        const anySelected = keys.some(k => fileBrowserSelected.has(k));
        header.classList.toggle("group-all-selected", allSelected);
        header.classList.toggle("group-partial", anySelected && !allSelected);
    }
}

function enterFileBrowserMulti(){
    if (!fileBrowserMultiAvailable()) return;
    fileBrowserMultiActive = true;
    fileBrowserSelected.clear();
    if (fileBrowserMultiselectCheckEl) fileBrowserMultiselectCheckEl.checked = true;
    if (fileBrowserItemsEl) fileBrowserItemsEl.classList.add("multiselect-active");
    updateFileBrowserMultiToolbar();
}

function exitFileBrowserMulti(){
    fileBrowserMultiActive = false;
    fileBrowserSelected.clear();
    if (fileBrowserMultiselectCheckEl) fileBrowserMultiselectCheckEl.checked = false;
    if (fileBrowserItemsEl) fileBrowserItemsEl.classList.remove("multiselect-active");
    if (fileBrowserItemsEl) {
        for (const li of fileBrowserItemsEl.querySelectorAll(".is-selected")) li.classList.remove("is-selected");
        for (const li of fileBrowserItemsEl.querySelectorAll(".group-all-selected,.group-partial")){
            li.classList.remove("group-all-selected", "group-partial");
        }
    }
    updateFileBrowserMultiToolbar();
}

function toggleFileBrowserItem(key){
    if (fileBrowserSelected.has(key)) fileBrowserSelected.delete(key);
    else fileBrowserSelected.add(key);
    if (fileBrowserItemsEl) {
        const li = fileBrowserItemsEl.querySelector(`li[data-key="${CSS.escape(key)}"]`);
        if (li) li.classList.toggle("is-selected", fileBrowserSelected.has(key));
    }
    updateFileBrowserMultiToolbar();
    updateFileBrowserGroupHeaders();
}

function toggleFileBrowserGroup(headerLi){
    if (!fileBrowserMultiActive || !fileBrowserItemsEl) return;
    const items = [];
    let sib = headerLi.nextSibling;
    while (sib && (!sib.dataset || sib.dataset.type !== "group-header")){
        if (sib.dataset && sib.dataset.type === "file") items.push(sib);
        sib = sib.nextSibling;
    }
    const keys = items.map(el => el.dataset.key);
    const allSelected = keys.length > 0 && keys.every(k => fileBrowserSelected.has(k));
    if (allSelected){
        keys.forEach(k => fileBrowserSelected.delete(k));
    } else {
        keys.forEach(k => fileBrowserSelected.add(k));
    }
    items.forEach(el => el.classList.toggle("is-selected", fileBrowserSelected.has(el.dataset.key)));
    updateFileBrowserMultiToolbar();
    updateFileBrowserGroupHeaders();
}

function selectAllFileBrowserItems(){
    if (!fileBrowserItemsEl) return;
    const fileItems = Array.from(fileBrowserItemsEl.querySelectorAll("li[data-type='file']"));
    const allSelected = fileItems.length > 0 && fileItems.every(li => fileBrowserSelected.has(li.dataset.key));
    if (allSelected){
        fileItems.forEach(li => { fileBrowserSelected.delete(li.dataset.key); li.classList.remove("is-selected"); });
    } else {
        fileItems.forEach(li => { fileBrowserSelected.add(li.dataset.key); li.classList.add("is-selected"); });
    }
    updateFileBrowserMultiToolbar();
    updateFileBrowserGroupHeaders();
}

async function fileBrowserMultiAdd(){
    if (!sid || !fileBrowserState.rootId || fileBrowserSelected.size === 0) return;
    const fileItems = fileBrowserItemsEl
        ? Array.from(fileBrowserItemsEl.querySelectorAll("li[data-type='file']")).filter(li => fileBrowserSelected.has(li.dataset.key))
        : [];
    if (!fileItems.length) return;

    const failed = [];
    for (const li of fileItems){
        const name = li.dataset.entryName;
        try{
            const rel = fileBrowserChildPath(name);
            await apiPost("/api/files/add", { root: fileBrowserState.rootId, path: rel });
            fileBrowserSelected.delete(li.dataset.key);
            li.classList.remove("is-selected");
        }catch(e){
            failed.push(name);
        }
    }

    const added = fileItems.length - failed.length;
    if (added > 0) showToast(`Added ${added} file${added !== 1 ? "s" : ""}`, "ok");
    if (failed.length) showToast(`Failed to add: ${failed.join(", ")}`, "err");
    if (fileBrowserWithSelectedEl) fileBrowserWithSelectedEl.value = "";
    updateFileBrowserMultiToolbar();
    updateFileBrowserGroupHeaders();
}

async function fileBrowserMultiRemove(){
    if (!sid || fileBrowserSelected.size === 0) return;
    const features = window.uiConfig.features || {};

    const fileItems = fileBrowserItemsEl
        ? Array.from(fileBrowserItemsEl.querySelectorAll("li[data-type='file']")).filter(li => fileBrowserSelected.has(li.dataset.key))
        : [];

    const toRemove = [];
    for (const li of fileItems){
        const entry = fileBrowserState.entries.find(en => en.type === "file" && en.name === li.dataset.entryName);
        if (!entry) continue;
        const matching = playlistItems.filter(it =>
            (entry.uri && it.uri === entry.uri) ||
            (entry.playlistId && String(it.id) === String(entry.playlistId))
        );
        for (const item of matching) {
            toRemove.push({
                id: String(item.id),
                name: item.name || item.uri || entry.name,
                key: li.dataset.key
            });
        }
    }

    if (!toRemove.length){
        showToast("None of the selected files are in the playlist", "info");
        if (fileBrowserWithSelectedEl) fileBrowserWithSelectedEl.value = "";
        return;
    }

    if (!(features.removePrompt === false)){
        const listText = toRemove.map(it => `• ${it.name}`).join("\n");
        if (!confirm(`Remove ${toRemove.length} item${toRemove.length !== 1 ? "s" : ""} from playlist?\n\n${listText}`)) return;
    }

    const failed = [];
    const successKeys = new Set();
    for (const item of toRemove){
        try{
            await apiPost("/api/playlist/remove", { id: item.id });
            successKeys.add(item.key);
        }catch(e){
            failed.push(item.name);
        }
    }

    for (const key of successKeys){
        fileBrowserSelected.delete(key);
        if (fileBrowserItemsEl){
            const li = fileBrowserItemsEl.querySelector(`li[data-key="${CSS.escape(key)}"]`);
            if (li) li.classList.remove("is-selected");
        }
    }

    if (failed.length) showToast(`Failed to remove: ${failed.join(", ")}`, "err");
    if (fileBrowserWithSelectedEl) fileBrowserWithSelectedEl.value = "";
    updateFileBrowserMultiToolbar();
    updateFileBrowserGroupHeaders();
}

function renderFileBrowser(){
    if (!fileBrowserItemsEl || !fileBrowserEmptyEl) return;
    renderFileBrowserBreadcrumbs();
    updateFileBrowserMultiToolbar();

    const filter = (fileBrowserSearchEl && fileBrowserSearchEl.value || "").trim().toLowerCase();
    const base = fileBrowserState.entries.filter(entry => !filter || entry.name.toLowerCase().includes(filter));
    const multiRoot = fileBrowserState.roots.length > 1;
    const inSubdir = !!fileBrowserState.rootId && !!fileBrowserState.path;
    const atRootTop = !!fileBrowserState.rootId && !fileBrowserState.path;
    const showUp = inSubdir || (atRootTop && multiRoot);
    const layout = window.uiConfig.layout || {};
    const grouped = !(layout.showFileBrowserFilesGrouped === false);
    const sorted = grouped ? (() => {
        const extOf = n => { const i = (n || "").lastIndexOf("."); return i > 0 ? n.slice(i + 1).toLowerCase() : ""; };
        const dirs = base.filter(e => e.type !== "file");
        const files = base.filter(e => e.type === "file");
        files.sort((a, b) => {
            const extA = extOf(a.name), extB = extOf(b.name);
            if (extA !== extB){
                if (!extA) return 1;
                if (!extB) return -1;
                return extA.localeCompare(extB);
            }
            return (a.name || "").localeCompare(b.name || "");
        });
        const result = [];
        if (dirs.length){
            result.push({ type: "group-header", label: "Folders" });
            result.push(...dirs);
        }
        const byExt = new Map();
        for (const f of files){
            const ext = extOf(f.name);
            if (!byExt.has(ext)) byExt.set(ext, []);
            byExt.get(ext).push(f);
        }
        const exts = [...byExt.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
        for (const ext of exts){
            result.push({ type: "group-header", label: ext ? ext.toUpperCase() : "Other" });
            result.push(...byExt.get(ext));
        }
        return result;
    })() : base;
    const entries = showUp ? [{ name: "Up one level", type: "up" }, ...sorted] : sorted;

    if (!entries.length){
        if (fileBrowserItemsEl.firstChild) fileBrowserItemsEl.innerHTML = "";
        if (fileBrowserEmptyEl.style.display !== "") fileBrowserEmptyEl.style.display = "";
        if (fileBrowserItemsEl.style.display !== "none") fileBrowserItemsEl.style.display = "none";
        return;
    }
    if (fileBrowserEmptyEl.style.display !== "none") fileBrowserEmptyEl.style.display = "none";
    if (fileBrowserItemsEl.style.display !== "") fileBrowserItemsEl.style.display = "";

    const existing = new Map();
    for (const li of Array.from(fileBrowserItemsEl.children)){
        if (li.dataset && li.dataset.key) existing.set(li.dataset.key, li);
    }

    const seen = new Set();
    let cursor = fileBrowserItemsEl.firstChild;

    for (const entry of entries){
        const key = fileBrowserEntryKey(entry);
        seen.add(key);

        let li = existing.get(key);
        if (!li){
            const fresh = buildFileBrowserRow(entry);
            if (cursor) fileBrowserItemsEl.insertBefore(fresh, cursor);
            else fileBrowserItemsEl.appendChild(fresh);
            existing.set(key, fresh);
            li = fresh;
        } else {
            updateFileBrowserRow(li, entry);
            if (cursor !== li) fileBrowserItemsEl.insertBefore(li, cursor);
        }
        if (fileBrowserMultiActive && entry.type === "file") li.classList.toggle("is-selected", fileBrowserSelected.has(key));
        cursor = li.nextSibling;
    }

    for (const [key, li] of existing){
        if (!seen.has(key)) li.remove();
    }

    if (fileBrowserMultiActive) updateFileBrowserGroupHeaders();
}

async function filesAdd(name){
    if (!sid || !fileBrowserState.rootId) return;
    const rel = fileBrowserChildPath(name);
    setUiBusy(true, "Adding…");
    try{
        const response = await apiPost("/api/files/add", { root: fileBrowserState.rootId, path: rel });
        const data = await response.json().catch(() => ({}));
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
    if (!sid || !fileBrowserState.rootId) return;
    const rel = fileBrowserChildPath(name);

    const entry = fileBrowserState.entries.find(item => item.type === "file" && item.name === name);
    let resumeAt = 0;
    const features = window.uiConfig.features || {};
    if (entry && features.resumePrompt !== false && isSignificantProgress(entry)){
        const choice = await openResumeModal(entry);
        if (choice === "cancel") return;
        if (choice === "resume"){
            resumeAt = Math.max(0, Math.floor(Number(entry.progress.watched) || 0));
        }
    }

    setUiBusy(true, "Sending…");
    try{
        const body = { root: fileBrowserState.rootId, path: rel };
        if (resumeAt > 0) body.resume_at = resumeAt;
        const response = await apiPost("/api/files/play", body);
        const data = await response.json().catch(() => ({}));
        if (data.status === "jumped"){
            showToast(resumeAt > 0 ? `Resuming: ${name}` : `Playing existing entry: ${name}`, "info");
        } else {
            showToast(resumeAt > 0 ? `Resuming: ${name}` : `Added & playing: ${name}`, "ok");
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

function fileBrowserGoBack(){
    if (!fileBrowserState.rootId){ closeFileBrowser(); return; }
    if (!fileBrowserState.path){
        if (fileBrowserState.roots.length > 1) loadFileBrowserRoots();
        else closeFileBrowser();
        return;
    }
    loadFileBrowserDirectory(fileBrowserState.rootId, fileBrowserParentPath(fileBrowserState.path));
}

if (btnPlaylistAddFiles) btnPlaylistAddFiles.addEventListener("click", openFileBrowser);
if (btnFileBrowserClose) btnFileBrowserClose.addEventListener("click", closeFileBrowser);
if (btnFileBrowserView) btnFileBrowserView.addEventListener("click", () => {
    setFileBrowserViewMode(getFileBrowserViewMode() === "grid" ? "list" : "grid");
});
if (fileBrowserModal){
    fileBrowserModal.addEventListener("click", (e) => {
        if (e.target === fileBrowserModal) closeFileBrowser();
    });
}
if (fileBrowserSearchEl) fileBrowserSearchEl.addEventListener("input", () => renderFileBrowser());

if (playlistMultiselectCheckEl){
    playlistMultiselectCheckEl.addEventListener("change", () => {
        if (playlistMultiselectCheckEl.checked) enterPlaylistMulti();
        else exitPlaylistMulti();
    });
}
if (playlistSelectAllEl) playlistSelectAllEl.addEventListener("click", selectAllPlaylistItems);
if (playlistWithSelectedEl){
    playlistWithSelectedEl.addEventListener("change", () => {
        const action = playlistWithSelectedEl.value;
        if (!action) return;
        if (action === "remove") playlistMultiRemove();
    });
}

if (fileBrowserMultiselectCheckEl){
    fileBrowserMultiselectCheckEl.addEventListener("change", () => {
        if (fileBrowserMultiselectCheckEl.checked) enterFileBrowserMulti();
        else exitFileBrowserMulti();
    });
}
if (fileBrowserSelectAllEl) fileBrowserSelectAllEl.addEventListener("click", selectAllFileBrowserItems);
if (fileBrowserWithSelectedEl){
    fileBrowserWithSelectedEl.addEventListener("change", () => {
        const action = fileBrowserWithSelectedEl.value;
        if (!action) return;
        if (action === "add") fileBrowserMultiAdd();
        else if (action === "remove") fileBrowserMultiRemove();
    });
}

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
                if (ws){ shutdownNotified = true; try{ ws.close(); }catch{} ws = null; }
            }
        }

        const delay = 2000 + Math.floor(Math.random() * 1500);
        pollTimer = setTimeout(() => { pollTimer = null; tick(); }, delay);
    };

    tick();
}

document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // backgrounded tabs can have their socket die silently (mobile OS suspension) without onclose firing
    if (ws && ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) ws = null;
    if (!ws) connectWS();
});

function connectWS(){
    if (sid) return;
    if (ws) return;

    const proto = (location.protocol === "https:") ? "wss" : "ws";
    const storedNickname = localStorage.getItem(NICKNAME_KEY) || "";
    const url = `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&cid=${encodeURIComponent(cid)}`
        + (storedNickname ? `&nickname=${encodeURIComponent(storedNickname)}` : "");
    ws = new WebSocket(url);

    ws.onopen = () => { if (wsEl) wsEl.textContent = "ws: connected"; };

    ws.onclose = (ev) => {
        ws = null;
        if (!shutdownNotified && ev.code !== 1001 && !document.hidden) lostConnectionToast = showToast("Connection to host lost", "err", Infinity);
        shutdownNotified = false;
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
                if (Array.isArray(d.list)){
                    mergeClientRoster(d.list);
                    if (isClientsOpen()) renderClientRoster();
                }
            }

            if (msg.type === "nickname_ok"){
                nicknameSavePending = false;
                localStorage.setItem(NICKNAME_KEY, nicknameSaveValue);
                if (clientsModalPendingSave && isClientsOpen()) closeClientsModal();
            }

            if (msg.type === "cmd_error"){
                if (msg.op === "set_nickname"){
                    clientsModalPendingSave = false;
                    nicknameSavePending = false;
                    const friendly = msg.message === "nickname taken" ? "That nickname is already taken" : "Something went wrong";
                    clientNicknameError.textContent = friendly;
                    clientNicknameError.hidden = false;
                    return;
                }
                if (_cmdLock) {
                    if (_cmdLock.expect === "seek") _optimisticSeekSec = null;
                    _unlockCommand();
                }
                const knownErrors = {
                    "seeking not allowed": "Seeking is disabled",
                    "playlist control not allowed": "Playlist control is disabled",
                    "id required": "Something went wrong",
                    "val required": "Something went wrong",
                    "unknown op": "Something went wrong",
                };
                const friendly = knownErrors[msg.message] ?? "VLC is not responding";
                showToast(friendly, "err");
                console.warn("cmd_error", msg);
                return;
            }

            if (msg.type === "shutdown"){
                const reasons = {
                    stopped: "Host stopped the session",
                    crashed: "Host crashed unexpectedly",
                };
                shutdownNotified = true;
                showToast(reasons[msg.reason] || "Host disconnected", "err", Infinity);
                return;
            }

            if (msg.type === "error"){
                lockUI("full");
                shutdownNotified = true;
                try{ ws.close(); }catch{}
                ws = null;
                startPolling();
                return;
            }

            if (msg.type === "auth" && msg.sid){
                sid = msg.sid;
                window.__sid = sid;
                if (lostConnectionToast){
                    dismissToast(lostConnectionToast);
                    lostConnectionToast = null;
                    showToast("Connection restored", "ok");
                }
                stopPolling();
                unlockUI();
                refreshStatusOnce();
                if (msg.nickname_conflict) openClientsModal(true, true);
                else if (!localStorage.getItem(NICKNAME_PROMPTED_KEY)) openClientsModal(true);
                return;
            }

            if (msg.type === "status"){
                window.__lastStatus = msg.data;
                if (sid) applyStatus(msg.data || {});
            }

            if (msg.type === "playlist"){
                playlistItems = Array.isArray(msg.data) ? msg.data : [];
                window.__playlist = playlistItems;
                if (_cmdLock && _cmdLock.expect === "playlist") _unlockCommand();
                renderPlaylist();
                if (isFileBrowserOpen() && fileBrowserState.rootId){
                    reconcileFileBrowserEntriesFromPlaylist();
                    renderFileBrowser();
                }
            }
        }catch{}
    };
}

function setupKeyboardShortcuts(){
    const features = window.uiConfig.features;
    const enabled = !(features && features.keyboardEvents === false);

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

        const features = window.uiConfig.features || {};
        const allowSeeking = !(features.allowSeeking === false);

        if (key === " " || key === "Spacebar"){
            e.preventDefault(); e.stopPropagation();
            sendApiCommand("toggle");
            return;
        }
        if (key === "n" || key === "N"){
            sendApiCommand("next");
            return;
        }
        if (key === "p" || key === "P"){
            sendApiCommand("prev");
            return;
        }
        if (key === "q" || key === "Q"){
            if (isResumeOpen()) return;
            const playlistAllowed = !(features.playlistControl === false);
            if (!playlistAllowed) return;
            e.preventDefault(); e.stopPropagation();
            if (isPlaylistOpen()) closePlaylist(); else openPlaylist();
            return;
        }

        if (!allowSeeking) return;

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
if (token) startPolling();

(async function bootstrap(){
    const loaderText = document.getElementById("loaderText");
    try{
        if (loaderText) loaderText.textContent = "Loading…";

        if (!token){
            if (loaderText) loaderText.textContent = "Missing token in URL (add ?t=...)";
            return;
        }

        await loadFrontendConfig();
        applyThemeVars(window.uiConfig.theme);
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