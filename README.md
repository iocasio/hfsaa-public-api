# HFSAA Public API

Source for the HFSAA Developer documentation and proposed OpenAPI contract.

The public API is implemented as a Cloudflare Worker. A scheduled job reads only from the restricted Supabase view `public.api_public_locations_v1`, publishes immutable dataset artifacts to R2, and serves public requests from those snapshots. It never returns raw directory-table data or Google Places content.

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

Set `SUPABASE_SERVICE_ROLE_KEY` as a Cloudflare Worker secret in each environment; never put it in `wrangler.jsonc`, `.dev.vars`, or a Git commit.

```powershell
# staging
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
npx wrangler deploy --env staging

# production
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler deploy
```

After each environment's first deployment, request `GET /v1/dataset` once to seed its initial snapshot. A daily cron at 06:00 UTC publishes later snapshots. Superseded artifacts are retained for at least seven days so version-bound cursors remain consistent.

Use `/health` to confirm the deployed Worker is reachable. The public endpoints are listed in `openapi.yaml`.
