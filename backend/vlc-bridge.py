from __future__ import annotations

from flask import Flask, request, abort, send_from_directory, jsonify
from flask_sock import Sock
import os
import time
import json
import threading
import requests
import secrets
from urllib.parse import quote, unquote, urlparse

VLC_URL = os.environ.get("VLC_URL", "http://127.0.0.1:8080")
VLC_PASS = os.environ.get("VLC_PASS", "")
TOKEN = os.environ.get("TOKEN", "")

MAX_CLIENTS = int(os.environ.get("MAX_CLIENTS", "2"))
GRACE_SECONDS = float(os.environ.get("GRACE_SECONDS", "30"))


def _env_flag(name: str, default: str) -> bool:
    return (os.environ.get(name, default) or default).strip().lower() in ("on", "yes", "true", "1")


FILE_BROWSE = _env_flag("FILE_BROWSE", "off")
FILE_BROWSE_AUTO = _env_flag("FILE_BROWSE_AUTO", "yes")
FILE_BROWSE_AUTO_RECURSIVE = _env_flag("FILE_BROWSE_AUTO_RECURSIVE", "no")

_DEFAULT_EXTS = "mp4,mkv,avi,mov,webm,mp3,flac,ogg,m4a,opus,wav"
FILE_BROWSE_EXTENSIONS: set[str] = {
    e.strip().lower().lstrip(".")
    for e in (os.environ.get("FILE_BROWSE_EXTENSIONS") or _DEFAULT_EXTS).split(",")
    if e.strip()
}


def _parse_file_roots() -> list[tuple[str, str, bool]]:
    raw = os.environ.get("FILE_BROWSE_DIRS", "") or ""
    out: list[tuple[str, str, bool]] = []
    seen: set[str] = set()
    for entry in raw.split(":"):
        entry = entry.strip()
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
    raw = os.environ.get("FILE_BROWSE_BLACKLIST_DIRS", "") or ""
    out: list[list[str]] = []
    for entry in raw.split(":"):
        entry = entry.strip().strip("/").lower()
        if not entry:
            continue
        parts = [s for s in entry.split("/") if s]
        if parts:
            out.append(parts)
    return out


def _parse_blacklist_terms() -> list[str]:
    raw = os.environ.get("FILE_BROWSE_BLACKLIST_TERMS", "") or ""
    return [t.strip().lower() for t in raw.split(",") if t.strip()]


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

app = Flask(__name__, static_folder="static", static_url_path="")
sock = Sock(app)

_active: dict[str, set] = {}          # cid -> set(ws)
_reserved: dict[str, float] = {}      # cid -> expires_at
_lock = threading.Lock()

_sessions: dict[str, tuple] = {}      # sid -> (ws, cid)
_sessions_lock = threading.Lock()

_last_api_action_at = 0.0
_last_api_action: dict | None = None

def mark_api_action(op: str, cid: str | None = None, value: str | None = None) -> None:
    global _last_api_action_at, _last_api_action
    _last_api_action_at = time.time()
    _last_api_action = {"op": op, "cid": cid, "value": value}


def api_action_recent(window_s: float = 1.25) -> bool:
    return (time.time() - _last_api_action_at) <= window_s


def log_event(event_type: str, **kv) -> None:
    parts = [f"EVENT type={event_type}"]
    for k, v in kv.items():
        if v is None:
            continue
        s = str(v).replace("\n", " ").strip().replace(" ", "_")
        parts.append(f"{k}={s}")
    print(" ".join(parts), flush=True)


def is_host_request() -> bool:
    ra = request.remote_addr or ""
    return ra in ("127.0.0.1", "::1")


def require_token() -> None:
    if not TOKEN:
        abort(500, "TOKEN not set")
    if request.args.get("t") != TOKEN:
        abort(403)


def fmt_time(seconds: int) -> str:
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


