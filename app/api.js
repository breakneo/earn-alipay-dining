/**
 * 「今天吃这桌」后端通信层
 * - 同域部署（腾讯云 EdgeOne 自定义域名 / 边缘函数）自动直连 /api/poi 与 /api/chat（零跨域）
 * - 手机弱网加固：每次请求自带超时控制、指数退避自动重连与 POST→GET 降级，绝不裸抛英文 Failed to fetch
 * - 逐店并发流式回调：拿到一家店的配菜方案立即回调渲染一家，无需干等全部餐厅返回
 */

import { extractJsonPayload, buildFallbackPlan, estimateMealBudget } from "./engine.js";

const FALLBACK_ORIGIN = "https://eat.breakneo.dpdns.org";

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
  return { poi: `${FALLBACK_ORIGIN}/api/poi`, chat: `${FALLBACK_ORIGIN}/api/chat` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatFriendlyNetworkError(err, sceneLabel = "网络请求") {
  const raw = String(err?.message || "");
  if (err?.name === "AbortError" || /timeout|timed out|aborted/i.test(raw)) {
    return `${sceneLabel}超时，当前手机网络可能存在抖动，请点击重试`;
  }
  if (/failed to fetch|load failed|networkerror|network request failed|fetch/i.test(raw)) {
    return `${sceneLabel}连接中断（已自动重连仍未成功），请检查当前 Wi-Fi / 4G/5G 网络或刷新页面后重试`;
  }
  return raw || `${sceneLabel}失败，请稍后重试`;
}

/**
 * 带超时与自动重试的弱网健壮 JSON 请求
 */
async function fetchJsonResilient(
  url,
  options,
  { timeoutMs = 12000, retries = 1, altRequest = null, signal = null, sceneLabel = "请求" } = {}
) {
  let lastErr = null;
  let lastDiag = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      const abortErr = new Error("请求已取消");
      abortErr.name = "UserAbortError";
      throw abortErr;
    }

    const useAlt = attempt > 0 && typeof altRequest === "function";
    const built = useAlt ? altRequest(attempt) : { url, init: options };
    const reqUrl = built.url;
    const reqInit = { ...built.init, cache: "no-store" };

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    const t0 = Date.now();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(reqUrl, { ...reqInit, signal: controller.signal });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        return data;
      }
      const err = new Error(data.error || `${sceneLabel}繁忙（HTTP ${resp.status}）`);
      err.status = resp.status;
      lastDiag = `${reqInit.method || "GET"} ${reqUrl.split("?")[0]} · HTTP ${resp.status} · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
      // 4xx 客户端业务错误直接返回，无需重试
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
        err.diag = lastDiag;
        throw err;
      }
      lastErr = err;
    } catch (err) {
      if (signal?.aborted) {
        const abortErr = new Error("请求已取消");
        abortErr.name = "UserAbortError";
        throw abortErr;
      }
      if (err?.status >= 400 && err?.status < 500 && err?.status !== 408 && err?.status !== 429) {
        throw err;
      }
      lastDiag = `${reqInit.method || "GET"} ${reqUrl.split("?")[0]} · ${err?.name || "Error"} · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
      lastErr = err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }

    if (attempt < retries) {
      await sleep(400 * (attempt + 1));
    }
  }
  const finalErr = new Error(formatFriendlyNetworkError(lastErr, sceneLabel));
  const host = typeof window !== "undefined" ? window.location.host : "node";
  finalErr.diag = `${host} · ${lastDiag}`;
  throw finalErr;
}

/**
 * 周边真实饭馆查询：优先走简单 GET（零 CORS 预检、手机浏览器/支付宝内嵌页最稳、可命中 120s 边缘缓存），失败自动切 POST 重试
 */
