// Pure logic for NAI Style Lab: style strings, Elo, tiers, breeding and the ladder placement used by evolution
// selection and newcomer placement. A faithful port of app/core.py (v4.1.4) so data moves between the PC and the
// phone unchanged (same state.json, same numbers).

// ---------------------------------------------------------------- python-ish helpers
export function pyRound(x) {
  // Python's round(): halves go to the even neighbour.
  if (!Number.isFinite(x)) return x;
  const frac = Math.abs(x % 1);
  if (frac === 0.5) return 2 * Math.round(x / 2);
  return Math.round(x);
}
export const round1 = (x) => pyRound(x * 10) / 10;

export function pyFloat(text) {
  if (typeof text === 'number') return text;
  const t = String(text ?? '').trim().replace(/_/g, '');
  if (!t) return NaN;
  const low = t.toLowerCase();
  if (['inf', '+inf', 'infinity', '+infinity'].includes(low)) return Infinity;
  if (['-inf', '-infinity'].includes(low)) return -Infinity;
  if (low === 'nan') return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return NaN;
  return Number(t);
}

export const rnd = {
  randint: (a, b) => a + Math.floor(Math.random() * (b - a + 1)),
  uniform: (a, b) => a + (b - a) * Math.random(),
  choice: (arr) => arr[Math.floor(Math.random() * arr.length)],
  randrange: (n) => Math.floor(Math.random() * n),
  // random.choices(population, weights)[0]
  pick(arr, weights) {
    if (!weights) return rnd.choice(arr);
    const total = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
    if (!(total > 0)) return rnd.choice(arr);
    let r = Math.random() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i] > 0 ? weights[i] : 0;
      if (r < 0) return arr[i];
    }
    return arr[arr.length - 1];
  },
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },
  sample(arr, k) {
    const pool = arr.slice();
    rnd.shuffle(pool);
    return pool.slice(0, k);
  },
  // k items without replacement, each draw in proportion to its weight (선호 작가 반영).
  weightedSample(arr, weights, k) {
    const items = arr.map((x, i) => [x, weights[i]]);
    const out = [];
    while (out.length < k && items.length) {
      const i = rnd.pick(items.map((_, j) => j), items.map(([, w]) => w));
      out.push(items[i][0]);
      items.splice(i, 1);
    }
    return out;
  },
};

// Compare tuples the way Python does (numbers by value, strings by code point, booleans as 0/1).
export function cmpTuple(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    let x = a[i], y = b[i];
    if (typeof x === 'boolean') x = Number(x);
    if (typeof y === 'boolean') y = Number(y);
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}
export const sortBy = (arr, key, reverse = false) =>
  arr.slice().sort((a, b) => (reverse ? -1 : 1) * cmpTuple(key(a), key(b)));

export function bisectLeft(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function newId() {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!/^[1-9]\d*$/.test(id)) return id;  // never an integer-looking key (JS objects would reorder it)
  }
}

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- NovelAI
export const NAI_GEN_URL = 'https://image.novelai.net/ai/generate-image';
export const NAI_SUB_URL = 'https://image.novelai.net/user/subscription';
export const MODELS = ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full'];
export const SIZE_PRESETS = { '세로 832x1216': [832, 1216], '정방형 1024x1024': [1024, 1024], '가로 1216x832': [1216, 832] };

// What novelai.net itself sends (V5, no quality tags / UC preset, no Variety+), so a picture imported there comes out
// the same. Kept byte for byte as the PC version sends it.
export const WEB_PARAMS = {
  ucPresetId: 'none', qualityPresetId: 'none', autoSmea: false, dynamic_thresholding: false,
  controlnet_strength: 1, legacy: false, add_original_image: true, legacy_v3_extend: false,
  use_coords: false, normalize_reference_strength_multiple: true, inpaintImg2ImgStrength: 1,
  straight_alpha: true, tag_hint_qt: 0, tag_hint_uc_preset: 0, deliberate_euler_ancestral_bug: false,
  prefer_brownian: true, noise_schedule: 'karras',
};

export const DEFAULT_NEGATIVE = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, blurry, artistic error, bad proportions, logo, artist logo, comic, manga panel, panel, speech bubble, cover art, magazine cover, collage, text focus, english text, japanese text, multiple views';
export const DEFAULT_BASE_PROMPT = '{artist}, 1girl, solo, standing, simple background, upper body';

