#!/usr/bin/env bash
set -Eeuo pipefail

: <<'DOC'
Installer for vlc-control.

Installs into XDG locations by default:
- data:   ~/.local/share/vlc-control
- config: ~/.config/vlc-control
- bin:    ~/.local/bin/vlc-control

Use --prefix <path> to install everything under a custom directory instead.
Use --log-dir <path> to set where log and pid files are written (default: /tmp).
Use --help or -h for this message.

Also optionally configures VLC HTTP control by updating vlcrc config files found on the machine.
DOC

APP_NAME="vlc-control"

XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

PREFIX="${XDG_DATA_HOME}/vlc-control"
BIN_DIR="${HOME}/.local/bin"
CONFIG_DIR="${XDG_CONFIG_HOME}/vlc-control"
DESKTOP_DIR="${XDG_DATA_HOME}/applications"
DESKTOP_FILE="${DESKTOP_DIR}/vlc-control.desktop"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_VERSION="$(sed -n 's/^VERSION = "\([^"]*\)".*/\1/p' "${REPO_DIR}/backend/vlc-bridge.py" 2>/dev/null | head -n 1)"
[[ -n "$APP_VERSION" ]] || APP_VERSION="unknown"

say() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }

die() {
  err "ERROR: $*"
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

confirm_default_yes() {
  local prompt="${1:-Continue?}"
  read -r -p "${prompt} [Y/n] " ans || true
  ans="${ans:-Y}"
  [[ "$ans" =~ ^[Yy]$ ]]
}

detect_all_pms() {
  have apt-get && echo "apt"
  have dnf     && echo "dnf"
  have yum     && echo "yum"
  have pacman  && echo "pacman"
  have zypper  && echo "zypper"
  have apk     && echo "apk"
  return 0
}

native_pm() {
  [[ -r /etc/os-release ]] || return 1
  local id id_like
  id="$(. /etc/os-release; echo "$ID")"
  id_like="$(. /etc/os-release; echo "${ID_LIKE:-}")"
  case " ${id} ${id_like} " in
    *debian*|*ubuntu*) echo apt ;;
    *fedora*) echo dnf ;;
    *rhel*|*centos*) echo yum ;;
    *arch*) echo pacman ;;
    *suse*) echo zypper ;;
    *alpine*) echo apk ;;
    *) return 1 ;;
  esac
}

detect_pm() {
  local all=()
  while IFS= read -r pm; do all+=("$pm"); done < <(detect_all_pms)
  [[ "${#all[@]}" -gt 0 ]] || { echo ""; return 1; }

  local native; native="$(native_pm || true)"
  if [[ -n "$native" ]]; then
    local pm
    for pm in "${all[@]}"; do
      [[ "$pm" == "$native" ]] && { echo "$pm"; return 0; }
    done
  fi

  echo "${all[0]}"
  return 0
}

pm_install() {
  local pm="$1"; shift
  local pkgs=("$@")
  case "$pm" in
    apt)
      sudo apt-get update -y
      sudo apt-get install -y "${pkgs[@]}"
      ;;
    dnf)    sudo dnf install -y "${pkgs[@]}" ;;
    yum)    sudo yum install -y "${pkgs[@]}" ;;
    pacman) sudo pacman -S --needed --noconfirm "${pkgs[@]}" ;;
    zypper) sudo zypper install -y "${pkgs[@]}" ;;
    apk)    sudo apk add "${pkgs[@]}" ;;
    *) return 1 ;;
  esac
}

pm_install_with_fallback() {
  local pm="$1"; shift
  local pkgs=("$@")

  local all=()
  while IFS= read -r cand; do all+=("$cand"); done < <(detect_all_pms)

  while true; do
    say "[*] Attempting install via ${pm}..."
    pm_install "$pm" "${pkgs[@]}" && return 0

    say "[!] Install via ${pm} failed."
    local others=()
    local cand
    for cand in "${all[@]}"; do
      [[ "$cand" == "$pm" ]] || others+=("$cand")
    done
    [[ "${#others[@]}" -gt 0 ]] || return 1

    say "    Other package managers found on this system: ${others[*]}"
    local choice
    read -r -p "    Try a different one? (name, or blank to give up): " choice || true
    [[ -n "$choice" ]] || return 1

    local valid=0
    for cand in "${others[@]}"; do [[ "$cand" == "$choice" ]] && valid=1; done
    [[ "$valid" -eq 1 ]] || { say "[!] Not one of: ${others[*]}"; return 1; }

    pm="$choice"
  done
}

do_uninstall() {
  say "[*] Uninstalling ${APP_NAME}..."
  rm -f "${BIN_DIR}/vlc-control" || true
  rm -f "${DESKTOP_FILE}" || true
  rm -rf "${PREFIX}" || true
  if [[ -d "${CONFIG_DIR}" ]] && confirm_default_yes "Keep your settings at ${CONFIG_DIR}?"; then
    say "[*] Left your settings in place."
  else
    rm -rf "${CONFIG_DIR}" || true
  fi
  say "[*] Uninstall complete."
}

