# VLC Control

A self-hosted web remote for VLC. You run it on your machine, it gives you a link, and anyone with that link can control playback from their browser.

Made for watch parties and shared streams where a few people need to pause, skip, scrub, and queue up what's playing. Not meant for public use — it's a trusted-link setup, not an auth system.

**Linux only for now.** Only tested on Arch, KDE 6, Wayland, NVIDIA. It'll probably work on other distros but nothing else has been verified yet.

---

## How it works

The runner (`vlc-control`) starts a small Python server that talks to VLC's built-in HTTP API. Browsers connect over WebSocket and get real-time playback state (title, position, play/pause, playlist). Control commands go through the server to VLC.

If `cloudflared` is installed, a Cloudflare quick tunnel is started automatically so people outside your LAN can connect without port forwarding. The tunnel URL is printed (and copied to clipboard if possible) when the server starts. Each run gets a new tunnel URL and a new access token.

**Stack:** Python (Flask + flask-sock) backend, vanilla HTML/CSS/JS frontend, VLC's HTTP interface.

---

## Features

- Play / pause / stop / previous / next / seek, live-synced to every connected browser
- Playlist modal - view what's queued, skip to a track, remove tracks, clear, multi-select for bulk removal
- File browser - let guests browse directories you've whitelisted and queue files, with search, list/grid views, extension grouping, and multi-select. Off by default
- Resume prompts - reopening a partially-watched item asks whether to resume or start over
- Nicknames - guests can pick a name; a roster modal shows who's connected and for how long
- Seat system - a configurable number of control slots, with a grace period so a dropped connection doesn't lose its seat
- Conflict handling - if two people hit pause at once (or you act in VLC directly), one action wins cleanly instead of fighting
- Fully themeable UI - colors, visible sections, and individual buttons all configurable

---

## Install

```bash
chmod +x install.sh
./install.sh
```

The installer:
- Checks for Python 3 and curl (required), cloudflared and clipboard tools (optional)
- Creates a Python venv with the dependencies
- Copies files into XDG locations
- Generates `config.toml` from the template, or validates and upgrades an existing one (your values are kept, new keys are added)
- Optionally configures VLC's HTTP interface by editing `vlcrc`
- Creates a `.desktop` entry so it shows up in app launchers

**Installed to:**

| What | Where |
| ---- | ----- |
| App files | `~/.local/share/vlc-control/` |
| Config | `~/.config/vlc-control/config.toml` |
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
1. Load `~/.config/vlc-control/config.toml`
2. Generate a fresh access token (new every run) and print the local URL
3. Launch the Cloudflare tunnel in the background (if enabled and installed), so it registers with Cloudflare while the rest starts
4. Start VLC with HTTP control if it isn't already running
5. Start the bridge server
6. Check the bridge is alive and answering, then print the share link

```
vlc-control 0.5.2 (<commit hash><"+" if files are modified>)
Installed:  10 Aug 2026, 07:20 (2 hours ago)
Updated:    09 Aug 2026, 09:17 (1 day ago)

Token:      <random>
Local URL:  http://127.0.0.1:5000/?t=<token>

==================== SHARE LINK ====================
https://<random>.trycloudflare.com/?t=<token>
====================================================

[OK] Running.
Press Ctrl+C to stop.
```

The share link is what you send to people. Anyone with it can control playback.

How much of that you see is up to you. `[status] show` in the config lists what gets printed, and taking an item out of the list hides it:

| Item | What it adds |
| ---- | ------------ |
| `version` | The version line, with the commit it was installed from |
| `installed` | When this copy was installed, and which version it replaced |
| `updated` | When the files it was installed from last changed |
| `stale` | A warning when those files have changed since you installed |
| `paths` | Where it's installed and where it was installed from |
| `seats` | Seat limit and grace period |
| `runtime` | Python and cloudflared versions |
| `token` | The bare token line (the local URL already contains it) |
| `steps` | Progress lines while VLC, the bridge and the tunnel start up |
| `ready` | The config path and log file list at the end |
| `logkey` | One line explaining the `+`, `-`, `*`, `~`, `!` and `x` tags in the live log |

`paths`, `seats` and `runtime` are the three left out by default. Once you know the tags off by heart, `logkey` is the next one most people drop. Whatever you remove, the local URL, the share link, `[OK] Running` and the Ctrl+C hint always print, along with any warning or error, since without those you'd have no link to hand out and no way to tell it had finished starting. `show = []` gets you exactly that and nothing else.

**CLI options:**

```
vlc-control --seats 4     # override max seats for this run
vlc-control -s 1          # same, short form
vlc-control --version     # or -v
vlc-control --help
```

The `--seats` flag overrides `max_clients` for that run only, doesn't touch the config file.

### Keeping the installed copy current

`install.sh` copies everything into `~/.local/share/vlc-control/`, so pulling a newer version or editing the files yourself changes nothing until you install again. That's what the `stale` item watches for:

```
[!] The source has changed since this copy was installed - re-run install.sh to pick the changes up.
```

Re-running `./install.sh` keeps the `config.toml` you already have and only adds keys that are new.

### Host log

While running, the terminal shows a live log of what's happening:

```
[14:32:01] [+] C1 joined
[14:32:05] [*] C1 paused playback
[14:32:19] [*] Alex seeked to 12:04 / 34:10
[14:33:02] [*] Alex switched to "episode 2.mkv"
[14:35:00] [*] Host started playback
[14:35:48] [~] VLC advanced to "episode 3.mkv"
[14:36:10] [-] C1 left (seat held for 30s)
```

