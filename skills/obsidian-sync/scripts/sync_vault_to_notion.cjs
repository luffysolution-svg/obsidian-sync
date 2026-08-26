#!/usr/bin/env node
'use strict';
/*
 * sync_vault_to_notion.cjs — 把本地目录（含子目录）单向同步进 Notion，保留目录层级。
 *
 * 用法：
 *   node sync_vault_to_notion.cjs --page <page_id> --dir <本地目录> [--title <根页标题>] [--dry-run] [--with-orphans] [--force] [--proxy socks5://host:port]
 *
 * 说明：
 *   - 依赖同目录 notion_api.cjs（自动加载 Notion token，见 env-and-auth.md）。
 *   - 模型：目录 → 页面；.md → 子页面（正文 = markdown 转 blocks）；引用到的图片/附件 → 内联 image/file 块（自动上传）。
 *   - 幂等同步（默认）：同名页面已存在则【覆盖更新内容】（清空旧子块后重填，保留页面 URL），不存在则新建；
 *     重复运行不会产生重复页面，本地笔记更新后重跑即可同步过去。
 *   - 增量跳过（v1.5.0+）：内容哈希缓存（~/.config/obsidian-sync/notion-cache.json）——页面已存在且本地 md
 *     内容未变化时跳过（不重写）；首次运行对已存在页面信任远端现状并建缓存。需要强制全量重写时加 --force。
 *   - 未被任何 md 引用的「孤儿附件」只在页面新建时或显式 --with-orphans 时上传（避免重复堆积）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const N = require('./notion_api.cjs');

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && i + 1 < args.length) ? args[i + 1] : undefined;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- 增量缓存（内容哈希，避免未变化页面全量重写） ----------
const CACHE_DIR = path.join(os.homedir(), '.config', 'obsidian-sync');
const CACHE_FILE = path.join(CACHE_DIR, 'notion-cache.json');
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); }
  catch (e) { console.error('增量缓存写入失败（不影响同步）: ' + e.message); }
}
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

// 带重试的 API 调用（429 / 5xx / 网络抖动）
async function withRetry(fn, label, retries = 4) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fn();
      if (r.status === 429 || r.status >= 500) {
        if (i === retries) throw new Error(`${label} 失败 HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
        await sleep(800 * (i + 1));
        continue;
      }
      return r;
    } catch (e) {
      if (i === retries || /ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(e.message)) {
        if (i < retries) { await sleep(800 * (i + 1)); continue; }
      }
      throw e;
    }
  }
}

function isErr(r) { return r.data && r.data.object === 'error'; }
function titleOf(page) {
  try { return page.properties.title.title[0].plain_text; } catch { return ''; }
}

// 在指定父页面下按标题精确查找子页面（不存在返回 null）
// 优先列父页子块（强一致，无索引延迟）；列失败时兜底 /search（索引可能延迟）
async function findChildByTitle(parentId, title, opts) {
  const want = String(title).trim();
  try {
    const children = await listAllChildren(parentId, opts);
    for (const b of children) {
      if (b.type === 'child_page' && ((b.child_page && b.child_page.title) || '').trim() === want) {
        return { id: b.id, url: 'https://www.notion.so/' + b.id.replace(/-/g, '') };
      }
    }
  } catch (e) { /* 列子块失败，走 search 兜底 */ }
  const r = await withRetry(() => N.search({ query: title, page_size: 100, filter: { value: 'page', property: 'object' } }, opts), '搜索页面 ' + title);
  if (isErr(r)) return null;
  for (const p of (r.data.results || [])) {
    if (p.parent && p.parent.type === 'page_id' && p.parent.page_id === parentId) {
      if ((titleOf(p) || '').trim() === want) return p;
    }
  }
  return null;
}

// 分页列出页面全部子块
async function listAllChildren(id, opts) {
  const all = [];
  let cursor = undefined;
  do {
    const q = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : '?page_size=100';
    const r = await withRetry(() => N.api('GET', `/blocks/${id}/children${q}`, null, opts), '列子块 ' + id);
    if (isErr(r)) throw new Error('列子块失败: ' + JSON.stringify(r.data));
    all.push(...(r.data.results || []));
    cursor = r.data.has_more ? r.data.next_cursor : undefined;
  } while (cursor);
  return all;
}

// 清空页面内容（删除全部子块；仅用于 md 页，不碰 child_page）
// 并发 3 删除（Notion 3 req/s 限流，429 由 withRetry 退避处理）
async function clearChildren(pageId, opts) {
  const blocks = await listAllChildren(pageId, opts);
  const targets = blocks.filter(b => b.type !== 'child_page' && b.type !== 'child_database');
  const CONC = 3;
  for (let i = 0; i < targets.length; i += CONC) {
    const chunk = targets.slice(i, i + CONC);
    await Promise.all(chunk.map(b => withRetry(() => N.deleteBlock(b.id, opts), '删块 ' + b.id)
      .then(d => { if (isErr(d)) console.error(`删块失败 ${b.id}: ${JSON.stringify(d.data)}`); })));
  }
  return blocks.length;
}

