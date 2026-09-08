// BofillTech VisualMonitor — check engine
// Runs in GitHub Actions. For each site in sites.json:
//   1. HTTP check (status code, response time, WP error strings)
//   2. Puppeteer screenshot -> visual diff vs committed baseline (pixelmatch)
//   3. Writes data/status.json + data/history.json, updates shots/
//   4. Emails alerts on status transitions via Brevo SMTP (secrets; skipped if absent)
//
// Usage: node monitor/check.mjs [--reset-baselines] [--no-shots]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const RESET_BASELINES = args.includes('--reset-baselines');
const NO_SHOTS = args.includes('--no-shots');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'sites.json'), 'utf8'));
const S = cfg.settings;

const ERROR_STRINGS = [
  'Fatal error',
  'Error establishing a database connection',
  'Briefly unavailable for scheduled maintenance',
  'There has been a critical error on this website',
  'Parse error: syntax error',
];

const dataDir = path.join(ROOT, 'data');
const shotsDir = path.join(ROOT, 'shots');
const baseDir = path.join(shotsDir, 'baseline');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(baseDir, { recursive: true });

const prev = readJson(path.join(dataDir, 'status.json')) || { sites: {} };
const history = readJson(path.join(dataDir, 'history.json')) || {};

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// ---------- 1. HTTP checks ----------
async function httpCheck(site) {
  const started = Date.now();
  const r = { code: 0, ms: 0, error: null, bodyIssue: null, botProtected: false };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), S.timeout_ms);
    const res = await fetch(site.url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(t);
    r.code = res.status;
    const body = await res.text();
    r.ms = Date.now() - started;
    // WAF/bot-challenge pages (Cloudflare Bot Fight Mode, hosting WAFs): infrastructure is up, it just blocks non-browsers
    if (r.code === 403 || r.code === 503 || r.code === 429) {
      const low = body.toLowerCase();
      if (res.headers.get('cf-mitigated') || res.headers.get('cf-ray') ||
          low.includes('just a moment') || low.includes('attention required') ||
          low.includes('cloudflare') || low.includes('captcha') || low.includes('access denied') ||
          low.includes('bot verification') || body.replace(/\s/g, '').length < 2000) {
        r.botProtected = true;
      }
    }
    for (const s of ERROR_STRINGS) {
      if (body.includes(s)) { r.bodyIssue = s; break; }
    }
    if (!r.bodyIssue && body.replace(/\s/g, '').length < 200) r.bodyIssue = 'Page body nearly empty';
  } catch (e) {
    r.ms = Date.now() - started;
    r.error = e.name === 'AbortError' ? `Timed out after ${S.timeout_ms / 1000}s` : (e.cause?.code || e.message);
  }
  return r;
}

// ---------- 2. Screenshots + diff ----------
let browserP = null;
function getBrowser() {
  if (!browserP) {
    browserP = (async () => {
      const puppeteer = (await import('puppeteer-extra')).default;
      const stealth = (await import('puppeteer-extra-plugin-stealth')).default;
      puppeteer.use(stealth());
      return puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--disable-blink-features=AutomationControlled'],
      });
    })();
  }
  return browserP;
}

const CHALLENGE_MARKERS = ['performing security verification', 'verify you are human', 'just a moment', 'checking your browser', 'verifying you are not a bot'];
async function looksLikeChallenge(page) {
  try {
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000).toLowerCase());
    return CHALLENGE_MARKERS.some(m => text.includes(m));
  } catch { return false; }
}

async function screenshot(site) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: S.screenshot_width, height: S.screenshot_height });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
    await page.goto(site.url, { waitUntil: 'networkidle2', timeout: S.timeout_ms })
      .catch(() => {}); // slow third-party beacons shouldn't sink the capture; proceed with what loaded
    // Cloudflare managed challenges usually auto-clear in a real-looking browser: poll up to 16s
    let challenged = await looksLikeChallenge(page);
    if (challenged) {
      for (let w = 0; w < 8 && challenged; w++) {
        await new Promise(r => setTimeout(r, 2000));
        challenged = await looksLikeChallenge(page);
      }
      if (!challenged) await new Promise(r => setTimeout(r, 2500)); // real page just arrived; let it settle
    }
    // wait for every <img> currently in the DOM to finish decoding (hero images are the big diff-flappers)
    await Promise.race([
      page.evaluate(() => Promise.all(Array.from(document.images).filter(i => !i.complete).map(i => new Promise(res => { i.onload = i.onerror = res; })))),
      new Promise(r => setTimeout(r, 8000)),
    ]).catch(() => {});
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important} video{visibility:hidden!important}' }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000)); // fonts/late JS settle
    const stillChallenged = challenged || await looksLikeChallenge(page);
    const png = await page.screenshot({ type: 'png' });
    return { png: Buffer.from(png), challenged: stillChallenged };
  } finally {
    await page.close().catch(() => {});
  }
}

