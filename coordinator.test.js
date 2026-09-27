"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { Store } = require("./src/store");
const { Coordinator } = require("./src/coordinator");

const coordinator = { id: "u-coord", role: "coordinator" };
const translator = { id: "u-trans", role: "translator" };
const director = { id: "u-dir", role: "director" };
const localLead = { id: "u-local", role: "local-lead" };
const venueStaff = { id: "u-venue", role: "venue-staff", venueId: "venue-sh-1" };

const SEGMENTS_V1 = [
  { key: "s1", text: "开场白", blocking: "台中", durationMs: 1000 },
  { key: "s2", text: "独白", blocking: "台左", durationMs: 2000 },
  { key: "s3", text: "谢幕", blocking: "台前", durationMs: 1000 },
];

function setupShow() {
  const c = new Coordinator(new Store());
  const production = c.createProduction({ title: "不眠之夜", originCity: "北京" }, coordinator);
  const { version } = c.registerScriptVersion(production.id, { segments: SEGMENTS_V1 }, director);
  const show = c.scheduleShow(
    { productionId: production.id, city: "上海", venueId: "venue-sh-1", startsAt: "2026-10-01T19:30:00+08:00" },
    coordinator,
  );
  return { c, production, version, show };
}

function setupPublishedCaption() {
  const ctx = setupShow();
  const track = ctx.c.registerAsset(
    ctx.show.id,
    {
      type: "caption",
      language: "zh",
      cues: [
        { segmentKey: "s1", text: "字幕一", offsetMs: 0 },
        { segmentKey: "s2", text: "字幕二", offsetMs: 1000 },
        { segmentKey: "s3", text: "字幕三", offsetMs: 3000 },
      ],
    },
    translator,
  );
  ctx.c.confirmAsset(track.id, { role: "translator" }, translator);
  ctx.c.confirmAsset(track.id, { role: "director" }, director);
  ctx.c.publishAsset(track.id, coordinator);
  return { ...ctx, track };
}

test("台本变更只召回受影响内容，并按职责重置确认", () => {
  const { c, production, show, track } = setupPublishedCaption();

  // 仅 s2 走位变化：台词与时长不变。
  const { version, recalls } = c.registerScriptVersion(
    production.id,
    {
      segments: [
        SEGMENTS_V1[0],
        { key: "s2", text: "独白", blocking: "台右", durationMs: 2000 },
        SEGMENTS_V1[2],
      ],
    },
    director,
  );

  assert.equal(version.version, 2);
  assert.deepEqual(version.changedKeys, ["s2"]);
  assert.deepEqual(version.changeKinds, ["blocking"]);
  assert.equal(recalls.length, 1);
  assert.equal(recalls[0].showId, show.id);

  const updated = c.store.get("assets", track.id);
  assert.equal(updated.status, "needs-revision");
  assert.deepEqual(
    updated.cues.map((cue) => cue.status),
    ["active", "recalled", "active"],
    "只有引用 s2 的提示被召回",
  );
  assert.ok(updated.confirmations.translator, "台词未变，翻译确认保留");
  assert.equal(updated.confirmations.director, undefined, "走位变化，导演确认被重置");

  // 有召回内容时不能发布；未被召回的提示不允许借修订改动。
  assert.throws(() => c.publishAsset(track.id, coordinator), /召回/);
  assert.throws(
    () => c.reviseAsset(track.id, { cues: [{ cueId: track.cues[0].cueId, text: "篡改" }] }, translator),
    /未被召回/,
  );

  c.reviseAsset(track.id, { cues: [{ cueId: track.cues[1].cueId, text: "字幕二·新走位" }] }, translator);
  assert.throws(() => c.publishAsset(track.id, coordinator), /director/);
  c.confirmAsset(track.id, { role: "director" }, director);
  const republished = c.publishAsset(track.id, coordinator);
  assert.equal(republished.status, "published");
  assert.equal(republished.publishedVersion, 2);
});

test("台词变化召回翻译确认，时长变化召回当地负责人确认", () => {
  const { c, production, track } = setupPublishedCaption();

  c.registerScriptVersion(
    production.id,
    {
      segments: [
        SEGMENTS_V1[0],
        { key: "s2", text: "独白·改词", blocking: "台左", durationMs: 2500 },
        SEGMENTS_V1[2],
      ],
    },
    director,
  );

  const updated = c.store.get("assets", track.id);
  assert.equal(updated.confirmations.translator, undefined, "台词变化，翻译确认被重置");
  assert.equal(updated.confirmations.director, undefined, "导演确认被重置");
  const recall = updated.recalls[updated.recalls.length - 1];
  assert.deepEqual([...recall.resetRoles].sort(), ["director", "local-lead", "translator"]);
});

