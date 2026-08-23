import { createContext, useCallback, useContext, useEffect, useState, type PropsWithChildren } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { supabase } from '@/lib/supabase';

type HouseholdContextValue = {
  householdId: string | null;
  isLoading: boolean;
  refresh: () => void;
};

const HouseholdContext = createContext<HouseholdContextValue>({
  householdId: null,
  isLoading: true,
  refresh: () => {},
});

export function HouseholdProvider({ children }: PropsWithChildren) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!userId) {
      setHouseholdId(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    async function bootstrap() {
      const metadata = session?.user.user_metadata as Record<string, unknown> | undefined;
      const displayName =
        (metadata?.full_name as string | undefined) ?? (metadata?.name as string | undefined) ?? null;

      const { error: upsertError } = await supabase
        .from('user_account')
        .upsert({ id: userId, display_name: displayName }, { onConflict: 'id', ignoreDuplicates: true });
      if (upsertError) console.error('Failed to bootstrap user_account', upsertError);

      const { data, error } = await supabase
        .from('household_member')
        .select('household_id')
        .eq('user_account_id', userId as string)
        .eq('invitation_state', 'accepted')
        .is('deleted_at', null)
        .order('joined_at', { ascending: true })
        .limit(1);

      if (cancelled) return;
      if (error) console.error('Failed to load household membership', error);
      setHouseholdId(data?.[0]?.household_id ?? null);
      setIsLoading(false);
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [userId, refreshToken]);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  return (
    <HouseholdContext.Provider value={{ householdId, isLoading, refresh }}>
      {children}
    </HouseholdContext.Provider>
  );
}

export const useHousehold = () => useContext(HouseholdContext);