function diffPct(bufA, bufB) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  if (a.width !== b.width || a.height !== b.height) return 100;
  const changed = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.12 });
  return +(100 * changed / (a.width * a.height)).toFixed(2);
}

// ---------- 3. Run ----------
const SHOT_BATCH = Number(process.env.SHOT_BATCH || 40);   // sites screenshotted per run
const HTTP_CONCURRENCY = 10;
const SHOT_CONCURRENCY = 4;

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// HTTP checks: every site, every run, concurrently
const httpResults = await pool(cfg.sites, HTTP_CONCURRENCY, s => httpCheck(s));

// Screenshot rotation: SHOT_BATCH sites per run via persisted cursor (full cycle ~ sites/SHOT_BATCH runs)
const cursorPath = path.join(dataDir, 'shot_cursor.json');
const cursor = (readJson(cursorPath)?.i ?? 0) % cfg.sites.length;
const shotSet = new Set();
if (!NO_SHOTS) {
  for (let k = 0; k < Math.min(SHOT_BATCH, cfg.sites.length); k++) shotSet.add((cursor + k) % cfg.sites.length);
  // always include sites with no baseline yet is unnecessary — rotation covers all within a few runs
  fs.writeFileSync(cursorPath, JSON.stringify({ i: (cursor + SHOT_BATCH) % cfg.sites.length, at: new Date().toISOString() }));
}

const results = [];
for (let idx = 0; idx < cfg.sites.length; idx++) {
  const site = cfg.sites[idx];
  const http = httpResults[idx];
  let status = 'live';
  const issues = [];

  if (http.error) { status = 'down'; issues.push(http.error); }
  else if (http.botProtected) { /* WAF challenged the checker; host is up */ }
  else if (http.code >= 500) { status = 'down'; issues.push(`HTTP ${http.code}`); }
  else if (http.code >= 400) { status = 'warning'; issues.push(`HTTP ${http.code}`); }
  if (http.bodyIssue && !http.botProtected) { status = status === 'down' ? 'down' : 'warning'; issues.push(http.bodyIssue); }
  if (status === 'live' && http.ms > S.slow_ms) { status = 'warning'; issues.push(`Slow response (${(http.ms / 1000).toFixed(1)}s)`); }

  // Two-strike rule: a site must fail two consecutive runs before it reports Down
  const prevStreak = prev.sites?.[site.slug]?.down_streak || 0;
  const downStreak = status === 'down' ? prevStreak + 1 : 0;
  if (status === 'down' && downStreak < 2) {
    status = 'warning';
    issues.unshift('First failure — confirming next run');
  }

  results.push({ site, idx, status, issues, downStreak, http, visual: prev.sites?.[site.slug]?.visual ?? null });
}

// Screenshots for this run's batch (skip down sites)
const toShoot = results.filter(r => shotSet.has(r.idx) && r.status !== 'down');
await pool(toShoot, SHOT_CONCURRENCY, async (r) => {
  const site = r.site;
  try {
    const { png, challenged } = await screenshot(site);
    const basePath = path.join(baseDir, `${site.slug}.png`);
    const latestPath = path.join(shotsDir, `${site.slug}.png`);
    if (challenged) {
      // WAF wouldn't let the browser through: keep whatever real shot/baseline we have, record the block, no diff
      r.visual = { challenge_blocked: true };
      return;
    }
    if (RESET_BASELINES || !fs.existsSync(basePath)) {
      fs.writeFileSync(basePath, png);
      fs.writeFileSync(latestPath, png);
      r.visual = { diff_pct: 0, baseline_reset: true };
    } else {
      const pct = diffPct(fs.readFileSync(basePath), png);
      r.visual = { diff_pct: pct };
      const prevPct = prev.sites?.[site.slug]?.visual?.diff_pct;
      if (pct >= 1 || prevPct === undefined || !fs.existsSync(latestPath)) fs.writeFileSync(latestPath, png);
      const warnPct = site.visual_warn_pct ?? S.visual_diff_warn_pct;
      if (pct >= warnPct) {
        if (r.status === 'live') r.status = 'warning';
        r.issues.push(`Visual change ${pct}% vs baseline`);
      }
    }
  } catch (e) {
    r.issues.push(`Screenshot failed: ${e.message.slice(0, 120)}`);
    if (r.status === 'live') r.status = 'warning';
  }
});

