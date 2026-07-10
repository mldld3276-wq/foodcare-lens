const test = require("node:test");
const assert = require("node:assert");
const { RESULTS, drawResult, centerAngle, angleForResult, gradientStops } = require("../js/draw.js");

test("확률 합계는 정확히 1.0, 당첨은 40%", () => {
  const sum = RESULTS.reduce((a, r) => a + r.prob, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, "합계 " + sum);
  assert.equal(RESULTS.find((r) => r.key === "win").prob, 0.4);
  assert.equal(RESULTS.find((r) => r.key === "lose").prob, 0.6);
});

test("추첨: 난수 경계 (0~0.4 당첨, 그 위 꽝)", () => {
  assert.equal(drawResult(0).key, "win");
  assert.equal(drawResult(0.39).key, "win");
  assert.equal(drawResult(0.4).key, "lose");
  assert.equal(drawResult(0.99).key, "lose");
});

test("추첨: 당첨은 prize=true, 꽝은 false", () => {
  assert.equal(drawResult(0.1).prize, true);
  assert.equal(drawResult(0.9).prize, false);
});

test("추첨: 잘못된 난수는 안전하게 꽝으로 방어", () => {
  assert.equal(drawResult(1.5).key, "lose");
  assert.equal(drawResult(-1).key, "lose");
  assert.equal(drawResult("x").key, "lose");
});

test("섹터 중심 각도: 확률 비례 (당첨 40%→72°, 꽝→252°)", () => {
  // 당첨 섹터 0~144°, 중심 72°. 꽝 144~360°, 중심 252°.
  assert.equal(centerAngle("win"), 72);
  assert.equal(centerAngle("lose"), 252);
});

test("돌림판 각도: spins바퀴 + 섹터 정렬, spins=0은 오프셋만", () => {
  assert.equal(angleForResult("win", 0), 360 - 72);   // 288
  assert.equal(angleForResult("win", 5), 5 * 360 + 288);
  assert.notEqual(angleForResult("win", 5), angleForResult("lose", 5));
});

test("conic-gradient 정지점: 확률 비례 두 섹터", () => {
  const stops = gradientStops();
  assert.match(stops, /0deg 144deg/);   // 당첨 40% = 144도
  assert.match(stops, /144deg 360deg/); // 꽝 60%
});

// 몬테카를로: 큰 표본에서 당첨 비율이 대략 40%
test("추첨 분포: 대량 표본에서 당첨 ~40%", () => {
  let win = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const r = ((i * 2654435761) % 1000000) / 1000000;
    if (drawResult(r).key === "win") win++;
  }
  const ratio = win / N;
  assert.ok(ratio > 0.36 && ratio < 0.44, "당첨 비율 " + ratio);
});
