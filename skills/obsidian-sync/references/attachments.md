# 附件 / 图片处理

Obsidian 里的「附件」分两类，处理方式在飞书、ima、Notion 上各不相同。先识别，再按目标平台处理。

> 反向方向（飞书 / Notion → Obsidian 导入）的附件处理：图片自动本地化到 vault 附件目录（`sync_feishu_to_obsidian.cjs` / `sync_notion_to_obsidian.cjs`），详见 SKILL.md「飞书 / Notion → Obsidian 反向导入」章节。

## 1. 识别 vault 内的附件

在目标笔记目录里扫描非 `.md` 文件：

```powershell
$dir = '<目标目录>'
Get-ChildItem -Path $dir -Recurse -File |
  Where-Object { $_.Extension -notin '.md','.markdown','.mark' } |
  Select-Object FullName, Extension, Length
```

常见类型与归属：

| 类型 | 扩展名 | 飞书 | ima | Notion |
|---|---|---|---|---|
| 图片（正文内嵌） | png/jpg/jpeg/gif/webp/bmp | `docs +media-insert` 插进文档 | `media_type=9` 独立条目 | 内联 `image` 块（`uploadFile` 上传后 `image.file.url`） |
| 文档类附件 | pdf/docx/xlsx/pptx/txt | `drive +upload` + `docs +media-insert` 挂载 | 按 `media_type` 映射上传 | `file` 块（内联或目录页「附件」分区） |
| 其他文件 | zip/其他 | `drive +upload` | 不支持则提示手动 | `file` 块（`api.notion.com/v1/file_uploads` 上传，single_part ≤20MB） |

**图片引用解析**：Markdown 里本地图片有三种写法，都要先解析成磁盘路径：

```md
![[diagram.png]]            ← Obsidian wiki 图片（相对 vault 根或附件目录）
![[diagram.png|600]]        ← 带尺寸，忽略尺寸部分
![架构图](../assets/x.png)   ← 标准相对路径
```

解析顺序：优先按「当前笔记所在目录相对路径」找；找不到再按「vault 根 + 文件名」递归定位；都找不到则跳过该图并在结果里标注「图片未找到」。HTTP(S) 图片不需要本地处理。

## 2. 飞书：图片与附件

> 执行前先 `lark-cli skills read lark-doc`（`+media-insert` 的 4 步编排 + 回滚）与 `lark-cli skills read lark-drive`（`+upload`）。

- **HTTP(S) 图片**：无需手动处理，`drive +import` 导入时服务端直接渲染成 `<img>` 块（已实测）。
- **本地图片（`![[x]]`/相对路径）**：`+import` 不解析本地图，导入成 docx 后逐张插入：
  ```powershell
  lark-cli docs +media-insert --file "<相对路径>" --doc "<docx url 或 token>" --type image
  ```
  `--file` 只接受 cwd 下相对路径；图片已在剪贴板时优先 `--from-clipboard`。**默认追加到文档末尾**（非原 inline 位置，已实测）。
- **非图片附件（PDF/docx/zip 等，已实测）**：
  1. 上传到 Drive：`lark-cli drive +upload --file "<相对路径>" --folder-token <token>` → 返回 `data.file_token` 与 `data.url`。
  2. 挂进文档（可选）：`lark-cli docs +media-insert --type file --file "<相对路径>" --doc "<docx url>"` → 在文档末尾生成 `<figure view-type="Card">` 附件下载卡。
  - 只需云端留档时做第 1 步即可，得到 `https://.../file/<file_token>` 链接。

注意：`drive +import` 只把单个 `.md` 转 docx，**不解析相对路径本地图片**；这也是为什么本地图片要单独 `+media-insert`。

## 3. ima：图片与附件是并列知识条目

ima 知识库是「资料库」形态，不是文档编辑器：**图片/附件不保留「内嵌在正文某段」的位置关系**，而是与 Markdown 文件并列的知识条目。逐条上传即可，见 `references/ima-sync.md` 的 `import-file` 与 media_type 映射。

- 图片：`media_type=9`（≤30MB，png/jpeg/webp）
- Markdown：`media_type=7`（≤10MB）
- PDF/Word/PPT/Excel/TXT/Xmind：按扩展名映射对应 `media_type`（1/3/4/5/13/14）
- 视频/音频解析、Bilibili/YouTube URL：**API 不支持**，提示用户在 ima 桌面端手动添加。

## 4. Notion：图片内联、附件挂 file 块

Notion 的文件上传走 **Direct Upload**（`api.notion.com/v1/file_uploads`），本地图片/附件**先上传拿到 `file_upload.id`**，再作为 block 引用：

- **图片**：`![](图)` / `![[图]]` 在 markdown 转 blocks 时变成 `image` 块，**保留内联位置**：
  ```json
  { "type": "image", "image": { "type": "file_upload", "file_upload": { "id": "<file_upload_id>" } } }
  ```
  HTTP(S) 图片直接用 `{ "type": "external", "external": { "url": ... } }`，无需上传。
- **非图片附件**：`[[file.pdf]]` / `[文字](file.pdf)` 被引用 → 上传后挂 `file` 块；**未被引用的孤儿附件** → 追加到其目录页的「附件」分区（`sync_vault_to_notion.cjs` 默认行为，`--skip-orphans` 关闭）。
- 上传流程（三步）：`POST /v1/file_uploads`（拿 `id`）→ `POST /v1/file_uploads/{id}/send`（`multipart/form-data`，文件在 `file` 字段）→ 用 `id` 写 `file_upload` 类型的 image/file 块。**`send` 是 multipart，不是 PUT 原始字节**。

> 与飞书的区别：飞书本地图默认插到**文档末尾**（非 inline）；Notion 图片能**内联**在原位置。与 ima 的区别：ima 图片是独立条目、不保留位置；Notion 保留。

## 5. 附件未找到 / 不支持的兜底

- 图片路径解析失败、或格式不支持 → 不中断整批，在最终结果表里把该附件标为「⚠️ 跳过：原因」。
- 用户必须保留「内嵌位置关系」→ Notion 与飞书都支持（Notion 内联、飞书末尾）；ima 做不到，建议改走飞书或 Notion。