export const DEFAULT_ARTIST_TAGS = [
  'artist:chamooi', 'artist:channel_(caststation)', 'artist:cura', 'artist:for-u', 'artist:healthyman',
  'artist:hwansang', 'artist:ke-ta', 'artist:mignon', 'artist:mikan03_26', 'artist:momoko_(momopoco)',
  'artist:muchi_maro', 'artist:necomi', 'artist:ningen_mame', 'artist:omutatsu', 'artist:onineko',
  'artist:quasarcake', 'artist:rurudo', 'artist:shigure_ui', 'artist:shnva', 'artist:supernew',
  'artist:torino_aqua', 'artist:wanke', 'artist:zain',
];

export const RATING_SCALE = 10;
export const START_ELO = 1000 * RATING_SCALE;
export const ELO_K = 32 * RATING_SCALE;
export const PLACE_GAP = 48 * RATING_SCALE;

export const TIER_ORDER = ['S', 'A', 'B', 'C', 'D'];
export const TIER_CUTOFFS = { S: 0.1, A: 0.3, B: 0.7, C: 0.9, D: 1.0 };
export const TIER_MATCH_MULTIPLIER = { S: 1.0, A: 0.9, B: 0.6, C: 0.3, D: 0.1 };

export const SAMPLERS = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m', 'k_dpmpp_sde', 'k_dpmpp_2m_sde'];

export const MAX_SEED = 4294967295;
export const AUTH_ERROR_STATUSES = [401, 403];
export const RETRY_STATUSES = [429, 500, 502, 503, 504];
export const RETRY_DELAYS = [5, 15, 45];

export class NaiHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseSubscription(data) {
  if (!data || typeof data !== 'object' || !('tier' in data)) throw new Error('구독 정보를 읽지 못했습니다.');
  const tierNum = data.tier;
  const tierNames = { 0: 'Free', 1: 'Tablet', 2: 'Scroll', 3: 'Opus' };
  const tier = tierNames[tierNum] ?? `Tier ${tierNum}`;
  const perks = data.perks || {};
  const unlimited = Boolean(perks.unlimitedImageGenerations) || tierNum === 3;
  const usage = data.usage || {};
  const percent = usage && typeof usage === 'object' ? usage.percent : null;
  let remaining = null;
  if (typeof percent === 'number' && Number.isFinite(percent)) remaining = usage.isNegative ? 0 : Math.max(0, percent);
  const steps = data.trainingStepsLeft;
  let anlas = null;
  if (steps && typeof steps === 'object') {
    const fixed = steps.fixedTrainingStepsLeft, purchased = steps.purchasedTrainingSteps;
    if (Number.isInteger(fixed) && Number.isInteger(purchased)) anlas = fixed + purchased;
  }
  return { tier, tier_num: tierNum, unlimited, active: Boolean(data.active), remaining_percent: remaining, anlas };
}

export function estimateV5Images(percent, width, height, steps, model) {
  if (percent == null || !model.startsWith('nai-diffusion-5') || width <= 0 || height <= 0
      || width * height > 1024 * 1024 || !(steps >= 1 && steps <= 28)) return null;
  // Measured 2026-10-03 (Opus, V5 Full, 832x1216): a full bar is 1735 images at 23 steps, 1488 at 28.
  const perStep = (1 / 1488 - 1 / 1735) / (28 - 23);
  const fixed = 1 / 1735 - 23 * perStep;
  const capacity = Math.round(1e6 / ((fixed + perStep * steps) * (width * height) / (832 * 1216))) / 1e6;
  return [Math.floor(capacity * Math.max(0, percent) / 100), Math.floor(capacity)];
}

export function characterPromptParts(prompts, negatives = []) {
  if (!Array.isArray(prompts) || !Array.isArray(negatives)) throw new Error('캐릭터 프롬프트 형식이 올바르지 않습니다.');
  const out = [];
  for (let i = 0; i < prompts.length; i++) {
    const p = String(prompts[i] ?? '').trim();
    const n = String(negatives[i] ?? '').trim();
    if (p) out.push([p, n]);
  }
  return out;
}

