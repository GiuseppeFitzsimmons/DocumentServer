FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Separate layer for LaTeX so it's cached across builds
FROM node:22-alpine AS texlive
RUN apk add --no-cache \
    texlive-xetex \
    texmf-dist \
    fontconfig \
    && rm -rf /var/cache/apk/*
# If soul.sty or other extras are needed, cherry-pick:
# RUN mkdir -p /usr/share/texmf-dist/tex/latex/soul && \
#     wget -qO /usr/share/texmf-dist/tex/latex/soul/soul.sty \
#     "https://mirrors.ctan.org/macros/generic/soul/soul.sty" && mktexlsr

FROM node:22-alpine
# Copy texlive from cached layer (avoids re-downloading on code changes)
COPY --from=texlive /usr/bin/xelatex /usr/bin/xelatex
COPY --from=texlive /usr/bin/xetex /usr/bin/xetex
COPY --from=texlive /usr/share/texmf-dist /usr/share/texmf-dist
COPY --from=texlive /usr/share/texlive /usr/share/texlive
COPY --from=texlive /usr/lib/libkpathsea* /usr/lib/
COPY --from=texlive /usr/lib/libptexenc* /usr/lib/
COPY --from=texlive /usr/lib/libsynctex* /usr/lib/
COPY --from=texlive /usr/lib/libtexlua* /usr/lib/
COPY --from=texlive /usr/bin/mktexlsr /usr/bin/mktexlsr
COPY --from=texlive /usr/bin/kpsewhich /usr/bin/kpsewhich
COPY --from=texlive /etc/fonts /etc/fonts
RUN apk add --no-cache pandoc fontconfig icu-libs harfbuzz freetype graphite2 libgcc libstdc++
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
