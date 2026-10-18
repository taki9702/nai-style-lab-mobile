// 그림체 뽑기 — random NAI V5 artist mixes from your own pool. Artist count, weights and order are drawn at random;
// pinned artists go into every mix (their weight random or fixed, their place free or first/last). Results copy
// straight into NovelAI, or go to the arena as new combos to be ranked.
import { get, post } from '../api.js';
import { h, morph, icon, toast, copyText, pageHead, card, emptyState, confirmDialog, shortTag, pickFile, novelaiMeta, stealthMeta, fmt } from '../ui.js';
import { DEFAULT_CONFIG, parsePool, drawBatch, validate, mixText } from '../backend/gacha.js';
import { FAVOR_LEVELS, artistPreference } from '../backend/core.js';

const HISTORY_LIMIT = 200;
const RESULTS_LIMIT = 100;
const ORDERS = [['shuffle', '무작위 섞기'], ['pinned-first', '고정 작가 먼저'], ['weight-desc', '가중치 높은 순'], ['pool', '풀에 넣은 순서']];
const POSITIONS = [['any', '자리 자유'], ['first', '맨 앞'], ['last', '맨 뒤']];
const TAP_MODES = [['pin', '고정'], ['off', '제외'], ['delete', '삭제']];

let root, app;
let data = { pool: [], config: { ...DEFAULT_CONFIG }, favorites: [], history: [] };
let results = [];  // the latest draws (saved too, so they are still there after the app restarts)
let selected = new Set();
const view = { input: '', tap: 'pin', tab: 'results', poolOpen: true, rulesOpen: true };
let saveTimer = null;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; post('/api/gacha/save', { data: { ...data, results } }).catch(() => {}); }, 400);
}

const cfg = () => data.config;
const counts = () => ({
  free: data.pool.filter((a) => (a.state || 'free') === 'free').length,
  pin: data.pool.filter((a) => a.state === 'pin').length,
  off: data.pool.filter((a) => a.state === 'off').length,
});

// ---------------------------------------------------------------- pool
function addToPool(entries) {
  const known = new Set(data.pool.map((a) => a.tag));
  let added = 0;
  for (const e of entries) {
    if (known.has(e.tag)) continue;
    data.pool.push({ tag: e.tag, state: 'free', w: null, w0: e.w0 ?? null, pos: 'any' });
    known.add(e.tag);
    added += 1;
  }
  persist();
  return added;
}

function addFromText() {
  const entries = parsePool(view.input);
  if (!entries.length) return toast('작가 태그를 찾지 못했습니다. artist:이름 형식이나 쉼표로 나눈 이름을 넣어 주세요.', 'warn');
  const added = addToPool(entries);
  view.input = '';
  toast(added ? `작가 ${added}명을 풀에 넣었습니다.` : '이미 풀에 있는 작가입니다.', added ? 'ok' : 'info');
  render();
}

async function addRegistered() {
  const artists = await get('/api/artists');
  const added = addToPool(artists.map((a) => ({ tag: a.tag })));
  toast(added ? `등록된 작가 ${added}명을 풀에 넣었습니다.` : '등록된 작가가 모두 풀에 있습니다.', added ? 'ok' : 'info');
  render();
}

async function addFromPng() {
  const file = await pickFile('image/png');
  if (!file) return;
  const meta = novelaiMeta(new Uint8Array(await file.arrayBuffer())) || await stealthMeta(file).catch(() => null);
  if (!meta) return toast('NovelAI 프롬프트 정보가 없는 그림입니다. NovelAI에서 받은 PNG 원본을 골라 주세요.', 'warn');
  const caption = meta.v4_prompt?.caption;
  const text = [caption?.base_caption ?? meta.prompt ?? '', ...(caption?.char_captions || []).map((c) => c.char_caption)].join('\n');
  const entries = parsePool(text);
  if (!entries.length) return toast('이 그림의 프롬프트에 artist: 태그가 없습니다.', 'warn');
  const added = addToPool(entries);
  toast(`그림에서 작가 ${entries.length}명을 찾아 ${added}명을 새로 넣었습니다. 원래 가중치도 함께 기억합니다.`, 'ok');
  render();
}

function tapChip(a) {
  if (view.tap === 'delete') {
    data.pool = data.pool.filter((x) => x !== a);
  } else if (view.tap === 'pin') {
    a.state = a.state === 'pin' ? 'free' : 'pin';
  } else {
    a.state = a.state === 'off' ? 'free' : 'off';
  }
  persist();
  render();
}

