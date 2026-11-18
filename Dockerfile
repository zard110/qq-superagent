FROM node:24-bookworm-slim
ENV TZ=Asia/Shanghai
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY vendor/superagent/src/core ./vendor/superagent/src/core
COPY vendor/superagent/LICENSE ./vendor/superagent/LICENSE
RUN npm run build && npm prune --omit=dev
COPY app ./app
COPY public ./public
RUN mkdir /state && chown node:node /state
USER node
ENV STATE_DIR=/state HOST=0.0.0.0
CMD ["node","app/server.mjs"]
