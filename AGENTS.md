# Repository implementation rules

- User communication and implementation reports use Chinese.
- Source comments and function documentation use English. Every function includes a summary, `Args`, and `Returns`; use Google-style documentation adapted to the source language.
- Include a file header identifying the filename, module purpose, and concise description. Explain control flow and important calls with English comments.
- Preserve compatible/gui/native engines and explicit capability reporting. GUI/Native inputs use operating system input and validate the current browser window.
- Keep the core independent of Playwright and platform bindings. Share schemas and error declarations across packages and IPC.
- Use portable path construction, exact dependency versions, and committed lockfiles.
- Follow TASK dependencies. Record actual test commands and results in each task report. Distinguish implementation, compilation, and physical desktop validation.
- User approved a Chromium-only exception for the official isolated Python toolchain. Other Python environments require Conda and user confirmation before configuration or execution.
- Windows is the first implementation and physical validation platform. macOS and Linux retain separate implementation and validation states.
- Credentials, input values, browser storage, and URL queries must be excluded from diagnostic logs. MCP stdout contains protocol messages only.
- Keep Chromium checkout outside this repository in a configurable directory without spaces. Store browser modifications as reproducible patches.
