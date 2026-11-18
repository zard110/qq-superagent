FROM node:24-bookworm-slim
ENV TZ=Asia/Shanghai
RUN mkdir -p /etc/ssl/certs && node -e "require('fs').writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('tls').rootCertificates.join('\n'))"
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::https::Timeout=30 update && apt-get -o Acquire::https::Timeout=30 -o Acquire::Retries=3 install -y --no-install-recommends chromium ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /browser
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY app/network.mjs app/providers.mjs ./app/
COPY browser/server.mjs ./server.mjs
USER node
CMD ["node","server.mjs"]
