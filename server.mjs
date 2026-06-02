// 法規更新查核工具 — 本機後端（純 Node 標準庫，無需 npm install）
// 資料來源：全國法規資料庫開放資料 API（law.moj.gov.tw）
//   法律：https://law.moj.gov.tw/api/Ch/Law/JSON
//   命令：https://law.moj.gov.tw/api/Ch/Order/JSON
// 每部法規的 LawModifiedDate（西元 YYYYMMDD）即「最新修正日期」。

import http from 'node:http';
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const GROUPS_PATH = path.join(DATA_DIR, 'groups.json');
const INDEX_PATH = path.join(DATA_DIR, 'moj-index.json');
const HISTORIES_PATH = path.join(DATA_DIR, 'moj-histories.json');
const SEED_PATH = path.join(DATA_DIR, 'pcode_all.json');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');            // groups.json 每日備份目錄

const LAW_API = 'https://law.moj.gov.tw/api/Ch/Law/JSON';
const ORDER_API = 'https://law.moj.gov.tw/api/Ch/Order/JSON';
const LAWOLDVER = 'https://law.moj.gov.tw/LawClass/LawOldVer.aspx?pcode=';
const LAWHISTORY = 'https://law.moj.gov.tw/LawClass/LawHistory.aspx?pcode=';
const GAZETTE_API = 'https://gazette.nat.gov.tw/egFront/OpenData/downloadXML.jsp'; // 行政院公報 dataset 5959（當日）
const GAZETTE_PATH = path.join(DATA_DIR, 'gazette.json'); // 累積快取：法規名稱 -> [{date,docNo,url,summary}]
const LY_API = 'https://ly.govapi.tw';                  // g0v 國會 API（立法理由來源）
const LY_LAWS_PATH = path.join(DATA_DIR, 'ly-laws.json');     // 法律名稱 -> 法律編號 索引快取
const LY_REASONS_PATH = path.join(DATA_DIR, 'ly-reasons.json'); // <pcode>:<ymd> -> {articles,bill}
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) LawTracker/1.0';
const PORT = Number(process.env.PORT) || 7843;
const HOST = process.env.HOST || '127.0.0.1';                 // 本機＝127.0.0.1；常駐伺服器要開放區網可設 0.0.0.0
// 「執行查核日」當天、本地時間幾點後算正式查核（台灣 9 點）；內建排程器也固定在這個時點（每天一次）動作，兩者永遠一致。
const CHECK_HOUR = process.env.CHECK_HOUR != null ? Number(process.env.CHECK_HOUR) : 9; // 設為 0–23 以外即關閉排程器（僅開頁時查核）
// 保留最近幾份每日備份：未設或填了非數字（手誤）→ 退回預設 30，不讓「備份」這種保命功能被打字錯誤靜默關掉；明確填 0（或負數）才關閉。
const _bkKeepRaw = process.env.BACKUP_KEEP;
const _bkKeepNum = Number(_bkKeepRaw);
const BACKUP_KEEP = (_bkKeepRaw != null && _bkKeepRaw !== '' && Number.isFinite(_bkKeepNum)) ? _bkKeepNum : 30;

// ──────────────────────────────────────────────────────────
// ZIP 解壓（最小實作，支援 STORED + DEFLATE）
// ──────────────────────────────────────────────────────────
function extractZipEntry(buf, want) {
  const EOCD_SIG = 0x06054b50;
  let p = buf.length - 22;
  for (; p >= 0; p--) if (buf.readUInt32LE(p) === EOCD_SIG) break;
  if (p < 0) throw new Error('ZIP EOCD 找不到');
  const cdCount = buf.readUInt16LE(p + 10);
  let off = buf.readUInt32LE(p + 16);
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP central-dir 損壞');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lhOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const hit = want instanceof RegExp ? want.test(name) : name === want;
    if (hit) {
      if (buf.readUInt32LE(lhOff) !== 0x04034b50) throw new Error('ZIP local-header 損壞');
      const lhNameLen = buf.readUInt16LE(lhOff + 26);
      const lhExtraLen = buf.readUInt16LE(lhOff + 28);
      const start = lhOff + 30 + lhNameLen + lhExtraLen;
      const comp = buf.subarray(start, start + compSize);
      if (method === 0) return comp;
      if (method === 8) return zlib.inflateRawSync(comp);
      throw new Error('ZIP 不支援的壓縮方式 ' + method);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('ZIP 內找不到項目: ' + want);
}

function parseMojZip(buf) {
  const jsonBuf = extractZipEntry(buf, /\.json$/i);
  const data = JSON.parse(jsonBuf.toString('utf8').replace(/^﻿/, ''));
  return Array.isArray(data) ? data : (data.Laws || []);
}

function pcodeFromUrl(url) {
  const m = /[?&]pcode=([^&]+)/i.exec(url || '');
  return m ? m[1] : '';
}

// ──────────────────────────────────────────────────────────
// 儲存輔助
// ──────────────────────────────────────────────────────────
async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return fallback; }
}
async function writeJSONAtomic(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await writeFile(tmp, JSON.stringify(obj), 'utf8');
  await rename(tmp, file);
}

// ──────────────────────────────────────────────────────────
// 記憶體狀態
// ──────────────────────────────────────────────────────────
let INDEX = null;        // { fetchedAt, lawCount, orderCount, total, laws: {pcode:{...}} }
let SEARCH_LIST = [];    // [{pcode, name, modifiedDate, abolished, level}]
let HISTORIES = {};      // pcode -> 沿革文字（記憶體，供 as-of 日期比對）
let refreshing = false;
let LAST_SYNC = null;     // { at, ok, error } 最近一次資料同步嘗試結果（供 UI 顯示）

// ── 日期工具（民國/西元、as-of 版本、加月、資料落差）──────────
const DEFAULT_LAG_DAYS = 3;   // 資料上網落差：基準日 + 3 天才開放查核
function cnToNum(s) {
  const d = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 兩: 2 };
  let section = 0, num = 0;
  for (const ch of s) {
    if (d[ch] != null) num = d[ch];
    else if (ch === '十') { section += (num || 1) * 10; num = 0; }
    else if (ch === '百') { section += (num || 1) * 100; num = 0; }
    else if (ch === '千') { section += (num || 1) * 1000; num = 0; }
  }
  return section + num;
}
// 「中華民國一百零六年六月十四日」→ '20170614'
function parseRocDate(s) {
  const m = /([〇零一二三四五六七八九十百千兩]+)\s*年\s*([〇零一二三四五六七八九十百千兩]+)\s*月\s*([〇零一二三四五六七八九十百千兩]+)\s*日/.exec(s || '');
  if (!m) return '';
  const y = cnToNum(m[1]) + 1911, mo = cnToNum(m[2]), da = cnToNum(m[3]);
  if (!y || !mo || !da) return '';
  return String(y) + String(mo).padStart(2, '0') + String(da).padStart(2, '0');
}
// 由沿革擷取各版本「公布/發布日」（西元 YYYYMMDD，升冪）
// 以編號條目分段，每段只取第一個中華民國日期＝該版公布日；
// 排除同段後面的「施行日」與「機關改隸公告日」（它們不是新版本）。
function parseAmendmentDates(text) {
  if (!text) return [];
  const out = [];
  const entries = [...String(text).matchAll(/(?:^|\r?\n)\s*\d+\.\s*([\s\S]*?)(?=\r?\n\s*\d+\.|$)/g)].map((e) => e[1]);
  const bodies = entries.length ? entries : [String(text)];
  for (const body of bodies) {
    const m = /中華民國\s*([〇零一二三四五六七八九十百千兩]+\s*年[〇零一二三四五六七八九十百千兩]+\s*月[〇零一二三四五六七八九十百千兩]+\s*日)/.exec(body);
    if (m) { const d = parseRocDate(m[1]); if (d) out.push(d); }
  }
  return [...new Set(out)].sort();
}
// ymd 正規化：'2026-05-31' / '20260531' → '20260531'
function ymdNorm(s) { return s ? String(s).replace(/\D/g, '').slice(0, 8) : ''; }
// 截至某日（含）為止，最新一版的日期
function asOfDate(pcode, ymd) {
  if (!ymd) return '';
  const dates = parseAmendmentDates(HISTORIES[pcode] || '');
  let best = '';
  for (const d of dates) { if (d <= ymd) best = d; else break; }
  // 沿革解析不到時，退回索引現值（若 ≤ 基準日）
  if (!best) { const meta = lawMeta(pcode); if (meta && meta.modifiedDate && meta.modifiedDate <= ymd) best = meta.modifiedDate; }
  return best;
}
function addMonths(ymd, months) {
  const s = ymdNorm(ymd); if (s.length !== 8 || !months) return s;
  let y = +s.slice(0, 4), mo = +s.slice(4, 6) - 1 + months, da = +s.slice(6, 8);
  y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12;
  const last = new Date(y, mo + 1, 0).getDate();
  da = Math.min(da, last);
  return String(y) + String(mo + 1).padStart(2, '0') + String(da).padStart(2, '0');
}
function todayYmd() { const d = new Date(); return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }
function dueYmd(group) { const n = ymdNorm(group.nextBaselineDate); if (!n) return ''; return addDays(n, group.lagDays ?? DEFAULT_LAG_DAYS); }
// 是否已到「執行查核日」可做正式查核：超過執行查核日→是；當天→上午 9 點後才算（避免資料尚未上線）。
function isDueNow(group) {
  if (group.paused) return false;            // 已停用任務：不自動查核、不視為到期
  const due = dueYmd(group); if (!due) return false;
  const t = todayYmd();
  if (t > due) return true;
  if (t === due) return new Date().getHours() >= CHECK_HOUR;   // 執行查核日當天，需過 CHECK_HOUR（台灣 9 點）才算到期
  return false;
}
function addDays(ymd, days) {
  const s = ymdNorm(ymd); if (s.length !== 8) return s;
  const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8) + (days || 0));
  return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
