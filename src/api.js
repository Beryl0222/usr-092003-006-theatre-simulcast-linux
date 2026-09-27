"use strict";

const { requireFields } = require("./util");
const scripting = require("./scripting");
const assets = require("./assets");
const live = require("./live");
const privacy = require("./privacy");
const trace = require("./trace");

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("请求体不是有效 JSON");
    err.status = 400;
    err.code = "bad_json";
    throw err;
  }
}

function matchPattern(pattern, path) {
  const wanted = pattern.split("/");
  const actual = path.split("/");
  if (wanted.length !== actual.length) return null;
  const params = {};
  for (let i = 0; i < wanted.length; i += 1) {
    if (wanted[i].startsWith(":")) params[wanted[i].slice(1)] = decodeURIComponent(actual[i]);
    else if (wanted[i] !== actual[i]) return null;
  }
  return params;
}

function createApi(store) {
  const routes = [
    ["POST", "/productions", 201, ({ body }) => {
      requireFields(body, ["title"]);
      const production = store.insert("production", { title: body.title, createdAt: store.now() });
      store.audit({ kind: "production_registered", productionId: production.id });
      return production;
    }],
    ["POST", "/cities", 201, ({ body }) => {
      requireFields(body, ["name"]);
      const city = store.insert("city", { name: body.name, createdAt: store.now() });
      store.audit({ kind: "city_registered", cityId: city.id });
      return city;
    }],
    ["POST", "/venues", 201, ({ body }) => {
      requireFields(body, ["cityId", "name"]);
      store.get("city", body.cityId);
      const venue = store.insert("venue", { cityId: body.cityId, name: body.name, createdAt: store.now() });
      store.audit({ kind: "venue_registered", venueId: venue.id, cityId: body.cityId });
      return venue;
    }],
    ["POST", "/productions/:id/script-versions", 201, ({ params, body }) =>
      scripting.registerScriptVersion(store, { ...body, productionId: params.id })],
    ["POST", "/assets", 201, ({ body }) => assets.registerAsset(store, body)],
    ["GET", "/assets/:id", 200, ({ params }) => store.get("asset", params.id)],
    ["POST", "/assets/:id/revise", 201, ({ params, body }) => assets.reviseAsset(store, params.id, body)],
    ["POST", "/assets/:id/submit", 200, ({ params }) => assets.submitAsset(store, params.id)],
    ["POST", "/assets/:id/approvals", 200, ({ params, body }) => assets.approveAsset(store, params.id, body)],
    ["POST", "/assets/:id/publish", 200, ({ params, body }) => assets.publishAsset(store, params.id, body)],
    ["POST", "/performances", 201, ({ body }) => live.schedulePerformance(store, body)],
    ["GET", "/performances/:id", 200, ({ params }) => live.performanceView(store, params.id)],
    ["GET", "/performances/:id/cues", 200, ({ params }) => ({
      cues: live.alignCues(store.get("performance", params.id)),
    })],
    ["POST", "/performances/:id/events", 201, ({ params, body }) =>
      live.recordLiveEvent(store, params.id, body)],
    ["POST", "/performances/:id/dispatches", 200, ({ params, body }) =>
      live.dispatchCues(store, params.id, body)],
    ["POST", "/performances/:id/manual-overrides", 201, ({ params, body }) =>
      live.startManualOverride(store, params.id, body)],
    ["POST", "/manual-overrides/:id/end", 200, ({ params, body }) =>
      live.endManualOverride(store, params.id, body)],
    ["POST", "/needs", 201, ({ body }) => privacy.registerNeed(store, body)],
    ["GET", "/performances/:id/venue-pack", 200, ({ params, query }) =>
      privacy.venuePack(store, params.id, query.venueId)],
    ["GET", "/needs/:id/pii", 200, ({ params, query }) => privacy.needPii(store, params.id, query)],
    ["POST", "/complaints", 201, ({ body }) => trace.fileComplaint(store, body)],
    ["POST", "/complaints/:id/resolve", 200, ({ params, body }) =>
      trace.resolveComplaint(store, params.id, body)],
    ["GET", "/complaints/:id/trace", 200, ({ params }) => trace.complaintTrace(store, params.id)],
    ["GET", "/cities/:id/gaps", 200, ({ params }) => trace.cityGaps(store, params.id)],
    ["GET", "/audit", 200, () => ({ entries: store.auditLog })],
  ];

  return async function handle(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");
      for (const [method, pattern, status, handler] of routes) {
        if (method !== request.method) continue;
        const params = matchPattern(pattern, url.pathname);
        if (!params) continue;
        const body = request.method === "POST" ? await readBody(request) : {};
        const result = await handler({
          params,
          query: Object.fromEntries(url.searchParams),
          body,
        });
        sendJson(response, status, result);
        return true;
      }
      return false;
    } catch (err) {
      sendJson(response, err.status || 500, {
        error: { code: err.code || "internal", message: err.message },
      });
      return true;
    }
  };
}

module.exports = { createApi };
