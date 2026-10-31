"""
ai/prompt_engine.py
Prompt Engine Module for Rest-In-Hackaton DEV-B AI Middleware.
Handles loading, caching, validating, and safe formatting of NPC prompt templates.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

# Setup logger
logger = logging.getLogger("ai.prompt_engine")

# Base directory where prompt files reside
_CANDIDATE_DIRS = [
    Path(__file__).resolve().parent / "prompts",
    Path(__file__).resolve().parents[1] / "ai" / "prompts",
    Path("/home/archi/Projects/Rest-In-Hackaton/ai/prompts"),
]
DEFAULT_PROMPTS_DIR = next((d for d in _CANDIDATE_DIRS if d.is_dir()), _CANDIDATE_DIRS[0])
PROMPTS_DIR = Path(os.getenv("AI_PROMPTS_DIR", str(DEFAULT_PROMPTS_DIR)))

# Supported NPCs
SUPPORTED_NPCS = frozenset({
    "lao_wang",
    "auntie_li",
    "electronics_zhang",
    "chef_chen",
    "granny_liu",
    "guard_zhang",
})

# Global fallback defaults for prompt variable interpolation
GLOBAL_DEFAULTS: Dict[str, Any] = {
    "price": 800,
    "price_floor": 120,
    "mianzi": 50,
    "aggro": 0,
    "history": "[]",
}

# Persona-specific context defaults
NPC_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "lao_wang": {
        "price": 800,
        "price_floor": 120,
        "mianzi": 50,
        "aggro": 0,
        "history": "[]",
    },
    "auntie_li": {
        "price": 300,
        "price_floor": 80,
        "mianzi": 50,
        "aggro": 0,
        "history": "[]",
    },
    "electronics_zhang": {
        "price": 65,
        "price_floor": 25,
        "mianzi": 50,
        "aggro": 0,
        "history": "[]",
    },
    "chef_chen": {
        "price": 30,
        "price_floor": 15,
        "mianzi": 50,
        "aggro": 0,
        "history": "[]",
    },
    "granny_liu": {
        "price": 150,
        "price_floor": 50,
        "mianzi": 50,
        "aggro": 0,
        "history": "[]",
    },
    "guard_zhang": {
        "price": 0,
        "price_floor": 0,
        "mianzi": 50,
        "aggro": 0,
        "history": "[]",
    },
}

# In-memory template cache
_PROMPT_CACHE: Dict[str, str] = {}


class SafeContextDict(dict):
    """
    A dictionary subclass that returns fallback values for missing keys,
    preventing KeyError exceptions during template string formatting.
    """

    def __init__(self, *args, defaults: Optional[Dict[str, Any]] = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.defaults = defaults or {}

    def __missing__(self, key: str) -> Any:
        if key in self.defaults:
            return self.defaults[key]
        # Preserve unknown curly bracket tokens instead of raising KeyError
        return f"{{{key}}}"


def get_supported_npcs() -> List[str]:
    """Return a sorted list of supported NPC identifiers."""
    return sorted(list(SUPPORTED_NPCS))


def normalize_npc_id(npc_id: str) -> str:
    """Sanitize and normalize NPC identifier."""
    if not npc_id or not isinstance(npc_id, str):
        raise ValueError(f"Invalid NPC ID: {npc_id!r}")
    # Strip any directory path components and .txt extension
    clean = Path(npc_id.strip()).stem.lower()
    if clean not in SUPPORTED_NPCS:
        raise ValueError(
            f"Unknown NPC ID '{npc_id}'. Supported NPCs: {get_supported_npcs()}"
        )
    return clean


def load_prompt(npc_id: str, reload: bool = False) -> str:
    """
    Load raw prompt template text for an NPC from the prompts directory.

    Args:
        npc_id: Target NPC identifier ('lao_wang', 'chef_chen', 'guard_zhang').
        reload: If True, bypass cache and reload from disk.

    Returns:
        Unformatted template text string.

    Raises:
        ValueError: If npc_id is invalid, unknown, or file cannot be read.
    """
    clean_id = normalize_npc_id(npc_id)

    if not reload and clean_id in _PROMPT_CACHE:
        return _PROMPT_CACHE[clean_id]

    prompt_path = PROMPTS_DIR / f"{clean_id}.txt"

    if not prompt_path.is_file():
        raise ValueError(
            f"Prompt file for NPC '{clean_id}' not found at path: {prompt_path}"
        )

    try:
        content = prompt_path.read_text(encoding="utf-8")
    except PermissionError as e:
        raise ValueError(f"Permission denied reading prompt file {prompt_path}: {e}") from e
    except OSError as e:
        raise ValueError(f"OS error reading prompt file {prompt_path}: {e}") from e

    _PROMPT_CACHE[clean_id] = content
    return content


def format_prompt(
    npc_id: str,
    context: Optional[Union[Any, Dict[str, Any]]] = None,
) -> str:
    """
    Load and format the system prompt template for an NPC with dynamic context.

    Safely substitutes {price}, {price_floor}, {mianzi}, {aggro}, {history}.
    Missing keys are filled using persona-specific and global defaults to prevent KeyError.

    Args:
        npc_id: Target NPC identifier.
        context: DialogueContext instance or dictionary of variables.

    Returns:
        Formatted prompt ready to be sent as the LLM system message.

    Raises:
        ValueError: If npc_id is unknown or template formatting encounters a syntax error.
    """
    clean_id = normalize_npc_id(npc_id)
    template = load_prompt(clean_id)

    # Merge hierarchy: GLOBAL_DEFAULTS -> NPC_DEFAULTS -> provided context
    merged_defaults = {**GLOBAL_DEFAULTS, **NPC_DEFAULTS.get(clean_id, {})}

    ctx_dict: Dict[str, Any] = {}
    if context is not None:
        if hasattr(context, "model_dump"):
            ctx_dict = context.model_dump()
        elif hasattr(context, "dict"):
            ctx_dict = context.dict()
        elif isinstance(context, dict):
            ctx_dict = dict(context)
        else:
            try:
                ctx_dict = dict(context)
            except Exception:
                ctx_dict = {}

    # Serialize history if structured
    if "history" in ctx_dict and ctx_dict["history"] is not None:
        hist_val = ctx_dict["history"]
        if isinstance(hist_val, (list, dict)):
            ctx_dict["history"] = json.dumps(hist_val, ensure_ascii=False)
        else:
            ctx_dict["history"] = str(hist_val)

    # Filter out None values to allow defaults to kick in
    active_ctx = {k: v for k, v in ctx_dict.items() if v is not None}
    safe_mapping = SafeContextDict(active_ctx, defaults=merged_defaults)

    try:
        return template.format_map(safe_mapping)
    except Exception as e:
        logger.error("Failed to format prompt for '%s': %s", clean_id, e)
        raise ValueError(f"Failed to format prompt for NPC '{clean_id}': {e}") from e


# Alias conforming to PROJECT.md interface contract
format_system_prompt = format_prompt


def clear_cache() -> None:
    """Clear in-memory prompt template cache."""
    _PROMPT_CACHE.clear()


def validate_all_prompts() -> Dict[str, bool]:
    """
    Validate that all known prompt files exist, can be loaded, and format without syntax errors.

    Returns:
        Dict mapping npc_id to validation success status.
    """
    results: Dict[str, bool] = {}
    for npc_id in get_supported_npcs():
        try:
            formatted = format_prompt(npc_id, None)
            results[npc_id] = len(formatted) > 0
        except Exception as e:
            logger.error("Prompt validation failed for %s: %s", npc_id, e)
            results[npc_id] = False
    return results


__all__ = [
    "format_prompt",
    "format_system_prompt",
    "load_prompt",
    "validate_all_prompts",
    "clear_cache",
    "get_supported_npcs",
    "normalize_npc_id",
    "SafeContextDict",
    "PROMPTS_DIR",
]
