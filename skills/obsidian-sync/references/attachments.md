# 附件 / 图片处理

Obsidian 里的「附件」分两类，处理方式在飞书和 ima 上完全不同。先识别，再按目标平台处理。

## 1. 识别 vault 内的附件

在目标笔记目录里扫描非 `.md` 文件：

```powershell
$dir = '<目标目录>'
Get-ChildItem -Path $dir -Recurse -File |
  Where-Object { $_.Extension -notin '.md','.markdown','.mark' } |
  Select-Object FullName, Extension, Length
```

常见类型与归属：

| 类型 | 扩展名 | 飞书 | ima |
|---|---|---|---|
| 图片（正文内嵌） | png/jpg/jpeg/gif/webp/bmp | `docs +media-insert` 插进文档 | `media_type=9` 独立条目 |
| 文档类附件 | pdf/docx/xlsx/pptx/txt | `drive +upload` + `docs +media-insert` 挂载 | 按 `media_type` 映射上传 |
| 其他文件 | zip/其他 | `drive +upload` | 不支持则提示手动 |

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

## 4. 附件未找到 / 不支持的兜底

- 图片路径解析失败、或格式不支持 → 不中断整批，在最终结果表里把该附件标为「⚠️ 跳过：原因」。
- 用户必须保留「内嵌位置关系」→ 明确告知 ima 做不到，建议改走飞书（飞书 docx 支持内嵌图片）。
