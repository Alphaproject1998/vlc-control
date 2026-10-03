"""
VLC Control bridge - Flask HTTP API + WebSocket broadcaster in front of VLC's HTTP interface.
Run with --tail to render EVENT lines from the log file as readable console output instead.
"""

from __future__ import annotations

from flask import Flask, request, abort, send_from_directory, jsonify
from flask_sock import Sock
import os
import re
import sys
import time
import json
import random
import signal
import logging
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


VERSION = "0.6.3"


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


def _read_commit() -> str:
    state_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "install-state.json")
    try:
        with open(state_path, "r", encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        return ""
    commit = str(state.get("commit") or "")
    if commit and state.get("dirty"):
        commit += "+"
    return commit


_ACTOR_IDENTITY = {"host": "Host", "vlc": "VLC", "system": "System"}
_ERROR_REASONS = {
    "seeking_not_allowed": "seeking is disabled",
    "playlist_control_not_allowed": "playlist control is disabled",
    "playlist_undo_not_allowed": "undo is disabled",
    "loop_control_not_allowed": "loop control is disabled",
    "random_control_not_allowed": "random order is disabled",
    "bad_mode": "that isn't a mode it knows",
    "nothing_to_undo": "there was nothing to undo",
    "already_restored": "everything was already back in the playlist",
    "undo_gone": "it had already been put back or aged out of the history",
    "nothing_loaded": "nothing is loaded",
    "nothing_to_skip_to": "nothing to skip to",
    "unknown_op": "unknown command",
}
_ERROR_OPS = {
    "toggle": "use play/pause",
    "stop": "stop playback",
    "next": "skip forward",
    "prev": "skip back",
    "seek": "seek",
    "playlist/play": "play an item",
    "playlist/remove": "remove an item",
    "playlist/clear": "clear the playlist",
    "playlist/undo": "undo a removal",
    "loop": "change the loop mode",
    "random": "change random order",
    "set_nickname": "set a nickname",
}
_VLC_FAULTS = {
    "ConnectionError": "nothing is listening on the VLC port",
    "ConnectTimeout": "no answer from VLC",
    "ReadTimeout": "VLC took too long to answer",
    "Timeout": "VLC took too long to answer",
    "HTTPError": "VLC turned the request down, check vlc_pass",
    "JSONDecodeError": "VLC sent back something unreadable",
}


_ITEM_SEPARATOR = "|"


def _tail_format(line: str, item_preview: int = 3) -> str | None:
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
    identity = unquote(kv.get("identity") or _ACTOR_IDENTITY.get(who) or kv.get("cid", "?"))
    op = kv.get("op", "")
    value = unquote(kv.get("value", ""))
    at = unquote(kv.get("at", ""))
    length = unquote(kv.get("length", ""))
    reason = unquote(kv.get("reason", ""))

    def out(tag: str, msg: str) -> str:
        return f"[{time_str}] [{tag}] {msg}"

    def listed(tag: str, msg: str) -> str:
        names = [unquote(name) for name in kv.get("items", "").split(_ITEM_SEPARATOR) if name]
        if not names:
            return out(tag, msg)
        indent = " " * (len(out(tag, "")) + 2)
        shown = names[:item_preview] if item_preview > 0 else names
        lines = [out(tag, f"{msg}:")] + [f"{indent}{name}" for name in shown]
        if len(names) > len(shown):
            lines.append(f"{indent}and {len(names) - len(shown)} more")
        return "\n".join(lines)

    def unrendered() -> str | None:
        if os.environ.get("VLC_CONTROL_TAIL_DEBUG"):
            return out("?", " ".join(parts[3:]))
        return None

    if etype == "startup":
        return None
    if etype == "shutdown":
        return out("!", "VLC Control crashed" if reason == "crashed" else "Session stopped")
    if etype == "client_join":
        if reason == "rejoin-reserved":
            return out("+", f"{identity} reconnected")
        return out("+", f"{identity} joined")
    if etype == "client_leave":
        held = kv.get("reserved_for", "")
        return out("-", f"{identity} left (seat held for {held}s)" if held else f"{identity} left")
    if etype == "seat_expired":
        return out("-", f"{identity}'s seat expired and is free again")
    if etype == "client_reject":
        return out("!", f"{identity} couldn't join - all {kv.get('max', '?')} seats taken")
    if etype == "cmd_error":
        detail = _ERROR_REASONS.get(reason) or _VLC_FAULTS.get(reason) or "VLC wouldn't take the command"
        return out("!", f"{identity} tried to {_ERROR_OPS.get(op, op)} - {detail}")
    if etype == "nickname_set":
        return out("*", f"{unquote(kv.get('old', ''))} is now known as {unquote(kv.get('new', ''))}")
    if etype == "nickname_clear":
        return out("*", f"{identity} cleared their nickname (now {unquote(kv.get('new', ''))})")
    if etype == "vlc_lost":
        detail = _VLC_FAULTS.get(reason) or reason
        return out("~", f"VLC stopped responding - {detail}" if detail else "VLC stopped responding")
    if etype == "vlc_back":
        return out("~", "VLC is responding again")
    if etype != "action":
        return unrendered()

    tag = "~" if who in ("vlc", "system") else "*"

    if op in ("play", "resume", "paused", "stopped", "stop"):
        verb = {"play": "started", "resume": "resumed", "paused": "paused",
                "stopped": "stopped", "stop": "stopped"}[op]
        return out(tag, f"{identity} {verb} playback")
    if op == "seek":
        detail = f"{at} / {length}" if at else value
        return out(tag, f"{identity} seeked to {detail}")
    if op in ("next", "prev"):
        direction = "next" if op == "next" else "previous"
        named = f": \"{value}\"" if value else ""
        return out(tag, f"{identity} skipped to {direction} track{named}")
    if op == "track_change":
        return out(tag, f"{identity} changed track to \"{value}\"")
    if op == "auto_next":
        return out(tag, f"{identity} advanced to \"{value}\"")
    if op == "restart":
        return out(tag, f"{identity} restarted \"{value}\"")
    if op == "loop_restart":
        return out(tag, f"{identity} looped back to the start of \"{value}\"")
    if op == "playlist_end":
        return out(tag, f"{identity} reached the end of the playlist")
    if op == "files_add":
        return out(tag, f"{identity} added \"{value}\" to the playlist")
    if op == "files_add_many":
        return listed(tag, f"{identity} added {value} files to the playlist")
    if op in ("files_play", "files_play_existing", "files_play_resume",
              "files_play_resume_existing", "playlist_skip", "playlist_resume"):
        return out(tag, f"{identity} switched to \"{value}\"")
    if op == "playlist_remove":
        return out(tag, f"{identity} removed \"{value}\" from the playlist")
    if op == "playlist_remove_many":
        return listed(tag, f"{identity} removed {value} files from the playlist")
    if op == "playlist_undo":
        return out(tag, f"{identity} put \"{value}\" back in the playlist")
    if op == "playlist_undo_many":
        return listed(tag, f"{identity} put {value} files back in the playlist")
    if op == "playlist_clear":
        return out(tag, f"{identity} cleared the playlist")
    if op == "loop_mode":
        verb = {"off": "turned looping off", "all": "set the playlist to loop",
                "one": "set the current item to repeat"}.get(value)
        return out(tag, f"{identity} {verb}") if verb else unrendered()
    if op == "random_mode":
        return out(tag, f"{identity} turned random order {'on' if value == 'on' else 'off'}")
    return unrendered()


def _tail_item_preview() -> int:
    try:
        section = _load_config().get("logging")
    except Exception:
        return 3
    value = section.get("item_preview", 3) if isinstance(section, dict) else 3
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 3
    return value


def _run_tail_mode() -> None:
    item_preview = _tail_item_preview()
    for raw in sys.stdin:
        rendered = _tail_format(raw.rstrip("\n"), item_preview)
        if rendered:
            print(rendered, flush=True)


if len(sys.argv) > 1 and sys.argv[1] == "--tail":
    _run_tail_mode()
    raise SystemExit(0)


_CFG = _load_config()
_SYS = _CFG.get("system", {})
_FB = _CFG.get("file_browse", {})
_FEAT = _CFG.get("features", {})

APP_COMMIT = _read_commit()

TOKEN = os.environ.get("TOKEN", "")

_vlc_host = str(_SYS.get("vlc_host", "127.0.0.1"))
_vlc_port = int(_SYS.get("vlc_port", 8080))
VLC_URL = f"http://{_vlc_host}:{_vlc_port}"
VLC_PASS = str(_SYS.get("vlc_pass", os.environ.get("VLC_PASS", "")))

MAX_CLIENTS = int(os.environ.get("MAX_CLIENTS") or _SYS.get("max_clients", 2))
GRACE_SECONDS = float(os.environ.get("GRACE_SECONDS") or _SYS.get("grace_seconds", 30))

LOG_WHEN_IDLE: bool = bool(_SYS.get("log_when_idle", False))

HTTP_ACCESS_LOG: bool = bool(_SYS.get("http_access_log", False))
LOG_DIR = os.environ.get("LOG_DIR") or str(_SYS.get("log_dir", "/tmp"))

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


class _PlainFormatter(logging.Formatter):
    # werkzeug colours request lines whether or not the destination is a terminal
    def format(self, record: logging.LogRecord) -> str:
        return _ANSI_RE.sub("", super().format(record))


def _setup_access_log() -> None:
    werkzeug_logger = logging.getLogger("werkzeug")
    werkzeug_logger.propagate = False
    access_path = os.path.join(LOG_DIR, "vlc-access.log")
    if not HTTP_ACCESS_LOG:
        werkzeug_logger.setLevel(logging.ERROR)
        try:
            os.remove(access_path)
        except OSError:
            pass
        return
    try:
        handler = logging.FileHandler(access_path, mode="w")
    except OSError:
        werkzeug_logger.propagate = True
        return
    handler.setFormatter(_PlainFormatter("%(message)s"))
    werkzeug_logger.addHandler(handler)
    werkzeug_logger.setLevel(logging.INFO)


_setup_access_log()

CLIENT_ID_STYLE = str(_SYS.get("client_id_style", "numeric")).strip().lower()
ACTION_DEBOUNCE_MS = int(_SYS.get("action_debounce_ms", 250))
NICKNAME_MAX_LENGTH = int(_SYS.get("nickname_max_length", 24))
UNDO_HISTORY_SIZE = max(1, int(_SYS.get("undo_history_size", 20)))

ALLOW_SEEKING: bool = bool(_FEAT.get("allow_seeking", True))
ALLOW_PLAYLIST_CONTROL: bool = bool(_FEAT.get("playlist_control", True))
PLAYLIST_UNDO: bool = bool(_FEAT.get("playlist_undo", True))
LOOP_CONTROL: bool = bool(_FEAT.get("loop_control", True))
RANDOM_CONTROL: bool = bool(_FEAT.get("random_control", True))

FILE_BROWSE: bool = bool(_FB.get("enabled", False))
FILE_BROWSE_AUTO: bool = bool(_FB.get("auto", True))
FILE_BROWSE_AUTO_RECURSIVE: bool = bool(_FB.get("auto_recursive", False))
FILE_BROWSE_AUTO_BLACKLIST: str = str(_FB.get("auto_blacklist", "ignore")).strip().lower()
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


BlacklistLift = tuple[list[str], list[list[str]]]
_NO_LIFT: BlacklistLift = ([], [])


def _blacklist_term_hits(name: str) -> list[str]:
    lo = name.lower()
    return [t for t in _FILE_BLACKLIST_TERMS if t in lo]


def _is_blacklisted_term(name: str, lift: BlacklistLift = _NO_LIFT) -> bool:
    return any(t not in lift[0] for t in _blacklist_term_hits(name))


def _blacklist_dir_hits(rel_parts: list[str]) -> list[list[str]]:
    # rel_parts are already lowercased path components (no leading/trailing slashes)
    hits: list[list[str]] = []
    for pat in _FILE_BLACKLIST_DIR_PATTERNS:
        n = len(pat)
        for i in range(0, len(rel_parts) - n + 1):
            if rel_parts[i:i + n] == pat:
                hits.append(pat)
                break
    return hits


def _is_blacklisted_dir_path(rel_parts: list[str], lift: BlacklistLift = _NO_LIFT) -> bool:
    return any(pat not in lift[1] for pat in _blacklist_dir_hits(rel_parts))

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
        "version": VERSION,
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
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
sock = Sock(app)

_active: dict[str, set] = {}          # cid -> set(ws)
_reserved: dict[str, float] = {}      # cid -> expires_at
_rejected_logged: set[str] = set()    # cids already logged as turned away, cleared once admitted
_client_meta: dict[str, dict] = {}    # cid -> {nickname, ip, joined_at, left_at, number}
_client_number_counter = 0
_lock = threading.Lock()

_action_buffers: dict[str, dict] = {}  # op -> {baseline, candidates, timer}
_action_buffers_lock = threading.Lock()
_DEBOUNCE_OPS = {"toggle": "pl_pause", "stop": "pl_stop"}

_NEEDS_MEDIA_OPS = frozenset({"toggle", "stop", "next", "prev", "seek"})

_sessions: dict[str, tuple] = {}      # sid -> (ws, cid)
_sessions_lock = threading.Lock()

_pending_action: dict | None = None

_undo_history: list[dict] = []        # oldest first: {id, cid, identity, op, at, items: [{key, id, uri, name, index}]}
_undo_record_counter = 0
_expected_removals: dict[str, float] = {}
_undo_lock = threading.Lock()

_MODE_COMMANDS = {"loop": "pl_loop", "repeat": "pl_repeat", "random": "pl_random"}
_LOOP_MODES = ("off", "all", "one")
_expected_modes: dict[str, tuple[str, float]] = {}  # "loop"/"random"
_modes_lock = threading.Lock()

_TRACK_OPS = frozenset({
    "next", "prev", "playlist_skip", "playlist_resume",
    "files_play", "files_play_existing",
    "files_play_resume", "files_play_resume_existing",
})

_PLAYBACK_MASK_OPS = _TRACK_OPS | {"playlist_clear", "playlist_remove"}
_SEEK_MASK_OPS = frozenset({
    "seek", "playlist_resume", "files_play_resume", "files_play_resume_existing",
})
_RESTART_MASK_OPS = _TRACK_OPS | {"restart"}


def _playback_op(prev_state: str, new_state: str) -> str:
    if new_state != "playing":
        return new_state
    return "resume" if prev_state == "paused" else "play"


def _set_pending(op: str, cid: str, value: str | None = None, target_sec: int | None = None) -> None:
    global _pending_action
    _pending_action = {"op": op, "cid": cid, "value": value, "target_sec": target_sec, "at": time.monotonic()}


def _clear_pending() -> None:
    global _pending_action
    _pending_action = None


def _vlc_get_pending(path: str, **kwargs):
    try:
        return vlc_get(path, **kwargs)
    except Exception:
        _clear_pending()
        raise


def _playback_modes(status: dict) -> dict[str, str]:
    loop = "one" if status.get("repeat") else "all" if status.get("loop") else "off"
    return {"loop": loop, "random": "on" if status.get("random") else "off"}


def _mode_was_expected(name: str, value: str) -> bool:
    expected = _expected_modes.get(name)
    if expected is None:
        return False
    if time.monotonic() - expected[1] > 10.0:
        _expected_modes.pop(name, None)
        return False
    if expected[0] != value:
        return False
    _expected_modes.pop(name, None)
    return True


def _set_playback_mode(cid: str, name: str, value: str, switches: dict[str, bool]) -> None:
    with _modes_lock:
        current = read_status_dict()

        def pending_flips(state: dict) -> list[str]:
            return sorted((key for key, on in switches.items() if bool(state.get(key)) != on),
                          key=lambda key: not switches[key])

        if not pending_flips(current):
            return
        _expected_modes[name] = (value, time.monotonic())
        try:
            for _ in range(len(switches) + 1):
                flips = pending_flips(current)
                if not flips:
                    break
                current = vlc_get("/requests/status.json", params={"command": _MODE_COMMANDS[flips[0]]}).json()
        except Exception:
            _expected_modes.pop(name, None)
            raise
    log_event("action", who="web", cid=cid, identity=_client_identity(cid), op=f"{name}_mode", value=value)


def _cmd_error_reason(exc: Exception) -> str:
    return type(exc).__name__ if isinstance(exc, requests.RequestException) else str(exc)


def _ws_err(ws, op: str, msg: str) -> None:
    _ws_send_safe(ws, json.dumps({"type": "cmd_error", "op": op, "message": msg}))


def _log_quote(value) -> str:
    return quote(str(value).replace("\n", " ").strip(), safe=":/,()[]@-_.")


def log_event(event_type: str, **kv) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    parts = [ts, "EVENT", f"type={event_type}"]
    for k, v in kv.items():
        if v is None:
            continue
        if isinstance(v, list):
            s = _ITEM_SEPARATOR.join(_log_quote(item) for item in v)
        else:
            s = _log_quote(v)
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


def _reserve_seat_locked(cid: str) -> None:
    if GRACE_SECONDS <= 0:
        return
    _reserved[cid] = time.monotonic() + GRACE_SECONDS
    meta = _client_meta.get(cid)
    if meta is not None:
        meta["left_at"] = _now()


def _cleanup_reserved_locked(now: float) -> None:
    expired = [cid for cid, exp in _reserved.items() if exp <= now]
    for cid in expired:
        identity = _client_identity_locked(cid)
        _reserved.pop(cid, None)
        _client_meta.pop(cid, None)
        log_event("seat_expired", cid=cid, identity=identity)


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
        if GRACE_SECONDS <= 0:
            _client_meta.pop(cid, None)
    if GRACE_SECONDS <= 0:
        log_event("client_leave", cid=cid, identity=identity)
    else:
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
            left_at = meta.get("left_at", now)
            entry["left_at"] = left_at
            entry["reserved_until"] = left_at + GRACE_SECONDS
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
        _rejected_logged.discard(cid)
        return True, "already-active"
    if cid in _reserved:
        _rejected_logged.discard(cid)
        return True, "rejoin-reserved"
    if (len(_active) + len(_reserved)) < MAX_CLIENTS:
        _rejected_logged.discard(cid)
        return True, "new-seat"

    return False, "server full"


def _log_reject_once_locked(cid: str, occupied_count: int, cooldown: int) -> None:
    if cid in _rejected_logged:
        return
    _rejected_logged.add(cid)
    identity = _client_identity_locked(cid) if cid in _client_meta else _client_real_ip()
    log_event("client_reject", cid=cid, identity=identity, reason="server_full",
              clients=occupied_count, max=MAX_CLIENTS, cooldown=cooldown)


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
    now = time.monotonic()
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
                "now": _now(),
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
                _reserve_seat_locked(cid)
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
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


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
    r.encoding = "utf-8"
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
    uri = current.get("uri") or ""
    if not uri:
        return
    _session_progress[uri] = {
        "watched": int(status.get("time") or 0),
        "duration": int(status.get("length") or 0),
    }


def _resume_position(uri: str, requested: int) -> int:
    if ALLOW_SEEKING:
        return requested
    if not requested:
        return 0
    return int((_session_progress.get(uri) or {}).get("watched") or 0)


def _apply_progress(items: list[dict]) -> list[dict]:
    for item in items:
        progress = _session_progress.get(item.get("uri") or "")
        if progress:
            item["progress"] = dict(progress)
    return items


_last_seen: dict | None = None
_last_seen_mono: float | None = None
_vlc_reachable: bool = True
_vlc_lost_reason: str = ""
_last_playlist_json: str | None = None
_last_playlist: list[dict] = []
_playlist_diff_ready = False
_auto_root_cache: tuple[str, BlacklistLift] | None = None
_auto_root_last_log: str = ""


def _note_auto_miss(reason: str, **kv) -> None:
    global _auto_root_last_log
    key = f"{reason}|{kv.get('uri','')}|{kv.get('dir','')}"
    if key == _auto_root_last_log:
        return
    _auto_root_last_log = key
    log_event("auto_root_miss", reason=reason, **kv)


def broadcaster_loop() -> None:
    global _last_seen, _last_seen_mono, _last_playlist_json, _last_playlist, _auto_root_cache, _pending_action, _vlc_reachable, _vlc_lost_reason, _playlist_diff_ready

    while True:
        time.sleep(0.75)

        with _lock:
            all_ws = []
            for ws_set in _active.values():
                all_ws.extend(list(ws_set))
            seat_expiring = any(exp <= time.monotonic() for exp in _reserved.values())

        if seat_expiring:
            broadcast_clients()

        if not all_ws and not LOG_WHEN_IDLE:
            _last_seen = None
            _last_seen_mono = None
            _playlist_diff_ready = False
            continue

        status: dict | None = None
        try:
            status = read_status_dict()
            tick_mono = time.monotonic()
            if not _vlc_reachable:
                _vlc_reachable = True
                _vlc_lost_reason = ""
                log_event("vlc_back")

            if _last_seen is not None:
                elapsed = tick_mono - (_last_seen_mono or tick_mono)
                pending = _pending_action
                if pending is not None and (time.monotonic() - pending.get("at", 0)) > 10.0:
                    _pending_action = None
                    pending = None

                prev_state = (_last_seen.get("state") or "unknown")
                new_state = (status.get("state") or "unknown")
                prev_title = (_last_seen.get("title") or "")
                new_title = (status.get("title") or "")
                prev_time = int(_last_seen.get("time") or 0)
                new_time = int(status.get("time") or 0)
                prev_length = int(_last_seen.get("length") or 0)

                near_end = prev_length > 0 and (prev_length - prev_time) <= 2
                track_changed = bool(new_title and new_title != prev_title and new_state != "stopped")
                restarted = (not track_changed and new_state == prev_state
                             and new_time <= 2 and new_time < prev_time)

                suppress_secondary = False
                resumed_from_stopped = prev_state == "stopped" and new_state != "stopped"
                if new_state != prev_state:
                    if pending and pending["op"] == "toggle":
                        cid_log = pending["cid"]
                        _pending_action = None
                        pending = None
                        suppress_secondary = resumed_from_stopped
                        log_event("action", who="web", cid=cid_log, identity=_client_identity(cid_log),
                                  op=_playback_op(prev_state, new_state))
                    elif pending and pending["op"] == "stop":
                        _pending_action = None
                        pending = None
                        suppress_secondary = True
                    elif pending and pending["op"] in _PLAYBACK_MASK_OPS:
                        if pending["op"] in ("playlist_remove", "playlist_clear"):
                            _pending_action = None
                            pending = None
                    elif new_state == "stopped" and prev_state == "playing" and near_end:
                        log_event("action", who="vlc", identity="VLC", op="playlist_end")
                        suppress_secondary = True
                    else:
                        suppress_secondary = resumed_from_stopped
                        log_event("action", who="host", identity="Host",
                                  op=_playback_op(prev_state, new_state))

                if not suppress_secondary and track_changed:
                    if pending and pending["op"] in _TRACK_OPS:
                        skip_cid = pending["cid"] if pending["op"] in ("next", "prev") else None
                        skip_op = pending["op"]
                        _pending_action = None
                        pending = None
                        if skip_cid:
                            log_event("action", who="web", cid=skip_cid, identity=_client_identity(skip_cid),
                                      op=skip_op, value=new_title)
                    elif pending and pending["op"] in _PLAYBACK_MASK_OPS:
                        pass
                    elif near_end:
                        log_event("action", who="vlc", identity="VLC", op="auto_next", value=new_title)
                    else:
                        log_event("action", who="host", identity="Host", op="track_change", value=new_title)

                if not suppress_secondary and restarted:
                    if pending and pending["op"] in _RESTART_MASK_OPS:
                        skip_cid = pending["cid"] if pending["op"] in ("next", "prev") else None
                        skip_op = pending["op"]
                        _pending_action = None
                        pending = None
                        if skip_cid:
                            log_event("action", who="web", cid=skip_cid, identity=_client_identity(skip_cid),
                                      op=skip_op, value=new_title)
                    elif pending and pending["op"] in _SEEK_MASK_OPS:
                        _pending_action = None
                        pending = None
                    elif near_end:
                        log_event("action", who="vlc", identity="VLC", op="loop_restart", value=new_title)
                    elif len(_last_playlist) == 1 and new_title:
                        log_event("action", who="host", identity="Host", op="restart", value=new_title)
                    else:
                        at_s = format_time(new_time)
                        len_s = format_time(int(status.get("length") or 0))
                        log_event("action", who="host", identity="Host", op="seek",
                                  at=at_s, length=len_s, value=f"{at_s}/{len_s}")

                expected_time = prev_time + elapsed if new_state == "playing" else prev_time
                if (not suppress_secondary and not track_changed and not restarted
                        and new_state != "stopped" and abs(new_time - expected_time) >= 3):
                    if pending and pending["op"] == "seek":
                        t = pending.get("target_sec")
                        if t is None or abs(new_time - t) <= 5:
                            _pending_action = None
                            pending = None
                    elif pending and pending["op"] in _SEEK_MASK_OPS:
                        pass
                    else:
                        length_s = int(status.get("length") or 0)
                        at_s = format_time(new_time)
                        len_s = format_time(length_s)
                        log_event("action", who="host", identity="Host", op="seek",
                                  at=at_s, length=len_s, value=f"{at_s}/{len_s}")

                prev_modes = _playback_modes(_last_seen)
                for name, value in _playback_modes(status).items():
                    if value != prev_modes[name] and not _mode_was_expected(name, value):
                        log_event("action", who="host", identity="Host", op=f"{name}_mode", value=value)

            _last_seen = status
            _last_seen_mono = tick_mono
            payload = json.dumps({"type": "status", "data": status})

        except Exception as exc:
            _last_seen = None
            _last_seen_mono = None
            _playlist_diff_ready = False
            lost_reason = type(exc).__name__
            if _vlc_reachable or lost_reason != _vlc_lost_reason:
                _vlc_reachable = False
                _vlc_lost_reason = lost_reason
                log_event("vlc_lost", reason=lost_reason)
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
            if status is not None and _playlist_diff_ready:
                _record_host_removals(_last_playlist, playlist_items)
            _playlist_diff_ready = status is not None
            if status is not None:
                _update_session_progress(status, playlist_items)
            playlist_items = _apply_progress(playlist_items)
            _last_playlist = playlist_items

            new_root: tuple[str, BlacklistLift] | None = None
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
                            real_dir = os.path.realpath(dir_path)
                            lift = _auto_dir_lift(real_dir, os.path.basename(path))
                            if lift is None:
                                _note_auto_miss("blacklisted", dir=real_dir)
                            else:
                                new_root = (real_dir, lift)
                        else:
                            _note_auto_miss("not_a_dir", uri=uri, dir=dir_path)
                    else:
                        _note_auto_miss("not_file_uri", uri=uri)
                    break
                if not found_current and playlist_items:
                    _note_auto_miss("no_current")
            if new_root != _auto_root_cache:
                _auto_root_cache = new_root

            playlist_json = json.dumps(playlist_items, sort_keys=True)
            if playlist_json != _last_playlist_json:
                _last_playlist_json = playlist_json
                playlist_payload = json.dumps({"type": "playlist", "data": playlist_items})
        except Exception:
            _playlist_diff_ready = False

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


@app.after_request
def _security_headers(response):
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


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


def _skip_is_dead_end(op: str) -> bool:
    if bool((_last_seen or {}).get("loop")) or bool((_last_seen or {}).get("random")):
        return False
    index = next((i for i, item in enumerate(_last_playlist) if item.get("isCurrent")), -1)
    if index < 0:
        return False
    return index == 0 if op == "prev" else index == len(_last_playlist) - 1


def _removes_current(items: list[dict], ids: list[str]) -> bool:
    return any(item.get("isCurrent") and str(item.get("id") or "") in ids for item in items)


def _playlist_name_for_id(items: list[dict], playlist_id: str) -> str:
    for item in items:
        if item.get("id") == playlist_id:
            return item.get("name") or ""
    return ""


def _removed_entries(items: list[dict], ids: list[str]) -> list[dict]:
    wanted = set(ids)
    return [
        {"id": str(item.get("id") or ""), "uri": item.get("uri") or "", "name": item.get("name") or "", "index": index}
        for index, item in enumerate(items)
        if str(item.get("id") or "") in wanted and item.get("uri")
    ]


def _undo_message(for_cid: str) -> str:
    with _undo_lock:
        records = [
            {
                "id": record["id"],
                "op": record["op"],
                "who": record["identity"],
                "host": record["cid"] is None,
                "mine": record["cid"] is not None and record["cid"] == for_cid,
                "at": record["at"],
                "items": [{"key": entry["key"], "uri": entry["uri"], "name": entry["name"]} for entry in record["items"]],
            }
            for record in _undo_history
        ]
    return json.dumps({"type": "undo", "data": {"records": records, "size": UNDO_HISTORY_SIZE}})


def broadcast_undo() -> None:
    with _lock:
        targets = [(target_cid, list(ws_set)) for target_cid, ws_set in _active.items()]
    for target_cid, ws_list in targets:
        payload = _undo_message(target_cid)
        for ws in ws_list:
            _ws_send_safe(ws, payload)


def _expect_removals(uris: list[str]) -> None:
    now = time.monotonic()
    with _undo_lock:
        for uri in uris:
            _expected_removals[uri] = now


def _unexpect_removals(uris: list[str]) -> None:
    with _undo_lock:
        for uri in uris:
            _expected_removals.pop(uri, None)


def _vlc_call_expecting_removals(uris: list[str], params: dict) -> None:
    _expect_removals(uris)
    try:
        vlc_get("/requests/status.xml", params=params)
    except Exception:
        _unexpect_removals(uris)
        raise


def _record_removal(cid: str | None, op: str, entries: list[dict]) -> None:
    global _undo_record_counter
    if not PLAYLIST_UNDO or not entries:
        return
    identity = _client_identity(cid) if cid else "Host"
    with _undo_lock:
        _undo_record_counter += 1
        _undo_history.append({
            "id": _undo_record_counter,
            "cid": cid,
            "identity": identity,
            "op": op,
            "at": _now(),
            "items": [dict(entry, key=key) for key, entry in enumerate(entries)],
        })
        del _undo_history[:-UNDO_HISTORY_SIZE]
    broadcast_undo()


def _record_host_removals(previous: list[dict], current: list[dict]) -> None:
    current_uris = {item.get("uri") for item in current}
    now = time.monotonic()
    vanished = []
    with _undo_lock:
        for uri, marked_at in list(_expected_removals.items()):
            if now - marked_at > 10.0:
                _expected_removals.pop(uri, None)
        for index, item in enumerate(previous):
            uri = item.get("uri") or ""
            if not uri or uri in current_uris:
                continue
            if _expected_removals.pop(uri, None) is not None:
                continue
            vanished.append({"id": str(item.get("id") or ""), "uri": uri, "name": item.get("name") or "", "index": index})
    if not vanished:
        return

    op = "clear" if not current and len(vanished) > 1 else "remove"
    if op == "clear":
        log_event("action", who="host", identity="Host", op="playlist_clear")
    elif len(vanished) == 1:
        log_event("action", who="host", identity="Host", op="playlist_remove",
                  value=(vanished[0]["name"] or vanished[0]["uri"]))
    else:
        log_event("action", who="host", identity="Host", op="playlist_remove_many", value=len(vanished),
                  items=[item["name"] or item["uri"] for item in vanished])
    _record_removal(None, op, vanished)


def _parse_undo_picks(raw) -> dict[int, set[int] | None]:
    picks: dict[int, set[int] | None] = {}
    if not isinstance(raw, list):
        return picks
    for pick in raw:
        if not isinstance(pick, dict):
            continue
        try:
            record_id = int(pick.get("record"))
            items = pick.get("items")
            picks[record_id] = None if items is None else {int(key) for key in items}
        except (ValueError, TypeError):
            continue
    return picks


def _take_undo_items(picks: dict[int, set[int] | None]) -> tuple[list[tuple[dict, dict]], bool]:
    in_playlist = {item.get("uri") for item in _last_playlist}
    restoring: list[tuple[dict, dict]] = []
    found = False
    with _undo_lock:
        for record in list(_undo_history):
            if record["id"] not in picks:
                continue
            wanted = picks[record["id"]]
            taken = [entry for entry in record["items"] if wanted is None or entry["key"] in wanted]
            if not taken:
                continue
            found = True
            taken_keys = {entry["key"] for entry in taken}
            record["items"] = [entry for entry in record["items"] if entry["key"] not in taken_keys]
            if not record["items"]:
                _undo_history.remove(record)
            restoring.extend((record, entry) for entry in taken if entry["uri"] not in in_playlist)
    return restoring, found


def _return_undo_items(pairs: list[tuple[dict, dict]]) -> None:
    with _undo_lock:
        for record, entry in pairs:
            record["items"].append(entry)
            record["items"].sort(key=lambda item: item["key"])
            if not any(existing is record for existing in _undo_history):
                _undo_history.append(record)
        _undo_history.sort(key=lambda record: record["id"])
        del _undo_history[:-UNDO_HISTORY_SIZE]
    broadcast_undo()


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

    body = request.json or {}
    raw_ids = body.get("ids")
    if raw_ids is None:
        raw_ids = [body.get("id", "")]
    ids = [str(i).strip() for i in raw_ids if str(i).strip()]
    if not ids:
        abort(400, "Missing id")

    names = {playlist_id: _playlist_name_for_id(_last_playlist, playlist_id) for playlist_id in ids}
    entries = _removed_entries(_last_playlist, ids)
    _expect_removals([entry["uri"] for entry in entries])
    masking = _removes_current(_last_playlist, ids)
    if masking:
        _set_pending("playlist_remove", cid, value=ids[-1])

    removed, failed = [], []
    for playlist_id in ids:
        try:
            vlc_get("/requests/status.xml", params={"command": "pl_delete", "id": playlist_id})
            removed.append(playlist_id)
        except Exception:
            failed.append(playlist_id)

    if not removed and masking:
        _clear_pending()
    elif len(removed) == 1:
        log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="playlist_remove",
                  value=(names[removed[0]] or removed[0]))
    else:
        log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="playlist_remove_many",
                  value=len(removed), items=[names[playlist_id] or playlist_id for playlist_id in removed])

    removed_set = set(removed)
    _unexpect_removals([entry["uri"] for entry in entries if entry["id"] not in removed_set])
    _record_removal(cid, "remove", [entry for entry in entries if entry["id"] in removed_set])

    return jsonify({"removed": removed, "failed": failed})


