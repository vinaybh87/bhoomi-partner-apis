# Production deployment

Production is served at `https://bhoomi-suvidha.kenpath.ai/apis/`. Nginx Proxy
Manager removes the `/apis/` prefix and forwards to `127.0.0.1:8011`.

## Server layout

- Releases: `/home/ubuntu/bhoomi-partner-apis/releases/<commit>`
- Active release: `/home/ubuntu/bhoomi-partner-apis/current`
- Secrets: `/home/ubuntu/bhoomi-partner-apis/shared/.env`
- JWT keys: `/home/ubuntu/bhoomi-partner-apis/shared/keys/`
- Incoming artifacts: `/home/ubuntu/bhoomi-partner-apis/incoming/`
- Deployment command: `/home/ubuntu/bhoomi-partner-apis/deploy-production.sh`
- PM2 application: `bhoomi-partner-apis`

The deployment script never runs database migrations. It validates the release,
runs a read-only dependency preflight, starts a candidate on port 8013, promotes
the release to port 8011, and restores the previous release if health checks fail.

## GitHub configuration

Create a protected GitHub Environment named `production` and configure these
environment secrets:

- `PROD_HOST`: production hostname or IP
- `PROD_USER`: SSH deployment user
- `PROD_SSH_KEY`: dedicated deployment private key
- `PROD_HOST_KEY`: pinned OpenSSH `known_hosts` entry for the server

CI runs automatically for pull requests and `main`. Production deployment is
manual: run **Deploy production**, enter a tested commit/tag/branch, and approve
the protected environment.

Application secrets must remain on the server. Do not add `.env`, JWT keys,
partner passwords, database URLs, MinIO credentials, or UPSIDA tokens to GitHub.

## Manual health and rollback

```bash
curl --fail http://127.0.0.1:8011/health
curl --fail https://bhoomi-suvidha.kenpath.ai/apis/health
pm2 show bhoomi-partner-apis
```

To roll back, point `current` to a previously validated release and reload PM2:

```bash
ln -s /home/ubuntu/bhoomi-partner-apis/releases/<previous> \
  /home/ubuntu/bhoomi-partner-apis/.current-rollback
mv -Tf /home/ubuntu/bhoomi-partner-apis/.current-rollback \
  /home/ubuntu/bhoomi-partner-apis/current
pm2 startOrReload \
  /home/ubuntu/bhoomi-partner-apis/current/ecosystem.config.cjs \
  --only bhoomi-partner-apis --update-env
pm2 save
```