async function clearPool() {
  if (!data.pool.length) return;
  if (!(await confirmDialog({ title: '작가 풀 비우기', text: `풀의 작가 ${data.pool.length}명을 모두 뺍니다. 뽑은 결과와 즐겨찾기는 남습니다.`, ok: '비우기', danger: true }))) return;
  data.pool = [];
  persist();
  render();
}

function setAll(state) {
  for (const a of data.pool) a.state = state;
  persist();
  render();
}

// ---------------------------------------------------------------- drawing
// 선호 작가 반영: each free artist's draw weight from its 점수 in 작가 목록 (not registered / no score yet: ×1).
let scoreCache = null;
async function loadScores() {
  try {
    const artists = await get('/api/artists');
    scoreCache = Object.fromEntries(artists.filter((a) => a.combos).map((a) => [a.tag, a.score]));
  } catch { scoreCache = scoreCache || {}; }
  return scoreCache;
}
async function preference() {
  const boost = Number(cfg().favor) || 1;
  if (!(boost > 1)) return null;
  const scores = await loadScores();
  const free = data.pool.filter((a) => (a.state || 'free') === 'free').map((a) => a.tag);
  return artistPreference(scores, free, boost);
}

async function draw() {
  const problem = validate(data.pool, cfg());
  if (problem) return toast(problem, 'warn');
  const count = Math.max(1, Math.min(50, Math.trunc(Number(cfg().batch) || 1)));
  const avoid = new Set([...data.history.map((r) => r.key), ...results.map((r) => r.key)]);
  const batch = drawBatch(data.pool, cfg(), count, avoid, await preference());
  if (!batch.length) return toast('더 이상 새로운 조합을 만들 수 없습니다. 작가를 더 넣거나 범위를 넓혀 주세요.', 'warn');
  const at = Date.now();
  const made = batch.map((r, i) => ({ ...r, id: `${at.toString(36)}${i}`, time: at }));
  results = [...made, ...results].slice(0, RESULTS_LIMIT);
  data.history = [...made.map(({ id, key, text, style, pairs, time }) => ({ id, key, text, style, pairs, time })), ...data.history].slice(0, HISTORY_LIMIT);
  persist();
  view.tab = 'results';
  if (batch.length < count) toast(`새 조합은 ${batch.length}개까지만 만들 수 있었습니다.`, 'info');
  render();
  scrollToResults();
}

function scrollToResults() {
  const content = document.getElementById('content');
  const target = root.querySelector('.gacha-results');
  if (!content || !target) return;
  const top = content.scrollTop + target.getBoundingClientRect().top - content.getBoundingClientRect().top - 8;
  content.scrollTo({ top, behavior: 'smooth' });
}

async function reroll(r) {
  const avoid = new Set([...data.history.map((x) => x.key), ...results.map((x) => x.key)]);
  const [fresh] = drawBatch(data.pool, cfg(), 1, avoid, await preference());
  if (!fresh) return toast('더 이상 새로운 조합을 만들 수 없습니다.', 'warn');
  const next = { ...fresh, id: `${Date.now().toString(36)}r`, time: Date.now() };
  results = results.map((x) => (x.id === r.id ? next : x));
  data.history = [next, ...data.history].slice(0, HISTORY_LIMIT);
  persist();
  render();
}

// Text as the current output options write it (favourites keep their pairs, so they follow the options too).
const textOf = (r) => (r.pairs ? mixText(r.pairs, cfg()) : r.text);
const isFav = (r) => data.favorites.some((f) => f.key === r.key);

function toggleFav(r) {
  if (isFav(r)) data.favorites = data.favorites.filter((f) => f.key !== r.key);
  else data.favorites.unshift({ id: r.id, key: r.key, text: r.text, style: r.style, pairs: r.pairs, time: Date.now() });
  persist();
  render();
}

async function drawImages(list) {
  if (!list.length) return toast('그릴 조합을 골라 주세요.', 'warn');
  if (!app.conf?.api_key) return toast('설정에서 NovelAI API 키를 먼저 입력해 주세요.', 'warn');
  const ok = await confirmDialog({ title: `${list.length}개 그리기`, ok: '그리기',
    text: `뽑은 조합 ${list.length}개를 설정의 프롬프트·시드로 한 장씩 그려 그림체 목록에 넣습니다. 대결에서 순위가 정해집니다.\n가중치는 그림체 목록 형식(소수점 한 자리)으로 저장됩니다. 풀에만 있던 작가는 작가 목록에도 등록됩니다.` });
  if (!ok) return;
  const r = await app.act(post('/api/generate/styles', { styles: list.map((x) => x.style) }));
  toast(`${r.count}개를 그리기 시작했습니다${r.skipped ? ` (이미 있는 ${r.skipped}개 제외)` : ''}. 다 그려지면 대결에서 자리를 찾아 주세요.`, 'ok');
  selected.clear();
  render();
}