export function buildPayload({ base_prompt, character_prompt, character_negative, negative, model, width, height, steps, cfg, sampler, cfg_rescale }, style, seed) {
  const base = String(base_prompt || '').trim();
  style = String(style || '').trim();
  let caption;
  if (!base.includes('{artist}')) caption = [style, base].filter(Boolean).join(', ');
  else if (style) caption = base.split('{artist}').join(style);
  else caption = base.replace(/\{artist\}/g, '').split(',').map((p) => p.trim()).filter(Boolean).join(', ');
  if (!caption) throw new Error('프롬프트가 비어 있습니다.');
  const chars = characterPromptParts(character_prompt || [], character_negative || []);
  const center = { x: 0.5, y: 0.5 };
  const parameters = {
    params_version: 4, width, height, scale: cfg, sampler, steps, seed, n_samples: 1, cfg_rescale, ...WEB_PARAMS,
    v4_prompt: { caption: { base_caption: caption, char_captions: chars.map(([c]) => ({ char_caption: c, centers: [center] })) },
      use_coords: false, use_order: true },
    v4_negative_prompt: { caption: { base_caption: negative, char_captions: chars.map(([, n]) => ({ char_caption: n, centers: [center] })) } },
    negative_prompt: negative,
    characterPrompts: chars.map(([c, n]) => ({ prompt: c, uc: n, center, enabled: true })),
  };
  return { input: caption, model, action: 'generate', parameters };
}

// ---------------------------------------------------------------- artists & style strings
export const defaultArtists = () => DEFAULT_ARTIST_TAGS.map((tag) => ({ tag, count: 0, arena_matches: 0, arena_wins: 0 }));

export function sanitizeTag(raw) {
  let name = String(raw ?? '').trim();
  if (name.startsWith('artist:')) name = name.slice('artist:'.length);
  name = name.replace(/\\/g, '').split(/\s+/).filter(Boolean).join('_');
  return name ? `artist:${name}` : null;
}

const looksLikeNumber = (token) => !Number.isNaN(pyFloat(token));

const WEIGHT_GROUP_SRC = String.raw`(-?(?:\d+\.?\d*|\.\d+))::([\s\S]*?)(?:::|$)`;
export const PROMPT_ARTIST_RE = /artist:[^:,{}\[\]|\n]+/g;
export const RANDOM_SLOT_RE = /__random__/g;

export function artistWeightsInPrompt(text, pattern = PROMPT_ARTIST_RE, bare = 1.0) {
  const found = [];
  let at = 0;
  const take = (chunk, weight) => {
    for (const t of chunk.match(new RegExp(pattern.source, 'g')) || []) if (t.trim() !== 'artist:') found.push([weight, t.trim()]);
  };
  const re = new RegExp(WEIGHT_GROUP_SRC, 'g');
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    take(text.slice(at, m.index), bare);
    const w = Number(m[1]);
    if (w > 0) take(m[2], w);
    at = m.index + m[0].length;
  }
  take(text.slice(at), bare);
  return found;
}

export const artistsInPrompt = (text) => artistWeightsInPrompt(text).map(([, t]) => t);

export function extractArtistNames(raw) {
  const names = [];
  for (const line of String(raw).split('\n')) {
    for (let chunk of line.split(',')) {
      chunk = chunk.trim();
      if (!chunk) continue;
      for (let token of chunk.split('::')) {
        token = token.trim();
        if (!token || looksLikeNumber(token)) continue;
        names.push(token);
      }
    }
  }
  return names;
}

export const artistsFromStyle = (style) => (String(style).match(/artist:[^:,]+/g) || []).map((t) => t.trim());

export function parseStyleCombo(style) {
  const items = [];
  for (let chunk of String(style).split(',')) {
    chunk = chunk.trim();
    if (!chunk) continue;
    const parts = chunk.split('::');
    if (parts.length >= 2) {
      let w = pyFloat(parts[0]);
      if (Number.isNaN(w)) w = 1.0;
      const tag = parts[1].trim();
      if (tag) items.push([w, tag]);
    } else if (chunk.startsWith('artist:')) {
      items.push([1.0, chunk]);
    }
  }
  return items;
}

// NovelAI weighting: "1.5::red scarf ::" — the closing "::" always follows a space.
export const weighted = (weight, tag) => `${weight.toFixed(1)}::${tag} ::`;
export const styleFromPairs = (pairs) => pairs.map(([w, t]) => weighted(w, t)).join(', ');

export function renameArtistInStyle(style, oldTag, newTag) {
  return style.replace(new RegExp(`(?<=::)${reEscape(oldTag)} ?(?=::)`, 'g'), `${newTag} `);
}

export function clampWeight(weight, minW, maxW) {
  const low = Math.ceil(minW * 10 - 1e-9) / 10, high = Math.floor(maxW * 10 + 1e-9) / 10;
  return Math.min(high, Math.max(low, round1(weight)));
}

