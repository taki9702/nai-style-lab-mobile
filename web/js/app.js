// App shell: drawer/sidebar, bottom tabs, workflow stepper, router, status polling, toasts, back button.
import { get, post, ready, shutdown } from './api.js';
import { h, clear, morph, icon, toast, run, fmt, setMeta, promptViewer, closeTopOverlay, pickFile, isMobile } from './ui.js';
import { onBackButton, minimizeApp, styleStatusBar, onPause } from './backend/platform.js';
import home from './pages/home.js';
import arena from './pages/arena.js';
import gacha from './pages/gacha.js';
import mixer from './pages/mixer.js';
import evolution from './pages/evolution.js';
import refine from './pages/refine.js';
import styles from './pages/styles.js';
import library from './pages/library.js';
import free from './pages/free.js';
import settings from './pages/settings.js';

const PAGES = {
  home:      { label: '홈', icon: 'home', page: home },
  arena:     { label: '대결', icon: 'swords', page: arena },
  gacha:     { label: '그림체 뽑기', short: '뽑기', icon: 'dice', page: gacha },
  mixer:     { label: '프롬프트 섞기', short: '섞기', icon: 'shuffle', page: mixer },
  evolution: { label: '진화', icon: 'dna', page: evolution },
  refine:    { label: '다듬기', icon: 'wand', page: refine },
  styles:    { label: '그림체', icon: 'grid', page: styles },
  library:   { label: '작가 · 조합 만들기', short: '작가', icon: 'users', page: library },
  free:      { label: '자유 생성', icon: 'brush', page: free },
  settings:  { label: '설정', icon: 'settings', page: settings },
};
const NAV = [
  ['워크플로', ['home', 'arena', 'evolution', 'refine']],
  ['라이브러리', ['gacha', 'mixer', 'styles', 'library', 'free']],
  ['', ['settings']],
];
const TABS = ['home', 'arena', 'gacha', 'styles'];
const STEP_ROUTES = ['library', 'arena', 'evolution', 'refine', 'refine'];

const app = {
  status: null,
  meta: null,
  conf: null,
  get settings() { return this.conf?.settings ?? {}; },
  route: null,
  params: {},
  page: null,
  go(route, params = {}) {
    const query = new URLSearchParams(params).toString();
    const hash = `#/${route}${query ? `?${query}` : ''}`;
    closeDrawer();
    if (location.hash === hash) mount();
    else location.hash = hash;
  },
  async refresh() {
    await poll(true);
  },
  async act(request, okText) {
    const result = await run(request, okText);
    await this.refresh();
    return result;
  },
  setFill(fill) {
    document.getElementById('content').classList.toggle('fill', fill);
  },
  openPromptViewer: () => openPromptViewer(),
};

let lastEvent = 0;
let polling = null;
let confRev = null;

// ---------------------------------------------------------------- drawer (the sidebar on a phone)
let drawerOpen = false;
function openDrawer() {
  drawerOpen = true;
  document.body.classList.add('drawer-open');
  renderSidebar();
}
function closeDrawer() {
  if (!drawerOpen) return false;
  drawerOpen = false;
  document.body.classList.remove('drawer-open');
  return true;
}

async function openPromptViewer() {
  const file = await pickFile('image/png');
  if (!file) return;
  if (!/png$/i.test(file.type) && !/\.png$/i.test(file.name)) return toast('NovelAI로 만든 PNG 그림을 골라 주세요.', 'warn');
  closeDrawer();
  promptViewer(app, file).catch(() => {});
}

// ---------------------------------------------------------------- sidebar
function badgesFor(s) {
  const badges = {};
  if (s) {
    const arenaWork = s.counts.newcomers + (s.tie ? 1 : 0);
    if (arenaWork) badges.arena = [arenaWork, 'hot'];
    else if (s.stage.route === 'arena') badges.arena = ['•', 'hot'];
    badges.evolution = [`${s.counts.generation}세대`, ''];
    if (s.improve) badges.refine = ['진행', 'warn'];
    badges.styles = [fmt(s.counts.active), ''];
  }
  return badges;
}

