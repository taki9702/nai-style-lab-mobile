// State, workflow and background jobs for NAI Style Lab — a port of app/engine.py (v4.1.4).
// Everything the pages can do goes through Engine. JavaScript runs one thing at a time, so the PC version's lock
// becomes "no await inside a change"; a generation job is an async loop that only waits for NovelAI and its delay.
import * as core from './core.js';
import { generateImage, fetchUserData } from './nai.js';
import { ZipWriter, zipEntries, readEntry, textBytes, bytesText, crc32 } from './zip.js';

export const STAGES = ['준비', '순위 결정', '진화', '다듬기', '완성'];
export const ARENA_MODES = ['auto', 'league', 'top'];
const IMPROVE_JITTER_START = 0.3;
const IMPROVE_JITTER_MIN = 0.1;
const IMPROVE_JITTER_STEP = 0.1;
export const FINAL_CHECK_SEEDS = 3;
export const CONVERGED_GENERATIONS = 2;
export const MIN_RATED_FOR_EVOLUTION = 10;
const COMBO_KEYS = ['id', 'style', 'elo', 'matches', 'wins'];
const MAX_FAILURE_STREAK = 3;
const DRAW_TRIES = 30;
const UNDO_LIMIT = 30;
const EVENT_LIMIT = 60;

export const SETTING_DEFAULTS = {
  model: core.MODELS[0], size: Object.keys(core.SIZE_PRESETS)[0], sampler: core.SAMPLERS[0],
  steps: 28, cfg: 5.0, cfg_rescale: 0.0, delay: 1.0, seed: '',
  global_min_w: 0.8, global_max_w: 1.8, gen_min: 4, gen_max: 8,
  gen_count: 50, evo_count: 20, improve_variants: 4,
  base_prompt: core.DEFAULT_BASE_PROMPT, character_prompt: [], negative: core.DEFAULT_NEGATIVE,
  character_negative: [],
  arena_mode: 'auto', arena_blind: false,
  prompt_checked: false, artists_checked: false,
  favor_boost: 1,  // 선호 작가 반영 in 무작위 조합 (1 = off, as the PC app)
};
const SETTING_TYPES = {
  model: 'str', size: 'str', sampler: 'str', steps: 'int', cfg: 'float', cfg_rescale: 'float', delay: 'float', seed: 'str',
  global_min_w: 'float', global_max_w: 'float', gen_min: 'int', gen_max: 'int', gen_count: 'int', evo_count: 'int',
  improve_variants: 'int', base_prompt: 'str', character_prompt: 'list', negative: 'str', character_negative: 'list',
  arena_mode: 'str', arena_blind: 'bool', prompt_checked: 'bool', artists_checked: 'bool', favor_boost: 'float',
};
const PROMPT_KEYS = ['base_prompt', 'character_prompt', 'negative', 'character_negative'];
export const SETTING_RANGES = {
  steps: ['Steps', 1, 50], cfg: ['CFG', 0, 20], cfg_rescale: ['CFG Rescale', 0, 1],
  delay: ['생성 간 대기', 0, 30], global_min_w: ['최소 가중치', 0.1, 3], global_max_w: ['최대 가중치', 0.1, 3],
  gen_min: ['조합당 최소 작가 수', 1, 20], gen_max: ['조합당 최대 작가 수', 1, 20],
  gen_count: ['무작위 조합 기본 개수', 1, 200], evo_count: ['진화 조합 수', 1, 60],
  improve_variants: ['다듬기 라운드당 변형', 2, 12], favor_boost: ['선호 작가 반영', 1, 4],
};
const SETTING_CHOICES = { model: core.MODELS, size: Object.keys(core.SIZE_PRESETS), sampler: core.SAMPLERS, arena_mode: ARENA_MODES };

export class UserError extends Error {}

const now = () => {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};
const nextJitter = (j) => Math.max(IMPROVE_JITTER_MIN, core.round1(j - IMPROVE_JITTER_STEP));
function jitterSchedule() {
  const steps = core.pyRound((IMPROVE_JITTER_START - IMPROVE_JITTER_MIN) / IMPROVE_JITTER_STEP);
  return Array.from({ length: steps + 1 }, (_, i) => core.round1(IMPROVE_JITTER_START - i * IMPROVE_JITTER_STEP));
}
const clone = (v) => structuredClone(v);
const kindName = (k) => k;

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

function convert(kind, value) {
  if (kind === 'bool') {
    if (typeof value !== 'boolean') throw new TypeError();
    return value;
  }
  if (kind === 'list') {
    if (!Array.isArray(value)) throw new TypeError();
    return value.map((v) => String(v));
  }
  if (kind === 'str') return value == null ? 'None' : String(value);
  if (kind === 'int') {
    if (typeof value === 'boolean') return Number(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError();
      return Math.trunc(value);
    }
    if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) return parseInt(value, 10);
    throw new TypeError();
  }
  // float
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'number') return value;
  const f = core.pyFloat(value);
  if (Number.isNaN(f) && String(value).trim().toLowerCase() !== 'nan') throw new TypeError();
  return f;
}

export class Engine {
  static async create(storage, { generate, fetchSubscription, autoSubscription = true } = {}) {
    const engine = new Engine(storage, { generate, fetchSubscription, autoSubscription });
    await engine.load();
    return engine;
  }

  constructor(storage, { generate, fetchSubscription, autoSubscription }) {
    this.storage = storage;
    this.images = storage.images;
    this._generateOnce = generate || generateImage;
    this._fetchSubscription = fetchSubscription || fetchUserData;
    this.autoSubscription = autoSubscription;
    this.events = [];
    this.eventId = 0;
    this.job = null;
    this.stopped = false;
    this.wakers = new Set();
    this.current = null;
    this.lastPair = [];
    this.undoStack = [];
    this.skippedTies = new Set();
    this.subscription = null;
    this.generatingChildren = null;
    this.saveTimer = null;
    this.saving = Promise.resolve();
    this.onJob = null;  // (running) => void, for keeping the screen on
  }

  async load() {
    let data = await this.storage.get('state');
    if (data && typeof data === 'object') {
      try {
        core.upgradeState(data);
      } catch (error) {
        if (error instanceof core.NewerDataError) throw error;
        await this.storage.set(`state.corrupt-${Date.now()}`, data);
        data = null;
        this._event('warn', '저장된 데이터를 읽지 못해 새로 시작했습니다. 원본은 앱 안에 따로 보존했습니다.');
      }
    }
    this.state = data && typeof data === 'object' ? { ...core.emptyState(), ...data } : core.emptyState();
    this.apiKey = (await this.storage.get('api_key')) || '';
  }

