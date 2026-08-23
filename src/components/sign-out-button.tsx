import { SymbolView } from 'expo-symbols';
import { Pressable } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { supabase } from '@/lib/supabase';

function handleSignOut() {
  supabase.auth.signOut();
}

export function SignOutButton() {
  const theme = useTheme();

  return (
    <Pressable onPress={handleSignOut} hitSlop={Spacing.two}>
      <SymbolView
        name={{ ios: 'rectangle.portrait.and.arrow.right', android: 'logout', web: 'logout' }}
        tintColor={theme.textSecondary}
        size={20}
      />
    </Pressable>
  );
}
