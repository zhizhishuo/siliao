<div align="center">

# 💬 Siliao — Team Chat System

**A full-featured internal team chat system built with React + Express + Socket.IO**

**一套功能完整的内部团队聊天系统，基于 React + Express + Socket.IO 构建**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express)](https://expressjs.com/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4-010101?logo=socket.io)](https://socket.io/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite)](https://vite.dev/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Quick Start](#quick-start--快速开始) · [Features](#features--特性) · [Contributing](CONTRIBUTING.md)

</div>

---

## Why / 为什么

Internal teams need a simple, self-hosted chat tool that works out of the box — without relying on third-party SaaS or complex infrastructure. Siliao provides private messaging, group channels, file sharing, search, notifications, and admin controls in a single deployable package.

内部团队需要一个开箱即用、可自托管的聊天工具，不依赖第三方 SaaS 或复杂基础设施。Siliao 在一个可部署的包里提供了私聊、群聊、文件共享、搜索、通知和管理员后台。

## Features / 特性

- 🔐 **Login** — Username/password authentication with JWT
- 💬 **Direct Messages** — One-on-one private chat with real-time sync
- 👥 **Group Channels** — Create channels, invite members, manage membership
- 📎 **File Upload** — Share files/images up to 10MB per message
- 🔍 **Global Search** — Search across all private and group messages
- 🔔 **Unread Counts** — Persistent per-thread unread badges + notification center
- ↩️ **Message Recall** — Recall your own messages (syncs to all participants)
- 👑 **Admin Console** — System overview, user role management, channel deletion
- 📱 **Responsive** — Works on desktop and mobile browsers
- ⚡ **Real-time** — Socket.IO powered instant message delivery
- 🎨 **Polished UI** — Lucide icons, glass morphism, Slack/Linear-inspired layout

## Quick Start / 快速开始

```bash
# Clone
git clone https://github.com/zhizhishuo/siliao.git
cd siliao

# Install
npm install

# Run (starts both frontend and backend)
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

### Demo Accounts / 演示账号

All passwords are `password123`:

| Username | Display Name | Role |
|----------|-------------|------|
| `li.lei` | 李雷 | Admin |
| `han.mei` | 韩梅梅 | Member |
| `wang.wei` | 王伟 | Member |

A default channel `全员群` is created automatically.

## How It Works / 工作原理

```
┌─────────────┐     WebSocket      ┌─────────────┐
│  React App  │◄──────────────────►│  Express +   │
│  (Vite)     │     REST API       │  Socket.IO   │
│  Port 5173  │◄──────────────────►│  Port 3001   │
└─────────────┘                    └──────┬───────┘
                                          │
                                   ┌──────┴───────┐
                                   │   SQLite DB   │
                                   │  + File Store │
                                   └──────────────┘
```

## Tech Stack / 技术栈

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Vite 8, Socket.IO Client, Lucide Icons |
| Backend | Express 5, Socket.IO 4, Better-SQLite3, JWT, Multer, bcrypt |
| Storage | SQLite (WAL mode) + local file uploads |
| Dev Tools | ESLint, Nodemon, Concurrently |

## Project Structure / 目录结构

```
frontend/       React Web client (Vite + TypeScript)
backend/        Express API, Socket.IO, SQLite, uploads
```

## Contributing / 贡献

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md).

欢迎贡献！请阅读[贡献指南](CONTRIBUTING.md)和[行为准则](CODE_OF_CONDUCT.md)。

## License / 许可证

[MIT](LICENSE) © 2026 zhizhishuo

---

<div align="center">

**If this project helps you, give it a ⭐**

**如果这个项目对你有帮助，请给一个 ⭐**

</div>
