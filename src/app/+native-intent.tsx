// The Supabase OAuth callback (`forage://google-auth#access_token=...`) isn't an app route —
// it's consumed by `WebBrowser.openAuthSessionAsync` in google-sign-in-button.tsx, which
// resolves the promise and calls `supabase.auth.setSession` independently of the router.
// Without this, expo-router's own Linking subscriber (see expo-router's link/linking.js)
// also receives that same URL event and tries to navigate to a "google-auth" route that
// doesn't exist, surfacing an "Unmatched route" error even though sign-in succeeded.
//
// Returning `null` here means "no redirection occurs and the app stays on the current
// path" (see expo-router's NativeIntent type) — exactly what we want for this callback.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (path.includes('google-auth')) {
      return null;
    }
    return path;
  } catch {
    return null;
  }
}
