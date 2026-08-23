# Auth

> **Living document.** Describes the present. If it disagrees with the code, one of them is
> wrong — say so rather than quietly following either.

## What exists today

Google-only sign-in via Supabase Auth, gating the app on native (iOS/Android). Web is **not**
gated — `src/app/_layout.web.tsx` renders `AppTabs` directly and never mounts `AuthProvider`.
Web sign-in is unimplemented, not just unstyled.

- **Client:** `src/lib/supabase.ts`. Session persisted via `expo-secure-store`
  (`autoRefreshToken`, `persistSession`, `detectSessionInUrl: false` — native has no URL to
  detect a session from).
- **Session state:** `src/hooks/use-auth.tsx` — `AuthProvider` / `useAuth`. Wraps
  `supabase.auth.getSession()` on mount plus `onAuthStateChange`.
- **Gate:** `src/app/_layout.tsx` (native) — while `isLoading`, renders nothing (the existing
  `AnimatedSplashOverlay` already covers the screen for this window); once resolved, renders
  `SignInScreen` or `AppTabs` depending on `session`. `src/app/_layout.web.tsx` is the separate,
  ungated web root layout — see the SSR note below for why this split exists at the file level
  rather than as a `Platform.OS` branch inside one file.
- **Sign-in flow:** `src/components/google-sign-in-button.tsx`. `supabase.auth.signInWithOAuth`
  with `skipBrowserRedirect: true` → `expo-web-browser`'s `openAuthSessionAsync` opens the
  Google consent screen → the `forage://google-auth` deep link (from `app.json`'s `scheme`)
  returns control to the app → access/refresh tokens are parsed from the callback URL fragment
  and passed to `supabase.auth.setSession`.
- **Sign-out:** `src/components/sign-out-button.tsx` (native) / `sign-out-button.web.tsx`
  (no-op), used as a header icon on the home screen (`src/app/index.tsx`).
- **Suppressing router navigation on the OAuth callback:** `src/app/+native-intent.tsx`.
  `forage://google-auth` is delivered to the app as an ordinary incoming URL (confirmed via
  `adb logcat`: Chrome sends it as a `VIEW`/`BROWSABLE` intent straight to `MainActivity`), so
  expo-router's own `Linking` subscriber — separate from `WebBrowser.openAuthSessionAsync`'s own
  listener, which correctly resolves the auth session — also sees it and tries to navigate to a
  `google-auth` route that doesn't exist, surfacing an "Unmatched route" error even though
  `setSession` succeeds underneath it. `redirectSystemPath` returns `null` for any path
  containing `google-auth`, which per expo-router's `NativeIntent` type means "no redirection
  occurs and the app stays on the current path." Verified on-device: sign-out → sign-in with
  Google no longer shows the error and lands correctly on `AppTabs`.

### Why `_layout.tsx` / `_layout.web.tsx` are separate files, not a `Platform.OS` branch

Found while verifying this feature (`expo export --platform web` and `expo start --web` both
crashed before this split existed): `app.json`'s `web.output: "static"` makes Expo Router
server-render every route through a Node-environment bundle. That bundle pulled in
`src/lib/supabase.ts` even when the only code path importing it was behind a runtime
`Platform.OS === 'web'` check in a single shared `_layout.tsx` — Metro's platform-extension
resolution (`.web.tsx` over `.tsx`) is what actually keeps native-only modules out of a
bundle; a runtime branch inside one file does not. Splitting into `_layout.tsx` /
`_layout.web.tsx` fixed the export.

Separately — and kept as defense in depth, since the mechanism above wasn't fully diagnosed
past "the file split fixes it" — `src/lib/supabase.ts`'s storage adapter also no-ops on
`Platform.OS === 'web'` rather than calling into `expo-secure-store`. `supabase-js` loads a
session from storage the moment `createClient()` runs, not lazily on first `getSession()`
call, so any environment that ends up constructing this client (this SSR bundle, or a real
browser) would otherwise hit a native module that isn't there.

## Required Supabase dashboard config (not managed by this repo)

`forage://google-auth` must be added to **Authentication → URL Configuration → Redirect URLs**
in the Supabase project. Without it, `signInWithOAuth` completes on Google's side but the
redirect back into the app is rejected.

## Household bootstrap

`user_account.id` references `auth.users(id)` (see `03-data-model.md`). A signed-in user with no
household yet is routed to onboarding rather than the app — see ADR 0015 for why this is a
client-driven step rather than a trigger on `auth.users`, and for the RLS policies it required.

- **State:** `src/hooks/use-household.tsx` — `HouseholdProvider` / `useHousehold`. Runs only once
  a session exists (nested inside `AuthProvider`). On mount: upserts the caller's `user_account`
  row (`ignoreDuplicates`, so it never overwrites `display_name` on a later sign-in), then queries
  `household_member` for an accepted, non-deleted row. `display_name` is taken from the Google
  profile (`user_metadata.full_name` / `.name`) when present, `null` otherwise — never fabricated.
- **Gate:** `src/app/_layout.tsx` — `AuthGate` renders `SignInScreen` with no session; with a
  session, wraps `HouseholdGate` in `HouseholdProvider`. `HouseholdGate` renders `AppTabs` once
  `householdId` resolves, otherwise `HouseholdOnboardingScreen`.
- **Onboarding UI:** `src/components/household-onboarding-screen.tsx`. Lets the user create a
  household (name field, becomes `owner`) or join any existing one from a full list (becomes
  `member`). Calls `useHousehold().refresh()` on success to re-run the membership check and fall
  through the gate into `AppTabs`.
- **MVP assumption:** one household per user. If a user somehow has more than one accepted
  membership row, the client silently takes the earliest-joined one — see
  `docs/decisions/deferred.md`.
