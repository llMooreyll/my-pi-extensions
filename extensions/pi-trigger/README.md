# pi-trigger

Wake-ups the agent schedules for itself, and external events (mail, links, webhooks, scripts) routed to named sessions. Trigger messages appear as cards, separate from what you type, and a widget above the editor shows what is scheduled and waiting.

| Part | Where | What it does |
|---|---|---|
| `schedule` tool | this extension | The agent creates, lists, updates and cancels timers in its own session |
| `/trigger` command | this extension | Menu and subcommands: timers, pause, compaction override, context policy, alias, budget |
| Widget `trigger` | this extension | Alias, policy, next timer, pending triggers, last delivery |
| Trigger hub | `pi-hostd` (pi-remote) | Sources → routes → durable queue → delivery through the bridge; reopens closed sessions |

Requirements: pi 1.5, an interactive session (TUI). External triggers and waking closed sessions need [pi-remote](../pi-remote)'s `pi-hostd` and bridge. Compacting before trigger runs needs [pi-cache-timer](../pi-cache-timer).

## Timers (`schedule` tool)

```
schedule({ action: "create", id: "check-mail", every: "30m", prompt: "Check the mail summary and report anything urgent." })
schedule({ action: "create", at: "09:00", prompt: "…" })            // once, next 09:00
schedule({ action: "create", in: "20m", prompt: "…" })              // once
schedule({ action: "create", daily: "08:30", wake: true, prompt: "…" })
schedule({ action: "list" }) / ({ action: "cancel", id }) / ({ action: "update", id, … })
```

| Field | Default | Meaning |
|---|---|---|
| `in` / `at` / `every` / `daily` | — | Exactly one for create. `at` takes ISO date-time or `HH:MM` |
| `maxRuns` | none | Delete after this many runs |
| `expiresIn` | 7d for repeating timers | Delete after this long (max 30d) |
| `whenBusy` | `queue` | A run due while the agent works: wait for it to finish, or `skip` |
| `catchUp` | `once` | Runs missed while the session was closed: one catch-up run, or `skip` |
| `wake` | `false` | pi-hostd reopens the closed session when the timer is due |

Timers are stored per session in `~/.pi/agent/pi-trigger/sessions/<sessionId>.json` and survive `/reload`, restarts and `/resume`. They only fire while the session is open, unless `wake` is set.

## Delivery

1. Due timers and accepted events wait in the session's pending list.
2. When Pi is idle, no message is queued and no dialog is open, pi-trigger takes a batch (items with the same tool restriction, up to 20).
3. `rebase` policy: go back to the base entry (`/tree` navigation without summary).
4. Asks pi-cache-timer `prepareSend` (source `pi-trigger`): with policy `compact` and a cold cache over its thresholds, it compacts first. Under `rebase`, the compacted point becomes the new base.
5. Sends one custom message (`customType: "trigger"`) that starts a run.

Runs started by triggers count against a daily budget (default $5 per session); when it is used up, triggers wait until the next day or `/trigger budget`. Routes with `allowedTools` block every other tool in their runs.

While a timer fires within 30 minutes, pi-trigger asks Pi to keep the prompt cache warm when the refreshes cost less than the miss they avoid (`cache_warming_decision`). It never stops Pi's own warming.

## `/trigger`

Without arguments it opens a menu. Subcommands:

| Subcommand | Effect |
|---|---|
| `list` | Timers, pending triggers, settings |
| `cancel <id\|all>`, `run <id>` | Delete timers, fire one now |
| `pause`, `resume` | Stop/resume firing and delivery (pending items are kept) |
| `compact <on\|off\|default>` | This session's override of pi-cache-timer's `extensionSends["pi-trigger"]` |
| `policy <keep\|rebase>` | `keep`: trigger runs continue the conversation. `rebase`: every trigger run starts from the current end of the conversation; earlier runs stay as branches in `/tree` |
| `inbox <alias\|off>` | Name the session `@alias` for the hub; the newest claim of an alias wins |
| `budget <usd\|default>` | Daily budget of trigger runs; `0` = no limit |
| `deliver`, `clear` | Deliver pending triggers now, or discard them |

Example of a session that only archives links:

```
(write the instructions: "You archive articles into ~/Notes/archive …", let the agent confirm)
/trigger inbox archive
/trigger policy rebase
/trigger compact off        # rebase keeps the context small; compaction is not needed
```