export async function fetchRealRestaurants({ location, city = "", cuisine = "", radius = 2000, count = 3, signal = null }) {
  const { poi } = getEndpoints();
  const qs = new URLSearchParams({
    location,
    city,
    cuisine,
    radius: String(radius),
    count: String(count),
  });
  return fetchJsonResilient(
    `${poi}?${qs.toString()}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
    {
      timeoutMs: 12000,
      retries: 1,
      signal,
      sceneLabel: "查询周边饭馆",
      altRequest: () => ({
        url: poi,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ location, city, cuisine, radius, count }),
        },
      }),
    }
  );
}

async function callChat(messages, maxTokens = 620, { signal = null, retries = 1 } = {}) {
  const { chat } = getEndpoints();
  const data = await fetchJsonResilient(
    chat,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        messages,
        max_tokens: maxTokens,
        temperature: 0.25,
      }),
    },
    {
      timeoutMs: 14500,
      retries,
      signal,
      sceneLabel: "智能配菜",
    }
  );
  const content = data?.choices?.[0]?.message?.content || "";
  if (!content.trim()) {
    throw new Error("未能获取配菜建议，请稍后重试");
  }
  return content;
}

/**
 * 为单家真实餐厅生成精准配菜、参考预算（不含酒水）与支付宝/口碑团购省钱策略
 * 紧凑 Schema + 620 token 上限，实测单店 4~8 秒稳定返回、规避边缘函数 15s 超时
 */
export async function generateSingleShopPlan({ anchor, restaurant, req, quota, signal = null }) {
  const targetDishCount = Math.min(Math.max(quota.totalDishes, 4), 7);
  const systemPrompt = [
    "你是「今天吃这桌」聚餐点菜专家（支付宝口碑与高德生态）。",
    "要求：1) 围绕传入的真实餐厅与特色标签推荐具体常见招牌菜，严禁写「招牌主菜×2」这类泛泛占位词；",
    "2) 严格避开用户忌口，总菜数控制在目标数量内，单价估算不含酒水并贴近人均×人数；",
    "3) 严禁编造团购精确假价，仅给支付宝口碑/高德核销策略，不提非支付宝系第三方平台；",
    "4) 仅输出合法紧凑 JSON，无多余说明。",
  ].join("\n");

  const userPrompt = JSON.stringify({
    loc: anchor?.name || req.location,
    people: req.headcount,
    scene: req.scene,
    perCapita: req.perCapita,
    totalNoDrinks: req.totalBudget,
    pref: req.preferences || "无",
    quota: `${quota.formulaText}（输出${targetDishCount}道代表菜）`,
    shop: {
      name: restaurant.name,
      cuisine: restaurant.cuisine,
      rating: restaurant.rating || "暂无",
      cost: restaurant.cost || req.perCapita,
      distM: restaurant.distance ?? "未知",
      tags: (restaurant.tag || "").slice(0, 60),
    },
    schema: {
      highlightTag: "4-6字卖点",
      whyChoose: "1-2句简明推荐理由",
      dishes: [{ category: "凉菜/硬菜/素菜/汤主食", name: "具体菜名", reason: "6字内理由", estPrice: 58 }],
      groupBuyStrategy: "1-2句支付宝口碑/高德省钱策略",
      avoidTip: "1句避坑提醒",
    },
  });

  try {
    const raw = await callChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      620,
      { signal, retries: 1 }
    );
    const parsed = extractJsonPayload(raw);
    if (!parsed || !Array.isArray(parsed.dishes) || parsed.dishes.length === 0) {
      throw new Error("格式解析失败");
    }
    const dishes = parsed.dishes.slice(0, 8).map((d) => ({
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
  } catch (err) {
    if (err?.name === "UserAbortError" || signal?.aborted) {
      throw err;
    }
    return buildFallbackPlan(restaurant, req, quota);
  }
}

export function buildOverallAdvice(plans, restaurants, req) {
  const ready = plans.filter(Boolean);
  const summaryParts = ready
    .slice(0, 3)
    .map((p) => `${p.highlightTag}选「${p.restaurantName.replace(/[\(（].*$/, "")}」`);
  if (summaryParts.length >= 2) {
    return `${summaryParts.join("，")}；共甄选 ${restaurants.length} 家贴合 ${req.headcount} 人预算（不含酒水）的饭馆。`;
  }
  return `已为你甄选 ${restaurants.length} 家贴合 ${req.headcount} 人「${req.scene}」预算（不含酒水）的饭馆。`;
}

/**
 * 逐店并发池：最多 3 路稳定并发，每拿到一家餐厅的配菜方案立刻触发 onShopReady 回调渲染
 */
export async function generateDiningPlans({
  anchor,
  restaurants,
  req,
  quota,
  onShopReady = null,
  signal = null,
}) {
  const plans = new Array(restaurants.length).fill(null);
  const concurrency = Math.min(3, restaurants.length);
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (cursor < restaurants.length) {
      if (signal?.aborted) return;
      const idx = cursor++;
      const plan = await generateSingleShopPlan({
        anchor,
        restaurant: restaurants[idx],
        req,
        quota,
        signal,
      });
      if (signal?.aborted) return;
      plans[idx] = plan;
      completed++;
      if (typeof onShopReady === "function") {
        onShopReady({
          idx,
          plan,
          completed,
          total: restaurants.length,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    overallAdvice: buildOverallAdvice(plans, restaurants, req),
    plans,
  };
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
    750,
    { retries: 1 }
  );
  const parsed = extractJsonPayload(raw);
  if (!parsed) {
    throw new Error("团购比价结果解析失败，请检查粘贴内容后重试");
  }
  return parsed;
}
