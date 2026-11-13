# pi-home

A console that opens when you run bare `pi`. It lets you pick a project and session, set
per-session options (extensions, skills, context files, system prompt, model, tools), manage all
sessions, and browse analytics built from every session file. It draws a CRT-style terminal-in-a-terminal
UI in the colours of your pi theme.

## Install

pi-home runs from this directory with Node 24+ (TypeScript is run directly).

```zsh
cd extensions/pi-home && npm install
# in ~/.zshrc:
source /home/moorey/Projects/Pi-extension-dev/extensions/pi-home/shell/pi-home.zsh
```

- Bare `pi` in an interactive terminal opens pi-home. When pi exits you come back to it
  (config `returnToHome`).
- `pi <anything>` runs pi directly, so subagents and pi-remote are unaffected.
- To bypass pi-home once, run `command pi`. To bypass it for a whole shell, run
  `export PI_HOME_DISABLE=1`.
- The companion extension (`extension/index.ts`) is added automatically with `-e` when a launch
  needs it. You do not have to add it to `settings.json`.

## Tabs

| Tab | What it does |
|---|---|
| 1 HOME | Recent projects (pinned first), the selected project's sessions and today/week metrics. `enter` starts a new session, `c` continues, `o` opens a path, `e` edits the profile, `p` pins |
| 2 SESSIONS | All sessions. Search (`/`, or `/?text` for full-text search through `rg`), filters `P T S F # E`, sort `o`, actions: open, fork, rename, tags, favourite, note, HTML export and trash (`gio trash`). `space` marks for batch actions, `c` shows the cleanup assistant, `i` opens the detail page |
| 3 ANALYTICS | Overview, Time, Cost, Models, Tools, Files, Projects, Behaviour and Wrapped. `[` and `]` switch sub-tabs, `r` changes the range, `s` includes subagents. Charts drill down into the Sessions tab |
| 4 PRESETS | Named profiles, the global default and project defaults |

The profile editor opens with `e` and shows the exact pi command it will run (`v` shows the full
command). Settings marked `[CLI]` become pi flags. Settings marked `[RUN]`, such as picking context
files, adding extra context files and hiding skills from the prompt, are applied by the companion
extension and stored in the session.

## Visual tiers

| Tier | When | Look |
|---|---|---|
| T3 | `pi-home --crt-window` (a new Ghostty window with `shaders/crt.glsl`) | GPU CRT: curvature, scanlines, glow, vignette, noise |
| T2 | `COLORTERM=truecolor` | Character-level CRT: bezel, phosphor palette from the theme accent, vignette, power-on/off animation |
| T1 | 256 colours | Quantised palette |
| T0 | `NO_COLOR`, 16 colours or a non-UTF-8 locale | Monochrome with ASCII fallbacks |

- Force a tier with `PI_HOME_TIER=crt|truecolor|256|plain`.
- Turn off animation with `PI_HOME_REDUCED_MOTION=1`.
- The `[■]` button toggles scanlines and the `[O]` button toggles the vignette (title bar, top right).
- The shader only acts while pi-home's marker row is on screen. To use it in every Ghostty window,
  add `custom-shader = …/shaders/crt.glsl` to your Ghostty config.

## Data

All of pi-home's own data is in `~/.pi/agent/pi-home/`:

| File | Contents |
|---|---|
| `config.json` | Configuration |
| `index.json` | Session index cache, rebuilt from the `.jsonl` files when they change |
| `meta.json` | Tags, favourites and notes |
| `models.json` | Model list cache |
| `run/` | One-shot profile files |
| `live/` | Running-pi markers |
| `exports/` | HTML exports |

Session files are only read. Rename appends a `session_info` entry, which is what `/name` does,
and delete moves the file to the trash.

Design documents are `PLAN.md`, `SESSIONS.md` and `VISUAL.md`. The progress log, deviations and
open items are in `JOURNAL.md`.
