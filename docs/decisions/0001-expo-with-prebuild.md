# ADR 0001 — Expo with prebuild/CNG over bare React Native

- **Date:** 2026-08-22
- **Status:** Accepted

## Context

Forage is a React Native app built partly to develop mobile depth. The historical
argument against Expo was the "eject cliff": introducing native code meant abandoning
the managed toolchain permanently.

## Decision

Use **Expo** with prebuild / Continuous Native Generation. Introduce native modules via
the **Expo Modules API** rather than TurboModules + codegen.

Package manager is **pnpm**. `create-expo-app` sets `nodeLinker: hoisted` automatically
for standalone apps; no manual hoisted-linker step is required. (That workaround applies
to monorepos only.)

## Consequences

- The eject cliff no longer applies — native code is reachable without leaving the toolchain.
- The practical day-to-day benefit is dependency version coherence across the RN ecosystem.
- Expo Modules API is a gentler on-ramp to native authoring than codegen.
- Agents must **verify native dependency compatibility against current docs before
  installing** rather than inferring from training data.
