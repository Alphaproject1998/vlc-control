from __future__ import annotations

from flask import Flask, request, abort, send_from_directory, jsonify
from flask_sock import Sock
import os
import sys
import time
import json
import random
import signal
import threading
import requests
import secrets
from urllib.parse import quote, unquote, urlparse

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib  # type: ignore[no-redef]
    except ImportError:
        tomllib = None  # type: ignore[assignment]


def _load_config() -> dict:
    config_dir = os.environ.get("VLC_CONTROL_CONFIG_DIR", "")
    candidates = []
    if config_dir:
        candidates.append(os.path.join(config_dir, "config.toml"))
    candidates.append(os.path.join(os.path.dirname(__file__), "..", "config", "config.toml"))
    for path in candidates:
        if os.path.isfile(path):
            if tomllib is None:
                print(f"WARNING: tomllib unavailable, cannot parse {path}. Using defaults.", flush=True)
                return {}
            with open(path, "rb") as f:
                return tomllib.load(f)
    print("WARNING: config.toml not found. Using defaults.", flush=True)
    return {}


def _tail_format(line: str) -> str | None:
    parts = line.strip().split(" ")
    if len(parts) < 3 or parts[2] != "EVENT":
        return None
    time_str = parts[1]

    kv: dict[str, str] = {}
    for tok in parts[3:]:
        if "=" not in tok:
            continue
        k, _, v = tok.partition("=")
        kv[k] = v

    etype = kv.get("type", "")
    who = kv.get("who", "")
    identity = unquote(kv.get("identity") or ("Host" if who == "host" else kv.get("cid", "?")))
    op = kv.get("op", "")
    value = unquote(kv.get("value", ""))
    at = unquote(kv.get("at", ""))
    length = unquote(kv.get("length", ""))
    reason = unquote(kv.get("reason", ""))

    def out(tag: str, msg: str) -> str:
        return f"[{time_str}] [{tag}] {msg}"

    if etype == "client_join":
        if reason == "rejoin-reserved":
            return out("+", f"{identity} reconnected")
        return out("+", f"{identity} joined")
    if etype == "client_leave":
        return out("-", f"{identity} left")
    if etype == "client_reject":
        return out("!", f"{identity} was rejected - server full ({kv.get('clients', '?')}/{kv.get('max', '?')})")
    if etype == "cmd_error":
        return out("!", f"{identity} tried to {op} - {reason}")
    if etype == "nickname_set":
        old = unquote(kv.get("old", ""))
        new = unquote(kv.get("new", ""))
        return out("*", f"{identity} changed nickname: {old} -> {new}")
    if etype != "action":
        return None

    if op in ("play", "paused", "stopped", "stop"):
        verb = {"play": "resumed", "paused": "paused", "stopped": "stopped", "stop": "stopped"}[op]
        return out("*", f"{identity} {verb} playback")
    if op == "seek":
        detail = f"{at} / {length}" if at else value
        return out("*", f"{identity} seeked to {detail}")
    if op in ("next", "prev"):
        return out("*", f"{identity} skipped to {'next' if op == 'next' else 'previous'} track")
    if op == "track_change":
        return out("*", f"{identity} changed track to \"{value}\"")
    if op == "files_add":
        return out("*", f"Playlist updated: {identity} added \"{value}\"")
    if op in ("files_play", "files_play_existing", "files_play_resume",
              "files_play_resume_existing", "playlist_skip", "playlist_resume"):
        return out("*", f"Playlist updated: {identity} switched to \"{value}\"")
    if op == "playlist_remove":
        return out("*", f"Playlist updated: {identity} removed \"{value}\"")
    if op == "playlist_clear":
        return out("*", f"Playlist updated: {identity} cleared the playlist")
    return None


def _run_tail_mode() -> None:
    for raw in sys.stdin:
        rendered = _tail_format(raw.rstrip("\n"))
        if rendered:
            print(rendered, flush=True)


if len(sys.argv) > 1 and sys.argv[1] == "--tail":
    _run_tail_mode()
    raise SystemExit(0)


_CFG = _load_config()
_SYS = _CFG.get("system", {})
_FB = _CFG.get("file_browse", {})
_FEAT = _CFG.get("features", {})

TOKEN = os.environ.get("TOKEN", "")

_vlc_host = str(_SYS.get("vlc_host", "127.0.0.1"))
_vlc_port = int(_SYS.get("vlc_port", 8080))
VLC_URL = f"http://{_vlc_host}:{_vlc_port}"
VLC_PASS = str(_SYS.get("vlc_pass", os.environ.get("VLC_PASS", "")))

MAX_CLIENTS = int(os.environ.get("MAX_CLIENTS") or _SYS.get("max_clients", 2))
GRACE_SECONDS = float(os.environ.get("GRACE_SECONDS") or _SYS.get("grace_seconds", 30))

CLIENT_ID_STYLE = str(_SYS.get("client_id_style", "numeric")).strip().lower()
ACTION_DEBOUNCE_MS = int(_SYS.get("action_debounce_ms", 250))
NICKNAME_MAX_LENGTH = int(_SYS.get("nickname_max_length", 24))

ALLOW_SEEKING: bool = bool(_FEAT.get("allow_seeking", True))
ALLOW_PLAYLIST_CONTROL: bool = bool(_FEAT.get("playlist_control", True))

FILE_BROWSE: bool = bool(_FB.get("enabled", False))
FILE_BROWSE_AUTO: bool = bool(_FB.get("auto", True))
FILE_BROWSE_AUTO_RECURSIVE: bool = bool(_FB.get("auto_recursive", False))
FILE_BROWSE_LOG_ROOT_RELATIVE: bool = bool(_FB.get("log_root_relative", True))

_DEFAULT_EXTS = ["mp4", "mkv", "avi", "mov", "webm", "mp3", "flac", "ogg", "m4a", "opus", "wav"]
FILE_BROWSE_EXTENSIONS: set[str] = {
    str(e).strip().lower().lstrip(".")
    for e in (_FB.get("extensions") or _DEFAULT_EXTS)
    if str(e).strip()
}


