import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import worker, { publishSnapshot, reconcileSnapshotRetention } from "../src/index.js";

const TEST_API_KEY = `hfsaa_test_${"A".repeat(43)}`;
const ADMIN_API_TOKEN = "test-admin-token-with-sufficient-length";
const GOOGLE_FORMS_INGEST_TOKEN = "test-google-forms-ingestion-token";
const APPLICATION_ID = "00000000-0000-4000-8000-000000000101";
const KEY_ID = "00000000-0000-4000-8000-000000000201";
const nativeFetch = globalThis.fetch;

function fetchUrl(input) {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function authorizedKeyResult(overrides = {}) {
  return {
    allowed: true,
    key_id: KEY_ID,
    key_prefix: "hfsaa_test_AAAAAA…AAAA",
    applicant_name: "Test Developer",
    email: "developer@example.com",
    period_start: "2026-08-01",
    request_count: 1,
    monthly_limit: 1000,
    rate_limit_per_minute: 10,
    reset_at: "2026-09-01T00:00:00.000Z",
    should_alert: false,
    ...overrides,
  };
}

async function defaultTestFetch(input, init) {
  const url = fetchUrl(input);
  if (url.pathname.endsWith("/rpc/developer_api_authorize_key")) {
    return Response.json(authorizedKeyResult());
  }
  return nativeFetch(input, init);
}

globalThis.fetch = defaultTestFetch;

function apiRequest(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TEST_API_KEY}`);
  return new Request(url, { ...init, headers });
}

async function withFetchMock(mock, callback) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => mock(input, init, previous);
  try {
    return await callback();
  } finally {
    globalThis.fetch = previous;
  }
}

class MemoryR2Object {
  constructor(key, stored) {
    this.key = key;
    this.bytes = stored.bytes;
    this.customMetadata = stored.customMetadata ?? {};
    this.etag = stored.etag;
    this.httpEtag = `"${stored.etag}"`;
    this.size = this.bytes.byteLength;
    this.body = new Blob([this.bytes]).stream();
  }

  async json() {
    return JSON.parse(new TextDecoder().decode(this.bytes));
  }

  async text() {
    return new TextDecoder().decode(this.bytes);
  }
}

class MemoryR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async get(key) {
    const stored = this.objects.get(key);
    return stored ? new MemoryR2Object(key, stored) : null;
  }

  async head(key) {
    const stored = this.objects.get(key);
    return stored ? new MemoryR2Object(key, stored) : null;
  }

  async put(key, value, options = {}) {
    const existing = this.objects.get(key);
    if (options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf?.etagDoesNotMatch === "*" && existing) return null;

    const bytes = typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(await new Response(value).arrayBuffer());
    const etag = createHash("md5").update(bytes).digest("hex");
    this.objects.set(key, {
      bytes,
      customMetadata: options.customMetadata,
      etag,
    });
    return new MemoryR2Object(key, this.objects.get(key));
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list({ prefix = "" } = {}) {
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, stored]) => new MemoryR2Object(key, stored));
    return { objects, truncated: false };
  }
}

function location(id, name) {
  return {
    id,
    type: "restaurant",
    name,
    verification_url: `https://example.com/verify/${id}`,
    certification_status: "certified",
    chapter_name: null,
    address: null,
    city: null,
    state: null,
    zip_code: null,
    cuisine_type: null,
    google_place_id: null,
  };
}

async function seedSnapshot(bucket, data, datasetVersion = randomUUID()) {
  const generatedAt = "2026-08-16T12:00:00.000Z";
  const body = `${JSON.stringify({
    dataset_version: datasetVersion,
    generated_at: generatedAt,
    location_count: data.length,
    data,
  }, null, 2)}\n`;
  const checksum = createHash("sha256").update(body).digest("hex");
  const artifactKey = `snapshots/${datasetVersion}.json`;
  await bucket.put(artifactKey, body, { customMetadata: { checksumSha256: checksum } });
  await bucket.put("metadata/current.json", JSON.stringify({
    dataset_version: datasetVersion,
    generated_at: generatedAt,
    location_count: data.length,
    checksum_sha256: checksum,
    artifact_key: artifactKey,
  }));
  return { body, checksum, datasetVersion };
}

