import { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useHousehold } from '@/hooks/use-household';
import { useTheme } from '@/hooks/use-theme';
import { supabase } from '@/lib/supabase';

type HouseholdRow = { id: string; name: string };

export function HouseholdOnboardingScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { session } = useAuth();
  const { refresh } = useHousehold();

  const [name, setName] = useState('');
  const [households, setHouseholds] = useState<HouseholdRow[]>([]);
  const [isListLoading, setIsListLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadHouseholds() {
      const { data, error } = await supabase
        .from('household')
        .select('id, name')
        .order('name', { ascending: true })
        .limit(200);

      if (cancelled) return;
      if (error) {
        console.error('Failed to load households', error);
      } else {
        setHouseholds(data ?? []);
      }
      setIsListLoading(false);
    }

    loadHouseholds();
    return () => {
      cancelled = true;
    };
  }, []);

  async function joinHousehold(householdId: string) {
    const userId = session?.user.id;
    if (!userId) return;

    setPendingId(householdId);
    const { error } = await supabase
      .from('household_member')
      .insert({ household_id: householdId, user_account_id: userId, joined_at: new Date().toISOString() });
    setPendingId(null);

    if (error) {
      Alert.alert('Could not join household', error.message);
      return;
    }
    refresh();
  }

  async function createHousehold() {
    const trimmedName = name.trim();
    const userId = session?.user.id;
    if (!trimmedName || !userId) return;

    setPendingId('__create__');
    const { data: household, error: createError } = await supabase
      .from('household')
      .insert({ name: trimmedName })
      .select('id')
      .single();

    if (createError || !household) {
      setPendingId(null);
      Alert.alert('Could not create household', createError?.message ?? 'Unknown error');
      return;
    }

    const { error: memberError } = await supabase.from('household_member').insert({
      household_id: household.id,
      user_account_id: userId,
      role: 'owner',
      joined_at: new Date().toISOString(),
    });
    setPendingId(null);

    if (memberError) {
      Alert.alert('Could not join the household you created', memberError.message);
      return;
    }
    refresh();
  }

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
            Create a household or join one to start tracking prices.
          </ThemedText>
        </View>

        <ThemedView type="backgroundElement" style={styles.createCard}>
          <ThemedText type="smallBold">Create a household</ThemedText>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. The Smiths"
            placeholderTextColor={theme.textSecondary}
            style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
            editable={pendingId === null}
          />
          <Pressable
            onPress={createHousehold}
            disabled={!name.trim() || pendingId !== null}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: theme.tint },
              (pressed || !name.trim() || pendingId !== null) && styles.pressed,
            ]}>
            <ThemedText type="smallBold" themeColor="background">
              {pendingId === '__create__' ? 'Creating…' : 'Create household'}
            </ThemedText>
          </Pressable>
        </ThemedView>

        <View style={styles.section}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
            Or join an existing household
          </ThemedText>

          {isListLoading ? (
            <ThemedText type="small" themeColor="textSecondary">
              Loading households…
            </ThemedText>
          ) : households.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              No households yet — be the first to create one.
            </ThemedText>
          ) : (
            <FlatList
              data={households}
              keyExtractor={(item) => item.id}
              style={styles.list}
              renderItem={({ item }) => (
                <ThemedView type="backgroundElement" style={styles.householdRow}>
                  <ThemedText style={styles.householdName}>{item.name}</ThemedText>
                  <Pressable
                    onPress={() => joinHousehold(item.id)}
                    disabled={pendingId !== null}
                    style={({ pressed }) => [
                      styles.joinButton,
                      { backgroundColor: theme.backgroundSelected },
                      (pressed || pendingId !== null) && styles.pressed,
                    ]}>
                    <ThemedText type="smallBold">{pendingId === item.id ? 'Joining…' : 'Join'}</ThemedText>
                  </Pressable>
                </ThemedView>
              )}
            />
          )}
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
    gap: Spacing.five,
  },
  header: {
    gap: Spacing.half,
  },
  wordmark: {
    letterSpacing: -0.5,
  },
  createCard: {
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
  },
  input: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  primaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderRadius: Spacing.five,
  },
  pressed: {
    opacity: 0.6,
  },
  section: {
    flex: 1,
    gap: Spacing.three,
  },
  sectionLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  list: {
    flexGrow: 0,
  },
  householdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: Spacing.three,
    padding: Spacing.three,
    marginBottom: Spacing.two,
  },
  householdName: {
    flexShrink: 1,
  },
  joinButton: {
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.five,
  },
});
