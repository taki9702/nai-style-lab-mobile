// 프롬프트 섞기 — NovelAI PNGs read in whole (artists, quality tags, undesired content), mixed into new style prompts.
// The scene and character prompts are left out (they come from the settings). Each picture's prompt is split into
// blocks right away and shown, so a wrong guess is fixed with a tap; results copy out or are drawn into the arena.
import { get, post } from '../api.js';
import { h, morph, icon, toast, copyText, pageHead, card, emptyState, confirmDialog, promptDialog, shortTag, novelaiMeta, stealthMeta, fmt, modal } from '../ui.js';
import { DEFAULT_MIX_CONFIG, sourceFromMeta, sourceParts, drawMixtures, mixTexts, validateMix, knownArtists, artistTagsIn, promptsOf, makeArtist, unArtist } from '../backend/mixer.js';

const HISTORY_LIMIT = 200;
const RESULTS_LIMIT = 100;
const SOURCES_LIMIT = 40;
const RATIOS = [[0, '안 씀'], [0.5, '×0.5'], [1, '×1'], [2, '×2'], [3, '×3']];
const ROLE_LABEL = {
  style: ['작가', 'accent'], quality: ['품질 · 그림체', 'sky'], scene: ['장면 · 구도', ''], mixed: ['한 덩어리 (태그별로 나눔)', 'amber'],
  'neg-style': ['네거티브 · 그림체', 'rose'], 'neg-scene': ['네거티브 · 장면', ''], 'neg-mixed': ['네거티브 (태그별로 나눔)', 'amber'],
};
const STATE_NEXT = { use: 'pin', pin: 'off', off: 'use' };

let root, app;
let data = { sources: [], config: { ...DEFAULT_MIX_CONFIG }, favorites: [], history: [] };
let results = [];
let selected = new Set();
const view = { tab: 'results', open: new Set() };
let saveTimer = null;

const cfg = () => data.config;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; post('/api/mixer/save', { data: { ...data, results } }).catch(() => {}); }, 400);
}

// ---------------------------------------------------------------- reading pictures
function pickFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png';
    input.multiple = true;
    input.style.display = 'none';
    let settled = false;
    const finish = (files) => { if (settled) return; settled = true; input.remove(); resolve(files ? [...files] : []); };
    input.addEventListener('change', () => finish(input.files));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}

async function thumbOf(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 120 / bitmap.width, 160 / bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * scale)), hgt = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, hgt);
    bitmap.close?.();
    return canvas.toDataURL('image/webp', 0.7);
  } catch { return null; }
}

async function addPictures() {
  const files = await pickFiles();
  if (!files.length) return;
  const room = SOURCES_LIMIT - data.sources.length;
  if (room <= 0) return toast(`그림은 ${SOURCES_LIMIT}장까지 넣을 수 있습니다. 안 쓰는 그림을 지워 주세요.`, 'warn');
  const added = [];
  let noMeta = 0, noStyle = 0;
  const read = [];
  for (const file of files.slice(0, room)) {
    const meta = novelaiMeta(new Uint8Array(await file.arrayBuffer())) || await stealthMeta(file).catch(() => null);
    if (!meta) { noMeta += 1; continue; }
    read.push([file, meta]);
  }
  // Names written bare (ebora for artist:ebora) are known from the artist list, the registered artists, and every
  // artist written with "artist:" in these pictures or the ones read before.
  const known = await knownNames(read.map(([, meta]) => promptsOf(meta).positive));
  for (const [file, meta] of read) {
    const src = sourceFromMeta(meta, { name: file.name.replace(/\.png$/i, ''), thumb: await thumbOf(file), known });
    const parts = sourceParts(src);
    if (!parts.artist.length && !parts.quality.length && !parts.neg.length) { noStyle += 1; continue; }
    added.push(src);
  }
  data.sources.push(...added);
  persist();
  render();
  const notes = [];
  if (noMeta) notes.push(`프롬프트 정보가 없는 그림 ${noMeta}장 (NovelAI에서 받은 PNG 원본이 아니거나, 메신저·SNS를 거치며 지워진 그림)`);
  if (noStyle) notes.push(`작가 · 품질 태그가 없는 그림 ${noStyle}장`);
  if (files.length > room) notes.push(`${SOURCES_LIMIT}장을 넘는 ${files.length - room}장`);
  if (added.length) toast(`그림 ${added.length}장을 읽었습니다. 나뉜 결과를 확인해 주세요.${notes.length ? `\n빠진 것: ${notes.join(', ')}` : ''}`, notes.length ? 'warn' : 'ok', notes.length ? 9000 : undefined);
  else toast(`읽은 그림이 없습니다. ${notes.join(', ')}`, 'warn', 9000);
  if (added.length === 1) editSource(added[0]);
  else for (const s of added) view.open.add(s.id);
  if (added.length > 1) render();
}