function env(bucket, rateLimitSuccess = true) {
  return {
    DATASET_BUCKET: bucket,
    ENVIRONMENT: "test",
    PUBLIC_API_BASE_URL: "https://api.example",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-only-secret",
    RESEND_API_KEY: "re_test-only-secret",
    ADMIN_API_TOKEN,
    GOOGLE_FORMS_INGEST_TOKEN,
    API_RATE_LIMITER: {
      async limit() {
        return { success: rateLimitSuccess };
      },
    },
  };
}

test("pagination remains bound to its original immutable dataset", async () => {
  const bucket = new MemoryR2Bucket();
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
  const v1 = await seedSnapshot(bucket, [location(firstId, "First"), location(secondId, "Second")]);

  const firstResponse = await worker.fetch(apiRequest("https://api.example/v1/locations?limit=1"), env(bucket));
  assert.equal(firstResponse.status, 200);
  const firstPage = await firstResponse.json();
  assert.equal(firstPage.dataset_version, v1.datasetVersion);
  assert.equal(firstPage.data[0].name, "First");
  assert.ok(firstPage.pagination.next_cursor);

  const v2 = await seedSnapshot(bucket, [location(firstId, "Changed")]);
  assert.notEqual(v2.datasetVersion, v1.datasetVersion);

  const secondResponse = await worker.fetch(apiRequest(
    `https://api.example/v1/locations?limit=1&cursor=${encodeURIComponent(firstPage.pagination.next_cursor)}`,
  ), env(bucket));
  assert.equal(secondResponse.status, 200);
  const secondPage = await secondResponse.json();
  assert.equal(secondPage.dataset_version, v1.datasetVersion);
  assert.equal(secondPage.data[0].name, "Second");
});

test("an expired cursor returns 410", async () => {
  const bucket = new MemoryR2Bucket();
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
  const snapshot = await seedSnapshot(bucket, [location(firstId, "First"), location(secondId, "Second")]);
  const firstResponse = await worker.fetch(apiRequest("https://api.example/v1/locations?limit=1"), env(bucket));
  const firstPage = await firstResponse.json();

  await bucket.delete(`snapshots/${snapshot.datasetVersion}.json`);
  const expired = await worker.fetch(apiRequest(
    `https://api.example/v1/locations?limit=1&cursor=${encodeURIComponent(firstPage.pagination.next_cursor)}`,
  ), env(bucket));
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error.code, "cursor_expired");
});

test("rate limiting returns 429 with Retry-After", async () => {
  const response = await worker.fetch(apiRequest("https://api.example/v1/locations", {
    headers: { "CF-Connecting-IP": "192.0.2.10" },
  }), env(new MemoryR2Bucket(), false));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal((await response.json()).error.code, "rate_limited");
});

test("dataset metadata checksum matches the exact versioned download", async () => {
  const bucket = new MemoryR2Bucket();
  const seeded = await seedSnapshot(bucket, [
    location("00000000-0000-4000-8000-000000000001", "First"),
  ]);

  const metadataResponse = await worker.fetch(apiRequest("https://api.example/v1/dataset"), env(bucket));
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.dataset_version, seeded.datasetVersion);
  assert.equal(metadata.location_count, 1);
  assert.equal(metadata.checksum.value, seeded.checksum);

  const downloadResponse = await worker.fetch(apiRequest(metadata.download_url), env(bucket));
  const downloaded = await downloadResponse.text();
  assert.equal(downloaded, seeded.body);
  assert.equal(createHash("sha256").update(downloaded).digest("hex"), metadata.checksum.value);
  assert.equal(downloadResponse.headers.get("X-Dataset-Version"), seeded.datasetVersion);
});

