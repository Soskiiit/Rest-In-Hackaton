#!/usr/bin/env bash
# ai/download_weights.sh
# Downloads Kokoro TTS model weights and voice pack into ai/kokoro/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${SCRIPT_DIR}/kokoro"

MODEL_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
VOICES_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"

MODEL_FILE="${TARGET_DIR}/kokoro-v1.0.onnx"
VOICES_FILE="${TARGET_DIR}/voices-v1.0.bin"

mkdir -p "${TARGET_DIR}"

echo "=========================================================="
echo " Kokoro TTS Model Weights Downloader"
echo " Target directory: ${TARGET_DIR}"
echo "=========================================================="

download_file() {
    local url="$1"
    local dest="$2"
    local min_bytes="$3"
    local name="$4"

    if [ -f "${dest}" ]; then
        local size
        size=$(stat -c%s "${dest}" 2>/dev/null || stat -f%z "${dest}" 2>/dev/null || echo 0)
        if [ "${size}" -ge "${min_bytes}" ]; then
            echo "[*] ${name} already exists and valid (${size} bytes). Skipping download."
            return 0
        else
            echo "[!] ${name} exists but size (${size} bytes) is below expected (${min_bytes} bytes). Re-downloading..."
            rm -f "${dest}"
        fi
    fi

    echo "[*] Downloading ${name}..."
    if command -v curl >/dev/null 2>&1; then
        curl -L --progress-bar -o "${dest}" "${url}"
    elif command -v wget >/dev/null 2>&1; then
        wget -q --show-progress -O "${dest}" "${url}"
    else
        echo "[ERROR] Neither curl nor wget was found. Please install curl or wget."
        exit 1
    fi

    local final_size
    final_size=$(stat -c%s "${dest}" 2>/dev/null || stat -f%z "${dest}" 2>/dev/null || echo 0)
    if [ "${final_size}" -lt "${min_bytes}" ]; then
        echo "[ERROR] Downloaded ${name} is incomplete (${final_size} bytes). Please re-run."
        exit 1
    fi
    echo "[OK] Successfully downloaded ${name} (${final_size} bytes)."
}

# 1. Download Model ONNX (~310 MB, threshold 300 MB)
download_file "${MODEL_URL}" "${MODEL_FILE}" 300000000 "Kokoro v1.0 ONNX model"

# 2. Download Voices BIN (~27 MB, threshold 25 MB)
download_file "${VOICES_URL}" "${VOICES_FILE}" 25000000 "Kokoro Voices v1.0"

echo "=========================================================="
echo " All Kokoro TTS weights are ready in ${TARGET_DIR}!"
echo "=========================================================="
