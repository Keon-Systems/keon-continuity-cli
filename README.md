# Kontinuity CLI

Kontinuity carries confirmed project memory between coding agents and machines. Run it in a terminal, from an agent hook, or as a stdio MCP server. It keeps agent inferences private to their own role until you confirm them.

This repository contains the standalone memory CLI and its client code. The Kontinuity Deck and memory services are distributed separately. [Kontinuity CLI overview](https://kontinuity.net/cli/)

The product is Kontinuity. The npm package is `@keon-systems/kontinuity-cli`. The primary executable is `kontinuity`. The previous executable remains available during migration.

## Install and try a handoff

Use Node.js 22.18 or newer on Linux, macOS, or Windows.

Release downloads are not yet published. The repository has no GitHub releases or tags yet. The v0.2.0 release stays unpublished until the [hosted handoff release gate](docs/hosted-release-verification.md) passes. Build from source to try the CLI today.

### Build from source

Building from source also requires Git.

~~~sh
git clone https://github.com/Keon-Systems/keon-kontinuity-cli.git
cd keon-kontinuity-cli
npm ci
npm pack
npm install --global ./keon-systems-kontinuity-cli-0.2.0.tgz
kontinuity --version
kontinuity demo
~~~

The demo runs in memory with two synthetic agents. It shows a private decision, a scripted confirmation, and the second agent reading the shared decision. It uses no credentials or hosted service. Use `kontinuity demo --json` for the structured result.

If you already have a Kontinuity installation providing these commands, use `node dist/cli/continuity.js --help` from this checkout to try the standalone CLI alongside it.

## Connect to shared memory

For hosted memory, get a Keon MCP Gateway credential and the project profile from your administrator. Enroll each machine with the credential issued for it. Login prompts for the secret without echoing it and checks the credential before storing it. Hosted account access is [by request](https://kontinuity.net/docs/install/#request).

~~~sh
kontinuity gateway login
kontinuity gateway status
kontinuity --as codex --project proj_example status
~~~

Use the same project profile on each machine. The Gateway verifies which profiles and operations each credential can access. Use the runtime name for the coding agent at the keyboard or in the hook.

The CLI can also use an existing direct Cortex endpoint for local development. Set `cortexUrl`, `tenantId`, and `ownerActor` in `~/.config/continuity/config.json` to match that service. Put its development secret in the configured `secretFile`, which defaults to `~/.config/continuity/cortex-secret`, and restrict file access to your user. The `~` directory is your user home on each platform.

## Hand off confirmed context

Replace `proj_example` with the project selected during setup. On the first machine, start by staging a fixture decision for review.

~~~sh
echo '{"decisions":[{"text":"Cap retry attempts at two.","keywords":["retry","limit","release"]}]}' | kontinuity --as claude --project proj_example stage
~~~

In Windows PowerShell the same pipeline works with `Write-Output` in place of `echo`.

Inspect `pending`. Replace `RECORD_ID` with the displayed ID and run `share` after reviewing and approving the decision. On the second machine use its own agent identity and the same project profile. If you use Gateway, each machine needs an enrollment for its agent role.

~~~sh
kontinuity --as claude --project proj_example pending
kontinuity --as claude --project proj_example share RECORD_ID --user-confirmed
kontinuity --as codex --project proj_example briefing
kontinuity --as codex --project proj_example recall "retry limit"
~~~

If you configure an MCP desktop client, launch `kontinuity --as YOUR_RUNTIME --project proj_example mcp` as its stdio server. Your runtime and project are fixed at launch. Run `kontinuity --help` for the command list and `kontinuity gateway help` for Gateway-specific tools and setup.

## Development

Run `npm ci` and `npm test`. The CLI has no third-party runtime dependencies.

Licensed under [Apache 2.0](LICENSE).