INSTALL_SNAPSHOT_DIR=""

snapshot_existing() {
  INSTALL_SNAPSHOT_DIR="$(mktemp -d -t vlc-control-install-bak.XXXXXX)"
  local i=0
  for path in "$PREFIX" "$CONFIG_DIR" "$BIN_DIR/vlc-control" "$DESKTOP_FILE"; do
    if [[ -e "$path" ]]; then
      cp -a "$path" "$INSTALL_SNAPSHOT_DIR/slot_${i}"
      printf '%s\n' "$path" > "$INSTALL_SNAPSHOT_DIR/slot_${i}.path"
    fi
    i=$((i+1))
  done
}

restore_snapshot() {
  [[ -n "$INSTALL_SNAPSHOT_DIR" && -d "$INSTALL_SNAPSHOT_DIR" ]] || return 0
  say "[*] Restoring previous install state..."
  rm -rf "$PREFIX" "$CONFIG_DIR" 2>/dev/null || true
  rm -f  "$BIN_DIR/vlc-control" "$DESKTOP_FILE" 2>/dev/null || true
  local i
  for i in 0 1 2 3; do
    local stash="$INSTALL_SNAPSHOT_DIR/slot_${i}"
    local pf="$INSTALL_SNAPSHOT_DIR/slot_${i}.path"
    [[ -e "$stash" && -f "$pf" ]] || continue
    local target; target="$(cat "$pf")"
    mkdir -p "$(dirname "$target")"
    cp -a "$stash" "$target"
  done
  rm -rf "$INSTALL_SNAPSHOT_DIR" || true
  INSTALL_SNAPSHOT_DIR=""
}

discard_snapshot() {
  [[ -n "$INSTALL_SNAPSHOT_DIR" && -d "$INSTALL_SNAPSHOT_DIR" ]] || return 0
  rm -rf "$INSTALL_SNAPSHOT_DIR" || true
  INSTALL_SNAPSHOT_DIR=""
}

abort_and_uninstall() {
  err "[!] $*"
  if [[ -n "$INSTALL_SNAPSHOT_DIR" ]]; then
    err "[!] Aborting and restoring previous state..."
    restore_snapshot
  else
    err "[!] Aborting (nothing to restore)."
  fi
  exit 1
}

CUSTOM_PREFIX=""
LOG_DIR_OVERRIDE=""
cmd="install"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      echo "${APP_NAME} ${APP_VERSION}"
      echo ""
      sed -n "/^: <<'DOC'\$/,/^DOC\$/p" "$0" | sed '1d;$d'
      exit 0
      ;;
    --prefix)
      shift
      CUSTOM_PREFIX="${1:-}"
      [[ -n "$CUSTOM_PREFIX" ]] || die "--prefix requires a path"
      shift
      ;;
    --log-dir)
      shift
      LOG_DIR_OVERRIDE="${1:-}"
      [[ -n "$LOG_DIR_OVERRIDE" ]] || die "--log-dir requires a path"
      shift
      ;;
    install)   cmd="install"; shift ;;
    uninstall) cmd="uninstall"; shift ;;
    *) die "Unknown option: $1. Try: ./install.sh --help" ;;
  esac
done

if [[ -n "$CUSTOM_PREFIX" ]]; then
  mkdir -p "$CUSTOM_PREFIX" || die "Cannot create prefix directory: $CUSTOM_PREFIX"
  CUSTOM_PREFIX="$(cd "$CUSTOM_PREFIX" && pwd)"
  PREFIX="${CUSTOM_PREFIX}/share"
  BIN_DIR="${CUSTOM_PREFIX}/bin"
  CONFIG_DIR="${CUSTOM_PREFIX}/config"
  DESKTOP_DIR="${CUSTOM_PREFIX}/applications"
  DESKTOP_FILE="${DESKTOP_DIR}/vlc-control.desktop"
  say "[*] Custom prefix: ${CUSTOM_PREFIX}"
fi

if [[ "$cmd" == "uninstall" ]]; then
  do_uninstall
  exit 0
fi

SRC_BACKEND="${REPO_DIR}/backend"
SRC_STATIC="${REPO_DIR}/static"
SRC_SCRIPTS="${REPO_DIR}/scripts"
SRC_CONFIG="${REPO_DIR}/config"

SRC_VLC_BRIDGE="${SRC_BACKEND}/vlc-bridge.py"
SRC_CLI="${SRC_SCRIPTS}/vlc-control"
SRC_REQUIREMENTS="${REPO_DIR}/requirements.txt"

SRC_TOML_TEMPLATE="${SRC_CONFIG}/config.toml.template"

DST_TOML="${CONFIG_DIR}/config.toml"
INSTALL_STATE="${PREFIX}/install-state.json"

