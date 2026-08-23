/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 *
 * Brand color is Mulberry (#7A2D57), used sparingly as an accent — neutrals carry most of the
 * UI. The gray ramp is warm (hue ~32) rather than true neutral, so surfaces read like paper
 * instead of stark white/black. `tint` is the brand accent for text/icons on a themed
 * background; it's lightened in dark mode to hold WCAG AA contrast against the dark background.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#26211D',
    background: '#FBFAF9',
    backgroundElement: '#F2F0ED',
    backgroundSelected: '#E5E1DC',
    textSecondary: '#6C645A',
    tint: '#7A2D57',
  },
  dark: {
    text: '#F6F5F3',
    background: '#171512',
    backgroundElement: '#272420',
    backgroundSelected: '#38332E',
    textSecondary: '#AFA9A1',
    tint: '#C45F96',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
