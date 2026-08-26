#!/usr/bin/env node
'use strict';
/*
 * notion_setup.cjs — Notion 凭证检测 + 交互式引导配置 + 验证（跨平台，Node >= 18）
 *
 * 用法：
 *   node notion_setup.cjs                          # 检测；缺失则交互式引导配置并验证
 *   node notion_setup.cjs --check                  # 只检测（输出 JSON，脱敏）
 *   node notion_setup.cjs --set <token> [--proxy socks5://host:port]   # 非交互写入并验证
 *
 * 凭证来源：https://www.notion.so/profile/integrations → New integration（Internal）→ Internal Integration Secret（ntn_ 或 secret_ 开头）
 * 存储：~/.config/notion/token（也可用环境变量 NOTION_TOKEN 覆盖）
 * 注意：新建的 integration 需要在目标页面/数据库里点「… → Connections → 连接该 integration」才有权限。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { whoami, parseProxy } = require('./notion_api.cjs');

const DIR = path.join(os.homedir(), '.config', 'notion');
const TOKEN_PATH = path.join(DIR, 'token');

function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } }

function getToken() {
  return process.env.NOTION_TOKEN || process.env.NOTION_API_KEY || readFileSafe(TOKEN_PATH);
}

async function verify(token, proxy) {
  try {
    const r = await whoami({ token, proxy });
    if (r.data && r.data.object === 'user') {
      const u = r.data;
      return {
        ok: true,
        bot: u.name,
        workspace: u.bot && u.bot.workspace_name,
        owner: u.bot && u.bot.owner && u.bot.owner.user ? (u.bot.owner.user.name || u.bot.owner.user.person?.email) : null,
        max_file_upload_bytes: u.bot && u.bot.workspace_limits && u.bot.workspace_limits.max_file_upload_size_in_bytes,
      };
    }
    return { ok: false, reason: (r.data && (r.data.message || r.data.code)) || ('HTTP ' + r.status) };
  } catch (e) {
    return { ok: false, reason: '网络错误: ' + (e.message || e) };
  }
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, ans => { rl.close(); res((ans || '').trim()); }));
}

function save(token) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, token);
}

function mask(t) { return t ? (t.slice(0, 6) + '...' + t.slice(-4)) : 'MISSING'; }

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const proxy = args.includes('--proxy') ? args[args.indexOf('--proxy') + 1] : undefined;

  if (mode === '--check') {
    const t = getToken();
    console.log(JSON.stringify({ token: t ? 'set' : 'MISSING', masked: mask(t) }));
    return;
  }
  if (mode === '--set' && args.length >= 2) {
    save(args[1]);
    console.log('已保存到 ' + TOKEN_PATH);
    const v = await verify(args[1], proxy);
    console.log(JSON.stringify(v, null, 2));
    return;
  }

  const t = getToken();
  if (t) {
    console.log('检测到 Notion 凭证，验证中...');
    const v = await verify(t, proxy);
    if (v.ok) console.log('凭证有效。集成=' + v.bot + '，工作区=' + v.workspace + '，owner=' + v.owner);
    else console.log('凭证验证失败：' + v.reason + '（可用 node notion_setup.cjs --set <token> 重新配置）');
    return;
  }

  console.log('未检测到 Notion 凭证。');
  console.log('获取方式：');
  console.log('  1) 打开 https://www.notion.so/profile/integrations');
  console.log('  2) New integration → 选 Internal → 起名（如 Obsidian Sync）→ Submit');
  console.log('  3) 复制 Internal Integration Secret（ntn_ 或 secret_ 开头）');
  console.log('  4) 在你要同步的 Notion 页面/数据库里点右上「… → Connections → 连接该 integration」');
  const token = await prompt('请输入 Token: ');
  if (!token) { console.log('已取消，未写入。'); return; }
  save(token);
  console.log('已保存到 ' + TOKEN_PATH + ' ，验证中...');
  const v = await verify(token, proxy);
  if (v.ok) console.log('配置成功。集成=' + v.bot + '，工作区=' + v.workspace + '，owner=' + v.owner);
  else console.log('验证失败：' + v.reason + '（可用 node notion_setup.cjs --set <token> 重试；注意 integration 是否已连接到目标页面）');
}

main().catch(e => { console.error(e.message); process.exit(1); });
