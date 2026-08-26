# 飞书同步全流程（Obsidian → 飞书云文档 / 知识库）

> 前置：`references/env-and-auth.md` 已完成，`lark-cli doctor` + `auth status` 显示 user 身份 `ready`。
> 权威命令文档：执行前按需 `lark-cli skills read lark-drive` / `lark-wiki` / `lark-doc` / `lark-shared`。

## 0. 术语

- **云盘/云空间（Drive）**：文件、文件夹、在线文档（docx）都住这里；个人根目录即「我的空间」。
- **知识库（Wiki）**：`space`（知识空间）→ `node`（节点，可嵌套）；个人文档库是内置空间 `my_library`。
- 把 md **导入成在线文档**：`drive +import --type docx`（本流程主路径）。
- 把 md 当**原生 Markdown 文件**上传：`lark-cli markdown`（`lark-markdown` 技能），团队协作可读性差，默认不用。

## 1. 探测已有结构（只读，给用户可选落点）

```powershell
# 1) 知识库空间列表（注意：不含个人文档库 my_library）
lark-cli wiki +space-list --format json

# 2) 个人文档库（我的空间）根节点
lark-cli wiki +node-list --space-id my_library --as user --format json

# 3) 某个知识库空间下的根节点
lark-cli wiki +node-list --space-id <space_id> --format json

# 4) 云盘根目录清单（不传 folder-token = 根目录）
lark-cli drive files list --format json

# 5) 按关键词兜底搜索
lark-cli drive +search --query "<关键词>" --format json
```

把结果整理成「可选落点清单」展示给用户：`位置类型（云盘文件夹 / 知识库空间 / 知识库节点）| 名称 | token`。

## 2. 询问落点：现有 or 新建

给用户两个选项：

- **A. 导入到现有位置**：用户从第 1 步清单里挑一个，记下其 `folder_token`（云盘）或节点对应的底层 `obj_token`。
- **B. 新建位置**（写操作，确认后执行）：
  ```powershell
  # 新建云盘文件夹（--folder-token = 父文件夹 token；省略会建到云盘根目录）
  lark-cli drive +create-folder --name "<名称>" --folder-token <父folder_token>
  # ⚠️ 返回 data.folder_token（不是 data.token）。建错位置：drive +move --file-token <t> --folder-token <父> --type folder

  # 新建知识库空间（仅 --as user；--name 必填）
  lark-cli wiki +space-create --name "<名称>" --as user

  # 在知识库空间/节点下新建节点（节点 = 文档或子目录，自动解析空间）
  lark-cli wiki +node-create --space-id <space_id> [--parent-node-token <token>] --title "<标题>"
  ```
  拿到新建目标 token 后再继续。

> 知识库 wiki URL 不能直接当 `file_token`，用 `lark-cli drive +inspect --url '<url>'` 解包拿到底层 `token`/`type`。

## 3. 导入（目录层级 + 串行）

**目录层级**：按 Obsidian 目录结构，逐层 `drive +create-folder` 建文件夹（记录「本地相对目录 → folder_token」映射），再逐文件导入。

**导入单篇**（md → 在线 docx）：

```powershell
# ⚠️ --file 只接受 cwd 下的相对路径（绝对路径报 unsafe file path）。
# 把 workdir 设到 vault 目录（或目标子目录），再用相对路径：
lark-cli drive +import --file "<相对路径.md>" --type docx --folder-token <目标folder_token> [--name "<标题>"]
```

规则（务必遵守）：

- `.md/.markdown/.mark` 只能导入为 `docx`；`.md` 大小上限 20MB。
- **同一目标位置必须串行**：一个 `--folder-token`（或都省略）下的多个 `+import` 不要并发；逐个执行、每个完成后等它返回。
- 未传 `--name` 时标题取文件名（去扩展名）；导入前可提示用户是否重命名，避免与正文首行标题重复。
- 返回 `ready=false`/`timed_out=true` → 用返回的 `next_command`（`lark-cli drive +task_result --scenario import --ticket <ticket>`）续查，直到 `ready=true`。

**批量编排（实测可用的 PowerShell 串行循环，workdir = vault 目录）**：

```powershell
# workdir 设为 vault 目录（如 F:\个人知识库）；lark-cli.ps1 用绝对路径调用
$cli = 'C:\node.js\<node版本>\lark-cli.ps1'
$map = @{ '子目录A'='<folder_token_A>'; '子目录B'='<folder_token_B>' }  # 本地子目录名 → 飞书 folder_token
# 用 -Filter（PS5.1 下 -Include 配 -LiteralPath 不生效，会误把 pdf/docx/png 都算进来）
$files = Get-ChildItem -Recurse -File -Filter *.md
foreach ($f in $files) {
  $rel = $f.FullName.Substring((Get-Location).Path.Length).TrimStart('\')   # 相对路径
  $tok = $map[$f.Directory.Name]                                            # 按父目录名映射 folder_token
  if (-not $tok) { Write-Output "SKIP $rel"; continue }
  $raw = (& $cli drive +import --file $rel --type docx --folder-token $tok --json 2>&1 | Out-String)
  # 成功信封 { ok:true, data:{ ready:true, token, url } }；data.url 即链接。ready=false 用 next_command 续查
}
```

要点（已实测）：中文文件名 / 空格 / 全角符号经 `lark-cli.ps1` shim 传参均正常；同名文件夹串行导入 0 失败。

## 4. 图片与附件

见 `references/attachments.md`。要点（实测）：

- **外链图片（HTTP/HTTPS）**：`drive +import` 直接渲染成 `<img>` 块，无需额外处理。
- **本地图片（`![[x]]`/相对路径）**：`+import` 不处理，需 `docs +media-insert --file <相对路径> --doc <url> --type image` 逐张插入，且**追加到文档末尾**（非原位）。
- **非图片附件**：`drive +upload` 上传拿 `file_token`，再 `docs +media-insert --type file` 挂到文档。

## 5. 校验

```powershell
# 目标文件夹应有全部预期条目
lark-cli drive files list --folder-token <token> --format json

# 抽查正文与图片：data.document.content 是 XML，数 <img 块验证图片是否渲染
lark-cli docs +fetch --doc "<docx url 或 token>"
```

对比「本地文件数 vs 云端条目数」，缺的列出来重试；图片用 `([regex]::Matches($content,'<img\b')).Count` 核对数量。

## 6. 回传

汇总为表格：`本地路径 | 目标位置 | 标题 | 飞书链接 | 状态`。链接形如 `https://<租户>.feishu.cn/docx/<docx_token>`（或 larksuite.com）。

## 7. 已知限制

- **双向同步**：`drive +sync` 只同步 `type=file` 原生文件，**跳过在线 docx 与快捷方式**；故「Obsidian↔飞书 docx 双向」无官方现成方案，本 skill 只做单向。
- **附件内嵌**：非图片附件上传后是独立文件/文档块，不保留正文内嵌关系。
- **并发冲突**：报 `232140101 / 232140100 / 233523001` 时改串行 + 间隔几秒重试，最多 3 次。
