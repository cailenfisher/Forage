// Integer cents in, formatted/editable dollar strings out — kept in one
// place so the receipt and shelf-tag review screens don't drift.
export function formatCurrency(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

// For prefilling an editable text field — no currency symbol, no sign
// handling (shelf tag prices are never negative).
export function centsToDollarsInput(cents: number): string {
  return (cents / 100).toFixed(2);
}
