#!/usr/bin/env node
// WSL LIVE RESULTS PIPELINE v3
// Bypasses cookie consent wall, longer timeouts, API interception

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');

const CONFIG = {
  port: 3456,
  refreshMinutes: 5,
  baseUrl: 'https://www.worldsurfleague.com/events/2026/ct/439/surf-city-el-salvador-pro/results',
  roundIds: [26798, 26799, 26800, 26801, 26802, 26803],
};

const ROUND_NAMES = {
  26798: { code:'R1', name:'Opening Round' },
  26799: { code:'R2', name:'Elimination Round' },
  26800: { code:'R3', name:'Round of 16' },
  26801: { code:'QF', name:'Quarterfinals' },
  26802: { code:'SF', name:'Semifinals' },
  26803: { code:'F',  name:'Final' },
};

// Shared state — server always reads this live object
let state = {
  event: 'Surf City El Salvador Pro 2026',
  scraped: null,
  apiEndpoint: null,
  rounds: [],
};

// ── SERVER ────────────────────────────────────────────────────────
function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url === '/results') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(state));
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<html><body style="font:14px monospace;padding:24px;background:#0a0a0a;color:#eee">
        <h2 style="color:#4CAF50">WSL Pipeline v3 — RUNNING</h2>
        <p>Scraped: <b>${state.scraped || 'pending'}</b></p>
        <p>API found: <b>${state.apiEndpoint || 'searching...'}</b></p>
        <p>Rounds with data: <b>${state.rounds.filter(r=>r.heats?.length).length} of ${CONFIG.roundIds.length}</b></p>
        <p><a href="/results" style="color:#4CAF50">/results</a></p>
        <p style="color:#555;margin-top:16px">Fantasy app: <code>http://localhost:${CONFIG.port}/results</code></p>
      </body></html>`);
    }
  });
  server.listen(CONFIG.port, () => {
    console.log(`Server: http://localhost:${CONFIG.port}`);
    console.log(`API:    http://localhost:${CONFIG.port}/results\n`);
  });
}

// ── BYPASS COOKIE WALL & SCRAPE ───────────────────────────────────
async function scrapeRound(browser, roundId) {
  const page = await browser.newPage();
  const url = `${CONFIG.baseUrl}?roundId=${roundId}`;
  let apiData = null;
  let apiUrl = null;

  // Pre-set cookies to bypass consent wall
  await page.context().addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date().toISOString(), domain: '.worldsurfleague.com', path: '/' },
    { name: 'OptanonConsent', value: 'isGpcEnabled=0&datestamp=' + encodeURIComponent(new Date().toISOString()) + '&version=202209.2.0&isIABGlobal=false&consentId=abc&interactionCount=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1', domain: '.worldsurfleague.com', path: '/' },
    { name: 'cookielaw_accepted', value: '1', domain: '.worldsurfleague.com', path: '/' },
  ]);

  // Set realistic browser headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Cache-Control': 'no-cache',
  });

  // Intercept ALL JSON responses
  page.on('response', async (response) => {
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    const u = response.url();

    // Skip known non-results URLs
    if (/cookielaw|gtm|analytics|segment|sentry|pixel|tracking|cdn\./i.test(u)) return;

    try {
      const json = await response.json();
      const s = JSON.stringify(json);
      // Must contain heat or score related data
      if ((s.includes('heat') || s.includes('score') || s.includes('athlete') || s.includes('competitor') || s.includes('surfer')) && s.length > 200) {
        console.log(`  API: ${u.substring(0, 80)}`);
        if (!apiData || s.length > JSON.stringify(apiData).length) {
          apiData = json;
          apiUrl = u;
        }
      }
    } catch(e) {}
  });

  try {
    // Use domcontentloaded instead of networkidle — much faster, less likely to timeout
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for actual content to load (up to 8 seconds)
    await page.waitForTimeout(5000);

    // Try to dismiss any cookie/consent popups
    const consentSelectors = [
      '#onetrust-accept-btn-handler',
      '[class*="accept-all"]',
      '[class*="AcceptAll"]',
      'button:has-text("Accept All")',
      'button:has-text("Accept Cookies")',
      'button:has-text("I Accept")',
      'button:has-text("Agree")',
    ];
    for (const sel of consentSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); await page.waitForTimeout(1000); break; }
      } catch(e) {}
    }

    // Wait a bit more after dismissing consent
    await page.waitForTimeout(3000);

  } catch (e) {
    console.log(`  Timeout on round ${roundId} — trying anyway`);
  }

  let heats = [];

  if (apiData) {
    heats = parseWSLJSON(apiData);
    if (heats.length > 0 && !state.apiEndpoint) {
      state.apiEndpoint = apiUrl;
    }
  }

  // DOM fallback if no API data
  if (heats.length === 0) {
    heats = await domScrape(page);
  }

  await page.close();
  return heats;
}

