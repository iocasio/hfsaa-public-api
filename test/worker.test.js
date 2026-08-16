import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import worker, { publishSnapshot, reconcileSnapshotRetention } from "../src/index.js";

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

  const firstResponse = await worker.fetch(new Request("https://api.example/v1/locations?limit=1"), env(bucket));
  assert.equal(firstResponse.status, 200);
  const firstPage = await firstResponse.json();
  assert.equal(firstPage.dataset_version, v1.datasetVersion);
  assert.equal(firstPage.data[0].name, "First");
  assert.ok(firstPage.pagination.next_cursor);

  const v2 = await seedSnapshot(bucket, [location(firstId, "Changed")]);
  assert.notEqual(v2.datasetVersion, v1.datasetVersion);

  const secondResponse = await worker.fetch(new Request(
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
  const firstResponse = await worker.fetch(new Request("https://api.example/v1/locations?limit=1"), env(bucket));
  const firstPage = await firstResponse.json();

  await bucket.delete(`snapshots/${snapshot.datasetVersion}.json`);
  const expired = await worker.fetch(new Request(
    `https://api.example/v1/locations?limit=1&cursor=${encodeURIComponent(firstPage.pagination.next_cursor)}`,
  ), env(bucket));
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error.code, "cursor_expired");
});

test("rate limiting returns 429 with Retry-After", async () => {
  const response = await worker.fetch(new Request("https://api.example/v1/locations", {
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

  const metadataResponse = await worker.fetch(new Request("https://api.example/v1/dataset"), env(bucket));
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.dataset_version, seeded.datasetVersion);
  assert.equal(metadata.location_count, 1);
  assert.equal(metadata.checksum.value, seeded.checksum);

  const downloadResponse = await worker.fetch(new Request(metadata.download_url), env(bucket));
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
