"use strict";

const { Store } = require("./store");

// ---------------------------------------------------------------------------
// 领域规则常量
// ---------------------------------------------------------------------------

// 台本变化类型 → 需要重新确认的职责。台词变动牵动翻译与导演；走位只牵动导演；

// 时长变动影响当地排期，需导演与当地负责人确认。召回时只重置这些角色的确认。
const ROLE_BY_CHANGE_KIND = {
  line: ["translator", "director"],
  blocking: ["director"],
  duration: ["director", "local-lead"],
};

// 各类辅助内容发布前必须集齐的职责确认。
const ASSET_RULES = {
  caption: { label: "实时字幕", registerRole: "translator", requiredRoles: ["translator", "director"] },
  "audio-description": { label: "口述影像稿", registerRole: "director", requiredRoles: ["director"] },
  "sign-assignment": { label: "手语译员排班", registerRole: "local-lead", requiredRoles: ["local-lead"] },
};

const DEVICE_KINDS = ["caption-receiver", "ad-headset"];
const DEMAND_KEYS = ["caption", "audioDescription", "sign"];

class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
  }
}

function now() {
  return new Date().toISOString();
}

function requireFields(payload, fields) {
  for (const field of fields) {
    const value = payload[field];
    if (value === undefined || value === null || value === "") {
      throw new DomainError("missing-field", `缺少必填字段: ${field}`, 400);
    }
  }
}

// ---------------------------------------------------------------------------
// 台本工具
// ---------------------------------------------------------------------------

function validateSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new DomainError("invalid-segments", "台本至少需要一个片段", 400);
  }
  const seen = new Set();
  for (const segment of segments) {
    if (!segment || typeof segment.key !== "string" || segment.key === "") {
      throw new DomainError("invalid-segments", "每个片段都需要字符串 key", 400);
    }
    if (seen.has(segment.key)) {
      throw new DomainError("invalid-segments", `片段 key 重复: ${segment.key}`, 400);
    }
    seen.add(segment.key);
  }
}

// 逐片段对比台词、走位、时长，得出受影响的片段 key 与变化类型集合。
function diffSegments(previous, next) {
  const prevByKey = new Map(previous.map((s) => [s.key, s]));
  const nextKeys = new Set(next.map((s) => s.key));
  const changedKeys = [];
  const changeKinds = new Set();
  for (const segment of next) {
    const before = prevByKey.get(segment.key);
    if (!before) {
      changedKeys.push(segment.key);
      changeKinds.add("line");
      continue;
    }
    let changed = false;
    if ((before.text ?? null) !== (segment.text ?? null)) {
      changeKinds.add("line");
      changed = true;
    }
    if ((before.blocking ?? null) !== (segment.blocking ?? null)) {
      changeKinds.add("blocking");
      changed = true;
    }
    if ((before.durationMs ?? null) !== (segment.durationMs ?? null)) {
      changeKinds.add("duration");
      changed = true;
    }
    if (changed) changedKeys.push(segment.key);
  }
  for (const key of prevByKey.keys()) {
    if (!nextKeys.has(key)) {
      changedKeys.push(key);
      changeKinds.add("line");
    }
  }
  return { changedKeys, changeKinds };
}

// 由台本片段时长累加得到场次时间线基准。
function buildTimeline(segments) {
  let cursor = 0;
  return segments.map((segment) => {
    const entry = {
      segmentKey: segment.key,
      plannedStartMs: cursor,
      plannedEndMs: cursor + (segment.durationMs || 0),
    };
    cursor = entry.plannedEndMs;
    return entry;
  });
}

// ---------------------------------------------------------------------------
// 协同后端
// ---------------------------------------------------------------------------

class Coordinator {
  constructor(store = new Store()) {
    this.store = store;
  }

  log(actor, action, entityType, entityId, details = {}, showId = null) {
    return this.store.audit({
      actor: { id: actor.id, role: actor.role },
      action,
      entityType,
      entityId,
      showId,
      details,
    });
  }

  mustGet(collection, id, label) {
    const record = this.store.get(collection, id);
    if (!record) throw new DomainError("not-found", `${label}不存在: ${id}`, 404);
    return record;
  }

  requireRole(actor, ...roles) {
    if (!actor || !roles.includes(actor.role)) {
      throw new DomainError("forbidden", `角色 ${actor && actor.role} 无权执行该操作`, 403);
    }
  }