// ---------------------------------------------------------------- Elo & tiers
export function calcElo(ra, rb, aWon, k = ELO_K) {
  const ea = 1 / (1 + 10 ** ((rb - ra) / (400 * RATING_SCALE)));
  const eb = 1 - ea;
  return [pyRound(ra + k * ((aWon ? 1 : 0) - ea)), pyRound(rb + k * ((aWon ? 0 : 1) - eb))];
}

export const confirmMatches = (poolSize) => pyRound(Math.log2(Math.max(poolSize, 2))) + 3;
export const tierConfirmed = (matches, poolSize) => matches >= confirmMatches(poolSize);
export const rankAmong = (elo, ascending) => ascending.length - bisectLeft(ascending, elo);
export const tierForPercentile = (p) => TIER_ORDER.find((t) => p <= TIER_CUTOFFS[t]) ?? TIER_ORDER.at(-1);

export function tierGrade(p) {
  const tier = tierForPercentile(p);
  const index = TIER_ORDER.indexOf(tier);
  const low = index ? TIER_CUTOFFS[TIER_ORDER[index - 1]] : 0;
  const third = (TIER_CUTOFFS[tier] - low) / 3;
  const pos = p - low;
  return tier + (pos <= third + 1e-12 ? '+' : pos <= 2 * third + 1e-12 ? '' : '-');
}

export const isRated = (c) => (c.matches || 0) >= 1 || Boolean(c.placed);

export const rankOrder = (combos) => sortBy([...combos], (c) =>
  [-c.elo, -(c.matches ? c.wins / c.matches : 0), -c.matches, c.created || 0, c.id]);

export function topTierCut(n) {
  for (let k = n; k >= 0; k--) if (n && k / n <= TIER_CUTOFFS.A) return k;
  return 0;
}

const exclude = (combos, ex) => combos.filter((c) => isRated(c) && !ex.has(c.id));

export function topTierIds(combos, ex = new Set()) {
  const rated = sortBy(exclude(combos, ex), (c) => [c.elo, c.id], true);
  return rated.slice(0, topTierCut(rated.length)).map((c) => c.id);
}

export const tieKey = (a, b, elo) => `${[a, b].sort().join('|')}@${elo}`;

export function boundaryTiePair(combos, ex = new Set(), skipped = new Set()) {
  const rated = sortBy(exclude(combos, ex), (c) => [c.elo], true);
  const cut = topTierCut(rated.length);
  if (!(cut > 0 && cut < rated.length) || rated[cut - 1].elo !== rated[cut].elo) return null;
  const elo = rated[cut].elo;
  const tied = rated.filter((c) => c.elo === elo).map((c) => c.id);
  for (let i = 0; i < tied.length; i++) for (const y of tied.slice(i + 1)) if (!skipped.has(tieKey(tied[i], y, elo))) return [tied[i], y];
  return null;
}

export function topTiePair(combos, ex = new Set(), skipped = new Set()) {
  const rated = sortBy(exclude(combos, ex), (c) => [c.elo], true);
  const top = rated.slice(0, topTierCut(rated.length));
  for (let i = 0; i < top.length; i++) {
    for (const y of top.slice(i + 1)) {
      if (top[i].elo === y.elo && !skipped.has(tieKey(top[i].id, y.id, top[i].elo))) return [top[i].id, y.id];
    }
  }
  return null;
}

// ---------------------------------------------------------------- breeding
export const BREED_MODES = ['mutate', 'crossover', 'random'];
export const BREED_WEIGHTS = [1, 1, 1];
const FAVOURITE_BOOST = 2;
const TOP_PARENT_BOOST = 2;
const MUTATE_WEIGHT_JITTER = 0.3;

// boost: how much more often the best-scored artist is drawn (the worst: 1/boost; no score yet: 1). Evolution uses 2, as the PC app.
export function artistPreference(scores, tags, boost = FAVOURITE_BOOST) {
  const top = Math.max(0, ...tags.map((t) => Math.abs(scores[t] || 0)));
  return Object.fromEntries(tags.map((t) => [t, top ? boost ** ((scores[t] || 0) / top) : 1.0]));
}

// 선호 작가 반영 levels (1 = off: every artist equally likely).
export const FAVOR_LEVELS = [[1, '끔'], [1.5, '약하게 (×1.5)'], [2, '보통 (×2)'], [3, '강하게 (×3)']];

export function pickParents(ranked) {
  const n = ranked.length;
  const weights = ranked.map((_, i) => TOP_PARENT_BOOST - (TOP_PARENT_BOOST - 1) * i / Math.max(n - 1, 1));
  const idx = ranked.map((_, i) => i);
  const first = rnd.pick(idx, weights);
  const rest = idx.filter((i) => i !== first);
  const second = rnd.pick(rest, rest.map((i) => weights[i]));
  return [ranked[first], ranked[second]];
}

