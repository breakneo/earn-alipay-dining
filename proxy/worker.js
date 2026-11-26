/**
 * Cloudflare Worker 安全双路由代理（支付宝「智能体涌现奖」2026 第一期）
 *
 * 路由：
 * - GET  /health : 健康检查（返回是否已配置高德与大模型 Secret，不暴露密钥）
 * - POST /poi    : 高德 Web 服务真实地标解析 + 周边餐饮 POI 查询（真实评分/人均/距离/地址）
 * - POST /chat   : SCNet GLM-5.3-Flash 对话代理（强制关闭 thinking 防超时，兼容 POST /）
 *
 * 安全防护：
 * 1. SCNET_API_KEY 与 AMAP_API_KEY 仅存 Cloudflare Worker Encrypted Secrets，绝不落前端或代码仓；
 * 2. 锁死 Origin（https://breakneo.github.io 及本地开发端口）与锁定模型（GLM-5.3-Flash）；
 * 3. 单 IP 滑动窗口限流（每小时最多 40 次请求），自动过期熔断（2027-01-05 00:00 UTC）。
 */

const ALLOWED_ORIGINS = new Set([
  "https://breakneo.github.io",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);
const SCNET_URL = "https://api.scnet.cn/api/llm/v1/chat/completions";
const AMAP_BASE = "https://restapi.amap.com/v3";
const LOCKED_MODEL = "GLM-5.3-Flash";
const EXPIRE_AT_MS = Date.parse("2027-01-05T00:00:00Z");

const ipBuckets = new Map();

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://breakneo.github.io";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

function jsonResp(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
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

function normalizePoi(p) {
  const biz = p.biz_ext || {};
  const photos = Array.isArray(p.photos) ? p.photos : [];
  const rawType = asStr(p.type);
  const typeParts = rawType.split(";").map((s) => s.trim()).filter(Boolean);
  const cuisine = typeParts[2] || typeParts[1] || "综合餐饮";
  return {
    id: asStr(p.id),
    name: asStr(p.name),
    cuisine,
    rawType,
    address: asStr(p.address) || `${asStr(p.adname)}${asStr(p.name)}`,
    city: asStr(p.cityname),
    district: asStr(p.adname),
    businessArea: asStr(p.business_area),
    location: asStr(p.location),
    distance: asNum(p.distance),
    rating: asNum(biz.rating),
    cost: asNum(biz.cost),
    tel: asStr(p.tel),
    tag: asStr(p.tag),
    openTime: asStr(biz.open_time) || asStr(biz.opentime2) || "",
    photo: photos[0]?.url || "",
  };
}

async function resolveAnchor(locationText, city, amapKey) {
  // 优先用 POI 文本搜索解析商圈/写字楼/地铁站，比纯地址编码更准确
  const textParams = new URLSearchParams({
    key: amapKey,
    keywords: locationText,
    offset: "3",
    page: "1",
    extensions: "base",
  });
  if (city) textParams.set("city", city);
  const r1 = await fetch(`${AMAP_BASE}/place/text?${textParams.toString()}`);
  const d1 = await r1.json();
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
  // 兜底：地理编码
  const geoParams = new URLSearchParams({ key: amapKey, address: locationText });
  if (city) geoParams.set("city", city);
  const r2 = await fetch(`${AMAP_BASE}/geocode/geo?${geoParams.toString()}`);
  const d2 = await r2.json();
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

async function searchNearbyRestaurants(anchorLoc, cuisine, radius, amapKey) {
  const params = new URLSearchParams({
    key: amapKey,
    location: anchorLoc,
    types: "050000",
    radius: String(Math.min(Math.max(Number(radius) || 2000, 500), 5000)),
    sortrule: "weight",
    offset: "25",
    page: "1",
    extensions: "all",
  });
  if (cuisine && cuisine !== "不限") {
    params.set("keywords", cuisine);
  }
  const resp = await fetch(`${AMAP_BASE}/place/around?${params.toString()}`);
  const data = await resp.json();
  if (data.status !== "1") {
    throw new Error(`高德接口返回异常：${data.info || data.infocode || "unknown"}`);
  }
  return Array.isArray(data.pois) ? data.pois.map(normalizePoi).filter((p) => p.name) : [];
}

async function handlePoi(body, env, headers) {
  if (!env.AMAP_API_KEY) {
    return jsonResp({ error: "服务端尚未配置高德地图密钥（AMAP_API_KEY）" }, 503, headers);
  }
  const locationText = String(body.location || "").trim();
  if (!locationText || locationText.length > 60) {
    return jsonResp({ error: "请输入有效的聚餐地点（1~60字）" }, 400, headers);
  }
  const city = String(body.city || "").trim();
  const cuisine = String(body.cuisine || "").trim();
  const radius = Number(body.radius) || 2000;

  const anchor = await resolveAnchor(locationText, city, env.AMAP_API_KEY);
  if (!anchor) {
    return jsonResp({ error: `未在高德地图找到「${locationText}」，请补充城市或附近地铁站/商圈名` }, 404, headers);
  }

  let pois = await searchNearbyRestaurants(anchor.location, cuisine, radius, env.AMAP_API_KEY);
  let fallbackUsed = false;
  if (pois.length < 3 && cuisine && cuisine !== "不限") {
    const broader = await searchNearbyRestaurants(anchor.location, "", Math.max(radius, 2500), env.AMAP_API_KEY);
    const seen = new Set(pois.map((p) => p.id));
    for (const item of broader) {
      if (!seen.has(item.id)) {
        pois.push(item);
        seen.add(item.id);
      }
    }
    fallbackUsed = true;
  }

  return jsonResp(
    {
      source: "高德开放平台 Web服务 API (实时查询)",
      anchor,
      fallbackUsed,
      total: pois.length,
      restaurants: pois.slice(0, 20),
    },
    200,
    headers
  );
}

async function handleChat(body, env, headers) {
  if (!env.SCNET_API_KEY) {
    return jsonResp({ error: "服务端尚未配置大模型密钥（SCNET_API_KEY）" }, 503, headers);
  }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-6) : [];
  if (!messages.length) {
    return jsonResp({ error: "messages 不能为空" }, 400, headers);
  }
  const upstreamResp = await fetch(SCNET_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.SCNET_API_KEY}`,
    },
    body: JSON.stringify({
      model: LOCKED_MODEL,
      temperature: typeof body.temperature === "number" ? Math.min(Math.max(body.temperature, 0), 0.7) : 0.3,
      max_tokens: Math.min(Number(body.max_tokens) || 1400, 1800),
      thinking: { type: "disabled" },
      messages,
    }),
  });
  const respBody = await upstreamResp.text();
  return new Response(respBody, {
    status: upstreamResp.status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return jsonResp({ error: "Forbidden Origin" }, 403, headers);
    }
    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResp(
        {
          ok: true,
          amapReady: Boolean(env.AMAP_API_KEY),
          llmReady: Boolean(env.SCNET_API_KEY),
          model: LOCKED_MODEL,
        },
        200,
        headers
      );
    }
    if (request.method !== "POST") {
      return jsonResp({ error: "Method Not Allowed" }, 405, headers);
    }
    if (Date.now() > EXPIRE_AT_MS) {
      return jsonResp({ error: "评审体验通道已到期关闭" }, 410, headers);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    const history = (ipBuckets.get(ip) || []).filter((t) => now - t < 3600_000);
    if (history.length >= 40) {
      return jsonResp({ error: "请求过于频繁，请稍后再试" }, 429, headers);
    }
    history.push(now);
    ipBuckets.set(ip, history);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResp({ error: "Invalid JSON" }, 400, headers);
    }

    try {
      if (url.pathname === "/poi") {
        return await handlePoi(body, env, headers);
      }
      if (url.pathname === "/chat" || url.pathname === "/") {
        return await handleChat(body, env, headers);
      }
      return jsonResp({ error: "Not Found" }, 404, headers);
    } catch (err) {
      return jsonResp({ error: err?.message || "代理调用失败" }, 502, headers);
    }
  },
};