## Trigger hub (pi-hostd)

Runs inside `pi-hostd serve`. Config: `~/.pi/agent/pi-trigger/hub.json` (reloaded on change). Queue and dedupe state: `~/.local/state/pi-remote/triggers/store.json`. Log lines start with `triggers:` in `~/.local/state/pi-remote/hostd.log`.

```jsonc
{
  "enabled": true,
  "trust": "deny",                      // --no-approve for sessions the hub reopens
  "webhook": { "enabled": true, "host": "127.0.0.1", "port": 7450, "token": "at-least-16-characters" },
  "sources": [
    { "name": "mail", "type": "exec", "command": ["python3", "~/bin/mail-poll.py"], "intervalSec": 300 },
    { "name": "feeds", "type": "exec", "command": ["~/bin/feed-watch"], "restartSec": 30 },
    { "name": "inbox", "type": "dir", "path": "~/Inbox/pi" },
    { "name": "custom", "type": "module", "path": "~/.pi/agent/pi-trigger/sources/custom.ts", "options": {} }
  ],
  "routes": [
    { "id": "archive-links", "match": { "kind": "link.share" }, "target": "@archive",
      "instruction": "Archive the linked article.", "trusted": true },
    { "id": "mail-triage", "match": { "source": "mail", "kind": "mail.*", "text": "invoice|urgent" },
      "target": "@mail", "batchWindowSec": 120, "maxPerHour": 20, "allowedTools": ["read", "write"] }
  ]
}
```

### Events

Every source produces JSON objects:

```jsonc
{ "id": "imap-4711",           // dedupe key within the source; omit for no dedupe
  "source": "mail",            // defaults to the source name
  "kind": "mail.new",          // defaults to "event"
  "title": "Invoice 2026-11",  // or the first line of text
  "text": "…", "data": { … },
  "target": "@archive" }       // optional: skip the routes and deliver directly
```

| Source | How |
|---|---|
| `drop` (built in) | Files in `~/.pi/agent/pi-trigger/drop/`: `.json` = one event or an array; other files = text event titled by the first line. Files are deleted after reading |
| `dir` | Same, for another folder |
| `exec` | Each stdout line with a JSON object is an event. With `intervalSec` the command runs periodically (killed after `timeoutSec`, default 300); without it, it runs continuously and restarts after `restartSec` with backoff. `PI_TRIGGER_SOURCE` is set |
| `module` | `export function start(ctx)` (or default export): `ctx.emit(event)`, `ctx.options`, `ctx.log`, `ctx.signal`; may return a stop function. Runs inside pi-hostd |
| webhook | `POST http://host:port/event` with `Authorization: Bearer <token>` (or `?token=`); JSON body = event(s), other bodies = text event |
| CLI | `pi-hostd trigger send @archive https://example.com/post [--title …] [--kind …]` |

### Routes

`match.source` / `match.kind` take `*` globs, `match.text` is a case-insensitive regular expression over title and text. Every matching route gets its own delivery. `target` is `@alias` or an absolute session file. `wake` (default true) reopens a closed target in the `pi-remote` tmux session. `batchWindowSec` collects events into one run; `maxPerHour` delays the excess.

Event content is wrapped in `<external-data>` and marked as data, not instructions, unless the route has `"trusted": true`; the route's `instruction` comes first. CLI sends through the drop folder are trusted.

`pi-hostd trigger status` shows the config problems, aliases and the queue.

## Config (`~/.pi/agent/pi-trigger.json`)

```json
{ "minIntervalMinutes": 5, "maxTimers": 10, "defaultExpiryDays": 7, "maxExpiryDays": 30, "dailyBudgetUsd": 5 }
```

To compact before trigger runs by default, add to `~/.pi/agent/pi-cache-timer.json`:

```json
{ "extensionSends": { "pi-trigger": "compact" } }
```

## Contracts

| Contract | Defined in |
|---|---|
| Session state files read by the hub | `src/state.ts`; read view in `pi-remote/packages/hostd/src/triggers/types.ts` |
| `globalThis[Symbol.for("pi.trigger.v1")].accept(sessionFile, items)` | `src/service.ts`; called by the bridge op `trigger_deliver` |
| `globalThis[Symbol.for("pi.cache-timer.v1")].prepareSend / lifetimeMs` | `pi-cache-timer/src/service.ts` |

Subagent and team member processes do not load pi-trigger's features.
