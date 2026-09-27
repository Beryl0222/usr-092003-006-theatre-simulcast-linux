"use strict";

const { badRequest, conflict, notFound, requireFields, requireNumber } = require("./util");
const { latestScriptVersion } = require("./assets");

const EVENT_TYPES = ["pause", "skip", "encore"];

function schedulePerformance(store, input) {
  requireFields(input, ["productionId", "cityId", "venueId", "scheduledAt"]);
  store.get("production", input.productionId);
  store.get("city", input.cityId);
  const venue = store.get("venue", input.venueId);
  if (venue.cityId !== input.cityId) throw badRequest("剧场不属于该城市");
  const scriptVersion = latestScriptVersion(store, input.productionId);
  if (!scriptVersion) throw badRequest("制作尚未登记台本");
  const published = store.find(
    "asset",
    (a) =>
      a.productionId === input.productionId &&
      a.status === "published" &&
      (a.venueId === null || a.venueId === input.venueId)
  );
  // 快照当晚采用的辅助内容，散场后追溯以快照为准，不受后续修订影响。
  const assetSnapshot = published.map((a) => ({
    assetId: a.id,
    lineId: a.lineId,
    version: a.version,
    type: a.type,
    locale: a.locale,
    venueId: a.venueId,
    deviceType: a.deviceType,
    count: a.count,
    segmentRefs: a.segmentRefs,
    content: a.content,
    assignees: a.assignees,
  }));
  const id = store.nextId("performance");
  const cues = buildCues(id, assetSnapshot, scriptVersion);
  const performance = store.insert("performance", {
    id,
    productionId: input.productionId,
    cityId: input.cityId,
    venueId: input.venueId,
    scheduledAt: input.scheduledAt,
    scriptVersionId: scriptVersion.id,
    assetSnapshot,
    cues,
    events: [],
    dispatchLog: [],
    status: "scheduled",
  });
  store.audit({
    kind: "performance_scheduled",
    performanceId: id,
    scriptVersionId: scriptVersion.id,
  });
  return performance;
}

function buildCues(performanceId, assetSnapshot, scriptVersion) {
  const segmentById = new Map(scriptVersion.segments.map((s) => [s.id, s]));
  const cues = [];
  for (const asset of assetSnapshot) {
    if (asset.type !== "caption" && asset.type !== "audio_description") continue;
    for (const ref of asset.segmentRefs) {
      const segment = segmentById.get(ref);
      if (!segment) continue;
      cues.push({
        id: performanceId + ":" + asset.assetId + ":" + ref,
        assetId: asset.assetId,
        type: asset.type,
        locale: asset.locale,
        segmentId: ref,
        baseAtSec: segment.startSec,
      });
    }
  }
  cues.sort((a, b) => a.baseAtSec - b.baseAtSec || (a.id < b.id ? -1 : 1));
  return cues;
}

function recordLiveEvent(store, performanceId, input) {
  const performance = store.get("performance", performanceId);
  const { type } = input;
  if (!EVENT_TYPES.includes(type)) throw badRequest("未知临场事件: " + type);
  let event;
  if (type === "pause" || type === "encore") {
    requireNumber(input, "atSec");
    requireNumber(input, "durationSec");
    if (input.durationSec <= 0) throw badRequest("时长需要为正数");
    event = { type, atSec: input.atSec, durationSec: input.durationSec };
  } else {
    requireNumber(input, "fromSec");
    requireNumber(input, "toSec");
    if (input.toSec <= input.fromSec) throw badRequest("跳段结束需晚于开始");
    event = { type, fromSec: input.fromSec, toSec: input.toSec };
  }
  event.seq = performance.events.length + 1;
  event.recordedAt = store.now();
  const events = [...performance.events, event];
  store.patch("performance", performanceId, { events, status: "live" });
  store.audit({ kind: "live_event", performanceId, event });
  return event;
}

