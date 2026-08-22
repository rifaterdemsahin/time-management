The `agy` command is the **Antigravity CLI** executable (Google's agentic coding assistant CLI). Because GitHub Codespaces runs a fresh Linux container, the executable isn't installed in your PATH by default.

### Quick Install (One-Liner)

Run the official installation script in your Codespace terminal:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash

```

*(Source:)*

Once installed, reload your shell or refresh your PATH environment:

```bash
source ~/.bashrc

```

Verify the installation and start a session:

```bash
agy

```

*(Source:)*

---

### Keep `agy` Permanently Installed in Codespaces

To ensure `agy` doesn't vanish whenever your Codespace rebuilds or stops, add the installation command to your project's `.devcontainer/devcontainer.json`:

```json
{
  "name": "Time Management Workspace",
  "postCreateCommand": "curl -fsSL https://antigravity.google/cli/install.sh | bash"
}

```
