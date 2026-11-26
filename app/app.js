import {
  normalizeBudget,
  normalizeShopCount,
  normalizeRadius,
  formatDistance,
  computeDishQuota,
  selectTopRestaurants,
  estimateMealBudget,
  calculateAaSplit,
  buildAbaoPrompt,
  buildAmapUrl,
  buildInviteText,
  buildIcsCalendar,
} from "./engine.js";
import {
  fetchRealRestaurants,
  generateDiningPlans,
  compareGroupBuyWithAI,
} from "./api.js";

const PRESETS = {
  hz: { loc: "杭州黄龙万科中心", radius: "2000", count: "3", people: "4", mode: "per_capita", budget: "120", scene: "朋友小聚", pref: "不吃辣" },
  bj: { loc: "北京国贸", radius: "2000", count: "3", people: "8", mode: "total", budget: "1400", scene: "单位聚餐", pref: "清淡少油、要包间" },
  sh: { loc: "上海陆家嘴", radius: "2000", count: "3", people: "6", mode: "per_capita", budget: "200", scene: "商务宴请", pref: "江浙菜、不吃辣" },
  cd: { loc: "成都太古里", radius: "1000", count: "3", people: "5", mode: "per_capita", budget: "100", scene: "朋友小聚", pref: "想吃火锅" },
};

const state = {
  budgetMode: "per_capita",
  req: null,
  quota: null,
  anchor: null,
  picked: [],
  backups: [],
  plans: [],
  overallAdvice: "",
  selectedIdx: -1,
};

const els = {
  presetSelect: document.getElementById("presetSelect"),
  form: document.getElementById("diningForm"),
  locationInput: document.getElementById("locationInput"),
  radiusSelect: document.getElementById("radiusSelect"),
  countSelect: document.getElementById("countSelect"),
  headcountInput: document.getElementById("headcountInput"),
  budgetLabel: document.getElementById("budgetLabel"),
  budgetInput: document.getElementById("budgetInput"),
  sceneSelect: document.getElementById("sceneSelect"),
  prefInput: document.getElementById("prefInput"),
  quotaPreview: document.getElementById("quotaPreview"),
  submitBtn: document.getElementById("submitBtn"),
  loadingSection: document.getElementById("loadingSection"),
  loadingTitle: document.getElementById("loadingTitle"),
  loadingSub: document.getElementById("loadingSub"),
  errorSection: document.getElementById("errorSection"),
  resultsSection: document.getElementById("resultsSection"),
  anchorMeta: document.getElementById("anchorMeta"),
  overallAdvice: document.getElementById("overallAdvice"),
  planMetaPills: document.getElementById("planMetaPills"),
  compareTbody: document.getElementById("compareTbody"),
  compareMobileList: document.getElementById("compareMobileList"),
  cardsGrid: document.getElementById("cardsGrid"),
  decisionPanel: document.getElementById("decisionPanel"),
  decisionTitle: document.getElementById("decisionTitle"),
  closeDecisionBtn: document.getElementById("closeDecisionBtn"),
  inviteTextarea: document.getElementById("inviteTextarea"),
  copyInviteBtn: document.getElementById("copyInviteBtn"),
  downloadIcsBtn: document.getElementById("downloadIcsBtn"),
  decisionAmapLink: document.getElementById("decisionAmapLink"),
  aaTotalInput: document.getElementById("aaTotalInput"),
  aaPeopleInput: document.getElementById("aaPeopleInput"),
  aaDrinkInput: document.getElementById("aaDrinkInput"),
  aaDrinkersInput: document.getElementById("aaDrinkersInput"),
  aaResultBox: document.getElementById("aaResultBox"),
  copyAaBtn: document.getElementById("copyAaBtn"),
  toast: document.getElementById("toast"),
};

let toastTimer = null;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

async function copyText(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    showToast(successMsg);
  }
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function updateQuotaPreview() {
  const b = normalizeBudget({
    headcount: els.headcountInput.value,
    budgetMode: state.budgetMode,
    budgetValue: els.budgetInput.value,
  });
  const count = normalizeShopCount(els.countSelect.value);
  const q = computeDishQuota(b.headcount, els.sceneSelect.value);
  els.quotaPreview.innerHTML = `配菜标准：<strong>${b.headcount}人 · ${escapeHtml(q.scene)}</strong>，建议 <strong>${escapeHtml(q.formulaText)}</strong>（目标总预算约 ¥${b.totalBudget}，人均 ¥${b.perCapita}）`;
  els.submitBtn.textContent = `帮我挑 ${count} 家并配菜`;
}

