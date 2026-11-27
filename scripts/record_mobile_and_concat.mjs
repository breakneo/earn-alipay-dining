/**
 * 录制 iPhone 16 Pro Max（440x956，2x Retina）真实手机竖屏适配操作视频，
 * 合成至 1920x1080 手机实机展示框，并无缝拼接在当前横屏演示视频之前，输出最终 submission/demo_video.mp4
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SUB_DIR = path.join(ROOT, "submission");
const DESKTOP_MP4 = "/tmp/desktop_demo_backup.mp4";
const RAW_MOBILE_MP4 = "/tmp/mobile_raw_440x956.mp4";
const COMPOSITE_MOBILE_MP4 = "/tmp/mobile_intro_1080p.mp4";
const FINAL_MP4 = path.join(SUB_DIR, "demo_video.mp4");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TARGET_URL = "https://eat.breakneo.dpdns.org/";

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
  throw new Error("Chrome CDP timeout");
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
  if (!fs.existsSync(DESKTOP_MP4)) {
    throw new Error(`缺少横屏基准视频：${DESKTOP_MP4}`);
  }
  // 1. 生成 1920x1080 品牌底板和圆角手机屏遮罩
  execFileSync("python3", [path.join(__dirname, "build_mobile_bg.py")], { stdio: "inherit" });

  // 2. 启动独立无头 Chrome 模拟 iPhone 16 Pro Max (440x956 @2x)
  const cdpPort = 19820 + Math.floor(Math.random() * 400);
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "today-table-mobile-rec-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tmpProfile}`,
      "--window-size=440,956",
      "--no-first-run",
      "--no-default-browser-check",
      "--host-resolver-rules=MAP eat.breakneo.dpdns.org 43.174.247.115",
      TARGET_URL,
    ],
    { stdio: "ignore" }
  );

  const FPS = 10;
  const ffmpegRaw = spawn(
    "ffmpeg",
    [
      "-y",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-r", String(FPS),
      "-i", "-",
      "-vf", "scale=446:968:flags=lanczos,fps=30,format=yuv420p",
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "19",
      RAW_MOBILE_MP4,
    ],
    { stdio: ["pipe", "ignore", "pipe"] }
  );

  let cdp;
  let frames = 0;

  async function grabFrame() {
    const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
    const buf = Buffer.from(shot.data, "base64");
    if (!ffmpegRaw.stdin.write(buf)) {
      await new Promise((r) => ffmpegRaw.stdin.once("drain", r));
    }
    frames += 1;
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
      width: 440,
      height: 956,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send("Network.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    });

    // 等待脚本初始化完成
    for (let i = 0; i < 50; i++) {
      if (await cdp.eval(`document.querySelectorAll(".ui-select-trigger").length >= 4`)) break;
      await sleep(150);
    }
    await sleep(300);

    // 1. iPhone 16 Pro Max 干净首屏
    await recordHold(1500);

    // 2. 点击「快捷试玩」弹出底部原生质感抽屉，选择「北京国贸 · 8人单位聚餐 · 总预算1400」
    await cdp.eval(`document.querySelector('#presetSelect + .ui-select-trigger')?.click()`);
    await recordHold(1100);
    await cdp.eval(`document.querySelector('.picker-option[data-opt-value="bj"]')?.click()`);
    await recordHold(1000);

    // 3. 点击「帮我挑 3 家并配菜」，真实录下先秒出正餐卡、再逐店亮出菜单的过程
    await cdp.eval(`document.getElementById("submitBtn")?.click()`);
    let scrolledToRes = false;
    let readyAll = false;
    for (let i = 0; i < 320; i++) {
      await grabFrame();
      const s = await cdp.eval(`({
        vis: !document.getElementById("resultsSection")?.classList.contains("hidden"),
        cards: document.querySelectorAll(".shop-card").length,
        ready: document.querySelectorAll(".shop-card.is-ready").length
      })`);
      if (s?.vis && s.cards === 3 && !scrolledToRes) {
        scrolledToRes = true;
        const top = await cdp.eval(`Math.max(0, document.getElementById("resultsSection").offsetTop - 12)`);
        await scrollToY(top, 500);
      }
      if (s?.ready === 3) {
        readyAll = true;
        break;
      }
      await sleep(150);
    }
    if (!readyAll) throw new Error("手机端 3 家正餐配菜等待超时");

    // 4. 校验 iPhone 16 Pro Max (440x956) 零横向溢出
    const ov = await cdp.eval(`({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth })`);
    console.log("IPHONE_16_PRO_MAX_CHECK:", JSON.stringify(ov));
    if (ov.scrollW > ov.clientW + 1) {
      throw new Error(`iPhone 16 Pro Max 横向溢出：${ov.scrollW} > ${ov.clientW}`);
    }

    // 5. 展示零横向滚条对比卡 → 下滑看第 1 家正餐菜单与不含酒水总价 → 点击「就定这家」
    await recordHold(1400);
    const card0Top = await cdp.eval(`Math.max(0, document.getElementById("shop-card-0").offsetTop - 12)`);
    await scrollToY(card0Top, 700);
    await recordHold(1600);
    await scrollToY(card0Top + 460, 700);
    await recordHold(1300);

    await cdp.eval(`document.querySelector('[data-pick-idx="0"]')?.click()`);
    await sleep(300);
    const decTop = await cdp.eval(`Math.max(0, document.getElementById("decisionPanel").offsetTop - 12)`);
    await scrollToY(decTop, 700);
    await recordHold(1600);

    ffmpegRaw.stdin.end();
    await new Promise((resolve) => ffmpegRaw.on("close", resolve));
  } finally {
    try { ffmpegRaw.stdin.end(); } catch {}
    cdp?.close();
    chrome.kill("SIGKILL");
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  }

  // 3. 将 446x968 真实手机录屏叠加圆角遮罩合成到 1920x1080 品牌画布中
  const mobileDur = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", RAW_MOBILE_MP4],
    { encoding: "utf8" }
  ).trim();
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loop", "1", "-i", "/tmp/mobile_stage_bg.png",
      "-i", RAW_MOBILE_MP4,
      "-loop", "1", "-i", "/tmp/mobile_screen_mask.png",
      "-t", mobileDur,
      "-filter_complex",
      "[1:v]format=rgba[mv];[2:v]format=gray[mk];[mv][mk]alphamerge[phone];[0:v][phone]overlay=1220:56:shortest=1,format=yuv420p[out]",
      "-map", "[out]",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "21",
      "-movflags", "+faststart",
      COMPOSITE_MOBILE_MP4,
    ],
    { stdio: "inherit" }
  );

  // 4. 将手机端竖屏片段拼接在原横屏视频之前，输出统一 1920x1080 @30fps H.264 成品
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i", COMPOSITE_MOBILE_MP4,
      "-i", DESKTOP_MP4,
      "-filter_complex",
      "[0:v]scale=1920:1080,fps=30,setsar=1,format=yuv420p[v0];[1:v]scale=1920:1080,fps=30,setsar=1,format=yuv420p[v1];[v0][v1]concat=n=2:v=1:a=0[v]",
      "-map", "[v]",
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "22",
      "-movflags", "+faststart",
      FINAL_MP4,
    ],
    { stdio: "inherit" }
  );

  // 截取手机段中间一帧供视觉验收
  execFileSync("ffmpeg", ["-y", "-ss", "12", "-i", COMPOSITE_MOBILE_MP4, "-vframes", "1", "/tmp/mobile_video_frame.png"], { stdio: "ignore" });

  const stat = fs.statSync(FINAL_MP4);
  const probe = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration:stream=width,height,r_frame_rate", "-of", "default=noprint_wrappers=1", FINAL_MP4],
    { encoding: "utf8" }
  ).trim();
  console.log(`FINAL_VIDEO_DONE: ${FINAL_MP4} | size=${(stat.size / 1024 / 1024).toFixed(2)}MB | mobileFrames=${frames}\n${probe}`);
}

main().catch((err) => {
  console.error("MOBILE_REC_FAILED:", err);
  process.exit(1);
});
