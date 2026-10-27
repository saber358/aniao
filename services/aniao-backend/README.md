# Aniao Harness Backend

Spring Boot 3.4 / Java 21 backend for the Aniao Harness desktop client.

The versioned source lives in `services/aniao-backend`. Run Maven commands from this directory. Local data, environment files and build outputs are excluded from Git.

Base URL in production:

```text
http://117.72.245.101/api
```

## Features

- Account registration and username/password login
- BCrypt password hashing and JWT bearer tokens
- User avatars with image upload and generated initial avatars
- User status management (`ACTIVE` / `DISABLED`) and admin role
- Token usage reporting with totals by model and by day
- User-scoped usage history and admin usage aggregation
- Anonymous in-app feedback with text and up to four images
- Feedback status workflow for administrators
- H2 file database, no external database service required

## Run locally

Requirements: Java 21 and Maven 3.9+.

```powershell
$env:ANIAO_JWT_SECRET = "replace-with-at-least-32-random-bytes"
$env:ANIAO_ADMIN_PASSWORD = "Admin12345!"
mvn spring-boot:run
```

Health check:

```text
http://127.0.0.1:8081/api/health
```

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `ANIAO_PORT` | `8081` | HTTP port |
| `ANIAO_BIND_ADDRESS` | `127.0.0.1` | Bind address; keep localhost behind nginx |
| `ANIAO_DATA_DIR` | `./data` | H2 data directory |
| `ANIAO_JWT_SECRET` | development value | JWT signing secret, at least 32 bytes |
| `ANIAO_JWT_TTL_DAYS` | `7` | Token lifetime |
| `ANIAO_ADMIN_USERNAME` | `admin` | Bootstrap administrator username |
| `ANIAO_ADMIN_PASSWORD` | empty | If set, create/promote the bootstrap administrator |
| `ANIAO_TIME_ZONE` | `Asia/Shanghai` | Time zone used for daily usage aggregation |

The administrator password is only used at startup. It is never returned by the API.

## API

All protected endpoints use:

```http
Authorization: Bearer <token>
```

### Authentication

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create account and return a token |
| `POST` | `/api/auth/login` | Login and return a token |
| `POST` | `/api/auth/password` | Change password |
| `GET` | `/api/me` | Current user |

Every user object contains `avatarUrl`, for example `/api/avatars/2`.

### Avatar

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/avatars/{userId}` | Public avatar image; returns a generated SVG when none uploaded |
| `POST` | `/api/me/avatar` | Upload current user's avatar (`file`, multipart) |
| `DELETE` | `/api/me/avatar` | Remove current avatar and fall back to initials |

Avatar limits: 2 MB, PNG/JPEG/WebP/GIF. The generated fallback uses the user's initials and a deterministic color.

Register:

```bash
curl -X POST http://127.0.0.1:8081/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"UserPass123!","displayName":"Alice"}'
```

### Token usage

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/usage` | Report one model usage record |
| `GET` | `/api/usage/summary` | Totals by model and day |
| `GET` | `/api/usage/records` | Paginated usage history |

Report usage:

```bash
curl -X POST http://127.0.0.1:8081/api/usage \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"aniao","model":"grok-4.7","promptTokens":120,"completionTokens":80,"sessionId":"session-1"}'
```

Summary query parameters: `from` and `to` as ISO-8601 instants. Default range is the last 30 days; maximum 370 days.

```bash
curl "http://127.0.0.1:8081/api/usage/summary?from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z" \
  -H "Authorization: Bearer $TOKEN"
```

### Feedback

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/feedback` | Public multipart feedback: `content` and `images`; no login required |
| `GET` | `/api/feedback/mine` | Authenticated user's feedback |
| `GET` | `/api/feedback/images/{id}` | Public unguessable image URL |

```bash
curl -X POST http://127.0.0.1:8081/api/feedback \
  -F 'content=界面运行正常，但希望增加深色模式' \
  -F 'images=@screenshot.png;type=image/png'
```

Limits: content 1-5000 characters, up to 4 images, 5 MB per image, PNG/JPEG/WebP/GIF only.

Anonymous submissions store no user association and display `匿名用户` in the admin list. A valid authenticated submission still retains its existing user association. Listing and updating feedback in `/api/admin/feedback` continues to require an administrator; anonymous clients cannot access user or admin lists.

### Admin

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/admin/users` | List users; `query`, `status` filters |
| `PATCH` | `/api/admin/users/{id}/status` | `{"status":"ACTIVE"}` or `DISABLED` |
| `PATCH` | `/api/admin/users/{id}/role` | `{"role":"USER"}` or `ADMIN` |
| `GET` | `/api/admin/usage/summary` | Aggregate usage; optional `userId`, `from`, `to` |
| `GET` | `/api/admin/feedback` | Paginated feedback |
| `PATCH` | `/api/admin/feedback/{id}` | `{"status":"OPEN\|IN_PROGRESS\|RESOLVED"}` |

## Deployment

Build:

```bash
mvn clean package
```

Install on Ubuntu:

```text
/usr/ds/aniao-backend/aniao-backend.jar
/etc/aniao-backend.env
```

Use `deploy/aniao-backend.service` for systemd and `deploy/nginx-api.conf` to expose `/api/` through nginx on port 80. The application binds to `127.0.0.1:8081` by default.

Example environment file:

```bash
ANIAO_PORT=8081
ANIAO_BIND_ADDRESS=127.0.0.1
ANIAO_DATA_DIR=/usr/ds/aniao-backend/data
ANIAO_JWT_SECRET=<at-least-32-random-bytes>
ANIAO_ADMIN_USERNAME=admin
ANIAO_ADMIN_PASSWORD=<strong-password>
ANIAO_TIME_ZONE=Asia/Shanghai
```

Backups: copy `/usr/ds/aniao-backend/data/aniao.mv.db` while the service is stopped, or use H2 `SCRIPT TO` during maintenance.

On upgrade, `FeedbackSchemaMigration` checks the existing H2 `feedback.user_id` column after JPA initialization and removes its old `NOT NULL` constraint if present. This migration is idempotent and preserves historical user associations and foreign keys. Deploy this backend update before distributing the anonymous-feedback client; older servers still require login for submissions.

## Tests

```bash
mvn test
```

The integration tests cover registration, JWT authentication, usage aggregation, authenticated and anonymous image feedback, admin review and permission checks, disabled-account token rejection, and idempotent migration of an existing non-null feedback user column.