export function breedWeightedStyle(styleA, styleB, artistTags, minTags, maxTags, minW, maxW, mode = 'mutate', parentCounts = {}, preference = {}) {
  const first = parseStyleCombo(styleA), second = parseStyleCombo(styleB);
  if (!first.length || !second.length || artistTags.length < minTags) throw new Error('자손 생성에 필요한 부모 또는 작가가 부족합니다.');
  maxTags = Math.min(maxTags, artistTags.length);
  const clamp = (w) => clampWeight(w, minW, maxW);
  const fresh = (used) => {
    const pool = artistTags.filter((t) => !used.has(t));
    return rnd.pick(pool, pool.map((t) => (preference[t] ?? 1.0) / (1 + (parentCounts[t] || 0))));
  };
  let pairs;
  if (mode === 'random') {
    pairs = [];
  } else if (mode === 'crossover') {
    const inherited = new Map(first.map(([w, t]) => [t, w]));
    for (const [w, t] of second) if (!inherited.has(t)) inherited.set(t, w);
    pairs = [...inherited].map(([t, w]) => [clamp(w), t]);
    rnd.shuffle(pairs);
    pairs = pairs.slice(0, rnd.randint(minTags, maxTags));
  } else {
    pairs = first.map(([w, t]) => [clamp(w + rnd.uniform(-MUTATE_WEIGHT_JITTER, MUTATE_WEIGHT_JITTER)), t]);
    rnd.shuffle(pairs);
    pairs = pairs.slice(0, maxTags);
    const times = rnd.randint(1, 3);
    for (let i = 0; i < times; i++) {
      const used = new Set(pairs.map(([, t]) => t));
      const canDraw = used.size < artistTags.length;
      const actions = [...(canDraw && pairs.length ? ['replace'] : []), ...(pairs.length > minTags ? ['remove'] : []),
        ...(canDraw && pairs.length < maxTags ? ['add'] : [])];
      if (!actions.length) break;
      const action = rnd.choice(actions);
      if (action === 'replace') pairs[rnd.randrange(pairs.length)] = [clamp(rnd.uniform(minW, maxW)), fresh(used)];
      else if (action === 'remove') pairs.splice(rnd.randrange(pairs.length), 1);
      else pairs.push([clamp(rnd.uniform(minW, maxW)), fresh(used)]);
    }
  }
  const target = mode === 'random' ? rnd.randint(minTags, maxTags) : minTags;
  const used = new Set(pairs.map(([, t]) => t));
  while (pairs.length < target) {
    const tag = fresh(used);
    used.add(tag);
    pairs.push([clamp(rnd.uniform(minW, maxW)), tag]);
  }
  return styleFromPairs(pairs);
}

// ---------------------------------------------------------------- evolution selection (ladder of frozen parents)
const batchVotes = (sel, history) => history.filter((v) => sel.batch_id && v.batch_id === sel.batch_id);

export function selectionScores(sel, history) {
  const scores = new Map(Object.entries(sel.parent_scores || {}).map(([k, v]) => [k, Number(v)]));
  if (!scores.size) return [new Map(), new Map()];
  const cutoff = Math.min(...scores.values());
  const children = new Set(sel.candidate_ids || []);
  for (const c of children) scores.set(c, cutoff);
  const counts = new Map([...children].map((c) => [c, 0]));
  for (let i = history.length - 1; i >= 0; i--) {
    const vote = history[i];
    if (vote.type !== 'selection_vote' || vote.batch_id !== sel.batch_id) continue;
    const pair = vote.pair || {};
    const a = pair.a, b = pair.b;
    if (!scores.has(a) || !scores.has(b) || ![a, b].includes(vote.winner_id)) continue;
    const [na, nb] = calcElo(scores.get(a), scores.get(b), vote.winner_id === a, 48 * RATING_SCALE);
    if (children.has(a)) { scores.set(a, na); counts.set(a, counts.get(a) + 1); }
    if (children.has(b)) { scores.set(b, nb); counts.set(b, counts.get(b) + 1); }
  }
  return [scores, counts];
}

