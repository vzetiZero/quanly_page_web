# License registry on Cloudflare D1

The app can run from its local `data/licenses.json` registry or use this Worker as a shared online registry. D1 is required when one admin issues a license that must activate on separate customer computers.

## Deploy

1. Install and authenticate Wrangler (`npx wrangler login`).
2. From this directory, create the database: `npx wrangler d1 create news247us-licenses`.
3. Copy the returned database ID into `wrangler.toml`.
4. Initialize the schema: `npx wrangler d1 execute news247us-licenses --remote --file=schema.sql`.
5. Set a long random admin secret: `npx wrangler secret put ADMIN_TOKEN`.
6. Deploy: `npx wrangler deploy`.

## Connect the app

Set `LICENSE_API_URL` to the deployed Worker URL in the management app's `.env`. Set `LICENSE_ADMIN_TOKEN` to the same secret there. Restart the app. License activation/checks use D1; the License menu can create, update, suspend, release devices, and delete licenses.

Customer installs need only `LICENSE_API_URL`; never distribute the admin token. They can activate codes against the Worker but cannot call admin endpoints. If the Worker is unavailable, the app fails closed until online validation works again. Leave `LICENSE_API_URL` blank to use the local registry.

## API routes

- `POST /v1/activate` and `POST /v1/check`: device-bound activation and validation.
- `GET /v1/admin/licenses`, `POST /v1/admin/licenses`, `PATCH /v1/admin/licenses/:id`, `DELETE /v1/admin/licenses/:id`: admin operations authenticated by `Authorization: Bearer <ADMIN_TOKEN>`.

License codes are stored as SHA-256 hashes in D1 and displayed only in the create response. The local app binds its admin API to loopback. For a remotely exposed management app, add Cloudflare Access or another authentication layer in front of it.