[[ -d "$SRC_BACKEND" ]] || die "Missing directory: ${SRC_BACKEND}"
[[ -d "$SRC_STATIC"  ]] || die "Missing directory: ${SRC_STATIC}"
[[ -d "$SRC_SCRIPTS" ]] || die "Missing directory: ${SRC_SCRIPTS}"
[[ -d "$SRC_CONFIG"  ]] || die "Missing directory: ${SRC_CONFIG}"

[[ -f "$SRC_VLC_BRIDGE" ]]     || die "Missing: ${SRC_VLC_BRIDGE}"
[[ -f "$SRC_CLI" ]]            || die "Missing: ${SRC_CLI}"
[[ -f "$SRC_REQUIREMENTS" ]]   || die "Missing: ${SRC_REQUIREMENTS}"
[[ -f "$SRC_TOML_TEMPLATE" ]]  || die "Missing: ${SRC_TOML_TEMPLATE}"

validate_toml_config() {
  local file="$1"
  [[ -f "$file" ]] || return 0

  python3 - "$file" <<'PY'
import sys, os, pathlib

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        sys.exit(0)

path = pathlib.Path(sys.argv[1])
try:
    with open(path, "rb") as f:
        cfg = tomllib.load(f)
except Exception:
    sys.exit(0)

warnings = []

def warn(section, key, msg):
    warnings.append(f"{section}.{key}: {msg}")

def is_bool(v): return isinstance(v, bool)
def is_int(v): return isinstance(v, int) and not isinstance(v, bool)

BOOL_SECTIONS = ("features", "layout", "buttons")

SCHEMA = {
    ("system", "port"): ("int_range", 1, 65535),
    ("system", "max_clients"): ("int_min", 1),
    ("system", "grace_seconds"): ("int_min", 0),
    ("system", "vlc_host"): ("nonempty_str",),
    ("system", "vlc_port"): ("int_range", 1, 65535),
    ("system", "vlc_pass"): ("nonempty_str",),
    ("system", "vlc_mode"): ("enum", ["auto", "native", "flatpak", "none"]),
    ("system", "start_vlc"): ("bool",),
    ("system", "kill_vlc_on_exit"): ("bool",),
    ("system", "cloudflare"): ("enum", ["auto", "on", "off"]),
    ("system", "log_dir"): ("writable_dir",),
    ("system", "log_when_idle"): ("bool",),
    ("system", "http_access_log"): ("bool",),
    ("system", "client_id_style"): ("enum", ["numeric", "cid", "short_cid", "ip"]),
    ("system", "nickname_max_length"): ("int_min", 1),
    ("system", "action_debounce_ms"): ("int_min", 0),
    ("file_browse", "enabled"): ("bool",),
    ("file_browse", "auto"): ("bool",),
    ("file_browse", "auto_recursive"): ("bool",),
    ("file_browse", "log_root_relative"): ("bool",),
    ("file_browse", "dirs"): ("dir_list",),
    ("status", "show"): ("enum_list", ["version", "installed", "updated", "stale", "paths", "seats", "runtime", "token", "steps", "ready", "logkey"]),
    ("config", "seek_jump_by"): ("int_min", 0),
    ("config", "clock_show_remaining"): ("bool",),
    ("config", "resume_min_percent"): ("int_range", 0, 100),
    ("config", "resume_min_seconds"): ("int_min", 0),
    ("config", "resume_max_percent"): ("int_range", 0, 100),
    ("config", "resume_tail_seconds"): ("int_min", 0),
    ("config", "file_browser_as_grid"): ("bool",),
}

def check(section, key, kind, v):
    if kind == "bool":
        if not is_bool(v): warn(section, key, f"expected true/false, got {v!r}")
    elif kind == "int_min":
        lo = SCHEMA[(section, key)][1]
        if not is_int(v) or v < lo: warn(section, key, f"expected an integer >= {lo}, got {v!r}")
    elif kind == "int_range":
        lo, hi = SCHEMA[(section, key)][1], SCHEMA[(section, key)][2]
        if not is_int(v) or not (lo <= v <= hi): warn(section, key, f"expected an integer between {lo} and {hi}, got {v!r}")
    elif kind == "enum":
        allowed = SCHEMA[(section, key)][1]
        if v not in allowed: warn(section, key, f"expected one of {allowed}, got {v!r}")
    elif kind == "nonempty_str":
        if not isinstance(v, str) or not v.strip(): warn(section, key, "this is blank - the app will not work correctly without it")
    elif kind == "writable_dir":
        if not isinstance(v, str) or not v.strip():
            warn(section, key, "blank log directory")
            return
        d = os.path.expanduser(v)
        try:
            os.makedirs(d, exist_ok=True)
            if not os.access(d, os.W_OK):
                warn(section, key, f"not writable: {d}")
        except Exception as exc:
            warn(section, key, f"cannot create/access {d}: {exc}")
    elif kind == "enum_list":
        allowed = SCHEMA[(section, key)][1]
        if not isinstance(v, list):
            warn(section, key, f"expected a list, got {v!r}")
            return
        for entry in v:
            if entry not in allowed:
                warn(section, key, f"unknown item {entry!r} - expected one of {allowed}")
    elif kind == "dir_list":
        if not isinstance(v, list):
            warn(section, key, f"expected a list of paths, got {v!r}")
            return
        for entry in v:
            base = str(entry)[:-2] if str(entry).endswith("/*") else str(entry)
            if not os.path.isdir(os.path.expanduser(base)):
                warn(section, key, f"directory does not exist: {base}")

for section, vals in cfg.items():
    if not isinstance(vals, dict):
        continue
    for key, v in vals.items():
        if section in BOOL_SECTIONS:
            check(section, key, "bool", v)
        elif (section, key) in SCHEMA:
            check(section, key, SCHEMA[(section, key)][0], v)

if cfg.get("config", {}).get("resume_min_percent", 0) >= cfg.get("config", {}).get("resume_max_percent", 100):
    warnings.append("config: resume_min_percent should be lower than resume_max_percent")

for w in warnings:
    print(w)
PY
}

