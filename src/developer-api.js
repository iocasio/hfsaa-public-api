import { error, html, privateJson, serviceUnavailable } from "./http.js";

const BODY_LIMIT_BYTES = 16 * 1024;
const VERIFY_MINUTES = 24 * 60;
const CLAIM_MINUTES = 30;
const MANAGEMENT_LINK_MINUTES = 15;
const MANAGEMENT_SESSION_HOURS = 8;
const ADMIN_SESSION_HOURS = 8;
const MANAGEMENT_COOKIE = "hfsaa_developer_session";
const ADMIN_COOKIE = "hfsaa_admin_session";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const API_KEY_PATTERN = /^hfsaa_(test|live)_[A-Za-z0-9_-]{43}$/;

const TEMPLATE = {
  verify: "api-access-verify-email",
  keyReady: "api-access-key-ready",
  denied: "api-access-application-denied",
  usage: "api-access-usage-alert",
  revoked: "api-access-key-revoked",
  manage: "api-access-manage-link",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function page(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} · HFSAA Developer API</title>
  <style>
    :root { color-scheme: light; font-family: Arial, sans-serif; color: #17211d; background: #f4f7f5; }
    body { margin: 0; }
    header { background: #0b5d45; color: white; padding: 20px max(20px, calc((100% - 720px) / 2)); font-weight: 700; }
    main { max-width: 960px; margin: 36px auto; padding: 0 20px; }
    section { background: white; border: 1px solid #dfe8e3; border-radius: 12px; padding: 28px; }
    h1 { color: #12372b; font-size: 28px; margin: 0 0 14px; }
    h2 { color: #12372b; font-size: 20px; margin: 28px 0 12px; }
    p { line-height: 1.6; }
    label { display: block; font-weight: 700; margin-top: 18px; }
    input, select, textarea { box-sizing: border-box; width: 100%; margin-top: 7px; padding: 11px; border: 1px solid #aebdb6; border-radius: 7px; font: inherit; }
    textarea { min-height: 130px; resize: vertical; }
    button { margin-top: 22px; border: 0; border-radius: 8px; background: #0b5d45; color: white; padding: 13px 20px; font: inherit; font-weight: 700; cursor: pointer; }
    button.danger { background: #a12d2d; }
    a { color: #075d45; }
    .button { display: inline-block; margin-top: 12px; border-radius: 8px; background: #0b5d45; color: white; padding: 11px 16px; font-weight: 700; text-decoration: none; }
    code { display: block; overflow-wrap: anywhere; border: 1px solid #b7c8c0; border-radius: 8px; background: #eef4f1; padding: 16px; font-size: 15px; }
    .note { color: #56645e; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; }
    .card { border: 1px solid #dfe8e3; border-radius: 10px; padding: 18px; }
    .card h2 { margin-top: 0; }
    .metric { font-size: 28px; font-weight: 700; color: #12372b; }
    .badge { display: inline-block; border-radius: 999px; background: #e4efe9; padding: 4px 9px; font-size: 12px; font-weight: 700; text-transform: capitalize; }
    .badge.revoked, .badge.denied { background: #fae4e4; color: #812020; }
    .badge.production { background: #e7e8fa; color: #292e78; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid #dfe8e3; padding: 10px 8px; text-align: left; vertical-align: top; }
    th { color: #4d5d56; }
    .scroll { overflow-x: auto; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .actions form, .actions button { margin: 0; }
    .inline { display: inline; }
    .topline { display: flex; justify-content: space-between; gap: 16px; align-items: center; flex-wrap: wrap; }
  </style>
</head>
<body><header>HFSAA Developer API</header><main><section>${content}</section></main></body>
</html>`;
}

function applicationForm(url) {
  const productionSelected = url.searchParams.get("tier") === "production";
  return page("Apply for API access", `
    <h1>Apply for HFSAA API access</h1>
    <p>Test access is intended for development and early-stage products. Test keys do not expire automatically, but they are limited to the test environment and its usage quota.</p>
    <form method="post" action="/v1/developer/applications">
      <label>Name<input name="applicant_name" autocomplete="name" maxlength="120" required></label>
      <label>Email<input name="email" type="email" autocomplete="email" maxlength="320" required></label>
      <label>Organization<input name="organization" autocomplete="organization" maxlength="160"></label>
      <label>Website<input name="website" type="url" maxlength="500" placeholder="https://example.com"></label>
      <label>Access type
        <select name="requested_tier">
          <option value="test"${productionSelected ? "" : " selected"}>Test — development and early-stage use</option>
          <option value="production"${productionSelected ? " selected" : ""}>Production — paid capacity review</option>
        </select>
      </label>
      <label>Expected monthly requests<input name="expected_monthly_requests" type="number" min="1" max="100000000"></label>
      <label>How will you use the API?<textarea name="use_case" maxlength="2000" required></textarea></label>
      <button type="submit">Submit request</button>
    </form>
    <p class="note">We verify the email address before placing the request into HFSAA's review queue.</p>`);
}

function acceptsHtml(request) {
  return request.headers.get("Accept")?.includes("text/html")
    || request.headers.get("Content-Type")?.includes("application/x-www-form-urlencoded");
}

async function readLimitedText(request) {
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT_BYTES) {
    throw new Error("request_body_too_large");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_LIMIT_BYTES) {
      await reader.cancel();
      throw new Error("request_body_too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function requestBody(request) {
  const text = await readLimitedText(request);
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType === "application/json") {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (contentType === "application/x-www-form-urlencoded") {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return null;
}

function normalizedText(value, maxLength, required = false) {
  if (typeof value !== "string") return required ? null : "";
  const normalized = value.trim().replace(/\s+/g, " ");
  if ((required && !normalized) || normalized.length > maxLength) return null;
  return normalized;
}

function applicationInput(body) {
  const applicantName = normalizedText(body?.applicant_name, 120, true);
  const email = normalizedText(body?.email, 320, true)?.toLowerCase() ?? null;
  const organization = normalizedText(body?.organization, 160);
  const website = normalizedText(body?.website, 500);
  const useCase = normalizedText(body?.use_case, 2000, true);
  const requestedTier = body?.requested_tier === "production" ? "production" : body?.requested_tier === "test" ? "test" : null;
  const expected = body?.expected_monthly_requests === "" || body?.expected_monthly_requests == null
    ? null
    : Number(body.expected_monthly_requests);

  if (!applicantName || !email || !EMAIL_PATTERN.test(email) || !useCase || !requestedTier) return null;
  if (website) {
    try {
      const parsed = new URL(website);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    } catch {
      return null;
    }
  }
  if (expected !== null && (!Number.isInteger(expected) || expected < 1 || expected > 100_000_000)) return null;

  return {
    applicant_name: applicantName,
    email,
    organization: organization || null,
    website: website || null,
    use_case: useCase,
    requested_tier: requestedTier,
    expected_monthly_requests: expected,
  };
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacBytes(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function hmacHex(secret, value) {
  return [...await hmacBytes(secret, value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deterministicToken(secret, value) {
  return btoa(String.fromCharCode(...await hmacBytes(secret, value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function cookieValue(request, name) {
  const cookies = request.headers.get("Cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) return cookie.slice(separator + 1).trim();
  }
  return null;
}

function secureCookie(name, value, maxAge, path = "/") {
  return `${name}=${value}; Max-Age=${maxAge}; Path=${path}; Secure; HttpOnly; SameSite=Strict`;
}

function clearCookie(name, path = "/") {
  return `${name}=; Max-Age=0; Path=${path}; Secure; HttpOnly; SameSite=Strict`;
}

function redirect(path, headers = {}) {
  return html("", 303, { Location: path, ...headers });
}

function sameOriginRequest(request) {
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(request.url).origin;
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return !fetchSite || fetchSite === "same-origin";
}

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

function formatDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Never";
  return new Date(value).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function supabaseHeaders(env, write = false) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("missing_supabase_service_role_key");
  return {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Accept-Profile": "public",
    ...(write ? { "Content-Profile": "public", "Content-Type": "application/json" } : {}),
  };
}

async function supabaseRpc(env, functionName, body) {
  const response = await fetch(new URL(`/rest/v1/rpc/${functionName}`, env.SUPABASE_URL), {
    method: "POST",
    headers: supabaseHeaders(env, true),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`supabase_request_failed:${response.status}`);
  return response.json();
}

async function supabaseSelect(env, table, params) {
  const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
  for (const [key, value] of params) url.searchParams.append(key, value);
  const response = await fetch(url, { headers: supabaseHeaders(env) });
  if (!response.ok) throw new Error(`supabase_request_failed:${response.status}`);
  const result = await response.json();
  if (!Array.isArray(result)) throw new Error("supabase_response_invalid");
  return result;
}

async function sendTemplateEmail(env, to, template, variables, idempotencyKey) {
  if (!env.RESEND_API_KEY) throw new Error("missing_resend_api_key");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ to: [to], template: { id: template, variables } }),
  });
  if (!response.ok) throw new Error(`resend_request_failed:${response.status}`);
}

function absoluteUrl(request, env, path) {
  const base = env.PUBLIC_API_BASE_URL || new URL(request.url).origin;
  return new URL(path, base).toString();
}

async function enforceApplicationRateLimit(request, env) {
  if (!env.API_RATE_LIMITER) return null;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.API_RATE_LIMITER.limit({ key: `application:${ip}` });
  return success ? null : error("rate_limited", "Too many applications. Try again in one minute.", 429, { "Retry-After": "60" });
}

async function submitApplication(request, env) {
  const limited = await enforceApplicationRateLimit(request, env);
  if (limited) return limited;

  let body;
  try {
    body = await requestBody(request);
  } catch (caught) {
    if (caught instanceof Error && caught.message === "request_body_too_large") {
      return error("request_too_large", "The request body is too large.", 413);
    }
    throw caught;
  }
  const input = applicationInput(body);
  if (!input) return error("invalid_application", "Review the application fields and try again.", 400);

  const verificationToken = randomToken();
  const verificationHash = await sha256Hex(verificationToken);
  const result = await supabaseRpc(env, "developer_api_submit_application", {
    p_applicant_name: input.applicant_name,
    p_email: input.email,
    p_organization: input.organization,
    p_website: input.website,
    p_use_case: input.use_case,
    p_requested_tier: input.requested_tier,
    p_expected_monthly_requests: input.expected_monthly_requests,
    p_verification_token_hash: verificationHash,
    p_verification_expires_at: new Date(Date.now() + VERIFY_MINUTES * 60_000).toISOString(),
  });

  if (result?.should_send_verification) {
    const verificationUrl = absoluteUrl(request, env, `/v1/developer/verify?token=${encodeURIComponent(verificationToken)}`);
    await sendTemplateEmail(env, input.email, TEMPLATE.verify, {
      APPLICANT_NAME: input.applicant_name,
      VERIFICATION_URL: verificationUrl,
      EXPIRATION_MINUTES: String(VERIFY_MINUTES),
    }, `application-${result.application_id}-verify-${verificationHash.slice(0, 16)}`);
  }

  if (acceptsHtml(request)) {
    return html(page("Check your email", "<h1>Check your email</h1><p>If the request can proceed, HFSAA will send verification instructions to the submitted address. After verification, the request enters the manual review queue.</p>"), 202);
  }
  return privateJson({ status: "verification_required" }, 202);
}

async function submitGoogleFormApplication(request, env) {
  if (!env.GOOGLE_FORMS_INGEST_TOKEN) {
    return serviceUnavailable("Google Forms ingestion is not configured.");
  }
  const supplied = bearerToken(request);
  if (!supplied || !await constantTimeEqual(supplied, env.GOOGLE_FORMS_INGEST_TOKEN)) {
    return error("unauthorized", "A valid ingestion token is required.", 401, { "WWW-Authenticate": "Bearer" });
  }

  let body;
  try {
    body = await requestBody(request);
  } catch (caught) {
    if (caught instanceof Error && caught.message === "request_body_too_large") {
      return error("request_too_large", "The request body is too large.", 413);
    }
    throw caught;
  }
  const input = applicationInput(body);
  const sourceReference = normalizedText(body?.source_response_id, 200, true);
  if (!input || !sourceReference) {
    return error("invalid_application", "Review the application fields and try again.", 400);
  }

  const verificationToken = await deterministicToken(
    env.GOOGLE_FORMS_INGEST_TOKEN,
    `google_forms:${sourceReference}:${input.email}`,
  );
  const verificationHash = await sha256Hex(verificationToken);
  const result = await supabaseRpc(env, "developer_api_submit_external_application", {
    p_applicant_name: input.applicant_name,
    p_email: input.email,
    p_organization: input.organization,
    p_website: input.website,
    p_use_case: input.use_case,
    p_requested_tier: input.requested_tier,
    p_expected_monthly_requests: input.expected_monthly_requests,
    p_verification_token_hash: verificationHash,
    p_verification_expires_at: new Date(Date.now() + VERIFY_MINUTES * 60_000).toISOString(),
    p_submission_source: "google_forms",
    p_source_reference: sourceReference,
  });

  if (result?.should_send_verification) {
    const verificationUrl = absoluteUrl(request, env, `/v1/developer/verify?token=${encodeURIComponent(verificationToken)}`);
    await sendTemplateEmail(env, input.email, TEMPLATE.verify, {
      APPLICANT_NAME: input.applicant_name,
      VERIFICATION_URL: verificationUrl,
      EXPIRATION_MINUTES: String(VERIFY_MINUTES),
    }, `google-form-${(await sha256Hex(sourceReference)).slice(0, 32)}`);
  }

  return privateJson({ status: "accepted" }, 202);
}

function oneTimeActionPage(title, message, action, token, buttonLabel) {
  return page(title, `
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <form method="post" action="${escapeHtml(action)}">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button type="submit">${escapeHtml(buttonLabel)}</button>
    </form>`);
}

function queryToken(request) {
  const token = new URL(request.url).searchParams.get("token");
  return token && token.length <= 200 ? token : null;
}

async function submittedToken(request) {
  const body = await requestBody(request);
  return typeof body?.token === "string" && body.token.length <= 200 ? body.token : null;
}

async function verifyApplication(request, env) {
  const token = await submittedToken(request);
  if (!token || token.length > 200) return html(page("Invalid link", "<h1>Invalid verification link</h1><p>Submit a new API access request to receive a fresh link.</p>"), 400);
  const result = await supabaseRpc(env, "developer_api_verify_application", { p_verification_token_hash: await sha256Hex(token) });
  if (!result?.verified) return html(page("Link unavailable", "<h1>This verification link is unavailable</h1><p>It may be invalid, expired, or already used. Submit a new request if you still need access.</p>"), 400);
  return html(page("Email verified", "<h1>Email verified</h1><p>Your API access request is now in HFSAA's review queue. We will email you after it is approved or denied.</p>"));
}

async function claimKey(request, env) {
  const token = await submittedToken(request);
  if (!token || token.length > 200) return html(page("Invalid link", "<h1>Invalid claim link</h1><p>Contact HFSAA for a fresh claim link.</p>"), 400);
  const claimHash = await sha256Hex(token);
  const testKey = `hfsaa_test_${randomToken()}`;
  const liveKey = `hfsaa_live_${randomToken()}`;
  const result = await supabaseRpc(env, "developer_api_claim_key", {
    p_claim_token_hash: claimHash,
    p_test_key_hash: await sha256Hex(testKey),
    p_test_key_prefix: `${testKey.slice(0, 17)}…${testKey.slice(-4)}`,
    p_live_key_hash: await sha256Hex(liveKey),
    p_live_key_prefix: `${liveKey.slice(0, 17)}…${liveKey.slice(-4)}`,
  });
  if (!result?.claimed) return html(page("Link unavailable", "<h1>This claim link is unavailable</h1><p>It may be invalid, expired, or already used. Contact HFSAA for help.</p>"), 400);

  const apiKey = result.environment === "production" ? liveKey : testKey;
  if (!acceptsHtml(request)) {
    return privateJson({ api_key: apiKey, environment: result.environment, monthly_limit: result.monthly_limit });
  }
  return html(page("API key ready", `<h1>Your API key</h1><p>This is the only time the full key will be shown. Store it in a secret manager and never place it in client-side code.</p><code>${escapeHtml(apiKey)}</code><p class="note">The key does not expire automatically. It remains active until HFSAA revokes it and is subject to its environment and usage limits.</p>`));
}

function managementSignInPage() {
  return page("Manage API keys", `
    <h1>Manage your API keys</h1>
    <p>Enter the email address used for your HFSAA API request. If it is eligible, we will email a secure sign-in link. No account or password is required.</p>
    <form method="post" action="/v1/developer/manage/request">
      <label>Email<input name="email" type="email" autocomplete="email" maxlength="320" required></label>
      <button type="submit">Email my sign-in link</button>
    </form>
    <p class="note">For privacy, the response is the same whether or not the address is on file.</p>`);
}

async function enforceManagementRateLimit(request, env) {
  if (!env.API_RATE_LIMITER) return null;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.API_RATE_LIMITER.limit({ key: `management:${ip}` });
  return success ? null : error("rate_limited", "Too many sign-in attempts. Try again in one minute.", 429, { "Retry-After": "60" });
}

async function requestManagementLink(request, env) {
  const limited = await enforceManagementRateLimit(request, env);
  if (limited) return limited;
  const body = await requestBody(request);
  const email = normalizedText(body?.email, 320, true)?.toLowerCase() ?? null;
  if (!email || !EMAIL_PATTERN.test(email)) {
    return error("invalid_email", "Enter a valid email address.", 400);
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const result = await supabaseRpc(env, "developer_api_create_management_token", {
    p_email: email,
    p_token_hash: tokenHash,
    p_expires_at: new Date(Date.now() + MANAGEMENT_LINK_MINUTES * 60_000).toISOString(),
  });

  if (result?.should_send) {
    const manageUrl = absoluteUrl(request, env, `/v1/developer/manage/verify?token=${encodeURIComponent(token)}`);
    try {
      await sendTemplateEmail(env, result.email, TEMPLATE.manage, {
        APPLICANT_NAME: result.applicant_name,
        MANAGE_URL: manageUrl,
        EXPIRATION_MINUTES: String(MANAGEMENT_LINK_MINUTES),
      }, `management-${tokenHash.slice(0, 32)}`);
    } catch (caught) {
      console.error(JSON.stringify({
        message: "management_email_failed",
        reason: caught instanceof Error ? caught.message : "unknown_error",
      }));
    }
  }

  const message = "If that address is eligible, HFSAA will send a sign-in link shortly. The link expires in 15 minutes.";
  return acceptsHtml(request)
    ? html(page("Check your email", `<h1>Check your email</h1><p>${message}</p>`), 202)
    : privateJson({ status: "accepted", message }, 202);
}

async function verifyManagementLink(request, env) {
  const token = await submittedToken(request);
  if (!token || token.length > 200) {
    return html(page("Invalid link", "<h1>Invalid sign-in link</h1><p>Request a fresh link to manage your API keys.</p>"), 400);
  }
  const sessionToken = randomToken();
  const result = await supabaseRpc(env, "developer_api_exchange_management_token", {
    p_token_hash: await sha256Hex(token),
    p_session_hash: await sha256Hex(sessionToken),
    p_session_expires_at: new Date(Date.now() + MANAGEMENT_SESSION_HOURS * 60 * 60_000).toISOString(),
  });
  if (!result?.authenticated) {
    return html(page("Link unavailable", "<h1>This sign-in link is unavailable</h1><p>It may be invalid, expired, or already used. Request a new link to continue.</p>"), 400);
  }
  return redirect("/developer/dashboard", {
    "Set-Cookie": secureCookie(MANAGEMENT_COOKIE, sessionToken, MANAGEMENT_SESSION_HOURS * 60 * 60),
  });
}

async function managementOverview(request, env) {
  const sessionToken = cookieValue(request, MANAGEMENT_COOKIE);
  if (!sessionToken || sessionToken.length > 200) return { authenticated: false };
  const result = await supabaseRpc(env, "developer_api_management_overview", {
    p_session_hash: await sha256Hex(sessionToken),
  });
  return { ...result, sessionToken };
}

function managementDashboardPage(overview) {
  const keys = Array.isArray(overview.keys) ? overview.keys : [];
  const applications = Array.isArray(overview.applications) ? overview.applications : [];
  const keyCards = keys.length === 0
    ? "<p>No API keys have been issued yet.</p>"
    : `<div class="grid">${keys.map((key) => {
      const used = Number(key.current_month_requests ?? 0);
      const limit = Number(key.monthly_limit ?? 0);
      const percent = limit > 0 ? Math.min(100, Math.floor((used / limit) * 100)) : 0;
      const actions = key.status === "active"
        ? `<div class="actions"><a href="/developer/keys/${key.id}/rotate">Rotate key</a><a href="/developer/keys/${key.id}/revoke">Revoke key</a></div>`
        : "";
      return `<article class="card">
        <div class="topline"><h2>${escapeHtml(key.key_prefix)}</h2><span class="badge ${escapeHtml(key.status)}">${escapeHtml(key.status)}</span></div>
        <p><span class="badge ${escapeHtml(key.environment)}">${escapeHtml(key.environment)}</span></p>
        <p class="metric">${formatNumber(used)} / ${formatNumber(limit)}</p>
        <p>requests used this month (${percent}%)</p>
        <p class="note">Resets ${escapeHtml(formatDate(overview.reset_at))} · Last used ${escapeHtml(formatDate(key.last_used_at))}</p>
        ${actions}
      </article>`;
    }).join("")}</div>`;

  const applicationRows = applications.length === 0
    ? '<tr><td colspan="3">No applications found.</td></tr>'
    : applications.map((application) => `<tr>
      <td><span class="badge ${escapeHtml(application.requested_tier)}">${escapeHtml(application.requested_tier)}</span></td>
      <td><span class="badge ${escapeHtml(application.status)}">${escapeHtml(application.status.replaceAll("_", " "))}</span></td>
      <td>${escapeHtml(formatDate(application.created_at))}</td>
    </tr>`).join("");

  return page("Developer dashboard", `
    <div class="topline"><div><h1>Developer dashboard</h1><p>${escapeHtml(overview.email)}</p></div>
      <form method="post" action="/v1/developer/manage/logout"><button type="submit">Sign out</button></form>
    </div>
    <h2>API keys</h2>
    ${keyCards}
    <p class="note">For security, HFSAA cannot display an existing full key. Rotate it if you need a replacement.</p>
    <h2>Applications</h2>
    <div class="scroll"><table><thead><tr><th>Access</th><th>Status</th><th>Submitted</th></tr></thead><tbody>${applicationRows}</tbody></table></div>
    <a class="button" href="/developer/apply?tier=production">Apply for production access</a>`);
}

async function showManagementDashboard(request, env) {
  const overview = await managementOverview(request, env);
  if (!overview.authenticated) {
    return redirect("/developer/manage", { "Set-Cookie": clearCookie(MANAGEMENT_COOKIE) });
  }
  return html(managementDashboardPage(overview));
}

async function showKeyAction(request, env, keyId, action) {
  const overview = await managementOverview(request, env);
  if (!overview.authenticated) return redirect("/developer/manage", { "Set-Cookie": clearCookie(MANAGEMENT_COOKIE) });
  const key = overview.keys?.find((candidate) => candidate.id === keyId && candidate.status === "active");
  if (!key) return html(page("Key unavailable", "<h1>Key unavailable</h1><p>This key cannot be changed.</p>"), 404);
  const rotate = action === "rotate";
  return html(page(rotate ? "Rotate API key" : "Revoke API key", `
    <h1>${rotate ? "Rotate" : "Revoke"} ${escapeHtml(key.key_prefix)}?</h1>
    <p>${rotate
      ? "The current key will stop working immediately. We will email a one-time link that displays its replacement. Usage limits will remain the same."
      : "The key will stop working immediately. This cannot be undone; you would need to submit a new access request."}</p>
    <form method="post" action="/v1/developer/manage/keys/${key.id}/${action}">
      <button class="danger" type="submit">Yes, ${rotate ? "rotate" : "revoke"} this key</button>
    </form>
    <p><a href="/developer/dashboard">Cancel</a></p>`));
}

async function revokeOwnKey(request, env, keyId) {
  if (!sameOriginRequest(request)) return error("forbidden", "Cross-site requests are not allowed.", 403);
  const sessionToken = cookieValue(request, MANAGEMENT_COOKIE);
  if (!sessionToken) return redirect("/developer/manage");
  const result = await supabaseRpc(env, "developer_api_revoke_own_key", {
    p_session_hash: await sha256Hex(sessionToken),
    p_key_id: keyId,
    p_reason: "Revoked by developer",
  });
  if (!result?.authenticated) return redirect("/developer/manage", { "Set-Cookie": clearCookie(MANAGEMENT_COOKIE) });
  if (!result?.revoked) return html(page("Key unavailable", "<h1>Key unavailable</h1><p>This key could not be revoked.</p>"), 409);
  await sendTemplateEmail(env, result.email, TEMPLATE.revoked, {
    APPLICANT_NAME: result.applicant_name,
    KEY_PREFIX: result.key_prefix,
    REVOCATION_REASON: "Revoked from the developer dashboard",
  }, `key-${keyId}-developer-revoked`);
  return redirect("/developer/dashboard");
}

async function rotateOwnKey(request, env, keyId) {
  if (!sameOriginRequest(request)) return error("forbidden", "Cross-site requests are not allowed.", 403);
  const sessionToken = cookieValue(request, MANAGEMENT_COOKIE);
  if (!sessionToken) return redirect("/developer/manage");
  const claimToken = randomToken();
  const claimHash = await sha256Hex(claimToken);
  const result = await supabaseRpc(env, "developer_api_rotate_own_key", {
    p_session_hash: await sha256Hex(sessionToken),
    p_key_id: keyId,
    p_claim_token_hash: claimHash,
    p_claim_expires_at: new Date(Date.now() + CLAIM_MINUTES * 60_000).toISOString(),
  });
  if (!result?.authenticated) return redirect("/developer/manage", { "Set-Cookie": clearCookie(MANAGEMENT_COOKIE) });
  if (!result?.rotated) return html(page("Key unavailable", "<h1>Key unavailable</h1><p>This key could not be rotated.</p>"), 409);
  const claimUrl = absoluteUrl(request, env, `/v1/developer/keys/claim?token=${encodeURIComponent(claimToken)}`);
  await sendTemplateEmail(env, result.email, TEMPLATE.keyReady, {
    APPLICANT_NAME: result.applicant_name,
    CLAIM_URL: claimUrl,
    CLAIM_EXPIRATION_MINUTES: String(CLAIM_MINUTES),
  }, `key-${keyId}-rotation-${claimHash.slice(0, 16)}`);
  return html(page("Replacement ready", "<h1>Check your email</h1><p>The old key has been disabled. Use the one-time link in your email to reveal and save the replacement key.</p><p><a href=\"/developer/dashboard\">Return to dashboard</a></p>"));
}

async function logoutManagement(request, env) {
  if (!sameOriginRequest(request)) return error("forbidden", "Cross-site requests are not allowed.", 403);
  const sessionToken = cookieValue(request, MANAGEMENT_COOKIE);
  if (sessionToken) {
    await supabaseRpc(env, "developer_api_end_management_session", {
      p_session_hash: await sha256Hex(sessionToken),
    });
  }
  return redirect("/developer/manage", { "Set-Cookie": clearCookie(MANAGEMENT_COOKIE) });
}

function bearerToken(request) {
  const match = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

async function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
  }
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function createAdminSession(env) {
  const expiresAt = Math.floor(Date.now() / 1000) + ADMIN_SESSION_HOURS * 60 * 60;
  const nonce = randomToken(16);
  const signature = await hmacHex(env.ADMIN_API_TOKEN, `${expiresAt}.${nonce}`);
  return `${expiresAt}.${nonce}.${signature}`;
}

async function validAdminSession(request, env) {
  if (!env.ADMIN_API_TOKEN) return false;
  const value = cookieValue(request, ADMIN_COOKIE);
  const parts = value?.split(".") ?? [];
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || parts[1].length > 100 || !/^[0-9a-f]{64}$/.test(parts[2])) {
    return false;
  }
  const expiresAt = Number(parts[0]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(env.ADMIN_API_TOKEN, `${parts[0]}.${parts[1]}`);
  return constantTimeEqual(parts[2], expected);
}

function adminLoginPage() {
  return page("Administrator sign in", `
    <h1>HFSAA API administration</h1>
    <p>Enter the staging administrator token. The token is verified by the Worker and is not stored in the browser; an eight-hour signed session is used instead.</p>
    <form method="post" action="/admin/login">
      <label>Administrator token<input name="admin_token" type="password" autocomplete="current-password" maxlength="500" required></label>
      <button type="submit">Sign in</button>
    </form>`);
}

async function loginAdmin(request, env) {
  if (!sameOriginRequest(request)) return error("forbidden", "Cross-site requests are not allowed.", 403);
  if (!env.ADMIN_API_TOKEN) return serviceUnavailable("Administrative access is not configured.");
  const body = await requestBody(request);
  const supplied = typeof body?.admin_token === "string" ? body.admin_token : "";
  if (!supplied || !await constantTimeEqual(supplied, env.ADMIN_API_TOKEN)) {
    return html(page("Sign in failed", "<h1>Sign in failed</h1><p>The administrator token is invalid.</p><p><a href=\"/admin\">Try again</a></p>"), 401);
  }
  return redirect("/admin", {
    "Set-Cookie": secureCookie(ADMIN_COOKIE, await createAdminSession(env), ADMIN_SESSION_HOURS * 60 * 60, "/admin"),
  });
}

async function logoutAdmin(request) {
  if (!sameOriginRequest(request)) return error("forbidden", "Cross-site requests are not allowed.", 403);
  return redirect("/admin", { "Set-Cookie": clearCookie(ADMIN_COOKIE, "/admin") });
}

async function adminDashboard(request, env) {
  if (!await validAdminSession(request, env)) return html(adminLoginPage());
  const [applications, keysResult] = await Promise.all([
    supabaseSelect(env, "developer_api_applications", new URLSearchParams({
      select: "id,applicant_name,email,organization,website,use_case,requested_tier,expected_monthly_requests,status,email_verified_at,created_at",
      status: "eq.pending_review",
      order: "created_at.asc",
      limit: "100",
    })),
    supabaseRpc(env, "developer_api_list_keys", { p_status: "active", p_environment: null }),
  ]);
  const keys = Array.isArray(keysResult?.data) ? keysResult.data : [];
  const applicationCards = applications.length === 0
    ? "<p>No verified applications are waiting for review.</p>"
    : applications.map((application) => `<article class="card">
      <div class="topline"><h2>${escapeHtml(application.applicant_name)}</h2><span class="badge ${escapeHtml(application.requested_tier)}">${escapeHtml(application.requested_tier)}</span></div>
      <p><strong>${escapeHtml(application.email)}</strong>${application.organization ? ` · ${escapeHtml(application.organization)}` : ""}</p>
      <p>${escapeHtml(application.use_case)}</p>
      <p class="note">Expected monthly requests: ${application.expected_monthly_requests ? formatNumber(application.expected_monthly_requests) : "Not provided"} · Submitted ${escapeHtml(formatDate(application.created_at))}</p>
      <form method="post" action="/admin/applications/${application.id}/approve">
        <label>Monthly request limit<input name="monthly_limit" type="number" min="1" max="100000000" value="${application.requested_tier === "test" ? "1000" : "100000"}" required></label>
        <button type="submit">Approve and email claim link</button>
      </form>
      <form method="post" action="/admin/applications/${application.id}/deny">
        <label>Denial reason<input name="reason" maxlength="1000" required></label>
        <button class="danger" type="submit">Deny and notify applicant</button>
      </form>
    </article>`).join("");
  const keyRows = keys.length === 0
    ? '<tr><td colspan="6">No active keys.</td></tr>'
    : keys.map((key) => `<tr>
      <td>${escapeHtml(key.key_prefix)}</td><td><span class="badge ${escapeHtml(key.environment)}">${escapeHtml(key.environment)}</span></td>
      <td>${escapeHtml(key.email)}</td><td>${formatNumber(key.current_month_requests)} / ${formatNumber(key.monthly_limit)}</td>
      <td>${escapeHtml(formatDate(key.last_used_at))}</td>
      <td><form method="post" action="/admin/keys/${key.id}/revoke"><input name="reason" maxlength="1000" placeholder="Reason" required><button class="danger" type="submit">Revoke</button></form></td>
    </tr>`).join("");

  return html(page("API administration", `
    <div class="topline"><div><h1>API administration</h1><p>${applications.length} pending · ${keys.length} active keys</p></div>
      <form method="post" action="/admin/logout"><button type="submit">Sign out</button></form>
    </div>
    <h2>Pending applications</h2><div class="grid">${applicationCards}</div>
    <h2>Active keys</h2><div class="scroll"><table><thead><tr><th>Key</th><th>Environment</th><th>Owner</th><th>Usage</th><th>Last used</th><th>Action</th></tr></thead><tbody>${keyRows}</tbody></table></div>`));
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_API_TOKEN) return serviceUnavailable("Administrative access is not configured.");
  const supplied = bearerToken(request);
  const bearerAllowed = supplied && await constantTimeEqual(supplied, env.ADMIN_API_TOKEN);
  if (!bearerAllowed && !await validAdminSession(request, env)) {
    return error("unauthorized", "A valid administrator token is required.", 401, { "WWW-Authenticate": "Bearer" });
  }
  return null;
}

async function listApplications(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const status = new URL(request.url).searchParams.get("status") ?? "pending_review";
  if (!["email_verification_required", "pending_review", "approved", "denied"].includes(status)) {
    return error("invalid_parameter", "status is invalid.", 400);
  }
  const rows = await supabaseSelect(env, "developer_api_applications", new URLSearchParams({
    select: "id,applicant_name,email,organization,website,use_case,requested_tier,expected_monthly_requests,status,email_verified_at,decision_reason,created_at,updated_at",
    status: `eq.${status}`,
    order: "created_at.desc",
    limit: "100",
  }));
  return privateJson({ data: rows });
}

async function listKeys(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const environment = url.searchParams.get("environment");
  if (status !== null && !["active", "revoked"].includes(status)) {
    return error("invalid_parameter", "status is invalid.", 400);
  }
  if (environment !== null && !["test", "production"].includes(environment)) {
    return error("invalid_parameter", "environment is invalid.", 400);
  }
  const result = await supabaseRpc(env, "developer_api_list_keys", {
    p_status: status,
    p_environment: environment,
  });
  return privateJson(result);
}

async function keyUsage(request, env, keyId) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const rawDays = new URL(request.url).searchParams.get("days") ?? "30";
  const days = Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    return error("invalid_parameter", "days must be an integer from 1 through 90.", 400);
  }
  const result = await supabaseRpc(env, "developer_api_key_usage", {
    p_key_id: keyId,
    p_days: days,
  });
  if (!result?.found) return error("key_not_found", "API key not found.", 404);
  return privateJson(result);
}

async function approveApplication(request, env, applicationId) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const body = await requestBody(request);
  if (body === null) return error("invalid_request", "A JSON body is required.", 400);
  const monthlyLimit = body.monthly_limit == null ? null : Number(body.monthly_limit);
  if (monthlyLimit !== null && (!Number.isInteger(monthlyLimit) || monthlyLimit < 1 || monthlyLimit > 100_000_000)) {
    return error("invalid_limit", "The monthly limit must be a positive integer within the supported range.", 400);
  }

  const claimToken = randomToken();
  const claimHash = await sha256Hex(claimToken);
  const result = await supabaseRpc(env, "developer_api_approve_application", {
    p_application_id: applicationId,
    p_claim_token_hash: claimHash,
    p_claim_expires_at: new Date(Date.now() + CLAIM_MINUTES * 60_000).toISOString(),
    p_monthly_limit: monthlyLimit,
    p_rate_limit_per_minute: null,
  });
  if (!result?.approved) return error("application_not_approvable", "The application cannot be approved in its current state.", 409);
  const claimUrl = absoluteUrl(request, env, `/v1/developer/keys/claim?token=${encodeURIComponent(claimToken)}`);
  await sendTemplateEmail(env, result.email, TEMPLATE.keyReady, {
    APPLICANT_NAME: result.applicant_name,
    CLAIM_URL: claimUrl,
    CLAIM_EXPIRATION_MINUTES: String(CLAIM_MINUTES),
  }, `application-${applicationId}-claim-${claimHash.slice(0, 16)}`);
  return privateJson({ id: applicationId, status: "approved", claim_email_sent: true });
}

async function denyApplication(request, env, applicationId) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const body = await requestBody(request);
  const reason = normalizedText(body?.reason, 1000, true);
  if (!reason) return error("invalid_reason", "A review reason is required.", 400);
  const result = await supabaseRpc(env, "developer_api_deny_application", { p_application_id: applicationId, p_reason: reason });
  if (!result?.denied) return error("application_not_deniable", "The application cannot be denied in its current state.", 409);
  await sendTemplateEmail(env, result.email, TEMPLATE.denied, {
    APPLICANT_NAME: result.applicant_name,
    DECISION_MESSAGE: reason,
  }, `application-${applicationId}-denied-${await sha256Hex(reason).then((hash) => hash.slice(0, 16))}`);
  return privateJson({ id: applicationId, status: "denied", decision_email_sent: true });
}

async function revokeKey(request, env, keyId) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const body = await requestBody(request);
  const reason = normalizedText(body?.reason, 1000, true);
  if (!reason) return error("invalid_reason", "A revocation reason is required.", 400);
  const result = await supabaseRpc(env, "developer_api_revoke_key", { p_key_id: keyId, p_reason: reason });
  if (!result?.revoked) return error("key_not_revocable", "The key cannot be revoked in its current state.", 409);
  await sendTemplateEmail(env, result.email, TEMPLATE.revoked, {
    APPLICANT_NAME: result.applicant_name,
    KEY_PREFIX: result.key_prefix,
    REVOCATION_REASON: reason,
  }, `key-${keyId}-revoked`);
  return privateJson({ id: keyId, status: "revoked", notification_email_sent: true });
}

function adminRoute(path) {
  if (path === "/v1/admin/api-applications") return { action: "list" };
  if (path === "/v1/admin/api-keys") return { action: "list_keys" };
  let match = path.match(/^\/v1\/admin\/api-applications\/([0-9a-f-]+)\/(approve|deny)$/i);
  if (match && UUID_PATTERN.test(match[1])) return { action: match[2], id: match[1] };
  match = path.match(/^\/v1\/admin\/api-keys\/([0-9a-f-]+)\/(usage|revoke)$/i);
  if (match && UUID_PATTERN.test(match[1])) return { action: match[2], id: match[1] };
  return null;
}

function managementKeyRoute(path) {
  let match = path.match(/^\/developer\/keys\/([0-9a-f-]+)\/(rotate|revoke)$/i);
  if (match && UUID_PATTERN.test(match[1])) return { action: match[2], id: match[1] };
  match = path.match(/^\/v1\/developer\/manage\/keys\/([0-9a-f-]+)\/(rotate|revoke)$/i);
  if (match && UUID_PATTERN.test(match[1])) return { action: match[2], id: match[1], submit: true };
  return null;
}

function adminUiRoute(path) {
  let match = path.match(/^\/admin\/applications\/([0-9a-f-]+)\/(approve|deny)$/i);
  if (match && UUID_PATTERN.test(match[1])) return { action: match[2], id: match[1] };
  match = path.match(/^\/admin\/keys\/([0-9a-f-]+)\/revoke$/i);
  if (match && UUID_PATTERN.test(match[1])) return { action: "revoke", id: match[1] };
  return null;
}

async function handleAdminUiMutation(request, env, route) {
  if (!sameOriginRequest(request)) return error("forbidden", "Cross-site requests are not allowed.", 403);
  let response;
  if (route.action === "approve") response = await approveApplication(request, env, route.id);
  else if (route.action === "deny") response = await denyApplication(request, env, route.id);
  else response = await revokeKey(request, env, route.id);
  return response.ok ? redirect("/admin") : response;
}

function externalApplicationForm(env) {
  if (!env.DEVELOPER_APPLICATION_FORM_URL) return null;
  try {
    const url = new URL(env.DEVELOPER_APPLICATION_FORM_URL);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function isDeveloperRoute(path) {
  return path === "/developer/apply"
    || path === "/developer/manage"
    || path === "/developer/dashboard"
    || path.startsWith("/developer/keys/")
    || path === "/v1/developer/applications"
    || path === "/v1/developer/verify"
    || path === "/v1/developer/keys/claim"
    || path === "/v1/developer/manage/request"
    || path === "/v1/developer/manage/verify"
    || path === "/v1/developer/manage/logout"
    || path.startsWith("/v1/developer/manage/keys/")
    || path === "/v1/integrations/google-forms/applications"
    || path === "/admin"
    || path.startsWith("/admin/")
    || path.startsWith("/v1/admin/");
}

export async function handleDeveloperRoute(request, env, path) {
  if (path === "/developer/apply" && request.method === "GET") {
    const externalForm = externalApplicationForm(env);
    return externalForm ? Response.redirect(externalForm, 302) : html(applicationForm(new URL(request.url)));
  }
  if (path === "/v1/developer/applications" && request.method === "POST") return submitApplication(request, env);
  if (path === "/v1/developer/verify" && request.method === "GET") {
    const token = queryToken(request);
    return token
      ? html(oneTimeActionPage("Verify your email", "Confirm that you want to submit this API access request for HFSAA review.", path, token, "Verify email"))
      : html(page("Invalid link", "<h1>Invalid verification link</h1><p>Submit a new API access request to receive a fresh link.</p>"), 400);
  }
  if (path === "/v1/developer/verify" && request.method === "POST") return verifyApplication(request, env);
  if (path === "/v1/developer/keys/claim" && request.method === "GET") {
    const token = queryToken(request);
    return token
      ? html(oneTimeActionPage("Reveal your API key", "Continue only when you are ready to save the key. HFSAA will show it once.", path, token, "Generate and reveal key"))
      : html(page("Invalid link", "<h1>Invalid claim link</h1><p>Contact HFSAA for a fresh claim link.</p>"), 400);
  }
  if (path === "/v1/developer/keys/claim" && request.method === "POST") return claimKey(request, env);
  if (path === "/v1/integrations/google-forms/applications" && request.method === "POST") return submitGoogleFormApplication(request, env);
  if (path === "/developer/manage" && request.method === "GET") return html(managementSignInPage());
  if (path === "/developer/dashboard" && request.method === "GET") return showManagementDashboard(request, env);
  if (path === "/v1/developer/manage/request" && request.method === "POST") return requestManagementLink(request, env);
  if (path === "/v1/developer/manage/verify" && request.method === "GET") {
    const token = queryToken(request);
    return token
      ? html(oneTimeActionPage("Sign in to API management", "Continue to create an eight-hour secure management session.", path, token, "Continue to dashboard"))
      : html(page("Invalid link", "<h1>Invalid sign-in link</h1><p>Request a fresh link to manage your API keys.</p>"), 400);
  }
  if (path === "/v1/developer/manage/verify" && request.method === "POST") return verifyManagementLink(request, env);
  if (path === "/v1/developer/manage/logout" && request.method === "POST") return logoutManagement(request, env);

  const managementRoute = managementKeyRoute(path);
  if (managementRoute && !managementRoute.submit && request.method === "GET") {
    return showKeyAction(request, env, managementRoute.id, managementRoute.action);
  }
  if (managementRoute?.submit && request.method === "POST") {
    return managementRoute.action === "rotate"
      ? rotateOwnKey(request, env, managementRoute.id)
      : revokeOwnKey(request, env, managementRoute.id);
  }

  if (path === "/admin" && request.method === "GET") return adminDashboard(request, env);
  if (path === "/admin/login" && request.method === "POST") return loginAdmin(request, env);
  if (path === "/admin/logout" && request.method === "POST") return logoutAdmin(request);
  const uiRoute = adminUiRoute(path);
  if (uiRoute && request.method === "POST") return handleAdminUiMutation(request, env, uiRoute);

  const route = adminRoute(path);
  if (!route) return error("not_found", "Route not found.", 404);
  if (route.action === "list" && request.method === "GET") return listApplications(request, env);
  if (route.action === "list_keys" && request.method === "GET") return listKeys(request, env);
  if (route.action === "usage" && request.method === "GET") return keyUsage(request, env, route.id);
  if (route.action === "approve" && request.method === "POST") return approveApplication(request, env, route.id);
  if (route.action === "deny" && request.method === "POST") return denyApplication(request, env, route.id);
  if (route.action === "revoke" && request.method === "POST") return revokeKey(request, env, route.id);
  return error("method_not_allowed", "This route does not support the requested method.", 405);
}

function keyEnvironment(env) {
  return env.ENVIRONMENT === "production" ? "production" : "test";
}

export function isProtectedDataRoute(path) {
  return path === "/v1/locations"
    || path.startsWith("/v1/locations/")
    || path === "/v1/chapters"
    || path === "/v1/dataset"
    || path === "/v1/dataset/locations.json";
}

export async function authorizeDataRequest(request, env, path) {
  const apiKey = bearerToken(request);
  if (!apiKey || !API_KEY_PATTERN.test(apiKey)) {
    return { response: error("invalid_api_key", "Provide a valid API key as a Bearer token.", 401, { "WWW-Authenticate": "Bearer" }) };
  }
  const keyHash = await sha256Hex(apiKey);
  if (env.API_RATE_LIMITER) {
    const { success } = await env.API_RATE_LIMITER.limit({ key: `api:${keyHash}` });
    if (!success) return { response: error("rate_limited", "Too many requests. Try again in one minute.", 429, { "Retry-After": "60" }) };
  }

  const result = await supabaseRpc(env, "developer_api_authorize_key", {
    p_key_hash: keyHash,
    p_environment: keyEnvironment(env),
    p_endpoint: path.slice(0, 160),
  });
  if (!result?.allowed) {
    if (result?.reason === "quota_exceeded") {
      return { response: error("quota_exceeded", "This API key has reached its monthly request limit.", 429, { "Retry-After": String(result.retry_after_seconds ?? 3600) }) };
    }
    if (result?.reason === "revoked") return { response: error("api_key_revoked", "This API key has been revoked.", 403) };
    return { response: error("invalid_api_key", "The API key is invalid for this environment.", 401, { "WWW-Authenticate": "Bearer" }) };
  }
  return { context: result };
}

export function addUsageHeaders(response, context) {
  const headers = new Headers(response.headers);
  headers.set("X-RateLimit-Limit", String(context.monthly_limit));
  headers.set("X-RateLimit-Remaining", String(Math.max(0, context.monthly_limit - context.request_count)));
  headers.set("X-RateLimit-Reset", String(Math.floor(Date.parse(context.reset_at) / 1000)));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function scheduleUsageAlert(request, env, ctx, context) {
  if (!context.should_alert || !ctx?.waitUntil) return;
  const percent = Math.floor((context.request_count / context.monthly_limit) * 100);
  ctx.waitUntil(sendTemplateEmail(env, context.email, TEMPLATE.usage, {
    APPLICANT_NAME: context.applicant_name,
    KEY_PREFIX: context.key_prefix,
    USAGE_PERCENT: String(percent),
    USAGE_USED: String(context.request_count),
    USAGE_LIMIT: String(context.monthly_limit),
    RESET_DATE: new Date(context.reset_at).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }),
    PRODUCTION_APPLICATION_URL: absoluteUrl(request, env, "/developer/apply?tier=production"),
  }, `key-${context.key_id}-usage-${context.period_start}`).catch((caught) => {
    console.error(JSON.stringify({ message: "usage_alert_failed", key_id: context.key_id, reason: caught instanceof Error ? caught.message : "unknown_error" }));
  }));
}