def _parse_file_roots() -> list[tuple[str, str, bool]]:
    dirs = _FB.get("dirs") or []
    out: list[tuple[str, str, bool]] = []
    seen: set[str] = set()
    for entry in dirs:
        entry = str(entry).strip()
        if not entry:
            continue
        recursive = False
        if entry.endswith("/*"):
            entry = entry[:-2]
            recursive = True
        real = os.path.realpath(os.path.expanduser(entry))
        if not os.path.isdir(real) or real in seen:
            continue
        seen.add(real)
        label = os.path.basename(real) or real
        out.append((label, real, recursive))
    return out


_FILE_ROOTS: list[tuple[str, str, bool]] = _parse_file_roots()


def _parse_blacklist_dirs() -> list[list[str]]:
    entries = _FB.get("blacklist_dirs") or []
    out: list[list[str]] = []
    for entry in entries:
        entry = str(entry).strip().strip("/").lower()
        if not entry:
            continue
        parts = [s for s in entry.split("/") if s]
        if parts:
            out.append(parts)
    return out


def _parse_blacklist_terms() -> list[str]:
    terms = _FB.get("blacklist_terms") or []
    return [str(t).strip().lower() for t in terms if str(t).strip()]


_FILE_BLACKLIST_DIR_PATTERNS: list[list[str]] = _parse_blacklist_dirs()
_FILE_BLACKLIST_TERMS: list[str] = _parse_blacklist_terms()


def _is_blacklisted_term(name: str) -> bool:
    if not _FILE_BLACKLIST_TERMS:
        return False
    lo = name.lower()
    return any(t in lo for t in _FILE_BLACKLIST_TERMS)


def _is_blacklisted_dir_path(rel_parts: list[str]) -> bool:
    # rel_parts are already lowercased path components (no leading/trailing slashes)
    if not _FILE_BLACKLIST_DIR_PATTERNS or not rel_parts:
        return False
    for pat in _FILE_BLACKLIST_DIR_PATTERNS:
        n = len(pat)
        if n > len(rel_parts):
            continue
        for i in range(0, len(rel_parts) - n + 1):
            if rel_parts[i:i + n] == pat:
                return True
    return False

def require_playlist_control() -> None:
    if not ALLOW_PLAYLIST_CONTROL:
        abort(403)


def _snake_to_camel(s: str) -> str:
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _camelize(obj):
    if isinstance(obj, dict):
        return {_snake_to_camel(k): _camelize(v) for k, v in obj.items()}
    return obj


def _build_frontend_config(cfg: dict) -> dict:
    ui = cfg.get("ui", {})
    features = dict(cfg.get("features", {}))
    features["file_browser"] = _FB.get("enabled", False)
    raw = {
        "title": ui.get("title", "VLC Control"),
        "subtitle": ui.get("subtitle", ""),
        "footer_text": ui.get("footer_text", ""),
        "features": features,
        "layout": cfg.get("layout", {}),
        "buttons": cfg.get("buttons", {}),
        "config": {**cfg.get("config", {}), "nickname_max_length": NICKNAME_MAX_LENGTH},
        "theme": cfg.get("theme", {}),
    }
    return _camelize(raw)


_FRONTEND_CONFIG: dict = _build_frontend_config(_CFG)

app = Flask(__name__, static_folder="static", static_url_path="")
sock = Sock(app)

_active: dict[str, set] = {}          # cid -> set(ws)
_reserved: dict[str, float] = {}      # cid -> expires_at
_client_meta: dict[str, dict] = {}    # cid -> {nickname, ip, joined_at, number}
_client_number_counter = 0
_lock = threading.Lock()

_action_buffers: dict[str, dict] = {}  # op -> {baseline, candidates, timer}
_action_buffers_lock = threading.Lock()
_DEBOUNCE_OPS = {"toggle": "pl_pause", "stop": "pl_stop"}

_sessions: dict[str, tuple] = {}      # sid -> (ws, cid)
_sessions_lock = threading.Lock()

_pending_action: dict | None = None

_TRACK_OPS = frozenset({
    "next", "prev", "playlist_skip", "playlist_resume",
    "files_play", "files_play_existing",
    "files_play_resume", "files_play_resume_existing",
})


def _set_pending(op: str, cid: str, value: str | None = None, target_sec: int | None = None) -> None:
    global _pending_action
    _pending_action = {"op": op, "cid": cid, "value": value, "target_sec": target_sec, "at": time.time()}


def _ws_err(ws, op: str, msg: str) -> None:
    _ws_send_safe(ws, json.dumps({"type": "cmd_error", "op": op, "message": msg}))


def log_event(event_type: str, **kv) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    parts = [ts, "EVENT", f"type={event_type}"]
    for k, v in kv.items():
        if v is None:
            continue
        s = quote(str(v).replace("\n", " ").strip(), safe=":/,()[]@-_.")
        parts.append(f"{k}={s}")
    print(" ".join(parts), flush=True)


def require_token() -> None:
    if not TOKEN:
        abort(500, "TOKEN not set")
    if not secrets.compare_digest(request.args.get("t") or "", TOKEN):
        abort(403)


def format_time(seconds: int) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h:d}:{m:02d}:{s:02d}"
    return f"{m:d}:{s:02d}"


def _now() -> float:
    return time.time()


def _cleanup_reserved_locked(now: float) -> None:
    expired = [cid for cid, exp in _reserved.items() if exp <= now]
    for cid in expired:
        _reserved.pop(cid, None)
        _client_meta.pop(cid, None)


def _client_real_ip() -> str:
    addr = request.remote_addr or ""
    # only trust Cf-Connecting-Ip from local cloudflared - anywhere else it's spoofable
    if addr in ("127.0.0.1", "::1"):
        return request.headers.get("Cf-Connecting-Ip") or addr
    return addr


