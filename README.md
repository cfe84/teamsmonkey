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

## Install pre-built binaries

Pre-built releases are available at
[github.com/cfe84/teamsmonkey/releases](https://github.com/cfe84/teamsmonkey/releases).
Download the ZIP for your operating system and CPU architecture, then extract
it without changing the directory structure. The ZIP includes the loader and
the bundled UserScripts.

On Apple Silicon macOS:

```bash
mkdir -p "$HOME/.local/teamsmonkey"
curl -L https://github.com/cfe84/teamsmonkey/releases/latest/download/teamsmonkey-darwin-arm64.zip \
  -o /tmp/teamsmonkey.zip
unzip -o /tmp/teamsmonkey.zip -d "$HOME/.local/teamsmonkey"
chmod +x "$HOME/.local/teamsmonkey/teamsmonkey"
cd "$HOME/.local/teamsmonkey"
./teamsmonkey --service-install
```

For Intel macOS, replace `darwin-arm64` with `darwin-amd64`.

For a one-line macOS installation, run the installer directly from
the repository:

```bash
curl -fsSL https://raw.githubusercontent.com/cfe84/teamsmonkey/main/install.sh | bash
```

The script detects Apple Silicon or Intel macOS, downloads the latest matching
release, installs it under `~/.local/teamsmonkey`, enables the Teams CDP
environment setting, and registers the service.

### Windows

The Windows release supports 64-bit Windows (`amd64`). Download
`teamsmonkey-windows-amd64.zip` from the
[releases page](https://github.com/cfe84/teamsmonkey/releases), extract it to
a permanent directory such as
`$env:LOCALAPPDATA\Teamsmonkey`, and open PowerShell in that directory:

```powershell
$installDir = "$env:LOCALAPPDATA\Teamsmonkey"
New-Item -ItemType Directory -Force $installDir | Out-Null
Expand-Archive "$env:USERPROFILE\Downloads\teamsmonkey-windows-amd64.zip" `
  -DestinationPath $installDir -Force
Set-Location $installDir
```

Before installing the service, configure Teams to expose its local Chrome
DevTools Protocol endpoint:

```powershell
[Environment]::SetEnvironmentVariable(
  "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
  "--remote-debugging-port=9223",
  "User"
)
```

Fully quit Teams and start it again so the new user environment variable is
picked up. Then install the per-user Task Scheduler task:

```powershell
.\teamsmonkey.exe --service-install
```

PowerShell can perform the same installation from one line:

```powershell
irm https://raw.githubusercontent.com/cfe84/teamsmonkey/main/install.ps1 | iex
```

The script downloads the latest Windows amd64 release to
`%LOCALAPPDATA%\Teamsmonkey`, configures the user CDP environment setting, and
registers the `Teamsmonkey` scheduled task. If Windows reports
`Access is denied`, run PowerShell as the signed-in user rather than as a
different administrator account, remove any existing task named
`Teamsmonkey` in Task Scheduler, and run the command again.

The task is named `Teamsmonkey` and starts the loader when you sign in. The
installer checks the configured environment variable or an already-running
CDP endpoint before creating the task. If it reports that CDP is unavailable,
quit Teams completely, reopen it, and run the install command again.

To check that Teams is listening on the expected port:

```powershell
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 9223 -State Listen
Invoke-WebRequest http://127.0.0.1:9223/json/version
```

To remove the scheduled task without removing the CDP environment variable:

```powershell
.\teamsmonkey.exe --service-uninstall
```

The service installer checks that Teams is configured with CDP support. Follow
the platform-specific instructions in [Service installation](#service-installation)
if it reports that CDP is not enabled.

## Run the loader

For development or platforms without a pre-built release, Go 1.23 or newer is
required to build the standalone loader:

```bash
make build
./teamsmonkey --port 9223
```

The loader also accepts `--scripts`, `--port`, `--host`, `--target`, and
`--poll-ms`. The `--scripts` option takes precedence over
`TEAMSMONKEY_SCRIPT_PATH`.

## Service installation

On macOS, this installs launch agents. On Windows, source builds install a
per-user Task Scheduler task that starts Teamsmonkey when you sign in. For a
pre-built Windows release, use `teamsmonkey.exe` directly as described above.

For macOS or a source build:

```bash
make install
```

The service install checks that Teams is already exposing CDP or that
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is configured for the user. If it is
not configured, set it before installing.

On macOS:

```bash
launchctl setenv WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS --remote-debugging-port=9223
```

On Windows PowerShell:

```powershell
[Environment]::SetEnvironmentVariable(
  'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
  '--remote-debugging-port=9223',
  'User'
)
```

Fully quit and reopen Teams after changing the environment, then run the
service installation command again. To remove a macOS service or a source-built
service:

```bash
make uninstall
```

On Windows, uninstall removes only the Teamsmonkey scheduled task. It does
not remove `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, because that setting may
be used by other WebView2 applications.

The loader must be connected to a loopback-only CDP endpoint. CDP has no
authentication, so any local process that can reach the endpoint can inspect
and control signed-in Teams content.

The macOS launch agents are named `com.teamsmonkey.env` and
`com.teamsmonkey.loader`. The Windows scheduled task is named `Teamsmonkey`.
Service management is implemented by the Go binary, so Node.js is not
required.

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