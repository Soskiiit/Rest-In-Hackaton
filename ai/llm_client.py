"""
ai/llm_client.py
OpenAI-Compatible LLM Client for Rest-In-Hackaton DEV-B AI Middleware.

Connects to llama-server on http://127.0.0.1:8080/v1/chat/completions.
Configured for fast Qwen3.5 inference with thinking token suppression,
resilient timeout handling, regex markdown/thinking stripping,
and structured JSON parsing.
"""

import json
import logging
import os
import re
from typing import Any, Dict, Optional, Tuple

import httpx

logger = logging.getLogger("ai.llm_client")

def resolve_llm_endpoints(
    llama_server_url: Optional[str] = None,
    ollama_url: Optional[str] = None,
    openai_base_url: Optional[str] = None,
    health_url: Optional[str] = None,
) -> Tuple[str, str]:
    """
    Resolves the chat completions endpoint and health probe endpoint.
    Supports Ollama, OpenAI-compatible servers, and llama-server.
    Priority:
    1. OLLAMA_URL / OLLAMA_HOST
    2. OPENAI_BASE_URL / LLM_BASE_URL
    3. LLAMA_SERVER_URL
    4. Default fallback: http://127.0.0.1:8080/v1/chat/completions
    """
    raw_ollama = ollama_url or os.getenv("OLLAMA_URL") or os.getenv("OLLAMA_HOST")
    raw_openai = openai_base_url or os.getenv("OPENAI_BASE_URL") or os.getenv("LLM_BASE_URL")
    raw_llama = llama_server_url or os.getenv("LLAMA_SERVER_URL")

    # Priority 1: OLLAMA_URL
    if raw_ollama:
        url = raw_ollama.strip().rstrip("/")
        if url.endswith("/v1/chat/completions"):
            completions = url
            base = url[:-len("/v1/chat/completions")]
        elif url.endswith("/api/chat"):
            base = url[:-len("/api/chat")]
            completions = f"{base}/v1/chat/completions"
        elif url.endswith("/v1"):
            base = url[:-len("/v1")]
            completions = f"{url}/chat/completions"
        else:
            base = url
            completions = f"{url}/v1/chat/completions"
        health = health_url or os.getenv("LLAMA_HEALTH_URL") or f"{base}/v1/models"
        return completions, health

    # Priority 2: OPENAI_BASE_URL
    if raw_openai:
        url = raw_openai.strip().rstrip("/")
        if url.endswith("/chat/completions"):
            completions = url
            base = url[:-len("/chat/completions")]
        elif url.endswith("/v1"):
            completions = f"{url}/chat/completions"
            base = url
        else:
            completions = f"{url}/v1/chat/completions"
            base = f"{url}/v1"
        health = health_url or os.getenv("LLAMA_HEALTH_URL") or f"{base}/models"
        return completions, health

    # Priority 3: LLAMA_SERVER_URL
    if raw_llama:
        url = raw_llama.strip().rstrip("/")
        if url.endswith("/chat/completions"):
            completions = url
            base = re.sub(r"/v1.*$", "", url)
        elif url.endswith("/v1"):
            completions = f"{url}/chat/completions"
            base = url[:-len("/v1")]
        else:
            completions = f"{url}/v1/chat/completions"
            base = url
        health = health_url or os.getenv("LLAMA_HEALTH_URL") or f"{base}/health"
        return completions, health

    # Default fallback to localhost llama-server
    completions = "http://127.0.0.1:8080/v1/chat/completions"
    health = health_url or os.getenv("LLAMA_HEALTH_URL") or "http://127.0.0.1:8080/health"
    return completions, health


def resolve_default_model(model_override: Optional[str] = None) -> str:
    """Resolves default model name based on LLM_MODEL or detected backend."""
    if model_override:
        return model_override
    env_model = os.getenv("LLM_MODEL")
    if env_model:
        return env_model
    if os.getenv("OLLAMA_URL") or os.getenv("OLLAMA_HOST"):
        return "qwen3.5:4b"
    return "unsloth/Qwen3.5-4B-MTP-GGUF:Q5_K_M"


# Dynamic defaults computed via resolvers
_resolved_completions, _resolved_health = resolve_llm_endpoints()
DEFAULT_LLAMA_SERVER_URL = _resolved_completions
DEFAULT_LLAMA_HEALTH_URL = _resolved_health
DEFAULT_MODEL = resolve_default_model()
DEFAULT_TIMEOUT_SECONDS = float(os.getenv("LLM_TIMEOUT", "15.0"))
DEFAULT_CONNECT_TIMEOUT = float(os.getenv("LLM_CONNECT_TIMEOUT", "3.0"))

# Fast Inference Tunings for Qwen3.5
DEFAULT_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0.7"))
DEFAULT_TOP_P = float(os.getenv("LLM_TOP_P", "0.8"))
DEFAULT_PRESENCE_PENALTY = float(os.getenv("LLM_PRESENCE_PENALTY", "1.5"))
DEFAULT_TOP_K = int(os.getenv("LLM_TOP_K", "20"))
DEFAULT_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "512"))
DEFAULT_ENABLE_THINKING = os.getenv("LLM_ENABLE_THINKING", "false").lower() in ("1", "true", "yes")


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


