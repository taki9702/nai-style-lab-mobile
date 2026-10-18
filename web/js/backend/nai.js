// NovelAI over HTTP: one picture, and the subscription check. Sent exactly as the PC version sends them.
import { NAI_GEN_URL, NAI_SUB_URL, NaiHttpError, buildPayload, parseSubscription } from './core.js';
import { http, bodyText } from './platform.js';
import { pngFromResponse } from './zip.js';

export function naiHeaders(apiKey) {
  return {
    'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Referer: 'https://novelai.net/', Origin: 'https://novelai.net', Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9',
  };
}

export async function generateImage(settings, style, seed) {
  const payload = buildPayload(settings, style, seed);
  let res;
  try {
    res = await http({ url: NAI_GEN_URL, method: 'POST', headers: naiHeaders(settings.api_key), json: payload, responseType: 'bytes', timeout: 120000 });
  } catch (error) {
    throw new Error(`NovelAI에 연결하지 못했습니다: ${error?.message || error}`);
  }
  if (res.status !== 200) throw new NaiHttpError(res.status, `HTTP ${res.status}: ${bodyText(res.data)}`);
  return pngFromResponse(res.data);
}

const REASONS = {
  400: '요청이 거부되었습니다. API 주소와 키를 확인해 주세요.',
  401: 'API 키가 만료되었거나 올바르지 않습니다.',
  403: '구독 정보에 접근할 권한이 없습니다.',
  429: '요청이 너무 많습니다. 잠시 후 다시 조회해 주세요.',
};

export async function fetchUserData(apiKey) {
  let res;
  try {
    res = await http({ url: NAI_SUB_URL, method: 'GET', headers: naiHeaders(apiKey.trim()), responseType: 'json', timeout: 10000 });
  } catch {
    throw new Error('NovelAI에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.');
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${REASONS[res.status] || 'NovelAI 서버가 요청을 처리하지 못했습니다.'}`);
  try {
    return parseSubscription(typeof res.data === 'string' ? JSON.parse(res.data) : res.data);
  } catch {
    throw new Error('구독 응답 형식을 읽을 수 없습니다.');
  }
}
