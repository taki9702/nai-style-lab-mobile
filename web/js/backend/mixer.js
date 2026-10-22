// 프롬프트 섞기: whole style prompts read out of NovelAI PNGs (artists, quality tags and the undesired content), mixed
// into new ones. The scene and the character prompts are left out: they come from the app's own settings.
import { sanitizeTag, rnd, styleFromPairs } from './core.js';

export const DEFAULT_MIX_CONFIG = {
  srcMin: 2, srcMax: 3,       // how many pictures one mix draws from
  artistMin: 4, artistMax: 8, // artists in a mix (pinned ones count too)
  jitter: 0.1,                // each artist's weight moves by up to ± this (0: as in the picture)
  order: 'shuffle',           // shuffle | weight-desc | source
  quality: 'union',           // union: every chosen picture's quality tags (no repeats) | one: one picture's, whole
  negative: 'union',          // the same for the undesired content
  negApply: 'merge',          // when drawn in the app: merge with the settings' 네거티브 | replace it
  unique: true,
  batch: 5,
};

// ---------------------------------------------------------------- reading a prompt
// NovelAI weights: "1.2::a, b ::" (until the next "::"), and {a} ×1.05 / [a] ÷1.05 per bracket.
const W_OPEN = /^\s*(-?(?:\d+\.?\d*|\.\d+))::/;
const round2 = (x) => Math.round(x * 100) / 100;

// Tokens of one prompt text, each with its weight: [{ tag, w }], in order. Brackets become weights.
export function tokenize(text) {
  const out = [];
  let weight = null;  // inside a "w::" group
  let rest = String(text || '');
  while (rest.length) {
    const open = rest.match(W_OPEN);
    if (open && weight == null) {
      weight = Number(open[1]);
      rest = rest.slice(open[0].length);
      continue;
    }
    // up to the next comma, newline or "::"
    const m = rest.match(/^([\s\S]*?)(,|\n|::|$)/);
    const piece = m[1];
    const sep = m[2];
    rest = rest.slice(m[0].length);
    push(piece, weight);
    if (sep === '::') weight = null;
    if (!m[0].length) break;
  }
  return out;

  function push(raw, groupWeight) {
    let tag = raw.trim();
    if (!tag) return;
    let w = groupWeight ?? 1;
    // a "w::tag" written with no comma before it, inside a plain run
    const inner = tag.match(/^(-?(?:\d+\.?\d*|\.\d+))::(.*)$/);
    if (inner) { w = Number(inner[1]); tag = inner[2].trim(); }
    let guard = 0;
    while (guard++ < 10) {
      if (/^\{.*\}$/.test(tag)) { w *= 1.05; tag = tag.slice(1, -1).trim(); }
      else if (/^\[.*\]$/.test(tag)) { w /= 1.05; tag = tag.slice(1, -1).trim(); }
      else break;
    }
    tag = tag.replace(/^[{[]+|[}\]]+$/g, '').trim();
    if (!tag || /^-?(?:\d+\.?\d*|\.\d+)$/.test(tag)) return;
    if (tag.startsWith('artist:')) tag = sanitizeTag(tag) || tag;
    out.push({ tag, w: round2(w) });
  }
}

