// --- metadata-colors.js ---
// One palette and one identity-to-color mapping for every metadata overlay.
// Loaded before drawing.js; exposes window.metadataColors.
(() => {
  // The first 20 are hand-picked to stay apart on dark and bright video; the last 20 are
  // overflow. Keep 40 entries; metadataColors.test.js checks their separation.
  const PALETTE = [
    "#2563eb", "#dc2626", "#16a34a", "#ca8a04", "#9333ea",
    "#0891b2", "#ea580c", "#4f46e5", "#be123c", "#0f766e",
    "#f472b6", "#84cc16", "#fbbf24", "#38bdf8", "#92400e",
    "#d946ef", "#14532d", "#fdba74", "#f43f5e", "#5eead4",
    // Overflow colors, used only when a channel shows more than twenty identities at once.
    // They sit closer together than the first twenty, but still beat repeating a color.
    "#989900", "#ff96d3", "#e1a0fe", "#b6b4ff", "#e2684a",
    "#267d30", "#4d7800", "#e06285", "#78c7fd", "#786900",
    "#bc6ece", "#10d8d8", "#927eec", "#2bdda4", "#66da85",
    "#ab413e", "#5590f3", "#8fd465", "#1899ec", "#b1cc46"
  ];
  const NEUTRAL_COLOR = "#f8fafc";

  function identityKey(identity) {
    if (identity === null || identity === undefined) return null;
    const text = String(identity);
    return text === "" ? null : text;
  }

  // One map per (channel, namespace): identity -> { slot, lastSeen, order }.
  // A new identity takes the lowest free slot. When every slot is taken, the
  // identity seen longest ago is evicted; ties go to the one inserted first.
  // Each map is independent; timestamps on one channel/namespace do not affect eviction on another.
  function createColorAllocator() {
    const maps = new Map();
    let insertCounter = 0;

    function mapFor(channelIndex, namespace) {
      const key = `${channelIndex}:${namespace}`;
      let map = maps.get(key);
      if (!map) {
        map = new Map();
        maps.set(key, map);
      }
      return map;
    }

    function freeSlot(map) {
      const used = new Set();
      map.forEach((entry) => used.add(entry.slot));
      for (let slot = 0; slot < PALETTE.length; slot += 1) {
        if (!used.has(slot)) return slot;
      }
      return -1;
    }

    function evictOldest(map) {
      let oldestKey = null;
      let oldest = null;
      map.forEach((entry, key) => {
        if (
          oldest === null ||
          entry.lastSeen < oldest.lastSeen ||
          (entry.lastSeen === oldest.lastSeen && entry.order < oldest.order)
        ) {
          oldest = entry;
          oldestKey = key;
        }
      });
      map.delete(oldestKey);
      return oldest.slot;
    }

    function colorFor(channelIndex, namespace, identity, now = 0) {
      const key = identityKey(identity);
      if (key === null) return NEUTRAL_COLOR;
      const map = mapFor(channelIndex, namespace);
      const existing = map.get(key);
      if (existing) {
        existing.lastSeen = now;
        return PALETTE[existing.slot];
      }
      let slot = freeSlot(map);
      if (slot < 0) slot = evictOldest(map);
      insertCounter += 1;
      map.set(key, { slot, lastSeen: now, order: insertCounter });
      return PALETTE[slot];
    }

    function clear() {
      maps.clear();
    }

    function size(channelIndex, namespace) {
      const key = `${channelIndex}:${namespace}`;
      const map = maps.get(key);
      return map ? map.size : 0;
    }

    return { colorFor, clear, size };
  }

  // Overrides win, then a `default` override for anything unlisted, then the
  // neutral color for a missing identity, then the allocator.
  function resolveColor({ allocator, channelIndex, namespace, identity, overrides, now }) {
    const key = identityKey(identity);
    if (overrides && typeof overrides === "object") {
      if (key !== null && typeof overrides[key] === "string") return overrides[key];
      if (typeof overrides.default === "string") return overrides.default;
    }
    if (key === null) return NEUTRAL_COLOR;
    return allocator.colorFor(channelIndex, namespace, key, now);
  }

  window.metadataColors = {
    PALETTE,
    NEUTRAL_COLOR,
    createColorAllocator,
    resolveColor
  };
})();
