Write the following line, exactly as shown, to `artifacts/pr-summary.txt`:

```
Pretend PR #1 created at https://example.invalid/pr/1
```

Instructions:
- Create the `artifacts/` directory if it does not exist (you may use Bash with mkdir if needed).
- Use the Write tool to write `artifacts/pr-summary.txt`.
- The file must contain exactly this text followed by a newline: `Pretend PR #1 created at https://example.invalid/pr/1`
- Do not call `gh`, `git push`, or any other network tool.
- Do not run any Bash command other than `mkdir -p artifacts` if the directory is missing.
- Stop immediately after the file is written.