def _require_file_browse() -> None:
    if not FILE_BROWSE:
        abort(403)


def _current_auto_root() -> tuple[str, BlacklistLift] | None:
    return _auto_root_cache if FILE_BROWSE_AUTO else None


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
            _label, root, _rec, _lift = root_info
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


def _resolve_root(root_id: str) -> tuple[str, str, bool, BlacklistLift] | None:
    if root_id == "auto":
        auto_root = _current_auto_root()
        if not auto_root:
            return None
        dir_path, lift = auto_root
        return ("Now playing folder", dir_path, FILE_BROWSE_AUTO_RECURSIVE, lift)
    if not root_id.startswith("r"):
        return None
    try:
        idx = int(root_id[1:])
    except ValueError:
        return None
    if 0 <= idx < len(_FILE_ROOTS):
        return (*_FILE_ROOTS[idx], _NO_LIFT)
    return None


def _safe_join(root: str, rel: str, *, allow_sub: bool = True, lift: BlacklistLift = _NO_LIFT) -> str | None:
    rel = (rel or "").strip().lstrip("/").replace("\\", "/").rstrip("/")
    if rel and ".." in rel.split("/"):
        return None
    if rel and not allow_sub and "/" in rel:
        return None
    full = os.path.realpath(os.path.join(root, rel))
    if full != root and not full.startswith(root + os.sep):
        return None
    if _is_hidden_under_root(root, full, lift):
        return None
    return full


