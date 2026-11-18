FROM docker:27-cli
RUN apk add --no-cache nodejs
COPY server.mjs /server.mjs
ENTRYPOINT ["node","/server.mjs"]
