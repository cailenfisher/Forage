import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { pickFromGallery, takePhoto, type PickedImage } from '@/capture/pick';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useHousehold } from '@/hooks/use-household';
import { useTheme } from '@/hooks/use-theme';
import { centsToDollarsInput } from '@/lib/currency';
import { isOcrSupported, runOcr } from '@/ocr/recognize';
import { qrPathSegment, scanBarcodes, type BarcodeScanGuess } from '@/ocr/scanBarcode';
import { parsePrice } from '@/parse';
import { extractShelfTagFields, type ShelfTagExtraction } from '@/parse/shelfTag';
import {
  findRetailerProductByStoreItemCode,
  listUnitsOfMeasure,
  saveShelfTagObservation,
  type SaveShelfTagObservationResult,
  type UnitOfMeasureOption,
} from '@/lib/shelfTags';
import { listStores, type StoreOption } from '@/lib/stores';
import type { OcrResult } from '@/parse/types';

type Step = 'capture' | 'processing' | 'review' | 'saving' | 'done';
type PriceKind = 'regular' | 'sale' | 'clearance';

const PRICE_KINDS: { key: PriceKind; label: string }[] = [
  { key: 'regular', label: 'Regular' },
  { key: 'sale', label: 'Sale' },
  { key: 'clearance', label: 'Clearance' },
];

