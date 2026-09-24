# Manual retry

Adds `/retry-last` to retry the last rate-limit, quota, or service-unavailable failure without adding a user message to the LLM request. Requires Pi 0.87.1+.

## Usage

1. Run `/reload` after installing the extension.
2. Let Pi finish its normal automatic retries and stop.
3. Once the limit is resolved or the service recovers (or after selecting another account/model), run `/retry-last`.

The command takes no arguments. It refuses to run while Pi is busy or has queued messages, after a successful/aborted response, or after new conversation content has been added. Switching models and changing labels/session metadata do not prevent retrying. Repeated invocations cannot start overlapping requests. Another supported failure can be retried after the new run fully settles.

Failure detection uses the final assistant's `errorMessage`, including 429, rate-limit, quota-exhaustion, usage-limit, budget and low-credit errors, plus HTTP 503 and `Service unavailable` / `Service temporarily unavailable` (including underscore/hyphen-separated variants). For example, `sub2api API error (503): {"message":"Service temporarily unavailable","type":"api_error"}` is supported. Unknown provider wording may not match. Context-length errors, authentication failures, other network/server errors and tool failures are not handled.

## How it works

The command uses `pi.sendMessage()` with `triggerTurn: true` and an empty, hidden custom message of type `my-pi-setup/manual-retry-wake`. A `context` handler removes **all** such messages before Pi converts the conversation to provider messages, including records restored from previous sessions. `display: false` alone would only hide the UI message, not exclude it from model context.

Pi's built-in API converters already skip assistant messages with `stopReason: "error"` or `"aborted"`. The plugin does not modify those messages or Pi's automatic retry/stop policy, register a provider, or execute previous tool calls again. A resumed model can still choose to issue new tool calls.

## Boundaries

- Raw session history retains the original error and an empty `custom_message` control record per manual attempt. No new user message is stored. This is not a history-free core continuation API.
- Keep the extension loaded when reopening these sessions: its filtering is what keeps the control records out of LLM requests. Other extensions must not reinsert them after filtering.
- Recovery uses the current session context, model, credentials and settings. It is not a byte-for-byte replay of the original HTTP request. Normal compaction and other extensions can still affect the request; the custom-message path does not rerun `input` or `before_agent_start` hooks.
- The plugin does not change compaction/branch-summary handling of partial output from failed responses. Empty wake content itself contributes no text to Pi's built-in summaries.
- After a new user/custom message or a compaction/branch summary, the command rejects the old failure rather than guessing which task to resume.

## Tests

```bash
node --test --experimental-strip-types agent/extensions/manual-retry/*.test.ts
npm run check
```

Tests cover eligibility, duplicate/busy guards, branch changes, restored wake records and a real Pi session against a local mock OpenAI-compatible HTTP endpoint. The integration tests cover both HTTP 429 and 503, inspect provider payloads and verify that existing tool history is retained, failed partial output/wake records are absent, and automatic retries still use the existing policy. They use no real credentials or external API calls.