// ── PARSE WSL JSON ────────────────────────────────────────────────
function parseWSLJSON(json) {
  function findHeats(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 8) return null;
    if (Array.isArray(obj)) {
      if (obj.length > 0 && (obj[0].athletes || obj[0].competitors || obj[0].heatNumber || obj[0].heatNum)) return obj;
      for (const item of obj) { const r = findHeats(item, depth+1); if (r) return r; }
    }
    for (const key of ['heats','Heats','heatResults','results','data','content','items','rounds']) {
      if (obj[key]) { const r = findHeats(obj[key], depth+1); if (r) return r; }
    }
    for (const val of Object.values(obj)) {
      if (typeof val === 'object') { const r = findHeats(val, depth+1); if (r) return r; }
    }
    return null;
  }

  const rawHeats = findHeats(json, 0);
  if (!rawHeats || !rawHeats.length) return [];

  return rawHeats.map((heat, i) => {
    const competitors = heat.athletes || heat.competitors || heat.surfers || heat.entries || [];
    const athletes = competitors.map(a => {
      const name = a.name || a.athleteName || a.surferName || `${a.firstName||''} ${a.lastName||''}`.trim() || '';
      const total = a.totalScore ?? a.score ?? a.total ?? a.combinedScore ?? '--';
      const w1 = a.waveScore1 ?? a.wave1Score ?? a.wave1 ?? (a.scores?.[0]) ?? '--';
      const w2 = a.waveScore2 ?? a.wave2Score ?? a.wave2 ?? (a.scores?.[1]) ?? '--';
      const place = a.place ?? a.rank ?? a.position ?? a.placeInHeat ?? '';
      const advanced = !!(a.advanced || a.winner || a.isWinner || place === 1 || place === '1' || a.status === 'ADVANCED' || a.status === 'WIN' || a.result === 'WIN');
      return { name, total: String(total), wave1: String(w1), wave2: String(w2), place: String(place), advanced };
    }).filter(a => a.name.trim().length > 2);

    return {
      heatNum: heat.heatNumber || heat.number || heat.heatNum || i + 1,
      label: heat.label || heat.heatLabel || `Heat ${i+1}`,
      athletes,
      status: heat.status || heat.heatStatus || '',
    };
  }).filter(h => h.athletes.length >= 2);
}

// ── DOM SCRAPE FALLBACK ────────────────────────────────────────────
async function domScrape(page) {
  return page.evaluate(() => {
    const heats = [];
    const containers = document.querySelectorAll('[class*="Heat"],[class*="heat"],[data-heat-id],[class*="HeatResult"]');
    containers.forEach((el, i) => {
      const athletes = [];
      el.querySelectorAll('[class*="Athlete"],[class*="athlete"],[class*="Competitor"],[class*="competitor"]').forEach(a => {
        const nameEl = a.querySelector('[class*="Name"],[class*="name"],[class*="AthleteName"]');
        const scoreEl = a.querySelector('[class*="Total"],[class*="total"],[class*="TotalScore"]');
        if (!nameEl) return;
        const name = nameEl.textContent.trim();
        const score = scoreEl?.textContent?.trim() || '--';
        const advanced = /advanc|winner|Win/i.test(a.className + (a.getAttribute('data-status')||''));
        if (name.length > 2) athletes.push({ name, total: score, wave1:'--', wave2:'--', place:'', advanced });
      });
      if (athletes.length >= 2) heats.push({ heatNum: i+1, label:`Heat ${i+1}`, athletes, status:'' });
    });
    return heats;
  });
}

// ── MAIN SCRAPE ───────────────────────────────────────────────────
async function scrape() {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] Scraping WSL...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const rounds = [];

  for (const roundId of CONFIG.roundIds) {
    const meta = ROUND_NAMES[roundId] || { code:'R?', name:`Round ${roundId}` };
    try {
      const heats = await scrapeRound(browser, roundId);
      if (heats.length > 0) {
        rounds.push({ ...meta, roundId, heats });
        const winners = heats.map(h => h.athletes.find(a=>a.advanced)?.name).filter(Boolean);
        console.log(`  ${meta.name}: ${heats.length} heats${winners.length ? ' | Winners: ' + winners.join(', ') : ''}`);
      } else {
        console.log(`  ${meta.name}: no data yet (event may not have started)`);
      }
    } catch(e) {
      console.log(`  ${meta.name}: error — ${e.message.split('\n')[0]}`);
    }
  }

  await browser.close();

  // Update live state
  state.scraped = new Date().toISOString();
  state.rounds = rounds;

  fs.writeFileSync('wsl-results.json', JSON.stringify(state, null, 2));
  console.log(`Done. ${rounds.length} rounds with data. Next refresh in ${CONFIG.refreshMinutes}min.\n`);
}

// ── START ─────────────────────────────────────────────────────────
(async () => {
  startServer();
  await scrape();
  setInterval(scrape, CONFIG.refreshMinutes * 60 * 1000);
})();