async function knownNames(texts = []) {
  let registered = [];
  try { registered = (await get('/api/artists')).map((a) => a.tag); } catch { /* the list alone */ }
  const fromSources = data.sources.flatMap((s) => s.blocks.flatMap((b) => b.tokens.filter((t) => t.kind === 'artist').map((t) => t.tag)));
  return knownArtists([...registered, ...fromSources, ...texts.flatMap(artistTagsIn)]);
}

// ---------------------------------------------------------------- editing one picture's split
function summary(src) {
  const p = sourceParts(src);
  const scene = src.blocks.reduce((n, b) => n + b.tokens.filter((t) => t.state === 'off').length, 0);
  const pins = src.blocks.reduce((n, b) => n + b.tokens.filter((t) => t.state === 'pin').length, 0);
  return `작가 ${p.artist.length} · 품질 ${p.quality.length} · 네거티브 ${p.neg.length} · 뺀 태그 ${scene}${pins ? ` · 고정 ${pins}` : ''}`;
}

function tokenChip(t, onTap, kindMode = false) {
  const state = t.state || 'use';
  const weight = Math.abs(t.w - 1) > 1e-9 ? String(t.w) : null;
  const cls = kindMode ? (t.kind === 'artist' ? 'artist' : 'free') : state === 'use' ? 'free' : state;
  return h('button', { class: `gchip ${cls}`, onclick: onTap },
    kindMode ? (t.kind === 'artist' ? icon('users') : null) : state === 'pin' ? icon('pin') : state === 'off' ? icon('ban') : null,
    h('span', { class: 'name' }, t.kind === 'artist' ? shortTag(t.tag) : t.tag),
    t.guessed ? h('span', { class: 'w0', title: '작가 목록에 없지만 작가 블록에 있어 작가로 본 이름' }, '?') : null,
    weight ? h('span', { class: 'w' }, weight) : null);
}

