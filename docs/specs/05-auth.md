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

## Known gap: no `user_account` bootstrap

`user_account.id` references `auth.users(id)` (see `03-data-model.md`), but nothing populates
`user_account` (or `household` / `household_member`) when a new `auth.users` row is created —
confirmed directly against the disposable test project: no trigger on `auth.users`, both
tables empty. A signed-in user today has a Supabase session and nothing else. This doesn't
break anything yet because the home screen doesn't query household-scoped data — but the first
feature that does will need this solved first. See `docs/decisions/deferred.md`.
