# Notion 同步全流程（Obsidian → Notion）

> 前置：`references/env-and-auth.md` 已完成，Notion 凭证就绪（`NOTION_TOKEN` 或 `~/.config/notion/token`）。
> 统一调用：`node "<SKILL_DIR>/scripts/notion_api.cjs" <子命令> ...`（脚本内部读凭证、走代理、处理返回）。

## 0. 模型约定

- **目录 → 页面**，**`.md` 文件 → 子页面**（正文 = markdown 转 blocks），**子目录 → 子页面**。天然保留层级。
- Notion 没有「文件夹」，层级由「页面里的子页面」表达。
- Base URL：`https://api.notion.com/v1`；文件上传走 `https://api.notion.com/v1/file_uploads`（`create` → multipart `send`）。
- 认证头：`Authorization: Bearer <token>` + `Notion-Version: 2026-03-11`。
- **Token 是 integration（机器人）身份**，只能访问「被显式连接了该 integration」的页面/数据库。用户自己的页面必须点「… → Connections → 连接该 integration」。
- 国内直连 `api.notion.com` 会被墙，需代理：`--proxy socks5://127.0.0.1:10808`（v2rayN 默认 SOCKS 10808/HTTP 10809；clash 默认 7890）。

## 1. 探测已有结构（只读）

```powershell
# 验证 token + 看集成身份/工作区
node scripts/notion_api.cjs whoami

# 列出数据库
node scripts/notion_api.cjs search --type database

# 列出页面（顶层 + 嵌套）
node scripts/notion_api.cjs search --type page

# 下钻：看某页面子块 / 子页面
node scripts/notion_api.cjs children --id <page_id>
```

整理成「页面树 / 数据库列表」给用户。要点：

- 顶层页面 `parent.type == "workspace"`；其余是子页面或数据库条目。
- 数据库页面 `parent.type == "database_id"`；同步到数据库需要适配其 schema（title + 各属性），本 skill 默认走**页面树**，不写数据库条目。
- `whoami` 里 `max_file_upload_size_in_bytes` 是单文件上传上限（5GB 起步）。

## 2. 询问落点 + 新建

1. 问用户落到**哪个顶层页面**（或某个现有页面下），以及是否**新建一个根页**（推荐，标题默认取目录名）。
2. 新建能力（脚本走 `POST /pages`，`parent` 可为 `workspace` / `page_id` / `database_id`）：

   ```powershell
   # 新建顶层页面（parent=workspace）
   node scripts/notion_api.cjs create-workspace-page --title "<标题>"

   # 在某页面下新建子页面
   node scripts/notion_api.cjs create-page --parent <page_id> --title "<标题>"
   ```

   - 新建顶层页面后重跑 `search --type page` 拿新 page_id。
   - **integration 权限**：新建页面由 integration 创建，自动可访问；但把内容同步进用户已有的页面/数据库前，必须先给该 integration 连接权限，否则报 `object:error / status:403`。

## 3. 导入

### 3.1 单篇 md

```powershell
node scripts/notion_api.cjs import-md --parent <page_id> --title "<标题>" --file "<绝对路径>"
```

脚本内部：建页 → `markdownToBlocks` 转 blocks → 内联图片/附件 `uploadFile` 上传 → 分块（≤100/次）`PATCH /blocks/{id}/children`。

### 3.2 一键目录同步（推荐）

```powershell
node scripts/sync_vault_to_notion.cjs --page <landing_page_id> --dir "<本地目录>" [--title <根页标题>] [--dry-run] [--with-orphans] [--force]
```

流程：

1. 递归扫描（跳过 `.` 开头隐藏文件/目录）。
2. **阶段一**：建页面树 —— 根页 → 目录页 → md 页，记录「相对路径 → page id/url」。
3. **阶段二**：逐 md 转 blocks 填充；`[[wikilink]]` 解析成已建页面的 Notion 链接；`![](图)` / `![[图]]` 内联上传成 image 块。
4. **孤儿附件**：未被任何 md 引用的本地文件，追加到其目录页的「附件」分区（`--skip-orphans` 关闭；仅新建页面或显式 `--with-orphans` 时上传）。

**增量跳过（v1.5.0+，解决全量重写慢）**：

- 脚本维护内容哈希缓存 `~/.config/obsidian-sync/notion-cache.json`（按同步目录绝对路径分命名空间，记录「相对路径 → { sha256, pageId }」）。
- 页面已存在且缓存哈希与本地 md 一致、页面 id 未变 → **整页跳过**（`SKIP 内容未变化`），不做任何 API 写操作；仅哈希变化的页面才「清空旧块重填」（`UPD`）。
- **首次运行**（缓存为空）：对已存在的同名页面**信任远端现状**，只记录哈希后跳过（避免首次运行全量重写耗时 10-30 分钟）；需要强制全量重写时加 `--force`。
- 删除旧块已改为**并发 3**（原逐块串行），配合 Notion 3 req/s 限流的 429 退避重试。
- 实测：37 篇笔记全量重写约 10-30 分钟 → 优化后未变化重跑仅需数秒，只重写改动页。