// ---------- 清理（--clean）：递归归档整棵同步树（先叶子后父级，最后根页），并清除增量缓存 ----------
async function cleanTree(landingPage, rootName, cache, cacheKey, opts) {
  const existing = await findChildByTitle(landingPage, rootName, opts);
  if (!existing) {
    console.error('未找到根页「' + rootName + '」（已删除或从未同步），无需清理');
    return;
  }
  let count = 0;
  async function archiveRec(id, label, depth) {
    const children = await listAllChildren(id, opts);
    for (const b of children) {
      if (b.type === 'child_page' || b.type === 'child_database') {
        await archiveRec(b.id, (b.child_page && b.child_page.title) || b.id, depth + 1);
      }
    }
    const r = await withRetry(() => N.archivePage(id, opts), '归档 ' + label);
    if (isErr(r)) { console.error('归档失败 ' + label + ': ' + JSON.stringify(r.data)); return; }
    count++;
    console.log('ARCHIVED ' + '  '.repeat(depth) + label);
  }
  await archiveRec(existing.id, rootName, 0);
  delete cache[cacheKey];
  saveCache(cache);
  console.log(`\n=== 清理完成：归档 ${count} 个页面（含根页，移入回收站），已清除该目录的增量缓存 ===`);
}

async function main() {
  const args = process.argv.slice(2);
  const landingPage = argValue(args, '--page');
  const dir = argValue(args, '--dir');
  const rootTitle = argValue(args, '--title');
  const dryRun = args.includes('--dry-run');
  const withOrphans = args.includes('--with-orphans');
  const force = args.includes('--force');
  const clean = args.includes('--clean');
  const proxy = argValue(args, '--proxy');
  const opts = proxy ? { proxy } : {};

  if (!landingPage || !dir) {
    console.error('用法: node sync_vault_to_notion.cjs --page <page_id> --dir <本地目录> [--title <根页标题>] [--dry-run] [--with-orphans] [--force] [--clean] [--proxy socks5://host:port]');
    console.error('  --clean  清理（非同步）：递归归档该目录对应的整棵 Notion 页面树（先叶子后父级，最后根页），并清除增量缓存；workspace 级顶层 landing 页需客户端手动删');
    process.exit(1);
  }
  const rootDir = path.resolve(dir);
  if (!fs.existsSync(rootDir)) { console.error('目录不存在: ' + rootDir); process.exit(1); }

  const rootName = rootTitle || path.basename(rootDir);
  const cache = loadCache();
  const cacheKey = rootDir;

  // --clean 模式：只清理，不同步
  if (clean) {
    await cleanTree(landingPage, rootName, cache, cacheKey, opts);
    return;
  }

  // 1. 扫描
  const mdFiles = [], otherFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|markdown)$/i.test(e.name)) mdFiles.push(p);
      else otherFiles.push(p);
    }
  })(rootDir);
  console.log(`发现 ${mdFiles.length} 个 md，${otherFiles.length} 个附件/其它文件${dryRun ? '（dry-run）' : ''}`);

  // 相对路径统一用 / 分隔
  const rel = (p) => path.relative(rootDir, p).split(path.sep).join('/');

  // 2. 阶段一：建/复用页面树（目录页 + md 页），记录 relpath -> { id, url }
  const pageMap = new Map(); // relpath(去 .md) -> {id,url}
  const dirPageMap = new Map(); // 目录 relpath(或 '.' 表示根) -> pageId
  const created = new Set(); // 本次新建的页面 id（用于孤儿附件判断）
  let createdCount = 0, updatedCount = 0, reusedCount = 0, skippedCount = 0;

  // 增量缓存命名空间（cache/cacheKey 已在 main 开头加载）
  const ns = cache[cacheKey] || (cache[cacheKey] = {});

  // 根页：落点下同名则复用
  if (dryRun) {
    console.log(`[dry-run] 根页「${rootName}」 -> 挂到 ${landingPage}`);
  } else {
    const existingRoot = await findChildByTitle(landingPage, rootName, opts);
    if (existingRoot) {
      dirPageMap.set('.', existingRoot.id);
      pageMap.set('.', { id: existingRoot.id, url: existingRoot.url });
      reusedCount++;
      console.log(`复用根页「${rootName}」 -> ${existingRoot.id}`);
    } else {
      const rr = await withRetry(() => N.createPage({ type: 'page_id', id: landingPage }, rootName, opts), '建根页');
      if (isErr(rr)) throw new Error('建根页失败: ' + JSON.stringify(rr.data));
      dirPageMap.set('.', rr.data.id);
      pageMap.set('.', { id: rr.data.id, url: rr.data.url });
      created.add(rr.data.id); createdCount++;
      console.log(`根页「${rootName}」 -> ${rr.data.id}`);
    }
  }

  // 目录集合
  const dirs = new Set();
  for (const f of mdFiles) {
    const sub = path.dirname(rel(f));
    if (sub && sub !== '.') dirs.add(sub);
  }
  for (const f of otherFiles) {
    const sub = path.dirname(rel(f));
    if (sub && sub !== '.') dirs.add(sub);
  }
  const sortedDirs = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);

  // 目录页（根下的子目录）：同名复用
  for (const sub of sortedDirs) {
    const parentRel = path.posix.dirname(sub);
    const parentId = parentRel === '.' ? dirPageMap.get('.') : dirPageMap.get(parentRel);
    if (!parentId) { console.error(`父目录页缺失 ${parentRel}，跳过 ${sub}`); continue; }
    const name = path.posix.basename(sub);
    if (dryRun) { console.log(`[dry-run] 目录页 ${sub}（parent=${parentRel}）`); continue; }
    const existing = await findChildByTitle(parentId, name, opts);
    if (existing) {
      dirPageMap.set(sub, existing.id);
      pageMap.set(sub, { id: existing.id, url: existing.url });
      reusedCount++;
      console.log(`复用目录页 ${sub} -> ${existing.id}`);
      continue;
    }
    const r = await withRetry(() => N.createPage({ type: 'page_id', id: parentId }, name, opts), `建目录页 ${sub}`);
    if (isErr(r)) { console.error(`建目录页失败 ${sub}: ${JSON.stringify(r.data)}`); continue; }
    dirPageMap.set(sub, r.data.id);
    pageMap.set(sub, { id: r.data.id, url: r.data.url });
    created.add(r.data.id); createdCount++;
    console.log(`目录页 ${sub} -> ${r.data.id}`);
  }

  // md 页面（先全部建好/找到，供 wikilink 互链）
  for (const f of mdFiles) {
    const rp = rel(f).replace(/\.md$/i, '');
    const sub = path.dirname(rel(f));
    const parentId = sub === '.' ? dirPageMap.get('.') : dirPageMap.get(sub);
    if (!parentId) { console.error(`父目录页缺失，跳过 ${rel(f)}`); continue; }
    const title = path.basename(f).replace(/\.md$/i, '');
    if (dryRun) { console.log(`[dry-run] md 页 ${rp}（title=${title}）`); continue; }
    const existing = await findChildByTitle(parentId, title, opts);
    if (existing) {
      pageMap.set(rp, { id: existing.id, url: existing.url });
      reusedCount++;
      console.log(`复用 md 页 ${rp} -> ${existing.id}`);
      continue;
    }
    const r = await withRetry(() => N.createPage({ type: 'page_id', id: parentId }, title, opts), `建 md 页 ${rp}`);
    if (isErr(r)) { console.error(`建 md 页失败 ${rp}: ${JSON.stringify(r.data)}`); continue; }
    pageMap.set(rp, { id: r.data.id, url: r.data.url });
    created.add(r.data.id); createdCount++;
  }

  // wikilink 解析：目标 -> Notion URL
  const byBase = new Map();
  for (const [k, v] of pageMap) { if (k && k !== '.') byBase.set(path.posix.basename(k).toLowerCase(), v); }
  function resolveLink(target) {
    const t = String(target || '').trim().replace(/\.md$/i, '').replace(/\\/g, '/');
    if (!t) return null;
    const hit = pageMap.get(t) || pageMap.get(t.toLowerCase()) || byBase.get(path.posix.basename(t).toLowerCase());
    return hit ? (hit.url || ('https://www.notion.so/' + hit.id.replace(/-/g, ''))) : null;
  }

  // 3. 阶段二：填 md 内容（新建 = 追加；已存在 = 清空旧子块后重填覆盖）+ 记录已引用附件
  const referenced = new Set(); // 已内联上传的本地文件绝对路径
  async function uploadImage(src, baseDir) {
    const f = path.isAbsolute(src) ? src : path.resolve(baseDir, src);
    if (!fs.existsSync(f)) return null;
    if (dryRun) { referenced.add(f); return { id: 'dry-run', name: path.basename(f) }; }
    try {
      const up = await withRetry(() => N.uploadFile({ pageId: pageMap.get('.').id, filePath: f, proxy }), '上传附件 ' + rel(f));
      referenced.add(f);
      return { id: up.id, name: up.name };
    } catch (e) { console.error(`上传失败 ${rel(f)}: ${e.message}`); return null; }
  }

  let ok = 0, fail = 0;
  for (const f of mdFiles) {
    const rp = rel(f).replace(/\.md$/i, '');
    const pg = pageMap.get(rp);
    if (!pg) { fail++; continue; }
    if (dryRun) { ok++; continue; }
    try {
      const md = fs.readFileSync(f, 'utf8');
      const h = sha256(md);
      const cached = ns[rp];
      if (!created.has(pg.id) && !force) {
        if (cached && cached.hash === h && cached.pageId === pg.id) {
          // 增量跳过：页面已存在、缓存哈希一致、页面 id 未变 → 内容未变化
          skippedCount++;
          console.log(`SKIP ${rp}（内容未变化）`);
          ok++;
          continue;
        }
        if (!cached) {
          // 首次建缓存：信任远端现状（同名页面已存在），仅记录哈希后跳过；
          // 之后本地内容一旦变化即触发覆盖更新。需要强制全量重写时用 --force。
          skippedCount++;
          console.log(`SKIP ${rp}（首次建缓存，信任远端）`);
          ns[rp] = { hash: h, pageId: pg.id };
          ok++;
          continue;
        }
        // 缓存存在但哈希不同 → 走覆盖更新
      }
      const conv = N.markdownToBlocks(md, { resolveLink, baseDir: path.dirname(f) });
      const blocks = await N.resolveImages(conv, (src) => uploadImage(src, path.dirname(f)));
      if (!created.has(pg.id)) {
        // 已存在页面：覆盖更新（清空旧内容再重填）
        const removed = await clearChildren(pg.id, opts);
        updatedCount++;
        console.log(`UPD  ${rp}（清除 ${removed} 个旧块后重写）`);
      } else {
        console.log(`NEW  ${rp}`);
      }
      for (let s = 0; s < blocks.length; s += 100) {
        const chunk = blocks.slice(s, s + 100);
        await withRetry(() => N.appendBlocks(pg.id, chunk, opts), `填充 ${rp}`);
      }
      ns[rp] = { hash: h, pageId: pg.id }; // 同步成功后记录缓存
      ok++;
    } catch (e) {
      fail++; console.log(`ERR  ${rp} : ${e.message}`);
    }
  }

  // 4. 孤儿附件（未被任何 md 引用）：仅新建页面或 --with-orphans 时上传
  const shouldHandleOrphans = withOrphans;
  const orphansByDir = new Map();
  for (const f of otherFiles) {
    if (referenced.has(f)) continue;
    const sub = path.dirname(rel(f));
    const key = sub || '.';
    if (!orphansByDir.has(key)) orphansByDir.set(key, []);
    orphansByDir.get(key).push(f);
  }
  for (const [sub, files] of orphansByDir) {
    const pageId = sub === '.' ? dirPageMap.get('.') : dirPageMap.get(sub);
    if (!pageId) continue;
    const pageNew = created.has(pageId);
    if (!shouldHandleOrphans && !pageNew) {
      console.log(`SKIP 孤儿附件 ${files.length} 个 -> ${sub}（页面已存在，避免重复；需要时加 --with-orphans）`);
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] 孤儿附件 ${files.length} 个 -> 目录 ${sub}`);
      continue;
    }
    const fileBlocks = [];
    for (const f of files) {
      try {
        const up = await withRetry(() => N.uploadFile({ pageId, filePath: f, proxy }), '上传孤儿附件 ' + rel(f));
        if (up.id) fileBlocks.push({ type: 'file', file: { type: 'file_upload', file_upload: { id: up.id }, name: up.name } });
      } catch (e) { console.error(`孤儿附件上传失败 ${rel(f)}: ${e.message}`); }
    }
    if (fileBlocks.length) {
      const header = [
        { type: 'divider', divider: {} },
        { type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: '附件' } }] } },
        ...fileBlocks,
      ];
      for (let s = 0; s < header.length; s += 100) {
        await withRetry(() => N.appendBlocks(pageId, header.slice(s, s + 100), opts), `写附件分区 ${sub}`);
      }
    }
  }

  saveCache(cache);
  console.log(`\n=== 完成：md 成功 ${ok}，失败 ${fail}；新建 ${createdCount}，覆盖更新 ${updatedCount}，跳过(未变化) ${skippedCount}，复用 ${reusedCount} ===`);
  if (pageMap.has('.')) console.log('根页链接: ' + (pageMap.get('.').url || ''));
}

main().catch(e => { console.error(e.message); process.exit(1); });
