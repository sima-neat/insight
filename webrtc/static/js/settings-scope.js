// The settings dialog's scope UI (spec part 3): a channel gets its own value for a
// setting only while that setting's switch is on. The global dialog lists, under
// every setting, the channels with a value of their own, and offers a reset of all
// channels. settings.js owns the dialog and calls into this file; nothing here
// touches the page until create() runs from settings.js's DOMContentLoaded handler.
(() => {
  // The settings functions this UI calls (viewer-settings-resolver.js).
  const REQUIRED_API_FUNCTIONS = [
    "scalarSettings",
    "followedValue",
    "readScopeOwnValues",
    "listChannelOverrides",
    "inheritedObjects",
    "writeScopeOwnSettings",
    "clearScopeOwnValue",
    "countChannelScopes",
    "clearAllChannelScopes"
  ];

  // The page elements this UI needs besides the controls of the table below.
  const REQUIRED_ELEMENT_IDS = [
    "viewerSettingsOverlay",
    "viewerSettingsScopeLine",
    "viewerObjectInheritedBody",
    "viewerObjectTableBody",
    "segmentationObjectInheritedBody",
    "segmentationObjectTableBody",
    "resetChannelScopes",
    "resetChannelScopesConfirm",
    "resetChannelScopesMessage",
    "resetChannelScopesConfirmButton",
    "resetChannelScopesCancel",
    "saveViewerSettings"
  ];

  function readInteger(control) {
    return parseInt(control.value, 10);
  }

  function readFraction(control) {
    return parseFloat(control.value);
  }

  function readChecked(control) {
    return control.checked;
  }

  function writeNumber(control, value) {
    control.value = value;
  }

  // Writing goes through the event the user's own click would fire, so settings.js
  // updates the controls that depend on it exactly as it does for the user.
  function writeChecked(control, value) {
    control.checked = value !== false;
    control.dispatchEvent(new Event("change"));
  }

  // The values as the notes quote them, with their unit.
  function describeMs(value) {
    return `${value} ms`;
  }

  function describeRetention(value) {
    return Number(value) === 0 ? "no expiry" : describeMs(value);
  }

  function describeFraction(value) {
    return Number(value).toFixed(2);
  }

  function describeOnOff(value) {
    return value === false ? "off" : "on";
  }

  function describePositions(value) {
    return `${value} positions`;
  }

  const NUMBER = { write: writeNumber };
  const CHECKBOX = { read: readChecked, write: writeChecked };

  // The one table: each scalar setting id with its control and how its value is
  // read, written and described. Switches, notes, locking
  // and saving are all driven by it.
  const SCALAR_CONTROLS = {
    "general.videoSyncBufferMs": {
      control: "videoSyncBufferInput",
      ...NUMBER,
      read: readInteger,
      describe: describeMs
    },
    "general.metadataRetentionMs": {
      control: "metadataRetentionInput",
      ...NUMBER,
      read: readInteger,
      describe: describeRetention
    },
    "general.showRoi": { control: "toggleRoiVisibility", ...CHECKBOX, describe: describeOnOff },
    "general.applyRoiFiltering": { control: "toggleRoiFiltering", ...CHECKBOX, describe: describeOnOff },
    "types.object-detection.confidenceThreshold": {
      control: "confidenceInput",
      ...NUMBER,
      read: readFraction,
      describe: describeFraction
    },
    "types.segmentation.confidenceThreshold": {
      control: "segmentationConfidenceInput",
      ...NUMBER,
      read: readFraction,
      describe: describeFraction
    },
    "types.segmentation.maskOpacity": {
      control: "segmentationOpacityInput",
      ...NUMBER,
      read: readFraction,
      describe: describeFraction
    },
    "types.tracking.confidenceThreshold": {
      control: "trackingConfidenceInput",
      ...NUMBER,
      read: readFraction,
      describe: describeFraction
    },
    "types.tracking.history.enabled": {
      control: "toggleTrackHistory",
      ...CHECKBOX,
      describe: describeOnOff
    },
    "types.tracking.history.trailLength": {
      control: "trackTrailLengthInput",
      ...NUMBER,
      read: readInteger,
      describe: describePositions,
      dependsOnTrackHistory: true
    },
    "types.tracking.history.lostTrackTtlMs": {
      control: "lostTrackTtlInput",
      ...NUMBER,
      read: readInteger,
      describe: describeMs,
      dependsOnTrackHistory: true
    }
  };

  const TRACK_HISTORY_ID = "types.tracking.history.enabled";

  // The class colour lists: where the inherited rows go, and the own rows' body.
  const OBJECT_LISTS = [
    { metadataType: "object-detection", inherited: "viewerObjectInheritedBody", own: "viewerObjectTableBody" },
    { metadataType: "segmentation", inherited: "segmentationObjectInheritedBody", own: "segmentationObjectTableBody" }
  ];

  const STYLE_NAMES = { solid: "Solid", dashed: "Dashed", dotted: "Dotted" };
  const WIDTH_NAMES = { 1: "Thin", 3: "Thick" };

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function isChannelScope(scope) {
    return scope !== "global";
  }

  function channelOfScope(scope) {
    const match = /^channel_(\d+)$/.exec(scope);
    return match ? parseInt(match[1], 10) : null;
  }

  // The row that holds a setting: a table row on the Metadata and General tabs,
  // the setting's group in the ROI tab's row.
  function settingContainer(control) {
    return control.closest("tr, .roi-scope-setting");
  }

  // What keeps the scope UI from working with this settings script and this page;
  // settings.js decides once from it whether to use the scope UI at all.
  function missingRequirements(settingsApi) {
    const functions = REQUIRED_API_FUNCTIONS.filter((name) => typeof settingsApi[name] !== "function");
    const elements = REQUIRED_ELEMENT_IDS.filter((id) => !document.getElementById(id));
    Object.values(SCALAR_CONTROLS).forEach((entry) => {
      const control = document.getElementById(entry.control);
      if (!control || !settingContainer(control)) elements.push(entry.control);
    });
    if (functions.length === 0) {
      // Both sides must name the same settings, or a switch would save nothing.
      const known = settingsApi.scalarSettings().map((setting) => setting.id);
      const unmatched = known
        .filter((id) => !hasOwn(SCALAR_CONTROLS, id))
        .concat(Object.keys(SCALAR_CONTROLS).filter((id) => !known.includes(id)));
      if (unmatched.length > 0) functions.push(`scalarSettings() matching ${unmatched.join(", ")}`);
    }
    return { functions, elements };
  }

  function createButton(text, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function createNoteLine(text, button) {
    const line = document.createElement("div");
    line.className = "settings-scope-note-line";
    line.appendChild(document.createTextNode(text));
    if (button) {
      line.appendChild(document.createTextNode(" "));
      line.appendChild(button);
    }
    return line;
  }

  // The label of the setting itself, so the switch can name what it belongs to.
  function settingLabelId(controlId) {
    const label = document.querySelector(`label[for="${controlId}"]`);
    if (!label) return null;
    if (!label.id) label.id = `${controlId}Label`;
    return label.id;
  }

  function createSwitch(controlId, container) {
    const wrapper = document.createElement(container.tagName === "TR" ? "td" : "span");
    wrapper.className = "settings-own-switch settings-channel-only";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `${controlId}OwnValue`;
    input.className = "settings-own-switch-input";
    input.setAttribute("role", "switch");
    const labelId = settingLabelId(controlId);
    if (labelId) input.setAttribute("aria-describedby", labelId);
    const label = document.createElement("label");
    label.htmlFor = input.id;
    label.textContent = "Own value";
    wrapper.append(input, label);
    container.appendChild(wrapper);
    return { wrapper, input };
  }

  // A table setting gets a note row under its row; a ROI group gets a line inside it.
  function createNote(container) {
    if (container.tagName === "TR") {
      const row = document.createElement("tr");
      row.className = "settings-scope-note-row";
      row.hidden = true;
      const cell = document.createElement("td");
      cell.className = "settings-scope-note";
      cell.colSpan = 3;
      row.appendChild(cell);
      container.after(row);
      return { box: row, content: cell };
    }
    const box = document.createElement("div");
    box.className = "settings-scope-note";
    box.hidden = true;
    container.appendChild(box);
    return { box, content: box };
  }

  function create(options) {
    const { settingsApi, createObjectEntry, readObjectEntries, dispatchSettingsChanged } = options;
    const dialog = document.getElementById("viewerSettingsOverlay");
    const scopeLine = document.getElementById("viewerSettingsScopeLine");
    const saveButton = document.getElementById("saveViewerSettings");
    const resetLink = document.getElementById("resetChannelScopes");
    const resetConfirm = document.getElementById("resetChannelScopesConfirm");
    const resetMessage = document.getElementById("resetChannelScopesMessage");
    const resetConfirmButton = document.getElementById("resetChannelScopesConfirmButton");
    const resetCancel = document.getElementById("resetChannelScopesCancel");
    let scope = "global";

    const settings = settingsApi.scalarSettings().map(({ id }) => {
      const entry = SCALAR_CONTROLS[id];
      const control = document.getElementById(entry.control);
      const container = settingContainer(control);
      const own = createSwitch(entry.control, container);
      const note = createNote(container);
      const setting = { id, entry, control, container, own, note };
      own.input.addEventListener("change", () => onSwitchChange(setting));
      return setting;
    });
    const trackHistory = settings.find((setting) => setting.id === TRACK_HISTORY_ID);

    const objectLists = OBJECT_LISTS.map((list) => {
      const objectList = {
        metadataType: list.metadataType,
        ownBody: document.getElementById(list.own),
        inheritedBody: document.getElementById(list.inherited)
      };
      // A renamed own entry can hide or reveal an inherited one.
      objectList.ownBody.addEventListener("change", () => renderInherited(objectList));
      return objectList;
    });

    resetLink.addEventListener("click", openResetConfirm);
    resetCancel.addEventListener("click", closeResetConfirm);
    resetConfirmButton.addEventListener("click", resetAllChannels);
    resetConfirm.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeResetConfirm();
    });

    function inChannelDialog() {
      return isChannelScope(scope);
    }

    function writeValue(setting, value) {
      setting.entry.write(setting.control, value);
    }

    function readValue(setting) {
      return setting.entry.read(setting.control);
    }

    // A control is usable when it is the channel's own (always, in the global
    // dialog) and, for the track history settings, while track history is on. In a
    // channel dialog the track history control holds what the channel ends up with:
    // its own value when switched on, the followed value otherwise.
    function isEnabled(setting) {
      if (setting.entry.dependsOnTrackHistory && !trackHistory.control.checked) return false;
      return !inChannelDialog() || setting.own.input.checked;
    }

    function refreshControls() {
      settings.forEach((setting) => {
        const enabled = isEnabled(setting);
        setting.control.disabled = !enabled;
        setting.container.classList.toggle("settings-scope-locked", !enabled);
      });
    }

    function renderChannelNote(setting) {
      const isOwn = setting.own.input.checked;
      setting.note.content.replaceChildren();
      if (isOwn) {
        const followed = settingsApi.followedValue(setting.id);
        setting.note.content.appendChild(createNoteLine(`Global value: ${setting.entry.describe(followed)}.`));
      }
      setting.note.box.hidden = !isOwn;
    }

    function renderGlobalNote(setting) {
      const overrides = settingsApi.listChannelOverrides(setting.id);
      setting.note.content.replaceChildren();
      setting.note.box.hidden = overrides.length === 0;
      if (overrides.length === 0) return;
      const box = document.createElement("div");
      box.className = "settings-scope-note--info";
      overrides.forEach(({ channel, value }) => {
        box.appendChild(
          createNoteLine(
            `Channel ${channel} uses its own value: ${setting.entry.describe(value)}.`,
            createButton("Use global value", "settings-scope-link", () => useGlobalValueForChannel(setting, channel))
          )
        );
      });
      box.appendChild(
        createNoteLine(overrides.length === 1 ? "Changes here do not affect it." : "Changes here do not affect them.")
      );
      setting.note.content.appendChild(box);
    }

    // "Use global value" in the global dialog takes effect at once, without Save.
    function useGlobalValueForChannel(setting, channel) {
      const channelScope = `channel_${channel}`;
      if (!settingsApi.clearScopeOwnValue(channelScope, setting.id)) return;
      dispatchSettingsChanged(channelScope);
      renderGlobalNote(setting);
      renderResetLink();
      // The button is gone; keep the focus on this setting.
      const nextLink = setting.note.content.querySelector(".settings-scope-link");
      if (nextLink) nextLink.focus();
      else if (!setting.control.disabled) setting.control.focus();
    }

    function onSwitchChange(setting) {
      if (!setting.own.input.checked) writeValue(setting, settingsApi.followedValue(setting.id));
      renderChannelNote(setting);
      refreshControls();
    }

    function loadChannelSettings() {
      const ownValues = settingsApi.readScopeOwnValues(scope);
      settings.forEach((setting) => {
        const isOwn = hasOwn(ownValues, setting.id);
        setting.own.input.checked = isOwn;
        writeValue(setting, isOwn ? ownValues[setting.id] : settingsApi.followedValue(setting.id));
      });
    }

    // The global dialog has no own values; no switch keeps a channel's state.
    function loadGlobalSettings() {
      settings.forEach((setting) => {
        setting.own.input.checked = false;
      });
    }

    function createInheritedRow(objectList, entry) {
      const row = document.createElement("tr");
      row.className = "settings-inherited-row";

      const labelCell = document.createElement("td");
      const label = document.createElement("span");
      label.className = "settings-inherited-label";
      label.textContent = entry.label;
      const tag = document.createElement("span");
      tag.className = "settings-inherited-tag";
      tag.textContent = "from global";
      labelCell.append(label, tag);

      const colorCell = document.createElement("td");
      const swatch = document.createElement("span");
      swatch.className = "settings-inherited-swatch";
      swatch.style.backgroundColor = entry.color;
      swatch.title = entry.color;
      colorCell.appendChild(swatch);

      const styleCell = document.createElement("td");
      styleCell.textContent = STYLE_NAMES[entry.style] || entry.style;
      const widthCell = document.createElement("td");
      widthCell.textContent = WIDTH_NAMES[entry.width] || String(entry.width);

      const actionCell = document.createElement("td");
      actionCell.appendChild(
        createButton("Override", "settings-scope-link", () => overrideInherited(objectList, entry))
      );

      row.append(labelCell, colorCell, styleCell, widthCell, actionCell);
      return row;
    }

    // Global entries first, read-only; a global entry the channel has its own entry
    // for is not shown. The global dialog shows none.
    function renderInherited(objectList) {
      objectList.inheritedBody.replaceChildren();
      if (inChannelDialog()) {
        const ownLabels = new Set(readObjectEntries(objectList.metadataType).map((entry) => entry.label.trim()));
        settingsApi
          .inheritedObjects(objectList.metadataType)
          .filter((entry) => !ownLabels.has(entry.label))
          .forEach((entry) => objectList.inheritedBody.appendChild(createInheritedRow(objectList, entry)));
      }
      objectList.inheritedBody.hidden = objectList.inheritedBody.childElementCount === 0;
    }

    function refreshInherited() {
      objectLists.forEach(renderInherited);
    }

    // Override: an own entry with the same values, made by the dialog's own row creation.
    function overrideInherited(objectList, entry) {
      const row = createObjectEntry(objectList.metadataType, entry);
      renderInherited(objectList);
      const firstInput = row && row.querySelector("input");
      if (firstInput) firstInput.focus();
    }

    function channelCountText(count) {
      return count === 1 ? "1 channel" : `${count} channels`;
    }

    function renderResetLink() {
      resetLink.hidden = !resetConfirm.hidden || settingsApi.countChannelScopes() === 0;
    }

    function openResetConfirm() {
      const count = settingsApi.countChannelScopes();
      resetMessage.textContent = `Remove the own values of ${channelCountText(count)}? Regions of interest are kept.`;
      resetConfirm.hidden = false;
      resetLink.hidden = true;
      resetCancel.focus();
    }

    function hideResetConfirm() {
      resetConfirm.hidden = true;
      resetMessage.textContent = "";
    }

    function closeResetConfirm() {
      hideResetConfirm();
      renderResetLink();
      if (!resetLink.hidden) resetLink.focus();
      else saveButton.focus();
    }

    // Every channel follows the global settings again; the drawn regions stay.
    function resetAllChannels() {
      settingsApi.clearAllChannelScopes();
      hideResetConfirm();
      dispatchSettingsChanged("global");
      render();
      if (!resetLink.hidden) resetLink.focus();
      else saveButton.focus();
    }

    // The scope line is channel-only (see the dialog's kind); only its text is set here.
    function renderScopeLine() {
      scopeLine.textContent = inChannelDialog()
        ? `These settings apply to channel ${channelOfScope(scope)} only. ` +
          "Switch on a setting to give this channel its own value."
        : "";
    }

    // The scope-dependent parts of the dialog, without touching values the user may
    // have changed: notes, inherited entries, locks, scope line and reset link.
    function render() {
      if (inChannelDialog()) settings.forEach(renderChannelNote);
      else settings.forEach(renderGlobalNote);
      refreshInherited();
      refreshControls();
      renderScopeLine();
      renderResetLink();
    }

    // Called at the end of settings.js's loadSettings, once its own loading has
    // put the scope's values and own class colour entries into the dialog. A
    // channel dialog then shows, per setting, the own value or the followed one.
    function load(targetScope) {
      scope = targetScope;
      // The one statement of the dialog's kind; viewer.css derives from it which of
      // the settings-channel-only and settings-global-only elements are displayed.
      dialog.dataset.settingsScope = inChannelDialog() ? "channel" : "global";
      hideResetConfirm();
      if (inChannelDialog()) loadChannelSettings();
      else loadGlobalSettings();
      render();
    }

    // What a channel dialog's Save stores: the switched-on settings of every tab
    // and metadata type, read from their controls whatever their disabled state.
    function collectOwnValues() {
      const ownValues = {};
      settings.forEach((setting) => {
        if (setting.own.input.checked) ownValues[setting.id] = readValue(setting);
      });
      return ownValues;
    }

    function collectOwnObjects() {
      const ownObjects = {};
      objectLists.forEach((objectList) => {
        ownObjects[objectList.metadataType] = readObjectEntries(objectList.metadataType);
      });
      return ownObjects;
    }

    return {
      load,
      refreshControls,
      refreshInherited,
      isChannelDialog: inChannelDialog,
      collectOwnValues,
      collectOwnObjects
    };
  }

  window.viewerSettingsScopeUi = {
    missingRequirements,
    create
  };
})();
