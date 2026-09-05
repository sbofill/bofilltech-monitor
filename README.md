# VisualMonitor — BofillTech

Visual + uptime monitoring for Bofill Technologies client websites.

**Dashboard:** https://bofilltech.github.io/bofilltech-monitor/

## How it works
- GitHub Actions runs `monitor/check.mjs` hourly. HTTP checks hit ALL sites every run (10 concurrent). Screenshots rotate in batches of 40 per run (4 concurrent pages), so every site gets a fresh visual diff roughly every 6 hours; a persisted cursor in `data/shot_cursor.json` tracks the rotation. Hourly (`.github/workflows/monitor.yml` — see One-time activation below).
- Each site gets an HTTP check (status code, response time, WordPress error strings, near-empty body) and a Puppeteer screenshot compared against a saved baseline with pixelmatch.
- Results are committed to `data/status.json` + `data/history.json`; screenshots to `shots/` (baselines in `shots/baseline/`). The dashboard is a static page reading those files via GitHub Pages.
- On any status transition (live → warning/down, or recovery) an email alert is sent through SMTP.

## Statuses
- **Down** — network error, timeout, or HTTP 5xx
- **Warning** — HTTP 4xx, WP fatal/db error string in body, near-empty body, slow response (> `slow_ms`), screenshot failure, or visual diff over threshold
- **Live** — everything else

At ~234 sites a full check run takes a few minutes; the workflow timeout is 25 min with headroom.

## Managing sites
Edit `sites.json`. Fields per site: `slug` (unique, filename-safe), `name`, `url`, optional `visual_warn_pct` override (use ~40 for pages with hero sliders/video; default is `settings.visual_diff_warn_pct`).

## Baselines
First run auto-creates a baseline per site. After an intentional redesign, re-baseline from **Actions → monitor → Run workflow → reset_baselines: true** (or delete `shots/baseline/<slug>.png`).

## Alert email setup (one-time)
Repo → Settings → Secrets and variables → Actions → add:
- `SMTP_HOST` — e.g. `smtp-relay.brevo.com`
- `SMTP_USER` — Brevo SMTP login
- `SMTP_PASS` — Brevo SMTP key
- `ALERT_TO` — `steve@bofilltech.com`

Without secrets, checks still run; alerts are skipped.

## One-time activation (PAT scope blocked pushing the workflow)
Create the file `.github/workflows/monitor.yml` via the GitHub web UI (Add file → Create new file, type the path with slashes) and paste the contents of [`setup/monitor.yml`](setup/monitor.yml). That single step turns the monitor on.