function jobCard(job) {
  return job && job.running ? h('div', { class: 'job-card fade-in' },
    h('div', { class: 'row' },
      h('div', { class: 'spinner' }), h('div', { class: 'title' }, job.label),
      h('button', { class: 'btn ghost icon-btn sm', 'aria-label': '생성 중단',
        onclick: () => app.act(post('/api/job/stop'), '현재 이미지가 끝나면 멈춥니다.') }, icon('stop'))),
    h('div', { class: 'bar' }, h('span', { style: { width: `${job.total ? (job.done / job.total) * 100 : 0}%` } })),
    h('div', { class: 'meta' }, h('span', { class: 'num' }, `${job.done} / ${job.total}`),
      job.failures ? h('span', { class: 'fail' }, `실패 ${job.failures}`) : h('span', {}, '생성 중'))) : null;
}

function renderSidebar() {
  const s = app.status;
  const side = document.getElementById('sidebar');
  const badges = badgesFor(s);
  const nav = NAV.map(([label, routes]) => [
    label ? h('div', { class: 'nav-label' }, label) : h('div', { style: { height: '10px' } }),
    routes.map((route) => {
      const page = PAGES[route];
      const badge = badges[route];
      return h('button', { class: `nav-item ${app.route === route ? 'active' : ''}`, onclick: () => app.go(route) },
        icon(page.icon), h('span', {}, page.label),
        badge ? h('span', { class: `nav-badge ${badge[1]}` }, badge[0]) : null);
    }),
  ]);
  const sub = s?.subscription;
  const subCard = !sub ? null : sub.error ? h('div', { class: 'sub-card' },
    h('div', {}, h('strong', { style: { color: 'var(--red)' } }, '구독 조회 실패')),
    h('div', { class: 'muted' }, `${sub.checked} 조회 · 다음 생성 때 다시 조회`))
    : h('div', { class: 'sub-card' },
      h('div', {}, h('strong', {}, sub.tier), sub.active ? '' : ' · 비활성'),
      sub.estimate ? h('div', { class: 'num' }, `예상 ${fmt(sub.estimate.left)} / ${fmt(sub.estimate.total)}장`) : null,
      h('div', { class: 'muted' }, `${sub.remaining_percent != null ? `잔여 ${sub.remaining_percent}% · ` : ''}${sub.checked} 조회`));
  const update = s?.update;
  const updateCard = update?.state === 'available' ? h('button', { class: 'sub-card update-card',
    onclick: () => app.go('settings', { focus: 'update' }) },
    h('div', {}, h('strong', {}, `새 버전 v${update.latest}`)),
    h('div', { class: 'muted' }, '눌러서 업데이트')) : null;
  morph(side,
    h('div', { class: 'brand' }, h('img', { class: 'brand-mark', src: 'icon.svg', alt: '' }),
      h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'brand-name' }, 'NAI Style Lab'),
        h('div', { class: 'brand-sub' }, app.meta?.version ? `나만의 그림체 찾기 · v${app.meta.version}` : '나만의 그림체 찾기')),
      h('button', { class: 'btn ghost icon-btn drawer-close', 'aria-label': '닫기', onclick: closeDrawer }, icon('x'))),
    nav,
    h('div', { class: 'nav-label' }, '도구'),
    h('button', { class: 'nav-item', onclick: openPromptViewer }, icon('image'), h('span', {}, 'PNG 프롬프트 보기')),
    h('div', { class: 'sidebar-foot' }, jobCard(s?.job), updateCard, subCard));
  placeToasts();
}

function placeToasts() {
  if (isMobile()) {
    document.documentElement.style.removeProperty('--toast-bottom');
    return;
  }
  const top = document.querySelector('.sidebar-foot')?.firstElementChild?.getBoundingClientRect().top;
  const bottom = top ? window.innerHeight - top + 10 : 14;
  document.documentElement.style.setProperty('--toast-bottom', `${Math.round(bottom)}px`);
}
window.addEventListener('resize', placeToasts);

