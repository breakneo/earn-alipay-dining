import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBudget,
  normalizeShopCount,
  normalizeRadius,
  formatDistance,
  computeDishQuota,
  selectTopRestaurants,
  selectTopThreeRestaurants,
  estimateMealBudget,
  calculateAaSplit,
  buildAbaoPrompt,
  buildAmapUrl,
  buildAlipaySearchScheme,
  buildInviteText,
  buildIcsCalendar,
  extractJsonPayload,
  buildFallbackPlan,
} from "../app/engine.js";
import { formatFriendlyNetworkError, generateDiningPlans } from "../app/api.js";

const SAMPLE_POIS = [
  {
    id: "p1",
    name: "老字号杭帮菜(黄龙店)",
    cuisine: "浙江菜",
    rawType: "餐饮服务;中餐厅;浙江菜",
    address: "西湖区学院路77号",
    city: "杭州市",
    district: "西湖区",
    location: "120.128,30.275",
    distance: 180,
    rating: 4.8,
    cost: 118,
    tel: "0571-88881111",
    openTime: "11:00-21:30",
  },
  {
    id: "p2",
    name: "余阿福牛肉火锅(黄龙店)",
    cuisine: "火锅店",
    rawType: "餐饮服务;中餐厅;火锅店",
    address: "曲荷巷42号",
    city: "杭州市",
    district: "西湖区",
    location: "120.129,30.276",
    distance: 90,
    rating: 4.7,
    cost: 105,
    tel: "0571-88882222",
    openTime: "11:00-22:00",
  },
  {
    id: "p3",
    name: "某高端黑珍珠法餐",
    cuisine: "法国菜品餐厅",
    rawType: "餐饮服务;外国餐厅;法国菜品餐厅",
    address: "曙光路120号",
    city: "杭州市",
    district: "西湖区",
    location: "120.135,30.271",
    distance: 900,
    rating: 4.9,
    cost: 680,
    tel: "",
    openTime: "17:30-22:00",
  },
  {
    id: "p4",
    name: "某奶茶果茶档口",
    cuisine: "冷饮店",
    rawType: "餐饮服务;冷饮店;奶茶店",
    address: "学院路79号",
    city: "杭州市",
    district: "西湖区",
    location: "120.128,30.275",
    distance: 30,
    rating: 4.9,
    cost: 18,
    tel: "",
    openTime: "10:00-22:00",
  },
  {
    id: "p5",
    name: "粤鲜楼茶餐厅(黄龙店)",
    cuisine: "广东菜",
    rawType: "餐饮服务;中餐厅;广东菜",
    address: "万塘路30号",
    city: "杭州市",
    district: "西湖区",
    location: "120.126,30.277",
    distance: 360,
    rating: 4.6,
    cost: 125,
    tel: "0571-88883333",
    openTime: "10:30-22:00",
  },
  {
    id: "p6",
    name: "老字号杭帮菜(文三路分店)",
    cuisine: "浙江菜",
    rawType: "餐饮服务;中餐厅;浙江菜",
    address: "文三路200号",
    city: "杭州市",
    district: "西湖区",
    location: "120.130,30.280",
    distance: 620,
    rating: 4.7,
    cost: 115,
    tel: "",
    openTime: "11:00-21:00",
  },
  {
    id: "p7",
    name: "鲜味小馆(西溪店)",
    cuisine: "海鲜酒楼",
    rawType: "餐饮服务;中餐厅;海鲜酒楼",
    address: "天目山路188号",
    city: "杭州市",
    district: "西湖区",
    location: "120.122,30.272",
    distance: 1350,
    rating: 4.6,
    cost: 132,
    tel: "",
    openTime: "11:00-21:30",
  },
];

test("normalizeBudget / normalizeShopCount / normalizeRadius / formatDistance 边界正确", () => {
  const per = normalizeBudget({ headcount: 5, budgetMode: "per_capita", budgetValue: 120 });
  assert.equal(per.perCapita, 120);
  assert.equal(per.totalBudget, 600);

  const tot = normalizeBudget({ headcount: 8, budgetMode: "total", budgetValue: 1200 });
  assert.equal(tot.perCapita, 150);
  assert.equal(tot.totalBudget, 1200);

  assert.equal(normalizeShopCount(0), 1);
  assert.equal(normalizeShopCount(15), 10);
  assert.equal(normalizeShopCount(5), 5);
  assert.equal(normalizeRadius(500), 500);
  assert.equal(normalizeRadius(9999), 5000);
  assert.equal(formatDistance(360), "360米");
  assert.equal(formatDistance(1500), "1.5公里");
});