export function ShelfTagCaptureScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { session } = useAuth();
  const { householdId } = useHousehold();

  const [step, setStep] = useState<Step>('capture');
  const [error, setError] = useState<string | null>(null);

  const [image, setImage] = useState<PickedImage | null>(null);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  const [extraction, setExtraction] = useState<ShelfTagExtraction | null>(null);
  const [barcodeResults, setBarcodeResults] = useState<BarcodeScanGuess[]>([]);

  const [stores, setStores] = useState<StoreOption[]>([]);
  const [storesLoading, setStoresLoading] = useState(false);
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);

  const [units, setUnits] = useState<UnitOfMeasureOption[]>([]);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);

  const [description, setDescription] = useState('');
  const [storeItemCode, setStoreItemCode] = useState('');
  const [priceText, setPriceText] = useState('');
  const [priceKind, setPriceKind] = useState<PriceKind>('regular');
  const [sizeText, setSizeText] = useState('');

  const [matchPreview, setMatchPreview] = useState<{ receiptDescription: string | null } | null>(null);

  const [result, setResult] = useState<SaveShelfTagObservationResult | null>(null);

  const selectedStore = stores.find((store) => store.id === selectedStoreId) ?? null;

  // Stores and units are both small, static-ish reference lists — loaded
  // once on entering review, same pattern the receipt screen uses for stores.
  useEffect(() => {
    if (step !== 'review') return;
    let cancelled = false;

    if (stores.length === 0) {
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
    }

    if (units.length === 0) {
      listUnitsOfMeasure()
        .then((rows) => {
          if (!cancelled) setUnits(rows);
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    }

    return () => {
      cancelled = true;
    };
  }, [step, stores.length, units.length]);

  // Pre-select a unit chip from the extraction's best guess. Kept separate
  // from the load effect above so it re-runs on every new capture (scout
  // mode scans several tags per session) rather than only firing the first
  // time units happen to still be empty.
  useEffect(() => {
    if (!extraction || units.length === 0) return;
    const preferredCode = extraction.size?.unitCode ?? extraction.unitPrice?.unitCode ?? null;
    if (!preferredCode) return;
    const match = units.find((unit) => unit.code === preferredCode);
    if (match) setSelectedUnitId(match.id);
  }, [extraction, units]);

  // Best-effort duplicate-avoidance preview: once a store and a store item
  // code are both known, check whether this retailer already has a catalog
  // entry for that code so the user isn't surprised by "matched" vs
  // "created new" after saving. Never blocks Save either way.
  useEffect(() => {
    const trimmedCode = storeItemCode.trim();
    if (!selectedStore || !trimmedCode) {
      setMatchPreview(null);
      return;
    }
    let cancelled = false;
    findRetailerProductByStoreItemCode(selectedStore.retailerId, trimmedCode)
      .then((match) => {
        if (!cancelled) setMatchPreview(match);
      })
      .catch(() => {
        if (!cancelled) setMatchPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedStore, storeItemCode]);

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

      // Run alongside OCR, not after: both read the same static image file
      // and are independent of each other. Restricted to 'qr' — the only
      // symbology the shelf-tag evidence in deferred.md has shown, and
      // narrower than the platform default avoids treating an unrelated
      // barcode elsewhere in frame as this tag's own code. Best-effort: an
      // unreadable or absent QR resolves to an empty array, never an error.
      const [recognized, barcodes] = await Promise.all([runOcr(picked.uri), scanBarcodes(picked.uri, ['qr'])]);
      const fields = extractShelfTagFields(recognized);

      setOcrResult(recognized);
      setExtraction(fields);
      setBarcodeResults(barcodes);
      setDescription(fields.descriptionGuess ?? '');
      // storeItemCode is deliberately never prefilled from extraction: there
      // is no known way to read a real store item code off a Walmart shelf
      // tag (see docs/decisions/deferred.md), and a plausible-looking wrong
      // value here silently mismatches this observation to another
      // product's price_observation history, which can't be undone
      // (price_observation is append-only). Left for the user to fill in.
      setPriceText(fields.priceCent !== null ? centsToDollarsInput(fields.priceCent) : '');
      setSizeText(fields.size ? String(fields.size.quantity) : '');
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('capture');
    }
  }, []);

  const priceCent = parsePrice(priceText.trim());
  const sizeQuantity = sizeText.trim() ? parseFloat(sizeText.trim()) : null;
  // A quantity with no unit isn't a size — it's just a number. Require both
  // together or neither, so normalized_unit_price is either computed for
  // real or left null, never silently stored against a meaningless bare
  // count.
  const sizeValid =
    sizeText.trim() === '' || (sizeQuantity !== null && !Number.isNaN(sizeQuantity) && sizeQuantity > 0 && selectedUnitId !== null);
  const canSave = Boolean(image && ocrResult && selectedStore && priceCent !== null && priceCent > 0 && sizeValid);

  const handleSave = useCallback(async () => {
    if (!image || !ocrResult || !selectedStore || !householdId || !session?.user.id || priceCent === null) return;

    setError(null);
    setStep('saving');
    try {
      const qrResult = barcodeResults.find((barcode) => barcode.type === 'qr') ?? null;
      const saved = await saveShelfTagObservation({
        householdId,
        userId: session.user.id,
        storeId: selectedStore.id,
        retailerId: selectedStore.retailerId,
        imageUri: image.uri,
        ocrResult,
        description: description.trim() || null,
        storeItemCode: storeItemCode.trim() || null,
        priceCent,
        priceKind,
        sizeQuantity: sizeText.trim() ? sizeQuantity : null,
        unitOfMeasureId: sizeText.trim() ? selectedUnitId : null,
        tagFooter: extraction?.tagFooter ?? null,
        barcodeResults,
        qrToken: qrResult ? qrPathSegment(qrResult.data) : null,
      });
      setResult(saved);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('review');
    }
  }, [
    image,
    ocrResult,
    extraction,
    barcodeResults,
    selectedStore,
    householdId,
    session?.user.id,
    priceCent,
    description,
    storeItemCode,
    priceKind,
    sizeText,
    sizeQuantity,
    selectedUnitId,
  ]);

  function handleScanAnother() {
    setStep('capture');
    setError(null);
    setImage(null);
    setOcrResult(null);
    setExtraction(null);
    setBarcodeResults([]);
    setDescription('');
    setStoreItemCode('');
    setPriceText('');
    setPriceKind('regular');
    setSizeText('');
    setSelectedUnitId(null);
    setMatchPreview(null);
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
        <ThemedText type="smallBold">Scan a shelf tag</ThemedText>
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
              {step === 'processing' ? 'Reading tag…' : 'Saving price…'}
            </ThemedText>
          </View>
        )}

        {step === 'review' && extraction && (
          <ReviewStep
            extraction={extraction}
            description={description}
            onChangeDescription={setDescription}
            storeItemCode={storeItemCode}
            onChangeStoreItemCode={setStoreItemCode}
            priceText={priceText}
            onChangePriceText={setPriceText}
            priceCent={priceCent}
            priceKind={priceKind}
            onChangePriceKind={setPriceKind}
            sizeText={sizeText}
            onChangeSizeText={setSizeText}
            sizeValid={sizeValid}
            units={units}
            selectedUnitId={selectedUnitId}
            onSelectUnit={setSelectedUnitId}
            stores={stores}
            storesLoading={storesLoading}
            selectedStoreId={selectedStoreId}
            onSelectStore={setSelectedStoreId}
            matchPreview={matchPreview}
            canSave={canSave}
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
            <ThemedText type="smallBold">Price recorded</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
              {result.matchedExistingRetailerProduct
                ? 'Matched to an existing catalog item.'
                : 'Added as a new provisional catalog item — it becomes fully trusted once a second capture corroborates it.'}
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
        <SymbolView name={{ ios: 'tag', android: 'sell', web: 'sell' }} tintColor={theme.tint} size={30} />
      </ThemedView>
      <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
        Take a photo of a shelf tag, or pick one you already have. You don&apos;t need to buy
        anything — this just logs the price.
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
  extraction,
  description,
  onChangeDescription,
  storeItemCode,
  onChangeStoreItemCode,
  priceText,
  onChangePriceText,
  priceCent,
  priceKind,
  onChangePriceKind,
  sizeText,
  onChangeSizeText,
  sizeValid,
  units,
  selectedUnitId,
  onSelectUnit,
  stores,
  storesLoading,
  selectedStoreId,
  onSelectStore,
  matchPreview,
  canSave,
  onSave,
  theme,
}: {
  extraction: ShelfTagExtraction;
  description: string;
  onChangeDescription: (value: string) => void;
  storeItemCode: string;
  onChangeStoreItemCode: (value: string) => void;
  priceText: string;
  onChangePriceText: (value: string) => void;
  priceCent: number | null;
  priceKind: PriceKind;
  onChangePriceKind: (value: PriceKind) => void;
  sizeText: string;
  onChangeSizeText: (value: string) => void;
  sizeValid: boolean;
  units: UnitOfMeasureOption[];
  selectedUnitId: string | null;
  onSelectUnit: (id: string) => void;
  stores: StoreOption[];
  storesLoading: boolean;
  selectedStoreId: string | null;
  onSelectStore: (id: string) => void;
  matchPreview: { receiptDescription: string | null } | null;
  canSave: boolean;
  onSave: () => void;
  theme: ReturnType<typeof useTheme>;
}) {
  const priceTextInvalid = priceText.trim() !== '' && priceCent === null;

  return (
    <View style={styles.reviewContainer}>
      <ThemedView type="backgroundElement" style={styles.section}>
        <ThemedText type="smallBold">Item</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Pulled from the photo where possible — check it against the tag and fix anything that's
          wrong.
        </ThemedText>
        <TextInput
          value={description}
          onChangeText={onChangeDescription}
          placeholder="Product description"
          placeholderTextColor={theme.textSecondary}
          style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
        />
        <TextInput
          value={storeItemCode}
          onChangeText={onChangeStoreItemCode}
          placeholder="Store item code / UPC (optional)"
          placeholderTextColor={theme.textSecondary}
          keyboardType="number-pad"
          style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
        />
        {matchPreview && (
          <ThemedText type="small" themeColor="tint">
            {matchPreview.receiptDescription
              ? `Matches an existing catalog item: "${matchPreview.receiptDescription}"`
              : 'Matches an existing catalog item.'}
          </ThemedText>
        )}
      </ThemedView>

      <ThemedView type="backgroundElement" style={styles.section}>
        <ThemedText type="smallBold">Price</ThemedText>
        <View style={styles.priceRow}>
          <ThemedText type="default">$</ThemedText>
          <TextInput
            value={priceText}
            onChangeText={onChangePriceText}
            placeholder="0.00"
            placeholderTextColor={theme.textSecondary}
            keyboardType="decimal-pad"
            style={[styles.input, styles.priceInput, { color: theme.text, borderColor: theme.backgroundSelected }]}
          />
        </View>
        {priceTextInvalid && (
          <ThemedText type="small" themeColor="text">
            Enter a price like 3.99.
          </ThemedText>
        )}
        {extraction.unitPrice && !extraction.unitPrice.isDegenerate && (
          <ThemedText type="small" themeColor="textSecondary">
            Tag also shows {extraction.unitPrice.displayAmount}/{extraction.unitPrice.unitToken}
          </ThemedText>
        )}
        <View style={styles.priceKindRow}>
          {PRICE_KINDS.map((kind) => {
            const selected = kind.key === priceKind;
            return (
              <Pressable key={kind.key} onPress={() => onChangePriceKind(kind.key)}>
                <ThemedView
                  type={selected ? 'backgroundSelected' : 'background'}
                  style={[styles.chip, selected && { borderColor: theme.tint, borderWidth: 1 }]}>
                  <ThemedText type="small">{kind.label}</ThemedText>
                </ThemedView>
              </Pressable>
            );
          })}
        </View>
      </ThemedView>

      <ThemedView type="backgroundElement" style={styles.section}>
        <ThemedText type="smallBold">Size (optional)</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          The package size the price above is for — leave blank if the tag doesn't show one (e.g.
          items priced per pound).
        </ThemedText>
        <View style={styles.sizeRow}>
          <TextInput
            value={sizeText}
            onChangeText={onChangeSizeText}
            placeholder="Qty"
            placeholderTextColor={theme.textSecondary}
            keyboardType="decimal-pad"
            style={[styles.input, styles.sizeInput, { color: theme.text, borderColor: theme.backgroundSelected }]}
          />
          <View style={styles.unitChips}>
            {units.map((unit) => {
              const selected = unit.id === selectedUnitId;
              return (
                <Pressable key={unit.id} onPress={() => onSelectUnit(unit.id)}>
                  <ThemedView
                    type={selected ? 'backgroundSelected' : 'background'}
                    style={[styles.chip, selected && { borderColor: theme.tint, borderWidth: 1 }]}>
                    <ThemedText type="small">{unit.code}</ThemedText>
                  </ThemedView>
                </Pressable>
              );
            })}
          </View>
        </View>
        {!sizeValid && (
          <ThemedText type="small" themeColor="text">
            Enter a positive number and pick a unit, or leave both blank.
          </ThemedText>
        )}
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
            a price.
          </ThemedText>
        ) : (
          stores.map((store) => {
            const selected = store.id === selectedStoreId;
            return (
              <Pressable key={store.id} onPress={() => onSelectStore(store.id)}>
                <ThemedView type={selected ? 'backgroundSelected' : 'background'} style={styles.storeRow}>
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

      <Pressable onPress={onSave} disabled={!canSave}>
        <ThemedView
          type="backgroundSelected"
          style={[styles.primaryButton, { backgroundColor: theme.tint }, !canSave && styles.disabled]}>
          <ThemedText type="smallBold" themeColor="background">
            Save price
          </ThemedText>
        </ThemedView>
      </Pressable>
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
  input: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  priceInput: {
    flex: 1,
  },
  priceKindRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  sizeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  sizeInput: {
    width: 80,
  },
  unitChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
    flexShrink: 1,
  },
  chip: {
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.five,
  },
  storeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
});
