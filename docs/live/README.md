# Live session transcripts

Final answers of headless Claude sessions (`claude -p --model haiku`), saved verbatim as each session printed them. Scratch paths are shortened to `<scratch>`. Each session drove the installed toolkit in a fixture project, and only the answer comes from the agent; the command outputs it quotes come from ECCode. All ran on 2026-10-23. Sessions 1–5 ran before the fixes from the independent audit (the MCP `evidence_run` allowlist, guard identity parsing, trace and index fixes); those fixes do not change the code paths the sessions exercise, except that session 2 was re-run after the runtime-edge fix it prompted. Session 6 ran after the audit fixes.

| File | Row it verifies | Setup |
|---|---|---|
| 1-codebase-mcp-onboard.txt | Understands a big codebase | No-Bash agent with only the `onboard`/`impact` tools of an `eccode mcp` server |
| 2-impact-trace.txt | Impact analysis | `impact src/util.js --trace -- "node src/index.js"` (after the runtime-edge fix this session prompted) |
| 3-process-sized.txt | Process sized to the task | `status` and `gate start architecture` on a quick work item |
| 4-deliveries.txt | Many deliveries | `work list` and `work start` while w2 is active |
| 5-stack-packs.txt | Stack packs | `stack`, `stack run node-test`, `stack run eccode-secrets` |
| 6-ask-path.txt | Trust: user decisions | `work abandon --actor user` held for the human |

Earlier live sessions are described in [senior-engineering.md](../senior-engineering.md): the CLI guard, the MCP no-Bash cycle, the adversarial battery, the multi-round safe-changes session and the bench-machinery session. Their transcripts were not saved. Only their recorded outcomes (event logs and audits) are described there.
