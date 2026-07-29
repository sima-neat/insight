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
  const settingsApi = window.viewerSettingsApi;

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

    settingsApi.writeScopeSettings(scope, settings);
    viewerSettingsOverlay.classList.add("hidden");
    window.dispatchEvent(
      new CustomEvent("viewer-settings-changed", {
        detail: {
          scope,
          metadataType: metadataTypeSelector.value
        }
      })
    );
  });

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
      "Viewer Configuration" + (value === "global" ? " (Global)" : ` (${value})`);
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
    videoSyncBufferSlider.value = settings.general.videoSyncBufferMs ?? 350;
    videoSyncBufferDisplay.textContent = videoSyncBufferSlider.value;
    metadataRetentionSlider.value = settings.general.metadataRetentionMs ?? 0;
    metadataRetentionDisplay.textContent = metadataRetentionSlider.value;
    roiToggle.checked = settings.general.showRoi !== false;
    roiFilteringToggle.checked = settings.general.applyRoiFiltering !== false;
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
