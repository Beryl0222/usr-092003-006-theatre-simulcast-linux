"use strict";

const { badRequest, forbidden, conflict, requireFields } = require("./util");

const ASSET_TYPES = [
  "caption",
  "audio_description",
  "sign_interpreter",
  "device",
  "seat_demand",
  "rehearsal_check",
];
const TIMED_TYPES = ["caption", "audio_description"];
const ROLES = ["translator", "director", "local_manager"];

// 各类内容发布前必须集齐的职责确认：翻译对文字内容负责，导演对舞台一致性负责，
// 当地负责人对本场资源与席位负责。
const REQUIRED_APPROVALS = {
  caption: ["translator", "director"],
  audio_description: ["translator", "director"],
  sign_interpreter: ["director", "local_manager"],
  device: ["local_manager"],
  seat_demand: ["local_manager"],
  rehearsal_check: ["local_manager", "director"],
};

function latestScriptVersion(store, productionId) {
  const versions = store.find("scriptVersion", (v) => v.productionId === productionId);
  if (versions.length === 0) return null;
  return versions.sort((a, b) => b.version - a.version)[0];
}

function validateAssetInput(store, input) {
  requireFields(input, ["productionId", "type"]);
  if (!ASSET_TYPES.includes(input.type)) throw badRequest("未知辅助内容类型: " + input.type);
  store.get("production", input.productionId);
  if (input.venueId !== undefined && input.venueId !== null) store.get("venue", input.venueId);
  if (input.type === "caption" && !input.locale) throw badRequest("字幕内容需要语种");
  if (input.type === "device") {
    requireFields(input, ["deviceType"]);
    if (typeof input.count !== "number" || input.count <= 0) {
      throw badRequest("设备需要正数数量");
    }
  }
  if (TIMED_TYPES.includes(input.type)) {
    if (!Array.isArray(input.segmentRefs) || input.segmentRefs.length === 0) {
      throw badRequest("计时内容需要关联台本段落");
    }
    const scriptVersion = latestScriptVersion(store, input.productionId);
    if (!scriptVersion) throw badRequest("制作尚未登记台本");
    const ids = new Set(scriptVersion.segments.map((s) => s.id));
    for (const ref of input.segmentRefs) {
      if (!ids.has(ref)) throw badRequest("段落不存在于当前台本: " + ref);
    }
  }
}

function nextVersion(store, lineId) {
  return (
    store.find("asset", (a) => a.lineId === lineId).reduce((max, a) => Math.max(max, a.version), 0) +
    1
  );
}

function registerAsset(store, input) {
  validateAssetInput(store, input);
  const id = store.nextId("asset");
  const asset = store.insert("asset", {
    id,
    lineId: id,
    version: 1,
    productionId: input.productionId,
    venueId: input.venueId ?? null,
    type: input.type,
    locale: input.locale ?? null,
    deviceType: input.deviceType ?? null,
    count: input.count ?? null,
    segmentRefs: input.segmentRefs ?? [],
    content: input.content ?? null,
    assignees: input.assignees ?? [],
    status: "draft",
    approvals: [],
    recalledBy: null,
    recallReasons: [],
    createdAt: store.now(),
    publishedAt: null,
  });
  store.audit({
    kind: "asset_registered",
    assetId: id,
    type: asset.type,
    productionId: asset.productionId,
  });
  return asset;
}

function reviseAsset(store, assetId, input) {
  const source = store.get("asset", assetId);
  if (source.status !== "recalled" && source.status !== "published") {
    throw conflict("仅被召回或已发布的内容可修订");
  }
  const merged = {
    productionId: source.productionId,
    venueId: source.venueId,
    type: source.type,
    locale: input.locale ?? source.locale,
    deviceType: input.deviceType ?? source.deviceType,
    count: input.count ?? source.count,
    segmentRefs: input.segmentRefs ?? source.segmentRefs,
    content: input.content ?? source.content,
    assignees: input.assignees ?? source.assignees,
  };
  validateAssetInput(store, merged);
  const asset = store.insert("asset", {
    lineId: source.lineId,
    version: nextVersion(store, source.lineId),
    ...merged,
    status: "draft",
    approvals: [],
    recalledBy: null,
    recallReasons: [],
    createdAt: store.now(),
    publishedAt: null,
  });
  store.audit({ kind: "asset_revised", assetId: asset.id, fromAssetId: assetId, version: asset.version });
  return asset;
}

function submitAsset(store, assetId) {
  const asset = store.get("asset", assetId);
  if (asset.status !== "draft") throw conflict("仅草稿可提交确认");
  const updated = store.patch("asset", assetId, { status: "pending" });
  store.audit({ kind: "asset_submitted", assetId });
  return updated;
}

function approveAsset(store, assetId, input) {
  requireFields(input, ["role", "by"]);
  const asset = store.get("asset", assetId);
  if (!ROLES.includes(input.role)) throw badRequest("未知职责: " + input.role);
  const required = REQUIRED_APPROVALS[asset.type];
  if (!required.includes(input.role)) throw forbidden("该内容不需要" + input.role + "确认");
  if (asset.status !== "pending") throw conflict("内容不在待确认状态");
  if (asset.approvals.some((a) => a.role === input.role)) throw conflict("该职责已确认过");
  const approvals = [...asset.approvals, { role: input.role, by: input.by, at: store.now() }];
  const complete = required.every((role) => approvals.some((a) => a.role === role));
  const updated = store.patch("asset", assetId, {
    approvals,
    status: complete ? "approved" : "pending",
  });
  store.audit({ kind: "asset_approved", assetId, role: input.role, by: input.by, complete });
  return updated;
}

function publishAsset(store, assetId, input) {
  const asset = store.get("asset", assetId);
  if (asset.status !== "approved") throw conflict("确认未齐，不能发布");
  for (const other of store.find("asset", (a) => a.lineId === asset.lineId && a.status === "published")) {
    store.patch("asset", other.id, { status: "superseded" });
  }
  const updated = store.patch("asset", assetId, {
    status: "published",
    publishedAt: store.now(),
  });
  store.audit({
    kind: "asset_published",
    assetId,
    by: (input && input.by) || null,
    version: updated.version,
  });
  return updated;
}

module.exports = {
  ASSET_TYPES,
  ROLES,
  REQUIRED_APPROVALS,
  latestScriptVersion,
  registerAsset,
  reviseAsset,
  submitAsset,
  approveAsset,
  publishAsset,
};
