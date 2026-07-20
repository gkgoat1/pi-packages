# Thinking Compression

Optional Pi extension that retains a shorter continuation memo in place of an
eligible assistant thinking block. It is **disabled by default** and only ever
changes an explicitly allowlisted source model's plain, unsigned thinking.

## Setup

In a trusted project, create `${CONFIG_DIR_NAME}/thinking-compression.json`
(usually `.pi/thinking-compression.json`):

```json
{
  "enabled": true,
  "sources": [{ "provider": "openrouter", "model": "open-weight-reasoner" }],
  "compressor": {
    "provider": "openrouter",
    "model": "meta-llama/llama-3.3-70b-instruct",
    "maxOutputTokens": 384,
    "timeoutMs": 8000
  },
  "minimumThinkingTokens": 800,
  "minimumSavingsRatio": 0.35
}
```

The compressor is resolved through Pi's native model runtime and must already
have configured authentication. It receives only the eligible thinking and
visible assistant text. It receives no session transcript, tools, provider
headers, or credentials.

## Safety

Any signature (including an empty present signature), encryption, replay token,
unknown content representation, malformed config, failure, cancellation, or
insufficient savings results in an unchanged original message. This generic
extension runs at final message lifecycle time, so it reduces **retained
next-turn context** but does not promise to hide live-streamed thinking. A
provider-owned buffered stream wrapper is required for that guarantee.

Diagnostics contain aggregate character counts, routes, and duration only; raw
thinking is not logged.