def strip_thinking_tokens(content: str) -> str:
    """
    Strips reasoning / thinking tokens (e.g. <think>...</think> or [THINK]...[/THINK])
    generated by reasoning-oriented LLMs like Qwen or DeepSeek.
    """
    if not content:
        return ""
    # Strip closed <think> ... </think> tags
    content = re.sub(r"<think>[\s\S]*?</think>", "", content, flags=re.IGNORECASE)
    # Strip unclosed <think> tag if stream was truncated
    content = re.sub(r"<think>[\s\S]*$", "", content, flags=re.IGNORECASE)
    # Strip [THINK] ... [/THINK] alternate syntax
    content = re.sub(r"\[THINK\][\s\S]*?\[/THINK\]", "", content, flags=re.IGNORECASE)
    return content.strip()


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
    Removes thinking blocks, markdown fences, and leading/trailing conversational filler.
    """
    cleaned = strip_thinking_tokens(content)
    cleaned = strip_markdown_fences(cleaned)
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
    Enforces thinking token suppression, top_p, presence_penalty, and extra_body params.
    """

    def __init__(
        self,
        completions_url: Optional[str] = None,
        health_url: Optional[str] = None,
        model: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
    ):
        if completions_url is None or health_url is None:
            resolved_c, resolved_h = resolve_llm_endpoints(
                llama_server_url=completions_url,
                health_url=health_url,
            )
            self.completions_url = completions_url or resolved_c
            self.health_url = health_url or resolved_h
        else:
            self.completions_url = completions_url
            self.health_url = health_url
        self.model = model or resolve_default_model()
        self.timeout = httpx.Timeout(timeout, connect=connect_timeout)

    async def check_health(self) -> bool:
        """
        Pings upstream LLM server to verify connectivity.
        Checks configured health endpoint, falling back to /v1/models and root /.
        Returns True if reachable and responding, False otherwise.
        """
        probe_timeout = httpx.Timeout(2.0, connect=1.0)
        try:
            async with httpx.AsyncClient(timeout=probe_timeout) as client:
                # 1. Try health endpoint (/health or /v1/models)
                try:
                    resp = await client.get(self.health_url)
                    if resp.status_code == 200:
                        return True
                except httpx.HTTPError:
                    pass

                # 2. Try OpenAI models endpoint (/v1/models)
                try:
                    models_url = self.completions_url.replace("/chat/completions", "/models")
                    if models_url != self.health_url:
                        resp = await client.get(models_url)
                        if resp.status_code == 200:
                            return True
                except httpx.HTTPError:
                    pass

                # 3. Try root endpoint (/) for Ollama
                try:
                    root_url = re.sub(r"/v1.*$", "/", self.completions_url)
                    if root_url not in (self.health_url, self.completions_url):
                        resp = await client.get(root_url)
                        if resp.status_code == 200:
                            return True
                except httpx.HTTPError:
                    pass

                return False
        except (httpx.ConnectError, httpx.TimeoutException, httpx.RequestError):
            return False

    async def generate_chat_completion(
        self,
        system_prompt: str,
        user_message: str,
        temperature: float = DEFAULT_TEMPERATURE,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        top_p: float = DEFAULT_TOP_P,
        presence_penalty: float = DEFAULT_PRESENCE_PENALTY,
        top_k: int = DEFAULT_TOP_K,
        enable_thinking: bool = DEFAULT_ENABLE_THINKING,
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Dict[str, Any], str]:
        """
        Sends chat completion request to llama-server with response_format json_object.
        Suppresses thinking tokens via top-level and extra_body chat_template_kwargs.

        Returns:
            Tuple of (parsed_dict, raw_content_str)

        Raises:
            LLMConnectionError: If server connection is refused or down
            LLMTimeoutError: If inference exceeds timeout limit
            LLMResponseError: If server responds with 4xx/5xx status
            LLMParseError: If server response or content cannot be parsed as JSON
        """
        extra_body_dict: Dict[str, Any] = {
            "top_k": top_k,
            "chat_template_kwargs": {"enable_thinking": enable_thinking},
        }
        if extra_body:
            extra_body_dict.update(extra_body)

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            "temperature": temperature,
            "top_p": top_p,
            "presence_penalty": presence_penalty,
            "max_tokens": max_tokens,
            "stream": False,
            "response_format": {"type": "json_object"},
            # Top-level kwargs for llama-server Jinja template
            "top_k": top_k,
            "chat_template_kwargs": {"enable_thinking": enable_thinking},
            # extra_body envelope for vLLM & OpenAI SDK compatibility
            "extra_body": extra_body_dict,
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
    "DEFAULT_TEMPERATURE",
    "DEFAULT_TOP_P",
    "DEFAULT_PRESENCE_PENALTY",
    "DEFAULT_TOP_K",
    "DEFAULT_MAX_TOKENS",
    "DEFAULT_ENABLE_THINKING",
    "LLMClientError",
    "LLMConnectionError",
    "LLMTimeoutError",
    "LLMResponseError",
    "LLMParseError",
    "strip_thinking_tokens",
    "strip_markdown_fences",
    "extract_json_object",
    "parse_llm_json",
    "resolve_llm_endpoints",
    "resolve_default_model",
    "LLMClient",
]