check_existing_toml() {
  [[ -f "$DST_TOML" ]] || return 0
  have python3 || return 0

  local valid
  valid="$(python3 - "$DST_TOML" <<'PY'
import sys, re, pathlib

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        print("valid"); sys.exit(0)

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")

HEADER_RE = re.compile(r'^\[([^\[\].\s]+)\]\s*$')

def dedupe_duplicate_tables(text):
    seen = set()
    kept = []
    dup_section = None
    for line in text.split("\n"):
        m = HEADER_RE.match(line.strip())
        if m:
            name = m.group(1)
            if name in seen:
                dup_section = name
                continue
            seen.add(name)
            dup_section = None
        if dup_section is None:
            kept.append(line)
    return "\n".join(kept)

try:
    tomllib.loads(text)
    print("valid")
except Exception:
    try:
        tomllib.loads(dedupe_duplicate_tables(text))
        print("valid")
    except Exception:
        print("invalid")
PY
)"
  local warnings=""
  if [[ "$valid" == "valid" ]]; then
    warnings="$(validate_toml_config "$DST_TOML")"
  fi

  if [[ "$valid" != "invalid" && -z "$warnings" ]]; then
    return 0
  fi

  if [[ "$valid" == "invalid" ]]; then
    say "[!] Existing config at ${DST_TOML} is not valid TOML."
  else
    say "[!] Config values that look wrong in ${DST_TOML}:"
    while IFS= read -r line; do
      say "    - ${line}"
    done <<< "$warnings"
  fi

  if confirm_default_yes "Reset config to defaults?"; then
    mkdir -p "$(dirname "$DST_TOML")"
    cp -f "$SRC_TOML_TEMPLATE" "$DST_TOML"
    say "[*] Reset ${DST_TOML} to defaults."
  else
    confirm_default_yes "Continue install anyway?" || die "Aborted: existing config has problems."
  fi
}

check_existing_toml

snapshot_existing
trap 'restore_snapshot' ERR

required_dep() {
  local label="$1"; shift
  local bin="$1"; shift
  local pkgs=("$@")

  if have "$bin"; then
    say "[*] Found required: ${label} (${bin})"
    return 0
  fi

  say "[!] Missing required: ${label} (${bin})"
  local pm; pm="$(detect_pm || true)"
  [[ -n "$pm" ]] || abort_and_uninstall "No supported package manager detected to install: ${label}"

  if ! pm_install_with_fallback "$pm" "${pkgs[@]}"; then
    abort_and_uninstall "Failed to install required dependency: ${label}"
  fi

  have "$bin" || abort_and_uninstall "Still missing required dependency after install: ${label}"
  say "[*] Installed: ${label}"
}

optional_dep() {
  local label="$1"; shift
  local bin="$1"; shift
  local impact="$1"; shift
  local pkgs=("$@")

  if have "$bin"; then
    say "[*] Found optional: ${label} (${bin})"
    return 0
  fi

  say "[!] Missing optional: ${label} (${bin})"
  say "    Impact: ${impact}"

  local pm; pm="$(detect_pm || true)"
  if [[ -z "$pm" ]]; then
    confirm_default_yes "Continue without ${label}?" || abort_and_uninstall "User aborted."
    return 1
  fi

  if confirm_default_yes "Attempt to install ${label} via ${pm}?"; then
    pm_install_with_fallback "$pm" "${pkgs[@]}" || true
  fi

  if have "$bin"; then
    say "[*] Installed optional: ${label}"
    return 0
  fi

  confirm_default_yes "Continue without ${label}?" || abort_and_uninstall "User aborted."
  return 1
}

