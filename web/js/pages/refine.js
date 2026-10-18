// 다듬기 — same artists, same seed, only the weights move. Champion vs variant, narrowing each round.
import { get, post } from '../api.js';
import { h, morph, listen, limits, icon, toast, art, tierChip, fmt, weightBars, tagList, copyText, lightbox, notice, pageHead, comboTile, comboPreview, previewPage,
  emptyState, confirmDialog, arrowTarget } from '../ui.js';

// The round schedule and seed count come from the server (data.jitters, data.final_seeds).
const HOW = () => [
  ['target', '기준 고르기', '가장 마음에 드는 그림체 하나를 고릅니다.'],
  ['sliders', '가중치 변형과 대결', `작가는 그대로, 가중치만 바꾼 변형이 원본과 같은 시드로 그려져 챔피언에게 도전합니다. 라운드마다 폭이 ±${data.jitters[0].toFixed(1)} → ±${data.jitters.at(-1).toFixed(1)}로 줄어듭니다.`],
  ['flag', '다른 시드로 확인', `마지막에 다른 시드 ${data.final_seeds}개로 원본과 나란히 비교하고 확정합니다.`],
];

// variantsDraft: what is typed in "라운드당 변형" until a start saves it as the new default.
let root, app, data = null, picked = null, variantsDraft = null;

function howItWorks() {
  return h('div', { class: 'grid how-grid', style: { gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', flex: 'none', marginBottom: '14px' } }, HOW().map(([ico, title, text], i) =>
    h('div', { class: 'card pad-sm row', style: { alignItems: 'flex-start', gap: '12px' } },
      h('div', { class: `icon-badge ${['sky', 'rose', 'mint'][i]}`, style: { width: '30px', height: '30px', borderRadius: '9px', flex: 'none' } }, icon(ico)),
      h('div', {}, h('div', { style: { fontWeight: 700, marginBottom: '2px' } }, h('span', { class: 'faint num', style: { marginRight: '6px' } }, `0${i + 1}`), title),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, text)))));
}

// Start controls live in the page head, so the picker needs no card of its own.
function startControls() {
  const variants = h('input', { class: 'input', type: 'number', ...limits('improve_variants'), value: variantsDraft ?? app.settings.improve_variants,
    style: { width: '76px' }, oninput: (e) => { variantsDraft = e.currentTarget.value; } });
  const choice = data.candidates.find((c) => c.id === picked);
  return [
    h('label', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'field-label' }, '라운드당 변형'), variants),
    h('button', { class: 'btn primary', disabled: !choice || app.status?.job?.running, onclick: () => start(choice, Number(variantsDraft ?? app.settings.improve_variants)) },
      icon('wand'), choice ? '다듬기 시작' : '그림체를 고르세요')];
}

const pick = (id) => { picked = picked === id ? null : id; render(); };

const pickTile = (c) => comboTile(c, { cls: picked === c.id ? 'selected' : '', onclick: () => pick(c.id) });

// The live top 30%, as on 진화 (in rank order: candidates come ranked): the styles worth refining.
function topPicks() {
  const top = new Set(data.top);
  const list = data.candidates.filter((c) => top.has(c.id));
  if (!list.length) return emptyState({ iconName: 'grid', title: '다듬을 그림체가 아직 없습니다', text: '대결로 순위를 잡으면 여기에 상위 30% 조합이 나타납니다.' });
  return [h('div', { class: 'section-head', style: { marginTop: 0 } }, h('h2', { class: 'section' }, '지금의 상위 30%'),
    h('span', { class: 'hint' }, `${list.length}개 · Elo 순`)), h('div', { class: 'gallery cols-8' }, list.map(pickTile))];
}

function finals() {
  if (!data.finals.length) return null;
  return [h('div', { class: 'section-head' }, h('h2', { class: 'section' }, '완성한 그림체'), h('span', { class: 'hint' }, '다듬기로 확정한 최종 그림체입니다.')),
    h('div', { class: 'gallery lg' }, data.finals.map((c) => comboTile(c, { cls: picked === c.id ? 'selected' : '', onclick: () => pick(c.id),
      extra: h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); copyText(c.style); } }, icon('copy'), '복사') })))];
}