  // 场所工作人员只能接触本场所的场次。
  requireVenueScope(actor, show, extraRoles = []) {
    if (extraRoles.includes(actor.role)) return;
    if (actor.role === "venue-staff" && actor.venueId && actor.venueId === show.venueId) return;
    throw new DomainError("forbidden", "无权接触其他场所的场次资料", 403);
  }

  // ---- 制作与台本 ---------------------------------------------------------

  createProduction(payload, actor) {
    this.requireRole(actor, "coordinator", "director");
    requireFields(payload, ["title", "originCity"]);
    const production = this.store.insert("productions", {
      id: this.store.nextId("prod"),
      title: payload.title,
      originCity: payload.originCity,
      createdAt: now(),
    });
    this.log(actor, "production.create", "production", production.id, { title: production.title });
    return production;
  }

  latestScriptVersion(productionId) {
    const versions = this.store.filter("scriptVersions", (v) => v.productionId === productionId);
    return versions.sort((a, b) => b.version - a.version)[0] || null;
  }

  // 登记新台本版本：与上一版本 diff，随后把受影响内容在各城市场次中定向召回。
  registerScriptVersion(productionId, payload, actor) {
    this.requireRole(actor, "coordinator", "director");
    const production = this.mustGet("productions", productionId, "制作");
    requireFields(payload, ["segments"]);
    validateSegments(payload.segments);
    const previous = this.latestScriptVersion(productionId);
    const diff = diffSegments(previous ? previous.segments : [], payload.segments);
    const version = this.store.insert("scriptVersions", {
      id: this.store.nextId("script"),
      productionId,
      version: previous ? previous.version + 1 : 1,
      segments: payload.segments.map((s) => ({ ...s })),
      note: payload.note || null,
      changedKeys: diff.changedKeys,
      changeKinds: [...diff.changeKinds],
      createdAt: now(),
      createdBy: actor.id,
    });
    this.log(actor, "script-version.register", "scriptVersion", version.id, {
      version: version.version,
      changedKeys: version.changedKeys,
      changeKinds: version.changeKinds,
    });
    const recalls = this.applyScriptVersion(production, version, diff, actor);
    return { version, recalls };
  }

  // 新台本生效：各场次换绑时间线基准；只召回引用了受影响片段的提示，
  // 并按变化类型重置对应职责的确认，其余内容与确认保持不变。
  applyScriptVersion(production, version, diff, actor) {
    const recalls = [];
    const shows = this.store.filter("shows", (s) => s.productionId === production.id);
    for (const show of shows) {
      show.scriptVersionId = version.id;
      show.timeline = buildTimeline(version.segments);
      const assets = this.store.filter("assets", (a) => a.showId === show.id);
      for (const asset of assets) {
        const affectedCueIds = [];
        for (const cue of asset.cues) {
          if (diff.changedKeys.includes(cue.segmentKey) && cue.status !== "recalled") {
            cue.status = "recalled";
            affectedCueIds.push(cue.cueId);
          }
        }
        if (affectedCueIds.length === 0) continue;
        asset.status = "needs-revision";
        const resetRoles = new Set();
        for (const kind of diff.changeKinds) {
          for (const role of ROLE_BY_CHANGE_KIND[kind]) resetRoles.add(role);
        }
        for (const role of resetRoles) delete asset.confirmations[role];
        const recall = {
          scriptVersionId: version.id,
          cueIds: affectedCueIds,
          changeKinds: [...diff.changeKinds],
          resetRoles: [...resetRoles],
          at: now(),
        };
        asset.recalls.push(recall);
        recalls.push({ showId: show.id, assetId: asset.id, ...recall });
        this.log(actor, "asset.recall", "asset", asset.id, {
          cueIds: affectedCueIds,
          resetRoles: recall.resetRoles,
        }, show.id);
      }
    }
    return recalls;
  }

  // ---- 场次 ----------------------------------------------------------------

