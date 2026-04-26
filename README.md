# VLC Control

A self-hosted web remote for VLC. You run it on your machine, it gives you a link, and anyone with that link can control playback from their browser.

Made for watch parties and shared streams where a few people need to pause, skip, or scrub through what's playing. Not meant for public use — it's a trusted-link setup, not an auth system.

**Linux only for now.** Only tested on Arch, KDE 6, Wayland, NVIDIA. It'll probably work on other distros but nothing else has been verified yet.

---

## How it works

The runner (`vlc-control`) starts a small Python server that talks to VLC's built-in HTTP API. Browsers connect over WebSocket and get real-time playback state (title, position, play/pause). Control commands go through the server to VLC.

If `cloudflared` is installed, a Cloudflare quick tunnel is started automatically so people outside your LAN can connect without port forwarding. The tunnel URL is printed (and copied to clipboard if possible) when the server starts. Each run gets a new tunnel URL and a new access token.

**Stack:** Python (Flask + flask-sock) backend, vanilla HTML/CSS/JS frontend, VLC's HTTP interface.

---

## Install

```bash
chmod +x install.sh
./install.sh
```

The installer:
- Checks for Python 3, curl (required), cloudflared, clipboard tools (optional)
- Creates a Python venv with the dependencies
- Copies files into XDG locations
- Optionally configures VLC's HTTP interface by editing `vlcrc`
- Creates a `.desktop` entry so it shows up in app launchers

**Installed to:**

| What | Where |
| ---- | ----- |
| App files | `~/.local/share/vlc-control/` |
| Config | `~/.config/vlc-control/` |
| CLI command | `~/.local/bin/vlc-control` |
| Desktop entry | `~/.local/share/applications/vlc-control.desktop` |

If the install fails partway through, it restores whatever was there before — a failed reinstall won't nuke your existing config.

**Uninstall:**

```bash
./install.sh uninstall
```

---

## Running

```bash
vlc-control
```

Or launch "VLC Control" from your app menu.

On startup it will:
1. Load config from `~/.config/vlc-control/config.env`
2. Generate a fresh access token (new every run)
3. Start VLC with HTTP control if it isn't already running
4. Start the bridge server
5. Start a Cloudflare tunnel (if enabled and installed)
6. Print the local URL and the share link

```
Token:     <random>
Local URL: http://127.0.0.1:5000/?t=<token>

==================== SHARE LINK ====================
https://<random>.trycloudflare.com/?t=<token>
====================================================
```

The share link is what you send to people. Anyone with it can control playback.

**CLI options:**

```
vlc-control --seats 4     # override max clients for this run
vlc-control -s 1          # same, short form
vlc-control --help
```

The `--seats` flag overrides `MAX_CLIENTS` for that run only, doesn't touch the config file.

### Host log

While running, the terminal shows a live log of what's happening:

```
[14:32:01] [+] Client joined: abc123
[14:32:05] [*] web cid=abc123 -> play
[14:33:12] [*] web cid=abc123 -> seek 1:23 / 4:56
[14:35:00] [*] host -> paused
[14:36:10] [-] Client left: abc123
```

Actions from the browser are tagged `web`, actions from VLC directly (you clicking pause in VLC itself) are tagged `host`.

---

## Configuration

There are two config files that control different things:

### `~/.config/vlc-control/config.env` — server / runtime

Controls how the server runs, how it connects to VLC, and how many people can connect. Requires a restart of `vlc-control` to take effect.

| Variable | What it does | Default |
| -------- | ------------ | ------- |
| `PORT` | Port the bridge server listens on | `5000` |
| `MAX_CLIENTS` | Max simultaneous controlling browsers | `2` |
| `GRACE_SECONDS` | How long a disconnected client's seat is held | `30` |
| `VLC_HOST` | VLC HTTP interface address | `127.0.0.1` |
| `VLC_PORT` | VLC HTTP interface port | `8080` |
| `VLC_PASS` | VLC HTTP password (set during install) | — |
| `VLC_MODE` | Which VLC to use: `auto`, `flatpak`, `native`, `none` | `auto` |
| `START_VLC` | Start VLC automatically if not running: `yes` / `no` | `yes` |
| `CLOUDFLARE` | Tunnel behavior: `auto`, `on`, `off` | `on` |

`TOKEN` is **not** in this file — it's generated fresh on every run and only lives in memory.

`VLC_MODE=auto` checks for a Flatpak VLC first, then falls back to a native install. Set to `none` if you want to manage VLC yourself.

