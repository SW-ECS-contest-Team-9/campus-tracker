import { test } from "node:test";
import assert from "node:assert/strict";
import { ArkitPreview } from "../src/arkit.ts";
class Element {
  constructor(tag) {
    this.tag = tag;
  }
  tag;
  children = [];
  textContent = "";
  style = {};
  dataset = {};
  type = "";
  checked = true;
  width = 0;
  height = 0;
  onchange = null;
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren() {
    this.children = [];
    this.textContent = "";
  }
  get lastElementChild() {
    return this.children.at(-1);
  }
  setAttribute() {
  }
  getContext() {
    return { fillRect() {
    }, fillText() {
    }, beginPath() {
    }, moveTo() {
    }, lineTo() {
    }, stroke() {
    }, fillStyle: "", strokeStyle: "", font: "" };
  }
  get text() {
    return this.textContent + this.children.map((c) => c.text).join("");
  }
}
test("preview keeps unaligned paths off map, separates AR sessions, toggles layers and reloads after reconnect", async () => {
  const globals = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const entities = [];
  globalThis.document = { createElement: (tag) => new Element(tag), createTextNode: (s) => {
    const e = new Element("text");
    e.textContent = s;
    return e;
  } };
  globalThis.window = { Cesium: { Cartesian3: { fromDegrees: (lon, lat, h) => [lon, lat, h] }, Color: { fromCssColorString: (c) => c } } };
  const p = { sequence: 1, timestamp: Date.now(), frameTimestamp: 100, x: 200, y: 1.5, z: 700, trackingState: "normal" };
  const mapped = [{ timestamp: p.timestamp, e: 201100, n: 557250, h: 100, source: "normal" }, { timestamp: p.timestamp + 100, e: 201102, n: 557250, h: 101, source: "normal" }];
  const summary = (id, status) => ({ arSessionId: id, poseCount: 1, lastPose: p, lastReceivedAt: (/* @__PURE__ */ new Date()).toISOString(), generatedAt: (/* @__PURE__ */ new Date()).toISOString(), result: { poseCount: 1, alignment: { status, reason: "test", rms: 0.1 }, aligned: [mapped], corrected: [mapped] } });
  let aligned = false;
  globalThis.fetch = (async (url) => ({ ok: true, json: async () => String(url).includes("/poses?") ? { poses: [p] } : { sessions: [summary("ar-a", aligned ? "aligned" : "pending"), summary("ar-b", "pending")] } }));
  try {
    const panel = new Element("section");
    const preview = new ArkitPreview(panel);
    preview.setViewer({ entities: { add: (e) => {
      e.show = true;
      entities.push(e);
      return e;
    }, remove: (e) => {
      entities.splice(entities.indexOf(e), 1);
    } } });
    preview.setVisible(/* @__PURE__ */ new Set(["collector-session"]));
    await preview.load("collector-session");
    preview.render(true);
    assert.equal(entities.length, 0, "Even a malicious/stale result with coordinates must be gated by alignment");
    assert.match(panel.text, /ar-a/);
    assert.match(panel.text, /ar-b/);
    assert.match(panel.text, /pending/);
    assert.equal(panel.children[1].children.length, 2, "Separate local viewers for each AR coordinate lifetime");
    aligned = true;
    await preview.load("collector-session");
    preview.render(true);
    assert.equal(entities.length, 2);
    assert.ok(entities.every((e) => e.show));
    assert.ok(entities[0].polyline.positions[0][0] > 126 && entities[0].polyline.positions[0][0] < 128, "Map uses inverse projected campus coordinates, not raw AR X/Z");
    const arToggle = panel.children[0].children[0].children[0];
    arToggle.checked = false;
    arToggle.onchange();
    assert.equal(entities.find((e) => e.arkitKind === "arkit").show, false);
    assert.equal(entities.find((e) => e.arkitKind === "corrected").show, true);
    const corrected = panel.children[0].children[1].children[0];
    corrected.checked = false;
    corrected.onchange();
    assert.ok(entities.every((e) => !e.show));
    preview.setVisible(/* @__PURE__ */ new Set());
    preview.render(false);
    assert.match(panel.text, /데이터 없음/);
    preview.setVisible(/* @__PURE__ */ new Set(["collector-session"]));
    preview.pose({ sessionId: "collector-session", arSessionId: "ar-a", pose: { ...p, sequence: 2, trackingState: "limited" }, receivedAt: (/* @__PURE__ */ new Date()).toISOString() });
    preview.tick();
    preview.setVisible(new Set(["collector-session"]));
    preview.render(true);
    assert.match(panel.text, /limited/);
    preview.remove("collector-session");
    assert.equal(entities.length, 0);
  } finally {
    Object.assign(globalThis, globals);
  }
});