// ---------------------------------------------------------------- deleting
// 결과 · 기록: a draw is one entry in both (same id), so it goes from both. 즐겨찾기: only from the favourites.
function removeEntries(tab, ids) {
  const drop = new Set(ids);
  const before = { results, history: data.history, favorites: data.favorites };
  if (tab === 'favorites') data.favorites = data.favorites.filter((r) => !drop.has(r.id));
  else {
    results = results.filter((r) => !drop.has(r.id));
    data.history = data.history.filter((r) => !drop.has(r.id));
  }
  for (const id of drop) selected.delete(id);
  persist();
  render();
  return () => {
    results = before.results;
    data.history = before.history;
    data.favorites = before.favorites;
    persist();
    render();
  };
}

function deleteOne(r) {
  const undo = removeEntries(view.tab, [r.id]);
  toast(view.tab === 'favorites' ? '즐겨찾기에서 뺐습니다.' : '삭제했습니다.', 'ok', 5000, { label: '되돌리기', onclick: undo });
}

async function deleteMany(tab, list, { all = false } = {}) {
  if (!list.length) return;
  const where = tab === 'favorites' ? '즐겨찾기' : tab === 'history' ? '기록' : '결과';
  const ok = await confirmDialog({
    title: all ? `${where} 비우기` : `${list.length}개 삭제`,
    text: tab === 'favorites' ? `즐겨찾기 ${list.length}개를 뺍니다.`
      : `${where} ${list.length}개를 결과와 기록에서 지웁니다. 즐겨찾기에 넣은 것은 남습니다.\n이미 그려서 그림체 목록에 들어간 조합은 지워지지 않습니다.`,
    ok: all ? '비우기' : '삭제', danger: true });
  if (!ok) return;
  const undo = removeEntries(tab, list.map((r) => r.id));
  toast(`${list.length}개를 지웠습니다.`, 'ok', 6000, { label: '되돌리기', onclick: undo });
}

// ---------------------------------------------------------------- view
const num = (key, { step = 1, min, max, width = '70px' } = {}) => h('input', {
  class: 'input num', type: 'number', inputmode: step < 1 ? 'decimal' : 'numeric', step, min, max, value: cfg()[key], style: { width },
  onchange: (e) => {
    const v = Number(e.currentTarget.value);
    if (Number.isFinite(v)) { cfg()[key] = v; persist(); render(); }
  },
});
const toggle = (key, label) => h('label', { class: 'switch-row' },
  h('input', { type: 'checkbox', checked: Boolean(cfg()[key]), onchange: (e) => { cfg()[key] = e.currentTarget.checked; persist(); render(); } }),
  h('span', { class: 'switch' }), h('span', {}, label));
const select = (key, options) => h('select', { class: 'select', onchange: (e) => {
  const raw = e.currentTarget.value;
  cfg()[key] = typeof DEFAULT_CONFIG[key] === 'number' ? Number(raw) : raw;
  persist();
  render();
} },
  options.map(([v, label]) => h('option', { value: v, selected: String(cfg()[key]) === String(v) }, label)));

function chip(a) {
  const state = a.state || 'free';
  const pinInfo = state === 'pin' ? (a.w != null ? a.w.toFixed(cfg().step < 0.1 ? 2 : 1) : '랜덤') : null;
  return h('button', { class: `gchip ${state}`, key: a.tag, onclick: () => tapChip(a) },
    state === 'pin' ? icon('pin') : state === 'off' ? icon('ban') : null,
    h('span', { class: 'name' }, shortTag(a.tag)),
    pinInfo ? h('span', { class: 'w' }, pinInfo) : a.w0 != null && state === 'free' ? h('span', { class: 'w0' }, a.w0) : null);
}

