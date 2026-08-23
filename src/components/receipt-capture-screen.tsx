import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { pickFromGallery, takePhoto, type PickedImage } from '@/capture/pick';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useHousehold } from '@/hooks/use-household';
import { useTheme } from '@/hooks/use-theme';
import { isOcrSupported, runOcr } from '@/ocr/recognize';
import { parseReceipt } from '@/parse';
import type { LineItem, ParsedReceipt, ReconciliationResult } from '@/parse';
import { lineItemExtendedPriceCent, listStores, saveReceiptTrip, type StoreOption } from '@/lib/receipts';
import type { OcrResult } from '@/parse/types';

type Step = 'capture' | 'processing' | 'review' | 'saving' | 'done';

function formatCurrency(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function statusLabel(status: ReconciliationResult['status']): string {
  if (status === 'match') return 'Totals match';
  if (status === 'mismatch') return 'Totals don’t match';
  return 'No subtotal found';
}

export function ReceiptCaptureScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { session } = useAuth();
  const { householdId } = useHousehold();

  const [step, setStep] = useState<Step>('capture');
  const [error, setError] = useState<string | null>(null);

  const [image, setImage] = useState<PickedImage | null>(null);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  const [parsed, setParsed] = useState<ParsedReceipt | null>(null);

  const [stores, setStores] = useState<StoreOption[]>([]);
  const [storesLoading, setStoresLoading] = useState(false);
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);

  const [result, setResult] = useState<{ tripId: string; itemCount: number } | null>(null);

  useEffect(() => {
    if (step !== 'review' || stores.length > 0) return;
    let cancelled = false;
    setStoresLoading(true);
    listStores()
      .then((rows) => {
        if (cancelled) return;
        setStores(rows);
        if (rows.length === 1) setSelectedStoreId(rows[0].id);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setStoresLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, stores.length]);

  const handlePick = useCallback(async (source: 'camera' | 'gallery') => {
    setError(null);
    try {
      const picked = source === 'camera' ? await takePhoto() : await pickFromGallery();
      if (!picked) return;

      if (!isOcrSupported()) {
        setError('On-device text recognition is not supported on this device.');
        return;
      }

      setImage(picked);
      setStep('processing');

      const recognized = await runOcr(picked.uri);
      const receipt = parseReceipt(recognized);

      setOcrResult(recognized);
      setParsed(receipt);
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('capture');
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!image || !ocrResult || !parsed || !selectedStoreId || !householdId || !session?.user.id) return;

    setError(null);
    setStep('saving');
    try {
      const saved = await saveReceiptTrip({
        householdId,
        userId: session.user.id,
        storeId: selectedStoreId,
        imageUri: image.uri,
        ocrResult,
        parsed,
      });
      setResult(saved);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('review');
    }
  }, [image, ocrResult, parsed, selectedStoreId, householdId, session?.user.id]);

  function handleScanAnother() {
    setStep('capture');
    setError(null);
    setImage(null);
    setOcrResult(null);
    setParsed(null);
    setSelectedStoreId(stores.length === 1 ? stores[0].id : null);
    setResult(null);
  }

  return (
    <ThemedView style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <ThemedText type="link" themeColor="tint">
            Close
          </ThemedText>
        </Pressable>
        <ThemedText type="smallBold">Scan a receipt</ThemedText>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.five }]}>
        {error && (
          <ThemedView type="backgroundElement" style={styles.errorBanner}>
            <ThemedText type="small" themeColor="text">
              {error}
            </ThemedText>
          </ThemedView>
        )}

        {step === 'capture' && <CaptureStep onPick={handlePick} theme={theme} />}

        {(step === 'processing' || step === 'saving') && (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={theme.tint} />
            <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
              {step === 'processing' ? 'Reading receipt…' : 'Saving trip…'}
            </ThemedText>
          </View>
        )}

        {step === 'review' && parsed && (
          <ReviewStep
            parsed={parsed}
            stores={stores}
            storesLoading={storesLoading}
            selectedStoreId={selectedStoreId}
            onSelectStore={setSelectedStoreId}
            onSave={handleSave}
            theme={theme}
          />
        )}

        {step === 'done' && result && (
          <View style={styles.centered}>
            <ThemedView type="backgroundSelected" style={styles.doneIcon}>
              <SymbolView
                name={{ ios: 'checkmark', android: 'check', web: 'check' }}
                tintColor={theme.tint}
                size={26}
              />
            </ThemedView>
            <ThemedText type="smallBold">Trip saved</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
              {result.itemCount} line item{result.itemCount === 1 ? '' : 's'} recorded. Unmatched items
              haven’t joined the price book yet — that happens once they’re resolved to a product.
            </ThemedText>
            <View style={styles.doneActions}>
              <Pressable onPress={handleScanAnother} style={({ pressed }) => pressed && styles.pressed}>
                <ThemedView type="backgroundElement" style={styles.secondaryButton}>
                  <ThemedText type="smallBold">Scan another</ThemedText>
                </ThemedView>
              </Pressable>
              <Pressable onPress={() => router.back()} style={({ pressed }) => pressed && styles.pressed}>
                <ThemedView type="backgroundSelected" style={[styles.secondaryButton, { backgroundColor: theme.tint }]}>
                  <ThemedText type="smallBold" themeColor="background">
                    Done
                  </ThemedText>
                </ThemedView>
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>
    </ThemedView>
  );
}

