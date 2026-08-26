#!/usr/bin/env node
'use strict';
/*
 * ima_api.cjs — 腾讯 ima 知识库 OpenAPI 封装（零依赖，Node >= 18）
 *
 * 凭证读取优先级：环境变量 IMA_OPENAPI_CLIENTID/IMA_OPENAPI_APIKEY
 *                （兼容 IMA_CLIENT_ID/IMA_API_KEY）→ ~/.config/ima/{client_id,api_key}
 * 凭证来源：https://ima.qq.com/agent-interface
 *
 * 用法：
 *   node ima_api.cjs list-kbs
 *   node ima_api.cjs kb-info --ids <kb_id[,kb_id]>
 *   node ima_api.cjs list --kb <kb_id> [--folder <folder_id>]
 *   node ima_api.cjs search-kb --query <关键词>
 *   node ima_api.cjs search --kb <kb_id> --query <关键词>
 *   node ima_api.cjs check-names --kb <kb_id> [--folder <folder_id>] --names "a.md,b.png"
 *   node ima_api.cjs import-url --kb <kb_id> --folder <folder_id> --urls "https://..."
 *   node ima_api.cjs import-file --kb <kb_id> [--folder <folder_id>] --file <本地路径> [--media-type <n>]
 *
 * 说明：
 *   - 响应统一 JSON：实测知识库接口返回 {code, msg, data}；旧文档写 {retcode, errmsg, data}。isOk() 两者都判。
 *   - import-file 走 create_media → COS 临时凭证上传 → add_knowledge 三步。
 *   - COS 上传用 Tencent COS V5 的 q-sign-algorithm=sha1 签名（临时密钥，已真机校准）。
 *     要点：secret_key 用原始字符串（勿 base64 解码）；HttpString 末尾保留换行；
 *     SignKey = HMAC-SHA1(secret_key, KeyTime).toString('hex')（hex 字符串再当第二次 HMAC 的 key）；
 *     域名用 bucket_name.cos.region.myqcloud.com（bucket_name 已含 -appid，勿用 custom_domain）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = 'https://ima.qq.com';
const KB = 'openapi/wiki/v1';

// ---------- 凭证 ----------
function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}
function loadCredentials() {
  const clientId = process.env.IMA_OPENAPI_CLIENTID || process.env.IMA_CLIENT_ID ||
    readFileSafe(path.join(os.homedir(), '.config/ima/client_id'));
  const apiKey = process.env.IMA_OPENAPI_APIKEY || process.env.IMA_API_KEY ||
    readFileSafe(path.join(os.homedir(), '.config/ima/api_key'));
  if (!clientId || !apiKey) {
    throw new Error('缺少 IMA 凭证。请设置 IMA_OPENAPI_CLIENTID / IMA_OPENAPI_APIKEY，或放到 ~/.config/ima/{client_id,api_key}（获取地址 https://ima.qq.com/agent-interface）。');
  }
  return { clientId, apiKey };
}

async function postJson(apiPath, body) {
  const { clientId, apiKey } = loadCredentials();
  const res = await fetch(`${BASE_URL}/${apiPath}`, {
    method: 'POST',
    headers: {
      'ima-openapi-clientid': clientId,
      'ima-openapi-apikey': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`响应非 JSON (HTTP ${res.status}): ${text.slice(0, 400)}`); }
}

// 兼容两种响应信封
function isOk(r) {
  if (r && typeof r.retcode === 'number') return r.retcode === 0;
  if (r && typeof r.code === 'number') return r.code === 0;
  return !(r && r.error);
}
function errMsg(r) {
  return (r && (r.errmsg || r.msg || r.error)) || JSON.stringify(r);
}

// ---------- media_type / content-type 映射 ----------
function mediaTypeFromExt(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  const map = {
    md: 7, markdown: 7, mark: 7,
    png: 9, jpg: 9, jpeg: 9, webp: 9,
    pdf: 1, doc: 3, docx: 3, ppt: 4, pptx: 4,
    xls: 5, xlsx: 5, csv: 5, txt: 13, xmind: 14,
  };
  return map[e] || null;
}
function contentTypeFromExt(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  const map = {
    md: 'text/markdown', markdown: 'text/markdown', mark: 'text/markdown',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv', txt: 'text/plain', xmind: 'application/x-xmind',
  };
  return map[e] || 'application/octet-stream';
}

// ---------- COS 上传（Tencent COS V5 签名） ----------
function hmacSha1(key, data) { return crypto.createHmac('sha1', key).update(data, 'utf8').digest(); }
function sha1Hex(data) { return crypto.createHash('sha1').update(data, 'utf8').digest('hex'); }

function cosAuthorization(cred, method, uriPath, headersToSign) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now};${now + 3600}`;
  // secret_key 用原始字符串（勿 base64 解码）；SignKey 必须转 hex 字符串再当第二次 HMAC 的 key
  const signKey = hmacSha1(cred.secret_key, keyTime).toString('hex');
  const headerKeys = Object.keys(headersToSign).sort();
  const headerStr = headerKeys.map(k => `${k}=${encodeURIComponent(headersToSign[k])}`).join('&');
  const headerList = headerKeys.join(';');
  const httpString = `${method}\n${uriPath}\n\n${headerStr}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`;
  const signature = hmacSha1(signKey, stringToSign).toString('hex');
  return `q-sign-algorithm=sha1&q-ak=${cred.secret_id}&q-sign-time=${keyTime}&q-key-time=${keyTime}` +
    `&q-header-list=${headerList}&q-url-param-list=&q-signature=${signature}`;
}

async function cosUpload(cred, cosKey, buffer, contentType) {
  // 用标准 COS 上传域名；bucket_name 已含 -appid，不要再拼 appid，也不要用 custom_domain（那是 CDN 读取域名，不接受 PUT）
  const host = `${cred.bucket_name}.cos.${cred.region}.myqcloud.com`;
  const uriPath = '/' + cosKey.split('/').map(encodeURIComponent).join('/');
  const headersToSign = {
    host,
    'x-cos-security-token': cred.token,
  };
  const authorization = cosAuthorization(cred, 'put', uriPath, headersToSign);
  const res = await fetch(`https://${host}${uriPath}`, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'x-cos-security-token': cred.token,
      'Content-Type': contentType,
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`COS 上传失败 HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
}

// ---------- 导入文件（create_media → COS → add_knowledge） ----------
async function importFile({ kb, folder, file, mediaType }) {
  const name = path.basename(file);
  const stat = fs.statSync(file);
  const ext = path.extname(file).replace(/^\./, '');
  const contentType = contentTypeFromExt(ext);
  const buffer = fs.readFileSync(file);

  const cm = await postJson(`${KB}/create_media`, {
    file_name: name,
    file_size: stat.size,
    content_type: contentType,
    knowledge_base_id: kb,
    file_ext: ext,
  });
  if (!isOk(cm)) return { ok: false, error: errMsg(cm), raw: cm };

  const data = cm.data;
  const mediaId = data.media_id;
  const cred = data.cos_credential;

  await cosUpload(cred, cred.cos_key, buffer, contentType);

  const ak = await postJson(`${KB}/add_knowledge`, {
    media_type: mediaType,
    media_id: mediaId,
    title: name,
    knowledge_base_id: kb,
    ...(folder ? { folder_id: folder } : {}),
    file_info: {
      cos_key: cred.cos_key,
      file_size: stat.size,
      last_modify_time: Math.floor(stat.mtimeMs / 1000),
      file_name: name,
    },
  });

  return { ok: isOk(ak), media_id: mediaId, title: name, add_knowledge: ak };
}

// ---------- CLI ----------
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && i + 1 < args.length) ? args[i + 1] : undefined;
}
function print(o) { process.stdout.write(JSON.stringify(o, null, 2)); }

const USAGE = `ima_api.cjs <子命令> [参数]

子命令：
  list-kbs                               列出可添加内容的知识库
  kb-info --ids <kb_id[,kb_id]>          知识库详情
  list --kb <kb_id> [--folder <id>]      浏览知识库/文件夹
  search-kb --query <关键词>             搜索知识库列表
  search --kb <kb_id> --query <关键词>   库内搜索
  check-names --kb <id> [--folder <id>] --names "a.md,b.png"   查重
  import-url --kb <id> --folder <id> --urls "https://..."      导入网页/公众号
  import-file --kb <id> [--folder <id>] --file <路径> [--media-type <n>]  导入文件
  create-folder --kb <id> --name <名> [--parent <父folder_media_id>]  新建文件夹（parent 传父文件夹 media_id）
  create-kb --name <名> [--type KBT_MINE_KB]  新建知识库（type: KBT_MINE_KB/KBT_SHARED_KB/KBT_SUBSCRIBED_CREATE_KB）`;

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(USAGE); return; }

  switch (cmd) {
    case 'list-kbs':
      return print(await postJson(`${KB}/get_addable_knowledge_base_list`, { cursor: '', limit: 50 }));
    case 'kb-info': {
      const ids = String(argValue(args, '--ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!ids.length) throw new Error('--ids 必填');
      return print(await postJson(`${KB}/get_knowledge_base`, { ids }));
    }
    case 'list': {
      const kb = argValue(args, '--kb'); const folder = argValue(args, '--folder');
      if (!kb) throw new Error('--kb 必填');
      const body = { cursor: '', limit: 50, knowledge_base_id: kb };
      if (folder) body.folder_id = folder;
      return print(await postJson(`${KB}/get_knowledge_list`, body));
    }
    case 'search-kb': {
      const q = argValue(args, '--query');
      if (!q) throw new Error('--query 必填');
      return print(await postJson(`${KB}/search_knowledge_base`, { query: q, cursor: '', limit: 50 }));
    }
    case 'search': {
      const kb = argValue(args, '--kb'); const q = argValue(args, '--query');
      if (!kb || !q) throw new Error('--kb 与 --query 必填');
      return print(await postJson(`${KB}/search_knowledge`, { query: q, cursor: '', knowledge_base_id: kb }));
    }
    case 'check-names': {
      const kb = argValue(args, '--kb'); const folder = argValue(args, '--folder');
      const names = String(argValue(args, '--names') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!kb || !names.length) throw new Error('--kb 与 --names 必填');
      const params = names.map(n => ({ name: n, media_type: mediaTypeFromExt(path.extname(n)) }));
      const body = { params, knowledge_base_id: kb };
      if (folder) body.folder_id = folder;
      return print(await postJson(`${KB}/check_repeated_names`, body));
    }
    case 'import-url': {
      const kb = argValue(args, '--kb'); const folder = argValue(args, '--folder');
      const urls = String(argValue(args, '--urls') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!kb || !folder || !urls.length) throw new Error('--kb / --folder / --urls 必填');
      return print(await postJson(`${KB}/import_urls`, { knowledge_base_id: kb, folder_id: folder, urls }));
    }
    case 'import-file': {
      const kb = argValue(args, '--kb'); const folder = argValue(args, '--folder');
      const file = argValue(args, '--file');
      if (!kb || !file) throw new Error('--kb 与 --file 必填');
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + abs);
      let mt = argValue(args, '--media-type');
      if (!mt) {
        mt = mediaTypeFromExt(path.extname(abs));
        if (!mt) throw new Error('无法识别 media_type，请用 --media-type 指定（扩展名: ' + path.extname(abs) + '）');
      }
      return print(await importFile({ kb, folder, file: abs, mediaType: Number(mt) }));
    }
    case 'create-folder': {
      const kb = argValue(args, '--kb'); const name = argValue(args, '--name'); const parent = argValue(args, '--parent');
      if (!kb || !name) throw new Error('--kb 与 --name 必填');
      const body = { name, knowledge_base_id: kb };
      if (parent) body.folder_id = parent; // 父参数名是 folder_id（parent_folder_id 会被忽略）
      return print(await postJson(`${KB}/create_folder`, body));
    }
    case 'create-kb': {
      const name = argValue(args, '--name'); const type = argValue(args, '--type') || 'KBT_MINE_KB';
      if (!name) throw new Error('--name 必填');
      return print(await postJson(`${KB}/create_knowledge_base`, { name, type }));
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

// 供其它脚本 require 复用
module.exports = {
  KB,
  postJson,
  importFile,
  mediaTypeFromExt,
  contentTypeFromExt,
  isOk,
  errMsg,
  loadCredentials,
  createFolder(kb, name, parent) {
    const body = { name, knowledge_base_id: kb };
    if (parent) body.folder_id = parent; // 父参数名是 folder_id（parent_folder_id 会被忽略）
    return postJson(`${KB}/create_folder`, body);
  },
  createKb(name, type) {
    return postJson(`${KB}/create_knowledge_base`, { name, type: type || 'KBT_MINE_KB' });
  },
};