// Tags that set the look rather than the scene: quality, era, rendering, and the "censored" kind.
const QUALITY_RE = /(^|\s)(masterpiece|best quality|amazing quality|great quality|good quality|normal quality|high quality|very aesthetic|aesthetic|absurdres|highres|incredibly absurdres|lowres|newest|recent|early|mid|late|very awa|official art|game cg|year \d{4}|\d{4}s \(style\)|high complexity|depthness|no text|uncensored|censored|nsfw|sfw|flat colou?r|no lineart|lineart|monochrome|greyscale|sketch|watercolor|oil painting \(medium\)|painting \(medium\)|traditional media|anime coloring|anime screencap|cel shading|soft shading|best illustration|novel illustration|illustration|simple illustration|artist collaboration|ultra detailed|ultra-detailed|high detail|highly detailed|very detailed|extremely detailed|detailed[\w\s]*|[\w\s]*texture|silky skin|realistic|photorealistic|semi-realistic|2\.5d|3d|chromatic aberration|film grain|bloom|depth of field|blurry background|light particles|rim lighting|backlighting|dramatic lighting|cinematic lighting|soft lighting|vivid colors|pastel colors|muted colors|limited palette|colorful|high contrast|low contrast)(\s|$)/i;
// Undesired content that guards the drawing itself (quality, errors, marks) rather than the scene.
const NEG_STYLE_RE = /(bad|worst|low|lowres|quality|artifact|error|blurry|blur|jpeg|watermark|signature|username|logo|text|deformed|distorted|disfigured|mutat|extra |missing|fewer|cropped|ugly|displeasing|amateur|unfinished|incomplete|sketch|3d|realistic|blender|chromatic|scan|dither|halftone|screentone|multiple views|border|letterbox|framed|censor|chibi|anatomy|anatomical|proportion|unnatural|asymmetrical|cloudy|blank|negative space|variant set|4koma|2koma|official art|artist|oekaki|toon|reference|turnaround|upscaled|vertical|banding|noise|grain|motion blur|inadequate|deficient|subpar|poor|cheesy|unsatisfactory|amputee|long neck|digits|fingers|hands|limb|legs|arms|feet|face|eyes|nipples|nsfw|lineart|simple illustration|flat color|aesthetic|abstract|retro|old|early|oldest)/i;

const kindOfToken = (tag) => (tag.startsWith('artist:') ? 'artist' : QUALITY_RE.test(tag) ? 'quality' : 'scene');

