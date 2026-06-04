#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// WSL ATHLETE PROFILE SCRAPER + HTML UPDATER
// Scrapes official WSL athlete profiles and updates the fantasy app
//
// Setup (one time):
//   npm install playwright
//   npx playwright install chromium
//
// Run:
//   node wsl-athlete-updater.js
//
// This will:
//   1. Visit each surfer's WSL profile page
//   2. Extract stance, nationality, age, weight, height
//   3. Update tb-wsl-fantasy-bracket-selector.html with correct data
//   4. Save a backup before making changes
// ═══════════════════════════════════════════════════════════════

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── ALL SURFERS TO CHECK ──────────────────────────────────────────
// WSL athlete slug = lowercase name with hyphens
// Format: { name: 'App name', slug: 'wsl-url-slug', gender: 'men'|'women' }
const ATHLETES = [
  // MEN
  { name: 'Ethan Ewing',           slug: 'ethan-ewing',           gender: 'men' },
  { name: 'Gabriel Medina',        slug: 'gabriel-medina',        gender: 'men' },
  { name: 'George Pittar',         slug: 'george-pittar',         gender: 'men' },
  { name: 'Griffin Colapinto',     slug: 'griffin-colapinto',     gender: 'men' },
  { name: 'Italo Ferreira',        slug: 'italo-ferreira',        gender: 'men' },
  { name: 'Miguel Pupo',           slug: 'miguel-pupo',           gender: 'men' },
  { name: 'Samuel Pupo',           slug: 'samuel-pupo',           gender: 'men' },
  { name: 'Yago Dora',             slug: 'yago-dora',             gender: 'men' },
  { name: 'Alejo Muniz',           slug: 'alejo-muniz',           gender: 'men' },
  { name: 'Barron Mamiya',         slug: 'barron-mamiya',         gender: 'men' },
  { name: 'Callum Robson',         slug: 'callum-robson',         gender: 'men' },
  { name: 'Cole Houshmand',        slug: 'cole-houshmand',        gender: 'men' },
  { name: "Connor O'Leary",        slug: 'connor-oleary',         gender: 'men' },
  { name: 'Crosby Colapinto',      slug: 'crosby-colapinto',      gender: 'men' },
  { name: 'Filipe Toledo',         slug: 'filipe-toledo',         gender: 'men' },
  { name: 'Jack Robinson',         slug: 'jack-robinson',         gender: 'men' },
  { name: 'Jake Marshall',         slug: 'jake-marshall',         gender: 'men' },
  { name: 'Joao Chianca',          slug: 'joao-chianca',          gender: 'men' },
  { name: 'Joel Vaughan',          slug: 'joel-vaughan',          gender: 'men' },
  { name: 'Kanoa Igarashi',        slug: 'kanoa-igarashi',        gender: 'men' },
  { name: 'Kauli Vaast',           slug: 'kauli-vaast',           gender: 'men' },
  { name: 'Leonardo Fioravanti',   slug: 'leonardo-fioravanti',   gender: 'men' },
  { name: "Liam O'Brien",          slug: 'liam-obrien',           gender: 'men' },
  { name: 'Marco Mignot',          slug: 'marco-mignot',          gender: 'men' },
  { name: 'Mateus Herdy',          slug: 'mateus-herdy',          gender: 'men' },
  { name: 'Matt McGillivray',      slug: 'matt-mcgillivray',      gender: 'men' },
  { name: 'Morgan Cibilic',        slug: 'morgan-cibilic',        gender: 'men' },
  { name: 'Rio Waida',             slug: 'rio-waida',             gender: 'men' },
  { name: 'Ramzi Boukhiam',        slug: 'ramzi-boukhiam',        gender: 'men' },
  { name: 'Luke Thompson',         slug: 'luke-thompson',         gender: 'men' },
  { name: 'Eli Hanneman',          slug: 'eli-hanneman',          gender: 'men' },
  { name: 'Seth Moniz',            slug: 'seth-moniz',            gender: 'men' },
  { name: 'Oscar Berry',           slug: 'oscar-berry',           gender: 'men' },
  { name: 'Alan Cleland',          slug: 'alan-cleland',          gender: 'men' },
  { name: 'Cole Houshmand',        slug: 'cole-houshmand',        gender: 'men' },
  { name: "Connor O'Leary",        slug: 'connor-oleary',         gender: 'men' },
  { name: 'Liam O\'Brien',         slug: 'liam-obrien',           gender: 'men' },
  { name: 'Jack Robinson',         slug: 'jack-robinson',         gender: 'men' },

  // WOMEN
  { name: 'Bettylou Sakura Johnson', slug: 'bettylou-sakura-johnson', gender: 'women' },
  { name: 'Caitlin Simmers',       slug: 'caitlin-simmers',       gender: 'women' },
  { name: 'Carissa Moore',          slug: 'carissa-moore',         gender: 'women' },
  { name: 'Gabriela Bryan',         slug: 'gabriela-bryan',        gender: 'women' },
  { name: 'Lakey Peterson',         slug: 'lakey-peterson',        gender: 'women' },
  { name: 'Luana Silva',            slug: 'luana-silva',           gender: 'women' },
  { name: 'Molly Picklum',          slug: 'molly-picklum',         gender: 'women' },
  { name: 'Sawyer Lindblad',        slug: 'sawyer-lindblad',       gender: 'women' },
  { name: 'Alyssa Spencer',         slug: 'alyssa-spencer',        gender: 'women' },
  { name: 'Caroline Marks',         slug: 'caroline-marks',        gender: 'women' },
  { name: 'Erin Brooks',            slug: 'erin-brooks',           gender: 'women' },
  { name: 'Isabella Nichols',       slug: 'isabella-nichols',      gender: 'women' },
  { name: 'Nadia Erostarbe',        slug: 'nadia-erostarbe',       gender: 'women' },
  { name: 'Stephanie Gilmore',      slug: 'stephanie-gilmore',     gender: 'women' },
  { name: 'Tyler Wright',           slug: 'tyler-wright',          gender: 'women' },
  { name: 'Vahine Fierro',          slug: 'vahine-fierro',         gender: 'women' },
  { name: 'Anat Lelior',            slug: 'anat-lelior',           gender: 'women' },
  { name: 'Bella Kenworthy',        slug: 'bella-kenworthy',       gender: 'women' },
  { name: 'Brisa Hennessy',         slug: 'brisa-hennessy',        gender: 'women' },
  { name: 'Francisca Veselko',      slug: 'francisca-veselko',     gender: 'women' },
  { name: 'Kirra Pinkerton',        slug: 'kirra-pinkerton',       gender: 'women' },
  { name: 'Yolanda Hopkins',        slug: 'yolanda-hopkins',       gender: 'women' },
  { name: 'Sally Fitzgibbons',      slug: 'sally-fitzgibbons',     gender: 'women' },
  { name: 'Tya Zebrowski',          slug: 'tya-zebrowski',         gender: 'women' },
];

