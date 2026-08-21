// Provider identity strings, in their own module so reading one does NOT drag in
// `keys()` and its env validation. `providers/attempts.ts` calls `keys()` at
// module scope, so anything importing a constant from there needed a full,
// valid environment — which is why routing logic that only needs to compare a
// provider name could not be unit-tested. Import these from
// `@repo/ai/providers/names` in code (and tests) that has no business holding an
// API key.
//
// These strings are also the `failedKeys` namespace (`provider:model`), so they
// must stay stable and must not collide with a BYOK provider id (see
// providers/byok, which namespaces its own).

export const GEMINI_PROVIDER = 'gemini';
export const HACKCLUB_PROVIDER = 'hackclub';
// A friend's self-hosted OpenWebUI (chat.mebbo.cloud), re-exposing free
// upstream endpoints on ONE key shared with everyone he gave it to.
export const MEBBO_PROVIDER = 'mebbo';
// OpenCode Zen (opencode.ai/zen), an OpenAI-compatible gateway. Only its Ox
// Alpha Free slug is wired, and only because THAT model's provider states a
// zero-retention / no-training policy (Zen docs, checked 2026-08-21) — every
// OTHER free slug on Zen may train on traffic and stays banned. See MODELS.md.
export const OPENCODE_PROVIDER = 'opencode';
