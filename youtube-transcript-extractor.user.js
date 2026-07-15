// ==UserScript==
// @name         YouTube Transcript Extractor
// @namespace    https://github.com/kahkiit
// @version      0.1.0
// @description  Extract YouTube transcript text from the modern get_panel payload on watch pages.
// @author       Codex
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  "use strict";

  const PAGE_WINDOW = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const ROOT_ID = "yt-transcript-extractor-root";
  const BUTTON_ID = "yt-transcript-extractor-button";
  const PANEL_ID = "yt-transcript-extractor-panel";
  const Z_INDEX = 2147483647;

  const state = {
    pageVideoId: null,
    lastResult: null,
    isLoading: false,
    watchPageSnapshot: null,
  };

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function createElement(tagName, options = {}) {
    const element = document.createElement(tagName);

    if (options.id) {
      element.id = options.id;
    }

    if (options.className) {
      element.className = options.className;
    }

    if (options.text) {
      element.textContent = options.text;
    }

    if (options.htmlFor) {
      element.htmlFor = options.htmlFor;
    }

    if (options.dataset) {
      for (const [key, value] of Object.entries(options.dataset)) {
        element.dataset[key] = value;
      }
    }

    if (options.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) {
        element.setAttribute(key, value);
      }
    }

    return element;
  }

  function deepClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function getVideoId() {
    try {
      return new URL(window.location.href).searchParams.get("v");
    } catch (_error) {
      return null;
    }
  }

  function isWatchPage() {
    return window.location.pathname === "/watch" && Boolean(getVideoId());
  }

  function sanitizeFilename(value) {
    return (value || "youtube-transcript")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }

  function formatTimestampFromSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "";
    }

    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    if (hours > 0) {
      return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
    }

    return [minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
  }

  function formatTranscriptLines(segments, withTimestamps) {
    return segments
      .map((segment) => {
        if (!segment.text) {
          return "";
        }

        if (!withTimestamps) {
          return segment.text;
        }

        const timestamp = segment.timestamp || formatTimestampFromSeconds(segment.startTimeSeconds);
        return timestamp ? `[${timestamp}] ${segment.text}` : segment.text;
      })
      .filter(Boolean)
      .join("\n");
  }

  function findFirst(root, predicate) {
    const seen = new WeakSet();

    function visit(value) {
      if (!value || typeof value !== "object") {
        return null;
      }

      if (seen.has(value)) {
        return null;
      }
      seen.add(value);

      if (predicate(value)) {
        return value;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          const match = visit(item);
          if (match) {
            return match;
          }
        }
        return null;
      }

      for (const item of Object.values(value)) {
        const match = visit(item);
        if (match) {
          return match;
        }
      }

      return null;
    }

    return visit(root);
  }

  function getYtcfgData() {
    return PAGE_WINDOW.ytcfg?.data_ || PAGE_WINDOW.yt?.config_ || {};
  }

  function getWatchFlexy() {
    return document.querySelector("ytd-watch-flexy");
  }

  function getYtdApp() {
    return document.querySelector("ytd-app");
  }

  function getCurrentPlayerResponse() {
    if (typeof PAGE_WINDOW.movie_player?.getPlayerResponse === "function") {
      const playerResponse = PAGE_WINDOW.movie_player.getPlayerResponse();
      if (playerResponse) {
        return playerResponse;
      }
    }

    const flexy = getWatchFlexy();
    if (flexy?.playerData) {
      return flexy.playerData;
    }

    if (flexy?.data?.playerResponse) {
      return flexy.data.playerResponse;
    }

    if (getYtdApp()?.data?.playerResponse) {
      return getYtdApp().data.playerResponse;
    }

    return PAGE_WINDOW.ytInitialPlayerResponse || null;
  }

  function getCurrentRuntimeVideoId() {
    const fromPlayer = PAGE_WINDOW.movie_player?.getVideoData?.().video_id;
    if (fromPlayer) {
      return fromPlayer;
    }

    const flexy = getWatchFlexy();
    const fromFlexyAttr = flexy?.getAttribute("video-id");
    if (fromFlexyAttr) {
      return fromFlexyAttr;
    }

    const fromFlexyData =
      flexy?.data?.currentVideoEndpoint?.watchEndpoint?.videoId ||
      flexy?.data?.response?.currentVideoEndpoint?.watchEndpoint?.videoId;
    if (fromFlexyData) {
      return fromFlexyData;
    }

    const appData = getYtdApp()?.data;
    const fromAppData =
      appData?.response?.currentVideoEndpoint?.watchEndpoint?.videoId ||
      appData?.currentVideoEndpoint?.watchEndpoint?.videoId;
    if (fromAppData) {
      return fromAppData;
    }

    return getVideoId();
  }

  function getFreshDataRoots() {
    const flexy = getWatchFlexy();
    const appData = getYtdApp()?.data;

    return [
      flexy?.data,
      flexy?.data?.response,
      appData?.response,
      appData,
      PAGE_WINDOW.ytInitialData,
    ].filter(Boolean);
  }

  function extractBalancedObject(source, startIndex) {
    let index = startIndex;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return source.slice(startIndex, index + 1);
        }
      }
    }

    return null;
  }

  function parseJsonObjectFromHtml(source, markers) {
    for (const marker of markers) {
      const markerIndex = source.indexOf(marker);
      if (markerIndex < 0) {
        continue;
      }

      const objectStart = markerIndex + marker.length;
      const objectText = extractBalancedObject(source, objectStart);
      if (!objectText) {
        continue;
      }

      try {
        return JSON.parse(objectText);
      } catch (_error) {
        // Try next marker.
      }
    }

    return null;
  }

  async function getWatchPageSnapshot(forceRefresh = false) {
    const currentUrl = window.location.href;
    if (!forceRefresh && state.watchPageSnapshot?.url === currentUrl) {
      return state.watchPageSnapshot;
    }

    const response = await PAGE_WINDOW.fetch(currentUrl, {
      method: "GET",
      credentials: "same-origin",
    });

    if (!response.ok) {
      throw new Error(`拉取当前 watch 页面失败: ${response.status}`);
    }

    const html = await response.text();
    const ytcfg = parseJsonObjectFromHtml(html, ["ytcfg.set({"]);
    const ytInitialData = parseJsonObjectFromHtml(html, ["var ytInitialData = ", "ytInitialData = "]);
    const ytInitialPlayerResponse = parseJsonObjectFromHtml(html, [
      "var ytInitialPlayerResponse = ",
      "ytInitialPlayerResponse = ",
    ]);

    const snapshot = {
      url: currentUrl,
      html,
      ytcfg,
      ytInitialData,
      ytInitialPlayerResponse,
    };

    state.watchPageSnapshot = snapshot;
    return snapshot;
  }

  function decodeBase64UrlToText(value) {
    if (!value) {
      return "";
    }

    try {
      const normalized = decodeURIComponent(value).replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
      return atob(padded);
    } catch (_error) {
      return "";
    }
  }

  function extractVideoIdFromTranscriptParams(params) {
    const decoded = decodeBase64UrlToText(params);
    const match = decoded.match(/[A-Za-z0-9_-]{11}/);
    return match ? match[0] : null;
  }

  function getModernTranscriptPayload(expectedVideoId, customRoots = null) {
    const dataRoots = customRoots || getFreshDataRoots();
    if (!dataRoots.length) {
      throw new Error("页面 transcript 数据源还没准备好。");
    }

    const commandNodes = [];
    for (const root of dataRoots) {
      findFirst(root, (node) => {
        const command = node?.updateEngagementPanelContentCommand;
        if (command?.contentSourcePanelIdentifier?.tag === "PAmodern_transcript_view") {
          commandNodes.push(node);
        }
        return false;
      });
    }

    const candidates = commandNodes
      .map((node) => {
        const command = node?.updateEngagementPanelContentCommand;
        const panelId = command?.contentSourcePanelIdentifier?.tag;
        const params = command?.globalConfiguration?.params;
        const videoId = extractVideoIdFromTranscriptParams(params);
        return { panelId, params, videoId };
      })
      .filter((candidate) => candidate.panelId && candidate.params);

    if (!candidates.length) {
      throw new Error("没找到 modern transcript 的 panel payload。这个视频可能没有可用转录。");
    }

    if (expectedVideoId) {
      const exactMatch = candidates.find((candidate) => candidate.videoId === expectedVideoId);
      if (exactMatch) {
        return exactMatch;
      }
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    const candidateSummary = candidates.map((candidate) => candidate.videoId || "unknown").join(", ");
    throw new Error(`找到了 transcript payload，但和当前视频对不上。候选 videoId: ${candidateSummary}`);
  }

  function getInnertubeRequestConfig(overrideYtcfgData = null) {
    const ytcfgData = overrideYtcfgData || getYtcfgData();
    const apiKey = ytcfgData.INNERTUBE_API_KEY;
    const clientName = String(ytcfgData.INNERTUBE_CONTEXT_CLIENT_NAME || 1);
    const clientVersion = ytcfgData.INNERTUBE_CONTEXT_CLIENT_VERSION || ytcfgData.INNERTUBE_CLIENT_VERSION;
    const visitorData = ytcfgData.VISITOR_DATA;
    const context = deepClone(ytcfgData.INNERTUBE_CONTEXT);
    const currentUrl = window.location.href;

    if (!apiKey || !clientVersion || !context) {
      throw new Error("没拿到 YouTube Innertube 配置，页面上下文不完整。");
    }

    context.client = context.client || {};
    context.client.originalUrl = currentUrl;

    const runtimeVideoId = getCurrentRuntimeVideoId();
    if (runtimeVideoId) {
      context.client.mainAppWebInfo = {
        ...(context.client.mainAppWebInfo || {}),
        graftUrl: currentUrl,
      };
    }

    return { apiKey, clientName, clientVersion, visitorData, context };
  }

  function extractSegmentsFromPanelResponse(payload) {
    const segments = [];
    const seen = new Set();

    function pushSegment(segment) {
      const text = (segment.text || "").replace(/\s+/g, " ").trim();
      if (!text) {
        return;
      }

      const normalized = {
        text,
        timestamp: segment.timestamp || "",
        startTimeSeconds: Number.isFinite(segment.startTimeSeconds) ? segment.startTimeSeconds : null,
      };

      const key = `${normalized.startTimeSeconds ?? ""}|${normalized.timestamp}|${normalized.text}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      segments.push(normalized);
    }

    findFirst(payload, (node) => {
      const marker = node?.macroMarkersPanelItemViewModel;
      if (!marker) {
        return false;
      }

      const item = marker.item?.timelineItemViewModel;
      const contentItems = item?.contentItems || [];
      const textParts = [];
      let fallbackTimestamp = item?.timestamp || "";

      for (const contentItem of contentItems) {
        const segmentView = contentItem?.transcriptSegmentViewModel;
        if (!segmentView?.simpleText) {
          continue;
        }

        if (!fallbackTimestamp && segmentView.timestamp) {
          fallbackTimestamp = segmentView.timestamp;
        }

        textParts.push(segmentView.simpleText);
      }

      pushSegment({
        text: textParts.join(" ").trim(),
        timestamp: fallbackTimestamp,
        startTimeSeconds: marker.onTap?.innertubeCommand?.watchEndpoint?.startTimeSeconds ?? null,
      });

      return false;
    });

    return segments;
  }

  async function fetchTranscriptViaGetPanel(expectedVideoId) {
    let requestConfig = getInnertubeRequestConfig();
    let transcriptPayload = null;

    try {
      transcriptPayload = getModernTranscriptPayload(expectedVideoId);
    } catch (_liveError) {
      const snapshot = await getWatchPageSnapshot(true);
      requestConfig = getInnertubeRequestConfig(snapshot.ytcfg || null);
      transcriptPayload = getModernTranscriptPayload(expectedVideoId, [snapshot.ytInitialData].filter(Boolean));
    }

    const response = await PAGE_WINDOW.fetch(
      `https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false&key=${requestConfig.apiKey}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-youtube-client-name": requestConfig.clientName,
          "x-youtube-client-version": requestConfig.clientVersion,
          "x-goog-visitor-id": requestConfig.visitorData || "",
        },
        body: JSON.stringify({
          context: requestConfig.context,
          panelId: transcriptPayload.panelId,
          params: transcriptPayload.params,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`get_panel 请求失败: ${response.status}`);
    }

    const payload = await response.json();
    const segments = extractSegmentsFromPanelResponse(payload);

    if (!segments.length) {
      throw new Error("get_panel 返回成功了，但没解析到 transcript 段落。");
    }

    return {
      videoId: expectedVideoId || transcriptPayload.videoId || getVideoId(),
      source: "get_panel",
      panelId: transcriptPayload.panelId,
      params: transcriptPayload.params,
      segments,
      raw: payload,
    };
  }

  function pickCaptionTrack(captionTracks) {
    if (!Array.isArray(captionTracks) || !captionTracks.length) {
      return null;
    }

    const ytcfgData = getYtcfgData();
    const preferredLanguage = String(ytcfgData.HL || ytcfgData.INNERTUBE_CONTEXT_HL || "en")
      .split("-")[0]
      .toLowerCase();

    const manualExact = captionTracks.find((track) => track.languageCode?.toLowerCase() === preferredLanguage && track.kind !== "asr");
    if (manualExact) {
      return manualExact;
    }

    const manualEnglish = captionTracks.find((track) => track.languageCode?.toLowerCase() === "en" && track.kind !== "asr");
    if (manualEnglish) {
      return manualEnglish;
    }

    const firstManual = captionTracks.find((track) => track.kind !== "asr");
    if (firstManual) {
      return firstManual;
    }

    return captionTracks[0];
  }

  async function fetchTranscriptViaTimedText(expectedVideoId) {
    let playerResponse = getCurrentPlayerResponse();
    let captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!Array.isArray(captionTracks) || !captionTracks.length) {
      const snapshot = await getWatchPageSnapshot(true);
      playerResponse = snapshot.ytInitialPlayerResponse || playerResponse;
      captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    }

    const selectedTrack = pickCaptionTrack(captionTracks);

    if (!selectedTrack?.baseUrl) {
      throw new Error("当前视频没有可用字幕轨道，或者 YouTube 没返回 transcript 数据。");
    }

    const url = `${selectedTrack.baseUrl}&fmt=json3`.replace(/\\u0026/g, "&");
    const response = await PAGE_WINDOW.fetch(url, {
      method: "GET",
      credentials: "same-origin",
    });

    if (!response.ok) {
      throw new Error(`timedtext 请求失败: ${response.status}`);
    }

    const payload = await response.json();
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const segments = [];
    const seen = new Set();

    for (const event of events) {
      const text = (event?.segs || [])
        .map((segment) => segment?.utf8 || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();

      if (!text) {
        continue;
      }

      const startTimeSeconds = typeof event.tStartMs === "number" ? event.tStartMs / 1000 : null;
      const timestamp = startTimeSeconds == null ? "" : formatTimestampFromSeconds(startTimeSeconds);
      const key = `${startTimeSeconds ?? ""}|${text}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      segments.push({ text, timestamp, startTimeSeconds });
    }

    if (!segments.length) {
      throw new Error("timedtext fallback 也没拿到 transcript 文本。");
    }

    return {
      videoId: expectedVideoId || playerResponse?.videoDetails?.videoId || getVideoId(),
      source: "timedtext",
      trackLanguage: selectedTrack.languageCode || "",
      segments,
      raw: payload,
    };
  }

  async function fetchTranscript(expectedVideoId) {
    try {
      return await fetchTranscriptViaGetPanel(expectedVideoId);
    } catch (getPanelError) {
      console.warn("[YT Transcript Extractor] get_panel failed, fallback to timedtext.", getPanelError);
      const fallbackResult = await fetchTranscriptViaTimedText(expectedVideoId);
      fallbackResult.fallbackReason = String(getPanelError?.message || getPanelError);
      return fallbackResult;
    }
  }

  function ensureUi() {
    let root = document.getElementById(ROOT_ID);
    if (root) {
      return root;
    }

    root = document.createElement("div");
    root.id = ROOT_ID;
    const style = createElement("style");
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: ${Z_INDEX};
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #${BUTTON_ID} {
        border: 0;
        border-radius: 999px;
        background: #ff0033;
        color: #fff;
        padding: 10px 16px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
      }

      #${BUTTON_ID}[data-busy="true"] {
        opacity: 0.7;
        cursor: progress;
      }

      #${PANEL_ID} {
        width: min(520px, calc(100vw - 32px));
        max-height: min(72vh, 760px);
        margin-top: 12px;
        padding: 14px;
        border-radius: 16px;
        background: rgba(15, 15, 15, 0.96);
        color: #fff;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.4);
        display: none;
        backdrop-filter: blur(14px);
      }

      #${PANEL_ID}[data-open="true"] {
        display: block;
      }

      #${PANEL_ID} .ytte-row {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }

      #${PANEL_ID} .ytte-row + .ytte-row {
        margin-top: 10px;
      }

      #${PANEL_ID} .ytte-title {
        font-size: 15px;
        font-weight: 700;
      }

      #${PANEL_ID} .ytte-meta {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.72);
      }

      #${PANEL_ID} .ytte-actions button {
        border: 0;
        border-radius: 10px;
        padding: 8px 10px;
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        cursor: pointer;
        font-size: 12px;
      }

      #${PANEL_ID} .ytte-actions button:hover {
        background: rgba(255, 255, 255, 0.18);
      }

      #${PANEL_ID} textarea {
        width: 100%;
        min-height: 360px;
        resize: vertical;
        border: 0;
        border-radius: 12px;
        padding: 12px;
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
        font-size: 13px;
        line-height: 1.55;
        box-sizing: border-box;
      }

      #${PANEL_ID} .ytte-status {
        font-size: 12px;
        color: #ffd27a;
        min-height: 16px;
      }
    `;

    const triggerButton = createElement("button", {
      id: BUTTON_ID,
      text: "提取转录",
      attributes: { type: "button" },
    });

    const panel = createElement("div", {
      id: PANEL_ID,
      dataset: { open: "false" },
    });

    const titleRow = createElement("div", { className: "ytte-row" });
    const title = createElement("div", {
      className: "ytte-title",
      text: "YouTube Transcript Extractor",
    });
    titleRow.appendChild(title);

    const metaRow = createElement("div", {
      className: "ytte-row ytte-meta",
      dataset: { role: "meta" },
    });

    const statusRow = createElement("div", {
      className: "ytte-row ytte-status",
      dataset: { role: "status" },
    });

    const actionsRow = createElement("div", { className: "ytte-row ytte-actions" });
    const actions = [
      ["refresh", "重新提取"],
      ["copy-ts", "复制带时间戳"],
      ["copy-plain", "复制纯文本"],
      ["download", "下载 TXT"],
      ["close", "关闭"],
    ];

    for (const [action, label] of actions) {
      const actionButton = createElement("button", {
        text: label,
        dataset: { action },
        attributes: { type: "button" },
      });
      actionsRow.appendChild(actionButton);
    }

    const outputRow = createElement("div", { className: "ytte-row" });
    const output = createElement("textarea", {
      dataset: { role: "output" },
      attributes: {
        spellcheck: "false",
        placeholder: "这里会显示提取出来的转录文字。",
      },
    });
    outputRow.appendChild(output);

    panel.appendChild(titleRow);
    panel.appendChild(metaRow);
    panel.appendChild(statusRow);
    panel.appendChild(actionsRow);
    panel.appendChild(outputRow);

    root.appendChild(style);
    root.appendChild(triggerButton);
    root.appendChild(panel);

    document.body.appendChild(root);

    $("#" + BUTTON_ID, root).addEventListener("click", async () => {
      if (!isWatchPage()) {
        updateStatus("当前不是 YouTube watch 页面。");
        openPanel(true);
        return;
      }

      openPanel(true);
      await loadTranscript();
    });

    root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const action = target.dataset.action;
      if (!action) {
        return;
      }

      if (action === "close") {
        openPanel(false);
        return;
      }

      if (action === "refresh") {
        await loadTranscript(true);
        return;
      }

      if (!state.lastResult?.segments?.length) {
        updateStatus("还没有可复制的 transcript。");
        return;
      }

      if (action === "copy-ts") {
        await copyToClipboard(formatTranscriptLines(state.lastResult.segments, true), "已复制带时间戳文本。");
        return;
      }

      if (action === "copy-plain") {
        await copyToClipboard(formatTranscriptLines(state.lastResult.segments, false), "已复制纯文本。");
        return;
      }

      if (action === "download") {
        downloadTranscript(state.lastResult);
      }
    });

    return root;
  }

  function openPanel(isOpen) {
    const panel = $("#" + PANEL_ID, ensureUi());
    panel.dataset.open = isOpen ? "true" : "false";
  }

  function updateStatus(message) {
    const status = $('[data-role="status"]', ensureUi());
    status.textContent = message || "";
  }

  function updateMeta(message) {
    const meta = $('[data-role="meta"]', ensureUi());
    meta.textContent = message || "";
  }

  function updateOutput(value) {
    const output = $('[data-role="output"]', ensureUi());
    output.value = value || "";
  }

  function setButtonBusy(isBusy) {
    const button = $("#" + BUTTON_ID, ensureUi());
    button.dataset.busy = isBusy ? "true" : "false";
    button.textContent = isBusy ? "提取中..." : "提取转录";
  }

  function renderResult(result) {
    const metaParts = [
      `source: ${result.source}`,
      `segments: ${result.segments.length}`,
    ];

    if (result.trackLanguage) {
      metaParts.push(`lang: ${result.trackLanguage}`);
    }

    updateMeta(metaParts.join(" | "));
    updateOutput(formatTranscriptLines(result.segments, true));

    if (result.source === "timedtext" && result.fallbackReason) {
      updateStatus(`已切到 fallback: ${result.fallbackReason}`);
      return;
    }

    updateStatus("提取完成。");
  }

  async function copyToClipboard(text, successMessage) {
    try {
      await navigator.clipboard.writeText(text);
      updateStatus(successMessage);
    } catch (error) {
      console.error("[YT Transcript Extractor] clipboard write failed.", error);
      updateStatus("复制失败，浏览器拒绝了剪贴板写入。");
    }
  }

  function downloadTranscript(result) {
    const videoId = getVideoId() || "youtube";
    const title = sanitizeFilename(document.title.replace(/\s*-\s*YouTube$/i, ""));
    const lines = formatTranscriptLines(result.segments, true);
    const blob = new Blob([lines], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${videoId}-${title}-transcript.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    updateStatus("TXT 已下载。");
  }

  async function waitForYoutubeData(expectedVideoId) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const runtimeVideoId = getCurrentRuntimeVideoId();
      const playerResponse = getCurrentPlayerResponse();

      if (!playerResponse && !getFreshDataRoots().length) {
        await sleep(300);
        continue;
      }

      if (expectedVideoId && runtimeVideoId !== expectedVideoId) {
        await sleep(300);
        continue;
      }

      if (!expectedVideoId) {
        return;
      }

      if (runtimeVideoId === expectedVideoId) {
        return;
      }
    }

    const currentRuntimeVideoId = getCurrentRuntimeVideoId() || "unknown";
    throw new Error(`YouTube 页面数据还没切稳。当前 URL: ${expectedVideoId}, runtime: ${currentRuntimeVideoId}`);
  }

  async function loadTranscript(forceRefresh = false) {
    const currentVideoId = getVideoId();
    if (!currentVideoId) {
      updateStatus("没找到视频 ID。");
      return;
    }

    if (!forceRefresh && state.lastResult?.videoId === currentVideoId) {
      renderResult(state.lastResult);
      return;
    }

    if (state.isLoading) {
      return;
    }

    state.isLoading = true;
    setButtonBusy(true);
    updateStatus("正在请求 transcript...");

    try {
      await waitForYoutubeData(currentVideoId);
      const result = await fetchTranscript(currentVideoId);
      state.pageVideoId = currentVideoId;
      state.lastResult = result;
      renderResult(result);
    } catch (error) {
      console.error("[YT Transcript Extractor] transcript extraction failed.", error);
      updateMeta("");
      updateOutput("");
      updateStatus(error instanceof Error ? error.message : String(error));
    } finally {
      state.isLoading = false;
      setButtonBusy(false);
    }
  }

  function syncPageState() {
    const root = ensureUi();
    const button = $("#" + BUTTON_ID, root);
    const videoId = getVideoId();
    const watch = isWatchPage();

    button.style.display = watch ? "inline-flex" : "none";

    if (!watch) {
      openPanel(false);
      return;
    }

    if (state.pageVideoId !== videoId) {
      state.pageVideoId = videoId;
      state.lastResult = null;
      state.watchPageSnapshot = null;
      updateMeta("");
      updateOutput("");
      updateStatus("");
    }
  }

  function installNavigationHooks() {
    const events = ["yt-navigate-finish", "yt-page-data-updated", "popstate"];
    for (const eventName of events) {
      window.addEventListener(eventName, () => {
        window.setTimeout(syncPageState, 250);
      });
    }

    let lastUrl = window.location.href;
    window.setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        syncPageState();
      }
    }, 1000);
  }

  function bootstrap() {
    ensureUi();
    syncPageState();
    installNavigationHooks();
  }

  bootstrap();
})();