# Debian splits venv into its own package, so a working python3 isn't enough.
ensure_venv_works() {
  local tmp
  tmp="$(mktemp -d)"
  if python3 -m venv "${tmp}/t" >/dev/null 2>&1; then
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$tmp"

  local pm; pm="$(detect_pm || true)"
  [[ -n "$pm" ]] || return 1

  case "$pm" in
    apt) pm_install "$pm" python3-venv ;;
    dnf|yum|pacman|zypper|apk) : ;;
  esac

  tmp="$(mktemp -d)"
  python3 -m venv "${tmp}/t" >/dev/null 2>&1 || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  return 0
}

required_dep "Python 3" "python3" python3
required_dep "curl" "curl" curl

if ! ensure_venv_works; then
  abort_and_uninstall "python3 -m venv is not working on this system."
fi

optional_dep "cloudflared" "cloudflared" "Public tunnel URL sharing will NOT work." cloudflared || true

detect_clipboard() {
  if have wl-copy; then echo "wl-copy"; return 0; fi
  if have xclip; then echo "xclip"; return 0; fi
  if have xsel; then echo "xsel"; return 0; fi
  if have pbcopy; then echo "pbcopy"; return 0; fi
  echo ""
  return 1
}

ensure_any_clipboard() {
  local tool
  tool="$(detect_clipboard || true)"
  if [[ -n "$tool" ]]; then
    say "[*] Found clipboard tool: ${tool} (won't try others)"
    return 0
  fi

  say "[!] No clipboard tool found (auto-copy may not work)."

  local pm; pm="$(detect_pm || true)"
  if [[ -z "$pm" ]]; then
    confirm_default_yes "Continue without clipboard auto-copy?" || abort_and_uninstall "User aborted."
    return 1
  fi

  local want_pkg="xclip"
  if [[ -n "${WAYLAND_DISPLAY:-}" || "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
    want_pkg="wl-clipboard"
  fi

  if confirm_default_yes "Attempt to install ${want_pkg} via ${pm}?"; then
    pm_install_with_fallback "$pm" "${want_pkg}" || true
  fi

  tool="$(detect_clipboard || true)"
  if [[ -n "$tool" ]]; then
    say "[*] Installed clipboard tool: ${tool}"
    return 0
  fi

  confirm_default_yes "Continue without clipboard auto-copy?" || abort_and_uninstall "User aborted."
  return 1
}

ensure_any_clipboard || true

say "[*] Installing files to:"
say "    ${PREFIX}"
say "    ${CONFIG_DIR}"
say "    ${BIN_DIR}"

mkdir -p "${PREFIX}" "${CONFIG_DIR}" "${BIN_DIR}" "${DESKTOP_DIR}"

cp -f "${REPO_DIR}/backend/vlc-bridge.py" "${PREFIX}/vlc-bridge.py"
cp -f "${REPO_DIR}/scripts/vlc-control"   "${PREFIX}/vlc-control"
chmod +x "${PREFIX}/vlc-control" || true

rm -rf "${PREFIX}/static"
mkdir -p "${PREFIX}/static"
cp -a "${REPO_DIR}/static/." "${PREFIX}/static/"

write_install_state() {
  local commit="" dirty="false" commit_date=""

  if have git && git -C "${REPO_DIR}" rev-parse --git-dir >/dev/null 2>&1; then
    commit="$(git -C "${REPO_DIR}" rev-parse --short HEAD 2>/dev/null || true)"
    commit_date="$(git -C "${REPO_DIR}" log -1 --format=%cI 2>/dev/null || true)"
    [[ -n "$(git -C "${REPO_DIR}" status --porcelain 2>/dev/null)" ]] && dirty="true"
  fi

  python3 - "${INSTALL_STATE}" "${REPO_DIR}" "${APP_VERSION}" "${commit}" "${dirty}" "${commit_date}" <<'PY'
import json, sys, time, pathlib
from datetime import datetime

state_path = pathlib.Path(sys.argv[1])
repo = pathlib.Path(sys.argv[2])
version, commit, dirty, commit_date = sys.argv[3], sys.argv[4], sys.argv[5] == "true", sys.argv[6]

def iso(ts):
    return datetime.fromtimestamp(ts).astimezone().replace(microsecond=0).isoformat()

def newest_source_mtime():
    newest = 0.0
    for name in ("backend", "static", "scripts", "config"):
        directory = repo / name
        if not directory.is_dir():
            continue
        for path in directory.rglob("*"):
            if path.is_file():
                newest = max(newest, path.stat().st_mtime)
    for name in ("install.sh", "requirements.txt"):
        path = repo / name
        if path.is_file():
            newest = max(newest, path.stat().st_mtime)
    return newest

if commit_date and commit and not dirty:
    source_updated = commit_date
else:
    newest = newest_source_mtime()
    source_updated = iso(newest) if newest else ""

previous = {}
if state_path.is_file():
    try:
        previous = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = {}

state = {
    "version": version,
    "installed_at": iso(time.time()),
    "source_updated_at": source_updated,
    "commit": commit,
    "dirty": dirty,
    "source_dir": str(repo),
    "previous_version": previous.get("version", ""),
    "previous_installed_at": previous.get("installed_at", ""),
}
state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
PY
}

write_install_state || say "[!] Could not write ${INSTALL_STATE} - version info will be unavailable."

mkdir -p "${CONFIG_DIR}"

regenerate_toml_config() {
  local src="$1"
  local dst="$2"
  [[ -f "$src" && -f "$dst" ]] || { echo "0"; return 0; }

  python3 - "$src" "$dst" <<'PY'
import re, sys, pathlib

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        print(0); sys.exit(0)

src = pathlib.Path(sys.argv[1])
dst = pathlib.Path(sys.argv[2])

HEADER_RE = re.compile(r'^\[([^\[\].\s]+)\]\s*$')
KEY_RE = re.compile(r'^([A-Za-z0-9_]+)\s*=\s*')

def dedupe_duplicate_tables(text):
    lines = text.split("\n")
    seen = set()
    kept = []
    orphan = {}
    dup_section = None
    for line in lines:
        m = HEADER_RE.match(line.strip())
        if m:
            name = m.group(1)
            if name in seen:
                dup_section = name
                continue
            seen.add(name)
            dup_section = None
            kept.append(line)
            continue
        if dup_section is not None:
            orphan.setdefault(dup_section, []).append(line)
        else:
            kept.append(line)
    if not orphan:
        return text
    result = []
    current_section = None
    for line in kept:
        m = HEADER_RE.match(line.strip())
        if m:
            current_section = m.group(1)
        result.append(line)
        if current_section in orphan:
            result.extend(orphan.pop(current_section))
    return "\n".join(result)

try:
    src_text = src.read_text(encoding="utf-8")
except Exception:
    print(0); sys.exit(0)

dst_text = dst.read_text(encoding="utf-8")
try:
    existing = tomllib.loads(dst_text)
except Exception:
    try:
        existing = tomllib.loads(dedupe_duplicate_tables(dst_text))
    except Exception:
        existing = {}

def toml_val(v):
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, int): return str(v)
    if isinstance(v, float): return str(v)
    if isinstance(v, str): return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    if isinstance(v, list):
        return "[" + ", ".join(toml_val(i) for i in v) + "]"
    return str(v)

def split_value_and_comment(rest):
    in_str = False
    str_char = ""
    depth = 0
    i = 0
    while i < len(rest):
        c = rest[i]
        if in_str:
            if c == "\\" and i + 1 < len(rest):
                i += 2
                continue
            if c == str_char:
                in_str = False
        elif c in ('"', "'"):
            in_str = True
            str_char = c
        elif c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
        elif c == "#" and depth == 0:
            return rest[:i], rest[i:]
        i += 1
    return rest, ""

carried_over = 0
current_section = None
out_lines = []
for line in src_text.split("\n"):
    stripped = line.strip()
    header_m = HEADER_RE.match(stripped)
    if header_m:
        current_section = header_m.group(1)
        out_lines.append(line)
        continue

    key_m = KEY_RE.match(stripped) if current_section else None
    if key_m:
        key = key_m.group(1)
        section_vals = existing.get(current_section, {})
        if isinstance(section_vals, dict) and key in section_vals:
            new_val = section_vals[key]
            rest = stripped[key_m.end():]
            _, comment = split_value_and_comment(rest)
            rendered = toml_val(new_val)
            if rendered != rest[:len(rest) - len(comment)].rstrip():
                carried_over += 1
            new_line = f"{key} = {rendered}"
            if comment:
                new_line += f"  {comment}"
            out_lines.append(new_line)
            continue

    out_lines.append(line)

dst.write_text("\n".join(out_lines), encoding="utf-8")
print(carried_over)
PY
}

if [[ ! -f "${DST_TOML}" ]]; then
  cp -f "${SRC_TOML_TEMPLATE}" "${DST_TOML}"
  say "[*] Created ${DST_TOML}"
else
  say "[*] Rebuilding ${DST_TOML} from the latest template, keeping your existing values..."
  TOML_CARRIED="$(regenerate_toml_config "${SRC_TOML_TEMPLATE}" "${DST_TOML}")"
  if [[ -n "${TOML_CARRIED}" && "${TOML_CARRIED}" -gt 0 ]]; then
    say "[*] Carried over ${TOML_CARRIED} of your existing setting(s)"
  fi
fi

VLC_CFG_CANDIDATES=(
  "${HOME}/.config/vlc/vlcrc"
  "${HOME}/.var/app/org.videolan.VLC/config/vlc/vlcrc"
)

generate_pass() {
  tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 24 || true
}

vlc_cfg_label() {
  case "$1" in
    *"/.var/app/org.videolan.VLC/"*) echo "flatpak" ;;
    *) echo "native" ;;
  esac
}

