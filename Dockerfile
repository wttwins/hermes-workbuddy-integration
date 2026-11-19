FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

ENV NODE_ENV=production \
    WB_CONFIG_DIR=/data \
    HOST=0.0.0.0

WORKDIR /app/server
COPY --chown=node:node server/server.mjs server/package.json ./
COPY --chown=node:node server/LICENSE ./LICENSE
COPY --chown=node:node server/src/ ./src/
COPY --chown=node:node server/console/ ./console/
COPY --chown=node:node docker/ /app/docker/
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8788
STOPSIGNAL SIGINT
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "/app/docker/healthcheck.mjs"]
ENTRYPOINT ["node", "/app/docker/entrypoint.mjs"]