`+` joined, `-` left, `*` an action someone took, `~` something VLC did on its own, `!` a problem, `x` fatal, something that stopped the run before it got this far.

Guests show up under their nickname if they've set one, otherwise a fallback identity (`C1`, `C2`, ... by default - see `client_id_style`). Anything you do in VLC itself rather than through the web UI is attributed to `Host`. Lines tagged `[~]` are things nobody did: a track ending and the next one starting, the playlist running out, VLC dropping off the network.

---

## Configuration

Everything lives in one file: `~/.config/vlc-control/config.toml`. It's heavily commented - the file itself is the full reference, this is just the map. Restart `vlc-control` after changing it.

| Section | What it controls |
| ------- | ---------------- |
| `[system]` | Server port, seats and grace period, VLC connection/launch, tunnel mode, logging, client identity, action debounce. Never sent to guests. |
| `[status]` | Which version/install details the runner prints to the console on startup. Host-side only. |
| `[file_browse]` | Whether guests can browse files at all, which directories, allowed extensions, blacklists. All enforced server-side. |
| `[features]` | Feature switches. Flags marked `[server]` in the file (seeking, playlist control) block the API call itself, not just the button. |
| `[layout]` | Show/hide individual UI sections - purely visual. |
| `[buttons]` | Show/hide individual buttons - purely visual, use `[features]` to actually block an action. |
| `[ui]` | Title, subtitle, and footer text guests see. |
| `[config]` | Defaults and thresholds - seek jump size, clock mode, resume prompt tuning, file browser default view. |
| `[theme]` | Full color palette via CSS variables, plus radius and shadow. |

A few `[system]` keys worth knowing about:

| Key | What it does | Default |
| --- | ------------ | ------- |
| `port` | Port the bridge listens on (local only) | `5000` |
| `max_clients` | Max simultaneous seats | `2` |
| `grace_seconds` | How long a disconnected client's seat is held | `30` |
| `vlc_mode` | Which VLC to use: `auto`, `flatpak`, `native`, `none` | `auto` |
| `start_vlc` | Start VLC automatically if it isn't running | `true` |
| `kill_vlc_on_exit` | Stop VLC on exit (only if vlc-control started it) | `true` |
| `cloudflare` | Tunnel behavior: `auto`, `on`, `off` | `auto` |
| `client_id_style` | Fallback guest identity: `numeric`, `cid`, `short_cid`, `ip` | `numeric` |
| `action_debounce_ms` | Window for resolving simultaneous play/pause/stop presses | `250` |
| `http_access_log` | Write a line per HTTP request to `vlc-access.log` (includes the token) | `false` |

The access token is **not** in the config — it's generated fresh on every run and only lives in memory.

`cloudflare = "auto"` starts a tunnel if `cloudflared` is installed and skips it if not. If the tunnel then fails to come up, it says why and carries on with the local URL. `on` treats the share link as the point of the run, so anything that stops the tunnel stops the run. `off` disables it entirely.

Either way, the bridge itself has to be alive and accepting this run's token before you get any URL at all. If it isn't, the run stops rather than hand you a link that answers nothing.

### File browsing

Off by default. When enabled, guests can only see what you explicitly allow:

- `dirs` - whitelisted root directories (append `/*` to a path to allow its subdirectories)
- `auto` - expose the folder of the currently-playing file without revealing its real path
- `extensions` - anything not in the list is hidden entirely
- `blacklist_dirs` / `blacklist_terms` - hide directories and names you never want shown

All of it is validated server-side - path traversal is blocked and full paths never leave your machine, guests only ever see paths relative to a root.

---

## Keyboard shortcuts

These work when the browser window is focused and `keyboard_events` is enabled:

| Key | Action |
| --- | ------ |
| `Space` | Play / Pause |
| `N` | Next track |
| `P` | Previous track |
| `Q` | Open / close the playlist |
| `Arrow Left` | Seek back (by `seek_jump_by` seconds) |
| `Arrow Right` | Seek forward (by `seek_jump_by` seconds) |

Modals are keyboard-navigable too - arrows to move, `Enter` to select, `Escape` to close, `Backspace` to go up a directory in the file browser.

Clicking the time display toggles between elapsed/total and elapsed/remaining.

---

## The seat system

`max_clients` (default 2) controls how many unique browsers can be connected at once. This isn't about page views — it's about control slots.

When someone disconnects (closes the tab, loses connection), their seat isn't freed immediately. It's held for `grace_seconds` (default 30) so they can reconnect without someone else taking their spot. If they don't come back in time, the seat opens up. Set `grace_seconds = 0` to turn grace off entirely - the seat frees the instant they disconnect.

If the server is full, new visitors see a waiting screen that polls automatically and connects them when a seat opens.

---

## Logs

While running, logs are written to `log_dir` (default `/tmp`):

- `vlc-bridge.log` — bridge server events, timestamped
- `vlc-http.log` — VLC process output (if started by vlc-control)
- `vlc-cloudflared.log` — tunnel output
- `vlc-access.log` — one line per HTTP request, only when `http_access_log = true`

All of them are truncated at the start of every run, so what you're looking at is always this session. The terminal log is a friendly rendering of the bridge log; the file has the full detail.

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
tomli (Python < 3.11 only)
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