def _ensure_client_meta_locked(cid: str) -> dict:
    global _client_number_counter
    meta = _client_meta.get(cid)
    if meta is None:
        _client_number_counter += 1
        meta = {"nickname": None, "ip": _client_real_ip(), "joined_at": _now(), "number": _client_number_counter}
        _client_meta[cid] = meta
    return meta


def _client_fallback_identity_locked(cid: str) -> str:
    if CLIENT_ID_STYLE == "ip":
        return _client_meta.get(cid, {}).get("ip") or cid
    if CLIENT_ID_STYLE == "short_cid":
        return cid[:6]
    if CLIENT_ID_STYLE == "cid":
        return cid
    number = _client_meta.get(cid, {}).get("number")
    if number:
        return f"C{number}"
    return cid


def _client_identity_locked(cid: str) -> str:
    meta = _client_meta.get(cid)
    if meta and meta.get("nickname"):
        return meta["nickname"]
    return _client_fallback_identity_locked(cid)


def _client_identity(cid: str) -> str:
    with _lock:
        return _client_identity_locked(cid)


def _log_client_leave(cid: str) -> None:
    with _lock:
        identity = _client_identity_locked(cid)
    log_event("client_leave", cid=cid, identity=identity, reserved_for=int(GRACE_SECONDS))


def _client_roster_locked() -> list[dict]:
    now = _now()
    cids = sorted(
        set(_active) | set(_reserved),
        key=lambda c: _client_meta.get(c, {}).get("joined_at", 0.0),
    )
    roster = []
    for cid in cids:
        meta = _client_meta.get(cid, {})
        entry = {
            "cid": cid,
            "identity": _client_identity_locked(cid),
            "nickname": meta.get("nickname"),
            "reserved": cid in _reserved,
            "joined_at": meta.get("joined_at", now),
        }
        if cid in _reserved:
            entry["reserved_until"] = _reserved[cid]
            entry["left_at"] = _reserved[cid] - GRACE_SECONDS
        roster.append(entry)
    return roster


def _occupied_count_locked(now: float) -> int:
    _cleanup_reserved_locked(now)
    return len(_active) + len(_reserved)


def _seconds_until_next_seat_opens_locked(now: float) -> int:
    occupied_count = _occupied_count_locked(now)
    if occupied_count < MAX_CLIENTS:
        return 0
    if not _reserved:
        return 0
    soonest = min(_reserved.values())
    rem = soonest - now
    return int(rem) if rem > 0 else 0


def _can_admit_locked(cid: str, now: float) -> tuple[bool, str]:
    _cleanup_reserved_locked(now)

    if cid in _active:
        return True, "already-active"
    if cid in _reserved:
        return True, "rejoin-reserved"
    if (len(_active) + len(_reserved)) < MAX_CLIENTS:
        return True, "new-seat"

    return False, "server full"


def require_sid() -> tuple[str, str]:
    sid = request.headers.get("X-Session-Id", "")
    if not sid:
        abort(403)

    with _sessions_lock:
        entry = _sessions.get(sid)
    if entry is None:
        abort(403)

    ws, cid = entry

    with _lock:
        ws_set = _active.get(cid)
        if not ws_set or ws not in ws_set:
            with _sessions_lock:
                _sessions.pop(sid, None)
            abort(403)

    return sid, cid


def _ws_send_safe(ws, payload: str) -> bool:
    lock = getattr(ws, "_send_lock", None)
    try:
        if lock is None:
            ws.send(payload)
            return True
        with lock:
            ws.send(payload)
        return True
    except Exception:
        return False


def broadcast_clients() -> None:
    now = _now()
    with _lock:
        occupied_count = _occupied_count_locked(now)
        payload = json.dumps({
            "type": "clients",
            "data": {
                "clients": occupied_count,
                "max": MAX_CLIENTS,
                "open": occupied_count < MAX_CLIENTS,
                "cooldown": _seconds_until_next_seat_opens_locked(now),
                "grace": int(GRACE_SECONDS),
                "list": _client_roster_locked(),
            }
        })
        all_ws = []
        for ws_set in _active.values():
            all_ws.extend(list(ws_set))

    dead = []
    for ws in all_ws:
        if not _ws_send_safe(ws, payload):
            dead.append(ws)

    if not dead:
        return

    left_cids = []
    with _lock:
        for cid, ws_set in list(_active.items()):
            for w in list(ws_set):
                if w in dead:
                    ws_set.discard(w)
            if len(ws_set) == 0:
                _active.pop(cid, None)
                _reserved[cid] = _now() + GRACE_SECONDS
                left_cids.append(cid)

    for cid in left_cids:
        _log_client_leave(cid)

    with _sessions_lock:
        for sid, (w, _) in list(_sessions.items()):
            if w in dead:
                _sessions.pop(sid, None)


def broadcast_shutdown(reason: str) -> None:
    payload = json.dumps({"type": "shutdown", "reason": reason})
    with _lock:
        all_ws = []
        for ws_set in _active.values():
            all_ws.extend(list(ws_set))
    for ws in all_ws:
        _ws_send_safe(ws, payload)


_shutdown_broadcast_done = False


def _handle_stop_signal(signum, frame) -> None:
    global _shutdown_broadcast_done
    if not _shutdown_broadcast_done:
        _shutdown_broadcast_done = True
        log_event("shutdown", reason="stopped")
        broadcast_shutdown("stopped")
    sys.exit(0)


def _handle_uncaught(exc_type, exc_value, exc_tb) -> None:
    global _shutdown_broadcast_done
    if not _shutdown_broadcast_done:
        _shutdown_broadcast_done = True
        log_event("shutdown", reason="crashed")
        broadcast_shutdown("crashed")
    sys.__excepthook__(exc_type, exc_value, exc_tb)


def _handle_uncaught_thread(args) -> None:
    _handle_uncaught(args.exc_type, args.exc_value, args.exc_traceback)


signal.signal(signal.SIGINT, _handle_stop_signal)
signal.signal(signal.SIGTERM, _handle_stop_signal)
sys.excepthook = _handle_uncaught
threading.excepthook = _handle_uncaught_thread


