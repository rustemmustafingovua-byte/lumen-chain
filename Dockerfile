# Multi-stage build. The runtime image keeps the native modules compiled in the builder.

FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY core ./core
COPY cli ./cli
COPY keeper ./keeper
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS production
RUN apk add --no-cache libstdc++
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY explorer ./explorer
COPY contracts ./contracts
COPY docs ./docs
COPY README.md LICENSE LAUNCH.md ./

VOLUME /data/.lumen
ENV LUMEN_HOME=/data/.lumen
ENV LUMEN_NETWORK=devnet
ENV LUMEN_P2P_PORT=8789
ENV LUMEN_RPC_PORT=8899
ENV NODE_ENV=production

EXPOSE 8789 8899
CMD ["node", "dist/cli/lumen.js", "serve", "--port=8899"]
