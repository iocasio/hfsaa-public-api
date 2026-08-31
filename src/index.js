import {
  addUsageHeaders,
  authorizeDataRequest,
  handleDeveloperRoute,
  isDeveloperRoute,
  isProtectedDataRoute,
  scheduleUsageAlert,
} from "./developer-api.js";
import { corsHeaders, error, json, serviceUnavailable } from "./http.js";

const PUBLIC_FIELDS = [
  "id",
  "type",
  "name",
  "verification_url",
  "certification_status",
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
const SNAPSHOT_PAGE_SIZE = 1000;
const MAX_SNAPSHOT_PAGES = 100;
const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CURRENT_SNAPSHOT_KEY = "metadata/current.json";
const SNAPSHOT_PREFIX = "snapshots/";
const RETENTION_PREFIX = "retention/";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    return parsed?.v === 1
      && typeof parsed.d === "string"
      && UUID_PATTERN.test(parsed.d)
      && typeof parsed.i === "string"
      && UUID_PATTERN.test(parsed.i)
      && typeof parsed.f === "string"
      && parsed.f.length <= 500
      ? { datasetVersion: parsed.d, id: parsed.i, filterKey: parsed.f }
      : null;
  } catch {
    return null;
  }
}

function encodeCursor(datasetVersion, id, filterKey) {
  return btoa(JSON.stringify({ v: 1, d: datasetVersion, i: id, f: filterKey }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function getSingleValue(params, name) {
  const values = params.getAll(name);
  return values.length <= 1 ? values[0] ?? null : undefined;
}

function searchTerm(value) {
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

  const body = await response.json();
  if (!Array.isArray(body)) throw new Error("supabase_response_invalid");
  return body;
}

function isPublicLocation(row) {
  if (!row || typeof row !== "object") return false;
  if (typeof row.id !== "string" || !UUID_PATTERN.test(row.id)) return false;
  if (!LOCATION_TYPES.has(row.type)) return false;
  if (typeof row.name !== "string" || !row.name.trim()) return false;
  if (row.certification_status !== "certified") return false;

  try {
    const verificationUrl = new URL(row.verification_url);
    if (verificationUrl.protocol !== "https:") return false;
  } catch {
    return false;
  }

  const nullableStrings = [
    row.chapter_name,
    row.address,
    row.city,
    row.state,
    row.zip_code,
    row.cuisine_type,
    row.google_place_id,
  ];
  return nullableStrings.every((value) => value === null || typeof value === "string");
}

async function fetchSnapshotRows(env) {
  const data = [];
  const ids = new Set();
  let lastId = null;

  for (let page = 0; page < MAX_SNAPSHOT_PAGES; page += 1) {
    const params = new URLSearchParams({
      select: PUBLIC_FIELDS.join(","),
      order: "id.asc",
      limit: String(SNAPSHOT_PAGE_SIZE),
    });
    if (lastId) params.set("id", `gt.${lastId}`);

    const rows = await querySupabase(env, "api_public_locations_v1", params);
    for (const row of rows) {
      if (!isPublicLocation(row) || ids.has(row.id)) {
        throw new Error("supabase_location_invalid");
      }
      ids.add(row.id);
      data.push(row);
    }

    if (rows.length < SNAPSHOT_PAGE_SIZE) {
      if (data.length === 0) throw new Error("snapshot_empty");
      return data;
    }
    lastId = rows.at(-1).id;
  }

  throw new Error("snapshot_page_limit_exceeded");
}

function requireDatasetBucket(env) {
  if (!env.DATASET_BUCKET) throw new Error("missing_dataset_bucket");
  return env.DATASET_BUCKET;
}

function snapshotKey(datasetVersion) {
  return `${SNAPSHOT_PREFIX}${datasetVersion}.json`;
}

function retentionKey(datasetVersion) {
  return `${RETENTION_PREFIX}${datasetVersion}.json`;
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSnapshotMetadata(value) {
  return value
    && typeof value === "object"
    && typeof value.dataset_version === "string"
    && UUID_PATTERN.test(value.dataset_version)
    && validDate(value.generated_at)
    && Number.isInteger(value.location_count)
    && value.location_count >= 0
    && typeof value.checksum_sha256 === "string"
    && /^[0-9a-f]{64}$/.test(value.checksum_sha256)
    && value.artifact_key === snapshotKey(value.dataset_version);
}

function isSnapshotPayload(value, datasetVersion) {
  return value
    && typeof value === "object"
    && value.dataset_version === datasetVersion
    && validDate(value.generated_at)
    && Number.isInteger(value.location_count)
    && value.location_count >= 0
    && Array.isArray(value.data)
    && value.location_count === value.data.length;
}

async function readCurrentSnapshotMetadata(env) {
  const object = await requireDatasetBucket(env).get(CURRENT_SNAPSHOT_KEY);
  if (!object) return { metadata: null, etag: null };

  const metadata = await object.json();
  if (!isSnapshotMetadata(metadata)) throw new Error("current_snapshot_metadata_invalid");
  return { metadata, etag: object.etag };
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { digest, hex };
}

async function writeRetentionMarker(bucket, metadata, supersededAt) {
  const deleteAfter = new Date(supersededAt.getTime() + SNAPSHOT_RETENTION_MS).toISOString();
  await bucket.put(retentionKey(metadata.dataset_version), JSON.stringify({
    dataset_version: metadata.dataset_version,
    artifact_key: metadata.artifact_key,
    superseded_at: supersededAt.toISOString(),
    delete_after: deleteAfter,
  }), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function readRetentionMarker(bucket, datasetVersion) {
  const object = await bucket.get(retentionKey(datasetVersion));
  if (!object) return null;

  try {
    const marker = await object.json();
    return marker
      && marker.dataset_version === datasetVersion
      && marker.artifact_key === snapshotKey(datasetVersion)
      && validDate(marker.superseded_at)
      && validDate(marker.delete_after)
      ? marker
      : null;
  } catch {
    return null;
  }
}

async function listAllSnapshotObjects(bucket) {
  const objects = [];
  let cursor;

  do {
    const page = await bucket.list({ prefix: SNAPSHOT_PREFIX, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return objects;
}

async function reconcileSnapshotRetention(env, now = new Date()) {
  const bucket = requireDatasetBucket(env);
  const { metadata: current } = await readCurrentSnapshotMetadata(env);
  if (!current) return;

  const objects = await listAllSnapshotObjects(bucket);
  for (const object of objects) {
    const datasetVersion = object.key.slice(SNAPSHOT_PREFIX.length, -".json".length);
    if (!UUID_PATTERN.test(datasetVersion)) continue;

    if (datasetVersion === current.dataset_version) {
      if (await bucket.head(retentionKey(datasetVersion))) {
        await bucket.delete(retentionKey(datasetVersion));
      }
      continue;
    }

    let marker = await readRetentionMarker(bucket, datasetVersion);
    if (!marker) {
      const orphanMetadata = {
        dataset_version: datasetVersion,
        artifact_key: object.key,
      };
      await writeRetentionMarker(bucket, orphanMetadata, now);
      marker = await readRetentionMarker(bucket, datasetVersion);
    }

    if (marker && Date.parse(marker.delete_after) <= now.getTime()) {
      const { metadata: latestCurrent } = await readCurrentSnapshotMetadata(env);
      if (latestCurrent?.dataset_version === datasetVersion) continue;
      await bucket.delete([object.key, retentionKey(datasetVersion)]);
    }
  }
}

async function publishSnapshot(env, now = new Date()) {
  const bucket = requireDatasetBucket(env);
  const previous = await readCurrentSnapshotMetadata(env);
  const data = await fetchSnapshotRows(env);
  const datasetVersion = crypto.randomUUID();
  const generatedAt = now.toISOString();
  const artifactKey = snapshotKey(datasetVersion);
  const artifact = `${JSON.stringify({
    dataset_version: datasetVersion,
    generated_at: generatedAt,
    location_count: data.length,
    data,
  }, null, 2)}\n`;
  const bytes = new TextEncoder().encode(artifact);
  const checksum = await sha256(bytes);
  const metadata = {
    dataset_version: datasetVersion,
    generated_at: generatedAt,
    location_count: data.length,
    checksum_sha256: checksum.hex,
    artifact_key: artifactKey,
  };

  await bucket.put(artifactKey, bytes, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "public, max-age=604800, immutable",
    },
    customMetadata: {
      datasetVersion,
      generatedAt,
      locationCount: String(data.length),
      checksumSha256: checksum.hex,
    },
    sha256: checksum.digest,
  });

  const pointer = await bucket.put(CURRENT_SNAPSHOT_KEY, JSON.stringify(metadata), {
    onlyIf: previous.etag ? { etagMatches: previous.etag } : { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "no-store",
    },
  });

  if (!pointer) {
    const winner = await readCurrentSnapshotMetadata(env);
    if (!winner.metadata) throw new Error("snapshot_publication_conflict");
    return winner.metadata;
  }

  try {
    await bucket.delete(retentionKey(datasetVersion));
    if (previous.metadata && previous.metadata.dataset_version !== datasetVersion) {
      await writeRetentionMarker(bucket, previous.metadata, now);
    }
    await reconcileSnapshotRetention(env, now);
  } catch (caught) {
    console.error(JSON.stringify({
      message: "snapshot_retention_failed",
      reason: caught instanceof Error ? caught.message : "unknown_error",
    }));
  }

  console.log(JSON.stringify({
    message: "snapshot_published",
    dataset_version: datasetVersion,
    generated_at: generatedAt,
    location_count: data.length,
  }));
  return metadata;
}

async function ensureCurrentSnapshot(env) {
  const current = await readCurrentSnapshotMetadata(env);
  if (current.metadata && await requireDatasetBucket(env).head(current.metadata.artifact_key)) {
    return current.metadata;
  }
  return publishSnapshot(env);
}

async function loadSnapshot(env, datasetVersion) {
  const object = await requireDatasetBucket(env).get(snapshotKey(datasetVersion));
  if (!object) return null;

  const payload = await object.json();
  if (!isSnapshotPayload(payload, datasetVersion)) throw new Error("snapshot_payload_invalid");
  return payload;
}

function parseLocationQuery(url, fixedType) {
  const params = url.searchParams;
  const allowed = new Set(["type", "state", "city", "zip_code", "chapter", "q", "limit", "cursor"]);
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

  const filters = {
    type: fixedType ?? requestedType,
    state: state?.toUpperCase() ?? null,
    city: getSingleValue(params, "city"),
    zipCode: getSingleValue(params, "zip_code"),
    chapter: getSingleValue(params, "chapter"),
    q: q === null ? null : searchTerm(q).toLowerCase(),
  };
  const filterKey = JSON.stringify(filters);
  if (cursor && cursor.filterKey !== filterKey) {
    return { error: "cursor must be used with the same filters as the previous page." };
  }

  return { cursor, filterKey, filters, limit };
}

function locationMatches(row, filters) {
  if (filters.type && row.type !== filters.type) return false;
  if (filters.state && row.state !== filters.state) return false;
  if (filters.city && row.city !== filters.city) return false;
  if (filters.zipCode && row.zip_code !== filters.zipCode) return false;
  if (filters.chapter && row.chapter_name !== filters.chapter) return false;

  if (filters.q) {
    const searchable = [row.name, row.city, row.state, row.chapter_name, row.cuisine_type];
    if (!searchable.some((value) => typeof value === "string" && value.toLowerCase().includes(filters.q))) {
      return false;
    }
  }

  return true;
}

async function listLocations(env, url, fixedType) {
  const parsed = parseLocationQuery(url, fixedType);
  if (parsed.error) return error("invalid_parameter", parsed.error, 400);

  const metadata = parsed.cursor
    ? { dataset_version: parsed.cursor.datasetVersion }
    : await ensureCurrentSnapshot(env);
  const snapshot = await loadSnapshot(env, metadata.dataset_version);
  if (!snapshot) {
    return parsed.cursor
      ? error("cursor_expired", "The cursor's dataset version is no longer available. Start a new pagination request.", 410)
      : serviceUnavailable("The current dataset is temporarily unavailable.");
  }

  const matching = snapshot.data.filter((row) => locationMatches(row, parsed.filters));
  let start = 0;
  if (parsed.cursor) {
    const cursorIndex = matching.findIndex((row) => row.id === parsed.cursor.id);
    if (cursorIndex < 0) return error("invalid_parameter", "cursor does not match this result set.", 400);
    start = cursorIndex + 1;
  }

  const page = matching.slice(start, start + parsed.limit + 1);
  const hasMore = page.length > parsed.limit;
  const data = hasMore ? page.slice(0, parsed.limit) : page;
  return json({
    dataset_version: snapshot.dataset_version,
    data,
    pagination: {
      limit: parsed.limit,
      next_cursor: hasMore
        ? encodeCursor(snapshot.dataset_version, data.at(-1).id, parsed.filterKey)
        : null,
    },
  }, 200, { "X-Dataset-Version": snapshot.dataset_version });
}

async function getLocation(env, locationId) {
  if (!UUID_PATTERN.test(locationId)) {
    return error("invalid_parameter", "locationId is invalid.", 400);
  }

  const metadata = await ensureCurrentSnapshot(env);
  const snapshot = await loadSnapshot(env, metadata.dataset_version);
  if (!snapshot) return serviceUnavailable("The current dataset is temporarily unavailable.");
  const location = snapshot.data.find((row) => row.id === locationId);
  return location
    ? json(location, 200, { "X-Dataset-Version": snapshot.dataset_version })
    : error("not_found", "Location not found.", 404);
}

async function listChapters(env) {
  const metadata = await ensureCurrentSnapshot(env);
  const snapshot = await loadSnapshot(env, metadata.dataset_version);
  if (!snapshot) return serviceUnavailable("The current dataset is temporarily unavailable.");

  const names = new Set(snapshot.data
    .map((row) => row.chapter_name)
    .filter((name) => typeof name === "string" && name.trim()));
  const data = [...names].sort((left, right) => left.localeCompare(right)).map((name) => ({ name }));
  return json({ dataset_version: snapshot.dataset_version, data }, 200, {
    "X-Dataset-Version": snapshot.dataset_version,
  });
}

function datasetDownloadUrl(requestUrl, datasetVersion) {
  const url = new URL("/v1/dataset/locations.json", requestUrl);
  url.searchParams.set("version", datasetVersion);
  return url.toString();
}

async function getDatasetMetadata(request, env) {
  const metadata = await ensureCurrentSnapshot(env);
  return json({
    api_version: "v1",
    dataset_version: metadata.dataset_version,
    generated_at: metadata.generated_at,
    location_count: metadata.location_count,
    checksum: {
      algorithm: "sha256",
      value: metadata.checksum_sha256,
    },
    download_url: datasetDownloadUrl(request.url, metadata.dataset_version),
    location_types: [...LOCATION_TYPES],
    attribution: {
      required: true,
      text: "HFSAA verification",
      instructions: "When stating or implying that a location is certified or halal verified by HFSAA, identify HFSAA and provide reasonable access to the location's exact verification_url.",
    },
  }, 200, { "X-Dataset-Version": metadata.dataset_version });
}

async function downloadDataset(request, env) {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (key !== "version") return error("invalid_parameter", `Unsupported query parameter: ${key}.`, 400);
    if (getSingleValue(url.searchParams, key) === undefined) {
      return error("invalid_parameter", `Query parameter may only be supplied once: ${key}.`, 400);
    }
  }

  const requestedVersion = getSingleValue(url.searchParams, "version");
  if (requestedVersion !== null && !UUID_PATTERN.test(requestedVersion)) {
    return error("invalid_parameter", "version is invalid.", 400);
  }

  const metadata = requestedVersion
    ? { dataset_version: requestedVersion }
    : await ensureCurrentSnapshot(env);
  const object = await requireDatasetBucket(env).get(snapshotKey(metadata.dataset_version));
  if (!object) {
    return requestedVersion
      ? error("dataset_expired", "The requested dataset version is no longer available.", 410)
      : serviceUnavailable("The current dataset is temporarily unavailable.");
  }

  const checksum = object.customMetadata?.checksumSha256;
  const headers = new Headers({
    ...corsHeaders(),
    "Cache-Control": requestedVersion
      ? "public, max-age=604800, immutable"
      : "public, max-age=60, s-maxage=300",
    "Content-Disposition": `attachment; filename="hfsaa-locations-${metadata.dataset_version}.json"`,
    "Content-Length": String(object.size),
    "Content-Type": "application/json; charset=utf-8",
    "ETag": object.httpEtag,
    "X-Content-Type-Options": "nosniff",
    "X-Dataset-Version": metadata.dataset_version,
  });
  if (checksum) headers.set("X-Checksum-SHA256", checksum);
  return new Response(object.body, { status: 200, headers });
}

function requestPath(url) {
  return url.pathname.replace(/\/+$/, "") || "/";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = requestPath(url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    try {
      if (isDeveloperRoute(path)) {
        const developerResponse = await handleDeveloperRoute(request, env, path);
        console.log(JSON.stringify({ message: "api_request", method: request.method, path, status: developerResponse.status }));
        return developerResponse;
      }
      if (request.method !== "GET") return error("method_not_allowed", "Only GET requests are supported.", 405);

      let response;
      if (path === "/health") {
        response = json({ status: "ok", api_version: "v1", environment: env.ENVIRONMENT });
      } else {
        if (!isProtectedDataRoute(path)) return error("not_found", "Route not found.", 404);
        const authorization = await authorizeDataRequest(request, env, path);
        if (authorization.response) return authorization.response;

        if (path === "/v1/locations") {
          response = await listLocations(env, url);
        } else if (path === "/v1/chapters") {
          response = await listChapters(env);
        } else if (path === "/v1/dataset") {
          response = await getDatasetMetadata(request, env);
        } else if (path === "/v1/dataset/locations.json") {
          response = await downloadDataset(request, env);
        } else {
          response = await getLocation(env, decodeURIComponent(path.slice("/v1/locations/".length)));
        }

        scheduleUsageAlert(request, env, ctx, authorization.context);
        response = addUsageHeaders(response, authorization.context);
      }

      console.log(JSON.stringify({ message: "api_request", method: request.method, path, status: response.status }));
      return response;
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : "unknown_error";
      console.error(JSON.stringify({ message: "api_request_failed", path, reason }));
      if (reason === "missing_supabase_service_role_key"
        || reason === "missing_dataset_bucket"
        || reason === "missing_resend_api_key") {
        return serviceUnavailable("The API is not configured yet.");
      }
      if (reason.startsWith("supabase_request_failed:")
        || reason.startsWith("resend_request_failed:")
        || reason === "supabase_response_invalid"
        || reason === "supabase_location_invalid"
        || reason === "snapshot_empty"
        || reason === "snapshot_page_limit_exceeded") {
        return serviceUnavailable("The source dataset is temporarily unavailable.");
      }
      return error("internal_error", "The service could not complete this request.", 500);
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(publishSnapshot(env).catch((caught) => {
      console.error(JSON.stringify({
        message: "scheduled_snapshot_failed",
        reason: caught instanceof Error ? caught.message : "unknown_error",
      }));
    }));
  },
};

export {
  decodeCursor,
  encodeCursor,
  publishSnapshot,
  reconcileSnapshotRetention,
};

