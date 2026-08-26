#!/usr/bin/env node
'use strict';
/*
 * sync_vault_to_notion.cjs — 把本地目录（含子目录）单向同步进 Notion，保留目录层级。
 *
 * 用法：
 *   node sync_vault_to_notion.cjs --page <page_id> --dir <本地目录> [--title <根页标题>] [--dry-run] [--proxy socks5://host:port]
 *
 * 说明：
 *   - 依赖同目录 notion_api.cjs（自动加载 Notion token，见 env-and-auth.md）。
 *   - 模型：目录 → 页面；.md → 子页面（正文 = markdown 转 blocks）；引用到的图片/附件 → 内联 image/file 块（自动上传）。
 *   - 未被任何 md 引用的「孤儿附件」会以 file 块追加到其所在目录页的「附件」分区（除非 --skip-orphans）。
 *   - 两阶段：先建目录/页面树（记录 相对路径→page 映射，供 wikilink 互链），再逐 md 转 blocks 填充。
 *   - Notion 无「覆盖写」：重复运行会再次新建同名页面。建议先在干净落点跑一次。
 */

const fs = require('fs');
const path = require('path');
const N = require('./notion_api.cjs');

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && i + 1 < args.length) ? args[i + 1] : undefined;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function main() {
  const args = process.argv.slice(2);
  const landingPage = argValue(args, '--page');
  const dir = argValue(args, '--dir');
  const rootTitle = argValue(args, '--title');
  const dryRun = args.includes('--dry-run');
  const skipOrphans = args.includes('--skip-orphans');
  const proxy = argValue(args, '--proxy');
  const opts = proxy ? { proxy } : {};

  if (!landingPage || !dir) {
    console.error('用法: node sync_vault_to_notion.cjs --page <page_id> --dir <本地目录> [--title <根页标题>] [--dry-run] [--proxy socks5://host:port] [--skip-orphans]');
    process.exit(1);
  }
  const rootDir = path.resolve(dir);
  if (!fs.existsSync(rootDir)) { console.error('目录不存在: ' + rootDir); process.exit(1); }

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

  const rootName = rootTitle || path.basename(rootDir);

  // 相对路径统一用 / 分隔
  const rel = (p) => path.relative(rootDir, p).split(path.sep).join('/');

  // 2. 阶段一：建页面树（目录页 + md 页），记录 relpath -> { id, url }
  const pageMap = new Map(); // relpath(去 .md) -> {id,url}
  const dirPageMap = new Map(); // 目录 relpath(或 '.' 表示根) -> pageId
  const rootPageId = '__root__';

  if (dryRun) {
    console.log(`[dry-run] 根页「${rootName}」 -> 挂到 ${landingPage}`);
  } else {
    const rr = await withRetry(() => N.createPage({ type: 'page_id', id: landingPage }, rootName, opts), '建根页');
    if (isErr(rr)) throw new Error('建根页失败: ' + JSON.stringify(rr.data));
    dirPageMap.set('.', rr.data.id);
    pageMap.set('.', { id: rr.data.id, url: rr.data.url });
    console.log(`根页「${rootName}」 -> ${rr.data.id}`);
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

  // 目录页（根下的子目录）
  for (const sub of sortedDirs) {
    const parentRel = path.posix.dirname(sub);
    const parentId = parentRel === '.' ? dirPageMap.get('.') : dirPageMap.get(parentRel);
    if (!parentId) { console.error(`父目录页缺失 ${parentRel}，跳过 ${sub}`); continue; }
    if (dryRun) { console.log(`[dry-run] 目录页 ${sub}（parent=${parentRel}）`); continue; }
    const r = await withRetry(() => N.createPage({ type: 'page_id', id: parentId }, path.posix.basename(sub), opts), `建目录页 ${sub}`);
    if (isErr(r)) { console.error(`建目录页失败 ${sub}: ${JSON.stringify(r.data)}`); continue; }
    dirPageMap.set(sub, r.data.id);
    pageMap.set(sub, { id: r.data.id, url: r.data.url });
    console.log(`目录页 ${sub} -> ${r.data.id}`);
  }

  // md 页面（先全部建好，供 wikilink 互链）
  for (const f of mdFiles) {
    const rp = rel(f).replace(/\.md$/i, '');
    const sub = path.dirname(rel(f));
    const parentId = sub === '.' ? dirPageMap.get('.') : dirPageMap.get(sub);
    if (!parentId) { console.error(`父目录页缺失，跳过 ${rel(f)}`); continue; }
    const title = path.basename(f).replace(/\.md$/i, '');
    if (dryRun) { console.log(`[dry-run] md 页 ${rp}（title=${title}）`); continue; }
    const r = await withRetry(() => N.createPage({ type: 'page_id', id: parentId }, title, opts), `建 md 页 ${rp}`);
    if (isErr(r)) { console.error(`建 md 页失败 ${rp}: ${JSON.stringify(r.data)}`); continue; }
    pageMap.set(rp, { id: r.data.id, url: r.data.url });
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

  // 3. 阶段二：填 md 内容（转 blocks + 上传内联图片）+ 记录已引用附件
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
      const conv = N.markdownToBlocks(md, { resolveLink, baseDir: path.dirname(f) });
      const blocks = await N.resolveImages(conv, (src) => uploadImage(src, path.dirname(f)));
      for (let s = 0; s < blocks.length; s += 100) {
        const chunk = blocks.slice(s, s + 100);
        await withRetry(() => N.appendBlocks(pg.id, chunk, opts), `填充 ${rp}`);
      }
      ok++;
      console.log(`OK   ${rp}`);
    } catch (e) {
      fail++; console.log(`ERR  ${rp} : ${e.message}`);
    }
  }

  // 4. 孤儿附件（未被任何 md 引用），追加到其目录页的「附件」分区
  if (!skipOrphans) {
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
  }

  console.log(`\n=== 完成：md 成功 ${ok}，失败 ${fail} ===`);
  if (pageMap.has('.')) console.log('根页链接: ' + (pageMap.get('.').url || ''));
}

main().catch(e => { console.error(e.message); process.exit(1); });
