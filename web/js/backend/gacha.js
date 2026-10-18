// 그림체 뽑기: random NovelAI V5 artist mixes from a pool — how many artists, their weights and their order all drawn
// at random, with chosen artists pinned in every mix (their weight random or fixed, their place free or first/last).
import { sanitizeTag, artistWeightsInPrompt, extractArtistNames, rnd, PROMPT_ARTIST_RE } from './core.js';

export const DEFAULT_CONFIG = {
  countMin: 3, countMax: 6,
  wMin: 0.5, wMax: 1.3, step: 0.1,
  pinRange: false, pinMin: 1.0, pinMax: 1.5,  // pinned artists may use their own range
  order: 'shuffle',  // shuffle | pinned-first | weight-desc | pool
  space: true,       // "1.2::artist:x ::" (as the PC app writes) or "1.2::artist:x::"
  omitOne: false,    // weight 1.0 written as the bare tag
  scale: 1.0,        // every weight times this, after drawing (e.g. 0.7 to move a mix from guidance 3.5 to 5)
  template: '{artist}',
  unique: true,      // never the same mix twice (this batch and the saved history)
  batch: 5,
  favor: 1,          // 선호 작가 반영: artists with a higher 점수 drawn more often (1 = off)
};

// Pool entries: { tag, state: 'free' | 'pin' | 'off', w: null | number (pinned: fixed weight), w0: weight it came with, pos: 'any' | 'first' | 'last' }
export function parsePool(text) {
  text = String(text || '');
  const out = [];
  const seen = new Set();
  const add = (raw, w0 = null) => {
    const tag = sanitizeTag(raw);
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    out.push({ tag, w0 });
  };
  if (text.includes('artist:')) {
    for (const [w, t] of artistWeightsInPrompt(text, PROMPT_ARTIST_RE, null)) add(t, w == null ? null : Math.round(w * 100) / 100);
  } else {
    for (const name of extractArtistNames(text)) add(name);
  }
  return out;
}

const decimals = (step) => (step < 0.1 - 1e-9 ? 2 : 1);
const snap = (w, step) => Math.round(w / step) * step;

function drawWeight(min, max, step) {
  const lo = Math.ceil(min / step - 1e-9), hi = Math.floor(max / step + 1e-9);
  if (hi < lo) return snap(min, step);
  return rnd.randint(lo, hi) * step;
}

export function formatPair(w, tag, cfg) {
  const d = decimals(cfg.step);
  const value = Number(w.toFixed(d));
  if (cfg.omitOne && Math.abs(value - 1) < 1e-9) return tag;
  return `${value.toFixed(d)}::${tag}${cfg.space ? ' ' : ''}::`;
}

export function mixText(pairs, cfg) {
  const style = pairs.map(([w, t]) => formatPair(w, t, cfg)).join(', ');
  const template = String(cfg.template ?? '').trim();
  if (!template) return style;
  if (template.includes('{artist}')) return template.split('{artist}').join(style);
  return [style, template].filter(Boolean).join(', ');
}

// One mix: [[weight, tag], ...] in its final order. pref: tag -> draw weight for the free artists (선호 작가 반영), or null.
export function drawMix(pool, cfg, pref = null) {
  const pinned = pool.filter((a) => a.state === 'pin');
  const free = pool.filter((a) => (a.state || 'free') === 'free');
  const nMin = Math.max(cfg.countMin, pinned.length);
  const nMax = Math.max(nMin, Math.min(Math.max(cfg.countMax, cfg.countMin), pinned.length + free.length));
  const n = Math.min(rnd.randint(nMin, nMax), pinned.length + free.length);
  const k = Math.max(0, n - pinned.length);
  const picked = [...pinned, ...(pref ? rnd.weightedSample(free, free.map((a) => pref[a.tag] ?? 1), k) : rnd.sample(free, k))];
  const step = cfg.step > 0 ? cfg.step : 0.1;
  const d = decimals(step);
  const weightOf = (a) => {
    let w;
    if (a.state === 'pin' && a.w != null && Number.isFinite(a.w)) w = a.w;
    else if (a.state === 'pin' && cfg.pinRange) w = drawWeight(cfg.pinMin, cfg.pinMax, step);
    else w = drawWeight(cfg.wMin, cfg.wMax, step);
    const scaled = w * (Number(cfg.scale) || 1);
    return Number(scaled.toFixed(d));
  };
  let items = picked.map((a) => ({ a, w: weightOf(a) }));
  if (cfg.order === 'shuffle') rnd.shuffle(items);
  else if (cfg.order === 'pinned-first') {
    const pins = items.filter((x) => x.a.state === 'pin');
    const rest = rnd.shuffle(items.filter((x) => x.a.state !== 'pin'));
    items = [...pins, ...rest];
  } else if (cfg.order === 'weight-desc') {
    rnd.shuffle(items);
    items.sort((x, y) => y.w - x.w);
  } else {
    const order = new Map(pool.map((a, i) => [a.tag, i]));
    items.sort((x, y) => order.get(x.a.tag) - order.get(y.a.tag));
  }
  const first = items.filter((x) => x.a.state === 'pin' && x.a.pos === 'first');
  const last = items.filter((x) => x.a.state === 'pin' && x.a.pos === 'last');
  const middle = items.filter((x) => !first.includes(x) && !last.includes(x));
  return [...first, ...middle, ...last].map((x) => [x.w, x.a.tag]);
}

// A batch of mixes, each new (not in ``avoid``: texts already drawn). Fewer when the pool cannot make more.
export function drawBatch(pool, cfg, count, avoid = new Set(), pref = null) {
  const out = [];
  const seen = new Set(cfg.unique ? avoid : []);
  for (let i = 0; i < count; i++) {
    let mix = null;
    for (let t = 0; t < 40; t++) {
      const pairs = drawMix(pool, cfg, pref);
      if (!pairs.length) break;
      const key = pairs.map(([w, tag]) => `${w}|${tag}`).join(',');
      if (!seen.has(key)) {
        seen.add(key);
        mix = { pairs, key };
        break;
      }
    }
    if (!mix) break;
    out.push({ ...mix, text: mixText(mix.pairs, cfg), style: mix.pairs.map(([w, t]) => formatPair(w, t, { ...cfg, omitOne: false, step: 0.1 })).join(', ') });
  }
  return out;
}

export function validate(pool, cfg) {
  const pinned = pool.filter((a) => a.state === 'pin').length;
  const usable = pool.filter((a) => a.state !== 'off').length;
  if (!usable) return '작가 풀에 작가를 넣어 주세요.';
  if (!(cfg.countMin >= 1) || !(cfg.countMax >= 1)) return '작가 수는 1명 이상이어야 합니다.';
  if (cfg.countMin > cfg.countMax) return '작가 수 범위를 확인해 주세요 (최소 ≤ 최대).';
  if (!(cfg.wMin > 0) || !(cfg.wMax > 0) || cfg.wMin > cfg.wMax) return '가중치 범위를 확인해 주세요 (0보다 크고 최소 ≤ 최대).';
  if (cfg.pinRange && (!(cfg.pinMin > 0) || cfg.pinMin > cfg.pinMax)) return '고정 작가 가중치 범위를 확인해 주세요.';
  if (!(cfg.scale > 0)) return '전체 배율은 0보다 커야 합니다.';
  if (pinned > cfg.countMax) return `고정 작가(${pinned}명)가 최대 작가 수(${cfg.countMax}명)보다 많습니다. 고정 작가는 항상 들어가므로 최대 작가 수를 늘려 주세요.`;
  return null;
}
