# HFSAA Public API

Source for the HFSAA Developer API Worker, documentation, database contract, and OpenAPI specification.

The API is implemented as a Cloudflare Worker. A scheduled job reads only from the restricted Supabase view `public.api_public_locations_v1`, publishes immutable dataset artifacts to R2, and serves requests from those snapshots. API keys are generated through an accountless, email-verified application flow. A Google Form can feed the same flow through a dedicated authenticated integration endpoint. Developers manage keys through emailed one-time links, while HFSAA reviews requests in a browser admin console. Only hashes of verification tokens, claim tokens, management sessions, and API keys are stored.

The v1 contract is documented in `openapi.yaml` and rendered by Mintlify.

## Local preview

Install Node.js 20.17 or later, then install Mintlify's CLI:

```powershell
npm install -g mint
mint dev
```

## Deployment

Connect this repository to a Mintlify project. Mintlify deploys changes pushed to the configured branch.

### Cloudflare Worker

The Worker configuration is in `wrangler.jsonc`. It has a `staging` environment and a production environment. Create the two R2 buckets once before the first deployment:

```powershell
npx wrangler r2 bucket create hfsaa-public-api-datasets-staging
npx wrangler r2 bucket create hfsaa-public-api-datasets
```

Apply `database/developer_api_mvp.sql`, followed by `database/developer_api_portals.sql`, to the linked Supabase project before deploying the API-key and portal flows.

Set `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `ADMIN_API_TOKEN`, and the separate `GOOGLE_FORMS_INGEST_TOKEN` as Cloudflare Worker secrets in each environment; never put their values in `wrangler.jsonc`, `.dev.vars`, or a Git commit.

```powershell
# staging
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
npx wrangler secret put RESEND_API_KEY --env staging
npx wrangler secret put ADMIN_API_TOKEN --env staging
npx wrangler secret put GOOGLE_FORMS_INGEST_TOKEN --env staging
npx wrangler deploy --env staging --keep-vars

# production
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ADMIN_API_TOKEN
npx wrangler secret put GOOGLE_FORMS_INGEST_TOKEN
npx wrangler deploy --keep-vars
```

After each environment's first deployment, request `GET /v1/dataset` once to seed its initial snapshot. A daily cron at 06:00 UTC publishes later snapshots. Superseded artifacts are retained for at least seven days so version-bound cursors remain consistent.

Use `/health` to confirm the deployed Worker is reachable. The application entry point is `/developer/apply`, accountless key management is at `/developer/manage`, and the browser admin console is at `/admin`. Configure `DEVELOPER_APPLICATION_FORM_URL` as a Worker variable after the Google Form is published; until then, `/developer/apply` serves the built-in fallback form. Data requests use `Authorization: Bearer <api-key>`. Test keys do not expire automatically; their access is controlled through environment restrictions, rate limits, monthly quotas, and revocation.

See `google-forms-setup.mdx` for the form questions, Apps Script properties, installable trigger, and staging checklist.