def _is_hidden_under_root(root: str, full: str, lift: BlacklistLift = _NO_LIFT) -> bool:
    if full == root:
        return False
    parts = os.path.relpath(full, root).split(os.sep)
    if any(part.startswith(".") or _is_blacklisted_term(part, lift) for part in parts):
        return True
    dir_parts = parts if os.path.isdir(full) else parts[:-1]
    return _is_blacklisted_dir_path([part.lower() for part in dir_parts], lift)


def _auto_dir_lift(dir_path: str, file_name: str) -> BlacklistLift | None:
    base = os.path.dirname(dir_path)
    for _label, root, _recursive in _FILE_ROOTS:
        if dir_path == root or dir_path.startswith(root + os.sep):
            base = root
            break
    parts = os.path.relpath(dir_path, base).split(os.sep) if dir_path != base else []
    if any(part.startswith(".") for part in parts):
        return None
    if FILE_BROWSE_AUTO_BLACKLIST == "ignore":
        return (_FILE_BLACKLIST_TERMS, _FILE_BLACKLIST_DIR_PATTERNS)

    dir_hits = _blacklist_dir_hits([part.lower() for part in parts])
    if FILE_BROWSE_AUTO_BLACKLIST != "allow":
        term_hits = [t for part in parts for t in _blacklist_term_hits(part)]
        return None if term_hits or dir_hits else _NO_LIFT

    names = [part.lower() for part in parts] + [file_name.lower()]
    term_hits = [t for t in _FILE_BLACKLIST_TERMS if any(t in name for name in names)]
    return (term_hits, dir_hits)


