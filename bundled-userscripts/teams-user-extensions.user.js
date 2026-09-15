// ==UserScript==
// @name         Teams User extensions
// @version      1.0.0
// @match        https://teams.microsoft.com/v2/*
// @match        https://teams.cloud.microsoft/v2/*
// @match        https://local.teams.office.com/v2/*
// @run-at       document-idle
// @toggleable   false
// ==/UserScript==

(() => {
  if (window.top !== window) return;

  globalThis.__teamsUserExtensions?.destroy();

  const DISABLED_STORAGE_KEY = "teams.userscripts.disabled";
  const REPOSITORIES_STORAGE_KEY = "teams.userscripts.repositories";
  const MAIN_REPOSITORY = {
    name: "Teams user scripts",
    url: "https://github.com/cfe84/teams-user-scripts",
    indexUrl:
      "https://github.com/cfe84/teams-user-scripts/raw/refs/heads/main/index.json",
  };
  const MENU_ITEM_ID = "teams-user-extensions-menu-item";
  const MODAL_ID = "teams-user-extensions-modal";

  function readDisabledExtensions() {
    try {
      const value = JSON.parse(
        localStorage.getItem(DISABLED_STORAGE_KEY) ?? "[]"
      );
      return Array.isArray(value) ? new Set(value) : new Set();
    } catch (error) {
      console.error("[Teams User extensions]", error);
      return new Set();
    }
  }

  function writeDisabledExtensions(disabledExtensions) {
    localStorage.setItem(
      DISABLED_STORAGE_KEY,
      JSON.stringify([...disabledExtensions].sort())
    );
  }

  async function waitFor(getValue, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = getValue();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for restart control");
  }

  async function restartTeams() {
    const restartSelector =
      "button[aria-label='Restart (also exits container)']";
    let restartButton = document.querySelector(restartSelector);
    if (!restartButton) {
      const ringElement = document.querySelector(
        "[data-tid='titlebar-status-indicator']"
      );
      if (!ringElement) throw new Error("Could not find the ring control");
      ringElement.click();
      restartButton = await waitFor(() =>
        document.querySelector(restartSelector)
      );
    }
    restartButton.click();
  }

  function closeModal() {
    document.getElementById(MODAL_ID)?.remove();
  }

  function readRepositories() {
    try {
      const value = JSON.parse(
        localStorage.getItem(REPOSITORIES_STORAGE_KEY) ?? "[]"
      );
      return [
        MAIN_REPOSITORY,
        ...(Array.isArray(value) ? value : []).filter(
          repository => repository?.indexUrl && repository.indexUrl !== MAIN_REPOSITORY.indexUrl
        ),
      ];
    } catch (error) {
      console.error("[Teams User extensions]", error);
      return [MAIN_REPOSITORY];
    }
  }

  function writeRepositories(repositories) {
    localStorage.setItem(
      REPOSITORIES_STORAGE_KEY,
      JSON.stringify(
        repositories
          .filter(repository => repository.indexUrl !== MAIN_REPOSITORY.indexUrl)
          .map(({ name, url, indexUrl }) => ({ name, url, indexUrl }))
      )
    );
  }

  function repositoryIndexUrl(value) {
    const url = value.trim().replace(/\/+$/, "");
    if (url.endsWith(".json")) return url;
    if (url.includes("raw.githubusercontent.com/")) {
      return `${url}/index.json`;
    }
    if (url.startsWith("https://github.com/")) {
      return `${url}/raw/refs/heads/main/index.json`;
    }
    return `${url}/index.json`;
  }

  function repositoryScriptUrl(repository, extension) {
    if (extension.url) return extension.url;
    const indexUrl = new URL(repository.indexUrl);
    const path = extension.path?.replace(/^\/+/, "");
    if (!path) throw new Error("Repository extension is missing a path");
    if (indexUrl.hostname === "raw.githubusercontent.com") {
      return new URL(path, indexUrl).toString();
    }
    return new URL(path, `${indexUrl.origin}${indexUrl.pathname.replace(/[^/]+$/, "")}`).toString();
  }

  async function fetchRepositoryResource(url) {
    if (typeof globalThis.__teamsmonkeyFetch === "function") {
      const result = await globalThis.__teamsmonkeyFetch(url);
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      return result.text;
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  function createLink(text, onClick) {
    const link = document.createElement("button");
    link.type = "button";
    link.textContent = text;
    Object.assign(link.style, {
      background: "transparent",
      border: "0",
      color: "var(--colorBrandForeground1, #5b5fc7)",
      cursor: "pointer",
      font: "inherit",
      padding: "4px 0",
      textDecoration: "underline",
    });
    link.addEventListener("click", onClick);
    return link;
  }

  function createModal(titleText, contentBuilder) {
    closeModal();
    const backdrop = document.createElement("div");
    backdrop.id = MODAL_ID;
    Object.assign(backdrop.style, {
      alignItems: "center",
      background: "rgba(0, 0, 0, 0.4)",
      display: "flex",
      inset: "0",
      justifyContent: "center",
      position: "fixed",
      zIndex: "2147483647",
    });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    Object.assign(dialog.style, {
      background: "var(--colorNeutralBackground1, #fff)",
      borderRadius: "8px",
      boxShadow: "0 8px 32px rgba(0, 0, 0, 0.28)",
      color: "var(--colorNeutralForeground1, #242424)",
      font: "14px/20px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      maxHeight: "70vh",
      minWidth: "460px",
      overflow: "auto",
      padding: "20px",
    });
    const header = document.createElement("div");
    Object.assign(header.style, {
      alignItems: "center",
      display: "flex",
      justifyContent: "space-between",
      marginBottom: "16px",
    });
    const heading = document.createElement("h2");
    heading.textContent = titleText;
    heading.id = `${MODAL_ID}-title`;
    Object.assign(heading.style, { fontSize: "20px", lineHeight: "28px", margin: "0" });
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.textContent = "×";
    Object.assign(closeButton.style, {
      background: "transparent",
      border: "0",
      color: "inherit",
      cursor: "pointer",
      fontSize: "24px",
      height: "32px",
      lineHeight: "24px",
      width: "32px",
    });
    closeButton.addEventListener("click", closeModal);
    header.append(heading, closeButton);
    dialog.append(header);
    contentBuilder(dialog);
    backdrop.append(dialog);
    backdrop.addEventListener("click", event => {
      if (event.target === backdrop) closeModal();
    });
    document.body.append(backdrop);
    closeButton.focus();
  }

  async function openGetExtensionsModal() {
    createModal("Get more extensions", dialog => {
      const status = document.createElement("p");
      status.textContent = "Loading extensions…";
      dialog.append(status);
      void (async () => {
        try {
          const repositories = readRepositories();
          const results = await Promise.all(
            repositories.map(async repository => {
              try {
                return {
                  repository,
                  index: JSON.parse(
                    await fetchRepositoryResource(repository.indexUrl)
                  ),
                };
              } catch (error) {
                throw new Error(`${repository.name}: ${error.message}`);
              }
            })
          );
          status.remove();
          for (const { repository, index } of results) {
            for (const extension of index.extensions ?? []) {
              const row = document.createElement("div");
              Object.assign(row.style, {
                borderTop: "1px solid var(--colorNeutralStroke2, #e0e0e0)",
                padding: "12px 0",
              });
              const name = document.createElement("strong");
              name.textContent = extension.name;
              const description = document.createElement("p");
              description.textContent = extension.description ?? "";
              Object.assign(description.style, { margin: "4px 0 8px" });
              const install = createLink("Install", async () => {
                install.disabled = true;
                install.textContent = "Installing…";
                try {
                  const source = await fetchRepositoryResource(
                    repositoryScriptUrl(repository, extension)
                  );
                  await globalThis.__teamsmonkeyDownloadScript({
                    filename: extension.filename ?? extension.path?.split("/").pop(),
                    source,
                  });
                  install.textContent = "Installed";
                } catch (error) {
                  install.disabled = false;
                  install.textContent = "Install";
                  console.error("[Teams User extensions]", error);
                  status.textContent = `Could not install ${extension.name}: ${error.message}`;
                  dialog.prepend(status);
                }
              });
              row.append(name, document.createTextNode(` (${repository.name})`), description, install);
              dialog.append(row);
            }
          }
          if (!dialog.querySelector("strong")) {
            status.textContent = "No extensions were found.";
            dialog.append(status);
          }
        } catch (error) {
          status.textContent = `Could not load extensions: ${error.message}`;
          console.error("[Teams User extensions]", error);
        }
      })();
      const footer = document.createElement("div");
      Object.assign(footer.style, { borderTop: "1px solid var(--colorNeutralStroke2, #e0e0e0)", marginTop: "16px", paddingTop: "12px" });
      footer.append(createLink("Manage repositories", () => openRepositoriesModal()));
      dialog.append(footer);
    });
  }

  function openRepositoriesModal() {
    createModal("Manage repositories", dialog => {
      const list = document.createElement("div");
      const render = () => {
        list.replaceChildren();
        for (const repository of readRepositories()) {
          const row = document.createElement("div");
          Object.assign(row.style, { alignItems: "center", borderTop: "1px solid var(--colorNeutralStroke2, #e0e0e0)", display: "flex", justifyContent: "space-between", padding: "10px 0" });
          row.append(document.createTextNode(repository.name));
          if (repository.indexUrl !== MAIN_REPOSITORY.indexUrl) {
            row.append(createLink("Remove", () => {
              writeRepositories(readRepositories().filter(item => item.indexUrl !== repository.indexUrl));
              render();
            }));
          }
          list.append(row);
        }
      };
      render();
      dialog.append(list);
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.placeholder = "Repository URL or index.json URL";
      input.required = true;
      Object.assign(input.style, { boxSizing: "border-box", marginTop: "16px", padding: "8px", width: "100%" });
      const add = document.createElement("button");
      add.type = "submit";
      add.textContent = "Add repository";
      Object.assign(add.style, { marginTop: "8px", padding: "6px 12px" });
      form.append(input, add);
      form.addEventListener("submit", event => {
        event.preventDefault();
        const indexUrl = repositoryIndexUrl(input.value);
        const repositories = readRepositories();
        if (!repositories.some(repository => repository.indexUrl === indexUrl)) {
          repositories.push({ name: input.value.trim(), url: input.value.trim(), indexUrl });
          writeRepositories(repositories);
          render();
          input.value = "";
        }
      });
      dialog.append(form);
      const footer = document.createElement("div");
      Object.assign(footer.style, { marginTop: "16px" });
      footer.append(createLink("Back to extensions", openGetExtensionsModal));
      dialog.append(footer);
    });
  }

  function openExtensionSettings(extension) {
    const settings = globalThis.__teamsUserscriptSettings?.[extension.name];
    if (typeof settings !== "function") return;
    closeModal();
    settings();
  }

  function createSwitch(extension, enabled) {
    const control = document.createElement("button");
    control.type = "button";
    control.setAttribute("role", "switch");
    control.setAttribute("aria-label", extension.name);
    control.setAttribute("aria-checked", String(enabled));
    Object.assign(control.style, {
      alignItems: "center",
      background: enabled
        ? "var(--colorBrandBackground, #6264a7)"
        : "var(--colorNeutralBackground1, #fff)",
      border: enabled
        ? "1px solid var(--colorBrandBackground, #6264a7)"
        : "1px solid var(--colorNeutralStroke1, #616161)",
      borderRadius: "10px",
      cursor: "pointer",
      display: "inline-flex",
      flex: "0 0 auto",
      height: "20px",
      justifyContent: enabled ? "flex-end" : "flex-start",
      padding: "2px",
      width: "36px",
    });
    const thumb = document.createElement("span");
    Object.assign(thumb.style, {
      background: enabled
        ? "var(--colorNeutralForegroundOnBrand, #fff)"
        : "var(--colorNeutralForeground3, #616161)",
      borderRadius: "50%",
      display: "block",
      height: "14px",
      width: "14px",
    });
    control.append(thumb);
    control.addEventListener("click", async () => {
      control.disabled = true;
      const disabledExtensions = readDisabledExtensions();
      if (enabled) disabledExtensions.add(extension.name);
      else disabledExtensions.delete(extension.name);
      writeDisabledExtensions(disabledExtensions);
      try {
        await restartTeams();
      } catch (error) {
        control.disabled = false;
        console.error("[Teams User extensions]", error);
      }
    });
    return control;
  }

  function openModal() {
    closeModal();
    const disabledExtensions = readDisabledExtensions();
    const extensions = (globalThis.__teamsUserscriptManifest ?? []).filter(
      extension => extension.toggleable
    );

    const backdrop = document.createElement("div");
    backdrop.id = MODAL_ID;
    Object.assign(backdrop.style, {
      alignItems: "center",
      background: "rgba(0, 0, 0, 0.4)",
      display: "flex",
      inset: "0",
      justifyContent: "center",
      position: "fixed",
      zIndex: "2147483647",
    });

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", `${MODAL_ID}-title`);
    Object.assign(dialog.style, {
      background: "var(--colorNeutralBackground1, #fff)",
      borderRadius: "8px",
      boxShadow: "0 8px 32px rgba(0, 0, 0, 0.28)",
      color: "var(--colorNeutralForeground1, #242424)",
      font: "14px/20px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      maxHeight: "70vh",
      minWidth: "420px",
      overflow: "auto",
      padding: "20px",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      alignItems: "center",
      display: "flex",
      justifyContent: "space-between",
      marginBottom: "16px",
    });
    const title = document.createElement("h2");
    title.id = `${MODAL_ID}-title`;
    title.textContent = "User extensions";
    Object.assign(title.style, {
      fontSize: "20px",
      lineHeight: "28px",
      margin: "0",
    });
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.textContent = "×";
    Object.assign(closeButton.style, {
      background: "transparent",
      border: "0",
      color: "inherit",
      cursor: "pointer",
      fontSize: "24px",
      height: "32px",
      lineHeight: "24px",
      width: "32px",
    });
    closeButton.addEventListener("click", closeModal);
    header.append(title, closeButton);
    dialog.append(header);

    if (!extensions.length) {
      const empty = document.createElement("p");
      empty.textContent = "No user extensions are available.";
      dialog.append(empty);
    } else {
      for (const extension of extensions) {
        const enabled = !disabledExtensions.has(extension.name);
        const row = document.createElement("div");
        Object.assign(row.style, {
          alignItems: "center",
          borderTop: "1px solid var(--colorNeutralStroke2, #e0e0e0)",
          display: "flex",
          gap: "24px",
          justifyContent: "space-between",
          minHeight: "52px",
        });
        const label = document.createElement("span");
        label.textContent = extension.name;
        const actions = document.createElement("span");
        Object.assign(actions.style, {
          alignItems: "center",
          display: "inline-flex",
          gap: "12px",
        });
        const settings = globalThis.__teamsUserscriptSettings?.[extension.name];
        if (typeof settings === "function") {
          const settingsLink = document.createElement("button");
          settingsLink.type = "button";
          settingsLink.textContent = "Settings";
          Object.assign(settingsLink.style, {
            background: "transparent",
            border: "0",
            color: "var(--colorBrandForeground1, #5b5fc7)",
            cursor: "pointer",
            font: "inherit",
            padding: "4px 0",
            textDecoration: "underline",
          });
          settingsLink.addEventListener("click", () =>
            openExtensionSettings(extension)
          );
          actions.append(settingsLink);
        }

        actions.append(createSwitch(extension, enabled));
        row.append(label, actions);
        dialog.append(row);
      }
    }

    const footer = document.createElement("div");
    Object.assign(footer.style, {
      borderTop: "1px solid var(--colorNeutralStroke2, #e0e0e0)",
      marginTop: "16px",
      paddingTop: "12px",
    });
    footer.append(createLink("Get more extensions", openGetExtensionsModal));
    dialog.append(footer);

    backdrop.append(dialog);
    backdrop.addEventListener("click", event => {
      if (event.target === backdrop) closeModal();
    });
    document.body.append(backdrop);
    closeButton.focus();
  }

  function createMenuItem(referenceItem) {
    const item = document.createElement("div");
    item.id = MENU_ITEM_ID;
    item.className = referenceItem.className;
    item.setAttribute("role", "menuitem");
    item.tabIndex = 0;
    item.textContent = "User extensions";
    item.addEventListener("click", openModal);
    item.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openModal();
    });
    return item;
  }

  function installMenuItem() {
    if (document.getElementById(MENU_ITEM_ID)) return;
    const ringMenuItem = [
      ...document.querySelectorAll("[data-tid='ringswitcher']"),
    ].find(
      element =>
        element.closest("[role='menu']") && element.getClientRects().length
    );
    const menu = ringMenuItem?.closest("[role='menu']");
    if (!ringMenuItem || !menu) return;
    const referenceItem =
      menu.querySelector("[data-tid='settings-button-menu']") ?? ringMenuItem;
    ringMenuItem.before(createMenuItem(referenceItem));
  }

  function handleKeydown(event) {
    if (event.key === "Escape" && document.getElementById(MODAL_ID)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeModal();
    }
  }

  const observer = new MutationObserver(installMenuItem);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("keydown", handleKeydown, true);
  installMenuItem();

  globalThis.__teamsUserExtensions = {
    destroy() {
      observer.disconnect();
      window.removeEventListener("keydown", handleKeydown, true);
      document.getElementById(MENU_ITEM_ID)?.remove();
      closeModal();
      delete globalThis.__teamsUserExtensions;
    },
  };
})();
