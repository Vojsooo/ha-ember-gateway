FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY config ./config

ENV NODE_ENV=production
ENV GATEWAY_CONFIG=/app/config/config.yaml

EXPOSE 9000 8090

CMD ["node", "src/index.js"]
