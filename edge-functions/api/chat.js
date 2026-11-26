/**
 * 腾讯云 EdgeOne Pages 边缘函数：POST/OPTIONS /api/chat（SCNet GLM-5.3-Flash 安全代理）
 * 环境变量：SCNET_API_KEY（在 EdgeOne Pages 控制台加密配置，绝不落代码仓）
 */

const SCNET_URL = "https://api.scnet.cn/api/llm/v1/chat/completions";
const LOCKED_MODEL = "GLM-5.3-Flash";
const UPSTREAM_TIMEOUT_MS = 13500;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const { request, env } = context || {};
    const scnetKey =
      env?.SCNET_API_KEY ||
      (typeof process !== "undefined" ? process.env?.SCNET_API_KEY : "") ||
      "";
    if (!scnetKey) {
      return jsonResp({ error: "服务端尚未配置推理服务密钥" }, 503);
    }
    const body = await request.json();
    const messages = Array.isArray(body.messages) ? body.messages.slice(-6) : [];
    if (!messages.length) {
      return jsonResp({ error: "请求内容不能为空" }, 400);
    }
    const upstreamResp = await fetch(SCNET_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${scnetKey}`,
      },
      body: JSON.stringify({
        model: LOCKED_MODEL,
        temperature: typeof body.temperature === "number" ? Math.min(Math.max(body.temperature, 0), 0.7) : 0.25,
        max_tokens: Math.min(Number(body.max_tokens) || 640, 1200),
        thinking: { type: "disabled" },
        messages,
      }),
    });
    const text = await upstreamResp.text();
    return new Response(text, {
      status: upstreamResp.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      return jsonResp({ error: "智能配菜响应超时，请稍后重试" }, 504);
    }
    return jsonResp({ error: err?.message || "智能配菜请求失败" }, 502);
  } finally {
    clearTimeout(timer);
  }
}