async function editSource(src) {
  view.open.delete(src.id);
  await modal((dialog, done) => {
    dialog.classList.add('viewer', 'mixer-editor');
    const body = h('div', { class: 'stack', style: { gap: '12px' } });
    let mode = 'state';  // state: 넣기 · 고정 · 빼기 | kind: 작가 지정
    const tapKind = (t) => {
      if (t.kind === 'artist') unArtist(t);
      else { makeArtist(t); if (t.state === 'off') t.state = 'use'; }
    };
    const paint = () => {
      const kindMode = mode === 'kind';
      morph(body,
        h('div', { class: 'segmented' }, [['state', '넣기 · 고정 · 빼기'], ['kind', '작가 지정']].map(([m, label]) =>
          h('button', { class: mode === m ? 'on' : '', onclick: () => { mode = m; paint(); } }, label))),
        h('p', { class: 'note' }, kindMode
          ? '작가인 태그를 누르면 작가로 바뀌고(artist:이름으로 씀), 한 번 더 누르면 원래대로 돌아갑니다. ?는 작가 목록에 없지만 작가 블록에 있어 작가로 본 이름입니다.'
          : '태그를 누르면 넣기 → 고정(매번 들어감) → 빼기 순서로 바뀝니다. 블록 오른쪽 버튼으로 블록 전체를 넣거나 뺍니다.'),
        src.blocks.map((b, i) => {
          const [label, tone] = ROLE_LABEL[b.role] || [b.role, ''];
          const on = b.tokens.some((t) => t.state !== 'off');
          const allArtist = b.side === 'pos' && b.tokens.every((t) => t.kind === 'artist');
          return h('div', { class: `mixer-block ${on || kindMode ? '' : 'off'}`, key: String(i) },
            h('div', { class: 'row', style: { gap: '8px' } },
              h('span', { class: `badge ${tone}` }, label),
              h('span', { class: 'note' }, `${b.tokens.length}개`),
              h('span', { class: 'spacer' }),
              kindMode
                ? (b.side === 'pos' ? h('button', { class: 'btn ghost sm', onclick: () => {
                  for (const t of b.tokens) allArtist ? unArtist(t) : (t.kind !== 'artist' && tapKind(t));
                  paint();
                } }, allArtist ? '작가 지정 풀기' : '블록 전체 작가로') : null)
                : h('button', { class: 'btn ghost sm', onclick: () => {
                  for (const t of b.tokens) t.state = on ? 'off' : 'use';
                  paint();
                } }, on ? '블록 빼기' : '블록 넣기')),
            h('div', { class: 'gchips' }, b.tokens.map((t) => tokenChip(t, () => {
              if (kindMode) { if (b.side === 'pos') tapKind(t); } else t.state = STATE_NEXT[t.state || 'use'];
              paint();
            }, kindMode && b.side === 'pos'))));
        }),
        h('p', { class: 'note' }, summary(src)),
        src.prompt ? h('button', { class: 'btn ghost sm', onclick: async () => {
          if (!(await confirmDialog({ title: '처음부터 다시 나누기', ok: '다시 나누기', text: '이 그림에서 고친 것(넣기 · 고정 · 빼기, 작가 지정)을 버리고 처음 읽은 상태로 다시 나눕니다. 등록 작가와 다른 그림의 작가도 다시 확인합니다.' }))) return;
          const fresh = sourceFromMeta({ prompt: src.prompt.positive, uc: src.prompt.negative }, { known: await knownNames([src.prompt.positive]) });
          src.blocks = fresh.blocks;
          paint();
        } }, icon('refresh'), '처음부터 다시 나누기') : null);
    };
    paint();
    dialog.append(
      h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
        src.thumb ? h('img', { class: 'mixer-thumb', src: src.thumb, alt: '' }) : null,
        h('div', {}, h('h3', {}, src.name), h('p', { class: 'note' }, [src.settings?.model, src.settings?.width && `${src.settings.width}×${src.settings.height}`].filter(Boolean).join(' · ')))),
      body,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => done(null) }, '확인')));
  });
  persist();
  render();
}

async function renameSource(src) {
  const name = await promptDialog({ title: '그림 이름', value: src.name, ok: '바꾸기' });
  if (name == null || !name.trim()) return;
  src.name = name.trim();
  persist();
  render();
}

function removeSource(src) {
  const at = data.sources.indexOf(src);
  data.sources = data.sources.filter((s) => s !== src);
  persist();
  render();
  toast(`'${src.name}'을(를) 뺐습니다.`, 'ok', 5000, { label: '되돌리기', onclick: () => {
    data.sources.splice(Math.min(at, data.sources.length), 0, src);
    persist();
    render();
  } });
}

// ---------------------------------------------------------------- mixing
function mix() {
  const problem = validateMix(data.sources, cfg());
  if (problem) return toast(problem, 'warn');
  const count = Math.max(1, Math.min(50, Math.trunc(Number(cfg().batch) || 1)));
  const avoid = new Set([...data.history.map((r) => r.key), ...results.map((r) => r.key)]);
  const batch = drawMixtures(data.sources, cfg(), count, avoid);
  if (!batch.length) return toast('더 이상 새로운 조합을 만들 수 없습니다. 그림을 더 넣거나 작가 수 범위를 넓혀 주세요.', 'warn');
  const at = Date.now();
  const made = batch.map((m, i) => ({ ...m, id: `${at.toString(36)}${i}`, time: at }));
  results = [...made, ...results].slice(0, RESULTS_LIMIT);
  data.history = [...made, ...data.history].slice(0, HISTORY_LIMIT);
  persist();
  view.tab = 'results';
  if (batch.length < count) toast(`새 조합은 ${batch.length}개까지만 만들 수 있었습니다.`, 'info');
  render();
  const content = document.getElementById('content');
  const target = root.querySelector('.gacha-results');
  if (content && target) content.scrollTo({ top: content.scrollTop + target.getBoundingClientRect().top - content.getBoundingClientRect().top - 8, behavior: 'smooth' });
}

