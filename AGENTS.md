# Agent Directives & Operational Rules

## 🚫 STRICT DIRECTIVE: TESTING IS SUSPENDED UNTIL AFTER PHASE 4

All testing is suspended until after Phase 4 is complete.

1. **DO NOT** create any new test files.
2. **DO NOT** modify, update, or touch existing test files in `tests/`.
3. **DO NOT** run `npm test` or invoke `vitest`.
4. **DO NOT** discuss test coverage or propose test additions.

### Primary Focus:
Focus 100% of your effort on **functional implementation, runtime correctness, and browser CDP stability** to support OpenCode coding activities.

### Permitted Verification Method:
To verify changes for correctness, run **ONLY**:
```bash
npm run build
```
Ensure TypeScript compiles cleanly with zero errors.
