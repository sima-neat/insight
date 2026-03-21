// roi-manual.js — direct ROI drawing over live video stream

let drawing = false;
let currentPoints = [];
let currentPolygon = null;
let selectedPolygon = null;
let currentScope = "global";
let previewLine = null;


const roiOverlay = document.getElementById("roiOverlay");
const modeSelector = document.getElementById("roiModeSelector");
const startBtn = document.getElementById("startROITool");
const clearBtn = document.getElementById("clearROIs");
const liveVideo = document.getElementById("roiLiveVideo");

function connectToStream(scope = "global") {
  currentScope = scope;
  const pc = new RTCPeerConnection();
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.ontrack = (event) => {
    if (event.track.kind === "video") {
      const stream = new MediaStream();
      stream.addTrack(event.track);
      liveVideo.srcObject = stream;
    }
  };
  pc.createOffer().then(offer => {
    pc.setLocalDescription(offer);
    return fetch(`/offer?channel=${scope}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer)
    });
  }).then(res => res.json()).then(answer => {
    pc.setRemoteDescription(answer);
  });

  liveVideo.onloadedmetadata = () => {
    observeAndResizeOverlay();
  };  
}

window.addEventListener("resize", observeAndResizeOverlay);

function observeAndResizeOverlay() {
  const video = document.getElementById("roiLiveVideo");
  const overlay = document.getElementById("roiOverlay");

  const observer = new IntersectionObserver((entries) => {
    const entry = entries[0];
    if (entry.isIntersecting && video.offsetWidth > 0 && video.offsetHeight > 0) {
      const rect = video.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);

      overlay.setAttribute("width", width);
      overlay.setAttribute("height", height);
      overlay.style.width = width + "px";
      overlay.style.height = height + "px";
      overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);

      observer.disconnect(); // Stop watching once it succeeds
    }
  }, {
    root: null,
    threshold: 0.1
  });

  observer.observe(video);
}


roiOverlay.addEventListener("click", (e) => {
  if (!drawing) return;
  const rect = roiOverlay.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  currentPoints.push({ x, y });

  // At the end of the click handler
  if (!previewLine) {
    previewLine = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    previewLine.setAttribute("stroke-dasharray", "4,4");
    previewLine.setAttribute("stroke", "blue");
    previewLine.setAttribute("fill", "none");
    roiOverlay.appendChild(previewLine);
  }
  previewLine.setAttribute("points", currentPoints.map(p => `${p.x},${p.y}`).join(" "));

  if (currentPolygon) {
    updatePolygon(currentPolygon, currentPoints);
  } else {
    currentPolygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    currentPolygon.classList.add(modeSelector.value);
    currentPolygon.dataset.type = modeSelector.value;
    roiOverlay.appendChild(currentPolygon);
  }

  if (currentPoints.length >= 3 && distance(currentPoints[0], { x, y }) < 10) {
    finalizePolygon();
  }

  // If not clicking on a polygon, clear selection and handles
  if (e.target.nodeName.toLowerCase() !== "polygon") {
    if (selectedPolygon) {
      selectedPolygon.classList.remove("selected");
      selectedPolygon = null;
    }
    removeHandles();
  }
});

roiOverlay.addEventListener("dblclick", (e) => {
  e.preventDefault();

  // If currently drawing, finalize the current polygon
  if (drawing) {
    finalizePolygon();
  }

  // Start a new drawing session if the mode is not "all"
  if (modeSelector.value !== "all") {
    roiOverlay.classList.add("drawing-mode");
    drawing = true;
    currentPoints = [];
    currentPolygon = null;
    roiOverlay.style.pointerEvents = "auto";
  }
});

roiOverlay.addEventListener("mousemove", (e) => {
  if (!drawing || currentPoints.length === 0) return;

  const rect = roiOverlay.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  console.log(x, y)

  const tempPoints = [...currentPoints, { x, y }]; // add mouse cursor position
  if (!previewLine) {
    previewLine = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    previewLine.setAttribute("stroke-dasharray", "4,4");
    previewLine.setAttribute("stroke", "blue");
    previewLine.setAttribute("fill", "none");
    roiOverlay.appendChild(previewLine);
  }
  previewLine.setAttribute("points", tempPoints.map(p => `${p.x},${p.y}`).join(" "));
});


function updatePolygon(polygon, points) {
  polygon.setAttribute("points", points.map(p => `${p.x},${p.y}`).join(" "));
}

function finalizePolygon() {
  if (previewLine) {
    roiOverlay.removeChild(previewLine);
    previewLine = null;
  }

  currentPolygon.style.pointerEvents = "auto";
  addSelectionHandler(currentPolygon);
  currentPolygon = null;
  currentPoints = [];
  drawing = false;
  roiOverlay.style.pointerEvents = "none";
  savePolygons(currentScope);
  roiOverlay.classList.remove("drawing-mode");
}


clearBtn.onclick = () => {
  [...roiOverlay.querySelectorAll("polygon")].forEach(p => roiOverlay.removeChild(p));
  [...roiOverlay.querySelectorAll(".roi-handle")].forEach(h => roiOverlay.removeChild(h));
  selectedPolygon = null;
  localStorage.removeItem(`viewerROI_${currentScope}`);
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Delete" && selectedPolygon) {
    roiOverlay.removeChild(selectedPolygon);
    removeHandles();
    selectedPolygon = null;
    savePolygons(currentScope);
  }

  if (e.key === "Escape" && drawing) {
    drawing = false;
    currentPoints = [];

    if (previewLine) {
      roiOverlay.removeChild(previewLine);
      previewLine = null;
    }

    if (currentPolygon) {
      roiOverlay.removeChild(currentPolygon);
      currentPolygon = null;
    }

    // Clean exit, but allow reactivation if dropdown is not "all"
    roiOverlay.classList.remove("drawing-mode");
    roiOverlay.style.pointerEvents = modeSelector.value !== "all" ? "auto" : "none";
  }

});

function distance(p1, p2) {
  return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
}

function savePolygons(scope) {
  const width = roiOverlay.clientWidth;
  const height = roiOverlay.clientHeight;

  const polygons = [...roiOverlay.querySelectorAll("polygon")]
    .map(p => {
      const raw = p.getAttribute("points");

      // Skip if polygon is missing the 'points' attribute
      if (!raw) {
        console.warn("⚠️ Skipping polygon with no 'points' attribute:", p);
        return null;
      }

      const absPoints = raw.split(" ").map(pt => {
        const [x, y] = pt.split(",").map(Number);
        return {
          x: x / width,
          y: y / height
        };
      });

      return {
        points: absPoints,
        type: p.dataset.type || "inclusion" // fallback to default if undefined
      };
    })
    .filter(Boolean); // Remove any null entries

  localStorage.setItem(`viewerROI_${scope}`, JSON.stringify(polygons));
}


function loadPolygons(scope) {
  const saved = localStorage.getItem(`viewerROI_${scope}`);
  roiOverlay.innerHTML = "";
  if (!saved) return;

  const tryDraw = () => {
    const width = roiOverlay.clientWidth;
    const height = roiOverlay.clientHeight;

    if (width === 0 || height === 0) {
      requestAnimationFrame(tryDraw);
      return;
    }

    roiOverlay.innerHTML = "";

    JSON.parse(saved).forEach(({ points, type }) => {
      const absPoints = points.map(({ x, y }) => ({
        x: x * width,
        y: y * height
      }));

      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", absPoints.map(p => `${p.x},${p.y}`).join(" "));
      polygon.classList.add(type);
      polygon.dataset.type = type;
      polygon.style.pointerEvents = "auto";
      polygon.addEventListener("click", (e) => {
        e.stopPropagation();
        if (selectedPolygon) selectedPolygon.classList.remove("selected");
        selectedPolygon = e.target;
        selectedPolygon.classList.add("selected");
      });
      roiOverlay.appendChild(polygon);
      addSelectionHandler(polygon);
    });
  };

  requestAnimationFrame(tryDraw);
}

window.addEventListener("load", () => {
  connectToStream("0");
  loadPolygons(currentScope);
  modeSelector.dispatchEvent(new Event("change"));
});

modeSelector.addEventListener("change", () => {
  const selectedMode = modeSelector.value;
  const msgEl = document.getElementById("roiModeMessage");

  if (selectedMode === "inclusion") {
    msgEl.textContent = "Only report objects if they overlap with the area.";
  } else if (selectedMode === "exclusion") {
    msgEl.textContent = "Only report objects if they are outside of the area.";
  } else {
    msgEl.textContent = "";
  }

  // Auto-start drawing if valid mode
  if (selectedMode !== "all") {
    drawing = true;
    currentPoints = [];
    currentPolygon = null;
    roiOverlay.style.pointerEvents = "auto";
  } else {
    drawing = false;
    roiOverlay.style.pointerEvents = "none";
  }
});


function addSelectionHandler(polygon) {
  polygon.addEventListener("click", (e) => {
    e.stopPropagation();
    if (selectedPolygon) {
      selectedPolygon.classList.remove("selected");
      removeHandles();
    }
    selectedPolygon = e.target;
    selectedPolygon.classList.add("selected");
    showHandles(selectedPolygon);
  });
}

function showHandles(polygon) {
  const points = polygon.getAttribute("points").split(" ").map(pt => {
    const [x, y] = pt.split(",").map(Number);
    return { x, y };
  });
  points.forEach(({ x, y }) => {
    const handle = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    handle.setAttribute("x", x - 3);
    handle.setAttribute("y", y - 3);
    handle.setAttribute("width", 6);
    handle.setAttribute("height", 6);
    handle.setAttribute("fill", "red");
    handle.classList.add("roi-handle");
    roiOverlay.appendChild(handle);
  });
}

function removeHandles() {
  document.querySelectorAll(".roi-handle").forEach(el => el.remove());
}
