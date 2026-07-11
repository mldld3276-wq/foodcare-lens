const test = require("node:test");
const assert = require("node:assert");
const { treeState, STAGES } = require("../js/tree.js");

// 신호등이 예측 가능한 음식들 (당뇨 프로필 기준)
const GREEN = { sugar_g: 2, sodium_mg: 100, protein_g: 10, purine_level: "low" };   // 당류 ≤5 → green
const YELLOW = { sugar_g: 10, sodium_mg: 100, protein_g: 10, purine_level: "low" }; // 5~15 → yellow
const RED = { sugar_g: 20, sodium_mg: 100, protein_g: 10, purine_level: "low" };    // >15 → red
const P = { diseases: ["diabetes"], severity: "mild" };
const TODAY = "2026-07-11";

function days(map) { return map; } // 가독용

test("나무: 기록 없으면 씨앗(0단계)", () => {
  const t = treeState({}, TODAY, P);
  assert.equal(t.stage, 0);
  assert.equal(t.emoji, "🌰");
  assert.match(t.message, /씨앗/);
});

test("나무: 초록불이 쌓이면 자라고 꽃이 핀다", () => {
  // 초록 8개 = 점수 16 → 4단계 꽃나무
  const all = days({ "2026-07-11": Array(8).fill(GREEN) });
  const t = treeState(all, TODAY, P);
  assert.equal(t.stage, 4);
  assert.equal(t.flowers, true);
  assert.equal(t.wilted, false);
  assert.match(t.emoji, /🌸/);
  assert.match(t.message, /꽃이 활짝/);
});

test("나무: 중간 점수는 중간 단계", () => {
  // 초록 2 = 4점 → 2단계 어린나무
  const t2 = treeState({ "2026-07-11": [GREEN, GREEN] }, TODAY, P);
  assert.equal(t2.stage, 2);
  // 초록 4 = 8점 → 3단계 나무
  const t3 = treeState({ "2026-07-11": [GREEN, GREEN, GREEN, GREEN] }, TODAY, P);
  assert.equal(t3.stage, 3);
  // 노랑 1 = 1점 → 1단계 새싹
  const t1 = treeState({ "2026-07-11": [YELLOW] }, TODAY, P);
  assert.equal(t1.stage, 1);
});

test("나무: 빨간불이 잦으면 시든다", () => {
  // 빨강 3, 초록 2 → reds>=2 && reds*2>=greens → 시듦
  const all = { "2026-07-11": [RED, RED, RED, GREEN, GREEN] };
  const t = treeState(all, TODAY, P);
  assert.equal(t.wilted, true);
  assert.equal(t.flowers, false);
  assert.match(t.emoji, /🍂/);
  assert.match(t.message, /시들/);
});

test("나무: 빨강이 적고 초록이 많으면 시들지 않는다", () => {
  // 빨강 2, 초록 6 → reds*2(4) < greens(6) → 건강
  const all = { "2026-07-11": [RED, RED, GREEN, GREEN, GREEN, GREEN, GREEN, GREEN] };
  const t = treeState(all, TODAY, P);
  assert.equal(t.wilted, false);
});

test("나무: 7일 이전 기록은 반영 안 됨", () => {
  const all = { "2026-07-01": Array(10).fill(GREEN) }; // 10일 전
  const t = treeState(all, TODAY, P);
  assert.equal(t.stage, 0);
  assert.equal(t.total, 0);
});

test("나무: 여러 날에 걸친 기록 합산", () => {
  const all = {
    "2026-07-09": [GREEN, GREEN],
    "2026-07-10": [GREEN, GREEN],
    "2026-07-11": [GREEN, GREEN, GREEN, GREEN]
  }; // 초록 8 = 16점 → 꽃
  const t = treeState(all, TODAY, P);
  assert.equal(t.stage, 4);
  assert.equal(t.greens, 8);
});

test("나무: 5단계 정의가 온전하다", () => {
  assert.equal(STAGES.length, 5);
  STAGES.forEach((s) => assert.ok(s.name && s.emoji));
});
