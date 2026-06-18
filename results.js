const WSL_RESULTS_URL =
  'https://www.worldsurfleague.com/events/2026/ct/440/vivo-rio-pro/results';

function decode(value) {
  return String(value || '')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function roundKey(roundName, gender, roundNumber) {
  const name = String(roundName || '').toLowerCase();
  const isWomen = String(gender || '').toLowerCase().includes('women');
  let key = `R${roundNumber || 1}`;

  if (name.includes('opening')) key = 'R1';
  else if (name.includes('elimination')) key = 'R2';
  else if (name.includes('round of 16')) key = 'R3';
  else if (name.includes('quarter')) key = 'QF';
  else if (name.includes('semi')) key = 'SF';
  else if (name.includes('final')) key = 'FINAL';

  return isWomen && key !== 'FINAL' ? `W${key}` : isWomen ? 'WFINAL' : key;
}

function parseHeats(html) {
  const blocks = [
    ...html.matchAll(
      /<div\s+class="post-event-watch-heat-bracket-stage__heat[\s\S]*?(?=<div\s+class="post-event-watch-heat-bracket-stage__heat|\n\s*<\/div>\s*<\/div>\s*<\/div>\s*<div class="bracket-stage-round|<style class="post-event-watch-athletes-css")/g
    ),
  ].map((match) => match[0]);

  const seen = new Set();
  const heats = [];

  for (const block of blocks) {
    const id = block.match(/data-heat-id="([^"]+)"/)?.[1] || '';
    const heatNum = block.match(/data-heat-number="([^"]+)"/)?.[1] || '';
    const roundNumber = block.match(/data-round-number="([^"]+)"/)?.[1] || '';
    const status =
      block.match(/post-event-watch-heat-bracket-stage__heat--status-([a-z-]+)/)?.[1] ||
      '';
    const heatName = decode(block.match(/<span class="heat-name">([\s\S]*?)<\/span>/)?.[1]);
    const details = block.match(/data-gtm-event='([^']+)'/)?.[1] || '';
    const athleteNames = decode(details.match(/"athlete-names":"([^"]*)"/)?.[1]);
    const roundName = decode(details.match(/"round_names":"([^"]*)"/)?.[1]) || heatName;
    const gender = decode(details.match(/"tour_genders":"([^"]*)"/)?.[1]);
    const scores = [...block.matchAll(/hot-heat-athlete__score">([\s\S]*?)<\/div>/g)].map(
      (match) => decode(match[1])
    );
    const names = [...block.matchAll(/hot-heat-athlete__name--short">([\s\S]*?)<\/div>/g)].map(
      (match) => decode(match[1])
    );
    const classes = [...block.matchAll(/<div\s+class="([^"]*hot-heat-athlete[^"]*)"[^>]*>/g)].map(
      (match) => match[1]
    );

    const athletes = names.map((name, index) => {
      const css = classes[index] || '';
      const total = scores[index] || '--';
      return {
        name,
        total,
        score: total,
        advanced: /advance-winner/.test(css),
        eliminated: /eliminated/.test(css),
      };
    });

    if (!id || !heatName || !athletes.length) continue;
    const key = `${id}|${heatName}|${athletes.map((a) => a.name).join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    heats.push({
      id,
      heatNum: Number(heatNum) || heatNum,
      heatNumber: heatNum,
      roundNumber,
      roundName,
      round: roundKey(roundName, gender, roundNumber),
      gender: String(gender || '').toLowerCase().includes('women') ? 'women' : 'men',
      status,
      athleteNames,
      athletes,
    });
  }

  return heats;
}

function groupRounds(heats) {
  const map = new Map();
  for (const heat of heats) {
    const id = `${heat.gender}|${heat.round}|${heat.roundName}`;
    if (!map.has(id)) {
      map.set(id, {
        gender: heat.gender,
        round: heat.round,
        roundName: heat.roundName,
        heats: [],
      });
    }
    map.get(id).heats.push(heat);
  }

  return [...map.values()].map((round) => ({
    ...round,
    heats: round.heats.sort((a, b) => Number(a.heatNum || 0) - Number(b.heatNum || 0)),
  }));
}

function namesByState(heats, field) {
  return [
    ...new Set(
      heats.flatMap((heat) =>
        heat.athletes.filter((athlete) => athlete[field]).map((athlete) => athlete.name)
      )
    ),
  ];
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    const response = await fetch(`${WSL_RESULTS_URL}?cb=${Date.now()}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; WSLFantasyBracketSelector/1.0; +https://wsl-bracket-selector.vercel.app)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      throw new Error(`WSL responded with ${response.status}`);
    }

    const html = await response.text();
    const heats = parseHeats(html);
    const rounds = groupRounds(heats);

    res.status(200).json({
      eventName: 'Vivo Rio Pro',
      eventLocation: 'Saquarema, Rio de Janeiro, Brazil',
      eventId: 440,
      source: WSL_RESULTS_URL,
      eventStatus: heats.some((heat) => heat.status === 'live')
        ? 'Live'
        : heats.some((heat) => heat.athletes.some((athlete) => athlete.total !== '--'))
          ? 'Results updating'
          : 'Picks open / awaiting results',
      scraped: new Date().toISOString(),
      advancing: namesByState(heats, 'advanced'),
      eliminated: namesByState(heats, 'eliminated'),
      heatCount: heats.length,
      rounds,
    });
  } catch (error) {
    res.status(502).json({
      eventName: 'Vivo Rio Pro',
      eventLocation: 'Saquarema, Rio de Janeiro, Brazil',
      eventId: 440,
      source: WSL_RESULTS_URL,
      eventStatus: 'WSL sync unavailable',
      scraped: new Date().toISOString(),
      error: error.message,
      advancing: [],
      eliminated: [],
      heatCount: 0,
      rounds: [],
    });
  }
};