function daysBetween(a, b) {   // 兩個 YYYYMMDD 之間的天數差（跨月跨年正確）
  const A = ymdNorm(a), B = ymdNorm(b);
  if (A.length !== 8 || B.length !== 8) return Infinity;
  return Math.abs((new Date(+A.slice(0, 4), +A.slice(4, 6) - 1, +A.slice(6, 8)) - new Date(+B.slice(0, 4), +B.slice(4, 6) - 1, +B.slice(6, 8))) / 86400000);
}

function buildSearchList() {
  if (INDEX && INDEX.laws) {
    SEARCH_LIST = Object.entries(INDEX.laws).map(([pcode, v]) => ({
      pcode, name: v.name, modifiedDate: v.modifiedDate, abolished: v.abolished, level: v.level,
    }));
  } else {
    // 種子（尚未下載完整法規庫前可用，僅有名稱與 pcode）
    const seed = (() => { try { return JSON.parse(readFileSync(SEED_PATH, 'utf8')); } catch { return null; } })();
    if (!seed) { SEARCH_LIST = []; return; }
    const ab = new Set(seed.abolished_set || []);
    SEARCH_LIST = Object.entries(seed.pcode_map || {}).map(([name, pcode]) => ({
      pcode, name, modifiedDate: null, abolished: ab.has(pcode), level: null,
    }));
  }
}

function lawMeta(pcode) {
  if (INDEX && INDEX.laws && INDEX.laws[pcode]) return INDEX.laws[pcode];
  return null;
}

// ──────────────────────────────────────────────────────────
// 下載並重建法規索引
// ──────────────────────────────────────────────────────────
async function fetchZip(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/zip,application/octet-stream,*/*' } });
  if (!resp.ok) throw new Error(`下載失敗 ${resp.status} ${url}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function refreshIndex() {
  if (refreshing) throw new Error('已有更新作業進行中');
  refreshing = true;
  try {
    const laws = {};
    const histories = {};
    let lawCount = 0, orderCount = 0;

    // 被追蹤法規:更新時順手存一份「官方條文快照」,供日後新舊對照(免再抓網頁)
    const groupsDb = await loadGroups();
    const watched = new Set();
    for (const g of groupsDb.groups) for (const l of g.watchlist) watched.add(l.pcode);
    const snaps = [];

    for (const [api, isLaw] of [[LAW_API, true], [ORDER_API, false]]) {
      const buf = await fetchZip(api);
      const arr = parseMojZip(buf);
      for (const item of arr) {
        const pcode = pcodeFromUrl(item.LawURL);
        if (!pcode) continue;
        laws[pcode] = {
          name: item.LawName || '',
          level: item.LawLevel || '',
          category: item.LawCategory || '',
          modifiedDate: String(item.LawModifiedDate || ''),
          effectiveDate: String(item.LawEffectiveDate || ''),
          abolished: (item.LawAbandonNote || '').trim() === '廢',
        };
        const hist = (item.LawHistories || '').trim();
        if (hist) histories[pcode] = hist;
        if (watched.has(pcode) && Array.isArray(item.LawArticles) && item.LawArticles.length) {
          snaps.push({ pcode, name: item.LawName || '', level: item.LawLevel || '',
            modifiedDate: String(item.LawModifiedDate || ''), articles: articlesFromBulk(item) });
        }
        if (isLaw) lawCount++; else orderCount++;
      }
    }

    const index = {
      fetchedAt: new Date().toISOString(),
      lawCount, orderCount, total: lawCount + orderCount,
      laws,
    };
    await writeJSONAtomic(INDEX_PATH, index);
    await writeJSONAtomic(HISTORIES_PATH, histories);
    for (const s of snaps) await archiveArticles(s);
    INDEX = index;
    HISTORIES = histories;
    buildSearchList();
    // 以下為 best-effort 加值（公報快取、立法理由索引），可能較慢/受限流；改背景執行，不阻斷查核回應
    const watchedNames = new Set([...watched].map((pc) => laws[pc] && laws[pc].name).filter(Boolean));
    if (watchedNames.size) captureGazette(watchedNames).catch(() => {});
    buildLyIndexIfNeeded().catch(() => {});
    return dbMeta();
  } finally {
    refreshing = false;
  }
}

function dbMeta() {
  if (!INDEX) return null;
  return {
    fetchedAt: INDEX.fetchedAt, total: INDEX.total,
    lawCount: INDEX.lawCount, orderCount: INDEX.orderCount,
  };
}
// 查核前確保資料是「當日」最新：同一天已抓過就沿用，否則自動下載；下載失敗但有舊索引則沿用。
function indexIsFresh() {
  if (!INDEX || !INDEX.fetchedAt) return false;
  return new Date(INDEX.fetchedAt).toLocaleDateString('en-CA') === new Date().toLocaleDateString('en-CA');
}
async function ensureFreshIndex() {
  if (refreshing || indexIsFresh()) return;
  try { await refreshIndex(); LAST_SYNC = { at: new Date().toISOString(), ok: true }; }
  catch (e) { LAST_SYNC = { at: new Date().toISOString(), ok: false, error: String(e.message || e) }; if (!INDEX) throw e; /* 有舊索引就沿用，不阻斷查核 */ }
}
// 資料同步狀態（供 UI 顯示資料是否最新、上次同步是否失敗）
function syncMeta() {
  return {
    fetchedAt: INDEX ? INDEX.fetchedAt : null,
    fresh: indexIsFresh(),
    error: LAST_SYNC && !LAST_SYNC.ok ? LAST_SYNC.error : null,
    errorAt: LAST_SYNC && !LAST_SYNC.ok ? LAST_SYNC.at : null,
  };
}

