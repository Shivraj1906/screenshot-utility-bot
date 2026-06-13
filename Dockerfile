FROM node:22.16.0-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV SCREENSHOT_DB_PATH=/app/data/screenshots.sqlite

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app

USER node

VOLUME ["/app/data"]

CMD ["npm", "start"]