  // ------------------------------------------------------------------ basics
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const snapshot = this.state;
    this.saving = this.saving.then(() => this.storage.set('state', snapshot)).catch((error) => {
      this._event('error', `데이터를 저장하지 못했습니다: ${error?.message || error}`);
    });
    return this.saving;
  }

  _event(level, text) {
    this.eventId += 1;
    this.events.push({ id: this.eventId, level, text, time: now() });
    if (this.events.length > EVENT_LIMIT) this.events.shift();
  }

  eventsSince(since) { return this.events.filter((e) => e.id > since); }

  get combos() { return this.state.combinations; }
  set combos(list) { this.state.combinations = list; }
  get selection() { return this.state.selection; }
  get retired() { return this.selection.retired; }

  settings() {
    const ui = this.state.ui_state;
    const s = {};
    for (const [key, def] of Object.entries(SETTING_DEFAULTS)) s[key] = key in ui ? clone(ui[key]) : clone(def);
    for (const [key, choices] of Object.entries(SETTING_CHOICES)) if (!choices.includes(s[key])) s[key] = SETTING_DEFAULTS[key];
    return s;
  }

  updateSettings(changes) {
    const ui = this.state.ui_state;
    const before = clone(ui);
    let apiKey;
    try {
      apiKey = this._applySettings(ui, changes || {});
    } catch (error) {
      for (const k of Object.keys(ui)) delete ui[k];
      Object.assign(ui, before);
      throw error;
    }
    if (apiKey != null) {
      this.apiKey = apiKey;
      this.storage.set('api_key', apiKey).catch((error) => this._event('error', `API 키를 저장하지 못했습니다: ${error?.message || error}`));
    }
    if ('arena_mode' in (changes || {})) this.current = null;
    this.save();
    return this.settings();
  }

  _applySettings(ui, changes) {
    let apiKey = null;
    for (let [key, value] of Object.entries(changes)) {
      if (key === 'api_key') {
        apiKey = String(value ?? '').trim();
        continue;
      }
      if (!(key in SETTING_TYPES)) throw new UserError(`알 수 없는 설정입니다: ${key}`);
      try {
        value = convert(SETTING_TYPES[key], value);
      } catch {
        throw new UserError(`${key} 값이 올바르지 않습니다.`);
      }
      if (key === 'seed') {
        value = value.trim();
        if (value && (!/^\d+$/.test(value) || Number(value) > core.MAX_SEED)) throw new UserError(`시드는 0 ~ ${core.MAX_SEED} 사이의 정수로 입력하거나 비워 두세요.`);
      }
      if (key in SETTING_CHOICES && !SETTING_CHOICES[key].includes(value)) throw new UserError(`${key} 값이 올바르지 않습니다.`);
      if (key in SETTING_RANGES) {
        const [label, low, high] = SETTING_RANGES[key];
        if (!(low <= value && value <= high)) throw new UserError(`${label}은(는) ${low} ~ ${high} 사이로 입력해 주세요.`);
      }
      ui[key] = value;
      if (PROMPT_KEYS.includes(key)) ui.prompt_checked = true;
    }
    if ('character_prompt' in changes || 'character_negative' in changes) {
      const pairs = core.characterPromptParts(ui.character_prompt || [], ui.character_negative || []);
      ui.character_prompt = pairs.map(([p]) => p);
      ui.character_negative = pairs.map(([, n]) => n);
    }
    const s = this.settings();
    if (s.gen_max < s.gen_min) throw new UserError('조합당 작가 수 범위를 확인해 주세요 (최소 ≤ 최대).');
    if (!(s.global_min_w < s.global_max_w)) throw new UserError('가중치 범위를 확인해 주세요 (최소 < 최대).');
    return apiKey;
  }

  _startCount(key, value) {
    if (value == null) return this.settings()[key];
    const n = Number(value);
    if (String(value).trim() === '' || !Number.isFinite(n)) throw new UserError('개수가 올바르지 않습니다.');
    this.updateSettings({ [key]: Math.trunc(n) });
    return Math.trunc(n);
  }

  _genSettings() {
    const s = this.settings();
    if (!this.apiKey) throw new UserError('설정에서 NovelAI API 키를 먼저 입력해 주세요.');
    if (!s.seed) {
      s.seed = String(core.rnd.randint(0, core.MAX_SEED));
      this.state.ui_state.seed = s.seed;
      this._event('info', `시드를 ${s.seed}(으)로 정했습니다. 앞으로 모든 그림이 이 시드로 생성됩니다.`);
    }
    const [width, height] = core.SIZE_PRESETS[s.size];
    return {
      api_key: this.apiKey, model: s.model, width, height, steps: s.steps, cfg: s.cfg, cfg_rescale: s.cfg_rescale,
      sampler: s.sampler, delay: s.delay, base_prompt: s.base_prompt, character_prompt: s.character_prompt,
      character_negative: s.character_negative, negative: s.negative, seed: Number(s.seed),
    };
  }

  // ------------------------------------------------------------------ lookups
  find(id) { return this.combos.find((c) => c.id === id) || null; }

  findAny(id) {
    return this.find(id) || this.retired.find((c) => c.id === id) || ((this.state.improve || {}).items || {})[id] || null;
  }

  rated() { return this.combos.filter(core.isRated); }

  newcomers() {
    const children = new Set(this.selection.candidate_ids);
    return this.combos.filter((c) => !core.isRated(c) && !children.has(c.id));
  }

  rankingCounts(rated = null, waiting = null) {
    rated ??= this.rated().length;
    waiting ??= this.newcomers().length;
    return rated >= 2 ? [rated, waiting] : [0, waiting + rated];
  }

  topIds() { return core.topTierIds(this.combos, new Set(this.selection.candidate_ids)); }
  boundaryTie() { return core.boundaryTiePair(this.combos, new Set(this.selection.candidate_ids), this.skippedTies); }
  topTie() { return core.topTiePair(this.combos, new Set(this.selection.candidate_ids), this.skippedTies); }

  // ------------------------------------------------------------------ views
  _tiers() {
    const rated = this.rated();
    const elos = rated.map((c) => c.elo).sort((a, b) => a - b);
    const places = rated.length >= 2 ? new Map(core.rankOrder(rated).map((c, i) => [c.id, i + 1])) : new Map();
    const children = new Set(this.selection.candidate_ids);
    const out = new Map();
    for (const combo of this.combos) {
      const child = children.has(combo.id);
      if (!core.isRated(combo) || rated.length < 2) {
        out.set(combo.id, [null, false, null, null, child]);
        continue;
      }
      const rank = core.rankAmong(combo.elo, elos);
      out.set(combo.id, [core.tierForPercentile(rank / elos.length), !core.tierConfirmed(combo.matches, elos.length),
        core.tierGrade(rank / elos.length), places.get(combo.id), child]);
    }
    return out;
  }

  comboView(combo, tiers = null, role = null) {
    tiers ??= this._tiers();
    const [tier, provisional, grade, rank, child] = tiers.get(combo.id) || [null, false, null, null, false];
    const excluded = combo.excluded?.rejected ? '쳐냄' : (combo.excluded || {}).reason ?? null;  // 쳐냄: set aside from the arena (a 제외)
    const image = combo.image_file;
    return {
      id: combo.id, style: combo.style,
      pairs: core.parseStyleCombo(combo.style).map(([w, t]) => ({ w, tag: t })),
      elo: core.pyRound(combo.elo), tier, grade, provisional, rank,
      rated: core.isRated(combo) && (tier != null || !tiers.has(combo.id)), matches: combo.matches, wins: combo.wins,
      generation: combo.generation ?? 1,
      image: image ? this.images.url(image) : null, thumb: image ? this.images.thumbUrl(image) : null, file: image || null,
      excluded, child, role,
      seed: combo.seed ?? null, final: Boolean(combo.final), created: combo.created || 0,
    };
  }

  listCombos() {
    const tiers = this._tiers();
    return { active: this.combos.map((c) => this.comboView(c, tiers)), excluded: this.retired.map((c) => this.comboView(c, tiers)) };
  }

  // ------------------------------------------------------------------ jobs
  jobView() {
    const j = this.job;
    return j ? { label: j.label, done: j.done, total: j.total, failures: j.failures, running: j.running } : null;
  }

  _requireIdle(action, kinds = null) {
    const j = this.job;
    if (j && j.running && (kinds == null || kinds.includes(j.kind))) throw new UserError(`생성 작업이 끝난 뒤 ${action} 주세요.`);
  }

  _startJob(kind, label, total, work) {
    this._requireIdle('다시 시도해');
    this.stopped = false;
    this.job = { kind, label, done: 0, total, failures: 0, running: true, streak: 0, renders: 0 };
    const job = this.job;
    (async () => {
      await null;  // the request that started it finishes first, as with the PC version's thread
      try {
        await work(job);
      } catch (error) {
        job.failures += 1;
        this._event('error', `${label} 중 오류가 났습니다: ${error?.message || error}`);
      } finally {
        job.running = false;
        if (kind === 'evolution') this.generatingChildren = null;
        this.save();
        this._afterJob(kind);
        this.onJob?.(false);
        if (this.autoSubscription) this.refreshSubscription();
      }
    })();
    this.onJob?.(true);
    if (this.autoSubscription) this.refreshSubscription();
  }

  stopJob() {
    this.stopped = true;
    for (const wake of this.wakers) wake();
    this.wakers.clear();
  }

  // Wait ``seconds`` unless stopped first; true when stopped.
  sleep(seconds) {
    if (this.stopped) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { this.wakers.delete(wake); resolve(false); }, seconds * 1000);
      this.wakers.add(wake);
    });
  }

  async _generate(settings, style, seed) {
    const delays = [...core.RETRY_DELAYS, null];
    for (const delay of delays) {
      try {
        return await this._generateOnce(settings, style, seed);
      } catch (error) {
        if (!(error instanceof core.NaiHttpError) || !core.RETRY_STATUSES.includes(error.status) || delay == null) throw error;
        this._event('warn', `HTTP ${error.status}: ${delay}초 후 다시 시도합니다.`);
        if (await this.sleep(delay)) throw error;
      }
    }
    throw new Error('unreachable');
  }

  async _render(job, settings, style, seed) {
    if (job.renders) {
      await this._pause(settings);
      if (this.stopped) return null;
    }
    job.renders += 1;
    let png;
    try {
      png = await this._generate(settings, style, seed);
    } catch (error) {
      job.failures += 1;
      this._event('error', `이미지를 만들지 못했습니다: ${error?.message || error}`);
      job.streak += 1;
      if (core.AUTH_ERROR_STATUSES.includes(error?.status)) {
        this._event('error', 'API 키 인증에 실패해 작업을 멈췄습니다. 설정에서 키를 확인해 주세요.');
        this.stopJob();
      } else if (job.streak >= MAX_FAILURE_STREAK && !this.stopped) {
        this._event('error', `이미지가 ${MAX_FAILURE_STREAK}번 연속 실패해 작업을 멈췄습니다. 설정(프롬프트·모델·크기)이나 네트워크를 확인해 주세요.`);
        this.stopJob();
      }
      return null;
    }
    const name = `${core.newId()}.png`;
    try {
      await this.images.put(name, png);
    } catch (error) {
      job.failures += 1;
      this._event('error', `그림을 저장하지 못했습니다: ${error?.message || error}`);
      return null;
    }
    job.streak = 0;
    return name;
  }

  async _drawAndRender(job, settings, count, draw, keep, seen) {
    let made = 0;
    for (let i = 0; i < count; i++) {
      if (this.stopped) break;
      let style, info, found = false;
      for (let t = 0; t < DRAW_TRIES; t++) {
        [style, info] = draw();
        if (!seen.has(style)) { found = true; break; }
      }
      if (!found) {
        this._event('warn', '더 이상 새로운 조합을 만들 수 없어 만든 만큼으로 마칩니다.');
        break;
      }
      seen.add(style);
      const name = await this._render(job, settings, style, settings.seed);
      job.done += 1;
      if (name) {
        made += 1;
        keep(style, name, info);
        this.save();
      }
    }
    return made;
  }

  _newCombo(style, name, settings, fields = {}) {
    return { id: core.newId(), style, elo: core.START_ELO, matches: 0, wins: 0, placed: false,
      image_file: name, seed: settings.seed, created: Date.now() / 1000, generation: this.selection.generation, ...fields };
  }

  async _pause(settings) {
    if (settings.delay > 0) await this.sleep(settings.delay);
  }

  _afterJob(kind) {
    if (kind === 'improve') this._improveRoundCheck();
  }

  // ------------------------------------------------------------------ generation: random / custom / free
  async startRandom(count = null) {
    const s = this.settings();
    count = this._startCount('gen_count', count);
    const tags = this.state.artists.map((a) => a.tag);
    if (tags.length < s.gen_min) throw new UserError(`작가를 최소 ${s.gen_min}명 이상 등록해 주세요.`);
    const settings = this._genSettings();
    const seen = new Set([...this.combos, ...this.retired].map((c) => c.style));
    const favor = this._favorWeights(tags, s);
    this.save();
    const draw = () => {
      const size = core.rnd.randint(s.gen_min, Math.min(s.gen_max, tags.length));
      const picked = favor ? core.rnd.weightedSample(tags, favor, size) : core.rnd.sample(tags, size);
      const weights = picked.map(() => core.clampWeight(core.rnd.uniform(s.global_min_w, s.global_max_w), s.global_min_w, s.global_max_w));
      return [core.styleFromPairs(picked.map((t, i) => [weights[i], t])), new Set(picked)];
    };
    const keep = (style, name, used) => {
      this.combos.push(this._newCombo(style, name, settings, { generation: this.selection.generation - 1 }));
      for (const artist of this.state.artists) if (used.has(artist.tag)) artist.count += 1;
    };
    this._startJob('random', '새 조합 생성', count, async (job) => {
      const made = await this._drawAndRender(job, settings, count, draw, keep, seen);
      this._event('ok', `새 조합 ${made}개를 만들었습니다. 대결에서 자리를 찾아 주세요.`);
    });
  }

  // 선호 작가 반영: one draw weight per tag, higher for a higher 점수 (null when off: all alike, as the PC app).
  _favorWeights(tags, s) {
    if (!(s.favor_boost > 1)) return null;
    const scores = Object.fromEntries(Object.entries(core.artistScores([...this.combos, ...this.retired])).map(([t, [sc]]) => [t, sc]));
    const pref = core.artistPreference(scores, tags, s.favor_boost);
    return tags.map((t) => pref[t]);
  }

  async startCustom(text, count = 1) {
    const scan = this.scanArtists(text);
    const slots = core.artistWeightsInPrompt(text, core.RANDOM_SLOT_RE, null).map(([w]) => w);
    if (!scan.pairs.length && !slots.length) throw new UserError('artist: 태그나 __random__을 하나 이상 넣어 주세요.');
    const fixed = scan.pairs.map((p) => [p.w, p.tag]);
    if (slots.length) {
      count = Number(count);
      if (!Number.isFinite(count)) throw new UserError('개수가 올바르지 않습니다.');
      count = Math.trunc(count);
    } else count = 1;
    const [, low0, high0] = SETTING_RANGES.gen_count;
    if (!(low0 <= count && count <= high0)) throw new UserError(`개수는 ${low0} ~ ${high0} 사이로 입력해 주세요.`);
    const s = this.settings();
    const seen = new Set([...this.combos, ...this.retired].map((c) => c.style));
    const fixedTags = new Set(fixed.map(([, t]) => t));
    const pool = this.state.artists.map((a) => a.tag).filter((t) => !fixedTags.has(t));
    if (pool.length < slots.length) throw new UserError(`__random__ ${slots.length}자리를 채울 작가가 부족합니다 (적은 작가 말고 등록된 작가 ${pool.length}명).`);
    if (!slots.length && seen.has(core.styleFromPairs(fixed))) throw new UserError('이미 그림체 목록에 있는 조합입니다.');
    const settings = this._genSettings();
    this.save();
    const low = s.global_min_w, high = s.global_max_w;
    const favor = this._favorWeights(pool, s);
    const draw = () => {
      const picked = favor ? core.rnd.weightedSample(pool, favor, slots.length) : core.rnd.sample(pool, slots.length);
      const weights = slots.map((w) => (w == null ? core.clampWeight(core.rnd.uniform(low, high), low, high) : w));
      const pairs = [...fixed, ...picked.map((t, i) => [weights[i], t])];
      return [core.styleFromPairs(pairs), new Set(pairs.map(([, t]) => t))];
    };
    const keep = (style, name, used) => {
      this._register(scan.new);
      for (const artist of this.state.artists) if (used.has(artist.tag)) artist.count += 1;
      this.combos.push(this._newCombo(style, name, settings, { generation: this.selection.generation - 1 }));
    };
    this._startJob('custom', '조합 생성', count, async (job) => {
      const made = await this._drawAndRender(job, settings, count, draw, keep, seen);
      this._event('ok', `조합 ${made}개를 만들었습니다. 대결에서 자리를 찾아 주세요.`);
    });
  }

  // 그림체 뽑기 results: each style drawn as it is and added like a random combo (unknown artists get registered).
  async startStyles(styles) {
    const list = [...new Set((styles || []).map((s) => String(s).trim()).filter(Boolean))];
    if (!list.length) throw new UserError('그릴 조합이 없습니다.');
    const seen = new Set([...this.combos, ...this.retired].map((c) => c.style));
    const fresh = [];
    const fresher = new Set();
    for (const text of list) {
      const pairs = this.scanArtists(text).pairs.map((p) => [p.w, p.tag]);
      if (!pairs.length) continue;
      const style = core.styleFromPairs(pairs);
      if (seen.has(style) || fresher.has(style)) continue;
      fresher.add(style);
      fresh.push(style);
    }
    if (!fresh.length) throw new UserError('모두 이미 그림체 목록에 있는 조합입니다.');
    const [, , high] = SETTING_RANGES.gen_count;
    if (fresh.length > high) throw new UserError(`한 번에 ${high}개까지 그릴 수 있습니다.`);
    const settings = this._genSettings();
    this.save();
    let i = 0;
    const draw = () => {
      const style = fresh[Math.min(i, fresh.length - 1)];
      i += 1;
      return [style, new Set(core.artistsFromStyle(style))];
    };
    const keep = (style, name, used) => {
      this._register([...used]);
      for (const artist of this.state.artists) if (used.has(artist.tag)) artist.count += 1;
      this.combos.push(this._newCombo(style, name, settings, { generation: this.selection.generation - 1 }));
    };
    this._startJob('custom', '뽑은 조합 그리기', fresh.length, async (job) => {
      const made = await this._drawAndRender(job, settings, fresh.length, draw, keep, seen);
      this._event('ok', `뽑은 조합 ${made}개를 그렸습니다. 대결에서 자리를 찾아 주세요.`);
    });
    return { count: fresh.length, skipped: list.length - fresh.length };
  }

  _register(tags) {
    const registered = new Set(this.state.artists.map((a) => a.tag));
    for (const t of tags) {
      if (!registered.has(t)) {
        this.state.artists.push({ tag: t, count: 0, arena_matches: 0, arena_wins: 0 });
        registered.add(t);
      }
    }
  }

  async startRedraw(top = false) {
    if (this.state.improve) throw new UserError('다듬기를 마친 뒤 다시 그려 주세요.');
    const ids = top ? this.topIds() : core.sortBy(this.combos, (c) => [-c.elo]).map((c) => c.id);
    if (!ids.length) throw new UserError(top ? '상위 30%에 든 조합이 아직 없습니다.' : '다시 그릴 조합이 없습니다.');
    const settings = this._genSettings();
    this.save();
    this._startJob('redraw', top ? '상위 30% 다시 그리기' : '전체 다시 그리기', ids.length, async (job) => {
      let made = 0;
      for (const id of ids) {
        if (this.stopped) break;
        const combo = this.find(id);
        if (!combo) continue;
        const name = await this._render(job, settings, combo.style, settings.seed);
        job.done += 1;
        if (!name) continue;
        made += 1;
        const old = combo.image_file;
        combo.image_file = name;
        combo.seed = settings.seed;
        if (!new Set([...this.combos, ...this.retired].map((c) => c.image_file)).has(old)) this.images.remove(old);
        this.current = null;
        this.save();
      }
      this._event('ok', `조합 ${made}개를 다시 그렸습니다.`);
    });
  }

  async startFree(prompt) {
    const settings = this._genSettings();
    this.save();
    this._startJob('free', '자유 생성', 1, async (job) => {
      const name = await this._render(job, settings, String(prompt || '').trim(), settings.seed);
      job.done = 1;
      if (name) {
        this.state.free_results.unshift({ image: name, prompt, time: now(), seed: settings.seed });
        this._event('ok', '자유 생성 이미지를 만들었습니다.');
      }
    });
  }

  freeView() {
    return { results: this.state.free_results.map((r) => ({ ...r, url: this.images.url(r.image), thumb: this.images.thumbUrl(r.image) })) };
  }

  async deleteFree(images) {
    const drop = new Set(images || []);
    this.state.free_results = this.state.free_results.filter((r) => !drop.has(r.image));
    const used = new Set([...this.combos, ...this.retired].map((c) => c.image_file));
    for (const name of drop) if (!used.has(name)) this.images.remove(name);
    this.save();
  }

  // ------------------------------------------------------------------ artists
  listArtists() {
    const scores = core.artistScores([...this.combos, ...this.retired]);
    return this.state.artists.map((a) => ({ ...a, winrate: a.arena_matches ? a.arena_wins / a.arena_matches : 0,
      score: (scores[a.tag] || [0, 0])[0], combos: (scores[a.tag] || [0, 0])[1] }));
  }

  addArtists(text) {
    text = String(text || '');
    const existing = new Set(this.state.artists.map((a) => a.tag));
    let added = 0;
    const names = text.includes('artist:') ? core.artistsInPrompt(text) : core.extractArtistNames(text);
    for (const name of names) {
      const tag = core.sanitizeTag(name);
      if (tag && !existing.has(tag)) {
        this.state.artists.push({ tag, count: 0, arena_matches: 0, arena_wins: 0 });
        existing.add(tag);
        added += 1;
      }
    }
    this._artistsChecked();
    this.save();
    return added;
  }

  scanArtists(text) {
    const weights = new Map();
    for (const [w, raw] of core.artistWeightsInPrompt(String(text || ''))) {
      const tag = core.sanitizeTag(raw);
      if (tag && !weights.has(tag)) weights.set(tag, w);
    }
    const existing = new Set(this.state.artists.map((a) => a.tag));
    return { pairs: [...weights].map(([tag, w]) => ({ w, tag })), new: [...weights.keys()].filter((t) => !existing.has(t)) };
  }

  renameArtist(old, next) {
    next = core.sanitizeTag(next || '');
    if (!next || next === old) return;
    if (this.state.artists.some((a) => a.tag === next)) throw new UserError('이미 있는 작가 이름입니다.');
    this._requireIdle('이름을 바꿔');
    for (const a of this.state.artists) if (a.tag === old) a.tag = next;
    const improving = Object.values((this.state.improve || {}).items || {});
    for (const c of [...this.combos, ...this.retired, ...improving]) c.style = core.renameArtistInStyle(c.style, old, next);
    this._artistsChecked();
    this.save();
  }

  _artistsChecked() { this.state.ui_state.artists_checked = true; }

  deleteArtists(tags) {
    const drop = new Set(tags || []);
    this.state.artists = this.state.artists.filter((a) => !drop.has(a.tag));
    this._artistsChecked();
    this.save();
  }

  // ------------------------------------------------------------------ arena: the next match
  match(last = null) {
    const desired = this._priorityPair();
    if (desired) {
      let [kind, a, b, meta] = desired;
      const cur = this.current;
      if (!(cur && cur.kind === kind && new Set([cur.a, cur.b]).has(a) && new Set([cur.a, cur.b]).has(b))) {
        if (hashStr([a, b].sort().join('|')) & 1) [a, b] = [b, a];
        this.current = { kind, a, b, meta };
      } else {
        this.current.meta = meta;
      }
    } else if (!(this.current && ['league', 'top'].includes(this.current.kind) && this.find(this.current.a) && this.find(this.current.b))) {
      this.current = this._leaguePair();
    }
    return this._matchView(last);
  }

  _priorityPair() {
    const mode = this.settings().arena_mode;
    let tie = this.boundaryTie();
    if (tie) return ['tie', tie[0], tie[1], {}];
    tie = this.topTie();
    if (tie) return ['tie', tie[0], tie[1], { inner: true }];
    if (mode !== 'auto') return null;
    for (const chooser of [() => this._placementPair(), () => this._selectionPair(), () => this._improvePair()]) {
      const pair = chooser();
      if (pair) return pair;
    }
    return null;
  }

  _leaguePair() {
    const mode = this.settings().arena_mode;
    const children = new Set(this.selection.candidate_ids);
    let pool = this.combos.filter((c) => core.isRated(c) && !children.has(c.id));
    if (mode === 'top') {
      const top = new Set(this.topIds());
      const leaders = pool.filter((c) => top.has(c.id));
      pool = leaders.length >= 2 ? leaders : core.sortBy(pool, (c) => [-c.elo]).slice(0, 2);
    }
    if (pool.length < 2) return null;
    const weights = Engine._matchWeights(pool, pool);
    const last = new Set(this.lastPair || []);
    let a, b;
    for (let i = 0; i < 10; i++) {
      a = core.rnd.pick(pool, weights);
      const rest = pool.filter((c) => c.id !== a.id);
      b = core.rnd.pick(rest, Engine._matchWeights(rest, pool));
      const same = last.size === 2 && last.has(a.id) && last.has(b.id);
      if (!same || pool.length === 2) break;
    }
    return { kind: mode === 'top' ? 'top' : 'league', a: a.id, b: b.id, meta: {} };
  }

  static _matchWeights(combos, pool) {
    const rated = pool.filter(core.isRated).map((c) => c.elo).sort((x, y) => x - y);
    return combos.map((c) => {
      const m = c.matches;
      let value = 1 / (m + 1);
      if (m >= 1 && rated.length >= 2 && core.tierConfirmed(m, rated.length)) {
        const rank = core.rankAmong(c.elo, rated);
        value *= core.TIER_MATCH_MULTIPLIER[core.tierForPercentile(rank / rated.length)] ?? 1;
      }
      return value;
    });
  }

  _matchView(last = null) {
    const cur = this.current;
    const base = { stage: this.stage(), mode: this.settings().arena_mode, undo: this.undoStack.length > 0 };
    const tiers = cur || last ? this._tiers() : null;
    if (last) {
      base.last = {};
      for (const side of ['a', 'b']) {
        const combo = this.findAny(last[side]);
        if (combo) base.last[side] = this.comboView(combo, tiers);
      }
    }
    if (!cur) return { ...base, kind: null, message: this._idleMessage() };
    const roles = this._roles(cur);
    const a = this.findAny(cur.a), b = this.findAny(cur.b);
    if (!a || !b) {
      this.current = null;
      return { ...base, kind: null, message: this._idleMessage() };
    }
    return { ...base, kind: cur.kind, context: this._context(cur),
      a: this.comboView(a, tiers, roles[a.id] ?? null), b: this.comboView(b, tiers, roles[b.id] ?? null) };
  }

  _roles(cur) {
    if (cur.kind === 'improve') {
      const imp = this.state.improve;
      const roles = { [imp.champion_id]: '챔피언' };
      for (const k of imp.pending) roles[k] = '변형';
      return roles;
    }
    return {};
  }

  _context(cur) {
    const kind = cur.kind;
    if (kind === 'tie' && cur.meta?.inner) return { title: '상위 30% 동점', detail: '상위권에서 점수가 같은 두 조합입니다. 순위를 가리도록 더 마음에 드는 쪽을 골라 주세요.' };
    if (kind === 'tie') return { title: '상위 30% 경계 동점', detail: '상위 30%에 들 마지막 자리를 두고 점수가 같습니다. 더 마음에 드는 쪽을 골라 주세요.' };
    if (kind === 'place') {
      const left = this.newcomers().length;
      const done = this._placementVotes(this.state.placement).length;
      return { title: '새 조합 자리 찾기', detail: `기존 순위표 사이에서 위치를 찾는 중 · ${done + 1}번째 비교 · 남은 새 조합 ${left}개` };
    }
    if (kind === 'select') {
      const [low, high] = core.selectionRemainingMatches(this.selection, this.combos, this.state.history);
      const remain = low === high ? `${low}` : `${low}~${high}`;
      return { title: `${this.selection.generation}세대 진화 조합 평가`, detail: `새 조합이 상위 30% 사이 어디쯤인지 찾는 중 · 남은 대결 약 ${remain}회` };
    }
    if (kind === 'improve') {
      const imp = this.state.improve;
      return { title: `다듬기 ${imp.round}라운드`, detail: `챔피언 vs 가중치 변형 · 조정 폭 ±${imp.jitter.toFixed(1)} · 남은 변형 ${imp.pending.length}개` };
    }
    if (kind === 'top') return { title: '상위 30% 리그', detail: '상위권끼리 순위를 다듬습니다.' };
    return { title: '순위 결정', detail: '할 일이 없을 때는 일반 대결로 순위를 더 정확하게 만듭니다.' };
  }

  _idleMessage() {
    if (this.generatingChildren) {
      const [made, total] = this.generatingChildren;
      return `진화 조합을 만드는 중입니다 (${made}/${total}). 하나가 완성되면 바로 대결이 이어집니다.`;
    }
    if (this.job && this.job.running) return `${this.job.label} 중입니다. 완성되면 바로 대결이 이어집니다.`;
    if (this.rated().length < 2 && !this.newcomers().length) return '대결할 조합이 없습니다. 먼저 새 조합을 만들어 주세요.';
    return '지금은 할 대결이 없습니다.';
  }

  // ------------------------------------------------------------------ arena: voting
  vote(side) {
    const cur = this.current;
    if (!cur || !['a', 'b'].includes(side)) throw new UserError('지금 투표할 대결이 없습니다.');
    const [winner, loser] = side === 'a' ? [cur.a, cur.b] : [cur.b, cur.a];
    const handler = { tie: '_voteRegular', league: '_voteRegular', top: '_voteRegular', place: '_votePlace', select: '_voteSelect', improve: '_voteImprove' }[cur.kind];
    const before = this.undoStack.at(-1) ?? null;
    this[handler](cur, winner, loser);
    this._rememberMatch(cur, before);
    this.lastPair = [cur.a, cur.b];
    this.current = null;
    this.save();
    return this.match(cur);
  }

  skip() {
    const cur = this.current;
    if (!cur) return this.match();
    const kind = cur.kind;
    let entry = null;
    const before = this.undoStack.at(-1) ?? null;
    if (kind === 'tie') {
      const elo = this.find(cur.a).elo;
      const key = core.tieKey(cur.a, cur.b, elo);
      this.skippedTies.add(key);
      this._pushUndo({ kind: 'tie_skip', key });
    } else if (kind === 'place') {
      this._recordPlace(cur, null);
    } else if (kind === 'select') {
      entry = { type: 'selection_skip', batch_id: this.selection.batch_id, pair: { a: cur.a, b: cur.b } };
    } else if (kind === 'improve') {
      this._improveStep(null);
    } else {
      this._pushUndo({ kind: 'skip' });
    }
    if (entry) {
      this.state.history.unshift(entry);
      this._pushUndo({ kind: 'history', entry, placement: clone(this.state.placement) });
      core.applySelectionRatings(this.combos, this.selection, this.state.history);
    }
    this._rememberMatch(cur, before);
    this.lastPair = [cur.a, cur.b];
    this.current = null;
    this.save();
    return this.match(cur);
  }

  // 쳐내기: the picture on this side loses this match (counted like any loss: Elo, record, artist 승률), then it is
  // set aside as 제외 — kept with its record, so it still counts in the artist scores, and 그림체 can revive or delete it.
  // A newcomer still being placed is put at the lowest place its votes allow; a ladder rung rejected during a
  // placement just leaves the ladder. One undo brings everything back.
  reject(side) {
    const cur = this.current;
    if (!cur || !['a', 'b'].includes(side)) throw new UserError('지금 쳐낼 대결이 없습니다.');
    if (!['league', 'top', 'tie', 'place'].includes(cur.kind)) throw new UserError('진화 평가와 다듬기 대결에서는 쳐낼 수 없습니다. 평가를 마친 뒤 그림체에서 정리해 주세요.');
    const [loserId, winnerId] = side === 'a' ? [cur.a, cur.b] : [cur.b, cur.a];
    if (this._protected().has(loserId)) throw new UserError('진행 중인 진화에 쓰이는 조합은 세대를 확정한 뒤 쳐낼 수 있습니다.');
    if (this.state.improve && this.state.improve.base_id === loserId) throw new UserError('다듬기 중인 원본은 다듬기를 마친 뒤 쳐낼 수 있습니다.');
    const loser = this.find(loserId), winner = this.find(winnerId);
    if (!loser || !winner) throw new UserError('지금 쳐낼 대결이 없습니다.');
    const snap = {
      kind: 'reject', id: loserId, index: this.combos.indexOf(loser), entry: null,
      combos: { [loserId]: clone(loser), [winnerId]: clone(winner) },
      artists: Object.fromEntries(this.state.artists.map((a) => [a.tag, { arena_matches: a.arena_matches, arena_wins: a.arena_wins }])),
      placement: clone(this.state.placement ?? null),
    };
    const firstEntry = this.state.history[0];
    const stack = this.undoStack.slice();
    if (cur.kind === 'place') {
      const p = this.state.placement;
      if (p && loserId === p.id) {
        this._recordPlace(cur, winnerId);
        if (this.state.placement && this.state.placement.id === loserId) this._settlePlacementLow();
      } else if (p) {
        const at = p.ladder.indexOf(loserId);
        if (at >= 0) { p.ladder.splice(at, 1); p.scores.splice(at, 1); }
      }
    } else {
      this._voteRegular(cur, winnerId);
    }
    this.undoStack = stack;  // the reject snapshot below undoes the vote too
    if (this.state.history[0] !== firstEntry) snap.entry = this.state.history[0];
    this.combos = this.combos.filter((c) => c.id !== loserId);
    loser.excluded = { reason: '제외', generation: this.selection.generation, rejected: true };
    this.retired.push(loser);
    snap.match = clone(cur);
    this._pushUndo(snap);
    this.lastPair = [cur.a, cur.b];
    this.current = null;
    this.save();
    return this.match(cur);
  }

  _settlePlacementLow() {
    const p = this.state.placement;
    const combo = this.find(p.id);
    if (combo) {
      const votes = this._placementVotes(p);
      combo.elo = core.placementElo(core.placementLowSlot(votes, p.ladder.length), p.scores);
      const played = votes.filter((v) => v[1] !== 'tie');
      combo.matches += played.length;
      combo.wins += played.filter((v) => v[1] === 'win').length;
      combo.placed = true;
    }
    this.state.placement = null;
  }

  _undoReject(snap) {
    const loser = this.retired.find((c) => c.id === snap.id);
    if (!loser) {
      this.undoStack = [];
      throw new UserError('쳐낸 조합이 이미 지워져 되돌릴 수 없습니다.');
    }
    if (snap.entry) {
      const index = this.state.history.indexOf(snap.entry);
      if (index >= 0) this.state.history.splice(index, 1);
    }
    this.selection.retired = this.retired.filter((c) => c.id !== snap.id);
    for (const [id, saved] of Object.entries(snap.combos)) {
      const combo = id === snap.id ? loser : this.find(id);
      if (!combo) continue;
      for (const k of Object.keys(combo)) delete combo[k];
      Object.assign(combo, clone(saved));
    }
    this.combos.splice(Math.min(Math.max(snap.index, 0), this.combos.length), 0, loser);
    for (const artist of this.state.artists) Object.assign(artist, snap.artists[artist.tag] || {});
    this.state.placement = snap.placement;
  }

  _pushUndo(snap) {
    this.undoStack.push(snap);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  _rememberMatch(cur, before) {
    if (this.undoStack.length && this.undoStack.at(-1) !== before) this.undoStack.at(-1).match = clone(cur);
  }

  _voteRegular(cur, winnerId) {
    const a = this.find(cur.a), b = this.find(cur.b);
    const aWon = winnerId === a.id;
    const tagsA = new Set(core.artistsFromStyle(a.style)), tagsB = new Set(core.artistsFromStyle(b.style));
    const snap = { kind: 'regular', combos: {}, artists: {} };
    for (const c of [a, b]) snap.combos[c.id] = { elo: c.elo, matches: c.matches, wins: c.wins };
    for (const x of this.state.artists) {
      if (tagsA.has(x.tag) || tagsB.has(x.tag)) snap.artists[x.tag] = { arena_matches: x.arena_matches, arena_wins: x.arena_wins };
    }
    [a.elo, b.elo] = core.calcElo(a.elo, b.elo, aWon);
    a.matches += 1;
    b.matches += 1;
    (aWon ? a : b).wins += 1;
    for (const artist of this.state.artists) {
      const inA = tagsA.has(artist.tag), inB = tagsB.has(artist.tag);
      if (inA !== inB) {
        artist.arena_matches += 1;
        const won = inA ? aWon : !aWon;
        artist.arena_wins += won ? 1 : 0;
      }
    }
    const entry = { type: 'arena', pair: { a: a.id, b: b.id }, winner_id: winnerId };
    this.state.history.unshift(entry);
    snap.entry = entry;
    this._pushUndo(snap);
  }

  undo() {
    if (!this.undoStack.length) throw new UserError('되돌릴 대결이 없습니다.');
    const snap = this.undoStack.pop();
    const kind = snap.kind;
    if (kind === 'regular' || kind === 'history' || (kind === 'improve' && snap.entry)) {
      const history = this.state.history;
      const index = history.indexOf(snap.entry);
      if (index < 0) {
        this.undoStack = [];
        throw new UserError('이 대결은 더 이상 되돌릴 수 없습니다.');
      }
      history.splice(index, 1);
    }
    if (kind === 'regular') {
      for (const combo of this.combos) Object.assign(combo, snap.combos[combo.id] || {});
      for (const artist of this.state.artists) Object.assign(artist, snap.artists[artist.tag] || {});
    } else if (kind === 'history') {
      if (snap.combo) {
        const combo = this.find(snap.combo.id);
        if (combo) {
          for (const k of Object.keys(combo)) delete combo[k];
          Object.assign(combo, snap.combo);
        }
      }
      this.state.placement = snap.placement;
      if (snap.entry.type.startsWith('selection')) core.applySelectionRatings(this.combos, this.selection, this.state.history);
    } else if (kind === 'improve') {
      const imp = this.state.improve;
      if (snap.requeued) {
        const at = imp.pending.lastIndexOf(snap.challenger);
        if (at >= 0) imp.pending.splice(at, 1);
        if (imp.items[snap.challenger]) delete imp.items[snap.challenger].similar;
      }
      imp.pending.unshift(snap.challenger);
      if (imp.items[snap.challenger]) delete imp.items[snap.challenger].result;
      Object.assign(imp, snap.before);
    } else if (kind === 'tie_skip') {
      this.skippedTies.delete(snap.key);
    } else if (kind === 'reject') {
      this._undoReject(snap);
    }
    const restored = snap.match;
    this.current = restored && this.findAny(restored.a) && this.findAny(restored.b) ? restored : null;
    this.save();
    return this.current ? this._matchView() : this.match();
  }

  // ------------------------------------------------------------------ newcomer placement
  _placementVotes(p) {
    const rung = new Map(p.ladder.map((k, i) => [k, i]));
    const out = [];
    const history = this.state.history;
    for (let i = history.length - 1; i >= 0; i--) {
      const vote = history[i];
      if (vote.batch_id !== p.batch || !['place_vote', 'place_skip'].includes(vote.type)) continue;
      const pair = vote.pair;
      const other = pair.a === p.id ? pair.b : pair.a;
      if (!rung.has(other)) continue;
      if (vote.type === 'place_skip') out.push([rung.get(other), 'tie']);
      else out.push([rung.get(other), vote.winner_id === p.id ? 'win' : 'loss']);
    }
    return out;
  }

  _ensurePlacement() {
    const p = this.state.placement;
    if (p) {
      const byId = new Map(this.combos.map((c) => [c.id, c]));
      if (byId.has(p.id) && !core.isRated(byId.get(p.id)) && p.ladder.every((k) => byId.has(k))) return p;
    }
    this.state.placement = null;
    const children = new Set(this.selection.candidate_ids);
    for (;;) {
      const queue = this.newcomers();
      if (!queue.length) return null;
      const newcomer = queue[0];
      const ladder = core.sortBy(this.rated().filter((c) => !children.has(c.id)), (c) => [c.elo, c.id]);
      if (!ladder.length) {
        newcomer.placed = true;
        newcomer.elo = core.START_ELO;
        continue;
      }
      this.state.placement = { id: newcomer.id, batch: core.newId(), ladder: ladder.map((c) => c.id), scores: ladder.map((c) => c.elo) };
      return this.state.placement;
    }
  }

  _placementPair() {
    const p = this._ensurePlacement();
    if (!p) return null;
    const [, rung] = core.placementState(this._placementVotes(p), p.ladder.length);
    if (rung == null) {
      this._settlePlacement();
      return this._placementPair();
    }
    return ['place', p.id, p.ladder[rung], {}];
  }

  _votePlace(cur, winnerId) { this._recordPlace(cur, winnerId); }

  _recordPlace(cur, winnerId) {
    const p = this.state.placement;
    const entry = { type: winnerId ? 'place_vote' : 'place_skip', batch_id: p.batch, pair: { a: cur.a, b: cur.b } };
    if (winnerId) entry.winner_id = winnerId;
    this.state.history.unshift(entry);
    const snap = { kind: 'history', entry, placement: clone(p) };
    const before = clone(this.find(p.id));
    if (this._settlePlacement()) snap.combo = before;
    this._pushUndo(snap);
  }

  _settlePlacement() {
    const p = this.state.placement;
    if (!p) return false;
    const votes = this._placementVotes(p);
    const [slot, rung] = core.placementState(votes, p.ladder.length);
    if (rung != null) return false;
    const combo = this.find(p.id);
    if (combo) {
      combo.elo = core.placementElo(slot, p.scores);
      const played = votes.filter((v) => v[1] !== 'tie');
      combo.matches += played.length;
      combo.wins += played.filter((v) => v[1] === 'win').length;
      combo.placed = true;
      this._event('ok', `새 조합이 ${p.ladder.length - slot + 1}위 자리(${combo.elo}점)에 들어갔습니다.`);
    }
    this.state.placement = null;
    return true;
  }

  // ------------------------------------------------------------------ evolution
  evolutionView() {
    const sel = this.selection;
    const children = [...sel.candidate_ids];
    const tiers = this._tiers();
    const parents = children.length ? sel.parent_ids : this.topIds();
    const view = { generation: sel.generation, batch_active: Boolean(children.length || sel.batch_id),
      log: sel.log.slice(-12), parents: [], children: [], summary: null, blocker: this._evolutionBlocker(),
      converged: this._converged(), converged_after: CONVERGED_GENERATIONS };
    view.can_start = view.blocker == null;
    const byId = new Map(this.combos.map((c) => [c.id, c]));
    view.parents = parents.filter((k) => byId.has(k)).map((k) => this.comboView(byId.get(k), tiers));
    view.parents.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    if (children.length) {
      const plan = this._generationPlan();
      const info = plan.ranking.info;
      for (const key of children) {
        if (!byId.has(key)) continue;
        const child = this.comboView(byId.get(key), tiers);
        const pending = info.has(key) && info.get(key).rung != null;
        child.status = pending ? '평가중' : plan.failed.has(key) ? '탈락' : plan.next_parents.includes(key) ? '상위 30% 진입' : '생존';
        view.children.push(child);
      }
      const pend = view.children.filter((c) => c.status === '평가중');
      view.summary = {
        children: children.length, pending: pend.length,
        entered: view.children.filter((c) => ['생존', '상위 30% 진입'].includes(c.status)).length,
        failed: view.children.filter((c) => c.status === '탈락').length,
        ready: this._selectionDone(plan.ranking),
      };
    }
    return view;
  }

  _evolutionBlocker() {
    const s = this.settings();
    const rated = this.rated().length, waiting = this.newcomers().length;
    if (rated < MIN_RATED_FOR_EVOLUTION) return `평가된 조합이 ${MIN_RATED_FOR_EVOLUTION}개 이상 필요합니다 (지금 ${rated}개).`;
    if (waiting) return `자리를 찾지 못한 새 조합 ${waiting}개를 먼저 배치해 주세요.`;
    if (this.selection.candidate_ids.length) return '진행 중인 진화 조합 평가를 먼저 마무리해 주세요.';
    if (this.state.artists.length < s.gen_min) return `작가가 ${s.gen_min}명 이상 필요합니다.`;
    if (this.boundaryTie()) return '상위 30% 경계 동점을 먼저 해소해 주세요 (대결 화면에 나옵니다).';
    if (this.topTie()) return '상위 30% 안의 동점을 먼저 해소해 주세요 (대결 화면에 나옵니다).';
    if (this.topIds().length < 2) return '진화에 쓸 상위 30% 조합이 2개 이상 필요합니다.';
    return null;
  }

  async startEvolution(count = null) {
    this._requireIdle('진화를 시작해');
    const blocker = this._evolutionBlocker();
    if (blocker) throw new UserError(blocker);
    const s = this.settings();
    count = this._startCount('evo_count', count);
    const settings = this._genSettings();
    const top = new Set(this.topIds());
    const parents = this.combos.filter((c) => top.has(c.id));
    const sel = this.selection;
    sel.parent_ids = parents.map((c) => c.id);
    sel.parent_scores = Object.fromEntries(parents.map((c) => [c.id, c.elo]));
    sel.batch_id = core.newId();
    sel.candidate_ids = [];
    this.generatingChildren = [0, count];
    this.undoStack = [];
    this.save();
    const artistTags = this.state.artists.map((a) => a.tag);
    const parentCounts = {};
    for (const c of parents) for (const t of core.artistsFromStyle(c.style)) parentCounts[t] = (parentCounts[t] || 0) + 1;
    const scores = Object.fromEntries(Object.entries(core.artistScores([...this.combos, ...this.retired])).map(([t, [sc]]) => [t, sc]));
    const preference = core.artistPreference(scores, artistTags);
    const ranked = core.rankOrder(parents);
    const seen = new Set([...this.combos, ...this.retired].map((c) => c.style));
    const draw = () => {
      const [pa, pb] = core.pickParents(ranked);
      const mode = core.rnd.pick(core.BREED_MODES, core.BREED_WEIGHTS);
      return [core.breedWeightedStyle(pa.style, pb.style, artistTags, s.gen_min, s.gen_max, s.global_min_w, s.global_max_w, mode, parentCounts, preference), null];
    };
    const keep = (style, name) => {
      const combo = this._newCombo(style, name, settings);
      this.combos.unshift(combo);
      this.selection.candidate_ids.push(combo.id);
      this.generatingChildren = [this.selection.candidate_ids.length, count];
    };
    this._startJob('evolution', `${this.selection.generation}세대 진화 조합 생성`, count, async (job) => {
      await this._drawAndRender(job, settings, count, draw, keep, seen);
    });
  }

  _selectionPool() {
    const ids = new Set([...this.selection.parent_ids, ...this.selection.candidate_ids]);
    return this.combos.filter((c) => ids.has(c.id));
  }

  _selectionPair() {
    const sel = this.selection;
    if (!sel.candidate_ids.length) return null;
    const ranking = core.selectionRanking(sel, this.state.history);
    const pair = core.selectionNextPair(sel, this._selectionPool(), this.state.history, ranking);
    if (pair && this.generatingChildren) {
      if (![...ranking.info.values()].some((ci) => ci.bisecting)) return null;
    }
    return pair ? ['select', pair[0].id, pair[1].id, {}] : null;
  }

  _voteSelect(cur, winnerId) {
    const entry = { type: 'selection_vote', pair: { a: cur.a, b: cur.b }, winner_id: winnerId, batch_id: this.selection.batch_id };
    this.state.history.unshift(entry);
    core.applySelectionRatings(this.combos, this.selection, this.state.history);
    this._pushUndo({ kind: 'history', entry, placement: clone(this.state.placement) });
  }

  _selectionDone(ranking = null) {
    const sel = this.selection;
    if (!sel.candidate_ids.length || this.generatingChildren) return false;
    return core.selectionNextPair(sel, this._selectionPool(), this.state.history, ranking) == null;
  }

  _generationPlan() {
    const sel = this.selection;
    const ranking = core.selectionRanking(sel, this.state.history);
    const parents = new Set(sel.parent_ids);
    const children = new Set(sel.candidate_ids);
    const active = new Map(this.combos.map((c) => [c.id, c]));
    const failed = new Set([...children].filter((k) => active.has(k) && ranking.info.get(k).slot === 0));
    const entered = [...children].filter((k) => active.has(k) && !failed.has(k));
    const order = core.sortBy([...active.keys()].filter((k) => !failed.has(k)), (k) => [active.get(k).elo, parents.has(k), k], true);
    const removable = [...order].reverse().filter((k) => !children.has(k));
    const dropped = removable.slice(0, entered.length);
    const droppedSet = new Set(dropped);
    const survivors = order.filter((k) => !droppedSet.has(k));
    const nextParents = core.topTierIds(survivors.map((k) => active.get(k)));
    return { ranking, order, next_parents: nextParents, failed, entered, dropped };
  }

  finishGeneration() {
    this._requireIdle('세대를 확정해', ['evolution']);
    if (!this.selection.candidate_ids.length) throw new UserError('확정할 진화 세대가 없습니다.');
    if (!this._selectionDone()) throw new UserError('남은 평가 대결을 먼저 마쳐 주세요.');
    core.applySelectionRatings(this.combos, this.selection, this.state.history);
    const plan = this._generationPlan();
    const sel = this.selection;
    const byId = new Map(this.combos.map((c) => [c.id, c]));
    const out = [...[...plan.failed].map((k) => [k, '탈락']), ...plan.dropped.map((k) => [k, '제외'])];
    for (const [key, reason] of out) byId.get(key).excluded = { reason, generation: sel.generation };
    this.retired.push(...out.map(([k]) => byId.get(k)));
    const gone = new Set(out.map(([k]) => k));
    this.combos = this.combos.filter((c) => !gone.has(c.id));
    const nextSet = new Set(plan.next_parents);
    const promoted = sel.candidate_ids.filter((k) => nextSet.has(k)).length;
    sel.log.push({ generation: sel.generation, children: sel.candidate_ids.length, entered: plan.entered.length,
      promoted, failed: plan.failed.size, dropped: plan.dropped.length });
    sel.parent_ids = plan.next_parents;
    sel.parent_scores = Object.fromEntries(plan.next_parents.map((k) => [k, byId.get(k).elo]));
    sel.candidate_ids = [];
    sel.batch_id = null;
    sel.generation += 1;
    this.current = null;
    this.undoStack = [];
    this._event('ok', `${sel.generation - 1}세대 확정 · 생존 ${plan.entered.length} · 탈락 ${plan.failed.size} · 기존 최하위 제외 ${plan.dropped.length}`);
    this.save();
    return sel.log.at(-1);
  }

  _converged() {
    const recent = this.selection.log.slice(-CONVERGED_GENERATIONS);
    return recent.length === CONVERGED_GENERATIONS && recent.reduce((s, g) => s + g.entered, 0) === 0;
  }

  // ------------------------------------------------------------------ refine workbench
  improveView() {
    const imp = this.state.improve;
    const tiers = this._tiers();
    const candidates = core.rankOrder(this.combos.filter(core.isRated));
    const view = { session: null, candidates: candidates.map((c) => this.comboView(c, tiers)), jitters: jitterSchedule(),
      final_seeds: FINAL_CHECK_SEEDS, finals: this.combos.filter((c) => c.final).map((c) => this.comboView(c, tiers)), top: this.topIds() };
    if (!imp) return view;
    const items = imp.items;
    const itemView = (key, role = null) => {
      const combo = this.findAny(key);
      return combo ? this.comboView(combo, tiers, role) : null;
    };
    const base = this.findAny(imp.base_id);
    const champion = imp.champion_id ? this.findAny(imp.champion_id) : null;
    view.session = {
      status: imp.status, round: imp.round, jitter: imp.jitter, next_jitter: nextJitter(imp.jitter),
      base: itemView(imp.base_id), champion: itemView(imp.champion_id, '챔피언'),
      pending: imp.pending.filter((k) => k in items).map((k) => itemView(k, '변형')),
      seed: imp.seed, changed: imp.changed,
      variants: imp.order.filter((k) => k in items).map((k) => ({ ...itemView(k), result: items[k].result ?? null })),
      finals: (imp.finals || []).map((f) => ({ seed: f.seed, champion: f.champion ? this.images.url(f.champion) : null, base: f.base ? this.images.url(f.base) : null })),
      same_as_base: Boolean(base && champion && champion.style === base.style),
      suggest_final: imp.status === 'round_done' && !imp.changed && imp.jitter <= IMPROVE_JITTER_MIN,
    };
    return view;
  }

  async startImprove(comboId, variants = null) {
    if (this.state.improve) throw new UserError('진행 중인 다듬기를 먼저 마무리해 주세요.');
    this._requireIdle('다듬기를 시작해');
    const base = this.find(comboId);
    if (!base) throw new UserError('다듬을 조합을 찾을 수 없습니다.');
    const settings = this._genSettings();
    const count = this._startCount('improve_variants', variants);
    const seed = base.seed != null ? base.seed : settings.seed;
    this.state.improve = { base_id: base.id, champion_id: base.id, items: {}, round: 1, jitter: IMPROVE_JITTER_START, pending: [], order: [],
      changed: false, status: 'generating', seed, variants: count, finals: [] };
    this.save();
    this._improveGenerate(settings, count);
  }

  _improveGenerate(settings0, count) {
    const s = this.settings();
    const settings = { ...settings0, seed: this.state.improve.seed };
    this._startJob('improve', `다듬기 ${this.state.improve.round}라운드 생성`, count, async (job) => {
      const imp = this.state.improve;
      const seen = new Set([...Object.keys(imp.items).map((k) => this.findAny(k).style), this.findAny(imp.champion_id).style]);
      const draw = () => {
        const pairs = core.parseStyleCombo(this.findAny(imp.champion_id).style);
        return [core.styleFromPairs(core.jitterWeights(pairs, imp.jitter, s.global_min_w, s.global_max_w)), null];
      };
      const keep = (style, name) => {
        const champion = this.findAny(imp.champion_id);
        const item = this._newCombo(style, name, settings, { elo: champion.elo, generation: champion.generation ?? 1 });
        imp.items[item.id] = item;
        const again = imp.pending.findIndex((k) => imp.items[k]?.similar);
        imp.pending.splice(again >= 0 ? again : imp.pending.length, 0, item.id);
        imp.order.push(item.id);
        imp.status = 'voting';
      };
      await this._drawAndRender(job, settings, count, draw, keep, seen);
    });
  }

  _improvePair() {
    const imp = this.state.improve;
    if (!imp || !imp.pending.length || !imp.champion_id) return null;
    return ['improve', imp.champion_id, imp.pending[0], {}];
  }

  _voteImprove(cur, winnerId) { this._improveStep(winnerId, { a: cur.a, b: cur.b }); }

  _improveStep(winnerId, pair = null) {
    const imp = this.state.improve;
    const snap = { kind: 'improve', challenger: imp.pending.shift(), entry: null,
      before: { champion_id: imp.champion_id, changed: imp.changed, status: imp.status } };
    const challenger = snap.challenger;
    const item = imp.items[challenger];
    if (winnerId) {
      item.result = winnerId === challenger ? 'win' : 'loss';
      if (winnerId === challenger) {
        imp.champion_id = challenger;
        imp.changed = true;
      }
      snap.entry = { type: 'improve_vote', pair, winner_id: winnerId };
      this.state.history.unshift(snap.entry);
    } else if (!item.similar) {
      item.similar = true;
      imp.pending.push(challenger);
      snap.requeued = true;
    } else {
      item.result = 'loss';
    }
    this._improveRoundCheck();
    this._pushUndo(snap);
  }

  _improveRoundCheck() {
    const imp = this.state.improve;
    const generating = this.job && this.job.running && this.job.kind === 'improve';
    if (imp && !imp.pending.length && !generating && ['voting', 'generating'].includes(imp.status)) imp.status = 'round_done';
  }

  improveNextRound() {
    const imp = this.state.improve;
    if (!imp || imp.status !== 'round_done') throw new UserError('지금은 다음 라운드를 시작할 수 없습니다.');
    this._requireIdle('다음 라운드를 시작해');
    imp.round += 1;
    imp.jitter = nextJitter(imp.jitter);
    imp.changed = false;
    imp.status = 'generating';
    const settings = this._genSettings();
    const count = imp.variants;
    this.undoStack = [];
    this.save();
    this._improveGenerate(settings, count);
  }

  improveFinalCheck() {
    const imp = this.state.improve;
    if (!imp || !['round_done', 'final_ready'].includes(imp.status)) throw new UserError('라운드를 마친 뒤 최종 확인을 할 수 있습니다.');
    this._requireIdle('최종 확인을 시작해');
    const settings = this._genSettings();
    const champion = this.findAny(imp.champion_id);
    const base = this.findAny(imp.base_id);
    const same = champion.style === base.style;
    const roles = same ? [['base', base]] : [['champion', champion], ['base', base]];
    const seeds = Array.from({ length: FINAL_CHECK_SEEDS }, () => core.rnd.randint(0, core.MAX_SEED));
    this._dropFinalImages(imp);
    imp.finals = seeds.map((seed) => ({ seed }));
    imp.status = 'final_check';
    this.undoStack = [];
    this.save();
    this._startJob('final', '다른 시드로 최종 확인', FINAL_CHECK_SEEDS * roles.length, async (job) => {
      for (const final of imp.finals) {
        for (const [role, combo] of roles) {
          if (this.stopped) break;
          const name = await this._render(job, settings, combo.style, final.seed);
          job.done += 1;
          final[role] = name;
          if (same) final.champion = name;
          this.save();
        }
      }
      if (imp.finals.every((f) => f.champion && f.base)) {
        imp.status = 'final_ready';
      } else {
        this._dropFinalImages(imp);
        imp.finals = [];
        imp.status = 'round_done';
        this._event('warn', '최종 확인 이미지를 모두 그리지 못해 라운드 결과로 돌아갑니다. 다시 시도할 수 있습니다.');
      }
    });
  }

  finishImprove(choice = 'champion') {
    const imp = this.state.improve;
    if (!imp) throw new UserError('진행 중인 다듬기가 없습니다.');
    if (!['champion', 'base', 'discard'].includes(choice)) throw new UserError('마무리 방법이 올바르지 않습니다.');
    this._requireIdle('마무리해', ['improve', 'final']);
    const base = this.find(imp.base_id);
    const champion = imp.items[imp.champion_id];
    const improved = choice === 'champion' && champion != null;
    let result = null;
    if (improved) {
      Object.assign(champion, { placed: false, final: true });
      delete champion.result;
      delete champion.similar;
      this.combos.push(champion);
      result = champion.id;
    } else if (choice !== 'discard' && base) {
      base.final = true;
      result = base.id;
    }
    for (const [key, item] of Object.entries(imp.items)) {
      if (key === result) continue;
      delete item.result;
      delete item.similar;
      item.excluded = { reason: '탈락', generation: null, improve: imp.base_id };
      this.retired.push(item);
    }
    this._dropFinalImages(imp);
    this.state.improve = null;
    this.current = null;
    this.undoStack = [];
    if (improved) this._event('ok', '다듬은 조합을 최종 그림체로 저장했습니다. 대결에서 전체 순위 안의 자리를 찾습니다.');
    else if (result) this._event('ok', '원본을 최종 그림체로 표시했습니다.');
    else this._event('info', '다듬기를 끝냈습니다.');
    this.save();
    return result;
  }

  improveResume() {
    const imp = this.state.improve;
    if (!imp || imp.status !== 'final_ready') throw new UserError('최종 확인 결과가 있을 때만 다듬기를 이어갈 수 있습니다.');
    this._dropFinalImages(imp);
    imp.finals = [];
    imp.status = 'round_done';
    this.save();
  }

  _dropFinalImages(imp) {
    for (const final of imp.finals || []) for (const role of ['champion', 'base']) if (final[role]) this.images.remove(final[role]);
  }

  // ------------------------------------------------------------------ combos: edit / delete / revive
  _protected() {
    const sel = this.selection;
    return sel.candidate_ids.length ? new Set([...sel.parent_ids, ...sel.candidate_ids]) : new Set();
  }

  deleteCombos(ids) {
    this._requireIdle('삭제해');
    ids = new Set(ids || []);
    const guarded = this._protected();
    if ([...ids].some((k) => guarded.has(k))) throw new UserError('진행 중인 진화에 쓰이는 조합은 세대를 확정한 뒤 삭제할 수 있습니다.');
    const imp = this.state.improve;
    if (imp && ids.has(imp.base_id)) throw new UserError('다듬기 중인 원본은 다듬기를 마친 뒤 삭제할 수 있습니다.');
    const all = [...this.combos, ...this.retired];
    const targets = all.filter((c) => ids.has(c.id));
    const kept = new Set(all.filter((c) => !ids.has(c.id)).map((c) => c.image_file));
    this.combos = this.combos.filter((c) => !ids.has(c.id));
    this.selection.retired = this.retired.filter((c) => !ids.has(c.id));
    for (const c of targets) if (c.image_file && !kept.has(c.image_file)) this.images.remove(c.image_file);
    const p = this.state.placement;
    if (p && (ids.has(p.id) || p.ladder.some((k) => ids.has(k)))) this.state.placement = null;
    this.current = null;
    this.undoStack = [];
    this.save();
    return { deleted: targets.length };
  }

  purge(reason) {
    const ids = this.retired.filter((c) => ((c.excluded || {}).reason ?? '제외') === reason).map((c) => c.id);
    return this.deleteCombos(ids);
  }

  revive(ids) {
    this._requireIdle('부활시켜');
    ids = new Set(ids || []);
    const targets = this.retired.filter((c) => ids.has(c.id));
    this.selection.retired = this.retired.filter((c) => !ids.has(c.id));
    for (const combo of targets) {
      delete combo.excluded;
      if (!core.isRated(combo)) combo.placed = false;
      this.combos.push(combo);
    }
    this.current = null;
    this.undoStack = [];
    this.save();
    return targets.length;
  }

  setElo(ids, elo) {
    elo = Math.trunc(Number(elo));
    if (!Number.isFinite(elo)) throw new UserError('Elo 값이 올바르지 않습니다.');
    if (elo < 0) throw new UserError('Elo는 0 이상으로 입력해 주세요.');
    ids = new Set(ids || []);
    for (const combo of [...this.combos, ...this.retired]) {
      if (ids.has(combo.id)) {
        combo.elo = elo;
        if (!core.isRated(combo)) combo.placed = true;
      }
    }
    const sel = this.selection;
    if (sel.candidate_ids.length && [...ids].some((k) => k in sel.parent_scores)) {
      for (const k of ids) if (k in sel.parent_scores) sel.parent_scores[k] = elo;
      core.applySelectionRatings(this.combos, sel, this.state.history);
    }
    const p = this.state.placement;
    if (p && p.ladder.some((k) => ids.has(k))) {
      const byId = new Map(this.combos.map((c) => [c.id, c]));
      if (p.ladder.every((k) => byId.has(k))) {
        p.ladder = core.sortBy(p.ladder, (k) => [byId.get(k).elo, k]);
        p.scores = p.ladder.map((k) => byId.get(k).elo);
      } else this.state.placement = null;
    }
    this.current = null;
    this.undoStack = [];
    this.save();
  }

  imageName(comboId) {
    const combo = this.findAny(comboId);
    return combo && combo.image_file ? combo.image_file : null;
  }

  // ------------------------------------------------------------------ reset
  async reset(scope) {
    const SCOPES = ['ratings', 'evolution', 'settings', 'artists', 'combos', 'all'];
    if (!SCOPES.includes(scope)) throw new UserError('초기화 범위가 올바르지 않습니다.');
    this._requireIdle('초기화해');
    if (['ratings', 'evolution'].includes(scope) && this.selection.candidate_ids.length) throw new UserError('진행 중인 진화 세대를 확정한 뒤 초기화해 주세요.');
    if (scope === 'ratings' && this.state.improve) throw new UserError('진행 중인 다듬기를 마친 뒤 초기화해 주세요.');
    const s = this.state;
    if (scope === 'ratings') {
      for (const c of [...this.combos, ...this.retired]) Object.assign(c, { elo: core.START_ELO, matches: 0, wins: 0, placed: false });
      for (const a of s.artists) Object.assign(a, { arena_matches: 0, arena_wins: 0 });
      s.history = [];
      s.placement = null;
    } else if (scope === 'evolution') {
      Object.assign(this.selection, { generation: 1, log: [], parent_ids: [], parent_scores: {}, candidate_ids: [], batch_id: null });
      for (const c of [...this.combos, ...this.retired]) c.generation = 0;
    } else if (scope === 'settings') {
      s.ui_state = { seed: s.ui_state.seed ?? '' };
    } else if (scope === 'artists') {
      s.artists = core.defaultArtists();
      s.ui_state.artists_checked = false;
    } else {
      await this.images.clear();
      const keep = scope === 'combos' ? { artists: s.artists, ui_state: s.ui_state, gacha: s.gacha } : {};
      this.state = { ...core.emptyState(), ...keep };
    }
    if (scope === 'all') {
      this.apiKey = '';
      await this.storage.del('api_key');
      this.subscription = null;
    }
    this.current = null;
    this.undoStack = [];
    this.skippedTies.clear();
    await this.flush();
    return {};
  }

  // ------------------------------------------------------------------ export / import (the PC version's zip)
  async exportData(sink, onProgress = null) {
    await this.flush();
    const zip = new ZipWriter(sink);
    await zip.add('state.json', textBytes(JSON.stringify(this.state)), { compress: true });
    const names = this.images.list().filter((n) => n.toLowerCase().endsWith('.png')).sort();
    let done = 0;
    for (const name of names) {
      let bytes;
      try { bytes = await this.images.read(name); } catch { continue; }
      await zip.add(`images/${name}`, bytes);
      done += 1;
      onProgress?.(done, names.length);
    }
    if (this.apiKey) await zip.add('api_key.txt', textBytes(this.apiKey), { compress: true });
    await zip.finish();
    return { images: done };
  }

  async importData(blob, onProgress = null) {
    let entries, state;
    try {
      entries = await zipEntries(blob);
      const stateEntry = entries.find((e) => e.name === 'state.json');
      if (!stateEntry) throw new Error('no state');
      state = JSON.parse(bytesText(await readEntry(blob, stateEntry)));
    } catch {
      throw new UserError('NAI Style Lab에서 내보낸 zip 파일이 아닙니다.');
    }
    try {
      if (state && typeof state === 'object') core.upgradeState(state);
    } catch (error) {
      if (error instanceof core.NewerDataError) throw new UserError('더 새 버전의 NAI Style Lab에서 내보낸 데이터입니다. 앱을 업데이트한 뒤 불러오세요.');
      throw new UserError('데이터 파일의 내용이 올바르지 않습니다.');
    }
    const combos = state && typeof state === 'object' ? state.combinations : null;
    if (!Array.isArray(combos) || !combos.every((c) => c && typeof c === 'object' && COMBO_KEYS.every((k) => k in c))) {
      throw new UserError('데이터 파일의 내용이 올바르지 않습니다.');
    }
    let apiKey = '';
    const keyEntry = entries.find((e) => e.name === 'api_key.txt');
    if (keyEntry) { try { apiKey = bytesText(await readEntry(blob, keyEntry)).trim(); } catch { apiKey = ''; } }
    const images = entries.filter((e) => /^images\/[^/]+\.png$/i.test(e.name));
    this._requireIdle('불러와');
    const kept = new Set();
    let done = 0;
    for (const entry of images) {
      const name = entry.name.slice('images/'.length);
      try {
        await this.images.put(name, await readEntry(blob, entry), { thumb: false });
      } catch (error) {
        throw new UserError(`zip 파일의 이미지를 풀지 못했습니다: ${error?.message || error}`);
      }
      kept.add(name);
      done += 1;
      onProgress?.(done, images.length);
    }
    for (const name of this.images.list()) if (!kept.has(name)) await this.images.remove(name);
    await this.images.clearThumbs();
    this.state = { ...core.emptyState(), ...state };
    if (apiKey && apiKey !== this.apiKey) {
      this.apiKey = apiKey;
      await this.storage.set('api_key', apiKey);
      this.subscription = null;
      if (this.autoSubscription) this.refreshSubscription();
    }
    this.current = null;
    this.undoStack = [];
    this.skippedTies.clear();
    await this.flush();
    return { combos: this.combos.length, images: images.length };
  }

  // ------------------------------------------------------------------ 그림체 뽑기 saved data (rides along in state.json)
  gachaView() { return clone(this.state.gacha || {}); }

  saveGacha(data) {
    this.state.gacha = { ...(this.state.gacha || {}), ...clone(data || {}) };
    this.save();
    return {};
  }

  // ------------------------------------------------------------------ subscription
  refreshSubscription() {
    if (this.apiKey) this.checkSubscription().catch(() => {});
  }

  async checkSubscription() {
    const key = this.apiKey;
    if (!key) throw new UserError('API 키를 먼저 입력해 주세요.');
    let data = null, error = null;
    try {
      data = await this._fetchSubscription(key);
    } catch (e) {
      error = e?.message || String(e);
    }
    this.subscription = { data, error, checked: now() };
    return this.subscriptionView();
  }

  settingsPayload() {
    return { settings: this.settings(), api_key: this.apiKey, subscription: this.subscriptionView() };
  }

  subscriptionView() {
    const sub = this.subscription;
    if (!sub) return null;
    if (sub.error) return { error: sub.error, checked: sub.checked };
    const data = sub.data;
    const s = this.settings();
    const [width, height] = core.SIZE_PRESETS[s.size];
    let estimate = null;
    if (data.active && (data.tier_num === 3 || data.unlimited)) estimate = core.estimateV5Images(data.remaining_percent, width, height, s.steps, s.model);
    return { tier: data.tier, active: data.active, anlas: data.anlas, remaining_percent: data.remaining_percent,
      estimate: estimate ? { left: estimate[0], total: estimate[1] } : null, checked: sub.checked };
  }

  // ------------------------------------------------------------------ workflow stage
  stage() {
    const s = this.settings();
    const checklist = {
      api_key: Boolean(this.apiKey),
      artists: this.state.artists.length >= s.gen_min && (s.artists_checked || this.combos.length > 0),
      prompt: s.prompt_checked || this.combos.length > 0,
      combos: this.combos.length > 0,
    };
    const imp = this.state.improve;
    const rated = this.rated().length;
    const newcomers = this.newcomers().length;
    const running = this.job && this.job.running;
    const [shownRated, waiting] = this.rankingCounts(rated, newcomers);
    const finals = this.combos.some((c) => c.final);
    let step, todo;
    if (!Object.values(checklist).every(Boolean)) {
      step = 0;
      if (!checklist.api_key) todo = ['설정에서 NovelAI API 키를 입력하세요.', 'settings', '설정 열기'];
      else if (this.state.artists.length < s.gen_min) todo = [`좋아하는 작가를 ${s.gen_min}명 이상 등록하세요.`, 'library', '작가 등록'];
      else if (!checklist.artists) todo = ['작가 목록을 확인하세요. 좋아하는 작가를 더하거나 기본 목록을 그대로 써도 됩니다.', 'library', '작가 확인'];
      else if (!checklist.prompt) todo = ['모든 그림에 쓰일 프롬프트를 확인하세요. 기본값 그대로 써도 됩니다.', 'settings', '프롬프트 확인'];
      else todo = ['첫 무작위 조합을 만들어 보세요.', 'library', '조합 만들기'];
    } else if (imp) {
      step = ['final_check', 'final_ready'].includes(imp.status) ? 4 : 3;
      if (imp.status === 'final_ready') todo = ['다른 시드에서도 좋은지 확인하고 확정하세요.', 'refine', '최종 확인'];
      else if (imp.status === 'final_check') todo = ['다른 시드로 최종 확인 이미지를 그리는 중입니다.', 'refine', '진행 보기'];
      else if (imp.status === 'round_done') todo = ['라운드가 끝났습니다. 다음 라운드로 더 다듬거나 최종 확인하세요.', 'refine', '다듬기 보기'];
      else todo = ['챔피언과 변형을 비교하세요. 마음에 드는 쪽을 고르면 됩니다.', 'arena', '대결하기'];
    } else if (newcomers || rated < MIN_RATED_FOR_EVOLUTION) {
      step = finals ? 4 : 1;
      if (newcomers) todo = [`새 조합 ${waiting}개의 자리를 찾아 주세요. 한 조합당 약 ${Math.max(1, Math.ceil(Math.log2(rated + 1)))}표면 됩니다.`, 'arena', '대결하기'];
      else if (running) todo = ['새 조합을 만드는 중입니다. 완성되는 대로 대결이 시작됩니다.', 'arena', '대결하기'];
      else todo = [`평가된 조합이 ${shownRated}개입니다. 진화를 시작하려면 ${MIN_RATED_FOR_EVOLUTION}개 이상 필요합니다.`, 'library', '조합 더 만들기'];
    } else if (finals) {
      step = 4;
      todo = ['최종 그림체를 정했습니다. 다른 그림체를 더 다듬거나 진화를 이어 갈 수도 있습니다.', 'refine', '완성한 그림체 보기'];
    } else {
      step = 2;
      const sel = this.selection;
      if (sel.candidate_ids.length) {
        todo = this._selectionDone() ? ['진화 조합 평가가 끝났습니다. 세대를 확정하세요.', 'evolution', '세대 확정']
          : [`${sel.generation}세대 진화 조합을 평가하세요.`, 'arena', '대결하기'];
      } else if (this.boundaryTie()) todo = ['상위 30% 경계에서 점수가 같은 조합이 생겼습니다. 대결에서 먼저 가려 주세요.', 'arena', '대결하기'];
      else if (this.topTie()) todo = ['상위 30% 안에서 점수가 같은 조합이 생겼습니다. 대결에서 먼저 가려 주세요.', 'arena', '대결하기'];
      else if (this._converged()) {
        step = 3;
        todo = [`${CONVERGED_GENERATIONS}세대 연속으로 살아남은 진화 조합이 없습니다. 이제 다듬기로 넘어가 보세요.`, 'refine', '다듬기 시작'];
      } else todo = [`상위 30% 조합을 섞어 ${sel.generation}세대 진화 조합을 만드세요.`, 'evolution', '진화 시작'];
    }
    const params = todo[1] === 'settings' ? { focus: !checklist.api_key ? 'connection' : 'prompts' } : {};
    return { step, names: STAGES, todo: todo[0], route: todo[1], action: todo[2], params, checklist };
  }

  status(since = 0) {
    const tie = this.boundaryTie() || this.topTie();
    const [rated, waiting] = this.rankingCounts();
    return {
      stage: this.stage(), job: this.jobView(), events: this.eventsSince(since),
      counts: { active: this.combos.length, top: this.topIds().length, rated, newcomers: waiting, excluded: this.retired.length,
        artists: this.state.artists.length, generation: this.selection.generation,
        votes: this.state.history.filter((h) => ['arena', 'selection_vote', 'place_vote', 'improve_vote'].includes(h.type)).length },
      tie: Boolean(tie), subscription: this.subscriptionView(),
      settings_rev: crc32(textBytes(stableStringify(this.settingsPayload()))),
      improve: (this.state.improve || {}).status ?? null,
    };
  }
}

export { kindName };
