# Platform

This is the authentication stack, we're running typescript and argon2, currently on the same internal postgres as the core engine. We'll migrate to something more stable later.

## Local Startup

#### Core Service

```
docker run -d -p 8080:80 --name eo-dev \
  -e JWT_SECRET=euro-office-dev-jwt-secret-key-2026 \
  -e EXAMPLE_ENABLED=true \
  ghcr.io/euro-office/documentserver:latest
```

Give it a sec, poll it with `curl http://localhost:8080/healthcheck`

#### Auth Service

```
cd platform
npm install
cp .env.example .env
```
#### Database
```
docker run -d --name portal-pg -p 5432:5432 \
  -e POSTGRES_DB=portal \
  -e POSTGRES_USER=portal \
  -e POSTGRES_PASSWORD=portal \
  postgres:16-alpine

docker run -d --name portal-redis -p 6379:6379 redis:7-alpine
```

#### Migration
```
npm run db:setup
npm run dev
```
This will seed the database with a user whose credentials are `dev@eurobureau.eu` / `password123`