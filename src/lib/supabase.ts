import { createClient } from '@supabase/supabase-js';
import { deleteItemAsync, getItemAsync, setItemAsync } from 'expo-secure-store';
import { Platform } from 'react-native';

// expo-secure-store is native-only. Google sign-in is native-only too (see docs/specs/05-auth.md),
// but this module still gets pulled into Expo Router's web/SSR bundle regardless — so every call
// here has to no-op there instead of hitting the (absent) native module.
const isNative = Platform.OS !== 'web';

const ExpoSecureStoreAdapter = {
  getItem: (key: string) => (isNative ? getItemAsync(key) : Promise.resolve(null)),
  setItem: (key: string, value: string) => (isNative ? setItemAsync(key, value) : Promise.resolve()),
  removeItem: (key: string) => (isNative ? deleteItemAsync(key) : Promise.resolve()),
};

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  {
    auth: {
      storage: ExpoSecureStoreAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }
);