function poolCard() {
  const c = counts();
  return card({ icon: 'users', title: `작가 풀 ${fmt(data.pool.length)}명`, desc: '뽑기에 쓸 작가들입니다. 칩을 누르면 아래에서 고른 동작(고정 · 제외 · 삭제)을 합니다.', cls: 'gacha-pool' },
    h('textarea', { class: 'textarea grow', rows: 3, value: view.input, oninput: (e) => { view.input = e.currentTarget.value; },
      placeholder: '1.2::artist:rurudo ::, artist:shigure ui ...\n프롬프트를 붙여 넣으면 artist: 태그만, 이름만 쉼표로 적으면 그 이름들을 넣습니다' }),
    h('div', { class: 'row wrap', style: { marginTop: '10px', gap: '6px' } },
      h('button', { class: 'btn primary', onclick: addFromText }, icon('plus'), '풀에 넣기'),
      h('button', { class: 'btn', onclick: addRegistered }, icon('users'), '등록 작가'),
      h('button', { class: 'btn', onclick: addFromPng }, icon('image'), 'PNG에서')),
    data.pool.length ? [
      h('div', { class: 'row wrap gacha-tapbar' },
        h('span', { class: 'field-label' }, '누르면'),
        h('div', { class: 'segmented' }, TAP_MODES.map(([mode, label]) => h('button', { class: view.tap === mode ? 'on' : '', onclick: () => { view.tap = mode; render(); } }, label))),
        h('span', { class: 'spacer' }),
        h('span', { class: 'note' }, `후보 ${c.free} · 고정 ${c.pin} · 제외 ${c.off}`)),
      h('div', { class: 'gchips' }, data.pool.map(chip)),
      h('div', { class: 'row wrap', style: { marginTop: '10px', gap: '6px' } },
        h('button', { class: 'btn ghost sm', onclick: () => setAll('free') }, '모두 후보로'),
        h('button', { class: 'btn ghost sm danger-text', onclick: clearPool }, icon('trash'), '풀 비우기')),
    ] : h('p', { class: 'note' }, '아직 비어 있습니다. 작가 태그를 붙여 넣거나, 작가 목록에 등록한 작가를 불러오세요.'));
}

function pinnedCard() {
  const pins = data.pool.filter((a) => a.state === 'pin');
  if (!pins.length) return null;
  const d = cfg().step < 0.1 ? 2 : 1;
  return card({ icon: 'pin', tone: 'amber', title: `고정 작가 ${pins.length}명`, desc: '매번 들어가는 작가입니다. 가중치를 비우면 랜덤, 숫자를 넣으면 그 값으로 고정됩니다.' },
    h('div', { class: 'pin-list' }, pins.map((a) => h('div', { class: 'pin-row', key: a.tag },
      h('div', { class: 'pin-name' }, icon('pin'), h('span', {}, shortTag(a.tag))),
      h('div', { class: 'pin-controls' },
        h('input', { class: 'input num', type: 'number', inputmode: 'decimal', step: cfg().step, placeholder: '랜덤', value: a.w ?? '', style: { width: '78px' },
          onchange: (e) => { const v = e.currentTarget.value.trim(); a.w = v === '' ? null : Number(Number(v).toFixed(d)); if (!Number.isFinite(a.w)) a.w = null; persist(); render(); } }),
        a.w0 != null && a.w !== a.w0 ? h('button', { class: 'btn ghost sm', onclick: () => { a.w = a.w0; persist(); render(); } }, `원래 ${a.w0}`) : null,
        a.w != null ? h('button', { class: 'btn ghost sm', onclick: () => { a.w = null; persist(); render(); } }, '랜덤') : null,
        h('select', { class: 'select sm', onchange: (e) => { a.pos = e.currentTarget.value; persist(); } },
          POSITIONS.map(([v, label]) => h('option', { value: v, selected: (a.pos || 'any') === v }, label))),
        h('button', { class: 'btn ghost icon-btn sm', 'aria-label': '고정 풀기', onclick: () => { a.state = 'free'; persist(); render(); } }, icon('x')))))));
}

