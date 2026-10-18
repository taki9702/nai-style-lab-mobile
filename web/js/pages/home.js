// 홈 — the whole workflow on one screen: where you are, what to do next, how far you've come.
import { get } from '../api.js';
import { h, morph, icon, card, comboTile, fmt, stat, tierDistribution, toast, shortTag } from '../ui.js';

// The five steps; their names come from the server (stage.names), the same as in the top bar.
const LEGS = [
  { text: 'API 키를 넣고 작가를 등록한 뒤, 무작위 조합을 만듭니다.', where: '설정 · 작가 · 조합 만들기', route: 'library' },
  { text: '새 조합은 기존 순위표 사이에서 자리를 찾습니다. 둘 중 마음에 드는 쪽을 고르세요.', where: '대결', route: 'arena' },
  { text: '상위 30% 조합을 섞고 바꿔 새 조합을 만들고, 대결로 더 나은 그림체를 찾습니다.', where: '진화 · 대결', route: 'evolution' },
  { text: '마음에 든 조합의 작가는 그대로 두고 가중치만 바꿔 기존 조합과 비교합니다.', where: '다듬기 · 대결', route: 'refine' },
  { text: '다른 시드에서도 좋은지 확인하고, 최종 결정합니다.', where: '다듬기', route: 'refine' },
];

let root, app;
const TOP_SHOWN = 5;  // favourites on the home screen

function greet() {
  const hour = new Date().getHours();
  return hour < 6 ? '늦은 밤입니다' : hour < 12 ? '좋은 아침입니다' : hour < 18 ? '좋은 오후입니다' : '좋은 저녁입니다';
}

function render(combos, artists) {
  const s = app.status;
  const step = s.stage.step;
  const hero = h('section', { class: 'hero fade-in' },
    h('div', { class: 'eyebrow' }, `${step + 1}단계 · ${s.stage.names[step]}`),
    h('h1', {}, `${greet()}. 오늘도 취향을 찾아보시겠습니까?`),
    h('p', {}, s.stage.todo),
    h('div', { class: 'cta' },
      h('button', { class: 'btn primary lg', onclick: () => app.go(s.stage.route, s.stage.params) }, s.stage.action, icon('arrowRight')),
      s.stage.route !== 'arena' && s.counts.rated >= 2
        ? h('button', { class: 'btn lg', onclick: () => app.go('arena') }, icon('swords'), '대결하러 가기') : null));

  const journey = h('div', { class: 'journey' }, LEGS.map((leg, i) =>
    h('button', { class: `leg ${i < step ? 'done' : i === step ? 'current' : ''}`, style: { textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit' },
      onclick: () => app.go(leg.route) },
      h('div', { class: 'row' }, h('span', { class: 'n' }, i < step ? icon('check', 'width="13" height="13"') : String(i + 1)), h('h4', {}, s.stage.names[i])),
      h('p', {}, leg.text), h('div', { class: 'where' }, leg.where))));

  const checklist = step === 0 ? setup(s) : null;

  const top = combos.active.filter((c) => c.rank).sort((a, b) => a.rank - b.rank).slice(0, TOP_SHOWN);
  // The tier distribution rides beside the combo count, its legend on one line: a narrow page widens that card.
  const stats = h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(max-content, 1fr) 1fr 1fr', marginTop: '14px' } },
    // Hover a segment for its share.
    stat('조합', h('div', { class: 'row', style: { gap: '16px', alignItems: 'center' } }, h('span', {}, fmt(s.counts.active)),
      h('div', { style: { flex: 1, minWidth: 0 } },
        tierDistribution(combos.active, { compact: true })))),
    stat('작가', fmt(s.counts.artists)),
    stat('누적 투표', fmt(s.counts.votes)));

  // The favourites card is exactly as many tiles wide as it shows (TOP_SHOWN, fewer in a narrow window: see .home-lower);
  // the artists card beside it takes the rest of the row and is exactly as tall as that card.
  const lower = h('div', { class: 'grid home-lower', style: { marginTop: '14px', alignItems: 'stretch' } },
    h('section', { class: 'card' },
      h('div', { class: 'row', style: { marginBottom: '10px' } }, h('h3', { style: { margin: 0 } }, '지금 가장 마음에 드는 그림체'),
        h('span', { class: 'spacer' }), h('button', { class: 'btn ghost sm', onclick: () => app.go('styles') }, '모두 보기', icon('arrowRight'))),
      top.length ? h('div', { class: 'gallery cols-10 home-top' },
        top.map((c) => comboTile(c, { onclick: () => app.go('styles', { focus: c.id }) })))
        : h('p', { class: 'muted', style: { margin: 0 } }, '아직 평가된 조합이 없습니다. 대결을 시작하면 여기에 순위가 나타납니다.')),
    // Laid over its cell (absolute), so only the favourites card sets the row's height.
    h('div', { style: { position: 'relative' } }, favouriteArtists(artists)));

  // One screen, no scrolling: on first run the checklist takes the place of the overview, stats and gallery.
  morph(root, hero, checklist ?? [h('div', { class: 'section-head' }, h('h2', { class: 'section' }, '취향을 찾는 다섯 단계'),
    h('span', { class: 'hint' }, '단계를 누르면 그 화면으로 이동합니다.')), journey, stats, lower]);
}