def _ext_of(name: str) -> str:
    _, dot, ext = name.rpartition(".")
    return ext.lower() if dot else ""


def _ext_allowed(name: str) -> bool:
    if not FILE_BROWSE_EXTENSIONS:
        return True
    return _ext_of(name) in FILE_BROWSE_EXTENSIONS


def _path_to_uri(path: str) -> str:
    return "file://" + quote(path)


def _list_dir(full: str, rel: str, *, allow_sub: bool = True, lift: BlacklistLift = _NO_LIFT) -> list[dict]:
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
                if _is_blacklisted_term(name, lift):
                    continue
                if _is_blacklisted_dir_path(base_parts + [lo], lift):
                    continue
                entries.append({"name": name, "type": "dir"})
            elif os.path.isfile(path) and _ext_allowed(name):
                if _is_blacklisted_term(name, lift):
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
                    progress = _session_progress.get(uri)
                    if progress:
                        entry["progress"] = dict(progress)
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
    if _current_auto_root():
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
    label, root, recursive, lift = root_info

    full = _safe_join(root, rel, allow_sub=recursive, lift=lift)
    if full is None or not os.path.isdir(full):
        abort(404)

    return jsonify({
        "root": {"id": root_id, "label": label, "recursive": recursive},
        "path": rel.strip("/"),
        "entries": _list_dir(full, rel, allow_sub=recursive, lift=lift),
    })