def vlc_get(path: str, *, params: dict | None = None):
    if not VLC_PASS:
        abort(500, "VLC_PASS not set")
    r = requests.get(
        f"{VLC_URL}{path}",
        params=params,
        auth=("", VLC_PASS),
        timeout=4,
    )
    r.raise_for_status()
    return r


def vlc_cmd(command: str) -> str:
    vlc_get("/requests/status.xml", params={"command": command})
    return "ok"


def read_status_dict() -> dict:
    r = vlc_get("/requests/status.json")
    data = r.json()

    meta = (
        data.get("information", {})
        .get("category", {})
        .get("meta", {})
    )

    title = meta.get("title") or meta.get("filename") or "Nothing playing"
    state = data.get("state") or "unknown"
    time_s = int(data.get("time") or 0)
    length_s = int(data.get("length") or 0)

    position = (time_s / length_s) if length_s > 0 else 0.0
    position = max(0.0, min(1.0, float(position)))

    return {
        "title": title,
        "state": state,
        "time": time_s,
        "length": length_s,
        "progress": position,
        "position": position,
        "loop": bool(data.get("loop")),
        "repeat": bool(data.get("repeat")),
        "random": bool(data.get("random")),
    }


def read_playlist() -> list[dict]:
    r = vlc_get("/requests/playlist.json")
    data = r.json()

    def _walk(node) -> list[dict]:
        out: list[dict] = []
        if not isinstance(node, dict):
            return out
        if node.get("type") == "leaf":
            out.append({
                "id": str(node.get("id") or ""),
                "name": node.get("name") or "",
                "uri": node.get("uri") or "",
                "duration": int(node.get("duration") or 0),
                "isCurrent": node.get("current") == "current",
            })
            return out
        for child in node.get("children") or []:
            out.extend(_walk(child))
        return out

    children = data.get("children") or []
    for top in children:
        if (top.get("name") or "").lower() == "playlist":
            return _walk(top)
    items: list[dict] = []
    for top in children:
        items.extend(_walk(top))
    return items


_session_progress: dict[str, dict] = {}


def _update_session_progress(status: dict, items: list[dict]) -> None:
    state = (status.get("state") or "").lower()
    if state not in ("playing", "paused"):
        return
    current = next((item for item in items if item.get("isCurrent")), None)
    if not current:
        return
    playlist_id = str(current.get("id") or "")
    if not playlist_id:
        return
    _session_progress[playlist_id] = {
        "watched": int(status.get("time") or 0),
        "duration": int(status.get("length") or 0),
    }


def _apply_progress(items: list[dict]) -> list[dict]:
    for item in items:
        playlist_id = str(item.get("id") or "")
        if playlist_id and playlist_id in _session_progress:
            item["progress"] = dict(_session_progress[playlist_id])
    return items


_last_seen: dict | None = None
_last_seen_wall_time: float | None = None
_last_playlist_json: str | None = None
_last_playlist: list[dict] = []
_current_playing_dir_cache: str | None = None
_auto_root_last_log: str = ""


def _note_auto_miss(reason: str, **kv) -> None:
    global _auto_root_last_log
    key = f"{reason}|{kv.get('uri','')}|{kv.get('dir','')}"
    if key == _auto_root_last_log:
        return
    _auto_root_last_log = key
    log_event("auto_root_miss", reason=reason, **kv)


def broadcaster_loop() -> None:
    global _last_seen, _last_seen_wall_time, _last_playlist_json, _last_playlist, _current_playing_dir_cache, _pending_action

    while True:
        time.sleep(0.75)

        with _lock:
            all_ws = []
            for ws_set in _active.values():
                all_ws.extend(list(ws_set))

        if not all_ws:
            continue

        status: dict | None = None
        tick_wall_time = time.time()
        try:
            status = read_status_dict()

            if _last_seen is not None:
                elapsed = tick_wall_time - (_last_seen_wall_time or tick_wall_time)
                pending = _pending_action
                if pending is not None and (time.time() - pending.get("at", 0)) > 10.0:
                    _pending_action = None
                    pending = None

                prev_state = (_last_seen.get("state") or "unknown")
                new_state = (status.get("state") or "unknown")
                suppress_secondary = False
                if new_state != prev_state:
                    if pending and pending["op"] == "toggle":
                        cid_log = pending["cid"]
                        _pending_action = None
                        pending = None
                        log_event("action", who="web", cid=cid_log, identity=_client_identity(cid_log),
                                  op=("play" if new_state == "playing" else new_state))
                    elif pending and pending["op"] == "stop":
                        _pending_action = None
                        pending = None
                        suppress_secondary = True
                    elif pending:
                        pass
                    else:
                        log_event("action", who="host", identity="Host",
                                  op=("play" if new_state == "playing" else new_state))

                prev_title = (_last_seen.get("title") or "")
                new_title = (status.get("title") or "")
                if not suppress_secondary and new_title and new_title != prev_title:
                    if pending and pending["op"] in _TRACK_OPS:
                        _pending_action = None
                        pending = None
                    else:
                        log_event("action", who="host", identity="Host", op="track_change", value=new_title)

                prev_time = int(_last_seen.get("time") or 0)
                new_time = int(status.get("time") or 0)
                expected_time = prev_time + elapsed if new_state == "playing" else prev_time
                if not suppress_secondary and abs(new_time - expected_time) >= 3:
                    if pending and pending["op"] == "seek":
                        t = pending.get("target_sec")
                        if t is None or abs(new_time - t) <= 5:
                            _pending_action = None
                            pending = None
                    elif pending:
                        pass
                    else:
                        length_s = int(status.get("length") or 0)
                        at_s = format_time(new_time)
                        len_s = format_time(length_s)
                        log_event("action", who="host", identity="Host", op="seek",
                                  at=at_s, length=len_s, value=f"{at_s}/{len_s}")

            _last_seen = status
            _last_seen_wall_time = tick_wall_time
            payload = json.dumps({"type": "status", "data": status})

        except Exception:
            _last_seen = None
            _last_seen_wall_time = None
            payload = json.dumps({
                "type": "status",
                "data": {
                    "title": "VLC not reachable",
                    "state": "error",
                    "time": 0,
                    "length": 0,
                    "progress": 0.0,
                    "position": 0.0,
                    "loop": False,
                    "repeat": False,
                    "random": False,
                },
            })

        playlist_payload: str | None = None
        try:
            playlist_items = read_playlist()
            if status is not None:
                _update_session_progress(status, playlist_items)
            playlist_items = _apply_progress(playlist_items)
            _last_playlist = playlist_items

            if _session_progress:
                live_ids = {str(item.get("id") or "") for item in playlist_items}
                for stale_id in list(_session_progress):
                    if stale_id not in live_ids:
                        del _session_progress[stale_id]

            new_dir: str | None = None
            if FILE_BROWSE_AUTO:
                found_current = False
                for item in playlist_items:
                    if not item.get("isCurrent"):
                        continue
                    found_current = True
                    uri = item.get("uri") or ""
                    if uri.startswith("file://"):
                        path = unquote(urlparse(uri).path)
                        dir_path = os.path.dirname(path)
                        if os.path.isdir(dir_path):
                            new_dir = os.path.realpath(dir_path)
                        else:
                            _note_auto_miss("not_a_dir", uri=uri, dir=dir_path)
                    else:
                        _note_auto_miss("not_file_uri", uri=uri)
                    break
                if not found_current and playlist_items:
                    _note_auto_miss("no_current")
            if new_dir != _current_playing_dir_cache:
                _current_playing_dir_cache = new_dir

            playlist_json = json.dumps(playlist_items, sort_keys=True)
            if playlist_json != _last_playlist_json:
                _last_playlist_json = playlist_json
                playlist_payload = json.dumps({"type": "playlist", "data": playlist_items})
        except Exception:
            pass

        dead = []
        for ws in all_ws:
            if not _ws_send_safe(ws, payload):
                dead.append(ws)
                continue
            if playlist_payload and not _ws_send_safe(ws, playlist_payload):
                dead.append(ws)

        if dead:
            broadcast_clients()