// ──────────────────────────────────────────────────────────
// 異動條文 / 新舊對照（以官方資料為準）
//   新版條文：官方批次（LawArticles，已下載）
//   舊版條文：本機快照，無則抓 全國法規資料庫·歷史法規(LawOldVer，緊鄰前一版官方全文)
//   比對：去除所有空白後逐條比對（中文法條無語意空白），避免排版差異誤判
// ──────────────────────────────────────────────────────────
function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function artNo(raw) { const m = /第\s*([0-9A-Za-z]+(?:-[0-9A-Za-z]+)?)\s*條/.exec(raw || ''); return m ? m[1] : null; }
function artKey(no) { const m = /^(\d+)(?:-(\d+))?/.exec(no || ''); return m ? [Number(m[1]), Number(m[2] || 0)] : [99999, 0]; }
function foldWidth(s) { return (s || '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); }
function normText(s) { return foldWidth(s).replace(/\s+/g, ''); }   // 比對用：全形↔半形折疊 + 去空白，避免排版差異誤判
function cleanText(s) { return stripTags(s).replace(/　/g, ' ').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }

function articlesFromBulk(item) {
  const out = {};
  for (const a of (item.LawArticles || [])) {
    const no = artNo(a.ArticleNo);
    if (no) out[no] = cleanText(a.ArticleContent || '');
  }
  return out;
}

// 款/目/子目 起始標記（用來辨識「項」與其子項，並避免把子項當成新項）
function isSubMarker(line) {
  return /^[一二三四五六七八九十百千]+、/.test(line) || /^（[一二三四五六七八九十百千]+）/.test(line) || /^[0-9０-９]+[、.．]/.test(line);
}
// 全國法規資料庫批次以 \r\n 切「項/款/目」（每單元完整，多句也同一行）；
// 但歷史法規(LawOldVer)是固定寬度硬斷行。下面依「行寬＋句末標點」把硬斷行重組回單元。
function dewrapByWidth(lines) {
  const W = Math.max(...lines.map((l) => l.length));
  const cont = (l) => l.length >= W - 4 && !/[。；：！？]$/.test(l);   // 接近滿行且非句末 ⇒ 被硬斷，續接下一行
  const units = []; let prev = null;
  for (const line of lines) {
    if (units.length && prev && cont(prev) && !isSubMarker(line)) units[units.length - 1] += line;
    else units.push(line);
    prev = line;
  }
  return units.join('\n');
}
// 只在「多數行看起來被截斷」時才重組（批次資料本就乾淨，不動）
function maybeDewrap(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return text;
  const noEnd = lines.filter((l) => !/[。；：！？.」』）]$/.test(l)).length;
  if (noEnd / lines.length < 0.34) return lines.join('\n');
  return dewrapByWidth(lines);
}

function parseLawOldVer(html) {
  const dm = /(?:修正日期|公(?:布|發)日期)：<\/th>\s*<td>([^<]+)<\/td>/.exec(html);
  const articles = {};
  const re = /col-no">([\s\S]*?)<\/div>\s*<div class="col-data[^"]*">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const no = artNo(stripTags(m[1]));
    if (no) articles[no] = cleanText(m[2]);
  }
  return { date: dm ? dm[1].trim() : '', articles };
}
function rocToYmd(s) {
  const m = /民國\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/.exec(s || '');
  if (!m) return '';
  return String(Number(m[1]) + 1911) + String(m[2]).padStart(2, '0') + String(m[3]).padStart(2, '0');
}

async function archiveArticles(s) {
  const f = path.join(ARTICLES_DIR, s.pcode + '.json');
  const cur = await readJSON(f, { pcode: s.pcode, versions: {} });
  cur.name = s.name; cur.level = s.level;
  if (s.modifiedDate) cur.versions[s.modifiedDate] = s.articles;
  const keys = Object.keys(cur.versions).sort();
  while (keys.length > 8) delete cur.versions[keys.shift()];   // 控制體積
  cur.updatedAt = new Date().toISOString();
  await writeJSONAtomic(f, cur);
}

async function fetchText(u) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' }, signal: ac.signal });
    if (!r.ok) throw new Error('抓取官方頁失敗 ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

function diffArticles(oldA, newA) {
  const nums = new Set([...Object.keys(oldA || {}), ...Object.keys(newA || {})]);
  const arr = [...nums].sort((a, b) => { const x = artKey(a), y = artKey(b); return x[0] - y[0] || x[1] - y[1]; });
  const modified = [], added = [], removed = [];
  for (const n of arr) {
    const o = oldA[n], nw = newA[n];
    if (o != null && nw != null) { if (normText(o) !== normText(nw)) modified.push({ no: n, old: o, new: nw }); }
    else if (nw != null) added.push({ no: n, new: nw });
    else removed.push({ no: n, old: o });
  }
  return { modified, added, removed, changedCount: modified.length + added.length + removed.length };
}

function officialLinks(pcode, meta) {
  const enc = encodeURIComponent(pcode);
  const isLaw = (meta.level || '') === '法律';
  const links = [
    { label: '全國法規資料庫 · 沿革', url: LAWHISTORY + enc },
    { label: '全國法規資料庫 · 歷史法規（舊版條文）', url: LAWOLDVER + enc },
  ];
  if (isLaw) links.push({ label: '立法院法律系統 · 異動條文及理由（輸入法規名稱查詢）', url: 'https://lis.ly.gov.tw/lglawc/lglawkm' });
  else links.push({ label: '行政院公報 · 修正總說明及條文對照表（輸入法規名稱查詢）', url: 'https://gazette.nat.gov.tw/egFront/' });
  return links;
}

function parseLatestAmendment(text) {
  if (!text) return null;
  const entries = [...text.matchAll(/(\d+)\.\s*([\s\S]*?)(?=\r?\n\s*\d+\.|$)/g)];
  if (!entries.length) return null;
  let best = entries[0];
  for (const e of entries) if (Number(e[1]) > Number(best[1])) best = e;
  const body = best[2].replace(/\s+/g, ' ').trim();
  const dm = /中華民國(.+?年.+?月.+?日)/.exec(body);
  const docm = /([^\s，；。]{2,}字第\s*[0-9A-Za-z]+\s*號|(?:總統|行政院)[^，；。]{0,12}令)/.exec(body);
  let docNo = docm ? docm[1].trim() : '';
  docNo = docNo.replace(/^中華民國.*?日\s*/, '');   // 去掉文號前面重複的日期
  const arts = [...body.matchAll(/第\s*(\d+(?:\s*[、～~\-－之至]\s*\d+)*)\s*條/g)].map((m) => m[1].replace(/\s+/g, ''));
  return { date: dm ? dm[1] : '', docNo, articlesMentioned: [...new Set(arts)].slice(0, 40) };
}

// ──────────────────────────────────────────────────────────
// 立法理由（法律）— g0v 國會 API：法律→三讀議案→關連提案→對照表.說明
// 內容源自官方立法院資料；抓不到時回退官方連結，不致單點故障
// ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function lyJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 30000);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ac.signal });
      clearTimeout(t);
      if ((r.status === 413 || r.status === 429 || r.status >= 500) && i < tries - 1) { await sleep(1500 * (i + 1)); continue; }   // 突發限流，退避重試
      if (!r.ok) throw new Error('LY ' + r.status);
      return await r.json();
    } catch (e) { clearTimeout(t); if (i === tries - 1) throw e; await sleep(1500 * (i + 1)); }
  }
  throw new Error('LY 重試失敗');
}
// 中文／阿拉伯條號 → 'N' 或 'N-M'
function artNoToArabic(s) {
  let m = /第\s*(\d+)\s*條(?:\s*之\s*(\d+))?/.exec(s || '');
  if (m) return m[1] + (m[2] ? '-' + m[2] : '');
  m = /第\s*([〇零一二三四五六七八九十百千]+)\s*條(?:\s*之\s*([〇零一二三四五六七八九十百千]+))?/.exec(s || '');
  if (!m) return null;
  const n = cnToNum(m[1]); if (!n) return null;
  return String(n) + (m[2] ? '-' + cnToNum(m[2]) : '');
}
function billDateYmd(no) { const s = String(no || ''); if (s.length < 7 || !/^\d{7}/.test(s)) return ''; const y = Number(s.slice(0, 3)) + 1911; return String(y) + s.slice(3, 5) + s.slice(5, 7); }
let LY_LAW_MAP = null;
async function lyLawMap() {
  if (LY_LAW_MAP) return LY_LAW_MAP;
  const cached = await readJSON(LY_LAWS_PATH, null);
  if (cached && cached.map && Object.keys(cached.map).length > 3000) { LY_LAW_MAP = cached.map; return LY_LAW_MAP; }
  return null;
}
async function lyLawCode(name) { const m = await lyLawMap(); return m ? (m[name] || null) : null; }   // 只讀快取，不在查詢時建索引
// 建立/更新 LY 法律名稱→編號索引（節流；於資料同步 refreshIndex 時 best-effort 背景呼叫）
async function buildLyIndexIfNeeded() {
  const cached = await readJSON(LY_LAWS_PATH, null);
  if (cached && cached.complete && cached.map && Object.keys(cached.map).length > 3000 && (Date.now() - new Date(cached.builtAt).getTime() < 30 * 86400000)) return;
  const map = (cached && cached.map) || {}; let totalPage = 14;
  for (let pg = 1; pg <= 20; pg++) {
    let d; try { d = await lyJson(LY_API + '/v2/laws?' + new URLSearchParams({ limit: '1000', page: String(pg) })); }
    catch { await sleep(2000); continue; }
    totalPage = d.total_page || totalPage;
    for (const L of (d.laws || [])) { if (L['名稱'] && L['法律編號'] && !map[L['名稱']]) map[L['名稱']] = L['法律編號']; }
    await writeJSONAtomic(LY_LAWS_PATH, { builtAt: new Date().toISOString(), map, complete: pg >= totalPage });
    if (pg >= totalPage) break;
    await sleep(2500);
  }
  LY_LAW_MAP = map;
}
async function lyReasons(pcode, name, ymd) {
  const key = pcode + ':' + ymd;
  const cache = await readJSON(LY_REASONS_PATH, {});
  if (cache[key]) return { ...cache[key], status: 'ok' };
  const result = { articles: {}, bill: null, status: 'none' };   // none＝查得到但本次修正無對應立法理由（不需重試）
  try {
    const code = await lyLawCode(name);
    if (code) {
      const d = await lyJson(LY_API + '/v2/bills?' + new URLSearchParams({ ['法律編號']: code, ['議案狀態']: '三讀', limit: '60' }));
      const bills = (d.bills || []).map((b) => ({ no: b['議案編號'], date: billDateYmd(b['議案編號']), name: b['議案名稱'] })).filter((b) => b.date);
      let best = null;
      for (const b of bills) { if (b.date > addDays(ymd, 45)) continue; if (!best || daysBetween(b.date, ymd) < daysBetween(best.date, ymd)) best = b; }
      if (best && daysBetween(best.date, ymd) <= 400) {   // 三讀通常在公布日前一年內
        const bd = await lyJson(LY_API + '/v1/bill/' + best.no);
        result.bill = { no: best.no, name: best.name || bd['議案名稱'], date: best.date };
        result.status = 'ok';                              // 找到對應議案＝成功（理由可能多寡不一）
        const billNos = [{ no: best.no, data: bd }];
        for (const r of (bd['關連議案'] || [])) { const n = r.billNo || r['議案編號']; if (n) billNos.push({ no: n }); }
        for (const bn of billNos.slice(0, 8)) {
          let pb = bn.data; if (!pb) { try { pb = await lyJson(LY_API + '/v1/bill/' + bn.no); } catch { continue; } }
          for (const c of (pb['對照表'] || [])) {
            for (const row of (c.rows || [])) {
              const no = artNoToArabic(row['條號'] || row['修正'] || row['增訂'] || row['現行'] || '');
              const say = (row['說明'] || '').trim();
              if (no && say) { (result.articles[no] = result.articles[no] || []); if (!result.articles[no].includes(say)) result.articles[no].push(say); }
            }
          }
        }
      }
    }
  } catch (e) { console.error('lyReasons:', e && e.message); result.status = 'failed'; }   // failed＝抓取失敗(限流/網路)，前端可重試（仍有官方連結）
  if (result.bill) { cache[key] = { articles: result.articles, bill: result.bill }; await writeJSONAtomic(LY_REASONS_PATH, cache); }   // 僅成功才快取，失敗下次重試
  return result;
}