function CaptureStep({
  onPick,
  theme,
}: {
  onPick: (source: 'camera' | 'gallery') => void;
  theme: ReturnType<typeof useTheme>;
}) {
  return (
    <View style={styles.captureCentered}>
      <ThemedView type="backgroundSelected" style={styles.captureIcon}>
        <SymbolView
          name={{ ios: 'receipt', android: 'receipt_long', web: 'receipt_long' }}
          tintColor={theme.tint}
          size={30}
        />
      </ThemedView>
      <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
        Take a photo of a full receipt, or pick one you already have.
      </ThemedText>
      <View style={styles.captureButtons}>
        <Pressable onPress={() => onPick('camera')} style={({ pressed }) => pressed && styles.pressed}>
          <ThemedView type="backgroundSelected" style={[styles.primaryButton, { backgroundColor: theme.tint }]}>
            <SymbolView
              name={{ ios: 'camera', android: 'photo_camera', web: 'photo_camera' }}
              tintColor={theme.background}
              size={16}
            />
            <ThemedText type="smallBold" themeColor="background">
              Take photo
            </ThemedText>
          </ThemedView>
        </Pressable>
        <Pressable onPress={() => onPick('gallery')} style={({ pressed }) => pressed && styles.pressed}>
          <ThemedView type="backgroundElement" style={styles.primaryButton}>
            <ThemedText type="smallBold">Choose from gallery</ThemedText>
          </ThemedView>
        </Pressable>
      </View>
    </View>
  );
}

