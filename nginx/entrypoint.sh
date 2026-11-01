#!/bin/bash
set -e

SSL_DIR="/etc/nginx/ssl"
CERT_FILE="${SSL_DIR}/cert.pem"
KEY_FILE="${SSL_DIR}/key.pem"

mkdir -p "${SSL_DIR}"

# Check for alternative certificate filenames in mounted volume
if [ ! -f "${CERT_FILE}" ]; then
    if [ -f "${SSL_DIR}/fullchain.pem" ]; then
        cp -f "${SSL_DIR}/fullchain.pem" "${CERT_FILE}"
    elif [ -f "${SSL_DIR}/tls.crt" ]; then
        cp -f "${SSL_DIR}/tls.crt" "${CERT_FILE}"
    elif [ -f "${SSL_DIR}/cert.crt" ]; then
        cp -f "${SSL_DIR}/cert.crt" "${CERT_FILE}"
    fi
fi

if [ ! -f "${KEY_FILE}" ]; then
    if [ -f "${SSL_DIR}/privkey.pem" ]; then
        cp -f "${SSL_DIR}/privkey.pem" "${KEY_FILE}"
    elif [ -f "${SSL_DIR}/tls.key" ]; then
        cp -f "${SSL_DIR}/tls.key" "${KEY_FILE}"
    elif [ -f "${SSL_DIR}/cert.key" ]; then
        cp -f "${SSL_DIR}/cert.key" "${KEY_FILE}"
    fi
fi

# If either cert or key is missing, auto-generate self-signed certificate
if [ ! -f "${CERT_FILE}" ] || [ ! -f "${KEY_FILE}" ]; then
    echo "[nginx-entrypoint] No existing SSL certificate found in ${SSL_DIR}."
    echo "[nginx-entrypoint] Generating self-signed RSA certificate for localhost and 127.0.0.1..."
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "${KEY_FILE}" \
        -out "${CERT_FILE}" \
        -subj "/C=RU/O=RestInHackaton/CN=localhost" \
        -addext "subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1"
    chmod 600 "${KEY_FILE}"
    chmod 644 "${CERT_FILE}"
    echo "[nginx-entrypoint] Self-signed certificate generated successfully."
else
    echo "[nginx-entrypoint] Using existing SSL certificate from ${SSL_DIR}."
fi

exec "$@"