read_vlc_pass_from_cfg() {
  local cfg="$1"
  [[ -f "$cfg" ]] || return 1
  local val
  val="$(grep -E '^[[:space:]]*http-password=' "$cfg" | tail -n 1 | cut -d= -f2- || true)"
  [[ -n "${val:-}" ]] || return 1
  printf '%s' "$val"
  return 0
}

set_toml_kv() {
  local file="$1"
  local section="$2"
  local key="$3"
  local value="$4"

  python3 - "$file" "$section" "$key" "$value" <<'PY'
import sys, re, pathlib

path    = pathlib.Path(sys.argv[1])
section = sys.argv[2]
key     = sys.argv[3]
value   = sys.argv[4]

toml_val = '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
new_line = f"{key} = {toml_val}"

text = path.read_text(encoding="utf-8") if path.exists() else ""
lines = text.splitlines()

sec_re = re.compile(r"^\s*\[" + re.escape(section) + r"\]\s*$")
next_re = re.compile(r"^\s*\[")
key_re = re.compile(r"^\s*" + re.escape(key) + r"\s*=")

in_sec = False
replaced = False
out = []

for line in lines:
    if sec_re.match(line):
        in_sec = True
    elif in_sec and next_re.match(line):
        if not replaced:
            out.append(new_line)
            replaced = True
        in_sec = False
    if in_sec and key_re.match(line):
        out.append(new_line)
        replaced = True
        continue
    out.append(line)

if not replaced:
    if not out or out[-1].strip():
        out.append("")
    out.append(f"[{section}]")
    out.append(new_line)

path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
}

