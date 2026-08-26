#!/usr/bin/env node
'use strict';
/*
 * sync_feishu_to_obsidian.cjs — 飞书 → Obsidian 反向导入（v1.6.0，实验性）
 *
 * 用法：
 *   node sync_feishu_to_obsidian.cjs --url <docx_url_or_token> --out <vault目录> [--attach-dir assets] [--as user] [--dry-run]
 *   node sync_feishu_to_obsidian.cjs --folder <folder_token> --out <vault目录> [--attach-dir assets] [--as user] [--dry-run]
 *
 * 流程：
 *   1) lark-cli drive +export --file-extension markdown 导出飞书 docx → 标准 markdown
 *   2) 解析 markdown 中的飞书内链图片 URL（internal-api-drive-stream.feishu.cn/...）
 *      并【立即下载】到 Obsidian 附件目录（默认同目录 assets/）——内链 URL 带时效，
 *      必须导出后立刻下载
 *   3) 图片引用改写为相对路径 ![](assets/image-xx.png)
 *   4) 清理 <title> 首行元数据，写入 --out 目录
 *
 * 依赖：Node ≥ 18（全局 fetch）、lark-cli（Windows 走 shell shim，或设 LARK_CLI 环境变量指定命令）
 * 已知限制：只处理在线 docx；shortcut 跳过；原生 file 跳过；公式块导出为文本（飞书侧限制）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const IMG_RE = /https:\/\/internal-api-drive-stream\.(?:feishu|feishu\.cn|larksuite)\.cn\/[^)\s]+/g;

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && i + 1 < args.length) ? args[i + 1] : undefined;
}

let _runJs = null;
// 定位 lark-cli 的 Node 入口（npm 全局 @larksuite/cli/scripts/run.js），跨平台直接 node 调用
function larkRunJs() {
  if (_runJs !== null) return _runJs;
  _runJs = '';
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    const prefix = execFileSync(process.execPath, [npmCli, 'prefix', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const p = path.join(prefix, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
    if (fs.existsSync(p)) _runJs = p;
  } catch { /* 找不到则报错提示 */ }
  return _runJs;
}