def _resolve_file_path(root_id: str, rel: str) -> str | None:
    root_info = _resolve_root(root_id)
    if not root_info:
        return None
    _label, root, recursive, lift = root_info

    full = _safe_join(root, rel, allow_sub=recursive, lift=lift)
    if full is None or not os.path.isfile(full) or not _ext_allowed(os.path.basename(full)):
        return None
    return full


def _resolve_file_arg() -> tuple[str, str, str]:
    body = request.json or {}
    root_id = str(body.get("root", "")).strip()
    rel = str(body.get("path", "")).strip()

    full = _resolve_file_path(root_id, rel)
    if full is None:
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
    require_playlist_control()

    body = request.json or {}
    root_id = str(body.get("root", "")).strip()
    raw_paths = body.get("paths")
    if raw_paths is None:
        raw_paths = [body.get("path", "")]
    rels = [str(p).strip() for p in raw_paths if str(p).strip()]
    if not rels:
        abort(400, "Missing path")

    added, already, failed = [], [], []
    added_names = []
    for rel in rels:
        full = _resolve_file_path(root_id, rel)
        if full is None:
            failed.append(rel)
            continue
        uri = _path_to_uri(full)
        if _playlist_find_by_uri(uri):
            already.append(rel)
            continue
        try:
            vlc_get("/requests/status.xml", params={"command": "in_enqueue", "input": uri})
        except Exception:
            failed.append(rel)
            continue
        added.append(rel)
        added_names.append(_log_file_value(root_id, rel, full))

    if len(added) == 1:
        log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="files_add",
                  value=added_names[0])
    elif added:
        log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="files_add_many",
                  value=len(added), items=added_names)

    return jsonify({"added": added, "already": already, "failed": failed})


