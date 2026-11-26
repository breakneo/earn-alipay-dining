/**
 * 「今天吃这桌」后端通信层
 * - 同域部署（腾讯云 EdgeOne 自定义域名 / 边缘函数）自动直连 /api/poi 与 /api/chat（国内 4G/5G/支付宝扫码秒开，零跨域）
 * - 纯静态托管（如 GitHub Pages 或本地 http.server）自动回退到云端代理
 * - 单店并发推理（每家店独立轻量请求，3~5 秒秒回，彻底规避边缘函数长请求超时）
 */

import { extractJsonPayload, buildFallbackPlan, estimateMealBudget } from "./engine.js";

const FALLBACK_WORKER = "https://alipay-dining-proxy.breakneo.workers.dev";

function getEndpoints() {
  if (typeof window !== "undefined") {
    const host = window.location.hostname || "";
    const port = window.location.port || "";
    const isStaticFallback =
      host.endsWith("github.io") ||
      ((host === "127.0.0.1" || host === "localhost") && (port === "8080" || port === "4173"));
    if (!isStaticFallback) {
      return { poi: "/api/poi", chat: "/api/chat" };
    }
  }
  return { poi: `${FALLBACK_WORKER}/poi`, chat: `${FALLBACK_WORKER}/chat` };
}

export async function fetchRealRestaurants({ location, city = "", cuisine = "", radius = 2000 }) {
  const { poi } = getEndpoints();
  const resp = await fetch(poi, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location, city, cuisine, radius }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || `查询周边饭馆失败（HTTP ${resp.status}）`);
  }
  return data;
}

async function callChat(messages, maxTokens = 750) {
  const { chat } = getEndpoints();
  const resp = await fetch(chat, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || `智能配菜服务繁忙（HTTP ${resp.status}）`);
  }
  const content = data?.choices?.[0]?.message?.content || "";
  if (!content.trim()) {
    throw new Error("未能获取配菜建议，请稍后重试");
  }
  return content;
}

/**
 * 为单家真实餐厅生成精准配菜、参考预算（不含酒水）与支付宝/口碑团购省钱策略
 * 单次请求轻量快速（约 3~5 秒），并发执行 3 家整体仅需约 5 秒且永不超时
 */
async function generateSingleShopPlan({ anchor, restaurant, req, quota }) {
  const systemPrompt = [
    "你是「今天吃这桌」聚餐点菜专家（支付宝口碑与高德生态）。",
    "要求：1) 严格围绕传入的真实餐厅菜系推荐具体常见招牌菜，严禁写「招牌主菜×2」这类泛泛占位词；",
    "2) 严格避开用户忌口，菜品数遵循推荐配比，价格估算不含酒水并贴近该店人均×人数；",
    "3) 严禁编造实时团购精确标价，仅给支付宝口碑/高德团购核销策略，不提非支付宝系第三方平台；",
    "4) 仅输出合法精简 JSON，无多余文字。",
  ].join("\n");

  const userPrompt = JSON.stringify({
    location: anchor?.name || req.location,
    headcount: req.headcount,
    scene: req.scene,
    targetPerCapita: req.perCapita,
    targetTotalNoDrinks: req.totalBudget,
    preferences: req.preferences || "无特殊忌口",
    dishQuota: quota.formulaText,
    restaurant: {
      name: restaurant.name,
      cuisine: restaurant.cuisine,
      rating: restaurant.rating || "暂无",
      avgCost: restaurant.cost || req.perCapita,
      distanceMeters: restaurant.distance ?? "未知",
      address: restaurant.address,
    },
    schema: {
      highlightTag: "4-7字卖点标签",
      whyChoose: "2句简明推荐理由",
      dishes: [{ category: "凉菜/硬菜/素菜/汤主食", name: "具体菜名", reason: "8字内理由", estPrice: 58 }],
      groupBuyStrategy: "2句支付宝口碑/高德团购省钱策略（不编造假价）",
      avoidTip: "1句点菜避坑提醒",
    },
  });

  try {
    const raw = await callChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      720
    );
    const parsed = extractJsonPayload(raw);
    if (!parsed || !Array.isArray(parsed.dishes) || parsed.dishes.length === 0) {
      throw new Error("格式解析失败");
    }
    const dishes = parsed.dishes.slice(0, 10).map((d) => ({
      category: String(d.category || "推荐菜"),
      name: String(d.name || "门店特色菜"),
      reason: String(d.reason || "口碑必点"),
      estPrice: Math.max(Math.round(Number(d.estPrice) || 45), 10),
    }));
    const dishSum = dishes.reduce((s, d) => s + d.estPrice, 0);
    const baseEst = estimateMealBudget({
      restaurantCost: restaurant.cost,
      headcount: req.headcount,
      targetPerCapita: req.perCapita,
    });
    const estimatedTotal = dishSum > 0 ? dishSum : baseEst.estimatedTotal;

    return {
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      highlightTag: String(parsed.highlightTag || restaurant.matchReasons?.[0] || "口碑优选"),
      whyChoose: String(parsed.whyChoose || ""),
      dishes,
      estimatedTotal,
      estimatedPerCapita: Math.round(estimatedTotal / Math.max(req.headcount, 1)),
      groupBuyStrategy: String(parsed.groupBuyStrategy || ""),
      avoidTip: String(parsed.avoidTip || ""),
      isFallback: false,
    };
  } catch {
    return buildFallbackPlan(restaurant, req, quota);
  }
}