test("publication is atomic and superseded snapshots remain for seven days", async () => {
  const bucket = new MemoryR2Bucket();
  const sourceRows = [location("00000000-0000-4000-8000-000000000001", "First")];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(sourceRows);

  const snapshotEnv = {
    ...env(bucket),
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-only-secret",
  };

  try {
    const firstTime = new Date("2026-08-01T06:00:00.000Z");
    const secondTime = new Date("2026-08-02T06:00:00.000Z");
    const first = await publishSnapshot(snapshotEnv, firstTime);
    const second = await publishSnapshot(snapshotEnv, secondTime);
    assert.notEqual(first.dataset_version, second.dataset_version);

    const current = await (await bucket.get("metadata/current.json")).json();
    assert.equal(current.dataset_version, second.dataset_version);
    assert.ok(await bucket.head(`snapshots/${first.dataset_version}.json`));

    const marker = await (await bucket.get(`retention/${first.dataset_version}.json`)).json();
    assert.equal(marker.superseded_at, secondTime.toISOString());
    assert.equal(marker.delete_after, "2026-08-09T06:00:00.000Z");

    await reconcileSnapshotRetention(snapshotEnv, new Date("2026-08-09T05:59:59.000Z"));
    assert.ok(await bucket.head(`snapshots/${first.dataset_version}.json`));

    await reconcileSnapshotRetention(snapshotEnv, new Date("2026-08-09T06:00:00.000Z"));
    assert.equal(await bucket.head(`snapshots/${first.dataset_version}.json`), null);
    assert.ok(await bucket.head(`snapshots/${second.dataset_version}.json`));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("protected data routes require an API key", async () => {
  const response = await worker.fetch(new Request("https://api.example/v1/locations"), env(new MemoryR2Bucket()));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "invalid_api_key");
  assert.equal(response.headers.get("WWW-Authenticate"), "Bearer");
});

test("authorized responses expose monthly quota headers", async () => {
  const bucket = new MemoryR2Bucket();
  await seedSnapshot(bucket, [location("00000000-0000-4000-8000-000000000001", "First")]);
  const response = await worker.fetch(apiRequest("https://api.example/v1/locations"), env(bucket));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-RateLimit-Limit"), "1000");
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "999");
  assert.equal(response.headers.get("X-RateLimit-Reset"), String(Date.parse("2026-09-01T00:00:00.000Z") / 1000));
});

test("the developer form explains that test keys do not expire", async () => {
  const response = await worker.fetch(new Request("https://api.example/developer/apply"), env(new MemoryR2Bucket()));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Test keys do not expire automatically/i);
  assert.match(body, /name="requested_tier"/);
});

test("the developer application route redirects to the configured external form", async () => {
  const testEnv = env(new MemoryR2Bucket());
  testEnv.DEVELOPER_APPLICATION_FORM_URL = "https://docs.google.com/forms/d/e/test-form/viewform";

  const response = await worker.fetch(new Request("https://api.example/developer/apply"), testEnv);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), testEnv.DEVELOPER_APPLICATION_FORM_URL);
});

test("an application stores only a verification hash and sends the verification template", async () => {
  const calls = [];
  await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    calls.push({ url, init });
    if (url.pathname.endsWith("/rpc/developer_api_submit_application")) {
      return Response.json({ application_id: APPLICATION_ID, should_send_verification: true });
    }
    if (url.hostname === "api.resend.com") return Response.json({ id: "email-id" }, { status: 200 });
    return previous(input, init);
  }, async () => {
    const response = await worker.fetch(new Request("https://api.example/v1/developer/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        applicant_name: "Test Developer",
        email: "Developer@Example.com",
        organization: "Example",
        website: "https://example.com",
        requested_tier: "test",
        expected_monthly_requests: 500,
        use_case: "Build an early-stage integration.",
      }),
    }), env(new MemoryR2Bucket()));
    assert.equal(response.status, 202);
  });

  const rpc = calls.find((call) => call.url.pathname.endsWith("/rpc/developer_api_submit_application"));
  const rpcBody = JSON.parse(rpc.init.body);
  assert.equal(rpcBody.p_email, "developer@example.com");
  assert.match(rpcBody.p_verification_token_hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(rpc.init.body, /hfsaa_(test|live)_/);

  const emailCall = calls.find((call) => call.url.hostname === "api.resend.com");
  const emailBody = JSON.parse(emailCall.init.body);
  assert.equal(emailBody.template.id, "api-access-verify-email");
  assert.match(emailBody.template.variables.VERIFICATION_URL, /\/v1\/developer\/verify\?token=/);
});