// ---------------------------------------------------------------- bottom tabs (phone)
function renderTabbar() {
  const bar = document.getElementById('tabbar');
  const badges = badgesFor(app.status);
  const inTabs = TABS.includes(app.route);
  morph(bar,
    TABS.map((route) => {
      const page = PAGES[route];
      const badge = route === 'arena' ? badges.arena : null;
      return h('button', { class: `tab ${app.route === route ? 'on' : ''}`, onclick: () => app.go(route) },
        h('span', { class: 'tab-ico' }, icon(page.icon), badge ? h('i', { class: 'tab-dot' }, badge[0] === '•' ? '' : badge[0]) : null),
        h('span', { class: 'tab-label' }, page.short || page.label));
    }),
    h('button', { class: `tab ${!inTabs || drawerOpen ? 'on' : ''}`, onclick: () => (drawerOpen ? closeDrawer() : openDrawer()) },
      h('span', { class: 'tab-ico' }, icon('menu'), app.status?.improve || app.status?.update?.state === 'available' ? h('i', { class: 'tab-dot' }, '') : null),
      h('span', { class: 'tab-label' }, inTabs ? '더보기' : (PAGES[app.route]?.short || PAGES[app.route]?.label || '더보기'))));
}

// ---------------------------------------------------------------- topbar
function renderTopbar() {
  const s = app.status;
  const bar = document.getElementById('topbar');
  if (!s) return clear(bar);
  const { step, names, todo, route, action } = s.stage;
  const steps = [];
  names.forEach((name, i) => {
    if (i) steps.push(h('span', { class: `step-link ${i <= step ? 'done' : ''}` }));
    const state = i < step ? 'done' : i === step ? 'current' : '';
    steps.push(h('button', { class: `step ${state}`, 'aria-label': name, onclick: () => app.go(STEP_ROUTES[i]) },
      h('span', { class: 'dot' }, i < step ? icon('check') : String(i + 1)), h('span', { class: 'name' }, name)));
  });
  const job = s.job;
  const page = PAGES[app.route];
  morph(bar,
    h('div', { class: 'appbar' },
      h('button', { class: 'btn ghost icon-btn appbar-menu', 'aria-label': '메뉴', onclick: openDrawer }, icon('menu')),
      h('div', { class: 'appbar-title' }, page?.label || ''),
      job && job.running ? h('button', { class: 'job-pill', onclick: () => app.act(post('/api/job/stop'), '현재 이미지가 끝나면 멈춥니다.'), 'aria-label': '생성 중단' },
        h('span', { class: 'spinner' }), h('span', { class: 'num' }, `${job.done}/${job.total}`), icon('stop')) : null,
      h('button', { class: 'step-chip', onclick: () => app.go(STEP_ROUTES[step]) }, h('b', {}, `${step + 1}`), `/5 ${names[step]}`)),
    h('nav', { class: 'stepper', 'aria-label': '워크플로 단계' }, steps),
    h('div', { class: 'todo' }, h('span', { class: 'label' }, '지금 할 일'), h('span', { class: 'text' }, todo),
      app.route === route && !s.stage.params?.focus ? null
        : h('button', { class: 'btn primary sm pill', onclick: () => app.go(route, s.stage.params) }, action, icon('arrowRight'))));
  const line = document.querySelector('#progress-line span');
  line.style.width = job && job.running && job.total ? `${Math.max(3, (job.done / job.total) * 100)}%` : '0';
}

// ---------------------------------------------------------------- status polling
async function poll(force = false) {
  try {
    const previous = app.status;
    const status = await get(`/api/status?since=${lastEvent}`);
    for (const event of status.events) {
      lastEvent = Math.max(lastEvent, event.id);
      toast(event.text, event.level);
    }
    if (status.settings_rev !== confRev) {
      app.conf = await get('/api/settings');
      confRev = status.settings_rev;
    }
    app.status = status;
    renderSidebar();
    renderTopbar();
    renderTabbar();
    app.page?.onStatus?.(status, previous, force);
  } catch (error) {
    if (force) toast(error.message, 'error');
  }
}

