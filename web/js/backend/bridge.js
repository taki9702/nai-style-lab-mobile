// The page's one way into the engine: the same routes as the PC version's bridge.py, answered in-process.
import * as core from './core.js';
import { Engine, SETTING_RANGES, UserError } from './engine.js';
import { openStorage } from './storage.js';
import { Updater } from './updater.js';
import { VERSION } from '../version.js';
import { native, Filesystem, toBase64, shareFile, openExternal, downloadBlob, keepAwake, onPause } from './platform.js';

class NotFound extends Error {}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// A file in the phone's shared folders (Download first, then Documents, then the app cache to share from).
async function openPublicFile(name, folder) {
  const targets = [
    ['EXTERNAL_STORAGE', `${folder}/${name}`, `내 파일 › ${folder}`],
    ['DOCUMENTS', `NAIStyleLab/${name}`, '내 파일 › Documents › NAIStyleLab'],
    ['CACHE', name, null],
  ];
  for (const [directory, path, label] of targets) {
    try {
      await Filesystem.writeFile({ path, directory, data: '', recursive: true });
      return { directory, path, label };
    } catch { /* next place */ }
  }
  throw new UserError('파일을 저장할 곳을 찾지 못했습니다.');
}

function chunkedSink(target) {
  let parts = [], size = 0;
  const flush = async () => {
    if (!size) return;
    const all = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    parts = [];
    size = 0;
    await Filesystem.appendFile({ path: target.path, directory: target.directory, data: toBase64(all) });
  };
  const sink = async (bytes) => {
    parts.push(bytes);
    size += bytes.length;
    if (size >= 3 * 1024 * 1024) await flush();
  };
  return { sink, flush };
}