test("a claim response reveals a test key once while sending only hashes to Supabase", async () => {
  let rpcBody;
  const response = await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    if (url.pathname.endsWith("/rpc/developer_api_claim_key")) {
      rpcBody = JSON.parse(init.body);
      return Response.json({ claimed: true, environment: "test", monthly_limit: 1000, rate_limit_per_minute: 10 });
    }
    return previous(input, init);
  }, () => worker.fetch(new Request("https://api.example/v1/developer/keys/claim", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ token: "claim-token" }),
  }), env(new MemoryR2Bucket())));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.api_key, /^hfsaa_test_[A-Za-z0-9_-]{43}$/);
  assert.match(rpcBody.p_test_key_hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(rpcBody), new RegExp(body.api_key));
  assert.doesNotMatch(JSON.stringify(rpcBody), /claim-token/);
});

test("opening a one-time email link does not consume it before confirmation", async () => {
  let rpcCalled = false;
  const response = await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    if (url.pathname.endsWith("/rpc/developer_api_claim_key")) rpcCalled = true;
    return previous(input, init);
  }, () => worker.fetch(new Request("https://api.example/v1/developer/keys/claim?token=claim-token"), env(new MemoryR2Bucket())));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Generate and reveal key/);
  assert.equal(rpcCalled, false);
});

test("an administrator can approve a verified application and send a one-time claim link", async () => {
  const calls = [];
  const response = await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    calls.push({ url, init });
    if (url.pathname.endsWith("/rpc/developer_api_approve_application")) {
      return Response.json({
        approved: true,
        application_id: APPLICATION_ID,
        applicant_name: "Test Developer",
        email: "developer@example.com",
        requested_tier: "test",
        monthly_limit: 1000,
        rate_limit_per_minute: 10,
      });
    }
    if (url.hostname === "api.resend.com") return Response.json({ id: "email-id" });
    return previous(input, init);
  }, () => worker.fetch(new Request(`https://api.example/v1/admin/api-applications/${APPLICATION_ID}/approve`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ADMIN_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  }), env(new MemoryR2Bucket())));

  assert.equal(response.status, 200);
  const emailBody = JSON.parse(calls.find((call) => call.url.hostname === "api.resend.com").init.body);
  assert.equal(emailBody.template.id, "api-access-key-ready");
  assert.match(emailBody.template.variables.CLAIM_URL, /\/v1\/developer\/keys\/claim\?token=/);
});

