/**
 * 「今天吃这桌」后端通信层
 * - 同域部署（腾讯云 EdgeOne Pages / 魔搭创空间 / 自托管国内服务）自动直连 /api/poi 与 /api/chat（国内 4G/5G/支付宝扫码秒开，零跨域）
 * - 纯静态托管（如 GitHub Pages 或本地 http.server）自动回退到云端代理
 */

import { extractJsonPayload, buildFallbackPlan, estimateMealBudget } from "./engine.js";

const FALLBACK_WORKER = "https://alipay-dining-proxy.breakneo.workers.dev";

function getEndpoints() {
  if (typeof window !== "undefined") {
    const host = window.location.hostname || "";
    const port = window.location.port || "";
    const isStaticFallback = host.endsWith("github.io") || ((host === "127.0.0.1" || host === "localhost") && (port === "8080" || port === "4173"));
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

async function callChat(messages, maxTokens = 1600) {
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

async function generateBatchPlans({ anchor, batchRestaurants, req, quota }) {
  const shopBrief = batchRestaurants.map((r, i) => ({
    idx: i,
    id: r.id,
    name: r.name,
    cuisine: r.cuisine,
    rating: r.rating || "暂无",
    realAvgCostPerPerson: r.cost || req.perCapita,
    distanceMeters: r.distance ?? "未知",
    address: r.address,
    openTime: r.openTime || "未知",
  }));

  const systemPrompt = [
    "你是「今天吃这桌」聚餐选店点菜专家（支付宝生活消费场景）。",
    "严格遵守以下底线：",
    "1. 只围绕传入的真实高德餐厅列表作答，绝不改名或编造不存在的店。",
    "2. 严禁虚构某店具体的实时团购套餐精确标价；在 groupBuyStrategy 中，仅结合支付宝口碑/高德团购生态，给出该品类下「先看代金券还是多人套餐、怎么叠加单点更划算」的实操建议（绝不提及任何非支付宝生态的第三方团购平台）。",
    "3. 每道菜的 estPrice 必须诚实参考该店 realAvgCostPerPerson 与聚餐人数做合理估算，菜品之和应接近该店 estimatedTotal。",
    "4. 必须严格避开用户忌口，菜品数量严格遵循建议配比，杜绝浪费。",
    "5. 只输出合法 JSON，不要输出任何额外说明文字。",
  ].join("\n");

  const userPrompt = JSON.stringify(
    {
      task: "请为以下真实餐厅分别生成选店理由、按人数配菜清单、参考预算与支付宝口碑/高德团购省钱建议",
      userNeed: {
        location: anchor?.name || req.location,
        city: anchor?.city || "",
        headcount: req.headcount,
        scene: req.scene,
        targetPerCapita: req.perCapita,
        targetTotalBudget: req.totalBudget,
        preferencesAndRestrictions: req.preferences || "无特殊忌口",
        recommendedDishQuota: quota.formulaText,
      },
      restaurants: shopBrief,
      outputSchema: {
        overallAdvice: "一句话横向总结这批店怎么选",
        plans: [
          {
            idx: 0,
            highlightTag: "4-8字卖点标签，如：稳妥不踩雷/聚餐氛围佳/高性价比",
            whyChoose: "结合口碑、距离、人均与聚餐场景的2句推荐理由",
            dishes: [
              {
                category: "凉菜/硬菜/素菜/汤主食",
                name: "具体菜名（贴合该店菜系且符合忌口）",
                reason: "10字以内推荐理由",
                estPrice: 68,
              },
            ],
            estimatedTotal: 480,
            groupBuyStrategy: "结合支付宝/口碑/高德团购的省钱策略（不编造假价、不提竞品平台）",
            avoidTip: "一句针对人数/忌口/点菜顺序的避坑提醒",
          },
        ],
      },
    },
    null,
    2
  );

  try {
    const raw = await callChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      1750
    );
    const parsed = extractJsonPayload(raw);
    if (!parsed || !Array.isArray(parsed.plans)) {
      throw new Error("解析失败");
    }

    const plans = batchRestaurants.map((r, idx) => {
      const matched = parsed.plans.find((p) => Number(p.idx) === idx) || parsed.plans[idx];
      if (!matched || !Array.isArray(matched.dishes) || matched.dishes.length === 0) {
        return buildFallbackPlan(r, req, quota);
      }
      const dishes = matched.dishes.slice(0, 10).map((d) => ({
        category: String(d.category || "推荐菜"),
        name: String(d.name || "门店招牌菜"),
        reason: String(d.reason || "口碑必点"),
        estPrice: Math.max(Math.round(Number(d.estPrice) || 45), 10),
      }));
      const dishSum = dishes.reduce((s, d) => s + d.estPrice, 0);
      const baseEst = estimateMealBudget({
        restaurantCost: r.cost,
        headcount: req.headcount,
        targetPerCapita: req.perCapita,
      });
      const estimatedTotal = dishSum > 0 ? dishSum : baseEst.estimatedTotal;
      return {
        restaurantId: r.id,
        restaurantName: r.name,
        highlightTag: String(matched.highlightTag || r.matchReasons?.[0] || "口碑优选"),
        whyChoose: String(matched.whyChoose || ""),
        dishes,
        estimatedTotal,
        estimatedPerCapita: Math.round(estimatedTotal / Math.max(req.headcount, 1)),
        groupBuyStrategy: String(matched.groupBuyStrategy || ""),
        avoidTip: String(matched.avoidTip || ""),
        isFallback: false,
      };
    });

    return { overallAdvice: String(parsed.overallAdvice || ""), plans };
  } catch {
    return {
      overallAdvice: "",
      plans: batchRestaurants.map((r) => buildFallbackPlan(r, req, quota)),
    };
  }
}

/**
 * 支持 1~10 家餐厅批量生成配菜方案（超过 3 家自动并发分批，每批 3 家，避免截断）
 */
export async function generateDiningPlans({ anchor, restaurants, req, quota }) {
  const chunks = [];
  for (let i = 0; i < restaurants.length; i += 3) {
    chunks.push(restaurants.slice(i, i + 3));
  }

  const batchResults = await Promise.all(
    chunks.map((batchRestaurants) => generateBatchPlans({ anchor, batchRestaurants, req, quota }))
  );

  const plans = batchResults.flatMap((b) => b.plans);
  const firstAdvice = batchResults[0]?.overallAdvice?.trim();
  const overallAdvice =
    firstAdvice || `已为你从指定地点周边筛出 ${restaurants.length} 家贴合预算与口味的饭馆，可按下方对比直接挑选。`;

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
    900
  );
  const parsed = extractJsonPayload(raw);
  if (!parsed) {
    throw new Error("团购比价结果解析失败，请检查粘贴内容后重试");
  }
  return parsed;
}
