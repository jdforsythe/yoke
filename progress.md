# Yoke — Build Progress

## feat-config-loader (2026-04-12)

Implemented the synchronous `.yoke.yml` config loader in full. The feature
comprises four new TypeScript modules: `src/shared/types/config.ts` (RawConfig
and ResolvedConfig type definitions, derived from the JSON schema), `src/server/
config/errors.ts` (ConfigLoadError with a discriminated `kind` field for
structured error handling), `src/server/config/resolve.ts` (pure, no-I/O path
resolver that deep-clones the raw config and converts all config-relative paths
to absolute using structuredClone + path.resolve), and `src/server/config/
loader.ts` (the synchronous entry point: readFileSync → yaml.parse → version
pin check → AJV compile/validate → resolveConfig). The project skeleton
(package.json, tsconfig.json, vitest.config.ts, updated .gitignore) was also
created from scratch as no Node project existed. All 31 tests pass; tsc
--noEmit clean.
