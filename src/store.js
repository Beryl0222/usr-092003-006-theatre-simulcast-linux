"use strict";

const { notFound } = require("./util");

class Store {
  constructor(clock) {
    this.now = clock || (() => new Date().toISOString());
    this.data = new Map();
    this.counters = new Map();
    this.auditLog = [];
  }

  collection(name) {
    if (!this.data.has(name)) this.data.set(name, new Map());
    return this.data.get(name);
  }

  nextId(name) {
    const next = (this.counters.get(name) || 0) + 1;
    this.counters.set(name, next);
    return name + "-" + next;
  }

  insert(name, record) {
    const id = record.id || this.nextId(name);
    const stored = { ...record, id };
    this.collection(name).set(id, stored);
    return stored;
  }

  get(name, id) {
    const record = this.collection(name).get(id);
    if (!record) throw notFound("未找到 " + name + ": " + id);
    return record;
  }

  find(name, predicate) {
    return [...this.collection(name).values()].filter(predicate);
  }

  patch(name, id, changes) {
    const current = this.get(name, id);
    const updated = { ...current, ...changes, id };
    this.collection(name).set(id, updated);
    return updated;
  }

  audit(entry) {
    this.auditLog.push({ at: this.now(), ...entry });
  }
}

module.exports = { Store };
