# Notch · 日迹 — 活动追踪工作日志

> 刻下每一天。

## 项目概述

Notch 是一个本地优先的个人工作日志应用，带有自动活动追踪功能。可以记录你一天中使用过的 App、窗口标题和截图。

## 功能特性

- **随手记**：随时记录想法和待办事项
- **任务计时**：追踪任务开始和结束时间
- **AI 总结**：在 12:00、18:00、21:00 自动生成工作小结（需要 ANTHROPIC_API_KEY）
- **对话问答**：在「问问今天」对话框里用自然语言提问，如「我过去一小时做了什么」「时间花在哪了」（无 key 时按时间窗口返回活动清单）
- **活动追踪**（内置于服务器，仅 macOS）：
  - App 使用时间（真实 App 名，按时长聚合）
  - 窗口标题追踪
  - 截图（每 5 分钟）
  - 可随时暂停 / 继续
- **本地存储**：每天一个 JSON 文件，支持 iCloud/Dropbox 同步

## 项目结构

```
littlejot/
├── server/               # Node.js 后端（含内置活动追踪）
│   ├── index.js        # Express 服务器 + API 端点 + 启动追踪
│   ├── storage.js      # 数据存储逻辑
│   ├── tracker.js      # 内置活动追踪（osascript + screencapture）
│   ├── summarizer.js   # AI 总结生成（接入活动数据）
│   └── scheduler.js    # 定时总结调度
├── public/
│   └── index.html      # 前端界面
├── src-tauri/          # （可选）Tauri 菜单栏应用，仅作快捷入口
│   └── ...
├── data/               # 数据存储目录
├── package.json
└── .env               # 环境配置
```

## 运行方式

活动追踪现在**内置在 Node 服务器里**，所以只要一条命令就能跑起整套应用——随手记、任务计时、AI 总结、App / 窗口 / 截图追踪全部到位，不需要再单独编译或启动 Tauri 菜单栏 App。

### 1. 启动（这就是全部）

```bash
cd ~/Desktop/📁\ Projects/littlejot
npm start
```

服务器运行在 http://localhost:4174，活动追踪默认开启。

### 2. 授权 macOS 权限（首次必做）

追踪通过 `osascript` 和 `screencapture` 实现，权限需要授予**运行 `node` 的那个程序**（通常是你的「终端 / iTerm」，而不是某个 App）：

- **辅助功能**：系统设置 → 隐私与安全性 → 辅助功能 → 勾选你的终端 → 用来读取前台 App 名称和窗口标题
- **屏幕录制**：系统设置 → 隐私与安全性 → 屏幕录制 → 勾选你的终端 → 用来定时截图

> 没授权也不会崩溃：服务器照常运行，随手记 / 任务 / 总结都能用，只是不会记录活动。界面上的追踪状态会显示「受限（检查系统权限）」。

### 3. 暂停 / 继续追踪

- 网页右上角「暂停追踪 / 继续追踪」按钮，或
- `curl -X POST localhost:4174/api/tracker/toggle`
- 想彻底关掉自动追踪：在 `.env` 里设 `TRACKING=off`

### 4.（可选）菜单栏 App

`src-tauri/` 下的 Tauri 菜单栏 App 仍可作为一个「打开 Notch」的快捷入口使用，但它**自带的旧追踪逻辑已被服务器内置追踪取代**。两者不要同时开启追踪，否则会记录重复数据——保持 `npm start` 这一条路径即可。

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/today` | GET | 获取今日所有数据 |
| `/api/entries` | POST | 添加随手记 |
| `/api/tasks/start` | POST | 开始任务 |
| `/api/tasks/stop` | POST | 结束任务 |
| `/api/summarize` | POST | 生成 AI 总结 |
| `/api/ask` | POST | 对话问答（`{question, history}`，基于当天数据+活动时间线回答） |
| `/api/activities/:date` | GET | 获取某日活动（apps / windows / screenshots） |
| `/api/activities/status` | GET | 内置追踪器状态（运行中 / 当前 App / 错误） |
| `/api/tracker/toggle` | POST | 暂停 / 继续追踪（`{enabled:true\|false}`，省略则翻转） |
| `/api/activities/apps` | POST | （兼容旧版）外部上报 App 使用 |
| `/api/activities/screenshots` | POST | （兼容旧版）外部上传截图 |
| `/api/activities/heartbeat` | POST | （兼容旧版）外部追踪器心跳 |

## 环境配置 (.env)

```bash
# 数据存储目录
DATA_DIR=./data

# 端口
PORT=4174

# Anthropic API Key（可选，不填则使用简单聚合总结）
ANTHROPIC_API_KEY=

# Claude 模型
ANTHROPIC_MODEL=claude-sonnet-4-6

# 自动总结时间
SUMMARY_SCHEDULE=12:00,18:00,21:00

# 活动追踪开关（off = 不自动记录 App/窗口/截图）
TRACKING=on
```

## 数据格式

每日数据存储在 `data/YYYY-MM-DD.json`：

```json
{
  "date": "2026-05-06",
  "entries": [{ "id", "ts", "text", "tag" }],
  "tasks": [{ "id", "name", "startTs", "endTs", "durationMs" }],
  "summaries": [{ "id", "ts", "slot", "text", "model" }],
  "activities": {
    "apps": [{ "id", "ts", "bundleId", "name", "durationMs" }],
    "windows": [{ "id", "ts", "app", "bundleId", "title", "durationMs" }],
    "screenshots": [{ "id", "ts", "filename" }]
  }
}
```

截图文件存储在 `data/screenshots/YYYY-MM-DD/` 目录。

## 开发

### 重新编译 Tauri App

```bash
cd ~/Desktop/📁\ Projects/littlejot
npm run tauri:build
```

### 测试 API

```bash
node test-tracker.js
```

## 当前状态

- [x] Node.js 服务器
- [x] 前端界面（随手记 / 任务计时 / 小结 / 活动日志）
- [x] 随手记
- [x] 任务计时
- [x] AI 总结（定时 + 手动；接入活动数据；无 Key 时降级为聚合）
- [x] App 使用追踪（内置，真实 App 名）
- [x] 窗口标题追踪（内置）
- [x] 截图功能（内置，每 5 分钟）
- [x] 暂停 / 继续追踪
- [x] 权限受限时优雅降级
- [~] Tauri 菜单栏 App（可选入口；追踪已由服务器内置取代）
- [ ] 键盘记录（已移除——隐私考量，且不在目标功能内）

## 技术栈

- **后端**：Node.js + Express
- **前端**：Vanilla JS + CSS
- **活动追踪**：Node 内置（`osascript` + `screencapture`，仅 macOS）
- **桌面应用（可选）**：Tauri v2 + Rust
- **存储**：本地 JSON 文件
- **API**：Anthropic Claude Messages API（默认 `claude-sonnet-4-6`）
