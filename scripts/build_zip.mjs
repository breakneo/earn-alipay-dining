/**
 * 按支付宝「智能体涌现奖」官方 ZIP 格式示例打包并校验：
 * earn-alipay-dining.zip
 * ├── package.json
 * ├── index.html
 * └── assets/
 *     ├── styles.css
 *     ├── app.js
 *     ├── api.js
 *     ├── engine.js
 *     ├── logo.png
 *     └── favicon.png
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(ROOT, "app");
const OUT_ZIP = path.join(ROOT, "submission", "earn-alipay-dining.zip");
const STAGE = "/tmp/alipay-official-zip-stage";

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, "assets"), { recursive: true });

// 1. package.json（严格含 name 与有效 version）
const pkg = {
  name: "today-table",
  version: "1.0.0",
  description: "今天吃这桌 · 聚餐选店配菜与支付宝口碑团购参谋",
};
fs.writeFileSync(path.join(STAGE, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");

// 2. index.html（全部静态资源均指向 ./assets/）
let indexHtml = fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8");
indexHtml = indexHtml
  .replace(/href="\.\/favicon\.png(?:\?[^"]*)?"/g, 'href="./assets/favicon.png"')
  .replace(/href="\.\/styles\.css(?:\?[^"]*)?"/g, 'href="./assets/styles.css"')
  .replace(/src="\.\/logo\.png(?:\?[^"]*)?"/g, 'src="./assets/logo.png"')
  .replace(/src="\.\/app\.js(?:\?[^"]*)?"/g, 'src="./assets/app.js"');
fs.writeFileSync(path.join(STAGE, "index.html"), indexHtml, "utf8");

// 3. assets/ 目录下所有脚本、样式、图标（清除缓存版本号 query，保持纯静态相对路径）
for (const fn of ["styles.css", "api.js", "engine.js", "logo.png", "favicon.png"]) {
  fs.copyFileSync(path.join(APP_DIR, fn), path.join(STAGE, "assets", fn));
}
let appJs = fs.readFileSync(path.join(APP_DIR, "app.js"), "utf8");
appJs = appJs.replace(/\?v=[0-9a-zA-Z]+/g, "");
fs.writeFileSync(path.join(STAGE, "assets", "app.js"), appJs, "utf8");

// 4. 打包 ZIP（不含任何隐藏文件或多余父目录）
fs.rmSync(OUT_ZIP, { force: true });
execFileSync("zip", ["-q", "-r", OUT_ZIP, "package.json", "index.html", "assets"], { cwd: STAGE });

// 5. 自检：解压后起静态服务验证 index.html 与所有 ./assets/* 均 200 OK 且零缺失
const verifyDir = "/tmp/alipay-official-zip-verify";
fs.rmSync(verifyDir, { recursive: true, force: true });
fs.mkdirSync(verifyDir, { recursive: true });
execFileSync("unzip", ["-q", OUT_ZIP, "-d", verifyDir]);

const mustExist = [
  "package.json",
  "index.html",
  "assets/styles.css",
  "assets/app.js",
  "assets/api.js",
  "assets/engine.js",
  "assets/logo.png",
  "assets/favicon.png",
];
for (const rel of mustExist) {
  if (!fs.existsSync(path.join(verifyDir, rel))) {
    throw new Error(`ZIP 缺少必需文件：${rel}`);
  }
}
if (fs.existsSync(path.join(verifyDir, "dist"))) {
  throw new Error("不能同时存在根 index.html 和 dist/");
}
const parsedPkg = JSON.parse(fs.readFileSync(path.join(verifyDir, "package.json"), "utf8"));
if (!parsedPkg.name || !/^\d+\.\d+\.\d+$/.test(parsedPkg.version)) {
  throw new Error("package.json 缺少有效的 name 或 version");
}

// 静态 HTTP 服务核验引用路径全部 200
const server = http.createServer((req, res) => {
  const clean = (req.url || "/").split("?")[0];
  const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const fp = path.join(verifyDir, rel);
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    res.writeHead(200);
    fs.createReadStream(fp).pipe(res);
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
try {
  for (const urlPath of ["/", "/assets/styles.css", "/assets/app.js", "/assets/api.js", "/assets/engine.js", "/assets/logo.png", "/assets/favicon.png"]) {
    const resp = await fetch(`http://127.0.0.1:${port}${urlPath}`);
    if (resp.status !== 200) throw new Error(`静态校验失败：${urlPath} -> HTTP ${resp.status}`);
  }
} finally {
  server.close();
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(verifyDir, { recursive: true, force: true });
}

const stat = fs.statSync(OUT_ZIP);
console.log(`ZIP_VERIFIED: ${OUT_ZIP} (${(stat.size / 1024).toFixed(1)} KB)`);
console.log(execFileSync("unzip", ["-l", OUT_ZIP], { encoding: "utf8" }));
