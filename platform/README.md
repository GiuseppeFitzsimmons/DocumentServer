# Platform

The EuroBureau authentication, file management, and editor integration layer. TypeScript + Express + Postgres + Redis.

## Local Development Setup

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- The `fonts` submodule initialized (`git submodule update --init fonts` from repo root)

### 1. Start infrastructure

From the `platform/` directory:

```bash
docker compose -f docker-compose.dev.yml up -d
```

This starts:
- **Postgres** on port 5432 (user: `portal`, password: `portal`, db: `portal`)
- **Redis** on port 6379
- **Document Server** on port 8080 (with custom fonts mounted from `../fonts/`)

Wait for DS to be ready:
```bash
curl http://localhost:8080/healthcheck
```

### 2. Install dependencies and configure

```bash
npm install
cp .env.example .env
```

The default `.env` is pre-configured for the local docker-compose setup.

### 3. Run migrations and seed

```bash
npm run db:setup
```

This creates all tables and seeds a dev user: `dev@eurobureau.eu` / `password123`

### 4. Start the dev server

```bash
npm run dev
```

The platform runs at `http://localhost:3000`. Open it in your browser, log in with the dev credentials, and create documents — they'll open in the DS instance at port 8080.

### Notes

- **Custom fonts**: The DS container mounts `../fonts/` (the EuroBureau-Fonts submodule) as custom fonts. If fonts appear missing, ensure the submodule is pulled: `cd .. && git submodule update --init fonts`
- **Email**: In dev, SMTP is unconfigured by default. Set `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` in `.env` if you need emails to actually send, or check the console for temp passwords during registration.
- **DS_URL**: Set to `http://localhost:8080` in the default `.env`. If running DS elsewhere, update accordingly.
- **PLATFORM_BASE_URL**: Set to `http://172.17.0.1:3000` (Docker bridge IP) so DS can reach the platform for callbacks. On macOS, use `http://host.docker.internal:3000` instead.
