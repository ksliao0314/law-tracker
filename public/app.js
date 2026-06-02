'use strict';

const state = { db: null, refreshing: false, groups: [], selectedId: null };

// ── API ─────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// ── 工具 ────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(d) {
  if (!d || String(d).length !== 8) return d ? esc(d) : '—';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}
function fmtTime(iso) { if (!iso) return '尚未查核'; const dt = new Date(iso); return dt.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
function daysSince(iso) { if (!iso) return Infinity; return (Date.now() - new Date(iso).getTime()) / 86400000; }
function ymdShort(d) { return (d && String(d).length === 8) ? `${String(d).slice(0, 4)}-${String(d).slice(4, 6)}-${String(d).slice(6, 8)}` : '—'; }

const STATUS_LABEL = { changed: '有異動', unchanged: '無異動', new: '首次納入', baseline: '尚未查核', missing: '應手動查詢' };
const STATUS_RANK = { changed: 0, missing: 1, new: 2, baseline: 3, unchanged: 4 };

function lastRun(g) { return g.history && g.history[0]; }
function lastChangeOf(g, pcode) { const run = lastRun(g); return run ? run.changes.find((x) => x.pcode === pcode) : null; }
// 顯示用狀態：取「最近一次查核」對該法規的結果；尚未查核則為 baseline。
function displayStatus(g, l) {                     // 任務內顯示用：有異動就一律顯示「有異動」（不受已閱影響）
  if (!l.current) return 'missing';
  const c = lastChangeOf(g, l.pcode);
  return c ? c.kind : 'baseline';
}
// 任務列表(側欄)用：是否有「尚未點開看過新舊對照」的異動。已閱(reviewedTo)是純內部判斷標記，只影響此處，任務內仍照常顯示有異動。
function groupHasUnreviewedChanges(g) {
  return (g.watchlist || []).some((l) => {
    const c = lastChangeOf(g, l.pcode);
    return !!l.current && !!c && c.kind === 'changed' && l.reviewedTo !== c.to;
  });
}
function groupNeedsCheck(g) {
  if (!g.nextBaselineDate) return { due: false };
  if (g.autoDue) return { due: true, label: '待查核' };
  return { due: false };
}

function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => { t.hidden = true; }, 3200);
}

// ── 載入與渲染 ──────────────────────────────────────
async function load() {
  const data = await api('/api/state');
  state.db = data.db; state.sync = data.sync; state.refreshing = data.refreshing; state.groups = data.groups;
  if (state.selectedId && !state.groups.find((g) => g.id === state.selectedId)) state.selectedId = null;
  if (!state.selectedId && state.groups.length) state.selectedId = state.groups[0].id;
  renderGroups(); renderDetail(); renderSyncStatus(); watchIndexReady();
}

// 首次部署時法規庫在背景下載：未就緒前每 2.5 秒重抓狀態，下載完成就自動重整 →
// 讓「下載前先加入的真法規」自動歸位到追蹤清單（不再卡在「應手動查詢」），使用者免手動重整。
let _idxPolls = 0;
function watchIndexReady() {
  clearTimeout(state._idxTimer);
  if (state.db && !state.refreshing) { _idxPolls = 0; return; }            // 索引已就緒 → 停止輪詢
  if (!state.refreshing && state.sync && state.sync.error) return;          // 下載失敗 → 停止，由同步狀態列顯示錯誤供手動重試
  if (_idxPolls++ > 80) return;                                            // 上限約 200 秒，避免離線時無限輪詢
  state._idxTimer = setTimeout(() => load().catch(() => {}), 2500);
}
// 資料同步狀態（角落）：正常時低調、失敗或過期時明顯並可點擊重試
function renderSyncStatus() {
  const el = document.getElementById('syncStatus'); if (!el) return;
  const s = state.sync || {};
  if (state.refreshing && !state.db) { el.innerHTML = `<span class="sync stale"><span class="spinner"></span>　法規資料庫準備中…（首次啟動，完成後法規自動就緒）</span>`; return; }
  if (state.refreshing) { el.innerHTML = `<span class="sync stale"><span class="spinner"></span>　更新法規資料庫中…</span>`; return; }
  if (s.error) el.innerHTML = `<span class="sync err" data-act="resync" title="${esc(s.error)}">⚠ 資料同步失敗，點此重試</span>`;
  else if (s.fresh) el.innerHTML = `<span class="sync ok">✓ 資料已同步</span>`;
  else if (s.fetchedAt) el.innerHTML = `<span class="sync stale" data-act="resync">資料基準 ${s.fetchedAt.slice(0, 10)}（點此更新）</span>`;
  else el.innerHTML = `<span class="sync stale" data-act="resync">尚未下載法規庫（點此下載）</span>`;
}

