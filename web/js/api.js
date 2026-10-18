// The page's one way into the engine. On the PC this crossed into Python; here the engine runs in the same page,
// so a call is a function call. Answers are copied, so a page can never change the engine's data by accident.
import { createBridge } from './backend/bridge.js';

let bridge = null;
export const ready = createBridge().then((b) => { bridge = b; return b; });

const copy = (v) => (v == null ? v : structuredClone(v));

async function call(method, path, body = null) {
  await ready;
  let payload;
  try {
    payload = await bridge.call(method, path, body);
  } catch (error) {
    throw new Error(`앱 내부 오류가 났습니다: ${error?.message || error}`);
  }
  if (!payload?.ok) throw new Error(payload?.error || '요청에 실패했습니다.');
  try {
    return copy(payload.data);
  } catch {
    return payload.data;
  }
}

export const get = (path) => call('GET', path);
export const post = (path, body = {}) => call('POST', path, body);

// Settings typed but not saved yet: kept, and saved if the app goes to the background first.
let draftSeq = 0;
export function keepDraft(changes) {
  post('/api/settings/draft', { seq: ++draftSeq, changes }).catch(() => {});
}

export async function shutdown() {
  await ready;
  await bridge.shutdown();
}
