/**
 * 「今天吃这桌」核心算法与工具引擎（纯函数，零外部依赖）
 */

const NON_DINING_KEYWORDS = [
  "奶茶",
  "冷饮",
  "咖啡",
  "甜品",
  "糕饼",
  "面包",
  "蛋糕",
  "饮品",
  "茶饮",
  "果汁",
  "便利店",
  "零食",
  "冰激凌",
  "冰淇淋",
  "茶馆",
  "茶楼",
  "茶室",
];

const FAST_FOOD_KEYWORDS = ["快餐", "便当", "汉堡", "炸鸡", "沙县", "兰州拉面", "黄焖鸡", "小吃", "粉面"];
const SPICY_KEYWORDS = ["川菜", "湘菜", "重庆", "麻辣", "冒菜", "串串", "水煮鱼", "酸菜鱼", "毛血旺", "烤鱼", "辣"];

export function normalizeBudget({ headcount = 4, budgetMode = "per_capita", budgetValue = 120 } = {}) {
  const n = Math.min(Math.max(Math.round(Number(headcount) || 4), 1), 30);
  const rawVal = Math.max(Number(budgetValue) || 100, 20);
  if (budgetMode === "total") {
    const totalBudget = Math.round(rawVal);
    const perCapita = Math.max(Math.round(totalBudget / n), 15);
    return { headcount: n, budgetMode: "total", perCapita, totalBudget };
  }
  const perCapita = Math.round(rawVal);
  return { headcount: n, budgetMode: "per_capita", perCapita, totalBudget: perCapita * n };
}

export function normalizeShopCount(count = 3) {
  const n = Number(count);
  if (!Number.isFinite(n)) return 3;
  return Math.min(Math.max(Math.round(n), 1), 10);
}

export function normalizeRadius(radius = 2000) {
  return Math.min(Math.max(Math.round(Number(radius) || 2000), 300), 5000);
}

export function formatDistance(meters) {
  const m = Number(meters);
  if (!Number.isFinite(m) || m < 0) return "附近";
  if (m >= 1000) return `${(m / 1000).toFixed(1)}公里`;
  return `${Math.round(m)}米`;
}

export function computeDishQuota(headcount = 4, scene = "朋友小聚") {
  const n = Math.min(Math.max(Math.round(Number(headcount) || 4), 1), 30);
  const formalBonus = scene === "商务宴请" || scene === "单位聚餐" ? 1 : 0;

  let cold = 1;
  let hot = 2;
  let veg = 1;
  let soupOrStaple = 1;

  if (n <= 2) {
    cold = 0;
    hot = 2;
    veg = 1;
    soupOrStaple = 1;
  } else if (n <= 4) {
    cold = 1;
    hot = 2;
    veg = 1;
    soupOrStaple = 1;
  } else if (n <= 6) {
    cold = 2;
    hot = 3 + formalBonus;
    veg = 2;
    soupOrStaple = 1;
  } else if (n <= 10) {
    cold = 3;
    hot = 4 + formalBonus;
    veg = 2;
    soupOrStaple = 2;
  } else {
    cold = Math.min(Math.round(n * 0.3), 6);
    hot = Math.min(Math.round(n * 0.55) + formalBonus, 10);
    veg = Math.min(Math.round(n * 0.25), 4);
    soupOrStaple = 2;
  }

  const totalDishes = cold + hot + veg + soupOrStaple;
  const parts = [];
  if (cold > 0) parts.push(`${cold}道凉菜`);
  parts.push(`${hot}道招牌硬菜`);
  parts.push(`${veg}道时蔬`);
  parts.push(`${soupOrStaple}道汤/主食`);

  return {
    headcount: n,
    scene,
    cold,
    hot,
    veg,
    soupOrStaple,
    totalDishes,
    formulaText: parts.join(" + "),
  };
}

