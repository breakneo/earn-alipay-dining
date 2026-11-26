export async function onRequestGet(context) {
  const env = context?.env || {};
  return new Response(
    JSON.stringify({
      ok: true,
      v: "ef-v2",
      amap: Boolean(env.AMAP_API_KEY),
      scnet: Boolean(env.SCNET_API_KEY),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    }
  );
}
