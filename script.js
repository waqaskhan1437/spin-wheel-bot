'use strict';

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

const ROOT = __dirname;
const OUTPUT_DIR = path.join(ROOT, 'output');
const RESULTS_FILE = 'results.json';

const TARGET_URL = process.env.TARGET_URL || 'https://my.ptcl.net.pk/SpinTheWheel/Default.aspx';
const PARALLEL = Math.max(1, parseInt(process.env.PARALLEL || '2', 10));
const MAX_CAPTCHA_ATTEMPTS = parseInt(process.env.MAX_CAPTCHA_ATTEMPTS || '6', 10);
const MIN_DELAY_MS = parseInt(process.env.MIN_DELAY_MS || '500', 10);
const MAX_DELAY_MS = parseInt(process.env.MAX_DELAY_MS || '1200', 10);
const COMMIT_EVERY = Math.max(1, parseInt(process.env.COMMIT_EVERY || '1', 10));
const JOB_TIMEOUT_MIN = parseInt(process.env.JOB_TIMEOUT_MIN || '45', 10);
const MAX_PAGE_WAIT_MS = parseInt(process.env.MAX_PAGE_WAIT_MS || '60000', 10);
const PROTOCOL_TIMEOUT_MS = parseInt(process.env.PROTOCOL_TIMEOUT_MS || '180000', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

function waitForDialog(page, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { page.off('dialog', handler); resolve(null); }
    }, timeoutMs);
    function handler(d) {
      done = true;
      clearTimeout(timer);
      const msg = (d.message() || '').trim();
      d.accept().then(() => page.off('dialog', handler)).catch(() => page.off('dialog', handler));
      resolve(msg);
    }
    page.on('dialog', handler);
  });
}

function readJSON(file, fallback) {
  try {
    let raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  }
  catch (_) { return fallback; }
}
function writeJSON(file, obj) {
  fs.writeFileSync(path.join(ROOT, file), JSON.stringify(obj, null, 2));
}

function configureGitAuth() {
  const token = process.env.GH_PAT || process.env.GITHUB_TOKEN;
  if (token) {
    const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
    execSync(
      'git config --local http.https://github.com/.extraheader "AUTHORIZATION: basic ' + b64 + '"',
      { cwd: ROOT, stdio: 'ignore' }
    );
    console.log('[git] push auth configured');
  } else {
    console.log('[git] WARNING: no token available, push will fail');
  }
}

function pushWithRetry(attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      execSync('git pull --rebase origin main', { cwd: ROOT, stdio: 'ignore' });
      execSync('git push origin HEAD:main', { cwd: ROOT, stdio: 'ignore' });
      return;
    } catch (_) {
      console.log(`[push] attempt ${i + 1} failed, retrying...`);
      sleep(2000);
    }
  }
  throw new Error('push failed after retries');
}

let publishChain = Promise.resolve();
function publish(message) {
  publishChain = publishChain.then(() => {
    try {
      execSync('git add -A', { cwd: ROOT, stdio: 'ignore' });
      execSync(
        `git -c user.name="spin-bot" -c user.email="spin-bot@users.noreply.github.com" commit -m ${JSON.stringify(message)}`,
        { cwd: ROOT, stdio: 'ignore' }
      );
      pushWithRetry();
      console.log(`[git] committed: ${message}`);
    } catch (_) {
      console.log('[git] nothing to commit');
    }
  }).catch(e => console.log('[publish] error:', e.message.slice(0, 120)));
  return publishChain;
}

let tess = null;
async function getTesseract() {
  if (tess) return tess;
  console.log('[ocr] initializing tesseract...');
  tess = await createWorker('eng', 1, { logger: () => {} });
  try {
    await tess.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
  } catch (_) {}
  console.log('[ocr] ready');
  return tess;
}