function syncTagChips() {
  const cur = els.prefInput.value
    .split(/[，,、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  document.querySelectorAll(".tag-chip").forEach((chip) => {
    chip.classList.toggle("active", cur.includes(chip.dataset.tag));
  });
}

function setBudgetMode(mode, preserveVal = false) {
  if (state.budgetMode === mode && !preserveVal) return;
  const n = Math.max(Number(els.headcountInput.value) || 4, 1);
  const cur = Number(els.budgetInput.value) || 120;
  state.budgetMode = mode;
  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.budgetMode === mode);
  });
  if (mode === "total") {
    els.budgetLabel.textContent = "本桌总预算";
    if (!preserveVal) els.budgetInput.value = String(Math.round(cur * n));
  } else {
    els.budgetLabel.textContent = "人均预算";
    if (!preserveVal) els.budgetInput.value = String(Math.max(Math.round(cur / n), 30));
  }
  updateQuotaPreview();
}

function extractCuisineKeyword(prefText = "") {
  const list = ["火锅", "江浙菜", "杭帮菜", "本帮菜", "粤菜", "川菜", "湘菜", "日料", "烤肉", "海鲜", "西餐", "烧烤", "泰国菜", "北京菜", "东北菜", "云南菜", "茶餐厅"];
  for (const kw of list) {
    if (prefText.includes(kw)) return kw;
  }
  return "";
}

function setLoading(isLoading, title = "", sub = "") {
  els.submitBtn.disabled = isLoading;
  if (isLoading) {
    els.loadingTitle.textContent = title;
    els.loadingSub.textContent = sub;
    els.loadingSection.classList.remove("hidden");
    els.errorSection.classList.add("hidden");
  } else {
    els.loadingSection.classList.add("hidden");
  }
}

function showError(msg) {
  els.errorSection.textContent = msg;
  els.errorSection.classList.remove("hidden");
}

function renderBudgetBadge(estimatedTotal, targetTotal) {
  const diff = estimatedTotal - targetTotal;
  if (diff <= 0) {
    return `<span class="badge badge-good">符合预算${diff <= -20 ? ` · 省约¥${Math.abs(diff)}` : ""}</span>`;
  }
  if (diff <= targetTotal * 0.15) {
    return `<span class="badge badge-warn">略超约 ¥${diff}</span>`;
  }
  return `<span class="badge badge-over">超预算约 ¥${diff}</span>`;
}

