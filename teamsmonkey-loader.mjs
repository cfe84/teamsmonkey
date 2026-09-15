#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const port = option("--port", "9222");
const repositoryDirectory = dirname(fileURLToPath(import.meta.url));
const defaultScriptsDirectory =
  process.platform === "win32"
    ? resolve(process.env.APPDATA ?? resolve(homedir(), "AppData/Roaming"), "teamsmonkey/scripts")
    : resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "teamsmonkey/scripts");
const scriptsDirectory = resolve(
  option("--scripts", process.env.TEAMSMONKEY_SCRIPT_PATH ?? defaultScriptsDirectory)
);
const bundledScriptsDirectory = resolve(repositoryDirectory, "bundled-userscripts");
const targetFilter = option("--target", "teams.");
const requestedHost = option("--host", null);
const pollIntervalMs = Number(option("--poll-ms", "1000"));
const hosts = requestedHost ? [requestedHost] : ["127.0.0.1", "[::1]"];
const connections = new Map();
const relayBindingName = "__teamsVimiumRelay";
const downloadBindingName = "__teamsmonkeyDownloadScriptBinding";
const fetchBindingName = "__teamsmonkeyFetchBinding";
const disabledScriptsStorageKey = "teams.userscripts.disabled";
let scripts = [];
let scriptsRevision = 0;
let reloadTimer;

function wildcardToRegExp(value) {
  return new RegExp(
    `^${value
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")}$`
  );
}

function readMetadata(source) {
  const block = source.match(
    /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/
  )?.[1];
  const metadata = new Map();

  for (const line of block?.split(/\r?\n/) ?? []) {
    const match = line.match(/^\s*\/\/\s*@(\S+)\s+(.+?)\s*$/);
    if (!match) continue;
    const values = metadata.get(match[1]) ?? [];
    values.push(match[2]);
    metadata.set(match[1], values);
  }

  return metadata;
}

function loadScripts() {
  const bundledNames = new Set(readdirSync(bundledScriptsDirectory));
  const candidates = [...bundledNames, ...readdirSync(scriptsDirectory)]
    .filter(name => name.endsWith(".user.js"))
    .sort();
  scripts = [...new Set(candidates)].map(name => {
    const path = resolve(
      bundledNames.has(name) ? bundledScriptsDirectory : scriptsDirectory,
      name
    );
      const source = readFileSync(path, "utf8");
      const metadata = readMetadata(source);
      const includes = [
        ...(metadata.get("match") ?? []),
        ...(metadata.get("include") ?? []),
      ];
      const excludes = [
        ...(metadata.get("exclude-match") ?? []),
        ...(metadata.get("exclude") ?? []),
      ];

      return {
        name: metadata.get("name")?.[0] ?? name,
        path,
        source,
        hash: createHash("sha256").update(source).digest("hex").slice(0, 12),
        runAt: metadata.get("run-at")?.[0] ?? "document-idle",
        toggleable: metadata.get("toggleable")?.[0] !== "false",
        includes: (includes.length ? includes : ["https://teams.*/*"]).map(
          wildcardToRegExp
        ),
        excludes: excludes.map(wildcardToRegExp),
      };
    });
  scriptsRevision++;
  console.log(
    `Loaded ${scripts.length} userscript(s): ${scripts
      .map(script => script.name)
      .join(", ")}`
  );
}

function persistDownloadedScript(payload) {
  if (
    !payload ||
    typeof payload.filename !== "string" ||
    typeof payload.source !== "string"
  ) {
    throw new Error("A script filename and source are required");
  }
  const filename = basename(payload.filename);
  if (filename !== payload.filename || !filename.endsWith(".user.js")) {
    throw new Error("Only .user.js files can be installed");
  }
  mkdirSync(scriptsDirectory, { recursive: true });
  writeFileSync(resolve(scriptsDirectory, filename), payload.source, "utf8");
  loadScripts();
  return { filename };
}

