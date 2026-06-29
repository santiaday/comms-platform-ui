# Comms Platform UI — read-only outcomes dashboard. No build step: the server
# runs TypeScript directly via tsx, so install all deps (incl. dev) and start.
FROM node:24-slim

WORKDIR /app

# Deps first for layer caching. npm install (no lockfile committed yet) pulls
# tsx/typescript which the start command needs.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .

# DeployBay injects PORT + COMMS_WRITER_BEARER (+ optional QUERY_ENDPOINT_URL)
# at runtime. The server reads the comms data layer via the platform SQL
# endpoint; the bearer never reaches the browser.
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