export async function createBridge() {
  const storage = await openStorage();
  let engine;
  try {
    engine = await Engine.create(storage, { autoSubscription: true });
  } catch (error) {
    if (error instanceof core.NewerDataError) throw new Error('이 데이터는 더 새 버전의 앱에서 저장되었습니다. 앱을 업데이트해 주세요.');
    throw error;
  }
  engine.onJob = (running) => keepAwake(running);
  const updater = new Updater();
  onPause(() => engine.flush());
  setTimeout(() => updater.check().catch(() => {}), 2500);
  engine.refreshSubscription();
  let draft = [-1, {}];
  let lastExport = null;

  const e = engine;
  const get = {
    '/api/status': (q) => ({ ...e.status(Number(q.since || 0)), update: updater.view() }),
    '/api/update': () => updater.view(),
    '/api/match': () => e.match(),
    '/api/combos': () => e.listCombos(),
    '/api/artists': () => e.listArtists(),
    '/api/evolution': () => e.evolutionView(),
    '/api/improve': () => e.improveView(),
    '/api/settings': () => e.settingsPayload(),
    '/api/meta': () => ({ models: core.MODELS, sizes: Object.keys(core.SIZE_PRESETS), samplers: core.SAMPLERS, tiers: core.TIER_ORDER,
      data_dir: native ? '이 폰의 앱 저장 공간' : '이 브라우저', max_seed: core.MAX_SEED, version: VERSION, native,
      ranges: Object.fromEntries(Object.entries(SETTING_RANGES).map(([k, [, lo, hi]]) => [k, [lo, hi]])) }),
    '/api/free': () => e.freeView(),
    '/api/gacha': () => e.gachaView(),
  };

  const post = {
    '/api/vote': (b) => e.vote(b.side),
    '/api/reject': (b) => e.reject(b.side),
    '/api/skip': () => e.skip(),
    '/api/undo': () => e.undo(),
    '/api/settings': (b) => e.updateSettings(b.changes || {}),
    '/api/settings/draft': (b) => { if (Number.isInteger(b.seq) && b.changes && b.seq > draft[0]) draft = [b.seq, b.changes]; },
    '/api/subscription': () => e.checkSubscription(),
    '/api/artists/add': (b) => ({ added: e.addArtists(b.text || '') }),
    '/api/artists/scan': (b) => e.scanArtists(b.text || ''),
    '/api/artists/rename': (b) => e.renameArtist(b.old, b.new),
    '/api/artists/delete': (b) => e.deleteArtists(b.tags || []),
    '/api/generate/random': (b) => e.startRandom(b.count),
    '/api/generate/custom': (b) => e.startCustom(b.text || '', b.count ?? 1),
    '/api/generate/styles': (b) => e.startStyles(b.styles || []),
    '/api/generate/free': (b) => e.startFree(b.prompt || ''),
    '/api/generate/redraw': (b) => e.startRedraw(b.top === true),
    '/api/free/delete': (b) => e.deleteFree(b.images || []),
    '/api/job/stop': () => e.stopJob(),
    '/api/combos/revive': (b) => ({ revived: e.revive(b.ids || []) }),
    '/api/combos/elo': (b) => e.setElo(b.ids || [], b.elo),
    '/api/combos/delete': (b) => e.deleteCombos(b.ids || []),
    '/api/combos/purge': (b) => e.purge(b.reason),
    '/api/open': (b) => shareImage(b.id ? e.imageName(b.id) : b.file),
    '/api/image/save': (b) => saveImage(b.id ? e.imageName(b.id) : b.file),
    '/api/open-novelai': () => openExternal('https://novelai.net/image'),
    '/api/open-url': (b) => openExternal(String(b.url || '')),
    '/api/data/export': (b) => exportData(b.onProgress),
    '/api/data/share-export': () => shareExport(),
    '/api/data/import': (b) => importData(b.file, b.onProgress),
    '/api/evolution/start': (b) => e.startEvolution(b.count),
    '/api/evolution/finish': () => e.finishGeneration(),
    '/api/improve/start': (b) => e.startImprove(b.id, b.variants),
    '/api/improve/next': () => e.improveNextRound(),
    '/api/improve/final': () => e.improveFinalCheck(),
    '/api/improve/finish': (b) => ({ result: e.finishImprove(b.choice || 'champion') }),
    '/api/improve/resume': () => e.improveResume(),
    '/api/gacha/save': (b) => e.saveGacha(b.data || {}),
    '/api/reset': (b) => e.reset(b.scope),
    '/api/update/check': () => updater.check(),
    '/api/update/install': () => updater.install(),
    '/api/update/page': () => updater.openPage(),
  };

  async function shareImage(name) {
    if (!name || !storage.images.has(name)) throw new UserError('원본 이미지 파일을 찾을 수 없습니다.');
    if (!native) {
      window.open(storage.images.url(name), '_blank');
      return {};
    }
    await shareFile({ path: `images/${name}`, directory: 'DATA', title: name });
    return {};
  }

  async function saveImage(name) {
    if (!name || !storage.images.has(name)) throw new UserError('원본 이미지 파일을 찾을 수 없습니다.');
    const bytes = await storage.images.read(name);
    if (!native) {
      downloadBlob(name, new Blob([bytes], { type: 'image/png' }));
      return { where: '다운로드' };
    }
    const target = await openPublicFile(name, 'Pictures/NAIStyleLab');
    await Filesystem.writeFile({ path: target.path, directory: target.directory, data: toBase64(bytes), recursive: true });
    if (!target.label) {
      await shareFile({ path: target.path, directory: target.directory, title: name });
      return { where: null };
    }
    return { where: target.label };
  }

  async function exportData(onProgress) {
    e._requireIdle('내보내');
    const name = `nai-style-lab-${stamp()}.zip`;
    if (!native) {
      const parts = [];
      await e.exportData(async (bytes) => { parts.push(bytes); }, onProgress);
      downloadBlob(name, new Blob(parts, { type: 'application/zip' }));
      return { path: `다운로드 › ${name}` };
    }
    const target = await openPublicFile(name, 'Download/NAIStyleLab');
    const { sink, flush } = chunkedSink(target);
    await e.exportData(sink, onProgress);
    await flush();
    lastExport = target;
    if (!target.label) await shareFile({ path: target.path, directory: target.directory, title: name });
    return { path: target.label ? `${target.label} › ${name}` : null, share: true };
  }

  async function shareExport() {
    if (!lastExport) throw new UserError('먼저 데이터를 내보내 주세요.');
    await shareFile({ path: lastExport.path, directory: lastExport.directory, title: 'NAI Style Lab 데이터' });
  }

  async function importData(file, onProgress) {
    if (!file) throw new UserError('불러올 파일을 먼저 고르세요.');
    return e.importData(file, onProgress);
  }

  async function call(method, path, body) {
    const [route, query] = path.split('?');
    const table = method === 'GET' ? get : post;
    const handler = table[route];
    if (!handler) throw new NotFound(path);
    const args = method === 'GET' ? Object.fromEntries(new URLSearchParams(query || '')) : body || {};
    return handler(args);
  }

  return {
    engine, storage, updater,
    async call(method, path, body) {
      try {
        const data = await call(method, path, body);
        return { ok: true, data: data === undefined ? null : data };
      } catch (error) {
        if (error instanceof UserError) return { ok: false, error: error.message };
        if (error instanceof NotFound) return { ok: false, error: `알 수 없는 요청입니다: ${path}` };
        console.error(method, path, error);
        return { ok: false, error: `내부 오류가 났습니다: ${error?.message || error}` };
      }
    },
    // Settings typed but not saved yet: kept so leaving the app still saves them.
    async shutdown() {
      const changes = draft[1];
      if (changes && Object.keys(changes).length) {
        try { e.updateSettings(changes); } catch { /* refused: the saved value stays */ }
      }
      await e.flush();
    },
  };
}