  scheduleShow(payload, actor) {
    this.requireRole(actor, "coordinator");
    requireFields(payload, ["productionId", "city", "venueId", "startsAt"]);
    const production = this.mustGet("productions", payload.productionId, "制作");
    const version = this.latestScriptVersion(production.id);
    if (!version) {
      throw new DomainError("no-script", "制作尚无台本版本，无法排期", 409);
    }
    const show = this.store.insert("shows", {
      id: this.store.nextId("show"),
      productionId: production.id,
      city: payload.city,
      venueId: payload.venueId,
      startsAt: payload.startsAt,
      scriptVersionId: version.id,
      timeline: buildTimeline(version.segments),
      demand: { caption: 0, audioDescription: 0, sign: 0 },
      status: "scheduled",
      createdAt: now(),
    });
    this.log(actor, "show.schedule", "show", show.id, {
      city: show.city,
      venueId: show.venueId,
      scriptVersionId: version.id,
    }, show.id);
    return show;
  }

  getShowView(showId, actor) {
    const show = this.mustGet("shows", showId, "场次");
    this.requireVenueScope(actor, show, ["coordinator", "director", "local-lead"]);
    const version = this.store.get("scriptVersions", show.scriptVersionId);
    return {
      show,
      scriptVersion: version && { id: version.id, version: version.version, changedKeys: version.changedKeys },
      assets: this.store.filter("assets", (a) => a.showId === showId),
      devices: this.store.filter("devices", (d) => d.showId === showId),
      rehearsalVerifications: this.store.filter("rehearsalVerifications", (r) => r.showId === showId),
      liveSessions: this.store
        .filter("liveSessions", (s) => s.showId === showId)
        .map((s) => ({ id: s.id, state: s.state, mode: s.mode, startedAt: s.startedAt })),
    };
  }

  // ---- 辅助内容登记 / 确认 / 发布 -------------------------------------------

  registerAsset(showId, payload, actor) {
    const show = this.mustGet("shows", showId, "场次");
    const rule = ASSET_RULES[payload.type];
    if (!rule) {
      throw new DomainError("unknown-asset-type", `未知的辅助内容类型: ${payload.type}`, 400);
    }
    this.requireRole(actor, rule.registerRole, "coordinator");
    const version = this.mustGet("scriptVersions", show.scriptVersionId, "台本版本");
    const segmentKeys = new Set(version.segments.map((s) => s.key));
    const cueInputs = payload.cues || [];
    for (const cue of cueInputs) {
      if (!segmentKeys.has(cue.segmentKey)) {
        throw new DomainError("unknown-segment", `台本中不存在片段: ${cue.segmentKey}`, 400);
      }
    }
    const asset = this.store.insert("assets", {
      id: this.store.nextId("asset"),
      showId,
      type: payload.type,
      language: payload.language || null,
      assignment: payload.assignment || null,
      cues: [],
      confirmations: {},
      recalls: [],
      status: "draft",
      publishedVersion: 0,
      createdAt: now(),
    });
    asset.cues = cueInputs.map((cue, index) => ({
      cueId: `${asset.id}-c${index + 1}`,
      segmentKey: cue.segmentKey,
      text: cue.text ?? null,
      offsetMs: cue.offsetMs ?? 0,
      status: "active",
    }));
    this.log(actor, "asset.register", "asset", asset.id, { type: asset.type, language: asset.language }, showId);
    return asset;
  }

  confirmAsset(assetId, payload, actor) {
    const asset = this.mustGet("assets", assetId, "辅助内容");
    const rule = ASSET_RULES[asset.type];
    requireFields(payload, ["role"]);
    if (!rule.requiredRoles.includes(payload.role)) {
      throw new DomainError("role-not-required", `${rule.label}不需要 ${payload.role} 确认`, 400);
    }
    if (actor.role !== payload.role && actor.role !== "coordinator") {
      throw new DomainError("forbidden", `只能以本人职责确认（需要 ${payload.role}）`, 403);
    }
    asset.confirmations[payload.role] = { by: actor.id, at: now() };
    this.log(actor, "asset.confirm", "asset", asset.id, { role: payload.role }, asset.showId);
    return asset;
  }

  // 修订被召回的提示；未被召回的内容不允许借此改动。
  reviseAsset(assetId, payload, actor) {
    const asset = this.mustGet("assets", assetId, "辅助内容");
    const rule = ASSET_RULES[asset.type];
    this.requireRole(actor, rule.registerRole, "coordinator");
    requireFields(payload, ["cues"]);
    const revised = [];
    for (const update of payload.cues) {
      const cue = asset.cues.find((c) => c.cueId === update.cueId);
      if (!cue) throw new DomainError("not-found", `提示不存在: ${update.cueId}`, 404);
      if (cue.status !== "recalled") {
        throw new DomainError("cue-not-recalled", `提示 ${cue.cueId} 未被召回，无需修订`, 409);
      }
      if (update.text !== undefined) cue.text = update.text;
      if (update.offsetMs !== undefined) cue.offsetMs = update.offsetMs;
      cue.status = "active";
      revised.push(cue.cueId);
    }
    if (asset.cues.every((c) => c.status === "active")) asset.status = "draft";
    this.log(actor, "asset.revise", "asset", asset.id, { revised }, asset.showId);
    return asset;
  }