async function buildDiff(pcode) {
  const meta = lawMeta(pcode);
  if (!meta) throw new Error('查無此法規（可能非全國法規資料庫範圍，例如公告／導則／附表）');
  const curDate = meta.modifiedDate;
  const snap = await readJSON(path.join(ARTICLES_DIR, pcode + '.json'), null);
  const newArts = snap && snap.versions && snap.versions[curDate];
  if (!newArts) throw new Error('尚無此法規的條文快照，暫時無法比對新舊條文（此法規會在隨資料庫同步、建立快照後即可使用）。');

  let oldArts = null, oldDate = '', oldSource = '';
  const prior = snap ? Object.keys(snap.versions).filter((d) => d < curDate).sort() : [];
  if (prior.length) {
    oldDate = prior[prior.length - 1];
    oldArts = snap.versions[oldDate];
    oldSource = '本機快照（官方批次）';
  } else {
    const ov = parseLawOldVer(await fetchText(LAWOLDVER + encodeURIComponent(pcode)));
    oldArts = ov.articles;
    oldDate = rocToYmd(ov.date) || ov.date;
    oldSource = '全國法規資料庫 · 歷史法規';
    // 快取舊版官方條文，下次同一版本免再連線
    if (/^\d{8}$/.test(oldDate) && Object.keys(oldArts).length) {
      await archiveArticles({ pcode, name: meta.name, level: meta.level, modifiedDate: oldDate, articles: oldArts });
    }
  }
  const oldEmpty = !oldArts || Object.keys(oldArts).length === 0;
  // 舊版若來自歷史法規(固定寬度硬斷行)，重組回正確的項/款單元；批次來源則原樣不動
  if (!oldEmpty) oldArts = Object.fromEntries(Object.entries(oldArts).map(([k, v]) => [k, maybeDewrap(v)]));
  const diff = oldEmpty ? { modified: [], added: [], removed: [], changedCount: 0 } : diffArticles(oldArts, newArts);
  const histories = await readJSON(HISTORIES_PATH, {});
  const amend = parseLatestAmendment(histories[pcode] || '');
  const out = {
    pcode, name: meta.name, level: meta.level,
    newDate: curDate, oldDate: oldEmpty ? '' : oldDate, oldSource, noPrior: oldEmpty,
    amend, ...diff, links: officialLinks(pcode, meta),
  };
  if (meta.level === '法律' && diff.changedCount) {   // 法律：附逐條立法理由（g0v 國會 API）
    const r = await lyReasons(pcode, meta.name, curDate);
    out.reasonsByArticle = r.articles; out.reasonBill = r.bill; out.reasonsStatus = r.status; // ok / none / failed
  }
  return out;
}

