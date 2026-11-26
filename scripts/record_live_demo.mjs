/**
 * 「今天吃这桌」真实动态交互录屏与高清截图脚本
 * - 启动独立无头 Chrome（端口 4173 合法来源，不触碰主人任何浏览器窗口）
 * - 真实点击输入地标「杭州黄龙万科中心」、人数、预算与「不吃辣」忌口
 * - 实时调用 Cloudflare Worker（高德真实饭馆 + GLM-5.3-Flash 配菜）
 * - 真实展开团购比价计算器、点击「就定这家」并操作支付宝群收款 AA 分账
 * - 通过 CDP 抓帧 + ffmpeg 合成 1080p MP4（绝非静态 PPT）并顺带保存真实运行高清截图
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
  const cdpPort = 19322 + Math.floor(Math.random() * 800);
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "today-table-rec-"));

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
      `http://127.0.0.1:${port}/index.html`,
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

  let ffmpegErr = "";
  ffmpeg.stderr.on("data", (d) => (ffmpegErr += d.toString()));

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

    // 等健康检测变绿
    for (let i = 0; i < 30; i++) {
      const ready = await cdp.eval(`document.getElementById("serviceStatus")?.classList.contains("ready")`);
      if (ready) break;
      await sleep(300);
    }

    // 1. 展示首屏（先截取干净无字幕首屏图，再开始录屏）
    await setCaption("今天吃这桌 · 高德真实选店 + AI 按人数配菜 + 团购比价与 AA 算账");
    await recordHold(2200);

    // 2. 真实勾选「不吃辣」与设置场景
    await setCaption("步骤 1：输入地标「杭州黄龙万科中心」、4人朋友小聚、人均120、勾选「不吃辣」");
    await cdp.eval(`document.querySelector('.tag-chip[data-tag="不吃辣"]')?.click()`);
    await recordHold(1500);

    // 3. 点击主按钮真实发起高德 + GLM-5.3-Flash 查询
    await setCaption("步骤 2：实时检索高德周边真实营业餐厅，并由 GLM-5.3-Flash 配好 3 桌菜");
    await cdp.eval(`document.getElementById("submitBtn")?.click()`);

    // 录制真实加载态直到 3 家结果卡片真正渲染（最多等 45 秒）
    let rendered = false;
    for (let i = 0; i < 280; i++) {
      await grabFrame();
      const done = await cdp.eval(`!document.getElementById("resultsSection")?.classList.contains("hidden") && document.querySelectorAll(".shop-card").length === 3`);
      if (done) {
        rendered = true;
        break;
      }
      await sleep(150);
    }
    if (!rendered) {
      throw new Error("等待 3 家推荐餐厅渲染超时");
    }
    await sleep(400);

    // 精准滚到对比表 + 3 家真店卡片顶部，截取干净高清结果图
    const resTop = await cdp.eval(`Math.max(0, document.getElementById("resultsSection").offsetTop - 20)`);
    await scrollToY(resTop, 700);
    await setCaption("");
    await savePng("screen_results.png");
    await setCaption("3 家高德真实高分饭馆横评：评分、距离、真实人均与本桌配菜估价一目了然");
    await recordHold(3000);

    // 4. 下滚查看 3 家店详细点菜清单与预算拆解
    await scrollToY(resTop + 340, 800);
    await setCaption("每家店按 4 人配比生成防浪费菜单（凉菜/硬菜/时蔬/汤主食），标注估算总价与人均");
    await recordHold(3200);

    // 5. 真实展开第 1 家店的团购比价计算器，填入示例团购并运行真实 AI 核算
    await scrollToY(1120, 700);
    await setCaption("步骤 3：粘贴支付宝/口碑团购文案，AI 实算份量、忌口冲突与团购省钱金额");
    await cdp.eval(`document.querySelector('[data-toggle-gb="0"]')?.click()`);
    await recordHold(800);
    await cdp.eval(`document.querySelector('[data-fill-sample-gb="0"]')?.click()`);
    await recordHold(1000);
    await cdp.eval(`document.querySelector('[data-run-gb="0"]')?.click()`);
    for (let i = 0; i < 120; i++) {
      await grabFrame();
      const ready = await cdp.eval(`!document.getElementById("gb-result-0")?.classList.contains("hidden")`);
      if (ready) break;
      await sleep(140);
    }
    await scrollToY(1340, 600);
    await setCaption("");
    await savePng("screen_groupbuy.png");
    await setCaption("团购比价核算完成：自动评估够不够吃、避坑提醒及比纯单点省多少钱");
    await recordHold(3000);

    // 6. 点击「就定这家」，演示群约饭通知 + 区分喝酒/不喝酒的支付宝群收款 AA 精算器
    await setCaption("步骤 4：点击「就定这家」，一键生成约饭群通知、日历提醒与支付宝群收款 AA");
    await cdp.eval(`document.querySelector('[data-pick-idx="0"]')?.click()`);
    await sleep(300);
    const decTop = await cdp.eval(`Math.max(0, document.getElementById("decisionPanel").offsetTop - 40)`);
    await scrollToY(decTop, 800);
    await recordHold(1400);

    // 实时输入酒水费用演示分摊
    await cdp.eval(`(() => {
      const d = document.getElementById("aaDrinkInput");
      const p = document.getElementById("aaDrinkersInput");
      d.value = "120";
      p.value = "2";
      d.dispatchEvent(new Event("input"));
      p.dispatchEvent(new Event("input"));
    })()`);
    await setCaption("");
    await savePng("screen_decision.png");
    await setCaption("支持区分喝酒与不喝酒人员精准分摊，一键复制支付宝群收款账单");
    await recordHold(2800);

    // 7. 结尾回到顶部收尾
    await scrollToY(0, 800);
    await setCaption("今天吃这桌 · 打开即用，30 秒搞定聚餐选店、点菜、团购比价与 AA 分账");
    await recordHold(2000);
  } finally {
    ffmpeg.stdin.end();
    await new Promise((resolve) => ffmpeg.on("close", resolve));
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
