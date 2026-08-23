import { supabase } from '@/lib/supabase';

export type StoreOption = {
  id: string;
  name: string;
  retailerId: string;
  retailerName: string;
};

// Every store in the shared catalog — there's no household scoping on retail
// location data, and (per docs/decisions/deferred.md) no in-app way to add a
// new one yet, so this list is whatever's been seeded directly in Postgres.
export async function listStores(): Promise<StoreOption[]> {
  const { data, error } = await supabase
    .from('store')
    .select('id, retailer_id, name, retailer:retailer(name)')
    .order('name', { ascending: true });
  if (error) throw error;

  // supabase-js infers embedded to-one relations as arrays without generated
  // DB types wired into the client (see src/lib/supabase.ts); the actual
  // response shape is a single object per the retailer_id foreign key.
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    retailer_id: string;
    name: string | null;
    retailer: { name: string } | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? '(unnamed store)',
    retailerId: row.retailer_id,
    retailerName: row.retailer?.name ?? 'Unknown retailer',
  }));
}
