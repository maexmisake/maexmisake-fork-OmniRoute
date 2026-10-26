"""Experimental opt-in Hermes profile for one explicitly approved OmniRoute combo.

This is new client integration, not a built-in Hermes flag. It requires the
adjacent pinned main-builder patch; it never installs or configures itself.
"""

from dataclasses import dataclass
from typing import Any, NoReturn
from urllib.parse import urlsplit

from agent.reasoning_effort import OPENAI_COMPAT_WIRE_EFFORTS, clamp_effort
from providers.base import ProviderProfile

PROVIDER_ID = "omniroute-delegated"


def rejected() -> NoReturn:
    raise ValueError("omniroute_delegation_target_rejected")


def exact_base(value: Any) -> str:
    if not isinstance(value, str) or value != value.strip():
        rejected()
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or "\\" in value
        ):
            rejected()
        parsed.port  # Validate malformed/out-of-range ports without changing them.
    except (TypeError, ValueError):
        rejected()
    # No hostname/subdomain/path guessing; the only accepted spelling change is '/'.
    return value.rstrip("/")


@dataclass(frozen=True)
class ApprovedBinding:
    enabled: bool = False
    base_url: str = ""
    combo: str = ""


def approved_binding(raw: Any) -> ApprovedBinding:
    if not isinstance(raw, dict) or set(raw) - {"enabled", "base_url", "combo"}:
        rejected()
    enabled = raw.get("enabled", False)
    base_url = raw.get("base_url", "")
    combo = raw.get("combo", "")
    if not isinstance(enabled, bool) or not isinstance(combo, str):
        rejected()
    if not isinstance(base_url, str):
        rejected()
    if not enabled:
        return ApprovedBinding()
    if not combo or combo != combo.strip() or len(combo) > 128:
        rejected()
    return ApprovedBinding(True, exact_base(base_url), combo)


class DelegatingRelayProfile(ProviderProfile):
    """A truthful API-key relay profile; no provider capability impersonation."""

    def __init__(self, raw_binding: Any):
        self._approved_binding = approved_binding(raw_binding)
        super().__init__(
            name=PROVIDER_ID,
            display_name="OmniRoute explicit effort delegation (experimental)",
            auth_type="api_key",
            env_vars=("OMNIROUTE_RELAY_API_KEY",),
            base_url=self._approved_binding.base_url,
            api_mode="chat_completions",
            hidden=True,
            supports_model_listing=False,
            supports_health_check=False,
        )

    def default_reasoning_config(self, model: str | None = None) -> dict | None:
        binding = self._approved_binding
        if binding.enabled and model == binding.combo:
            return None
        # Unmatched/disabled defaults remain ordinary custom Medium. The final
        # profile hook still rejects that route, rather than dispatch elsewhere.
        return {"enabled": True, "effort": "medium"}

    def build_api_kwargs_extras(
        self, *, reasoning_config: dict | None = None, **context: Any
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        binding = self._approved_binding
        if (
            not binding.enabled
            or context.get("model") != binding.combo
            or exact_base(context.get("base_url")) != binding.base_url
        ):
            rejected()
        if reasoning_config is None:
            # Both genuine default delegation and Hermes's own rejection-driven
            # omission arrive as None. Neither is rewritten to Medium here.
            return {}, {}
        if not isinstance(reasoning_config, dict):
            rejected()
        effort = reasoning_config.get("effort") or ""
        if not isinstance(effort, str):
            rejected()
        effort = effort.strip().lower()
        if effort == "none" or reasoning_config.get("enabled", True) is False:
            return {}, {"reasoning_effort": "none"}
        if not effort:
            return {}, {}
        return {}, {"reasoning_effort": clamp_effort(effort, OPENAI_COMPAT_WIRE_EFFORTS)}