export function applySelectionRatings(combos, sel, history) {
  const batch = sel.batch_id;
  const children = new Set(sel.candidate_ids || []);
  if (!batch || !children.size) return;
  const ranking = selectionRanking(sel, history);
  const { scores, counts } = ranking;
  const wins = new Map([...children].map((c) => [c, 0]));
  for (const vote of batchVotes(sel, history)) if (vote.type === 'selection_vote' && wins.has(vote.winner_id)) wins.set(vote.winner_id, wins.get(vote.winner_id) + 1);
  for (const combo of combos) {
    const key = combo.id;
    if (!children.has(key)) continue;
    const voted = counts.get(key) || 0;
    const judged = ranking.info.get(key).votes.length > 0;
    const target = { elo: judged ? pyRound(scores.get(key)) - START_ELO : 0, matches: voted, wins: voted ? wins.get(key) : 0 };
    let applied = combo.selection_applied || {};
    if (applied.batch_id !== batch) applied = {};
    for (const [field, value] of Object.entries(target)) combo[field] += value - (applied[field] || 0);
    combo.selection_applied = { batch_id: batch, ...target };
  }
}

const SELECTION_EXTRA_VOTES = 4;
const SELECTION_CUT_WINDOW = 3;

export function selectionVotes(sel, history) {
  const frozen = sel.parent_scores || {};
  const ladder = sortBy((sel.parent_ids || []).filter((k) => k in frozen), (k) => [frozen[k], k]);
  const rung = new Map(ladder.map((k, i) => [k, i]));
  const votes = new Map((sel.candidate_ids || []).map((c) => [c, []]));
  for (let i = history.length - 1; i >= 0; i--) {
    const vote = history[i];
    if (vote.batch_id !== sel.batch_id || !['selection_vote', 'selection_skip'].includes(vote.type)) continue;
    const pair = vote.pair || {};
    let child, parent;
    if (votes.has(pair.a) && rung.has(pair.b)) [child, parent] = [pair.a, pair.b];
    else if (votes.has(pair.b) && rung.has(pair.a)) [child, parent] = [pair.b, pair.a];
    else continue;
    let result;
    if (vote.type === 'selection_skip') result = 'tie';
    else if ([child, parent].includes(vote.winner_id)) result = vote.winner_id === child ? 'win' : 'loss';
    else continue;
    votes.get(child).push([rung.get(parent), result]);
  }
  return [ladder, votes];
}

function bisect(votes, n, climbTies = false) {
  let lo = 0, hi = n;
  for (const [k, result] of votes) {
    if (!(lo <= k && k < hi)) continue;
    if (result === 'win') lo = k + 1;
    else if (result === 'loss') hi = k;
    else if (climbTies) lo = k;
    else { lo = k; hi = k + 1; }
  }
  return [lo, hi];
}

function climbRung(votes, hi, tried) {
  if (votes.length && votes.at(-1)[1] === 'tie') {
    const above = votes.at(-1)[0] + 1;
    if (above < hi && !tried.has(above)) return above;
  }
  return null;
}

function bestSlots(votes, n) {
  const violations = (slot) => votes.filter(([k, r]) => (r === 'win' && slot <= k) || (r === 'loss' && slot > k)
    || (r === 'tie' && slot !== k && slot !== k + 1)).length;
  const costs = [];
  for (let s = 0; s <= n; s++) costs.push(violations(s));
  const min = Math.min(...costs);
  return costs.map((c, s) => [c, s]).filter(([c]) => c === min).map(([, s]) => s);
}

function nextRung(lo, hi, tried) {
  const open = [];
  for (let k = lo; k < hi; k++) if (!tried.has(k)) open.push(k);
  if (!open.length) return null;
  const target = lo === 0 ? lo : Math.floor((lo + hi) / 2);
  return sortBy(open, (k) => [Math.abs(k - target), k])[0];
}

function checkRung(best, slot, tried, n) {
  if (best.length > 1) {
    const open = [];
    for (let k = best[0]; k < best.at(-1); k++) if (!tried.has(k)) open.push(k);
    if (open.length) return open[Math.floor(open.length / 2)];
  }
  for (const win of [[slot + 1, slot + 2].filter((k) => k < n), [slot - 2, slot - 3].filter((k) => k >= 0)]) {
    if (win.length && !win.some((k) => tried.has(k))) return win[0];
  }
  return null;
}

