/**
 * Korea Travel Guide — API Proxy Worker
 *
 * Endpoints:
 *   GET  /api/naver-search?query=...&display=10
 *   GET  /api/kakao-category?code=...&x=...&y=...&radius=...&size=15
 *   GET  /api/kakao-keyword?query=...&x=...&y=...&radius=...&size=15
 *   GET  /api/kakao-route?mode=walk|traffic&start_x=...&start_y=...&end_x=...&end_y=...
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

const KAKAO_CATEGORY_CODES = new Set(['AD5', 'CS2', 'HP8', 'PM9']);
const NAVER_SORT_OPTIONS = new Set(['random', 'comment']);
const DEEPL_TARGET_LANGUAGES = new Set(['EN', 'JA', 'ZH-HANS']);
const MAX_TRANSLATION_ITEMS = 24;
const MAX_TRANSLATION_ITEM_LENGTH = 200;
const MAX_TRANSLATION_TOTAL_LENGTH = 3000;
const MAX_TRANSLATION_BODY_BYTES = 12000;
const KAKAO_ROUTE_MODES = new Set(['walk', 'traffic']);
const MAX_ROUTE_STEPS = 24;

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const isLocalDevelopment = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ALLOWED_ORIGINS.includes(origin) || isLocalDevelopment;
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function jsonResponse(data, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...securityHeaders,
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

function errorResponse(message, status, origin, extraHeaders = {}) {
  return jsonResponse({ error: message }, status, origin, extraHeaders);
}

async function rateLimitResponse(request, env, path, origin) {
  if (!path.startsWith('/api/')) return null;
  const limiter = path === '/api/deepl'
    ? env.TRANSLATE_RATE_LIMITER
    : env.API_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return null;

  const clientAddress = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await limiter.limit({ key: `${clientAddress}:${path}` });
  return success
    ? null
    : errorResponse('Too many requests. Please try again shortly.', 429, origin, {
      'Retry-After': '60',
    });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (!isAllowedOrigin(origin)) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...securityHeaders,
          Vary: 'Origin',
        },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const path = url.pathname;

    try {
      const limited = await rateLimitResponse(request, env, path, origin);
      if (limited) return limited;

      if (path === '/api/naver-search' && request.method === 'GET') {
        return await handleNaverSearch(url, env, origin);
      }
      if (path === '/api/kakao-category' && request.method === 'GET') {
        return await handleKakaoCategory(url, env, origin);
      }
      if (path === '/api/kakao-keyword' && request.method === 'GET') {
        return await handleKakaoKeyword(url, env, origin);
      }
      if (path === '/api/kakao-route' && request.method === 'GET') {
        return await handleKakaoRoute(url, env, origin);
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
      return errorResponse('Internal server error', 500, origin);
    }
  },
};

async function handleNaverSearch(url, env, origin) {
  const query = (url.searchParams.get('query') || '').trim();
  const display = Number(url.searchParams.get('display') || '10');
  const sort = url.searchParams.get('sort') || 'random';

  if (!query) return errorResponse('Missing "query" parameter', 400, origin);
  if (query.length > 100) return errorResponse('"query" must be 100 characters or fewer', 400, origin);
  if (!Number.isInteger(display) || display < 1 || display > 20) {
    return errorResponse('"display" must be an integer between 1 and 20', 400, origin);
  }
  if (!NAVER_SORT_OPTIONS.has(sort)) {
    return errorResponse('Unsupported "sort" value', 400, origin);
  }

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
  const code = (url.searchParams.get('code') || '').trim().toUpperCase();
  const x = Number(url.searchParams.get('x'));
  const y = Number(url.searchParams.get('y'));
  const radius = Number(url.searchParams.get('radius') || '2000');
  const size = Number(url.searchParams.get('size') || '15');

  if (!code || !Number.isFinite(x) || !Number.isFinite(y)) {
    return errorResponse('Missing required parameters (code, x, y)', 400, origin);
  }
  if (!KAKAO_CATEGORY_CODES.has(code)) return errorResponse('Unsupported category code', 400, origin);
  if (x < -180 || x > 180 || y < -90 || y > 90) return errorResponse('Invalid coordinates', 400, origin);
  if (!Number.isInteger(radius) || radius < 1 || radius > 5000) {
    return errorResponse('"radius" must be an integer between 1 and 5000', 400, origin);
  }
  if (!Number.isInteger(size) || size < 1 || size > 15) {
    return errorResponse('"size" must be an integer between 1 and 15', 400, origin);
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
  const query = (url.searchParams.get('query') || '').trim();
  const x = Number(url.searchParams.get('x'));
  const y = Number(url.searchParams.get('y'));
  const radius = Number(url.searchParams.get('radius') || '2000');
  const size = Number(url.searchParams.get('size') || '15');

  if (!query || !Number.isFinite(x) || !Number.isFinite(y)) {
    return errorResponse('Missing required parameters (query, x, y)', 400, origin);
  }
  if (query.length > 100) return errorResponse('"query" must be 100 characters or fewer', 400, origin);
  if (x < -180 || x > 180 || y < -90 || y > 90) return errorResponse('Invalid coordinates', 400, origin);
  if (!Number.isInteger(radius) || radius < 1 || radius > 5000) {
    return errorResponse('"radius" must be an integer between 1 and 5000', 400, origin);
  }
  if (!Number.isInteger(size) || size < 1 || size > 15) {
    return errorResponse('"size" must be an integer between 1 and 15', 400, origin);
  }

  const target = `https://dapi.kakao.com/v2/local/search/keyword.json` +
    `?query=${encodeURIComponent(query)}&x=${x}&y=${y}&radius=${radius}&sort=distance&size=${size}`;

  const res = await fetch(target, {
    headers: { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` },
  });

  const data = await res.json();
  return jsonResponse(data, res.status, origin);
}

async function handleKakaoRoute(url, env, origin) {
  const mode = (url.searchParams.get('mode') || '').trim().toLowerCase();
  const startX = Number(url.searchParams.get('start_x'));
  const startY = Number(url.searchParams.get('start_y'));
  const endX = Number(url.searchParams.get('end_x'));
  const endY = Number(url.searchParams.get('end_y'));
  const destinationName = (url.searchParams.get('name') || 'Destination').trim();

  if (!KAKAO_ROUTE_MODES.has(mode)) {
    return errorResponse('Unsupported route mode', 400, origin);
  }
  if (![startX, startY, endX, endY].every(Number.isFinite)) {
    return errorResponse('Missing or invalid route coordinates', 400, origin);
  }
  if (![ [startX, startY], [endX, endY] ].every(([x, y]) => isKoreanCoordinate(x, y))) {
    return errorResponse('Route coordinates must be within Korea', 400, origin);
  }
  if (destinationName.length > 100) {
    return errorResponse('Destination name must be 100 characters or fewer', 400, origin);
  }
  if (!env.KAKAO_REST_KEY) {
    return errorResponse('KAKAO_REST_KEY is not configured', 503, origin);
  }

  const endpoint = mode === 'traffic' ? 'publictraffic' : 'walk';
  const params = new URLSearchParams({
    start_x: String(startX),
    start_y: String(startY),
    end_x: String(endX),
    end_y: String(endY),
    s_name: 'Current location',
    e_name: destinationName || 'Destination',
    input_coord: 'WGS84',
    output_coord: 'WGS84',
  });
  if (mode === 'walk') params.set('route_mode', 'SHORTEST');

  const target = `https://dapi.kakao.com/v2/routing/${endpoint}?${params}`;
  const res = await fetch(target, {
    headers: { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` },
  });

  let data;
  try {
    data = await res.json();
  } catch {
    return errorResponse('Kakao route service returned an invalid response', 502, origin);
  }
  if (!res.ok) {
    return errorResponse(`Kakao route request failed (${res.status})`, 502, origin);
  }
  if (data.status !== 'OK') {
    return jsonResponse({ status: data.status || 'NO_RESULTS', error: 'No route found' }, 404, origin);
  }

  const normalized = mode === 'traffic'
    ? normalizeTransitRoute(data)
    : normalizeWalkingRoute(data);
  if (!normalized) {
    return jsonResponse({ status: 'NO_RESULTS', error: 'No route found' }, 404, origin);
  }

  return jsonResponse({ status: 'OK', mode, ...normalized }, 200, origin);
}

function isKoreanCoordinate(x, y) {
  return x >= 124 && x <= 132 && y >= 32 && y <= 39.5;
}

function normalizeWalkingRoute(data) {
  const route = data.route;
  if (!route?.properties || !Array.isArray(route.legs)) return null;
  const allSteps = route.legs.flatMap(leg => Array.isArray(leg?.steps) ? leg.steps : []);
  return {
    summary: {
      distance: safeNumber(route.properties.totalDistance),
      duration: safeNumber(route.properties.totalTime),
      transfers: 0,
      fare: 0,
      routeType: 'WALK',
    },
    steps: allSteps.slice(0, MAX_ROUTE_STEPS).map(step => normalizeRouteStep(step)),
    truncated: allSteps.length > MAX_ROUTE_STEPS,
    fallbackUrl: safeUrl(route.properties.landingUrl),
  };
}

function normalizeTransitRoute(data) {
  const routes = Array.isArray(data.routes) ? data.routes : [];
  const route = routes
    .filter(item => item?.properties)
    .sort((a, b) => safeNumber(a.properties.totalTime) - safeNumber(b.properties.totalTime))[0];
  if (!route) return null;

  const allSteps = Array.isArray(route.steps) ? route.steps : [];
  return {
    summary: {
      distance: safeNumber(route.properties.totalDistance),
      duration: safeNumber(route.properties.totalTime),
      transfers: safeNumber(route.properties.transfers),
      fare: safeNumber(route.properties.fare?.value),
      routeType: String(route.properties.type || 'TRANSIT').slice(0, 40),
    },
    steps: allSteps.slice(0, MAX_ROUTE_STEPS).map(step => normalizeRouteStep(step)),
    truncated: allSteps.length > MAX_ROUTE_STEPS,
    fallbackUrl: safeUrl(data.properties?.landingURL),
  };
}

function normalizeRouteStep(step) {
  const properties = step?.properties || {};
  const stops = Array.isArray(properties.stops) ? properties.stops : [];
  const vehicles = Array.isArray(properties.vehicles) ? properties.vehicles : [];
  return {
    type: String(properties.type || 'WALK').slice(0, 40),
    guidance: String(properties.guidance || '').slice(0, MAX_TRANSLATION_ITEM_LENGTH),
    distance: safeNumber(properties.distance),
    duration: safeNumber(properties.time),
    vehicle: String(vehicles[0]?.name || '').slice(0, 80),
    vehicleType: String(vehicles[0]?.type || '').slice(0, 40),
    startStop: String(stops[0]?.name || '').slice(0, 100),
    endStop: String(stops.at(-1)?.name || '').slice(0, 100),
    stopCount: stops.length,
  };
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function safeUrl(value) {
  const url = String(value || '');
  return url.startsWith('https://map.kakao.com/') ? url : '';
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
  const declaredLength = Number(request.headers.get('Content-Length') || '0');
  if (declaredLength > MAX_TRANSLATION_BODY_BYTES) {
    return errorResponse('Request body is too large', 413, origin);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_TRANSLATION_BODY_BYTES) {
    return errorResponse('Request body is too large', 413, origin);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse('Request body must be valid JSON', 400, origin);
  }
  const { text, target_lang } = body;

  if (!Array.isArray(text) || !target_lang) {
    return errorResponse('Missing "text" or "target_lang" in body', 400, origin);
  }
  if (text.length < 1 || text.length > MAX_TRANSLATION_ITEMS) {
    return errorResponse(`"text" must contain 1 to ${MAX_TRANSLATION_ITEMS} items`, 400, origin);
  }
  if (!text.every((item) => typeof item === 'string' && item.length <= MAX_TRANSLATION_ITEM_LENGTH)) {
    return errorResponse(`Each translation item must be a string of ${MAX_TRANSLATION_ITEM_LENGTH} characters or fewer`, 400, origin);
  }
  if (text.reduce((sum, item) => sum + item.length, 0) > MAX_TRANSLATION_TOTAL_LENGTH) {
    return errorResponse('Total translation text is too long', 400, origin);
  }
  if (!DEEPL_TARGET_LANGUAGES.has(target_lang)) {
    return errorResponse('Unsupported target language', 400, origin);
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