read_toml_kv() {
  local file="$1"
  local section="$2"
  local key="$3"

  [[ -f "$file" ]] || return 0

  python3 - "$file" "$section" "$key" <<'PY'
import sys, pathlib

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        sys.exit(0)

path, section, key = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path, "rb") as f:
        data = tomllib.load(f)
except Exception:
    sys.exit(0)

val = data.get(section, {}).get(key)
if val:
    print(val)
PY
}

EXISTING_VLC_PASS="$(read_toml_kv "${DST_TOML}" "system" "vlc_pass")"

if [[ -n "${EXISTING_VLC_PASS}" ]]; then
  say "[*] Keeping existing VLC HTTP password already in ${DST_TOML}"
  VLC_PASS_VALUE="${EXISTING_VLC_PASS}"
else
  VLC_PASS_VALUE=""

  if confirm_default_yes "Check VLC config for existing HTTP password?"; then
    for cfg in "${VLC_CFG_CANDIDATES[@]}"; do
      if VLC_PASS_VALUE="$(read_vlc_pass_from_cfg "$cfg")"; then
        say "[*] Found an HTTP password in the $(vlc_cfg_label "$cfg") VLC config: $cfg"
        break
      fi
    done
    if [[ -z "${VLC_PASS_VALUE}" ]]; then
      say "[*] No VLC HTTP password found."
    fi
  fi

  if [[ -z "${VLC_PASS_VALUE}" ]]; then
    read -r -p "Enter VLC HTTP password (leave blank to generate): " VLC_PASS_VALUE || true
  fi

  if [[ -z "${VLC_PASS_VALUE}" ]]; then
    VLC_PASS_VALUE="$(generate_pass)"
    say "[*] Generated VLC HTTP password."
  fi

  set_toml_kv "${DST_TOML}" "system" "vlc_pass" "${VLC_PASS_VALUE}"
fi

if [[ -n "${LOG_DIR_OVERRIDE}" ]]; then
  set_toml_kv "${DST_TOML}" "system" "log_dir" "${LOG_DIR_OVERRIDE}"
fi

VALIDATION_WARNINGS="$(validate_toml_config "${DST_TOML}")"
if [[ -n "${VALIDATION_WARNINGS}" ]]; then
  say "[!] Config values that look wrong in ${DST_TOML} (install will continue):"
  while IFS= read -r line; do
    say "    - ${line}"
  done <<< "${VALIDATION_WARNINGS}"
fi

vlc_write_cfg_kv() {
  local cfg="$1"
  local key="$2"
  local value="$3"

  mkdir -p "$(dirname "$cfg")"
  touch "$cfg"

  if grep -qE "^[[:space:]]*#?[[:space:]]*${key}=" "$cfg"; then
    python3 - "$cfg" "$key" "$value" <<'PY'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
key  = sys.argv[2]
val  = sys.argv[3]
lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
pat = re.compile(rf'^\s*#?\s*{re.escape(key)}=')
out = []
replaced = False
for line in lines:
    if pat.match(line):
        out.append(f"{key}={val}")
        replaced = True
    else:
        out.append(line)
if not replaced:
    if out and out[-1].strip() != "":
        out.append("")
    out.append(f"{key}={val}")
path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$cfg"
  fi
}

