// NFO 编辑器 - 磁力搜索代理（bt4g 专用版，2026-08-12 修订，Vercel Edge Function）
//
// 部署目标：Vercel（免费层，出口 IP 干净，直连 bt4g 基本不被 BT4G 限流）
// 部署后地址填到 App「设置 → 磁力搜索配置」（里模式下才显示该项）。
//
// 用法：把本目录（含 api/index.js + vercel.json + package.json）推到一个 GitHub 仓库，
//       在 Vercel 导入该仓库即可。访问根路径 / 即命中本函数（vercel.json 已 rewrite）。
//
// 设计要点：
//   Vercel 的出口 IP 自有、非共享，BT4G 不会按 IP 限流 → 直连即可稳定出数据（~1s）。
//   因此本版【直连优先】，公共代理仅作兜底。
//
// 执行顺序（并发竞速，第一个成功即返回）：
//   1) 直连 bt4g          （Vercel 出口干净，稳定命中）
//   2) allorigins /raw    （公共代理兜底，用代理自身 IP 打 bt4g）
//   3) allorigins /get    （备用兜底）
// 全程带 AbortController 6s 超时，绝不无限挂起；命中结果按 query 内存缓存 10 分钟。
//
// 前端约定：
//   GET /?q=关键词&source=bt4g&cat=movie&order=seeders&p=1
//   成功: { source, query, count, items:[ {title, magnet, size, source, seeders, leechers} ] }
//   失败: { error: "可读的中文提示" }
//
// 字幕路由（同函数、不同 path）：
//   GET /subtitles?action=search&q=关键词&year=年份&lang=zh&assrt=Token&os=ApiKey
//   成功: { query, count, items:[ {source,id,title,lang,langDesc,ext,fileCount,downloads,meta} ], warnings }
//   GET /subtitles?action=download&source=assrt|os&id=...&name=...&ext=...&assrt=Token&os=ApiKey
//   成功: 直接返回字幕文件二进制（assrt 多文件自动打包为 zip）

export const config = {
  runtime: 'edge'
};

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ACCEPT = 'application/xml, text/xml, application/rss+xml, */*';
const FETCH_TIMEOUT = 10000;

// 简单内存缓存：key -> { ts, items }（实例热期内有效，冷启动清空；能显著减少对上游的命中）
const _cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function cacheGet(key) {
  const v = _cache.get(key);
  if (v && (Date.now() - v.ts) < CACHE_TTL) return v.items;
  if (v) _cache.delete(key);
  return null;
}
function cacheSet(key, items) {
  _cache.set(key, { ts: Date.now(), items: items });
}

function buildBt4gUrl(q, cat, order, p) {
  const query = encodeURIComponent(q);
  const category = cat || 'movie';
  return 'https://bt4gprx.com/search?q=' + query + '&orderby=seeders&category=' + encodeURIComponent(category) + '&p=' + (p || '1') + '&page=rss';
}

function pick(re, s, i) {
  const m = re.exec(s);
  return m ? (m[i != null ? i : 1] || '') : '';
}

function parseBt4g(xml) {
  const items = [];
  if (!xml) return items;
  const blocks = xml.split(/<item>/i).slice(1);
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const end = block.indexOf('</item>');
    const raw = end > 0 ? block.slice(0, end) : block;
    const title = pick(/<title>([\s\S]*?)<\/title>/i, raw, 1).trim();
    const magnet = pick(/<link>(magnet:[^<]*)<\/link>/i, raw, 1).trim();
    if (!magnet) continue;
    let size = '';
    const desc = pick(/<description>([\s\S]*?)<\/description>/i, raw, 1);
    const sizeM = desc.match(/([\d.]+)\s*(GB|MB|TB|KB)/i);
    if (sizeM) size = sizeM[1] + ' ' + sizeM[2].toUpperCase();
    items.push({ title: title, magnet: magnet, size: size, source: 'bt4g', seeders: '', leechers: '' });
  }
  return items;
}