  // 发布前置条件：无待修订的召回内容，且职责确认齐全。
  publishAsset(assetId, actor) {
    this.requireRole(actor, "coordinator", "director");
    const asset = this.mustGet("assets", assetId, "辅助内容");
    if (asset.status === "published") {
      throw new DomainError("already-published", "该内容已发布，如需变更请先修订", 409);
    }
    const recalled = asset.cues.filter((c) => c.status === "recalled");
    if (recalled.length > 0) {
      throw new DomainError("recalled-cues", `仍有 ${recalled.length} 条被召回内容待修订`, 409);
    }
    const missing = ASSET_RULES[asset.type].requiredRoles.filter((role) => !asset.confirmations[role]);
    if (missing.length > 0) {
      throw new DomainError("missing-confirmation", `缺少职责确认: ${missing.join(", ")}`, 409);
    }
    asset.status = "published";
    asset.publishedVersion += 1;
    asset.publishedAt = now();
    this.log(actor, "asset.publish", "asset", asset.id, { publishedVersion: asset.publishedVersion }, asset.showId);
    return asset;
  }

  // ---- 设备 / 需求 / 彩排核验 ----------------------------------------------

  registerDevice(showId, payload, actor) {
    const show = this.mustGet("shows", showId, "场次");
    this.requireVenueScope(actor, show, ["coordinator", "local-lead"]);
    requireFields(payload, ["kind", "label"]);
    if (!DEVICE_KINDS.includes(payload.kind)) {
      throw new DomainError("unknown-device-kind", `未知的接收设备类型: ${payload.kind}`, 400);
    }
    const device = this.store.insert("devices", {
      id: this.store.nextId("device"),
      showId,
      kind: payload.kind,
      label: payload.label,
      status: "unchecked",
      checks: [],
    });
    this.log(actor, "device.register", "device", device.id, { kind: device.kind }, showId);
    return device;
  }

  checkDevice(deviceId, payload, actor) {
    const device = this.mustGet("devices", deviceId, "设备");
    const show = this.mustGet("shows", device.showId, "场次");
    this.requireVenueScope(actor, show, ["coordinator", "local-lead"]);
    if (typeof payload.ok !== "boolean") {
      throw new DomainError("missing-field", "缺少必填字段: ok（布尔）", 400);
    }
    const check = { ok: payload.ok, note: payload.note || null, by: actor.id, at: now() };
    device.checks.push(check);
    device.status = payload.ok ? "ready" : "faulty";
    this.log(actor, "device.check", "device", device.id, { ok: payload.ok }, show.id);
    return device;
  }

  // 当地席位需求只登记匿名数量，不与个人关联。
  recordDemand(showId, payload, actor) {
    const show = this.mustGet("shows", showId, "场次");
    this.requireVenueScope(actor, show, ["coordinator", "local-lead"]);
    for (const key of DEMAND_KEYS) {
      if (payload[key] === undefined) continue;
      if (typeof payload[key] !== "number" || payload[key] < 0) {
        throw new DomainError("invalid-demand", `需求数量必须是非负数字: ${key}`, 400);
      }
      show.demand[key] = payload[key];
    }
    this.log(actor, "show.demand", "show", show.id, { demand: { ...show.demand } }, showId);
    return show.demand;
  }

