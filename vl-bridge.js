// Visual Labeling bridge: forwards postMessage traffic between the
// Stargate opener and any same-origin SDK-enabled frame. See VL_BRIDGE.md.
(function setupVLBridge() {
  var FRAME_SELECTOR = "iframe, frame";
  var MAX_PENDING_MESSAGES = 20;
  var ALLOWED_ORIGIN_HOST_SUFFIX = ".amplitude.com";
  var MESSAGE_EVENT_TYPE = "message";
  var FRAME_LOAD_EVENT_TYPE = "load";
  var UNLOADED_FRAME_URL = "about:blank";
  var OBSERVED_FRAME_ATTRIBUTES = ["src", "srcdoc"];
  var SCAN_DELAY_MS = 0;

  var stargateWin = window.opener;
  if (!stargateWin) return;

  var scanScheduled = false;
  var pending = [];
  var observedDocuments = [];
  var observedFrames = [];
  var readyFrames = [];

  function containsItem(items, item) {
    for (var index = 0; index < items.length; index += 1) {
      if (items[index] === item) return true;
    }

    return false;
  }

  function addUniqueItem(items, item) {
    if (!containsItem(items, item)) {
      items.push(item);
    }
  }

  function removeItem(items, item) {
    for (var index = items.length - 1; index >= 0; index -= 1) {
      if (items[index] === item) {
        items.splice(index, 1);
      }
    }
  }

  function hostnameEndsWith(hostname, suffix) {
    return hostname.slice(hostname.length - suffix.length) === suffix;
  }

  function isAllowedOrigin(origin) {
    try {
      var parser = document.createElement("a");
      parser.href = origin;
      return hostnameEndsWith(parser.hostname, ALLOWED_ORIGIN_HOST_SUFFIX);
    } catch (_) {
      return false;
    }
  }

  // Re-dispatch (don't postMessage) so the original event.origin is
  // preserved — the SDK validates origin and would reject our origin.
  function deliverToFrame(frame, event) {
    var frameWindow = getFrameWindow(frame);
    if (!frameWindow) return false;

    try {
      var relay = new MessageEvent(MESSAGE_EVENT_TYPE, {
        data: event.data,
        origin: event.origin,
        source: stargateWin
      });
      frameWindow.dispatchEvent(relay);
      return true;
    } catch (e) {
      console.warn("[VL bridge] failed to relay message into frame", e);
      return false;
    }
  }

  function wireOpener(frame) {
    var frameWindow = getFrameWindow(frame);
    if (!frameWindow) return;

    try {
      frameWindow.opener = stargateWin;
    } catch (e) {
      console.warn("[VL bridge] could not set frame.contentWindow.opener", e);
    }
  }

  function flushPendingToFrame(frame) {
    if (!containsItem(readyFrames, frame)) return;

    for (var index = 0; index < pending.length; index += 1) {
      var pendingMessage = pending[index];
      if (containsItem(pendingMessage.deliveredFrames, frame)) continue;

      if (deliverToFrame(frame, pendingMessage.event)) {
        addUniqueItem(pendingMessage.deliveredFrames, frame);
      }
    }
  }

  function flushPendingToReadyFrames() {
    var frames = readyFrames.slice();
    for (var index = 0; index < frames.length; index += 1) {
      var frame = frames[index];
      if (!isLoadedFrame(frame)) {
        removeItem(readyFrames, frame);
        continue;
      }

      flushPendingToFrame(frame);
    }
  }

  function queueMessage(event) {
    pending.push({
      event: event,
      deliveredFrames: []
    });

    if (pending.length > MAX_PENDING_MESSAGES) {
      pending.shift();
    }

    flushPendingToReadyFrames();
  }

  function isLoadedFrame(frame) {
    try {
      var hasNavigatingSrc = frame.hasAttribute("src");
      var href = frame.contentWindow && frame.contentWindow.location.href;
      var ready = frame.contentDocument && frame.contentDocument.readyState;

      if (hasNavigatingSrc && href === UNLOADED_FRAME_URL) {
        return false;
      }

      return ready === "complete" || ready === "interactive";
    } catch (_) {
      return false;
    }
  }

  function bridgeFrame(frame) {
    if (!frame) return;

    observeFrame(frame);
    wireOpener(frame);

    if (isLoadedFrame(frame)) {
      addUniqueItem(readyFrames, frame);
      flushPendingToFrame(frame);
    } else {
      removeItem(readyFrames, frame);
    }
  }

  function getFrameDocument(frame) {
    try {
      return frame.contentDocument || frame.contentWindow.document;
    } catch (_) {
      return null;
    }
  }

  function getFrameWindow(frame) {
    try {
      return frame.contentWindow;
    } catch (_) {
      return null;
    }
  }

  function getFrameElements(documentToSearch) {
    return Array.prototype.slice.call(
      documentToSearch.querySelectorAll(FRAME_SELECTOR)
    );
  }

  function observeDocument(documentToObserve) {
    if (!documentToObserve || containsItem(observedDocuments, documentToObserve)) return;
    observedDocuments.push(documentToObserve);

    var root = documentToObserve.documentElement || documentToObserve;
    var observer = new MutationObserver(scheduleScan);
    observer.observe(root, {
      attributes: true,
      attributeFilter: OBSERVED_FRAME_ATTRIBUTES,
      childList: true,
      subtree: true
    });
  }

  function observeFrame(frame) {
    if (!frame || containsItem(observedFrames, frame)) return;
    observedFrames.push(frame);

    frame.addEventListener(FRAME_LOAD_EVENT_TYPE, function () {
      removeItem(readyFrames, frame);
      bridgeFrame(frame);
      scheduleScan();
    });
  }

  function scanFrameTree(frameWindow) {
    var documentToSearch = null;

    try {
      documentToSearch = frameWindow.document;
    } catch (_) {
      return null;
    }

    observeDocument(documentToSearch);

    var frames = getFrameElements(documentToSearch);
    for (var index = 0; index < frames.length; index += 1) {
      bridgeFrame(frames[index]);
    }

    for (var childIndex = 0; childIndex < frames.length; childIndex += 1) {
      var childWindow = getFrameWindow(frames[childIndex]);
      if (!childWindow) continue;

      scanFrameTree(childWindow);
    }
  }

  function scanForFrames() {
    scanScheduled = false;
    scanFrameTree(window);
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    window.setTimeout(scanForFrames, SCAN_DELAY_MS);
  }

  window.addEventListener(MESSAGE_EVENT_TYPE, function (event) {
    // Only forward messages from the Stargate window on Amplitude domains.
    if (event.source !== stargateWin || !isAllowedOrigin(event.origin)) return;
    queueMessage(event);
  });

  // Try to bridge existing frames right now; observers on every same-origin
  // frame document keep rescanning as nested frames appear or navigate.
  scanForFrames();
})();