@app.post("/api/files/play")
def files_play():
    require_token()
    _, cid = require_sid()
    _require_file_browse()
    require_playlist_control()

    root_id, rel, full = _resolve_file_arg()
    uri = _path_to_uri(full)

    body = request.json or {}
    resume_at = 0
    if body.get("resume_at") not in (None, "", 0):
        try:
            resume_at = max(0, int(body["resume_at"]))
        except (ValueError, TypeError):
            abort(400, "Invalid resume_at")
    resume_at = _resume_position(uri, resume_at)

    identity = _client_identity(cid)

    existing = _playlist_find_by_uri(uri)
    if existing:
        if resume_at > 0:
            _set_pending("files_play_resume_existing", cid=cid, value=f"{existing}@{resume_at}")
        else:
            _set_pending("files_play_existing", cid=cid, value=existing)
        _vlc_get_pending("/requests/status.xml", params={"command": "pl_play", "id": existing})
        if resume_at > 0:
            time.sleep(0.25)
            _vlc_get_pending("/requests/status.xml", params={"command": "seek", "val": str(resume_at)})
            log_event("action", who="web", cid=cid, identity=identity, op="files_play_resume_existing",
                      at=format_time(resume_at), value=f"{os.path.basename(full)} - {format_time(resume_at)}")
        else:
            log_event("action", who="web", cid=cid, identity=identity, op="files_play_existing",
                      value=os.path.basename(full))
        return jsonify({"status": "jumped", "id": existing})

    if resume_at > 0:
        _set_pending("files_play_resume", cid=cid, value=f"{rel}@{resume_at}")
    else:
        _set_pending("files_play", cid=cid, value=rel)
    _vlc_get_pending("/requests/status.xml", params={"command": "in_play", "input": uri})
    if resume_at > 0:
        time.sleep(0.25)
        _vlc_get_pending("/requests/status.xml", params={"command": "seek", "val": str(resume_at)})
        log_event("action", who="web", cid=cid, identity=identity, op="files_play_resume",
                  at=format_time(resume_at), value=f"{_log_file_value(root_id, rel, full)} - {format_time(resume_at)}")
    else:
        log_event("action", who="web", cid=cid, identity=identity, op="files_play",
                  value=_log_file_value(root_id, rel, full))
    return jsonify({"status": "added_and_played"})


