"use strict";

const { badRequest, requireFields } = require("./util");
const { alignCues } = require("./live");
const { demandSummary } = require("./privacy");

function fileComplaint(store, input) {
  requireFields(input, ["performanceId", "category", "text"]);
  store.get("performance", input.performanceId);
  if (input.needId) {
    const need = store.get("need", input.needId);
    if (need.performanceId !== input.performanceId) {
      throw badRequest("观众需求不属于该场次");
    }
  }
  const complaint = store.insert("complaint", {
    performanceId: input.performanceId,
    needId: input.needId ?? null,
    category: input.category,
    text: input.text,
    status: "open",
    createdAt: store.now(),
    resolution: null,
  });
  store.audit({ kind: "complaint_filed", complaintId: complaint.id, performanceId: input.performanceId });
  return complaint;
}

function resolveComplaint(store, complaintId, input) {
  requireFields(input, ["resolution"]);
  const complaint = store.get("complaint", complaintId);
  const updated = store.patch("complaint", complaintId, {
    status: "resolved",
    resolution: { text: input.resolution, by: input.by ?? null, at: store.now() },
  });
  store.audit({ kind: "complaint_resolved", complaintId, by: input.by ?? null });
  return updated;
}

// 从一条投诉还原当晚全貌：台本版本、辅助内容快照、人员排班、
// 设备与彩排检查、临场事件、人工跟随切换、提示播出情况与补救结果。
function complaintTrace(store, complaintId) {
  const complaint = store.get("complaint", complaintId);
  const performance = store.get("performance", complaint.performanceId);
  const scriptVersion = store.get("scriptVersion", performance.scriptVersionId);
  const aligned = alignCues(performance);
  const overrides = store.find("manualOverride", (o) => o.performanceId === performance.id);
  return {
    complaint,
    performance: {
      id: performance.id,
      cityId: performance.cityId,
      venueId: performance.venueId,
      scheduledAt: performance.scheduledAt,
      status: performance.status,
    },
    scriptVersion: {
      id: scriptVersion.id,
      version: scriptVersion.version,
      note: scriptVersion.note,
      changedSegments: scriptVersion.changedSegments,
    },
    assets: performance.assetSnapshot,
    roster: performance.assetSnapshot.filter((a) => a.type === "sign_interpreter"),
    deviceChecks: performance.assetSnapshot.filter(
      (a) => a.type === "device" || a.type === "rehearsal_check"
    ),
    liveEvents: performance.events,
    manualOverrides: overrides,
    dispatches: {
      total: aligned.length,
      sent: aligned.filter((c) => c.status === "sent").length,
      skipped: aligned.filter((c) => c.status === "skipped").length,
      pending: aligned.filter((c) => c.status === "pending").length,
    },
    resolution: complaint.resolution,
  };
}

// 汇总城市内各场次的供给缺口；同一缺口出现在两个及以上场次视为反复出现。
function cityGaps(store, cityId) {
  const performances = store.find("performance", (p) => p.cityId === cityId);
  const gapMap = new Map();
  const addGap = (kind, performanceId) => {
    if (!gapMap.has(kind)) gapMap.set(kind, new Set());
    gapMap.get(kind).add(performanceId);
  };
  for (const performance of performances) {
    const supply = { captionLocales: new Set(), audioDescription: false, signInterpreter: false, devices: 0 };
    for (const asset of performance.assetSnapshot) {
      if (asset.type === "caption") supply.captionLocales.add(asset.locale);
      if (asset.type === "audio_description") supply.audioDescription = true;
      if (asset.type === "sign_interpreter") supply.signInterpreter = true;
      if (asset.type === "device") supply.devices += asset.count || 0;
    }
    const demand = demandSummary(store, performance.id);
    for (const locale of Object.keys(demand.captions)) {
      if (!supply.captionLocales.has(locale)) addGap("caption_locale_missing:" + locale, performance.id);
    }
    if (demand.audioDescription > 0 && !supply.audioDescription) {
      addGap("audio_description_missing", performance.id);
    }
    if (demand.signLanguage > 0 && !supply.signInterpreter) {
      addGap("sign_interpreter_missing", performance.id);
    }
    if (demand.devices > supply.devices) addGap("device_shortage", performance.id);
    const complaints = store.find("complaint", (c) => c.performanceId === performance.id);
    for (const complaint of complaints) addGap("complaint:" + complaint.category, performance.id);
  }
  const gaps = [...gapMap.entries()].map(([kind, ids]) => ({
    kind,
    occurrences: ids.size,
    performanceIds: [...ids].sort(),
    repeated: ids.size >= 2,
  }));
  gaps.sort((a, b) => b.occurrences - a.occurrences || a.kind.localeCompare(b.kind));
  return {
    cityId,
    performances: performances.length,
    gaps,
    repeatedGaps: gaps.filter((g) => g.repeated).map((g) => g.kind),
  };
}

module.exports = { fileComplaint, resolveComplaint, complaintTrace, cityGaps };
