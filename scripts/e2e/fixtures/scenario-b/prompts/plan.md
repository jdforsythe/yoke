Write the following JSON byte-for-byte to `docs/idea/feature-b.json`.

Use the Write tool. Create the `docs/idea/` directory first if it does not exist.
Do not add prose, comments, or any content beyond what is shown below.
Do not modify or reformat the JSON in any way.

The repo already contains a working app:
- `package.json` (module type)
- `index.js` exports `greet()` returning `'hello'`
- `test/smoke.test.js` asserts `greet() === 'hello'`

Both features below ADD to that existing app. They MUST NOT delete the seeded
files, MUST NOT remove the existing `greet returns hello` test, and MUST keep
that assertion passing.

```json
{
  "features": [
    {
      "id": "feat-b-001",
      "description": "Add a `farewell()` export to index.js that returns 'goodbye'. Add `test/farewell.test.js` asserting it. Do not modify package.json. Do not modify the existing greet() or its test.",
      "depends_on": [],
      "target_files": [
        { "path": "index.js", "contents": "export function greet() { return 'hello'; }\nexport function farewell() { return 'goodbye'; }\n" },
        { "path": "test/farewell.test.js", "contents": "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { farewell } from '../index.js';\ntest('farewell returns goodbye', () => { assert.equal(farewell(), 'goodbye'); });\n" }
      ]
    },
    {
      "id": "feat-b-002",
      "description": "Add a `shout(s)` export to index.js that returns the input uppercased. Add `test/shout.test.js`. Keep greet() and farewell() and their tests intact.",
      "depends_on": ["feat-b-001"],
      "target_files": [
        { "path": "index.js", "contents": "export function greet() { return 'hello'; }\nexport function farewell() { return 'goodbye'; }\nexport function shout(s) { return String(s).toUpperCase(); }\n" },
        { "path": "test/shout.test.js", "contents": "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { shout } from '../index.js';\ntest('shout uppercases its input', () => { assert.equal(shout('yoke'), 'YOKE'); });\n" }
      ]
    }
  ]
}
```

After writing the file, stop. Do not run any commands. Do not output anything else.