function renderGroups() {
  const ul = document.getElementById('groupList');
  if (!state.groups.length) { ul.innerHTML = `<li class="muted" style="padding:12px">尚無任務，點右上「＋ 新增」。</li>`; return; }
  ul.innerHTML = state.groups.slice()
    .sort((a, b) => (Number(!!a.paused) - Number(!!b.paused)))   // 已停用任務排到最後
    .map((g) => {
    const nc = groupNeedsCheck(g);
    const changed = groupHasUnreviewedChanges(g);   // 看過(已閱)後就不再於任務列表顯示「有異動」
    const badges = g.paused
      ? `<span class="badge paused">已停用</span>`
      : (changed ? `<span class="badge changed">有異動</span>` : '') + (nc.due ? `<span class="badge due">${nc.label}</span>` : '');
    const meta = g.paused ? '已停用' : (g.due ? '下次查核 ' + ymdShort(g.due) : (g.lastCheckedAt ? '已查核' : ''));
    return `<li class="group-item ${g.paused ? 'paused' : ''} ${g.id === state.selectedId ? 'active' : ''}" data-id="${g.id}">
      <div class="gi-name">${esc(g.name)} ${badges}</div>
      <div class="gi-meta">${g.watchlist.length} 部法規${meta ? ' · ' + meta : ''}</div>
    </li>`;
  }).join('');
}

