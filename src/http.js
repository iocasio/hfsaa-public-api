export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "Content-Disposition, ETag, Retry-After, X-Checksum-SHA256, X-Dataset-Version, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(),
      "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=60",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

export function privateJson(body, status = 200, extraHeaders = {}) {
  return json(body, status, { "Cache-Control": "no-store", ...extraHeaders });
}

export function error(code, message, status, extraHeaders = {}) {
  return privateJson({ error: { code, message } }, status, extraHeaders);
}

export function serviceUnavailable(message) {
  return error("service_unavailable", message, 503, { "Retry-After": "60" });
}

export function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(),
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

