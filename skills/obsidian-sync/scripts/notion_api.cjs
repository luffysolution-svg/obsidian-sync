#!/usr/bin/env node
'use strict';
/*
 * notion_api.cjs — Notion API 封装（零依赖，Node >= 18）
 *
 * 凭证：环境变量 NOTION_TOKEN（兼容 NOTION_API_KEY）→ ~/.config/notion/token
 * 获取：https://www.notion.so/profile/integrations 新建 integration（Internal）拿 Internal Integration Secret（ntn_ 或 secret_ 开头）
 *
 * 代理：环境变量 NOTION_PROXY，或 CLI --proxy；支持
 *   http://127.0.0.1:10809   （HTTP CONNECT 代理）
 *   socks5://127.0.0.1:10808 （SOCKS5 代理）
 * 国内直连 api.notion.com 会被墙，需走代理（v2rayN/clash 等）。
 *
 * 用法：
 *   node notion_api.cjs whoami
 *   node notion_api.cjs search [--type page|database] [--query 关键词]
 *   node notion_api.cjs page --id <page_id>
 *   node notion_api.cjs children --id <page_or_block_id>
 *   node notion_api.cjs create-workspace-page --title <标题>
 *   node notion_api.cjs create-page --parent <page_id> --title <标题>
 *   node notion_api.cjs import-md --parent <page_id> --title <标题> --file <本地.md>
 *   node notion_api.cjs upload-file --parent <page_id> --file <本地路径>
 *   所有命令可加 --proxy socks5://host:port
 *
 * 说明：
 *   - 响应是 Notion 标准 JSON；错误时返回 {object:"error", status, code, message}。
 *   - markdown → blocks 由 markdownToBlocks() 完成（标题/列表/代码/引用/图片/表格/公式/前端元数据跳过等）。
 *   - 文件上传走 Direct Upload：POST /v1/file_uploads 建对象 → multipart POST .../send 传内容 → 用 file_upload.id 写 image/file 块。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';

// ---------- 凭证 ----------
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } }
function loadToken() {
  const t = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY ||
    readFileSafe(path.join(os.homedir(), '.config/notion/token'));
  if (!t) throw new Error('缺少 Notion Token。请设置 NOTION_TOKEN，或放到 ~/.config/notion/token（获取：https://www.notion.so/profile/integrations）。');
  return t;
}

// ---------- 代理（HTTP CONNECT / SOCKS5） ----------
function parseProxy(s) {
  if (!s) return null;
  let m = s.match(/^(socks5|socks|http|https):\/\/([^:]+):(\d+)\/?$/i);
  if (m) return { proto: m[1].toLowerCase() === 'socks' ? 'socks5' : m[1].toLowerCase(), host: m[2], port: +m[3] };
  m = s.match(/^([^:]+):(\d+)$/);
  if (m) return { proto: 'http', host: m[1], port: +m[2] };
  return null;
}
function proxyFromEnv() { return parseProxy(process.env.NOTION_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''); }

function readN(sock, n) {
  return new Promise((resolve, reject) => {
    const parts = []; let got = 0;
    function onData(d) {
      parts.push(d); got += d.length;
      if (got >= n) {
        sock.removeListener('data', onData); sock.removeListener('error', onErr);
        const buf = Buffer.concat(parts);
        resolve(buf.subarray(0, n));
      }
    }
    function onErr(e) { sock.removeListener('data', onData); reject(e); }
    sock.on('data', onData); sock.on('error', onErr);
  });
}

function socks5Connect(proxy, host, port) {
  return new Promise(async (resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    sock.setTimeout(30000);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('SOCKS5 代理超时')); });
    sock.on('error', reject);
    sock.once('connect', async () => {
      try {
        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        const head = await readN(sock, 2);
        if (head[0] !== 0x05 || head[1] !== 0x00) throw new Error('SOCKS5 无认证协商失败');
        const hostBuf = Buffer.from(host, 'utf8');
        sock.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]));
        const resp = await readN(sock, 4);
        if (resp[1] !== 0x00) throw new Error('SOCKS5 CONNECT 失败 rep=' + resp[1]);
        const atyp = resp[3];
        let skip = 0;
        if (atyp === 1) skip = 4; else if (atyp === 4) skip = 16; else if (atyp === 3) { const l = await readN(sock, 1); skip = l[0]; }
        await readN(sock, skip + 2);
        resolve(sock);
      } catch (e) { sock.destroy(); reject(e); }
    });
  });
}

function httpConnect(proxy, host, port) {
  return new Promise(async (resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    sock.setTimeout(30000);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('HTTP 代理超时')); });
    sock.on('error', reject);
    sock.once('connect', () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let buf = '';
    function onData(d) {
      buf += d.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx >= 0) {
        sock.removeListener('data', onData);
        const status = buf.slice(0, idx).split('\r\n')[0];
        if (!/ 200 /.test(status)) { sock.destroy(); reject(new Error('HTTP 代理 CONNECT 失败: ' + status)); }
        else resolve(sock);
      }
    }
    sock.on('data', onData);
  });
}

async function tunnel(proxy, host, port) {
  if (proxy.proto === 'socks5') return socks5Connect(proxy, host, port);
  return httpConnect(proxy, host, port);
}

// 通用请求（支持代理 + 字符串/Buffer 请求体）
function rawRequest(method, url, { headers = {}, body = null, proxy } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const port = u.port ? +u.port : (isHttps ? 443 : 80);
    const agent = new (isHttps ? https : http).Agent({
      createConnection: (opts, cb) => {
        (async () => {
          try {
            let sock;
            if (proxy) sock = await tunnel(proxy, u.hostname, port);
            else sock = net.connect(port, u.hostname);
            if (isHttps) {
              const t = tls.connect({ socket: sock, servername: u.hostname, ALPNProtocols: ['http/1.1'] });
              t.once('secureConnect', () => cb(null, t));
              t.once('error', cb);
            } else cb(null, sock);
          } catch (e) { cb(e); }
        })();
      },
    });
    const opts = { method, headers, agent };
    if (body != null) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = (isHttps ? https : http).request(u, opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function requestJSON(method, basePath, body, opts = {}) {
  const proxy = opts.proxy !== undefined ? parseProxy(opts.proxy) : proxyFromEnv();
  const headers = {
    'Authorization': 'Bearer ' + (opts.token || loadToken()),
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
  return rawRequest(method, basePath, { headers, body: body == null ? null : JSON.stringify(body), proxy });
}

async function api(method, path, body, opts = {}) {
  const r = await requestJSON(method, API_BASE + path, body, opts);
  let j; try { j = JSON.parse(r.body.toString('utf8')); } catch { j = { _raw: r.body.toString('utf8').slice(0, 500) }; }
  return { status: r.status, data: j };
}

function isError(j) { return j && j.object === 'error'; }

// ---------- 高层 API ----------
async function whoami(opts = {}) { return api('GET', '/users/me', null, opts); }
async function search(params = {}, opts = {}) {
  const body = Object.assign({ page_size: 100 }, params);
  return api('POST', '/search', body, opts);
}
async function getPage(id, opts = {}) { return api('GET', `/pages/${id}`, null, opts); }
async function getDatabase(id, opts = {}) { return api('GET', `/databases/${id}`, null, opts); }
async function listChildren(id, opts = {}) { return api('GET', `/blocks/${id}/children?page_size=100`, null, opts); }
async function createPage(parent, title, opts = {}) {
  // parent: { type:'workspace' } | { type:'page_id', id } | { type:'database_id', id, props }
  const body = { parent: {}, properties: {} };
  if (parent.type === 'workspace') { body.parent = { type: 'workspace', workspace: true }; }
  else if (parent.type === 'page_id') { body.parent = { page_id: parent.id }; }
  else if (parent.type === 'database_id') { body.parent = { database_id: parent.id }; }
  if (parent.type === 'database_id' && parent.props) body.properties = parent.props;
  if (title != null) body.properties.title = { title: [{ text: { content: title } }] };
  return api('POST', '/pages', body, opts);
}
async function appendBlocks(id, blocks, opts = {}) {
  return api('PATCH', `/blocks/${id}/children`, { children: blocks }, opts);
}
async function archivePage(id, opts = {}) {
  return api('PATCH', `/pages/${id}`, { in_trash: true }, opts);
}
async function deleteBlock(id, opts = {}) {
  // 删除页面的子块（覆盖更新内容用）；不能用于删除 child_page 本身
  return api('DELETE', `/blocks/${id}`, null, opts);
}

// ---------- 文件上传（Direct Upload：create → multipart send → attach） ----------
function mimeFromExt(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv', txt: 'text/plain', md: 'text/markdown',
    zip: 'application/zip', mp3: 'audio/mpeg', mp4: 'video/mp4', mov: 'video/quicktime',
    json: 'application/json',
  };
  return map[e] || 'application/octet-stream';
}

function buildMultipart(boundary, filename, contentType, buf) {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return Buffer.concat([head, buf, tail]);
}

async function uploadFile({ pageId, filePath, proxy } = {}) {
  const proxyObj = proxy !== undefined ? parseProxy(proxy) : proxyFromEnv();
  const name = path.basename(filePath);
  const buf = fs.readFileSync(filePath);
  const token = loadToken();
  const contentType = mimeFromExt(path.extname(filePath));

  // 1) 创建 File Upload 对象（拿 id + upload_url）
  const createRes = await requestJSON('POST', API_BASE + '/file_uploads', {
    filename: name, content_type: contentType, mode: 'single_part',
  }, { proxy, token });
  const createJson = createRes.body.toString('utf8');
  let cj; try { cj = JSON.parse(createJson); } catch { cj = { _raw: createJson }; }
  if (createRes.status >= 400 || isError(cj)) {
    throw new Error('创建文件上传失败 HTTP ' + createRes.status + ': ' + createJson.slice(0, 500));
  }
  const fileId = cj.id;
  const uploadUrl = cj.upload_url || (API_BASE + '/file_uploads/' + fileId + '/send');
  if (!fileId) throw new Error('未取得 file_upload id: ' + createJson.slice(0, 500));

  // 2) multipart/form-data 上传文件内容
  const boundary = '----notion' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
  const mp = buildMultipart(boundary, name, contentType, buf);
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
    'Content-Length': mp.length,
  };
  const sendRes = await rawRequest('POST', uploadUrl, { headers, body: mp, proxy: proxyObj });
  if (sendRes.status >= 300) {
    throw new Error('文件内容上传失败 HTTP ' + sendRes.status + ': ' + sendRes.body.toString('utf8').slice(0, 500));
  }

  // 返回 file_upload id，用于 image/file block 的 file_upload 类型引用
  return { id: fileId, name, size: buf.length };
}

// ---------- markdown → blocks ----------
// 富文本内联解析：**粗** *斜* `码` ~~删~~ [文字](url) [[wiki]] $公式$
function parseInline(text, resolveLink) {
  const out = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~|\$[^$\n]+\$|\[\[[^\]\n]+\]\]|\[[^\]\n]+\]\([^)\n]+\))/g;
  let last = 0; let m;
  const push = (content, ann) => {
    if (!content) return;
    out.push({ type: 'text', text: { content }, annotations: Object.assign({ bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' }, ann) });
  };
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`') && tok.endsWith('`')) push(tok.slice(1, -1), { code: true });
    else if (tok.startsWith('**') && tok.endsWith('**')) push(tok.slice(2, -2), { bold: true });
    else if (tok.startsWith('__') && tok.endsWith('__')) push(tok.slice(2, -2), { bold: true });
    else if (tok.startsWith('*') && tok.endsWith('*')) push(tok.slice(1, -1), { italic: true });
    else if (tok.startsWith('_') && tok.endsWith('_')) push(tok.slice(1, -1), { italic: true });
    else if (tok.startsWith('~~') && tok.endsWith('~~')) push(tok.slice(2, -2), { strikethrough: true });
    else if (tok.startsWith('$') && tok.endsWith('$')) {
      out.push({ type: 'equation', equation: { expression: tok.slice(1, -1) } });
    } else if (tok.startsWith('[[') && tok.endsWith(']]')) {
      const inner = tok.slice(2, -2);
      const [target, alias] = inner.split('|');
      const display = alias || target;
      const url = resolveLink ? resolveLink(target.trim()) : null;
      if (url) out.push({ type: 'text', text: { content: display, link: { url } }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' } });
      else push(display);
    } else if (tok.startsWith('[') && tok.endsWith(')')) {
      const mm = tok.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
      out.push({ type: 'text', text: { content: mm[1], link: { url: mm[2] } }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' } });
    }
    last = m.index + tok.length;
  }
  if (last < text.length) push(text.slice(last));
  return out;
}

function richText(text, resolveLink) {
  const arr = parseInline(text, resolveLink);
  // 单段超 2000 字拆分（Notion rich_text 单对象上限）
  const result = [];
  for (const item of arr) {
    if (item.type === 'text' && item.text.content.length > 2000) {
      const c = item.text.content;
      for (let i = 0; i < c.length; i += 1900) {
        result.push({ type: 'text', text: { content: c.slice(i, i + 1900), link: item.text.link }, annotations: item.annotations });
      }
    } else result.push(item);
  }
  return result.length ? result : [{ type: 'text', text: { content: '' } }];
}

function calloutType(kind) {
  const map = { note: '💡', info: 'ℹ️', tip: '💡', hint: '💡', important: '❗', warning: '⚠️', caution: '⚠️', danger: '🚨', error: '🚨', example: '🧪', abstract: '📄', summary: '📄', tldr: '📄', todo: '✅', success: '✅', question: '❓', quote: '💬' };
  return map[(kind || '').toLowerCase()] || '💡';
}

// 把一个 .md 文本转成 Notion blocks。opts: { resolveLink, uploadImage, baseDir }
function markdownToBlocks(md, opts = {}) {
  const resolveLink = opts.resolveLink || null;
  const uploadImage = opts.uploadImage || null; // (src) => Promise<{url,name}|null>
  let lines = md.replace(/\r\n/g, '\n').split('\n');
  // 跳过 YAML frontmatter
  if (lines[0] && lines[0].trim() === '---') {
    let end = lines.indexOf('---', 1);
    if (end >= 0) lines = lines.slice(end + 1);
  }
  const blocks = [];
  let i = 0;
  const text = (t) => ({ type: 'paragraph', paragraph: { rich_text: richText(t, resolveLink) } });

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') { i++; continue; }

    // 围栏代码块
    let cm = line.match(/^```(.*)$/);
    if (cm) {
      let lang = cm[1].trim(); const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // 跳过结尾 ```
      const langMap = { '': 'plain text', js: 'javascript', jsx: 'javascript', ts: 'typescript', py: 'python', sh: 'shell', bash: 'shell', md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml', cpp: 'c++', cs: 'c#', html: 'html', css: 'css', sql: 'sql', java: 'java', go: 'go', rs: 'rust', rb: 'ruby', php: 'php' };
      blocks.push({ type: 'code', code: { rich_text: [{ type: 'text', text: { content: code.join('\n') } }], language: langMap[lang] || lang || 'plain text' } });
      continue;
    }

    // 标题
    let hm = line.match(/^(#{1,3})\s+(.*)$/);
    if (hm) {
      const lvl = hm[1].length;
      blocks.push({ type: `heading_${lvl}`, [`heading_${lvl}`]: { rich_text: richText(hm[2], resolveLink) } });
      i++; continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) { blocks.push({ type: 'divider', divider: {} }); i++; continue; }

    // 块公式 $$...$$
    if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) {
      blocks.push({ type: 'equation', equation: { expression: trimmed.slice(2, -2) } });
      i++; continue;
    }

    // 引用块 / 呼叫块
    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quoteLines.push(lines[i].replace(/^>\s?/, '')); i++; }
      const content = quoteLines.join('\n');
      const call = content.match(/^\[!(\w+)\]\s*(.*)$/m);
      if (call) {
        const kind = call[1]; const title = call[2] || kind;
        const rest = content.replace(/^\[!\w+\][^\n]*\n?/, '');
        const rich = [];
        if (title) rich.push(...richText(title, resolveLink));
        if (rest) { if (rich.length) rich.push(...richText('\n', resolveLink)); rich.push(...richText(rest, resolveLink)); }
        blocks.push({ type: 'callout', callout: { rich_text: rich, icon: { type: 'emoji', emoji: calloutType(kind) } } });
      } else {
        blocks.push({ type: 'quote', quote: { rich_text: richText(content, resolveLink) } });
      }
      continue;
    }

    // 表格
    if (trimmed.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const headerRow = trimmed.split('|').map(s => s.trim()).filter((s, idx, a) => !(idx === 0 && s === '') && !(idx === a.length - 1 && s === ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        rows.push(lines[i].trim().split('|').map(s => s.trim()));
        i++;
      }
      // Notion table 需要 table_row 子块；这里简化为表格块的表格行
      const tableBlock = { type: 'table', table: { table_width: Math.max(headerRow.length, ...rows.map(r => r.length)), has_column_header: true, has_row_header: false, children: [] } };
      const cell = (c) => [{ type: 'text', text: { content: c || '' } }];
      const headerCells = headerRow.map(c => cell(c));
      while (headerCells.length < tableBlock.table.table_width) headerCells.push(cell(''));
      tableBlock.table.children.push({ type: 'table_row', table_row: { cells: headerCells } });
      for (const r of rows) {
        const cells = r.map(c => cell(c));
        while (cells.length < tableBlock.table.table_width) cells.push(cell(''));
        tableBlock.table.children.push({ type: 'table_row', table_row: { cells: cells.slice(0, tableBlock.table.table_width) } });
      }
      blocks.push(tableBlock);
      continue;
    }

    // 任务列表（允许缩进，按平级处理）
    let tm = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (tm) {
      const items = [];
      while (i < lines.length) {
        const mm = lines[i].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
        if (!mm) break;
        items.push({ checked: /[xX]/.test(mm[1]), text: mm[2] }); i++;
      }
      for (const it of items) blocks.push({ type: 'to_do', to_do: { rich_text: richText(it.text, resolveLink), checked: it.checked } });
      continue;
    }

    // 无序列表（允许缩进，按平级处理）
    let bm = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bm) {
      const items = [];
      while (i < lines.length) {
        const mm = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        if (!mm) break;
        items.push(mm[1]); i++;
      }
      for (const it of items) blocks.push({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(it, resolveLink) } });
      continue;
    }

    // 有序列表（允许缩进，按平级处理）
    let om = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (om) {
      const items = [];
      while (i < lines.length) {
        const mm = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
        if (!mm) break;
        items.push(mm[1]); i++;
      }
      for (const it of items) blocks.push({ type: 'numbered_list_item', numbered_list_item: { rich_text: richText(it, resolveLink) } });
      continue;
    }

    // 图片：![alt](src) 或 ![[image.png]]
    let img = line.match(/^!\[(.*)\]\((.*)\)\s*$/);
    let emb = line.match(/^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/);
    if (img || emb) {
      const src = img ? img[2] : emb[1];
      const block = { pendingImage: true, src, alt: img ? img[1] : (emb[1] || '') };
      blocks.push(block);
      i++; continue;
    }

    // 普通段落（合并到空行）
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3})\s/.test(lines[i]) && !/^```/.test(lines[i]) && !/^>/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+[.)]\s/.test(lines[i]) && !/^!\[/.test(lines[i]) && !/^!\[\[/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    blocks.push(text(para.join('\n')));
  }

  // 处理 pendingImage（异步，故在同步函数外处理）
  return { blocks, images: blocks.filter(b => b.pendingImage).map(b => ({ src: b.src, alt: b.alt, index: blocks.indexOf(b) })) };
}

// 把 blocks 里标记的 pendingImage 替换为真实 image 块（需要 uploadImage 返回 {id}）
async function resolveImages(result, uploadImage) {
  for (const info of result.images) {
    let imgObj = null;
    if (/^https?:\/\//i.test(info.src)) {
      imgObj = { type: 'external', external: { url: info.src } };
    } else if (uploadImage) {
      const up = await uploadImage(info.src);
      if (up && up.id) imgObj = { type: 'file_upload', file_upload: { id: up.id } };
    }
    if (imgObj) {
      if (info.alt) imgObj.caption = [{ type: 'text', text: { content: info.alt } }];
      result.blocks[info.index] = { type: 'image', image: imgObj };
    } else {
      // 无法解析：退回文本提示
      result.blocks[info.index] = { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '（未导入的图片：' + info.src + '）' } }] } };
    }
  }
  return result.blocks;
}

// ---------- 工具 ----------
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && i + 1 < args.length) ? args[i + 1] : undefined;
}
function print(o) { process.stdout.write(JSON.stringify(o, null, 2)); }

const USAGE = `notion_api.cjs <子命令> [参数] [--proxy socks5://host:port]

子命令：
  whoami                                    验证 token，返回 bot/workspace
  search [--type page|database] [--query q]  搜索页面/数据库
  page --id <page_id>                        页面详情
  children --id <page_or_block_id>           列出子块
  create-workspace-page --title <标题>        新建顶层页面（parent=workspace）
  create-page --parent <page_id> --title <t>  新建子页面
  import-md --parent <page_id> --title <t> --file <md>   新建页面并导入 markdown
  upload-file --parent <page_id> --file <本地路径>        上传文件返回 file_upload id
  archive-page --id <page_id>                 归档（移入回收站）页面
  delete-block --id <block_id>                删除一个子块（覆盖更新内容用）`;

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(USAGE); return; }
  const proxy = argValue(args, '--proxy');
  const opts = proxy ? { proxy } : {};

  switch (cmd) {
    case 'whoami': return print(await whoami(opts));
    case 'search': {
      const type = argValue(args, '--type') || 'page';
      const q = argValue(args, '--query') || '';
      const body = { query: q, page_size: 100, filter: { value: type, property: 'object' } };
      return print(await search(body, opts));
    }
    case 'page': {
      const id = argValue(args, '--id'); if (!id) throw new Error('--id 必填');
      return print(await getPage(id, opts));
    }
    case 'children': {
      const id = argValue(args, '--id'); if (!id) throw new Error('--id 必填');
      return print(await listChildren(id, opts));
    }
    case 'create-workspace-page': {
      const title = argValue(args, '--title'); if (!title) throw new Error('--title 必填');
      return print(await createPage({ type: 'workspace' }, title, opts));
    }
    case 'create-page': {
      const parent = argValue(args, '--parent'); const title = argValue(args, '--title');
      if (!parent || !title) throw new Error('--parent 与 --title 必填');
      return print(await createPage({ type: 'page_id', id: parent }, title, opts));
    }
    case 'import-md': {
      const parent = argValue(args, '--parent'); const title = argValue(args, '--title');
      const file = argValue(args, '--file');
      if (!parent || !file) throw new Error('--parent 与 --file 必填');
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + abs);
      const md = fs.readFileSync(abs, 'utf8');
      const name = title || path.basename(abs).replace(/\.md$/i, '');
      const pg = await createPage({ type: 'page_id', id: parent }, name, opts);
      const pgId = pg.data && pg.data.id;
      if (!pgId) return print(pg);
      const baseDir = path.dirname(abs);
      const conv = markdownToBlocks(md, { baseDir });
      const blocks = await resolveImages(conv, async (src) => {
        const f = path.isAbsolute(src) ? src : path.resolve(baseDir, src);
        if (!fs.existsSync(f)) return null;
        try { return await uploadFile({ pageId: pgId, filePath: f, proxy }); } catch { return null; }
      });
      for (let s = 0; s < blocks.length; s += 100) {
        const chunk = blocks.slice(s, s + 100);
        await appendBlocks(pgId, chunk, opts);
      }
      return print({ page: pg.data, blocks_count: blocks.length });
    }
    case 'upload-file': {
      const parent = argValue(args, '--parent'); const file = argValue(args, '--file');
      if (!parent || !file) throw new Error('--parent 与 --file 必填');
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + abs);
      return print(await uploadFile({ pageId: parent, filePath: abs, proxy }));
    }
    case 'archive-page': {
      const id = argValue(args, '--id'); if (!id) throw new Error('--id 必填');
      return print(await archivePage(id, opts));
    }
    case 'delete-block': {
      const id = argValue(args, '--id'); if (!id) throw new Error('--id 必填');
      return print(await deleteBlock(id, opts));
    }
    default:
      throw new Error('未知子命令: ' + (cmd || '(空)') + '\n' + USAGE);
  }
}

if (require.main === module) {
  main().catch(e => {
    process.stderr.write(JSON.stringify({ code: -100, msg: e && e.message ? e.message : String(e) }));
    process.exit(1);
  });
}

module.exports = {
  API_BASE, NOTION_VERSION,
  loadToken, parseProxy, rawRequest, requestJSON, api, isError,
  whoami, search, getPage, getDatabase, listChildren, createPage, appendBlocks, archivePage, deleteBlock, uploadFile,
  markdownToBlocks, resolveImages, parseInline, mimeFromExt,
};
