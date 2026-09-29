# Bhoomi APIs — Local Project Setup

This Node.js/TypeScript service handles partner authentication, analysis submissions, payment status, database persistence, document storage, and calls to the UPSIDA AI service.

## Prerequisites

- Windows PowerShell
- Node.js and npm
- Docker Desktop with Docker Compose
- The companion AI service at `D:\upsida-ai-service-bhoomi-suvidha\bhoomi-suvidha-upsida-ai-service`

## Local services

| Component | Address | Purpose |
|---|---|---|
| Bhoomi APIs | `http://127.0.0.1:8011` | Main API |
| UPSIDA AI | `http://127.0.0.1:8421` | OCR, verification, evaluation |
| PostgreSQL | `127.0.0.1:5437` | API databases |
| MinIO API | `http://127.0.0.1:9100` | Document storage |
| MinIO console | `http://127.0.0.1:9101` | Storage UI |

The API port comes from `.env`; the current local value is `8011`. The AI URL must be `http://127.0.0.1:8421`.

## First-time setup

```powershell
cd D:\bhoomi-apis
npm install
Copy-Item .env.example .env
```

Configure `.env` with local values. Important entries are:

```text
AUTH_DATABASE_URL=postgresql://<user>:<password>@localhost:5437/apis?sslmode=disable
BHOOMI_DATABASE_URL=postgresql://<user>:<password>@localhost:5437/bhoomi_suvidha?sslmode=disable
PORT=8011
AI_SERVICE_URL=http://127.0.0.1:8421
MINIO_ENDPOINT=http://127.0.0.1:9100
```

Also configure JWT key paths, UPSIDA integration values, and MinIO credentials. Never commit `.env`, private keys, or real credentials.

## Start PostgreSQL

Use credentials matching `.env`:

```powershell
docker run -d --name bhoomi-postgres --restart unless-stopped `
  -e POSTGRES_USER=<user> `
  -e POSTGRES_PASSWORD=<password> `
  -e POSTGRES_DB=apis `
  -p 5437:5432 `
  -v bhoomi-postgres-data:/var/lib/postgresql/data `
  postgres:16-alpine
```

Create the second database once:

```powershell
docker exec -e PGPASSWORD=<password> bhoomi-postgres `
  psql -U <user> -d apis -c "CREATE DATABASE bhoomi_suvidha"
```

## Start MinIO

```powershell
docker compose -f docker-compose.minio.yml up -d
```

The compose file uses the current MinIO Quay image and persists data in the `bhoomi-minio-data` Docker volume.

## Apply database migrations

Apply the ordered SQL files to the `apis` database:

```powershell
Get-ChildItem .\sql\*.sql | Sort-Object Name | ForEach-Object {
  docker cp $_.FullName ("bhoomi-postgres:/tmp/" + $_.Name)
  docker exec -e PGPASSWORD=<password> bhoomi-postgres `
    psql -v ON_ERROR_STOP=1 -U <user> -d apis -f ("/tmp/" + $_.Name)
}
```

The `bhoomi_suvidha` database is queried by `/flags`. Load a development database dump into it if full application-data tests are required.

## Start the API

```powershell
cd D:\bhoomi-apis
npm run start
```

Use `npm run dev` for auto-reload. Verify the service:

```powershell
Invoke-RestMethod http://127.0.0.1:8011/health
```

Expected response:

```json
{"status":"ok"}
```

## Create a local test user

```powershell
npm run seed-client -- <username> <password>
```

Example:

```powershell
npm run seed-client -- vinay vinay123
```

Use development-only credentials; do not reuse them in staging or production.

## Test with Postman

Import:

```text
D:\bhoomi-apis\postman\Bhoomi-Suvidha-Nivesh-Mitra.postman_collection.json
```

Set collection variables:

```text
baseUrl       = http://127.0.0.1:8011
username      = <seeded local username>
password      = <seeded local password>
applicationId = local-test-001
```

Run in order:

1. **Get a token** — `POST /auth/token`
2. **Submit for analysis** — `POST /v1/analysis`
3. **Check status / re-fetch** — `GET /v1/analysis/:analysisId`
4. **Report payment status** — `POST /v1/payment-status`
5. **Get payment status** — `GET /v1/payment-status/:applicationId`

The collection saves the token and analysis ID after successful responses.

The analysis request requires reachable HTTP/HTTPS document URLs. A Windows path such as `C:\documents\dpr.pdf` will not work because the API downloads documents over HTTP. Use pre-signed URLs or test the AI service directly with a multipart PDF upload.

When the API runs in Docker and receives local MinIO Console share links such as `http://127.0.0.1:9101/api/v1/download-shared-object/...`, configure an origin rewrite for the container network:

```text
DOCUMENT_URL_REWRITE_FROM=http://127.0.0.1:9101
DOCUMENT_URL_REWRITE_TO=http://bhoomi-minio:9001
```

The API rewrites only the outer Console origin. The share token and its encoded, signed S3 URL are left unchanged.

## Direct checks

```powershell
Invoke-RestMethod http://127.0.0.1:8011/health
Invoke-RestMethod http://127.0.0.1:8421/health
Invoke-WebRequest http://127.0.0.1:9100/minio/health/ready
```

## Troubleshooting

### API cannot reach AI

```powershell
Test-NetConnection 127.0.0.1 -Port 8421
Select-String AI_SERVICE_URL .env
```

Expected value: `AI_SERVICE_URL=http://127.0.0.1:8421`.

### Database errors

```powershell
docker ps
Test-NetConnection 127.0.0.1 -Port 5437
```

Check the database names, credentials, and port in `.env`.

### MinIO errors

```powershell
docker ps --filter name=bhoomi-minio
Invoke-WebRequest http://127.0.0.1:9100/minio/health/ready
```

### Stop local containers

```powershell
docker stop bhoomi-postgres bhoomi-minio
```

Stopping containers preserves named volumes. Remove volumes only when intentionally deleting local database or storage data.
