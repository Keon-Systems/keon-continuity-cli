# Continuity CLI

Continuity carries confirmed project memory between coding agents and machines. Run it in a terminal, from an agent hook, or as a stdio MCP server. It keeps agent inferences private to their own role until you confirm them.

This repository contains the standalone memory CLI and its client code. The Continuity Deck and memory services are distributed separately. [Kontinuity CLI overview](https://kontinuity.net/cli/)

## Build and install

Use Node.js 22.18 or newer and Git on Linux, macOS, or Windows.

~~~sh
git clone https://github.com/Keon-Systems/keon-continuity-cli.git
cd keon-continuity-cli
npm ci
npm pack
npm install --global ./keon-systems-continuity-cli-0.1.0.tgz
continuity --help
~~~

The package provides the `continuity` and `kontinuity` commands. If you already have a Kontinuity installation providing these commands, use `node dist/cli/continuity.js --help` from this checkout to try the standalone CLI alongside it.

## Connect to shared memory

For hosted memory, get a Keon MCP Gateway credential and the project profile from your administrator. Enroll each machine with the credential issued for it. Login prompts for the secret without echoing it and checks the credential before storing it. Hosted account access is [by request](https://kontinuity.net/docs/install/#request).

~~~sh
continuity gateway login
continuity gateway status
continuity --as codex --project proj_example status
~~~

Use the same project profile on each machine. The Gateway verifies which profiles and operations each credential can access. Use the runtime name for the coding agent at the keyboard or in the hook.

The CLI can also use an existing direct Cortex endpoint for local development. Set `cortexUrl`, `tenantId`, and `ownerActor` in `~/.config/continuity/config.json` to match that service. Put its development secret in the configured `secretFile`, which defaults to `~/.config/continuity/cortex-secret`, and restrict file access to your user. The `~` directory is your user home on each platform.

## Hand off confirmed context

On the machine where an agent staged a record, inspect `pending`. Run `share` with the displayed record ID only after you have reviewed and approved it. Then load the confirmed context from the same project on the other machine.

~~~sh
continuity --as claude --project proj_example pending
continuity --as claude --project proj_example share RECORD_ID --user-confirmed
continuity --as codex --project proj_example briefing
continuity --as codex --project proj_example recall "retry limit"
~~~

If you configure an MCP desktop client, launch `continuity --as YOUR_RUNTIME --project proj_example mcp` as its stdio server. Your runtime and project are fixed at launch. Run `continuity --help` for the command list and `continuity gateway help` for Gateway-specific tools and setup.

## Development

Run `npm ci` and `npm test`. The CLI has no third-party runtime dependencies.

Licensed under [Apache 2.0](LICENSE).
