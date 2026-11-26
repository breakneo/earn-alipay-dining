/**
 * 腾讯云 EdgeOne Pages 边缘函数：POST /api/chat（SCNet GLM-5.3-Flash 安全代理）
 * 环境变量：SCNET_API_KEY（在 EdgeOne Pages 控制台加密配置，绝不落代码仓）
 */

const SCNET_URL = "https://api.scnet.cn/api/llm/v1/chat/completions";
const LOCKED_MODEL = "GLM-5.3-Flash";

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env?.SCNET_API_KEY) {
      return jsonResp({ error: "服务端尚未配置推理服务密钥" }, 503);
    }
    const body = await request.json();
    const messages = Array.isArray(body.messages) ? body.messages.slice(-6) : [];
    if (!messages.length) {
      return jsonResp({ error: "请求内容不能为空" }, 400);
    }
    const upstreamResp = await fetch(SCNET_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.SCNET_API_KEY}`,
      },
      body: JSON.stringify({
        model: LOCKED_MODEL,
        temperature: typeof body.temperature === "number" ? Math.min(Math.max(body.temperature, 0), 0.7) : 0.3,
        max_tokens: Math.min(Number(body.max_tokens) || 1500, 1800),
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
      },
    });
  } catch (err) {
    return jsonResp({ error: err?.message || "智能配菜请求失败" }, 502);
  }
}
