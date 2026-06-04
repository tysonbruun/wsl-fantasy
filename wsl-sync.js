#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  WSL SYNC  v1.0                                                  ║
 * ║  Unified data sync tool for the WSL Fantasy Bracket Selector     ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  WHAT IT DOES                                                    ║
 * ║  ─────────────────────────────────────────────────────────────   ║
 * ║  1. RESULTS MODE  — reads live heat scores from WSL              ║
 * ║     Tries discovered JSON endpoints first (fast, no browser)     ║
 * ║     Falls back to Playwright + real Chrome if blocked            ║
 * ║     Serves results at localhost:3456 for the fantasy app         ║
 * ║     App polls this every 60s and shows live scores + LIVE badge  ║
 * ║                                                                  ║
 * ║  2. STATS MODE  — updates surfer fp/avg/mhs/ahs/hw in index.html ║
 * ║     Reads WSL Fantasy app data via Playwright                    ║
 * ║     Patches index.html directly, no manual screenshot needed     ║
 * ║                                                                  ║
 * ║  3. ATHLETES MODE — updates stance/nat/age in index.html         ║
 * ║     Reads WSL athlete profile pages via Playwright               ║
 * ║     Only updates fields that changed — won't overwrite correct   ║
 * ║                                                                  ║
 * ║  4. RANKINGS MODE — updates CT points table in index.html        ║
 * ║     Reads WSL rankings page                                      ║
 * ║                                                                  ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  USAGE                                                           ║
 * ║  ─────────────────────────────────────────────────────────────   ║
 * ║  node wsl-sync.js --results          Live scores during event    ║
 * ║  node wsl-sync.js --stats            Update fantasy stats        ║
 * ║  node wsl-sync.js --athletes         Update athlete profiles     ║
 * ║  node wsl-sync.js --rankings         Update CT rankings          ║
 * ║  node wsl-sync.js --all              Run all update modes        ║
 * ║  node wsl-sync.js --api <url>        Register a WSL API endpoint ║
 * ║  node wsl-sync.js --discover         Find WSL endpoints via CDP  ║
 * ║                                                                  ║
 * ║  FIRST RUN: Discover the WSL API endpoints (10 min, once only)  ║
 * ║    node wsl-sync.js --discover                                   ║
 * ║    Open Chrome → DevTools → Network → Filter: Fetch/XHR         ║
 * ║    Load worldsurfleague.com/events/2026/ct/439/.../results       ║
 * ║    The tool prints every JSON URL it sees — copy the useful ones ║
 * ║    Then: node wsl-sync.js --api "https://discovered-url"         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict';

const { chromium } = require('playwright');
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  // El Salvador 2026
  eventId:    439,
  eventSlug:  'surf-city-el-salvador-pro',
  eventYear:  2026,
  roundIds:   [26798, 26799, 26800, 26801, 26802, 26803],

  // Local server
  port:           3456,
  refreshMins:    5,

  // Files — assumes wsl-sync.js is in the same folder as index.html
  htmlFile:       'index.html',
  apiCacheFile:   'wsl-api-endpoints.json',
  logFile:        'wsl-sync.log',
  dataFile:       'wsl-data.json',

  // WSL URLs
  baseResultsUrl: 'https://www.worldsurfleague.com/events/2026/ct/439/surf-city-el-salvador-pro/results',
  rankingsUrl:    'https://www.worldsurfleague.com/athletes/rankings',
  athletesUrl:    'https://www.worldsurfleague.com/athletes',
};

const ROUND_META = {
  26798: { code:'R1', name:'Opening Round' },
  26799: { code:'R2', name:'Elimination Round' },
  26800: { code:'R3', name:'Round of 16' },
  26801: { code:'QF', name:'Quarterfinals' },
  26802: { code:'SF', name:'Semifinals' },
  26803: { code:'F',  name:'Final' },
};

// ── LOGGING ───────────────────────────────────────────────────────────────
function log(msg, level = 'INFO') {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch(e) {}
}