test("职责确认不齐不得发布", () => {
  const { c, show } = setupShow();
  const track = c.registerAsset(
    show.id,
    { type: "caption", language: "zh", cues: [{ segmentKey: "s1", text: "字幕一", offsetMs: 0 }] },
    translator,
  );
  c.confirmAsset(track.id, { role: "translator" }, translator);
  assert.throws(() => c.publishAsset(track.id, coordinator), /director/);
  // 翻译不能代替导演确认
  assert.throws(() => c.confirmAsset(track.id, { role: "director" }, translator), /本人职责/);
});

test("暂停与跳段触发重对齐，迟到的提示不重复播出", () => {
  const { c, show, track } = setupPublishedCaption();
  c.startLive(show.id, localLead);

  const [cue1, cue2, cue3] = track.cues.map((cue) => cue.cueId);
  const first = c.dispatchCue(show.id, { cueId: cue1 }, localLead);
  assert.equal(first.deduplicated, false);

  // 网络恢复后迟到的同一提示重放：去重，不再播出。
  const retry = c.dispatchCue(show.id, { cueId: cue1 }, localLead);
  assert.equal(retry.deduplicated, true);
  assert.ok(retry.firstDispatchedAt);

  // 暂停 1000ms → 4000ms：之后的未播提示平移 3000ms。
  c.liveEvent(show.id, { type: "pause", atMs: 1000 }, localLead);
  c.liveEvent(show.id, { type: "resume", atMs: 4000 }, localLead);
  let session = c.getLiveSession(show.id, localLead);
  const shifted = session.timeline.find((cue) => cue.cueId === cue3);
  assert.equal(shifted.plannedOffsetMs, 6000);
  const untouched = session.timeline.find((cue) => cue.cueId === cue2);
  assert.equal(untouched.plannedOffsetMs, 1000, "暂停点之前的提示不平移");

  // 跳段到 s3：s2 的未播提示作废，不能再播出。
  c.liveEvent(show.id, { type: "skip", toSegmentKey: "s3" }, localLead);
  assert.throws(() => c.dispatchCue(show.id, { cueId: cue2 }, localLead), /跳段/);

  // 返场留下重对齐记录。
  c.liveEvent(show.id, { type: "encore", atMs: 9000, note: "返场一段" }, localLead);
  session = c.getLiveSession(show.id, localLead);
  assert.deepEqual(
    session.realignments.map((entry) => entry.type),
    ["pause-resume", "skip", "encore"],
  );
});

test("人工跟随切换必须留痕：原因、起止位置、观众告知", () => {
  const { c, show } = setupPublishedCaption();
  c.startLive(show.id, localLead);

  assert.throws(
    () => c.manualSwitch(show.id, { action: "start", positionMs: 1200, audienceNotified: true }, localLead),
    /reason/,
  );
  assert.throws(
    () => c.manualSwitch(show.id, { action: "start", reason: "自动同步失联", positionMs: 1200 }, localLead),
    /观众|audienceNotified/,
  );

  const started = c.manualSwitch(
    show.id,
    { action: "start", reason: "自动同步失联", positionMs: 1200, audienceNotified: true, noticeMessage: "场灯提示+广播" },
    localLead,
  );
  assert.equal(c.getLiveSession(show.id, localLead).mode, "manual");
  assert.equal(started.audienceNotified, true);

  const ended = c.manualSwitch(show.id, { action: "end", positionMs: 5400 }, localLead);
  assert.equal(ended.endPositionMs, 5400);
  assert.ok(ended.endedAt);
  assert.equal(c.getLiveSession(show.id, localLead).mode, "auto");

  const audit = c.auditTrail(coordinator, show.id);
  assert.ok(audit.some((entry) => entry.action === "live.manual-switch.start" && entry.details.reason === "自动同步失联"));
  assert.ok(audit.some((entry) => entry.action === "live.manual-switch.end"));
});

test("剧场只见本场所资料与匿名需求，观众信息按同意范围开放", () => {
  const { c, show } = setupPublishedCaption();
  c.recordDemand(show.id, { caption: 12, audioDescription: 5 }, localLead);
  c.registerAudienceMember(
    show.id,
    { needs: ["caption"], contact: "13800000000", consent: { coordinator: true, venue: true, contact: true } },
    coordinator,
  );
  c.registerAudienceMember(
    show.id,
    { needs: ["audio-description"], contact: "13900000000", consent: { coordinator: true, venue: false, contact: false } },
    coordinator,
  );

  // 其他场所的工作人员拿不到本场所简报。
  const outsider = { id: "u-other", role: "venue-staff", venueId: "venue-other" };
  assert.throws(() => c.venueBrief("venue-sh-1", show.id, outsider), (error) => error.status === 403);

  const brief = c.venueBrief("venue-sh-1", show.id, venueStaff);
  assert.equal(brief.demand.caption, 12);
  assert.equal(brief.assets.length, 1);
  assert.ok(!("audience" in brief), "简报不含观众个人信息");

  // 同意范围：剧场只能看到同意对场所开放的观众；联系方式需单独同意。
  const venueView = c.listAudienceMembers(show.id, venueStaff);
  assert.equal(venueView.length, 1);
  assert.equal(venueView[0].contact, "13800000000");

  const coordinatorView = c.listAudienceMembers(show.id, coordinator);
  assert.equal(coordinatorView.length, 2);
  assert.equal(coordinatorView[1].contact, null, "未同意开放联系方式则置空");
});