function remix(r) {
  const avoid = new Set([...data.history.map((x) => x.key), ...results.map((x) => x.key)]);
  const [fresh] = drawMixtures(data.sources, cfg(), 1, avoid);
  if (!fresh) return toast('더 이상 새로운 조합을 만들 수 없습니다.', 'warn');
  const next = { ...fresh, id: `${Date.now().toString(36)}r`, time: Date.now() };
  results = results.map((x) => (x.id === r.id ? next : x));
  data.history = [next, ...data.history].slice(0, HISTORY_LIMIT);
  persist();
  render();
}

const isFav = (r) => data.favorites.some((f) => f.key === r.key);
function toggleFav(r) {
  if (isFav(r)) data.favorites = data.favorites.filter((f) => f.key !== r.key);
  else data.favorites.unshift({ ...r, time: Date.now() });
  persist();
  render();
}

async function drawImages(list) {
  if (!list.length) return toast('그릴 조합을 골라 주세요.', 'warn');
  if (!app.conf?.api_key) return toast('설정에서 NovelAI API 키를 먼저 입력해 주세요.', 'warn');
  const base = String(app.settings.base_prompt || '');
  const replace = cfg().negApply === 'replace';
  const ok = await confirmDialog({ title: `${list.length}개 그리기`, ok: '그리기',
    text: `섞은 프롬프트 ${list.length}개를 한 장씩 그려 그림체 목록에 넣습니다. 대결에서 순위가 정해집니다.\n\n`
      + `작가와 품질 태그는 설정의 기본 프롬프트 ${base.includes('{artist}') ? '{artist} 자리에' : '맨 앞에'} 들어가고, 장면 · 캐릭터는 설정의 것을 씁니다.\n`
      + `네거티브는 ${replace ? '섞은 것만 씁니다 (설정의 네거티브는 쓰지 않음).' : '섞은 것 뒤에 설정의 네거티브를 붙입니다 (겹치는 태그는 한 번만).'}` });
  if (!ok) return;
  const items = list.map((r) => { const t = mixTexts(r); return { style: t.style, extra: t.extra, negative: t.negative }; });
  const res = await app.act(post('/api/generate/mixes', { items, negApply: cfg().negApply }));
  toast(`${res.count}개를 그리기 시작했습니다${res.skipped ? ` (이미 있는 ${res.skipped}개 제외)` : ''}. 다 그려지면 대결에서 자리를 찾아 주세요.`, 'ok');
  selected.clear();
  render();
}

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
  return () => { results = before.results; data.history = before.history; data.favorites = before.favorites; persist(); render(); };
}

async function deleteMany(tab, list, all = false) {
  if (!list.length) return;
  const where = tab === 'favorites' ? '즐겨찾기' : tab === 'history' ? '기록' : '결과';
  const ok = await confirmDialog({ title: all ? `${where} 비우기` : `${list.length}개 삭제`, ok: all ? '비우기' : '삭제', danger: true,
    text: tab === 'favorites' ? `즐겨찾기 ${list.length}개를 뺍니다.` : `${where} ${list.length}개를 결과와 기록에서 지웁니다. 즐겨찾기와 이미 그린 조합은 남습니다.` });
  if (!ok) return;
  const undo = removeEntries(tab, list.map((r) => r.id));
  toast(`${list.length}개를 지웠습니다.`, 'ok', 6000, { label: '되돌리기', onclick: undo });
}

