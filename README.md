# Teamsmonkey

Teamsmonkey is a sidecar UserScript loader for the Microsoft Teams desktop
client. It attaches to the local Chrome DevTools Protocol endpoint exposed by
the embedded web runtime, without modifying the signed Teams application.

The bundled **User extensions** manager lets you enable and disable installed
scripts, browse the default
[teams-user-scripts](https://github.com/cfe84/teams-user-scripts) catalogue,
install scripts, and manage additional compatible repositories.

Installed scripts are loaded from:

- macOS and Linux: `~/.config/teamsmonkey/scripts`
- Windows: `%APPDATA%\teamsmonkey\scripts`

Set `TEAMSMONKEY_SCRIPT_PATH` to use a different directory. The bundled manager
is always available and does not need to be copied into the scripts directory.

## Run the loader

Node.js 22 or newer is required:

```bash
npm install
node teamsmonkey-loader.mjs --port 9223
```

The loader also accepts `--scripts`, `--port`, `--host`, `--target`, and
`--poll-ms`. The `--scripts` option takes precedence over
`TEAMSMONKEY_SCRIPT_PATH`.

## macOS launch agent

To configure the Teams CDP environment and keep the loader running:

```bash
npm run service:install
```

Fully quit and reopen Teams after installation. To remove the launch agents:

```bash
npm run service:uninstall
```

The loader must be connected to a loopback-only CDP endpoint. CDP has no
authentication, so any local process that can reach the endpoint can inspect
and control signed-in Teams content.

The launch agents are named `com.teamsmonkey.env` and
`com.teamsmonkey.loader`.