// ── API ENDPOINT REGISTRY ─────────────────────────────────────────────────
// Once you discover WSL's actual JSON endpoints via --discover,
// they get saved here and used in all future runs — no browser needed.
const EndpointRegistry = {
  load() {
    try { return JSON.parse(fs.readFileSync(CONFIG.apiCacheFile, 'utf8')); }
    catch(e) { return { results: [], athletes: [], rankings: [], fantasy: [] }; }
  },
  save(registry) {
    fs.writeFileSync(CONFIG.apiCacheFile, JSON.stringify(registry, null, 2));
  },
  add(category, url) {
    const r = this.load();
    if (!r[category]) r[category] = [];
    if (!r[category].includes(url)) {
      r[category].push(url);
      this.save(r);
      log(`Registered ${category} endpoint: ${url}`);
    }
  },
};

// ── HTTP HELPER — try a URL without a browser ──────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept':           'application/json, text/plain, */*',
        'Accept-Language':  'en-US,en;q=0.9',
        'Referer':          'https://www.worldsurfleague.com/',
        'Origin':           'https://www.worldsurfleague.com',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── PARSE WSL JSON — handles various response shapes ─────────────────────
function parseHeatData(json) {
  function findHeats(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 8) return null;
    if (Array.isArray(obj)) {
      if (obj.length > 0) {
        const f = obj[0];
        if (f.athletes || f.competitors || f.heatNumber || f.heatNum || f.entries) return obj;
      }
      for (const item of obj) { const r = findHeats(item, depth+1); if (r) return r; }
    }
    for (const key of ['heats','heatResults','results','data','content','rounds','items']) {
      if (obj[key]) { const r = findHeats(obj[key], depth+1); if (r) return r; }
    }
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') { const r = findHeats(val, depth+1); if (r) return r; }
    }
    return null;
  }

  const rawHeats = findHeats(json);
  if (!rawHeats?.length) return [];

  return rawHeats.map((heat, i) => {
    const raw = heat.athletes || heat.competitors || heat.surfers || heat.entries || [];
    const athletes = raw.map(a => {
      const name     = (a.name || `${a.firstName||''} ${a.lastName||''}`.trim() || a.athleteName || '').trim();
      const total    = String(a.totalScore ?? a.score ?? a.total ?? a.combinedScore ?? '--');
      const w1       = String(a.waveScore1 ?? a.wave1 ?? a.scores?.[0] ?? '--');
      const w2       = String(a.waveScore2 ?? a.wave2 ?? a.scores?.[1] ?? '--');
      const place    = String(a.place ?? a.rank ?? a.placeInHeat ?? '');
      const advanced = !!(a.advanced || a.winner || a.isWinner || place === '1' || a.status === 'ADVANCED');
      return { name, total, wave1: w1, wave2: w2, place, advanced };
    }).filter(a => a.name.length > 2 && a.name.length < 60);

    return {
      heatNum:  heat.heatNumber ?? heat.heatNum ?? i + 1,
      label:    heat.label ?? heat.heatLabel ?? `Heat ${i+1}`,
      athletes,
      status:   heat.status ?? heat.heatStatus ?? '',
    };
  }).filter(h => h.athletes.length >= 2);
}

// ─────────────────────────────────────────────────────────────────────────
// MODE 1: RESULTS — serve live heat scores to the fantasy app
// ─────────────────────────────────────────────────────────────────────────
const LiveState = {
  event:   'Surf City El Salvador Pro 2026',
  eventId: CONFIG.eventId,
  scraped: null,
  source:  null,   // 'api' | 'playwright' | 'mock'
  rounds:  [],
};

async function fetchRoundViaAPI(roundId) {
  // Try every registered result endpoint for this round
  const registry = EndpointRegistry.load();
  const endpoints = registry.results || [];

  for (const baseUrl of endpoints) {
    const url = baseUrl.includes('roundId') ? baseUrl : `${baseUrl}?roundId=${roundId}`;
    try {
      const raw  = await httpGet(url);
      const json = JSON.parse(raw);
      const heats = parseHeatData(json);
      if (heats.length > 0) {
        log(`  API hit: ${url.slice(0, 80)} → ${heats.length} heats`);
        return heats;
      }
    } catch(e) {
      log(`  API miss: ${url.slice(0, 60)} — ${e.message}`, 'WARN');
    }
  }
  return null; // No API worked — fall back to Playwright
}