threading.Thread(target=broadcaster_loop, daemon=True).start()


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.get("/api/config")
def api_config():
    require_token()
    return jsonify(_FRONTEND_CONFIG)


@app.get("/api/status")
def status():
    require_token()
    require_sid()
    return jsonify(read_status_dict())


def _playlist_name_for_id(items: list[dict], playlist_id: str) -> str:
    for item in items:
        if item.get("id") == playlist_id:
            return item.get("name") or ""
    return ""


@app.get("/api/playlist")
def playlist():
    require_token()
    require_sid()
    return jsonify(_apply_progress(read_playlist()))


@app.post("/api/playlist/remove")
def playlist_remove():
    require_token()
    _, cid = require_sid()
    require_playlist_control()

    playlist_id = str((request.json or {}).get("id", "")).strip()
    if not playlist_id:
        abort(400, "Missing id")

    name = _playlist_name_for_id(_last_playlist, playlist_id)

    vlc_get("/requests/status.xml", params={"command": "pl_delete", "id": playlist_id})
    _set_pending("playlist_remove", cid, value=playlist_id)
    log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="playlist_remove", value=(name or playlist_id))
    return "ok"


def _require_file_browse() -> None:
    if not FILE_BROWSE:
        abort(403)


def _current_playing_dir() -> str | None:
    return _current_playing_dir_cache if FILE_BROWSE_AUTO else None


def _now_playing_dir_realpath() -> str | None:
    for item in _last_playlist:
        if not item.get("isCurrent"):
            continue
        uri = item.get("uri") or ""
        if not uri.startswith("file://"):
            return None
        path = unquote(urlparse(uri).path)
        dir_path = os.path.dirname(path)
        return os.path.realpath(dir_path) if os.path.isdir(dir_path) else None
    return None


def _log_file_value(root_id: str, rel: str, full: str) -> str:
    if FILE_BROWSE_LOG_ROOT_RELATIVE:
        root_info = _resolve_root(root_id)
        if root_info:
            _label, root, _rec = root_info
            root_name = os.path.basename(root.rstrip(os.sep)) or root.strip(os.sep) or "root"
            rel_clean = (rel or "").strip("/")
            return f"/{root_name}/{rel_clean}" if rel_clean else f"/{root_name}"
        return full

    playing_dir = _now_playing_dir_realpath()
    if playing_dir:
        real_full = os.path.realpath(full)
        if real_full == playing_dir or real_full.startswith(playing_dir + os.sep):
            return os.path.relpath(real_full, playing_dir)
    return full


def _resolve_root(root_id: str) -> tuple[str, str, bool] | None:
    if root_id == "auto":
        dir_path = _current_playing_dir()
        return ("Now playing folder", dir_path, FILE_BROWSE_AUTO_RECURSIVE) if dir_path else None
    if not root_id.startswith("r"):
        return None
    try:
        idx = int(root_id[1:])
    except ValueError:
        return None
    if 0 <= idx < len(_FILE_ROOTS):
        return _FILE_ROOTS[idx]
    return None


def _safe_join(root: str, rel: str, *, allow_sub: bool = True) -> str | None:
    rel = (rel or "").strip().lstrip("/").replace("\\", "/").rstrip("/")
    if rel and ".." in rel.split("/"):
        return None
    if rel and not allow_sub and "/" in rel:
        return None
    full = os.path.realpath(os.path.join(root, rel))
    if full != root and not full.startswith(root + os.sep):
        return None
    return full


def _ext_of(name: str) -> str:
    _, dot, ext = name.rpartition(".")
    return ext.lower() if dot else ""


def _ext_allowed(name: str) -> bool:
    if not FILE_BROWSE_EXTENSIONS:
        return True
    return _ext_of(name) in FILE_BROWSE_EXTENSIONS


def _path_to_uri(path: str) -> str:
    return "file://" + quote(path)


