# Teamsmonkey

![Teamsmonkey](./img/teamsmonkey.png)

Teamsmonkey is a sidecar UserScript loader for the Microsoft Teams desktop
client. When installed on your system, it adds a menu in Teams that allows
you to load userscripts. Userscripts are small scripts allowing you to
customize and enhance the functionality of Teams.

![Teamsmonkey Userscripts menu](img/teams-monkey-menu.png)

Teamsmonkey is risk-free: it modifies temporarily your Teams client temporarily,
all modifications are removed as soon as you stop it. It doesn't modify your
files, doesn't touch your data, doesn't add any telemetry.

![User scripts manager](img/userscripts-manager.png)

## How it works

```mermaid
flowchart LR
    Teams[Teams desktop client]
    CDP[Loopback Chrome DevTools Protocol]
    Loader[Teamsmonkey loader]
    Cache[Installed scripts cache]
    Dev[Development directories]
    Manager[Teamsmonkey menu and script manager]
    Scripts[UserScripts]
    Catalogue[Script catalogues]

    Teams --> CDP
    Loader <-->|attach and inject| CDP
    Cache --> Loader
    Dev --> Loader
    Loader --> Scripts
    Loader --> Manager
    Manager -->|fetch and install| Catalogue
    Manager -->|enable, disable, update| Scripts
```

The bundled **User scripts** manager lets you enable and disable installed
scripts, browse the default
[teams-user-scripts](https://github.com/cfe84/teams-user-scripts) catalogue,
install scripts, manage additional compatible repositories, and check for
updates. Updates are checked when Teams loads and hourly while it is running.

![Embedded scripts catalogue](img/get-more-scripts.png)

## Run the loader

Go 1.23 or newer is required to build the standalone loader:

```bash
go build -o teamsmonkey .
./teamsmonkey --port 9223
```

The loader also accepts `--scripts`, `--port`, `--host`, `--target`, and
`--poll-ms`. The `--scripts` option takes precedence over
`TEAMSMONKEY_SCRIPT_PATH`.

## macOS launch agent

To configure the Teams CDP environment and keep the loader running:

```bash
go build -o teamsmonkey .
./teamsmonkey --service-install
```

Fully quit and reopen Teams after installation. To remove the launch agents:

```bash
./teamsmonkey --service-uninstall
```

The loader must be connected to a loopback-only CDP endpoint. CDP has no
authentication, so any local process that can reach the endpoint can inspect
and control signed-in Teams content.

The launch agents are named `com.teamsmonkey.env` and
`com.teamsmonkey.loader`. Service management is implemented by the Go binary,
so Node.js is not required.

## Development and technical details

Teamsmonkey is a local service that attaches to the local Chrome DevTools Protocol 
endpoint exposed by the embedded web runtime, without modifying the signed
Teams application.

Installed scripts are loaded from:

- macOS and Linux: `~/.config/teamsmonkey/scripts`
- Windows: `%APPDATA%\teamsmonkey\scripts`

Set `TEAMSMONKEY_SCRIPT_PATH` to use a different directory. The bundled manager
is always available and does not need to be copied into the scripts directory.

For local development, use **Manage directories (Dev)** in the User scripts
menu to add or remove script directories. Those directories are persisted in
the Teamsmonkey configuration and scanned at loader startup and whenever their
contents change. Scripts in the cache directory take precedence over
development-directory scripts with the same filename.

Private GitHub script repositories are supported through the standalone loader.
If GitHub CLI is installed and authenticated, Teamsmonkey automatically uses
`gh auth token` without copying the token into Teams. You can also provide a
token explicitly with `TEAMSMONKEY_GITHUB_TOKEN`; `TEAMSMONKEY_GH_PATH` can be
used when `gh` is installed outside the standard locations. Tokens are used
only for requests to `raw.githubusercontent.com` and are never exposed to the
page or persisted by Teamsmonkey.