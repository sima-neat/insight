let scope = "global";

document.addEventListener("DOMContentLoaded", () => {
  const viewerSettingsBtn = document.getElementById("viewerSettingsBtn");
  const viewerSettingsOverlay = document.getElementById("viewerSettingsOverlay");
  const viewerSettingsClose = document.getElementById("viewerSettingsClose");
  const saveViewerSettings = document.getElementById("saveViewerSettings");
  const metadataTypeSelector = document.getElementById("metadataTypeSelector");
  const confidenceSlider = document.getElementById("confidenceSlider");
  const metadataDelaySlider = document.getElementById("metadataDelaySlider");
  const confidenceDisplay = document.getElementById("confidenceDisplay");
  const metadataDelayDisplay = document.getElementById("metadataDelayDisplay");
  const tabButtons = document.querySelectorAll(".settings-tab-link");
  const tabSections = document.querySelectorAll(".settings-tab-section");
  const objectList = document.getElementById("viewerObjectList");
  const metadataTab = document.getElementById("viewer-metadata");
  const addViewerObjectBtn = document.getElementById("addViewerObject");
  const objectTableBody = document.getElementById("viewerObjectTableBody");
  const objectDetectionSettings = document.getElementById("objectDetectionSettings");
  const trackingSettings = document.getElementById("trackingSettings");
  const metadataNoSettings = document.getElementById("metadataNoSettings");
  const roiToggle = document.getElementById("toggleRoiVisibility");
  const trackHistoryToggle = document.getElementById("toggleTrackHistory");
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

  metadataDelaySlider.addEventListener("input", () => {
    metadataDelayDisplay.textContent = metadataDelaySlider.value;
  });

  metadataTypeSelector.addEventListener("change", () => {
    localStorage.setItem("lastViewerMetadataType", metadataTypeSelector.value);
    updateMetadataTypeSection();
  });

  saveViewerSettings.addEventListener("click", () => {
    const settings = settingsApi.readScopeSettings(scope);
    settings.general.metadataDelay = parseFloat(metadataDelaySlider.value);
    settings.general.showRoi = roiToggle.checked;
    settings.types["object-detection"].confidenceThreshold = parseFloat(confidenceSlider.value);
    settings.types["object-detection"].objects = getObjectEntries();
    settings.types.tracking.showTrackHistory = trackHistoryToggle.checked;

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
    trackingSettings.style.display = selectedType === "tracking" ? "flex" : "none";
    metadataNoSettings.style.display =
      selectedType !== "object-detection" && selectedType !== "tracking" ? "flex" : "none";
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

  function loadSettings() {
    const settings = settingsApi.readScopeSettings(scope);
    const objectDetectionTypeSettings = settings.types["object-detection"];
    const trackingTypeSettings = settings.types.tracking;

    confidenceSlider.value = objectDetectionTypeSettings.confidenceThreshold ?? 0;
    confidenceDisplay.textContent = confidenceSlider.value;
    metadataDelaySlider.value = settings.general.metadataDelay ?? 0;
    metadataDelayDisplay.textContent = metadataDelaySlider.value;
    roiToggle.checked = settings.general.showRoi !== false;
    trackHistoryToggle.checked = trackingTypeSettings.showTrackHistory !== false;
    loadObjectEntries(objectDetectionTypeSettings.objects || settingsApi.defaults.types["object-detection"].objects);

    const lastMetadataType = localStorage.getItem("lastViewerMetadataType");
    const supportedType = settingsApi.metadataTypes.some((metadataType) => metadataType.value === lastMetadataType);
    metadataTypeSelector.value = supportedType ? lastMetadataType : "object-detection";
    updateMetadataTypeSection();
  }

  addViewerObjectBtn?.addEventListener("click", () => {
    createObjectEntry("", "#ff0000", "solid", 1);
  });

  metadataTab.style.flexDirection = "column";
  objectList.style.flex = "1";
  objectList.style.overflowY = "auto";
  objectList.style.maxHeight = "280px";
  objectList.style.marginBottom = "1rem";

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