// ---------------------------------------------------------------- view
const num = (key, { step = 1, min, max, width = '70px' } = {}) => h('input', {
  class: 'input num', type: 'number', inputmode: step < 1 ? 'decimal' : 'numeric', step, min, max, value: cfg()[key], style: { width },
  onchange: (e) => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) { cfg()[key] = v; persist(); render(); } },
});
const select = (key, options) => h('select', { class: 'select', onchange: (e) => {
  const raw = e.currentTarget.value;
  cfg()[key] = typeof DEFAULT_MIX_CONFIG[key] === 'number' ? Number(raw) : raw;
  persist();
  render();
} }, options.map(([v, label]) => h('option', { value: v, selected: String(cfg()[key]) === String(v) }, label)));
const toggle = (key, label) => h('label', { class: 'switch-row' },
  h('input', { type: 'checkbox', checked: Boolean(cfg()[key]), onchange: (e) => { cfg()[key] = e.currentTarget.checked; persist(); render(); } }),
  h('span', { class: 'switch' }), h('span', {}, label));

function sourceRow(src) {
  return h('div', { class: `mixer-source ${src.ratio > 0 ? '' : 'off'}`, key: src.id },
    h('button', { class: 'mixer-source-main', onclick: () => editSource(src) },
      src.thumb ? h('img', { class: 'mixer-thumb', src: src.thumb, alt: '' }) : h('div', { class: 'mixer-thumb empty' }, icon('image')),
      h('div', { class: 'mixer-source-text' },
        h('div', { class: 'title' }, src.name, view.open.has(src.id) ? h('span', { class: 'badge amber', style: { marginLeft: '6px' } }, '확인') : null),
        h('div', { class: 'note' }, summary(src)))),
    h('div', { class: 'mixer-source-controls' },
      h('select', { class: 'select sm', 'aria-label': '비율', onchange: (e) => { src.ratio = Number(e.currentTarget.value); persist(); render(); } },
        RATIOS.map(([v, label]) => h('option', { value: v, selected: Number(src.ratio) === v }, label))),
      h('button', { class: 'btn ghost icon-btn sm', 'aria-label': '나뉜 결과 보기', onclick: () => editSource(src) }, icon('eye')),
      h('button', { class: 'btn ghost icon-btn sm', 'aria-label': '이름 바꾸기', onclick: () => renameSource(src) }, icon('pen')),
      h('button', { class: 'btn ghost icon-btn sm danger-text', 'aria-label': '빼기', onclick: () => removeSource(src) }, icon('trash'))));
}

function sourcesCard() {
  const on = data.sources.filter((s) => s.ratio > 0).length;
  return card({ icon: 'image', title: `그림 ${fmt(data.sources.length)}장`, cls: 'mixer-sources',
    desc: 'NovelAI에서 받은 PNG 원본을 여러 장 고르세요. 프롬프트를 작가 · 품질 · 장면 · 네거티브로 나누고, 장면과 캐릭터는 뺍니다. 그림을 누르면 나뉜 결과를 고칠 수 있습니다.' },
    h('div', { class: 'row wrap', style: { gap: '6px' } },
      h('button', { class: 'btn primary', onclick: addPictures }, icon('upload'), 'PNG 올리기'),
      h('span', { class: 'spacer' }),
      data.sources.length ? h('span', { class: 'note' }, `섞는 그림 ${on} · 안 씀 ${data.sources.length - on}`) : null),
    data.sources.length ? h('div', { class: 'mixer-source-list' }, data.sources.map(sourceRow))
      : h('p', { class: 'note', style: { marginTop: '10px' } }, '아직 비어 있습니다. 카카오톡 · 디스코드로 주고받은 그림이나 캡처는 프롬프트 정보가 지워져 있을 수 있습니다.'),
    data.sources.length ? h('p', { class: 'note', style: { marginTop: '8px' } }, '비율: 그 그림이 섞기에 뽑히는 빈도와 그 그림 작가가 들어가는 빈도입니다. 0이면 쓰지 않습니다.') : null);
}

