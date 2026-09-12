'use strict';

const LS = {
  owner: 'spin:owner',
  repo: 'spin:repo',
  token: 'spin:token',
  numbers: 'spin:numbers',
  runId: 'spin:runId',
};

const $ = sel => document.querySelector(sel);

function settings() {
  const owner = localStorage.getItem(LS.owner) || 'waqaskhan1437';
  const repo = localStorage.getItem(LS.repo) || 'spin-wheel-bot';
  const token = localStorage.getItem(LS.token) || '';
  return { owner, repo, token };
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

let msgTimer = null;
function setMsg(text, kind) {
  const el = $('#msg');
  if (msgTimer) clearTimeout(msgTimer);
  el.textContent = text;
  el.className = 'msg ' + (kind || 'info');
  msgTimer = setTimeout(() => { el.className = 'msg hidden'; }, kind === 'err' ? 8000 : 4000);
}

function parseNumbers() {
  return $('#numbersInput').value
    .split(/[\n,;\s]+/)
    .map(s => s.trim())
    .filter(s => /^03\d{9}$/.test(s));
}

async function github(pathname, method = 'GET', body = null) {
  const { owner, repo, token } = settings();
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${pathname}`, {
    method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchRaw(file) {
  const cfg = settings();
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;
  try {
    const api = await fetch(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${file}?v=${Date.now()}`,
      { headers, cache: 'no-store' }
    );
    if (api.ok) {
      const j = await api.json();
      if (j && j.content) return JSON.parse(utf8FromB64(j.content));
    }
  } catch (_) {}
  throw new Error(`file ${file} not available`);
}

function utf8FromB64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function fetchRawSafe(file) {
  try { return await fetchRaw(file); } catch (_) { return null; }
}

async function putPending(content, message) {
  let sha = null;
  try {
    const meta = await github('/contents/pending.json');
    sha = meta.sha;
  } catch (_) {}
  await github('/contents/pending.json', 'PUT', {
    message,
    content: toBase64(content),
    sha: sha || undefined,
  });
}

function moneyValue(reward) {
  if (!reward) return 0;
  const m = String(reward).match(/[\d,.]+/);
  if (!m) return 0;
  return parseFloat(m[0].replace(/,/g, '')) || 0;
}

function setStatus(state) {
  const pill = $('#statusPill');
  pill.className = 'status-pill ' + state;
  pill.textContent = state;
}

function render(results, pending, lastRun) {
  const history = (results && Array.isArray(results.history) && results.history) || [];
  const queue = (pending && Array.isArray(pending.numbers) && pending.numbers.length) || 0;
  const ok = history.filter(x => x.status === 'ok').length;
  const fail = history.filter(x => x.status === 'fail').length;
  const cash = history.reduce((s, x) => s + moneyValue(x.reward), 0);

  $('#statTotal').textContent = history.length;
  $('#statOk').textContent = ok;
  $('#statFail').textContent = fail;
  $('#statCash').textContent = 'PKR ' + cash.toLocaleString('en-PK');
  $('#statQueue').textContent = queue;
  $('#lastRun').textContent = 'Current run: ' + (results && results.runId ? results.runId : '—') +
    ' · State: ' + (results && results.state ? results.state : '—');

  if (results && results.state === 'running') setStatus('running');
  else if (results && results.state === 'done') setStatus('done');
  else if (results && results.state === 'error') setStatus('error');
  else setStatus('idle');

  const total = (results && results.runTotal) || 0;
  const done = (results && results.runDone) || 0;
  const fill = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
  $('#progressFill').style.width = fill + '%';
  $('#progressLbl').textContent = total > 0
    ? `Progress: ${done} / ${total} ho gaye (${fill}%) — ${total - done} baqi`
    : 'Progress: 0 / 0';

  const btn = $('#btnStart');
  if (results && results.state === 'running') {
    btn.disabled = true;
    btn.textContent = 'Run Chalu Hai...';
  } else {
    btn.disabled = false;
    btn.textContent = 'Start Bot';
  }

  const tab = document.querySelector('.tab.active').dataset.tab;
  renderTable(history, tab);

  if (lastRun && history.length > 0) lastRun.value = history[history.length - 1].runId || '';
}

