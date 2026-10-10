# The FTP servers shared hosts run, for the end-to-end tests (spec #41 decision 17): Pure-FTPd,
# ProFTPD and vsftpd, one build target each (the three Debian packages conflict). User `deploy` logs
# in with a password and is locked in its login folder. Built and started by
# test/ftp-servers-kit.ts; never pushed anywhere.
#
# The base image is pinned by digest (debian trixie-slim, 2026-10-08, the OpenSSH image's base).
# The packages come from that release, so a rebuild may pick up a security fix, never a new major
# version. No password, key or certificate is baked in: start.sh writes the server's config from
# the container's environment (TLS on or off, the passive ports, R9's address), and the test sets
# the password with chpasswd after the start.

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS base
RUN useradd --create-home --shell /bin/sh deploy
COPY start.sh /usr/local/bin/start-ftp
RUN chmod 755 /usr/local/bin/start-ftp
EXPOSE 21
CMD ["/usr/local/bin/start-ftp"]

FROM base AS pure-ftpd
RUN apt-get update \
  && apt-get install -y --no-install-recommends pure-ftpd \
  && rm -rf /var/lib/apt/lists/*
ENV SERVER=pure-ftpd

FROM base AS proftpd
RUN apt-get update \
  && apt-get install -y --no-install-recommends proftpd-core proftpd-mod-crypto \
  && rm -rf /var/lib/apt/lists/*
ENV SERVER=proftpd

FROM base AS vsftpd
RUN apt-get update \
  && apt-get install -y --no-install-recommends vsftpd \
  && rm -rf /var/lib/apt/lists/*
ENV SERVER=vsftpd
