# "Watch on TV" for Kodi: a YouTube cast receiver that plays through Kodi's
# YouTube add-on. Runs on the host network, so the DIAL announcement (SSDP
# multicast) reaches phones on the LAN.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src/ ./src/

ENV NODE_ENV=production DATA_DIR=/data
# The stack runs it as PUID:PGID; /data is its bind mount.
USER node

ENTRYPOINT ["node", "src/main.js"]