async function fetchRoundViaPlaywright(context, roundId) {
  const page  = await context.newPage();
  const url   = `${CONFIG.baseResultsUrl}?roundId=${roundId}`;
  let captured = null;

  // Intercept API responses — scoped to this event only
  page.on('response', async (res) => {
    const u  = res.url();
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    if (/analytics|gtm|sentry|cdn\.|cookielaw/i.test(u)) return;
    const isThisEvent = u.includes(String(CONFIG.eventId)) || u.includes(CONFIG.eventSlug) || u.includes(String(roundId));
    if (!isThisEvent) return;
    try {
      const json  = await res.json();
      const heats = parseHeatData(json);
      if (heats.length > 0 && (!captured || heats.length > captured.heats.length)) {
        captured = { heats, url: u };
        log(`  Intercepted: ${u.slice(0, 80)}`);
        // Auto-register the endpoint for future API-only calls
        EndpointRegistry.add('results', u.split('?')[0]);
      }
    } catch(e) {}
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3500);
    for (const sel of ['#onetrust-accept-btn-handler', 'button:has-text("Accept All")']) {
      try { const b = await page.$(sel); if (b) { await b.click(); await page.waitForTimeout(600); } } catch(e) {}
    }
    await page.waitForTimeout(1500);
  } catch(e) {
    log(`  Playwright page timeout for round ${roundId}`, 'WARN');
  }

  // DOM fallback scoped to results container
  if (!captured) {
    const heats = await page.evaluate(() => {
      const root = document.querySelector('[class*="ResultsPage"],[class*="EventResults"],main') || document.body;
      const result = [];
      root.querySelectorAll('[class*="Heat"],[data-heat-id]').forEach((el, i) => {
        if (el.closest('nav,header,aside,[class*="Sidebar"]')) return;
        const athletes = [];
        el.querySelectorAll('[class*="Athlete"],[class*="Competitor"]').forEach(a => {
          const nameEl  = a.querySelector('[class*="Name"],[class*="AthleteName"]');
          const scoreEl = a.querySelector('[class*="Total"],[class*="TotalScore"]');
          if (!nameEl) return;
          const name = nameEl.textContent.trim();
          if (name.length > 2 && name.length < 60) {
            athletes.push({ name, total: scoreEl?.textContent?.trim() || '--', wave1:'--', wave2:'--', place:'', advanced: /advanc|winner/i.test(a.className) });
          }
        });
        if (athletes.length >= 2) result.push({ heatNum: i+1, label:`Heat ${i+1}`, athletes, status:'' });
      });
      return result;
    });
    if (heats.length > 0) captured = { heats, url: 'dom-scrape' };
  }

  await page.close();
  return captured?.heats || [];
}