test("the administrator browser form can approve an application", async () => {
  const testEnv = env(new MemoryR2Bucket());
  const loginResponse = await worker.fetch(new Request("https://api.example/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `admin_token=${encodeURIComponent(ADMIN_API_TOKEN)}`,
  }), testEnv);
  const cookie = loginResponse.headers.get("Set-Cookie").split(";", 1)[0];
  let approvalBody;

  const response = await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    if (url.pathname.endsWith("/rpc/developer_api_approve_application")) {
      approvalBody = JSON.parse(init.body);
      return Response.json({
        approved: true,
        application_id: APPLICATION_ID,
        applicant_name: "Test Developer",
        email: "developer@example.com",
        requested_tier: "test",
        monthly_limit: 50,
        rate_limit_per_minute: 10,
      });
    }
    if (url.hostname === "api.resend.com") return Response.json({ id: "email-id" });
    return previous(input, init);
  }, () => worker.fetch(new Request(`https://api.example/admin/applications/${APPLICATION_ID}/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookie,
      "Origin": "https://api.example",
    },
    body: "monthly_limit=50",
  }), testEnv));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "/admin");
  assert.equal(approvalBody.p_monthly_limit, 50);
});

test("an administrator can list keys and inspect per-endpoint usage", async () => {
  const rpcCalls = [];
  await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    if (url.pathname.endsWith("/rpc/developer_api_list_keys")) {
      rpcCalls.push({ name: "list", body: JSON.parse(init.body) });
      return Response.json({ data: [{ id: KEY_ID, key_prefix: "hfsaa_test_AAAAAA…AAAA", current_month_requests: 12 }] });
    }
    if (url.pathname.endsWith("/rpc/developer_api_key_usage")) {
      rpcCalls.push({ name: "usage", body: JSON.parse(init.body) });
      return Response.json({ found: true, key: { id: KEY_ID }, monthly: [], daily: [{ endpoint: "/v1/locations", request_count: 12 }] });
    }
    return previous(input, init);
  }, async () => {
    const headers = { "Authorization": `Bearer ${ADMIN_API_TOKEN}` };
    const keysResponse = await worker.fetch(new Request("https://api.example/v1/admin/api-keys?status=active&environment=test", { headers }), env(new MemoryR2Bucket()));
    assert.equal(keysResponse.status, 200);
    assert.equal((await keysResponse.json()).data[0].current_month_requests, 12);

    const usageResponse = await worker.fetch(new Request(`https://api.example/v1/admin/api-keys/${KEY_ID}/usage?days=30`, { headers }), env(new MemoryR2Bucket()));
    assert.equal(usageResponse.status, 200);
    assert.equal((await usageResponse.json()).daily[0].endpoint, "/v1/locations");
  });

  assert.deepEqual(rpcCalls, [
    { name: "list", body: { p_status: "active", p_environment: "test" } },
    { name: "usage", body: { p_key_id: KEY_ID, p_days: 30 } },
  ]);
});

test("crossing the usage threshold schedules one usage-alert template", async () => {
  const bucket = new MemoryR2Bucket();
  await seedSnapshot(bucket, [location("00000000-0000-4000-8000-000000000001", "First")]);
  const emailBodies = [];
  const waitUntil = [];

  await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    if (url.pathname.endsWith("/rpc/developer_api_authorize_key")) {
      return Response.json(authorizedKeyResult({ request_count: 800, should_alert: true }));
    }
    if (url.hostname === "api.resend.com") {
      emailBodies.push(JSON.parse(init.body));
      return Response.json({ id: "email-id" });
    }
    return previous(input, init);
  }, async () => {
    const response = await worker.fetch(apiRequest("https://api.example/v1/locations"), env(bucket), {
      waitUntil(promise) { waitUntil.push(promise); },
    });
    assert.equal(response.status, 200);
    await Promise.all(waitUntil);
  });

  assert.equal(emailBodies.length, 1);
  assert.equal(emailBodies[0].template.id, "api-access-usage-alert");
  assert.equal(emailBodies[0].template.variables.USAGE_PERCENT, "80");
});

test("Google Forms ingestion requires its dedicated secret", async () => {
  const response = await worker.fetch(new Request("https://api.example/v1/integrations/google-forms/applications", {
    method: "POST",
    headers: { "Authorization": "Bearer wrong-secret", "Content-Type": "application/json" },
    body: "{}",
  }), env(new MemoryR2Bucket()));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "unauthorized");
});