function rulesCard() {
  const c = cfg();
  const pins = counts().pin;
  return card({ icon: 'sliders', tone: 'sky', title: '뽑기 규칙', desc: '작가 수, 가중치, 순서를 정합니다. NAI V5 가중치 문법(1.2::태그 ::)으로 출력합니다.' },
    h('div', { class: 'rule-grid' },
      h('div', { class: 'rule' }, h('div', { class: 'note' }, `작가 수${pins ? ` (고정 ${pins}명 포함)` : ''}`),
        h('div', { class: 'range-pair' }, num('countMin', { min: 1, max: 30 }), h('span', {}, '~'), num('countMax', { min: 1, max: 30 }))),
      h('div', { class: 'rule' }, h('div', { class: 'note' }, '가중치 범위'),
        h('div', { class: 'range-pair' }, num('wMin', { step: 0.05, min: 0.05, max: 5 }), h('span', {}, '~'), num('wMax', { step: 0.05, min: 0.05, max: 5 }))),
      h('div', { class: 'rule' }, h('div', { class: 'note' }, '가중치 단위'), select('step', [[0.1, '0.1 단위'], [0.05, '0.05 단위']])),
      h('div', { class: 'rule' }, h('div', { class: 'note' }, '순서'), select('order', ORDERS))),
    h('div', { class: 'stack', style: { gap: '10px', marginTop: '12px' } },
      toggle('pinRange', '고정 작가는 가중치 범위를 따로 정하기'),
      c.pinRange ? h('div', { class: 'range-pair', style: { maxWidth: '240px', marginLeft: '46px' } },
        num('pinMin', { step: 0.05, min: 0.05, max: 5 }), h('span', {}, '~'), num('pinMax', { step: 0.05, min: 0.05, max: 5 })) : null,
      toggle('unique', '이미 뽑은 조합은 다시 뽑지 않기'),
      toggle('space', '닫는 :: 앞에 공백 넣기 (1.2::artist:x ::)'),
      toggle('omitOne', '가중치 1.0인 작가는 태그만 쓰기')),
    h('div', { class: 'rule-grid', style: { marginTop: '12px' } },
      h('div', { class: 'rule' }, h('div', { class: 'note' }, '전체 가중치 배율'), num('scale', { step: 0.05, min: 0.05, max: 5, width: '100%' }),
        h('div', { class: 'note', style: { marginTop: '4px' } }, '뽑은 뒤 모든 가중치에 곱합니다 (예: 0.7).')),
      h('div', { class: 'rule wide' }, h('div', { class: 'note' }, '선호 작가 반영'), select('favor', FAVOR_LEVELS),
        h('div', { class: 'note', style: { marginTop: '4px' } }, Number(c.favor) > 1
          ? `대결 점수가 높은 작가가 더 자주 뽑힙니다 (1위 ×${c.favor}, 꼴찌 ×${Math.round(100 / c.favor) / 100}, 점수 없는 작가 ×1). 고정 작가는 상관없이 항상 들어갑니다.`
          : '끄면 후보 작가가 모두 같은 확률로 뽑힙니다.')),
      h('div', { class: 'rule wide' }, h('div', { class: 'note' }, '출력 틀 ({artist} 자리에 작가 믹스)'),
        h('textarea', { class: 'textarea', rows: 2, value: c.template, style: { minHeight: '56px' },
          onchange: (e) => { c.template = e.currentTarget.value; persist(); render(); } }))));
}

function drawBar() {
  return h('div', { class: 'gacha-drawbar' },
    h('label', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'field-label' }, '개수'), num('batch', { min: 1, max: 50, width: '64px' })),
    h('button', { class: 'btn primary lg gacha-go', onclick: draw }, icon('dice'), '뽑기'));
}

function resultCard(r, { fav = false } = {}) {
  const text = textOf(r);
  const on = selected.has(r.id);
  return h('div', { class: `gresult ${on ? 'selected' : ''}`, key: r.id },
    h('div', { class: 'gresult-text mono', onclick: () => copyText(text, '프롬프트를 복사했습니다.') }, text),
    h('div', { class: 'tags open' }, r.pairs.map(([w, t]) => h('span', { class: 'tag' },
      h('span', { class: `w ${w >= 1.3 ? 'hi' : w <= 0.8 ? 'lo' : ''}` }, w.toFixed(cfg().step < 0.1 ? 2 : 1)), shortTag(t)))),
    h('div', { class: 'gresult-actions' },
      h('button', { class: `tile-check ${on ? 'on' : ''}`, 'aria-label': '선택', onclick: () => { on ? selected.delete(r.id) : selected.add(r.id); render(); } }, icon('check', 'width="14" height="14"')),
      h('button', { class: 'btn primary sm', onclick: () => copyText(text, '프롬프트를 복사했습니다.') }, icon('copy'), '복사'),
      h('button', { class: `btn sm ${isFav(r) ? 'fav-on' : ''}`, 'aria-label': '즐겨찾기', onclick: () => toggleFav(r) }, icon('star')),
      fav ? null : h('button', { class: 'btn sm', 'aria-label': '다시 뽑기', onclick: () => reroll(r) }, icon('refresh')),
      h('button', { class: 'btn sm danger-text', 'aria-label': view.tab === 'favorites' ? '즐겨찾기에서 빼기' : '삭제', onclick: () => deleteOne(r) }, icon('trash')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => drawImages([r]) }, icon('brush'), '그리기')));
}

