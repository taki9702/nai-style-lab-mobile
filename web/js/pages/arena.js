// 대결 — the one place the user spends most time. Pick the one you like; the app decides what to compare.
// On a phone the two cards sit side by side; tapping a picture opens the full-screen A/B viewer (tap or swipe to flip,
// pinch to zoom both the same way), where the votes go on match after match.
import { get, post } from '../api.js';
import { h, morph, listen, icon, toast, keysButton, saveSetting, art, tierChip, record, tagList, copyText, openOriginal, saveImage,
  emptyState, fmt, capped, eloShown, removeCombos, zoomable, pushOverlay, isMobile } from '../ui.js';

const KIND = {
  tie:     { icon: 'scale', tone: 'amber' },
  place:   { icon: 'target', tone: 'sky' },
  select:  { icon: 'dna', tone: '' },
  improve: { icon: 'wand', tone: 'rose' },
  league:  { icon: 'swords', tone: 'mint' },
  top:     { icon: 'crown', tone: 'mint' },
};
const MODES = [['auto', '자동'], ['league', '전체 리그'], ['top', '상위 30%']];

let root, app, current = null, busy = false, stamp = '', ready = false, reveal = null;
const REVEAL_MS = 1000;
const MASK = '???';
const deletable = (kind) => kind !== 'select' && kind !== 'improve';

function header(match) {
  const kind = KIND[match.kind] || KIND.league;
  const ctx = match.context || { title: '대결', detail: '' };
  return h('div', { class: 'arena-head' },
    h('div', { class: 'row' }, h('div', { class: 'context', style: { flex: 1 } }, h('div', { class: `icon-badge ${kind.tone}` }, icon(kind.icon)),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'title' }, match.kind ? ctx.title : '대결'),
        h('div', { class: 'detail' }, match.kind ? ctx.detail : '마음에 드는 쪽을 고르기만 하면 됩니다.'))),
      keysButton([[['←', '→'], '선택'], [['4', '6'], '선택 (숫자 패드)'], [['Enter'], '비슷함'], [['⌫'], '되돌리기'], [[], '휠 확대(양쪽 함께) · 드래그 이동']])),
    h('div', { class: 'arena-controls' }, h('button', { class: `btn icon-btn ${blind() ? 'primary' : ''}`, 'aria-label': '블라인드', 'aria-pressed': String(blind()), onclick: toggleBlind },
      icon(blind() ? 'eyeOff' : 'eye')),
    h('div', { class: 'segmented', role: 'tablist', 'aria-label': '대결 모드' },
      MODES.map(([mode, label]) => h('button', { class: match.mode === mode ? 'on' : '', role: 'tab', 'aria-selected': String(match.mode === mode),
        onclick: () => setMode(mode) }, label))),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn', disabled: !match.undo, onclick: undo, 'aria-label': '되돌리기' }, icon('undo'), h('span', { class: 'hide-xs' }, '되돌리기'))));
}

const evaluating = (c) => !c.rated || c.child;
const settled = (combo, after) => evaluating(combo) && after && !evaluating(after);

function eloText(combo, after) {
  if (settled(combo, after)) return eloShown(after.elo);
  if (evaluating(combo)) return '평가중';
  if (!after) return eloShown(combo.elo);
  if (after.elo === combo.elo) return [eloShown(combo.elo), h('span', { class: 'delta same' }, ' +0')];
  const delta = after.elo - combo.elo;
  return [eloShown(after.elo),
    combo.rated ? h('span', { class: `delta ${delta > 0 ? 'up' : 'down'}` }, ` ${delta > 0 ? '+' : ''}${fmt(delta)}`) : null];
}

