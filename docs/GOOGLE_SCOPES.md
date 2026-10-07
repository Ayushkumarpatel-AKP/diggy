# Google OAuth scopes Diggy asks for

Diggy asks Google for scopes in **two independent places**, and they are not
identical. Both include the **restricted** `gmail.readonly` scope, so both are
gated by the same Google verification requirements.

### A. The local plugin backend (`services/api`)

The consent URL is built in `services/api/src/oauth.ts` (`SCOPES.google`, used by
`beginAuth`). It requests five scopes:

```
openid  email  profile
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/calendar
```

> `services/api/src/providers.ts` declares a byte-identical `GOOGLE_SCOPES` and
> attaches it to the `google` `ProviderDefinition`, but that `scopes` field is
> **not consumed** anywhere (the `GET /plugins` response omits it). Treat
> `oauth.ts` as the source of truth for what the backend actually sends.

### B. The extension's own Google connection (`apps/extension/src/google.ts`)

The extension can connect to Google directly (OAuth 2.0 + PKCE through
`chrome.identity.launchWebAuthFlow`). Its `GOOGLE_SCOPES` requests a **slightly
different** set:

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/userinfo.email
```

The OIDC scopes are expressed as a single `userinfo.email` rather than
`openid email profile`, and it asks for the finer `calendar.readonly` +
`calendar.events` pair instead of the broad `calendar` scope.

> There is also a **third, scope-free** Gmail path: `apps/extension/src/gmail-session.ts`
> reads Google's public Gmail Atom feed with the browser's own cookies
> (`<all_urls>` host permission, `credentials: 'include'`). It uses **no Google
> Cloud project and no scopes at all** — which is why it needs no verification,
> and also why it only exposes the most recent inbox messages.

This file records what each scope is, how Google classifies it, what Google
requires before a **public** app may use it, and what that means in practice.

> Google uses three tiers: **non-sensitive** (publish freely), **sensitive**
> (Google must review the app), and **restricted** (review **plus** a security
> assessment). The tier decides everything below.

## The scopes

| Scope | What it grants | Tier | Google's requirement for a public app | Practical consequence |
|---|---|---|---|---|
| `openid` | OpenID Connect sign-in; lets Google return an `id_token` identifying the user. | **Non-sensitive** | None. | Ships as-is. No review. |
| `email` | The account's email address (OIDC). | **Non-sensitive** | None. | Ships as-is. No review. |
| `profile` | Basic profile: name, picture, locale (OIDC). | **Non-sensitive** | None. | Ships as-is. No review. |
| `https://www.googleapis.com/auth/userinfo.email` | The account's email address (the extension's OIDC form). | **Non-sensitive** | None. | Same as `email`; ships as-is. |
| `https://www.googleapis.com/auth/gmail.readonly` | **Read** all of the user's Gmail messages and settings. | **Restricted** | OAuth app verification **and** a third-party security assessment (CASA — annual, done by an authorized assessor). | Personal/testing use is fine. A public release is blocked until the security assessment passes — the single biggest gating item here. |
| `https://www.googleapis.com/auth/calendar` | Full read/write access to the user's calendars and events (create, edit, delete). | **Sensitive** | OAuth app verification: homepage + privacy policy, per-scope justification, and a demo video of the consent flow. | Use build/dev freely with test users; a public release needs ordinary verification but **no** security assessment. |
| `https://www.googleapis.com/auth/calendar.readonly` | Read-only access to the user's calendars and events. | **Sensitive** | Same as `calendar`. | Same review as `calendar`; no assessment. |
| `https://www.googleapis.com/auth/calendar.events` | Read/write access to events on all calendars (but not the calendar list/settings). | **Sensitive** | Same as `calendar`. | Same review; no assessment. Powers the extension's "create calendar event". |

## What the requirements actually mean

- **Non-sensitive** — no verification at all. The app can go to "In production"
  and be used by any Google account immediately.
- **Sensitive** — the "Verify app" / OAuth consent-screen review. You submit the
  consent screen, a public homepage (verified in Search Console), a privacy
  policy, a justification per scope, and a demo video; Google reviews it in
  roughly days-to-weeks. Before approval the app can only be used by addresses
  listed as **test users** (100 max) and shows the "Google hasn't verified this
  app" warning.
- **Restricted** — everything a sensitive scope needs **plus** an independent,
  annual security assessment (CASA Tier 2). That is a paid engagement with an
  authorized assessor, not a form. Because `gmail.readonly` is restricted, this
  is what stands between Diggy and a public Gmail launch — **in either path**,
  backend (§A) or extension (§B).

## Testing vs. shipping (the practical bit)

- **Personal / testing is fine.** Keep the OAuth consent screen in **Testing**,
  add your own address (and any collaborators) as test users, and the full set
  of scopes works — including `gmail.readonly`. Nothing needs verification to
  build and use Diggy yourself.
- **Caveat while in Testing:** Google expires **refresh tokens after 7 days**,
  so the user has to re-consent about weekly. Fine for development, not for a
  shipped product — plan to move the consent screen to "In production" (which
  is what triggers the reviews above).
- **Public release order:** `openid` / `email` / `profile` / `userinfo.email`
  and the whole `calendar.*` family are reachable through ordinary verification.
  `gmail.readonly` additionally needs the security assessment; until then, ship
  without Gmail or keep the app in Testing.

## Accuracy notes

1. **`gmail.readonly` is *restricted*, not merely "sensitive".**
   `docs/PROJECT.md` (§8, item 4) calls it "the sensitive `gmail.readonly`
   scope". That understates it: Google classifies Gmail data scopes in the
   stricter **restricted** tier, which adds the annual security assessment.
2. **The extension path (§B) asks for a different set than the backend (§A).**
   `calendar.readonly` and `calendar.events` are **sensitive** (same as
   `calendar`); `userinfo.email` is non-sensitive. The restricted item —
   `gmail.readonly` — is present in **both** sets.
3. **I am confident** that `gmail.readonly` → restricted and the `calendar.*`
   family → sensitive. **I am not able to re-verify** the exact tier Google
   attaches to your specific client from here (no live Console, no network), and
   Google does reclassify scopes. Treat the **Google Cloud Console → OAuth
   consent screen → Data access** view for the exact client you register (and
   Google's "OAuth API verification" docs) as the source of truth rather than
   this summary.