function roundPanel(s) {
  const running = app.status?.job?.running;
  const stepIndex = data.jitters.findIndex((j) => Math.abs(j - s.jitter) < 1e-6);
  const statusText = {
    generating: '변형을 만드는 중입니다. 먼저 완성된 변형부터 대결할 수 있습니다.',
    voting: '챔피언과 변형을 비교하고 있습니다. 대결 화면에서 마음에 드는 쪽을 고르세요.',
    round_done: s.changed ? '이번 라운드에서 챔피언이 바뀌었습니다. 더 좁은 폭으로 이어가 보세요.' : '이번 라운드에서는 챔피언이 지켜졌습니다.',
    final_check: '다른 시드로 원본과 챔피언을 그리는 중입니다.',
    final_ready: '다른 시드에서도 챔피언이 더 좋은지 확인하고 확정하세요.',
  }[s.status];
  const buttons = [];
  if (s.status === 'generating' || s.status === 'voting') {
    buttons.push(h('button', { class: 'btn primary', onclick: () => app.go('arena') }, icon('swords'), `대결하러 가기${s.pending.length ? ` · ${s.pending.length}` : ''}`));
  }
  if (s.status === 'round_done') {
    buttons.push(h('button', { class: `btn ${s.suggest_final ? '' : 'primary'}`, disabled: running, onclick: nextRound }, icon('refresh'), `다음 라운드 (±${s.next_jitter.toFixed(1)})`));
    buttons.push(h('button', { class: `btn ${s.suggest_final ? 'primary' : ''}`, disabled: running, onclick: finalCheck }, icon('flag'), '최종 확인'));
  }
  return h('section', { class: 'card' },
    h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('div', {}, h('div', { class: 'eyebrow' }, `${s.round}라운드`), h('h3', { style: { margin: 0 } }, `조정 폭 ±${s.jitter.toFixed(1)}`)),
      h('span', { class: 'spacer' }),
      h('div', { class: 'round-dots' }, data.jitters.map((j, i) => h('i', { class: i <= Math.max(stepIndex, 0) ? 'on' : '' })))),
    h('p', { class: 'desc' }, statusText),
    s.suggest_final ? h('div', { style: { marginBottom: '12px' } }, notice({ iconName: 'flag', title: '충분히 다듬었습니다',
      text: s.same_as_base ? '어떤 변형도 원본을 넘지 못했습니다. 최종 확인에서 원본을 다른 시드로 확인하고 마무리해 보세요.'
        : '가장 좁은 폭에서도 챔피언이 지켜졌습니다. 최종 확인으로 마무리해 보세요.' })) : null,
    h('div', { class: 'row wrap' }, buttons, h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', disabled: running, onclick: discard }, '그만두기')),
    s.variants.length ? h('div', { style: { marginTop: '18px' } },
      h('div', { class: 'field-label', style: { marginBottom: '8px' } }, `변형 ${s.variants.length}개`),
      h('div', { class: 'variant-list' }, s.variants.map((v) => h('div', { class: `variant ${v.result || ''}`, key: v.id },
        art(v, { corners: [['tl', v.result === 'win' ? h('span', { class: 'badge accent' }, '생존') : v.result === 'loss' ? h('span', { class: 'badge red' }, '탈락')
          : h('span', { class: 'badge sky' }, '평가중')]] }))))) : null);
}

function finalsPanel(s) {
  const ready = s.status === 'final_ready';
  // No variant beat the original: there is only the original to look at, once per seed.
  const same = s.same_as_base;
  return h('section', { class: 'card', style: { marginTop: '16px' } },
    h('div', { class: 'row', style: { marginBottom: '14px' } }, h('div', { class: 'icon-badge mint' }, icon('flag')),
      h('div', {}, h('h3', { style: { margin: 0 } }, '다른 시드로 최종 확인'), h('p', { class: 'desc', style: { margin: 0 } },
        same ? '챔피언이 원본 그대로라 원본만 다른 시드로 그렸습니다. 클릭하면 크게 봅니다.' : '왼쪽이 원본, 오른쪽이 챔피언입니다. 클릭하면 크게 봅니다.'))),
    ready ? h('div', { class: 'row wrap', style: { marginBottom: '16px' } },
      same ? h('button', { class: 'btn primary', onclick: () => finish('base', s.base?.style) }, icon('star'), '원본으로 확정 · 태그 복사')
        : [h('button', { class: 'btn primary', onclick: () => finish('champion') }, icon('star'), '챔피언으로 확정 · 태그 복사'),
          h('button', { class: 'btn', onclick: () => finish('base') }, '원본 유지')],
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onclick: resume }, '더 다듬기')) : null,
    h('div', { class: 'finals' }, s.finals.map((f) => h('div', { key: f.seed },
      h('div', { class: 'final-label' }, icon('image', 'width="13" height="13"'), `시드 ${f.seed}`),
      h('div', { class: 'final-row' },
        same ? finalImage(f.base, '원본') : [finalImage(f.base, '원본'), finalImage(f.champion, '챔피언')])))));
}

function finalImage(url, label) {
  const corner = ['tl', h('span', { class: `badge ${label === '챔피언' ? 'accent' : 'glass'}` }, label)];
  if (!url) return h('div', { class: 'art loading' }, h('div', { class: 'corner tl' }, corner[1]));  // still being drawn
  const frame = art({ image: url }, { thumb: false, corners: [corner] });
  frame.style.cursor = 'zoom-in';
  listen(frame, 'click', () => lightbox(url));
  return frame;
}