function renderTable(history, tab) {
  const rows = history.slice(-100).reverse().filter(x => {
    if (tab === 'ok') return x.status === 'ok';
    if (tab === 'fail') return x.status === 'fail';
    return true;
  });

  const tbody = $('#tbody');
  tbody.innerHTML = '';
  tbody.dataset.raw = JSON.stringify(history);

  if (!rows.length) {
    $('#empty').classList.remove('hidden');
    return;
  }
  $('#empty').classList.add('hidden');

  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    const okState = r.status === 'ok';
    tr.innerHTML =
      `<td class="no">${i + 1}</td>` +
      `<td class="no">${r.no || '—'}</td>` +
      `<td><span class="badge ${okState ? 'ok' : 'fail'}">${okState ? 'OK' : 'FAIL'}</span></td>` +
      `<td class="no">${r.reward || '—'}</td>` +
      `<td class="reason">${okState ? '' : (esc(r.reason) || '—')}</td>` +
      `<td class="no">${fmtTime(r.at)}</td>`;
    tbody.appendChild(tr);
  });
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { hour12: false }) + ' ' + new Date(iso).toLocaleDateString('en-GB');
  } catch (_) { return '—'; }
}

async function refresh() {
  const cfg = settings();
  if (!cfg.owner || !cfg.repo) return;
  let results = null;
  let pending = null;
  let lastRun = null;
  try { results = await fetchRaw('results.json'); } catch (_) {}
  try { pending = await fetchRaw('pending.json'); } catch (_) {}
  try { lastRun = await fetchRaw('last-run.json'); } catch (_) {}
  render(results, pending, lastRun);
}

async function start(numbers, label) {
  const cfg = settings();
  if (!cfg.token) { setMsg('Settings mein GitHub token daalo pehle.', 'err'); openSettings(); return; }
  const results = await fetchRawSafe('results.json');
  if (results && results.state === 'running') {
    setMsg('Ek run pehle se chalu hai. Khatam hone ka wait karo.', 'err');
    return;
  }
  const nums = numbers || parseNumbers();
  if (!nums.length) { setMsg('Koi valid 11-digit number nahi mila.', 'err'); return; }
  const runId = label || ('job-' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 17));
  const content = JSON.stringify({ runId, createdAt: new Date().toISOString(), numbers: nums }, null, 2);

  setMsg('pending.json update + worker trigger ho raha hai...', 'info');
  const btn = $('#btnStart');
  btn.disabled = true;
  try {
    await putPending(content, 'queue ' + nums.length + ' numbers [' + runId + ']');
    localStorage.setItem(LS.runId, runId);
    setMsg('DONE: ' + nums.length + ' numbers queue mein. Worker ~30 sec mein start hoga.', 'ok');
  } catch (e) {
    setMsg('Error: ' + e.message + ' (token/owner/repo check karo)', 'err');
  } finally {
    btn.disabled = false;
  }
}

function failedRuns() {
  const cfg = settings();
  const runId = localStorage.getItem(LS.runId) || '';
  return { runId, history: [] };
}

function downloadPdf(kind) {
  const { owner, repo } = settings();
  const tbody = $('#tbody');
  const status = kind === 'ok' ? 'SUCCESS' : 'FAILED';
  let items;
  try {
    const rows = JSON.parse(tbody.dataset.raw || '[]');
    items = rows.filter(r => r.status === (kind === 'ok' ? 'ok' : 'fail'));
  } catch (_) { items = []; }
  if (!items.length) { setMsg('PDF ke liye koi ' + status + ' record nahi.', 'err'); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFontSize(16);
  doc.setTextColor(243, 128, 31);
  doc.text('Spin Wheel Bot - ' + status + ' Record', 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(130);
  doc.text('Repo: ' + owner + '/' + repo + '   |   Generated: ' + new Date().toLocaleString(), 40, 56);

  doc.autoTable({
    startY: 72,
    head: [['#', 'Number', 'Reward', 'Reason', 'Time']],
    body: items.map((r, i) => [
      String(i + 1),
      r.no || '-',
      r.reward || '-',
      (kind === 'ok' ? '-' : (r.reason || '-')),
      fmtTime(r.at),
    ]),
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: [243, 128, 31], textColor: [255, 255, 255] },
    alternateRowStyles: { fillColor: [22, 27, 34] },
  });

  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(130);
    doc.text('Page ' + i + ' / ' + total, pageWidth - 40, doc.internal.pageSize.getHeight() - 20, { align: 'right' });
  }

  const fname = 'spin-' + kind + '-records-' + new Date().toISOString().slice(0, 10) + '.pdf';
  doc.save(fname);
  setMsg(status + ' PDF download hui: ' + fname + ' (' + items.length + ' entries)', 'ok');
}

