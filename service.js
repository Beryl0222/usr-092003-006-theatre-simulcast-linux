"use strict";

const http = require("node:http");
const { Store } = require("./src/store");
const { createApi } = require("./src/api");

const SERVICE_ID = "theatre-simulcast";
const SERVICE_NAME = "跨城剧场同步演播";

function healthPayload() {
  return { status: "ok", service: SERVICE_ID, name: SERVICE_NAME };
}

function createServer(store) {
  const api = createApi(store || new Store());
  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const body = JSON.stringify(healthPayload());
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    const handled = await api(request, response);
    if (!handled) {
      response.writeHead(404);
      response.end();
    }
  });
}

if (require.main === module) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== SERVICE_ID) throw new Error("服务身份不一致");
    process.stdout.write("基础检查通过\n");
  } else {
    const port = Number(process.env.PORT || 8000);
    createServer().listen(port, "127.0.0.1");
  }
}

module.exports = { SERVICE_ID, SERVICE_NAME, createServer, healthPayload };