def _occupied_count_locked(now: float) -> int:
    _cleanup_reserved_locked(now)
    return len(_active) + len(_reserved)


def _seconds_until_next_seat_opens_locked(now: float) -> int:
    occ = _occupied_count_locked(now)
    if occ < MAX_CLIENTS:
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


def _ensure_cid() -> str:
    cid = request.args.get("cid", "").strip()
    if not cid:
        abort(400, "Missing cid")
    if len(cid) > 200:
        abort(400, "cid too long")
    return cid


def require_sid() -> tuple[str, str]:
    sid = request.args.get("sid", "")
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
    try:
        ws.send(payload)
        return True
    except Exception:
        return False


def broadcast_clients() -> None:
    now = _now()
    with _lock:
        occ = _occupied_count_locked(now)
        payload = json.dumps({
            "type": "clients",
            "data": {
                "clients": occ,
                "max": MAX_CLIENTS,
                "open": occ < MAX_CLIENTS,
                "cooldown": _seconds_until_next_seat_opens_locked(now),
                "grace": int(GRACE_SECONDS),
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

    with _lock:
        for cid, ws_set in list(_active.items()):
            for w in list(ws_set):
                if w in dead:
                    ws_set.discard(w)
            if len(ws_set) == 0:
                _active.pop(cid, None)
                _reserved[cid] = _now() + GRACE_SECONDS

    with _sessions_lock:
        for sid, (w, _) in list(_sessions.items()):
            if w in dead:
                _sessions.pop(sid, None)


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
    current = next((it for it in items if it.get("isCurrent")), None)
    if not current:
        return
    pid = str(current.get("id") or "")
    if not pid:
        return
    _session_progress[pid] = {
        "watched": int(status.get("time") or 0),
        "duration": int(status.get("length") or 0),
    }


def _apply_progress(items: list[dict]) -> list[dict]:
    for item in items:
        pid = str(item.get("id") or "")
        if pid and pid in _session_progress:
            item["progress"] = dict(_session_progress[pid])
    return items


_last_seen: dict | None = None
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
    global _last_seen, _last_playlist_json, _last_playlist, _current_playing_dir_cache

    while True:
        time.sleep(0.75)

        with _lock:
            all_ws = []
            for ws_set in _active.values():
                all_ws.extend(list(ws_set))

        if not all_ws:
            continue

        status: dict | None = None
        try:
            status = read_status_dict()

            if _last_seen is not None and not api_action_recent(1.0):
                prev_state = (_last_seen.get("state") or "unknown")
                new_state = (status.get("state") or "unknown")
                if new_state != prev_state:
                    op = "play" if new_state == "playing" else new_state
                    log_event("action", who="host", op=op)

                prev_title = (_last_seen.get("title") or "")
                new_title = (status.get("title") or "")
                if new_title and new_title != prev_title:
                    log_event("action", who="host", op="track_change", value=new_title)

                t0 = int(_last_seen.get("time") or 0)
                t1 = int(status.get("time") or 0)
                if abs(t1 - t0) >= 3:
                    length_s = int(status.get("length") or 0)
                    at_s = fmt_time(t1)
                    len_s = fmt_time(length_s)
                    log_event("action", who="host", op="seek", at=at_s, length=len_s, value=f"{at_s}/{len_s}")

            _last_seen = status
            payload = json.dumps({"type": "status", "data": status})

        except Exception:
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
            pl = read_playlist()
            if status is not None:
                _update_session_progress(status, pl)
            pl = _apply_progress(pl)
            _last_playlist = pl

            new_dir: str | None = None
            if FILE_BROWSE_AUTO:
                found_current = False
                for it in pl:
                    if not it.get("isCurrent"):
                        continue
                    found_current = True
                    uri = it.get("uri") or ""
                    if uri.startswith("file://"):
                        p = unquote(urlparse(uri).path)
                        d = os.path.dirname(p)
                        if os.path.isdir(d):
                            new_dir = os.path.realpath(d)
                        else:
                            _note_auto_miss("not_a_dir", uri=uri, dir=d)
                    else:
                        _note_auto_miss("not_file_uri", uri=uri)
                    break
                if not found_current and pl:
                    _note_auto_miss("no_current")
            if new_dir != _current_playing_dir_cache:
                _current_playing_dir_cache = new_dir

            pl_json = json.dumps(pl, sort_keys=True)
            if pl_json != _last_playlist_json:
                _last_playlist_json = pl_json
                playlist_payload = json.dumps({"type": "playlist", "data": pl})
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


@app.get("/api/toggle")
def toggle():
    require_token()
    _, cid = require_sid()

    mark_api_action("toggle", cid=cid)
    vlc_cmd("pl_pause")

    op = "toggle"
    try:
        st = read_status_dict()
        state = (st.get("state") or "unknown")
        if state == "playing":
            op = "play"
        elif state == "paused":
            op = "paused"
        else:
            op = state
    except Exception:
        pass

    mark_api_action(op, cid=cid)
    log_event("action", who="web", cid=cid, op=op)
    return "ok"


@app.get("/api/stop")
def stop():
    require_token()
    _, cid = require_sid()
    log_event("action", who="web", cid=cid, op="stop")
    mark_api_action("stop", cid=cid)
    return vlc_cmd("pl_stop")


@app.get("/api/next")
def next_track():
    require_token()
    _, cid = require_sid()
    log_event("action", who="web", cid=cid, op="next")
    mark_api_action("next", cid=cid)
    return vlc_cmd("pl_next")


@app.get("/api/prev")
def prev_track():
    require_token()
    _, cid = require_sid()
    log_event("action", who="web", cid=cid, op="prev")
    mark_api_action("prev", cid=cid)
    return vlc_cmd("pl_previous")


# Accepts seconds (123), relative offset (+30, -10), or percent (50%).
@app.get("/api/seek")
def seek():
    require_token()
    _, cid = require_sid()

    val = request.args.get("val", "").strip()
    if not val:
        abort(400, "Missing val")

    at_s = None
    len_s = None
    pretty_value = val

    try:
        status = read_status_dict()
        length = int(status.get("length") or 0)
        cur = int(status.get("time") or 0)

        if val.endswith("%"):
            pct = int(val[:-1])
            target = int((pct / 100.0) * length) if length > 0 else 0
        elif val.startswith(("+", "-")):
            target = cur + int(val)
        else:
            target = int(val)

        target = max(0, min(length, target))
        at_s = fmt_time(target)
        len_s = fmt_time(length)
        pretty_value = f"{at_s}/{len_s}"
    except Exception:
        pass

    vlc_get("/requests/status.xml", params={"command": "seek", "val": val})

    mark_api_action("seek", cid=cid, value=val)
    log_event("action", who="web", cid=cid, op="seek", at=at_s, length=len_s, value=pretty_value)

    return "ok"


@app.get("/api/status")
def status():
    require_token()
    #return jsonify(read_status_dict()) if request.args.get("sid") else abort(403)
    require_sid()
    return jsonify(read_status_dict())


def _playlist_name_for_id(items: list[dict], pid: str) -> str:
    for it in items:
        if it.get("id") == pid:
            return it.get("name") or ""
    return ""


@app.get("/api/playlist")
def playlist():
    require_token()
    require_sid()
    return jsonify(_apply_progress(read_playlist()))


@app.get("/api/playlist/play")
def playlist_play():
    require_token()
    _, cid = require_sid()

    pid = request.args.get("id", "").strip()
    if not pid:
        abort(400, "Missing id")

    resume_at_raw = request.args.get("resume_at", "").strip()
    resume_at = 0
    if resume_at_raw:
        try:
            resume_at = max(0, int(resume_at_raw))
        except ValueError:
            abort(400, "Invalid resume_at")

    name = ""
    total = 0
    try:
        for it in read_playlist():
            if it.get("id") == pid:
                name = it.get("name") or ""
                total = int(it.get("duration") or 0)
                break
    except Exception:
        pass

    mark_api_action("playlist_resume" if resume_at > 0 else "playlist_skip", cid=cid, value=pid)
    vlc_get("/requests/status.xml", params={"command": "pl_play", "id": pid})
    if resume_at > 0:
        time.sleep(0.25)
        vlc_get("/requests/status.xml", params={"command": "seek", "val": str(resume_at)})
        mark_api_action("playlist_resume", cid=cid, value=f"{pid}@{resume_at}")
        at_s = fmt_time(resume_at)
        len_s = fmt_time(total) if total > 0 else "?"
        log_event("action", who="web", cid=cid, op="playlist_resume",
                  at=at_s, length=len_s, value=f"{(name or pid)} - {at_s} / {len_s}")
    else:
        log_event("action", who="web", cid=cid, op="playlist_skip", value=(name or pid))
    return "ok"


@app.get("/api/playlist/remove")
def playlist_remove():
    require_token()
    _, cid = require_sid()

    pid = request.args.get("id", "").strip()
    if not pid:
        abort(400, "Missing id")

    name = ""
    try:
        name = _playlist_name_for_id(read_playlist(), pid)
    except Exception:
        pass

    vlc_get("/requests/status.xml", params={"command": "pl_delete", "id": pid})
    mark_api_action("playlist_remove", cid=cid, value=pid)
    log_event("action", who="web", cid=cid, op="playlist_remove", value=(name or pid))
    return "ok"


@app.get("/api/playlist/clear")
def playlist_clear():
    require_token()
    _, cid = require_sid()

    vlc_get("/requests/status.xml", params={"command": "pl_empty"})
    mark_api_action("playlist_clear", cid=cid)
    log_event("action", who="web", cid=cid, op="playlist_clear")
    return "ok"


@app.get("/api/playlist/add")
def playlist_add():
    require_token()
    _, cid = require_sid()

    uri = request.args.get("uri", "").strip()
    if not uri:
        abort(400, "Missing uri")

    vlc_get("/requests/status.xml", params={"command": "in_enqueue", "input": uri})
    mark_api_action("playlist_add", cid=cid, value=uri)
    log_event("action", who="web", cid=cid, op="playlist_add", value=uri)
    return "ok"


@app.get("/api/playlist/playnow")
def playlist_playnow():
    require_token()
    _, cid = require_sid()

    uri = request.args.get("uri", "").strip()
    if not uri:
        abort(400, "Missing uri")

    vlc_get("/requests/status.xml", params={"command": "in_play", "input": uri})
    mark_api_action("playlist_playnow", cid=cid, value=uri)
    log_event("action", who="web", cid=cid, op="playlist_playnow", value=uri)
    return "ok"


def _require_file_browse() -> None:
    if not FILE_BROWSE:
        abort(403)


def _current_playing_dir() -> str | None:
    return _current_playing_dir_cache if FILE_BROWSE_AUTO else None


def _now_playing_dir_realpath() -> str | None:
    for it in _last_playlist:
        if not it.get("isCurrent"):
            continue
        uri = it.get("uri") or ""
        if not uri.startswith("file://"):
            return None
        p = unquote(urlparse(uri).path)
        d = os.path.dirname(p)
        return os.path.realpath(d) if os.path.isdir(d) else None
    return None


def _log_file_value(full: str) -> str:
    playing_dir = _now_playing_dir_realpath()
    if playing_dir and os.path.realpath(os.path.dirname(full)) == playing_dir:
        return os.path.basename(full)
    return full


def _resolve_root(rid: str) -> tuple[str, str, bool] | None:
    if rid == "auto":
        d = _current_playing_dir()
        return ("Now playing folder", d, FILE_BROWSE_AUTO_RECURSIVE) if d else None
    if not rid.startswith("r"):
        return None
    try:
        idx = int(rid[1:])
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


def _path_to_uri(p: str) -> str:
    return "file://" + quote(p)


def _list_dir(full: str, rel: str, *, allow_sub: bool = True) -> list[dict]:
    entries: list[dict] = []
    try:
        names = os.listdir(full)
    except OSError:
        return entries

    rel_norm = (rel or "").strip("/").replace("\\", "/").lower()
    base_parts = [s for s in rel_norm.split("/") if s]

    uri_index: dict[str, dict] = {}
    for it in _last_playlist:
        u = it.get("uri") or ""
        if u:
            uri_index[u] = it

    for name in names:
        if name.startswith("."):
            continue
        lo = name.lower()
        p = os.path.join(full, name)
        try:
            if os.path.isdir(p):
                if not allow_sub:
                    continue
                if _is_blacklisted_term(name):
                    continue
                if _is_blacklisted_dir_path(base_parts + [lo]):
                    continue
                entries.append({"name": name, "type": "dir"})
            elif os.path.isfile(p) and _ext_allowed(name):
                if _is_blacklisted_term(name):
                    continue
                entry = {
                    "name": name,
                    "type": "file",
                    "ext": _ext_of(name),
                    "size": os.path.getsize(p),
                }
                uri = _path_to_uri(p)
                it = uri_index.get(uri)
                if it:
                    pid = str(it.get("id") or "")
                    entry["inPlaylist"] = True
                    if pid:
                        entry["playlistId"] = pid
                    if it.get("isCurrent"):
                        entry["isCurrent"] = True
                    if pid and pid in _session_progress:
                        entry["progress"] = dict(_session_progress[pid])
                    if not entry.get("progress") and it.get("duration"):
                        entry["duration"] = int(it.get("duration") or 0)
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

    rid = request.args.get("root", "").strip()
    rel = request.args.get("path", "").strip()

    r = _resolve_root(rid)
    if not r:
        abort(404)
    label, root, recursive = r

    full = _safe_join(root, rel, allow_sub=recursive)
    if full is None or not os.path.isdir(full):
        abort(404)

    return jsonify({
        "root": {"id": rid, "label": label, "recursive": recursive},
        "path": rel.strip("/"),
        "entries": _list_dir(full, rel, allow_sub=recursive),
    })


def _resolve_file_arg() -> tuple[str, str, str]:
    rid = request.args.get("root", "").strip()
    rel = request.args.get("path", "").strip()

    r = _resolve_root(rid)
    if not r:
        abort(404)
    _label, root, recursive = r

    full = _safe_join(root, rel, allow_sub=recursive)
    if full is None or not os.path.isfile(full) or not _ext_allowed(os.path.basename(full)):
        abort(404)

    return rid, rel, full


def _playlist_find_by_uri(uri: str) -> str | None:
    for it in _last_playlist:
        if it.get("uri") == uri:
            pid = it.get("id")
            return str(pid) if pid else None
    return None


@app.get("/api/files/add")
def files_add():
    require_token()
    _, cid = require_sid()
    _require_file_browse()

    _rid, rel, full = _resolve_file_arg()
    uri = _path_to_uri(full)

    existing = _playlist_find_by_uri(uri)
    if existing:
        return jsonify({"status": "already_present", "id": existing})

    vlc_get("/requests/status.xml", params={"command": "in_enqueue", "input": uri})
    mark_api_action("files_add", cid=cid, value=rel)
    log_event("action", who="web", cid=cid, op="files_add", value=_log_file_value(full))
    return jsonify({"status": "added"})


@app.get("/api/files/play")
def files_play():
    require_token()
    _, cid = require_sid()
    _require_file_browse()

    _rid, rel, full = _resolve_file_arg()
    uri = _path_to_uri(full)

    existing = _playlist_find_by_uri(uri)
    if existing:
        vlc_get("/requests/status.xml", params={"command": "pl_play", "id": existing})
        mark_api_action("files_play_existing", cid=cid, value=existing)
        log_event("action", who="web", cid=cid, op="files_play_existing", value=os.path.basename(full))
        return jsonify({"status": "jumped", "id": existing})

    vlc_get("/requests/status.xml", params={"command": "in_play", "input": uri})
    mark_api_action("files_play", cid=cid, value=rel)
    log_event("action", who="web", cid=cid, op="files_play", value=_log_file_value(full))
    return jsonify({"status": "added_and_played"})


@app.get("/api/clients")
def clients():
    require_token()
    cid = request.args.get("cid", "").strip()

    now = _now()
    with _lock:
        occ = _occupied_count_locked(now)
        cooldown = _seconds_until_next_seat_opens_locked(now)
        resp = {
            "clients": occ,
            "max": MAX_CLIENTS,
            "open": occ < MAX_CLIENTS,
            "cooldown": cooldown,
            "grace": int(GRACE_SECONDS),
        }

        if cid:
            ok, reason = _can_admit_locked(cid, now)
            resp["admit_for_cid"] = bool(ok)
            resp["reason"] = reason

    return jsonify(resp)


@sock.route("/ws")
def ws_route(ws):
    if request.args.get("t") != TOKEN or not TOKEN:
        try:
            ws.send(json.dumps({"type": "error", "message": "forbidden"}))
        finally:
            return

    cid = request.args.get("cid", "").strip()
    if not cid:
        try:
            ws.send(json.dumps({"type": "error", "message": "missing cid"}))
        finally:
            return

    now = _now()
    with _lock:
        ok, reason = _can_admit_locked(cid, now)
        occ = _occupied_count_locked(now)
        cooldown = _seconds_until_next_seat_opens_locked(now)

        if not ok:
            try:
                ws.send(json.dumps({
                    "type": "clients",
                    "data": {
                        "clients": occ,
                        "max": MAX_CLIENTS,
                        "open": False,
                        "cooldown": cooldown,
                        "grace": int(GRACE_SECONDS),
                    }
                }))
                ws.send(json.dumps({"type": "error", "message": "server full"}))
                log_event("client_reject", cid=cid, reason="server_full", clients=occ, max=MAX_CLIENTS, cooldown=cooldown)
            finally:
                return

        if cid not in _active:
            _active[cid] = set()
        _active[cid].add(ws)
        _reserved.pop(cid, None)
        log_event("client_join", cid=cid, reason=reason)

    sid = secrets.token_urlsafe(18)
    with _sessions_lock:
        _sessions[sid] = (ws, cid)

    broadcast_clients()

    try:
        ws.send(json.dumps({"type": "auth", "sid": sid}))
        ws.send(json.dumps({
            "type": "clients",
            "data": {
                "clients": client_count_safe(),
                "max": MAX_CLIENTS,
                "open": True,
                "cooldown": 0,
                "grace": int(GRACE_SECONDS),
            }
        }))
        ws.send(json.dumps({"type": "status", "data": read_status_dict()}))
        try:
            ws.send(json.dumps({"type": "playlist", "data": _apply_progress(read_playlist())}))
        except Exception:
            pass
    except Exception:
        pass

    try:
        while True:
            msg = ws.receive()
            if msg is None:
                break
    finally:
        with _lock:
            ws_set = _active.get(cid)
            if ws_set:
                ws_set.discard(ws)
                if len(ws_set) == 0:
                    _active.pop(cid, None)
                    _reserved[cid] = _now() + GRACE_SECONDS
                    log_event("client_leave", cid=cid, reserved_for=int(GRACE_SECONDS))

        with _sessions_lock:
            _sessions.pop(sid, None)

        broadcast_clients()


def client_count_safe() -> int:
    now = _now()
    with _lock:
        return _occupied_count_locked(now)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