function fighter(combo, side, rival, kind) {
  const key = side === 'a' ? '←' : '→';
  const masked = blind() && !reveal;
  const after = reveal?.last[side];
  const outcome = !reveal?.side ? '' : reveal.side === 'even' ? 'even' : reveal.side === side ? 'picked' : 'dimmed';
  const frame = art(combo, { thumb: false, corners: [
    ['tl', masked || kind === 'select' || !combo.role ? null : h('span', { class: 'badge glass' }, combo.role)],
    ['tr', h('span', { class: 'badge glass side-mark' }, side === 'a' ? 'A' : 'B')],
  ] });
  listen(frame, 'click', (event) => {
    if (event.currentTarget.__panned || !combo.image) return;
    openCompare(side);
  });
  const refine = kind === 'improve';
  const other = new Map(rival.pairs.map((p) => [p.tag, p.w]));
  const diffs = refine ? combo.pairs.filter((p) => other.has(p.tag) && Math.abs(other.get(p.tag) - p.w) > 1e-9).length : 0;
  const tags = masked ? h('div', { class: 'tags' }, h('span', { class: 'tag mask' }, MASK))
    : tagList(combo.pairs, { diff: refine ? other : null });
  const card = h('section', { class: `fighter fade-in ${outcome}`, 'data-side': side, 'aria-label': `${side === 'a' ? '왼쪽' : '오른쪽'} 그림체` },
    frame,
    h('div', { class: 'fighter-info' },
      masked ? h('span', { class: 'tier mask lg' }, MASK)
        : refine ? h('span', { class: `badge ${combo.role === '챔피언' ? 'accent' : 'rose'}`, style: { height: '28px', fontSize: '13px' } },
          combo.role === '챔피언' ? icon('crown') : icon('sliders'), combo.role)
        : evaluating(combo) && !settled(combo, after) ? h('span', { class: 'tier tier-new lg' }, '평가중') : tierChip(after || combo, 'lg'),
      masked
        ? h('div', {}, h('div', { class: 'elo num' }, MASK), h('div', { class: 'meta' }, MASK))
        : refine
          ? h('div', { style: { minWidth: 0 } }, h('div', { class: 'elo' }, diffs ? `다른 가중치 ${diffs}곳` : '가중치 같음'),
            h('div', { class: 'meta' }, '작가는 같고 가중치만 다릅니다 · 강조된 칩이 차이'))
          : h('div', { style: { minWidth: 0 } }, h('div', { class: 'elo num' }, eloText(combo, after)),
            h('div', { class: 'meta' }, `${evaluating(combo) && !settled(combo, after) ? '새 조합' : record(after || combo)} · ${capped(combo.generation)}세대`)),
      h('div', { class: 'fighter-actions' },
        h('button', { class: 'btn ghost sm labeled', onclick: () => openOriginal(combo) }, icon('share'), '공유'),
        deletable(kind) ? h('button', { class: 'btn ghost sm labeled danger-text', onclick: () => remove([combo.id]) }, icon('trash'), '삭제') : null)),
    h('div', { class: 'fighter-tags' }, tags,
      h('button', { class: 'btn ghost sm labeled', 'aria-label': '복사', onclick: () => copyText(combo.style) }, icon('copy'), h('span', { class: 'hide-xs' }, '복사'))),
    h('button', { class: 'btn primary pick', disabled: !ready, onclick: () => vote(side) },
      h('span', { class: 'pick-long' }, '이쪽이 더 좋습니다'), h('span', { class: 'pick-short' }, `${side === 'a' ? 'A' : 'B'} 선택`), h('kbd', {}, key)));
  listen(tags, 'wheel', (event) => {
    const el = event.currentTarget;
    if (el.scrollWidth <= el.clientWidth || !event.deltaY) return;
    event.preventDefault();
    el.scrollLeft += event.deltaY;
  });
  return card;
}

function render(match) {
  current = match;
  const next = match.kind ? `${match.kind}:${match.a.id}:${match.b.id}` : 'idle';
  if (next !== stamp) {
    stamp = next;
    ready = false;
  }
  compare?.update();
  if (!match.kind) {
    const s = app.status?.stage;
    const working = app.status?.job?.running;
    return morph(root, header(match), h('div', { key: 'idle', class: 'arena-idle' },
      emptyState({ iconName: working ? 'sparkle' : 'check', title: working ? '그림을 만드는 중입니다' : '지금은 할 대결이 없습니다',
        text: match.message,
        action: s && s.route !== 'arena' ? h('button', { class: 'btn primary', onclick: () => app.go(s.route) }, s.action, icon('arrowRight')) : null })));
  }
  morph(root, header(match),
    h('div', { class: 'duel', key: stamp }, fighter(match.a, 'a', match.b, match.kind),
      h('div', { class: 'versus' }, h('div', { class: 'vs-orb' }, 'VS'),
        h('button', { class: `btn pick-similar ${reveal?.side === 'even' ? 'on' : ''}`, disabled: !ready, onclick: skip }, icon('equal'), '비슷함'),
        deletable(match.kind) ? h('button', { class: 'btn ghost sm danger-text', onclick: () => remove([match.a.id, match.b.id]) }, icon('trash'), '둘 다 삭제') : null),
      fighter(match.b, 'b', match.a, match.kind)),
    h('div', { class: 'duel-bar', key: `bar-${stamp}` },
      h('button', { class: `btn pick-similar ${reveal?.side === 'even' ? 'on' : ''}`, disabled: !ready, onclick: skip }, icon('equal'), '비슷함'),
      h('button', { class: 'btn', onclick: () => openCompare('a') }, icon('layers'), '크게 비교'),
      deletable(match.kind) ? h('button', { class: 'btn ghost danger-text', onclick: () => remove([match.a.id, match.b.id]) }, icon('trash'), '둘 다 삭제') : null));
  const duel = root.querySelector('.duel');
  if (duel.__started) return;
  duel.__started = true;
  if (!isMobile()) syncZoom([...duel.querySelectorAll('.fighter .art')]);
  const shown = stamp;
  Promise.all([...duel.querySelectorAll('.fighter .art img')].map((img) => img.decode().catch(() => {}))).then(() => {
    if (stamp !== shown) return;
    ready = true;
    render(current);
  });
}

