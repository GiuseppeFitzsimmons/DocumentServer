FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache \
    pandoc \
    texlive-xetex \
    texmf-dist \
    texmf-dist-latexextra \
    texmf-dist-genericextra \
    fontconfig \
    icu-libs \
    harfbuzz \
    freetype \
    graphite2
# Font directories for custom fonts
RUN printf '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>/data/fonts</dir>\n  <dir>/data/core-fonts</dir>\n</fontconfig>\n' > /etc/fonts/local.conf
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY src/views ./dist/views
COPY src/db/migrations ./dist/db/migrations
COPY public ./public
COPY config ./config
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
