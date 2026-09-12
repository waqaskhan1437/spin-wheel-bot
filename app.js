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
  const { owner, repo } = settings();
  const res = await fetch(
    `https://raw.githubusercontent.com/${owner}/${repo}/main/${file}?v=${Date.now()}`
  );
  if (!res.ok) throw new Error(`raw ${file}: ${res.status}`);
  return res.json();
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

  const tab = document.querySelector('.tab.active').dataset.tab;
  renderTable(history, tab);

  if (history.length > 0) lastRun.value = history[history.length - 1].runId || '';
}

function renderTable(history, tab) {
  const rows = history.slice(-100).reverse().filter(x => {
    if (tab === 'ok') return x.status === 'ok';
    if (tab === 'fail') return x.status === 'fail';
    return true;
  });

  const tbody = $('#tbody');
  tbody.innerHTML = '';

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
setInterval(refresh, 5000);