  submitRehearsalVerification(showId, payload, actor) {
    const show = this.mustGet("shows", showId, "场次");
    this.requireRole(actor, "local-lead", "coordinator");
    requireFields(payload, ["items"]);
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      throw new DomainError("invalid-items", "彩排核验至少需要一个检查项", 400);
    }
    const ok = payload.items.every((item) => item && item.ok === true);
    const record = this.store.insert("rehearsalVerifications", {
      id: this.store.nextId("rehearsal"),
      showId,
      items: payload.items,
      ok,
      note: payload.note || null,
      by: actor.id,
      at: now(),
    });
    this.log(actor, "rehearsal.verify", "rehearsalVerification", record.id, { ok }, showId);
    return record;
  }

  // ---- 观众登记与同意范围 ----------------------------------------------------

  registerAudienceMember(showId, payload, actor) {
    this.requireRole(actor, "coordinator");
    this.mustGet("shows", showId, "场次");
    requireFields(payload, ["needs", "consent"]);
    const consent = {
      coordinator: payload.consent.coordinator === true,
      venue: payload.consent.venue === true,
      contact: payload.consent.contact === true,
    };
    const member = this.store.insert("audience", {
      id: this.store.nextId("aud"),
      showId,
      ref: payload.ref || null,
      needs: payload.needs,
      contact: payload.contact || null,
      consent,
      createdAt: now(),
    });
    this.log(actor, "audience.register", "audience", member.id, { needs: member.needs }, showId);
    return member;
  }

  // 障碍信息与联系方式只在观众同意的范围内开放。
  listAudienceMembers(showId, actor) {
    const show = this.mustGet("shows", showId, "场次");
    let scope;
    if (actor.role === "coordinator") {
      scope = "coordinator";
    } else if (actor.role === "local-lead" || (actor.role === "venue-staff" && actor.venueId === show.venueId)) {
      scope = "venue";
    } else {
      throw new DomainError("forbidden", "无权查看观众信息", 403);
    }
    return this.store
      .filter("audience", (a) => a.showId === showId && a.consent[scope])
      .map((a) => ({
        id: a.id,
        showId: a.showId,
        needs: a.needs,
        contact: a.consent.contact ? a.contact : null,
      }));
  }

  // 场所简报：本场所需的已发布辅助资料 + 匿名需求数量，不含任何个人信息。
  venueBrief(venueId, showId, actor) {
    const show = this.mustGet("shows", showId, "场次");
    if (show.venueId !== venueId) {
      throw new DomainError("forbidden", "该场次不属于本场所", 403);
    }
    this.requireVenueScope(actor, show, ["coordinator", "local-lead"]);
    const version = this.store.get("scriptVersions", show.scriptVersionId);
    const assets = this.store.filter("assets", (a) => a.showId === showId && a.status === "published");
    const verifications = this.store.filter("rehearsalVerifications", (r) => r.showId === showId);
    return {
      show: { id: show.id, city: show.city, venueId: show.venueId, startsAt: show.startsAt, status: show.status },
      scriptVersion: version && { id: version.id, version: version.version },
      assets,
      demand: { ...show.demand },
      devices: this.store
        .filter("devices", (d) => d.showId === showId)
        .map((d) => ({ id: d.id, kind: d.kind, label: d.label, status: d.status })),
      rehearsal: verifications.length
        ? { ok: verifications[verifications.length - 1].ok, at: verifications[verifications.length - 1].at }
        : null,
    };
  }

  // ---- 演出中：对齐、去重、人工跟随 ------------------------------------------

  startLive(showId, actor) {
    const show = this.mustGet("shows", showId, "场次");
    this.requireVenueScope(actor, show, ["coordinator", "local-lead"]);
    const open = this.store.filter("liveSessions", (s) => s.showId === showId && s.state === "live");
    if (open.length > 0) {
      throw new DomainError("already-live", "该场次已有进行中的直播会话", 409);
    }
    const published = this.store.filter("assets", (a) => a.showId === showId && a.status === "published");
    const timeline = published.flatMap((asset) =>
      asset.cues.map((cue) => ({
        cueId: cue.cueId,
        assetId: asset.id,
        assetType: asset.type,
        segmentKey: cue.segmentKey,
        text: cue.text,
        plannedOffsetMs: cue.offsetMs,
        dispatched: false,
        skipped: false,
      })),
    );
    const session = this.store.insert("liveSessions", {
      id: this.store.nextId("live"),
      showId,
      state: "live",
      mode: "auto",
      generation: 1,
      startedAt: now(),
      timeline,
      dispatchLog: [],
      events: [],
      realignments: [],
      manualSwitches: [],
      openPause: null,
    });
    show.status = "live";
    this.log(actor, "live.start", "liveSession", session.id, { cueCount: timeline.length }, showId);
    return session;
  }

  openSession(showId) {
    const session = this.store.filter("liveSessions", (s) => s.showId === showId && s.state === "live")[0];
    if (!session) {
      throw new DomainError("no-live-session", "该场次没有进行中的直播会话", 409);
    }
    return session;
  }

  getLiveSession(showId, actor) {
    const show = this.mustGet("shows", showId, "场次");
    this.requireVenueScope(actor, show, ["coordinator", "local-lead", "director"]);
    return this.openSession(showId);
  }

  // 暂停 / 跳段 / 返场：重排未播出的提示，已播出的保持原样。
  liveEvent(showId, payload, actor) {
    const show = this.mustGet("shows", showId, "场次");
    this.requireVenueScope(actor, show, ["coordinator", "local-lead"]);
    const session = this.openSession(showId);
    requireFields(payload, ["type"]);

    if (payload.type === "pause") {
      requireFields(payload, ["atMs"]);
      if (session.openPause) {
        throw new DomainError("already-paused", "已处于暂停状态", 409);
      }
      session.openPause = { atMs: payload.atMs };
      session.events.push({ type: "pause", atMs: payload.atMs, at: now() });
    } else if (payload.type === "resume") {
      requireFields(payload, ["atMs"]);
      if (!session.openPause) {
        throw new DomainError("not-paused", "当前未处于暂停状态", 409);
      }
      const shiftMs = payload.atMs - session.openPause.atMs;
      const affected = session.timeline.filter(
        (cue) => !cue.dispatched && !cue.skipped && cue.plannedOffsetMs > session.openPause.atMs,
      );
      for (const cue of affected) cue.plannedOffsetMs += shiftMs;
      session.realignments.push({
        type: "pause-resume",
        shiftMs,
        affectedCueIds: affected.map((cue) => cue.cueId),
        at: now(),
      });
      session.events.push({ type: "resume", atMs: payload.atMs, shiftMs, at: now() });
      session.openPause = null;
      session.generation += 1;
    } else if (payload.type === "skip") {
      requireFields(payload, ["toSegmentKey"]);
      const version = this.mustGet("scriptVersions", show.scriptVersionId, "台本版本");
      const order = new Map(version.segments.map((segment, index) => [segment.key, index]));
      const target = order.get(payload.toSegmentKey);
      if (target === undefined) {
        throw new DomainError("unknown-segment", `台本中不存在片段: ${payload.toSegmentKey}`, 400);
      }
      const skipped = session.timeline.filter(
        (cue) => !cue.dispatched && !cue.skipped && (order.get(cue.segmentKey) ?? Infinity) < target,
      );
      for (const cue of skipped) cue.skipped = true;
      session.realignments.push({
        type: "skip",
        toSegmentKey: payload.toSegmentKey,
        skippedCueIds: skipped.map((cue) => cue.cueId),
        at: now(),
      });
      session.events.push({ type: "skip", toSegmentKey: payload.toSegmentKey, at: now() });
      session.generation += 1;
    } else if (payload.type === "encore") {
      session.realignments.push({ type: "encore", atMs: payload.atMs ?? null, note: payload.note || null, at: now() });
      session.events.push({ type: "encore", atMs: payload.atMs ?? null, at: now() });
      session.generation += 1;
    } else {
      throw new DomainError("unknown-event-type", `未知的演出事件: ${payload.type}`, 400);
    }
    this.log(actor, `live.event.${payload.type}`, "liveSession", session.id, { ...payload, type: undefined }, showId);
    return session;
  }

  // 提示播出按 (会话, 提示) 幂等：网络恢复后迟到的重放不会重复播出。
  dispatchCue(showId, payload, actor) {
    const show = this.mustGet("shows", showId, "场次");
    this.requireVenueScope(actor, show, ["coordinator", "local-lead"]);
    const session = this.openSession(showId);
    requireFields(payload, ["cueId"]);
    const prior = session.dispatchLog.find((entry) => entry.cueId === payload.cueId);
    if (prior) {
      this.log(actor, "live.dispatch.deduplicated", "liveSession", session.id, { cueId: payload.cueId }, showId);
      return { cueId: payload.cueId, deduplicated: true, firstDispatchedAt: prior.at, generation: session.generation };
    }
    const cue = session.timeline.find((entry) => entry.cueId === payload.cueId);
    if (!cue) throw new DomainError("not-found", `提示不存在: ${payload.cueId}`, 404);
    if (cue.skipped) {
      throw new DomainError("cue-skipped", "该提示已因跳段作废，不再播出", 409);
    }
    cue.dispatched = true;
    const record = { cueId: cue.cueId, at: now(), generation: session.generation, by: actor.id };
    session.dispatchLog.push(record);
    this.log(actor, "live.dispatch", "liveSession", session.id, { cueId: cue.cueId }, showId);
    return { cueId: cue.cueId, deduplicated: false, dispatchedAt: record.at, generation: session.generation };
  }

  // 自动同步失效后切换人工跟随：原因、起止位置、观众告知必须留痕。
  manualSwitch(showId, payload, actor) {
    const show = this.mustGet("shows", showId, "场次");
    this.requireVenueScope(actor, show, ["coordinator", "local-lead"]);
    const session = this.openSession(showId);
    requireFields(payload, ["action"]);

    if (payload.action === "start") {
      requireFields(payload, ["reason", "positionMs"]);
      if (typeof payload.audienceNotified !== "boolean") {
        throw new DomainError("missing-field", "必须记录是否已告知观众（audienceNotified）", 400);
      }
      if (session.mode === "manual") {
        throw new DomainError("already-manual", "已处于人工跟随模式", 409);
      }
      const record = {
        id: this.store.nextId("manual"),
        reason: payload.reason,
        startPositionMs: payload.positionMs,
        audienceNotified: payload.audienceNotified,
        noticeMessage: payload.noticeMessage || null,
        startedAt: now(),
        startedBy: actor.id,
        endedAt: null,
        endPositionMs: null,
      };
      session.manualSwitches.push(record);
      session.mode = "manual";
      this.log(actor, "live.manual-switch.start", "liveSession", session.id, {
        reason: record.reason,
        positionMs: record.startPositionMs,
        audienceNotified: record.audienceNotified,
      }, showId);
      return record;
    }

    if (payload.action === "end") {
      requireFields(payload, ["positionMs"]);
      const open = [...session.manualSwitches].reverse().find((entry) => !entry.endedAt);
      if (!open) {
        throw new DomainError("not-manual", "当前未处于人工跟随模式", 409);
      }
      open.endedAt = now();
      open.endPositionMs = payload.positionMs;
      session.mode = "auto";
      this.log(actor, "live.manual-switch.end", "liveSession", session.id, {
        switchId: open.id,
        positionMs: open.endPositionMs,
      }, showId);
      return open;
    }

    throw new DomainError("unknown-action", `未知的切换动作: ${payload.action}`, 400);
  }

  // ---- 投诉追溯与供给缺口 ----------------------------------------------------

  fileComplaint(showId, payload, actor) {
    this.mustGet("shows", showId, "场次");
    requireFields(payload, ["summary"]);
    const complaint = this.store.insert("complaints", {
      id: this.store.nextId("complaint"),
      showId,
      audienceId: payload.audienceId || null,
      summary: payload.summary,
      channel: payload.channel || "onsite",
      status: "open",
      filedAt: now(),
      remediation: null,
    });
    this.log(actor, "complaint.file", "complaint", complaint.id, { summary: complaint.summary }, showId);
    return complaint;
  }

  remediateComplaint(complaintId, payload, actor) {
    this.requireRole(actor, "coordinator");
    const complaint = this.mustGet("complaints", complaintId, "投诉");
    requireFields(payload, ["actions", "outcome"]);
    complaint.status = "resolved";
    complaint.remediation = { actions: payload.actions, outcome: payload.outcome, by: actor.id, at: now() };
    this.log(actor, "complaint.remediate", "complaint", complaint.id, { outcome: payload.outcome }, complaint.showId);
    return complaint;
  }

  // 从一条投诉还原当晚事实：台本版本、辅助内容、人员排班、设备检查、
  // 临场切换与补救结果，以及该场次的全部审计事件。
  traceComplaint(complaintId, actor) {
    this.requireRole(actor, "coordinator");
    const complaint = this.mustGet("complaints", complaintId, "投诉");
    const show = this.mustGet("shows", complaint.showId, "场次");
    const version = this.store.get("scriptVersions", show.scriptVersionId);
    const assets = this.store.filter("assets", (a) => a.showId === show.id);
    const sessions = this.store.filter("liveSessions", (s) => s.showId === show.id);
    return {
      complaint,
      show: {
        id: show.id,
        productionId: show.productionId,
        city: show.city,
        venueId: show.venueId,
        startsAt: show.startsAt,
        status: show.status,
      },
      scriptVersion: version && {
        id: version.id,
        version: version.version,
        changedKeys: version.changedKeys,
        changeKinds: version.changeKinds,
        createdAt: version.createdAt,
      },
      assets: assets.map((asset) => ({
        id: asset.id,
        type: asset.type,
        language: asset.language,
        status: asset.status,
        publishedVersion: asset.publishedVersion,
        confirmations: asset.confirmations,
        recalls: asset.recalls,
        cueCount: asset.cues.length,
      })),
      staffing: assets
        .filter((asset) => asset.type === "sign-assignment")
        .map((asset) => ({ id: asset.id, assignment: asset.assignment, confirmations: asset.confirmations })),
      rehearsalVerifications: this.store.filter("rehearsalVerifications", (r) => r.showId === show.id),
      deviceChecks: this.store
        .filter("devices", (d) => d.showId === show.id)
        .map((d) => ({ id: d.id, kind: d.kind, label: d.label, status: d.status, checks: d.checks })),
      live: sessions.map((session) => ({
        id: session.id,
        mode: session.mode,
        state: session.state,
        events: session.events,
        realignments: session.realignments,
        manualSwitches: session.manualSwitches,
        dispatchCount: session.dispatchLog.length,
      })),
      audit: this.store.auditLog.filter((entry) => entry.showId === show.id),
    };
  }

  gapsForShow(show) {
    const gaps = [];
    const demand = show.demand || {};
    const devices = this.store.filter("devices", (d) => d.showId === show.id);
    const readyCount = (kind) => devices.filter((d) => d.kind === kind && d.status === "ready").length;
    const hasPublished = (type) =>
      this.store.filter("assets", (a) => a.showId === show.id && a.type === type && a.status === "published").length > 0;

    if ((demand.caption || 0) > 0 && !hasPublished("caption")) {
      gaps.push({ kind: "caption-track", detail: "有字幕需求但无已发布的字幕轨" });
    }
    if ((demand.audioDescription || 0) > 0 && !hasPublished("audio-description")) {
      gaps.push({ kind: "audio-description-script", detail: "有口述需求但无已发布的口述稿" });
    }
    if ((demand.sign || 0) > 0 && !hasPublished("sign-assignment")) {
      gaps.push({ kind: "sign-interpreter", detail: "有手语需求但无已发布的译员排班" });
    }
    if ((demand.caption || 0) > readyCount("caption-receiver")) {
      gaps.push({
        kind: "caption-receiver",
        detail: "字幕接收设备不足",
        needed: demand.caption,
        available: readyCount("caption-receiver"),
      });
    }
    if ((demand.audioDescription || 0) > readyCount("ad-headset")) {
      gaps.push({
        kind: "ad-headset",
        detail: "口述耳机不足",
        needed: demand.audioDescription,
        available: readyCount("ad-headset"),
      });
    }
    const verified = this.store.filter("rehearsalVerifications", (r) => r.showId === show.id).some((r) => r.ok);
    if (!verified) {
      gaps.push({ kind: "rehearsal-verification", detail: "缺少通过的彩排核验" });
    }
    return gaps;
  }

  // 按城市聚合供给缺口；同一城市两个及以上场次出现缺口记为反复缺口。
  supplyGaps(actor) {
    this.requireRole(actor, "coordinator");
    const byCity = new Map();
    for (const show of this.store.all("shows")) {
      const gaps = this.gapsForShow(show);
      let entry = byCity.get(show.city);
      if (!entry) {
        entry = { city: show.city, totalShows: 0, showsWithGaps: 0, gaps: [] };
        byCity.set(show.city, entry);
      }
      entry.totalShows += 1;
      if (gaps.length > 0) {
        entry.showsWithGaps += 1;
        entry.gaps.push({ showId: show.id, gaps });
      }
    }
    return [...byCity.values()].map((entry) => ({ ...entry, recurring: entry.showsWithGaps >= 2 }));
  }

  auditTrail(actor, showId = null) {
    this.requireRole(actor, "coordinator");
    if (!showId) return this.store.auditLog;
    return this.store.auditLog.filter((entry) => entry.showId === showId);
  }
}

module.exports = {
  Coordinator,
  DomainError,
  ASSET_RULES,
  ROLE_BY_CHANGE_KIND,
  diffSegments,
  buildTimeline,
};