async function retry() {
  const cfg = settings();
  if (!cfg.token) { setMsg('Settings mein token daalo.', 'err'); openSettings(); return; }
  let results = null;
  try { results = await fetchRaw('results.json'); } catch (_) {}
  const history = (results && results.history) || [];
  const curRun = (results && results.runId) || localStorage.getItem(LS.runId) || '';
  const failed = history
    .filter(x => x.status === 'fail' && (x.runId === curRun))
    .map(x => x.no);
  if (!failed.length) { setMsg('Is run mein koi failed number nahi.', 'err'); return; }
  setMsg('Retrying ' + failed.length + ' failed numbers...', 'info');
  await start(failed, 'retry-' + Date.now());
}

async function clearRecords(kind, confirmText) {
  const cfg = settings();
  if (!cfg.token) { setMsg('Settings mein token daalo.', 'err'); openSettings(); return; }
  if (!confirm(confirmText)) return;
  const results = await fetchRawSafe('results.json');
  if (!results || !Array.isArray(results.history)) { setMsg('results.json null hai, clear nahi hua.', 'err'); return; }
  const before = results.history.length;
  const keep = results.history.filter(x => x.status !== kind);
  if (keep.length === before) { setMsg('Is type ka koi record nahi.', 'info'); return; }

  const updated = { ...results, history: keep, updatedAt: new Date().toISOString() };
  let sha = null;
  try { sha = (await github('/contents/results.json')).sha; } catch (_) {}
  await github('/contents/results.json', 'PUT', {
    message: 'clear ' + kind + ' records (' + (before - keep.length) + ')',
    content: toBase64(JSON.stringify(updated, null, 2)),
    sha: sha || undefined,
  });
  setMsg((kind === 'ok' ? 'Success' : 'Failed') + ' records clear: ' + (before - keep.length) + ' hataye, ' + keep.length + ' rahe.', 'ok');
  refresh();
}

function clearNumbersInput() {
  $('#numbersInput').value = '';
  localStorage.removeItem(LS.numbers);
  setMsg('Numbers box clear ho gaya.', 'ok');
}

function openSettings() {
  const { owner, repo, token } = settings();
  $('#setOwner').value = owner;
  $('#setRepo').value = repo;
  $('#setToken').value = token;
  $('#settingsModal').classList.remove('hidden');
}

function closeSettings() {
  $('#settingsModal').classList.add('hidden');
}

function loadNumbers() {
  const saved = localStorage.getItem(LS.numbers);
  if (saved) $('#numbersInput').value = saved;
}

function autoOpenSettingsIfMissing() {
  const cfg = settings();
  if (!cfg.token) openSettings();
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      refresh();
    });
  });
}

function bind() {
  $('#btnStart').addEventListener('click', async () => {
    const nums = parseNumbers();
    if (nums.length) localStorage.setItem(LS.numbers, nums.join('\n'));
    await start(nums);
  });
  $('#btnSave').addEventListener('click', () => {
    localStorage.setItem(LS.numbers, $('#numbersInput').value);
    setMsg('Numbers save ho gaye in this browser.', 'ok');
  });
  $('#btnRetry').addEventListener('click', retry);
  $('#btnPdfFail').addEventListener('click', () => downloadPdf('fail'));
  $('#btnPdfOk').addEventListener('click', () => downloadPdf('ok'));
  $('#btnClearFail').addEventListener('click', () => clearRecords('fail', 'Failed (FAIL) records sab delete kar dein? results.json update hoga.'));
  $('#btnClearOk').addEventListener('click', () => clearRecords('ok', 'Success (OK) records sab delete kar dein? results.json update hoga.'));
  $('#btnClearNumbers').addEventListener('click', clearNumbersInput);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#settingsModal').addEventListener('click', e => {
    if (e.target === $('#settingsModal')) closeSettings();
  });
  $('#btnSaveSettings').addEventListener('click', () => {
    localStorage.setItem(LS.owner, $('#setOwner').value.trim());
    localStorage.setItem(LS.repo, $('#setRepo').value.trim());
    localStorage.setItem(LS.token, $('#setToken').value.trim());
    closeSettings();
    setMsg('Settings saved.', 'ok');
    refresh();
  });
  $('#btnClearLocal').addEventListener('click', () => {
    Object.values(LS).forEach(k => localStorage.removeItem(k));
    location.reload();
  });
  bindTabs();
}

bind();
loadNumbers();
autoOpenSettingsIfMissing();
refresh();
setInterval(refresh, 3000);