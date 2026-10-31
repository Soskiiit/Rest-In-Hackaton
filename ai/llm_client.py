"""
ai/llm_client.py
OpenAI-Compatible LLM Client for Rest-In-Hackaton DEV-B AI Middleware.

Connects to llama-server on http://127.0.0.1:8080/v1/chat/completions.
Provides resilient timeout handling, regex markdown fence stripping,
and structured JSON parsing.
"""

import json
import logging
import os
import re
from typing import Any, Dict, Optional, Tuple

import httpx

logger = logging.getLogger("ai.llm_client")

# Defaults configurable via environment variables
DEFAULT_LLAMA_SERVER_URL = os.getenv(
    "LLAMA_SERVER_URL", "http://127.0.0.1:8080/v1/chat/completions"
)
DEFAULT_LLAMA_HEALTH_URL = os.getenv(
    "LLAMA_HEALTH_URL", "http://127.0.0.1:8080/health"
)
DEFAULT_MODEL = os.getenv(
    "LLM_MODEL", "unsloth/Qwen3.5-4B-MTP-GGUF:Q5_K_M"
)
DEFAULT_TIMEOUT_SECONDS = float(os.getenv("LLM_TIMEOUT", "15.0"))
DEFAULT_CONNECT_TIMEOUT = float(os.getenv("LLM_CONNECT_TIMEOUT", "3.0"))


class LLMClientError(Exception):
    """Base exception for all LLM client failures."""
    pass


class LLMConnectionError(LLMClientError):
    """Raised when llama-server cannot be reached (e.g., ConnectionRefused)."""
    pass


class LLMTimeoutError(LLMClientError):
    """Raised when llama-server times out during connection or inference."""
    pass


class LLMResponseError(LLMClientError):
    """Raised when llama-server returns an HTTP error status (4xx or 5xx)."""

    def __init__(self, status_code: int, message: str):
        super().__init__(f"LLM server HTTP error {status_code}: {message}")
        self.status_code = status_code
        self.message = message


class LLMParseError(LLMClientError):
    """Raised when LLM output cannot be parsed into the expected JSON structure."""

    def __init__(self, raw_content: str, detail: str):
        super().__init__(f"Failed to parse LLM JSON response: {detail}")
        self.raw_content = raw_content
        self.detail = detail


def strip_markdown_fences(content: str) -> str:
    """
    Strips markdown code blocks (e.g. ```json ... ``` or ``` ... ```) from content.
    Returns the inner text if fences are detected; otherwise returns stripped content.
    """
    fence_pattern = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```", re.IGNORECASE)
    match = fence_pattern.search(content)
    if match:
        return match.group(1).strip()
    return content.strip()


def extract_json_object(content: str) -> str:
    """
    Extracts the outermost JSON object substring enclosed by '{' and '}'.
    Removes leading or trailing conversational filler if present.
    """
    cleaned = strip_markdown_fences(content)
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        return cleaned[first_brace : last_brace + 1]
    return cleaned


def parse_llm_json(content: str) -> Dict[str, Any]:
    """
    Cleans raw LLM response text and deserializes into a Python dict.
    Raises LLMParseError if JSON decoding fails.
    """
    extracted = extract_json_object(content)
    try:
        return json.loads(extracted)
    except json.JSONDecodeError as exc:
        raise LLMParseError(raw_content=content, detail=str(exc)) from exc


class LLMClient:
    """
    Asynchronous client for llama-server OpenAI-compatible chat completions API.
    """

    def __init__(
        self,
        completions_url: str = DEFAULT_LLAMA_SERVER_URL,
        health_url: str = DEFAULT_LLAMA_HEALTH_URL,
        model: str = DEFAULT_MODEL,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
    ):
        self.completions_url = completions_url
        self.health_url = health_url
        self.model = model
        self.timeout = httpx.Timeout(timeout, connect=connect_timeout)

    async def check_health(self) -> bool:
        """
        Pings llama-server to verify connectivity.
        Checks /health endpoint, falling back to /v1/models.
        Returns True if reachable and responding, False otherwise.
        """
        probe_timeout = httpx.Timeout(2.0, connect=1.0)
        try:
            async with httpx.AsyncClient(timeout=probe_timeout) as client:
                # 1. Try health endpoint
                try:
                    resp = await client.get(self.health_url)
                    if resp.status_code == 200:
                        return True
                except httpx.HTTPError:
                    pass

                # 2. Try OpenAI models endpoint
                models_url = self.completions_url.replace("/chat/completions", "/models")
                resp = await client.get(models_url)
                return resp.status_code == 200
        except (httpx.ConnectError, httpx.TimeoutException, httpx.RequestError):
            return False

    async def generate_chat_completion(
        self,
        system_prompt: str,
        user_message: str,
        temperature: float = 0.7,
        max_tokens: int = 512,
    ) -> Tuple[Dict[str, Any], str]:
        """
        Sends chat completion request to llama-server with response_format json_object.

        Returns:
            Tuple of (parsed_dict, raw_content_str)

        Raises:
            LLMConnectionError: If server connection is refused or down
            LLMTimeoutError: If inference exceeds timeout limit
            LLMResponseError: If server responds with 4xx/5xx status
            LLMParseError: If server response or content cannot be parsed as JSON
        """
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
            "response_format": {"type": "json_object"},
        }

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    self.completions_url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
        except (httpx.ConnectError, httpx.NetworkError) as exc:
            raise LLMConnectionError(
                f"Failed to connect to llama-server at {self.completions_url}: {exc}"
            ) from exc
        except httpx.TimeoutException as exc:
            raise LLMTimeoutError(
                f"llama-server request timed out after {self.timeout.read}s"
            ) from exc
        except httpx.RequestError as exc:
            raise LLMClientError(f"HTTP request error: {exc}") from exc

        if response.status_code != 200:
            raise LLMResponseError(response.status_code, response.text)

        try:
            resp_data = response.json()
            raw_content = resp_data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, json.JSONDecodeError) as exc:
            raise LLMParseError(
                raw_content=response.text,
                detail=f"Malformed OpenAI API response envelope: {exc}",
            ) from exc

        parsed_json = parse_llm_json(raw_content)
        return parsed_json, raw_content


__all__ = [
    "DEFAULT_LLAMA_SERVER_URL",
    "DEFAULT_LLAMA_HEALTH_URL",
    "DEFAULT_MODEL",
    "DEFAULT_TIMEOUT_SECONDS",
    "DEFAULT_CONNECT_TIMEOUT",
    "LLMClientError",
    "LLMConnectionError",
    "LLMTimeoutError",
    "LLMResponseError",
    "LLMParseError",
    "strip_markdown_fences",
    "extract_json_object",
    "parse_llm_json",
    "LLMClient",
]