function rulesCard() {
  const range = (label, a, b, max) => h('div', { class: 'rule' }, h('div', { class: 'note' }, label),
    h('div', { class: 'range-pair' }, num(a, { min: 1, max }), h('span', {}, '~'), num(b, { min: 1, max })));
  return card({ icon: 'sliders', tone: 'sky', title: '섞기 규칙', desc: '한 번 섞을 때마다 아래 범위 안에서 무작위로 정합니다. 고정한 태그는 매번 들어갑니다.' },
    h('div', { class: 'rule-grid' },
      range('한 번에 섞을 그림 (장)', 'srcMin', 'srcMax', SOURCES_LIMIT),
      range('작가 수 (고정 포함)', 'artistMin', 'artistMax', 40),
      h('div', { class: 'rule' }, h('div', { class: 'note' }, '작가 가중치 흔들기'),
        select('jitter', [[0, '그림 그대로'], [0.1, '±0.1'], [0.2, '±0.2'], [0.3, '±0.3']])),
      h('div', { class: 'rule' }, h('div', { class: 'note' }, '작가 순서'),
        select('order', [['shuffle', '무작위 섞기'], ['weight-desc', '가중치 높은 순'], ['source', '그림 순서대로']])),
      h('div', { class: 'rule' }, h('div', { class: 'note' }, '품질 태그'),
        select('quality', [['union', '모두 합치기'], ['one', '한 그림 것만']])),
      h('div', { class: 'rule' }, h('div', { class: 'note' }, '네거티브'),
        select('negative', [['union', '모두 합치기'], ['one', '한 그림 것만']])),
      h('div', { class: 'rule wide' }, h('div', { class: 'note' }, '앱에서 그릴 때 네거티브'),
        select('negApply', [['merge', '섞은 것 + 설정 것'], ['replace', '섞은 것만']]))),
    h('div', { class: 'stack', style: { gap: '10px', marginTop: '12px' } }, toggle('unique', '이미 섞은 조합은 다시 만들지 않기')));
}

function drawBar() {
  return h('div', { class: 'gacha-drawbar' },
    h('label', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'field-label' }, '개수'), num('batch', { min: 1, max: 50, width: '64px' })),
    h('button', { class: 'btn primary lg gacha-go', onclick: mix }, icon('shuffle'), '섞기'));
}

function resultCard(r, { fav = false } = {}) {
  const t = mixTexts(r);
  const on = selected.has(r.id);
  const names = new Map(data.sources.map((s) => [s.id, s.name]));
  const from = (r.from || []).map((id) => names.get(id) || '지운 그림');
  return h('div', { class: `gresult ${on ? 'selected' : ''}`, key: r.id },
    h('div', { class: 'gresult-text mono', onclick: () => copyText(t.prompt, '프롬프트를 복사했습니다.') }, t.prompt),
    h('div', { class: 'tags open' }, r.artists.map(([w, tag]) => h('span', { class: 'tag' },
      h('span', { class: `w ${w >= 1.3 ? 'hi' : w <= 0.8 ? 'lo' : ''}` }, w.toFixed(1)), shortTag(tag)))),
    t.negative ? h('details', { class: 'mixer-neg' }, h('summary', {}, `네거티브 ${r.negative.length}개`),
      h('div', { class: 'gresult-text mono', onclick: () => copyText(t.negative, '네거티브를 복사했습니다.') }, t.negative)) : null,
    from.length ? h('div', { class: 'note' }, `섞은 그림: ${from.join(', ')}`) : null,
    h('div', { class: 'gresult-actions' },
      h('button', { class: `tile-check ${on ? 'on' : ''}`, 'aria-label': '선택', onclick: () => { on ? selected.delete(r.id) : selected.add(r.id); render(); } }, icon('check', 'width="14" height="14"')),
      h('button', { class: 'btn primary sm', onclick: () => copyText(t.prompt, '프롬프트를 복사했습니다.') }, icon('copy'), '프롬프트'),
      t.negative ? h('button', { class: 'btn sm', onclick: () => copyText(t.negative, '네거티브를 복사했습니다.') }, icon('copy'), '네거티브') : null,
      h('button', { class: `btn sm ${isFav(r) ? 'fav-on' : ''}`, 'aria-label': '즐겨찾기', onclick: () => toggleFav(r) }, icon('star')),
      fav ? null : h('button', { class: 'btn sm', 'aria-label': '다시 섞기', onclick: () => remix(r) }, icon('refresh')),
      h('button', { class: 'btn sm danger-text', 'aria-label': '삭제', onclick: () => {
        const undo = removeEntries(view.tab, [r.id]);
        toast(view.tab === 'favorites' ? '즐겨찾기에서 뺐습니다.' : '삭제했습니다.', 'ok', 5000, { label: '되돌리기', onclick: undo });
      } }, icon('trash')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => drawImages([r]) }, icon('brush'), '그리기')));
}