test("computeDishQuota 按人数与聚餐场景输出合理防浪费菜量配比", () => {
  const q4 = computeDishQuota(4, "朋友小聚");
  assert.equal(q4.cold, 1);
  assert.equal(q4.hot, 2);
  assert.equal(q4.veg, 1);
  assert.equal(q4.totalDishes, 5);

  const q8 = computeDishQuota(8, "单位聚餐");
  assert.ok(q8.cold >= 2 && q8.hot >= 4 && q8.veg >= 2);
  assert.ok(q8.totalDishes >= 9 && q8.totalDishes <= 12);
});

test("selectTopRestaurants 支持自定义 1~10 家数量，过滤奶茶档口且避免同品牌重复", () => {
  const { picked: p3, backups: b3 } = selectTopThreeRestaurants(SAMPLE_POIS, {
    headcount: 4,
    perCapita: 120,
    scene: "朋友小聚",
    preferences: "不吃辣",
    radius: 2000,
  });
  assert.equal(p3.length, 3);
  const names3 = p3.map((r) => r.name);
  assert.ok(!names3.includes("某奶茶果茶档口"), "不应把奶茶档口当聚餐饭馆");
  assert.ok(!names3.includes("某高端黑珍珠法餐"), "人均680严重超出120预算应排在后位");
  assert.equal(names3.filter((n) => n.startsWith("老字号杭帮菜")).length, 1);
  assert.ok(b3.length >= 1);

  const { picked: p5 } = selectTopRestaurants(
    SAMPLE_POIS,
    { headcount: 4, perCapita: 120, scene: "朋友小聚", radius: 2000 },
    5
  );
  assert.equal(p5.length, 5);
});

test("estimateMealBudget 计算预计总价区间与预算对比状态", () => {
  const est = estimateMealBudget({
    restaurantCost: 110,
    headcount: 4,
    targetPerCapita: 120,
  });
  assert.equal(est.estimatedPerCapita, 110);
  assert.equal(est.estimatedTotal, 440);
  assert.equal(est.budgetStatus, "within");
  assert.ok(est.rangeLow < est.estimatedTotal && est.rangeHigh > est.estimatedTotal);
});

test("calculateAaSplit 支持均摊与区分酒水分摊", () => {
  const even = calculateAaSplit({ totalAmount: 486, headcount: 4 });
  assert.equal(even.perPerson, 121.5);
  assert.equal(even.drinkersCount, 0);

  const withDrinks = calculateAaSplit({
    totalAmount: 600,
    headcount: 4,
    drinkTotal: 120,
    drinkersCount: 2,
  });
  assert.equal(withDrinks.foodPerPerson, 120);
  assert.equal(withDrinks.drinkerPerPerson, 180);
  assert.equal(withDrinks.nonDrinkerPerPerson, 120);
});

test("buildAbaoPrompt 不含竞品字样，buildInviteText 简洁不含点菜与预计花销", () => {
  const r = SAMPLE_POIS[0];
  const prompt = buildAbaoPrompt(r, 4, 120);
  assert.ok(prompt.includes(r.name) && prompt.includes("支付宝") && prompt.includes("口碑") && prompt.includes("4人"));
  assert.ok(!prompt.includes("点评") && !prompt.includes("美团"));

  const url = buildAmapUrl(r);
  assert.ok(url.startsWith("https://uri.amap.com/marker?") && url.includes("120.128,30.275"));

  const alipayUrl = buildAlipaySearchScheme(r);
  assert.ok(alipayUrl.startsWith("alipays://platformapi/startapp?appId=20001003&keyword="));

  const invite = buildInviteText({ restaurant: r, headcount: 4, scene: "朋友小聚" });
  assert.ok(invite.includes(r.name) && invite.includes("高德导航"));
  assert.ok(!invite.includes("参考点菜") && !invite.includes("预计花销"), "约饭通知不应包含参考点菜与预计花销");

  const ics = buildIcsCalendar({
    restaurant: r,
    headcount: 4,
    dateTimeIso: "2026-12-01T18:30:00+08:00",
  });
  assert.ok(ics.includes("BEGIN:VCALENDAR") && ics.includes("今天吃这桌") && ics.includes(r.name));
});