def _list_dir(full: str, rel: str, *, allow_sub: bool = True) -> list[dict]:
    entries: list[dict] = []
    try:
        names = os.listdir(full)
    except OSError:
        return entries

    rel_norm = (rel or "").strip("/").replace("\\", "/").lower()
    base_parts = [s for s in rel_norm.split("/") if s]

    uri_index: dict[str, dict] = {}
    for item in _last_playlist:
        uri = item.get("uri") or ""
        if uri:
            uri_index[uri] = item

    for name in names:
        if name.startswith("."):
            continue
        lo = name.lower()
        path = os.path.join(full, name)
        try:
            if os.path.isdir(path):
                if not allow_sub:
                    continue
                if _is_blacklisted_term(name):
                    continue
                if _is_blacklisted_dir_path(base_parts + [lo]):
                    continue
                entries.append({"name": name, "type": "dir"})
            elif os.path.isfile(path) and _ext_allowed(name):
                if _is_blacklisted_term(name):
                    continue
                uri = _path_to_uri(path)
                entry = {
                    "name": name,
                    "type": "file",
                    "ext": _ext_of(name),
                    "size": os.path.getsize(path),
                    "uri": uri,
                }
                item = uri_index.get(uri)
                if item:
                    playlist_id = str(item.get("id") or "")
                    entry["inPlaylist"] = True
                    if playlist_id:
                        entry["playlistId"] = playlist_id
                    if item.get("isCurrent"):
                        entry["isCurrent"] = True
                    if playlist_id and playlist_id in _session_progress:
                        entry["progress"] = dict(_session_progress[playlist_id])
                    if not entry.get("progress") and item.get("duration"):
                        entry["duration"] = int(item.get("duration") or 0)
                entries.append(entry)
        except OSError:
            continue
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    return entries


@app.get("/api/files/roots")
def files_roots():
    require_token()
    require_sid()
    _require_file_browse()

    out: list[dict] = []
    if _current_playing_dir():
        out.append({"id": "auto", "label": "Now playing folder"})
    for i, (label, _rp, _rec) in enumerate(_FILE_ROOTS):
        out.append({"id": f"r{i}", "label": label})
    return jsonify(out)


@app.get("/api/files")
def files_list():
    require_token()
    require_sid()
    _require_file_browse()

    root_id = request.args.get("root", "").strip()
    rel = request.args.get("path", "").strip()

    root_info = _resolve_root(root_id)
    if not root_info:
        abort(404)
    label, root, recursive = root_info

    full = _safe_join(root, rel, allow_sub=recursive)
    if full is None or not os.path.isdir(full):
        abort(404)

    return jsonify({
        "root": {"id": root_id, "label": label, "recursive": recursive},
        "path": rel.strip("/"),
        "entries": _list_dir(full, rel, allow_sub=recursive),
    })


def _resolve_file_arg() -> tuple[str, str, str]:
    body = request.json or {}
    root_id = str(body.get("root", "")).strip()
    rel = str(body.get("path", "")).strip()

    root_info = _resolve_root(root_id)
    if not root_info:
        abort(404)
    _label, root, recursive = root_info

    full = _safe_join(root, rel, allow_sub=recursive)
    if full is None or not os.path.isfile(full) or not _ext_allowed(os.path.basename(full)):
        abort(404)

    return root_id, rel, full


def _playlist_find_by_uri(uri: str) -> str | None:
    for item in _last_playlist:
        if item.get("uri") == uri:
            playlist_id = item.get("id")
            return str(playlist_id) if playlist_id else None
    return None


@app.post("/api/files/add")
def files_add():
    require_token()
    _, cid = require_sid()
    _require_file_browse()

    root_id, rel, full = _resolve_file_arg()
    uri = _path_to_uri(full)

    existing = _playlist_find_by_uri(uri)
    if existing:
        return jsonify({"status": "already_present", "id": existing})

    vlc_get("/requests/status.xml", params={"command": "in_enqueue", "input": uri})
    _set_pending("files_add", cid, value=rel)
    log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="files_add",
              value=_log_file_value(root_id, rel, full))
    return jsonify({"status": "added"})


@app.post("/api/files/play")
def files_play():
    require_token()
    _, cid = require_sid()
    _require_file_browse()

    root_id, rel, full = _resolve_file_arg()
    uri = _path_to_uri(full)

    body = request.json or {}
    resume_at = 0
    if body.get("resume_at") not in (None, "", 0):
        try:
            resume_at = max(0, int(body["resume_at"]))
        except (ValueError, TypeError):
            abort(400, "Invalid resume_at")

    identity = _client_identity(cid)

    existing = _playlist_find_by_uri(uri)
    if existing:
        vlc_get("/requests/status.xml", params={"command": "pl_play", "id": existing})
        if resume_at > 0:
            time.sleep(0.25)
            vlc_get("/requests/status.xml", params={"command": "seek", "val": str(resume_at)})
            _set_pending("files_play_resume_existing", cid=cid, value=f"{existing}@{resume_at}")
            log_event("action", who="web", cid=cid, identity=identity, op="files_play_resume_existing",
                      at=format_time(resume_at), value=f"{os.path.basename(full)} - {format_time(resume_at)}")
        else:
            _set_pending("files_play_existing", cid=cid, value=existing)
            log_event("action", who="web", cid=cid, identity=identity, op="files_play_existing",
                      value=os.path.basename(full))
        return jsonify({"status": "jumped", "id": existing})

    vlc_get("/requests/status.xml", params={"command": "in_play", "input": uri})
    if resume_at > 0:
        time.sleep(0.25)
        vlc_get("/requests/status.xml", params={"command": "seek", "val": str(resume_at)})
        _set_pending("files_play_resume", cid=cid, value=f"{rel}@{resume_at}")
        log_event("action", who="web", cid=cid, identity=identity, op="files_play_resume",
                  at=format_time(resume_at), value=f"{_log_file_value(root_id, rel, full)} - {format_time(resume_at)}")
    else:
        _set_pending("files_play", cid=cid, value=rel)
        log_event("action", who="web", cid=cid, identity=identity, op="files_play",
                  value=_log_file_value(root_id, rel, full))
    return jsonify({"status": "added_and_played"})