// ──────────────────────────────────────────────────────────
// 行政院公報：命令「修正總說明」擷取（dataset 5959 / gazette.nat.gov.tw）
// 取得不到時回退為官方查詢提示，不影響匯出。
// ──────────────────────────────────────────────────────────
function cdata(rec, tag) { const m = new RegExp('<' + tag + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></' + tag + '>').exec(rec); return m ? m[1] : ''; }
function rocDateAny(s) { const m = /(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/.exec(s || ''); if (m) return String(Number(m[1]) + 1911) + String(m[2]).padStart(2, '0') + String(m[3]).padStart(2, '0'); return parseRocDate(s || ''); }
// 公報 HTMLContent 多半把修正總說明放在 PDF（顯示「請參見PDF」），此時回空字串、改提供連結
function extractGazetteSummary(html) {
  const text = stripTags(html).replace(/[ \t　]+/g, ' ').trim();
  const i = text.indexOf('修正總說明');
  if (i < 0) return '';
  let seg = text.slice(i + 5);
  const j = seg.search(/條文對照表/);
  if (j > 5) seg = seg.slice(0, j);
  seg = seg.replace(/\s+/g, ' ').trim();
  if (/請參見PDF|請參閱PDF|見PDF|詳如附件|另載/.test(seg) || seg.length < 30) return '';
  return seg.slice(0, 4000);
}
function parseGazetteRecords(xml) {
  const out = [];
  for (const m of xml.matchAll(/<Record>([\s\S]*?)<\/Record>/g)) {
    const rec = m[1];
    const title = cdata(rec, 'Title');
    if (!/修正|訂定|增訂|刪除/.test(title)) continue;
    const nm = /[「『]([^」』]+)[」』]/.exec(title);
    if (!nm) continue;
    out.push({ name: nm[1], date: rocDateAny(cdata(rec, 'Date_Published')), docNo: cdata(rec, 'GazetteId'),
      url: cdata(rec, 'PreviewStageURL'), summary: extractGazetteSummary(cdata(rec, 'HTMLContent')) });
  }
  return out;
}
// 更新法規庫時順手抓「當日」公報，命中被追蹤命令就快取連結（與內文，若有）；往後逐日累積
async function captureGazette(watchedNames) {
  try {
    const recs = parseGazetteRecords(await fetchText(GAZETTE_API))
      .filter((r) => r.date && [...watchedNames].some((n) => r.name === n || r.name.includes(n) || n.includes(r.name)));
    if (!recs.length) return;
    const cache = await readJSON(GAZETTE_PATH, {});
    for (const r of recs) {
      const arr = cache[r.name] || (cache[r.name] = []);
      const ex = arr.find((e) => e.date === r.date);
      if (ex) { ex.url = r.url; if (r.summary) ex.summary = r.summary; }
      else arr.push({ date: r.date, docNo: r.docNo, url: r.url, summary: r.summary });
      arr.sort((a, b) => (a.date < b.date ? 1 : -1));
      if (arr.length > 12) arr.length = 12;
    }
    await writeJSONAtomic(GAZETTE_PATH, cache);
  } catch { /* 靜默：公報抓取失敗不影響更新 */ }
}
async function fetchGazetteSummary(name, ymd) {
  const cache = await readJSON(GAZETTE_PATH, {});
  let entries = cache[name];
  if (!entries) entries = Object.entries(cache).filter(([k]) => k.includes(name) || name.includes(k)).flatMap(([, v]) => v);
  if (!entries || !entries.length) return null;
  let best = null;
  for (const e of entries) if (!best || Math.abs(Number(e.date) - Number(ymd)) < Math.abs(Number(best.date) - Number(ymd))) best = e;
  return best;   // {date, docNo, url, summary}
}
async function attachGazetteSummary(diff) {
  diff.summaryNote = (diff.amend && diff.amend.docNo ? diff.amend.docNo + '　' : '') + '修正總說明請見行政院公報（gazette.nat.gov.tw，以法規名稱查詢）';
  try {
    const g = await fetchGazetteSummary(diff.name, diff.newDate);
    if (g) {
      diff.summarySource = '行政院公報';
      if (g.url) diff.summaryUrl = g.url;
      diff.summaryNote = g.summary || ((g.docNo ? g.docNo + '　' : '') + '修正總說明及條文對照表以 PDF 發布，請點下方公報連結查看。');
    }
  } catch { /* 靜默回退 */ }
}

// ──────────────────────────────────────────────────────────
// Word(.docx) 匯出 — 純 Node 自製（ZIP store + WordprocessingML）
// ──────────────────────────────────────────────────────────
function cnumS(n) {
  const d = '〇一二三四五六七八九';
  if (n <= 10) return n === 10 ? '十' : d[n];
  if (n < 20) return '十' + (n > 10 ? d[n - 10] : '');
  if (n < 100) { const t = Math.floor(n / 10), o = n % 10; return d[t] + '十' + (o ? d[o] : ''); }
  return String(n);
}
function lcsDiffS(a, b) {
  const n = a.length, m = b.length;
  if (n + m > 6000) return [{ t: '-', s: a }, { t: '+', s: b }];
  const dp = []; for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; const push = (t, s) => { const l = ops[ops.length - 1]; if (l && l.t === t) l.s += s; else ops.push({ t, s }); };
  let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { push('=', a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { push('-', a[i]); i++; } else { push('+', b[j]); j++; } }
  while (i < n) push('-', a[i++]); while (j < m) push('+', b[j++]);
  return ops;
}
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files) {
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8'), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central), cdStart = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}
function xmlEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function wRun(text, o = {}) {
  const r = [];
  if (o.color) r.push(`<w:color w:val="${o.color}"/>`);
  if (o.u) r.push('<w:u w:val="single"/>');
  if (o.strike) r.push('<w:strike/>');
  if (o.b) r.push('<w:b/>');
  if (o.sz) r.push(`<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>`);
  const rpr = r.length ? `<w:rPr>${r.join('')}</w:rPr>` : '';
  return `<w:r>${rpr}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
}
function wPara(runs, o = {}) {
  const pr = [];
  if (o.spacing != null) pr.push(`<w:spacing w:after="${o.spacing}"/>`);
  if (o.align) pr.push(`<w:jc w:val="${o.align}"/>`);
  const ppr = pr.length ? `<w:pPr>${pr.join('')}</w:pPr>` : '';
  return `<w:p>${ppr}${runs || ''}</w:p>`;
}
function colParasDocx(ops, side) {
  const keep = side === 'new' ? '+' : '-';
  const fmt = side === 'new' ? { color: 'C0392B', u: true } : { color: 'C0392B', strike: true };
  const paras = [[]];
  for (const op of ops) {
    if (op.t !== '=' && op.t !== keep) continue;
    const segs = op.s.split('\n');
    for (let k = 0; k < segs.length; k++) { if (k > 0) paras.push([]); if (segs[k]) paras[paras.length - 1].push([op.t === '=', segs[k]]); }
  }
  const real = paras.filter((p) => p.length);
  if (!real.length) return wPara(wRun('（無此版本）', { color: '999999' }));
  let itemNo = 0;
  return real.map((p) => {
    const plain = p.map(([, s]) => s).join('');
    const sub = isSubMarker(plain);
    const label = sub ? '　　' : '第' + (++itemNo) + '項　';
    return wPara(wRun(label, { color: '888888', sz: 18 }) + p.map(([same, s]) => wRun(s, same ? {} : fmt)).join(''), { spacing: 40 });
  }).join('');
}
const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
function buildDocx(diff) {
  const RB = diff.reasonsByArticle || {};
  const hasReasons = Object.keys(RB).length > 0;
  const W1 = hasReasons ? 3450 : 3850, W2 = W1, W3 = hasReasons ? 2500 : 1700;   // 合計 9400 dxa ＜ A4 直印可用寬
  const cell = (xml, w) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${xml || wPara('')}</w:tc>`;
  const rows = [`<w:tr>${cell(wPara(wRun('修正條文（新）', { b: true }), { align: 'center' }), W1)}${cell(wPara(wRun('現行條文（舊）', { b: true }), { align: 'center' }), W2)}${cell(wPara(wRun(hasReasons ? '立法理由' : '備註', { b: true }), { align: 'center' }), W3)}</w:tr>`];
  const kindColor = { 修正: 'B4882B', 新增: '2F7D4F', 刪除: 'B4452B' };
  const all = [...diff.modified.map((a) => ['修正', a]), ...diff.added.map((a) => ['新增', a]), ...diff.removed.map((a) => ['刪除', a])];
  for (const [kind, a] of all) {
    const ops = lcsDiffS(a.old || '', a.new || '');
    const head = wPara(wRun('第 ' + a.no + ' 條　', { b: true }) + wRun('（' + kind + '）', { color: kindColor[kind], b: true }), { spacing: 40 });
    const reasons = RB[a.no] || [];   // 法律：立法理由；命令：留空供批註
    const col3xml = reasons.length ? reasons.map((r) => wPara(wRun(r, { sz: 18 }), { spacing: 60 })).join('') : wPara('');
    rows.push(`<w:tr>${cell(head + colParasDocx(ops, 'new'), W1)}${cell(colParasDocx(ops, 'old'), W2)}${cell(col3xml, W3)}</w:tr>`);
  }
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:color="AAAAAA"/>`).join('');
  const grid = `<w:tblGrid><w:gridCol w:w="${W1}"/><w:gridCol w:w="${W2}"/><w:gridCol w:w="${W3}"/></w:tblGrid>`;
  const tbl = `<w:tbl><w:tblPr><w:tblW w:w="${W1 + W2 + W3}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${grid}${rows.join('')}</w:tbl>`;
  const ymd = (d) => (d && String(d).length === 8) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : (d || '—');
  const title = wPara(wRun(diff.name + '　新舊條文對照表', { b: true, sz: 32 }), { spacing: 120, align: 'center' });
  const sub = wPara(wRun(`新版 ${ymd(diff.newDate)}　↔　舊版 ${ymd(diff.oldDate)}　·　異動 ${diff.changedCount} 條`, { color: '666666', sz: 20 }), { spacing: 160, align: 'center' });
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${title}${sub}${tbl}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
  return zipStore([
    { name: '[Content_Types].xml', data: DOCX_CONTENT_TYPES },
    { name: '_rels/.rels', data: DOCX_RELS },
    { name: 'word/document.xml', data: doc },
  ]);
}

// ──────────────────────────────────────────────────────────
// 群組與查核
// ──────────────────────────────────────────────────────────
async function loadGroups() {
  const db = await readJSON(GROUPS_PATH, { version: 1, groups: [] });
  if (!db || !Array.isArray(db.groups)) return { version: 1, groups: [] };   // 防護：損壞的 groups.json 不致讓所有 API 壞掉
  return db;
}
async function saveGroups(db) { await writeJSONAtomic(GROUPS_PATH, db); await backupGroups(); }

// 每日備份 groups.json —— 你的「任務設定＋查核歷史＋各法規版本基準」是唯一無法重建的資料：
// 法規索引壞了可重抓，但這個檔誤刪／損壞／磁碟故障就全失。以當天日期為檔名（同日多次儲存覆蓋同一份＝永遠最新），保留最近 BACKUP_KEEP 天。
let LAST_BACKUP = null;   // { at, ok, error, file } 供日後 UI／通知顯示
let _bkSeq = 0;
async function backupGroups() {
  if (!(BACKUP_KEEP > 0)) return;                                  // BACKUP_KEEP=0 → 關閉備份
  try {
    const raw = await readFile(GROUPS_PATH, 'utf8').catch(() => null);
    if (!raw || raw.trim().length < 2) return;                     // 全新安裝、尚無資料 → 不備份
    await mkdir(BACKUP_DIR, { recursive: true });
    const file = `groups-${todayYmd()}.json`;
    const dest = path.join(BACKUP_DIR, file);
    const tmp = `${dest}.tmp-${process.pid}-${++_bkSeq}`;
    await writeFile(tmp, raw, 'utf8');
    await rename(tmp, dest);                                        // 原子寫入，備份檔本身也不會寫一半
    LAST_BACKUP = { at: new Date().toISOString(), ok: true, file };  // 寫入已成功；後續修剪是盡力而為，失敗不該蓋掉這個成功狀態
    try {
      const all = await readdir(BACKUP_DIR);
      const dated = all.filter((f) => /^groups-\d{8}\.json$/.test(f)).sort();   // 零填日期 → 字典序＝時間序
      for (const f of dated.slice(0, Math.max(0, dated.length - BACKUP_KEEP))) await unlink(path.join(BACKUP_DIR, f)).catch(() => {});
      // 清掉先前崩潰/中斷殘留的 .tmp 暫存檔（修剪 regex 不含 .tmp，否則會無限累積）；排除本行程正在寫的暫存檔以免誤刪
      const mine = `.tmp-${process.pid}-`;
      for (const f of all.filter((f) => /^groups-\d{8}\.json\.tmp-/.test(f) && !f.includes(mine))) await unlink(path.join(BACKUP_DIR, f)).catch(() => {});
    } catch { /* 修剪盡力而為，不影響已寫入的備份 */ }
  } catch (e) {
    LAST_BACKUP = { at: new Date().toISOString(), ok: false, error: String(e.message || e) };
    console.error('  備份 groups.json 失敗（不影響查核）：', LAST_BACKUP.error);
  }
}

// 群組寫入序列化：把所有「讀取→修改→寫回 groups.json」的交易排成一條佇列，
// 避免兩個並行請求各自 loadGroups 後又各自 saveGroups、互相覆蓋而遺失任務。
let _groupsChain = Promise.resolve();
function lockGroups(fn) {
  const run = _groupsChain.then(fn, fn);
  _groupsChain = run.then(() => {}, () => {});   // 不論成敗都讓佇列繼續
  return run;
}

function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// 舊版群組（frequencyDays）→ 新排程模型，僅供顯示用的安全預設
function migrateGroup(g) {
  if (g.frequencyMonths === undefined) {
    g.frequencyMonths = g.frequencyDays ? Math.max(1, Math.round(g.frequencyDays / 30)) : 0;
    g.baselineDate = g.baselineDate ?? null;
    g.nextBaselineDate = g.nextBaselineDate ?? null;
    g.lagDays = g.lagDays ?? DEFAULT_LAG_DAYS;
  }
  if (!Array.isArray(g.watchlist)) g.watchlist = [];   // 防護：手改／損壞的 groups.json 缺 watchlist 時，不讓整個 UI 壞掉
  if (!Array.isArray(g.history)) g.history = [];
  return g;
}

// 日期驅動查核：比較各法規「截至前次基準日」與「截至此次基準日」的在效版本
// official=true：正式查核（到期執行）→ 記錄每法版本(baseVersion)、推進排程；false：試算（未到期手動）→ 只比對、不推進。
function runCheck(group, now, official) {
  if (!INDEX) throw new Error('法規資料庫尚未就緒，請稍候再試');
  const baseYmd = ymdNorm(group.baselineDate);                      // 前次查核基準日（期間起點，僅供顯示／標籤）
  const cutoffYmd = ymdNorm(group.nextBaselineDate) || todayYmd();  // 本次查核基準日（期間終點）
  const changes = [];
  for (const law of group.watchlist) {
    const meta = lawMeta(law.pcode);
    if (!meta) { changes.push({ pcode: law.pcode, name: law.name, from: null, to: null, kind: 'missing', abolished: false }); continue; }
    const toDate = asOfDate(law.pcode, cutoffYmd) || meta.modifiedDate || '';
    // 比對起點＝該法「上次正式查核所記錄的版本」(baseVersion)。如此，某次因資料晚上線而漏抓的修正，
    // 會在下一期被自然抓到（因為 baseVersion 仍停在舊版）。舊資料未記錄版本時，退回以前次基準日推算。
    let fromV;
    // 已記錄版本（正式查核後 baseVersion 會是日期）才直接採用；尚未記錄者（新加入＝null、舊資料＝undefined）一律以「前次基準日」推算，
    // 讓第一次查核能把「前次查核結果」補成前次基準日當時的在效版本（沒填前次基準日則為 null＝首次納入）。
    if (law.baseVersion != null) fromV = law.baseVersion;
    else fromV = baseYmd ? (asOfDate(law.pcode, baseYmd) || null) : null;
    let kind;
    if (!fromV) kind = 'new';
    else if (toDate > fromV) kind = 'changed';
    else kind = 'unchanged';
    changes.push({ pcode: law.pcode, name: meta.name || law.name, from: fromV || null, to: toDate, kind, abolished: meta.abolished });
    if (official) law.baseVersion = toDate || null;                 // 只有正式查核才推進 per-law 版本基準
  }
  const summary = { changed: 0, unchanged: 0, new: 0, missing: 0 };
  for (const c of changes) summary[c.kind]++;
  group.prevCheckedAt = group.lastCheckedAt || null;
  group.lastCheckedAt = now;
  const run = { checkedAt: now, dbDate: INDEX.fetchedAt, stale: !indexIsFresh(), baseDate: baseYmd || null, cutoffDate: cutoffYmd, summary, changes, official: !!official };
  // 同一基準日（本期）重複執行 → 覆蓋該期紀錄，不重複堆疊（試算亦會被同期正式查核取代）
  group.history = (group.history || []).filter((r) => r.cutoffDate !== cutoffYmd);
  group.history.unshift(run);
  if (group.history.length > 60) group.history.length = 60;
  // 正式查核才推進排程：前次基準 ← 本次基準；本次基準 ← 本次 + 頻率（月）
  if (official) {
    group.baselineDate = cutoffYmd;
    group.nextBaselineDate = group.frequencyMonths > 0 ? addMonths(cutoffYmd, group.frequencyMonths) : null;
  }
  return run;
}

// ──────────────────────────────────────────────────────────
// HTTP 輔助
// ──────────────────────────────────────────────────────────
function sendJSON(res, code, obj) {
  try {
    if (res.writableEnded || res.destroyed) return;   // 連線已關/斷就不再寫入，避免在毀損的 socket 上拋錯
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  } catch { /* 連線已斷，忽略 */ }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };          // 確保 Promise 一定有結果，避免請求卡死
    req.on('data', (c) => { data += c; if (data.length > 5e6) { fail(new Error('請求內容過大')); req.destroy(); } });
    req.on('end', () => { if (done) return; done = true; try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', fail);
    req.on('close', () => fail(new Error('連線中斷')));                       // destroy()/中斷只發 close，不發 end → 在此收尾
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
async function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
  const full = path.join(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

// 跑「所有到期任務」的正式查核（補完積壓期間，上限 24 期）。/api/auto-check 與內建排程器共用。
async function runDueChecks() {
  await ensureFreshIndex();                          // 先確保比對最新資料（不佔群組鎖）
  return await lockGroups(async () => {
    const db = await loadGroups();
    const now = new Date().toISOString();
    const ran = [], capped = [];
    for (const g of db.groups) {
      migrateGroup(g);
      let guard = 0;
      while (isDueNow(g) && guard < 24) {
        const run = runCheck(g, now, true);
        ran.push({ groupId: g.id, name: g.name, baseDate: run.baseDate, cutoffDate: run.cutoffDate, summary: run.summary });
        guard++;
      }
      if (isDueNow(g)) capped.push(g.name);            // 撞上限，仍有更早期間未補完
    }
    if (ran.length) await saveGroups(db);              // 沒有任何到期就不必寫檔
    return { ran, capped };
  });
}

// ──────────────────────────────────────────────────────────
// 路由
// ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const m = req.method;
  try {
    // ---- API ----
    if (p === '/api/state' && m === 'GET') {
      const db = await loadGroups();
      const today = todayYmd();
      const groups = db.groups.map((g0) => {
        const g = migrateGroup(g0);
        const due = dueYmd(g);
        return {
          ...g,
          due, autoDue: isDueNow(g),
          watchlist: g.watchlist.map((l) => {
            const meta = lawMeta(l.pcode);
            return { ...l, current: meta ? { name: meta.name, modifiedDate: meta.modifiedDate, abolished: meta.abolished, level: meta.level } : null };
          }),
        };
      });
      return sendJSON(res, 200, { db: dbMeta(), sync: syncMeta(), refreshing, today, groups });
    }

    if (p === '/api/db/refresh' && m === 'POST') {
      try { const meta = await refreshIndex(); LAST_SYNC = { at: new Date().toISOString(), ok: true }; return sendJSON(res, 200, { ok: true, db: meta, sync: syncMeta() }); }
      catch (e) { LAST_SYNC = { at: new Date().toISOString(), ok: false, error: String(e.message || e) }; return sendJSON(res, 500, { error: String(e.message || e), sync: syncMeta() }); }
    }

    if (p === '/api/laws/search' && m === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJSON(res, 200, { results: [] });
      const lower = q.toLowerCase();
      const results = SEARCH_LIST
        .filter((x) => x.name.includes(q) || x.pcode.toLowerCase() === lower)
        .sort((a, b) => (a.abolished - b.abolished) || (a.name.length - b.name.length) || a.name.localeCompare(b.name, 'zh-Hant'))
        .slice(0, 40);
      return sendJSON(res, 200, { results, hasIndex: !!INDEX });
    }

    if (p === '/api/groups' && m === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return sendJSON(res, 400, { error: '請輸入任務名稱' });
      return await lockGroups(async () => {
        const db = await loadGroups();
        const group = {
          id: newId(), name, note: (body.note || '').trim(),
          baselineDate: ymdNorm(body.baselineDate) || null,          // 前次查核基準日（可空＝第一次查核）
          nextBaselineDate: ymdNorm(body.nextBaselineDate) || null,  // 下次查核基準日
          frequencyMonths: Number(body.frequencyMonths) || 0,        // 查核頻率（月）
          lagDays: body.lagDays != null ? Number(body.lagDays) : DEFAULT_LAG_DAYS,
          watchlist: [], state: {}, history: [],
          prevCheckedAt: null, lastCheckedAt: null, createdAt: new Date().toISOString(),
        };
        db.groups.push(group);
        await saveGroups(db);
        return sendJSON(res, 200, { group });
      });
    }

    let mm;
    if ((mm = p.match(/^\/api\/groups\/([^/]+)$/)) && (m === 'PATCH' || m === 'DELETE')) {
      const body = m === 'PATCH' ? await readBody(req) : null;
      return await lockGroups(async () => {
        const db = await loadGroups();
        const g = db.groups.find((x) => x.id === mm[1]);
        if (!g) return sendJSON(res, 404, { error: '找不到任務' });
        if (m === 'PATCH') {
          if (body.name != null) g.name = String(body.name).trim() || g.name;
          if (body.note != null) g.note = String(body.note).trim();
          if (body.baselineDate !== undefined) g.baselineDate = ymdNorm(body.baselineDate) || null;
          if (body.nextBaselineDate !== undefined) g.nextBaselineDate = ymdNorm(body.nextBaselineDate) || null;
          if (body.frequencyMonths != null) g.frequencyMonths = Number(body.frequencyMonths) || 0;
          if (body.lagDays != null) g.lagDays = Number(body.lagDays);
          if (body.paused != null) g.paused = !!body.paused;     // 停用／恢復（紀錄保留）
          delete g.frequencyDays;
          await saveGroups(db);
          return sendJSON(res, 200, { group: g });
        }
        db.groups = db.groups.filter((x) => x.id !== mm[1]);     // DELETE
        await saveGroups(db);
        return sendJSON(res, 200, { ok: true });
      });
    }

    if ((mm = p.match(/^\/api\/groups\/([^/]+)\/laws$/)) && m === 'POST') {
      const body = await readBody(req);
      return await lockGroups(async () => {
        const db = await loadGroups();
        const g = db.groups.find((x) => x.id === mm[1]);
        if (!g) return sendJSON(res, 404, { error: '找不到任務' });
        // 手動查核項目：不在批次資料庫的法規，由使用者自行追蹤（系統不自動比對），產生唯一 MANUAL- 代碼
        if (body.manual || !(body.pcode || '').trim()) {
          const name = (body.name || '').trim();
          if (!name) return sendJSON(res, 400, { error: '請輸入法規名稱' });
          const pcode = 'MANUAL-' + newId();
          g.watchlist.push({ pcode, name, addedAt: new Date().toISOString(), manual: true });
          await saveGroups(db);
          return sendJSON(res, 200, { group: g, manual: true });
        }
        const pcode = (body.pcode || '').trim();
        if (g.watchlist.some((l) => l.pcode === pcode)) return sendJSON(res, 200, { group: g, dup: true });
        const meta = lawMeta(pcode);
        const name = (meta && meta.name) || body.name || pcode;
        g.watchlist.push({ pcode, name, addedAt: new Date().toISOString(), baseVersion: null });
        await saveGroups(db);
        return sendJSON(res, 200, { group: g });
      });
    }

    if ((mm = p.match(/^\/api\/groups\/([^/]+)\/laws\/([^/]+)$/)) && m === 'DELETE') {
      return await lockGroups(async () => {
        const db = await loadGroups();
        const g = db.groups.find((x) => x.id === mm[1]);
        if (!g) return sendJSON(res, 404, { error: '找不到任務' });
        const pcode = decodeURIComponent(mm[2]);
        g.watchlist = g.watchlist.filter((l) => l.pcode !== pcode);
        if (g.state) delete g.state[pcode];
        await saveGroups(db);
        return sendJSON(res, 200, { group: g });
      });
    }

    // 手動查核法規：記錄使用者自填的「前次修正日期」（純存檔，不做異動比對）
    if ((mm = p.match(/^\/api\/groups\/([^/]+)\/laws\/([^/]+)$/)) && m === 'PATCH') {
      const body = await readBody(req);
      return await lockGroups(async () => {
        const db = await loadGroups();
        const g = db.groups.find((x) => x.id === mm[1]);
        if (!g) return sendJSON(res, 404, { error: '找不到任務' });
        const law = (g.watchlist || []).find((l) => l.pcode === decodeURIComponent(mm[2]));
        if (!law) return sendJSON(res, 404, { error: '找不到法規' });
        if (body.manualDate !== undefined) law.manualDate = ymdNorm(body.manualDate) || null;
        if (body.reviewedTo !== undefined) law.reviewedTo = ymdNorm(body.reviewedTo) || null; // 已閱：使用者已看過此版本的新舊對照
        await saveGroups(db);
        return sendJSON(res, 200, { ok: true });
      });
    }

    if ((mm = p.match(/^\/api\/groups\/([^/]+)\/check$/)) && m === 'POST') {
      await ensureFreshIndex();                       // 查核前先確保比對的是當日最新資料（不佔群組寫入鎖）
      return await lockGroups(async () => {
        const db = await loadGroups();
        const g = db.groups.find((x) => x.id === mm[1]);
        if (!g) return sendJSON(res, 404, { error: '找不到任務' });
        migrateGroup(g);
        const now = new Date().toISOString();
        let run, periods = 0, totalChanged = 0, capped = false;
        if (isDueNow(g)) {
          // 已到執行查核日＝正式查核：一次補完所有積壓期間（與「開啟自動查核」一致），上限 24 期
          let guard = 0;
          while (isDueNow(g) && guard < 24) { run = runCheck(g, now, true); periods++; totalChanged += run.summary.changed; guard++; }
          capped = isDueNow(g);                        // 仍到期＝撞上限，還有更早期間未補完
        } else {
          run = runCheck(g, now, false);               // 未到期＝試算（僅參考，不推進基準）
        }
        await saveGroups(db);
        return sendJSON(res, 200, { group: g, run, periods, totalChanged, capped, db: dbMeta() });
      });
    }

    // 自動查核：開啟系統時呼叫。把所有「已到執行查核日」的任務各自跑正式查核並推進基準；
    // 跨多期會自動補做（上限 24 期）。後端原子寫檔，中途關掉視窗仍會完成；未完成者下次開啟自動補做。
    if (p === '/api/auto-check' && m === 'POST') {
      const r = await runDueChecks();
      return sendJSON(res, 200, { ...r, db: dbMeta() });
    }

    if ((mm = p.match(/^\/api\/laws\/([^/]+)\/history$/)) && m === 'GET') {
      const histories = await readJSON(HISTORIES_PATH, {});
      const pcode = decodeURIComponent(mm[1]);
      const meta = lawMeta(pcode);
      return sendJSON(res, 200, { pcode, name: meta && meta.name, history: histories[pcode] || '' });
    }

    if ((mm = p.match(/^\/api\/laws\/([^/]+)\/diff$/)) && m === 'GET') {
      const out = await buildDiff(decodeURIComponent(mm[1]));
      if (out.level !== '法律') await attachGazetteSummary(out);   // 命令：帶入公報修正總說明（讀本機快取）
      return sendJSON(res, 200, out);
    }

    if ((mm = p.match(/^\/api\/laws\/([^/]+)\/diff\.docx$/)) && m === 'GET') {
      const diff = await buildDiff(decodeURIComponent(mm[1]));
      const buf = buildDocx(diff);
      const fname = encodeURIComponent(`${diff.name}_新舊對照表_${diff.newDate}.docx`);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${fname}`,
      });
      return res.end(buf);
    }

    if (p.startsWith('/api/')) return sendJSON(res, 404, { error: '未知的 API' });

    // ---- 靜態檔 ----
    return await serveStatic(res, p);
  } catch (e) {
    return sendJSON(res, 500, { error: String(e.message || e) });
  }
});

// ──────────────────────────────────────────────────────────
// 啟動
// ──────────────────────────────────────────────────────────
async function start() {
  await mkdir(DATA_DIR, { recursive: true });
  INDEX = await readJSON(INDEX_PATH, null);
  HISTORIES = await readJSON(HISTORIES_PATH, {});
  buildSearchList();
  server.listen(PORT, HOST, () => {
    const stamp = INDEX ? `法規庫版本 ${INDEX.fetchedAt.slice(0, 10)}（${INDEX.total} 部）` : '尚未下載法規庫';
    const where = HOST === '0.0.0.0' ? `區網開放　埠 ${PORT}（請用本機區網 IP 連線）` : `http://${HOST}:${PORT}`;
    console.log(`\n  法規更新查核工具已啟動`);
    console.log(`  ➜  ${where}`);
    console.log(`  ${stamp}`);
    const schOn = CHECK_HOUR >= 0 && CHECK_HOUR <= 23;
    console.log(`  排程器：${schOn ? `每天 ${String(CHECK_HOUR).padStart(2, '0')}:05（本機時間≈台灣）＋啟動時，自動查核到期任務` : '已關閉（僅開頁時查核）'}\n`);
  });
  backupGroups().catch(() => {});   // 啟動時先備份一次：即使當天無任何變更，也確保有一份當日快照（防護：永不影響啟動）
  // 內建排程器：①啟動後 4 秒補做一次（涵蓋停機/重啟期間錯過的，會自動補完多期）；
  // ②每天 CHECK_HOUR:05（本機時間）跑一次——挑「9 點剛過」是因為任務正是在執行查核日當天 9 點跨過到期門檻，這時動作當天上午就完成。
  if (CHECK_HOUR >= 0 && CHECK_HOUR <= 23) {
    const tick = async (why) => {
      try {
        const r = await runDueChecks();
        if (r.ran.length) console.log(`  [排程/${why}] 自動查核完成 ${r.ran.length} 期${r.capped.length ? `（${r.capped.join('、')} 仍積壓，下輪續補）` : ''}`);
      } catch (e) { console.error(`  [排程/${why}] 自動查核失敗：`, e.message); }
    };
    setTimeout(() => tick('啟動補做'), 4000);
    const msUntil = (h, min) => { const n = new Date(); const t = new Date(n.getFullYear(), n.getMonth(), n.getDate(), h, min, 0, 0); if (t <= n) t.setDate(t.getDate() + 1); return t - n; };
    const scheduleDaily = () => setTimeout(async () => { await tick('每日'); scheduleDaily(); }, msUntil(CHECK_HOUR, 5));
    scheduleDaily();
  }
}
start();