function renderDetail() {
  const host = document.getElementById('detail');
  const g = state.groups.find((x) => x.id === state.selectedId);
  if (!g) { host.innerHTML = `<div class="empty"><p>請從左側選擇或新增一個任務。</p><p class="muted">每個任務（當事人 / 案件）可建立各自的法規清單與查核排程。</p></div>`; return; }

  const last = g.history && g.history[0];
  let banner = '';
  if (last) {
    const s = last.summary; const c = s.changed;
    const bits = [];
    if (s.changed) bits.push(`<b>有異動 ${s.changed}</b>`);
    if (s.unchanged) bits.push(`無異動 ${s.unchanged}`);
    if (s.new) bits.push(`首次納入 ${s.new}`);
    if (s.missing) bits.push(`查無 ${s.missing}`);
    const dataDate = last.dbDate ? `　<span class="muted">· 資料基準 ${last.dbDate.slice(0, 10)}</span>` : '';
    const staleNote = last.stale ? `　<span class="stale-note">⚠ 該次未能更新最新資料</span>` : '';
    const isPrev = last.official === false;
    const runTag = isPrev ? '<span class="run-tag preview">試算</span>' : '<span class="run-tag official">例行</span>';
    const prevNote = isPrev ? '　<span class="muted">· 參考用，未更新基準日</span>' : '';
    banner = `<div class="summary-banner ${isPrev ? 'preview' : (c > 0 ? 'has-changes' : 'no-changes')}">
      ${runTag} ${isPrev ? '試算於' : '上次查核'} ${fmtTime(last.checkedAt)}：${bits.join(' · ') || '尚無資料'}${dataDate}${staleNote}${prevNote}</div>`;
  }

  const paused = !!g.paused;
  const freqTxt = g.frequencyMonths > 0 ? `每 ${g.frequencyMonths} 個月` : '不定期';
  const nextBaseTxt = g.nextBaselineDate ? ymdShort(g.nextBaselineDate) : '—';
  const autoCheckTxt = paused ? '<span class="muted">已停用</span>'
    : (g.due ? `${ymdShort(g.due)}${g.autoDue ? ' <span class="badge due">待查核</span>' : ''}` : '—');
  host.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${esc(g.name)}${paused ? ' <span class="badge paused">已停用</span>' : ''}</h2>
      </div>
      <div class="head-actions">
        ${paused
          ? `<button class="btn primary" data-act="resume">恢復查核</button>`
          : `<button class="btn primary" id="btnCheck">執行查核</button>`}
        <button class="btn small" data-act="editGroup">編輯</button>
      </div>
    </div>
    ${paused ? `<div class="summary-banner paused-banner">此任務已停用，不再自動查核；過往查核紀錄已保留。需要時可按右上「恢復查核」繼續。</div>` : ''}
    <div class="meta-row">
      <div class="m"><b>前次查核基準日</b>${g.baselineDate ? ymdShort(g.baselineDate) : '—（首次）'}</div>
      <div class="m"><b>下次查核基準日</b>${nextBaseTxt}</div>
      <div class="m"><b>查核頻率</b>${freqTxt}</div>
      <div class="m"><b>下次自動查核日</b>${autoCheckTxt}</div>
      <div class="m"><b>追蹤數</b>${g.watchlist.length} 部</div>
      <div class="m"><b>上次執行</b>${g.lastCheckedAt ? fmtTime(g.lastCheckedAt) : '—'}</div>
    </div>
    ${paused ? '' : banner}
    ${renderLawTable(g)}
    ${renderManualTable(g)}
    ${renderHistory(g)}
  `;
}

function renderLawTable(g) {
  const list = g.watchlist.filter((l) => l.current);   // 在庫法規（可自動比對）
  if (!list.length) return `<p class="muted" style="padding:20px 4px">尚無可自動追蹤的法規。請按右上「編輯」加入。</p>`;
  const rows = list.slice().sort((a, b) =>
    (STATUS_RANK[displayStatus(g, a)] - STATUS_RANK[displayStatus(g, b)]) || a.name.localeCompare(b.name, 'zh-Hant')
  ).map((l) => {
    const status = displayStatus(g, l);
    const cur = l.current;
    const c = lastChangeOf(g, l.pcode);
    const base = c ? c.from : null;                              // 前次基準日的在效版本
    const latest = c ? c.to : (cur ? cur.modifiedDate : null);   // 本次基準日的在效版本
    const abolished = cur && cur.abolished ? `<span class="badge abolished">已廢止</span>` : '';
    return `<tr class="${status === 'changed' ? 'changed' : ''}">
      <td>
        <span class="law-name" data-pcode="${l.pcode}" data-name="${esc(l.name)}">${esc(cur ? cur.name : l.name)}</span>${abolished}
        ${cur && cur.level ? `<div class="law-pcode">${esc(cur.level)}</div>` : ''}
      </td>
      <td class="date-cell">${base ? fmtDate(base) : '<span class="muted">—</span>'}</td>
      <td class="date-cell">${latest ? fmtDate(latest) : '<span class="muted">—</span>'}</td>
      <td>
        <span class="badge ${status}">${STATUS_LABEL[status]}</span>
        ${status === 'changed' ? `<button class="btn-link diff-link hot" data-act="diff" data-pcode="${l.pcode}" data-name="${esc(cur ? cur.name : l.name)}">新舊對照</button>` : ''}
      </td>
    </tr>`;
  }).join('');
  return `<table class="laws">
    <thead><tr><th>法規名稱</th><th>前次查核結果</th><th>本次查核結果</th><th>狀態</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
// 不在批次資料庫中的法規 → 需手動查核，獨立區塊置於最後。
// 純存檔：使用者手動查到該法「前次修正日期」後自填，不做異動比對、不標狀態。
function renderManualTable(g) {
  const list = g.watchlist.filter((l) => !l.current);
  if (!list.length) return '';
  const di = (d) => (d && String(d).length === 8) ? `${String(d).slice(0, 4)}-${String(d).slice(4, 6)}-${String(d).slice(6, 8)}` : '';
  const rows = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')).map((l) =>
    `<tr>
      <td>${esc(l.name)}</td>
      <td><input type="date" class="manual-date" data-mr-pcode="${esc(l.pcode)}" value="${di(l.manualDate)}"></td>
    </tr>`
  ).join('');
  return `<div class="manual-section">
    <h3>需手動查核 <span class="muted">（${list.length} 部）</span></h3>
    <p class="muted manual-hint">這些法規不在全國法規資料庫批次資料中，系統無法自動比對；請手動查詢後，把該法的「前次修正日期」填在右欄存檔（自動儲存，無須每次填，有更新再改即可）。</p>
    <table class="laws manual">
      <thead><tr><th>法規名稱</th><th>前次修正日期</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderHistory(g) {
  if (!g.history || !g.history.length) return '';
  const items = g.history.map((run, i) => {
    const changed = run.changes.filter((c) => c.kind === 'changed');
    const lines = changed.map((c) => `<div class="hist-change"><button class="btn-link" data-act="diff" data-pcode="${c.pcode}" data-name="${esc(c.name)}">${esc(c.name)}</button> <span class="muted">${ymdShort(c.from)}</span> <span class="arrow">→</span> ${ymdShort(c.to)}</div>`).join('')
      || `<div class="muted" style="padding:6px 0">本期間無異動。</div>`;
    const runTag = run.official === false ? '<span class="run-tag preview">試算</span>' : '<span class="run-tag official">例行</span>';
    const period = run.baseDate ? `${ymdShort(run.baseDate)} → ${ymdShort(run.cutoffDate)}` : `基準日 ${ymdShort(run.cutoffDate)}（首次）`;
    return `<div class="hist-item ${i === 0 ? 'open' : ''}" data-hist="${i}">
      <div class="hist-head" data-act="toggleHist">
        <span>${runTag} <b>${period}</b> · 執行 ${fmtTime(run.checkedAt)}</span>
        <span>${run.summary.changed > 0 ? `<span class="badge changed">${run.summary.changed} 部異動</span>` : `<span class="badge unchanged">無異動</span>`}</span>
      </div>
      <div class="hist-body">${lines}</div>
    </div>`;
  }).join('');
  return `<div class="history"><h3>查核歷史</h3>${items}</div>`;
}

// 法規搜尋已移至「編輯」視窗（見 wireModalSearch）；首頁不再有獨立搜尋框。

// ── 事件 ────────────────────────────────────────────
document.getElementById('groupList').addEventListener('click', (e) => {
  const li = e.target.closest('.group-item'); if (!li) return;
  state.selectedId = li.dataset.id; renderGroups(); renderDetail();});

document.getElementById('detail').addEventListener('click', async (e) => {
  const g = state.groups.find((x) => x.id === state.selectedId); if (!g) return;
  if (e.target.closest('#btnCheck')) return doCheck(g);
  const actEl = e.target.closest('[data-act]');   // 用 closest：點到按鈕/標題列內的文字(子元素)也能正確判讀，例如查核歷史展開
  const act = actEl ? actEl.dataset.act : null;
  if (act === 'editGroup') return groupModal(g);
  if (act === 'pause') return pauseGroup(g, true);
  if (act === 'resume') return pauseGroup(g, false);
  if (act === 'delGroup') return delGroup(g);
  if (act === 'diff') { const pc = actEl.dataset.pcode, nm = actEl.dataset.name; markReviewed(g, pc); return showDiff(pc, nm); }
  if (act === 'toggleHist') { actEl.closest('.hist-item').classList.toggle('open'); return; }
  const ln = e.target.closest('.law-name'); if (ln && ln.dataset.pcode) return showHistory(ln.dataset.pcode, ln.dataset.name);
});

// 手動查核法規的「前次修正日期」：失焦自動儲存
document.getElementById('detail').addEventListener('change', async (e) => {
  const inp = e.target.closest('.manual-date'); if (!inp) return;
  const g = state.groups.find((x) => x.id === state.selectedId); if (!g) return;
  const pcode = inp.dataset.mrPcode;
  try {
    await api(`/api/groups/${g.id}/laws/${encodeURIComponent(pcode)}`, { method: 'PATCH', body: { manualDate: inp.value } });
    const law = g.watchlist.find((l) => l.pcode === pcode); if (law) law.manualDate = inp.value.replace(/\D/g, '') || null;
    toast('已儲存前次修正日期');
  } catch (err) { toast(err.message, true); }
});

// 法規增刪：在「編輯」視窗內即時生效
async function addLawModal(g, pcode, name) {
  try {
    await api(`/api/groups/${g.id}/laws`, { method: 'POST', body: { pcode, name } });
    await load();
    renderModalLawList(state.groups.find((x) => x.id === g.id) || g);
    const inp = document.getElementById('mLawSearch'); if (inp) inp.value = '';
    const box = document.getElementById('mSearchResults'); if (box) { box.hidden = true; box.innerHTML = ''; }
    toast('已加入 ' + name);
  } catch (e) { toast(e.message, true); }
}
async function delLawModal(g, pcode) {
  if (!confirm('確定移除此法規？其查核基準會一併刪除。')) return;
  try {
    await api(`/api/groups/${g.id}/laws/${encodeURIComponent(pcode)}`, { method: 'DELETE' });
    await load();
    renderModalLawList(state.groups.find((x) => x.id === g.id) || g);
  } catch (e) { toast(e.message, true); }
}
// 加入「不在資料庫」的手動查核項目（自行追蹤、自填前次修正日期）
async function addManualLaw(g, name) {
  name = (name || '').trim(); if (!name) return;
  try {
    await api(`/api/groups/${g.id}/laws`, { method: 'POST', body: { name, manual: true } });
    await load();
    renderModalLawList(state.groups.find((x) => x.id === g.id) || g);
    const inp = document.getElementById('mLawSearch'); if (inp) inp.value = '';
    const box = document.getElementById('mSearchResults'); if (box) { box.hidden = true; box.innerHTML = ''; }
    toast('已加入手動查核項目：' + name);
  } catch (e) { toast(e.message, true); }
}
async function doCheck(g) {
  const btn = document.getElementById('btnCheck'); if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>查核中…（同步最新法規）'; }
  state.checking = true;
  try {
    const { run, periods, totalChanged, capped } = await api(`/api/groups/${g.id}/check`, { method: 'POST' });
    state.checking = false;
    await load();    if (run && run.official) {
      if (capped) toast(`已補做 ${periods} 期（達單次上限）；仍有更早期間未補，請再按一次「執行查核」`, true);
      else if (periods > 1) toast(`✓ 已補做 ${periods} 期至 ${ymdShort(run.cutoffDate)}，共 ${totalChanged} 部異動`);
      else toast(`✓ 已完成新一期查核：基準日更新為 ${ymdShort(run.cutoffDate)}（異動 ${run.summary.changed} 部）`);
    } else {
      toast(`試算完成（僅供參考，未更新基準日）${run && run.summary.changed > 0 ? '：' + run.summary.changed + ' 部有異動' : ''}`);
    }
  } catch (e) { state.checking = false; toast(e.message, true); if (btn) { btn.disabled = false; btn.textContent = '執行查核'; } }
}
async function pauseGroup(g, paused) {
  if (paused && !confirm(`停用任務「${g.name}」？\n將不再自動查核，但過往查核紀錄會完整保留；需要時可隨時「恢復查核」。`)) return;
  try {
    await api(`/api/groups/${g.id}`, { method: 'PATCH', body: { paused } });
    closeModal(); await load();    toast(paused ? '已停用此任務（紀錄保留）' : '已恢復查核');
  } catch (e) { toast(e.message, true); }
}
async function delGroup(g) {
  if (!confirm(`確定刪除任務「${g.name}」？此操作無法復原。`)) return;
  try { await api(`/api/groups/${g.id}`, { method: 'DELETE' }); closeModal(); state.selectedId = null; await load(); }
  catch (e) { toast(e.message, true); }
}

async function showHistory(pcode, name) {
  try {
    const data = await api(`/api/laws/${encodeURIComponent(pcode)}/history`);
    openModal(`<h3>${esc(data.name || name)} — 修法沿革</h3>
      <div class="hist-pre">${data.history ? esc(data.history) : '（目前資料庫查無此法規的沿革資料）'}</div>
      <div class="modal-actions"><button class="btn" data-close>關閉</button></div>`);
  } catch (e) { toast(e.message, true); }
}

// 看過新舊對照＝已閱：把該法目前這筆異動標記為已看過，側欄「有異動」隨之清除（日後若再有新修正會重新亮起）
async function markReviewed(g, pcode) {
  const c = lastChangeOf(g, pcode);
  if (!c || c.kind !== 'changed' || !c.to) return;
  const law = (g.watchlist || []).find((l) => l.pcode === pcode);
  if (!law || law.reviewedTo === c.to) return;
  law.reviewedTo = c.to;                 // 樂觀更新：立即更新任務列表（任務內仍照常顯示有異動）
  renderGroups();
  try { await api(`/api/groups/${g.id}/laws/${encodeURIComponent(pcode)}`, { method: 'PATCH', body: { reviewedTo: c.to } }); }
  catch (e) { /* 失敗靜默，下次載入會還原 */ }
}

// ── 新舊對照 ────────────────────────────────────────
async function showDiff(pcode, name) {
  openModal(`<h3>新舊對照 · ${esc(name || pcode)}</h3>
    <div id="diffBody" class="diff-body"><p class="muted"><span class="spinner"></span>讀取官方條文中…（首次查詢需向全國法規資料庫取得舊版，約數秒）</p></div>
    <div class="modal-actions">
      <a class="btn" href="/api/laws/${encodeURIComponent(pcode)}/diff.docx" target="_blank" rel="noopener">⤓ 匯出 Word 對照表</a>
      <button class="btn" data-close>關閉</button>
    </div>`, { wide: true });
  try {
    const d = await api(`/api/laws/${encodeURIComponent(pcode)}/diff`);
    const body = document.getElementById('diffBody');
    if (body) body.innerHTML = renderDiff(d);
  } catch (e) {
    const body = document.getElementById('diffBody');
    if (body) body.innerHTML = `<p class="muted">${esc(e.message)}</p><p style="margin-top:12px"><button class="btn" data-act="retryDiff" data-pcode="${esc(pcode)}" data-name="${esc(name || '')}">🔄 重試</button></p>`;
  }
}
function cnum(n) {
  const d = '〇一二三四五六七八九';
  if (n <= 10) return n === 10 ? '十' : d[n];
  if (n < 20) return '十' + (n > 10 ? d[n - 10] : '');
  if (n < 100) { const t = Math.floor(n / 10), o = n % 10; return d[t] + '十' + (o ? d[o] : ''); }
  return String(n);
}
// 字元級 LCS 差異 → ops（=相同 / +新增 / -刪除）
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  if (n + m > 6000) return [{ t: '-', s: a }, { t: '+', s: b }];   // 過長則不做字元級
  const dp = []; for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; const push = (t, s) => { const l = ops[ops.length - 1]; if (l && l.t === t) l.s += s; else ops.push({ t, s }); };
  let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { push('=', a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { push('-', a[i]); i++; } else { push('+', b[j]); j++; } }
  while (i < n) push('-', a[i++]);
  while (j < m) push('+', b[j++]);
  return ops;
}
// 款/目/子目 起始標記：這些不另給「項次」，視為該項的子項
function isSubMarker(line) {
  return /^[一二三四五六七八九十百千]+、/.test(line) || /^（[一二三四五六七八九十百千]+）/.test(line) || /^[0-9０-９]+[、.．]/.test(line);
}
// 依 ops 渲染單欄（new 留 =,+；old 留 =,-）；以「項」為單位標項次，款/目縮排不另編號，變動字以 <ins>/<del> 標示
function renderCol(ops, side) {
  const keep = side === 'new' ? '+' : '-', tag = side === 'new' ? 'ins' : 'del';
  const paras = [[]];
  for (const op of ops) {
    if (op.t !== '=' && op.t !== keep) continue;
    const cls = op.t === '=' ? '' : 'chg';
    const segs = op.s.split('\n');
    for (let k = 0; k < segs.length; k++) { if (k > 0) paras.push([]); if (segs[k]) paras[paras.length - 1].push([cls, segs[k]]); }
  }
  const real = paras.filter((p) => p.length);
  if (!real.length) return '';
  let itemNo = 0;
  return real.map((p) => {
    const sub = isSubMarker(p.map(([, s]) => s).join(''));
    const inner = p.map(([cls, s]) => cls === 'chg' ? `<${tag}>${esc(s)}</${tag}>` : esc(s)).join('');
    return `<div class="para${sub ? ' sub' : ''}"><span class="para-no">${sub ? '' : (++itemNo)}</span><span class="para-txt">${inner}</span></div>`;
  }).join('');
}
function diffArticleBlock(kind, no, oldT, newT, reasons) {
  const tag = kind === '修正' ? 'changed' : (kind === '新增' ? 'baseline' : 'missing');
  const ops = lcsDiff(oldT || '', newT || '');
  const newCol = renderCol(ops, 'new'), oldCol = renderCol(ops, 'old');
  const rsn = (reasons && reasons.length)
    ? `<div class="diff-reason"><span class="diff-reason-h">立法理由</span>${reasons.map((r) => `<div class="diff-reason-t">${esc(r).replace(/\n/g, '<br>')}</div>`).join('')}</div>` : '';
  return `<div class="diff-item">
    <div class="diff-no">第 ${esc(no)} 條 <span class="badge ${tag}">${kind}</span></div>
    ${newCol ? `<div class="diff-col diff-new"><span class="diff-tag">新</span><div class="diff-txt">${newCol}</div></div>` : ''}
    ${oldCol ? `<div class="diff-col diff-old"><span class="diff-tag">舊</span><div class="diff-txt">${oldCol}</div></div>` : ''}
    ${rsn}
  </div>`;
}
function renderDiff(d) {
  const links = (d.links || []).map((l) => `<a href="${l.url}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('');
  const amend = d.amend && (d.amend.date || d.amend.docNo || (d.amend.articlesMentioned || []).length)
    ? `<div class="diff-amend">沿革最新修正：${esc(d.amend.date || '')}${d.amend.docNo ? '　' + esc(d.amend.docNo) : ''}${(d.amend.articlesMentioned || []).length ? '　異動第 ' + esc(d.amend.articlesMentioned.join('、')) + ' 條' : ''}</div>`
    : '';
  const oldShown = /^\d{8}$/.test(String(d.oldDate || '')) ? fmtDate(d.oldDate).replace(/<[^>]+>/g, '') : (d.oldDate || '—');
  let head = `<div class="diff-head">
      <div class="diff-title"><b>${esc(d.name)}</b> <span class="badge ${d.level === '法律' ? 'baseline' : 'unchanged'}">${esc(d.level || '')}</span></div>
      <div class="diff-meta">新版 <b>${fmtDate(d.newDate).replace(/<[^>]+>/g, '')}</b>　↔　舊版 <b>${esc(oldShown)}</b>　·　異動 <b>${d.changedCount}</b> 條</div>
      ${amend}
      <div class="diff-src">條文以官方原文為準（新版：全國法規資料庫批次；舊版：${esc(d.oldSource || '')}）。理由／修正總說明請點官方原文：<div class="diff-links">${links}</div></div>
    </div>`;
  const summary = d.summarySource
    ? `<div class="diff-summary"><div class="diff-summary-h">修正總說明 <span class="muted">（來源：${esc(d.summarySource)}）</span>${d.summaryUrl ? ` · <a href="${esc(d.summaryUrl)}" target="_blank" rel="noopener">看公報原文 ↗</a>` : ''}</div><div class="diff-summary-txt">${esc(d.summaryNote)}</div></div>`
    : '';
  const RB = d.reasonsByArticle || {};
  const blocks = [
    ...d.modified.map((a) => diffArticleBlock('修正', a.no, a.old, a.new, RB[a.no])),
    ...d.added.map((a) => diffArticleBlock('新增', a.no, null, a.new, RB[a.no])),
    ...d.removed.map((a) => diffArticleBlock('刪除', a.no, a.old, null, RB[a.no])),
  ];
  if (d.reasonBill) head += `<div class="diff-src" style="margin-top:-8px">立法理由來源：立法院議案對照表（g0v 國會 API）· 議案 ${esc(d.reasonBill.name || d.reasonBill.no)}</div>`;
  if (d.reasonsStatus === 'failed') head += `<div class="reasons-notice err">⚠ 立法理由載入失敗（可能 API 限流）　<button class="btn-link" data-act="retryDiff" data-pcode="${esc(d.pcode)}" data-name="${esc(d.name)}">🔄 重試</button></div>`;
  else if (d.reasonsStatus === 'none') head += `<div class="reasons-notice muted">（本次修正查無對應立法理由，可點上方官方連結確認）</div>`;
  if (d.noPrior) return head + summary + `<p class="muted" style="margin-top:14px">查無前一版本：此法自制定公布後未經修正，或歷史版本早於民國 90 年（全國法規資料庫歷史法規起始）。如為近期初次納入，仍可點上方官方連結確認。</p>`;
  if (!blocks.length) return head + summary + `<p class="muted" style="margin-top:14px">這兩個版本的條文內容無實質差異。</p>`;
  return head + summary + `<div class="diff-list">${blocks.join('')}</div>`;
}