@app.get("/api/clients")
def clients():
    require_token()
    cid = request.args.get("cid", "").strip()

    now = _now()
    with _lock:
        occupied_count = _occupied_count_locked(now)
        cooldown = _seconds_until_next_seat_opens_locked(now)
        response = {
            "clients": occupied_count,
            "max": MAX_CLIENTS,
            "open": occupied_count < MAX_CLIENTS,
            "cooldown": cooldown,
            "grace": int(GRACE_SECONDS),
        }

        if cid:
            ok, reason = _can_admit_locked(cid, now)
            response["admit_for_cid"] = bool(ok)
            response["reason"] = reason

    return jsonify(response)


def _resolve_action_buffer(op: str, vlc_command: str) -> None:
    global _last_seen, _last_seen_wall_time

    with _action_buffers_lock:
        buf = _action_buffers.pop(op, None)
    if buf is None:
        return

    candidates: list[str] = buf["candidates"]
    baseline = buf["baseline"]

    try:
        current = read_status_dict()
    except Exception:
        current = None

    host_acted = bool(
        baseline is not None and current is not None
        and current.get("state") != baseline.get("state")
    )

    if host_acted:
        log_event("action", who="host", identity="Host",
                  op=("play" if current.get("state") == "playing" else current.get("state")))
        _last_seen = current
        _last_seen_wall_time = time.time()
        for extra_cid in candidates:
            log_event("action_dropped", cid=extra_cid, op=op, reason="host_preempted")
        return

    winner = random.choice(candidates)
    try:
        vlc_cmd(vlc_command)
    except Exception as exc:
        log_event("cmd_error", cid=winner, op=op, reason=str(exc))
        return

    _set_pending(op, winner)
    if op == "stop":
        log_event("action", who="web", cid=winner, identity=_client_identity(winner), op="stop")
    for extra_cid in candidates:
        if extra_cid != winner:
            log_event("action_duplicate", cid=extra_cid, op=op, note="lost_tiebreak")


def _debounced_dispatch(cid: str, op: str, vlc_command: str) -> None:
    if ACTION_DEBOUNCE_MS <= 0:
        vlc_cmd(vlc_command)
        _set_pending(op, cid)
        if op == "stop":
            log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="stop")
        return

    with _action_buffers_lock:
        buf = _action_buffers.get(op)
        if buf is not None:
            if cid not in buf["candidates"]:
                buf["candidates"].append(cid)
            return

        try:
            baseline = read_status_dict()
        except Exception:
            baseline = None

        buf = {"baseline": baseline, "candidates": [cid]}
        _action_buffers[op] = buf
        timer = threading.Timer(ACTION_DEBOUNCE_MS / 1000.0, _resolve_action_buffer, args=(op, vlc_command))
        timer.daemon = True
        timer.start()


def _dispatch_ws_cmd(ws, cid: str, data: dict) -> None:
    op = str(data.get("op") or "").strip()
    try:
        if op in _DEBOUNCE_OPS:
            _debounced_dispatch(cid, op, _DEBOUNCE_OPS[op])

        elif op == "next":
            vlc_cmd("pl_next")
            _set_pending("next", cid)
            log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="next")

        elif op == "prev":
            vlc_cmd("pl_previous")
            _set_pending("prev", cid)
            log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="prev")

        elif op == "set_nickname":
            nickname = str(data.get("nickname") or "").strip()[:NICKNAME_MAX_LENGTH]
            with _lock:
                meta = _ensure_client_meta_locked(cid)
                old_nickname = meta.get("nickname")
                if nickname:
                    taken = any(
                        other_cid != cid and (other_meta.get("nickname") or "").lower() == nickname.lower()
                        for other_cid, other_meta in _client_meta.items()
                        if other_cid in _active or other_cid in _reserved
                    )
                    if taken:
                        _ws_err(ws, op, "nickname taken")
                        return
                changed = (nickname or None) != old_nickname
                if changed:
                    fallback = _client_fallback_identity_locked(cid)
                    old_display = old_nickname or fallback
                    new_display = nickname or fallback
                meta["nickname"] = nickname or None
            if changed:
                log_event("nickname_set", cid=cid, identity=old_display, old=old_display, new=new_display)
            broadcast_clients()
            _ws_send_safe(ws, json.dumps({"type": "nickname_ok", "nickname": nickname}))

        elif op == "seek":
            if not ALLOW_SEEKING:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="seeking_not_allowed")
                _ws_err(ws, op, "seeking not allowed"); return
            val = str(data.get("val") or "").strip()
            if not val:
                _ws_err(ws, op, "val required"); return

            target_sec = at_s = len_s = None
            seen = _last_seen
            if seen:
                try:
                    length = int(seen.get("length") or 0)
                    cur = int(seen.get("time") or 0)
                    if val.endswith("%"):
                        target_sec = int((int(val[:-1]) / 100.0) * length) if length > 0 else 0
                    elif val.startswith(("+", "-")):
                        target_sec = cur + int(val)
                    else:
                        target_sec = int(val)
                    if length > 0:
                        target_sec = max(0, min(length, target_sec))
                    at_s = format_time(target_sec)
                    len_s = format_time(length)
                except Exception:
                    pass

            vlc_get("/requests/status.xml", params={"command": "seek", "val": val})
            _set_pending("seek", cid, value=val, target_sec=target_sec)
            log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="seek",
                      at=at_s, length=len_s, value=f"{at_s}/{len_s}" if at_s else val)

        elif op == "playlist/play":
            if not ALLOW_PLAYLIST_CONTROL:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="playlist_control_not_allowed")
                _ws_err(ws, op, "playlist control not allowed"); return
            playlist_id = str(data.get("id") or "").strip()
            if not playlist_id:
                _ws_err(ws, op, "id required"); return

            resume_at = 0
            if data.get("resume_at") not in (None, "", 0):
                try:
                    resume_at = max(0, int(data["resume_at"]))
                except (ValueError, TypeError):
                    pass

            name, total = "", 0
            for item in _last_playlist:
                if item.get("id") == playlist_id:
                    name = item.get("name") or ""
                    total = int(item.get("duration") or 0)
                    break

            op_key = "playlist_resume" if resume_at > 0 else "playlist_skip"
            _set_pending(op_key, cid, value=playlist_id)
            vlc_get("/requests/status.xml", params={"command": "pl_play", "id": playlist_id})
            if resume_at > 0:
                time.sleep(0.25)
                vlc_get("/requests/status.xml", params={"command": "seek", "val": str(resume_at)})
                at_s = format_time(resume_at)
                len_s = format_time(total) if total > 0 else "?"
                log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="playlist_resume",
                          at=at_s, length=len_s, value=f"{(name or playlist_id)} - {at_s} / {len_s}")
            else:
                log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="playlist_skip",
                          value=(name or playlist_id))

        elif op == "playlist/remove":
            if not ALLOW_PLAYLIST_CONTROL:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="playlist_control_not_allowed")
                _ws_err(ws, op, "playlist control not allowed"); return
            playlist_id = str(data.get("id") or "").strip()
            if not playlist_id:
                _ws_err(ws, op, "id required"); return
            name = _playlist_name_for_id(_last_playlist, playlist_id)
            vlc_get("/requests/status.xml", params={"command": "pl_delete", "id": playlist_id})
            _set_pending("playlist_remove", cid, value=playlist_id)
            log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="playlist_remove",
                      value=(name or playlist_id))

        elif op == "playlist/clear":
            if not ALLOW_PLAYLIST_CONTROL:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="playlist_control_not_allowed")
                _ws_err(ws, op, "playlist control not allowed"); return
            vlc_get("/requests/status.xml", params={"command": "pl_empty"})
            _set_pending("playlist_clear", cid)
            log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="playlist_clear")

        else:
            log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="unknown_op")
            _ws_err(ws, op, "unknown op")

    except Exception as exc:
        log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason=str(exc))
        _ws_err(ws, op, str(exc))