function getBrandKey(name = "") {
  return String(name)
    .replace(/[\(（\[【].*$/, "")
    .replace(/[-·\s]+/g, "")
    .slice(0, 8);
}

function isNonDiningPoi(poi, prefText) {
  const text = `${poi.name || ""} ${poi.cuisine || ""} ${poi.rawType || ""}`;
  return NON_DINING_KEYWORDS.some((kw) => text.includes(kw) && !prefText.includes(kw));
}

function isFastFoodPoi(poi, prefText) {
  const text = `${poi.name || ""} ${poi.cuisine || ""} ${poi.rawType || ""}`;
  return FAST_FOOD_KEYWORDS.some((kw) => text.includes(kw) && !prefText.includes(kw));
}

function scoreRestaurant(poi, { headcount = 4, perCapita = 120, scene = "朋友小聚", preferences = "", radius = 2000 }) {
  const pref = String(preferences || "");
  const fullText = `${poi.name || ""} ${poi.cuisine || ""} ${poi.rawType || ""} ${poi.tag || ""}`;
  let score = 0;
  const reasons = [];

  // 1. 口碑评分（最多 42 分）
  const rating = Number(poi.rating);
  if (Number.isFinite(rating) && rating > 0) {
    score += Math.min(Math.max((rating - 3.0) / 2.0, 0), 1) * 42;
    if (rating >= 4.5) reasons.push(`口碑 ${rating.toFixed(1)} 分`);
  } else {
    score += 22;
  }

  // 2. 人均与预算匹配度（最多 28 分）
  const cost = Number(poi.cost);
  if (Number.isFinite(cost) && cost > 0) {
    const ratio = cost / Math.max(perCapita, 30);
    if (ratio >= 0.7 && ratio <= 1.15) {
      score += 28;
      reasons.push(`人均 ¥${Math.round(cost)} 贴合预算`);
    } else if (ratio > 1.15 && ratio <= 1.35) {
      score += 18;
      reasons.push(`人均 ¥${Math.round(cost)} 略高于预算`);
    } else if (ratio < 0.7 && ratio >= 0.45) {
      score += 20;
      reasons.push(`人均 ¥${Math.round(cost)} 高性价比`);
    } else if (ratio > 1.6) {
      score -= 18;
    } else {
      score += 8;
    }
  } else {
    score += 14;
  }

  // 3. 距离便利度（最多 18 分）
  const dist = Number(poi.distance);
  const maxR = normalizeRadius(radius);
  if (Number.isFinite(dist) && dist >= 0) {
    if (dist <= Math.min(500, maxR * 0.4)) {
      score += 18;
      reasons.push(`距选定地点 ${formatDistance(dist)}`);
    } else if (dist <= maxR * 0.75) {
      score += 13;
      reasons.push(`距选定地点 ${formatDistance(dist)}`);
    } else if (dist <= maxR) {
      score += 8;
    } else {
      score -= 10;
    }
  }

  // 4. 聚餐场景与忌口适配（最多 12 分）
  if (headcount >= 4 && perCapita >= 65 && isFastFoodPoi(poi, pref)) {
    score -= 22;
  }
  if ((scene === "单位聚餐" || scene === "商务宴请") && Number.isFinite(cost) && cost < 45) {
    score -= 18;
  }
  if ((pref.includes("不吃辣") || pref.includes("清淡") || pref.includes("不辣")) && SPICY_KEYWORDS.some((k) => fullText.includes(k))) {
    score -= 16;
  }
  const cuisineHints = ["火锅", "粤菜", "广东", "浙江", "杭帮", "江浙", "本帮", "川菜", "湘菜", "日料", "烤肉", "海鲜", "烧烤", "西餐", "泰国", "北京", "东北", "云南", "茶餐厅"];
  for (const h of cuisineHints) {
    if (pref.includes(h) && fullText.includes(h)) {
      score += 14;
      reasons.push(`命中偏好「${h}」`);
      break;
    }
  }

  return {
    ...poi,
    matchScore: Math.round(Math.max(score, 1)),
    matchReasons: reasons.slice(0, 3),
  };
}

/**
 * 按用户指定数量（1~10 家）筛选最合适的餐厅，避免同品牌扎堆并保留真实候补池
 */
export function selectTopRestaurants(pois = [], req = {}, limit = 3) {
  const count = normalizeShopCount(limit);
  const pref = String(req.preferences || "");
  const valid = (pois || []).filter((p) => p && p.name && !isNonDiningPoi(p, pref));
  const pool = valid.length >= count ? valid : (pois || []).filter((p) => p && p.name);

  const scored = pool.map((p) => scoreRestaurant(p, req)).sort((a, b) => b.matchScore - a.matchScore);

  const picked = [];
  const usedBrands = new Set();
  const cuisineCount = new Map();
  const maxSameCuisine = count <= 3 ? 2 : Math.max(2, Math.ceil(count / 2));

  // 第一轮：优先保证品牌不重复 + 品类多样
  for (const item of scored) {
    if (picked.length >= count) break;
    const brand = getBrandKey(item.name);
    const cKey = item.cuisine || "综合";
    if (usedBrands.has(brand)) continue;
    if ((cuisineCount.get(cKey) || 0) >= maxSameCuisine && scored.length > count + 2) continue;
    picked.push(item);
    usedBrands.add(brand);
    cuisineCount.set(cKey, (cuisineCount.get(cKey) || 0) + 1);
  }

  // 第二轮：若不足目标数量则按高分补足
  if (picked.length < count) {
    const pickedIds = new Set(picked.map((p) => p.id || p.name));
    for (const item of scored) {
      if (picked.length >= count) break;
      const key = item.id || item.name;
      if (pickedIds.has(key)) continue;
      picked.push(item);
      pickedIds.add(key);
    }
  }

  const finalIds = new Set(picked.map((p) => p.id || p.name));
  const backups = scored.filter((item) => !finalIds.has(item.id || item.name));

  return { picked, backups };
}

export function selectTopThreeRestaurants(pois = [], req = {}) {
  return selectTopRestaurants(pois, req, 3);
}

export function estimateMealBudget({ restaurantCost, headcount = 4, targetPerCapita = 120 }) {
  const n = Math.max(Math.round(Number(headcount) || 4), 1);
  const target = Math.max(Number(targetPerCapita) || 120, 20);
  const hasRealCost = Number.isFinite(Number(restaurantCost)) && Number(restaurantCost) > 0;
  const perCapita = hasRealCost ? Math.round(Number(restaurantCost)) : target;
  const estimatedTotal = perCapita * n;
  const rangeLow = Math.round((estimatedTotal * 0.9) / 10) * 10;
  const rangeHigh = Math.round((estimatedTotal * 1.15) / 10) * 10;
  const diffTotal = estimatedTotal - target * n;

  let budgetStatus = "within";
  let budgetLabel = "符合预算";
  if (perCapita > target * 1.15) {
    budgetStatus = "over";
    budgetLabel = `约超预算 ¥${Math.abs(diffTotal)}`;
  } else if (perCapita > target) {
    budgetStatus = "near";
    budgetLabel = "略高于目标人均";
  } else if (diffTotal < -20) {
    budgetLabel = `预计结余 ¥${Math.abs(diffTotal)}`;
  }

  return {
    costMissing: !hasRealCost,
    estimatedPerCapita: perCapita,
    estimatedTotal,
    rangeLow,
    rangeHigh,
    diffTotal,
    budgetStatus,
    budgetLabel,
  };
}

export function calculateAaSplit({ totalAmount = 0, headcount = 4, drinkTotal = 0, drinkersCount = 0 }) {
  const total = Math.max(Number(totalAmount) || 0, 0);
  const n = Math.max(Math.round(Number(headcount) || 1), 1);
  const drink = Math.min(Math.max(Number(drinkTotal) || 0, 0), total);
  const drinkers = Math.min(Math.max(Math.round(Number(drinkersCount) || 0), 0), n);

  const round1 = (v) => Math.round(v * 10) / 10;

  if (drink > 0 && drinkers > 0) {
    const foodTotal = total - drink;
    const foodPerPerson = round1(foodTotal / n);
    const drinkPerDrinker = round1(drink / drinkers);
    const drinkerPerPerson = round1(foodPerPerson + drinkPerDrinker);
    return {
      totalAmount: total,
      headcount: n,
      drinkTotal: drink,
      drinkersCount: drinkers,
      foodPerPerson,
      drinkPerDrinker,
      drinkerPerPerson,
      nonDrinkerPerPerson: foodPerPerson,
      perPerson: round1(total / n),
      summaryText: `【今天吃这桌 · AA 账单】\n总实付：¥${total}（共 ${n} 人，其中酒水 ¥${drink} 由 ${drinkers} 位喝酒伙伴均摊）\n• 喝酒人均：¥${drinkerPerPerson}（餐费 ¥${foodPerPerson} + 酒水 ¥${drinkPerDrinker}）\n• 不喝酒人均：¥${foodPerPerson}\n打开支付宝搜索「群收款」按上述金额发起即可。`,
    };
  }

  const perPerson = round1(total / n);
  return {
    totalAmount: total,
    headcount: n,
    drinkTotal: 0,
    drinkersCount: 0,
    foodPerPerson: perPerson,
    drinkPerDrinker: 0,
    drinkerPerPerson: perPerson,
    nonDrinkerPerPerson: perPerson,
    perPerson,
    summaryText: `【今天吃这桌 · AA 账单】\n总实付：¥${total}（共 ${n} 人均摊）\n• 每人应付：¥${perPerson}\n打开支付宝搜索「群收款」输入总金额 ¥${total}、${n} 人即可一键发起。`,
  };
}

export function buildAbaoPrompt(restaurant, headcount = 4, perCapita = 120) {
  const addr = restaurant.address ? `（${restaurant.address}）` : "";
  return `帮我查一下「${restaurant.name}」${addr}在支付宝口碑和高德里，有没有适合${headcount}人聚餐（人均约¥${perCapita}）的团购套餐或代金券，以及大家最推荐的招牌菜和避雷菜。`;
}

export function buildAmapUrl(restaurant) {
  const loc = String(restaurant.location || "").trim();
  const name = encodeURIComponent(restaurant.name || "聚餐地点");
  if (/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(loc)) {
    return `https://uri.amap.com/marker?position=${loc}&name=${name}&src=today-table&callnative=0`;
  }
  return `https://ditu.amap.com/search?query=${name}`;
}

export function buildAlipayAaScheme() {
  return "alipays://platformapi/startapp?appId=20000116";
}

/**
 * 简洁得体的约饭定店通知（不含参考点菜和预计花销，符合真实社交礼仪）
 */
export function buildInviteText({ restaurant, headcount, scene, timeText = "今晚 18:30" }) {
  return [
    `【今天吃这桌 · 聚餐定店通知】`,
    `时间：${timeText}（${scene || "聚餐"} · ${headcount}人）`,
    `餐厅：${restaurant.name}${restaurant.rating ? `（评分 ${restaurant.rating}）` : ""}`,
    `地址：${restaurant.address || "见高德导航"}`,
    `高德导航：${buildAmapUrl(restaurant)}`,
  ].join("\n");
}

function formatIcsUtc(dateObj) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    dateObj.getUTCFullYear() +
    pad(dateObj.getUTCMonth() + 1) +
    pad(dateObj.getUTCDate()) +
    "T" +
    pad(dateObj.getUTCHours()) +
    pad(dateObj.getUTCMinutes()) +
    pad(dateObj.getUTCSeconds()) +
    "Z"
  );
}