test("extractJsonPayload 容错提取模型返回的 Markdown JSON 代码块", () => {
  const raw = '下面是推荐结果：\n```json\n{"summary":"ok","plans":[1,2,3]}\n```\n祝用餐愉快';
  const parsed = extractJsonPayload(raw);
  assert.deepEqual(parsed, { summary: "ok", plans: [1, 2, 3] });
});

test("formatFriendlyNetworkError 拦截英文 Failed to fetch 与超时并转为清晰中文提示", () => {
  const e1 = formatFriendlyNetworkError(new TypeError("Failed to fetch"), "查询周边饭馆");
  assert.ok(!e1.includes("Failed to fetch") && e1.includes("查询周边饭馆") && e1.includes("网络"));

  const e2 = formatFriendlyNetworkError(new TypeError("Load failed"), "智能配菜");
  assert.ok(!e2.includes("Load failed") && e2.includes("智能配菜"));

  const abortErr = new Error("Aborted");
  abortErr.name = "AbortError";
  const e3 = formatFriendlyNetworkError(abortErr, "查询周边饭馆");
  assert.ok(e3.includes("超时") && e3.includes("重试"));
});

test("buildFallbackPlan 融合高德真实招牌标签，且支持 10 家边界去重挑选", () => {
  const manyPois = Array.from({ length: 14 }, (_, i) => ({
    id: `m${i}`,
    name: `测试餐厅${i + 1}`,
    cuisine: i % 2 === 0 ? "浙江菜" : "广东菜",
    rawType: "餐饮服务;中餐厅;浙江菜",
    address: `测试路${i + 1}号`,
    location: "120.128,30.275",
    distance: 100 + i * 120,
    rating: 4.5 + (i % 4) * 0.1,
    cost: 95 + i * 5,
    tag: "龙井虾仁,东坡肉,西湖醋鱼",
  }));
  const { picked, backups } = selectTopRestaurants(
    manyPois,
    { headcount: 6, perCapita: 120, scene: "朋友小聚", radius: 3000 },
    10
  );
  assert.equal(picked.length, 10);
  assert.equal(backups.length, 4);

  const q = computeDishQuota(4, "朋友小聚");
  const fb = buildFallbackPlan(manyPois[0], { headcount: 4, perCapita: 120, scene: "朋友小聚", preferences: "不吃辣" }, q);
  assert.equal(fb.isFallback, true);
  assert.ok(fb.dishes.some((d) => d.name.includes("龙井虾仁")), "兜底菜单应利用高德真实招牌标签");
});