async function handleDownloadBinding(connection, payload) {
  try {
    const request = JSON.parse(payload);
    const result = persistDownloadedScript(request);
    await connection.send("Runtime.evaluate", {
      expression: `globalThis.__teamsmonkeyDownloadScriptResult(${JSON.stringify(
        request.requestId
      )}, ${JSON.stringify({ ok: true, ...result })})`,
    });
  } catch (error) {
    let requestId;
    try {
      requestId = JSON.parse(payload).requestId;
    } catch {}
    if (requestId) {
      await connection.send("Runtime.evaluate", {
        expression: `globalThis.__teamsmonkeyDownloadScriptResult(${JSON.stringify(
          requestId
        )}, ${JSON.stringify({ ok: false, error: error.message })})`,
      });
    }
    console.error(`Could not install userscript: ${error.message}`);
  }
}

async function handleFetchBinding(connection, payload) {
  let requestId;
  try {
    const request = JSON.parse(payload);
    requestId = request.requestId;
    const url = new URL(request.url);
    if (url.protocol !== "https:") throw new Error("Only HTTPS URLs can be fetched");
    const response = await fetch(url);
    const result = {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
    await connection.send("Runtime.evaluate", {
      expression: `globalThis.__teamsmonkeyFetchResult(${JSON.stringify(
        requestId
      )}, ${JSON.stringify(result)})`,
    });
  } catch (error) {
    if (requestId) {
      await connection.send("Runtime.evaluate", {
        expression: `globalThis.__teamsmonkeyFetchResult(${JSON.stringify(
          requestId
        )}, ${JSON.stringify({ ok: false, error: error.message })})`,
      });
    }
    console.error(`Could not fetch userscript repository resource: ${error.message}`);
  }
}

function downloadBridgeSource() {
  return `(() => {
    const pending = globalThis.__teamsmonkeyDownloadScriptPending ??= new Map();
    let nextRequestId = 0;
    globalThis.__teamsmonkeyDownloadScriptResult = (requestId, result) => {
      const request = pending.get(requestId);
      if (!request) return;
      pending.delete(requestId);
      result.ok ? request.resolve(result) : request.reject(new Error(result.error));
    };
    globalThis.__teamsmonkeyDownloadScript = payload => new Promise((resolve, reject) => {
      const requestId = String(++nextRequestId);
      pending.set(requestId, { resolve, reject });
      globalThis.${downloadBindingName}(JSON.stringify({ requestId, ...payload }));
    });
  })()`;
}

function fetchBridgeSource() {
  return `(() => {
    const pending = globalThis.__teamsmonkeyFetchPending ??= new Map();
    let nextRequestId = 0;
    globalThis.__teamsmonkeyFetchResult = (requestId, result) => {
      const request = pending.get(requestId);
      if (!request) return;
      pending.delete(requestId);
      result.ok ? request.resolve(result) : request.reject(new Error(result.error));
    };
    globalThis.__teamsmonkeyFetch = url => new Promise((resolve, reject) => {
      const requestId = String(++nextRequestId);
      pending.set(requestId, { resolve, reject });
      globalThis.${fetchBindingName}(JSON.stringify({ requestId, url }));
    });
  })()`;
}

function scriptApplies(script, url) {
  return (
    script.includes.some(pattern => pattern.test(url)) &&
    !script.excludes.some(pattern => pattern.test(url))
  );
}

function scriptKey(script) {
  return `${script.name}:${script.hash}`;
}

function isHostedCalendarTarget(target) {
  return target.url.startsWith(
    "https://outlook.office.com/hosted/calendar/"
  );
}

function hintContext(target, targets, eligibleTargetIds) {
  const hostedCalendar = isHostedCalendarTarget(target);
  const peers = targets
    .filter(
      candidate =>
        eligibleTargetIds.has(candidate.id) &&
        isHostedCalendarTarget(candidate) === hostedCalendar
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const index = peers.findIndex(candidate => candidate.id === target.id);

  return {
    index: Math.max(0, index),
    count: Math.max(1, peers.length),
  };
}

function hintContextSource(context) {
  return `globalThis.__teamsVimiumHintContext = ${JSON.stringify(context)}`;
}

function wrappedSource(script, disabledScripts = []) {
  const includeSources = script.includes.map(pattern => pattern.source);
  const excludeSources = script.excludes.map(pattern => pattern.source);
  const key = scriptKey(script);
  const execute = `() => {
    const registry = globalThis.__teamsUserscriptLoader ??= new Set();
    if (registry.has(${JSON.stringify(key)})) return;
    registry.add(${JSON.stringify(key)});
    try {
${script.source}
    } catch (error) {
      console.error(${JSON.stringify(`[userscript] ${script.name}`)}, error);
    }

  }`;

  let schedule;
  if (script.runAt === "document-start") {
    schedule = `(${execute})()`;
  } else if (script.runAt === "document-end") {
    schedule = `document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", ${execute}, { once: true })
      : (${execute})()`;
  } else {
    schedule = `document.readyState === "complete"
      ? setTimeout(${execute}, 0)
      : addEventListener("load", () => setTimeout(${execute}, 0), { once: true })`;
  }

  return `(() => {
    const url = location.href;
    const includes = ${JSON.stringify(includeSources)}.map(value => new RegExp(value));
    const excludes = ${JSON.stringify(excludeSources)}.map(value => new RegExp(value));
    if (!includes.some(pattern => pattern.test(url)) ||
        excludes.some(pattern => pattern.test(url))) return;
    const disabledScripts = ${JSON.stringify(disabledScripts)};
    if (${script.toggleable} && disabledScripts.includes(${JSON.stringify(
      script.name
    )})) {
      (globalThis.__teamsUserscriptLoader ??= new Set()).add(${JSON.stringify(
        scriptKey(script)
      )});
      return;
    }
    ${schedule};
  })();
  //# sourceURL=teams-userscript://${encodeURIComponent(script.name)}.user.js`;
}

function userscriptManifestSource() {
  const manifest = scripts.map(script => ({
      name: script.name,
      toggleable: script.toggleable,
      includes: script.includes.map(pattern => pattern.source),
      excludes: script.excludes.map(pattern => pattern.source),
    }));
  return `globalThis.__teamsUserscriptManifest = ${JSON.stringify(manifest)}
    .filter(extension =>
      extension.includes.some(value => new RegExp(value).test(location.href)) &&
      !extension.excludes.some(value => new RegExp(value).test(location.href))
    )
    .map(({ name, toggleable }) => ({ name, toggleable }))`;
}

async function ensureScripts(connection, target, context, disabledScripts) {
  await connection.send("Runtime.evaluate", {
    expression: hintContextSource(context),
  });
  await connection.send("Runtime.evaluate", {
    expression: userscriptManifestSource(),
  });
  for (const script of scripts) {
    if (!scriptApplies(script, target.url)) continue;
    const key = scriptKey(script);
    const status = await connection.send("Runtime.evaluate", {
      expression: `globalThis.__teamsUserscriptLoader?.has(${JSON.stringify(
        key
      )}) === true`,
      returnByValue: true,
    });
    if (status.result?.value === true) continue;
    const result = await connection.send("Runtime.evaluate", {
      expression: wrappedSource(script, disabledScripts),
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      console.error(
        `Failed to restore "${script.name}" in "${target.title}":`,
        result.exceptionDetails.text
      );
    } else {
      console.log(`Restored "${script.name}" in "${target.title}"`);
    }
  }
}

async function fetchTargets() {
  const errors = [];

  for (const host of hosts) {
    try {
      const response = await fetch(`http://${host}:${port}/json/list`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json();
      if (
        targets.some(target =>
          `${target.title} ${target.url}`
            .toLowerCase()
            .includes(targetFilter.toLowerCase())
        )
      ) {
        return {
          host,
          targets: targets.filter(
            target =>
              target.type === "page" ||
              target.type === "iframe"
          ),
        };
      }
    } catch (error) {
      errors.push(`${host}: ${error.cause?.code ?? error.message}`);
    }
  }

  throw new Error(errors.join("; "));
}

function relayUserscriptKey(sourceConnection, payload) {
  const expression = `globalThis.__teamsVimium?.receiveRelayedKey(${JSON.stringify(
    payload
  )})`;
  for (const connection of connections.values()) {
    if (
      connection === sourceConnection ||
      connection.socket.readyState !== WebSocket.OPEN
    ) {
      continue;
    }
    void connection.send("Runtime.evaluate", { expression }).catch(() => {});
  }
}

function connect(webSocketUrl) {
  return new Promise((resolveConnection, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 0;
    let settled = false;

    const connection = {
      socket,
      registrationIds: [],
      revision: 0,
      send(method, params = {}) {
        return new Promise((resolveMessage, rejectMessage) => {
          const id = ++nextId;
          const timeout = setTimeout(() => {
            pending.delete(id);
            rejectMessage(new Error(`${method} timed out`));
          }, 10000);
          pending.set(id, { resolveMessage, rejectMessage, timeout });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      close() {
        socket.close();
      },
    };

    socket.onopen = () => {
      settled = true;
      resolveConnection(connection);
    };
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (
        message.method === "Runtime.bindingCalled" &&
        message.params?.name === relayBindingName
      ) {
        relayUserscriptKey(connection, message.params.payload);
        return;
      }
      if (
        message.method === "Runtime.bindingCalled" &&
        message.params?.name === downloadBindingName
      ) {
        void handleDownloadBinding(connection, message.params.payload);
        return;
      }
      if (
        message.method === "Runtime.bindingCalled" &&
        message.params?.name === fetchBindingName
      ) {
        void handleFetchBinding(connection, message.params.payload);
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timeout);
      pending.delete(message.id);
      if (message.error) {
        request.rejectMessage(new Error(message.error.message));
      } else {
        request.resolveMessage(message.result);
      }
    };
    socket.onerror = () => {
      if (!settled) reject(new Error("WebSocket connection failed"));
    };
    socket.onclose = () => {
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.rejectMessage(new Error("Target disconnected"));
      }
      pending.clear();
    };
  });
}

async function installScripts(connection, target, context, disabledScripts) {
  for (const registrationId of connection.registrationIds) {
    await connection
      .send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: registrationId,
      })
      .catch(() => {});
  }
  connection.registrationIds = [];
  await connection.send("Runtime.enable");
  await connection
    .send("Runtime.addBinding", { name: relayBindingName })
    .catch(() => {});
  await connection
    .send("Runtime.addBinding", { name: downloadBindingName })
    .catch(() => {});
  await connection
    .send("Runtime.addBinding", { name: fetchBindingName })
    .catch(() => {});
  await connection.send("Page.enable");
  const contextSource = hintContextSource(context);
  const contextRegistration = await connection.send(
    "Page.addScriptToEvaluateOnNewDocument",
    { source: contextSource }
  );
  connection.registrationIds.push(contextRegistration.identifier);
  await connection.send("Runtime.evaluate", {
    expression: contextSource,
  });
  const manifestSource = userscriptManifestSource();
  const manifestRegistration = await connection.send(
    "Page.addScriptToEvaluateOnNewDocument",
    { source: manifestSource }
  );
  connection.registrationIds.push(manifestRegistration.identifier);
  await connection.send("Runtime.evaluate", {
    expression: manifestSource,
  });
  await connection.send("Runtime.evaluate", {
    expression: downloadBridgeSource(),
  });
  await connection.send("Runtime.evaluate", {
    expression: fetchBridgeSource(),
  });

  for (const script of scripts) {
    const source = wrappedSource(script, disabledScripts);
    const registration = await connection.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source }
    );
    connection.registrationIds.push(registration.identifier);

    if (scriptApplies(script, target.url)) {
      const result = await connection.send("Runtime.evaluate", {
        expression: source,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        console.error(
          `Failed to run "${script.name}" in "${target.title}":`,
          result.exceptionDetails.text
        );
      } else {
        console.log(`Injected "${script.name}" into "${target.title}"`);
      }
    }
  }
  connection.revision = scriptsRevision;
  connection.hintContext = JSON.stringify(context);
}

async function reconcile() {
  const { host, targets } = await fetchTargets();
  const matchingTargets = targets.filter(
    target =>
      `${target.title} ${target.url}`
        .toLowerCase()
        .includes(targetFilter.toLowerCase()) ||
      scripts.some(script => scriptApplies(script, target.url))
  );
  const liveTargetIds = new Set(matchingTargets.map(target => target.id));

  for (const [targetId, connection] of connections) {
    if (
      !liveTargetIds.has(targetId) ||
      connection.socket.readyState === WebSocket.CLOSED
    ) {
      connection.close();
      connections.delete(targetId);
    }
  }

  for (const target of matchingTargets) {
    let connection = connections.get(target.id);
    if (!connection) {
      const url = target.webSocketDebuggerUrl.replace(
        /^ws:\/\/[^/]+/,
        `ws://${host}:${port}`
      );
      connection = await connect(url);
      connections.set(target.id, connection);
      console.log(`Attached to "${target.title}" (${target.url})`);
    }
  }

  let disabledScripts = [];
  const teamsTarget = matchingTargets.find(
    target => !isHostedCalendarTarget(target)
  );
  if (teamsTarget) {
    const connection = connections.get(teamsTarget.id);
    const result = await connection.send("Runtime.evaluate", {
      expression: `(() => {
        try {
          const value = JSON.parse(
            localStorage.getItem(${JSON.stringify(
              disabledScriptsStorageKey
            )}) ?? "[]"
          );
          return Array.isArray(value) ? value : [];
        } catch (error) {
          console.error("[userscript-loader] Could not read disabled extensions", error);
          return [];
        }
      })()`,
      returnByValue: true,
    });
    disabledScripts = result.result?.value ?? [];
  }

  const eligibleTargetIds = new Set();
  await Promise.all(
    matchingTargets.map(async target => {
      const connection = connections.get(target.id);
      const result = await connection.send("Runtime.evaluate", {
        expression: `document.visibilityState === "visible" &&
          Boolean(document.querySelector(
            "a[href], button, input:not([type='hidden']), select, textarea, [contenteditable='true'], [role='button'], [role='link'], [role='switch'], [role='tab'], [role='textbox']"
          ))`,
        returnByValue: true,
      });
      if (result.result?.value === true) eligibleTargetIds.add(target.id);
    })
  );

  for (const target of matchingTargets) {
    const connection = connections.get(target.id);
    const context = hintContext(
      target,
      matchingTargets,
      eligibleTargetIds
    );
    const contextSignature = JSON.stringify(context);
    if (
      connection.revision !== scriptsRevision ||
      connection.hintContext !== contextSignature
    ) {
      await installScripts(connection, target, context, disabledScripts);
    } else {
      await ensureScripts(connection, target, context, disabledScripts);
    }
  }
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    try {
      loadScripts();
    } catch (error) {
      console.error(`Could not reload userscripts: ${error.message}`);
    }
  }, 100);
}

mkdirSync(scriptsDirectory, { recursive: true });
if (!statSync(bundledScriptsDirectory).isDirectory()) {
  throw new Error(`Not a directory: ${bundledScriptsDirectory}`);
}
loadScripts();
watch(scriptsDirectory, scheduleReload);
console.log(
  `Watching ${scriptsDirectory}; bundled scripts from ${bundledScriptsDirectory}; looking for Teams CDP targets on localhost:${port}`
);

for (;;) {
  try {
    await reconcile();
  } catch (error) {
    console.error(`Waiting for Teams CDP endpoint: ${error.message}`);
  }
  await new Promise(resolveDelay => setTimeout(resolveDelay, pollIntervalMs));
}
