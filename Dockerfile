FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
# FFmpeg and FFprobe run as local child processes of the Nuvio server.
# Install both in the runtime image; do not rely on host-mounted binaries.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 \
    NUVIO_FFMPEG_PATH=/usr/bin/ffmpeg NUVIO_FFPROBE_PATH=/usr/bin/ffprobe
WORKDIR /app
# Retain runtime files and dependencies for the built-in server and media runtime.
COPY --from=build /app /app
EXPOSE 4173
CMD ["node", "scripts/serve.mjs"]
