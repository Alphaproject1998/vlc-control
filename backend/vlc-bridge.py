from __future__ import annotations

from flask import Flask, request, abort, send_from_directory, jsonify
from flask_sock import Sock
import os
import time
import json
import threading
import requests
import secrets

VLC_URL = os.environ.get("VLC_URL", "http://127.0.0.1:8080")
VLC_PASS = os.environ.get("VLC_PASS", "")
TOKEN = os.environ.get("TOKEN", "")

MAX_CLIENTS = int(os.environ.get("MAX_CLIENTS", "2"))
GRACE_SECONDS = float(os.environ.get("GRACE_SECONDS", "30"))

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
    uri = current.get("uri") or ""
    if not uri:
        return
    _session_progress[uri] = {
        "watched": int(status.get("time") or 0),
        "duration": int(status.get("length") or 0),
    }


def _apply_progress(items: list[dict]) -> list[dict]:
    for item in items:
        uri = item.get("uri") or ""
        if uri and uri in _session_progress:
            item["progress"] = dict(_session_progress[uri])
    return items


_last_seen: dict | None = None
_last_playlist_json: str | None = None


def broadcaster_loop() -> None:
    global _last_seen, _last_playlist_json

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