test("Google Forms retries reuse the verification token and Resend idempotency key", async () => {
  const rpcBodies = [];
  const emailCalls = [];
  const submit = () => worker.fetch(new Request("https://api.example/v1/integrations/google-forms/applications", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GOOGLE_FORMS_INGEST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_response_id: "form-response-123",
      applicant_name: "Form Developer",
      email: "form@example.com",
      organization: "Example",
      website: "https://example.com",
      requested_tier: "test",
      expected_monthly_requests: 250,
      use_case: "Develop and test an integration.",
    }),
  }), env(new MemoryR2Bucket()));

  await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    if (url.pathname.endsWith("/rpc/developer_api_submit_external_application")) {
      rpcBodies.push(JSON.parse(init.body));
      return Response.json({ application_id: APPLICATION_ID, should_send_verification: true });
    }
    if (url.hostname === "api.resend.com") {
      emailCalls.push({ body: JSON.parse(init.body), idempotency: init.headers["Idempotency-Key"] });
      return Response.json({ id: "email-id" });
    }
    return previous(input, init);
  }, async () => {
    assert.equal((await submit()).status, 202);
    assert.equal((await submit()).status, 202);
  });

  assert.equal(rpcBodies.length, 2);
  assert.equal(rpcBodies[0].p_verification_token_hash, rpcBodies[1].p_verification_token_hash);
  assert.equal(rpcBodies[0].p_submission_source, "google_forms");
  assert.equal(rpcBodies[0].p_source_reference, "form-response-123");
  assert.equal(emailCalls[0].idempotency, emailCalls[1].idempotency);
  assert.equal(emailCalls[0].body.template.variables.VERIFICATION_URL, emailCalls[1].body.template.variables.VERIFICATION_URL);
  assert.doesNotMatch(JSON.stringify(rpcBodies), /token=|hfsaa_test_/);
});

test("management-link requests do not reveal whether an email is eligible", async () => {
  let emailSent = false;
  const response = await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    if (url.pathname.endsWith("/rpc/developer_api_create_management_token")) {
      return Response.json({ should_send: false });
    }
    if (url.hostname === "api.resend.com") emailSent = true;
    return previous(input, init);
  }, () => worker.fetch(new Request("https://api.example/v1/developer/manage/request", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html" },
    body: "email=unknown%40example.com",
  }), env(new MemoryR2Bucket())));

  assert.equal(response.status, 202);
  assert.match(await response.text(), /If that address is eligible/i);
  assert.equal(emailSent, false);
});

test("an eligible developer receives a one-time management link", async () => {
  const calls = [];
  await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    if (url.pathname.endsWith("/rpc/developer_api_create_management_token")) {
      return Response.json({ should_send: true, email: "developer@example.com", applicant_name: "Test Developer" });
    }
    if (url.hostname === "api.resend.com") {
      calls.push(JSON.parse(init.body));
      return Response.json({ id: "email-id" });
    }
    return previous(input, init);
  }, async () => {
    const response = await worker.fetch(new Request("https://api.example/v1/developer/manage/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "developer@example.com" }),
    }), env(new MemoryR2Bucket()));
    assert.equal(response.status, 202);
  });
  assert.equal(calls[0].template.id, "api-access-manage-link");
  assert.match(calls[0].template.variables.MANAGE_URL, /\/v1\/developer\/manage\/verify\?token=/);
  assert.equal(calls[0].template.variables.EXPIRATION_MINUTES, "15");
});

test("a management link becomes a secure short-lived session cookie", async () => {
  let rpcBody;
  const response = await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    if (url.pathname.endsWith("/rpc/developer_api_exchange_management_token")) {
      rpcBody = JSON.parse(init.body);
      return Response.json({ authenticated: true, email: "developer@example.com" });
    }
    return previous(input, init);
  }, () => worker.fetch(new Request("https://api.example/v1/developer/manage/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "token=one-time-token",
  }), env(new MemoryR2Bucket())));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "/developer/dashboard");
  const cookie = response.headers.get("Set-Cookie");
  assert.match(cookie, /^hfsaa_developer_session=/);
  assert.match(cookie, /Secure; HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(cookie, /one-time-token/);
  assert.match(rpcBody.p_token_hash, /^[0-9a-f]{64}$/);
  assert.match(rpcBody.p_session_hash, /^[0-9a-f]{64}$/);
});

