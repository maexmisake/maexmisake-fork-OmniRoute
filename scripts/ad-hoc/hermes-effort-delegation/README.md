# Experimental Hermes effort delegation

This is **new, optional client integration** for Hermes source pin
`749cb638ff43f9ce5333c186a1e4f67d473aa4f2`. It is disabled by default. No plugin,
patch, client configuration or credential has been installed or changed by this
work. It does not change OmniRoute's server defaults.

Ordinary Hermes `custom` intentionally turns unset reasoning into Medium. A
post-builder filter cannot distinguish that generated Medium from a user's
explicit Medium. This package changes the default at the profile hook instead;
it never deletes an explicit effort after request assembly.

| Input to the pinned main builder                 | Result                       |
| ------------------------------------------------ | ---------------------------- |
| Ordinary `custom`, unset                         | Existing Medium              |
| New profile, enabled exact relay/combo, unset    | No effort carrier            |
| Explicit Medium or High                          | Same explicit effort         |
| Explicit reasoning-off or one-shot recovery-off  | Explicit `none`              |
| Existing rejection-driven omission               | Omission retained            |
| Disabled, wrong URL/combo, missing/wrong profile | Rejected before SDK dispatch |

The profile uses the existing OpenAI-compatible effort vocabulary and clamping
policy. It does not pretend the model lacks reasoning. It declares ordinary
API-key relay authentication, not OAuth or provider entitlement.

## Components

- `profile.py`: pure profile and exact nonsecret target binding.
- `__init__.py` and `plugin.yaml`: optional model-provider entry point.
- `binding.example.json`: disabled example. An optional `binding.json` may contain
  only `enabled`, `base_url`, and `combo`; credentials do not belong there.
- `hermes-749cb638.patch`: two narrow guards in the pinned main builder. They
  reject the deliberately selected new profile when unavailable and reject
  unsupported non-chat API modes. `PATCH-PIN.json` binds original/patched bytes.
- `LICENSE`: upstream MIT notice retained for derived source.

The guards are required. An original-builder regression control demonstrates that
a retained provider identity with a missing profile can fall through the legacy
path and lose explicit High. The profile hook alone cannot prevent that case.
The inspected builder propagates profile/guard exceptions before request
middleware; the middleware's later fail-open behavior cannot recover an omitted
profile by continuing that same build.

## Configuration boundary

The proposed provider ID is `omniroute-delegated`; it is not a built-in Hermes
setting. Selecting it is separate from ordinary `custom`. The optional binding
must explicitly enable one exact base URL and one combo name. URL matching allows
only a trailing-slash spelling difference; lookalike hosts, different paths,
userinfo, query and fragment variants are rejected. The profile declares
`OMNIROUTE_RELAY_API_KEY` for Hermes's existing API-key resolver; this work neither
reads nor creates a real key.

Official pinned source supports model-provider directories containing a manifest
and self-registering `__init__.py` under the user's Hermes provider-plugin
directory. This package has not been installed through that loader, and no new
installation command is asserted here. A future activation needs review of the
exact client version, configuration and its independently configured fallbacks.
These guards cover the inspected main request build; this is not a claim about
every full-agent retry/fallback path.

## Offline proof

`tests/fixtures/decisionPolicy/hermesEffort/build_request.py` runs pinned main-loop
reasoning/default resolution, the original transport, and the optional patch in
memory. It accepts a named case plus optional supplied message history and tool
flag. `capturedKwargs` and separately declared `driverFlags` can be handed directly
to the installed SDK fixture. Metadata about source execution is never part of
those kwargs or the request body.

This source capture uses supplied **parsed** reasoning state, closed import
facades, a selected original profile-field declaration subset, unknown capability
metadata, identity message sanitization and no real credentials, discovery or
sockets. It does not run CLI configuration resolution or the full Hermes agent.
The default resolver is a frozen, previously retrieved official web-rendered
fragment; its raw whole-module/blob hash is deliberately not claimed. Other
fragments retain byte-checked cached source pins. See the fixture's provenance.

Installed-SDK serialization, actual-handler routing, and full Hermes behavior are
separate evidence layers. An omitted effort lets the router choose among eligible
efforts; explicit effort still constrains it. Tool continuation must retain the
trusted originating pair/account/effort without another decision. Explicit
conflict or off must reject when the pinned execution cannot honor it.

Pinned source references: [profile/default interface](https://github.com/NousResearch/hermes-agent/blob/749cb638ff43f9ce5333c186a1e4f67d473aa4f2/providers/base.py#L315),
[custom Medium default](https://github.com/NousResearch/hermes-agent/blob/749cb638ff43f9ce5333c186a1e4f67d473aa4f2/plugins/model-providers/custom/__init__.py#L46),
[registry](https://github.com/NousResearch/hermes-agent/blob/749cb638ff43f9ce5333c186a1e4f67d473aa4f2/providers/__init__.py#L1),
[API-key profile mirror](https://github.com/NousResearch/hermes-agent/blob/749cb638ff43f9ce5333c186a1e4f67d473aa4f2/hermes_cli/auth_plugin_providers.py#L39),
[main builder](https://github.com/NousResearch/hermes-agent/blob/749cb638ff43f9ce5333c186a1e4f67d473aa4f2/agent/chat_completion_helpers.py#L1437).
