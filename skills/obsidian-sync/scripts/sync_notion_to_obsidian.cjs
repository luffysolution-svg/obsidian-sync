#!/usr/bin/env node
'use strict';
/*
 * sync_notion_to_obsidian.cjs — Notion → Obsidian 反向导入（v1.6.0，实验性）
 *
 * 用法：
 *   node sync_notion_to_obsidian.cjs --page <page_id> --out <vault目录> [--attach-dir assets] [--proxy socks5://host:port] [--dry-run]
 *
 * 流程：
 *   1) 读取 Notion 页面（getPage + 递归 listChildren，含嵌套子块）
 *   2) blocks → Obsidian markdown：标题/列表/todo/引用/callout/代码/表格/公式/图片/文件/互链
 *   3) 图片：external 保持外链；file 走 Notion CDN 下载到 <out>/<attach-dir>/（经代理），引用改写为相对路径
 *   4) child_page 递归生成子文件，[[wikilink]] 互链；写入 frontmatter（title/url/时间）
 *
 * 依赖：Node ≥ 18、同目录 notion_api.cjs（Notion token；国内需 --proxy）
 * 说明：只读导出，不修改 Notion 侧任何内容
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const N = require('./notion_api.cjs');

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && i + 1 < args.length) ? args[i + 1] : undefined;
}

// Windows 非法文件名字符 → 全角替换
function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|\r\n]/g, (c) => ({ '\\': '＼', '/': '／', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜' }[c] || ' ')).trim().slice(0, 120) || 'untitled';
}

// ---------- rich_text 内联渲染 ----------
function renderRichText(rt, ctx) {
  let out = '';
  for (const t of rt || []) {
    const { annotations = {}, href } = t;
    let s = t.plain_text || '';
    if (t.type === 'equation') s = '$' + (t.equation && t.equation.expression || '') + '$';
    else if (t.type === 'mention') {
      const m = t.mention || {};
      if (m.type === 'page') s = '[[' + (m.page && m.page.title || '') + ']]';
      else if (m.type === 'date') s = (m.date && (m.date.start || '')) || s;
      else if (m.type === 'user') s = '@' + ((m.user && m.user.name) || '');
    }
    if (annotations.code) s = '`' + s + '`';
    if (annotations.bold) s = '**' + s + '**';
    if (annotations.italic) s = '*' + s + '*';
    if (annotations.strikethrough) s = '~~' + s + '~~';
    if (annotations.underline) s = '<u>' + s + '</u>';
    if (href) s = '[' + s + '](' + href + ')';
    out += s;
  }
  return out;
}

// ---------- 带重试的 API 调用（429 / 5xx / 网络抖动） ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function withRetry(fn, label, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fn();
      if (r && r.status === 429 || (r && r.status >= 500)) {
        if (i === retries) throw new Error(`${label} 失败 HTTP ${r.status}`);
        await sleep(900 * (i + 1));
        continue;
      }
      return r;
    } catch (e) {
      if (i === retries || /ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(e.message)) {
        if (i < retries) { await sleep(900 * (i + 1)); continue; }
      }
      throw e;
    }
  }
}

// ---------- 递归读取（含嵌套子块） ----------
async function fetchBlocks(id, opts) {
  const all = [];
  let cursor;
  do {
    const q = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : '?page_size=100';
    const r = await withRetry(() => N.api('GET', `/blocks/${id}/children${q}`, null, opts), '读块 ' + id);
    if (r.data && r.data.object === 'error') throw new Error('读块失败 ' + id + ': ' + JSON.stringify(r.data));
    all.push(...(r.data.results || []));
    cursor = r.data.has_more ? r.data.next_cursor : undefined;
  } while (cursor);
  for (const b of all) {
    if (b.has_children && !['child_page', 'child_database', 'table_row'].includes(b.type)) {
      b._children = await fetchBlocks(b.id, opts);
    }
  }
  return all;
}

// ---------- blocks → markdown ----------
function blocksToMarkdown(blocks, ctx) {
  const lines = [];
  for (const b of blocks) lines.push(blockToMarkdown(b, ctx, 0));
  return lines.filter(l => l !== null).join('\n');
}

function blockToMarkdown(b, ctx, depth) {
  const p = '  '.repeat(Math.min(depth, 6));
  const rt = (arr) => renderRichText(arr, ctx);
  const children = b._children || [];

  switch (b.type) {
    case 'paragraph': return p + rt(b.paragraph && b.paragraph.rich_text);
    case 'heading_1': return '# ' + rt(b.heading_1 && b.heading_1.rich_text);
    case 'heading_2': return '## ' + rt(b.heading_2 && b.heading_2.rich_text);
    case 'heading_3': return '### ' + rt(b.heading_3 && b.heading_3.rich_text);
    case 'bulleted_list_item': return p + '- ' + rt(b.bulleted_list_item && b.bulleted_list_item.rich_text) + (children.length ? '\n' + blocksToMarkdown(children, ctx) : '');
    case 'numbered_list_item': return p + '1. ' + rt(b.numbered_list_item && b.numbered_list_item.rich_text) + (children.length ? '\n' + blocksToMarkdown(children, ctx) : '');
    case 'to_do': return p + '- ' + (b.to_do && b.to_do.checked ? '[x]' : '[ ]') + ' ' + rt(b.to_do && b.to_do.rich_text) + (children.length ? '\n' + blocksToMarkdown(children, ctx) : '');
    case 'toggle': return p + '> **' + rt(b.toggle && b.toggle.rich_text) + '**\n' + (children.length ? blocksToMarkdown(children, ctx) : '');
    case 'quote': return p + '> ' + rt(b.quote && b.quote.rich_text).split('\n').join('\n> ') + (children.length ? '\n' + blocksToMarkdown(children, ctx) : '');
    case 'callout': {
      const icon = (b.callout && b.callout.icon && b.callout.icon.emoji) || '';
      const text = rt(b.callout && b.callout.rich_text);
      const head = text.split('\n')[0];
      return p + '> [!NOTE] ' + (icon ? icon + ' ' : '') + head + '\n> ' + text.split('\n').slice(1).join('\n> ') + (children.length ? '\n' + blocksToMarkdown(children, ctx) : '');
    }
    case 'code': {
      const lang = (b.code && b.code.language) || '';
      return p + '```' + lang + '\n' + (b.code && b.code.rich_text || []).map(t => t.plain_text).join('') + '\n```';
    }
    case 'divider': return p + '---';
    case 'equation': return p + '$$\n' + (b.equation && b.equation.expression || '') + '\n$$';
    case 'table': {
      // 表格：第一行表头 + 分隔行 + 其余行（table_row 子块）
      const rows = children.map(c => (c.table_row && c.table_row.cells || []).map(cell => renderRichText(cell, ctx).replace(/\|/g, '\\|')));
      if (!rows.length) return null;
      const cols = Math.max(...rows.map(r => r.length));
      const line = (r) => '| ' + r.concat(new Array(cols - r.length).fill('')).join(' | ') + ' |';
      const sep = '| ' + new Array(cols).fill('---').join(' | ') + ' |';
      return [line(rows[0]), sep, ...rows.slice(1).map(line)].join('\n');
    }
    case 'image': {
      const img = b.image || {};
      const src = img.type === 'external' ? (img.external && img.external.url) : (img.file && img.file.url);
      if (!src) return null;
      const cap = rt(img.caption || []);
      if (img.type === 'external') return p + '![' + cap + '](' + src + ')';
      return ctx.localizeImage(src, p + '![' + cap + ']', ctx);
    }
    case 'file': {
      const f = b.file || {};
      const url = f.type === 'external' ? (f.external && f.external.url) : (f.file && f.file.url);
      if (!url) return null;
      const name = (f.name || 'attachment');
      const cap = rt(b.file && b.file.caption || []);
      if (f.type === 'external') return p + '[' + name + (cap ? ' — ' + cap : '') + '](' + url + ')';
      return ctx.localizeImage(url, p + '[' + name + (cap ? ' — ' + cap : '') + ']', ctx, true);
    }
    case 'bookmark': case 'embed': case 'link_preview': case 'link_to_page': {
      let url = b.bookmark && b.bookmark.url || b.embed && b.embed.url || b.link_preview && b.link_preview.url || '';
      if (b.link_to_page) {
        const t = b.link_to_page;
        const target = t.type === 'page_id' ? (ctx.pageTitles[t.page_id] || t.page_id) : (t.type === 'database_id' ? 'database ' + t.database_id : '');
        return p + '[[' + target + ']]';
      }
      if (!url) return null;
      const cap = rt((b.bookmark && b.bookmark.caption) || (b.embed && b.embed.caption) || []);
      return p + '[' + (cap || new URL(url).hostname) + '](' + url + ')';
    }
    case 'child_page': return p + '[[' + (b.child_page && b.child_page.title) + ']]';
    case 'child_database': return p + '> [!WARNING] Notion 数据库（child_database）未展开：' + (b.child_database && b.child_database.title || '');
    case 'column': case 'column_list': return children.length ? blocksToMarkdown(children, ctx) : null;
    case 'synced_block': return children.length ? blocksToMarkdown(children, ctx) : null;
    case 'breadcrumb': case 'table_of_contents': case 'template': case 'unsupported': return null;
    default:
      // 有子块则递归，否则忽略
      return children.length ? blocksToMarkdown(children, ctx) : null;
  }
}

// ---------- 页面导出 ----------
async function exportPage(pageId, outDir, attachDir, opts, ctx, relPrefix) {
  const page = await withRetry(() => N.getPage(pageId, opts), '读页面 ' + pageId);
  if (page.data && page.data.object === 'error') throw new Error('读页面失败: ' + JSON.stringify(page.data));
  const title = (page.data.properties && page.data.properties.title && page.data.properties.title.title || []).map(t => t.plain_text).join('') || pageId;
  const safeTitle = sanitize(title);

  const blocks = await fetchBlocks(pageId, opts);
  const subPages = [];
  // 先登记子页面标题（用于互链）
  for (const b of blocks) if (b.type === 'child_page') ctx.pageTitles[b.id] = b.child_page.title;

  const md = [];
  md.push('---');
  md.push('title: ' + JSON.stringify(title));
  if (page.data.url) md.push('url: ' + page.data.url);
  if (page.data.created_time) md.push('created: ' + page.data.created_time);
  if (page.data.last_edited_time) md.push('updated: ' + page.data.last_edited_time);
  md.push('source: Notion');
  md.push('---');
  md.push('');
  md.push(blocksToMarkdown(blocks, ctx));

  const relDir = relPrefix || '';
  const dirPath = path.join(outDir, relDir);
  fs.mkdirSync(dirPath, { recursive: true });
  const filePath = path.join(dirPath, safeTitle + '.md');
  fs.writeFileSync(filePath, md.join('\n') + '\n', 'utf8');
  console.log(`  ✅ ${path.join(relDir, safeTitle + '.md')}`);

  // 子页面递归（子目录）；单个子页面失败不中断整批
  for (const b of blocks) {
    if (b.type === 'child_page') {
      try {
        await exportPage(b.id, outDir, attachDir, opts, ctx, path.join(relDir, safeTitle));
      } catch (e) {
        console.error(`  ❌ 子页面「${b.child_page && b.child_page.title}」导出失败: ${e.message}`);
      }
    }
  }
  return filePath;
}

async function main() {
  const args = process.argv.slice(2);
  const pageId = argValue(args, '--page');
  const out = argValue(args, '--out');
  const attachDir = argValue(args, '--attach-dir') || 'assets';
  const proxy = argValue(args, '--proxy');
  const dryRun = args.includes('--dry-run');

  if (!pageId || !out) {
    console.error('用法: node sync_notion_to_obsidian.cjs --page <page_id> --out <vault目录> [--attach-dir assets] [--proxy socks5://host:port] [--dry-run]');
    process.exit(1);
  }
  const opts = proxy ? { proxy } : {};
  const outDir = path.resolve(out);
  fs.mkdirSync(outDir, { recursive: true });

  // 图片/附件本地化（走代理下载 Notion CDN 文件）
  const ctx = { pageTitles: {}, imgSeq: 0, attachDir, outDir, opts, proxy: proxy || process.env.NOTION_PROXY || process.env.HTTPS_PROXY || '' };
  ctx.localizeImage = async function (url, mdPrefix, c, keepUrl = false) {
    // 外链（非 Notion 托管）保持原样
    if (!/^https?:\/\/prod-files-secure\.s3\.|^https?:\/\/www\.notion\.so\/image\//.test(url) && !keepUrl) return mdPrefix + '](' + url + ')';
    const attachPath = path.join(c.outDir, c.attachDir);
    fs.mkdirSync(attachPath, { recursive: true });
    c.imgSeq++;
    const ext = (path.extname(new URL(url).pathname) || '.png').slice(0, 8).toLowerCase();
    const fname = 'image-' + String(c.imgSeq).padStart(2, '0') + (ext && ext.length <= 5 ? ext : '.png');
    try {
      const proxyObj = c.proxy ? N.parseProxy(c.proxy) : null;
      const res = await N.rawRequest('GET', url, { headers: { 'User-Agent': 'Mozilla/5.0' }, proxy: proxyObj });
      if (res.status >= 400) throw new Error('HTTP ' + res.status);
      fs.writeFileSync(path.join(attachPath, fname), res.body);
      console.log(`  🖼️  下载 ${fname} (${res.body.length} bytes) <- ${url.slice(0, 70)}...`);
      return mdPrefix + '](' + c.attachDir + '/' + fname + ')';
    } catch (e) {
      console.error(`  ⚠️ 附件下载失败 ${fname}: ${e.message}（保留原链接）`);
      return mdPrefix + '](' + url + ')';
    }
  };

  console.log(`导出 Notion 页面树: ${pageId} -> ${outDir}`);
  await exportPage(pageId, outDir, attachDir, opts, ctx, '');
  console.log('\n=== 完成 ===');
}

main().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
