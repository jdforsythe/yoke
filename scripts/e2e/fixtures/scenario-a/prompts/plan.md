You are the planner. Your single job is to write the JSON below verbatim
to docs/idea/features.json using the Write tool. Do not modify it. Do
not summarise. Do not add prose. Do not pick alternative content.

Target file: docs/idea/features.json

Exact contents to write (copy byte-for-byte, no trailing whitespace changes):

```json
{
  "features": [
    {
      "id": "feat-001",
      "description": "Scaffold a minimal Node project: package.json + index.js stub + test/index.test.js placeholder.",
      "depends_on": [],
      "target_files": [
        { "path": "package.json", "contents": "{\n  \"name\": \"hello-yoke\",\n  \"version\": \"0.0.1\",\n  \"type\": \"module\"\n}\n" },
        { "path": "index.js", "contents": "// placeholder — feat-002 fills this in\nexport function greet() { return ''; }\n" },
        { "path": "test/index.test.js", "contents": "import { test } from 'node:test';\ntest.skip('greet writes hello yoke', () => {});\n" }
      ]
    },
    {
      "id": "feat-002",
      "description": "Implement greet() to console.log('hello yoke') and replace the test with a real assertion using node:test + node:assert.",
      "depends_on": ["feat-001"],
      "target_files": [
        { "path": "index.js", "contents": "import { stdout } from 'node:process';\nexport function greet() { stdout.write('hello yoke\\n'); return 'hello yoke'; }\nif (import.meta.url === `file://${process.argv[1]}`) greet();\n" },
        { "path": "test/index.test.js", "contents": "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../index.js';\ntest('greet returns hello yoke', () => {\n  assert.equal(greet(), 'hello yoke');\n});\n" }
      ]
    }
  ]
}
```

Instructions:
1. Create the parent directory docs/idea/ if it does not exist.
2. Use the Write tool to write the file docs/idea/features.json with
   exactly the contents shown above.
3. Do not reformat the JSON. Do not sort keys. Do not add or remove fields.
4. Do not run any other tools after writing the file.
5. Do not commit. Do not run tests. Do not summarise what you did.

Acceptance:
- The file docs/idea/features.json exists.
- It parses as valid JSON.
- It contains exactly two entries under .features with ids feat-001
  and feat-002 in that order.

When done, stop. Do not run any other tools.