async function solveCaptcha(page) {
  try {
    await page.waitForFunction(
      () => {
        const i = document.getElementById('imgCaptcha');
        return i && i.complete && i.naturalWidth > 0;
      },
      { timeout: 20000, polling: 50 }
    );
  } catch (_) {
    return '';
  }
  const img = await page.$('#imgCaptcha');
  if (!img) return '';
  const raw = await img.screenshot();

  const worker = await getTesseract();
  let text = '';

  const variants = [
    buf => sharp(buf).resize({ width: 500 }).grayscale().normalize().threshold(140).negate().png().toBuffer(),
    buf => sharp(buf).resize({ width: 500 }).grayscale().normalize().sharpen().png().toBuffer(),
    buf => sharp(buf).resize({ width: 700 }).grayscale().normalize().png().toBuffer(),
  ];

  for (const v of variants) {
    try {
      const buf = await v(raw);
      const { data } = await worker.recognize(buf);
      text = (data.text || '').replace(/[^0-9]/g, '');
      if (text.length >= 3) break;
    } catch (_) {}
  }
  return text;
}

async function fill(page, sel, value) {
  await page.$eval(sel, (el, v) => {
    el.focus();
    el.value = '';
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

function extractMoney(text) {
  if (!text) return '';
  const m = text.match(/(?:PKR|Rs\.?|RS\.?|₨)\s*[:@]?\s*([0-9][0-9,.]*)/i);
  if (m) return `PKR ${m[1]}`;
  const m2 = text.match(/([0-9][0-9,.]*)\s*(?:PKR|rupees)/i);
  if (m2) return `PKR ${m2[1]}`;
  return '';
}

function classifyReason(low, full) {
  if (low.includes('invalid') || /not a valid/.test(low) || low.includes('wrong number')) return 'invalid-number';
  if (low.includes('already') || low.includes('participat') || low.includes('taken') || low.includes('used')) return 'already-used';
  if (low.includes('captcha')) return 'captcha-error';
  if (low.includes('not eligible') || low.includes('not found') || low.includes('does not exist')) return 'not-connected-to-upaisa';
  if (/network|server|timeout|connection|unavailable/i.test(low)) return 'network-error';
  return full.slice(0, 100) || 'unknown-error';
}

async function extractMoneyFromPage(page, number, started) {
  let reward = '';
  let bodyText = '';
  try {
    bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  } catch (_) {}
  reward = extractMoney(bodyText);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(OUTPUT_DIR, `${number}.png`), type: 'png' }).catch(() => {});
  return { no: number, status: 'ok', reason: '', reward, at: now(), ms: Date.now() - started };
}

async function attemptSpin(page, number, runId, started) {
  let reward = '';

  // Arm all event promises BEFORE triggering so nothing can be missed.
  const dialogP = waitForDialog(page, 30000);
  const respP = page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().includes('SpinTheWheel'),
    { timeout: MAX_PAGE_WAIT_MS }
  ).catch(() => null);

  const spinPressed = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('#btnSpin, button, input[type="submit"], a, .btn'));
    const el = els.find(e => /spin/i.test((e.id || '') + ' ' + (e.value || '') + ' ' + (e.innerText || '')));
    if (el) { el.click(); return true; }
    return false;
  });

  if (spinPressed) {
    console.log(`[spin] ${number}: spin button pressed`);
    const res = await respP;
    if (res) console.log(`[nav] ${number}: spin response received (${res.status()})`);
    const msg = await dialogP;
    if (msg) {
      reward = extractMoney(msg);
      console.log(`[spin] ${number}: got dialog "${msg.slice(0, 90)}"`);
    }
  }

  try {
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (!reward) reward = extractMoney(bodyText);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(OUTPUT_DIR, `${number}.png`), type: 'png' }).catch(() => {});
    return { no: number, status: 'ok', reason: '', reward, at: now(), ms: Date.now() - started, runId };
  } catch (_) {
    return { no: number, status: 'ok', reason: '', reward, at: now(), ms: Date.now() - started, runId };
  }
}

