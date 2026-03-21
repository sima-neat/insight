let scope = "global";

document.addEventListener("DOMContentLoaded", () => {
    const viewerSettingsBtn = document.getElementById("viewerSettingsBtn");
    const viewerSettingsOverlay = document.getElementById("viewerSettingsOverlay");
    const viewerSettingsClose = document.getElementById("viewerSettingsClose");
    const saveViewerSettings = document.getElementById("saveViewerSettings");
    const confidenceSlider = document.getElementById("confidenceSlider");
    const metadataDelaySlider = document.getElementById("metadataDelaySlider");
    const confidenceDisplay = document.getElementById("confidenceDisplay");
    const metadataDelayDisplay = document.getElementById("metadataDelayDisplay");
    const tabButtons = document.querySelectorAll(".settings-tab-link");
    const tabSections = document.querySelectorAll(".settings-tab-section");
    const objectList = document.getElementById("viewerObjectList");
    const objectTab = document.getElementById("viewer-objects");
    const addViewerObjectBtn = document.getElementById("addViewerObject");
    const objectTableBody = document.getElementById("viewerObjectTableBody");
  
    viewerSettingsBtn.addEventListener("click", () => {
      openSettingsForScope("global");
    });

    viewerSettingsClose.addEventListener("click", () => {
      viewerSettingsOverlay.classList.add("hidden");
    });
  
    tabButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        tabButtons.forEach(b => b.classList.remove("active"));
        tabSections.forEach(section => section.style.display = "none");
  
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


    const viewerSettingsTitle = document.getElementById("viewerSettingsTitle");
    if (scope === "global") {
      viewerSettingsTitle.textContent += " (Global)";
    }

    saveViewerSettings.addEventListener("click", () => {
        const settings = {
          confidenceThreshold: parseFloat(confidenceSlider.value),
          metadataDelay: parseFloat(metadataDelaySlider.value),
          useGlobal: scope === "global",
          objects: getObjectEntries(),
          showRoi: document.getElementById("toggleRoiVisibility").checked
        };
      
        const storageKey = `viewerSettings_${scope}`;
        localStorage.setItem(storageKey, JSON.stringify(settings));
        viewerSettingsOverlay.classList.add("hidden");
      });
      
    let selectedRow = null;
    
    function scopeToIndex(scope) {
      if (scope === "global") return 0;
      const match = scope.match(/channel_(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    }

    function waitForOverlayVisible(callback) {
      const observer = new IntersectionObserver((entries) => {
        const [entry] = entries;
        if (entry.isIntersecting && entry.target.clientWidth > 0 && entry.target.clientHeight > 0) {
          observer.disconnect();
          callback();
        }
      }, {
        root: null,
        threshold: 0.1
      });

      observer.observe(roiOverlay);
    }    
    

    function openSettingsForScope(targetScope) {
      scope = targetScope;
      localStorage.setItem("lastViewerScope", scope);
      const index = scopeToIndex(scope);
      connectToStream(index.toString());
      updateViewerTitle(scope);
      loadObjectEntries();
      viewerSettingsOverlay.classList.remove("hidden");
      loadPolygons(index);
    }

    function updateViewerTitle(scope) {
      const viewerSettingsTitle = document.getElementById("viewerSettingsTitle");
      viewerSettingsTitle.textContent =
        "Viewer Configuration" + (scope === "global" ? " (Global)" : ` (${scope})`);
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
        <td><button class="delete-entry" title="Delete" style="visibility: hidden;">×</button></td>`;
    
      row.addEventListener("click", () => {
        if (selectedRow && selectedRow !== row) {
          selectedRow.querySelector(".delete-entry").style.visibility = "hidden";
        }
        selectedRow = row;
        row.querySelector(".delete-entry").style.visibility = "visible";
      });
    
      // Prevent blur-before-click issue
      row.querySelector(".delete-entry").addEventListener("mousedown", (e) => {
        e.stopPropagation(); // prevent row deselection
        row.remove();
        if (selectedRow === row) selectedRow = null;
      });
    
      objectTableBody.appendChild(row);
    }
      
    function getObjectEntries() {
      const entries = [];
      objectTableBody.querySelectorAll("tr").forEach(row => {
        const inputs = row.querySelectorAll("input, select");
        if (inputs.length >= 4) {
          entries.push({
            label: inputs[0].value,
            color: inputs[1].value,
            style: inputs[2].value,
            width: parseInt(inputs[3].value)
          });
        }
      });
      return entries;
    }
  
    function loadObjectEntries() {
      const storageKey = `viewerSettings_${scope}`;
      const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");

      // Clear any existing rows
      objectTableBody.innerHTML = "";

      // Load confidence threshold
      confidenceSlider.value = saved.confidenceThreshold ?? 0.5;
      confidenceDisplay.textContent = confidenceSlider.value;
      metadataDelaySlider.value = saved.metadataDelay ?? 0;
      metadataDelayDisplay.textContent = metadataDelaySlider.value;

      // Load object entries
      const objects = saved.objects?.length ? saved.objects : [{ label: "default", color: "#00ff00", style: "solid", width: 1 }];
      objects.forEach(obj => {
        createObjectEntry(obj.label, obj.color, obj.style, obj.width);
      });

      // 🟢 Load ROI visibility toggle (default = true)
      const roiToggle = document.getElementById("toggleRoiVisibility");
      roiToggle.checked = saved.showRoi !== false; // default to true      
    }
  
    addViewerObjectBtn?.addEventListener("click", () => {
      createObjectEntry("", "#ff0000", "solid", 1);
    });
      
    objectTab.style.flexDirection = "column";
    objectList.style.flex = "1";
    objectList.style.overflowY = "auto";
    objectList.style.maxHeight = "280px";
    objectList.style.marginBottom = "1rem";
  
    tabSections.forEach(section => section.style.display = "none");
    const initialTab = document.querySelector(".settings-tab-link.active")?.getAttribute("data-tab");
    if (initialTab) {
      document.getElementById(initialTab).style.display = "flex";
    }
  
    loadObjectEntries();
    window.openSettingsForScope = openSettingsForScope;
    window.loadPolygons = loadPolygons;
  });
  