// 依据临场事件把基准提示重新对齐：暂停与返场顺延后续提示，
// 跳段内提示作废、其后提示提前；已播出的保持已播状态。
function alignCues(performance) {
  return performance.cues.map((cue) => {
    let effectiveAtSec = cue.baseAtSec;
    let status = "pending";
    for (const event of performance.events) {
      if (event.type === "pause" || event.type === "encore") {
        if (effectiveAtSec > event.atSec) effectiveAtSec += event.durationSec;
      } else if (event.type === "skip") {
        if (effectiveAtSec >= event.fromSec && effectiveAtSec < event.toSec) {
          status = "skipped";
        } else if (effectiveAtSec >= event.toSec) {
          effectiveAtSec -= event.toSec - event.fromSec;
        }
      }
    }
    if (status === "pending" && performance.dispatchLog.includes(cue.id)) status = "sent";
    return { ...cue, effectiveAtSec, status };
  });
}

function activeOverride(store, performanceId) {
  return store.find(
    "manualOverride",
    (o) => o.performanceId === performanceId && o.status === "active"
  )[0];
}

function dispatchCues(store, performanceId, input) {
  const performance = store.get("performance", performanceId);
  const source = input.source || "auto";
  if (source !== "auto" && source !== "manual") throw badRequest("未知播出来源: " + source);
  if (source === "auto" && activeOverride(store, performanceId)) {
    throw conflict("已切换人工跟随，自动同步播出暂停");
  }
  if (!Array.isArray(input.cueIds) || input.cueIds.length === 0) {
    throw badRequest("需要至少一个提示编号");
  }
  const aligned = new Map(alignCues(performance).map((c) => [c.id, c]));
  const dispatchLog = [...performance.dispatchLog];
  const sent = [];
  const suppressed = [];
  for (const cueId of input.cueIds) {
    const cue = aligned.get(cueId);
    if (!cue) throw notFound("未知提示: " + cueId);
    if (cue.status === "skipped") {
      suppressed.push({ cueId, reason: "skipped_segment" });
      continue;
    }
    // 网络恢复后补到的同步批次可能重复携带已播提示，按提示编号去重，不再播出。
    if (dispatchLog.includes(cueId)) {
      suppressed.push({ cueId, reason: "late_replay" });
      store.audit({ kind: "cue_suppressed", performanceId, cueId, reason: "late_replay", source });
      continue;
    }
    dispatchLog.push(cueId);
    sent.push({ cueId, effectiveAtSec: cue.effectiveAtSec });
    store.audit({
      kind: "cue_dispatched",
      performanceId,
      cueId,
      source,
      effectiveAtSec: cue.effectiveAtSec,
    });
  }
  store.patch("performance", performanceId, { dispatchLog });
  return { sent, suppressed };
}

function startManualOverride(store, performanceId, input) {
  store.get("performance", performanceId);
  if (!input.reason) throw badRequest("必须记录切换原因");
  requireNumber(input, "fromPositionSec");
  if (!input.operatorId) throw badRequest("必须记录操作人");
  if (!input.audienceNotice || !input.audienceNotice.method || !input.audienceNotice.message) {
    throw badRequest("必须记录观众告知方式与内容");
  }
  if (activeOverride(store, performanceId)) throw conflict("已存在进行中的人工跟随");
  const override = store.insert("manualOverride", {
    performanceId,
    reason: input.reason,
    fromPositionSec: input.fromPositionSec,
    toPositionSec: null,
    operatorId: input.operatorId,
    audienceNotice: input.audienceNotice,
    status: "active",
    startedAt: store.now(),
    endedAt: null,
  });
  store.audit({
    kind: "manual_override_start",
    performanceId,
    overrideId: override.id,
    reason: override.reason,
    fromPositionSec: override.fromPositionSec,
    operatorId: override.operatorId,
  });
  return override;
}

function endManualOverride(store, overrideId, input) {
  const override = store.get("manualOverride", overrideId);
  if (override.status !== "active") throw conflict("人工跟随已结束");
  requireNumber(input, "toPositionSec");
  const updated = store.patch("manualOverride", overrideId, {
    status: "closed",
    toPositionSec: input.toPositionSec,
    endedAt: store.now(),
  });
  store.audit({
    kind: "manual_override_end",
    performanceId: override.performanceId,
    overrideId,
    toPositionSec: input.toPositionSec,
  });
  return updated;
}

function performanceView(store, performanceId) {
  const performance = store.get("performance", performanceId);
  return { ...performance, cues: alignCues(performance) };
}

module.exports = {
  EVENT_TYPES,
  schedulePerformance,
  recordLiveEvent,
  alignCues,
  dispatchCues,
  startManualOverride,
  endManualOverride,
  performanceView,
};
