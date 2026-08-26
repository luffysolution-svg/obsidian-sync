#!/usr/bin/env node
'use strict';
/*
 * ima_setup.cjs — ima 凭证检测 + 交互式引导配置 + 验证（跨平台，Node >= 18）
 *
 * 用法：
 *   node ima_setup.cjs                          # 检测；缺失则交互式引导配置并验证
 *   node ima_setup.cjs --check                  # 只检测（输出 JSON）
 *   node ima_setup.cjs --set <client_id> <api_key>   # 非交互写入并验证
 *
 * 凭证来源：https://ima.qq.com/agent-interface
 * 存储：~/.config/ima/client_id 与 ~/.config/ima/api_key（也可用环境变量覆盖）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const DIR = path.join(os.homedir(), '.config', 'ima');
const CLIENT_ID_PATH = path.join(DIR, 'client_id');
const API_KEY_PATH = path.join(DIR, 'api_key');

function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } }

function getCreds() {
  const clientId = process.env.IMA_OPENAPI_CLIENTID || process.env.IMA_CLIENT_ID || readFileSafe(CLIENT_ID_PATH);
  const apiKey = process.env.IMA_OPENAPI_APIKEY || process.env.IMA_API_KEY || readFileSafe(API_KEY_PATH);
  return { clientId, apiKey };
}

async function verify(clientId, apiKey) {
  try {
    const r = await fetch('https://ima.qq.com/openapi/wiki/v1/get_addable_knowledge_base_list', {
      method: 'POST',
      headers: {
        'ima-openapi-clientid': clientId,
        'ima-openapi-apikey': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cursor: '', limit: 10 }),
    });
    const j = await r.json();
    if (j.code === 0) {
      const list = (j.data && j.data.addable_knowledge_base_list) || [];
      return { ok: true, kbs: list.map(x => x.name) };
    }
    return { ok: false, reason: j.msg || ('code ' + j.code) };
  } catch (e) {
    return { ok: false, reason: '网络错误: ' + (e.message || e) };
  }
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, ans => { rl.close(); res((ans || '').trim()); }));
}

function save(clientId, apiKey) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CLIENT_ID_PATH, clientId);
  fs.writeFileSync(API_KEY_PATH, apiKey);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];

  if (mode === '--check') {
    const c = getCreds();
    console.log(JSON.stringify({ client_id: c.clientId ? 'set' : 'MISSING', api_key: c.apiKey ? 'set' : 'MISSING' }));
    return;
  }
  if (mode === '--set' && args.length >= 3) {
    save(args[1], args[2]);
    console.log('已保存到 ' + DIR);
    const v = await verify(args[1], args[2]);
    console.log(JSON.stringify(v));
    return;
  }

  const c = getCreds();
  if (c.clientId && c.apiKey) {
    console.log('检测到 ima 凭证，验证中...');
    const v = await verify(c.clientId, c.apiKey);
    if (v.ok) console.log('凭证有效。可添加的知识库：' + JSON.stringify(v.kbs));
    else console.log('凭证验证失败：' + v.reason + '（可用 node ima_setup.cjs --set 重新配置）');
    return;
  }

  console.log('未检测到 ima 凭证。');
  console.log('获取方式：打开 https://ima.qq.com/agent-interface ，复制 Client ID 和 API Key。');
  const clientId = await prompt('请输入 Client ID: ');
  const apiKey = await prompt('请输入 API Key: ');
  if (!clientId || !apiKey) { console.log('已取消，未写入。'); return; }
  save(clientId, apiKey);
  console.log('已保存到 ' + DIR + ' ，验证中...');
  const v = await verify(clientId, apiKey);
  if (v.ok) console.log('配置成功。可添加的知识库：' + JSON.stringify(v.kbs));
  else console.log('验证失败：' + v.reason + '（可用 node ima_setup.cjs --set <cid> <key> 重试）');
}

main().catch(e => { console.error(e.message); process.exit(1); });
