"use strict";

const { badRequest, forbidden } = require("./util");

// 同意范围：service_only 仅用于现场服务协调，不含任何身份信息；
// coordinator_contact 允许统筹查看联系方式；full 允许查看障碍详情。
const CONSENT_SCOPES = ["service_only", "coordinator_contact", "full"];

function registerNeed(store, input) {
  if (!input.performanceId) throw badRequest("缺少场次编号");
  store.get("performance", input.performanceId);
  const services = input.services || {};
  const consent = input.consent || {};
  if (!CONSENT_SCOPES.includes(consent.scope)) {
    throw badRequest("同意范围无效，可选: " + CONSENT_SCOPES.join("/"));
  }
  const need = store.insert("need", {
    performanceId: input.performanceId,
    services: {
      captionLocale: services.captionLocale ?? null,
      audioDescription: !!services.audioDescription,
      signLanguage: !!services.signLanguage,
      device: !!services.device,
    },
    seatRequirement: input.seatRequirement ?? null,
    pii: {
      disabilityDetail: (input.pii && input.pii.disabilityDetail) ?? null,
      contact: (input.pii && input.pii.contact) ?? null,
    },
    consent: { scope: consent.scope, grantedAt: consent.grantedAt || store.now() },
  });
  store.audit({ kind: "need_registered", performanceId: input.performanceId, needId: need.id });
  return need;
}

function demandSummary(store, performanceId) {
  const needs = store.find("need", (n) => n.performanceId === performanceId);
  const summary = { audience: needs.length, captions: {}, audioDescription: 0, signLanguage: 0, devices: 0, seats: {} };
  for (const need of needs) {
    if (need.services.captionLocale) {
      summary.captions[need.services.captionLocale] =
        (summary.captions[need.services.captionLocale] || 0) + 1;
    }
    if (need.services.audioDescription) summary.audioDescription += 1;
    if (need.services.signLanguage) summary.signLanguage += 1;
    if (need.services.device) summary.devices += 1;
    if (need.seatRequirement) {
      summary.seats[need.seatRequirement] = (summary.seats[need.seatRequirement] || 0) + 1;
    }
  }
  return summary;
}

// 剧场视角的资料包：仅本场所需的辅助资料与匿名需求数量，不含任何观众身份信息。
function venuePack(store, performanceId, venueId) {
  if (!venueId) throw badRequest("缺少剧场编号");
  const performance = store.get("performance", performanceId);
  if (performance.venueId !== venueId) throw forbidden("该剧场无权查看此场次");
  const assets = performance.assetSnapshot.filter(
    (a) => a.venueId === null || a.venueId === venueId
  );
  return {
    performance: {
      id: performance.id,
      scheduledAt: performance.scheduledAt,
      cityId: performance.cityId,
      venueId: performance.venueId,
    },
    scriptVersionId: performance.scriptVersionId,
    assets,
    demandSummary: demandSummary(store, performanceId),
  };
}

function needPii(store, needId, input) {
  const need = store.get("need", needId);
  const requester = (input && input.requester) || "unknown";
  store.audit({ kind: "pii_access", needId, requester, scope: need.consent.scope });
  const base = {
    id: need.id,
    performanceId: need.performanceId,
    services: need.services,
    seatRequirement: need.seatRequirement,
    consentScope: need.consent.scope,
  };
  if (need.consent.scope === "full") {
    return { ...base, contact: need.pii.contact, disabilityDetail: need.pii.disabilityDetail };
  }
  if (need.consent.scope === "coordinator_contact") {
    return { ...base, contact: need.pii.contact };
  }
  return base;
}

module.exports = { CONSENT_SCOPES, registerNeed, demandSummary, venuePack, needPii };
