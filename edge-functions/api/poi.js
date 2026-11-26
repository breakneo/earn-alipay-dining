/**
 * 腾讯云 EdgeOne Pages 边缘函数：POST /api/poi（高德开放平台实时餐饮 POI 查询）
 * 环境变量：AMAP_API_KEY（在 EdgeOne Pages 控制台加密配置，绝不落代码仓）
 */

const AMAP_BASE = "https://restapi.amap.com/v3";

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
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
    radius: String(Math.min(Math.max(Number(radius) || 2000, 300), 5000)),
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
    throw new Error(`地图查询异常：${data.info || data.infocode || "unknown"}`);
  }
  return Array.isArray(data.pois) ? data.pois.map(normalizePoi).filter((p) => p.name) : [];
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context || {};
    const amapKey =
      env?.AMAP_API_KEY ||
      (typeof process !== "undefined" ? process.env?.AMAP_API_KEY : "") ||
      "";
    if (!amapKey) {
      return jsonResp({ error: "服务端尚未配置地图服务密钥" }, 503);
    }
    const body = await request.json();
    const locationText = String(body.location || "").trim();
    if (!locationText || locationText.length > 60) {
      return jsonResp({ error: "请输入有效的聚餐地点（1~60字）" }, 400);
    }
    const city = String(body.city || "").trim();
    const cuisine = String(body.cuisine || "").trim();
    const radius = Number(body.radius) || 2000;

    const anchor = await resolveAnchor(locationText, city, amapKey);
    if (!anchor) {
      return jsonResp({ error: `未找到「${locationText}」，请补充城市或附近地铁站/商圈名` }, 404);
    }

    let pois = await searchNearbyRestaurants(anchor.location, cuisine, radius, amapKey);
    if (pois.length < 10 && cuisine && cuisine !== "不限") {
      const broader = await searchNearbyRestaurants(anchor.location, "", radius, amapKey);
      const seen = new Set(pois.map((p) => p.id));
      for (const item of broader) {
        if (!seen.has(item.id)) {
          pois.push(item);
          seen.add(item.id);
        }
      }
    }

    return jsonResp({
      anchor,
      total: pois.length,
      restaurants: pois.slice(0, 25),
    });
  } catch (err) {
    return jsonResp({ error: err?.message || "查询周边餐厅失败" }, 502);
  }
}
