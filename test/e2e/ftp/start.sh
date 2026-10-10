#!/bin/sh
# Starts one FTP server in the foreground, configured from the environment that test/ftp-servers-kit.ts
# gives the container (spec #41 decision 17). Like a shared host: user `deploy` is locked in its
# login folder (chroot), and with FTP_TLS=yes the server demands explicit TLS (AUTH TLS) on the
# control and the data connections.
#
#   SERVER        pure-ftpd, proftpd or vsftpd (set by the image)
#   FTP_TLS       yes: TLS required, with the key and certificate in TLS_PEM; no: plain FTP only
#   TLS_PEM       the TEST-ONLY key and certificate (src/testkit/tls-certificates.ts), PEM
#   PASV_MIN/MAX  the passive port range, published on the same ports of 127.0.0.1
#   PASV_ADDRESS  an address the passive reply names instead of the server's own (R9)
#   NO_EPSV       yes: EPSV refused, so a client must use PASV and read its address (R9)
#
# The password is set afterwards with chpasswd, on its stdin, never here.

set -eu

pem=/etc/ssl/private/ftp-test.pem
tls=${FTP_TLS:-no}
if [ "$tls" = yes ]; then
  mkdir -p /etc/ssl/private
  printf '%s\n' "$TLS_PEM" > "$pem"
  chmod 600 "$pem"
fi

case "$SERVER" in
pure-ftpd)
  # -l unix: system users; -E: no anonymous; -A: chroot everyone; -j: make the home folder;
  # -H: no DNS lookups; -Y 3: TLS required on the control and the data connections.
  set -- -l unix -E -A -j -H -c 64 -C 64 -p "$PASV_MIN:$PASV_MAX"
  if [ "$tls" = yes ]; then set -- "$@" -Y 3 -2 "$pem"; else set -- "$@" -Y 0; fi
  if [ -n "${PASV_ADDRESS:-}" ]; then set -- "$@" -P "$PASV_ADDRESS"; fi
  exec /usr/sbin/pure-ftpd "$@"
  ;;
proftpd)
  conf=/etc/proftpd/test.conf
  {
    # Debian builds the transfer, listing and TLS modules as shared ones.
    echo 'ModulePath /usr/lib/proftpd'
    echo 'LoadModule mod_ls.c'
    echo 'LoadModule mod_xfer.c'
    if [ "$tls" = yes ]; then echo 'LoadModule mod_tls.c'; fi
    echo 'ServerType standalone'
    echo 'ServerName "sealup test"'
    echo 'DefaultServer on'
    echo 'Port 21'
    echo 'UseIPv6 off'
    echo 'User proftpd'
    echo 'Group nogroup'
    echo 'Umask 022'
    echo 'AllowOverwrite on'
    echo 'DefaultRoot ~'
    echo 'RequireValidShell off'
    echo 'UseReverseDNS off'
    echo 'MaxInstances 64'
    echo 'TimesGMT on'
    echo 'ScoreboardFile /run/proftpd/scoreboard'
    echo "PassivePorts $PASV_MIN $PASV_MAX"
    echo 'SystemLog /var/log/proftpd/system.log'
    # Every command and its reply, for the R8 and R9 tests (PASS is logged as "(hidden)").
    echo 'LogFormat commands "%m %J => %s %S"'
    echo 'ExtendedLog /var/log/proftpd/commands.log ALL commands'
    if [ -n "${PASV_ADDRESS:-}" ]; then echo "MasqueradeAddress $PASV_ADDRESS"; fi
    if [ "${NO_EPSV:-no}" = yes ]; then printf '<Limit EPSV>\n  DenyAll\n</Limit>\n'; fi
    if [ "$tls" = yes ]; then
      echo 'TLSEngine on'
      echo 'TLSRequired on'
      echo 'TLSProtocol TLSv1.2 TLSv1.3'
      echo "TLSECCertificateFile $pem"
      echo "TLSECCertificateKeyFile $pem"
      echo 'TLSLog /var/log/proftpd/tls.log'
    fi
  } > "$conf"
  mkdir -p /run/proftpd /var/log/proftpd
  exec /usr/sbin/proftpd --nodaemon --config "$conf"
  ;;
vsftpd)
  conf=/etc/vsftpd-test.conf
  {
    echo 'listen=YES'
    echo 'listen_ipv6=NO'
    echo 'background=NO'
    echo 'anonymous_enable=NO'
    echo 'local_enable=YES'
    echo 'write_enable=YES'
    echo 'local_umask=022'
    echo 'chroot_local_user=YES'
    echo 'allow_writeable_chroot=YES'
    echo 'seccomp_sandbox=NO'
    echo 'secure_chroot_dir=/var/run/vsftpd/empty'
    echo 'pam_service_name=vsftpd'
    echo 'max_clients=64'
    echo 'max_per_ip=64'
    echo 'pasv_enable=YES'
    echo "pasv_min_port=$PASV_MIN"
    echo "pasv_max_port=$PASV_MAX"
    # Every command and reply, for the R8 and R9 tests (vsftpd logs PASS as "PASS <password>").
    echo 'log_ftp_protocol=YES'
    echo 'xferlog_enable=YES'
    echo 'xferlog_std_format=NO'
    echo 'vsftpd_log_file=/var/log/vsftpd.log'
    if [ -n "${PASV_ADDRESS:-}" ]; then
      echo "pasv_address=$PASV_ADDRESS"
      echo 'pasv_addr_resolve=NO'
    fi
    if [ "${NO_EPSV:-no}" = yes ]; then echo 'cmds_denied=EPSV'; fi
    if [ "$tls" = yes ]; then
      echo 'ssl_enable=YES'
      echo "rsa_cert_file=$pem"
      echo "rsa_private_key_file=$pem"
      echo 'force_local_logins_ssl=YES'
      echo 'force_local_data_ssl=YES'
      echo 'require_ssl_reuse=YES'
      echo 'ssl_ciphers=HIGH'
    else
      echo 'ssl_enable=NO'
    fi
  } > "$conf"
  mkdir -p /var/run/vsftpd/empty
  exec /usr/sbin/vsftpd "$conf"
  ;;
*)
  echo "unknown SERVER: $SERVER" >&2
  exit 2
  ;;
esac