test("generateDiningPlans 拿到一家餐厅配菜即立刻回调 onShopReady，不等待全部结束", async () => {
  const originalFetch = globalThis.fetch;
  const delays = [120, 20, 60];
  let callIdx = 0;
  globalThis.fetch = async () => {
    const myIdx = callIdx++;
    await new Promise((r) => setTimeout(r, delays[myIdx] || 20));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                highlightTag: `卖点${myIdx}`,
                whyChoose: "味道稳妥",
                dishes: [
                  { category: "凉菜", name: `水晶肴肉${myIdx}`, reason: "开胃", estPrice: 48 },
                  { category: "硬菜", name: `龙井虾仁${myIdx}`, reason: "必点", estPrice: 128 },
                  { category: "素菜", name: `上汤娃娃菜${myIdx}`, reason: "解腻", estPrice: 38 },
                ],
                groupBuyStrategy: "先看口碑代金券",
                avoidTip: "别点太多",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  try {
    const arrivals = [];
    const req = { location: "黄龙", headcount: 4, perCapita: 120, totalBudget: 480, scene: "朋友小聚", preferences: "" };
    const quota = computeDishQuota(4, "朋友小聚");
    const res = await generateDiningPlans({
      anchor: { name: "黄龙" },
      restaurants: SAMPLE_POIS.slice(0, 3),
      req,
      quota,
      onShopReady: ({ idx, completed, total }) => arrivals.push({ idx, completed, total }),
    });
    assert.equal(arrivals.length, 3);
    assert.deepEqual(
      arrivals.map((a) => a.completed),
      [1, 2, 3]
    );
    assert.equal(arrivals[0].idx, 1, "最先完成的第2家店应最先触发渲染回调");
    assert.equal(res.plans.filter((p) => !p.isFallback).length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("单位聚餐/高预算场景严禁混入咖啡厅/哈根达斯/酒店本体，且优先匹配预算 75%~105% 品质档位", () => {
  const guomaoPois = [
    { id: "g1", name: "Peet's皮爷咖啡(国贸商城店)", cuisine: "咖啡厅", rawType: "餐饮服务;咖啡厅;咖啡厅", rating: 4.8, cost: 39, distance: 37 },
    { id: "g2", name: "哈根达斯(国贸商城店)", cuisine: "甜品店", rawType: "餐饮服务;甜品店;甜品店", rating: 4.6, cost: 53, distance: 119 },
    { id: "g3", name: "北京中国大饭店", cuisine: "五星级宾馆", rawType: "住宿服务;宾馆酒店;五星级宾馆|餐饮服务;餐饮相关场所;餐饮相关", rating: 4.7, cost: null, distance: 40 },
    { id: "g4", name: "赛百味(国贸店)", cuisine: "快餐厅", rawType: "餐饮服务;快餐厅;快餐厅", rating: 4.5, cost: 25, distance: 123 },
    { id: "g5", name: "南门小馆(国贸商城店)", cuisine: "中餐厅", rawType: "餐饮服务;中餐厅;中餐厅", rating: 4.7, cost: 67, distance: 80 },
    { id: "g6", name: "羲和雅苑烤鸭坊(国贸商城店)", cuisine: "北京菜", rawType: "餐饮服务;中餐厅;北京菜", rating: 4.6, cost: 145, distance: 180 },
    { id: "g7", name: "京雅堂(国贸店)", cuisine: "中餐厅", rawType: "餐饮服务;中餐厅;中餐厅", rating: 4.6, cost: 172, distance: 260 },
    { id: "g8", name: "粤菜品质酒楼(国贸店)", cuisine: "广东菜", rawType: "餐饮服务;中餐厅;广东菜", rating: 4.5, cost: 162, distance: 310 },
    { id: "g9", name: "GIADA Garden", cuisine: "西餐厅", rawType: "餐饮服务;外国餐厅;西餐厅", rating: 4.6, cost: 1401, distance: 71 },
  ];

  // 即使请求 10 家超过合格正餐数，也绝不能放回咖啡厅/哈根达斯/酒店本体
  const { picked } = selectTopRestaurants(
    guomaoPois,
    { headcount: 8, perCapita: 175, scene: "单位聚餐", preferences: "清淡少油、要包间", radius: 2000 },
    10
  );
  const names = picked.map((p) => p.name);
  assert.ok(!names.some((n) => /咖啡|哈根达斯|中国大饭店|赛百味/.test(n)), `不应混入非正餐/快餐，实际：${names.join(",")}`);

  // 前 3 名必须全部是贴合人均 175 品质档位（145/162/172）的正餐，压过不到预算一半的 67 元简餐与 1401 元超标店
  const top3 = names.slice(0, 3);
  assert.ok(top3.includes("羲和雅苑烤鸭坊(国贸商城店)"));
  assert.ok(top3.includes("京雅堂(国贸店)"));
  assert.ok(top3.includes("粤菜品质酒楼(国贸店)"));
  assert.ok(!top3.includes("南门小馆(国贸商城店)"), "不到预算一半(¥67/¥175)的店不应排进前3");
  assert.ok(!top3.includes("GIADA Garden"), "严重超预算(¥1401/¥175)的店不应排进前3");
});

test("兜底菜单全部为具体独立菜名（零泛称/零×2合并价/零重复菜名）", () => {
  const shop = {
    id: "sh1",
    name: "逸品淮扬(白玉兰店)",
    cuisine: "中餐厅",
    rawType: "餐饮服务;中餐厅;江苏菜",
    address: "白玉兰广场",
    rating: 4.6,
    cost: 180,
    tag: "清炖狮子头,牛肉,豆腐",
  };
  const req = { headcount: 6, perCapita: 200, totalBudget: 1200, scene: "商务宴请", preferences: "江浙菜、不吃辣" };
  const quota = computeDishQuota(6, "商务宴请");
  const fb = buildFallbackPlan(shop, req, quota);
  assert.ok(fb.dishes.length >= 6);
  const seenNames = new Set();
  for (const d of fb.dishes) {
    assert.ok(!/爽口凉菜|招牌主菜|当季时蔬|例汤或特色主食|×\d|门店招牌/.test(d.name), `不应出现模糊占位菜名：${d.name}`);
    assert.ok(d.estPrice >= 20 && d.estPrice <= 350, `单道菜价应合理：${d.name} ¥${d.estPrice}`);
    assert.ok(!seenNames.has(d.name), `兜底菜单不应重复出现同道菜：${d.name}`);
    seenNames.add(d.name);
  }
});