// Deduplicate
const seen = new Set();
const UNIQUE_ATHLETES = ATHLETES.filter(a => {
  if (seen.has(a.name)) return false;
  seen.add(a.name);
  return true;
});

// ── NAT CODE MAP (WSL country name → 3-letter code) ──────────────
const NAT_MAP = {
  'Australia': 'AUS', 'Brazil': 'BRA', 'USA': 'USA', 'United States': 'USA',
  'Hawaii': 'HAW', 'South Africa': 'RSA', 'France': 'FRA', 'Japan': 'JPN',
  'New Zealand': 'NZL', 'Portugal': 'POR', 'Spain': 'ESP', 'Italy': 'ITA',
  'Canada': 'CAN', 'Morocco': 'MAR', 'Indonesia': 'INA', 'Costa Rica': 'CRC',
  'El Salvador': 'SLV', 'Israel': 'ISR', 'Ireland': 'IRL', 'UK': 'GBR',
  'French Polynesia': 'PYF', 'Fiji': 'FJI', 'Argentina': 'ARG',
  'Chile': 'CHL', 'Peru': 'PER', 'Mexico': 'MEX', 'Uruguay': 'URY',
};

// ── SCRAPE ONE ATHLETE FROM WSL ────────────────────────────────────
async function scrapeAthlete(page, athlete) {
  const url = `https://www.worldsurfleague.com/athletes/tour/${athlete.slug}`;
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2000);

    const data = await page.evaluate(() => {
      const result = {};

      // Helper: find text near a label
      const findNear = (label) => {
        const els = document.querySelectorAll('*');
        for (const el of els) {
          if (el.children.length === 0 && el.textContent.trim().toLowerCase() === label.toLowerCase()) {
            // Look at siblings and nearby elements
            const next = el.nextElementSibling || el.parentElement?.nextElementSibling;
            if (next) return next.textContent.trim();
            const parent = el.parentElement;
            if (parent) {
              const siblings = [...parent.children];
              const idx = siblings.indexOf(el);
              if (siblings[idx + 1]) return siblings[idx + 1].textContent.trim();
            }
          }
        }
        return null;
      };

      // Try multiple selector strategies for each field
      
      // STANCE
      const stanceSelectors = [
        '[class*="Stance"] + *', '[class*="stance"] + *',
        '[class*="AthleteStat"] [class*="stance"]',
      ];
      for (const sel of stanceSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) { result.stance = el.textContent.trim(); break; }
        } catch(e) {}
      }
      if (!result.stance) result.stance = findNear('Stance');

      // AGE / DOB
      const ageSelectors = ['[class*="Age"] + *', '[class*="age"] + *', '[class*="Born"] + *'];
      for (const sel of ageSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) { result.age = el.textContent.trim(); break; }
        } catch(e) {}
      }
      if (!result.age) result.age = findNear('Age');

      // HEIGHT
      const heightSelectors = ['[class*="Height"] + *', '[class*="height"] + *'];
      for (const sel of heightSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) { result.height = el.textContent.trim(); break; }
        } catch(e) {}
      }
      if (!result.height) result.height = findNear('Height');

      // WEIGHT
      const weightSelectors = ['[class*="Weight"] + *', '[class*="weight"] + *'];
      for (const sel of weightSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) { result.weight = el.textContent.trim(); break; }
        } catch(e) {}
      }
      if (!result.weight) result.weight = findNear('Weight');

      // HOMETOWN / NATIONALITY
      const homeSelectors = ['[class*="Hometown"] + *', '[class*="hometown"] + *', '[class*="Country"] + *'];
      for (const sel of homeSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) { result.hometown = el.textContent.trim(); break; }
        } catch(e) {}
      }
      if (!result.hometown) result.hometown = findNear('Hometown');

      // Full page text scan as fallback
      const pageText = document.body.innerText;
      const lines = pageText.split('\n').map(l => l.trim()).filter(Boolean);
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase();
        const next = lines[i + 1] || '';
        
        if (line === 'stance' && !result.stance) result.stance = next;
        if ((line === 'age' || line === 'born') && !result.age) result.age = next;
        if (line === 'height' && !result.height) result.height = next;
        if (line === 'weight' && !result.weight) result.weight = next;
        if ((line === 'hometown' || line === 'from') && !result.hometown) result.hometown = next;
      }

      // Also get the nationality flag/country from the profile header
      const flagImg = document.querySelector('[class*="Flag"], [class*="flag"], img[alt*="flag"]');
      if (flagImg) result.flagAlt = flagImg.alt || flagImg.getAttribute('title') || '';

      return result;
    });

    return { ...athlete, ...data, url, ok: true };

  } catch (e) {
    return { ...athlete, error: e.message, ok: false };
  }
}