async function load() {
  try {
    render(await get('/api/match'));
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function act(path, body, side) {
  if (busy) return;
  busy = true;
  try {
    if (side === 'even') {
      root.querySelectorAll('.fighter').forEach((el) => el.classList.add('even'));
      root.querySelectorAll('.pick-similar').forEach((el) => el.classList.add('on'));
      compare?.flash('even');
      await new Promise((r) => setTimeout(r, 170));
    } else if (side) {
      root.querySelector(`.fighter[data-side="${side}"]`)?.classList.add('picked');
      root.querySelector(`.fighter[data-side="${side === 'a' ? 'b' : 'a'}"]`)?.classList.add('dimmed');
      compare?.flash(side);
      await new Promise((r) => setTimeout(r, 170));
    }
    const match = await post(path, body);
    if (current?.kind && match.last) {
      reveal = { last: match.last, side };
      render(current);
      await new Promise((r) => setTimeout(r, compare ? 450 : REVEAL_MS));
      reveal = null;
    }
    render(match);
    app.refresh();
  } catch (error) {
    toast(error.message, 'error');
    await load();
  } finally {
    busy = false;
  }
}

const vote = (side) => current?.kind && ready && act('/api/vote', { side }, side);
const skip = () => current?.kind && ready && act('/api/skip', undefined, 'even');
const undo = () => act('/api/undo');
async function remove(ids) {
  if (busy) return;
  busy = true;
  try {
    if (await removeCombos(app, ids).catch(() => true)) await load();
  } finally {
    busy = false;
  }
}
const blind = () => Boolean(app.settings.arena_blind);
async function toggleBlind() {
  const settings = app.settings;
  settings.arena_blind = !settings.arena_blind;
  if (current) render(current);
  if (!(await saveSetting({ arena_blind: settings.arena_blind }))) {
    settings.arena_blind = !settings.arena_blind;
    if (current) render(current);
  }
}
async function setMode(mode) {
  await saveSetting({ arena_mode: mode });
  load();
}

// ---------------------------------------------------------------- full-screen A/B viewer (phone)
// Both pictures are stacked in one frame and share one zoom, so flipping shows the same spot of the other side.
let compare = null;

function openCompare(side = 'a') {
  if (!current?.kind || compare) return;
  const box = h('div', { class: 'compare' });
  document.getElementById('overlay-root').append(box);
  let showing = side;
  let zoom = null;
  let stampShown = '';
  const release = pushOverlay(() => close());
  const close = () => {
    release();
    box.remove();
    compare = null;
  };
  const flip = (to) => {
    showing = to || (showing === 'a' ? 'b' : 'a');
    draw();
  };
  const draw = () => {
    const m = current;
    if (!m?.kind) {
      morph(box, h('div', { class: 'compare-top' },
        h('button', { class: 'btn ghost icon-btn', 'aria-label': '닫기', onclick: close }, icon('x')), h('span', { class: 'spacer' })),
        h('div', { class: 'compare-empty' }, emptyState({ iconName: app.status?.job?.running ? 'sparkle' : 'check',
          title: app.status?.job?.running ? '다음 그림을 만드는 중입니다' : '지금은 할 대결이 없습니다', text: m?.message || '' })));
      stampShown = '';
      return;
    }
    const masked = blind() && !reveal;
    const combo = m[showing];
    const after = reveal?.last?.[showing];
    const info = masked ? MASK : m.kind === 'improve' ? combo.role
      : evaluating(combo) && !settled(combo, after) ? '평가중' : `${combo.grade || ''} · ${eloShown((after || combo).elo)}`;
    const newMatch = stampShown !== stamp;
    morph(box,
      h('div', { class: 'compare-top' },
        h('button', { class: 'btn ghost icon-btn', 'aria-label': '닫기', onclick: close }, icon('x')),
        h('div', { class: 'segmented' }, ['a', 'b'].map((s) => h('button', { class: showing === s ? 'on' : '', onclick: () => flip(s) }, s === 'a' ? 'A' : 'B'))),
        h('span', { class: 'compare-info' }, info),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost icon-btn', 'aria-label': '되돌리기', disabled: !m.undo, onclick: undo }, icon('undo'))),
      h('div', { class: 'compare-stage', key: `stage-${stamp}` },
        ['a', 'b'].map((s) => h('img', { class: `side-${s} ${showing === s ? 'on' : ''}`, src: m[s].image, alt: '', draggable: false })),
        h('div', { class: `compare-mark ${showing}` }, showing === 'a' ? 'A' : 'B')),
      h('div', { class: 'compare-tags' }, masked ? h('div', { class: 'tags' }, h('span', { class: 'tag mask' }, MASK))
        : tagList(combo.pairs, { diff: m.kind === 'improve' ? new Map(m[showing === 'a' ? 'b' : 'a'].pairs.map((p) => [p.tag, p.w])) : null })),
      h('div', { class: 'compare-actions' },
        h('button', { class: 'btn primary lg', disabled: !ready, onclick: () => vote('a') }, 'A 선택'),
        h('button', { class: 'btn lg', disabled: !ready, onclick: skip }, icon('equal'), '비슷함'),
        h('button', { class: 'btn primary lg', disabled: !ready, onclick: () => vote('b') }, 'B 선택')),
      h('div', { class: 'compare-hint' }, '그림을 누르거나 옆으로 밀면 A/B가 바뀝니다 · 두 손가락으로 확대'));
    const stage = box.querySelector('.compare-stage');
    if (!stage.__zoom) {
      stage.__zoom = zoomable(stage, { onTap: () => flip() });
      stage.addEventListener('swipe', () => flip());
    }
    zoom = stage.__zoom;
    if (newMatch) stampShown = stamp;
  };
  compare = {
    close: () => close(),
    update: () => {
      if (current?.kind && stampShown && stampShown !== stamp) showing = 'a';  // a new match starts from A
      draw();
    },
    flash: (s) => {
      box.querySelector('.compare-stage')?.classList.add(`flash-${s}`);
    },
  };
  draw();
}

// Wheel zoom around the cursor and drag to pan, on both pictures at once (a mouse or trackpad).
function syncZoom(frames) {
  const z = { scale: 1, x: 0, y: 0 };
  let drag = null;
  const apply = () => {
    z.x = Math.min(0, Math.max(1 - z.scale, z.x));
    z.y = Math.min(0, Math.max(1 - z.scale, z.y));
    for (const frame of frames) {
      const img = frame.querySelector('img');
      if (img) img.style.transform = `translate(${z.x * frame.clientWidth}px, ${z.y * frame.clientHeight}px) scale(${z.scale})`;
      frame.classList.toggle('zoomed', z.scale > 1);
    }
  };
  for (const frame of frames) {
    frame.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      const px = (event.clientX - rect.left) / rect.width, py = (event.clientY - rect.top) / rect.height;
      const next = Math.min(5, Math.max(1, z.scale * (event.deltaY < 0 ? 1.18 : 1 / 1.18)));
      z.x = px - ((px - z.x) * next) / z.scale;
      z.y = py - ((py - z.y) * next) / z.scale;
      z.scale = next;
      apply();
    }, { passive: false });
    frame.addEventListener('pointerdown', (event) => {
      frame.__panned = false;
      if (z.scale <= 1 || event.button !== 0 || event.pointerType === 'touch') return;
      drag = { sx: event.clientX, sy: event.clientY, x: z.x, y: z.y, w: frame.clientWidth, h: frame.clientHeight };
      frame.setPointerCapture(event.pointerId);
    });
    frame.addEventListener('pointermove', (event) => {
      if (!drag) return;
      z.x = drag.x + (event.clientX - drag.sx) / drag.w;
      z.y = drag.y + (event.clientY - drag.sy) / drag.h;
      apply();
    });
    frame.addEventListener('pointerup', (event) => {
      if (drag && Math.abs(event.clientX - drag.sx) + Math.abs(event.clientY - drag.sy) > 3) frame.__panned = true;
      drag = null;
    });
    frame.addEventListener('pointercancel', () => { drag = null; });
  }
}

export default {
  async mount(el, appRef) {
    app = appRef;
    app.setFill(true);
    root = h('div', { class: 'arena-root', style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } });
    el.append(root);
    stamp = '';
    await load();
  },
  onStatus(status, previous) {
    if (!current?.kind && !busy) {
      const changed = !previous || previous.counts.newcomers !== status.counts.newcomers
        || previous.job?.done !== status.job?.done || previous.job?.running !== status.job?.running
        || previous.improve !== status.improve || previous.tie !== status.tie;
      if (changed) load();
    }
  },
  onKey(event) {
    const map = { ArrowLeft: () => vote('a'), ArrowRight: () => vote('b'), Numpad4: () => vote('a'), Numpad6: () => vote('b'),
      Enter: skip, Backspace: undo };
    const fn = map[event.key] || map[event.code];
    if (fn) {
      event.preventDefault();
      if (!event.repeat) fn();
    }
  },
  unmount() {
    current = null;
    reveal = null;
    stamp = '';
    compare?.close();
    compare = null;
  },
};