@app.get("/api/clients")
def clients():
    require_token()
    cid = request.args.get("cid", "").strip()

    now = time.monotonic()
    with _lock:
        occupied_count = _occupied_count_locked(now)
        cooldown = _seconds_until_next_seat_opens_locked(now)
        response = {
            "clients": occupied_count,
            "max": MAX_CLIENTS,
            "open": occupied_count < MAX_CLIENTS,
            "cooldown": cooldown,
            "grace": int(GRACE_SECONDS),
            "now": _now(),
        }

        if cid:
            ok, reason = _can_admit_locked(cid, now)
            response["admit_for_cid"] = bool(ok)
            response["reason"] = reason
            if not ok:
                _log_reject_once_locked(cid, occupied_count, cooldown)

    return jsonify(response)


def _resolve_action_buffer(op: str, vlc_command: str) -> None:
    global _last_seen, _last_seen_mono

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
        if _last_seen is None or _last_seen.get("state") != current.get("state"):
            log_event("action", who="host", identity="Host",
                      op=_playback_op(baseline.get("state") or "", current.get("state") or ""))
            _last_seen = current
            _last_seen_mono = time.monotonic()
        for extra_cid in candidates:
            log_event("action_dropped", cid=extra_cid, op=op, reason="host_preempted")
        return

    winner = random.choice(candidates)
    _set_pending(op, winner)
    try:
        vlc_cmd(vlc_command)
    except Exception as exc:
        _clear_pending()
        log_event("cmd_error", cid=winner, identity=_client_identity(winner), op=op, reason=_cmd_error_reason(exc))
        return

    if op == "stop":
        log_event("action", who="web", cid=winner, identity=_client_identity(winner), op="stop")
    for extra_cid in candidates:
        if extra_cid != winner:
            log_event("action_duplicate", cid=extra_cid, op=op, note="lost_tiebreak")