// ── PARSE SCRAPED DATA ─────────────────────────────────────────────
function parseAthlete(raw) {
  const result = { name: raw.name, gender: raw.gender };

  // Stance
  if (raw.stance) {
    const s = raw.stance.toLowerCase();
    if (s.includes('goofy')) result.stance = 'Goofy';
    else if (s.includes('regular') || s.includes('natural')) result.stance = 'Regular';
  }

  // Weight in kg
  if (raw.weight) {
    const lbsMatch = raw.weight.match(/(\d+)\s*lbs?/i);
    const kgMatch = raw.weight.match(/(\d+)\s*kg/i);
    if (kgMatch) result.weightKg = parseInt(kgMatch[1]);
    else if (lbsMatch) result.weightKg = Math.round(parseInt(lbsMatch[1]) * 0.453592);
  }

  // Age
  if (raw.age) {
    const ageMatch = raw.age.match(/\b(\d{2})\b/);
    if (ageMatch) result.age = parseInt(ageMatch[1]);
    // Also handle DOB format
    const dobMatch = raw.age.match(/(\w+)\s+(\d+),\s+(\d{4})/);
    if (dobMatch) {
      const year = parseInt(dobMatch[3]);
      result.age = new Date().getFullYear() - year;
    }
  }

  // Nationality from hometown
  if (raw.hometown || raw.flagAlt) {
    const text = (raw.flagAlt || raw.hometown || '').trim();
    for (const [country, code] of Object.entries(NAT_MAP)) {
      if (text.toLowerCase().includes(country.toLowerCase())) {
        result.nat = code;
        break;
      }
    }
  }

  return result;
}

