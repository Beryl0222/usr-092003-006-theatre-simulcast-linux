"use strict";

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const badRequest = (message) => httpError(400, "bad_request", message);
const forbidden = (message) => httpError(403, "forbidden", message);
const notFound = (message) => httpError(404, "not_found", message);
const conflict = (message) => httpError(409, "conflict", message);

function requireFields(obj, fields) {
  for (const field of fields) {
    const value = obj[field];
    if (value === undefined || value === null || value === "") {
      throw badRequest("缺少字段: " + field);
    }
  }
}

function requireNumber(obj, field) {
  if (typeof obj[field] !== "number" || Number.isNaN(obj[field])) {
    throw badRequest("字段需要数字: " + field);
  }
}

module.exports = { httpError, badRequest, forbidden, notFound, conflict, requireFields, requireNumber };
