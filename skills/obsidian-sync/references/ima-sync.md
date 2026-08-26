# ima 同步全流程（Obsidian → 腾讯 ima 知识库）

> 前置：`references/env-and-auth.md` 已完成，ima 凭证就绪（`IMA_OPENAPI_CLIENTID`/`IMA_OPENAPI_APIKEY` 或 `~/.config/ima/` 文件）。
> 统一调用：`node "<SKILL_DIR>/scripts/ima_api.cjs" <子命令> ...`（脚本内部读凭证、发 POST、处理返回）。

## 0. 模型约定

- ima 有「**笔记**」和「**知识库**」两套对象。**Obsidian 文件导入属于知识库**（资料库），不是 ima 笔记。
- 知识库内按**文件夹**组织；文件夹也是「知识条目」的一种。
- Base URL：`https://ima.qq.com`；所有请求 `POST + JSON`，认证头 `ima-openapi-clientid` / `ima-openapi-apikey`。
- 统一响应：`{ "code": 0, "msg": "success", "data": {...}, "request_id": ... }`；`code=0` 成功，否则直接展示 `msg`。脚本 `ima_api.cjs` 的 `isOk()` 同时兼容 `code` 与 `retcode` 两种信封。

## 1. 探测已有知识库（只读）

```powershell
# 1) 当前用户「可添加内容」的知识库列表（先看这个）
node scripts/ima_api.cjs list-kbs

# 2) 知识库详情（id 从上面拿）
node scripts/ima_api.cjs kb-info --ids <kb_id>

# 3) 浏览某知识库根目录（文件 + 文件夹；文件夹条目的 folder_id 可下钻）
node scripts/ima_api.cjs list --kb <kb_id>

# 4) 下钻子文件夹
node scripts/ima_api.cjs list --kb <kb_id> --folder <folder_id>

# 5) 关键词搜索知识库列表 / 库内搜索
node scripts/ima_api.cjs search-kb --query "<关键词>"
node scripts/ima_api.cjs search --kb <kb_id> --query "<关键词>"
```

整理成「知识库名（id）→ 文件夹」树展示给用户。**folder_id 约定**：

- 知识库 ID 是 base64 串（如 `mxd8...pk=`）；根目录的 `folder_id` 是独立数字（`list` 返回的 `current_path[0].folder_id`）。
- **子文件夹的 `folder_id` = 列表项 `media_id` 的完整值 `folder_<数字>`（带 `folder_` 前缀，不是裸数字）**。`add_knowledge`、`get_knowledge_list` 都按这个传。
- 导入到根目录：`add_knowledge` 省略 `folder_id` 即可。

## 2. 询问落点 + 新建

1. 问用户导入到**哪个知识库 + 哪个文件夹**（默认根目录）。
2. **新建能力**：

   ```powershell
   # 新建文件夹（--parent 传父文件夹 media_id `folder_<数字>`；省略则建到知识库根目录）
   node scripts/ima_api.cjs create-folder --kb <kb_id> --name "<名称>" [--parent <父folder_media_id>]
   # 返回 data.media_id = folder_<数字>

   # 新建知识库（type 必填：KBT_MINE_KB 我的 / KBT_SHARED_KB 共享 / KBT_SUBSCRIBED_CREATE_KB）
   node scripts/ima_api.cjs create-kb --name "<名称>" [--type KBT_MINE_KB]
   # 返回 data.id = 新知识库 base64 ID
   ```

   - 新建知识库后重跑 `list-kbs` 拿新 id，再 `list --kb <id>` 拿根目录 folder_id。
   - **`create_folder` 的父参数名是 `folder_id`**（传 `parent_folder_id` 会被静默忽略、文件夹建到知识库根目录，已实测踩坑）。
   - **无删除端点**（`delete_folder` / `delete_knowledge` / `delete_knowledge_base` 均 404）：误建或测试产物只能在 **ima 客户端手动删**。

