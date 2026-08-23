import { Image } from 'expo-image';
import Constants from 'expo-constants';
import { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { ThemedText } from '@/components/themed-text';
import { supabase } from '@/lib/supabase';

WebBrowser.maybeCompleteAuthSession();

const rawScheme = Constants.expoConfig?.scheme;
const scheme = Array.isArray(rawScheme) ? rawScheme[0] : rawScheme;
const redirectTo = `${scheme}://google-auth`;

function extractTokensFromCallback(url: string) {
  const fragment = url.split('#')[1] ?? '';
  const params = new URLSearchParams(fragment);
  return {
    accessToken: params.get('access_token'),
    refreshToken: params.get('refresh_token'),
  };
}

export function GoogleSignInButton() {
  useEffect(() => {
    WebBrowser.warmUpAsync();
    return () => {
      WebBrowser.coolDownAsync();
    };
  }, []);

  async function handlePress() {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });

    if (error || !data.url) {
      console.error('Failed to start Google sign-in', error);
      return;
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== 'success') return;

    const { accessToken, refreshToken } = extractTokensFromCallback(result.url);
    if (!accessToken || !refreshToken) {
      console.error('Google sign-in callback did not include a session');
      return;
    }

    const { error: sessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (sessionError) console.error('Failed to establish session', sessionError);
  }

  return (
    <Pressable onPress={handlePress} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
      <Image
        style={styles.logo}
        source={{ uri: 'https://developers.google.com/identity/images/g-logo.png' }}
        contentFit="contain"
      />
      <ThemedText type="smallBold" style={styles.label}>
        Sign in with Google
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DADCE0',
    alignSelf: 'stretch',
  },
  pressed: {
    opacity: 0.7,
  },
  logo: {
    width: 20,
    height: 20,
  },
  label: {
    color: '#3C4043',
  },
});
