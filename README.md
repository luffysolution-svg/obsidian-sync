# obsidian-sync — Obsidian 笔记单向同步到飞书 / ima / Notion

一个跨平台的 **Agent Skill**：把本地 Obsidian vault（Markdown + 附件）单向同步到 **飞书云文档/知识库**、**腾讯 ima 知识库** 和 **Notion**。

- **飞书**：`lark-cli` + OAuth 设备流（二维码登录）
- **ima**：`ima.qq.com` OpenAPI（Client ID / API Key，含首次使用引导配置）
- **Notion**：官方 API（Internal Token，含首次使用引导配置；国内需代理，脚本内置 SOCKS5/HTTP 隧道）
- 支持目录层级、多篇批量、本地图片、附件导入；完成后校验并回传结果
- 跨平台（Windows / macOS / Linux）

## 安装

### 方式一：npx skills（推荐）

```bash
# 安装到所有已检测到的 agent
npx skills add luffysolution-svg/obsidian-sync

# 或指定 agent（Claude Code / Codex / OpenCode / Pi / Hermes 等）
npx skills add luffysolution-svg/obsidian-sync -a claude-code -a codex -a opencode -a pi -a hermes-agent -y

# 全局安装
npx skills add luffysolution-svg/obsidian-sync -g -y
```

支持 76+ agent：Claude Code、Codex、OpenCode、Pi、Hermes、Cursor、Gemini CLI、GitHub Copilot 等。

### 方式二：手动下载 zip

1. 从 [Releases](https://github.com/luffysolution-svg/obsidian-sync/releases) 下载 `obsidian-sync-vX.Y.Z.zip`
2. 解压，把 `obsidian-sync/` 目录放到对应 agent 的 skills 目录：

| Agent | 目录 |
|---|---|
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| OpenCode | `~/.config/opencode/skills/` |
| Pi | `~/.pi/agent/skills/` |
| Hermes | `~/.hermes/skills/` |

## 使用

Agent 加载 skill 后，直接说「把 `F:\个人知识库\素材\文章` 同步到飞书 / ima / Notion」即可。skill 会引导完成：

```
环境检测 → 认证/凭证 → 探测落点 → 导入（层级/图片/附件）→ 校验 → 回传
```

### 依赖

- **Node.js ≥ 18**（脚本用全局 `fetch`）
- **飞书**：`npm i -g @larksuite/cli`（首次使用需设备流二维码登录）
- **ima**：`node scripts/ima_setup.cjs` 引导配置 Client ID / API Key（来源 https://ima.qq.com/agent-interface）
- **Notion**：`node scripts/notion_setup.cjs` 引导配置 Internal Token（来源 https://www.notion.so/profile/integrations；国内需代理 `--proxy socks5://127.0.0.1:10808` 或 `NOTION_PROXY` 环境变量）

## 仓库结构

```
skills/obsidian-sync/
├── SKILL.md              # 主入口（路由 + 流程）
├── references/           # 环境认证 / 飞书 / ima / Notion / 附件
│   ├── env-and-auth.md
│   ├── lark-sync.md
│   ├── ima-sync.md
│   ├── notion-sync.md
│   └── attachments.md
└── scripts/              # 可执行脚本（Node 跨平台）
    ├── env_check.ps1 / env_check.sh   # 环境检测
    ├── ima_setup.cjs                  # ima 凭证检测/配置/验证
    ├── ima_api.cjs                    # ima API 封装
    ├── sync_vault_to_ima.cjs          # ima 一键目录同步
    ├── notion_setup.cjs               # Notion 凭证检测/配置/验证
    ├── notion_api.cjs                 # Notion API 封装 + markdown→blocks
    └── sync_vault_to_notion.cjs       # Notion 一键目录同步
```

## 边界与限制

- **单向同步**：Obsidian 是源，飞书/ima/Notion 是输出；不做双向合并。
- **ima 无删除端点**：误建/测试产物只能在 ima 客户端手动删。
- **ima 图片不内嵌**：作为独立知识条目（media_type 9），不保留正文内联位置。
- **Notion 无覆盖写**：API 无法按标题幂等更新，重复同步会新增同名页。
- **Notion 需代理（国内）**：`api.notion.com` 被墙，走 `--proxy` / `NOTION_PROXY`。

## License

[MIT](LICENSE)
