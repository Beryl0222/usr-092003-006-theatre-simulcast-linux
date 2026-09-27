"use strict";

// 简单的内存存储：集合 + 自增编号 + 追加式审计日志。
// 审计日志是事后追溯的事实来源，所有变更动作都必须写入。

class Store {
  constructor() {
    this.collections = new Map();
    this.counters = new Map();
    this.auditLog = [];
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return this.collections.get(name);
  }

  nextId(prefix) {
    const next = (this.counters.get(prefix) || 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}-${String(next).padStart(4, "0")}`;
  }

  insert(name, record) {
    this.collection(name).set(record.id, record);
    return record;
  }

  get(name, id) {
    return this.collection(name).get(id) || null;
  }

  all(name) {
    return [...this.collection(name).values()];
  }

  filter(name, predicate) {
    return this.all(name).filter(predicate);
  }

  audit(entry) {
    const record = {
      seq: this.auditLog.length + 1,
      at: entry.at || new Date().toISOString(),
      ...entry,
    };
    this.auditLog.push(record);
    return record;
  }
}

module.exports = { Store };