const final = results.map(r => {
  const h = history[r.site.slug] || [];
  h.push({ t: Date.now(), s: r.status, ms: r.http.ms });
  history[r.site.slug] = h.slice(-336);
  const up = h.filter(x => x.s !== 'down').length;
  console.log(`[${r.status.toUpperCase().padEnd(7)}] ${r.site.name} — ${r.http.code} in ${r.http.ms}ms${r.issues.length ? ' — ' + r.issues.join('; ') : ''}`);
  return {
    slug: r.site.slug, name: r.site.name, url: r.site.url,
    status: r.status, issues: r.issues, code: r.http.code, ms: r.http.ms, visual: r.visual,
    down_streak: r.downStreak || undefined,
    bot_protected: r.http.botProtected || undefined,
    uptime_pct: +(100 * up / h.length).toFixed(1),
    checked_at: new Date().toISOString(),
  };
});
if (browserP) await browserP.then(b => b.close()).catch(() => {});

// ---------- 4. Persist ----------
const out = {
  generated_at: new Date().toISOString(),
  sites: Object.fromEntries(final.map(r => [r.slug, r])),
};
fs.writeFileSync(path.join(dataDir, 'status.json'), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(dataDir, 'history.json'), JSON.stringify(history));

// ---------- 5. Alerts on transitions ----------
const transitions = final.filter(r => {
  const was = prev.sites?.[r.slug]?.status;
  if (!was || was === r.status) return false;
  if (r.status === 'down' || was === 'down') return true;                       // outage + recovery
  if (r.status === 'warning' && !r.issues.some(i => i.startsWith('First failure'))) return true; // real new warnings
  return false;                                                                  // warning->live clears silently
});

if (transitions.length) {
  console.log(`\n${transitions.length} status change(s):`);
  for (const t of transitions) console.log(`  ${t.name}: ${prev.sites[t.slug].status} -> ${t.status}`);

  const { SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_TO } = process.env;
  if (SMTP_HOST && SMTP_USER && SMTP_PASS && ALERT_TO) {
    try {
    const nodemailer = (await import('nodemailer')).default;
    const tx = nodemailer.createTransport({ host: SMTP_HOST, port: 587, secure: false, auth: { user: SMTP_USER, pass: SMTP_PASS } });
    const lines = transitions.map(t =>
      `${t.status === 'live' ? '✅' : t.status === 'down' ? '🔴' : '⚠️'} ${t.name} — ${prev.sites[t.slug].status} → ${t.status}` +
      (t.issues.length ? `\n   ${t.issues.join('; ')}` : '') + `\n   ${t.url}`
    ).join('\n\n');
    const worst = transitions.some(t => t.status === 'down') ? 'DOWN' : transitions.some(t => t.status === 'warning') ? 'Warning' : 'Recovered';
    await tx.sendMail({
      from: `"VisualMonitor" <${process.env.ALERT_FROM || ALERT_TO}>`,
      to: ALERT_TO,
      subject: `[VisualMonitor] ${worst}: ${transitions.map(t => t.name).join(', ')}`,
      text: `${lines}\n\nDashboard: https://bofilltech.github.io/bofilltech-monitor/\n${new Date().toISOString()}`,
    });
    console.log('Alert email sent.');
    } catch (e) {
      console.error('Alert email FAILED (monitoring unaffected):', e.message);
    }
  } else {
    console.log('SMTP secrets not set — alert email skipped.');
  }
}

const downCount = final.filter(r => r.status === 'down').length;
console.log(`\nDone: ${final.length} sites (${toShoot.length} screenshotted this run), ${downCount} down, ${final.filter(r => r.status === 'warning').length} warning.`);