// ── 群組 modal ──────────────────────────────────────
function groupModal(g, fresh) {
  const isEdit = !!g;
  const di = (d) => (d && String(d).length === 8) ? `${String(d).slice(0, 4)}-${String(d).slice(4, 6)}-${String(d).slice(6, 8)}` : '';
  const lag = (isEdit && g.lagDays != null) ? g.lagDays : 3;
  openModal(`<h3>${isEdit ? (fresh ? '加入法規' : '編輯任務') : '新增任務'}</h3>
    <label>任務名稱（當事人 / 案件）</label>
    <input id="gName" value="${isEdit ? esc(g.name) : ''}">
    <label>前次查核基準日（可選）</label>
    <input id="gBaseDate" type="date" value="${isEdit ? di(g.baselineDate) : ''}">
    <p class="hint">填了才會與本次基準日比對、標示新舊異動；留空＝視為第一次查核，只建立基準、不標異動。</p>
    <label>下次查核基準日</label>
    <input id="gNextDate" type="date" value="${isEdit ? di(g.nextBaselineDate) : ''}">
    <p class="hint">以這一天的法規狀態作為本次查核資料基準。因法規上網有時間差，系統會在「基準日 + ${lag} 天」之上午 9:00 自動執行查核（例：基準日 5/31 → 6/3 上午 9:00）。</p>
    <label>查核頻率（每 N 個月，0 = 不定期）</label>
    <input id="gFreq" type="number" min="0" max="60" value="${isEdit ? (g.frequencyMonths || 0) : 6}">
    ${isEdit ? `
    <hr class="modal-sep">
    <label>追蹤法規 <span class="muted">（增刪即時生效）</span></label>
    <div class="addbar">
      <input id="mLawSearch" type="text" placeholder="加入法規：輸入名稱搜尋（如「公司法」「勞動基準法」）" autocomplete="off">
      <ul class="search-results" id="mSearchResults" hidden></ul>
    </div>
    <ul class="modal-law-list" id="mLawList"></ul>` : `<p class="hint">按下方「建立並加入法規」後，即可在同一視窗加入要追蹤的法規。</p>`}
    ${isEdit ? `
    <hr class="modal-sep">
    <div class="modal-danger">
      ${g.paused ? '' : `<button class="btn small" data-act="pause">停用此任務</button>`}
      <button class="btn small danger" data-act="delGroup">刪除此任務</button>
      <span class="muted modal-danger-hint">停用＝停止查核但保留紀錄</span>
    </div>` : ''}
    <div class="modal-actions">
      <button class="btn" data-close>${isEdit ? (fresh ? '完成' : '關閉') : '取消'}</button>
      <button class="btn primary" id="gSave">${isEdit ? '儲存設定' : '建立並加入法規'}</button>
    </div>`, { wide: isEdit });
  if (isEdit) { renderModalLawList(g); wireModalSearch(g); }
  document.getElementById('gSave').addEventListener('click', async () => {
    const body = {
      name: document.getElementById('gName').value.trim(),
      baselineDate: document.getElementById('gBaseDate').value || null,
      nextBaselineDate: document.getElementById('gNextDate').value || null,
      frequencyMonths: Number(document.getElementById('gFreq').value) || 0,
    };
    if (!body.name) { toast('請輸入名稱', true); return; }
    try {
      if (isEdit) { await api(`/api/groups/${g.id}`, { method: 'PATCH', body }); closeModal(); await load(); }
      else {
        const r = await api('/api/groups', { method: 'POST', body });
        state.selectedId = r.group.id;
        await load();
        groupModal(state.groups.find((x) => x.id === r.group.id), true);  // 同一視窗轉為「加入法規」
        toast('任務已建立，可在下方加入法規');
      }
    } catch (e) { toast(e.message, true); }
  });
}
function renderModalLawList(g) {
  const host = document.getElementById('mLawList'); if (!host || !g) return;
  if (!g.watchlist.length) { host.innerHTML = `<li class="muted mll-empty">尚未加入任何法規。</li>`; return; }
  host.innerHTML = g.watchlist.slice()
    .sort((a, b) => (Number(!!b.current) - Number(!!a.current)) || a.name.localeCompare(b.name, 'zh-Hant'))
    .map((l) => `<li class="mll-item">
      <span class="mll-name">${esc(l.current ? l.current.name : l.name)}${l.current ? (l.current.level ? ` <span class="muted">· ${esc(l.current.level)}</span>` : '') : ' <span class="badge missing">應手動查詢</span>'}</span>
      <button class="btn-link mll-del" data-mremove="${esc(l.pcode)}">移除</button>
    </li>`).join('');
}
function wireModalSearch(g) {
  const input = document.getElementById('mLawSearch'); const box = document.getElementById('mSearchResults');
  if (!input) return;
  const manualOpt = (q) => `<li class="add-manual" data-add-manual="${esc(q)}">＋ 以「${esc(q)}」新增為手動查核項目 <span class="muted">（不在資料庫、系統不自動比對）</span></li>`;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer); const q = input.value.trim();
    if (!q) { box.hidden = true; box.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      try {
        const { results } = await api('/api/laws/search?q=' + encodeURIComponent(q));
        const hits = results.map((r) => `<li data-mpcode="${esc(r.pcode)}" data-mname="${esc(r.name)}">
          <span class="sr-name">${esc(r.name)}${r.abolished ? ' <span class="badge abolished">廢</span>' : ''}</span></li>`).join('');
        box.innerHTML = (hits || `<li class="muted">查無相符法規</li>`) + manualOpt(q);
        box.hidden = false;
      } catch (e) { toast(e.message, true); }
    }, 220);
  });
  input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 180));
}

