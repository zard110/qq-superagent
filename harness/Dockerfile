ARG SANDBOX_BASE=qq-superagent-sandbox:local
FROM node:24-bookworm-slim AS node
FROM ${SANDBOX_BASE}
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /opt/npm
RUN ln -s /opt/npm/bin/npm-cli.js /usr/local/bin/npm && mkdir /opt/harness /work && chown 65534:65534 /work
WORKDIR /opt/harness
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY worker.mjs qq-tool install_deb.py install_skill.mjs unpack_skills.py ./
RUN chmod 755 qq-tool && ln -s /opt/harness/qq-tool /usr/local/bin/qq-tool
ENV HOME=/work/home TZ=Asia/Shanghai PIP_TARGET=/work/tools/python PYTHONPATH=/work/tools/python NPM_CONFIG_PREFIX=/work/tools/node PATH=/work/tools/node/bin:/work/tools/python/bin:/work/tools/deb/usr/bin:/usr/local/bin:/usr/bin:/bin
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["sleep","infinity"]