function resultsSection() {
  const list = view.tab === 'favorites' ? data.favorites : view.tab === 'history' ? data.history : results;
  const chosen = list.filter((r) => selected.has(r.id));
  const tabs = [['results', `결과 ${results.length}`], ['favorites', `즐겨찾기 ${data.favorites.length}`], ['history', `기록 ${data.history.length}`]];
  const allOn = list.length && list.every((r) => selected.has(r.id));
  return h('section', { class: 'gacha-results' },
    h('div', { class: 'row wrap', style: { gap: '8px', marginBottom: '10px' } },
      h('div', { class: 'segmented' }, tabs.map(([id, label]) => h('button', { class: view.tab === id ? 'on' : '', onclick: () => { view.tab = id; selected.clear(); render(); } }, label)))),
    list.length ? h('div', { class: 'row wrap', style: { gap: '6px', marginBottom: '10px' } },
      h('button', { class: 'btn ghost sm', onclick: () => { for (const r of list) allOn ? selected.delete(r.id) : selected.add(r.id); render(); } }, allOn ? '선택 해제' : '모두 선택'),
      chosen.length ? h('button', { class: 'btn primary sm', onclick: () => drawImages(chosen) }, icon('brush'), `선택 ${chosen.length}개 그리기`) : null,
      chosen.length ? h('button', { class: 'btn ghost sm danger-text', onclick: () => deleteMany(view.tab, chosen) }, icon('trash'), `선택 ${chosen.length}개 삭제`)
        : h('button', { class: 'btn ghost sm danger-text', onclick: () => deleteMany(view.tab, list, true) }, icon('trash'),
          view.tab === 'favorites' ? '즐겨찾기 비우기' : view.tab === 'history' ? '기록 비우기' : '결과 비우기')) : null,
    list.length ? h('div', { class: 'gresults' }, list.map((r) => resultCard(r, { fav: view.tab !== 'results' })))
      : h('div', { class: 'card' }, emptyState({ iconName: view.tab === 'favorites' ? 'star' : 'shuffle',
        title: view.tab === 'favorites' ? '즐겨찾기가 없습니다' : view.tab === 'history' ? '아직 섞은 기록이 없습니다' : '섞기를 눌러 보세요',
        text: view.tab === 'favorites' ? '결과의 ☆를 누르면 여기에 모입니다.' : '올린 그림들의 작가 · 품질 태그 · 네거티브를 섞어 여기에 보여 줍니다. 누르면 복사됩니다.' })));
}

function render() {
  morph(root,
    pageHead({ title: '프롬프트 섞기', desc: 'NovelAI PNG 여러 장의 그림체 프롬프트(작가 · 품질 태그 · 네거티브)를 섞어 새 그림체를 만듭니다. 장면과 캐릭터는 빼고 섞습니다.' }),
    h('div', { class: 'gacha-grid' },
      h('div', { class: 'stack', style: { gap: '14px' } }, sourcesCard(), rulesCard()),
      h('div', { class: 'stack', style: { gap: '14px' } }, drawBar(), resultsSection())));
}

export default {
  async mount(el, appRef) {
    app = appRef;
    root = h('div', { class: 'gacha mixer' });
    el.append(root);
    try {
      const saved = await get('/api/mixer');
      data = {
        sources: Array.isArray(saved.sources) ? saved.sources : [],
        config: { ...DEFAULT_MIX_CONFIG, ...(saved.config || {}) },
        favorites: Array.isArray(saved.favorites) ? saved.favorites : [],
        history: Array.isArray(saved.history) ? saved.history : [],
      };
      results = Array.isArray(saved.results) ? saved.results.slice(0, RESULTS_LIMIT) : [];
    } catch (error) {
      toast(error.message, 'error');
    }
    render();
  },
  unmount() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      post('/api/mixer/save', { data: { ...data, results } }).catch(() => {});
    }
  },
};