async function spinOnce(page, number, runId) {
  const started = Date.now();
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_CAPTCHA_ATTEMPTS; attempt++) {
    try {
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: MAX_PAGE_WAIT_MS });
      await page.waitForFunction(
        () => {
          const i = document.getElementById('imgCaptcha');
          const m = document.getElementById('txtMobile');
          return m && i && i.complete && i.naturalWidth > 0;
        },
        { timeout: MAX_PAGE_WAIT_MS, polling: 50 }
      );
    } catch (_) {
      return { no: number, status: 'fail', reason: 'page-load-failed', reward: '', at: now(), ms: Date.now() - started, runId };
    }

    await fill(page, '#txtMobile', number);

    const captcha = await solveCaptcha(page);
    if (!captcha) {
      lastError = 'captcha-unreadable';
      console.log(`[cap] ${number} attempt ${attempt}: unreadable`);
      continue;
    }
    await fill(page, '#txtCaptcha', captcha);
    console.log(`[cap] ${number} attempt ${attempt}: "${captcha}"`);

    await page.evaluate(() => {
      const c = document.getElementById('chkTerms');
      if (c) c.checked = true;
    });

    // Fire-and-wait: response event resolves the instant the server answers the postback.
    const respP = page.waitForResponse(
      r => r.request().method() === 'POST' && r.url().includes('SpinTheWheel'),
      { timeout: MAX_PAGE_WAIT_MS }
    ).catch(() => null);

    let errorText = '';
    try {
      await Promise.all([
        respP,
        page.click('#btnNext'),
      ]);
    } catch (_) {
      lastError = 'submit-error';
      continue;
    }

    const submitted = await respP;
    if (submitted) console.log(`[nav] ${number} attempt ${attempt}: server responded (${submitted.status()})`);

    try {
      await page.waitForFunction(
        () => {
          const err = document.getElementById('lblError');
          if (err && err.innerText && err.innerText.trim()) return true;
          return Array.from(document.querySelectorAll('#btnSpin, button, input[type="submit"], a, .btn'))
            .some(e => /spin/i.test((e.id || '') + ' ' + (e.value || '') + ' ' + (e.innerText || '')));
        },
        { timeout: MAX_PAGE_WAIT_MS, polling: 50 }
      );
    } catch (_) {}

    errorText = await page.evaluate(() => {
      const el = document.getElementById('lblError');
      return ((el && el.innerText) || '').trim();
    }).catch(() => '');

    if (errorText) {
      lastError = errorText.slice(0, 160);
      const low = errorText.toLowerCase();
      console.log(`[err] ${number}: ${errorText.slice(0, 80)}`);
      if (low.includes('captcha')) continue;
      return { no: number, status: 'fail', reason: classifyReason(low, errorText), reward: '', at: now(), ms: Date.now() - started, runId };
    }

    return await attemptSpin(page, number, runId, started);
  }

  return { no: number, status: 'fail', reason: 'captcha-exhausted', reward: '', at: now(), ms: Date.now() - started, runId };
}