test("the developer browser form can rotate an active key", async () => {
  let rotationBody;
  let emailBody;
  const response = await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    if (url.pathname.endsWith("/rpc/developer_api_rotate_own_key")) {
      rotationBody = JSON.parse(init.body);
      return Response.json({
        authenticated: true,
        rotated: true,
        applicant_name: "Test Developer",
        email: "developer@example.com",
      });
    }
    if (url.hostname === "api.resend.com") {
      emailBody = JSON.parse(init.body);
      return Response.json({ id: "email-id" });
    }
    return previous(input, init);
  }, () => worker.fetch(new Request(`https://api.example/v1/developer/manage/keys/${KEY_ID}/rotate`, {
    method: "POST",
    headers: {
      "Cookie": "hfsaa_developer_session=session-token",
      "Origin": "https://api.example",
    },
  }), env(new MemoryR2Bucket())));

  assert.equal(response.status, 200);
  assert.match(await response.text(), /The old key has been disabled/i);
  assert.equal(rotationBody.p_key_id, KEY_ID);
  assert.match(rotationBody.p_session_hash, /^[0-9a-f]{64}$/);
  assert.equal(emailBody.template.id, "api-access-key-ready");
});

test("the developer dashboard shows prefixes and usage but never a full API key", async () => {
  const response = await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    if (url.pathname.endsWith("/rpc/developer_api_management_overview")) {
      return Response.json({
        authenticated: true,
        email: "developer@example.com",
        applicant_name: "Test Developer",
        reset_at: "2026-09-01T00:00:00.000Z",
        applications: [{ id: APPLICATION_ID, requested_tier: "test", status: "approved", created_at: "2026-08-01T00:00:00.000Z" }],
        keys: [{
          id: KEY_ID,
          key_prefix: "hfsaa_test_AAAAAA…AAAA",
          environment: "test",
          status: "active",
          monthly_limit: 1000,
          current_month_requests: 12,
          last_used_at: "2026-08-20T00:00:00.000Z",
        }],
      });
    }
    return previous(input, init);
  }, () => worker.fetch(new Request("https://api.example/developer/dashboard", {
    headers: { Cookie: "hfsaa_developer_session=session-token" },
  }), env(new MemoryR2Bucket())));

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /hfsaa_test_AAAAAA…AAAA/);
  assert.match(body, /12 \/ 1,000/);
  assert.doesNotMatch(body, new RegExp(TEST_API_KEY));
  assert.match(body, /cannot display an existing full key/i);
});

test("administrator browser sign-in creates a signed session despite unreliable origin metadata", async () => {
  const loginResponse = await worker.fetch(new Request("https://api.example/admin/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://browser-context.example",
    },
    body: `admin_token=${encodeURIComponent(ADMIN_API_TOKEN)}`,
  }), env(new MemoryR2Bucket()));
  assert.equal(loginResponse.status, 303);
  const setCookie = loginResponse.headers.get("Set-Cookie");
  assert.match(setCookie, /^hfsaa_admin_session=/);
  assert.doesNotMatch(setCookie, new RegExp(ADMIN_API_TOKEN));
  const cookie = setCookie.split(";", 1)[0];

  const dashboardResponse = await withFetchMock(async (input, init, previous) => {
    const url = fetchUrl(input);
    if (url.pathname === "/rest/v1/developer_api_applications") return Response.json([]);
    if (url.pathname.endsWith("/rpc/developer_api_list_keys")) return Response.json({ data: [] });
    return previous(input, init);
  }, () => worker.fetch(new Request("https://api.example/admin", { headers: { Cookie: cookie } }), env(new MemoryR2Bucket())));
  assert.equal(dashboardResponse.status, 200);
  assert.match(await dashboardResponse.text(), /API administration/);
});

test("administrator browser sign-in rejects an invalid token despite unreliable origin metadata", async () => {
  const response = await worker.fetch(new Request("https://api.example/admin/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://browser-context.example",
    },
    body: "admin_token=not-the-admin-token",
  }), env(new MemoryR2Bucket()));

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.match(await response.text(), /administrator token is invalid/i);
});

test("administrator browser mutations still reject cross-site requests", async () => {
  const response = await worker.fetch(new Request("https://api.example/admin/logout", {
    method: "POST",
    headers: { "Origin": "https://browser-context.example" },
  }), env(new MemoryR2Bucket()));

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: { code: "forbidden", message: "Cross-site requests are not allowed." },
  });
});

