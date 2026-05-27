<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# AGENTS.md
Guidance for agentic coding assistants working in this repository.

## Project Snapshot
- Name: `homebridge-roborock-vacuum`
- Stack: TypeScript (plugin), JavaScript (legacy Roborock library), Node.js
- Runtime target: Homebridge plugin
- Build output: `dist/`
- Entry point: `dist/index.js`
- Source roots:
  - `src/` (TypeScript platform/accessories)
  - `roborockLib/` (legacy Roborock communication and parsing)
  - `homebridge-ui/` (UI/server assets)

## Environment and Package Manager
- Use `npm` (repo includes `package-lock.json`)
- Supported Node versions: `^18.20.4 || ^20.15.1 || ^22 || ^24`
- Development and deployment happen on different machines. Do not run build commands on the development machine unless the user explicitly asks for it.
- If dependencies look broken, reset and reinstall:
  1. `rm -rf node_modules`
  2. `npm ci`

## Build, Lint, and Test Commands

### Install
- `npm ci`

### Build
- `npm run build`
- Command details: `rimraf ./dist && tsc`
- Compiles only `src/` to `dist/` with source maps
- Do not run this on the development machine unless explicitly requested by the user.

### Lint / Formatting
- `npm run lint` -> `prettier --check .`
- `npm run lint:fix` -> `prettier --write .`

### Tests
- `npm test` -> `jest`
- Coverage run: `npm test -- --coverage`

### Single-Test Commands (important)
- Run one file:
  - `npm test -- path/to/file.test.ts`
  - `npm test -- path/to/file.test.js`
- Run by test name:
  - `npm test -- -t "should do something"`
- Run one file + one test name:
  - `npm test -- path/to/file.test.ts -t "should do something"`
- Debug async or flaky tests:
  - `npm test -- path/to/file.test.ts --runInBand`

### Current Test State
- No committed Jest suites currently exist under `src/`
- `roborockLib/test.js` is integration-style and not a Jest spec
- Prefer new tests as `*.test.ts` colocated in `src/`

## CI Parity (local)
Do not run the full CI parity sequence on the development machine unless the user explicitly requests it.

Run this sequence to match GitHub Actions:
1. `npm ci`
2. `npm run lint`
3. `npm run build`
4. `npm test -- --coverage`

## Code Style and Conventions

### Formatting (Prettier)
- Source of truth: `.prettierrc`
- Rules:
  - `tabWidth: 2`
  - `semi: true`
  - `trailingComma: "es5"`
- Ignore list in `.prettierignore`: `coverage`, `dist`, `node_modules`, `__snapshots__`

### TypeScript Compiler Expectations
- Source of truth: `tsconfig.json`
- Key options:
  - `strict: true`
  - `module: commonjs`
  - `target: ES2018`
  - `esModuleInterop: true`
  - `skipLibCheck: true`
  - `noImplicitAny: false` (legacy compatibility)
- Compilation input is `src/` only

### Imports and Module Style
- Prefer ES imports in TypeScript
- Keep imports at file top
- Group imports by origin:
  1. External packages (`homebridge`, `rxjs`, etc.)
  2. Internal relative modules (`./platform`, `./types`, etc.)
- `require(...)` is acceptable at JS/TS interop boundaries
- Do not introduce a new module system unless required for compatibility

### Naming Conventions
- Classes/interfaces/types: `PascalCase`
- Functions/variables/properties: `camelCase`
- Shared constants: `UPPER_SNAKE_CASE` (e.g. `PLUGIN_NAME`, `PLATFORM_NAME`)
- Preserve existing file naming conventions (including snake_case files like `vacuum_accessory.ts`)

### Type Usage
- Add explicit types to exported/public APIs
- Avoid new broad `any` usage
- If `any` is unavoidable, keep scope narrow and document intent briefly
- Prefer `unknown` + narrowing for untrusted data

### Error Handling and Logging
- Wrap external I/O and API calls in `try/catch`
- Log actionable failures via platform logger (`this.log.error(...)` / `platform.log.error(...)`)
- Include context in error messages (device id, operation, state)
- Avoid silent failures unless intentionally non-fatal
- Return safe defaults for recoverable paths (see `src/crypto.ts` decryption behavior)

### Async, Callbacks, and State Updates
- Prefer `async/await` for new async flows
- Keep Homebridge characteristic handlers lightweight and resilient
- Ensure service/characteristic updates are idempotent when possible
- Guard callback paths against null/undefined runtime state

### Homebridge Platform Patterns
- Preserve dynamic platform lifecycle:
  - restore cached accessories
  - discover devices after `APIEvent.DID_FINISH_LAUNCHING`
  - register/unregister platform accessories carefully
- Keep UUID generation stable and deterministic
- Maintain backward-compatible config handling

## Files to Treat Carefully
- `src/platform.ts`: lifecycle, discovery, cache orchestration
- `src/vacuum_accessory.ts`: characteristic wiring, scene switch behavior
- `src/crypto.ts`: token encryption/decryption, key file handling
- `roborockLib/`: legacy protocol/runtime code with cloud/local impact

## Verification Checklist for Code Changes
After edits, run:
1. `npm run lint` (or `npm run lint:fix` and then re-check)
2. `npm run build`
3. `npm test` (or a targeted single-test command)
If tests were added/updated, also run:
4. `npm test -- --coverage`

## Documentation Expectations
- Keep technical docs in English
- Update `README.md` for user-visible behavior or config changes
- Keep schema/docs aligned when adding or changing config options

## Cursor / Copilot Rule Integration
- `.cursorrules`: not found
- `.cursor/rules/`: not found
- `.github/copilot-instructions.md`: not found

No repository-local Cursor/Copilot rule files are currently present.
If these files are added later, treat them as higher-priority repository guidance.