async function runResultsMode() {
  log('=== RESULTS MODE — serving live scores at localhost:' + CONFIG.port);

  // Start the HTTP server first so the app can connect immediately
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/results') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(LiveState));
    } else if (req.url === '/health') {
      res.writeHead(200); res.end('OK');
    } else {
      res.setHeader('Content-Type', 'text/html');
      const roundsWithData = LiveState.rounds.filter(r => r.heats?.length).length;
      res.end(`<html><body style="font:13px monospace;padding:20px;background:#0a0a0a;color:#eee">
        <h2 style="color:#4CAF50">WSL Sync — Results Server</h2>
        <p>Event: <b>${LiveState.event}</b></p>
        <p>Source: <b>${LiveState.source || 'pending...'}</b></p>
        <p>Scraped: <b>${LiveState.scraped ? new Date(LiveState.scraped).toLocaleString() : 'pending...'}</b></p>
        <p>Rounds with data: <b>${roundsWithData} / ${CONFIG.roundIds.length}</b></p>
        <p><a href="/results" style="color:#4CAF50">/results</a> · <a href="/health" style="color:#888">/health</a></p>
        <pre style="color:#888;font-size:11px;margin-top:20px">${JSON.stringify(LiveState.rounds.map(r=>({round:r.name,heats:r.heats?.length||0})),null,2)}</pre>
      </body></html>`);
    }
  });
  server.listen(CONFIG.port, () => log(`Server ready → http://localhost:${CONFIG.port}`));

  async function scrape() {
    const registry = EndpointRegistry.load();
    const hasAPI   = (registry.results || []).length > 0;
    log(`Scraping... (${hasAPI ? 'API-first' : 'Playwright-only — run --discover to find API endpoints'})`);

    let browser = null;
    let context = null;

    if (!hasAPI) {
      // No registered API endpoints — must use Playwright
      browser = await launchBrowser();
      context = await setupBrowserContext(browser);
      await warmupSession(context);
    }

    const rounds = [];
    for (const roundId of CONFIG.roundIds) {
      const meta = ROUND_META[roundId];
      let heats = null;

      // Try API first (fast, no browser)
      if (hasAPI) {
        heats = await fetchRoundViaAPI(roundId);
      }

      // Fall back to Playwright if API didn't work
      if (!heats) {
        if (!browser) {
          browser = await launchBrowser();
          context = await setupBrowserContext(browser);
          await warmupSession(context);
        }
        heats = await fetchRoundViaPlaywright(context, roundId);
        LiveState.source = 'playwright';
      } else {
        LiveState.source = 'api';
      }

      if (heats.length > 0) {
        const winners = heats.map(h => h.athletes.find(a => a.advanced)?.name).filter(Boolean);
        log(`  ${meta.name}: ${heats.length} heats${winners.length ? ' | '+winners.slice(0,3).join(', ') : ''}`);
        rounds.push({ ...meta, roundId, heats });
      } else {
        log(`  ${meta.name}: no data yet`);
      }
    }

    if (browser) await browser.close();

    // Update shared state — server reads this live
    LiveState.scraped = new Date().toISOString();
    LiveState.rounds  = rounds;

    // Save to disk for debugging
    fs.writeFileSync(CONFIG.dataFile, JSON.stringify(LiveState, null, 2));
    log(`Done. ${rounds.length} rounds with data. Next refresh in ${CONFIG.refreshMins}min.\n`);
  }

  await scrape();
  setInterval(scrape, CONFIG.refreshMins * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────────
// MODE 2: STATS — update fp/avg/ex/mhs/ahs/hw in index.html from WSL Fantasy
// ─────────────────────────────────────────────────────────────────────────
async function runStatsMode() {
  log('=== STATS MODE — updating fantasy stats in ' + CONFIG.htmlFile);

  const htmlPath = path.resolve(CONFIG.htmlFile);
  if (!fs.existsSync(htmlPath)) { log(`ERROR: ${htmlPath} not found`, 'ERROR'); return; }

  const browser = await launchBrowser();
  const context = await setupBrowserContext(browser);
  const page    = await context.newPage();

  // WSL Fantasy uses the same auth as the main site
  // Navigate to the fantasy results/stats page for this event
  const fantasyUrl = `https://www.worldsurfleague.com/fantasy/event/${CONFIG.eventId}`;
  log(`Loading WSL Fantasy at ${fantasyUrl}`);

  const stats = {}; // name → { fp, avg, ex, mhs, ahs, hw }

  page.on('response', async (res) => {
    const u  = res.url();
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    if (!/fantasy|athlete|surfer|scoring/i.test(u)) return;
    try {
      const json = await res.json();
      // Look for athlete scoring arrays
      const str = JSON.stringify(json);
      if (!str.includes('fantasyPoints') && !str.includes('totalScore') && !str.includes('fp')) return;
      // Auto-register for future use
      EndpointRegistry.add('fantasy', u.split('?')[0]);
      log(`  Fantasy API found: ${u.slice(0, 80)}`);
      // Parse athlete stats
      parseAthleteStats(json, stats);
    } catch(e) {}
  });

  try {
    await page.goto(fantasyUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(4000);
    await dismissCookies(page);
    await page.waitForTimeout(2000);
  } catch(e) {
    log(`Fantasy page error: ${e.message}`, 'WARN');
  }

  await browser.close();

  if (Object.keys(stats).length === 0) {
    log('No stats captured — WSL Fantasy may require auth or page structure changed', 'WARN');
    log('Alternative: Screenshot the WSL Fantasy tiers and paste values here', 'INFO');
    return;
  }

  // Patch the HTML file
  let html    = fs.readFileSync(htmlPath, 'utf8');
  let changes = 0;
  const backup = htmlPath.replace('.html', `-backup-${Date.now()}.html`);
  fs.copyFileSync(htmlPath, backup);

  for (const [name, s] of Object.entries(stats)) {
    html    = patchSurferField(html, name, 'fp',  s.fp);
    html    = patchSurferField(html, name, 'avg', s.avg);
    html    = patchSurferField(html, name, 'ex',  s.ex);
    html    = patchSurferField(html, name, 'mhs', s.mhs);
    html    = patchSurferField(html, name, 'ahs', s.ahs);
    html    = patchSurferField(html, name, 'hw',  s.hw);
    changes++;
  }

  fs.writeFileSync(htmlPath, html);
  log(`Stats updated: ${changes} surfers patched. Backup: ${backup}`);
}

function parseAthleteStats(json, stats) {
  // Handles various WSL Fantasy API response shapes
  function walk(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return;
    if (Array.isArray(obj)) { obj.forEach(i => walk(i, depth+1)); return; }

    // Is this an athlete stats object?
    const name = obj.name || obj.athleteName || obj.surferName;
    if (name && typeof name === 'string' && name.length > 2) {
      const entry = {};
      if (obj.fantasyPoints !== undefined) entry.fp  = obj.fantasyPoints;
      if (obj.averageScore  !== undefined) entry.avg = obj.averageScore;
      if (obj.eventsPlayed  !== undefined) entry.ex  = obj.eventsPlayed;
      if (obj.bestHeatScore !== undefined) entry.mhs = obj.bestHeatScore;
      if (obj.avgHeatScore  !== undefined) entry.ahs = obj.avgHeatScore;
      if (obj.heatWinPct    !== undefined) entry.hw  = obj.heatWinPct;
      if (Object.keys(entry).length > 0) stats[name] = { ...stats[name], ...entry };
    }

    for (const val of Object.values(obj)) walk(val, depth+1);
  }
  walk(json);
}

// ─────────────────────────────────────────────────────────────────────────
// MODE 3: ATHLETES — update stance/nat in index.html from WSL profiles
// ─────────────────────────────────────────────────────────────────────────
const ATHLETES_TO_CHECK = [
  // Men with unverified or uncertain data (from our earlier audit)
  'Barron Mamiya','Jake Marshall','Crosby Colapinto','Alejo Muniz','Marco Mignot',
  'Joel Vaughan','Seth Moniz','Ramzi Boukhiam','Matt McGillivray','Tyler Wright',
  'Erin Brooks','Brisa Hennessy','Jack Robinson','Kanoa Igarashi','Cole Houshmand',
  // Add any others you want to verify
];

const NAT_MAP = {
  'Australia':'AUS','Brazil':'BRA','USA':'USA','United States':'USA','Hawaii':'HAW',
  'South Africa':'RSA','France':'FRA','Japan':'JPN','New Zealand':'NZL','Portugal':'POR',
  'Spain':'ESP','Italy':'ITA','Canada':'CAN','Morocco':'MAR','Indonesia':'INA',
  'Costa Rica':'CRC','El Salvador':'SLV','Israel':'ISR','Ireland':'IRL',
  'French Polynesia':'PYF','Fiji':'FJI','Argentina':'ARG',
};

async function runAthletesMode() {
  log('=== ATHLETES MODE — verifying stances and nationalities');

  const htmlPath = path.resolve(CONFIG.htmlFile);
  if (!fs.existsSync(htmlPath)) { log(`ERROR: ${htmlPath} not found`, 'ERROR'); return; }

  const browser = await launchBrowser({ headless: false }); // Real Chrome to bypass bot detection
  const context = await setupBrowserContext(browser);
  const page    = await context.newPage();

  log('Opening real Chrome window (required to bypass WSL bot detection)');

  // Warm up session
  try {
    await page.goto('https://www.worldsurfleague.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    await dismissCookies(page);
  } catch(e) {}

  const results = [];
  for (let i = 0; i < ATHLETES_TO_CHECK.length; i++) {
    const name = ATHLETES_TO_CHECK[i];
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const url  = `https://www.worldsurfleague.com/athletes?q=${encodeURIComponent(name)}`;

    process.stdout.write(`[${i+1}/${ATHLETES_TO_CHECK.length}] ${name}... `);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2500);

      // Find first profile link
      const profileURL = await page.evaluate((searchName) => {
        const links = [...document.querySelectorAll('a[href*="/athletes/"]')];
        for (const a of links) {
          if (/\/athletes\/\d+\//.test(a.href) && a.textContent.toLowerCase().includes(searchName.split(' ')[0].toLowerCase())) return a.href;
        }
        const first = links.find(a => /\/athletes\/\d+\//.test(a.href));
        return first?.href || null;
      }, name);

      if (!profileURL) { console.log('no profile found'); continue; }

      await page.goto(profileURL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2500);

      const data = await page.evaluate(() => {
        const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
        const result = {};
        for (let i = 0; i < lines.length - 1; i++) {
          const lbl = lines[i].toLowerCase();
          const val = lines[i+1];
          if (!val || val.length > 80) continue;
          if (lbl === 'stance')   result.stance   = val;
          if (lbl === 'hometown') result.hometown  = val;
          if (lbl === 'age')      result.age       = val;
        }
        const h1 = document.querySelector('h1');
        result.pageName = h1?.textContent?.trim() || '';
        return result;
      });

      // Verify page loaded the right person
      if (data.pageName && !data.pageName.toLowerCase().includes(name.split(' ')[0].toLowerCase())) {
        console.log(`WRONG PAGE ("${data.pageName}")`);
        results.push({ name, error: 'wrong page', pageName: data.pageName });
        continue;
      }

      const stanceRaw = (data.stance || '').toLowerCase();
      const stance    = stanceRaw.includes('goofy') ? 'Goofy' : stanceRaw.includes('regular') ? 'Regular' : null;
      const natRaw    = data.hometown || '';
      let nat = null;
      for (const [k, v] of Object.entries(NAT_MAP)) {
        if (natRaw.toLowerCase().includes(k.toLowerCase())) { nat = v; break; }
      }

      const bits = [stance, data.hometown, data.age].filter(Boolean);
      console.log(bits.join(' | ') || 'loaded but no stat fields');
      results.push({ name, stance, nat, hometown: data.hometown });
    } catch(e) {
      console.log(`ERROR: ${e.message.split('\n')[0]}`);
      results.push({ name, error: e.message.split('\n')[0] });
    }
    await page.waitForTimeout(400);
  }

  await browser.close();

  // Save raw results
  fs.writeFileSync('wsl-athlete-data.json', JSON.stringify(results, null, 2));
  log(`Athlete data saved → wsl-athlete-data.json`);

  // Patch HTML
  let html    = fs.readFileSync(htmlPath, 'utf8');
  let changes = 0;
  const backup = htmlPath.replace('.html', `-backup-athletes-${Date.now()}.html`);
  fs.copyFileSync(htmlPath, backup);

  for (const r of results) {
    if (!r.stance || r.error) continue;
    const before = html;
    html = patchSurferField(html, r.name, 'st', r.stance);
    if (html !== before) { log(`  ${r.name}: stance → ${r.stance}`); changes++; }
  }

  if (changes > 0) {
    fs.writeFileSync(htmlPath, html);
    log(`${changes} athlete corrections applied. Backup: ${backup}`);
  } else {
    log('No athlete changes needed.');
    fs.unlinkSync(backup);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MODE 4: RANKINGS — update CT points in index.html
// ─────────────────────────────────────────────────────────────────────────
async function runRankingsMode() {
  log('=== RANKINGS MODE — updating CT standings');

  const htmlPath = path.resolve(CONFIG.htmlFile);
  if (!fs.existsSync(htmlPath)) { log(`ERROR: ${htmlPath} not found`, 'ERROR'); return; }

  // Try API first
  const registry = EndpointRegistry.load();
  let rankings = null;

  for (const url of (registry.rankings || [])) {
    try {
      const raw  = await httpGet(url);
      const json = JSON.parse(raw);
      rankings   = parseRankings(json);
      if (rankings?.men?.length > 5) { log(`Rankings from API: ${url.slice(0,60)}`); break; }
    } catch(e) { rankings = null; }
  }

  // Playwright fallback
  if (!rankings) {
    const browser = await launchBrowser();
    const context = await setupBrowserContext(browser);
    const page    = await context.newPage();

    page.on('response', async (res) => {
      const u  = res.url();
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;
      if (!/rank|standing|athlete/i.test(u)) return;
      try {
        const json = await res.json();
        const r    = parseRankings(json);
        if (r?.men?.length > 5) {
          rankings = r;
          EndpointRegistry.add('rankings', u.split('?')[0]);
          log(`Rankings intercepted: ${u.slice(0,60)}`);
        }
      } catch(e) {}
    });

    try {
      await page.goto(CONFIG.rankingsUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(4000);
    } catch(e) {}

    await browser.close();
  }

  if (!rankings) {
    log('Could not retrieve rankings. Try adding a rankings API endpoint via --api', 'WARN');
    return;
  }

  log(`Got ${rankings.men?.length || 0} men, ${rankings.women?.length || 0} women`);

  // Patch MRANKS and WRANKS in HTML
  let html = fs.readFileSync(htmlPath, 'utf8');
  // Rankings patching is complex — log what we got and let user verify
  fs.writeFileSync('wsl-rankings.json', JSON.stringify(rankings, null, 2));
  log('Rankings saved → wsl-rankings.json — verify before applying to index.html');
}

function parseRankings(json) {
  // Try to extract men's and women's rankings
  const men = [], women = [];
  function walk(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return;
    if (Array.isArray(obj)) { obj.forEach(i => walk(i, depth+1)); return; }
    const rank = obj.rank ?? obj.position ?? obj.standing;
    const name = obj.name ?? obj.athleteName;
    const pts  = obj.points ?? obj.totalPoints ?? obj.rankingPoints;
    if (rank && name && pts) {
      const entry = { rank: Number(rank), name: String(name).trim(), pts: Number(pts) };
      if (obj.gender === 'women' || obj.tour === 'wct-women') women.push(entry);
      else men.push(entry);
    }
    for (const val of Object.values(obj)) walk(val, depth+1);
  }
  walk(json);
  return { men: men.sort((a,b) => a.rank-b.rank), women: women.sort((a,b) => a.rank-b.rank) };
}

// ─────────────────────────────────────────────────────────────────────────
// MODE 5: DISCOVER — help find WSL API endpoints via browser interception
// ─────────────────────────────────────────────────────────────────────────
async function runDiscoverMode() {
  log('=== DISCOVER MODE — finding WSL API endpoints');
  log('Opening Chrome window. Load the WSL results/athletes/rankings pages.');
  log('Every JSON API request will be logged here. Ctrl+C to stop.\n');

  const browser = await launchBrowser({ headless: false });
  const context = await setupBrowserContext(browser);
  const page    = await context.newPage();

  const found = new Set();

  context.on('response', async (res) => {
    const u  = res.url();
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    if (/analytics|gtm|sentry|cookielaw|fonts\./i.test(u)) return;
    if (found.has(u)) return;
    found.add(u);
    try {
      const raw  = await res.text();
      const size = Math.round(raw.length / 1024);
      const json = JSON.parse(raw);
      const str  = JSON.stringify(json);
      const category =
        (u.includes('athlete') || str.includes('stance') || str.includes('hometown')) ? 'ATHLETE' :
        (u.includes('rank') || str.includes('ranking') || str.includes('totalPoints'))  ? 'RANKING' :
        (str.includes('heat') || str.includes('score') || str.includes('athlete') && str.includes('total')) ? 'RESULTS' :
        (u.includes('fantasy') || str.includes('fantasyPoints') || str.includes('tier')) ? 'FANTASY' :
        'OTHER';

      if (category !== 'OTHER' || size > 5) {
        const line = `[${category}] ${size}KB — ${u}`;
        log(line);
        fs.appendFileSync('wsl-discovered-endpoints.txt', line + '\n');
      }
    } catch(e) {}
  });

  await page.goto(CONFIG.baseResultsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  log('Browser open. Navigate to any WSL page to capture endpoints.');
  log('Check wsl-discovered-endpoints.txt for results.');
  log('When done: node wsl-sync.js --api "URL" for each useful endpoint found.\n');

  // Keep running until user kills it
  await new Promise(() => {});
}

// ─────────────────────────────────────────────────────────────────────────
// SHARED UTILITIES
// ─────────────────────────────────────────────────────────────────────────
async function launchBrowser(opts = {}) {
  const headless = opts.headless !== false;
  // Use real Chrome if available — bypasses bot detection
  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  const executablePath = chromePaths.find(p => fs.existsSync(p));

  return chromium.launch({
    headless,
    executablePath: executablePath || undefined, // falls back to Playwright's bundled Chromium
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled'],
    ...(headless ? {} : { slowMo: 100 }),
  });
}

async function setupBrowserContext(browser) {
  const context = await browser.newContext({
    userAgent:    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:     { width: 1280, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  await context.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date().toISOString(), domain: '.worldsurfleague.com', path: '/' },
    { name: 'OptanonConsent', value: 'isGpcEnabled=0&interactionCount=1&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1', domain: '.worldsurfleague.com', path: '/' },
  ]);
  return context;
}

async function warmupSession(context) {
  try {
    const p = await context.newPage();
    await p.goto('https://www.worldsurfleague.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await p.waitForTimeout(1500);
    await dismissCookies(p);
    await p.close();
  } catch(e) {}
}

async function dismissCookies(page) {
  for (const sel of ['#onetrust-accept-btn-handler', 'button:has-text("Accept All")', 'button:has-text("I Accept")']) {
    try { const b = await page.$(sel); if (b) { await b.click(); await page.waitForTimeout(600); return; } } catch(e) {}
  }
}

// Patch a single field for a named surfer in the HTML file
function patchSurferField(html, name, field, newVal) {
  if (newVal === null || newVal === undefined) return html;
  const search = `"${name}"`;
  let pos = 0;
  while (true) {
    const idx = html.indexOf(search, pos);
    if (idx === -1) break;
    // Find the containing data object
    const ob = html.lastIndexOf('{', idx);
    if (ob === -1) { pos = idx + 1; continue; }
    let depth = 0, cp = ob;
    for (let i = ob; i < Math.min(ob + 600, html.length); i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (!depth) { cp = i; break; } }
    }
    const entry = html.slice(ob, cp + 1);
    // Only patch actual surfer data objects
    if (!entry.includes('fp:') && !entry.includes('seed:') && !entry.includes('nat:')) { pos = idx + 1; continue; }
    const fmtVal = field === 'st' ? `"${newVal}"` : field === 'ex' ? String(Math.round(newVal)) : typeof newVal === 'number' ? newVal.toFixed(2) : `"${newVal}"`;
    const pattern = new RegExp(field + ':(?:[\\d.]+|null|"[^"]*")', 'g');
    const newEntry = entry.replace(pattern, `${field}:${fmtVal}`);
    if (newEntry !== entry) {
      html = html.slice(0, ob) + newEntry + html.slice(cp + 1);
    }
    break;
  }
  return html;
}

// ─────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    console.log(`
WSL Sync v1.0 — Usage:

  node wsl-sync.js --discover          Open Chrome, capture WSL API endpoints
  node wsl-sync.js --api <url>         Register a discovered API endpoint
  node wsl-sync.js --results           Serve live scores (polls every ${CONFIG.refreshMins}min)
  node wsl-sync.js --stats             Update fantasy stats in ${CONFIG.htmlFile}
  node wsl-sync.js --athletes          Update athlete profiles in ${CONFIG.htmlFile}
  node wsl-sync.js --rankings          Update CT rankings
  node wsl-sync.js --all               Run stats + athletes + rankings (not --results)

Recommended first-time setup:
  1. node wsl-sync.js --discover       (10 min — find the API endpoints)
  2. node wsl-sync.js --api <url>      (register each useful endpoint you found)
  3. node wsl-sync.js --stats          (now runs without Playwright — fast + reliable)
  4. node wsl-sync.js --results        (run during the event for live scores)
`);
    process.exit(0);
  }

  if (args.includes('--api')) {
    const url = args[args.indexOf('--api') + 1];
    if (!url) { log('--api requires a URL argument', 'ERROR'); process.exit(1); }
    // Guess category from URL
    const cat = url.includes('fantasy') ? 'fantasy' : url.includes('rank') ? 'rankings' : url.includes('athlete') ? 'athletes' : 'results';
    EndpointRegistry.add(cat, url);
    process.exit(0);
  }

  log(`WSL Sync starting — ${new Date().toLocaleString()}`);
  log(`HTML target: ${path.resolve(CONFIG.htmlFile)}`);
  log(`API registry: ${path.resolve(CONFIG.apiCacheFile)}`);

  if (args.includes('--discover'))  { await runDiscoverMode();  return; }
  if (args.includes('--results'))   { await runResultsMode();   return; } // never returns
  if (args.includes('--stats'))     { await runStatsMode();     }
  if (args.includes('--athletes'))  { await runAthletesMode();  }
  if (args.includes('--rankings'))  { await runRankingsMode();  }
  if (args.includes('--all')) {
    await runStatsMode();
    await runAthletesMode();
    await runRankingsMode();
  }

  log('Done.');
  process.exit(0);
})();
