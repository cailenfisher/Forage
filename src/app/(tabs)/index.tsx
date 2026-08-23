import { useRouter } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SignOutButton } from '@/components/sign-out-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const QUICK_ACTIONS = [
  {
    key: 'receipt',
    label: 'Receipt',
    caption: 'Scan a full receipt',
    icon: { ios: 'receipt', android: 'receipt_long', web: 'receipt_long' },
  },
  {
    key: 'shelf-tag',
    label: 'Shelf tag',
    caption: 'Price without buying',
    icon: { ios: 'tag', android: 'sell', web: 'sell' },
  },
  {
    key: 'barcode',
    label: 'Barcode',
    caption: 'Identify an item',
    icon: { ios: 'barcode.viewfinder', android: 'barcode_scanner', web: 'barcode_scanner' },
  },
  {
    key: 'manual',
    label: 'Manual',
    caption: 'Type in a price',
    icon: { ios: 'square.and.pencil', android: 'edit_square', web: 'edit_square' },
  },
] as const satisfies { key: string; label: string; caption: string; icon: SymbolViewProps['name'] }[];

function handleComingSoon(feature: string) {
  Alert.alert('Not built yet', `${feature} capture isn't wired up yet.`);
}

export default function HomeScreen() {
  const router = useRouter();
  const safeAreaInsets = useSafeAreaInsets();
  const insets = {
    ...safeAreaInsets,
    bottom: safeAreaInsets.bottom + BottomTabInset + Spacing.three,
  };
  const theme = useTheme();

  const contentPlatformStyle = Platform.select({
    android: {
      paddingTop: insets.top,
      paddingLeft: insets.left,
      paddingRight: insets.right,
      paddingBottom: insets.bottom,
    },
    web: {
      paddingTop: Spacing.six,
      paddingBottom: Spacing.four,
    },
  });

  return (
    <ScrollView
      style={[styles.scrollView, { backgroundColor: theme.background }]}
      contentInset={insets}
      contentContainerStyle={[styles.contentContainer, contentPlatformStyle]}>
      <ThemedView style={styles.container}>
        <View style={styles.headerRow}>
          <View style={styles.header}>
            <ThemedText type="subtitle" themeColor="tint" style={styles.wordmark}>
              Forage
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Price intelligence for everyday groceries.
            </ThemedText>
          </View>
          <SignOutButton />
        </View>

        <ThemedView type="backgroundElement" style={styles.heroCard}>
          <ThemedView type="backgroundSelected" style={styles.heroIcon}>
            <SymbolView
              name={{ ios: 'chart.line.uptrend.xyaxis', android: 'trending_up', web: 'trending_up' }}
              tintColor={theme.tint}
              size={26}
            />
          </ThemedView>
          <ThemedText style={styles.heroTitle}>Your price book is empty</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.heroBody}>
            Scan a receipt or shelf tag to log your first price observation and start tracking
            prices over time.
          </ThemedText>
          <Pressable
            onPress={() => router.push('/receipt-capture')}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: theme.tint },
              pressed && styles.pressed,
            ]}>
            <SymbolView
              name={{ ios: 'camera', android: 'photo_camera', web: 'photo_camera' }}
              tintColor={theme.background}
              size={16}
            />
            <ThemedText type="smallBold" themeColor="background">
              Scan a receipt
            </ThemedText>
          </Pressable>
        </ThemedView>

        <View style={styles.section}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
            Log a price
          </ThemedText>
          <View style={styles.actionsGrid}>
            {QUICK_ACTIONS.map((action) => (
              <Pressable
                key={action.key}
                onPress={() => {
                  if (action.key === 'receipt') router.push('/receipt-capture');
                  else if (action.key === 'shelf-tag') router.push('/shelf-tag-capture');
                  else handleComingSoon(action.label);
                }}
                style={({ pressed }) => [styles.actionCard, pressed && styles.pressed]}>
                <ThemedView type="backgroundElement" style={styles.actionCardInner}>
                  <ThemedView type="backgroundSelected" style={styles.actionIcon}>
                    <SymbolView name={action.icon} tintColor={theme.tint} size={18} />
                  </ThemedView>
                  <ThemedText type="smallBold">{action.label}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {action.caption}
                  </ThemedText>
                </ThemedView>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
            Recent activity
          </ThemedText>
          <ThemedView type="backgroundElement" style={styles.emptyState}>
            <SymbolView
              name={{ ios: 'clock.arrow.circlepath', android: 'history', web: 'history' }}
              tintColor={theme.textSecondary}
              size={20}
            />
            <ThemedText type="smallBold">No price observations yet</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
              They&apos;ll show up here as soon as you log your first price.
            </ThemedText>
          </ThemedView>
        </View>
      </ThemedView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  container: {
    maxWidth: MaxContentWidth,
    flexGrow: 1,
    width: '100%',
    paddingHorizontal: Spacing.four,
    gap: Spacing.five,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingTop: Spacing.three,
  },
  header: {
    gap: Spacing.half,
  },
  wordmark: {
    letterSpacing: -0.5,
  },
  heroCard: {
    borderRadius: Spacing.four,
    padding: Spacing.four,
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  heroIcon: {
    width: 48,
    height: 48,
    borderRadius: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.one,
  },
  heroTitle: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: 700,
  },
  heroBody: {
    marginBottom: Spacing.two,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderRadius: Spacing.five,
    alignSelf: 'stretch',
  },
  pressed: {
    opacity: 0.7,
  },
  section: {
    gap: Spacing.three,
  },
  sectionLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
  },
  actionCard: {
    flexBasis: '46%',
    flexGrow: 1,
  },
  actionCardInner: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.half,
  },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.one,
  },
  emptyState: {
    borderRadius: Spacing.four,
    paddingVertical: Spacing.five,
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
    gap: Spacing.two,
  },
  centerText: {
    textAlign: 'center',
  },
});
