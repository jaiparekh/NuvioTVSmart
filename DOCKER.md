# Nuvio browser container

This experimental container runs the existing Nuvio web server and bundled local media runtime with Node.js 22.

## Start

From the repository root:

```sh
touch local.properties
docker compose up -d --build
docker compose logs -f nuvio-web
```

Open `http://<server-ip>:4173/`.

To update after pulling changes:

```sh
docker compose up -d --build
```

The server dynamically generates `/nuvio.env.js` from `local.properties`. **Do not put private secrets in this file:** its configuration values are delivered to browser clients.

**Security warning:** The current upstream `scripts/serve.mjs` can fall back to serving files from the repository root, potentially including `local.properties` and source files. Do **not** expose port 4173 publicly or through a public reverse proxy until file-serving restrictions are implemented and tested. Restrict access to a trusted LAN for now.

This deployment does not yet fix browser mouse interaction or QR login behavior.
