"use strict";

const http = require("node:http");

const { Store } = require("./src/store");
const { Coordinator, DomainError } = require("./src/coordinator");

const SERVICE_ID = "theatre-simulcast";
const SERVICE_NAME = "跨城剧场同步演播";

function healthPayload() {
  return { status: "ok", service: SERVICE_ID, name: SERVICE_NAME };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new DomainError("invalid-json", "请求体不是合法 JSON", 400));
      }
    });
    request.on("error", reject);
  });
}

// 调用者身份来自请求头：x-actor-id / x-actor-role / x-venue-id。
function actorFrom(request) {
  return {
    id: request.headers["x-actor-id"] || "anonymous",
    role: request.headers["x-actor-role"] || "anonymous",
    venueId: request.headers["x-venue-id"] || null,
  };
}

function createCoordinator() {
  return new Coordinator(new Store());
}

function createServer(coordinator = createCoordinator()) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp(
      "^" + pattern.replace(/:[^/]+/g, (match) => {
        keys.push(match.slice(1));
        return "([^/]+)";
      }) + "$",
    );
    routes.push({ method, regex, keys, handler });
  };
  const ok = (body, status = 200) => ({ status, body });

  route("GET", "/health", async () => ok(healthPayload()));

  // 制作与台本
  route("POST", "/productions", async (_req, _params, body, actor) =>
    ok(coordinator.createProduction(body, actor), 201));
  route("POST", "/productions/:id/script-versions", async (_req, params, body, actor) =>
    ok(coordinator.registerScriptVersion(params.id, body, actor), 201));

  // 场次
  route("POST", "/shows", async (_req, _params, body, actor) =>
    ok(coordinator.scheduleShow(body, actor), 201));
  route("GET", "/shows/:id", async (_req, params, _body, actor) =>
    ok(coordinator.getShowView(params.id, actor)));

  // 辅助内容：登记 / 确认 / 修订 / 发布
  route("POST", "/shows/:id/assets", async (_req, params, body, actor) =>
    ok(coordinator.registerAsset(params.id, body, actor), 201));
  route("POST", "/assets/:id/confirm", async (_req, params, body, actor) =>
    ok(coordinator.confirmAsset(params.id, body, actor)));
  route("POST", "/assets/:id/revise", async (_req, params, body, actor) =>
    ok(coordinator.reviseAsset(params.id, body, actor)));
  route("POST", "/assets/:id/publish", async (_req, params, _body, actor) =>
    ok(coordinator.publishAsset(params.id, actor)));

  // 设备 / 需求 / 彩排核验
  route("POST", "/shows/:id/devices", async (_req, params, body, actor) =>
    ok(coordinator.registerDevice(params.id, body, actor), 201));
  route("POST", "/devices/:id/checks", async (_req, params, body, actor) =>
    ok(coordinator.checkDevice(params.id, body, actor)));
  route("POST", "/shows/:id/demand", async (_req, params, body, actor) =>
    ok(coordinator.recordDemand(params.id, body, actor)));
  route("POST", "/shows/:id/rehearsal-verifications", async (_req, params, body, actor) =>
    ok(coordinator.submitRehearsalVerification(params.id, body, actor), 201));

  // 观众登记与同意范围
  route("POST", "/shows/:id/audience", async (_req, params, body, actor) =>
    ok(coordinator.registerAudienceMember(params.id, body, actor), 201));
  route("GET", "/shows/:id/audience", async (_req, params, _body, actor) =>
    ok(coordinator.listAudienceMembers(params.id, actor)));

  // 场所简报（仅本场所资料 + 匿名需求数量）
  route("GET", "/venues/:venueId/shows/:showId/brief", async (_req, params, _body, actor) =>
    ok(coordinator.venueBrief(params.venueId, params.showId, actor)));

  // 演出中：开始 / 事件 / 提示播出 / 人工跟随
  route("POST", "/shows/:id/live/start", async (_req, params, _body, actor) =>
    ok(coordinator.startLive(params.id, actor), 201));
  route("GET", "/shows/:id/live", async (_req, params, _body, actor) =>
    ok(coordinator.getLiveSession(params.id, actor)));
  route("POST", "/shows/:id/live/events", async (_req, params, body, actor) =>
    ok(coordinator.liveEvent(params.id, body, actor)));
  route("POST", "/shows/:id/live/dispatches", async (_req, params, body, actor) =>
    ok(coordinator.dispatchCue(params.id, body, actor)));
  route("POST", "/shows/:id/live/manual-switches", async (_req, params, body, actor) =>
    ok(coordinator.manualSwitch(params.id, body, actor)));

  // 投诉与追溯
  route("POST", "/shows/:id/complaints", async (_req, params, body, actor) =>
    ok(coordinator.fileComplaint(params.id, body, actor), 201));
  route("POST", "/complaints/:id/remediation", async (_req, params, body, actor) =>
    ok(coordinator.remediateComplaint(params.id, body, actor)));
  route("GET", "/complaints/:id/trace", async (_req, params, _body, actor) =>
    ok(coordinator.traceComplaint(params.id, actor)));

  // 分析与审计
  route("GET", "/analytics/supply-gaps", async (_req, _params, _body, actor) =>
    ok(coordinator.supplyGaps(actor)));
  route("GET", "/audit", async (_req, _params, _body, actor, url) =>
    ok(coordinator.auditTrail(actor, url.searchParams.get("showId"))));

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      for (const candidate of routes) {
        if (candidate.method !== request.method) continue;
        const match = candidate.regex.exec(url.pathname);
        if (!match) continue;
        const params = {};
        candidate.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1]);
        });
        const body = request.method === "GET" ? {} : await readBody(request);
        const result = await candidate.handler(request, params, body, actorFrom(request), url);
        sendJson(response, result.status, result.body);
        return;
      }
      sendJson(response, 404, { error: { code: "not-found", message: "路由不存在" } });
    } catch (error) {
      if (error instanceof DomainError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        sendJson(response, 500, { error: { code: "internal", message: "服务内部错误" } });
      }
    }
  });
}

if (require.main === module) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== SERVICE_ID) throw new Error("服务身份不一致");
    createCoordinator();
    process.stdout.write("基础检查通过\n");
  } else {
    const port = Number(process.env.PORT || 8000);
    createServer().listen(port, "127.0.0.1");
  }
}

module.exports = { SERVICE_ID, SERVICE_NAME, createServer, createCoordinator, healthPayload };
