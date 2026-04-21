#!/usr/bin/env bash
set -euo pipefail

: <<'DOC'
Installer for vlc-control.

Installs into XDG locations by default:
- data:   ~/.local/share/vlc-control
- config: ~/.config/vlc-control
- bin:    ~/.local/bin/vlc-control

Use --prefix <path> to install everything under a custom directory instead.
Use --log-dir <path> to set where log and pid files are written (default: /tmp).

Also optionally configures VLC HTTP control by updating vlcrc.
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

detect_pm() {
  if have apt-get; then echo "apt"; return 0; fi
  if have dnf; then echo "dnf"; return 0; fi
  if have yum; then echo "yum"; return 0; fi
  if have pacman; then echo "pacman"; return 0; fi
  if have zypper; then echo "zypper"; return 0; fi
  if have apk; then echo "apk"; return 0; fi
  echo ""
  return 1
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
    pacman) sudo pacman -Sy --noconfirm "${pkgs[@]}" ;;
    zypper) sudo zypper install -y "${pkgs[@]}" ;;
    apk)    sudo apk add "${pkgs[@]}" ;;
    *) return 1 ;;
  esac
}

do_uninstall() {
  say "[*] Uninstalling ${APP_NAME}..."
  rm -f "${BIN_DIR}/vlc-control" || true
  rm -f "${DESKTOP_FILE}" || true
  rm -rf "${PREFIX}" || true
  rm -rf "${CONFIG_DIR}" || true
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
      sed -n '1,/^DOC$/p' "$0" | sed '1d;$d'
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

SRC_ENV_TEMPLATE="${SRC_CONFIG}/config.env.template"
SRC_FRONTEND_TEMPLATE="${SRC_CONFIG}/frontend.json.template"

DST_ENV="${CONFIG_DIR}/config.env"
DST_FRONTEND="${CONFIG_DIR}/frontend.json"

[[ -d "$SRC_BACKEND" ]] || die "Missing directory: ${SRC_BACKEND}"
[[ -d "$SRC_STATIC"  ]] || die "Missing directory: ${SRC_STATIC}"
[[ -d "$SRC_SCRIPTS" ]] || die "Missing directory: ${SRC_SCRIPTS}"
[[ -d "$SRC_CONFIG"  ]] || die "Missing directory: ${SRC_CONFIG}"

[[ -f "$SRC_VLC_BRIDGE" ]]        || die "Missing: ${SRC_VLC_BRIDGE}"
[[ -f "$SRC_CLI" ]]               || die "Missing: ${SRC_CLI}"
[[ -f "$SRC_REQUIREMENTS" ]]      || die "Missing: ${SRC_REQUIREMENTS}"
[[ -f "$SRC_ENV_TEMPLATE" ]]      || die "Missing: ${SRC_ENV_TEMPLATE}"
[[ -f "$SRC_FRONTEND_TEMPLATE" ]] || die "Missing: ${SRC_FRONTEND_TEMPLATE}"

snapshot_existing

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

  say "[*] Attempting to install required dependency via ${pm}..."
  if ! pm_install "$pm" "${pkgs[@]}"; then
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
    pm_install "$pm" "${pkgs[@]}" || true
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
    pm_install "$pm" "${want_pkg}" || true
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

mkdir -p "${CONFIG_DIR}"

merge_env_defaults() {
  local src="$1"
  local dst="$2"
  [[ -f "$src" && -f "$dst" ]] || { echo 0; return 0; }

  python3 - "$src" "$dst" <<'PY'
import sys, re, pathlib

src = pathlib.Path(sys.argv[1])
dst = pathlib.Path(sys.argv[2])

key_pat = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=")

dst_text = dst.read_text(encoding="utf-8")
dst_keys = set()
for line in dst_text.splitlines():
    m = key_pat.match(line)
    if m:
        dst_keys.add(m.group(1))

added = []
pending = []
for line in src.read_text(encoding="utf-8").splitlines():
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        pending.append(line)
        continue
    m = key_pat.match(line)
    if not m:
        pending = []
        continue
    key = m.group(1)
    if key in dst_keys:
        pending = []
        continue
    added.extend(pending)
    added.append(line)
    pending = []

count = sum(1 for l in added if key_pat.match(l))
if count:
    if not dst_text.endswith("\n"):
        dst_text += "\n"
    if not dst_text.endswith("\n\n"):
        dst_text += "\n"
    dst_text += "\n".join(added) + "\n"
    dst.write_text(dst_text, encoding="utf-8")

print(count)
PY
}

if [[ ! -f "${DST_ENV}" ]]; then
  cp -f "${REPO_DIR}/config/config.env.template" "${DST_ENV}"
  say "[*] Created ${DST_ENV}"
else
  say "[*] Keeping existing ${DST_ENV}"
  ENV_ADDED="$(merge_env_defaults "${REPO_DIR}/config/config.env.template" "${DST_ENV}")"
  if [[ -n "${ENV_ADDED}" && "${ENV_ADDED}" -gt 0 ]]; then
    say "[*] Added ${ENV_ADDED} new key(s) from template to ${DST_ENV}"
  fi
fi

merge_json_defaults() {
  local src="$1"
  local dst="$2"
  [[ -f "$src" && -f "$dst" ]] || { echo 0; return 0; }

  python3 - "$src" "$dst" <<'PY'
import sys, json, pathlib

src = pathlib.Path(sys.argv[1])
dst = pathlib.Path(sys.argv[2])

try:
    src_obj = json.loads(src.read_text(encoding="utf-8"))
    dst_obj = json.loads(dst.read_text(encoding="utf-8"))
except Exception:
    print(0)
    sys.exit(0)

def merge(s, d):
    if not isinstance(s, dict) or not isinstance(d, dict):
        return 0
    n = 0
    for k, v in s.items():
        if k not in d:
            d[k] = v
            n += 1
        elif isinstance(v, dict) and isinstance(d[k], dict):
            n += merge(v, d[k])
    return n

added = merge(src_obj, dst_obj)
if added:
    dst.write_text(json.dumps(dst_obj, indent=2) + "\n", encoding="utf-8")

print(added)
PY
}

if [[ ! -f "${DST_FRONTEND}" ]]; then
  cp -f "${REPO_DIR}/config/frontend.json.template" "${DST_FRONTEND}"
  say "[*] Created ${DST_FRONTEND}"
else
  say "[*] Keeping existing ${DST_FRONTEND}"
  FE_ADDED="$(merge_json_defaults "${REPO_DIR}/config/frontend.json.template" "${DST_FRONTEND}")"
  if [[ -n "${FE_ADDED}" && "${FE_ADDED}" -gt 0 ]]; then
    say "[*] Added ${FE_ADDED} new key(s) from template to ${DST_FRONTEND}"
  fi
fi

ln -sf "${DST_FRONTEND}" "${PREFIX}/static/frontend.json"

VLC_CFG_CANDIDATES=(
  "${HOME}/.config/vlc/vlcrc"
  "${HOME}/.var/app/org.videolan.VLC/config/vlc/vlcrc"
)

generate_pass() {
  tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24
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

set_env_kv() {
  local file="$1"
  local key="$2"
  local value="$3"

  python3 - "$file" "$key" "$value" <<'PY'
import sys, re, pathlib

path = pathlib.Path(sys.argv[1])
key  = sys.argv[2]
val  = sys.argv[3]

def shell_quote_double(s: str) -> str:
    return '"' + s.replace('\\','\\\\').replace('"','\\"').replace('$','\\$').replace('`','\\`') + '"'

new_line = f"{key}={shell_quote_double(val)}"
text = path.read_text(encoding="utf-8") if path.exists() else ""
lines = text.splitlines()

pat = re.compile(rf"^{re.escape(key)}=")
replaced = False
out = []
for line in lines:
    if pat.match(line):
        out.append(new_line)
        replaced = True
    else:
        out.append(line)

if not replaced:
    if out and out[-1].strip() != "":
        out.append("")
    out.append(new_line)

path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
}

VLC_PASS_VALUE=""

if confirm_default_yes "Check VLC config for existing HTTP password?"; then
  for cfg in "${VLC_CFG_CANDIDATES[@]}"; do
    if VLC_PASS_VALUE="$(read_vlc_pass_from_cfg "$cfg")"; then
      say "[*] Found VLC HTTP password in: $cfg"
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

set_env_kv "${DST_ENV}" "VLC_PASS" "${VLC_PASS_VALUE}"

if [[ -n "${LOG_DIR_OVERRIDE}" ]]; then
  set_env_kv "${DST_ENV}" "LOG_DIR" "${LOG_DIR_OVERRIDE}"
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

VLC_CFG_TARGET=""
for cfg in "${VLC_CFG_CANDIDATES[@]}"; do
  if [[ -f "$cfg" ]]; then
    VLC_CFG_TARGET="$cfg"
    break
  fi
done

if [[ -z "$VLC_CFG_TARGET" ]]; then
  if have flatpak && flatpak info org.videolan.VLC >/dev/null 2>&1; then
    VLC_CFG_TARGET="${HOME}/.var/app/org.videolan.VLC/config/vlc/vlcrc"
  else
    VLC_CFG_TARGET="${HOME}/.config/vlc/vlcrc"
  fi
fi

if confirm_default_yes "Configure VLC to enable HTTP control on startup with this password (so vlc-control can latch on later)?"; then
  if [[ -w "$(dirname "$VLC_CFG_TARGET")" ]] || [[ -w "$VLC_CFG_TARGET" ]] || [[ ! -e "$VLC_CFG_TARGET" ]]; then
    if vlc_try_configure_http "$VLC_CFG_TARGET"; then
      say "[*] Updated VLC config: ${VLC_CFG_TARGET}"
      say "    Restart VLC for changes to take effect."
    else
      say "[!] Tried to update VLC config but it failed: ${VLC_CFG_TARGET}"
      say "    You may need to set up VLC HTTP manually or launch VLC via vlc-control."
    fi
  else
    say "[!] VLC config path is not writable: ${VLC_CFG_TARGET}"
    say "    You may need to set up VLC HTTP manually or launch VLC via vlc-control."
  fi
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
say "- Config:     ${DST_ENV}"
say "- Frontend:   ${PREFIX}/static/"
say "- Uninstall:  ./install.sh uninstall"

discard_snapshot
