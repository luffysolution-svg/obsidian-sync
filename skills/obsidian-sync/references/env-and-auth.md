# 环境检测、依赖自装与认证（跨平台）

本文件是「检测 → 安装 → 认证/凭证」的权威步骤。**Windows 用 PowerShell，macOS/Linux 用 bash**；`lark-cli`、`node` 命令本身跨平台。

## 1. 一键检测（推荐先跑）

```powershell
# Windows（PowerShell）
pwsh -File "<SKILL_DIR>/scripts/env_check.ps1"

# macOS / Linux（bash）
bash "<SKILL_DIR>/scripts/env_check.sh"
```

输出：node / npm / git / lark-cli 版本与是否存在、lark-cli 认证身份、ima 凭证是否存在（脱敏）。按输出缺啥补啥。

## 2. 运行时依赖

| 依赖                                 | 检测                                                                                     | 安装       |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | ---------- |
| Node.js ≥ 18（脚本用全局`fetch`） | `node --version`                                                                       | 引导装 LTS |
| npm                                  | `npm --version`                                                                        | 随 Node    |
| git（技能安装兜底，可选）            | `git --version`                                                                        | 引导安装   |
| `lark-cli`（飞书）                 | `lark-cli --version`；`Get-Command lark-cli`（Win）/ `command -v lark-cli`（Unix） | 见 §3     |

> **Windows 执行策略坑（实测）**：`npm.ps1` 可能报 `cannot be loaded ... not digitally signed`，npm/npx 改 `cmd /c` 包裹；不要在受限沙箱提权 `Set-ExecutionPolicy`。
>
> **Windows PowerShell 5.1 编码坑（实测）**：读无 BOM 的 UTF-8 `.ps1` 会按 ANSI 误读。本 skill 的 `env_check.ps1` 已写成纯 ASCII；新增 PowerShell 脚本务必保持 ASCII 或「UTF-8 with BOM」。

## 3. 安装 lark-cli

```bash
npm install -g @larksuite/cli        # Windows 用 cmd /c "npm install -g @larksuite/cli"
lark-cli --version                   # 注意是 --version / -v，不是 version 子命令
```

## 4. 飞书认证与健康检查

### 4.1 健康检查（只读）

```bash
lark-cli doctor          # config + auth + 连通性
lark-cli auth status     # bot / user 身份状态
lark-cli whoami          # 当前生效身份 + token 状态
```

判定：

- `whoami` 显示 `identity: user` 且 `tokenStatus: ready` → 就绪，进入同步。
- `auth status` 里 **user 身份 `missing` / `tokenStatus: expired`** → 走 4.2 设备流登录。
  - 原因：飞书文档/知识库的创建与导入**默认走 `--as user`**；bot 身份看不到用户个人文档库/知识库。
- `doctor` 报连通性问题 → 检查网络/代理后重跑。

### 4.2 设备流登录

`lark-cli auth login` 是「设备流（Device Flow）」，需用户在浏览器/手机确认。agent 用**分离式**：先拿链接/二维码发给用户，等授权完再用 `device_code` 完成。**绝不在同一轮发完链接又立刻阻塞轮询**。

**第一步：发起授权（立即返回，不阻塞）**

```bash
# bash
export LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1
lark-cli auth login --domain all --no-wait --json
# 按需收窄：--domain docs,drive,wiki（同步需 docs/drive/wiki，可选 markdown）
```

（Windows PowerShell 用 `$env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER='1'` 等）

从 JSON 提取 `verification_url`、`device_code`（`expires_in` 通常 600 秒）。

**第二步：生成二维码（必做，不要只给链接）**

```bash
lark-cli auth qrcode '<verification_url>' --output feishu-login-qr.png   # PNG，--output 用 cwd 下相对路径
lark-cli auth qrcode '<verification_url>' --ascii                       # 无法内联 PNG 时用
```

**第三步：展示给用户，然后结束本轮**

- 顺序：**先 URL，后二维码图**。
- `verification_url` 当 opaque string **原样**展示，不做任何 URL 编码/解码/重拼。
- 优先贴 PNG 二维码图；harness 无法内联图片时退而「可点击链接 + ASCII 二维码（代码块）」。
- 末尾明确告知：「请完成授权后回来告诉我『已授权』」。过期（10 分钟）则重走第一步。

**第四步：用户确认已授权后，由 agent 亲自完成登录**

```bash
lark-cli auth login --device-code '<device_code>' --json
```

成功标志：`event == "authorization_complete"`、`missing: []`，并含 `user_open_id`。

**第五步：验证**

```bash
lark-cli whoami        # 期望 identity: user, tokenStatus: ready
```

### 4.3 认证/调用关键规则

- **不要缓存** `verification_url` / `device_code`：每次需要授权都重新 `--no-wait --json` 生成。
- **必须由 agent 亲自执行 `--device-code`**，不要让用户自己跑。
- 判断成功用 `ok == true`（或进程退出码 0），**不要用 `code == 0`**（成功信封无顶层 `code`/`msg`）。
- `--file` / `--output` 等路径参数**只接受 cwd 下相对路径**。
- 高风险写操作 exit 10 `confirmation_required`：先向用户确认，同意后在原命令末尾追加 `--yes` 重试。

