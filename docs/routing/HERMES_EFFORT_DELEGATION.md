---
title: Experimental Hermes effort delegation
description: Optional pinned client integration that delegates only an unset default for one approved relay and combo.
---

# Experimental Hermes effort delegation

The normal Hermes custom-provider path emits Medium when effort is unset. That
wire value remains a hard routing constraint. Removing a user's setting alone
does not enable automatic effort selection.

An optional, disabled-by-default client prototype is available under
[scripts/ad-hoc/hermes-effort-delegation](../../scripts/ad-hoc/hermes-effort-delegation/README.md).
It uses a dedicated API-key relay profile and a small patch pinned to Hermes
`749cb638ff43f9ce5333c186a1e4f67d473aa4f2`. It changes only the profile's default:
an enabled exact relay/combo can omit effort, while explicit Medium, High, XHigh, Max and off
remain explicit. Recovery omission is retained. No private provenance field is
added to the wire.

The new provider is rejected before SDK dispatch when its profile is absent,
disabled, pointed at another URL/combo, or used with an unsupported API mode.
Ordinary Hermes `custom` retains its existing behavior. The prototype does not
change the router's default mode, permissions, provider credentials or fallback
policy. No client installation or configuration change has been performed.

Source-builder, SDK-wire and actual-handler checks must be assessed separately.
The source fixture runs pinned function bodies with closed collaborators and
supplied parsed reasoning state; it is not the full Hermes CLI. Its default
resolver has a documented web-rendered-fragment provenance boundary. The package
README records the exact source and scope.

For an actual omitted-effort request, the router may select an eligible model
and effort. Explicit effort continues to restrict eligibility. A tool-result
continuation uses the trusted original model/account/effort without a new
decision; a conflicting explicit effort or reasoning-off must fail closed if
that pair cannot honor it. Catalog entries and these synthetic checks do not
establish real account availability or live provider compatibility.

The current source-builder suite passes 24 cases. The actual installed-SDK suite
passes 37 cases through the real application handler, including literal XHigh/Max
and deliberate omission over two-request tool loops. The wide fixture pool uses
only original Claude Medium/High/XHigh/Max pairs; it is not live capability or
quality evidence. One mock native choice is followed by two separately accounted
executions with the same pinned identity and output cap. Explicit effort is
present on both client requests; delegated omission is absent on both. Max is
not renamed to XHigh. These tests do not install the profile or execute the full
Hermes runtime/plugin loader.

A separately configured original-builder request can also carry redundant nested
`reasoning: {enabled: true, effort: "high"}`. The router accepts consistent
explicit intent at ingress and canonicalizes it without forwarding enabled to
the provider. Enabled-only, false, contradictory, unknown and unsupported sampling
controls remain rejected. This is configured fragment/SDK evidence, not a claim
that ordinary full-agent default traffic emits this envelope.