export function selectionRanking(sel, historyAll) {
  const history = batchVotes(sel, historyAll);
  const [ladder, votes] = selectionVotes(sel, history);
  const n = ladder.length;
  const [elo, counts] = selectionScores(sel, history);
  const info = new Map();
  for (const [child, cv] of votes) {
    const tried = new Set(cv.map(([k]) => k));
    const [lo, hi] = bisect(cv, n, true);
    let rung = climbRung(cv, hi, tried);
    if (rung == null) rung = nextRung(lo, hi, tried);
    const best = rung != null ? [lo] : bestSlots(cv, n);
    info.set(child, { slot: best[Math.floor((best.length - 1) / 2)], best, rung, bisecting: rung != null, lo, hi, votes: cv, tried });
  }
  const batch = sel.batch_id;
  const h2h = new Map(), played = new Set();
  for (const vote of history) {
    const pair = vote.pair || {};
    if (vote.batch_id !== batch || !info.has(pair.a) || !info.has(pair.b)) continue;
    played.add([pair.a, pair.b].sort().join('|'));
    if (vote.type === 'selection_vote' && [pair.a, pair.b].includes(vote.winner_id)) h2h.set(vote.winner_id, (h2h.get(vote.winner_id) || 0) + 1);
  }
  const arrange = () => {
    const slots = new Map();
    for (const [child, ci] of info) {
      if (!slots.has(ci.slot)) slots.set(ci.slot, []);
      slots.get(ci.slot).push(child);
    }
    const ordered = [];
    for (let s = 0; s <= n; s++) {
      ordered.push(...sortBy(slots.get(s) || [], (k) => [h2h.get(k) || 0, elo.get(k) || 0, k]));
      if (s < n) ordered.push(ladder[s]);
    }
    return [slots, ordered];
  };
  const [slots, ascending] = arrange();
  if (![...info.values()].some((ci) => ci.bisecting)) {
    const cap = Math.ceil(Math.log2(n + 1)) + 1 + SELECTION_EXTRA_VOTES;
    const rank = new Map([...ascending].reverse().map((k, i) => [k, i + 1]));
    for (const [child, ci] of info) {
      if (ci.slot > 0 && ci.votes.length < cap && n - SELECTION_CUT_WINDOW < rank.get(child) && rank.get(child) <= n + SELECTION_CUT_WINDOW) {
        ci.rung = checkRung(ci.best, ci.slot, ci.tried, n);
      }
    }
  }
  const frozen = sel.parent_scores || {};
  const scores = new Map(ladder.map((k) => [k, frozen[k]]));
  for (const [slot, mates] of slots) {
    const levels = [...new Set(mates.map((k) => h2h.get(k) || 0))].sort((a, b) => a - b);
    let low, high;
    if (ladder.length) {
      low = slot ? frozen[ladder[slot - 1]] : frozen[ladder[0]] - PLACE_GAP;
      high = slot < n ? frozen[ladder[slot]] : frozen[ladder.at(-1)] + Math.floor(PLACE_GAP / 2) * (levels.length + 1);
    } else {
      low = START_ELO;
      high = START_ELO + Math.floor(PLACE_GAP / 2) * (levels.length + 1);
    }
    for (const k of mates) {
      const level = levels.indexOf(h2h.get(k) || 0) + 1;
      scores.set(k, pyRound(low + level * (high - low) / (levels.length + 1)));
    }
  }
  let boundaryPairs = [];
  const cut = ascending.length - n;
  if (![...info.values()].some((ci) => ci.rung != null) && cut > 0 && cut < ascending.length) {
    const below = ascending[cut - 1], above = ascending[cut];
    if (info.has(below) && info.has(above) && info.get(below).slot === info.get(above).slot) {
      const group = slots.get(info.get(below).slot);
      for (let i = 0; i < group.length; i++) for (const y of group.slice(i + 1)) {
        if (!played.has([group[i], y].sort().join('|'))) boundaryPairs.push([group[i], y]);
      }
    }
  }
  return { ladder, info, ascending, scores, counts, boundary_pairs: boundaryPairs };
}

export function selectionNextPair(sel, combos, history, ranking = null) {
  const byId = new Map(combos.map((c) => [c.id, c]));
  ranking ??= selectionRanking(sel, history);
  const { ladder } = ranking;
  const waiting = [];
  for (const [child, ci] of ranking.info) {
    if (ci.rung != null && byId.has(child) && byId.has(ladder[ci.rung])) waiting.push([ci.votes.length, child, ci.rung]);
  }
  if (waiting.length) {
    const [, child, k] = sortBy(waiting, (w) => w)[0];
    return [byId.get(child), byId.get(ladder[k])];
  }
  for (const [a, b] of ranking.boundary_pairs) if (byId.has(a) && byId.has(b)) return [byId.get(a), byId.get(b)];
  return null;
}

