let scope = "global";

document.addEventListener("DOMContentLoaded", () => {
  const viewerSettingsBtn = document.getElementById("viewerSettingsBtn");
  const viewerSettingsOverlay = document.getElementById("viewerSettingsOverlay");
  const viewerSettingsClose = document.getElementById("viewerSettingsClose");
  const saveViewerSettings = document.getElementById("saveViewerSettings");
  const metadataTypeSelector = document.getElementById("metadataTypeSelector");
  const confidenceSlider = document.getElementById("confidenceSlider");
  const trackingConfidenceSlider = document.getElementById("trackingConfidenceSlider");
  const trackTrailLengthSlider = document.getElementById("trackTrailLengthSlider");
  const lostTrackTtlSlider = document.getElementById("lostTrackTtlSlider");
  const videoSyncBufferSlider = document.getElementById("videoSyncBufferSlider");
  const metadataRetentionSlider = document.getElementById("metadataRetentionSlider");
  const confidenceDisplay = document.getElementById("confidenceDisplay");
  const trackingConfidenceDisplay = document.getElementById("trackingConfidenceDisplay");
  const trackTrailLengthDisplay = document.getElementById("trackTrailLengthDisplay");
  const lostTrackTtlDisplay = document.getElementById("lostTrackTtlDisplay");
  const videoSyncBufferDisplay = document.getElementById("videoSyncBufferDisplay");
  const metadataRetentionDisplay = document.getElementById("metadataRetentionDisplay");
  const tabButtons = document.querySelectorAll(".settings-tab-link");
  const tabSections = document.querySelectorAll(".settings-tab-section");
  const objectList = document.getElementById("viewerObjectList");
  const metadataTab = document.getElementById("viewer-metadata");
  const addViewerObjectBtn = document.getElementById("addViewerObject");
  const objectTableBody = document.getElementById("viewerObjectTableBody");
  const segmentationConfidenceSlider = document.getElementById("segmentationConfidenceSlider");
  const segmentationConfidenceDisplay = document.getElementById("segmentationConfidenceDisplay");
  const segmentationOpacitySlider = document.getElementById("segmentationOpacitySlider");
  const segmentationOpacityDisplay = document.getElementById("segmentationOpacityDisplay");
  const segmentationObjectList = document.getElementById("segmentationObjectList");
  const addSegmentationObjectBtn = document.getElementById("addSegmentationObject");
  const segmentationObjectTableBody = document.getElementById("segmentationObjectTableBody");
  const objectDetectionSettings = document.getElementById("objectDetectionSettings");
  const segmentationSettings = document.getElementById("segmentationSettings");
  const trackingSettings = document.getElementById("trackingSettings");
  const metadataNoSettings = document.getElementById("metadataNoSettings");
  const roiToggle = document.getElementById("toggleRoiVisibility");
  const roiFilteringToggle = document.getElementById("toggleRoiFiltering");
  const trackHistoryToggle = document.getElementById("toggleTrackHistory");
  const trackHistoryDependentRows = document.querySelectorAll(".track-history-dependent");
  const viewerSettingsScopeLine = document.getElementById("viewerSettingsScopeLine");
  const settingsApi = window.viewerSettingsApi;
  // Every general key a channel can set itself; the save of a channel dialog decides per key.
  const GENERAL_KEYS = ["videoSyncBufferMs", "metadataRetentionMs", "showRoi", "applyRoiFiltering"];
  // The General tab's settings that show whether a channel sets them itself.
  const SCOPED_GENERAL_SETTINGS = [
    {
      key: "videoSyncBufferMs",
      slider: videoSyncBufferSlider,
      display: videoSyncBufferDisplay,
      tag: document.getElementById("videoSyncBufferScopeTag"),
      noteRow: document.getElementById("videoSyncBufferScopeNoteRow"),
      note: document.getElementById("videoSyncBufferScopeNote")
    },
    {
      key: "metadataRetentionMs",
      slider: metadataRetentionSlider,
      display: metadataRetentionDisplay,
      tag: document.getElementById("metadataRetentionScopeTag"),
      noteRow: document.getElementById("metadataRetentionScopeNoteRow"),
      note: document.getElementById("metadataRetentionScopeNote")
    }
  ];
  // What loadSettings put into the general controls, and which keys the scope set
  // itself at that moment; the channel dialog's save compares against it.
  let loadedGeneral = { values: {}, ownKeys: new Set() };

  if (!settingsApi) {
    console.error("viewerSettingsApi is not available");
    return;
  }

  settingsApi.metadataTypes.forEach((metadataType) => {
    const option = document.createElement("option");
    option.value = metadataType.value;
    option.textContent = metadataType.label;
    metadataTypeSelector.appendChild(option);
  });

  viewerSettingsBtn.addEventListener("click", () => {
    openSettingsForScope("global");
  });

  viewerSettingsClose.addEventListener("click", () => {
    viewerSettingsOverlay.classList.add("hidden");
  });

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabButtons.forEach((tabButton) => tabButton.classList.remove("active"));
      tabSections.forEach((section) => {
        section.style.display = "none";
      });

      btn.classList.add("active");
      const tabId = btn.getAttribute("data-tab");
      document.getElementById(tabId).style.display = "flex";
    });
  });

  confidenceSlider.addEventListener("input", () => {
    confidenceDisplay.textContent = confidenceSlider.value;
  });

  segmentationConfidenceSlider.addEventListener("input", () => {
    segmentationConfidenceDisplay.textContent = segmentationConfidenceSlider.value;
  });

  segmentationOpacitySlider.addEventListener("input", () => {
    segmentationOpacityDisplay.textContent = segmentationOpacitySlider.value;
  });

  trackingConfidenceSlider.addEventListener("input", () => {
    trackingConfidenceDisplay.textContent = trackingConfidenceSlider.value;
  });

  trackTrailLengthSlider.addEventListener("input", () => {
    updateTrackTrailLengthDisplay();
  });

  lostTrackTtlSlider.addEventListener("input", () => {
    updateLostTrackTtlDisplay();
  });

  trackHistoryToggle.addEventListener("change", () => {
    updateTrackHistoryControls();
  });

  videoSyncBufferSlider.addEventListener("input", () => {
    videoSyncBufferDisplay.textContent = videoSyncBufferSlider.value;
  });

  metadataRetentionSlider.addEventListener("input", () => {
    metadataRetentionDisplay.textContent = metadataRetentionSlider.value;
  });

  metadataTypeSelector.addEventListener("change", () => {
    localStorage.setItem("lastViewerMetadataType", metadataTypeSelector.value);
    updateMetadataTypeSection();
  });

  saveViewerSettings.addEventListener("click", () => {
    const settings = settingsApi.readScopeSettings(scope);
    settings.general.videoSyncBufferMs = parseInt(videoSyncBufferSlider.value, 10);
    settings.general.metadataRetentionMs = parseInt(metadataRetentionSlider.value, 10);
    settings.general.showRoi = roiToggle.checked;
    settings.general.applyRoiFiltering = roiFilteringToggle.checked;
    settings.types["object-detection"].confidenceThreshold = parseFloat(confidenceSlider.value);
    settings.types["object-detection"].objects = getObjectEntries();
    settings.types.segmentation.confidenceThreshold = parseFloat(segmentationConfidenceSlider.value);
    settings.types.segmentation.maskOpacity = parseFloat(segmentationOpacitySlider.value);
    settings.types.segmentation.objects = getSegmentationEntries();
    settings.types.tracking.confidenceThreshold = parseFloat(trackingConfidenceSlider.value);
    settings.types.tracking.history = {
      enabled: trackHistoryToggle.checked,
      trailLength: parseInt(trackTrailLengthSlider.value, 10),
      lostTrackTtlMs: parseInt(lostTrackTtlSlider.value, 10)
    };

    if (isChannelScope(scope)) {
      settingsApi.writeScopeSettings(scope, settings, { generalKeys: generalKeysToStore() });
    } else {
      settingsApi.writeScopeSettings(scope, settings);
    }
    viewerSettingsOverlay.classList.add("hidden");
    dispatchSettingsChanged(scope);
  });

  function dispatchSettingsChanged(targetScope) {
    window.dispatchEvent(
      new CustomEvent("viewer-settings-changed", {
        detail: {
          scope: targetScope,
          metadataType: metadataTypeSelector.value
        }
      })
    );
  }

  function isChannelScope(value) {
    return value !== "global";
  }

  function formatMs(value) {
    return `${value} ms`;
  }

  // What a channel follows for a general key when it has no value of its own.
  function followedGeneralValue(key) {
    const globalOwn = settingsApi.readScopeOverrides("global").general;
    return Object.prototype.hasOwnProperty.call(globalOwn, key) ? globalOwn[key] : settingsApi.defaults.general[key];
  }

  function readGeneralControls() {
    return {
      videoSyncBufferMs: parseInt(videoSyncBufferSlider.value, 10),
      metadataRetentionMs: parseInt(metadataRetentionSlider.value, 10),
      showRoi: roiToggle.checked,
      applyRoiFiltering: roiFilteringToggle.checked
    };
  }

  // A channel keeps a general key as its own if it had one at load, or if the
  // control now holds something else than the dialog put there.
  function generalKeysToStore() {
    const current = readGeneralControls();
    return GENERAL_KEYS.filter(
      (key) => loadedGeneral.ownKeys.has(key) || current[key] !== loadedGeneral.values[key]
    );
  }

  function setSliderValue(setting, value) {
    setting.slider.value = value;
    setting.display.textContent = setting.slider.value;
  }

  function createUseGlobalButton(onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-scope-link";
    button.textContent = "Use global value";
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

  function renderChannelSettingScope(setting, ownGeneral) {
    const isOwn = Object.prototype.hasOwnProperty.call(ownGeneral, setting.key);
    setting.tag.textContent = isOwn ? "own value" : "global";
    setting.tag.classList.toggle("settings-scope-tag--own", isOwn);
    setting.tag.classList.toggle("settings-scope-tag--global", !isOwn);
    setting.tag.hidden = false;
    setting.note.replaceChildren();
    if (isOwn) {
      setting.note.appendChild(
        createNoteLine(
          `Global value: ${formatMs(followedGeneralValue(setting.key))}.`,
          createUseGlobalButton(() => useGlobalValueInChannelDialog(setting))
        )
      );
    }
    setting.noteRow.hidden = !isOwn;
  }

  function renderGlobalSettingScope(setting) {
    const overrides = settingsApi.listChannelGeneralOverrides(setting.key);
    setting.tag.hidden = true;
    setting.note.replaceChildren();
    if (overrides.length === 0) {
      setting.noteRow.hidden = true;
      return;
    }
    const box = document.createElement("div");
    box.className = "settings-scope-note--info";
    overrides.forEach(({ channel, value }) => {
      box.appendChild(
        createNoteLine(
          `Channel ${channel} uses its own value: ${formatMs(value)}.`,
          createUseGlobalButton(() => useGlobalValueForChannel(channel, setting.key))
        )
      );
    });
    box.appendChild(
      createNoteLine(overrides.length === 1 ? "Changes here do not affect it." : "Changes here do not affect them.")
    );
    setting.note.appendChild(box);
    setting.noteRow.hidden = false;
  }

  function renderGeneralScopeNotes() {
    if (isChannelScope(scope)) {
      const ownGeneral = settingsApi.readScopeOverrides(scope).general;
      SCOPED_GENERAL_SETTINGS.forEach((setting) => renderChannelSettingScope(setting, ownGeneral));
    } else {
      SCOPED_GENERAL_SETTINGS.forEach(renderGlobalSettingScope);
    }
  }

  // "Use global value" in a channel dialog: takes effect at once, without Save.
  function useGlobalValueInChannelDialog(setting) {
    if (!settingsApi.clearScopeGeneralOverride(scope, setting.key)) return;
    dispatchSettingsChanged(scope);
    setSliderValue(setting, followedGeneralValue(setting.key));
    loadedGeneral.ownKeys.delete(setting.key);
    loadedGeneral.values[setting.key] = parseInt(setting.slider.value, 10);
    renderGeneralScopeNotes();
  }

  // "Use global value" in the global dialog: one channel goes back to the global value.
  function useGlobalValueForChannel(channel, key) {
    const channelScope = `channel_${channel}`;
    if (!settingsApi.clearScopeGeneralOverride(channelScope, key)) return;
    dispatchSettingsChanged(channelScope);
    renderGeneralScopeNotes();
  }

  // Fills the General tab: a channel dialog shows what the channel resolves to
  // (own, else global, else default), the global dialog the global values.
  function loadGeneralSettings() {
    let general;
    let ownGeneral = {};
    if (isChannelScope(scope)) {
      general = settingsApi.resolveTypeSettings(scopeToIndex(scope), metadataTypeSelector.value).general;
      ownGeneral = settingsApi.readScopeOverrides(scope).general;
    } else {
      general = settingsApi.readScopeSettings(scope).general;
    }
    setSliderValue(SCOPED_GENERAL_SETTINGS[0], general.videoSyncBufferMs ?? 350);
    setSliderValue(SCOPED_GENERAL_SETTINGS[1], general.metadataRetentionMs ?? 0);
    roiToggle.checked = general.showRoi !== false;
    roiFilteringToggle.checked = general.applyRoiFiltering !== false;
    loadedGeneral = {
      values: readGeneralControls(),
      ownKeys: new Set(GENERAL_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(ownGeneral, key)))
    };
    renderGeneralScopeNotes();
  }

  function updateScopeLine(value) {
    if (isChannelScope(value)) {
      viewerSettingsScopeLine.textContent =
        `These settings apply to channel ${scopeToIndex(value)} only. ` +
        "Values you have not changed follow the global settings.";
      viewerSettingsScopeLine.hidden = false;
    } else {
      viewerSettingsScopeLine.textContent = "";
      viewerSettingsScopeLine.hidden = true;
    }
  }

  let selectedRow = null;

  function scopeToIndex(value) {
    if (value === "global") return 0;
    const match = value.match(/channel_(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  function openSettingsForScope(targetScope) {
    scope = targetScope;
    localStorage.setItem("lastViewerScope", scope);
    const index = scopeToIndex(scope);
    connectToStream(index.toString());
    updateViewerTitle(scope);
    updateScopeLine(scope);
    loadSettings();
    viewerSettingsOverlay.classList.remove("hidden");
    loadPolygons(index);
  }

  function updateViewerTitle(value) {
    const viewerSettingsTitle = document.getElementById("viewerSettingsTitle");
    viewerSettingsTitle.textContent =
      "Viewer Configuration" + (value === "global" ? " (Global)" : ` (Channel ${scopeToIndex(value)})`);
  }

  function updateMetadataTypeSection() {
    const selectedType = metadataTypeSelector.value;
    objectDetectionSettings.style.display = selectedType === "object-detection" ? "flex" : "none";
    segmentationSettings.style.display = selectedType === "segmentation" ? "flex" : "none";
    trackingSettings.style.display = selectedType === "tracking" ? "flex" : "none";
    metadataNoSettings.style.display =
      selectedType !== "object-detection" && selectedType !== "segmentation" && selectedType !== "tracking" ? "flex" : "none";
  }

  function updateTrackTrailLengthDisplay() {
    const value = parseInt(trackTrailLengthSlider.value, 10);
    trackTrailLengthDisplay.textContent = `${Number.isFinite(value) ? value : 10} positions`;
  }

  function updateLostTrackTtlDisplay() {
    const value = parseInt(lostTrackTtlSlider.value, 10);
    const seconds = Number.isFinite(value) ? (value / 1000).toFixed(1) : "2.0";
    lostTrackTtlDisplay.textContent = `${seconds} s`;
  }

  function updateTrackHistoryControls() {
    const enabled = trackHistoryToggle.checked;
    trackHistoryDependentRows.forEach((row) => {
      row.classList.toggle("is-disabled", !enabled);
      row.querySelectorAll("input, select, button").forEach((control) => {
        control.disabled = !enabled;
      });
    });
  }

  function createObjectEntry(label, color, lineStyle, lineWidth) {
    const row = document.createElement("tr");

    row.innerHTML = `<td><input type="text" placeholder="enter new object name" value="${label}" /></td>
      <td><input type="color" value="${color}" /></td>
      <td>
        <select>
          <option value="solid" ${lineStyle === "solid" ? "selected" : ""}>Solid</option>
          <option value="dashed" ${lineStyle === "dashed" ? "selected" : ""}>Dashed</option>
          <option value="dotted" ${lineStyle === "dotted" ? "selected" : ""}>Dotted</option>
        </select>
      </td>
      <td>
        <select>
          <option value="1" ${lineWidth == 1 ? "selected" : ""}>Thin</option>
          <option value="3" ${lineWidth == 3 ? "selected" : ""}>Thick</option>
        </select>
      </td>
      <td><button class="delete-entry" title="Delete" style="visibility: hidden;">&times;</button></td>`;

    row.addEventListener("click", () => {
      if (selectedRow && selectedRow !== row) {
        selectedRow.querySelector(".delete-entry").style.visibility = "hidden";
      }
      selectedRow = row;
      row.querySelector(".delete-entry").style.visibility = "visible";
    });

    row.querySelector(".delete-entry").addEventListener("mousedown", (event) => {
      event.stopPropagation();
      row.remove();
      if (selectedRow === row) selectedRow = null;
    });

    objectTableBody.appendChild(row);
  }

  function getObjectEntries() {
    const entries = [];
    objectTableBody.querySelectorAll("tr").forEach((row) => {
      const inputs = row.querySelectorAll("input, select");
      if (inputs.length >= 4) {
        entries.push({
          label: inputs[0].value,
          color: inputs[1].value,
          style: inputs[2].value,
          width: parseInt(inputs[3].value, 10)
        });
      }
    });
    return entries;
  }

  function loadObjectEntries(objects) {
    objectTableBody.innerHTML = "";
    objects.forEach((obj) => {
      createObjectEntry(obj.label, obj.color, obj.style, obj.width);
    });
  }

  function createSegmentationEntry(label, color, lineStyle, lineWidth) {
    const row = document.createElement("tr");

    row.innerHTML = `<td><input type="text" placeholder="enter new object name" value="${label}" /></td>
      <td><input type="color" value="${color}" /></td>
      <td>
        <select>
          <option value="solid" ${lineStyle === "solid" ? "selected" : ""}>Solid</option>
          <option value="dashed" ${lineStyle === "dashed" ? "selected" : ""}>Dashed</option>
          <option value="dotted" ${lineStyle === "dotted" ? "selected" : ""}>Dotted</option>
        </select>
      </td>
      <td>
        <select>
          <option value="1" ${lineWidth == 1 ? "selected" : ""}>Thin</option>
          <option value="3" ${lineWidth == 3 ? "selected" : ""}>Thick</option>
        </select>
      </td>
      <td><button class="delete-entry" title="Delete" style="visibility: hidden;">&times;</button></td>`;

    row.addEventListener("click", () => {
      if (selectedRow && selectedRow !== row) {
        selectedRow.querySelector(".delete-entry").style.visibility = "hidden";
      }
      selectedRow = row;
      row.querySelector(".delete-entry").style.visibility = "visible";
    });

    row.querySelector(".delete-entry").addEventListener("mousedown", (event) => {
      event.stopPropagation();
      row.remove();
      if (selectedRow === row) selectedRow = null;
    });

    segmentationObjectTableBody.appendChild(row);
  }

  function getSegmentationEntries() {
    const entries = [];
    segmentationObjectTableBody.querySelectorAll("tr").forEach((row) => {
      const inputs = row.querySelectorAll("input, select");
      if (inputs.length >= 4) {
        entries.push({
          label: inputs[0].value,
          color: inputs[1].value,
          style: inputs[2].value,
          width: parseInt(inputs[3].value, 10)
        });
      }
    });
    return entries;
  }

  function loadSegmentationEntries(objects) {
    segmentationObjectTableBody.innerHTML = "";
    objects.forEach((obj) => {
      createSegmentationEntry(obj.label, obj.color, obj.style, obj.width);
    });
  }

  function loadSettings() {
    const settings = settingsApi.readScopeSettings(scope);
    const objectDetectionTypeSettings = settings.types["object-detection"];
    const segmentationTypeSettings = settings.types.segmentation;
    const trackingTypeSettings = settings.types.tracking;
    const trackingHistorySettings = trackingTypeSettings.history || settingsApi.defaults.types.tracking.history;

    confidenceSlider.value = objectDetectionTypeSettings.confidenceThreshold ?? 0;
    confidenceDisplay.textContent = confidenceSlider.value;
    segmentationConfidenceSlider.value = segmentationTypeSettings.confidenceThreshold ?? 0;
    segmentationConfidenceDisplay.textContent = segmentationConfidenceSlider.value;
    segmentationOpacitySlider.value = segmentationTypeSettings.maskOpacity ?? settingsApi.defaults.types.segmentation.maskOpacity;
    segmentationOpacityDisplay.textContent = segmentationOpacitySlider.value;
    trackingConfidenceSlider.value = trackingTypeSettings.confidenceThreshold ?? 0;
    trackingConfidenceDisplay.textContent = trackingConfidenceSlider.value;
    trackTrailLengthSlider.value = trackingHistorySettings.trailLength ?? 10;
    lostTrackTtlSlider.value = trackingHistorySettings.lostTrackTtlMs ?? 2000;
    loadGeneralSettings();
    trackHistoryToggle.checked = trackingHistorySettings.enabled !== false;
    updateTrackTrailLengthDisplay();
    updateLostTrackTtlDisplay();
    updateTrackHistoryControls();
    loadObjectEntries(objectDetectionTypeSettings.objects || settingsApi.defaults.types["object-detection"].objects);
    loadSegmentationEntries(segmentationTypeSettings.objects || settingsApi.defaults.types.segmentation.objects);

    const lastMetadataType = localStorage.getItem("lastViewerMetadataType");
    const supportedType = settingsApi.metadataTypes.some((metadataType) => metadataType.value === lastMetadataType);
    metadataTypeSelector.value = supportedType ? lastMetadataType : "object-detection";
    updateMetadataTypeSection();
  }

  addViewerObjectBtn?.addEventListener("click", () => {
    createObjectEntry("", "#ff0000", "solid", 1);
  });

  addSegmentationObjectBtn?.addEventListener("click", () => {
    createSegmentationEntry("", "#ff0000", "solid", 1);
  });

  metadataTab.style.flexDirection = "column";
  objectList.style.flex = "1";
  objectList.style.overflowY = "auto";
  objectList.style.maxHeight = "280px";
  objectList.style.marginBottom = "1rem";
  segmentationObjectList.style.flex = "1";
  segmentationObjectList.style.overflowY = "auto";
  segmentationObjectList.style.maxHeight = "280px";
  segmentationObjectList.style.marginBottom = "1rem";

  tabSections.forEach((section) => {
    section.style.display = "none";
  });
  const initialTab = document.querySelector(".settings-tab-link.active")?.getAttribute("data-tab");
  if (initialTab) {
    document.getElementById(initialTab).style.display = "flex";
  }

  loadSettings();
  window.openSettingsForScope = openSettingsForScope;
  window.loadPolygons = loadPolygons;
});
