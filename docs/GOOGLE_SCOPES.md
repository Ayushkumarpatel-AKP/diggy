# Google OAuth scopes Diggy asks for

Diggy's local plugin API requests exactly five Google scopes when it connects a
Google account (`services/api/src/providers.ts` → `GOOGLE_SCOPES`):

```
openid  email  profile
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/calendar
```

This file records what each one is, how Google classifies it, what Google
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
| `https://www.googleapis.com/auth/gmail.readonly` | **Read** all of the user's Gmail messages and settings. | **Restricted** | OAuth app verification **and** a third-party security assessment (CASA — annual, done by an authorized assessor). | Personal/testing use is fine. A public release is blocked until the security assessment is passed — the single biggest gating item here. |
| `https://www.googleapis.com/auth/calendar` | Full read/write access to the user's calendars and events (create, edit, delete). | **Sensitive** | OAuth app verification: homepage + privacy policy, per-scope justification, and a demo video of the consent flow. | Use build/dev freely with test users; a public release needs ordinary verification but **no** security assessment. |

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
  is what stands between Diggy and a public Gmail launch.

## Testing vs. shipping (the practical bit)

- **Personal / testing is fine.** Keep the OAuth consent screen in **Testing**,
  add your own address (and any collaborators) as test users, and the full set
  of scopes works — including `gmail.readonly`. Nothing needs verification to
  build and use Diggy yourself.
- **Caveat while in Testing:** Google expires **refresh tokens after 7 days**,
  so the user has to re-consent about weekly. Fine for development, not for a
  shipped product — plan to move the consent screen to "In production" (which
  is what triggers the reviews above).
- **Public release order:** `openid` / `email` / `profile` / `calendar` are
  reachable through ordinary verification. `gmail.readonly` additionally needs
  the security assessment; until then, ship without Gmail or keep the app in
  Testing.

## Two accuracy notes

1. **`gmail.readonly` is *restricted*, not merely "sensitive".** `docs/PROJECT.md`
   (§8) calls it "the sensitive `gmail.readonly` scope". That understates it:
   Google classifies Gmail data scopes in the stricter **restricted** tier, which
   adds the security assessment.
2. **The extension path asks for a slightly different set.** `apps/extension/src/google.ts`
   requests `gmail.readonly`, `calendar.readonly`, `calendar.events`, and
   `userinfo.email` (the OIDC scopes are expressed as `userinfo.email` rather than
   `openid email profile`). `calendar.readonly` and `calendar.events` are also
   **sensitive**; the table above covers the API-side set.

## How to confirm before relying on this

I am confident about `gmail.readonly` → restricted and `calendar` → sensitive as
written, but Google does reclassify scopes and the tier is attached to the scope
in the **Google Cloud Console → OAuth consent screen → Data access** view. Treat
that screen (and Google's "OAuth API verification" docs) as the source of truth
for the specific client you register, rather than this summary.