## 3. 导入

### 3.1 查重 / 增量同步（建议批量开启）

```powershell
# 查重（只读）：返回每个名字是否已存在于目标位置（{name, is_repeated}）
node scripts/ima_api.cjs check-names --kb <kb_id> [--folder <folder_id>] --names "a.md,b.png"

# 一键目录同步默认复用同名文件夹；加 --incremental 则已存在的文件跳过（不产生重复条目）
node scripts/sync_vault_to_ima.cjs --kb <kb_id> --dir <目录> --incremental
```

> **ima 无内容更新端点**：`--incremental` 只能「跳过已存在」，**无法覆盖更新内容**。本地笔记改动后需：ima 客户端手动删旧条目 → 重新导入（或接受旧新并存）。已实测探测：`update_knowledge`/`modify_*`/`delete_*` 均 404，仅 `rename_knowledge`（改名）存在。

### 3.2 导入 Markdown / 图片 / 附件

```powershell
# 单个文件（脚本内部完成 create_media → COS 上传 → add_knowledge）
node scripts/ima_api.cjs import-file --kb <kb_id> --folder <folder_id> --file "<本地文件绝对路径>"
```

media_type 映射（脚本按扩展名自动选，可 `--media-type` 覆盖）：

| 类型                      | media_type | 大小上限               |
| ------------------------- | ---------- | ---------------------- |
| Markdown（.md/.markdown） | 7          | 10MB                   |
| 图片（png/jpg/jpeg/webp） | 9          | 30MB                   |
| PDF                       | 1          | 200MB                  |
| Word（.doc/.docx）        | 3          | 200MB                  |
| PPT（.ppt/.pptx）         | 4          | 200MB                  |
| Excel（.xls/.xlsx/.csv）  | 5          | Excel 200MB / CSV 10MB |
| TXT                       | 13         | 10MB                   |
| Xmind                     | 14         | 10MB                   |

规则：

- **同位置串行**：同一个 `--kb`+`--folder` 下逐文件执行，不要并发。
- **文件名保真**：`title` 必须等于 `file_name`（含扩展名），不重命名、不翻译。
- 二进制文件（图片/PDF 等）上传时**原样传输，不转码**。
- 网页/公众号导入走 `import-url`（media_type 2/6 无需文件上传）：
  ```powershell
  node scripts/ima_api.cjs import-url --kb <kb_id> --folder <folder_id> --urls "https://..."
  ```

### 3.3 导入成功后

返回 `media_id`；记录「本地路径 → 知识库/文件夹 → 标题 → media_id」。

## 4. 校验

```powershell
node scripts/ima_api.cjs list --kb <kb_id> --folder <folder_id>
```

核对目标文件夹下出现了预期 `title`（含扩展名）与 `media_id`。缺的列出来重试。

## 5. 回传

ima 无独立公开链接，回传落位清单：`本地路径 | 知识库名(id) | 文件夹 | 标题 | media_id | 状态`。

## 6. 失败与兜底

- `code!=0`（或 `retcode!=0`）→ 展示 `msg`/`errmsg`，按错误码处理（110020 安全打击/110021 频控/110030 无权限等）。
- **无覆盖更新**：ima API 无更新内容/删除端点（`update_knowledge` 等 404，仅 `rename_knowledge` 存在）；内容变更只能客户端手动删旧后重导。
- COS 签名已按 Tencent COS V5 真机校准（要点见 `ima_api.cjs` 头部注释：secret_key 用原始串、SignKey 先 hex 化、域名用 `bucket_name.cos.region.myqcloud.com`）。再遇 403 先确认凭证未过期；兜底改用官方 SDK（`npm i cos-nodejs-sdk-v5`）或提示用户在 ima 客户端手动导入。
- 图片/附件不保留内嵌位置关系（见 `references/attachments.md`）；用户若强依赖内嵌，建议改飞书。