// ── 頂部按鈕 ────────────────────────────────────────
document.getElementById('btnNewGroup').addEventListener('click', () => groupModal(null));
// 資料同步狀態：點「重試/更新」→ 重新下載最新法規庫
document.getElementById('syncStatus').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-act="resync"]')) return;
  document.getElementById('syncStatus').innerHTML = `<span class="sync"><span class="spinner"></span>資料同步中…</span>`;
  try { await api('/api/db/refresh', { method: 'POST' }); await load(); toast('資料已更新'); }
  catch (err) { await load(); toast('同步失敗：' + (err.message || ''), true); }
});

// ── Modal 基礎 ──────────────────────────────────────
function openModal(html, opts) { const o = document.getElementById('overlay'); const m = document.getElementById('modal'); m.className = 'modal' + (opts && opts.wide ? ' modal-wide' : ''); m.innerHTML = html; o.hidden = false; }
function closeModal() { document.getElementById('overlay').hidden = true; }
document.getElementById('overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay' || e.target.hasAttribute('data-close')) closeModal(); });
// 編輯視窗內的法規增刪（加入搜尋結果 / 移除）
document.getElementById('modal').addEventListener('click', (e) => {
  const retry = e.target.closest('[data-act="retryDiff"]');   // 新舊對照 / 立法理由 重試
  if (retry) return showDiff(retry.dataset.pcode, retry.dataset.name);
  const add = e.target.closest('[data-mpcode]');
  const rm = e.target.closest('[data-mremove]');
  const man = e.target.closest('[data-add-manual]');
  const act = e.target.closest('[data-act]')?.dataset.act;   // 編輯視窗內的「停用 / 刪除」
  if (!add && !rm && !man && !act) return;
  const g = state.groups.find((x) => x.id === state.selectedId); if (!g) return;
  if (add) return addLawModal(g, add.dataset.mpcode, add.dataset.mname);
  if (man) return addManualLaw(g, man.dataset.addManual);
  if (rm) return delLawModal(g, rm.dataset.mremove);
  if (act === 'pause') return pauseGroup(g, true);
  if (act === 'delGroup') return delGroup(g);
});

