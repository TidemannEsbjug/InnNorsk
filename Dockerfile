# InnNorsk Sky: webserveren (Express + node:sqlite). Se docs/DEPLOY.md.
FROM node:22-slim

WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json package-lock.json ./
# --omit=optional: canvas (valgfri for pdfjs-dist) trengs ikke til tekstuttrekk og kan ikke bygges i slim-imaget.
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY server ./server
COPY web ./web
COPY assets/icon.png ./assets/icon.png

ENV NODE_ENV=production DATA_DIR=/data PORT=8080
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
