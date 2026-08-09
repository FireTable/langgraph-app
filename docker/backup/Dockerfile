# ponytail: VPS-only sidecar image for scripts/backup-vps.sh. Alpine base
# + docker-cli (so we can `docker compose exec postgres pg_dump` against
# the live app container) + rclone (Google One / Drive sync) +
# supercronic (cron that handles SIGTERM cleanly + per-job logs). Runs
# as non-root `backup` with the `docker` group so the docker.sock
# mount in docker-compose.yml is accessible without giving the process
# a real shell or writable rootfs.

FROM alpine:3.20

RUN apk add --no-cache \
      bash \
      curl \
      docker-cli \
      docker-cli-compose \
      rclone \
      openssh-client

ARG SUPERCRONIC_VERSION=v0.2.33
RUN curl -fsSL \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
      -o /usr/local/bin/supercronic \
    && chmod +x /usr/local/bin/supercronic

# ponytail: `docker-cli` (client only) doesn't ship a `docker` group —
# only `dockerd` does. We provision a `docker` group at GID 998 inside
# the container, and the host's docker.sock must carry the same GID
# (verify with `stat -c '%g' /var/run/docker.sock`; on mismatch, run
# `chown :998 /var/run/docker.sock` on the host). UID 1000 matches the
# `user: "1000:998"` line in docker-compose.yml.
RUN addgroup -g 1001 docker \
    && adduser -u 1000 -G docker -D -h /home/backup backup

USER backup
WORKDIR /home/backup

ENTRYPOINT ["/usr/local/bin/supercronic", "/etc/crontabs/root"]
