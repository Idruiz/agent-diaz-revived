FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system diaz && useradd --system --gid diaz --home-dir /app diaz
COPY --from=build --chown=diaz:diaz /app/package.json /app/package-lock.json ./
COPY --from=build --chown=diaz:diaz /app/node_modules ./node_modules
COPY --from=build --chown=diaz:diaz /app/dist ./dist
RUN mkdir -p data artifacts uploads && chown -R diaz:diaz data artifacts uploads
USER diaz
EXPOSE 3000
VOLUME ["/app/data","/app/artifacts","/app/uploads"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","dist/server/index.js"]
