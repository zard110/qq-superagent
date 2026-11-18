FROM docker:27-cli
ENV TZ=Asia/Shanghai
COPY --from=node:24-bookworm-slim /usr/share/zoneinfo/Asia/Shanghai /usr/share/zoneinfo/Asia/Shanghai
RUN apk add --no-cache nodejs
COPY server.mjs /server.mjs
ENTRYPOINT ["node","/server.mjs"]
