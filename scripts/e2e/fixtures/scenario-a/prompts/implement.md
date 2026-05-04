You are the implementer for feature {{item_id}}.

Description: {{item.description}}

target_files:
{{item.target_files}}

Method:
1. For every entry in target_files above, use the Write tool to create
   the file at the given path with the literal contents shown.
2. Create parent directories as needed (the Write tool handles this).
3. Do not modify, reformat, or improve the contents.
4. Do not invent additional files.
5. Do not run tests, lint, or any other tool.
6. Do not commit anything.

Acceptance:
- Every path under target_files exists with byte-identical contents to
  what is shown above.

When all files are written, stop.