function renderResults() {
  if (!state.picked.length) return;
  els.resultsSection.classList.remove("hidden");

  const anchorLabel = [state.anchor?.city, state.anchor?.district, state.anchor?.name].filter(Boolean).join(" · ");
  const rangeLabel = formatDistance(state.req.radius);
  els.anchorMeta.textContent = `${anchorLabel || state.req.location} · ${rangeLabel}内`;
  els.overallAdvice.textContent = state.overallAdvice;
  els.planMetaPills.innerHTML = [
    `<span class="meta-pill">精选 ${state.picked.length} 家</span>`,
    `<span class="meta-pill">${state.req.headcount}人 · ${escapeHtml(state.req.scene)}</span>`,
    `<span class="meta-pill">目标预算 ¥${state.req.totalBudget}（人均¥${state.req.perCapita}）</span>`,
    `<span class="meta-pill">${escapeHtml(state.quota.formulaText)}</span>`,
  ].join("");

  // 1. 桌面端横向对比表
  els.compareTbody.innerHTML = state.picked
    .map((shop, idx) => {
      const plan = state.plans[idx];
      const estTotal = plan?.estimatedTotal || estimateMealBudget({ restaurantCost: shop.cost, headcount: state.req.headcount, targetPerCapita: state.req.perCapita }).estimatedTotal;
      const estPer = Math.round(estTotal / state.req.headcount);
      return `
        <tr>
          <td><strong>${idx + 1}. ${escapeHtml(shop.name)}</strong><br><span style="color:#8c8378;font-size:12px;">${escapeHtml(shop.cuisine)}</span></td>
          <td>${shop.rating ? `⭐ ${shop.rating.toFixed(1)}` : "暂无评分"} / ${formatDistance(shop.distance)}</td>
          <td>${shop.cost ? `¥${Math.round(shop.cost)}/人` : "门店未标"}</td>
          <td><strong>¥${estTotal}</strong>（人均¥${estPer}）</td>
          <td>${renderBudgetBadge(estTotal, state.req.totalBudget)}</td>
          <td><button type="button" class="btn-outline btn-sm" data-scroll-card="${idx}">看菜单</button></td>
        </tr>
      `;
    })
    .join("");

  // 2. 手机端零横向滚条对比卡
  els.compareMobileList.innerHTML = state.picked
    .map((shop, idx) => {
      const plan = state.plans[idx];
      const estTotal = plan?.estimatedTotal || estimateMealBudget({ restaurantCost: shop.cost, headcount: state.req.headcount, targetPerCapita: state.req.perCapita }).estimatedTotal;
      const estPer = Math.round(estTotal / state.req.headcount);
      return `
        <div class="compare-m-item">
          <div class="compare-m-top">
            <div>
              <div class="compare-m-name">${idx + 1}. ${escapeHtml(shop.name)}</div>
              <div class="compare-m-sub">${escapeHtml(shop.cuisine)} · ${shop.rating ? `⭐ ${shop.rating.toFixed(1)}` : "暂无评分"} · 距 ${formatDistance(shop.distance)}</div>
            </div>
            ${renderBudgetBadge(estTotal, state.req.totalBudget)}
          </div>
          <div class="compare-m-bottom">
            <span>参考人均 ${shop.cost ? `¥${Math.round(shop.cost)}` : "未标"} · 本桌约 <strong>¥${estTotal}</strong>（¥${estPer}/人）</span>
            <button type="button" class="btn-outline btn-sm" data-scroll-card="${idx}">看菜单</button>
          </div>
        </div>
      `;
    })
    .join("");

  // 3. 卡片列数适配（1家居中、2家双列、3家及以上三列）
  els.cardsGrid.className = "cards-grid" + (state.picked.length === 1 ? " cols-1" : state.picked.length === 2 ? " cols-2" : "");

  // 4. 餐厅决策方案卡
  els.cardsGrid.innerHTML = state.picked
    .map((shop, idx) => {
      const plan = state.plans[idx];
      const estTotal = plan?.estimatedTotal || 0;
      const estPer = plan?.estimatedPerCapita || Math.round(estTotal / state.req.headcount);
      const amapUrl = buildAmapUrl(shop);
      const isSelected = state.selectedIdx === idx;
      const dishRows = (plan?.dishes || [])
        .map(
          (d) => `
          <li class="dish-item">
            <div>
              <span class="dish-cat">${escapeHtml(d.category)}</span>
              <strong>${escapeHtml(d.name)}</strong>
              <span class="dish-reason">${escapeHtml(d.reason)}</span>
            </div>
            <span class="dish-price">约¥${d.estPrice}</span>
          </li>
        `
        )
        .join("");

      return `
        <article class="shop-card ${isSelected ? "selected" : ""}" id="shop-card-${idx}">
          <div class="shop-top">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <span class="rank-tag">方案 ${idx + 1}</span>
              <span class="badge badge-accent">${escapeHtml(plan?.highlightTag || "口碑精选")}</span>
            </div>
            ${state.backups.length > 0 ? `<button type="button" class="btn-ghost btn-sm" data-swap-idx="${idx}" title="从附近候补餐厅中换一家">换一家</button>` : ""}
          </div>

          <div>
            <h3 class="shop-name">${escapeHtml(shop.name)}</h3>
            <div class="shop-facts">
              <span>${escapeHtml(shop.cuisine)}</span>
              <span>⭐ <strong>${shop.rating ? shop.rating.toFixed(1) : "暂无"}</strong></span>
              <span>参考人均 <strong>${shop.cost ? `¥${Math.round(shop.cost)}` : "按预算"}</strong></span>
              <span>距选定地点 ${formatDistance(shop.distance)}</span>
            </div>
            <p class="shop-address">地址：${escapeHtml(shop.address)}${shop.openTime ? ` · 营业 ${escapeHtml(shop.openTime)}` : ""}</p>
          </div>

          <div class="why-box">${escapeHtml(plan?.whyChoose || "")}</div>

          <div>
            <div class="block-title">
              <span>按 ${state.req.headcount} 人配好这一桌</span>
              <span style="font-size:11px;font-weight:400;color:#8c8378;">估价供参考</span>
            </div>
            <ul class="dish-list">${dishRows}</ul>
          </div>

          <div class="budget-strip">
            <div>
              <div style="font-size:12px;color:#8c8378;">本桌参考总价 / 折合人均</div>
              <strong>约 ¥${estTotal}</strong> <span style="color:#5c544c;">（¥${estPer}/人）</span>
            </div>
            ${renderBudgetBadge(estTotal, state.req.totalBudget)}
          </div>

          <div class="strategy-box">
            <strong>支付宝 / 口碑团购省钱建议</strong>
            <p>${escapeHtml(plan?.groupBuyStrategy || "")}</p>
          </div>

          ${plan?.avoidTip ? `<p class="avoid-note">点菜提醒：${escapeHtml(plan.avoidTip)}</p>` : ""}

          <div class="card-actions">
            <button type="button" class="btn-alipay btn-sm" data-abao-idx="${idx}">复制问阿宝查团购</button>
            <a class="btn-outline btn-sm" href="${amapUrl}" target="_blank" rel="noopener noreferrer">高德地图直达</a>
            <button type="button" class="btn-outline btn-sm full-span" data-toggle-gb="${idx}">
              粘贴支付宝/口碑团购文案，帮我算差价
            </button>
            <button type="button" class="btn-primary btn-sm full-span" data-pick-idx="${idx}">
              就定这家 · 生成约饭通知
            </button>
          </div>

          <div class="gb-drawer hidden" id="gb-drawer-${idx}">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <span style="font-size:12px;font-weight:600;color:#5c544c;">贴入支付宝、口碑或高德看到的团购/代金券文案</span>
              <button type="button" class="btn-ghost btn-sm" data-fill-sample-gb="${idx}" style="font-size:11.5px;padding:3px 7px;white-space:nowrap;">填入示例</button>
            </div>
            <textarea id="gb-input-${idx}" rows="3" placeholder="例如：288元4人餐，含招牌主菜2份+凉菜1份+时蔬1份+主食，周末通用，可叠加口碑79代100代金券"></textarea>
            <button type="button" class="btn-primary btn-sm" data-run-gb="${idx}">智能实算团购 vs 单点</button>
            <div class="gb-result hidden" id="gb-result-${idx}"></div>
          </div>
        </article>
      `;
    })
    .join("");
}

