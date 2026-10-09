import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { buildScrapingApp } from "../src/app.js";

describe("Fastify REST API Endpoints", () => {
  test("GET /health returns 200 OK", async () => {
    const app = await buildScrapingApp();
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, "ok");
    await app.close();
  });

  test("GET /ready returns 200 OK", async () => {
    const app = await buildScrapingApp();
    const res = await app.inject({
      method: "GET",
      url: "/ready",
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, "ready");
    await app.close();
  });

  test("GET /metrics returns telemetry", async () => {
    const app = await buildScrapingApp();
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(typeof body.uptimeSeconds === "number");
    assert.ok(body.memory);
    await app.close();
  });

  test("POST /v1/extract rejects invalid request bodies with 400", async () => {
    const app = await buildScrapingApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/extract",
      payload: {}, // missing urls and query
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_REQUEST");
    await app.close();
  });

  test("POST /v1/map rejects invalid URL format with 400", async () => {
    const app = await buildScrapingApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/map",
      payload: { url: "not-a-valid-url" },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_REQUEST");
    await app.close();
  });

  test("POST /v1/crawl rejects invalid URL with 400", async () => {
    const app = await buildScrapingApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/crawl",
      payload: { url: "invalid" },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_REQUEST");
    await app.close();
  });
});
