// New versions: GitHub Releases of this app's repository. Installing opens the APK download; Android takes it from there.
import { VERSION, REPO } from '../version.js';
import { http, openExternal } from './platform.js';

const parse = (v) => String(v || '').replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
export function newer(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

export class Updater {
  constructor() {
    this.state = 'idle';
    this.latest = null;
    this.notes = '';
    this.page = `https://github.com/${REPO}/releases`;
    this.apk = null;
    this.error = null;
  }

  view() {
    return { state: this.state, current: VERSION, latest: this.latest, notes: this.notes, page: this.page,
      error: this.error, blocked: null, progress: null };
  }

  async check() {
    this.state = 'checking';
    this.error = null;
    try {
      const res = await http({ url: `https://api.github.com/repos/${REPO}/releases/latest`, headers: { Accept: 'application/vnd.github+json' }, timeout: 15000 });
      if (res.status === 404) {
        this.state = 'latest';
        return this.view();
      }
      if (res.status !== 200 || !res.data || typeof res.data !== 'object') throw new Error(`HTTP ${res.status}`);
      const release = res.data;
      this.latest = String(release.tag_name || '').replace(/^v/i, '');
      this.notes = release.body || '';
      this.page = release.html_url || this.page;
      this.apk = (release.assets || []).find((a) => /\.apk$/i.test(a.name))?.browser_download_url || null;
      this.state = this.latest && newer(this.latest, VERSION) ? 'available' : 'latest';
    } catch (error) {
      this.state = 'error';
      this.error = `업데이트를 확인하지 못했습니다: ${error?.message || error}`;
    }
    return this.view();
  }

  async install() {
    await openExternal(this.apk || this.page);
  }

  async openPage() {
    await openExternal(this.page);
  }
}
