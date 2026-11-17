# 0003 — Validate level files with hand-written TypeScript, not a JSON Schema library

**Context.** Level files must be validated in tests and at build time.

**Options.** (a) A JSON Schema file plus a validator library such as Ajv. (b) A
hand-written validator next to the TypeScript types.

**Decision.** (b). `src/levels/schema.ts` holds the `Level` type and
`src/levels/validate.ts` checks an unknown value against it, field by field, and then
checks every cross-reference (ids that must exist, kites that must aim at something the
level can contain). Error messages name the JSON path and say what was expected.

**Consequences.** No dependency. The type and the validator are two things to keep in
step; `tests/levels/` exercises both. Cross-reference checks, which JSON Schema cannot
express, sit in the same place as shape checks.