// Blocks of a prompt: split where it has a blank line (how prompts are usually laid out: artists / quality / scene).
const blocksOf = (text) => String(text || '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

// What one block is for. Positive: 'style' (artists, with whatever else is in that block counted as style),
// 'quality' (mostly look tags) or 'scene'. Negative: 'neg-style' or 'neg-scene'.
function positiveRole(tokens) {
  const a = tokens.filter((t) => t.kind === 'artist').length;
  const q = tokens.filter((t) => t.kind === 'quality').length;
  const o = tokens.length - a - q;
  if (a && a >= o) return 'style';
  if (q && q >= o) return 'quality';
  return 'scene';
}
function negativeRole(tokens) {
  const s = tokens.filter((t) => NEG_STYLE_RE.test(t.tag)).length;
  return s / Math.max(1, tokens.length) >= 0.5 ? 'neg-style' : 'neg-scene';
}

// A NovelAI PNG's meta (novelaiMeta) → a source: its blocks with every tag's kind and state.
// state: 'use' (goes into mixes), 'pin' (in every mix), 'off' (left out). Scene blocks start off.
export function sourceFromMeta(meta, { name = '', thumb = null } = {}) {
  const caption = meta.v4_prompt?.caption;
  const positive = caption?.base_caption ?? meta.prompt ?? '';
  const negative = meta.v4_negative_prompt?.caption?.base_caption ?? meta.uc ?? '';
  const blocks = [];
  const posBlocks = blocksOf(positive);
  for (const text of posBlocks) {
    const tokens = tokenize(text).map((t) => ({ ...t, kind: kindOfToken(t.tag) }));
    if (!tokens.length) continue;
    let role = positiveRole(tokens);
    // A prompt written as one block: sort tag by tag instead.
    if (posBlocks.length === 1) role = 'mixed';
    for (const t of tokens) {
      if (t.kind === 'artist') t.state = 'use';
      else if (role === 'style' || role === 'quality') { t.kind = 'quality'; t.state = 'use'; }
      else if (role === 'mixed') { t.state = t.kind === 'quality' ? 'use' : 'off'; }
      else { t.kind = 'scene'; t.state = 'off'; }
    }
    blocks.push({ side: 'pos', role, tokens });
  }
  const negBlocks = blocksOf(negative);
  for (const text of negBlocks) {
    const tokens = tokenize(text).map((t) => ({ ...t, kind: 'neg' }));
    if (!tokens.length) continue;
    let role = negativeRole(tokens);
    if (negBlocks.length === 1) role = 'neg-mixed';
    for (const t of tokens) {
      const style = NEG_STYLE_RE.test(t.tag);
      t.state = role === 'neg-style' || (role === 'neg-mixed' && style) ? 'use' : 'off';
      if (role === 'neg-mixed') t.scene = !style;
    }
    blocks.push({ side: 'neg', role, tokens });
  }
  const settings = {
    model: String(meta.source || '').replace(/\s+[0-9A-F]{8}$/, ''), width: meta.width, height: meta.height, steps: meta.steps,
    cfg: meta.scale, cfg_rescale: meta.cfg_rescale, sampler: meta.sampler, seed: meta.seed,
  };
  return { id: newSourceId(), name: name || '그림', thumb, ratio: 1, blocks, settings, created: Date.now() };
}

let idSeq = 0;
const newSourceId = () => `s${Date.now().toString(36)}${(idSeq++).toString(36)}`;

// The source's tags by kind, as they go into mixes: [{ tag, w, pin }] (off ones left out, repeats merged).
export function sourceParts(src) {
  const parts = { artist: [], quality: [], neg: [] };
  const seen = { artist: new Set(), quality: new Set(), neg: new Set() };
  for (const b of src.blocks || []) {
    for (const t of b.tokens) {
      if (t.state === 'off') continue;
      const kind = t.kind === 'artist' ? 'artist' : t.kind === 'neg' ? 'neg' : t.kind === 'quality' ? 'quality' : null;
      if (!kind) continue;  // a scene tag the user turned on counts as quality
      const key = t.tag.toLowerCase();
      if (seen[kind].has(key)) continue;
      seen[kind].add(key);
      parts[kind].push({ tag: t.tag, w: t.w, pin: t.state === 'pin' });
    }
  }
  // scene tags switched on by hand ride with the quality tags
  for (const b of src.blocks || []) for (const t of b.tokens) {
    if (t.kind !== 'scene' || t.state === 'off') continue;
    const key = t.tag.toLowerCase();
    if (seen.quality.has(key)) continue;
    seen.quality.add(key);
    parts.quality.push({ tag: t.tag, w: t.w, pin: t.state === 'pin' });
  }
  return parts;
}

// ---------------------------------------------------------------- writing
const fmtW = (w) => {
  const r = round2(w);
  return Number.isInteger(r * 10) ? r.toFixed(1) : String(r);
};
export const tagText = ({ tag, w }) => (Math.abs(w - 1) < 1e-9 ? tag : `${fmtW(w)}::${tag} ::`);
export const tagsText = (list) => list.map(tagText).join(', ');

// ---------------------------------------------------------------- mixing
function mergeTags(lists) {
  // same tag in several pictures: the average weight, pinned if pinned in any
  const map = new Map();
  for (const list of lists) for (const t of list) {
    const key = t.tag.toLowerCase();
    const cur = map.get(key);
    if (cur) { cur.ws.push(t.w); cur.pin ||= t.pin; }
    else map.set(key, { tag: t.tag, ws: [t.w], pin: t.pin });
  }
  return [...map.values()].map((x) => ({ tag: x.tag, w: round2(x.ws.reduce((s, v) => s + v, 0) / x.ws.length), pin: x.pin, n: x.ws.length }));
}

function pickBlock(chosen, kind, mode) {
  const pins = mergeTags(chosen.map((s) => s.parts[kind].filter((t) => t.pin)));
  if (mode === 'one') {
    const one = rnd.pick(chosen, chosen.map((s) => s.ratio));
    const own = one.parts[kind].map((t) => ({ ...t }));
    const have = new Set(own.map((t) => t.tag.toLowerCase()));
    return [...own, ...pins.filter((p) => !have.has(p.tag.toLowerCase()))];
  }
  return mergeTags(chosen.map((s) => s.parts[kind]));
}

// One mix: { artists: [[w, tag]], quality: [{tag, w}], negative: [{tag, w}], from: [source ids] }.
export function drawMixture(sources, cfg) {
  const usable = sources.filter((s) => s.ratio > 0).map((s) => ({ ...s, parts: sourceParts(s) }))
    .filter((s) => s.parts.artist.length || s.parts.quality.length || s.parts.neg.length);
  if (!usable.length) return null;
  const lo = Math.max(1, Math.min(cfg.srcMin, usable.length)), hi = Math.max(lo, Math.min(cfg.srcMax, usable.length));
  const chosen = rnd.weightedSample(usable, usable.map((s) => s.ratio), rnd.randint(lo, hi));
  // artists: pinned ones from every usable picture, the rest drawn from the chosen pictures
  const pinned = mergeTags(usable.map((s) => s.parts.artist.filter((t) => t.pin)));
  const pinnedKeys = new Set(pinned.map((t) => t.tag));
  const candidates = mergeTags(chosen.map((s) => s.parts.artist.filter((t) => !t.pin))).filter((t) => !pinnedKeys.has(t.tag));
  const share = (t) => chosen.filter((s) => s.parts.artist.some((a) => a.tag === t.tag)).reduce((sum, s) => sum + s.ratio, 0);
  const total = pinned.length + candidates.length;
  const aLo = Math.min(Math.max(1, cfg.artistMin, pinned.length), total);
  const aHi = Math.min(Math.max(aLo, cfg.artistMax), total);
  const n = rnd.randint(aLo, aHi);
  const drawn = rnd.weightedSample(candidates, candidates.map(share), Math.max(0, n - pinned.length));
  const j = Math.max(0, Number(cfg.jitter) || 0);
  const steps = Math.round(j / 0.1);
  const weigh = (t) => {
    if (t.w <= 0 || !steps) return Math.round(t.w * 10) / 10;
    const w = t.w + rnd.randint(-steps, steps) * 0.1;
    return Math.round(Math.min(3, Math.max(0.1, w)) * 10) / 10;
  };
  let items = [...pinned.map((t) => ({ t, w: Math.round(t.w * 10) / 10, pin: true })), ...drawn.map((t) => ({ t, w: weigh(t), pin: false }))];
  if (cfg.order === 'shuffle') rnd.shuffle(items);
  else if (cfg.order === 'weight-desc') { rnd.shuffle(items); items.sort((a, b) => b.w - a.w); }
  else {
    const order = new Map();
    chosen.forEach((s, i) => s.parts.artist.forEach((a, k) => { if (!order.has(a.tag)) order.set(a.tag, i * 1000 + k); }));
    items.sort((a, b) => (order.get(a.t.tag) ?? 1e9) - (order.get(b.t.tag) ?? 1e9));
  }
  return {
    artists: items.map((x) => [x.w, x.t.tag]),
    quality: pickBlock(chosen, 'quality', cfg.quality).map(({ tag, w }) => ({ tag, w })),
    negative: pickBlock(chosen, 'neg', cfg.negative).map(({ tag, w }) => ({ tag, w })),
    from: chosen.map((s) => s.id),
  };
}

export const mixKey = (m) => [m.artists.map(([w, t]) => `${w}|${t}`).join(','), tagsText(m.quality), tagsText(m.negative)].join('\n');

// Texts of a mix: the artists the way the arena stores them, the quality tags, and both together.
export function mixTexts(m) {
  const style = styleFromPairs(m.artists);
  const extra = tagsText(m.quality);
  return { style, extra, prompt: [style, extra].filter(Boolean).join(', '), negative: tagsText(m.negative) };
}

export function drawMixtures(sources, cfg, count, avoid = new Set()) {
  const out = [];
  const seen = new Set(cfg.unique ? avoid : []);
  for (let i = 0; i < count; i++) {
    let found = null;
    for (let t = 0; t < 40; t++) {
      const m = drawMixture(sources, cfg);
      if (!m) break;
      const key = mixKey(m);
      if (!seen.has(key)) { seen.add(key); found = { ...m, key }; break; }
    }
    if (!found) break;
    out.push(found);
  }
  return out;
}

export function validateMix(sources, cfg) {
  const usable = sources.filter((s) => s.ratio > 0);
  if (!sources.length) return 'NovelAI PNG를 먼저 올려 주세요.';
  if (!usable.length) return '섞을 그림이 없습니다. 비율이 0보다 큰 그림이 하나 이상 있어야 합니다.';
  if (!(cfg.srcMin >= 1) || cfg.srcMin > cfg.srcMax) return '한 번에 섞을 그림 수의 범위를 확인해 주세요 (1 이상, 최소 ≤ 최대).';
  if (!(cfg.artistMin >= 1) || cfg.artistMin > cfg.artistMax) return '작가 수 범위를 확인해 주세요 (1 이상, 최소 ≤ 최대).';
  if (!usable.some((s) => sourceParts(s).artist.length)) return '쓸 수 있는 작가 태그가 없습니다. 그림의 작가 태그가 모두 빠져 있지 않은지 확인해 주세요.';
  return null;
}