vlc_try_configure_http() {
  local cfg="$1"
  vlc_write_cfg_kv "$cfg" "extraintf" "http"
  vlc_write_cfg_kv "$cfg" "http-host" "127.0.0.1"
  vlc_write_cfg_kv "$cfg" "http-port" "8080"
  vlc_write_cfg_kv "$cfg" "http-password" "$VLC_PASS_VALUE"
}

VLC_CFG_TARGETS=()
for cfg in "${VLC_CFG_CANDIDATES[@]}"; do
  if [[ -f "$cfg" ]]; then
    VLC_CFG_TARGETS+=("$cfg")
  fi
done

if [[ ${#VLC_CFG_TARGETS[@]} -eq 0 ]]; then
  if have flatpak && flatpak info org.videolan.VLC >/dev/null 2>&1; then
    VLC_CFG_TARGETS=("${HOME}/.var/app/org.videolan.VLC/config/vlc/vlcrc")
  else
    VLC_CFG_TARGETS=("${HOME}/.config/vlc/vlcrc")
  fi
fi

vlc_http_already_configured() {
  local cfg="$1"
  [[ -f "$cfg" ]] || return 1
  grep -qE '^[[:space:]]*extraintf=.*\bhttp\b' "$cfg" || return 1
  local pass
  pass="$(read_vlc_pass_from_cfg "$cfg")" || return 1
  [[ "$pass" == "$VLC_PASS_VALUE" ]]
}

VLC_CFG_PENDING=()
VLC_CFG_PENDING_LABELS=""
for cfg in "${VLC_CFG_TARGETS[@]}"; do
  if vlc_http_already_configured "$cfg"; then
    say "[*] HTTP control already enabled with the current password in the $(vlc_cfg_label "$cfg") VLC config: ${cfg}"
  else
    VLC_CFG_PENDING+=("$cfg")
    VLC_CFG_PENDING_LABELS+="${VLC_CFG_PENDING_LABELS:+ and }$(vlc_cfg_label "$cfg")"
  fi
done

if [[ ${#VLC_CFG_PENDING[@]} -eq 0 ]]; then
  :
elif confirm_default_yes "Configure your ${VLC_CFG_PENDING_LABELS} VLC to enable HTTP control on startup with this password (so vlc-control can latch on later)?"; then
  for cfg in "${VLC_CFG_PENDING[@]}"; do
    label="$(vlc_cfg_label "$cfg")"
    if [[ -w "$(dirname "$cfg")" ]] || [[ -w "$cfg" ]] || [[ ! -e "$cfg" ]]; then
      if vlc_try_configure_http "$cfg"; then
        say "[*] Updated the ${label} VLC config: ${cfg}"
        say "    Restart ${label} VLC for changes to take effect."
      else
        say "[!] Tried to update the ${label} VLC config but it failed: ${cfg}"
        say "    You may need to set up VLC HTTP manually or launch VLC via vlc-control."
      fi
    else
      say "[!] The ${label} VLC config path is not writable: ${cfg}"
      say "    You may need to set up VLC HTTP manually or launch VLC via vlc-control."
    fi
  done
else
  say "[*] OK. VLC must be manually set up for HTTP control, or launched via vlc-control."
fi

DST_VENV="${PREFIX}/.venv"
if [[ ! -d "${DST_VENV}" ]]; then
  say "[*] Creating venv: ${DST_VENV}"
  python3 -m venv "${DST_VENV}"
else
  say "[*] Keeping existing venv: ${DST_VENV}"
fi

say "[*] Installing Python deps into venv (requirements.txt)"
"${DST_VENV}/bin/python" -m pip install --upgrade pip >/dev/null 2>&1 || true
"${DST_VENV}/bin/python" -m pip install -r "${REPO_DIR}/requirements.txt"

if [[ -n "$CUSTOM_PREFIX" ]]; then
  cat > "${BIN_DIR}/vlc-control" <<WRAPPER
#!/usr/bin/env bash
export VLC_CONTROL_PREFIX="${PREFIX}"
export VLC_CONTROL_CONFIG_DIR="${CONFIG_DIR}"
exec "${PREFIX}/vlc-control" "\$@"
WRAPPER
  chmod +x "${BIN_DIR}/vlc-control"
else
  ln -sf "${PREFIX}/vlc-control" "${BIN_DIR}/vlc-control"
fi

cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Type=Application
Name=VLC Control
Comment=VLC bridge + share link
Exec=/usr/bin/env bash -lc "${BIN_DIR}/vlc-control"
Icon=org.videolan.VLC
Terminal=true
Categories=AudioVideo;Player;
EOF

say ""
say "Done!"
if [[ -n "$CUSTOM_PREFIX" ]]; then
  say "- Run:        ${BIN_DIR}/vlc-control"
else
  say "- Run:        vlc-control"
fi
say "- Config:     ${DST_TOML}"
say "- Frontend:   ${PREFIX}/static/"
say "- Uninstall:  ./install.sh uninstall"

discard_snapshot