def _debounced_dispatch(cid: str, op: str, vlc_command: str) -> None:
    if ACTION_DEBOUNCE_MS <= 0:
        _set_pending(op, cid)
        vlc_cmd(vlc_command)
        if op == "stop":
            log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="stop")
        return

    with _action_buffers_lock:
        buf = _action_buffers.get(op)
        if buf is not None:
            if cid not in buf["candidates"]:
                buf["candidates"].append(cid)
            return

        baseline = _last_seen
        if baseline is None:
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
        if op in _NEEDS_MEDIA_OPS and _last_seen is not None and not _last_playlist:
            log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="nothing_loaded")
            _ws_err(ws, op, "nothing is loaded"); return

        if op in _DEBOUNCE_OPS:
            _debounced_dispatch(cid, op, _DEBOUNCE_OPS[op])

        elif op in ("next", "prev"):
            looping_single = len(_last_playlist) == 1 and bool((_last_seen or {}).get("loop"))
            if not looping_single and _skip_is_dead_end(op):
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="nothing_to_skip_to")
                _ws_err(ws, op, "nothing to skip to"); return
            logged_op = "restart" if looping_single else op
            _set_pending(logged_op, cid)
            vlc_cmd("pl_next" if op == "next" else "pl_previous")
            if looping_single:
                log_event("action", who="web", cid=cid, identity=_client_identity(cid), op=logged_op,
                          value=(_last_seen or {}).get("title"))

        elif op == "loop":
            if not LOOP_CONTROL:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="loop_control_not_allowed")
                _ws_err(ws, op, "loop control not allowed"); return
            mode = str(data.get("val") or "").strip().lower()
            if mode not in _LOOP_MODES:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="bad_mode")
                _ws_err(ws, op, "val required"); return
            _set_playback_mode(cid, "loop", mode, {"loop": mode == "all", "repeat": mode == "one"})

        elif op == "random":
            if not RANDOM_CONTROL:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="random_control_not_allowed")
                _ws_err(ws, op, "random control not allowed"); return
            mode = str(data.get("val") or "").strip().lower()
            if mode not in ("on", "off"):
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="bad_mode")
                _ws_err(ws, op, "val required"); return
            _set_playback_mode(cid, "random", mode, {"random": mode == "on"})

        elif op == "set_nickname":
            nickname = str(data.get("nickname") or "").strip()[:NICKNAME_MAX_LENGTH]
            taken = False
            with _lock:
                meta = _ensure_client_meta_locked(cid)
                old_nickname = meta.get("nickname")
                if nickname:
                    taken = any(
                        other_cid != cid and (other_meta.get("nickname") or "").lower() == nickname.lower()
                        for other_cid, other_meta in _client_meta.items()
                        if other_cid in _active or other_cid in _reserved
                    )
                changed = not taken and (nickname or None) != old_nickname
                if changed:
                    fallback = _client_fallback_identity_locked(cid)
                    old_display = old_nickname or fallback
                    new_display = nickname or fallback
                    meta["nickname"] = nickname or None
            if taken:
                _ws_err(ws, op, "nickname taken")
                return
            if changed:
                log_event("nickname_set" if nickname else "nickname_clear",
                          cid=cid, identity=old_display, old=old_display, new=new_display)
            broadcast_clients()
            _ws_send_safe(ws, json.dumps({"type": "nickname_ok", "nickname": nickname}))

        elif op == "seek":
            if not ALLOW_SEEKING:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="seeking_not_allowed")
                _ws_err(ws, op, "seeking not allowed"); return
            val = str(data.get("val") or "").strip()
            if not val:
                _ws_err(ws, op, "val required"); return

            seen = _last_seen
            if seen is not None and (seen.get("length") or 0) <= 0:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="nothing_loaded")
                _ws_err(ws, op, "nothing is loaded"); return

            target_sec = at_s = len_s = None
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

            _set_pending("seek", cid, value=val, target_sec=target_sec)
            vlc_get("/requests/status.xml", params={"command": "seek", "val": val})
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

            name, total, uri = "", 0, ""
            for item in _last_playlist:
                if item.get("id") == playlist_id:
                    name = item.get("name") or ""
                    total = int(item.get("duration") or 0)
                    uri = item.get("uri") or ""
                    break
            resume_at = _resume_position(uri, resume_at)

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
            entries = _removed_entries(_last_playlist, [playlist_id])
            if _removes_current(_last_playlist, [playlist_id]):
                _set_pending("playlist_remove", cid, value=playlist_id)
            _vlc_call_expecting_removals([entry["uri"] for entry in entries], {"command": "pl_delete", "id": playlist_id})
            log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="playlist_remove",
                      value=(name or playlist_id))
            _record_removal(cid, "remove", entries)

        elif op == "playlist/clear":
            if not ALLOW_PLAYLIST_CONTROL:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="playlist_control_not_allowed")
                _ws_err(ws, op, "playlist control not allowed"); return
            entries = _removed_entries(_last_playlist, [str(item.get("id") or "") for item in _last_playlist])
            _set_pending("playlist_clear", cid)
            _vlc_call_expecting_removals([entry["uri"] for entry in entries], {"command": "pl_empty"})
            log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="playlist_clear")
            _record_removal(cid, "clear", entries)

        elif op == "playlist/undo":
            if not ALLOW_PLAYLIST_CONTROL:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="playlist_control_not_allowed")
                _ws_err(ws, op, "playlist control not allowed"); return
            if not PLAYLIST_UNDO:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="playlist_undo_not_allowed")
                _ws_err(ws, op, "playlist undo not allowed"); return
            picks = _parse_undo_picks(data.get("picks"))
            if not picks:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="nothing_to_undo")
                _ws_err(ws, op, "nothing to undo"); return
            restoring, found = _take_undo_items(picks)
            if not found:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="undo_gone")
                _ws_err(ws, op, "undo gone"); return
            broadcast_undo()
            if not restoring:
                log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="already_restored")
                _ws_err(ws, op, "already restored"); return

            restoring.sort(key=lambda pair: (pair[0]["id"], pair[1]["index"]))
            for position, (_, entry) in enumerate(restoring):
                try:
                    vlc_get("/requests/status.xml", params={"command": "in_enqueue", "input": entry["uri"]})
                except Exception:
                    _return_undo_items(restoring[position:])
                    raise

            if len(restoring) == 1:
                entry = restoring[0][1]
                log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="playlist_undo",
                          value=(entry["name"] or entry["uri"]))
            else:
                log_event("action", who="web", cid=cid, identity=_client_identity(cid), op="playlist_undo_many",
                          value=len(restoring), items=[entry["name"] or entry["uri"] for _, entry in restoring])

        else:
            log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason="unknown_op")
            _ws_err(ws, op, "unknown op"); return

        _ws_send_safe(ws, json.dumps({"type": "cmd_ack", "op": op}))

    except Exception as exc:
        _clear_pending()
        log_event("cmd_error", cid=cid, identity=_client_identity(cid), op=op, reason=_cmd_error_reason(exc))
        _ws_err(ws, op, "vlc unreachable" if isinstance(exc, requests.RequestException) else "failed")


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

    now = time.monotonic()
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
                        "now": _now(),
                    }
                }))
                ws.send(json.dumps({"type": "error", "message": "server full"}))
                _log_reject_once_locked(cid, occupied_count, cooldown)
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
                "now": _now(),
                "list": roster,
            }
        }))
        try:
            _ws_send_safe(ws, json.dumps({"type": "status", "data": read_status_dict()}))
        except Exception:
            pass
        try:
            initial_playlist = _apply_progress(read_playlist())
        except Exception:
            initial_playlist = []
        _ws_send_safe(ws, json.dumps({"type": "playlist", "data": initial_playlist}))
        _ws_send_safe(ws, _undo_message(cid))
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
                    _reserve_seat_locked(cid)
                    left = True

        if left:
            _log_client_leave(cid)

        with _sessions_lock:
            _sessions.pop(sid, None)

        broadcast_clients()


def client_count_safe() -> int:
    now = time.monotonic()
    with _lock:
        return _occupied_count_locked(now)


if __name__ == "__main__":
    _port = int(_SYS.get("port", os.environ.get("PORT", "5000")))
    log_event("startup", version=VERSION, commit=APP_COMMIT or None,
              seats=MAX_CLIENTS, port=_port, debounce_ms=ACTION_DEBOUNCE_MS,
              idle_logging=str(LOG_WHEN_IDLE).lower(), file_browse=str(FILE_BROWSE).lower())
    app.run(host="0.0.0.0", port=_port, threaded=True)
