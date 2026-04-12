/**
 * VLC Control - Frontend
 *
 * Browser UI for:
 * - seat admission / waiting room
 * - realtime VLC status via WebSocket
 * - control commands via HTTP endpoints
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
        showFooter: true
    },
    buttons: { playPause: true, stop: true, previous: true, next: true, seekJumps: true },
    features: { allowSeeking: true, keyboardEvents: true, updateTabTitle: true },
    config: { seekJumpBy: 10, clockShowRemaining: false }
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

    const jump = getSeekJumpBy();
    const lb = document.getElementById("lblBack");
    const lf = document.getElementById("lblFwd");
    if (lb) lb.textContent = `-${jump}s`;
    if (lf) lf.textContent = `+${jump}s`;

    const showIcons = !(layout.showIcons === false);
    document.querySelectorAll(".grid button").forEach(btn => {
        const first = btn.childNodes && btn.childNodes.length ? btn.childNodes[0] : null;
        if (first && first.nodeType === Node.TEXT_NODE){
            btn.style.gap = showIcons ? "10px" : "0px";
            if (!showIcons) first.textContent = "";
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
    updatePlayPauseButtonFromState((lastStatus && lastStatus.state) || "unknown");
}

function applyStatus(s){
    lastStatus = s || lastStatus;

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

if (btnToggle) btnToggle.addEventListener("click", () => hit("toggle"));
if (btnPrev)   btnPrev.addEventListener("click", () => hit("prev"));
if (btnNext)   btnNext.addEventListener("click", () => hit("next"));
if (btnStop)   btnStop.addEventListener("click", () => hit("stop"));

if (btnBack) btnBack.addEventListener("click", () => seekBy(-getSeekJumpBy()));
if (btnFwd)  btnFwd.addEventListener("click", () => seekBy(getSeekJumpBy()));

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
