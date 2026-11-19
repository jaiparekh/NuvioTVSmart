FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173
WORKDIR /app
# Retain runtime files and dependencies for the built-in server and media runtime.
COPY --from=build /app /app
EXPOSE 4173
CMD ["node", "scripts/serve.mjs"]
