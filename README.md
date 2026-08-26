# obsidian-sync — Obsidian 笔记单向同步到飞书 / ima / Notion

一个跨平台的 **Agent Skill**：把本地 Obsidian vault（Markdown + 附件）单向同步到 **飞书云文档/知识库**、**腾讯 ima 知识库** 和 **Notion**。

- **飞书**：`lark-cli` + OAuth 设备流（二维码登录）
- **ima**：`ima.qq.com` OpenAPI（Client ID / API Key，含首次使用引导配置）
- **Notion**：官方 API（Internal Token，含首次使用引导配置；国内需代理，脚本内置 SOCKS5/HTTP 隧道）
- 支持目录层级、多篇批量、本地图片、附件导入；完成后校验并回传结果
- **增量同步 + 覆盖更新（v1.4.0）**：重复同步不产生重复条目；飞书 / Notion 支持已存在内容覆盖更新（保留链接），ima 支持查重跳过已存在条目
- **Notion 增量秒级跳过（v1.5.0）**：内容哈希缓存——未变化的页面整页跳过，只重写改动页；全量重写 10-30 分钟 → 未变化重跑数秒（`--force` 可强制全量）
- **清理/回滚同步产物（v1.5.1）**：飞书 `drive +delete`、Notion `--clean` 递归归档整棵页面树、ima 客户端手动删——均有文档化命令
- **飞书 → Obsidian 反向导入（v1.6.0）**：`sync_feishu_to_obsidian.cjs` 一键把飞书 docx 导入 vault——正文标准 markdown + **图片自动本地化到同目录 assets/**（下载飞书时效内链为本地文件，引用改写为相对路径），支持单篇/批量递归
- **Notion → Obsidian 反向导入（v1.6.1）**：`sync_notion_to_obsidian.cjs` 页面树递归导出——blocks→markdown（表格/公式/代码/callout 等）+ 图片走代理下载到 assets/ + `[[wikilink]]` 互链 + frontmatter
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

### 方式三：npm 包（可选）

```bash
npm i -g obsidian-sync-skill
npx skills experimental_sync -y   # 从 node_modules 同步到 agent 目录
```

## 使用

Agent 加载 skill 后，直接说「把 `F:\个人知识库\素材\文章` 同步到飞书 / ima / Notion」即可。skill 会引导完成：

```
环境检测 → 认证/凭证 → 探测落点 → 导入（层级/图片/附件）→ 校验 → 回传
```

> **重复运行是安全的（v1.4.0+）**：Notion / 飞书同名内容覆盖更新，ima 加 `--incremental` 跳过已存在条目；不会产生重复内容。
>
> **Notion 重跑很快（v1.5.0+）**：内容哈希缓存（`~/.config/obsidian-sync/notion-cache.json`）跳过未变化页面，只有改动页被覆盖更新。

## 更新已同步的笔记（v1.4.0+）

本地笔记修改后，重新同步即可：

| 平台 | 重新同步行为 | 命令 |
|---|---|---|
| **飞书** | 同名 docx 整文覆盖更新（链接不变；图片/评论会丢，本地图片需重新插入）。多行内容用 `@file` 传，避免被拆成位置参数 | `lark-cli docs +update --doc <url> --command overwrite --doc-format markdown --content @x.md` |
| **ima** | `--incremental`：新增自动导入、已存在的跳过（不重复）；**内容变更需 ima 客户端手动删旧后重导**（API 无更新端点） | `node scripts/sync_vault_to_ima.cjs --kb <id> --dir <目录> --incremental` |
| **Notion** | 同名页面自动覆盖更新（URL 不变，无重复页）；v1.5.0+ 哈希缓存跳过未变化页面，仅改动页重写 | `node scripts/sync_vault_to_notion.cjs --page <id> --dir <目录>`（加 `--force` 强制全量） |

## 清理 / 回滚同步产物（v1.5.1）

删掉之前同步的内容（均为**移入回收站**，可恢复）：

| 平台 | 命令 |
|---|---|
| **飞书** | `lark-cli drive +delete --file-token <token> --type folder\|docx --as user --yes`（删文件夹递归删内容；high-risk 需 `--yes`） |
| **Notion** | `node scripts/sync_vault_to_notion.cjs --page <landing_id> --dir <本地目录> --clean`（递归归档根页树 + 清增量缓存；workspace 顶层页需客户端手动删） |
| **ima** | API 无删除端点（`delete_*` 404），客户端手动删 |

## 飞书 / Notion → Obsidian 反向导入（v1.6.x，实验性）

把飞书在线文档 / Notion 页面树导入本地 Obsidian vault，图片自动本地化：

```bash
# 飞书：单篇 / 批量（递归子文件夹）
node skills/obsidian-sync/scripts/sync_feishu_to_obsidian.cjs --url "<docx链接或token>" --out "<vault目录>"
node skills/obsidian-sync/scripts/sync_feishu_to_obsidian.cjs --folder "<folder_token>" --out "<vault目录>"

# Notion：页面树递归导出（国内加 --proxy）
node skills/obsidian-sync/scripts/sync_notion_to_obsidian.cjs --page "<page_id>" --out "<vault目录>" --proxy http://127.0.0.1:10809
```

- 飞书：`lark-cli drive +export --file-extension markdown`（表格/代码块/链接完整）；时效内链图片导出后立即下载到同目录 `assets/`
- Notion：blocks→markdown（标题/列表/todo/引用/callout/代码/表格/公式/图片/文件/互链）；图片走代理下载；子页面递归 + `[[wikilink]]`；frontmatter 自动写入
- 附件目录默认 `assets/`（`--attach-dir` 可改）；同名文档自动 `-2/-3` 后缀；均只读不修改远端

## 依赖

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
- **ima 无覆盖更新**：API 无更新内容/删除端点（仅 `rename_knowledge` 存在），内容变更需在 ima 客户端手动删旧条目后重新导入；`--incremental` 可跳过已存在条目避免重复。
- **ima 无删除端点**：误建/测试产物只能在 ima 客户端手动删。
- **ima 图片不内嵌**：作为独立知识条目（media_type 9），不保留正文内联位置。
- **Notion 幂等覆盖更新（v1.5.0+ 增量）**：同名页面覆盖更新内容（保留 URL，不产生重复页）；哈希缓存跳过未变化页（`--force` 强制全量）；workspace 级顶层页面 API 不支持归档/删除，只能客户端手动删。
- **飞书覆盖更新**：`docs +update --command overwrite` 整文重写（保留文档链接；图片/评论会丢，本地图片需重新插入）；多行内容用 `--content @file`。
- **大文件限制（实测）**：飞书 `drive +upload` >20MB 报 `quota_exceeded`（1061043）；Notion `uploadFile` 仅 `single_part` ≤20MB。大附件需压缩或外链。
- **Notion 需代理（国内）**：`api.notion.com` 被墙，走 `--proxy` / `NOTION_PROXY`；直连偶发 `ENOTFOUND`，统一带 `--proxy` 更稳。

## 发布流程（维护者）

每次代码更新，**npx / npm / Release 包三渠道自动同步最新版本**（GitHub Actions 工作流 `.github/workflows/release.yml`）：

```bash
# 1. 改代码并提交
git add -A && git commit -m "feat/fix: ..."
# 2. bump 版本并打 tag（自动更新 package.json 版本号）
npm version patch -m "chore: release v%s"    # 或 minor / major
# 3. 推送（含 tag）
git push && git push --tags
```

推送 `vX.Y.Z` tag 后，Actions 自动完成：

| 渠道 | 动作 |
|---|---|
| **npx** | `npx skills add luffysolution-svg/obsidian-sync` 始终拉取 main 分支最新代码（push 即生效） |
| **npm** | 自动 `npm publish`（需要仓库配置 `NPM_TOKEN` secret；未配置则跳过 npm，其余照常） |
| **Release 包** | 自动打包 `obsidian-sync-vX.Y.Z.zip` 并创建 GitHub Release |

> **版本一致性校验**：Actions 会校验 tag 与 `package.json` 版本一致，不一致直接失败（避免 tag 与包版本错位）。
>
> **兜底**：若推送 tag 后 Actions 未触发（偶发），手动执行同款步骤：打包 `obsidian-sync-vX.Y.Z.zip` → `gh release create vX.Y.Z ... <zip>` → `npm publish`（仓库根目录）。

## License

[MIT](LICENSE)
