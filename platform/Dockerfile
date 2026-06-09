FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache pandoc
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY src/views ./dist/views
COPY src/db/migrations ./dist/db/migrations
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
