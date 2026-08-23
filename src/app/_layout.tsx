import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { HouseholdOnboardingScreen } from '@/components/household-onboarding-screen';
import { SignInScreen } from '@/components/sign-in-screen';
import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { HouseholdProvider, useHousehold } from '@/hooks/use-household';

SplashScreen.preventAutoHideAsync();

function HouseholdGate() {
  const { householdId, isLoading } = useHousehold();

  if (isLoading) return null;
  return householdId ? <AppTabs /> : <HouseholdOnboardingScreen />;
}

function AuthGate() {
  const { session, isLoading } = useAuth();

  if (isLoading) return null;
  if (!session) return <SignInScreen />;

  return (
    <HouseholdProvider>
      <HouseholdGate />
    </HouseholdProvider>
  );
}

export default function TabLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </ThemeProvider>
  );
}
