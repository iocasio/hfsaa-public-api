const PUBLIC_FIELDS = [
  "id",
  "type",
  "name",
  "certificate_id",
  "certification_status",
  "certification_date",
  "chapter_name",
  "address",
  "city",
  "state",
  "zip_code",
  "cuisine_type",
  "google_place_id",
];

const LOCATION_TYPES = new Set(["restaurant", "meat_market", "dining_hall"]);
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body, status = 200, extraHeaders = {}) {
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

function error(code, message, status) {
  return json({ error: { code, message } }, status, { "Cache-Control": "no-store" });
}

function parseLimit(value) {
  if (value === null) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded));
    return typeof parsed.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
      ? parsed.id
      : null;
  } catch {
    return null;
  }
}

function encodeCursor(id) {
  return btoa(JSON.stringify({ id })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function getSingleValue(params, name) {
  const values = params.getAll(name);
  return values.length <= 1 ? values[0] ?? null : undefined;
}

function addExactFilter(params, name, value) {
  if (value !== null) params.set(name, `eq.${value}`);
}

function searchTerm(value) {
  // PostgREST filter syntax uses punctuation as operators. Excluding it here keeps
  // q as a literal directory-text search rather than allowing filter injection.
  const normalized = value.trim().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function supabaseUrl(env, path, params) {
  const url = new URL(`/rest/v1/${path}`, env.SUPABASE_URL);
  for (const [key, value] of params) url.searchParams.append(key, value);
  return url;
}

async function querySupabase(env, path, params) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("missing_supabase_service_role_key");
  }

  const response = await fetch(supabaseUrl(env, path, params), {
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Accept-Profile": "public",
    },
  });

  if (!response.ok) {
    throw new Error(`supabase_request_failed:${response.status}`);
  }

  return response.json();
}

function buildLocationQuery(url, fixedType) {
  const params = url.searchParams;
  const allowed = new Set(["type", "state", "city", "zip_code", "chapter", "certificate_id", "q", "limit", "cursor"]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) return { error: `Unsupported query parameter: ${key}.` };
    if (getSingleValue(params, key) === undefined) return { error: `Query parameter may only be supplied once: ${key}.` };
  }

  const requestedType = getSingleValue(params, "type");
  if (requestedType !== null && !LOCATION_TYPES.has(requestedType)) {
    return { error: "type must be restaurant, meat_market, or dining_hall." };
  }
  if (fixedType && requestedType && requestedType !== fixedType) {
    return { error: `This endpoint only supports type=${fixedType}.` };
  }

  const limit = parseLimit(getSingleValue(params, "limit"));
  if (limit === null) return { error: `limit must be an integer between 1 and ${MAX_LIMIT}.` };

  const cursorValue = getSingleValue(params, "cursor");
  const cursor = decodeCursor(cursorValue);
  if (cursorValue !== null && cursor === null) return { error: "cursor is invalid." };

  const q = getSingleValue(params, "q");
  if (q !== null && (q.length > 100 || !searchTerm(q))) {
    return { error: "q must contain up to 100 letters, numbers, spaces, apostrophes, or hyphens." };
  }

  const state = getSingleValue(params, "state");
  if (state !== null && !/^[A-Za-z]{2}$/.test(state)) return { error: "state must be a two-letter code." };

  const query = new URLSearchParams({
    select: PUBLIC_FIELDS.join(","),
    order: "id.asc",
    limit: String(limit + 1),
  });
  addExactFilter(query, "type", fixedType ?? requestedType);
  addExactFilter(query, "state", state?.toUpperCase() ?? null);
  addExactFilter(query, "city", getSingleValue(params, "city"));
  addExactFilter(query, "zip_code", getSingleValue(params, "zip_code"));
  addExactFilter(query, "chapter_name", getSingleValue(params, "chapter"));
  addExactFilter(query, "certificate_id", getSingleValue(params, "certificate_id"));
  if (cursor) query.set("id", `gt.${cursor}`);

  if (q !== null) {
    const term = searchTerm(q);
    query.set(
      "or",
      `(name.ilike.*${term}*,city.ilike.*${term}*,state.ilike.*${term}*,chapter_name.ilike.*${term}*,cuisine_type.ilike.*${term}*)`,
    );
  }

  return { query, limit };
}

async function listLocations(env, url, fixedType) {
  const built = buildLocationQuery(url, fixedType);
  if (built.error) return error("invalid_parameter", built.error, 400);

  const rows = await querySupabase(env, "api_public_locations_v1", built.query);
  const hasMore = rows.length > built.limit;
  const data = hasMore ? rows.slice(0, built.limit) : rows;
  return json({
    data,
    pagination: {
      limit: built.limit,
      next_cursor: hasMore ? encodeCursor(data.at(-1).id) : null,
    },
  });
}

async function getLocation(env, locationId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(locationId)) {
    return error("invalid_parameter", "locationId is invalid.", 400);
  }

  const params = new URLSearchParams({ select: PUBLIC_FIELDS.join(","), id: `eq.${locationId}`, limit: "1" });
  const rows = await querySupabase(env, "api_public_locations_v1", params);
  return rows[0] ? json(rows[0]) : error("not_found", "Location not found.", 404);
}

async function listChapters(env) {
  const params = new URLSearchParams({ select: "chapter_name", "chapter_name": "not.is.null", order: "chapter_name.asc", limit: "1000" });
  const rows = await querySupabase(env, "api_public_locations_v1", params);
  const seen = new Set();
  const data = rows
    .map((row) => row.chapter_name)
    .filter((name) => typeof name === "string" && name.trim() && !seen.has(name) && seen.add(name))
    .map((name) => ({ name }));
  return json({ data });
}

function requestPath(url) {
  return url.pathname.replace(/\/+$/, "") || "/";
}

async function enforceRateLimit(request, env, path) {
  if (!path.startsWith("/v1/") || !env.API_RATE_LIMITER) return null;

  // This is only a coarse, per-location safeguard while the public API has no
  // caller identity. Production will also use a zone-level rule once api.hfsaa.org
  // is attached to Cloudflare.
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.API_RATE_LIMITER.limit({ key });
  return success
    ? null
    : error("rate_limited", "Too many requests. Try again in one minute.", 429);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = requestPath(url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== "GET") return error("method_not_allowed", "Only GET requests are supported.", 405);

    try {
      const rateLimitResponse = await enforceRateLimit(request, env, path);
      if (rateLimitResponse) return rateLimitResponse;

      let response;
      if (path === "/health") {
        response = json({ status: "ok", api_version: "v1", environment: env.ENVIRONMENT });
      } else if (path === "/v1/locations") {
        response = await listLocations(env, url);
      } else if (path === "/v1/chapters") {
        response = await listChapters(env);
      } else if (path === "/v1/dataset") {
        response = json({ api_version: "v1", location_types: [...LOCATION_TYPES] });
      } else if (path.startsWith("/v1/locations/")) {
        response = await getLocation(env, decodeURIComponent(path.slice("/v1/locations/".length)));
      } else {
        response = error("not_found", "Route not found.", 404);
      }

      console.log(JSON.stringify({ message: "api_request", method: request.method, path, status: response.status }));
      return response;
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : "unknown_error";
      console.error(JSON.stringify({ message: "api_request_failed", path, reason }));
      if (reason === "missing_supabase_service_role_key") {
        return error("service_unavailable", "The API is not configured yet.", 503);
      }
      return error("internal_error", "The service could not complete this request.", 502);
    }
  },
};
