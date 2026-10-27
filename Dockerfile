# Multi-stage Dockerfile для lumen-chain
# Собираем в builder, запускаем в минимальном alpine-образе.

FROM node:20-alpine AS builder
WORKDIR /app

# Кэшируем зависимости
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Собираем TS -> JS
COPY tsconfig*.json ./
COPY core ./core
COPY cli ./cli
COPY keeper ./keeper
RUN npm run build

# --- runtime ---
FROM node:20-alpine
RUN apk add --no-cache sqlite-libs

WORKDIR /app

# Копируем только собранный код и статику
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY explorer ./explorer
COPY contracts ./contracts
COPY docs ./docs
COPY README.md LICENSE LAUNCH.md ./

# Данные цепочки
VOLUME /data/.lumen
ENV LUMEN_HOME=/data/.lumen
ENV NODE_ENV=production

EXPOSE 8789 8899

# По умолчанию запускаем узел + explorer (serve)
CMD ["node", "dist/cli/lumen.js", "serve", "--port=8899", "--peers="]
