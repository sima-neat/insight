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
  const lineWidthInput = document.getElementById("lineWidthInput");
  const orientationSelector = document.getElementById("orientationSelector");
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
  const poseEstimationSettings = document.getElementById("poseEstimationSettings");
  const classificationSettings = document.getElementById("classificationSettings");
  // Each metadata type's section, shown while that type is selected.
  const metadataTypeSections = {
    "object-detection": objectDetectionSettings,
    segmentation: segmentationSettings,
    tracking: trackingSettings,
    "pose-estimation": poseEstimationSettings,
    classification: classificationSettings
  };
  // Each metadata type's Show Overlay switch, at the top of its section.
  const overlayToggles = {
    "object-detection": document.getElementById("toggleObjectDetectionOverlay"),
    segmentation: document.getElementById("toggleSegmentationOverlay"),
    tracking: document.getElementById("toggleTrackingOverlay"),
    "pose-estimation": document.getElementById("togglePoseEstimationOverlay"),
    classification: document.getElementById("toggleClassificationOverlay")
  };
  const poseKeypointsToggle = document.getElementById("togglePoseKeypoints");
  const poseKeypointLabelsToggle = document.getElementById("togglePoseKeypointLabels");
  const roiToggle = document.getElementById("toggleRoiVisibility");
  const roiFilteringToggle = document.getElementById("toggleRoiFiltering");
  const trackHistoryToggle = document.getElementById("toggleTrackHistory");
  const trackHistoryDependentRows = document.querySelectorAll(".track-history-dependent");
  const blazePose3DPanelToggle = document.getElementById("toggleBlazePose3DPanel");
  const blazePose3DPanelMode = document.getElementById("blazePose3DPanelMode");
  const blazePose3DTransparencySlider = document.getElementById("blazePose3DTransparencySlider");
  const blazePose3DTransparencyDisplay = document.getElementById("blazePose3DTransparencyDisplay");
  const blazePose3DYawSlider = document.getElementById("blazePose3DYawSlider");
  const blazePose3DYawDisplay = document.getElementById("blazePose3DYawDisplay");
  const blazePose3DPitchSlider = document.getElementById("blazePose3DPitchSlider");
  const blazePose3DPitchDisplay = document.getElementById("blazePose3DPitchDisplay");
  const blazePose3DReferenceBoxToggle = document.getElementById("toggleBlazePose3DReferenceBox");
  const blazePose3DDependentRows = document.querySelectorAll(".blazepose-3d-dependent");
  const resetBlazePose3DView = document.getElementById("resetBlazePose3DView");
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
    restoreSavedBlazePose3DSettings();
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
    metadataRetentionInput,
    lineWidthInput
  ].forEach(keepInRange);

  trackHistoryToggle.addEventListener("change", () => {
    updateTrackHistoryControls();
  });

  blazePose3DPanelToggle.addEventListener("change", () => {
    updateBlazePose3DControls();
    previewBlazePose3DSettings();
  });

  blazePose3DPanelMode.addEventListener("change", previewBlazePose3DSettings);

  [blazePose3DYawSlider, blazePose3DPitchSlider, blazePose3DTransparencySlider].forEach((slider) => {
    slider.addEventListener("input", () => {
      updateBlazePose3DDisplays();
      previewBlazePose3DSettings();
    });
  });

  blazePose3DReferenceBoxToggle.addEventListener("change", previewBlazePose3DSettings);

  // Puts the defaults into the 3D Pose controls that can be edited: in a channel
  // dialog only the switched-on ones, since the others show the global value.
  resetBlazePose3DView.addEventListener("click", () => {
    const defaults = settingsApi.defaults.auxiliary["blazepose-3d"];
    if (!blazePose3DPanelToggle.disabled) {
      blazePose3DPanelToggle.checked = defaults.enabled;
      updateBlazePose3DControls();
    }
    const resets = [
      [blazePose3DPanelMode, defaults.panelMode],
      [blazePose3DTransparencySlider, Math.round((defaults.backgroundTransparency ?? 0) * 100)],
      [blazePose3DYawSlider, defaults.yawDegrees],
      [blazePose3DPitchSlider, defaults.pitchDegrees]
    ];
    resets.forEach(([control, value]) => {
      if (!control.disabled) control.value = value;
    });
    if (!blazePose3DReferenceBoxToggle.disabled) blazePose3DReferenceBoxToggle.checked = defaults.showReferenceBox;
    updateBlazePose3DDisplays();
    previewBlazePose3DSettings();
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
    settings.general.lineWidth = parseInt(lineWidthInput.value, 10);
    settings.general.orientation = orientationSelector.value;
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
    settings.types["pose-estimation"].showKeypoints = poseKeypointsToggle.checked;
    settings.types["pose-estimation"].showKeypointLabels = poseKeypointLabelsToggle.checked;
    Object.entries(overlayToggles).forEach(([metadataType, toggle]) => {
      settings.types[metadataType].visible = toggle.checked;
    });
    settings.auxiliary["blazepose-3d"] = blazePose3DDraftSettings();
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
    Object.entries(metadataTypeSections).forEach(([metadataType, section]) => {
      section.style.display = metadataType === selectedType ? "flex" : "none";
    });
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

  function updateBlazePose3DDisplays() {
    blazePose3DTransparencyDisplay.textContent = `${blazePose3DTransparencySlider.value}%`;
    blazePose3DYawDisplay.textContent = `${blazePose3DYawSlider.value}\u00b0`;
    blazePose3DPitchDisplay.textContent = `${blazePose3DPitchSlider.value}\u00b0`;
  }

  function updateBlazePose3DControls() {
    if (scopeUi) {
      // The scope UI also locks controls whose switch is off.
      scopeUi.refreshControls();
      return;
    }
    const enabled = blazePose3DPanelToggle.checked;
    blazePose3DDependentRows.forEach((row) => {
      row.classList.toggle("is-disabled", !enabled);
      row.querySelectorAll("input, select, button").forEach((control) => {
        control.disabled = !enabled;
      });
    });
  }

  function blazePose3DDraftSettings() {
    return {
      enabled: blazePose3DPanelToggle.checked,
      panelMode: blazePose3DPanelMode.value,
      backgroundTransparency: parseInt(blazePose3DTransparencySlider.value, 10) / 100,
      yawDegrees: parseInt(blazePose3DYawSlider.value, 10),
      pitchDegrees: parseInt(blazePose3DPitchSlider.value, 10),
      showReferenceBox: blazePose3DReferenceBoxToggle.checked
    };
  }

  function previewBlazePose3DSettings() {
    window.dispatchEvent(new CustomEvent("viewer-settings-preview", {
      detail: {
        scope,
        auxiliaryRenderer: "blazepose-3d",
        auxiliarySettings: blazePose3DDraftSettings()
      }
    }));
  }

  function restoreSavedBlazePose3DSettings() {
    window.dispatchEvent(new CustomEvent("viewer-settings-changed", {
      detail: { scope, auxiliaryRenderer: "blazepose-3d" }
    }));
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
    const poseTypeSettings = settings.types["pose-estimation"];
    const trackingHistorySettings = trackingTypeSettings.history || settingsApi.defaults.types.tracking.history;
    const blazePose3DSettings = settings.auxiliary["blazepose-3d"]
      || settingsApi.defaults.auxiliary["blazepose-3d"];

    confidenceInput.value = objectDetectionTypeSettings.confidenceThreshold ?? 0;
    segmentationConfidenceInput.value = segmentationTypeSettings.confidenceThreshold ?? 0;
    segmentationOpacityInput.value = segmentationTypeSettings.maskOpacity ?? settingsApi.defaults.types.segmentation.maskOpacity;
    trackingConfidenceInput.value = trackingTypeSettings.confidenceThreshold ?? 0;
    trackTrailLengthInput.value = trackingHistorySettings.trailLength ?? 10;
    lostTrackTtlInput.value = trackingHistorySettings.lostTrackTtlMs ?? 2000;
    videoSyncBufferInput.value = settings.general.videoSyncBufferMs ?? 300;
    metadataRetentionInput.value = settings.general.metadataRetentionMs ?? 0;
    lineWidthInput.value = settings.general.lineWidth ?? settingsApi.defaults.general.lineWidth;
    orientationSelector.value = settings.general.orientation || "none";
    roiToggle.checked = settings.general.showRoi !== false;
    roiFilteringToggle.checked = settings.general.applyRoiFiltering !== false;
    trackHistoryToggle.checked = trackingHistorySettings.enabled !== false;
    poseKeypointsToggle.checked = poseTypeSettings.showKeypoints !== false;
    poseKeypointLabelsToggle.checked = poseTypeSettings.showKeypointLabels === true;
    Object.entries(overlayToggles).forEach(([metadataType, toggle]) => {
      toggle.checked = settings.types[metadataType]?.visible !== false;
    });
    blazePose3DPanelToggle.checked = blazePose3DSettings.enabled !== false;
    blazePose3DPanelMode.value = blazePose3DSettings.panelMode || "compact";
    blazePose3DTransparencySlider.value = Math.round((blazePose3DSettings.backgroundTransparency ?? 0) * 100);
    blazePose3DYawSlider.value = blazePose3DSettings.yawDegrees ?? -45;
    blazePose3DPitchSlider.value = blazePose3DSettings.pitchDegrees ?? 20;
    blazePose3DReferenceBoxToggle.checked = blazePose3DSettings.showReferenceBox !== false;
    updateTrackHistoryControls();
    updateBlazePose3DDisplays();
    updateBlazePose3DControls();
    loadObjectEntries(objectDetectionTypeSettings.objects || settingsApi.defaults.types["object-detection"].objects);
    loadSegmentationEntries(segmentationTypeSettings.objects || settingsApi.defaults.types.segmentation.objects);

    const lastMetadataType = localStorage.getItem("lastViewerMetadataType");
    const supportedType = settingsApi.metadataTypes.some((metadataType) => metadataType.value === lastMetadataType);
    metadataTypeSelector.value = supportedType ? lastMetadataType : "object-detection";
    updateMetadataTypeSection();
    // A channel dialog then shows its own values or the followed ones, per switch.
    if (scopeUi) scopeUi.load(scope);
    updateBlazePose3DDisplays();
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
