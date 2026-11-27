/**
 * 腾讯云 EdgeOne Pages 边缘函数：GET/POST/OPTIONS /api/poi（高德开放平台实时正餐 POI 查询）
 * - 严格限定 types=050100|050200（中餐厅 + 外国餐厅），源头过滤咖啡厅/甜品店/哈根达斯/糕饼/快餐/茶饮
 * - 并行拉取第 1~2 页（最多 40~50 家真实正餐馆），保障选 10 家与高预算品质筛选均有充足候选池
 * - 环境变量：AMAP_API_KEY（在 EdgeOne Pages 控制台加密配置，绝不落代码仓）
 */

const AMAP_BASE = "https://restapi.amap.com/v3";
const UPSTREAM_TIMEOUT_MS = 6500;
const SITDOWN_DINING_TYPES = "050100|050200";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const HARD_EXCLUDE_RE =
  /咖啡|coffee|cafe|星巴克|皮爷|瑞幸|manner|arabica|bacha|甜品|甜点|哈根达斯|häagen|haagen|godiva|歌帝梵|巧克力|冰淇淋|冰激凌|糕饼|面包|烘焙|bakery|蛋糕|奶茶|冷饮|茶饮|果茶|喜茶|奈雪|霸王茶姬|茶艺馆|茶馆|茶楼|茶室|便利店|零食|赛百味|肯德基|麦当劳|汉堡王|炸鸡|快餐厅|harbor\s*house/i;

