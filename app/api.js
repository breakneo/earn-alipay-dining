/**
 * 「今天吃这桌」后端通信层（对接 Cloudflare Worker 双路由安全代理）
 * - /poi  : 高德开放平台实时餐饮 POI 查询
 * - /chat : SCNet GLM-5.3-Flash 真实大模型推理
 */

import { extractJsonPayload, buildFallbackPlan, estimateMealBudget } from "./engine.js";

export const WORKER_BASE = "https://alipay-dining-proxy.breakneo.workers.dev";

export async function checkServiceHealth() {
  const resp = await fetch(`${WORKER_BASE}/health`);
  if (!resp.ok) throw new Error(`服务体检失败（HTTP ${resp.status}）`);
  return resp.json();
}

export async function fetchRealRestaurants({ location, city = "", cuisine = "", radius = 2000 }) {
  const resp = await fetch(`${WORKER_BASE}/poi`, {
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
  const resp = await fetch(`${WORKER_BASE}/chat`, {
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
    throw new Error(data.error || `大模型推理失败（HTTP ${resp.status}）`);
  }
  const content = data?.choices?.[0]?.message?.content || "";
  if (!content.trim()) {
    throw new Error("大模型返回内容为空，请重试");
  }
  return content;
}

/**
 * 为筛选出的 1~3 家真实饭馆批量生成：推荐理由 + 按人数/忌口点菜清单 + 团购策略 + 预算拆解
 */
export async function generateDiningPlans({ anchor, restaurants, req, quota }) {
  const shopBrief = restaurants.map((r, i) => ({
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
    "你是「今天吃这桌」聚餐选店点菜专家（面向支付宝生活消费场景）。",
    "严格遵守以下事实底线：",
    "1. 只围绕传入的真实高德餐厅列表作答，绝不改名或编造不存在的店。",
    "2. 严禁虚构某店具体的实时团购套餐精确标价（例如严禁凭空编造“该店现有298元4人餐”）；在 groupBuyStrategy 中，只给出该菜系/人均下「该优先搜代金券还是多人套餐、怎么叠加单点最省」的实操策略，并引导用卡片上的实时查团购与比价工具核算。",
    "3. 每道菜的 estPrice 必须诚实参考该店 realAvgCostPerPerson（高德人均）与聚餐人数做合理估算，所有菜品 estPrice 之和应接近该店 estimatedTotal（允许 ±15%）。",
    "4. 必须严格避开用户忌口，菜品数量严格遵循建议配比，杜绝浪费。",
    "5. 只输出合法 JSON，不要输出任何额外说明文字。",
  ].join("\n");

  const userPrompt = JSON.stringify(
    {
      task: "请为以下真实餐厅分别生成详细的选店理由、按人数配菜清单、参考预算与团购省钱策略",
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
        overallAdvice: "一句话横向总结这3家店怎么选（例如偏稳妥选A、重氛围选B、高性价比选C）",
        plans: [
          {
            idx: 0,
            highlightTag: "4-8字卖点标签，如：稳妥不踩雷/包间聚餐首选/性价比最高",
            whyChoose: "结合评分、距离、人均与聚餐场景的2句推荐理由",
            dishes: [
              {
                category: "凉菜/硬菜/素菜/汤主食",
                name: "具体菜名（贴合该店菜系且符合忌口）",
                reason: "10字以内推荐理由",
                estPrice: 68,
              },
            ],
            estimatedTotal: 480,
            groupBuyStrategy: "具体可执行的团购/代金券核销策略（绝不编造虚假实时套餐价格）",
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
      throw new Error("模型返回格式未解析成功");
    }

    const plans = restaurants.map((r, idx) => {
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
        highlightTag: String(matched.highlightTag || r.matchReasons?.[0] || "真实口碑优选"),
        whyChoose: String(matched.whyChoose || ""),
        dishes,
        estimatedTotal,
        estimatedPerCapita: Math.round(estimatedTotal / Math.max(req.headcount, 1)),
        groupBuyStrategy: String(matched.groupBuyStrategy || ""),
        avoidTip: String(matched.avoidTip || ""),
        isFallback: false,
      };
    });

    return {
      overallAdvice: String(parsed.overallAdvice || "已从周边真实高德餐厅中精选 3 家不同风味备选，按上方横评可直接拍板。"),
      plans,
      poweredBy: "GLM-5.3-Flash + 高德实时数据",
    };
  } catch (err) {
    return {
      overallAdvice: "高德真实餐厅数据已加载（大模型响应波动，当前展示本地兜底配菜结构，可点击刷新重试 AI 精配）。",
      plans: restaurants.map((r) => buildFallbackPlan(r, req, quota)),
      poweredBy: "高德实时数据（AI 兜底）",
      warning: err?.message || "",
    };
  }
}

/**
 * 粘贴真实团购套餐/代金券/菜单文字，实算「团购+补菜 vs 纯单点」差价与份量
 */
export async function compareGroupBuyWithAI({ restaurant, req, estimatedTotal, pastedText }) {
  const systemPrompt = [
    "你是「今天吃这桌」团购比价精算助手。",
    "用户会把他在支付宝/口碑/美团/大众点评看到的真实团购套餐或代金券文案粘贴给你。",
    "你必须严格基于用户粘贴的真实文字和金额做计算，绝不编造文字里没有的优惠。",
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