function session(s) {
  const champ = s.champion;
  const frame = champ ? art(champ, { thumb: false, corners: [['tl', h('span', { class: 'badge accent' }, icon('crown'), '챔피언')]] }) : h('div', { class: 'art loading' });
  if (champ) listen(frame, 'click', () => lightbox(champ.image, { id: champ.id }));
  const isBase = champ && s.base && champ.style === s.base.style;
  return [
    pageHead({ eyebrow: '다듬기 진행 중', title: '가중치 다듬기', desc: `작가 구성은 그대로 두고, 같은 시드(${s.seed})로 가중치만 바꿔 비교합니다.` }),
    // One screen: the champion image takes the height that is left; the right column scrolls only if it must.
    h('div', { class: 'refine-grid fill' },
      h('section', { class: 'card champion' },
        frame,
        champ ? h('div', { style: { marginTop: '14px' } },
          h('div', { class: 'row', style: { marginBottom: '10px' } },
            h('h3', { style: { margin: 0 } }, isBase ? '현재 챔피언: 원본' : '현재 챔피언'),
            h('span', { class: 'spacer' }),
            h('button', { class: 'btn ghost sm', onclick: () => copyText(champ.style) }, icon('copy'), '복사')),
          weightBars(champ.pairs, { min: app.settings.global_min_w, max: app.settings.global_max_w, compare: s.base?.pairs }),
          isBase ? null : h('p', { class: 'note' }, '막대 위 세로선은 원본의 가중치, 초록/분홍 숫자는 원본보다 오르고 내린 값입니다.')) : null),
      h('div', { class: 'fill-list' }, roundPanel(s),
        s.base ? h('section', { class: 'card', style: { marginTop: '16px' } },
          h('div', { class: 'row', style: { marginBottom: '10px' } }, h('h3', { style: { margin: 0 } }, '원본'), tierChip(s.base), h('span', { class: 'spacer' }),
            h('span', { class: 'faint num' }, `Elo ${fmt(s.base.elo)}`)),
          tagList(s.base.pairs, { open: true })) : null,
        s.finals.length ? finalsPanel(s) : null)),
  ];
}

function render() {
  if (data.session) return morph(root, session(data.session));
  // One screen: the head and the steps stay put, the candidates (and finished styles) scroll under them.
  const shown = [...data.candidates, ...data.finals].find((c) => c.id === picked);
  morph(root, previewPage(
    pageHead({ title: '다듬기', desc: '그림체의 작가는 바꾸지 않고, 가중치만 조금씩 바꿔 가장 마음에 드는 그림체를 찾습니다.',
      keys: [[['←', '→', '↑', '↓'], '선택 이동']],
      below: h('div', { class: 'row', style: { marginTop: '14px' } }, startControls()) }),
    howItWorks(),  // stays above the list; the candidates scroll under it
  [topPicks(), finals()],
  comboPreview(shown, app, () => { picked = null; render(); })));
}

async function load() {
  try {
    data = await get('/api/improve');
    render();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function start(combo, variants) {
  picked = null;
  await app.act(post('/api/improve/start', { id: combo.id, variants }), '다듬기를 시작했습니다. 변형이 만들어지는 대로 대결이 이어집니다.');
  variantsDraft = null;  // saved as the default now
}

async function nextRound() {
  await app.act(post('/api/improve/next'), '다음 라운드 변형을 만들기 시작했습니다.');
}

async function finalCheck() {
  await app.act(post('/api/improve/final'), '다른 시드로 원본과 챔피언을 그리기 시작했습니다.');
}

async function finish(choice, copyStyle = null) {
  const champion = data.session?.champion;
  picked = null;
  await app.act(post('/api/improve/finish', { choice }));
  const style = choice === 'champion' ? champion?.style : copyStyle;
  if (style) copyText(style, '최종 태그를 복사했습니다.');
}

async function resume() {
  await app.act(post('/api/improve/resume'));
}

async function discard() {
  const ok = await confirmDialog({ title: '다듬기를 그만두시겠습니까?', text: '지금까지의 변형은 그림체 목록에 탈락으로 남고, 최종 그림체는 정하지 않습니다.', ok: '그만두기', danger: true });
  if (ok) await finish('discard');
}

export default {
  async mount(el, appRef) {
    app = appRef;
    app.setFill(true);
    root = h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } });
    el.append(root);
    await load();
  },
  onStatus(status, previous, force) {
    if (force || !previous || previous.improve !== status.improve || previous.job?.done !== status.job?.done
        || previous.job?.running !== status.job?.running || previous.counts.votes !== status.counts.votes
        || previous.settings_rev !== status.settings_rev) load();
  },
  onKey(event) {
    const id = arrowTarget(event, picked);
    if (id) {
      picked = id;
      render();
    }
  },
  unmount() {
    variantsDraft = null;
  },
};
