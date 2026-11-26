/**
 * 「今天吃这桌」真实动态交互录屏 + 桌面/手机双端视觉自检脚本
 * - 启动独立无头 Chrome（不触碰主人任何浏览器窗口）
 * - 真实选择快捷试玩下拉、范围、数量与忌口并触发真实查询
 * - 录制 1080p 真机动态操作视频 + 截取桌面与手机（390x844）高清截图并严格校验手机端零横向滚动条
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(ROOT, "app");
const SUB_DIR = path.join(ROOT, "submission");
const OUT_MP4 = path.join(SUB_DIR, "demo_video.mp4");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function startStaticServer(preferredPort = 4173) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const cleanPath = (req.url || "/").split("?")[0];
      const rel = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
      const filePath = path.join(APP_DIR, rel);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    server.on("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdpTarget(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await resp.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome CDP endpoint did not come up in time");
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", reject);
      this.ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return res?.result?.value;
  }
  close() {
    this.ws?.close();
  }
}

async function main() {
  fs.mkdirSync(SUB_DIR, { recursive: true });
  const { server, port } = await startStaticServer(4173);
  const cdpPort = 19422 + Math.floor(Math.random() * 600);
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "today-table-rec-"));

  const TARGET_URL = process.env.DEMO_URL || `http://127.0.0.1:${port}/index.html`;
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tmpProfile}`,
      "--window-size=1920,1080",
      "--force-device-scale-factor=1",
      "--no-first-run",
      "--no-default-browser-check",
      "--host-resolver-rules=MAP eat.breakneo.dpdns.org 43.174.247.115",
      TARGET_URL,
    ],
    { stdio: "ignore" }
  );

  const FPS = 10;
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-y",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-r", String(FPS),
      "-i", "-",
      "-vf", "scale=1920:1080,fps=30,format=yuv420p",
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "21",
      "-movflags", "+faststart",
      OUT_MP4,
    ],
    { stdio: ["pipe", "ignore", "pipe"] }
  );

  let cdp;
  let totalFrames = 0;

  async function grabFrame() {
    const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
    const buf = Buffer.from(shot.data, "base64");
    if (!ffmpeg.stdin.write(buf)) {
      await new Promise((r) => ffmpeg.stdin.once("drain", r));
    }
    totalFrames += 1;
  }

  async function recordHold(ms) {
    const count = Math.max(Math.round((ms / 1000) * FPS), 1);
    for (let i = 0; i < count; i++) {
      const t0 = Date.now();
      await grabFrame();
      const dt = Date.now() - t0;
      if (dt < 1000 / FPS) await sleep(1000 / FPS - dt);
    }
  }

  async function savePng(filename) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SUB_DIR, filename), Buffer.from(shot.data, "base64"));
  }

  async function setCaption(text) {
    await cdp.eval(`(() => {
      let bar = document.getElementById("__demo_caption");
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "__demo_caption";
        bar.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(31,29,26,0.92);color:#fff;padding:12px 24px;border-radius:999px;font-size:20px;font-weight:600;z-index:99999;box-shadow:0 8px 28px rgba(0,0,0,0.28);letter-spacing:0.02em;white-space:nowrap;";
        document.body.appendChild(bar);
      }
      bar.textContent = ${JSON.stringify(text)};
      bar.style.display = ${text ? "'block'" : "'none'"};
    })()`);
  }

  async function scrollToY(y, durationMs = 700) {
    const startY = (await cdp.eval("window.scrollY")) || 0;
    const steps = Math.max(Math.round((durationMs / 1000) * FPS), 4);
    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      const eased = ratio < 0.5 ? 2 * ratio * ratio : 1 - Math.pow(-2 * ratio + 2, 2) / 2;
      const cur = Math.round(startY + (y - startY) * eased);
      await cdp.eval(`window.scrollTo(0, ${cur})`);
      await grabFrame();
    }
  }

  try {
    const wsUrl = await waitForCdpTarget(cdpPort);
    cdp = new CdpClient(wsUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(600);

    // 1. 干净首屏截图与录屏开场
    await savePng("screen_home.png");
    await setCaption("今天吃这桌 · 选定地点范围与家数，挑好饭馆、配好一桌菜、算清团购");
    await recordHold(2200);

    // 2. 真实点击打开精致自定义下拉菜单并选中快捷场景
    await setCaption("步骤 1：统一自定义下拉选单，轻松设置地点、搜索范围、甄选餐厅（1-10家）与预算");
    await cdp.eval(`document.querySelector('#presetSelect + .ui-select-trigger')?.click()`);
    await recordHold(1000);
    await cdp.eval(`document.querySelector('.picker-option[data-opt-value="hz"]')?.click()`);
    await recordHold(1200);

    // 3. 点击查询（录下真实逐店流式加载过程：先秒出真实餐厅卡，再逐家亮出菜单与预算）
    await setCaption("步骤 2：实时筛选指定范围内高分饭馆，拿到一家立刻展示一家，不干等");
    await cdp.eval(`document.getElementById("submitBtn")?.click()`);

    let scrolledToResults = false;
    let rendered = false;
    for (let i = 0; i < 280; i++) {
      await grabFrame();
      const stateInfo = await cdp.eval(`({
        visible: !document.getElementById("resultsSection")?.classList.contains("hidden"),
        cards: document.querySelectorAll(".shop-card").length,
        ready: document.querySelectorAll(".shop-card.is-ready").length
      })`);
      if (stateInfo?.visible && stateInfo.cards === 3 && !scrolledToResults) {
        scrolledToResults = true;
        const top = await cdp.eval(`Math.max(0, document.getElementById("resultsSection").offsetTop - 20)`);
        await scrollToY(top, 450);
      }
      if (stateInfo?.ready === 3) {
        rendered = true;
        break;
      }
      await sleep(150);
    }
    if (!rendered) throw new Error("等待 3 家推荐餐厅渲染超时");
    await sleep(400);

    const resTop = await cdp.eval(`Math.max(0, document.getElementById("resultsSection").offsetTop - 20)`);
    await scrollToY(resTop, 700);
    await setCaption("");
    await savePng("screen_results.png");
    await setCaption("3 家候选饭馆横向对比：口碑、距离、参考人均与本桌配菜估价一目了然");
    await recordHold(3000);

    await scrollToY(resTop + 340, 800);
    await setCaption("按人数与忌口生成防浪费菜单，标明每道菜估价与预算结余");
    await recordHold(2800);

    // 4. 展开支付宝/口碑团购比价器并实算
    await scrollToY(resTop + 700, 700);
    await setCaption("步骤 3：粘贴支付宝/口碑团购文案，实算份量、忌口冲突与比单点省多少钱");
    await cdp.eval(`document.querySelector('[data-toggle-gb="0"]')?.click()`);
    await recordHold(700);
    await cdp.eval(`document.querySelector('[data-fill-sample-gb="0"]')?.click()`);
    await recordHold(900);
    await cdp.eval(`document.querySelector('[data-run-gb="0"]')?.click()`);
    for (let i = 0; i < 120; i++) {
      await grabFrame();
      const ready = await cdp.eval(`!document.getElementById("gb-result-0")?.classList.contains("hidden")`);
      if (ready) break;
      await sleep(150);
    }
    await scrollToY(resTop + 920, 600);
    await setCaption("");
    await savePng("screen_groupbuy.png");
    await setCaption("团购比价核算完成：自动判断是否划算、要不要补菜以及能省多少");
    await recordHold(2800);

    // 5. 点击「就定这家 · 生成约饭通知」
    await setCaption("步骤 4：点击「就定这家 · 生成约饭通知」，一键发群定位、导日历与高德导航");
    await cdp.eval(`document.querySelector('[data-pick-idx="0"]')?.click()`);
    await sleep(300);
    const decTop = await cdp.eval(`Math.max(0, document.getElementById("decisionPanel").offsetTop - 36)`);
    await scrollToY(decTop, 800);
    await setCaption("");
    await savePng("screen_decision.png");
    await setCaption("简洁得体的群约饭通知与高德导航直达，一键复制发群里即可赴约");
    await recordHold(2800);

    await scrollToY(0, 800);
    await setCaption("今天吃这桌 · 30 秒搞定聚餐选店、点菜、团购比价与约饭定店");
    await recordHold(1800);

    // 结束视频流后再切手机竖屏（390x844）做零横向滚动条真机校验与截图
    ffmpeg.stdin.end();
    await new Promise((resolve) => ffmpeg.on("close", resolve));

    await setCaption("");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(400);
    await cdp.eval(`window.scrollTo(0, document.getElementById("resultsSection").offsetTop - 12)`);
    await sleep(300);
    const overflowInfo = await cdp.eval(`({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      mobileVisible: getComputedStyle(document.getElementById("compareMobileList")).display
    })`);
    await savePng("screen_mobile.png");
    // 顺手测试手机端精致底部抽屉下拉弹窗
    await cdp.eval(`window.scrollTo(0, 0)`);
    await sleep(250);
    await cdp.eval(`document.querySelector('#sceneSelect + .ui-select-trigger')?.click()`);
    await sleep(300);
    await savePng("screen_mobile_picker.png");
    await cdp.eval(`document.getElementById("pickerCloseBtn")?.click()`);
    console.log("MOBILE_CHECK:", JSON.stringify(overflowInfo));
    if (overflowInfo.scrollW > overflowInfo.clientW + 1) {
      throw new Error(`手机端仍有横向溢出：scrollWidth=${overflowInfo.scrollW} > clientWidth=${overflowInfo.clientW}`);
    }
  } finally {
    try { ffmpeg.stdin.end(); } catch {}
    cdp?.close();
    chrome.kill("SIGKILL");
    server.close();
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  }

  const stat = fs.statSync(OUT_MP4);
  console.log(`RECORD_DONE: ${OUT_MP4} | frames=${totalFrames} | size=${(stat.size / 1024 / 1024).toFixed(2)}MB`);
}

main().catch((err) => {
  console.error("RECORD_FAILED:", err);
  process.exit(1);
});