function ReviewStep({
  parsed,
  stores,
  storesLoading,
  selectedStoreId,
  onSelectStore,
  onSave,
  theme,
}: {
  parsed: ParsedReceipt;
  stores: StoreOption[];
  storesLoading: boolean;
  selectedStoreId: string | null;
  onSelectStore: (id: string) => void;
  onSave: () => void;
  theme: ReturnType<typeof useTheme>;
}) {
  const { reconciliation } = parsed;
  const badgeColor =
    reconciliation.status === 'match' ? theme.tint : reconciliation.status === 'mismatch' ? theme.text : theme.textSecondary;

  return (
    <View style={styles.reviewContainer}>
      <ThemedView type="backgroundElement" style={styles.section}>
        <View style={styles.reconciliationHeader}>
          <ThemedText type="smallBold">{statusLabel(reconciliation.status)}</ThemedText>
          <View style={[styles.statusDot, { backgroundColor: badgeColor }]} />
        </View>
        <SummaryRow
          label="Parsed sum"
          value={formatCurrency(reconciliation.parsedSum)}
        />
        <SummaryRow
          label="Printed subtotal"
          value={reconciliation.printedSubtotal !== null ? formatCurrency(reconciliation.printedSubtotal) : '—'}
        />
        {reconciliation.status !== 'match' && (
          <ThemedText type="small" themeColor="textSecondary">
            This trip will be flagged for review, but every item below still gets saved.
          </ThemedText>
        )}
      </ThemedView>

      <ThemedView type="backgroundElement" style={styles.section}>
        <ThemedText type="smallBold">
          Line items ({parsed.items.length})
        </ThemedText>
        {parsed.items.length === 0 && (
          <ThemedText type="small" themeColor="textSecondary">
            No line items detected. You can still save the trip and image, or try a clearer photo.
          </ThemedText>
        )}
        {parsed.items.map((item, index) => (
          <LineItemRow key={index} item={item} />
        ))}
      </ThemedView>

      <ThemedView type="backgroundElement" style={styles.section}>
        <ThemedText type="smallBold">Store</ThemedText>
        {storesLoading ? (
          <ThemedText type="small" themeColor="textSecondary">
            Loading stores…
          </ThemedText>
        ) : stores.length === 0 ? (
          <ThemedText type="small" themeColor="textSecondary">
            No stores set up yet — ask whoever manages the catalog to add one before you can save
            a trip.
          </ThemedText>
        ) : (
          stores.map((store) => {
            const selected = store.id === selectedStoreId;
            return (
              <Pressable key={store.id} onPress={() => onSelectStore(store.id)}>
                <ThemedView
                  type={selected ? 'backgroundSelected' : 'background'}
                  style={styles.storeRow}>
                  <View>
                    <ThemedText type="default">{store.name}</ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {store.retailerName}
                    </ThemedText>
                  </View>
                  {selected && (
                    <SymbolView
                      name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
                      tintColor={theme.tint}
                      size={20}
                    />
                  )}
                </ThemedView>
              </Pressable>
            );
          })
        )}
      </ThemedView>

      <Pressable onPress={onSave} disabled={!selectedStoreId}>
        <ThemedView
          type="backgroundSelected"
          style={[styles.primaryButton, { backgroundColor: theme.tint }, !selectedStoreId && styles.disabled]}>
          <ThemedText type="smallBold" themeColor="background">
            Save trip
          </ThemedText>
        </ThemedView>
      </Pressable>
    </View>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="default">{value}</ThemedText>
    </View>
  );
}

function LineItemRow({ item }: { item: LineItem }) {
  return (
    <View style={styles.lineItemRow}>
      <View style={styles.lineItemDescription}>
        <ThemedText type="default">{item.description || '(no description)'}</ThemedText>
        {item.quantity !== undefined && (
          <ThemedText type="small" themeColor="textSecondary">
            {item.quantity}
            {item.unit ? ` ${item.unit}` : ''}
            {item.unitPrice !== undefined ? ` @ ${formatCurrency(item.unitPrice)}` : ''}
          </ThemedText>
        )}
      </View>
      <ThemedText type="default">{formatCurrency(lineItemExtendedPriceCent(item))}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
  },
  headerSpacer: {
    width: 40,
  },
  content: {
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
  },
  errorBanner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    marginBottom: Spacing.three,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.six,
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  centerText: {
    textAlign: 'center',
  },
  captureCentered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.four,
    paddingVertical: Spacing.six,
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  captureIcon: {
    width: 64,
    height: 64,
    borderRadius: Spacing.four,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureButtons: {
    gap: Spacing.three,
    width: '100%',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
    borderRadius: Spacing.five,
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderRadius: Spacing.five,
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.7,
  },
  doneIcon: {
    width: 56,
    height: 56,
    borderRadius: Spacing.four,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneActions: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  reviewContainer: {
    width: '100%',
    maxWidth: MaxContentWidth,
    gap: Spacing.three,
  },
  section: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  reconciliationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  lineItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: Spacing.two,
    paddingVertical: Spacing.one,
  },
  lineItemDescription: {
    flex: 1,
  },
  storeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
});
