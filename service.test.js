"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer, healthPayload } = require("./service");

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

const COORDINATOR = { "x-actor-id": "u-coord", "x-actor-role": "coordinator" };
const DIRECTOR = { "x-actor-id": "u-dir", "x-actor-role": "director" };

async function post(base, path, body, headers = COORDINATOR) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("健康检查返回稳定身份", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), healthPayload());
  });
});

test("未知路由返回不存在", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/unknown");
    assert.equal(response.status, 404);
  });
});

test("缺少角色的调用被拒绝", async () => {
  await withServer(async (base) => {
    const result = await post(base, "/productions", { title: "X", originCity: "北京" }, {});
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, "forbidden");
  });
});

test("端到端：排期、登记需求、缺口分析", async () => {
  await withServer(async (base) => {
    const production = await post(base, "/productions", { title: "不眠之夜", originCity: "北京" });
    assert.equal(production.status, 201);

    const scripted = await post(
      base,
      `/productions/${production.body.id}/script-versions`,
      { segments: [{ key: "s1", text: "开场白", blocking: "台中", durationMs: 1000 }] },
      DIRECTOR,
    );
    assert.equal(scripted.status, 201);
    assert.equal(scripted.body.version.version, 1);

    const show = await post(base, "/shows", {
      productionId: production.body.id,
      city: "上海",
      venueId: "venue-sh-1",
      startsAt: "2026-10-01T19:30:00+08:00",
    });
    assert.equal(show.status, 201);
    assert.equal(show.body.scriptVersionId, scripted.body.version.id);

    const demand = await post(
      base,
      `/shows/${show.body.id}/demand`,
      { caption: 10 },
      { "x-actor-id": "u-local", "x-actor-role": "local-lead" },
    );
    assert.equal(demand.status, 200);
    assert.equal(demand.body.caption, 10);

    const gapsResponse = await fetch(base + "/analytics/supply-gaps", { headers: COORDINATOR });
    assert.equal(gapsResponse.status, 200);
    const gaps = await gapsResponse.json();
    const shanghai = gaps.find((entry) => entry.city === "上海");
    assert.ok(shanghai.gaps[0].gaps.some((gap) => gap.kind === "caption-track"));
  });
});

test("提示播出幂等：网络恢复后的重放被去重", async () => {
  await withServer(async (base) => {
    const production = await post(base, "/productions", { title: "不眠之夜", originCity: "北京" });
    await post(
      base,
      `/productions/${production.body.id}/script-versions`,
      { segments: [{ key: "s1", text: "开场白", blocking: "台中", durationMs: 1000 }] },
      DIRECTOR,
    );
    const show = await post(base, "/shows", {
      productionId: production.body.id,
      city: "上海",
      venueId: "venue-sh-1",
      startsAt: "2026-10-01T19:30:00+08:00",
    });
    const track = await post(
      base,
      `/shows/${show.body.id}/assets`,
      { type: "caption", language: "zh", cues: [{ segmentKey: "s1", text: "字幕一", offsetMs: 0 }] },
      { "x-actor-id": "u-trans", "x-actor-role": "translator" },
    );
    const cueId = track.body.cues[0].cueId;
    await post(base, `/assets/${track.body.id}/confirm`, { role: "translator" }, {
      "x-actor-id": "u-trans",
      "x-actor-role": "translator",
    });
    await post(base, `/assets/${track.body.id}/confirm`, { role: "director" }, DIRECTOR);
    await post(base, `/assets/${track.body.id}/publish`, {});
    await post(base, `/shows/${show.body.id}/live/start`, {}, {
      "x-actor-id": "u-local",
      "x-actor-role": "local-lead",
    });

    const headers = { "x-actor-id": "u-local", "x-actor-role": "local-lead" };
    const first = await post(base, `/shows/${show.body.id}/live/dispatches`, { cueId }, headers);
    assert.equal(first.body.deduplicated, false);
    const replay = await post(base, `/shows/${show.body.id}/live/dispatches`, { cueId }, headers);
    assert.equal(replay.body.deduplicated, true);
  });
});
