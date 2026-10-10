# An OpenSSH server for the end-to-end tests (ticket 11, decision 0013): like a shared host's SSH
# account, user `deploy` logs in with a password or a key and gets SFTP (internal-sftp, which
# announces posix-rename@openssh.com) and a POSIX shell with GNU tar and gzip, for `ssh://`'s
# archive (0034, spec #41 decision 17): the tar shared hosts run. Built and started by
# test/openssh-kit.ts; never pushed anywhere.
#
# The base image is pinned by digest (debian trixie-slim, 2026-10-08, the image T07's tar test
# uses). The packages come from that release, so a rebuild may pick up an OpenSSH security fix,
# never a new major version. No password and no key are baked in: the test sets the password with
# chpasswd and writes the authorized key after the start (decision 0033), and the host keys are
# made at each start, so every run pins a fresh key. The authorized keys live outside the login
# folder, so emptying it between tests keeps them. A second user, `sftponly`, with the same
# password, runs the sftp-server program whatever command it asks for (ForceCommand), as some
# SFTP-only accounts do: it reads stdin and exits 0 once it ends, so the archive's probe must
# tell it from a shell (0039). (`ForceCommand internal-sftp` refuses an exec with exit 1.)

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server \
  && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
  && useradd --create-home --shell /bin/sh deploy \
  && useradd --create-home --shell /bin/sh sftponly \
  && mkdir -p /run/sshd /etc/ssh/authorized_keys \
  && printf '%s\n' \
    'Port 22' \
    'HostKey /etc/ssh/ssh_host_ed25519_key' \
    'PermitRootLogin no' \
    'PasswordAuthentication yes' \
    'PubkeyAuthentication yes' \
    'AuthorizedKeysFile /etc/ssh/authorized_keys/%u' \
    'KbdInteractiveAuthentication no' \
    'UsePAM no' \
    'Subsystem sftp internal-sftp' \
    'Match User sftponly' \
    '  ForceCommand /usr/lib/openssh/sftp-server' \
    > /etc/ssh/sshd_config

EXPOSE 22
CMD ["sh", "-c", "ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key && exec /usr/sbin/sshd -D -e"]