// The artists the votes favour most (작가 점수, see core.artist_scores). As many as fit: the list fills its column
// top to bottom, then a second column; whatever does not fit is left out whole, never cut in half.
function favouriteArtists(artists) {
  const liked = artists.filter((a) => a.combos && a.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
  return h('section', { class: 'card home-artists' },
    h('div', { class: 'row', style: { marginBottom: '10px' } }, h('h3', { style: { margin: 0 } }, '좋아하는 작가'),
      h('span', { class: 'spacer' }), h('button', { class: 'btn ghost sm', onclick: () => app.go('library') }, '모두 보기', icon('arrowRight'))),
    liked.length ? h('div', { class: 'artist-list' }, liked.map((a, i) =>
      h('div', { class: 'artist-row' },
        h('span', { class: 'n num' }, i + 1), h('span', { class: 'name' }, shortTag(a.tag)), h('span', { class: 'score num' }, `+${fmt(a.score)}`))))
      : h('p', { class: 'muted', style: { margin: 0 } }, '대결 결과가 쌓이면 점수가 높은 작가가 여기에 나타납니다.'));
}

// First-run setup: explain each step here, then send the user to the screen where it is done.
function setup(s) {
  const done = s.stage.checklist;
  const steps = [
    [done.api_key, 'NovelAI API 키 입력',
      done.api_key ? '입력되었습니다.'
        : '설정 화면의 "키 발급받기" 버튼으로 NovelAI를 열고, ≡ → Account Settings → Get Persistent API Token에서 발급한 pst- 토큰을 붙여 넣고 "조회"를 누릅니다. 키는 이 폰의 앱 안에만 저장됩니다.',
      'settings', { focus: 'connection' }, '설정에서 입력'],
    [done.artists, '작가 확인',
      done.artists ? `${fmt(s.counts.artists)}명으로 확인했습니다. 작가는 언제든 더하거나 뺄 수 있습니다.`
        : `지금 ${fmt(s.counts.artists)}명이 등록되어 있습니다. 처음에는 기본 작가 목록이 들어 있으니, 좋아하는 작가를 더하거나 "이 목록 그대로 사용"을 눌러 확인해 주세요.`,
      'library', {}, '작가 목록 열기'],
    [done.prompt, '프롬프트 확인',
      '모든 그림이 같은 프롬프트로 그려지고 작가 조합만 바뀝니다. {artist} 자리에 작가 태그가 들어갑니다. 조합을 만든 뒤에 바꾸면 이전 그림과 조건이 달라지니, 조합을 만들기 전에 정해 두세요.',
      'settings', { focus: 'prompts' }, '프롬프트 열기'],
    [done.combos, '첫 무작위 조합 만들기',
      '등록한 작가를 가중치와 함께 섞은 조합을 만들고 같은 시드로 한 장씩 그립니다. 다 그려지면 대결에서 둘 중 마음에 드는 쪽을 선택해 주세요.',
      'library', {}, '조합 만들러 가기'],
  ];
  const next = steps.findIndex(([ok]) => !ok);
  return card({ icon: 'flag', title: '처음 시작하기', desc: '위에서부터 차례로 진행하세요. 버튼을 누르면 해당 화면으로 이동합니다.',
    cls: 'fade-in', style: { marginTop: '14px' } },
    h('div', { class: 'checklist' }, steps.map(([ok, title, text, route, params, action], i) =>
      h('div', { class: `check-item ${ok ? 'ok' : ''}`, style: { alignItems: 'flex-start' } }, h('span', { class: 'tick' }, ok ? icon('check') : null),
        h('div', { class: 'txt', style: { flex: 1 } }, h('div', { style: { fontWeight: 600 } }, `${i + 1}. ${title}`),
          h('p', { class: 'note' }, text)),
        h('button', { class: `btn sm check-go ${i === next ? 'primary' : ''}`, style: { flex: 'none' }, onclick: () => app.go(route, params) },
          action, icon('arrowRight'))))));
}

async function load() {
  try {
    const [combos, artists] = await Promise.all([get('/api/combos'), get('/api/artists')]);
    render(combos, artists);
  } catch (error) {
    toast(error.message, 'error');
  }
}

export default {
  async mount(el, appRef) {
    app = appRef;
    root = h('div');
    el.append(root);
    await load();
  },
  onStatus(status, previous, force) {
    if (force || !previous || previous.stage.step !== status.stage.step || previous.counts.active !== status.counts.active
        || previous.counts.rated !== status.counts.rated || previous.stage.todo !== status.stage.todo) load();
  },
};
