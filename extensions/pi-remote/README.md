# pi-remote

在安卓手机上随时随地远程查看、操作并实时交互运行在 Linux 主机上的 [Pi Coding Agent](https://github.com/badlogic/pi-mono)。

由 **llMooreyll** 自主设计与开发的自托管全栈远程套件（包含 Android App、Linux 后台守护进程 `hostd`、极简无状态中继 `relay` 及 Pi 桥接插件 `bridge`）。

---

## 核心特性

- 📱 **全功能移动端控制**：在手机上实时观看 Pi 会话流式输出，发送 Prompt，中断（Steer/Stop）运行，应答交互式问答（Dialogs），并直观监控子代理（Subagents）与团队成员（Team Members）的执行动向。
- ⚡ **深度命令集成**：支持在移动端直接调用 `/model`, `/thinking`, `/tree`, `/new`, `/fork`, `/resume`, `/compact`, `/settings` 等核心指令。
- 🔒 **端到端加密（E2EE）**：手机与主机之间基于 Noise NK 协议进行强加密通信，即使通过中继转发也无法被任何中间节点解密。
- 🌐 **无需公网 IP**：主机与手机通过自建在个人 VPS 上的极简 WebSocket 中继建立连接，也支持同一局域网（LAN）内直接直连。
- 🖥️ **本地 tmux 无缝接管**：主机上的 Pi 会话在 tmux 中托管，后台 `pi-hostd` 守护进程管理进程生命周期与事件回放，手机掉线重连后平滑续播。

---

## 架构简图 / Architecture

```
Android app ──ws(s)──▶ relay on your VPS ◀──ws── pi-hostd on the computer ◀──unix socket── pi + bridge extension
             (or directly over the LAN)            (systemd user service)                  (every pi TUI in tmux)
        └──────────── Noise NK end-to-end encryption between app and hostd ────────────┘
```

## Repository layout

| Path | Runs on | What it is |
|---|---|---|
| `packages/hostd/` | Linux computer | `pi-hostd`: pairing, device auth, process registry, event replay, starts pi in tmux, session list, settings. Includes the systemd unit and `scripts/dev-client.ts`, a command-line client for testing. |
| `packages/relay/` | Linux VPS | `pi-relay`: a stateless WebSocket relay that splices one app connection to one hostd data connection. It has a Dockerfile and a systemd unit. |
| `packages/bridge/` | inside pi | `pi-remote-bridge`: the pi extension. It streams events, runs remote operations, mirrors dialogs and reports subagent and team roles. |
| `apps/mobile/` | Android | Expo / React Native app. |
| `packages/protocol/` | shared | Wire types, op definitions, error codes, version constants. |
| `tools/` | dev machine | `wd.mjs`: a UI test helper for Waydroid. |
| `plan.md` | — | Full design and implementation plan, in Chinese. |
| `NOTES.md`, `ACCEPTANCE.md` | — | Implementation notes and the acceptance checklist, in Chinese. |

## Requirements

- Computer: Linux, Node.js 26 (it runs `.ts` directly), tmux, zsh, pi **1.5.0**.
- VPS: Docker, or Node.js 24+, with one open TCP port (default 7443).
- Phone: Android. To build the APK you need JDK 17 and the Android SDK.

## Setup

**1. Install dependencies** (from the repository root):

```zsh
npm install
cd apps/mobile && npm install && cd ../..
```

**2. Relay on the VPS:**

```zsh
mkdir -p -m 700 ~/.config/pi-remote
(umask 077; openssl rand -base64 32 > ~/.config/pi-remote/relay-secret)
ssh vps 'mkdir -p ~/pi-relay'
scp -r packages/relay/{package.json,Dockerfile,src} vps:~/pi-relay/
ssh vps 'cd ~/pi-relay && docker build -t pi-relay .'
ssh vps "docker run -d --name pi-relay --restart unless-stopped -p 7443:7443 \
  -e RELAY_SECRET='$(cat ~/.config/pi-remote/relay-secret)' pi-relay"
curl http://<VPS_IP>:7443/healthz
```

**3. Host daemon on the computer:**

```zsh
node packages/hostd/src/main.ts init
node packages/hostd/src/main.ts relay set ws://<VPS_IP>:7443 --secret "$(cat ~/.config/pi-remote/relay-secret)"
node packages/hostd/src/main.ts direct enable --advertise ws://<LAN_IP>:7444   # optional, for same-network use
```

Before you link the systemd unit, edit `WorkingDirectory` in `packages/hostd/systemd/pi-hostd.service` to point at your checkout. Then:

```zsh
ln -sf "$PWD/packages/hostd/systemd/pi-hostd.service" ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now pi-hostd
loginctl enable-linger $USER          # keep it running when you are logged out
node packages/hostd/src/main.ts relay show
```

**4. Bridge extension:**

```zsh
pi install "$PWD/packages/bridge"
```

Restart running pi sessions, or run `/reload` in them.

**5. Android app:**

```zsh
cd apps/mobile
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

The release build is signed with the debug keystore that prebuild generates. That is fine for personal use, but swap in your own key before you distribute it.

**6. Pair the phone:**

```zsh
node packages/hostd/src/main.ts pair
```

Then scan the QR code in the app.

## Day-to-day

| Task | Command |
|---|---|
| Relay status | `node packages/hostd/src/main.ts relay show` |
| Paired devices | `node packages/hostd/src/main.ts devices list`; remove one with `devices revoke <id>` |
| Moved to a new VPS | Deploy the relay there, run `relay set` with the new address, then update the address in the app settings. You do not need to re-pair. |
| Moved to a new computer | `node packages/hostd/src/main.ts export <file>` on the old one, `… import <file>` on the new one |
| Logs | `~/.local/state/pi-remote/` (`hostd.log`, `audit.jsonl`, `bridge-<pid>.log`) |
| Processes started by hostd | `tmux attach -t pi-remote` |
| Type check | `npm run typecheck` |

## Security

- App ↔ hostd traffic is end-to-end encrypted with Noise NK (`@getpaseo/relay` e2ee). The phone learns the host's public key from the pairing QR code. The relay sees only ciphertext, IPs, timing and sizes.
- The relay secret only stops strangers from using your relay. The identity file and the device credentials under `~/.config/pi-remote/` are what really need protecting. Never commit them.
- Anything you send from the phone runs with your user's permissions on the computer, just as if you typed it into pi. Revoke a lost phone right away.

## Status

The core features are done: milestones M0–M8 in `plan.md`. Two-way file transfer between the computer and the phone is planned as M9 and not implemented yet. Only Android is supported.

## Fonts

The bundled fonts are Instrument Serif, JetBrains Mono, Space Grotesk, and GB2312 subsets of Noto Serif SC and Noto Sans SC. All of them are under the SIL Open Font License 1.1.

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0) — see the [LICENSE](LICENSE) file for details. Any derivative works must remain open source under the same license.
