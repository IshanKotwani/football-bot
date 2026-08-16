import "dotenv/config";

// football-data.org v4. Free tier: 12 competitions, 10 requests/minute, no card.
// Register at https://www.football-data.org/client/register
const BASE = "https://api.football-data.org/v4";
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;

/** With no token the tools are simply not offered, and the bot answers from memory. */
export const enabled = Boolean(TOKEN);

// Competition codes on the free tier, plus the names people actually type.
// The model is told the canonical names; this map catches everything else.
const COMPETITIONS = {
  PL: ["premier league", "epl", "english premier league", "england"],
  PD: ["la liga", "primera division", "laliga", "spain", "spanish league"],
  BL1: ["bundesliga", "german bundesliga", "germany"],
  SA: ["serie a", "italian serie a", "italy"],
  FL1: ["ligue 1", "french ligue 1", "france"],
  CL: ["champions league", "ucl", "uefa champions league"],
  DED: ["eredivisie", "netherlands", "dutch league"],
  PPL: ["primeira liga", "portugal", "portuguese league"],
  ELC: ["championship", "efl championship", "english championship"],
  BSA: ["brasileirao", "serie a brazil", "brazil"],
  EC: ["euros", "european championship", "euro"],
  WC: ["world cup", "fifa world cup"],
};

export const COMPETITION_NAMES = Object.keys(COMPETITIONS);

// Words people attach to a competition name that carry no meaning here.
// Order matters: a "league table" alternative would match before the league name
// itself, turning "premier league table" into "premier". Keep these single words.
const NOISE = /\b(the|table|tables|standings|fixtures|results|scorers|season|current)\b/g;

/**
 * Accepts "PL", "Premier League", "the premier league table" — code or null.
 *
 * Matching is exact after normalisation, deliberately. A loose substring test
 * mapped "Bundesliga 5" to BL1, and a silently wrong competition is far worse
 * than a null: on null the model is handed the valid list and retries correctly.
 */
function toCode(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const upper = raw.toUpperCase();
  if (COMPETITIONS[upper]) return upper;

  const needle = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const [code, aliases] of Object.entries(COMPETITIONS)) {
    if (aliases.includes(needle)) return code;
  }
  return null;
}

// Club-type tokens that carry no identifying information. "Real" is NOT here:
// it distinguishes Real Madrid, Real Sociedad and Real Betis from other clubs.
const CLUB_NOISE = /\b(fc|cf|afc|ac|as|sc|ssc|ss|cd|ud|sd|rc|rcd|bc|calcio|club|de|the)\b/g;

// Nicknames the API's own names never contain. Applied after normalisation.
const NICKNAMES = {
  spurs: "tottenham",
  gunners: "arsenal",
  wolves: "wolverhampton",
  atleti: "atletico madrid",
  psg: "paris saint germain",
  inter: "internazionale",
  juve: "juventus",
  united: "manchester united",
  city: "manchester city",
};

function normTeam(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // Barça -> Barca
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(CLUB_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Picks the best team match by score, never the first substring hit.
 *
 * "Barcelona" used to match RCD Espanyol *de Barcelona*, which sits earlier in
 * the list — the cross-city rival, which is about as wrong as an answer gets.
 * Exact matches must therefore outrank containment rather than merely tie.
 */
function matchTeam(teams, query) {
  let needle = normTeam(query);
  if (!needle) return null;
  needle = NICKNAMES[needle] ?? needle;

  let best = null;
  let bestScore = 0;

  for (const t of teams) {
    const name = normTeam(t.name ?? "");
    const short = normTeam(t.shortName ?? "");
    const tla = String(t.tla ?? "").toLowerCase();

    let score = 0;
    if (name === needle || short === needle || tla === needle) score = 4;
    else if (name.startsWith(needle) || short.startsWith(needle)) score = 3;
    else if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(short)) score = 2;
    else if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(name)) score = 1;

    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }

  return best;
}

// Cached because the rate limit is 10/minute and a league table does not move
// between two questions asked seconds apart.
const cache = new Map();

async function get(path, ttlMs) {
  const hit = cache.get(path);
  if (hit && hit.expires > Date.now()) return hit.data;

  const res = await fetch(`${BASE}${path}`, { headers: { "X-Auth-Token": TOKEN } });

  if (!res.ok) {
    // The API explains itself in a `message` field; prefer that to our guess.
    const detail = await res.json().catch(() => ({}));
    const why =
      detail.message ||
      (res.status === 429
        ? "Rate limit reached (10 requests/minute)."
        : res.status === 403
          ? "Not available on the free tier."
          : `HTTP ${res.status}`);
    throw new Error(`football-data.org: ${why}`);
  }

  const data = await res.json();
  cache.set(path, { data, expires: Date.now() + ttlMs });
  return data;
}

const MINUTE = 60_000;

/* ── The four operations, each returning a trimmed shape ───────────────────── */

async function standings({ competition }) {
  const code = toCode(competition);
  if (!code) return { error: `Unknown competition "${competition}". Available: ${COMPETITION_NAMES.join(", ")}` };

  const data = await get(`/competitions/${code}/standings`, 10 * MINUTE);
  const table = data.standings?.find((s) => s.type === "TOTAL")?.table ?? [];

  return {
    competition: data.competition?.name,
    season: `${data.season?.startDate?.slice(0, 4)}/${data.season?.endDate?.slice(0, 4)}`,
    matchday: data.season?.currentMatchday,
    table: table.map((r) => ({
      pos: r.position,
      team: r.team?.shortName || r.team?.name,
      played: r.playedGames,
      w: r.won,
      d: r.draw,
      l: r.lost,
      gd: r.goalDifference,
      pts: r.points,
    })),
  };
}