/**
 * 并发池：支持 1~10 家餐厅快速并发配菜（最多 4 路并发，每店 3~5 秒返回）
 */
export async function generateDiningPlans({ anchor, restaurants, req, quota }) {
  const plans = new Array(restaurants.length);
  const concurrency = Math.min(4, restaurants.length);
  let cursor = 0;

  async function worker() {
    while (cursor < restaurants.length) {
      const idx = cursor++;
      plans[idx] = await generateSingleShopPlan({
        anchor,
        restaurant: restaurants[idx],
        req,
        quota,
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const summaryParts = plans.slice(0, 3).map((p) => `${p.highlightTag}选「${p.restaurantName.replace(/[\(（].*$/, "")}」`);
  const overallAdvice =
    summaryParts.length >= 2
      ? `${summaryParts.join("，")}；共甄选 ${restaurants.length} 家贴合 ${req.headcount} 人预算（不含酒水）的饭馆。`
      : `已为你甄选 ${restaurants.length} 家贴合 ${req.headcount} 人「${req.scene}」预算（不含酒水）的饭馆。`;

  return { overallAdvice, plans };
}

/**
 * 粘贴支付宝/口碑/高德团购套餐或代金券文字，实算「团购+补菜 vs 纯单点」差价与份量
 */
export async function compareGroupBuyWithAI({ restaurant, req, estimatedTotal, pastedText }) {
  const systemPrompt = [
    "你是「今天吃这桌」团购比价精算助手（支付宝口碑与高德生态）。",
    "用户会把在支付宝、口碑或高德里看到的真实团购套餐或代金券文案粘贴给你。",
    "你必须严格基于用户粘贴的真实文字和金额做计算，绝不编造文字里没有的优惠，仅围绕支付宝、口碑与高德生态作答。",
    "只返回合法 JSON。",
  ].join("\n");

  const userPrompt = JSON.stringify({
    restaurant: restaurant.name,
    cuisine: restaurant.cuisine,
    headcount: req.headcount,
    scene: req.scene,
    preferencesAndRestrictions: req.preferences || "无特殊忌口",
    alaCarteEstimatedTotal: estimatedTotal,
    pastedGroupBuyText: pastedText,
    outputSchema: {
      verdict: "买这个团购划算 / 建议改买代金券+单点 / 份量不够需补菜",
      groupBuyPrice: 298,
      portionCheck: "分析这套团购够不够N人吃，主菜/素菜是否均衡",
      dietaryCheck: "是否命中用户的忌口/辣度雷区",
      addonSuggestions: ["建议补点的1-2道菜及原因（如果够吃则写无需补菜）"],
      addonCost: 68,
      totalWithGroupBuy: 366,
      savingsVsAlaCarte: 94,
      actionTip: "一句话最终操作建议（如：先抢1份套餐再单点1份清炒时蔬，折合人均91元）",
    },
  });

  const raw = await callChat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    750
  );
  const parsed = extractJsonPayload(raw);
  if (!parsed) {
    throw new Error("团购比价结果解析失败，请检查粘贴内容后重试");
  }
  return parsed;
}