export function buildIcsCalendar({ restaurant, headcount = 4, dateTimeIso }) {
  const start = dateTimeIso ? new Date(dateTimeIso) : new Date(Date.now() + 3600_000 * 3);
  const safeStart = Number.isNaN(start.getTime()) ? new Date() : start;
  const end = new Date(safeStart.getTime() + 2 * 3600_000);
  const clean = (s) => String(s || "").replace(/[\r\n]+/g, " ").replace(/([,;])/g, "\\$1");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TodayTable//Alipay Emerge 2026//CN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:today-table-${Date.now()}@alipay-emerge`,
    `DTSTAMP:${formatIcsUtc(new Date())}`,
    `DTSTART:${formatIcsUtc(safeStart)}`,
    `DTEND:${formatIcsUtc(end)}`,
    `SUMMARY:今天吃这桌：${clean(restaurant.name)}（${headcount}人聚餐）`,
    `LOCATION:${clean(restaurant.address || restaurant.name)}`,
    `DESCRIPTION:高德导航 ${buildAmapUrl(restaurant)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export function extractJsonPayload(rawText = "") {
  const text = String(rawText || "").trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function buildFallbackPlan(restaurant, req, quota) {
  const est = estimateMealBudget({
    restaurantCost: restaurant.cost,
    headcount: req.headcount,
    targetPerCapita: req.perCapita,
  });
  const baseUnit = Math.max(Math.round(est.estimatedTotal / Math.max(quota.totalDishes, 3)), 28);
  const dishes = [];
  if (quota.cold > 0) {
    dishes.push({
      category: "凉菜开胃",
      name: `${restaurant.cuisine}时令爽口凉菜 ×${quota.cold}`,
      reason: "先上桌垫胃，避免等热菜冷场",
      estPrice: Math.round(baseUnit * 0.55) * quota.cold,
    });
  }
  dishes.push({
    category: "招牌硬菜",
    name: `门店口碑 Top 招牌主菜 ×${quota.hot}`,
    reason: `按${req.headcount}人「${req.scene}」配足核心硬菜${req.preferences ? `（注意：${req.preferences}）` : ""}`,
    estPrice: Math.round(baseUnit * 1.35) * quota.hot,
  });
  dishes.push({
    category: "解腻时蔬",
    name: `清炒当季时蔬 ×${quota.veg}`,
    reason: "荤素平衡不腻口",
    estPrice: Math.round(baseUnit * 0.6) * quota.veg,
  });
  dishes.push({
    category: "汤品主食",
    name: `例汤或特色主食 ×${quota.soupOrStaple}`,
    reason: "收尾压饱，控制总价不超支",
    estPrice: Math.round(baseUnit * 0.85) * quota.soupOrStaple,
  });

  return {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    highlightTag: restaurant.matchReasons?.[0] || "口碑优选",
    whyChoose: `${restaurant.name} 位于${restaurant.address || "所选地标附近"}，评分 ${restaurant.rating || "暂无"}，参考人均约 ¥${est.estimatedPerCapita}，与本次 ${req.headcount} 人「${req.scene}」贴合度高。`,
    dishes,
    estimatedTotal: est.estimatedTotal,
    estimatedPerCapita: est.estimatedPerCapita,
    groupBuyStrategy: `建议到店前先在支付宝口碑或高德查看该店是否有「满100减代金券」或「${req.headcount <= 4 ? "2-4人" : "4-6人"}团购套餐」；若套餐菜品有忌口，优先买代金券叠加单点更灵活。`,
    avoidTip: `建议总菜数控制在 ${quota.totalDishes} 道左右（${quota.formulaText}），不够再加 1 道主食，避免点多浪费。`,
    isFallback: true,
  };
}
