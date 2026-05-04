You are implementing feature `{{item_id}}`.

Description: {{item.description}}

The files to create are listed below as a JSON array:

```json
{{item.target_files}}
```

Instructions:
- For every entry in the array above, use the Write tool to create (or
  overwrite) the file at the path given by `.path`, with exactly the
  bytes given by `.contents`.
- Create any parent directories that do not exist before writing.
- Write each file exactly as specified. Do not add, remove, or change any bytes.
- DO NOT delete or modify any other file in the worktree. In particular:
  the existing `package.json`, `index.js`, and `test/smoke.test.js` are
  the project baseline. If `index.js` is in `target_files` you MUST keep
  every export the seeded version had (so `greet()` returning `'hello'`
  still works) and add the new exports alongside it. Never delete or
  rename `test/smoke.test.js`.
- Do not run tests. Do not commit. Do not create any files not listed above.
- Stop immediately after all files are written.
