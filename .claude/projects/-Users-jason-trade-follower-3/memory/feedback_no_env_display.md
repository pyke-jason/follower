---
name: Never display .env contents
description: Do not grep, cat, or display .env file contents — they contain secrets
type: feedback
---

Never display .env file contents to the screen. The .env contains API keys, passwords, and other secrets. If you need to check a value exists, check for its presence without showing the value, or just read the variable from process.env in a script.

**Why:** User was rightfully upset when credentials were displayed in terminal output.
**How to apply:** Never use grep/cat/read on .env files. If you need to verify a key is set, do it in code (e.g., `process.env.KEY ? 'set' : 'missing'`).