export function selectionRemainingMatches(sel, combos, history) {
  const ranking = selectionRanking(sel, history);
  if (!selectionNextPair(sel, combos, history, ranking)) return [0, 0];
  let lower = ranking.boundary_pairs.length, upper = lower;
  for (const ci of ranking.info.values()) {
    if (ci.bisecting) {
      lower += 1;
      upper += Math.ceil(Math.log2(ci.hi - ci.lo + 1)) + (ci.lo === 0 ? 1 : 0) + 2;
    } else if (ci.rung != null) {
      lower += 1;
      upper += 2;
    }
  }
  return [Math.max(1, lower), Math.max(1, lower, upper)];
}

// ---------------------------------------------------------------- newcomer placement
export function placementState(votes, ladderSize) {
  const [lo, hi] = bisect(votes, ladderSize, true);
  const tried = new Set(votes.map(([k]) => k));
  const climb = climbRung(votes, hi, tried);
  if (climb != null) return [lo, climb];
  const open = [];
  for (let k = lo; k < hi; k++) if (!tried.has(k)) open.push(k);
  if (open.length) {
    const middle = Math.floor((lo + hi) / 2);
    return [lo, sortBy(open, (k) => [Math.abs(k - middle), k])[0]];
  }
  const best = bestSlots(votes, ladderSize);
  return [best[Math.floor((best.length - 1) / 2)], null];
}

export function placementElo(slot, scores) {
  if (!scores.length) return START_ELO;
  if (slot <= 0) return pyRound(scores[0] - PLACE_GAP);
  if (slot >= scores.length) return pyRound(scores.at(-1) + PLACE_GAP);
  return pyRound((scores[slot - 1] + scores[slot]) / 2);
}

// ---------------------------------------------------------------- artist scores
const ARTIST_SCORE_PRIOR = 2.0;

export function artistScores(combos, sweeps = 60) {
  const rows = combos.filter(isRated).map((c) => [c.elo, parseStyleCombo(c.style)]);
  if (!rows.length) return {};
  const mean = rows.reduce((s, [e]) => s + e, 0) / rows.length;
  const residual = rows.map(([e]) => e - mean);
  const uses = new Map();
  rows.forEach(([, pairs], row) => {
    for (const [w, tag] of pairs) {
      if (!uses.has(tag)) uses.set(tag, []);
      uses.get(tag).push([row, w]);
    }
  });
  const score = new Map([...uses.keys()].map((t) => [t, 0]));
  for (let s = 0; s < sweeps; s++) {
    for (const [tag, hits] of uses) {
      const old = score.get(tag);
      let num = 0, den = ARTIST_SCORE_PRIOR;
      for (const [row, w] of hits) { num += w * (residual[row] + w * old); den += w * w; }
      const next = num / den;
      for (const [row, w] of hits) residual[row] -= w * (next - old);
      score.set(tag, next);
    }
  }
  return Object.fromEntries([...uses].map(([tag, hits]) => [tag, [pyRound(score.get(tag)), hits.length]]));
}

// ---------------------------------------------------------------- refine workbench
export function jitterWeights(pairs, jitter, minW, maxW, tries = 50) {
  for (let i = 0; i < tries; i++) {
    const moved = pairs.map(([w, t]) => [clampWeight(w + rnd.uniform(-jitter, jitter), minW, maxW), t]);
    if (moved.some(([n], j) => n !== pairs[j][0])) return moved;
  }
  const index = rnd.randrange(pairs.length);
  const [w, t] = pairs[index];
  const step = clampWeight(w + 0.1, minW, maxW) !== w ? 0.1 : -0.1;
  return [...pairs.slice(0, index), [clampWeight(w + step, minW, maxW), t], ...pairs.slice(index + 1)];
}

// ---------------------------------------------------------------- storage format
export const SCHEMA = 1;
const UPGRADES = {};
export class NewerDataError extends Error {}

export function upgradeState(data) {
  const schema = data.schema ?? 1;
  if (!Number.isInteger(schema) || schema < 1) throw new Error(`unknown data format: ${schema}`);
  if (schema > SCHEMA) throw new NewerDataError(String(schema));
  for (let step = schema; step < SCHEMA; step++) UPGRADES[step](data);
  data.schema = SCHEMA;
  return schema;
}

export const emptyState = () => ({
  schema: SCHEMA, artists: defaultArtists(), combinations: [], history: [], ui_state: {},
  selection: { generation: 1, candidate_ids: [], batch_id: null, retired: [], parent_ids: [], parent_scores: {}, log: [] },
  placement: null, improve: null, free_results: [],
});
