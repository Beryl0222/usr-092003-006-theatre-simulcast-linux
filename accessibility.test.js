"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("./service");

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function api(base, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

const SEGMENTS = [
  { id: "s1", startSec: 0, endSec: 600 },
  { id: "s2", startSec: 600, endSec: 1200 },
  { id: "s3", startSec: 1200, endSec: 1800 },
];

async function seed(base) {
  const production = (await api(base, "POST", "/productions", { title: "茶馆" })).data;
  const city = (await api(base, "POST", "/cities", { name: "上海" })).data;
  const venue = (await api(base, "POST", "/venues", { cityId: city.id, name: "上海大剧院" })).data;
  await api(base, "POST", `/productions/${production.id}/script-versions`, { segments: SEGMENTS });
  return { production, city, venue };
}

async function publishAsset(base, input, roles) {
  const asset = (await api(base, "POST", "/assets", input)).data;
  assert.equal((await api(base, "POST", `/assets/${asset.id}/submit`)).status, 200);
  for (const role of roles) {
    const res = await api(base, "POST", `/assets/${asset.id}/approvals`, { role, by: role + "-1" });
    assert.equal(res.status, 200, JSON.stringify(res.data));
  }
  const published = await api(base, "POST", `/assets/${asset.id}/publish`, { by: "统筹" });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  return published.data;
}

test("台本变更只召回受影响的辅助内容", async () => {
  await withServer(async (base) => {
    const { production, venue } = await seed(base);
    const caption = await publishAsset(base, {
      productionId: production.id, type: "caption", locale: "zh",
      segmentRefs: ["s1", "s2"], content: "第一二幕字幕",
    }, ["translator", "director"]);
    const ad = await publishAsset(base, {
      productionId: production.id, type: "audio_description",
      segmentRefs: ["s2"], content: "第二幕口述稿",
    }, ["translator", "director"]);
    const device = await publishAsset(base, {
      productionId: production.id, type: "device", venueId: venue.id,
      deviceType: "字幕接收机", count: 50,
    }, ["local_manager"]);
    const interpreter = await publishAsset(base, {
      productionId: production.id, type: "sign_interpreter", venueId: venue.id,
      assignees: ["译员甲"],
    }, ["director", "local_manager"]);

    // 台词改了第一幕台词：只召回覆盖 s1 的字幕。
    const lineChange = await api(base, "POST", `/productions/${production.id}/script-versions`, {
      segments: SEGMENTS,
      changedSegments: [{ segmentId: "s1", changeKind: "line" }],
    });
    assert.equal(lineChange.status, 201);
    assert.deepEqual(lineChange.data.recalled.map((a) => a.id), [caption.id]);
    assert.equal((await api(base, "GET", `/assets/${ad.id}`)).data.status, "published");
    assert.equal((await api(base, "GET", `/assets/${device.id}`)).data.status, "published");

    // 第三幕时长变化：召回覆盖全场的手语排班，不波及只覆盖 s2 且有台词敏感但段落未变的口述稿。
    const durationChange = await api(base, "POST", `/productions/${production.id}/script-versions`, {
      segments: SEGMENTS,
      changedSegments: [{ segmentId: "s3", changeKind: "duration" }],
    });
    assert.deepEqual(durationChange.data.recalled.map((a) => a.id), [interpreter.id]);
    assert.equal((await api(base, "GET", `/assets/${ad.id}`)).data.status, "published");
  });
});

test("按职责确认后才能发布，召回后需修订重审", async () => {
  await withServer(async (base) => {
    const { production } = await seed(base);
    const asset = (await api(base, "POST", "/assets", {
      productionId: production.id, type: "caption", locale: "zh",
      segmentRefs: ["s1"], content: "旧字幕稿",
    })).data;
    await api(base, "POST", `/assets/${asset.id}/submit`);

    const wrongRole = await api(base, "POST", `/assets/${asset.id}/approvals`, { role: "local_manager", by: "x" });
    assert.equal(wrongRole.status, 403);
    const early = await api(base, "POST", `/assets/${asset.id}/publish`, {});
    assert.equal(early.status, 409);

    await api(base, "POST", `/assets/${asset.id}/approvals`, { role: "translator", by: "翻译甲" });
    const duplicate = await api(base, "POST", `/assets/${asset.id}/approvals`, { role: "translator", by: "翻译乙" });
    assert.equal(duplicate.status, 409);
    const stillEarly = await api(base, "POST", `/assets/${asset.id}/publish`, {});
    assert.equal(stillEarly.status, 409);

    await api(base, "POST", `/assets/${asset.id}/approvals`, { role: "director", by: "导演" });
    const published = await api(base, "POST", `/assets/${asset.id}/publish`, { by: "统筹" });
    assert.equal(published.status, 200);

    // 台词变更召回后，修订产生新版本，需重新走确认流。
    await api(base, "POST", `/productions/${production.id}/script-versions`, {
      segments: SEGMENTS,
      changedSegments: [{ segmentId: "s1", changeKind: "line" }],
    });
    assert.equal((await api(base, "GET", `/assets/${asset.id}`)).data.status, "recalled");

    const revised = await api(base, "POST", `/assets/${asset.id}/revise`, { content: "新字幕稿" });
    assert.equal(revised.status, 201);
    assert.equal(revised.data.version, 2);
    assert.equal(revised.data.status, "draft");
    await api(base, "POST", `/assets/${revised.data.id}/submit`);
    await api(base, "POST", `/assets/${revised.data.id}/approvals`, { role: "translator", by: "翻译甲" });
    await api(base, "POST", `/assets/${revised.data.id}/approvals`, { role: "director", by: "导演" });
    const republished = await api(base, "POST", `/assets/${revised.data.id}/publish`, {});
    assert.equal(republished.status, 200);
    assert.equal(republished.data.version, 2);
  });
});

test("暂停、跳段、返场后提示重新对齐，迟到提示不重复播出", async () => {
  await withServer(async (base) => {
    const { production, city, venue } = await seed(base);
    await publishAsset(base, {
      productionId: production.id, type: "caption", locale: "zh",
      segmentRefs: ["s1", "s2", "s3"], content: "全场字幕",
    }, ["translator", "director"]);
    const performance = (await api(base, "POST", "/performances", {
      productionId: production.id, cityId: city.id, venueId: venue.id,
      scheduledAt: "2026-10-01T19:30:00+08:00",
    })).data;

    const cueOf = async (segmentId) => {
      const cues = (await api(base, "GET", `/performances/${performance.id}/cues`)).data.cues;
      return cues.find((c) => c.segmentId === segmentId);
    };
    assert.equal((await cueOf("s2")).effectiveAtSec, 600);

    // 第 300 秒暂停 120 秒：其后提示顺延。
    await api(base, "POST", `/performances/${performance.id}/events`, { type: "pause", atSec: 300, durationSec: 120 });
    assert.equal((await cueOf("s1")).effectiveAtSec, 0);
    assert.equal((await cueOf("s2")).effectiveAtSec, 720);
    assert.equal((await cueOf("s3")).effectiveAtSec, 1320);

    const c1 = (await cueOf("s1")).id;
    const c2 = (await cueOf("s2")).id;
    const c3 = (await cueOf("s3")).id;

    const first = await api(base, "POST", `/performances/${performance.id}/dispatches`, { cueIds: [c1] });
    assert.deepEqual(first.data.sent.map((c) => c.cueId), [c1]);

    // 网络恢复后迟到的批次重复携带 c1：被抑制，不重复播出。
    const replay = await api(base, "POST", `/performances/${performance.id}/dispatches`, { cueIds: [c1, c2] });
    assert.deepEqual(replay.data.suppressed, [{ cueId: c1, reason: "late_replay" }]);
    assert.deepEqual(replay.data.sent.map((c) => c.cueId), [c2]);

    // 跳过 600-900 秒：c2 作废，c3 提前 300 秒。
    await api(base, "POST", `/performances/${performance.id}/events`, { type: "skip", fromSec: 600, toSec: 900 });
    assert.equal((await cueOf("s2")).status, "skipped");
    assert.equal((await cueOf("s3")).effectiveAtSec, 1020);
    const skipped = await api(base, "POST", `/performances/${performance.id}/dispatches`, { cueIds: [c2] });
    assert.deepEqual(skipped.data.suppressed, [{ cueId: c2, reason: "skipped_segment" }]);

    // 返场 300 秒发生在 1500 秒处：c3 在其前，不受影响。
    await api(base, "POST", `/performances/${performance.id}/events`, { type: "encore", atSec: 1500, durationSec: 300 });
    assert.equal((await cueOf("s3")).effectiveAtSec, 1020);
    assert.equal((await cueOf("s3")).status, "pending");
    const last = await api(base, "POST", `/performances/${performance.id}/dispatches`, { cueIds: [c3] });
    assert.deepEqual(last.data.sent, [{ cueId: c3, effectiveAtSec: 1020 }]);
  });
});

test("自动同步失效可切人工跟随，切换全程留痕", async () => {
  await withServer(async (base) => {
    const { production, city, venue } = await seed(base);
    await publishAsset(base, {
      productionId: production.id, type: "caption", locale: "zh",
      segmentRefs: ["s1"], content: "字幕",
    }, ["translator", "director"]);
    const performance = (await api(base, "POST", "/performances", {
      productionId: production.id, cityId: city.id, venueId: venue.id,
      scheduledAt: "2026-10-02T19:30:00+08:00",
    })).data;
    const cueId = (await api(base, "GET", `/performances/${performance.id}/cues`)).data.cues[0].id;

    const missingReason = await api(base, "POST", `/performances/${performance.id}/manual-overrides`, {
      fromPositionSec: 120, operatorId: "现场甲",
      audienceNotice: { method: "场内广播", message: "字幕转为人工跟随" },
    });
    assert.equal(missingReason.status, 400);

    const started = await api(base, "POST", `/performances/${performance.id}/manual-overrides`, {
      reason: "自动同步链路中断", fromPositionSec: 120, operatorId: "现场甲",
      audienceNotice: { method: "场内广播", message: "字幕转为人工跟随" },
    });
    assert.equal(started.status, 201);

    const autoBlocked = await api(base, "POST", `/performances/${performance.id}/dispatches`, { cueIds: [cueId] });
    assert.equal(autoBlocked.status, 409);
    const manual = await api(base, "POST", `/performances/${performance.id}/dispatches`, { cueIds: [cueId], source: "manual" });
    assert.deepEqual(manual.data.sent.map((c) => c.cueId), [cueId]);

    const second = await api(base, "POST", `/performances/${performance.id}/manual-overrides`, {
      reason: "重复切换", fromPositionSec: 130, operatorId: "现场甲",
      audienceNotice: { method: "场内广播", message: "再次切换" },
    });
    assert.equal(second.status, 409);

    const ended = await api(base, "POST", `/manual-overrides/${started.data.id}/end`, { toPositionSec: 480 });
    assert.equal(ended.status, 200);
    assert.equal(ended.data.status, "closed");

    const audit = (await api(base, "GET", "/audit")).data.entries;
    const startEntry = audit.find((e) => e.kind === "manual_override_start");
    assert.equal(startEntry.reason, "自动同步链路中断");
    assert.equal(startEntry.fromPositionSec, 120);
    const endEntry = audit.find((e) => e.kind === "manual_override_end");
    assert.equal(endEntry.toPositionSec, 480);

    const autoAgain = await api(base, "POST", `/performances/${performance.id}/dispatches`, { cueIds: [cueId] });
    assert.deepEqual(autoAgain.data.suppressed, [{ cueId, reason: "late_replay" }]);
  });
});

test("剧场仅见本场资料与匿名需求，身份信息按同意范围开放", async () => {
  await withServer(async (base) => {
    const { production, city, venue } = await seed(base);
    const otherVenue = (await api(base, "POST", "/venues", { cityId: city.id, name: "另一剧场" })).data;
    await publishAsset(base, {
      productionId: production.id, type: "caption", locale: "zh",
      segmentRefs: ["s1"], content: "字幕稿",
    }, ["translator", "director"]);
    await publishAsset(base, {
      productionId: production.id, type: "device", venueId: venue.id,
      deviceType: "字幕接收机", count: 30,
    }, ["local_manager"]);
    await publishAsset(base, {
      productionId: production.id, type: "device", venueId: otherVenue.id,
      deviceType: "字幕接收机", count: 5,
    }, ["local_manager"]);
    const performance = (await api(base, "POST", "/performances", {
      productionId: production.id, cityId: city.id, venueId: venue.id,
      scheduledAt: "2026-10-03T19:30:00+08:00",
    })).data;

    const full = (await api(base, "POST", "/needs", {
      performanceId: performance.id,
      services: { captionLocale: "zh", device: true },
      seatRequirement: "轮椅位",
      pii: { disabilityDetail: "听力一级", contact: "13800000000" },
      consent: { scope: "full" },
    })).data;
    const minimal = (await api(base, "POST", "/needs", {
      performanceId: performance.id,
      services: { audioDescription: true },
      pii: { disabilityDetail: "视力二级", contact: "13900000000" },
      consent: { scope: "service_only" },
    })).data;

    const pack = await api(base, "GET", `/performances/${performance.id}/venue-pack?venueId=${venue.id}`);
    assert.equal(pack.status, 200);
    assert.equal(pack.data.demandSummary.captions.zh, 1);
    assert.equal(pack.data.demandSummary.audioDescription, 1);
    assert.equal(pack.data.demandSummary.devices, 1);
    assert.equal(pack.data.demandSummary.seats["轮椅位"], 1);
    // 本剧场设备在内，其他剧场设备不在内。
    assert.equal(pack.data.assets.filter((a) => a.type === "device").length, 1);
    const raw = JSON.stringify(pack.data);
    for (const secret of ["听力一级", "视力二级", "13800000000", "13900000000"]) {
      assert.ok(!raw.includes(secret), "资料包不应包含身份信息: " + secret);
    }

    const denied = await api(base, "GET", `/performances/${performance.id}/venue-pack?venueId=${otherVenue.id}`);
    assert.equal(denied.status, 403);

    const fullPii = (await api(base, "GET", `/needs/${full.id}/pii?requester=统筹员`)).data;
    assert.equal(fullPii.contact, "13800000000");
    assert.equal(fullPii.disabilityDetail, "听力一级");
    const minimalPii = (await api(base, "GET", `/needs/${minimal.id}/pii?requester=统筹员`)).data;
    assert.equal(minimalPii.contact, undefined);
    assert.equal(minimalPii.disabilityDetail, undefined);

    const audit = (await api(base, "GET", "/audit")).data.entries;
    assert.equal(audit.filter((e) => e.kind === "pii_access").length, 2);
  });
});

test("从投诉还原当晚台本、内容、排班、检查、切换与补救", async () => {
  await withServer(async (base) => {
    const { production, city, venue } = await seed(base);
    await publishAsset(base, {
      productionId: production.id, type: "caption", locale: "zh",
      segmentRefs: ["s1"], content: "字幕稿",
    }, ["translator", "director"]);
    await publishAsset(base, {
      productionId: production.id, type: "sign_interpreter", venueId: venue.id,
      assignees: ["译员甲"],
    }, ["director", "local_manager"]);
    await publishAsset(base, {
      productionId: production.id, type: "rehearsal_check", venueId: venue.id,
      content: "开演前设备核验通过",
    }, ["local_manager", "director"]);
    const performance = (await api(base, "POST", "/performances", {
      productionId: production.id, cityId: city.id, venueId: venue.id,
      scheduledAt: "2026-10-04T19:30:00+08:00",
    })).data;
    const cueId = (await api(base, "GET", `/performances/${performance.id}/cues`)).data.cues[0].id;
    await api(base, "POST", `/performances/${performance.id}/events`, { type: "pause", atSec: 100, durationSec: 60 });
    const override = (await api(base, "POST", `/performances/${performance.id}/manual-overrides`, {
      reason: "同步延迟过大", fromPositionSec: 100, operatorId: "现场甲",
      audienceNotice: { method: "场内广播", message: "字幕短暂人工跟随" },
    })).data;
    await api(base, "POST", `/performances/${performance.id}/dispatches`, { cueIds: [cueId], source: "manual" });
    await api(base, "POST", `/manual-overrides/${override.id}/end`, { toPositionSec: 200 });

    const complaint = (await api(base, "POST", "/complaints", {
      performanceId: performance.id, category: "字幕延迟", text: "开场字幕延迟约一分钟",
    })).data;
    await api(base, "POST", `/complaints/${complaint.id}/resolve`, {
      resolution: "确认为同步链路中断，已切换人工跟随并向观众致歉", by: "统筹员",
    });

    const trace = (await api(base, "GET", `/complaints/${complaint.id}/trace`)).data;
    assert.equal(trace.scriptVersion.version, 1);
    assert.equal(trace.assets.length, 3);
    assert.deepEqual(trace.roster[0].assignees, ["译员甲"]);
    assert.equal(trace.deviceChecks[0].content, "开演前设备核验通过");
    assert.equal(trace.liveEvents.length, 1);
    assert.equal(trace.liveEvents[0].type, "pause");
    assert.equal(trace.manualOverrides.length, 1);
    assert.equal(trace.manualOverrides[0].reason, "同步延迟过大");
    assert.equal(trace.manualOverrides[0].fromPositionSec, 100);
    assert.equal(trace.manualOverrides[0].toPositionSec, 200);
    assert.equal(trace.dispatches.sent, 1);
    assert.equal(trace.resolution.by, "统筹员");
  });
});

test("识别反复出现供给缺口的城市", async () => {
  await withServer(async (base) => {
    const production = (await api(base, "POST", "/productions", { title: "雷雨" })).data;
    await api(base, "POST", `/productions/${production.id}/script-versions`, { segments: SEGMENTS });
    await publishAsset(base, {
      productionId: production.id, type: "caption", locale: "zh",
      segmentRefs: ["s1"], content: "字幕",
    }, ["translator", "director"]);

    const cityA = (await api(base, "POST", "/cities", { name: "城市甲" })).data;
    const venueA = (await api(base, "POST", "/venues", { cityId: cityA.id, name: "甲剧场" })).data;
    await publishAsset(base, {
      productionId: production.id, type: "device", venueId: venueA.id,
      deviceType: "字幕接收机", count: 2,
    }, ["local_manager"]);
    // 同一城市两场都设备不足、都缺英文字幕、都有同类致命投诉。
    for (const date of ["2026-10-05", "2026-10-06"]) {
      const performance = (await api(base, "POST", "/performances", {
        productionId: production.id, cityId: cityA.id, venueId: venueA.id,
        scheduledAt: date + "T19:30:00+08:00",
      })).data;
      for (let i = 0; i < 3; i += 1) {
        await api(base, "POST", "/needs", {
          performanceId: performance.id, services: { device: true }, consent: { scope: "service_only" },
        });
      }
      await api(base, "POST", "/needs", {
        performanceId: performance.id, services: { captionLocale: "en" }, consent: { scope: "service_only" },
      });
      await api(base, "POST", "/complaints", {
        performanceId: performance.id, category: "设备故障", text: "接收机无法开机",
      });
    }

    const cityB = (await api(base, "POST", "/cities", { name: "城市乙" })).data;
    const venueB = (await api(base, "POST", "/venues", { cityId: cityB.id, name: "乙剧场" })).data;
    await publishAsset(base, {
      productionId: production.id, type: "device", venueId: venueB.id,
      deviceType: "字幕接收机", count: 2,
    }, ["local_manager"]);
    const onlyShow = (await api(base, "POST", "/performances", {
      productionId: production.id, cityId: cityB.id, venueId: venueB.id,
      scheduledAt: "2026-10-07T19:30:00+08:00",
    })).data;
    for (let i = 0; i < 3; i += 1) {
      await api(base, "POST", "/needs", {
        performanceId: onlyShow.id, services: { device: true }, consent: { scope: "service_only" },
      });
    }

    const gapsA = (await api(base, "GET", `/cities/${cityA.id}/gaps`)).data;
    assert.ok(gapsA.repeatedGaps.includes("device_shortage"));
    assert.ok(gapsA.repeatedGaps.includes("caption_locale_missing:en"));
    assert.ok(gapsA.repeatedGaps.includes("complaint:设备故障"));
    const shortage = gapsA.gaps.find((g) => g.kind === "device_shortage");
    assert.equal(shortage.occurrences, 2);
    assert.equal(shortage.performanceIds.length, 2);

    const gapsB = (await api(base, "GET", `/cities/${cityB.id}/gaps`)).data;
    assert.deepEqual(gapsB.repeatedGaps, []);
    assert.equal(gapsB.gaps.find((g) => g.kind === "device_shortage").occurrences, 1);
  });
});