### 3.3 清理同步产物（--clean，v1.5.1+）

删除/回滚之前同步的整棵页面树（先归档叶子页 → 目录页 → 根页，全部移入回收站），并清除该目录的增量缓存：

```powershell
node scripts/sync_vault_to_notion.cjs --page <landing_page_id> --dir "<本地目录>" --clean
```

- 只清理 landing 下与目录名同名的**根页**及其子树；找不到根页时报「已删除或从未同步」并安全退出。
- 归档 = 移入回收站（可恢复），非物理删除；`workspace` 级顶层 landing 页本身 API 不支持归档/删除，需客户端手动删（建议把根页建在普通页面下便于整树清理）。
- 清理后增量缓存自动清除，下次同步会重建全部页面。

### 3.4 markdown → blocks 支持度

| Markdown | Notion 块 |
| --- | --- |
| `#` `##` `###` | heading_1/2/3 |
| 段落、空行 | paragraph |
| `-` `*` 无序 | bulleted_list_item |
| `1.` 有序 | numbered_list_item |
| `- [ ]` `- [x]` | to_do |
| `> 引用` | quote |
| `> [!NOTE] 标题` | callout（note/info/warning/tip/danger 等映射图标） |
| ` ```lang ` | code（语言映射） |
| `---` | divider |
| `\| a \| b \|` 表格 | table |
| `$$...$$` / `$...$` | equation |
| `![](图)` / `![[图]]` | image（本地自动上传，外链直接用） |
| `[文字](url)` / `[[wiki]]` | 带链接富文本 / 页面互链 |
| `**粗** *斜* `码` ~~删~~ | 富文本 annotations |
| YAML frontmatter | 跳过 |

未覆盖：脚注、Mermaid 图、嵌套列表缩进（按平级处理）、Obsidian 自定义语法。复杂笔记建议先飞书（docx 导入保真度更高）。

## 4. 校验

```powershell
node scripts/notion_api.cjs children --id <根页_id>      # 看根页下是否出现预期子页面
node scripts/notion_api.cjs children --id <md页_id>      # 看正文块是否就位
```

核对页面树与预期目录一致；缺的列出来重跑（脚本幂等：同名页面覆盖更新，不会新建同名页）。

## 5. 回传

Notion 有公开链接：`createPage` 返回的 `url`（`https://www.notion.so/<slug>-<id>`，或 `https://www.notion.so/<id去横杠>`）。回传清单：

`本地路径 | 目标页面 | 标题 | 链接 | 状态`

## 6. 失败与兜底

- `object:"error", status:401` → token 无效/被删；重走 `notion_setup.cjs`。
- `getaddrinfo ENOTFOUND api.notion.com`（实测偶发）→ 本机 DNS 解析失败，重试；或显式 `--proxy http://127.0.0.1:10809`（v2rayN HTTP）/ `--proxy socks5://127.0.0.1:10808`。
- `status:403` → integration 没连接目标页面；让用户在页面「… → Connections」里添加该 integration。
- `status:429` → 触发限流（3 req/s），脚本已带退避重试；仍频繁则降低并发、串行。
- 文件上传 403/超时 → 确认代理可达 `api.notion.com`（`/v1/file_uploads` 同域，无需额外放行）。上传分两步：`POST /v1/file_uploads` 建对象 → `POST .../send`（`multipart/form-data`，文件在 `file` 字段）；不要改成 PUT 原始字节。
- **幂等覆盖更新（v1.4.0+）**：`sync_vault_to_notion.cjs` 默认「同名页面存在则覆盖更新内容」（按标题找子页面 → 清空旧子块 → 重填，保留页面 URL），重复运行不产生重复页；本地笔记更新后重跑即可同步。查找子页面优先列父页子块（强一致），搜索索引延迟时不会误判。
- **增量跳过（v1.5.0+）**：哈希缓存（见 §3.2）跳过未变化页面；`--force` 强制全量重写。删除块并发 3。
- **归档/删除**：子页面可用 `PATCH /pages/{id} {in_trash:true}` 归档（`archive-page` 子命令）；**workspace 级顶层页面 API 不支持归档/删除**，只能进 Notion 客户端手动删。脚本同步时建议把根页建在某个普通页面下，便于整树归档。
- **大附件（实测）**：`uploadFile` 仅实现 `single_part`（上限 20MB），37MB mp4 实测无法上传；需压缩或改外链（`multi_part` 未实现）。嵌套在无 md 的 `assets/` 子目录下的附件会因「父目录页缺失」被跳过——把附件放到有 md 的目录，或先建对应目录页。

## 7. 限制

- **不做双向**：只 Obsidian → Notion，不回写、不 diff、不删除远端。
- **不写数据库条目**：默认页面树；如需把每条笔记做成数据库行（带标签/日期等属性），需单独适配 schema。
- **integration 身份**：创建者是 bot，页面作者显示为 integration；如需「本人」作者，需用 OAuth（本 skill 暂用 Internal Token，简单可靠）。
