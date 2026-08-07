FROM node:22-alpine AS builder

WORKDIR /build
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm install
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine

WORKDIR /app
COPY --from=builder /build/package.json .
COPY --from=builder /build/dist/ dist/
COPY --from=builder /build/node_modules/ node_modules/

ENV NODE_ENV=production
ENV PORT=12342
ENV STORAGE_DRIVER=local
ENV DATA_DIR=/data
EXPOSE 12342

RUN apk add --no-cache su-exec \
    && mkdir -p /data \
    && chmod 700 /data \
    && chown node:node /data

VOLUME ["/data"]

CMD ["sh", "-c", "chown node:node /data && chmod 700 /data && exec su-exec node node dist/main"]