async function matches({ competition, when = "upcoming", limit = 10 }) {
  const code = toCode(competition);
  if (!code) return { error: `Unknown competition "${competition}". Available: ${COMPETITION_NAMES.join(", ")}` };

  const status = when === "recent" ? "FINISHED" : "SCHEDULED";
  const data = await get(`/competitions/${code}/matches?status=${status}`, 5 * MINUTE);

  let list = data.matches ?? [];
  // FINISHED comes back oldest-first, so the most recent results are at the end.
  if (status === "FINISHED") list = list.slice(-limit).reverse();
  else list = list.slice(0, limit);

  return {
    competition: data.competition?.name,
    when,
    matches: list.map((m) => ({
      date: m.utcDate?.slice(0, 10),
      home: m.homeTeam?.shortName || m.homeTeam?.name,
      away: m.awayTeam?.shortName || m.awayTeam?.name,
      score: m.score?.fullTime?.home == null ? null : `${m.score.fullTime.home}-${m.score.fullTime.away}`,
      status: m.status,
    })),
  };
}

async function scorers({ competition, limit = 10 }) {
  const code = toCode(competition);
  if (!code) return { error: `Unknown competition "${competition}". Available: ${COMPETITION_NAMES.join(", ")}` };

  const data = await get(`/competitions/${code}/scorers?limit=${Math.min(limit, 20)}`, 10 * MINUTE);
  return {
    competition: data.competition?.name,
    scorers: (data.scorers ?? []).map((s) => ({
      player: s.player?.name,
      team: s.team?.shortName || s.team?.name,
      goals: s.goals,
      assists: s.assists ?? undefined,
      penalties: s.penalties ?? undefined,
    })),
  };
}

async function squad({ competition, team }) {
  const code = toCode(competition);
  if (!code) return { error: `Unknown competition "${competition}". Available: ${COMPETITION_NAMES.join(", ")}` };
  if (!team) return { error: "A team name is required." };

  const data = await get(`/competitions/${code}/teams`, 60 * MINUTE);
  const found = matchTeam(data.teams ?? [], team);

  if (!found) {
    return {
      error: `No team matching "${team}" in that competition.`,
      available: (data.teams ?? []).map((t) => t.shortName || t.name),
    };
  }

  // No coach here, and none from /teams/{id} either: on the free tier every
  // field of the `coach` object comes back null. Verified against the live API,
  // so do not "fix" this by adding a second request — it returns the same nulls.
  return {
    team: found.name,
    founded: found.founded,
    venue: found.venue,
    note: "Manager/coach is not available on this data plan; answer that part from your own knowledge, with the usual caveat.",
    squad: (found.squad ?? []).map((p) => ({
      name: p.name,
      position: p.position,
      nationality: p.nationality,
    })),
  };
}

/* ── Tool surface exposed to the model ─────────────────────────────────────── */

const HANDLERS = { get_standings: standings, get_matches: matches, get_scorers: scorers, get_squad: squad };

const competitionParam = {
  type: "string",
  description: `Competition name or code. One of: ${COMPETITION_NAMES.join(", ")}, or a plain name like "Premier League" or "La Liga".`,
};

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_standings",
      description: "Current league table for a competition: positions, points, played, goal difference.",
      parameters: { type: "object", properties: { competition: competitionParam }, required: ["competition"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_matches",
      description: "Fixtures or recent results for a competition.",
      parameters: {
        type: "object",
        properties: {
          competition: competitionParam,
          when: { type: "string", enum: ["upcoming", "recent"], description: "Default upcoming." },
          limit: { type: "integer", description: "How many matches, default 10." },
        },
        required: ["competition"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_scorers",
      description: "Top scorers in a competition this season.",
      parameters: {
        type: "object",
        properties: { competition: competitionParam, limit: { type: "integer", description: "Default 10." } },
        required: ["competition"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_squad",
      description:
        "Current squad list, stadium and founding year for one team. Does NOT include the " +
        'manager — answer that from your own knowledge. Use this for "who plays for X", ' +
        '"is Y still at X", and "where do X play". If the user does not name a competition, ' +
        "infer the team's domestic league — Chelsea is Premier League, Barcelona is La Liga, " +
        "Bayern is Bundesliga, and so on.",
      parameters: {
        type: "object",
        properties: { competition: competitionParam, team: { type: "string", description: 'Team name, e.g. "Arsenal".' } },
        required: ["competition", "team"],
      },
    },
  },
];

/** Short phrase for the UI while a call is in flight. */
export function describe(name, args) {
  const comp = args?.competition ? String(args.competition) : "";
  switch (name) {
    case "get_standings": return `checking the ${comp} table`;
    case "get_matches": return `looking up ${comp} ${args?.when === "recent" ? "results" : "fixtures"}`;
    case "get_scorers": return `checking ${comp} top scorers`;
    case "get_squad": return `looking up the ${args?.team ?? ""} squad`;
    default: return "looking that up";
  }
}

/** Runs one tool call. Never throws — the model sees errors as data and can react. */
export async function run(name, argsJson) {
  const handler = HANDLERS[name];
  if (!handler) return { error: `Unknown tool "${name}".` };

  let args;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return { error: "Arguments were not valid JSON." };
  }

  try {
    return await handler(args);
  } catch (err) {
    console.error(`[football] ${name} failed:`, err.message);
    return { error: err.message };
  }
}
