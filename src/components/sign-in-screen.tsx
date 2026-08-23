import { SymbolView } from 'expo-symbols';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GoogleSignInButton } from '@/components/google-sign-in-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function SignInScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  return (
    <ThemedView style={styles.screen}>
      <View
        style={[
          styles.container,
          { paddingTop: insets.top + Spacing.six, paddingBottom: insets.bottom + Spacing.five },
        ]}>
        <View style={styles.header}>
          <ThemedText type="subtitle" themeColor="tint" style={styles.wordmark}>
            Forage
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Price intelligence for everyday groceries.
          </ThemedText>
        </View>

        <View style={styles.hero}>
          <ThemedView type="backgroundSelected" style={styles.heroIcon}>
            <SymbolView
              name={{ ios: 'chart.line.uptrend.xyaxis', android: 'trending_up', web: 'trending_up' }}
              tintColor={theme.tint}
              size={30}
            />
          </ThemedView>
        </View>

        <View style={styles.footer}>
          <GoogleSignInButton />
          <ThemedText type="small" themeColor="textSecondary" style={styles.disclaimer}>
            Sign in with Google to start tracking prices.
          </ThemedText>
        </View>
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  container: {
    flex: 1,
    alignSelf: 'center',
    maxWidth: MaxContentWidth,
    width: '100%',
    paddingHorizontal: Spacing.four,
  },
  header: {
    gap: Spacing.half,
  },
  wordmark: {
    letterSpacing: -0.5,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroIcon: {
    width: 72,
    height: 72,
    borderRadius: Spacing.four,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    gap: Spacing.three,
  },
  disclaimer: {
    textAlign: 'center',
  },
});