// 调 lark-cli（node run.js），返回解析后的 JSON（进度信息走 stderr，不影响 stdout JSON）
function lark(args, cwd) {
  let out;
  try {
    if (process.env.LARK_CLI) {
      // LARK_CLI 自定义命令，如 "node C:/path/run.js" 或任意可执行命令
      const parts = process.env.LARK_CLI.split(/\s+/).filter(Boolean);
      out = execFileSync(parts[0], [...parts.slice(1), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } else {
      const runJs = larkRunJs();
      if (!runJs) throw new Error('未找到 lark-cli 入口（npm 全局 @larksuite/cli 未安装？可设 LARK_CLI 环境变量指定）');
      out = execFileSync(process.execPath, [runJs, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    }
  } catch (e) {
    const msg = e.stdout || e.stderr || e.message;
    throw new Error(`lark-cli 调用失败: ${args.join(' ')}\n${String(msg).slice(0, 400)}`);
  }
  const s = out.indexOf('{');
  if (s < 0) throw new Error('lark-cli 无 JSON 输出: ' + out.slice(0, 300));
  let j;
  try { j = JSON.parse(out.slice(s)); } catch { throw new Error('JSON 解析失败: ' + out.slice(0, 300)); }
  if (!j.ok) throw new Error(`lark-cli 返回错误: ${JSON.stringify(j.error || j).slice(0, 400)}`);
  return j.data;
}

// 导出单篇 docx → markdown，返回 md 文本（ref 可为完整 URL 或裸 token）
function exportDocx(ref, tmpDir, as) {
  const args = String(ref).startsWith('http')
    ? ['drive', '+export', '--url', ref, '--file-extension', 'markdown', '--as', as, '--json']
    : ['drive', '+export', '--token', ref, '--doc-type', 'docx', '--file-extension', 'markdown', '--as', as, '--json'];
  const data = lark(args, tmpDir);
  const file = path.join(tmpDir, data.file_name);
  if (!fs.existsSync(file)) throw new Error('导出文件不存在: ' + file);
  return { name: data.file_name.replace(/\.md$/i, ''), md: fs.readFileSync(file, 'utf8') };
}

// 图片本地化：下载内链图片到附件目录，改写引用；返回改写后的 md
async function localizeImages(md, outDir, attachDir) {
  const urls = [...new Set(md.match(IMG_RE) || [])];
  if (urls.length === 0) return { md, ok: 0, fail: 0 };
  const attachPath = path.join(outDir, attachDir);
  fs.mkdirSync(attachPath, { recursive: true });
  let ok = 0, fail = 0;
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    try {
      const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get('content-type') || '';
      const ext = ct.includes('jpeg') ? '.jpg' : ct.includes('gif') ? '.gif' : ct.includes('webp') ? '.webp' : ct.includes('svg') ? '.svg' : '.png';
      const fname = 'image-' + String(i + 1).padStart(2, '0') + ext;
      fs.writeFileSync(path.join(attachPath, fname), buf);
      md = md.split(u).join('![](' + attachDir + '/' + fname + ')');
      ok++;
    } catch (e) {
      fail++;
      console.error(`  ⚠️ 图片下载失败 ${u.slice(0, 90)}... : ${e.message}`);
    }
  }
  return { md, ok, fail };
}

// 清理飞书导出元数据首行 <title>xxx</title>
function stripTitleLine(md) {
  return md.replace(/^<title>.*<\/title>\s*\r?\n?/, '');
}

// 目标文件名去重（同名文档加 -2/-3 后缀）
function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  let n = 2;
  while (fs.existsSync(p)) {
    p = path.join(dir, base + '-' + n + ext);
    n++;
  }
  return p;
}

// 处理单篇：导出 → 图片本地化 → 落盘；返回 { name, ok, fail, outFile }
// 每篇使用独立临时目录（lark-cli 导出同名文件默认不覆盖，批量同名文档会冲突）
async function processOne(ref, outDir, attachDir, as, dryRun) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2o-'));
  try {
    const { name, md } = exportDocx(ref, tmpDir, as);
    let cleaned = stripTitleLine(md);
    if (!dryRun) {
      const { md: localized, ok, fail } = await localizeImages(cleaned, outDir, attachDir);
      cleaned = localized;
      const outFile = uniquePath(outDir, name, '.md');
      fs.writeFileSync(outFile, cleaned, 'utf8');
      return { name, ok, fail, outFile };
    }
    console.log(`[dry-run] ${name}（${cleaned.length} 字符，图片 ${(cleaned.match(IMG_RE) || []).length} 个）`);
    return { name, ok: 0, fail: 0, outFile: null };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 递归列飞书文件夹：返回 [{name, url, relOut}]（folder 递归，shortcut/file 跳过并提示）
function listFolderTree(folderToken, as, baseOut) {
  const items = [];
  function walk(tok, relOut) {
    const files = lark(['drive', 'files', 'list', '--folder-token', tok, '--as', as, '--format', 'json'], os.tmpdir()).files || [];
    for (const f of files) {
      if (f.type === 'folder') {
        walk(f.token, path.join(relOut, f.name));
      } else if (f.type === 'docx') {
        items.push({ name: f.name, url: f.url, relOut });
      } else if (f.type === 'shortcut') {
        console.log(`  ⏭️  跳过 shortcut: ${f.name}（指向 ${f.shortcut_info && f.shortcut_info.target_token}）`);
      } else {
        console.log(`  ⏭️  跳过非 docx: ${f.name}（type=${f.type}）`);
      }
    }
  }
  walk(folderToken, '');
  return items;
}

async function main() {
  const args = process.argv.slice(2);
  const url = argValue(args, '--url');
  const folder = argValue(args, '--folder');
  const out = argValue(args, '--out');
  const attachDir = argValue(args, '--attach-dir') || 'assets';
  const as = argValue(args, '--as') || 'user';
  const dryRun = args.includes('--dry-run');

  if (!out || (!url && !folder)) {
    console.error('用法:');
    console.error('  node sync_feishu_to_obsidian.cjs --url <docx_url_or_token> --out <vault目录> [--attach-dir assets] [--as user] [--dry-run]');
    console.error('  node sync_feishu_to_obsidian.cjs --folder <folder_token> --out <vault目录> [--attach-dir assets] [--as user] [--dry-run]');
    process.exit(1);
  }
  const outDir = path.resolve(out);
  fs.mkdirSync(outDir, { recursive: true });

  let okCount = 0, failCount = 0, imgOk = 0, imgFail = 0;
  try {
    if (url) {
      console.log(`导出并处理: ${url}`);
      const r = await processOne(url, outDir, attachDir, as, dryRun);
      okCount = r.fail === 0 ? 1 : 0;
      imgOk = r.ok; imgFail = r.fail;
      if (!dryRun) console.log(`  ✅ ${r.name} -> ${r.outFile}`);
    } else {
      console.log(`列出文件夹 ${folder} 并处理...`);
      const items = listFolderTree(folder, as, outDir);
      console.log(`发现 ${items.length} 个 docx`);
      for (const it of items) {
        try {
          const targetDir = path.join(outDir, it.relOut);
          fs.mkdirSync(targetDir, { recursive: true });
          const r = await processOne(it.url, targetDir, attachDir, as, dryRun);
          okCount++;
          imgOk += r.ok; imgFail += r.fail;
          if (!dryRun) console.log(`  ✅ ${path.join(it.relOut, it.name)} -> ${r.outFile}`);
        } catch (e) {
          failCount++;
          console.error(`  ❌ ${it.name}: ${e.message}`);
        }
      }
    }
  } finally {
    // 临时目录已由各 processOne 内部清理
  }

  console.log(`\n=== 完成：成功 ${okCount}，失败 ${failCount}；图片本地化 ${imgOk} 成功 / ${imgFail} 失败 ===`);
  console.log(`输出目录: ${outDir}`);
  if (imgFail > 0) console.log('⚠️ 有图片下载失败：内链 URL 已过期需重新导出，或飞书侧无权限。可重跑该篇。');
  if (failCount > 0) process.exitCode = 1;
}

main().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
