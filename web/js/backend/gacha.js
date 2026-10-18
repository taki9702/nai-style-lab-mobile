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
  mode: 'pool',      // pool: new mixes from the pool | base: variations of one chosen style (기준 그림체)
  // 기준 그림체 변형: how many base artists are swapped for pool artists, added, dropped; how far the kept weights move.
  vSwapMin: 1, vSwapMax: 2, vAddMin: 0, vAddMax: 1, vDropMin: 0, vDropMax: 1,
  vJitter: 0.1,         // kept artists' weights move by up to ± this (0: unchanged)
  vSwapWeight: 'keep',  // keep: a swapped-in artist takes the weight of the one it replaces | random: from the weight range
  vOrder: 'keep',       // keep: the base order (added artists go in at random places) | shuffle
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

// ---------------------------------------------------------------- 기준 그림체 변형
// base: { pairs: [[w, tag], ...], locked: [tag, ...] } — locked artists are never dropped, swapped or re-weighted.
const keyOf = (pairs) => pairs.map(([w, tag]) => `${w}|${tag}`).join(',');

export function drawVariant(base, pool, cfg, pref = null) {
  const step = cfg.step > 0 ? cfg.step : 0.1;
  const d = decimals(step);
  const locked = new Set(base.locked || []);
  const items = base.pairs.map(([w, t]) => ({ t, w, locked: locked.has(t), orig: true }));
  const range = (lo, hi) => rnd.randint(Math.max(0, Math.min(lo, hi)), Math.max(0, lo, hi));
  const changeable = () => items.filter((x) => !x.locked && x.orig);
  const pickNew = () => {
    const used = new Set(items.map((x) => x.t));
    const c = pool.filter((a) => (a.state || 'free') !== 'off' && !used.has(a.tag));
    if (!c.length) return null;
    return (pref ? rnd.pick(c, c.map((a) => pref[a.tag] ?? 1)) : rnd.choice(c)).tag;
  };
  // drop (never below one artist)
  let drop = Math.min(range(cfg.vDropMin, cfg.vDropMax), changeable().length, items.length - 1);
  while (drop-- > 0) items.splice(items.indexOf(rnd.choice(changeable())), 1);
  // swap
  let swap = Math.min(range(cfg.vSwapMin, cfg.vSwapMax), changeable().length);
  while (swap-- > 0) {
    const tag = pickNew();
    if (!tag) break;
    const x = rnd.choice(changeable());
    x.t = tag;
    x.orig = false;
    if (cfg.vSwapWeight === 'random') x.w = drawWeight(cfg.wMin, cfg.wMax, step);
  }
  // jitter the kept ones, in steps
  const j = Math.max(0, Number(cfg.vJitter) || 0);
  const k = Math.floor(j / step + 1e-9);
  if (k > 0) for (const x of items) if (!x.locked && x.orig) x.w = Math.min(5, Math.max(step, x.w + rnd.randint(-k, k) * step));
  // add
  let add = range(cfg.vAddMin, cfg.vAddMax);
  while (add-- > 0) {
    const tag = pickNew();
    if (!tag) break;
    const item = { t: tag, w: drawWeight(cfg.wMin, cfg.wMax, step), locked: false, orig: false };
    if (cfg.vOrder === 'shuffle') items.push(item);
    else items.splice(rnd.randint(0, items.length), 0, item);
  }
  if (cfg.vOrder === 'shuffle') rnd.shuffle(items);
  return items.map((x) => [Number(x.w.toFixed(d)), x.t]);
}

export function drawVariantBatch(base, pool, cfg, count, avoid = new Set(), pref = null) {
  const out = [];
  const d = decimals(cfg.step > 0 ? cfg.step : 0.1);
  const seen = new Set([...(cfg.unique ? avoid : []), keyOf(base.pairs.map(([w, t]) => [Number(w.toFixed(d)), t]))]);
  for (let i = 0; i < count; i++) {
    let mix = null;
    for (let t = 0; t < 60; t++) {
      const pairs = drawVariant(base, pool, cfg, pref);
      const key = keyOf(pairs);
      if (pairs.length && !seen.has(key)) { seen.add(key); mix = { pairs, key }; break; }
    }
    if (!mix) break;
    out.push({ ...mix, text: mixText(mix.pairs, cfg), style: mix.pairs.map(([w, t]) => formatPair(w, t, { ...cfg, omitOne: false, step: 0.1 })).join(', ') });
  }
  return out;
}

export function validateVariant(base, pool, cfg) {
  if (!base || !base.pairs?.length) return '기준 그림체를 먼저 골라 주세요.';
  const nums = ['vSwapMin', 'vSwapMax', 'vAddMin', 'vAddMax', 'vDropMin', 'vDropMax'].map((k) => Number(cfg[k]));
  if (nums.some((n) => !(n >= 0))) return '바꿔치기 · 추가 · 빼기 수는 0 이상이어야 합니다.';
  if (cfg.vSwapMin > cfg.vSwapMax || cfg.vAddMin > cfg.vAddMax || cfg.vDropMin > cfg.vDropMax) return '바꿔치기 · 추가 · 빼기 수의 범위를 확인해 주세요 (최소 ≤ 최대).';
  if (!(cfg.wMin > 0) || cfg.wMin > cfg.wMax) return '가중치 범위를 확인해 주세요 (0보다 크고 최소 ≤ 최대).';
  const locked = new Set(base.locked || []);
  const free = base.pairs.filter(([, t]) => !locked.has(t)).length;
  const inBase = new Set(base.pairs.map(([, t]) => t));
  const candidates = pool.filter((a) => (a.state || 'free') !== 'off' && !inBase.has(a.tag)).length;
  const swapsOrAdds = cfg.vSwapMax > 0 || cfg.vAddMax > 0;
  const jitters = Math.floor((Number(cfg.vJitter) || 0) / (cfg.step || 0.1) + 1e-9) > 0;
  if (!free && !(cfg.vAddMax > 0 && candidates)) return '기준 그림체의 작가가 모두 고정이라 바꿀 수 있는 것이 없습니다. 고정을 풀거나 추가 수를 늘려 주세요.';
  if (swapsOrAdds && !candidates && !jitters && !(cfg.vDropMax > 0)) return '바꿔 넣을 작가가 없습니다. 작가 풀에 작가를 넣어 주세요 (기준 그림체에 이미 있는 작가는 빼고 셉니다).';
  if (!swapsOrAdds && !jitters && !(cfg.vDropMax > 0)) return '바꿀 것이 없습니다. 바꿔치기 · 추가 · 빼기 수나 가중치 흔들기를 정해 주세요.';
  return null;
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