## 5. lark 技能的检测与自装

飞书底层命令的权威文档是 lark-cli **内嵌技能**（版本与 CLI 同步）：

```bash
lark-cli skills list             # 全部内嵌技能（含版本）
lark-cli skills read lark-shared # 认证/权限
lark-cli skills read lark-drive  # 导入/文件夹/搜索
lark-cli skills read lark-wiki   # 知识库空间/节点
lark-cli skills read lark-doc    # 文档内容/附件插入
```

本工作流用到：`lark-shared`、`lark-drive`、`lark-wiki`、`lark-doc`（`lark-markdown` 仅在需要原生 md 时）。

**落地为 harness 可加载的 skill 文件**（`~/.agents/skills/<name>/SKILL.md`）：

```bash
npx skills add larksuite/cli -g -y     # 官方安装（Windows 用 cmd /c "npx skills add larksuite/cli -g -y"）
# 兜底：git clone --depth 1 https://github.com/larksuite/cli 后复制 skills/* 到 skills 目录
```

> 无论是否落地文件，**执行飞书命令前都以 `lark-cli skills read <name>` 的内嵌内容为准**。

## 6. ima 凭证检测、引导配置与验证（首次使用核心）

ima 走 `https://ima.qq.com/openapi/*`，POST + JSON，认证头 `ima-openapi-clientid` / `ima-openapi-apikey`。

### 6.1 一键检测 + 配置（跨平台，推荐）

```bash
node scripts/ima_setup.cjs                        # 检测；缺失则交互式引导配置并验证
node scripts/ima_setup.cjs --check                # 只检测（输出 JSON，脱敏）
node scripts/ima_setup.cjs --set <cid> <key>      # 非交互写入并验证
```

### 6.2 凭证来源（引导用户）

打开 **https://ima.qq.com/agent-interface** 获取 **Client ID** 和 **API Key**（有效期通常一年，过期后需重新获取）。

### 6.3 存放位置（脚本按「环境变量 → 配置文件」优先级读）

- **环境变量**：`IMA_OPENAPI_CLIENTID` / `IMA_OPENAPI_APIKEY`（兼容 `IMA_CLIENT_ID` / `IMA_API_KEY`）
- **配置文件**：`~/.config/ima/client_id` 与 `~/.config/ima/api_key`（`ima_setup.cjs` 自动写这里；跨平台，`~` = 用户主目录）

### 6.4 验证

```bash
node scripts/ima_api.cjs list-kbs        # 返回 code=0 且列出知识库 = 凭证有效
```

> **安全约定**：凭证只作为 header 发给 `ima.qq.com`；文件上传阶段 `create_media` 返回的临时 COS 凭证只发往 `*.myqcloud.com`，用户的 Client ID / API Key 不发给 COS。

## 7. Notion 凭证检测、引导配置与验证

Notion 走 `https://api.notion.com/v1`，认证头 `Authorization: Bearer <token>` + `Notion-Version: 2026-03-11`。

> **国内网络（重要）**：`api.notion.com` 在国内被墙，直连会超时/被掐断。需通过本机代理访问，代理用 `NOTION_PROXY` 环境变量或命令 `--proxy` 传入，支持：
>
> - `http://127.0.0.1:10809`（HTTP CONNECT 代理）
> - `socks5://127.0.0.1:10808`（SOCKS5 代理；v2rayN 默认 SOCKS=10808 / HTTP=10809，clash 默认 7890）
>
> 脚本 `notion_api.cjs` 已内置 SOCKS5 / HTTP 代理隧道（零依赖，`net`+`tls`）。

### 7.1 一键检测 + 配置（跨平台，推荐）

```bash
node scripts/notion_setup.cjs                        # 检测；缺失则交互式引导配置并验证
node scripts/notion_setup.cjs --check                # 只检测（输出 JSON，脱敏）
node scripts/notion_setup.cjs --set <token> [--proxy socks5://host:port]  # 非交互写入并验证
```

### 7.2 凭证来源（引导用户）

1. 打开 **https://www.notion.so/profile/integrations**。
2. **New integration → Internal**，起名（如 `Obsidian Sync`）→ **Submit**。
3. 复制 **Internal Integration Secret**（`ntn_` 或 `secret_` 开头）。
4. **关键**：在你要同步的 Notion 页面/数据库里点右上「**… → Connections**」，**连接刚才创建的 integration**。否则 token 能验证通过但读不到目标内容（报 403）。

### 7.3 存放位置（脚本按「环境变量 → 配置文件」优先级读）

- **环境变量**：`NOTION_TOKEN`（兼容 `NOTION_API_KEY`）
- **配置文件**：`~/.config/notion/token`（`notion_setup.cjs` 自动写这里）

### 7.4 验证

```bash
node scripts/notion_api.cjs whoami        # 返回 bot/workspace/owner = token 有效
```

`whoami` 里的 `max_file_upload_size_in_bytes` 是单文件上传上限（5GB 起步）。

> **身份说明**：Internal Token 是「integration（机器人）」身份，创建的内容作者显示为 integration 名；这是 Notion 官方推荐的稳定方式，不涉及 OAuth 用户授权流程。