async function main() {
  const pending = readJSON('pending.json', { numbers: [] });
  const rawNumbers = Array.isArray(pending.numbers) ? pending.numbers : [];
  let numbers = [...new Set(rawNumbers.map(String))].filter(n => /^03\d{9}$/.test(n));

  let results = readJSON(RESULTS_FILE, { history: [] });
  if (!Array.isArray(results.history)) results.history = [];

  const done = new Set(
    results.history
      .filter(x => x.status === 'ok' || x.reason === 'already-used')
      .map(x => x.no)
  );
  const before = numbers.length;
  numbers = numbers.filter(n => !done.has(n));
  if (before !== numbers.length) {
    console.log(`[dedupe] skipped ${before - numbers.length} already-processed numbers`);
  }

  if (numbers.length === 0) {
    console.log('[skip] no pending numbers');
    return;
  }
  const runId = (pending.runId && String(pending.runId)) || `job-${Date.now()}`;

  configureGitAuth();
  results = { ...results, runId, state: 'running', runTotal: numbers.length, runDone: 0, startedAt: now(), updatedAt: now() };
  writeJSON(RESULTS_FILE, results);
  await publish(`start: ${runId} (${numbers.length} numbers)`);

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const resultsAcc = [...results.history];
  const seen = new Set();
  let idx = 0;
  const deadline = Date.now() + JOB_TIMEOUT_MIN * 60000;

  const runner = async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(MAX_PAGE_WAIT_MS);
    page.on('dialog', d => {
      const msg = (d.message() || '').trim();
      page.evaluate(m => { window.__lastDialog = m; }, msg).catch(() => {});
      d.dismiss().catch(() => {});
    });
    await page.evaluateOnNewDocument(() => { window.__lastDialog = ''; });
    while (true) {
      const myIdx = idx++;
      if (myIdx >= numbers.length) break;
      if (Date.now() > deadline) { resultsAcc.push({ no: numbers[myIdx], status: 'fail', reason: 'job-timeout', reward: '', at: now(), runId }); continue; }

      const processStart = Date.now();
      let res;
      try {
        res = await spinOnce(page, numbers[myIdx], runId);
        if (res.status === 'fail' && /callFunctionOn timed out/i.test(res.reason)) {
          console.log(`[retry] ${numbers[myIdx]}: transient timeout, trying once more`);
          try { await page.goto('about:blank', { timeout: 15000 }).catch(() => {}); } catch (_) {}
          res = await spinOnce(page, numbers[myIdx], runId);
          res.ms = Date.now() - processStart;
        }
      } catch (e) {
        res = { no: numbers[myIdx], status: 'fail', reason: 'exception-' + e.message.slice(0, 60), reward: '', at: now(), ms: Date.now() - processStart, runId };
      }
      resultsAcc.push(res);
      seen.add(numbers[myIdx]);
      console.log(`[done] ${res.no} -> ${res.status}${res.reward ? ' (' + res.reward + ')' : ''}`);

      if (seen.size % COMMIT_EVERY === 0) {
        const tmp = { ...results, history: resultsAcc, runDone: seen.size, updatedAt: now() };
        writeJSON(RESULTS_FILE, tmp);
        await publish(`progress: ${seen.size}/${numbers.length}`);
      }
      await sleep(MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS)));
    }
    await page.close().catch(() => {});
  };

  const workers = Array.from({ length: PARALLEL }, () => runner());
  await Promise.all(workers.filter(w => w));

  await browser.close().catch(() => {});

  const remaining = numbers.filter(n => !seen.has(n));
  for (const n of remaining) {
    if (!resultsAcc.find(x => x.no === n)) {
      resultsAcc.push({ no: n, status: 'fail', reason: 'skipped-timeout', reward: '', at: now(), runId });
    }
  }

  const ok = resultsAcc.filter(x => x.status === 'ok').length;
  const fail = resultsAcc.filter(x => x.status === 'fail').length;
  const final = { ...results, history: resultsAcc, state: 'done', runDone: numbers.length, runTotal: numbers.length, doneAt: now(), updatedAt: now() };
  writeJSON(RESULTS_FILE, final);
  try { writeJSON('pending.json', { runId: '', createdAt: '', numbers: [] }); } catch (_) {}
  try { writeJSON('last-run.json', { runId, finishedAt: now(), total: resultsAcc.length, ok, fail }); } catch (_) {}
  await publish(`finished: ${runId} (ok=${ok} fail=${fail})`);
  console.log(`[summary] ok=${ok} fail=${fail} total=${resultsAcc.length}`);
}

main().then(() => process.exit(0)).catch(e => {
  console.error('[fatal]', e.message);
  process.exit(1);
});