function jsonResp(data, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      ...CORS_HEADERS,
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function asStr(val) {
  if (typeof val === "string") return val.trim();
  if (Array.isArray(val) && val.length > 0) return String(val[0]).trim();
  return "";
}

function asNum(val) {
  const s = asStr(val);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchJsonWithTimeout(url, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    return await resp.json();
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("地图服务响应超时，请稍后重试");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function normalizePoi(p) {
  const biz = p.biz_ext || {};
  const rawType = asStr(p.type);
  const firstSegment = rawType.split("|")[0] || rawType;
  const typeParts = firstSegment.split(";").map((s) => s.trim()).filter(Boolean);
  const cuisine = typeParts[2] || typeParts[1] || "中餐厅";
  const rawTag = asStr(p.tag);
  return {
    id: asStr(p.id),
    name: asStr(p.name),
    cuisine,
    rawType,
    address: asStr(p.address) || `${asStr(p.adname)}${asStr(p.name)}`,
    city: asStr(p.cityname),
    district: asStr(p.adname),
    location: asStr(p.location),
    distance: asNum(p.distance),
    rating: asNum(biz.rating),
    cost: asNum(biz.cost),
    tag: rawTag.length > 80 ? rawTag.slice(0, 80) : rawTag,
    openTime: asStr(biz.open_time) || asStr(biz.opentime2) || "",
  };
}

function isRealSitdownPoi(poi) {
  if (!poi?.name) return false;
  // 排除主类目为酒店住宿/购物服装的复合条目
  if (/^(住宿服务|购物服务|生活服务|风景名胜|商务住宅)/.test(poi.rawType || "")) {
    return false;
  }
  const combined = `${poi.name} ${poi.cuisine} ${poi.rawType}`;
  if (HARD_EXCLUDE_RE.test(combined)) {
    return false;
  }
  return true;
}

async function resolveAnchor(locationText, city, amapKey) {
  const textParams = new URLSearchParams({
    key: amapKey,
    keywords: locationText,
    offset: "3",
    page: "1",
    extensions: "base",
  });
  if (city) textParams.set("city", city);
  const d1 = await fetchJsonWithTimeout(`${AMAP_BASE}/place/text?${textParams.toString()}`);
  if (d1.status === "1" && Array.isArray(d1.pois) && d1.pois.length > 0 && d1.pois[0].location) {
    const first = d1.pois[0];
    return {
      name: asStr(first.name) || locationText,
      city: asStr(first.cityname) || city || "",
      district: asStr(first.adname) || "",
      address: asStr(first.address) || "",
      location: asStr(first.location),
    };
  }
  const geoParams = new URLSearchParams({ key: amapKey, address: locationText });
  if (city) geoParams.set("city", city);
  const d2 = await fetchJsonWithTimeout(`${AMAP_BASE}/geocode/geo?${geoParams.toString()}`);
  if (d2.status === "1" && Array.isArray(d2.geocodes) && d2.geocodes.length > 0 && d2.geocodes[0].location) {
    const g = d2.geocodes[0];
    return {
      name: asStr(g.formatted_address) || locationText,
      city: asStr(g.city) || city || "",
      district: asStr(g.district) || "",
      address: asStr(g.formatted_address) || "",
      location: asStr(g.location),
    };
  }
  return null;
}

async function searchNearbyPage(anchorLoc, cuisine, radius, amapKey, page = 1) {
  const params = new URLSearchParams({
    key: amapKey,
    location: anchorLoc,
    types: SITDOWN_DINING_TYPES,
    radius: String(Math.min(Math.max(Number(radius) || 2000, 300), 5000)),
    sortrule: "weight",
    offset: "25",
    page: String(page),
    extensions: "all",
  });
  if (cuisine && cuisine !== "不限") {
    params.set("keywords", cuisine);
  }
  const data = await fetchJsonWithTimeout(`${AMAP_BASE}/place/around?${params.toString()}`);
  if (data.status !== "1") {
    throw new Error(`地图查询异常：${data.info || data.infocode || "unknown"}`);
  }
  return Array.isArray(data.pois) ? data.pois.map(normalizePoi).filter(isRealSitdownPoi) : [];
}

async function searchNearbyRestaurants(anchorLoc, cuisine, radius, amapKey) {
  // 并行拉取第 1、2 页正餐馆，不增加耗时但将候选品质正餐池扩大一倍（最多 ~45 家）
  const results = await Promise.allSettled([
    searchNearbyPage(anchorLoc, cuisine, radius, amapKey, 1),
    searchNearbyPage(anchorLoc, cuisine, radius, amapKey, 2),
  ]);
  const merged = [];
  const seen = new Set();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      const key = item.id || item.name;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
  }
  if (merged.length === 0 && results[0]?.status === "rejected") {
    throw results[0].reason;
  }
  return merged;
}

async function handlePoiQuery(params, env, allowCache = false) {
  const amapKey =
    env?.AMAP_API_KEY ||
    (typeof process !== "undefined" ? process.env?.AMAP_API_KEY : "") ||
    "";
  if (!amapKey) {
    return jsonResp({ error: "服务端尚未配置地图服务密钥" }, 503);
  }
  const locationText = String(params.location || "").trim();
  if (!locationText || locationText.length > 60) {
    return jsonResp({ error: "请输入有效的聚餐地点（1~60字）" }, 400);
  }
  const city = String(params.city || "").trim();
  const cuisine = String(params.cuisine || "").trim();
  const radius = Number(params.radius) || 2000;
  const requestedCount = Math.min(Math.max(Math.round(Number(params.count) || 3), 1), 10);

  const anchor = await resolveAnchor(locationText, city, amapKey);
  if (!anchor) {
    return jsonResp({ error: `未找到「${locationText}」，请补充城市或附近地铁站/商圈名` }, 404);
  }

  let pois = await searchNearbyRestaurants(anchor.location, cuisine, radius, amapKey);
  const minNeeded = Math.min(requestedCount + 6, 18);
  if (pois.length < minNeeded && cuisine && cuisine !== "不限") {
    const broader = await searchNearbyRestaurants(anchor.location, "", radius, amapKey);
    const seen = new Set(pois.map((p) => p.id || p.name));
    for (const item of broader) {
      const key = item.id || item.name;
      if (!seen.has(key)) {
        pois.push(item);
        seen.add(key);
      }
    }
  }

  return jsonResp(
    {
      anchor,
      total: pois.length,
      restaurants: pois.slice(0, 40),
    },
    200,
    allowCache ? "public, max-age=120" : "no-store"
  );
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context || {};
    const body = await request.json();
    return await handlePoiQuery(body || {}, env, false);
  } catch (err) {
    return jsonResp({ error: err?.message || "查询周边餐厅失败" }, 502);
  }
}

export async function onRequestGet(context) {
  try {
    const { request, env } = context || {};
    const url = new URL(request.url);
    return await handlePoiQuery(
      {
        location: url.searchParams.get("location") || "",
        city: url.searchParams.get("city") || "",
        cuisine: url.searchParams.get("cuisine") || "",
        radius: url.searchParams.get("radius") || "2000",
        count: url.searchParams.get("count") || "3",
      },
      env,
      true
    );
  } catch (err) {
    return jsonResp({ error: err?.message || "查询周边餐厅失败" }, 502);
  }
}
