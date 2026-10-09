let scope = "global";

document.addEventListener("DOMContentLoaded", () => {
  const viewerSettingsBtn = document.getElementById("viewerSettingsBtn");
  const viewerSettingsOverlay = document.getElementById("viewerSettingsOverlay");
  const viewerSettingsClose = document.getElementById("viewerSettingsClose");
  const saveViewerSettings = document.getElementById("saveViewerSettings");
  const metadataTypeSelector = document.getElementById("metadataTypeSelector");
  const confidenceInput = document.getElementById("confidenceInput");
  const trackingConfidenceInput = document.getElementById("trackingConfidenceInput");
  const trackTrailLengthInput = document.getElementById("trackTrailLengthInput");
  const lostTrackTtlInput = document.getElementById("lostTrackTtlInput");
  const videoSyncBufferInput = document.getElementById("videoSyncBufferInput");
  const metadataRetentionInput = document.getElementById("metadataRetentionInput");
  const tabButtons = document.querySelectorAll(".settings-tab-link");
  const tabSections = document.querySelectorAll(".settings-tab-section");
  const objectList = document.getElementById("viewerObjectList");
  const metadataTab = document.getElementById("viewer-metadata");
  const addViewerObjectBtn = document.getElementById("addViewerObject");
  const objectTableBody = document.getElementById("viewerObjectTableBody");
  const segmentationConfidenceInput = document.getElementById("segmentationConfidenceInput");
  const segmentationOpacityInput = document.getElementById("segmentationOpacityInput");
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
  const settingsApi = window.viewerSettingsApi;

  if (!settingsApi) {
    console.error("viewerSettingsApi is not available");
    return;
  }

  // A browser can pair this script with an older cached settings resolver, an older
  // cached viewer page, or a page that does not load settings-scope.js. Without what
  // the scope UI needs the dialog works as before: no switches or notes, each scope
  // loaded and saved as a whole. Decided once, so no path calls a missing function
  // or touches a missing element.
  const scopeUiModule = window.viewerSettingsScopeUi;
  const scopeUiCauses = [];
  if (!scopeUiModule) {
    scopeUiCauses.push("viewerSettingsScopeUi is not loaded (an older viewer.html or a missing settings-scope.js)");
  } else {
    const missing = scopeUiModule.missingRequirements(settingsApi);
    if (missing.functions.length > 0) {
      scopeUiCauses.push(`viewerSettingsApi lacks ${missing.functions.join(", ")} (an older viewer-settings-resolver.js)`);
    }
    if (missing.elements.length > 0) {
      scopeUiCauses.push(`the page lacks the elements ${missing.elements.join(", ")} (an older viewer.html)`);
    }
  }
  if (scopeUiCauses.length > 0) {
    console.warn(
      `${scopeUiCauses.join("; ")}; the settings dialog cannot give a channel its own value per setting. ` +
        "Reload the page to update it."
    );
  }
  const scopeUi =
    scopeUiCauses.length === 0
      ? scopeUiModule.create({
          settingsApi,
          createObjectEntry: (metadataType, entry) =>
            (metadataType === "segmentation" ? createSegmentationEntry : createObjectEntry)(
              entry.label,
              entry.color,
              entry.style,
              entry.width
            ),
          readObjectEntries: (metadataType) =>
            metadataType === "segmentation" ? getSegmentationEntries() : getObjectEntries(),
          dispatchSettingsChanged
        })
      : null;

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

  [
    confidenceInput,
    segmentationConfidenceInput,
    segmentationOpacityInput,
    trackingConfidenceInput,
    trackTrailLengthInput,
    lostTrackTtlInput,
    videoSyncBufferInput,
    metadataRetentionInput
  ].forEach(keepInRange);

  trackHistoryToggle.addEventListener("change", () => {
    updateTrackHistoryControls();
  });

  metadataTypeSelector.addEventListener("change", () => {
    localStorage.setItem("lastViewerMetadataType", metadataTypeSelector.value);
    updateMetadataTypeSection();
  });

  saveViewerSettings.addEventListener("click", () => {
    if (scopeUi && scopeUi.isChannelDialog()) {
      // A channel stores exactly the settings whose switch is on and its own entries.
      const stored = settingsApi.writeScopeOwnSettings(scope, scopeUi.collectOwnValues(), scopeUi.collectOwnObjects());
      if (!stored) {
        console.error(`The settings of ${scope} could not be stored.`);
        return;
      }
    } else {
      settingsApi.writeScopeSettings(scope, readAllSettings());
    }
    viewerSettingsOverlay.classList.add("hidden");
    dispatchSettingsChanged(scope);
  });

  // The whole scope as the controls show it: what the global dialog stores, and
  // what every dialog stores without the scope UI.
  function readAllSettings() {
    const settings = settingsApi.readScopeSettings(scope);
    settings.general.videoSyncBufferMs = parseInt(videoSyncBufferInput.value, 10);
    settings.general.metadataRetentionMs = parseInt(metadataRetentionInput.value, 10);
    settings.general.showRoi = roiToggle.checked;
    settings.general.applyRoiFiltering = roiFilteringToggle.checked;
    settings.types["object-detection"].confidenceThreshold = parseFloat(confidenceInput.value);
    settings.types["object-detection"].objects = getObjectEntries();
    settings.types.segmentation.confidenceThreshold = parseFloat(segmentationConfidenceInput.value);
    settings.types.segmentation.maskOpacity = parseFloat(segmentationOpacityInput.value);
    settings.types.segmentation.objects = getSegmentationEntries();
    settings.types.tracking.confidenceThreshold = parseFloat(trackingConfidenceInput.value);
    settings.types.tracking.history = {
      enabled: trackHistoryToggle.checked,
      trailLength: parseInt(trackTrailLengthInput.value, 10),
      lostTrackTtlMs: parseInt(lostTrackTtlInput.value, 10)
    };
    return settings;
  }

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

  // A typed value is kept within the spinner's range, whole numbers stay whole, and an
  // empty or unreadable entry goes back to the value the field had before the edit.
  function keepInRange(input) {
    let before = input.value;
    input.addEventListener("focus", () => {
      before = input.value;
    });
    input.addEventListener("change", () => {
      let value = parseFloat(input.value);
      if (!Number.isFinite(value)) {
        input.value = before;
        return;
      }
      if (Number.isInteger(parseFloat(input.step))) value = Math.round(value);
      input.value = String(Math.min(Math.max(value, parseFloat(input.min)), parseFloat(input.max)));
      before = input.value;
    });
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

  function updateTrackHistoryControls() {
    if (scopeUi) {
      // The scope UI also locks controls whose switch is off.
      scopeUi.refreshControls();
      return;
    }
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
      // A deleted own entry can reveal the global entry it overrode.
      if (scopeUi) scopeUi.refreshInherited();
    });

    objectTableBody.appendChild(row);
    return row;
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
      // A deleted own entry can reveal the global entry it overrode.
      if (scopeUi) scopeUi.refreshInherited();
    });

    segmentationObjectTableBody.appendChild(row);
    return row;
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

    confidenceInput.value = objectDetectionTypeSettings.confidenceThreshold ?? 0;
    segmentationConfidenceInput.value = segmentationTypeSettings.confidenceThreshold ?? 0;
    segmentationOpacityInput.value = segmentationTypeSettings.maskOpacity ?? settingsApi.defaults.types.segmentation.maskOpacity;
    trackingConfidenceInput.value = trackingTypeSettings.confidenceThreshold ?? 0;
    trackTrailLengthInput.value = trackingHistorySettings.trailLength ?? 10;
    lostTrackTtlInput.value = trackingHistorySettings.lostTrackTtlMs ?? 2000;
    videoSyncBufferInput.value = settings.general.videoSyncBufferMs ?? 350;
    metadataRetentionInput.value = settings.general.metadataRetentionMs ?? 0;
    roiToggle.checked = settings.general.showRoi !== false;
    roiFilteringToggle.checked = settings.general.applyRoiFiltering !== false;
    trackHistoryToggle.checked = trackingHistorySettings.enabled !== false;
    updateTrackHistoryControls();
    loadObjectEntries(objectDetectionTypeSettings.objects || settingsApi.defaults.types["object-detection"].objects);
    loadSegmentationEntries(segmentationTypeSettings.objects || settingsApi.defaults.types.segmentation.objects);

    const lastMetadataType = localStorage.getItem("lastViewerMetadataType");
    const supportedType = settingsApi.metadataTypes.some((metadataType) => metadataType.value === lastMetadataType);
    metadataTypeSelector.value = supportedType ? lastMetadataType : "object-detection";
    updateMetadataTypeSection();
    // A channel dialog then shows its own values or the followed ones, per switch.
    if (scopeUi) scopeUi.load(scope);
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
