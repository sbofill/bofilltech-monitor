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
  const r = { code: 0, ms: 0, error: null, bodyIssue: null };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), S.timeout_ms);
    const res = await fetch(site.url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': 'BofillTech-VisualMonitor/1.0 (+https://bofilltech.com)' },
    });
    clearTimeout(t);
    r.code = res.status;
    const body = await res.text();
    r.ms = Date.now() - started;
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
let browser = null;
async function getBrowser() {
  if (browser) return browser;
  const puppeteer = (await import('puppeteer')).default;
  browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  return browser;
}

async function screenshot(site) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: S.screenshot_width, height: S.screenshot_height });
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: S.timeout_ms });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important} video{visibility:hidden!important}' }).catch(() => {});
    await new Promise(r => setTimeout(r, 3500)); // let heroes/fonts settle
    const png = await page.screenshot({ type: 'png' });
    return Buffer.from(png);
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
const results = [];
for (const site of cfg.sites) {
  const http = await httpCheck(site);
  let status = 'live';
  const issues = [];

  if (http.error) { status = 'down'; issues.push(http.error); }
  else if (http.code >= 500) { status = 'down'; issues.push(`HTTP ${http.code}`); }
  else if (http.code >= 400) { status = 'warning'; issues.push(`HTTP ${http.code}`); }
  if (http.bodyIssue) { status = status === 'down' ? 'down' : 'warning'; issues.push(http.bodyIssue); }
  if (status === 'live' && http.ms > S.slow_ms) { status = 'warning'; issues.push(`Slow response (${(http.ms / 1000).toFixed(1)}s)`); }

  let visual = null;
  if (!NO_SHOTS && status !== 'down') {
    try {
      const png = await screenshot(site);
      const basePath = path.join(baseDir, `${site.slug}.png`);
      const latestPath = path.join(shotsDir, `${site.slug}.png`);
      if (RESET_BASELINES || !fs.existsSync(basePath)) {
        fs.writeFileSync(basePath, png);
        fs.writeFileSync(latestPath, png);
        visual = { diff_pct: 0, baseline_reset: true };
      } else {
        const pct = diffPct(fs.readFileSync(basePath), png);
        visual = { diff_pct: pct };
        // only rewrite latest when something actually moved (keeps git history lean)
        const prevPct = prev.sites?.[site.slug]?.visual?.diff_pct;
        if (pct >= 1 || prevPct === undefined || !fs.existsSync(latestPath)) fs.writeFileSync(latestPath, png);
        const warnPct = site.visual_warn_pct ?? S.visual_diff_warn_pct;
        if (pct >= warnPct) {
          if (status === 'live') status = 'warning';
          issues.push(`Visual change ${pct}% vs baseline`);
        }
      }
    } catch (e) {
      issues.push(`Screenshot failed: ${e.message.slice(0, 120)}`);
      if (status === 'live') status = 'warning';
    }
  }

  // history (cap ~2 weeks of hourly runs per site)
  const h = history[site.slug] || [];
  h.push({ t: Date.now(), s: status, ms: http.ms });
  history[site.slug] = h.slice(-336);
  const up = h.filter(x => x.s !== 'down').length;
  const uptimePct = +(100 * up / h.length).toFixed(1);

  results.push({
    slug: site.slug, name: site.name, url: site.url,
    status, issues, code: http.code, ms: http.ms, visual,
    uptime_pct: uptimePct,
    checked_at: new Date().toISOString(),
  });
  console.log(`[${status.toUpperCase().padEnd(7)}] ${site.name} — ${http.code} in ${http.ms}ms${issues.length ? ' — ' + issues.join('; ') : ''}`);
}
if (browser) await browser.close();

// ---------- 4. Persist ----------
const out = {
  generated_at: new Date().toISOString(),
  sites: Object.fromEntries(results.map(r => [r.slug, r])),
};
fs.writeFileSync(path.join(dataDir, 'status.json'), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(dataDir, 'history.json'), JSON.stringify(history));

// ---------- 5. Alerts on transitions ----------
const transitions = results.filter(r => {
  const was = prev.sites?.[r.slug]?.status;
  return was && was !== r.status && (r.status !== 'live' || was === 'down');
});

if (transitions.length) {
  console.log(`\n${transitions.length} status change(s):`);
  for (const t of transitions) console.log(`  ${t.name}: ${prev.sites[t.slug].status} -> ${t.status}`);

  const { SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_TO } = process.env;
  if (SMTP_HOST && SMTP_USER && SMTP_PASS && ALERT_TO) {
    const nodemailer = (await import('nodemailer')).default;
    const tx = nodemailer.createTransport({ host: SMTP_HOST, port: 587, secure: false, auth: { user: SMTP_USER, pass: SMTP_PASS } });
    const lines = transitions.map(t =>
      `${t.status === 'live' ? '✅' : t.status === 'down' ? '🔴' : '⚠️'} ${t.name} — ${prev.sites[t.slug].status} → ${t.status}` +
      (t.issues.length ? `\n   ${t.issues.join('; ')}` : '') + `\n   ${t.url}`
    ).join('\n\n');
    const worst = transitions.some(t => t.status === 'down') ? 'DOWN' : transitions.some(t => t.status === 'warning') ? 'Warning' : 'Recovered';
    await tx.sendMail({
      from: `"VisualMonitor" <${SMTP_USER.includes('@') ? SMTP_USER : ALERT_TO}>`,
      to: ALERT_TO,
      subject: `[VisualMonitor] ${worst}: ${transitions.map(t => t.name).join(', ')}`,
      text: `${lines}\n\nDashboard: https://sbofill.github.io/bofilltech-monitor/\n${new Date().toISOString()}`,
    });
    console.log('Alert email sent.');
  } else {
    console.log('SMTP secrets not set — alert email skipped.');
  }
}

const downCount = results.filter(r => r.status === 'down').length;
console.log(`\nDone: ${results.length} sites, ${downCount} down, ${results.filter(r => r.status === 'warning').length} warning.`);
