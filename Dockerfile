# Comms Platform UI — read-only outcomes dashboard. No build step: the server
# runs TypeScript directly via tsx, so install all deps (incl. dev) and start.
FROM node:24-slim

WORKDIR /app

# Deps first for layer caching. Installs dev deps too — tsx/typescript are
# needed at run time because there is no build step.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .

# DeployBay injects these at runtime. The server reads the comms data layer via
# the platform SQL endpoint; bearers never reach the browser.
#   COMMS_WRITER_BEARER  required
#   QUERY_ENDPOINT_URL   REQUIRED — no default is baked in (this repo is public,
#                        so the endpoint address is configuration, not source).
#                        Without it the Experiments tab fails loudly.
#   LEDGER_API_URL       required for the Ledger tab (API base, not a full path)
#   LEDGER_BEARER        required for the Ledger tab
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