// 带短超时的抓取；返回 { ok, status, text } 或 { ok:false, status:0, err }
async function fetchText(url, extraHeaders) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT);
  try {
    const headers = { 'User-Agent': UA, 'Accept': ACCEPT };
    if (extraHeaders) { for (const k in extraHeaders) headers[k] = extraHeaders[k]; }
    const resp = await fetch(url, { headers: headers, signal: ctrl.signal });
    if (!resp.ok) return { ok: false, status: resp.status };
    const text = await resp.text();
    return { ok: true, status: resp.status, text: text };
  } catch (e) {
    return { ok: false, status: 0, err: (e && e.message) || 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function parseItems(xml) {
  const items = parseBt4g(xml);
  return (items && items.length) ? items : null;
}

// 各取数策略：返回 items 数组或 null
async function viaDirect(q, cat, order, p) {
  const res = await fetchText(buildBt4gUrl(q, cat, order, p));
  if (!res.ok) return null;
  return parseItems(res.text);
}
async function viaAllOriginsRaw(q, cat, order, p) {
  const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(buildBt4gUrl(q, cat, order, p));
  const res = await fetchText(proxyUrl);
  if (!res.ok) return null;
  return parseItems(res.text);
}
async function viaAllOriginsGet(q, cat, order, p) {
  const proxyUrl = 'https://api.allorigins.win/get?url=' + encodeURIComponent(buildBt4gUrl(q, cat, order, p));
  const res = await fetchText(proxyUrl);
  if (!res.ok) return null;
  try {
    const j = JSON.parse(res.text);
    return parseItems(j && j.contents ? j.contents : '');
  } catch (e) { return null; }
}

// 直连优先（Vercel 出口干净稳定命中），公共代理仅作兜底
const STRATEGIES = [
  { name: 'direct', fn: viaDirect },
  { name: 'allorigins-raw', fn: viaAllOriginsRaw },
  { name: 'allorigins-get', fn: viaAllOriginsGet }
];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

// 并发执行各取数任务，【第一个成功】立即兑现；全部失败才等到最慢一个
function raceFirstSuccess(tasks) {
  return new Promise(function (resolve) {
    let pending = tasks.length;
    let settled = false;
    function finish(r) {
      if (settled) return;
      if (r && r.items && r.items.length) { settled = true; resolve(r); return; }
      pending--;
      if (pending === 0 && !settled) resolve(null);
    }
    tasks.forEach(function (t) {
      Promise.resolve().then(t).then(finish).catch(function () {
        pending--;
        if (pending === 0 && !settled) resolve(null);
      });
    });
  });
}

async function handle(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

  // ---- 字幕路由（伪射手 assrt + OpenSubtitles 双源）----
  if (path.endsWith('/subtitles') || url.searchParams.get('sub')) {
    return handleSubtitles(request, url);
  }

  const q = (url.searchParams.get('q') || '').trim();
  const cat = url.searchParams.get('cat') || 'movie';
  const order = url.searchParams.get('order') || 'seeders';
  const p = url.searchParams.get('p') || '1';

  if (!q) {
    return new Response(JSON.stringify({ error: '关键词为空' }), { status: 200, headers: corsHeaders() });
  }

  const key = q + '|' + cat + '|' + order + '|' + p;

  // 1) 命中内存缓存直接返回
  const cached = cacheGet(key);
  if (cached && cached.length) {
    return new Response(JSON.stringify({ source: 'bt4g(cache)', query: q, count: cached.length, items: cached }), { status: 200, headers: corsHeaders() });
  }

  // 2) 并发竞速所有策略（直连优先，代理兜底）；第一个成功即返回
  const tasks = STRATEGIES.map(function (s) {
    return function () {
      return s.fn(q, cat, order, p)
        .then(function (items) { return (items && items.length) ? { items: items, name: s.name } : null; })
        .catch(function () { return null; });
    };
  });
  const best = await raceFirstSuccess(tasks);

  if (best && best.items.length) {
    cacheSet(key, best.items);
    return new Response(JSON.stringify({ source: 'bt4g', query: q, count: best.items.length, items: best.items }), { status: 200, headers: corsHeaders() });
  }

  return new Response(JSON.stringify({
    error: 'BT4G 暂时拿不到数据。已尝试直连与公共代理兜底均未取到结果，多为源站波动或公共代理限流。请稍候几十秒重试，或换更具体的关键词。'
  }), { status: 200, headers: corsHeaders() });
}

export default async function (request) {
  return handle(request).catch(function (e) {
    return new Response(JSON.stringify({ error: '函数内部错误：' + (e && e.message ? e.message : '未知错误') }), { status: 200, headers: corsHeaders() });
  });
}

// ============================================================================
//  字幕路由：伪射手（assrt.net）+ OpenSubtitles.com 双源搜索 / 下载
// ============================================================================
//
// 前端约定：
//   搜索  GET /subtitles?action=search&q=关键词&year=年份&lang=zh&assrt=Token&os=ApiKey
//         成功: { query, count, items:[ {source,id,title,lang,langDesc,ext,fileCount,downloads,meta} ], warnings:[...] }
//   下载  GET /subtitles?action=download&source=assrt|os&id=...&name=...&ext=...&assrt=Token&os=ApiKey
//         成功: 直接返回文件二进制（单文件原样返回；assrt 多文件打包为 store 模式 zip）
//
// 说明：伪射手 Token 走 ?token= 查询参数；OpenSubtitles 走 Api-Key 请求头。
//       任一时限/限流（伪射手 20 次/分、OpenSubtitles 100 次下载/天）由源站返回，
//       本代理只负责转发并把源站错误翻成可读中文。

async function handleSubtitles(request, url) {
  const action = (url.searchParams.get('action') || 'search').trim();
  if (action === 'download') return handleSubtitleDownload(url);
  return handleSubtitleSearch(url);
}

function jsonError(msg) {
  return new Response(JSON.stringify({ error: msg }), { status: 200, headers: corsHeaders() });
}

function dlHeaders(filename, contentType) {
  const enc = encodeURIComponent(filename);
  return {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="' + enc + '"; filename*=UTF-8\'\'' + enc
  };
}

// 抓取并解析 JSON；返回 { json } 或 { err }
async function fetchJson(u, extraHeaders, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT);
  try {
    const h = { 'User-Agent': UA, 'Accept': 'application/json, */*' };
    if (extraHeaders) { for (const k in extraHeaders) h[k] = extraHeaders[k]; }
    const resp = await fetch(u, Object.assign({ headers: h, signal: ctrl.signal }, init || {}));
    if (!resp.ok) return { err: 'HTTP ' + resp.status };
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { return { err: '响应不是合法 JSON' }; }
    return { json: json };
  } catch (e) {
    return { err: (e && e.message) || 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// 抓取二进制；返回 { ok, bytes, resp, status } 或 { ok:false, status }
async function fetchArray(u) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT);
  try {
    const resp = await fetch(u, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!resp.ok) return { ok: false, status: resp.status };
    const buf = await resp.arrayBuffer();
    return { ok: true, status: resp.status, resp: resp, bytes: new Uint8Array(buf) };
  } catch (e) {
    return { ok: false, status: 0, err: (e && e.message) || 'network' };
  } finally {
    clearTimeout(timer);
  }
}

async function proxyFile(u, filename) {
  const fr = await fetchArray(u);
  if (!fr.ok) return jsonError('文件下载失败（HTTP ' + fr.status + '）');
  const ct = fr.resp.headers.get('content-type') || 'application/octet-stream';
  return new Response(fr.bytes, { status: 200, headers: dlHeaders(filename, ct) });
}

// ---- 搜索 ----
async function handleSubtitleSearch(url) {
  const q = (url.searchParams.get('q') || '').trim();
  const year = (url.searchParams.get('year') || '').trim();
  const lang = (url.searchParams.get('lang') || 'zh').trim();
  const assrtToken = (url.searchParams.get('assrt') || '').trim();
  const osKey = (url.searchParams.get('os') || '').trim();

  if (!q) return jsonError('搜索关键词为空');

  const tasks = [];
  if (assrtToken) {
    tasks.push(searchAssrt(q, year, lang, assrtToken).catch(function (e) { return { source: 'assrt', error: (e && e.message) || '伪射手出错' }; }));
  }
  if (osKey) {
    tasks.push(searchOpenSubtitles(q, year, lang, osKey).catch(function (e) { return { source: 'os', error: (e && e.message) || 'OpenSubtitles 出错' }; }));
  }
  if (!tasks.length) {
    return jsonError('未配置任何字幕源 Token。请到 App「设置 → API 配置」填写伪射手 Token 或 OpenSubtitles Key。');
  }

  const results = await Promise.all(tasks);
  const items = [];
  const warnings = [];
  results.forEach(function (r) {
    if (r.error) { warnings.push(r.source + ': ' + r.error); return; }
    (r.items || []).forEach(function (it) { items.push(it); });
  });

  items.sort(function (a, b) { return langRank(a.lang) - langRank(b.lang); });

  return new Response(JSON.stringify({ query: q, count: items.length, items: items, warnings: warnings }),
    { status: 200, headers: corsHeaders() });
}

async function searchAssrt(q, year, lang, token) {
  // 名称.年份（用点，不用空格）
  let apiq = q;
  if (year) apiq += '.' + year;
  // 注意：伪射手 v1 搜索的 lang 筛选参数形态不稳定，且易把结果过滤为 0；
  // 这里不传 lang，由代理把全部语言返回，前端用彩色标签展示，语言胶囊只影响 OpenSubtitles。
  const u = 'https://api.assrt.net/v1/sub/search?token=' + encodeURIComponent(token)
    + '&q=' + encodeURIComponent(apiq);
  const res = await fetchJson(u, { 'Authorization': 'Bearer ' + token });
  if (res.err) return { source: 'assrt', error: '伪射手请求失败：' + res.err };
  const j = res.json || {};
  // 伪射手 v1 成功用 status===0，失败用 errmsg；数组字段是 sub（不是 items）
  if (j.status !== 0) return { source: 'assrt', error: '伪射手返回：' + (j.errmsg || j.msg || '失败') };
  const subs = extractAssrtSubs(j);
  const items = subs.map(function (it) {
    const files = it.filelist || [];
    const firstFile = files[0] ? files[0].file : '';
    const ext = firstFile ? extOf(firstFile) : (files.length > 1 ? 'zip' : 'srt');
    const li = assrtLang(it.lang);
    return {
      source: 'assrt',
      id: String(it.id),
      title: it.native_name || it.sub_native_name || it.videoname || '字幕包',
      lang: li.norm,
      langDesc: li.desc,
      ext: ext,
      fileCount: files.length,
      downloads: '',
      meta: [it.team, it.version].filter(Boolean).join(' ')
    };
  });
  return { source: 'assrt', items: items };
}

// 伪射手 v1 的 sub 字段形态多变：可能是 {subs:[...]}、数组、或顶层 {subs:[...]}/{items:[...]}
// 参考官方文档与 WebMediaManager 集成：真正的结果数组在 j.sub.subs
function extractAssrtSubs(j) {
  const section = j.sub;
  if (Array.isArray(section)) return section;
  if (section && Array.isArray(section.subs)) return section.subs;
  if (Array.isArray(j.subs)) return j.subs;
  if (Array.isArray(j.items)) return j.items;
  return [];
}

function extractAssrtFilelist(j) {
  // 下载详情：filelist 常见在 j.sub.subs[0].filelist；也可能在 j.sub.filelist / j.filelist
  const sub = j.sub;
  if (sub) {
    if (sub.subs && sub.subs[0] && Array.isArray(sub.subs[0].filelist)) return sub.subs[0].filelist;
    if (Array.isArray(sub.filelist)) return sub.filelist;
  }
  if (Array.isArray(j.filelist)) return j.filelist;
  return [];
}
function assrtLang(langField) {
  let desc = '', key = '';
  if (typeof langField === 'string') { key = langField; desc = langField; }
  else if (langField && typeof langField === 'object') {
    if (langField.desc || langField.key) { desc = langField.desc || langField.key; key = langField.key || langField.desc; }
    else {
      const vals = Object.values(langField);
      const v = vals[0] || {};
      desc = v.desc || ''; key = v.key || '';
    }
  }
  return { norm: normalizedLang(key || desc), desc: desc || key || '' };
}

async function searchOpenSubtitles(q, year, lang, apiKey) {
  // 年份不拼进词，单独走 year 参数（OpenSubtitles 支持）
  const apiq = q;
  const langs = (lang === 'all') ? '' : (lang || 'zh');
  let u = 'https://api.opensubtitles.com/api/v1/subtitles?query=' + encodeURIComponent(apiq) + '&type=movie';
  if (langs) u += '&languages=' + encodeURIComponent(langs);
  if (year) u += '&year=' + encodeURIComponent(year);
  const res = await fetchJson(u, {
    'Api-Key': apiKey,
    'Accept': 'application/json'
  });
  if (res.err) return { source: 'os', error: 'OpenSubtitles 请求失败：' + res.err };
  const data = (res.json && res.json.data) || [];
  const items = data.map(function (d) {
    const a = d.attributes || {};
    const files = a.files || [];
    const f0 = files[0] || {};
    return {
      source: 'os',
      id: String(f0.file_id != null ? f0.file_id : (a.subtitle_id != null ? a.subtitle_id : d.id)),
      title: a.release || a.movie || apiq,
      lang: normalizedLang([a.language]),
      langDesc: a.language || '',
      ext: extOf(f0.file_name || '') || 'srt',
      fileCount: files.length,
      downloads: a.download_count != null ? String(a.download_count) : '',
      meta: a.release || ''
    };
  });
  return { source: 'os', items: items };
}

// ---- 下载 ----
async function handleSubtitleDownload(url) {
  const source = (url.searchParams.get('source') || '').trim();
  const id = (url.searchParams.get('id') || '').trim();
  const name = (url.searchParams.get('name') || 'subtitle').trim();
  const ext = (url.searchParams.get('ext') || '').trim();
  const assrtToken = (url.searchParams.get('assrt') || '').trim();
  const osKey = (url.searchParams.get('os') || '').trim();

  if (source === 'assrt') {
    if (!assrtToken) return jsonError('缺少伪射手 Token');
    if (!id) return jsonError('缺少字幕 id');
    const du = 'https://api.assrt.net/v1/sub/detail?id=' + encodeURIComponent(id) + '&token=' + encodeURIComponent(assrtToken);
    const res = await fetchJson(du, { 'Authorization': 'Bearer ' + assrtToken });
    if (res.err) return jsonError('伪射手详情：' + res.err);
    const j = res.json || {};
    if (j.status !== 0) return jsonError('伪射手详情：' + (j.errmsg || j.msg || '失败'));
    // 伪射手详情：filelist 在 j.sub.subs[0].filelist（也可能在 j.sub.filelist / j.filelist）
    const filelist = extractAssrtFilelist(j);
    if (!filelist.length) return jsonError('伪射手未返回可下载文件');
    if (filelist.length === 1) {
      const f = filelist[0];
      return proxyFile(f.url, f.f || f.file || (name + '.' + (ext || 'srt')));
    }
    // 多文件 → 打包为 store 模式 zip
    const parts = [];
    for (let i = 0; i < filelist.length; i++) {
      const fr = await fetchArray(filelist[i].url);
      if (!fr.ok) continue;
      parts.push({ name: filelist[i].f || filelist[i].file || ('file' + (i + 1)), bytes: fr.bytes });
    }
    if (!parts.length) return jsonError('伪射手文件下载失败');
    const zip = makeZip(parts);
    const fn = (name || 'subtitles') + '.zip';
    return new Response(zip, { status: 200, headers: dlHeaders(fn, 'application/zip') });
  }

  if (source === 'os') {
    if (!osKey) return jsonError('缺少 OpenSubtitles Key');
    if (!id) return jsonError('缺少字幕 id');
    const res = await fetchJson('https://api.opensubtitles.com/api/v1/download', {
      'Api-Key': osKey,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }, {
      method: 'POST',
      body: JSON.stringify({ file_id: Number(id) })
    });
    if (res.err) return jsonError('OpenSubtitles 下载：' + res.err);
    const link = res.json && res.json.link;
    const fn = (res.json && res.json.file_name) || (name + '.' + (ext || 'srt'));
    if (!link) return jsonError('OpenSubtitles 未返回下载链接（可能已达每日 100 次下载限额）');
    return proxyFile(link, fn);
  }

  return jsonError('未知字幕源：' + source);
}

// ---- 工具 ----
function extOf(fname) {
  if (!fname) return '';
  const m = /\.([a-z0-9]+)$/i.exec(fname);
  return m ? m[1].toLowerCase() : '';
}
function normalizedLang(langArr) {
  let l = Array.isArray(langArr) ? (langArr[0] || '') : langArr;
  l = (l || '').toLowerCase();
  if (l.indexOf('zh-cn') >= 0 || l === 'zh' || l === 'chs' || l === 'sc') return 'zh';
  if (l.indexOf('zh-tw') >= 0 || l.indexOf('cht') >= 0 || l === 'tc') return 'zht';
  if (l.indexOf('zh') >= 0) return 'zh';
  if (l.indexOf('en') >= 0) return 'en';
  return l || 'other';
}
function langDescFromArr(langArr) {
  let l = Array.isArray(langArr) ? (langArr[0] || '') : langArr;
  return l || '';
}
function langRank(l) {
  if (l === 'zh') return 0;
  if (l === 'zht') return 1;
  if (l === 'en') return 2;
  return 3;
}

// 极简 store（无压缩）ZIP 编码：files = [{ name, bytes:Uint8Array }]
function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (let i = 0; i < files.length; i++) {
    const nameBytes = enc.encode(files[i].name);
    const data = files[i].bytes;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint32(14, crc, true);
    cdv.setUint32(20, data.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }
  const centralSize = central.reduce(function (s, c) { return s + c.length; }, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, 0, true);

  const total = chunks.reduce(function (s, c) { return s + c.length; }, 0) + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
  central.forEach(function (c) { out.set(c, pos); pos += c.length; });
  out.set(eocd, pos);
  return out;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
  }
  return (~c) >>> 0;
}
