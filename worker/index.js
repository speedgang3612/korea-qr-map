/**
 * Korea Travel Guide — API Proxy Worker
 *
 * Endpoints:
 *   GET  /api/naver-search?query=...&display=10
 *   GET  /api/kakao-category?code=...&x=...&y=...&radius=...&size=15
 *   GET  /api/kakao-keyword?query=...&x=...&y=...&radius=...&size=15
 *   GET  /api/seoul-population?area=POI003
 *   POST /api/deepl          body: { text: [...], target_lang: "EN" }
 *
 * Secrets:
 *   NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 *   KAKAO_REST_KEY
 *   DEEPL_API_KEY
 *   SEOUL_API_KEY
 */

const ALLOWED_ORIGINS = [
  'https://korea-guide.kr',
  'https://www.korea-guide.kr',
  'https://speedgang3612.github.io',
];

function corsHeaders(origin) {
  const isLocalDevelopment = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const allowed = ALLOWED_ORIGINS.includes(origin) || isLocalDevelopment ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(data, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

function errorResponse(message, status, origin) {
  return jsonResponse({ error: message }, status, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const path = url.pathname;

    try {
      if (path === '/api/naver-search' && request.method === 'GET') {
        return await handleNaverSearch(url, env, origin);
      }
      if (path === '/api/kakao-category' && request.method === 'GET') {
        return await handleKakaoCategory(url, env, origin);
      }
      if (path === '/api/kakao-keyword' && request.method === 'GET') {
        return await handleKakaoKeyword(url, env, origin);
      }
      if (path === '/api/seoul-population' && request.method === 'GET') {
        return await handleSeoulPopulation(url, env, origin);
      }
      if (path === '/api/deepl' && request.method === 'POST') {
        return await handleDeepL(request, env, origin);
      }
      if (path === '/' || path === '/health') {
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() }, 200, origin);
      }

      return errorResponse('Not found', 404, origin);
    } catch (error) {
      console.error('Worker error:', error);
      return errorResponse(error.message || 'Internal server error', 500, origin);
    }
  },
};

async function handleNaverSearch(url, env, origin) {
  const query = url.searchParams.get('query');
  const display = url.searchParams.get('display') || '10';
  const sort = url.searchParams.get('sort') || 'random';

  if (!query) return errorResponse('Missing "query" parameter', 400, origin);

  const target = `https://openapi.naver.com/v1/search/local.json` +
    `?query=${encodeURIComponent(query)}&display=${display}&start=1&sort=${sort}`;

  const res = await fetch(target, {
    headers: {
      'X-Naver-Client-Id': env.NAVER_CLIENT_ID,
      'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET,
    },
  });

  const data = await res.json();
  return jsonResponse(data, res.status, origin);
}

async function handleKakaoCategory(url, env, origin) {
  const code = url.searchParams.get('code');
  const x = url.searchParams.get('x');
  const y = url.searchParams.get('y');
  const radius = url.searchParams.get('radius') || '2000';
  const size = url.searchParams.get('size') || '15';

  if (!code || !x || !y) {
    return errorResponse('Missing required parameters (code, x, y)', 400, origin);
  }

  const target = `https://dapi.kakao.com/v2/local/search/category.json` +
    `?category_group_code=${code}&x=${x}&y=${y}&radius=${radius}&sort=distance&size=${size}`;

  const res = await fetch(target, {
    headers: { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` },
  });

  const data = await res.json();
  return jsonResponse(data, res.status, origin);
}

async function handleKakaoKeyword(url, env, origin) {
  const query = url.searchParams.get('query');
  const x = url.searchParams.get('x');
  const y = url.searchParams.get('y');
  const radius = url.searchParams.get('radius') || '2000';
  const size = url.searchParams.get('size') || '15';

  if (!query || !x || !y) {
    return errorResponse('Missing required parameters (query, x, y)', 400, origin);
  }

  const target = `https://dapi.kakao.com/v2/local/search/keyword.json` +
    `?query=${encodeURIComponent(query)}&x=${x}&y=${y}&radius=${radius}&sort=distance&size=${size}`;

  const res = await fetch(target, {
    headers: { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` },
  });

  const data = await res.json();
  return jsonResponse(data, res.status, origin);
}

async function handleSeoulPopulation(url, env, origin) {
  const area = (url.searchParams.get('area') || '').trim().toUpperCase();

  if (!/^POI\d{3}$/.test(area)) {
    return errorResponse('"area" must be a Seoul POI code such as POI003', 400, origin);
  }
  if (!env.SEOUL_API_KEY) {
    return errorResponse('SEOUL_API_KEY is not configured', 503, origin);
  }

  // Seoul Open Data's citydata endpoint on port 8088 is served over HTTP.
  // The browser still talks to this Worker over HTTPS, so no secret is exposed.
  const target = `http://openapi.seoul.go.kr:8088/${env.SEOUL_API_KEY}` +
    `/json/citydata_ppltn/1/5/${encodeURIComponent(area)}`;

  const res = await fetch(target, {
    cf: { cacheEverything: true, cacheTtl: 300 },
  });
  const responseText = await res.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    console.error('Unexpected Seoul API response:', responseText.slice(0, 300));
    return errorResponse(`Seoul API returned an invalid response (${res.status})`, 502, origin);
  }

  if (!res.ok) {
    return errorResponse(`Seoul API request failed (${res.status})`, 502, origin);
  }

  const service = data['SeoulRtd.citydata_ppltn'] ?? data.SeoulRtd?.citydata_ppltn;
  const apiError = data.RESULT || data.SeoulRtd?.RESULT || service?.RESULT;
  if (apiError && apiError.CODE && apiError.CODE !== 'INFO-000') {
    return errorResponse(apiError.MESSAGE || apiError.CODE, 502, origin);
  }

  // Seoul Open Data usually wraps JSON results in
  // { "SeoulRtd.citydata_ppltn": { RESULT, row: [...] } }.
  // Older responses used a nested/array shape, so support both.
  const place = Array.isArray(service)
    ? service[0]
    : service?.row?.[0] ?? service;
  const live = place?.LIVE_PPLTN_STTS?.[0] ?? place;
  if (!place || !live) {
    return errorResponse('No real-time population data was returned for this area', 404, origin);
  }

  const forecast = Array.isArray(live.FCST_PPLTN)
    ? live.FCST_PPLTN.map((item) => ({
      time: item.FCST_TIME,
      congestion: item.FCST_CONGEST_LVL,
      minPopulation: toNumber(item.FCST_PPLTN_MIN),
      maxPopulation: toNumber(item.FCST_PPLTN_MAX),
    }))
    : [];

  return jsonResponse({
    areaCode: place.AREA_CD,
    areaName: place.AREA_NM,
    congestion: live.AREA_CONGEST_LVL,
    message: live.AREA_CONGEST_MSG,
    minPopulation: toNumber(live.AREA_PPLTN_MIN),
    maxPopulation: toNumber(live.AREA_PPLTN_MAX),
    updatedAt: live.PPLTN_TIME,
    forecast,
  }, 200, origin, { 'Cache-Control': 'public, max-age=300' });
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function handleDeepL(request, env, origin) {
  const body = await request.json();
  const { text, target_lang } = body;

  if (!text || !target_lang) {
    return errorResponse('Missing "text" or "target_lang" in body', 400, origin);
  }

  const res = await fetch('https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${env.DEEPL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, target_lang }),
  });

  const data = await res.json();
  return jsonResponse(data, res.status, origin);
}
