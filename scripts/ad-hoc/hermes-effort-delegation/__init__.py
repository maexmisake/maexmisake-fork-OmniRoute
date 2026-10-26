"""Optional model-provider entry point; auth remains owned by Hermes.

This file reads only its own nonsecret binding. The offline fixture does not
execute installed plugin discovery or the framework's authentication resolver.
"""

import json
from pathlib import Path

from providers import register_provider

from .profile import DelegatingRelayProfile

binding_file = Path(__file__).with_name("binding.json")
if binding_file.exists():
    # This optional file contains nonsecret route/combo approval only. Credentials
    # remain in Hermes's existing API-key path, never in the binding document.
    try:
        with binding_file.open("rb") as stream:
            raw = stream.read(4097)
        if len(raw) > 4096:
            raise ValueError("omniroute_delegation_binding_invalid")
        binding = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, ValueError):
        raise ValueError("omniroute_delegation_binding_invalid") from None
else:
    binding = {"enabled": False}

register_provider(DelegatingRelayProfile(binding))
