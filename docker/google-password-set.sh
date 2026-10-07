#!/bin/bash
# Store the Timeline Google account password for automatic re-auth, encrypted with this
# machine's TPM 2.0 (systemd-creds). The ciphertext lives in /data/secrets; only a process
# with access to *this* host's TPM can decrypt it, so a copied data folder or backup is useless.
# Input is hidden and never echoed, logged or written in plaintext.
#
#   docker compose exec -it google-browser google-password-set          # set / replace
#   docker compose exec -it google-browser google-password-set --check  # verify it decrypts
#   docker compose exec -it google-browser google-password-set --remove
set -euo pipefail
CRED=/data/secrets/google-password.cred
NAME=google-password

case "${1:-}" in
  --check)
    [ -f "$CRED" ] || { echo "no stored password ($CRED missing)"; exit 1; }
    if systemd-creds decrypt --name="$NAME" "$CRED" - >/dev/null; then echo "stored password decrypts with this machine's TPM"
    else echo "stored password could NOT be decrypted (TPM changed or file damaged); run google-password-set again"; exit 1; fi
    exit 0 ;;
  --remove)
    rm -f "$CRED" && echo "removed $CRED"; exit 0 ;;
esac

[ -e /dev/tpmrm0 ] || { echo "error: no TPM device in this container (see DOCKER.md, Automatic Timeline re-auth)" >&2; exit 1; }
mkdir -p "$(dirname "$CRED")" && chmod 700 "$(dirname "$CRED")"
read -rsp "Google password for ${TIMELINE_GOOGLE_EMAIL:-the Timeline account} (input hidden): " PW; echo
[ -n "$PW" ] || { echo "error: empty password" >&2; exit 1; }
read -rsp "Repeat it: " PW2; echo
[ "$PW" = "$PW2" ] || { unset PW PW2; echo "error: the two entries differ" >&2; exit 1; }
unset PW2
umask 077
# Bound to this TPM + PCR 7 (Secure Boot state). Kernel/OS updates don't affect it; changing
# Secure Boot settings or keys does, in which case --check fails and you run this again.
# (An empty PCR set would avoid even that, but systemd-creds 252 rejects it.)
printf '%s' "$PW" | systemd-creds encrypt --with-key=tpm2 --tpm2-device=/dev/tpmrm0 --tpm2-pcrs=7 --name="$NAME" - "$CRED"
unset PW
chmod 600 "$CRED"
systemd-creds decrypt --name="$NAME" "$CRED" - >/dev/null && echo "saved: $CRED (TPM-encrypted; verified it decrypts)"
