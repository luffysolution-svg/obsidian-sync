#!/usr/bin/env node
'use strict';
/*
 * sync_vault_to_ima.cjs — 把本地目录（含子目录）单向同步进 ima 知识库，保留目录层级。
 *
 * 用法：
 *   node sync_vault_to_ima.cjs --kb <kb_id> --dir <本地目录> [--folder <父folder_media_id>] [--incremental] [--dry-run]
 *
 * 说明：
 *   - 依赖同目录 ima_api.cjs（自动加载 ima 凭证，见 env-and-auth.md）。
 *   - 流程：递归扫描 → 按相对路径串行建文件夹（同名文件夹自动复用，不重复建）→ 串行导入文件。
 *   - --incremental：导入前用 check-names 查重，目标位置已存在的文件【跳过】（增量新增，不产生重复条目）。
 *   - ima 无更新/删除端点：已存在条目的【内容更新无法覆盖】，需在 ima 客户端手动删旧条目后重新导入。
 *   - 只导入 media_type 可识别的扩展名（md/pdf/docx/ppt/xlsx/csv/txt/xmind/png/jpg/jpeg/webp），其余跳过。
 */

const fs = require('fs');
const path = require('path');
const ima = require('./ima_api.cjs');

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && i + 1 < args.length) ? args[i + 1] : undefined;
}

// 列出某 folder（或知识库根）下的条目，返回 [{title, media_id, media_type}]
async function listEntries(kb, folder) {
  const body = { cursor: '', limit: 50, knowledge_base_id: kb };
  if (folder) body.folder_id = folder;
  const r = await ima.postJson(`${ima.KB}/get_knowledge_list`, body);
  if (!ima.isOk(r)) return null;
  return ((r.data && r.data.knowledge_list) || []).map(x => ({ title: x.title, media_id: x.media_id, media_type: x.media_type }));
}

async function main() {
  const args = process.argv.slice(2);
  const kb = argValue(args, '--kb');
  const dir = argValue(args, '--dir');
  const rootFolder = argValue(args, '--folder'); // 目标根文件夹 media_id（省略 = 知识库根目录）
  const incremental = args.includes('--incremental');
  const dryRun = args.includes('--dry-run');

  if (!kb || !dir) {
    console.error('用法: node sync_vault_to_ima.cjs --kb <kb_id> --dir <本地目录> [--folder <父folder_media_id>] [--incremental] [--dry-run]');
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
  console.log(`发现 ${files.length} 个文件，支持导入 ${supported.length}，跳过 ${skipped}${dryRun ? '（dry-run）' : ''}${incremental ? '（增量模式）' : ''}`);

  // 3. 建/复用文件夹（缓存 相对目录 -> folder media_id；'.' = 目标根，值为 null 表示不传 folder_id）
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
      console.log(`[dry-run] 文件夹 ${sub}（parent=${parentFid || '知识库根'}）`);
      folderCache.set(sub, '(new)');
      continue;
    }
    // 父级下已有同名文件夹则复用（幂等，避免重复建文件夹）
    const existing = await listEntries(kb, parentFid || undefined);
    const hit = existing ? existing.find(e => e.media_type === 99 && e.title === path.basename(sub)) : null;
    if (hit) {
      folderCache.set(sub, hit.media_id);
      console.log(`复用文件夹 ${sub} -> ${hit.media_id}`);
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

  // 4. 增量查重（按 folder 分组批量 check-names，命中则跳过）
  const skipNames = new Set();
  if (incremental) {
    const byFid = new Map();
    for (const f of supported) {
      const rel = path.relative(rootDir, f);
      const sub = path.dirname(rel);
      const fid = folderCache.get(sub === '' || sub === '.' ? '.' : sub);
      if (fid === '__FAILED__') continue;
      const key = fid || '';
      if (!byFid.has(key)) byFid.set(key, []);
      byFid.get(key).push(path.basename(f));
    }
    for (const [fid, names] of byFid) {
      for (let s = 0; s < names.length; s += 50) {
        const chunk = names.slice(s, s + 50);
        if (dryRun) { chunk.forEach(n => skipNames.add(n)); continue; }
        const r = await ima.checkNames({ kb, folder: fid || undefined, names: chunk });
        if (ima.isOk(r)) {
          for (const it of (r.data && r.data.results) || []) {
            if (it.is_repeated) skipNames.add(it.name);
          }
        } else {
          console.log(`查重失败（folder=${fid || '根'}）: ${ima.errMsg(r)}，该组不跳过`);
        }
      }
    }
    if (skipNames.size) console.log(`增量：目标位置已存在 ${skipNames.size} 个文件，将跳过`);
  }

  // 5. 串行导入文件
  let ok = 0, fail = 0, skip = 0;
  for (const f of supported) {
    const rel = path.relative(rootDir, f);
    const sub = path.dirname(rel);
    const fid = folderCache.get(sub === '' || sub === '.' ? '.' : sub);
    if (fid === '__FAILED__') { fail++; console.log(`SKIP ${rel} : 父文件夹创建失败`); continue; }
    const mt = ima.mediaTypeFromExt(path.extname(f));
    if (incremental && skipNames.has(path.basename(f))) { skip++; console.log(`SKIP ${rel} : 已存在（增量）`); continue; }
    if (dryRun) { console.log(`[dry-run] 导入 ${rel}（media_type=${mt}，folder=${fid || '知识库根'}）`); ok++; continue; }
    try {
      const r = await ima.importFile({ kb, folder: fid || undefined, file: f, mediaType: mt });
      if (r.ok) { ok++; console.log(`OK   ${rel}`); }
      else { fail++; console.log(`FAIL ${rel} : ${r.add_knowledge ? r.add_knowledge.msg : r.error}`); }
    } catch (e) {
      fail++; console.log(`ERR  ${rel} : ${e.message}`);
    }
  }
  console.log(`\n=== 完成：成功 ${ok}，跳过 ${skip}，失败 ${fail} ===`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