// ── UPDATE THE HTML FILE ───────────────────────────────────────────
function updateHTML(htmlPath, athletes) {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const originalSize = html.length;
  let changes = 0;

  for (const athlete of athletes) {
    if (!athlete.stance && !athlete.nat && !athlete.weightKg && !athlete.age) continue;

    // Find the surfer's data entry in the HTML
    const nameSearch = `"${athlete.name}"`;
    let idx = html.indexOf(nameSearch);

    while (idx !== -1) {
      // Find the closing } of this data entry
      let depth = 0;
      let entryStart = idx;
      // Find the { that opens this entry
      let openBrace = html.lastIndexOf('{', idx);
      if (openBrace === -1) { idx = html.indexOf(nameSearch, idx + 1); continue; }
      
      let closePos = openBrace;
      depth = 0;
      for (let i = openBrace; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') {
          depth--;
          if (depth === 0) { closePos = i; break; }
        }
      }

      const entry = html.slice(openBrace, closePos + 1);

      // Only update if this looks like a surfer data entry (has fp: or seed: or nat:)
      if (!entry.includes('fp:') && !entry.includes('seed:') && !entry.includes('nat:')) {
        idx = html.indexOf(nameSearch, idx + 1);
        continue;
      }

      let newEntry = entry;
      let entryChanged = false;

      // Update stance
      if (athlete.stance) {
        const stanceReg = /st:"(Regular|Goofy)"/;
        if (stanceReg.test(newEntry)) {
          const currentStance = newEntry.match(stanceReg)?.[1];
          if (currentStance !== athlete.stance) {
            newEntry = newEntry.replace(stanceReg, `st:"${athlete.stance}"`);
            console.log(`  ✓ ${athlete.name}: stance ${currentStance} → ${athlete.stance}`);
            entryChanged = true;
          }
        } else if (!newEntry.includes('st:')) {
          // Add stance field
          newEntry = newEntry.slice(0, -1) + `,st:"${athlete.stance}"}`;
          console.log(`  + ${athlete.name}: added stance ${athlete.stance}`);
          entryChanged = true;
        }
      }

      // Update nationality
      if (athlete.nat) {
        const natReg = /nat:"([A-Z]{2,4})"/;
        const currentNat = newEntry.match(natReg)?.[1];
        if (currentNat && currentNat !== athlete.nat) {
          newEntry = newEntry.replace(natReg, `nat:"${athlete.nat}"`);
          console.log(`  ✓ ${athlete.name}: nat ${currentNat} → ${athlete.nat}`);
          entryChanged = true;
        }
      }

      if (entryChanged) {
        html = html.slice(0, openBrace) + newEntry + html.slice(closePos + 1);
        changes++;
      }

      // Only update first occurrence per surfer
      break;
    }
  }

  return { html, changes };
}

// ── MAIN ───────────────────────────────────────────────────────────
(async () => {
  const htmlFile = 'index.html';
  const altFile = 'tb-wsl-fantasy-bracket-selector.html';
  const target = fs.existsSync(htmlFile) ? htmlFile : fs.existsSync(altFile) ? altFile : null;

  if (!target) {
    console.error('ERROR: Cannot find index.html or tb-wsl-fantasy-bracket-selector.html');
    console.error('Make sure you run this script from the same folder as your HTML file.');
    process.exit(1);
  }

  console.log(`\nWSL Athlete Updater`);
  console.log(`Target file: ${target}`);
  console.log(`Athletes to check: ${UNIQUE_ATHLETES.length}\n`);

  // Backup
  const backup = target.replace('.html', `-backup-${Date.now()}.html`);
  fs.copyFileSync(target, backup);
  console.log(`Backup saved: ${backup}\n`);

  // Launch browser
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Pre-accept cookies
  await page.context().addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date().toISOString(), domain: '.worldsurfleague.com', path: '/' },
    { name: 'OptanonConsent', value: 'isGpcEnabled=0&interactionCount=1&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1', domain: '.worldsurfleague.com', path: '/' },
  ]);

  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Scrape each athlete
  const scraped = [];
  for (const athlete of UNIQUE_ATHLETES) {
    process.stdout.write(`Checking ${athlete.name}...`);
    const raw = await scrapeAthlete(page, athlete);
    const parsed = parseAthlete(raw);
    scraped.push(parsed);

    if (raw.ok) {
      const info = [parsed.stance, parsed.nat, parsed.weightKg ? parsed.weightKg+'kg' : null, parsed.age ? 'age '+parsed.age : null].filter(Boolean);
      console.log(` ${info.length ? info.join(' · ') : 'no data found'}`);
    } else {
      console.log(` FAILED: ${raw.error?.split('\n')[0]}`);
    }

    // Small delay to be respectful
    await page.waitForTimeout(800);
  }

  await browser.close();

  // Save raw scraped data for reference
  fs.writeFileSync('wsl-athlete-data.json', JSON.stringify(scraped, null, 2));
  console.log(`\nRaw data saved: wsl-athlete-data.json`);

  // Update HTML
  console.log(`\nUpdating ${target}...`);
  const { html, changes } = updateHTML(target, scraped);

  if (changes > 0) {
    fs.writeFileSync(target, html);
    console.log(`\nDone — ${changes} fields updated in ${target}`);
    console.log(`Backup is at: ${backup}`);
    console.log(`\nUpload the updated ${target} to GitHub to go live.`);
  } else {
    console.log(`\nNo changes needed — all data already correct.`);
    fs.unlinkSync(backup); // Remove backup if nothing changed
  }

  // Print summary of what was found
  console.log('\n── ATHLETE DATA SUMMARY ──');
  scraped.filter(a => a.stance || a.nat).forEach(a => {
    console.log(`${a.name}: ${[a.stance, a.nat, a.weightKg ? a.weightKg+'kg' : null].filter(Boolean).join(' | ')}`);
  });

})();
