---
name: obsidian-sync
version: 1.6.0
description: "把 Obsidian 笔记（Markdown + 附件）单向同步到飞书云文档/知识库、腾讯 ima 知识库和 Notion。自动检测并安装 lark-cli 与所需技能，飞书走设备流二维码登录，ima 走 Client ID/API Key、Notion 走 Internal Token 引导配置；探测目标已有结构，询问落点，支持目录层级、本地图片与附件导入，完成后校验并回传结果。跨平台（Windows/macOS/Linux）。"
metadata:
  requires:
    bins: ["node", "lark-cli"]
  cliHelp: "lark-cli --help"
---

# obsidian-sync — Obsidian 笔记单向同步到飞书 / ima / Notion

把本地 Obsidian vault（`*.md` + 附件）**单向**发布为飞书在线文档、腾讯 ima 知识库条目，或 Notion 页面树。**Obsidian 是源，飞书/ima/Notion 是输出**；不回写 Obsidian，不做双向合并。

> 跨平台约定：Windows 用 PowerShell，macOS/Linux 用 bash；`lark-cli` / `node` 命令本身跨平台，脚本一律 Node.js（`*.cjs`）。

## 触发与路由

| 用户意图 | 走哪条分支 |
|---|---|
| 同步 / 发布 / 导入到**飞书** | [飞书分支](#飞书分支) |
| 导入到 **ima**（知识库 / 资料库） | [ima 分支](#ima-分支) |
| 同步到 **Notion**（页面 / 数据库） | [Notion 分支](#notion-分支) |
| 多个都要 | 各自独立确认落点，逐一执行 |

## 第 0 步：确认输入（先问清，再动手）

一次性问清（缺失即询问，不要猜）：

1. **Obsidian vault 路径**（绝对路径）。不确定时先只读探测 `*.md` 与附件，再展示候选。
2. **同步范围**：单篇 / 某子目录（递归）/ 整个 vault。
3. **目标平台**：飞书 / ima / Notion / 多个。
4. 预期落点（可留到各分支探测后再问）。

> 只读探测：`Get-ChildItem <vault> -Recurse -File`（PowerShell）或 `find <vault> -type f`（bash）。

## 第 1 步：环境检测与认证（跨平台）

按 [`references/env-and-auth.md`](references/env-and-auth.md) 执行。要点：

1. **一键检测**：`scripts/env_check.ps1`（Windows）/ `scripts/env_check.sh`（macOS/Linux）。
2. **缺 lark-cli** → `npm install -g @larksuite/cli`。
3. **缺 lark 技能** → `npx skills add larksuite/cli -g -y`（或直接用 `lark-cli skills read <name>` 读内嵌技能）。
4. **飞书认证**：设备流 split-flow（`auth login --no-wait --json` → `auth qrcode` 生成二维码 → 用户授权 → `--device-code` 完成）。
5. **ima 凭证**：`node scripts/ima_setup.cjs` —— 自动检测，缺失则**交互式引导**配置 Client ID / API Key 并验证（首次使用核心入口）。
6. **Notion 凭证**：`node scripts/notion_setup.cjs` —— 自动检测，缺失则**交互式引导**配置 Internal Token 并验证；国内需代理（`--proxy socks5://...` 或 `NOTION_PROXY` 环境变量）。

任一依赖装不上 / 无网络 → 停下报告卡点，不硬造命令。

## 飞书分支

详见 [`references/lark-sync.md`](references/lark-sync.md)。核心顺序：

探测已有结构（`wiki +space-list` / `+node-list` / `drive files list`）→ 询问落点（现有 / 新建）→ 目录层级 + 串行导入（`drive +import --type docx`）→ 图片 / 附件（`docs +media-insert`）→ 校验（`drive files list` / `docs +fetch`）→ 回传链接。

## ima 分支

详见 [`references/ima-sync.md`](references/ima-sync.md)。核心顺序：

探测知识库（`list-kbs` / `list`）→ 询问落点 → 支持新建（`create-folder` / `create-kb`）→ 导入（`import-file`，或一键 `sync_vault_to_ima.cjs`）→ 校验（`list`）→ 回传落位清单。

## Notion 分支

详见 [`references/notion-sync.md`](references/notion-sync.md)。核心顺序：

探测已有结构（`whoami` / `search --type page|database`）→ 询问落点（现有页面 / 新建顶层页）→ 目录层级 + markdown→blocks 串行导入（`sync_vault_to_notion.cjs` 或 `import-md`）→ 图片/附件内联上传（`upload-file`）→ 校验（`children`）→ 回传页面链接。

## 附件处理

详见 [`references/attachments.md`](references/attachments.md)。要点：飞书外链图片自动内联、本地图片 `docs +media-insert`；ima 图片 / 附件是独立知识条目（不保留内嵌位置）。

## 飞书 → Obsidian 反向导入（v1.6.0，实验性）

与主流程方向相反：把**飞书在线文档（docx）导入本地 Obsidian vault**。脚本自动完成「导出 → 图片本地化 → 引用改写 → 落盘」：

```powershell
# 单篇（--url 接受完整链接或裸 token）
node scripts/sync_feishu_to_obsidian.cjs --url "<飞书docx链接或token>" --out "<vault目录>" [--attach-dir assets]

# 批量（递归子文件夹；同名文档自动加 -2/-3 后缀；shortcut/原生文件跳过）
node scripts/sync_feishu_to_obsidian.cjs --folder "<飞书文件夹token>" --out "<vault目录>" [--attach-dir assets]
```

**原理与要点（实测）**：

- `lark-cli drive +export --file-extension markdown` 导出正文为标准 markdown（标题/表格/代码块/链接完整）。
- 飞书导出的图片是**时效内链 URL**（`internal-api-drive-stream.feishu.cn/...`），但 authcode 本身就是一次性凭证——**导出后立即 GET 可直接下载**（实测 11/11、133/133 成功），无需额外登录。
- 图片下载到 Obsidian 附件目录（默认每篇同目录 `assets/`），引用改写为相对路径 `![](assets/image-xx.png)`，彻底消除时效问题。
- 自动清理导出元数据首行 `<title>...</title>`。
- **已知限制**：公式块飞书导出为文本（飞书侧限制，非脚本问题）；shortcut 与原生 file 类型跳过；图片必须在导出后立即下载（脚本内部串行完成，无过期窗口）。

> 需要 lark-cli 已安装并完成 user 认证；找不到入口时可设 `LARK_CLI` 环境变量指定命令。

## 校验与回传的统一要求

- 每个写操作后都有**只读校验**，失败即报告，不静默跳过。
- 最终回传表格：`本地路径 | 目标位置 | 标题 | 链接/ID | 状态`。
- 批量中途失败：保留已成功的，单独列出失败项 + 重试命令，不整批回滚。

## 清理 / 回滚同步产物（v1.5.1+）

用户要「删掉 / 清理 / 回滚」之前同步的内容时，按平台删除（**均为破坏性操作，先确认再执行**）：

| 平台 | 删除方式 | 命令 | 说明 |
|---|---|---|---|
| **飞书** | `drive +delete`（移入回收站） | `lark-cli drive +delete --file-token <folder或docx token> --type folder\|docx --as user --yes` | high-risk 操作需 `--yes`；删除异步、CLI 自动轮询；删文件夹递归删除其中全部内容 |
| **Notion** | `--clean` 递归归档（移入回收站） | `node scripts/sync_vault_to_notion.cjs --page <landing_id> --dir <本地目录> --clean` | 先归档叶子页再父级、最后根页，并清除增量缓存；只归档 landing 下的同名根页树，**workspace 级顶层 landing 页 API 删不了，需客户端手动删** |
| **ima** | 无 API 删除端点 | 客户端手动删 | `delete_*` 均 404（实测） |

> 飞书/Notion 的删除都是**移入回收站**（可恢复），不是物理删除；ima 客户端删除同理。删除前如不确定落点，先 `drive files list` / `search --type page` 探测确认。

## 快速命令速查

```powershell
# 飞书
lark-cli doctor / auth status / whoami                          # 检测 / 认证
lark-cli wiki +space-list                                        # 知识库空间
lark-cli drive +import --file x.md --type docx --folder-token <t> # 导入
lark-cli docs +media-insert --file img.png --doc <url> --type image # 插图片
lark-cli docs +update --doc <url> --command overwrite --doc-format markdown --content @x.md # 覆盖更新已存在文档（保留链接；多行内容务必用 @file，直接传 --content 会被拆成位置参数报错）
lark-cli drive +delete --file-token <t> --type folder --yes    # 删除文件夹/docx（移入回收站；high-risk 需 --yes）

# ima
node scripts/ima_setup.cjs                                       # 凭证检测 / 配置
node scripts/ima_api.cjs list-kbs                                # 知识库列表
node scripts/ima_api.cjs import-file --kb <id> --file x.md        # 单文件导入
node scripts/sync_vault_to_ima.cjs --kb <id> --dir <目录>         # 一键目录同步（同名文件夹自动复用）
node scripts/sync_vault_to_ima.cjs --kb <id> --dir <目录> --incremental # 增量：已存在的文件跳过（不产生重复条目）

# Notion（国内加 --proxy socks5://127.0.0.1:10808）
node scripts/notion_setup.cjs                                    # 凭证检测 / 配置
node scripts/notion_api.cjs whoami                               # 验证 token / 看工作区
node scripts/notion_api.cjs search --type page                    # 页面列表
node scripts/notion_api.cjs import-md --parent <id> --file x.md   # 单篇导入
node scripts/sync_vault_to_notion.cjs --page <id> --dir <目录>    # 一键目录同步（幂等：同名页面覆盖更新，不产生重复页）
node scripts/sync_vault_to_notion.cjs --page <id> --dir <目录> --force # 忽略增量缓存，强制全量重写（首次运行默认信任远端建缓存）
node scripts/sync_vault_to_notion.cjs --page <id> --dir <目录> --clean # 清理：递归归档该目录对应的整棵页面树 + 清增量缓存

# 飞书 → Obsidian 反向导入（v1.6.0）
node scripts/sync_feishu_to_obsidian.cjs --url <docx链接> --out <vault目录>   # 单篇（图片自动本地化到 assets/）
node scripts/sync_feishu_to_obsidian.cjs --folder <folder_token> --out <vault目录> # 批量（递归子文件夹）
```

> **Notion 增量同步（v1.5.0+）**：`sync_vault_to_notion.cjs` 默认带内容哈希缓存（`~/.config/obsidian-sync/notion-cache.json`）——页面已存在且本地 md 未变化 → 整页跳过（秒级）；仅本地有改动的页面才「清空旧块重填」覆盖更新（保留 URL、无重复页）。首次运行对已存在页面信任远端现状并建缓存；需要强制全量重写时加 `--force`。

## 边界与限制

- **飞书双向**：`drive +sync` 只同步原生文件、跳过在线 docx，本 skill 只做单向。
- **飞书覆盖更新**：`docs +update --command overwrite` 整文重写（保留文档链接），但会丢失图片/评论，本地图片需重新 `docs +media-insert`；**多行内容必须用 `--content @file` 传（直接内联会被拆成位置参数报 `positional arguments are not supported`）**。
- **飞书文件大小限制（实测）**：`drive +upload` 对 >20MB 文件报 `quota_exceeded / file size beyond limit`（code 1061043），37MB mp4 实测失败；大附件需先压缩或走外链。
- **ima 增量同步**：`--incremental` 按文件名查重跳过已存在条目；**ima 无更新内容/删除端点，内容变更无法覆盖**，需在 ima 客户端手动删旧条目后重新导入。
- **ima 无删除端点**：误建 / 测试产物只能在 ima 客户端手动删。
- **ima 图片不内嵌**：作为独立知识条目（media_type 9），不保留正文内联位置。
- **Notion 幂等覆盖更新（v1.5.0+ 增量）**：同名页面覆盖更新内容（保留页面 URL，不产生重复页）；内容哈希缓存跳过未变化页面，仅改动页重写，未变化重跑秒级完成（`--force` 强制全量）；附件/孤儿附件不重复上传（需要时加 `--with-orphans`）。
- **Notion 是国内被墙服务**：需代理（`NOTION_PROXY` 或 `--proxy`），且 integration 必须先连接目标页面；**直连偶发 `getaddrinfo ENOTFOUND api.notion.com`（DNS 解析失败），重试或显式 `--proxy http://127.0.0.1:10809`（v2rayN HTTP）等本机代理即可**。
- **Notion 大附件限制**：脚本 `uploadFile` 仅实现 `single_part`（≤20MB），更大文件需压缩或外链（multi_part 未实现）；嵌套在无 md 的 `assets/` 子目录下的附件会因「父目录页缺失」被跳过。

## 参考

- [`references/env-and-auth.md`](references/env-and-auth.md) — 环境检测、依赖安装、飞书认证、ima/Notion 凭证引导
- [`references/lark-sync.md`](references/lark-sync.md) — 飞书同步全流程
- [`references/ima-sync.md`](references/ima-sync.md) — ima 同步全流程
- [`references/notion-sync.md`](references/notion-sync.md) — Notion 同步全流程
- [`references/attachments.md`](references/attachments.md) — 附件处理
- [`scripts/ima_setup.cjs`](scripts/ima_setup.cjs) — ima 凭证检测 / 配置 / 验证
- [`scripts/ima_api.cjs`](scripts/ima_api.cjs) — ima API 封装
- [`scripts/sync_vault_to_ima.cjs`](scripts/sync_vault_to_ima.cjs) — ima 一键目录同步
- [`scripts/notion_setup.cjs`](scripts/notion_setup.cjs) — Notion 凭证检测 / 配置 / 验证
- [`scripts/notion_api.cjs`](scripts/notion_api.cjs) — Notion API 封装 + markdown→blocks
- [`scripts/sync_vault_to_notion.cjs`](scripts/sync_vault_to_notion.cjs) — Notion 一键目录同步
- [`scripts/sync_feishu_to_obsidian.cjs`](scripts/sync_feishu_to_obsidian.cjs) — 飞书 → Obsidian 反向导入（图片本地化）
- [`scripts/env_check.ps1`](scripts/env_check.ps1) / [`scripts/env_check.sh`](scripts/env_check.sh) — 环境检测