`CLOUDFLARE=auto` starts a tunnel if `cloudflared` is installed, skips silently if not. `on` requires it and errors if missing. `off` disables it entirely.

### `~/.config/vlc-control/frontend.json` — what the browser shows

Controls the UI: text, colors, which elements are visible, which controls are enabled. Changes take effect on browser reload, no server restart needed.

```json
{
  "title": "Alphaproject's Stream",
  "subtitle": "Work in progress.",
  "footerText": "Tip: spacebar to play / pause.",
  "theme": { ... },
  "layout": { ... },
  "buttons": { ... },
  "features": { ... },
  "config": { ... }
}
```

**Theme** — full color palette via CSS variables:

| Key | What it sets |
| --- | ------------ |
| `background` | Page background |
| `panel` | Card background |
| `panel2` | Inner card sections |
| `text` | Main text color |
| `muted` | Secondary text |
| `border` | Border color |
| `shadow` | Card shadow |
| `radius` | Corner rounding |
| `accent` | Primary button color |
| `danger` | Stop button / error color |
| `ok` | Success indicator color |

**Layout toggles** — show/hide individual UI sections:

`showTitleBar`, `showNowPlaying`, `showSeekBar`, `showSeekPreview`, `showState`, `showClock`, `showClients`, `showWSStatus`, `showButtons`, `showIcons`, `showSystemStatus`, `showFooter`

All default to `true`. Set any to `false` to hide that piece.

**Button toggles:**

`playPause`, `stop`, `previous`, `next`, `seekJumps` — each `true`/`false`.

**Feature toggles:**

| Key | What it does | Default |
| --- | ------------ | ------- |
| `allowSeeking` | Enable/disable the seek bar and seek buttons | `true` |
| `keyboardEvents` | Enable/disable keyboard shortcuts | `true` |
| `updateTabTitle` | Update the browser tab with the current track | `true` |

**Config values:**

| Key | What it does | Default |
| --- | ------------ | ------- |
| `seekJumpBy` | Seconds for the skip forward/back buttons | `10` |
| `clockShowRemaining` | Default clock mode: remaining time instead of total | `false` |

---

## Keyboard shortcuts

These work when the browser window is focused and `keyboardEvents` is enabled:

| Key | Action |
| --- | ------ |
| `Space` | Play / Pause |
| `N` | Next track |
| `P` | Previous track |
| `Arrow Left` | Seek back (by `seekJumpBy` seconds) |
| `Arrow Right` | Seek forward (by `seekJumpBy` seconds) |

Clicking the time display in the UI toggles between elapsed/total and elapsed/remaining.

---

## The seat system

`MAX_CLIENTS` (default 2) controls how many unique browsers can be connected at once. This isn't about page views — it's about control slots.

When someone disconnects (closes the tab, loses connection), their seat isn't freed immediately. It's held for `GRACE_SECONDS` (default 30) so they can reconnect without someone else taking their spot. If they don't come back in time, the seat opens up.

If the server is full, new visitors see a waiting screen that polls automatically and connects them when a seat opens.

---

## Logs

While running, logs are written to:

- `/tmp/vlc-bridge.log` — bridge server output
- `/tmp/vlc-http.log` — VLC process output (if started by vlc-control)
- `/tmp/vlc-cloudflared.log` — tunnel output

---

## Security

This is a **private, trusted-link** tool. The access token is the only thing between the link and full playback control. There's no login, no accounts, no permissions beyond "has the link" / "doesn't have the link."

Keep the link private. The token changes every run, and if you're using Cloudflare tunnels the URL changes too, so old links stop working automatically.

The seat limit helps prevent spam if a link gets shared wider than intended, but it's not a security mechanism — it's a usability one.

---

## Requirements

```
flask
flask-sock
requests
```

Installed automatically into a venv by `install.sh`.

Optional: `cloudflared` for tunnel support, `wl-copy`/`xclip` for clipboard auto-copy.

---

## License & Use

This project is licensed under AGPLv3.  See [LICENSE](LICENSE) for the full text.

**Personal & private use (most users):** You can modify this code and run it
for yourself and friends without any obligations. You are not required to open-source modifications for private use. Though they are certainly accepted.
If you plan to run this software with friends, this is for you.

**Commercial/Public use:** If you run a public service or commercial
offering based on modifications, you must provide source code to users
(per AGPLv3). You cannot run a proprietary SaaS version.

---

Created by **Alphaproject**.