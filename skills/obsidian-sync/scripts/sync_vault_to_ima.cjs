#!/usr/bin/env node
'use strict';
/*
 * sync_vault_to_ima.cjs — 把本地目录（含子目录）单向同步进 ima 知识库，保留目录层级。
 *
 * 用法：
 *   node sync_vault_to_ima.cjs --kb <kb_id> --dir <本地目录> [--folder <父folder_media_id>] [--dry-run]
 *
 * 说明：
 *   - 依赖同目录 ima_api.cjs（自动加载 ima 凭证，见 env-and-auth.md）。
 *   - 流程：递归扫描 → 按相对路径串行建文件夹（create_folder）→ 串行导入文件（create_media → COS → add_knowledge）。
 *   - 只导入 media_type 可识别的扩展名（md/pdf/docx/ppt/xlsx/csv/txt/xmind/png/jpg/jpeg/webp），其余跳过。
 *   - ima 无删除端点：本脚本只做「增量新增」，不会删除远端已有条目。
 */

const fs = require('fs');
const path = require('path');
const ima = require('./ima_api.cjs');

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && i + 1 < args.length) ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const kb = argValue(args, '--kb');
  const dir = argValue(args, '--dir');
  const rootFolder = argValue(args, '--folder'); // 目标根文件夹 media_id（省略 = 知识库根目录）
  const dryRun = args.includes('--dry-run');

  if (!kb || !dir) {
    console.error('用法: node sync_vault_to_ima.cjs --kb <kb_id> --dir <本地目录> [--folder <父folder_media_id>] [--dry-run]');
    process.exit(1);
  }
  const rootDir = path.resolve(dir);
  if (!fs.existsSync(rootDir)) { console.error('目录不存在: ' + rootDir); process.exit(1); }

  // 1. 递归收集文件
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  })(rootDir);

  // 2. 按扩展名过滤
  const supported = files.filter(f => ima.mediaTypeFromExt(path.extname(f)) != null);
  const skipped = files.length - supported.length;
  console.log(`发现 ${files.length} 个文件，支持导入 ${supported.length}，跳过 ${skipped}${dryRun ? '（dry-run）' : ''}`);

  // 3. 建文件夹（缓存 相对目录 -> folder media_id；'.' = 目标根，值为 null 表示不传 folder_id）
  const folderCache = new Map();
  folderCache.set('.', rootFolder || null);
  const dirs = new Set();
  for (const f of supported) {
    const sub = path.dirname(path.relative(rootDir, f));
    if (sub && sub !== '.') dirs.add(sub);
  }
  const sortedDirs = [...dirs].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  for (const sub of sortedDirs) {
    const parentRel = path.dirname(sub);
    const parentFid = folderCache.get(parentRel === '.' ? '.' : parentRel);
    if (dryRun) {
      console.log(`[dry-run] 建文件夹 ${sub}（parent=${parentFid || '知识库根'}）`);
      folderCache.set(sub, '(new)');
      continue;
    }
    const r = await ima.createFolder(kb, path.basename(sub), parentFid || undefined);
    if (!ima.isOk(r)) {
      console.error(`建文件夹失败 ${sub}: ${ima.errMsg(r)}`);
      folderCache.set(sub, '__FAILED__'); // 标记失败，后续文件跳过，不要回退到根目录
      continue;
    }
    const fid = r.data.media_id;
    folderCache.set(sub, fid);
    console.log(`建文件夹 ${sub} -> ${fid}`);
  }

  // 4. 串行导入文件
  let ok = 0, fail = 0;
  for (const f of supported) {
    const rel = path.relative(rootDir, f);
    const sub = path.dirname(rel);
    const fid = folderCache.get(sub === '' || sub === '.' ? '.' : sub);
    if (fid === '__FAILED__') { fail++; console.log(`SKIP ${rel} : 父文件夹创建失败`); continue; }
    const mt = ima.mediaTypeFromExt(path.extname(f));
    if (dryRun) { console.log(`[dry-run] 导入 ${rel}（media_type=${mt}，folder=${fid || '知识库根'}）`); ok++; continue; }
    try {
      const r = await ima.importFile({ kb, folder: fid || undefined, file: f, mediaType: mt });
      if (r.ok) { ok++; console.log(`OK   ${rel}`); }
      else { fail++; console.log(`FAIL ${rel} : ${r.add_knowledge ? r.add_knowledge.msg : r.error}`); }
    } catch (e) {
      fail++; console.log(`ERR  ${rel} : ${e.message}`);
    }
  }
  console.log(`\n=== 完成：成功 ${ok}，失败 ${fail} ===`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