test("从投诉还原当晚事实：版本、内容、排班、设备、切换与补救", () => {
  const { c, show } = setupPublishedCaption();
  c.assignSign = c.registerAsset(
    show.id,
    { type: "sign-assignment", assignment: { interpreterName: "张老师", language: "CSL" } },
    localLead,
  );
  c.confirmAsset(c.assignSign.id, { role: "local-lead" }, localLead);
  c.publishAsset(c.assignSign.id, coordinator);

  const device = c.registerDevice(show.id, { kind: "caption-receiver", label: "接收机-01" }, venueStaff);
  c.checkDevice(device.id, { ok: true, note: "开场前自检" }, venueStaff);
  c.submitRehearsalVerification(show.id, { items: [{ name: "字幕链路", ok: true }] }, localLead);

  c.startLive(show.id, localLead);
  c.manualSwitch(
    show.id,
    { action: "start", reason: "自动同步失联", positionMs: 1200, audienceNotified: true },
    localLead,
  );
  c.manualSwitch(show.id, { action: "end", positionMs: 5400 }, localLead);

  const complaint = c.fileComplaint(show.id, { summary: "字幕与舞台不一致", channel: "hotline" }, { id: "anon", role: "anonymous" });
  c.remediateComplaint(complaint.id, { actions: "更换接收设备并退款", outcome: "观众接受" }, coordinator);

  const trace = c.traceComplaint(complaint.id, coordinator);
  assert.equal(trace.scriptVersion.version, 1);
  assert.equal(trace.assets.find((a) => a.type === "caption").status, "published");
  assert.equal(trace.staffing[0].assignment.interpreterName, "张老师");
  assert.equal(trace.deviceChecks[0].checks.length, 1);
  assert.equal(trace.live[0].manualSwitches.length, 1);
  assert.equal(trace.live[0].manualSwitches[0].reason, "自动同步失联");
  assert.equal(trace.complaint.remediation.outcome, "观众接受");
  assert.ok(trace.audit.some((entry) => entry.action === "live.manual-switch.start"));
  assert.ok(trace.audit.some((entry) => entry.action === "device.check"));
});

test("供给缺口按城市聚合并识别反复缺口", () => {
  const c = new Coordinator(new Store());
  const production = c.createProduction({ title: "不眠之夜", originCity: "北京" }, coordinator);
  c.registerScriptVersion(production.id, { segments: SEGMENTS_V1 }, director);

  // 上海两场：字幕需求 10，可用接收机 3，且无彩排核验 → 缺口。
  for (const startsAt of ["2026-10-01T19:30:00+08:00", "2026-10-02T19:30:00+08:00"]) {
    const show = c.scheduleShow(
      { productionId: production.id, city: "上海", venueId: "venue-sh-1", startsAt },
      coordinator,
    );
    c.recordDemand(show.id, { caption: 10 }, localLead);
    for (let i = 0; i < 3; i += 1) {
      const device = c.registerDevice(show.id, { kind: "caption-receiver", label: `接收机-${i}` }, localLead);
      c.checkDevice(device.id, { ok: true }, localLead);
    }
  }

  // 杭州一场：需求与供给匹配且通过彩排核验 → 无缺口。
  const hangzhou = c.scheduleShow(
    { productionId: production.id, city: "杭州", venueId: "venue-hz-1", startsAt: "2026-10-03T19:30:00+08:00" },
    coordinator,
  );
  c.recordDemand(hangzhou.id, { caption: 2 }, localLead);
  const track = c.registerAsset(
    hangzhou.id,
    { type: "caption", language: "zh", cues: [{ segmentKey: "s1", text: "字幕一", offsetMs: 0 }] },
    translator,
  );
  c.confirmAsset(track.id, { role: "translator" }, translator);
  c.confirmAsset(track.id, { role: "director" }, director);
  c.publishAsset(track.id, coordinator);
  for (let i = 0; i < 2; i += 1) {
    const device = c.registerDevice(hangzhou.id, { kind: "caption-receiver", label: `接收机-${i}` }, localLead);
    c.checkDevice(device.id, { ok: true }, localLead);
  }
  c.submitRehearsalVerification(hangzhou.id, { items: [{ name: "字幕链路", ok: true }] }, localLead);

  const gaps = c.supplyGaps(coordinator);
  const shanghai = gaps.find((entry) => entry.city === "上海");
  assert.equal(shanghai.showsWithGaps, 2);
  assert.equal(shanghai.recurring, true, "上海反复出现供给缺口");
  assert.ok(shanghai.gaps[0].gaps.some((gap) => gap.kind === "caption-receiver" && gap.available === 3));

  const hz = gaps.find((entry) => entry.city === "杭州");
  assert.equal(hz.showsWithGaps, 0);
  assert.equal(hz.recurring, false);
});
