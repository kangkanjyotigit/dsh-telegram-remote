# 🤖 dsh-telegram-remote

**Full remote control + live state visibility for the [DeepSeek Harness](https://github.com/deepseek-ai/dsh) — from Telegram.**

Turn any Telegram chat into a pocket terminal for your harness: chat with your AI, watch replies stream live (thinking → tools → text), run commands, manage chats/subagents/goals/jobs, and control every harness feature — all through one bot with zero external services (direct Bot API long polling).

---

## ✨ Features

- 💬 **Chat from Telegram** — send a message, get a live-streamed structured reply (thinking, tools, final answer) edited in place
- 🎛 **Full harness control** — 49 commands: chats, models, sessions, subagents, goals, jobs, files, PowerShell, exports, presets, skills, settings, credentials, permissions, and more
- 📡 **Live state** — status, running turns, queued messages (steer / edit / remove), background jobs
- 🔐 **Permission-aware** — sandbox read/write/full control per chat, approval buttons for risky tools
- 🔔 **Notifications** — per-chat on/off/all, background activity pushed to you
- 🔄 **Hot reload** — plugin edits hot-reload with no restart (HMR)
- 🔒 **Single-instance** — a lock file guarantees exactly one poller per bot token (no Telegram 409s)
- 🖥 **Works everywhere** — long polling means no public IP / no webhooks / works behind NAT

## 📦 Requirements

- Node.js **>= 22** (uses global `fetch`)
- A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) installation with a profile (e.g. `web`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## 🚀 Installation

1. **Install the plugin** into your harness profiles:

   ```powershell
   # from your harness profile dir (e.g. ~/.dsh/profiles/web)
   npm install link:path/to/dsh-telegram-remote
   ```

   Or add it to the profile's `package.json`:

   ```json
   {
     "dependencies": {
       "dsh-telegram-remote": "link:C:/path/to/dsh-telegram-remote"
     }
   }
   ```

2. **Add the plugin to the profile patch** (`cordis.patch.yml`):

   ```yaml
   - insert:
       - id: telegram-remote
         name: 'dsh-telegram-remote'
         config:
           tokenFile: 'C:\path\to\telegram.token'   # file containing the bot token
           ownerChatId: 123456789                     # YOUR telegram user id (get it from /whoami)
           workspaceRoot: 'C:\path\to\workspace'
           allowEval: true
           notifyOnStartup: true
   ```

3. **Create the token file** (or set `tokenEnv` instead):

   ```powershell
   Set-Content -Path telegram.token -Value "123456:ABC-your-bot-token" -NoNewline
   ```

4. **Start the harness**, open the chat with your bot, and send `/start`.

## ⚙️ Configuration

| Key | Default | Description |
|---|---|---|
| `botToken` | `""` | Token directly (alternative to a file/env) |
| `tokenEnv` | `"TELEGRAM_BOT_TOKEN"` | Env var holding the token |
| `tokenFile` | `""` | File containing the token |
| `ownerChatId` | `undefined` | Your Telegram user id — full access |
| `allowedUserIds` | `[]` | Extra users allowed to chat |
| `workspaceRoot` | `process.cwd()` | Where `/new` chats start |
| `allowEval` | `true` | Enable `/eval` (runs JS in the harness) |
| `notifyOnStartup` | `true` | Send a "bot online" message on boot |
| `stateFile` / `logFile` | `~/.dsh/...` | Override runtime state / log paths |

## 💬 Usage

Just **type a message** — it goes to your AI and the reply streams back:

```
💭 Thinking
<live reasoning…>

🔧 Tools
⋯ write    ✅ read

🤖 Reply
<live streaming text…>

─────── ⋆⋅☆⋅⋆ ───────
⏳ 34s
```

Tap the **/start** keyboard or type `/help` for the full command list. Key commands:

- `/chats` · `/new` · `/open` — manage chats
- `/model` · `/models` — switch AI models (`/model max` for deepest thinking)
- `/status` — what's happening right now
- `/queue` `/steer` `/edit` `/remove` — control queued messages
- `/cmd` `/fs` `/mkdir` — run commands and manage files
- `/agents` `/send` `/interrupt` — subagents
- `/goal` — long-running objectives
- `/jobs` `/kill` — background tasks
- `/export` `/search` `/archive` — conversation history
- `/permission` — sandbox mode per chat
- `/eval` `/raw` `/api` — power-user harness access
- `/reboot` `/shutdown` — harness lifecycle (graceful)

## 🔒 Security notes

- The bot can control your computer — **only add users you trust** (`ownerChatId` / `allowedUserIds`).
- Every request is checked against the per-chat `/permission` mode; risky tools request approval.
- `/eval` and `/cmd` are powerful — consider `allowEval: false` unless you need them.
- No telemetry, no external services: the bot talks to Telegram and your harness only.

## 🔄 Hot reload (development)

With the harness HMR enabled, editing this plugin's `lib/*.js` files reloads it in ~2s:

```yaml
- id: hmr
  disabled: false
  config:
    root: ['C:\path\to\dsh-telegram-remote']
    ignored: []
```

## 📄 License

MIT
