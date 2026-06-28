# Notch · 日迹

> Mark every day. · 刻下每一天。

A local-first personal work journal with automatic activity tracking — it records the apps, window titles, and screenshots of your day, and turns them into AI summaries you can actually read.

一个本地优先的个人工作日志应用，带有自动活动追踪：记录你一天中用过的 App、窗口标题和截图，并生成你真正读得下去的 AI 总结。

---

## Features · 功能特性

**English**

- **Quick notes** — jot down thoughts and todos anytime.
- **Task timers** — track when tasks start and stop.
- **AI summaries** — auto-generated at 12:00 / 18:00 / 21:00 (requires `ANTHROPIC_API_KEY`).
- **Ask your day** — a chat box that answers natural-language questions like "what did I do in the past hour?" (falls back to a time-windowed activity digest when no key is set).
- **Activity tracking** (built into the server, macOS only):
  - App usage time (real app names, aggregated by duration)
  - Window-title tracking
  - Screenshots (every 5 minutes)
  - Pause / resume anytime
- **Local storage** — one JSON file per day; syncs for free via iCloud/Dropbox.

**中文**

- **随手记** —— 随时记录想法和待办事项。
- **任务计时** —— 追踪任务的开始和结束时间。
- **AI 总结** —— 在 12:00 / 18:00 / 21:00 自动生成（需要 `ANTHROPIC_API_KEY`）。
- **问问今天** —— 对话框，支持自然语言提问，如「我过去一小时做了什么」（没 key 时按时间窗口返回活动汇总）。
- **活动追踪**（内置于服务器，仅 macOS）：
  - App 使用时间（真实 App 名，按时长聚合）
  - 窗口标题追踪
  - 截图（每 5 分钟）
  - 可随时暂停 / 继续
- **本地存储** —— 每天一个 JSON 文件，支持 iCloud/Dropbox 同步。

---

## Project structure · 项目结构

```
littlejot/
├── server/             # Node.js backend (with built-in tracking) · 后端（含内置追踪）
│   ├── index.js        # Express server + API + starts tracking · 服务器 + API + 启动追踪
│   ├── storage.js      # data storage · 数据存储
│   ├── tracker.js      # built-in activity tracker (osascript + screencapture) · 内置追踪
│   ├── summarizer.js   # AI summaries + Q&A · AI 总结与问答
│   └── scheduler.js    # scheduled summaries · 定时小结
├── public/
│   └── index.html      # frontend · 前端界面
├── src-tauri/          # (optional) Tauri desktop app · （可选）Tauri 桌面应用
│   └── ...
├── data/               # data directory · 数据目录
├── package.json
└── .env                # config · 环境配置
```

---

## Plan ahead & review · 计划与复盘（Little Bird 式）

Notch no longer just *records the past* — it also *plans the future*. Three tabs:
**今天 / 本周 / Bird**.

Notch 不再只是「记录过去」，还能「规划未来」。三个标签页：**今天 / 本周 / Bird**。

- **Daily plan · 每日计划** — Bird drafts the day's 3–5 focus items, grounded in
  yesterday's unfinished items, your calendar, this week's priorities, and your
  `goals.md`. Check items off through the day; add your own. (晨间起草当天重点，
  锚定昨天遗留、日历、本周重点和长期目标；可勾选、可手动加。)
- **Daily review · 每日复盘** — evening plan-vs-actual: what landed, what didn't,
  wins, blockers, what carries to tomorrow — using your tracked activity as
  ground truth. (晚间「计划 vs 实际」，用真实活动追踪做底。)
- **Weekly plan · 每周计划** — Monday's theme + 3–5 priorities for the week. (周一
  定主题与本周重点。)
- **Weekly review · 每周复盘** — rolls up the week's daily reviews + tracked time
  into progress, patterns, and seeds for next week. (周复盘汇总一周的每日复盘与时
  间投入，看进展与模式。)
