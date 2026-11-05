# Claude credits through the proxy

“Cloud credits” can refer to different balances. Check which account issued them
before choosing a credential; there is no switch that converts one type into another.

- **OAuth cloud-session credits:** sign in with Claude OAuth in Authentication
  Files, then refresh quota on that credential or the Quota page. The cloud-session
  row displays the reported USD used, limit, remaining balance and reset separately
  from subscription/Fable windows. Unknown fields stay unknown. These amounts are
  already dollars, not cents. This is read-only visibility, not a spending control.
  The OAuth usage field `iguana_necktie` with dollar amounts identifies this pool;
  the same legacy field without dollar amounts can represent a weekly Fable window.
- **Subscription quota and extra usage:** use the existing Claude OAuth credential
  and select an available Claude model in a client connected to the proxy. Usage
  follows upstream account eligibility and limits. Extra usage must be enabled and
  funded with Anthropic; the proxy does not enable it or guarantee billing priority.
  Extra-usage amounts from the usage response are cents and are displayed as USD.
- **Anthropic Console API-key credits:** in API Access, configure a Claude API-key
  provider using your Console API key. Connect your client to the proxy with its
  existing access key and select the configured model. These requests use the
  configured API provider; they do not convert OAuth or subscription balances into
  Console credits. Keep secrets out of screenshots and support reports.

## What is established for #338?

The question and “fully supported” reply do not identify the credit type or prove
cloud-session request routing. The official WebUI’s Claude usage normalization and
quota display distinguish OAuth dollar balances from subscription/Fable limits:
`src/services/api/claudeUsage.ts` and
`src/features/quota/providers/claude/{data.ts,ClaudeQuotaBody.tsx}`.
Those files establish balance visibility only. They do **not** establish that
ordinary Messages API requests can spend cloud-session credits. No such routing
support or billing guarantee is asserted here; confirm upstream eligibility and
the supported session workflow before attempting paid usage. This change performs
no paid request and adds no billing/configuration switch.
