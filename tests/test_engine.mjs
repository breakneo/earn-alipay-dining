import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBudget,
  computeDishQuota,
  selectTopThreeRestaurants,
  estimateMealBudget,
  calculateAaSplit,
  buildAbaoPrompt,
  buildAmapUrl,
  buildInviteText,
  buildIcsCalendar,
  extractJsonPayload,
} from "../app/engine.js";

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
];

test("normalizeBudget 正确换算人均与总预算", () => {
  const per = normalizeBudget({ headcount: 5, budgetMode: "per_capita", budgetValue: 120 });
  assert.equal(per.perCapita, 120);
  assert.equal(per.totalBudget, 600);

  const tot = normalizeBudget({ headcount: 8, budgetMode: "total", budgetValue: 1200 });
  assert.equal(tot.perCapita, 150);
  assert.equal(tot.totalBudget, 1200);
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

test("selectTopThreeRestaurants 过滤奶茶档口与严重超预算，且避免同品牌重复", () => {
  const { picked, backups } = selectTopThreeRestaurants(SAMPLE_POIS, {
    headcount: 4,
    perCapita: 120,
    scene: "朋友小聚",
    preferences: "不吃辣",
  });
  assert.equal(picked.length, 3);
  const names = picked.map((r) => r.name);
  assert.ok(!names.includes("某奶茶果茶档口"), "不应把奶茶档口当聚餐饭馆");
  assert.ok(!names.includes("某高端黑珍珠法餐"), "人均680严重超出120预算应排在后位");
  assert.equal(
    names.filter((n) => n.startsWith("老字号杭帮菜")).length,
    1,
    "同名品牌分店不应同时占据3家候选"
  );
  assert.ok(backups.length >= 1, "应保留可替换的真实备选店");
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

test("buildAbaoPrompt / buildAmapUrl / buildInviteText / buildIcsCalendar 产出完整真实工具文本", () => {
  const r = SAMPLE_POIS[0];
  const prompt = buildAbaoPrompt(r, 4, 120);
  assert.ok(prompt.includes(r.name) && prompt.includes("团购") && prompt.includes("4人"));

  const url = buildAmapUrl(r);
  assert.ok(url.startsWith("https://uri.amap.com/marker?"));
  assert.ok(url.includes("120.128,30.275"));

  const invite = buildInviteText({
    restaurant: r,
    headcount: 4,
    scene: "朋友小聚",
    dishes: ["龙井虾仁", "东坡肉", "清炒时蔬"],
    estimatedTotal: 460,
  });
  assert.ok(invite.includes(r.name) && invite.includes("龙井虾仁") && invite.includes("460"));

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