function listFor(tab) {
  if (tab === 'favorites') return data.favorites;
  if (tab === 'history') return data.history;
  return results;
}

function resultsSection() {
  const list = listFor(view.tab);
  const chosen = list.filter((r) => selected.has(r.id));
  const tabs = [['results', `결과 ${results.length}`], ['favorites', `즐겨찾기 ${data.favorites.length}`], ['history', `기록 ${data.history.length}`]];
  return h('section', { class: 'gacha-results' },
    h('div', { class: 'row wrap', style: { gap: '8px', marginBottom: '10px' } },
      h('div', { class: 'segmented' }, tabs.map(([id, label]) => h('button', { class: view.tab === id ? 'on' : '', onclick: () => { view.tab = id; selected.clear(); render(); } }, label))),
      h('span', { class: 'spacer' }),
      list.length ? h('button', { class: 'btn sm', onclick: () => copyText(list.map(textOf).join('\n\n'), `${list.length}개를 복사했습니다.`) }, icon('copy'), '전체 복사') : null),
    list.length ? h('div', { class: 'row wrap', style: { gap: '6px', marginBottom: '10px' } },
      h('button', { class: 'btn ghost sm', onclick: () => { const all = list.every((r) => selected.has(r.id)); for (const r of list) all ? selected.delete(r.id) : selected.add(r.id); render(); } },
        list.every((r) => selected.has(r.id)) ? '선택 해제' : '모두 선택'),
      chosen.length ? h('button', { class: 'btn ghost sm', onclick: () => copyText(chosen.map(textOf).join('\n\n'), `${chosen.length}개를 복사했습니다.`) }, icon('copy'), `선택 ${chosen.length}개 복사`) : null,
      chosen.length ? h('button', { class: 'btn primary sm', onclick: () => drawImages(chosen) }, icon('brush'), `선택 ${chosen.length}개 그리기`) : null,
      chosen.length ? h('button', { class: 'btn ghost sm danger-text', onclick: () => deleteMany(view.tab, chosen) }, icon('trash'), `선택 ${chosen.length}개 삭제`)
        : h('button', { class: 'btn ghost sm danger-text', onclick: () => deleteMany(view.tab, list, { all: true }) }, icon('trash'),
          view.tab === 'favorites' ? '즐겨찾기 비우기' : view.tab === 'history' ? '기록 비우기' : '결과 비우기')) : null,
    list.length ? h('div', { class: 'gresults' }, list.map((r) => resultCard(r, { fav: view.tab !== 'results' })))
      : h('div', { class: 'card' }, emptyState({ iconName: view.tab === 'favorites' ? 'star' : 'dice',
        title: view.tab === 'favorites' ? '즐겨찾기가 없습니다' : view.tab === 'history' ? '아직 뽑은 기록이 없습니다' : '뽑기를 눌러 보세요',
        text: view.tab === 'favorites' ? '결과의 ☆를 누르면 여기에 모입니다.' : '규칙대로 작가 믹스를 만들어 여기에 보여 줍니다. 누르면 복사됩니다.' })));
}

function render() {
  morph(root,
    pageHead({ title: '그림체 뽑기', desc: 'NAI V5 작가 태그 믹스를 무작위로 뽑습니다. 작가 수 · 가중치 · 순서를 섞고, 고정한 작가는 매번 들어갑니다.' }),
    h('div', { class: 'gacha-grid' },
      h('div', { class: 'stack', style: { gap: '14px' } }, poolCard(), pinnedCard(), rulesCard()),
      h('div', { class: 'stack', style: { gap: '14px' } }, drawBar(), resultsSection())));
}

export default {
  async mount(el, appRef) {
    app = appRef;
    root = h('div', { class: 'gacha' });
    el.append(root);
    try {
      const saved = await get('/api/gacha');
      data = {
        pool: Array.isArray(saved.pool) ? saved.pool : [],
        config: { ...DEFAULT_CONFIG, ...(saved.config || {}) },
        favorites: Array.isArray(saved.favorites) ? saved.favorites : [],
        history: Array.isArray(saved.history) ? saved.history : [],
      };
      if (Array.isArray(saved.results)) results = saved.results.slice(0, RESULTS_LIMIT);
      scoreCache = null;
    } catch (error) {
      toast(error.message, 'error');
    }
    render();
  },
  unmount() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      post('/api/gacha/save', { data: { ...data, results } }).catch(() => {});
    }
  },
};