function openDecisionPanel(idx) {
  state.selectedIdx = idx;
  const shop = state.picked[idx];
  const plan = state.plans[idx];
  if (!shop || !plan) return;

  renderResults();
  els.decisionTitle.textContent = `就定这家：${shop.name}`;
  els.inviteTextarea.value = buildInviteText({
    restaurant: shop,
    headcount: state.req.headcount,
    scene: state.req.scene,
  });
  els.decisionAmapLink.href = buildAmapUrl(shop);
  els.aaTotalInput.value = String(plan.estimatedTotal);
  els.aaPeopleInput.value = String(state.req.headcount);
  els.aaDrinkInput.value = "0";
  els.aaDrinkersInput.value = "0";
  refreshAaBox();

  els.decisionPanel.classList.remove("hidden");
  els.decisionPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function refreshAaBox() {
  const res = calculateAaSplit({
    totalAmount: els.aaTotalInput.value,
    headcount: els.aaPeopleInput.value,
    drinkTotal: els.aaDrinkInput.value,
    drinkersCount: els.aaDrinkersInput.value,
  });
  els.aaResultBox.textContent = res.summaryText;
}

async function handleSwapShop(idx) {
  if (!state.backups.length) {
    showToast("该范围内没有更多候补饭馆了，可适当扩大搜索范围");
    return;
  }
  const replacement = state.backups.shift();
  state.picked[idx] = replacement;
  if (state.selectedIdx === idx) {
    state.selectedIdx = -1;
    els.decisionPanel.classList.add("hidden");
  }
  showToast(`已切换为「${replacement.name}」，正在重新配菜…`);

  const oneRes = await generateDiningPlans({
    anchor: state.anchor,
    restaurants: [replacement],
    req: state.req,
    quota: state.quota,
  });
  state.plans[idx] = oneRes.plans[0];
  renderResults();
  showToast(`「${replacement.name}」点菜与预算方案已更新`);
}

async function handleRunGroupBuy(idx, btn) {
  const input = document.getElementById(`gb-input-${idx}`);
  const out = document.getElementById(`gb-result-${idx}`);
  const pasted = (input?.value || "").trim();
  if (pasted.length < 6) {
    showToast("请先粘贴支付宝/口碑团购套餐或代金券文案");
    return;
  }
  btn.disabled = true;
  btn.textContent = "正在比价精算…";
  try {
    const res = await compareGroupBuyWithAI({
      restaurant: state.picked[idx],
      req: state.req,
      estimatedTotal: state.plans[idx]?.estimatedTotal || state.req.totalBudget,
      pastedText: pasted,
    });
    const addons = Array.isArray(res.addonSuggestions) ? res.addonSuggestions.join("、") : String(res.addonSuggestions || "无需补菜");
    const savings = Number(res.savingsVsAlaCarte);
    const saveLine = Number.isFinite(savings)
      ? savings >= 0
        ? `比纯单点预计省 ¥${Math.round(savings)}`
        : `比纯单点贵约 ¥${Math.abs(Math.round(savings))}`
      : "";
    out.innerHTML = `
      <strong>结论：${escapeHtml(res.verdict || "核算完成")}</strong>${saveLine ? `（${escapeHtml(saveLine)}）` : ""}
      <ul>
        <li><strong>份量评估：</strong>${escapeHtml(res.portionCheck || "")}</li>
        <li><strong>忌口检查：</strong>${escapeHtml(res.dietaryCheck || "无明显冲突")}</li>
        <li><strong>补菜建议：</strong>${escapeHtml(addons)}${res.addonCost ? `（补菜约 ¥${res.addonCost}）` : ""}</li>
        <li><strong>预计总实付：</strong>¥${escapeHtml(String(res.totalWithGroupBuy || res.groupBuyPrice || "见文案"))} · ${escapeHtml(res.actionTip || "")}</li>
      </ul>
    `;
    out.classList.remove("hidden");
  } catch (err) {
    showToast(err?.message || "团购比价失败，请稍后重试");
  } finally {
    btn.disabled = false;
    btn.textContent = "智能实算团购 vs 单点";
  }
}

async function handleSearchSubmit(evt) {
  evt.preventDefault();
  const location = els.locationInput.value.trim();
  if (!location) {
    showToast("请先输入聚餐地点");
    return;
  }

  const budget = normalizeBudget({
    headcount: els.headcountInput.value,
    budgetMode: state.budgetMode,
    budgetValue: els.budgetInput.value,
  });
  const count = normalizeShopCount(els.countSelect.value);
  const radius = normalizeRadius(els.radiusSelect.value);
  const scene = els.sceneSelect.value;
  const preferences = els.prefInput.value.trim();
  const quota = computeDishQuota(budget.headcount, scene);
  const req = { location, ...budget, count, radius, scene, preferences };

  state.req = req;
  state.quota = quota;
  state.selectedIdx = -1;
  els.decisionPanel.classList.add("hidden");

  try {
    setLoading(true, `正在检索「${location}」${formatDistance(radius)}内合适饭馆…`, "按口碑、距离与预算综合筛选");
    const poiData = await fetchRealRestaurants({
      location,
      cuisine: extractCuisineKeyword(preferences),
      radius,
    });
    if (!poiData.restaurants || poiData.restaurants.length === 0) {
      throw new Error(`「${location}」${formatDistance(radius)}内暂未找到合适餐厅，建议扩大搜索范围或换个附近商圈名`);
    }

    const { picked, backups } = selectTopRestaurants(poiData.restaurants, req, count);
    state.anchor = poiData.anchor;
    state.picked = picked;
    state.backups = backups;

    setLoading(
      true,
      `已选出 ${picked.length} 家候选饭馆，正在按 ${req.headcount} 人配菜算账…`,
      picked.slice(0, 4).map((p) => p.name).join(" · ") + (picked.length > 4 ? ` 等 ${picked.length} 家` : "")
    );

    const aiRes = await generateDiningPlans({
      anchor: state.anchor,
      restaurants: state.picked,
      req,
      quota,
    });
    state.plans = aiRes.plans;
    state.overallAdvice = aiRes.overallAdvice;

    setLoading(false);
    renderResults();
    els.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setLoading(false);
    showError(err?.message || "请求失败，请检查网络后重试");
  }
}

function handleScrollToCard(e) {
  const btn = e.target.closest("[data-scroll-card]");
  if (!btn) return;
  const card = document.getElementById(`shop-card-${btn.dataset.scrollCard}`);
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function initEvents() {
  els.presetSelect.addEventListener("change", () => {
    const p = PRESETS[els.presetSelect.value];
    if (!p) return;
    els.locationInput.value = p.loc;
    els.radiusSelect.value = p.radius;
    els.countSelect.value = p.count;
    els.headcountInput.value = p.people;
    setBudgetMode(p.mode, true);
    els.budgetInput.value = p.budget;
    els.sceneSelect.value = p.scene;
    els.prefInput.value = p.pref;
    syncTagChips();
    updateQuotaPreview();
    showToast("已填入常见聚餐场景，点击下方按钮即可开始挑店");
  });

  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => setBudgetMode(btn.dataset.budgetMode));
  });

  document.querySelectorAll(".tag-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const tag = chip.dataset.tag;
      const cur = els.prefInput.value
        .split(/[，,、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const exists = cur.includes(tag);
      const next = exists ? cur.filter((t) => t !== tag) : [...cur, tag];
      chip.classList.toggle("active", !exists);
      els.prefInput.value = next.join("、");
    });
  });

  els.prefInput.addEventListener("input", syncTagChips);

  [els.headcountInput, els.budgetInput, els.sceneSelect, els.countSelect, els.radiusSelect].forEach((el) => {
    el.addEventListener("input", updateQuotaPreview);
    el.addEventListener("change", updateQuotaPreview);
  });

  els.form.addEventListener("submit", handleSearchSubmit);

  els.compareTbody.addEventListener("click", handleScrollToCard);
  els.compareMobileList.addEventListener("click", handleScrollToCard);

  els.cardsGrid.addEventListener("click", (e) => {
    const abaoBtn = e.target.closest("[data-abao-idx]");
    if (abaoBtn) {
      const idx = Number(abaoBtn.dataset.abaoIdx);
      const prompt = buildAbaoPrompt(state.picked[idx], state.req.headcount, state.req.perCapita);
      copyText(prompt, "已复制查团购指令，打开支付宝阿宝粘贴即可查该店实时团购");
      return;
    }

    const swapBtn = e.target.closest("[data-swap-idx]");
    if (swapBtn) {
      handleSwapShop(Number(swapBtn.dataset.swapIdx));
      return;
    }

    const gbToggle = e.target.closest("[data-toggle-gb]");
    if (gbToggle) {
      const drawer = document.getElementById(`gb-drawer-${gbToggle.dataset.toggleGb}`);
      drawer?.classList.toggle("hidden");
      return;
    }

    const sampleGb = e.target.closest("[data-fill-sample-gb]");
    if (sampleGb) {
      const idx = Number(sampleGb.dataset.fillSampleGb);
      const est = state.plans[idx]?.estimatedTotal || state.req.totalBudget;
      const pkgPrice = Math.round((est * 0.72) / 10) * 10;
      const input = document.getElementById(`gb-input-${idx}`);
      if (input) {
        input.value = `【示例口碑团购】${pkgPrice}元${state.req.headcount}人欢聚餐：含门店热销主菜2道 + 爽口凉菜1道 + 清炒时蔬1道 + 米饭/例汤；周末晚市可用，另支持支付宝口碑79代100代金券限用1张。`;
      }
      return;
    }

    const runGb = e.target.closest("[data-run-gb]");
    if (runGb) {
      handleRunGroupBuy(Number(runGb.dataset.runGb), runGb);
      return;
    }

    const pickBtn = e.target.closest("[data-pick-idx]");
    if (pickBtn) {
      openDecisionPanel(Number(pickBtn.dataset.pickIdx));
    }
  });

  els.closeDecisionBtn.addEventListener("click", () => els.decisionPanel.classList.add("hidden"));
  els.copyInviteBtn.addEventListener("click", () => copyText(els.inviteTextarea.value, "已复制约饭通知，可直接发群里"));
  els.downloadIcsBtn.addEventListener("click", () => {
    const shop = state.picked[state.selectedIdx];
    if (!shop) return;
    const ics = buildIcsCalendar({ restaurant: shop, headcount: state.req.headcount });
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `今天吃这桌-${shop.name}.ics`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("已导出 .ics 日历提醒文件");
  });

  [els.aaTotalInput, els.aaPeopleInput, els.aaDrinkInput, els.aaDrinkersInput].forEach((el) => {
    el.addEventListener("input", refreshAaBox);
  });
  els.copyAaBtn.addEventListener("click", () => copyText(els.aaResultBox.textContent, "已复制账单文案，可去支付宝发起群收款"));
}

updateQuotaPreview();
initEvents();
