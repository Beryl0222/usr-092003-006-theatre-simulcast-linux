"use strict";

const { badRequest } = require("./util");

const CHANGE_KINDS = new Set(["line", "blocking", "duration"]);

// 各类辅助内容受哪些台本变更影响：台词改动影响字幕与口述，走位改动影响口述，
// 时长改动影响所有计时内容与排班；设备与席位需求不随内容变更召回。
const ASSET_SENSITIVITY = {
  caption: ["line", "duration"],
  audio_description: ["line", "blocking", "duration"],
  sign_interpreter: ["duration"],
  device: [],
  seat_demand: [],
  rehearsal_check: ["duration"],
};

function registerScriptVersion(store, input) {
  const { productionId, segments, note } = input;
  const changedSegments = input.changedSegments || [];
  if (!productionId) throw badRequest("缺少制作编号");
  store.get("production", productionId);
  if (!Array.isArray(segments) || segments.length === 0) {
    throw badRequest("台本需要至少一个段落");
  }
  const segmentIds = new Set();
  for (const segment of segments) {
    if (
      !segment ||
      !segment.id ||
      typeof segment.startSec !== "number" ||
      typeof segment.endSec !== "number" ||
      segment.endSec <= segment.startSec
    ) {
      throw badRequest("段落需要编号与有效的起止秒数");
    }
    if (segmentIds.has(segment.id)) throw badRequest("段落编号重复: " + segment.id);
    segmentIds.add(segment.id);
  }
  for (const change of changedSegments) {
    if (!change || !segmentIds.has(change.segmentId)) {
      throw badRequest("变更指向未知段落: " + (change && change.segmentId));
    }
    if (!CHANGE_KINDS.has(change.changeKind)) {
      throw badRequest("未知变更类型: " + change.changeKind);
    }
  }
  const version = store.find("scriptVersion", (v) => v.productionId === productionId).length + 1;
  const scriptVersion = store.insert("scriptVersion", {
    productionId,
    version,
    segments,
    changedSegments,
    note: note || null,
    createdAt: store.now(),
  });
  store.audit({
    kind: "script_version_registered",
    productionId,
    scriptVersionId: scriptVersion.id,
    version,
  });
  const recalled = recallAffectedAssets(store, scriptVersion);
  return { scriptVersion, recalled };
}

function recallAffectedAssets(store, scriptVersion) {
  const changed = new Map();
  for (const change of scriptVersion.changedSegments) {
    if (!changed.has(change.segmentId)) changed.set(change.segmentId, new Set());
    changed.get(change.segmentId).add(change.changeKind);
  }
  if (changed.size === 0) return [];
  const candidates = store.find(
    "asset",
    (a) =>
      a.productionId === scriptVersion.productionId &&
      (a.status === "published" || a.status === "approved" || a.status === "pending")
  );
  const recalled = [];
  for (const asset of candidates) {
    const sensitivity = ASSET_SENSITIVITY[asset.type] || [];
    if (sensitivity.length === 0) continue;
    const hitKinds = new Set();
    if (asset.segmentRefs.length === 0) {
      // 排班与核验类内容不绑定具体段落，视为覆盖全场。
      for (const kinds of changed.values()) {
        for (const kind of kinds) if (sensitivity.includes(kind)) hitKinds.add(kind);
      }
    } else {
      for (const ref of asset.segmentRefs) {
        const kinds = changed.get(ref);
        if (!kinds) continue;
        for (const kind of kinds) if (sensitivity.includes(kind)) hitKinds.add(kind);
      }
    }
    if (hitKinds.size === 0) continue;
    const updated = store.patch("asset", asset.id, {
      status: "recalled",
      recalledBy: scriptVersion.id,
      recallReasons: [...hitKinds],
    });
    store.audit({
      kind: "asset_recalled",
      assetId: asset.id,
      scriptVersionId: scriptVersion.id,
      reasons: [...hitKinds],
    });
    recalled.push(updated);
  }
  return recalled;
}

module.exports = { registerScriptVersion, recallAffectedAssets, ASSET_SENSITIVITY, CHANGE_KINDS };
