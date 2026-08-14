# HFSAA Public API

Source for the HFSAA Developer documentation and proposed OpenAPI contract.

The public API is implemented as a Cloudflare Worker. The Worker reads only from the restricted, live Supabase view `public.api_public_locations_v1`; it never returns raw directory-table data or Google Places content.

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

The Worker configuration is in `wrangler.jsonc`. It has a `staging` environment and a production environment. Set `SUPABASE_SERVICE_ROLE_KEY` as a Cloudflare Worker secret in each environment; never put it in `wrangler.jsonc`, `.dev.vars`, or a Git commit.

```powershell
# staging
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
npx wrangler deploy --env staging

# production
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler deploy
```

Use `/health` to confirm the deployed Worker is reachable. The public endpoints are listed in `openapi.yaml`.