// ── 自動查核（開啟系統時）＋ 防中斷 ──────────────────
function setChecking(on, msg) {
  state.checking = on;
  const ov = document.getElementById('checkingOverlay');
  if (!ov) return;
  ov.hidden = !on;
  if (on && msg) { const t = ov.querySelector('.co-msg'); if (t) t.textContent = msg; }
}
async function autoCheckOnOpen() {
  if (!state.groups.some((g) => g.autoDue)) return;   // 沒有到期任務就不打擾
  setChecking(true, '正在自動執行到期查核…請勿關閉視窗');
  try {
    const { ran, capped } = await api('/api/auto-check', { method: 'POST' });
    setChecking(false);
    await load();    const overCap = capped && capped.length;
    if (ran.length) {
      const changed = ran.reduce((s, r) => s + r.summary.changed, 0);
      const groups = new Set(ran.map((r) => r.groupId)).size;
      const more = overCap ? '；部分任務仍積壓（超過單次 24 期上限），請再開啟一次繼續補做' : '';
      toast(`✓ 已完成 ${ran.length} 期新查核（${groups} 個任務）：共 ${changed} 部有異動${more}`, !!overCap);
    } else if (overCap) {
      toast(`部分任務積壓超過 24 期上限，請再開啟一次繼續補做：${capped.join('、')}`, true);
    }
  } catch (e) { setChecking(false); toast('自動查核失敗，可手動再試：' + e.message, true); }
}
// 查核進行中時，攔截關閉／重整，避免中斷（即使被關，後端仍會完成、下次開啟也會自動補做）
window.addEventListener('beforeunload', (e) => {
  if (state.checking) { e.preventDefault(); e.returnValue = '查核進行中，關閉視窗可能中斷，確定離開嗎？'; return e.returnValue; }
});

// ── 啟動 ────────────────────────────────────────────
load().then(async () => { await autoCheckOnOpen(); }).catch((e) => toast('載入失敗：' + e.message, true));