function schedule() {
  clearTimeout(polling);
  const busy = app.status?.job?.running;
  const delay = document.hidden ? 4000 : busy ? 900 : 1600;
  polling = setTimeout(async () => { await poll(); schedule(); }, delay);
}

// ---------------------------------------------------------------- router
function parseHash() {
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  return { route: PAGES[path] ? path : 'home', params: Object.fromEntries(new URLSearchParams(query || '')) };
}

let mountToken = 0;
const scrollWatch = new ResizeObserver(() => requestAnimationFrame(() => {
  const content = document.getElementById('content');
  content.classList.toggle('scrolling', content.offsetWidth - content.clientWidth > 0);
}));

async function mount() {
  const { route, params } = parseHash();
  const token = ++mountToken;
  app.page?.unmount?.();
  app.page = null;
  app.route = route;
  app.params = params;
  document.body.dataset.route = route;
  renderSidebar();
  renderTopbar();
  renderTabbar();
  const content = document.getElementById('content');
  app.setFill(false);
  clear(content);
  scrollWatch.disconnect();
  scrollWatch.observe(content);
  if (token !== mountToken) return;
  app.page = PAGES[route].page;
  content.scrollTop = 0;
  try {
    await app.page.mount(content, app);
    for (const el of content.children) scrollWatch.observe(el);
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------- keyboard (a keyboard on a tablet still works)
document.addEventListener('keydown', (event) => {
  const tag = event.target.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || event.target.isContentEditable) return;
  if (document.querySelector('.backdrop, .lightbox, .compare')) return;
  app.page?.onKey?.(event);
});

const isNumber = (el) => el instanceof HTMLInputElement && el.type === 'number';
document.addEventListener('wheel', (event) => {
  if (isNumber(event.target) && event.target === document.activeElement) event.preventDefault();
}, { capture: true, passive: false });

// A picture dropped on the window (tablet / browser): the prompt viewer.
document.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  const file = [...event.dataTransfer.files].find((f) => f.type === 'image/png');
  if (!file) return toast('NovelAI로 만든 PNG 그림을 놓아 주세요.', 'warn');
  if (document.querySelector('.backdrop')) return;
  promptViewer(app, file).catch(() => {});
});

window.addEventListener('error', (event) => toast(`화면에서 오류가 났습니다: ${event.message}`, 'error'));
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason?.shown) return;
  toast(event.reason?.message || String(event.reason), 'error');
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); schedule(); } });
window.addEventListener('hashchange', mount);
document.getElementById('drawer-backdrop').addEventListener('click', () => closeDrawer());

// Android back: close what is open, then go back a page, then leave the app (it keeps running in the background).
onBackButton(() => {
  if (closeTopOverlay()) return;
  if (closeDrawer()) return;
  if (app.page?.onBack?.()) return;
  if (app.route !== 'home') {
    if (history.length > 1) history.back();
    else app.go('home');
    return;
  }
  shutdown().finally(() => minimizeApp());
});
onPause(() => { shutdown().catch(() => {}); });

(async function start() {
  styleStatusBar();
  try {
    await ready;
  } catch (error) {
    document.getElementById('boot')?.remove();
    clear(document.getElementById('content'), h('div', { class: 'empty-state' }, h('h3', {}, '앱을 시작하지 못했습니다'), h('p', {}, String(error?.message || error))));
    return;
  }
  try {
    app.meta = await get('/api/meta');
    setMeta(app.meta);
    document.documentElement.classList.toggle('native', Boolean(app.meta.native));
  } catch (error) {
    toast(error.message, 'error');
  }
  await poll();
  if (!location.hash) location.replace('#/home');
  await mount();
  document.getElementById('boot')?.remove();
  schedule();
})();

export default app;