@sock.route("/ws")
def ws_route(ws):
    if not TOKEN or not secrets.compare_digest(request.args.get("t") or "", TOKEN):
        try:
            ws.send(json.dumps({"type": "error", "message": "forbidden"}))
        except Exception:
            pass
        return

    cid = request.args.get("cid", "").strip()
    if not cid:
        try:
            ws.send(json.dumps({"type": "error", "message": "missing cid"}))
        except Exception:
            pass
        return

    nickname_hint = request.args.get("nickname", "").strip()[:NICKNAME_MAX_LENGTH]

    now = _now()
    with _lock:
        ok, reason = _can_admit_locked(cid, now)
        occupied_count = _occupied_count_locked(now)
        cooldown = _seconds_until_next_seat_opens_locked(now)

        if not ok:
            try:
                ws.send(json.dumps({
                    "type": "clients",
                    "data": {
                        "clients": occupied_count,
                        "max": MAX_CLIENTS,
                        "open": False,
                        "cooldown": cooldown,
                        "grace": int(GRACE_SECONDS),
                    }
                }))
                ws.send(json.dumps({"type": "error", "message": "server full"}))
                log_event("client_reject", cid=cid, identity=_client_identity_locked(cid), reason="server_full",
                          clients=occupied_count, max=MAX_CLIENTS, cooldown=cooldown)
            except Exception:
                pass
            return

        ws._send_lock = threading.Lock()
        if cid not in _active:
            _active[cid] = set()
        _active[cid].add(ws)
        _reserved.pop(cid, None)
        meta = _ensure_client_meta_locked(cid)
        nickname_conflict = False
        if nickname_hint and not meta.get("nickname"):
            taken = any(
                other_cid != cid and (other_meta.get("nickname") or "").lower() == nickname_hint.lower()
                for other_cid, other_meta in _client_meta.items()
                if other_cid in _active or other_cid in _reserved
            )
            if taken:
                nickname_conflict = True
            else:
                meta["nickname"] = nickname_hint
        if reason != "already-active":
            log_event("client_join", cid=cid, identity=_client_identity_locked(cid), reason=reason)

    sid = secrets.token_urlsafe(18)
    with _sessions_lock:
        _sessions[sid] = (ws, cid)

    broadcast_clients()

    try:
        _ws_send_safe(ws, json.dumps({"type": "auth", "sid": sid, "nickname_conflict": nickname_conflict}))
        with _lock:
            roster = _client_roster_locked()
        _ws_send_safe(ws, json.dumps({
            "type": "clients",
            "data": {
                "clients": client_count_safe(),
                "max": MAX_CLIENTS,
                "open": True,
                "cooldown": 0,
                "grace": int(GRACE_SECONDS),
                "list": roster,
            }
        }))
        _ws_send_safe(ws, json.dumps({"type": "status", "data": read_status_dict()}))
        try:
            _ws_send_safe(ws, json.dumps({"type": "playlist", "data": _apply_progress(read_playlist())}))
        except Exception:
            pass
    except Exception:
        pass

    try:
        while True:
            msg = ws.receive()
            if msg is None:
                break
            with _lock:
                if ws not in _active.get(cid, ()):
                    break
            try:
                data = json.loads(msg)
            except (json.JSONDecodeError, TypeError):
                continue
            if data.get("type") == "cmd":
                _dispatch_ws_cmd(ws, cid, data)
    finally:
        left = False
        with _lock:
            ws_set = _active.get(cid)
            if ws_set:
                ws_set.discard(ws)
                if len(ws_set) == 0:
                    _active.pop(cid, None)
                    _reserved[cid] = _now() + GRACE_SECONDS
                    left = True

        if left:
            _log_client_leave(cid)

        with _sessions_lock:
            _sessions.pop(sid, None)

        broadcast_clients()


def client_count_safe() -> int:
    now = _now()
    with _lock:
        return _occupied_count_locked(now)


if __name__ == "__main__":
    _port = int(_SYS.get("port", os.environ.get("PORT", "5000")))
    app.run(host="0.0.0.0", port=_port, threaded=True)