- **Routines · 例行助理** — the proactive engine (Little Bird's "Routines"). At
  set times it auto-generates the above and drops a card in your **feed**
  ("Bird drafted your daily plan"). Toggle each on/off or run it now. (到点自动
  产出计划/复盘并推送到动态；可逐个开关或手动运行。)
- **Calendar integration · 日历集成** — point `CALENDAR_ICS_URL` at any Google/Apple
  ICS feed (no OAuth) so plans are anchored to real meetings. (接入 ICS 日历，让
  计划锚定真实日程。)
- **`goals.md` context** — a hand-written file of your goals/projects that every
  plan reads. Notch's lightweight take on Little Bird "knowing your work" — one
  file instead of a dozen integrations. (一个手写的目标文件，作为「了解你的世界」
  的轻量上下文。)

- **Cross-day / cross-week chat · 跨天跨周问答** — "问问 Notch" now resolves the
  time range in your question ("今天 / 这周 / 上周 / 这个月 / 周二 / 2026-06-25 /
  最近 3 天") and answers from a compact digest spanning it — daily summaries,
  reviews, plan-completion, task totals, and weekly plans/reviews. Intraday
  questions ("过去一小时") still use today's fine-grained timeline. (问答不再只看
  当天：自动识别时间范围，跨天跨周作答。)

> All of it degrades gracefully without an API key (deterministic drafts) and
> without a calendar. 没有 API key（用本地草稿）或没接日历也都能用。

---

## Getting started · 运行方式

Activity tracking is **built into the Node server**, so a single command runs the whole app — notes, timers, AI summaries, and app/window/screenshot tracking. No separate build or menu-bar app required.

活动追踪**内置在 Node 服务器里**，所以一条命令就能跑起整套应用——随手记、任务计时、AI 总结、App/窗口/截图追踪全部到位，不需要单独编译或启动菜单栏 App。

### 1. Start it (that's all) · 启动（这就是全部）

```bash
cd ~/Desktop/📁\ Projects/littlejot
npm start
```

Server runs at http://localhost:4174 with tracking on by default.
服务器运行在 http://localhost:4174，活动追踪默认开启。

### 2. Grant macOS permissions (first run) · 授权 macOS 权限（首次必做）

Tracking uses `osascript` and `screencapture`, so permissions go to **whatever program runs `node`** — usually your **Terminal / iTerm**, not a separate app:

追踪通过 `osascript` 和 `screencapture` 实现，权限要授予**运行 `node` 的那个程序**（通常是你的**终端 / iTerm**，而不是某个 App）：

- **Accessibility · 辅助功能**: System Settings → Privacy & Security → Accessibility → enable your terminal. (Reads the foreground app name + window title · 读取前台 App 名称和窗口标题)
- **Screen Recording · 屏幕录制**: System Settings → Privacy & Security → Screen Recording → enable your terminal. (For periodic screenshots · 用于定时截图)

> It degrades gracefully without permissions: the server still runs and notes/timers/summaries all work — it just records no activity, and the UI shows the tracker as "受限（检查系统权限）".
>
> 没授权也不会崩溃：服务器照常运行，随手记/任务/总结都能用，只是不记录活动，界面会显示「受限（检查系统权限）」。

### 3. Pause / resume tracking · 暂停 / 继续追踪

- The "暂停追踪 / 继续追踪" button at the top-right of the activity card, or
- `curl -X POST localhost:4174/api/tracker/toggle`
- To disable auto-tracking entirely, set `TRACKING=off` in `.env`.

网页活动卡片右上角的「暂停追踪 / 继续追踪」按钮；或上面的 `curl` 命令；想彻底关掉就在 `.env` 设 `TRACKING=off`。

### 4. (Optional) desktop app · （可选）桌面 App

The Tauri app in `src-tauri/` opens Notch in a native window. Its **old built-in tracker has been superseded by the server's tracking** — don't run both at once or you'll get duplicate data. Stick to `npm start`.

`src-tauri/` 下的 Tauri 桌面 App 会用原生窗口打开 Notch。它**自带的旧追踪已被服务器内置追踪取代**——两者别同时开，否则会重复记录。保持 `npm start` 这一条路径即可。

---

## API · API 端点

| Endpoint | Method | Description | 说明 |
|----------|--------|-------------|------|
| `/api/today` | GET | Get all of today's data | 获取今日所有数据 |
| `/api/entries` | POST | Add a quick note | 添加随手记 |
| `/api/tasks/start` | POST | Start a task timer | 开始任务 |
| `/api/tasks/stop` | POST | Stop the current task | 结束任务 |
| `/api/summarize` | POST | Generate an AI summary | 生成 AI 总结 |
| `/api/ask` | POST | Conversational Q&A across days/weeks (`{question, history}`) | 对话问答（自动识别「今天/这周/上周/这个月/某天」并跨天跨周作答） |
| `/api/plan/today/generate` | POST | Generate today's daily plan | 生成今日计划 |
| `/api/plan/today/items` | POST | Add a manual plan item (`{text}`) | 手动加计划项 |
| `/api/plan/today/items/:id/toggle` | POST | Check/uncheck a plan item | 勾选/取消计划项 |
| `/api/review/today/generate` | POST | Generate today's daily review | 生成今日复盘 |
| `/api/week` | GET | This week's plan + review (`?date=`) | 本周计划+复盘 |
| `/api/week/plan/generate` | POST | Generate the weekly plan | 生成本周计划 |
| `/api/week/plan/items` | POST | Add / toggle a weekly priority | 加/勾选本周重点 |
| `/api/week/review/generate` | POST | Generate the weekly review | 生成本周复盘 |
| `/api/calendar/today` · `/week` | GET | Upcoming calendar events (ICS) | 日历事件 |
| `/api/routines` | GET | List routines | 列出例行助理 |
| `/api/routines/:id` | PATCH | Enable/disable or retime a routine | 开关/改时间 |
| `/api/routines/:id/run` | POST | Run a routine now | 立即运行 |
| `/api/feed` | GET | Recent proactive cards | 最近的动态卡片 |
| `/api/activities/:date` | GET | Get a day's activity (apps/windows/screenshots) | 获取某日活动 |
| `/api/activities/status` | GET | Tracker status (running / current app / error) | 内置追踪器状态 |
| `/api/tracker/toggle` | POST | Pause / resume tracking (`{enabled}`) | 暂停 / 继续追踪 |
| `/api/activities/apps` | POST | (legacy) external app report | （兼容旧版）外部上报 App |
| `/api/activities/screenshots` | POST | (legacy) external screenshot upload | （兼容旧版）外部上传截图 |
| `/api/activities/heartbeat` | POST | (legacy) external tracker heartbeat | （兼容旧版）外部追踪器心跳 |

---

## Configuration (.env) · 环境配置

```bash
# Data directory · 数据存储目录
DATA_DIR=./data

# Port · 端口
PORT=4174

# Anthropic API key (optional; without it, summaries fall back to a plain digest)
# Anthropic API Key（可选，不填则用简单聚合总结）
ANTHROPIC_API_KEY=

# Claude model · Claude 模型
ANTHROPIC_MODEL=claude-sonnet-4-6

# Scheduled summary times · 自动总结时间
SUMMARY_SCHEDULE=12:00,18:00,21:00

# Activity tracking switch (off = no auto app/window/screenshot recording)
# 活动追踪开关（off = 不自动记录 App/窗口/截图）
TRACKING=on
```

---

## Data format · 数据格式

One file per day at `data/YYYY-MM-DD.json` · 每日数据存储在 `data/YYYY-MM-DD.json`：

```json
{
  "date": "2026-05-06",
  "entries": [{ "id", "ts", "text", "tag" }],
  "tasks": [{ "id", "name", "startTs", "endTs", "durationMs" }],
  "summaries": [{ "id", "ts", "slot", "text", "model" }],
  "plan": { "id", "ts", "model", "headline", "items": [{ "id", "text", "done", "source" }], "note" },
  "review": { "id", "ts", "model", "text" },
  "activities": {
    "apps": [{ "id", "ts", "bundleId", "name", "durationMs" }],
    "windows": [{ "id", "ts", "app", "bundleId", "title", "durationMs" }],
    "screenshots": [{ "id", "ts", "filename" }]
  }
}
```

Weekly plans/reviews live in `data/weeks/YYYY-Www.json`; routine config in
`data/routines.json`; the proactive feed in `data/feed.json`; your long-horizon
context in `data/goals.md` (copy from `data/goals.example.md`). Screenshots are
stored under `data/screenshots/YYYY-MM-DD/`.

每周计划/复盘存在 `data/weeks/YYYY-Www.json`；例行助理配置在 `data/routines.json`；
动态在 `data/feed.json`；长期上下文在 `data/goals.md`（从 `data/goals.example.md`
复制）。截图文件存储在 `data/screenshots/YYYY-MM-DD/` 目录。

---

## Development · 开发

Rebuild the Tauri app · 重新编译 Tauri App：

```bash
cd ~/Desktop/📁\ Projects/littlejot
npm run tauri:build
```

Test the API · 测试 API：

```bash
node test-tracker.js
```

---

## Status · 当前状态

- [x] Node.js server · Node.js 服务器
- [x] Frontend (notes / timers / summaries / activity log) · 前端界面
- [x] Quick notes · 随手记
- [x] Task timers · 任务计时
- [x] AI summaries (scheduled + manual; activity-aware; degrades without a key) · AI 总结
- [x] App usage tracking (built-in, real app names) · App 使用追踪
- [x] Window-title tracking (built-in) · 窗口标题追踪
- [x] Screenshots (built-in, every 5 min) · 截图功能
- [x] Pause / resume tracking · 暂停 / 继续追踪
- [x] Q&A chat · 对话问答
- [x] Graceful degradation without permissions/key · 权限或 key 缺失时优雅降级
- [~] Tauri desktop app (optional launcher) · Tauri 桌面 App（可选入口）
- [ ] Keystroke logging (removed — privacy, out of scope) · 键盘记录（已移除）

---

## Tech stack · 技术栈

- **Backend · 后端**: Node.js + Express
- **Frontend · 前端**: Vanilla JS + CSS
- **Activity tracking · 活动追踪**: built into Node (`osascript` + `screencapture`, macOS only)
- **Desktop app (optional) · 桌面应用（可选）**: Tauri v2 + Rust
- **Storage · 存储**: local JSON files · 本地 JSON 文件
- **AI · 模型**: Anthropic Claude Messages API (default `claude-sonnet-4-6`)
