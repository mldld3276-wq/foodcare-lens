const test = require("node:test");
const assert = require("node:assert");
const { GRADES, drawGrade, angleForGrade } = require("../js/draw.js");

test("등급 확률 합계는 정확히 1.0", () => {
  const sum = GRADES.reduce((a, g) => a + g.prob, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, "합계 " + sum);
});

test("추첨: 난수 경계별로 올바른 등급 (A가 가장 낮음)", () => {
  // 누적: A<0.01, B<0.05, C<0.15, D<0.35, E<0.65, F이하
  assert.equal(drawGrade(0.0).grade, "A");
  assert.equal(drawGrade(0.009).grade, "A");
  assert.equal(drawGrade(0.01).grade, "B");
  assert.equal(drawGrade(0.04).grade, "B");
  assert.equal(drawGrade(0.05).grade, "C");
  assert.equal(drawGrade(0.14).grade, "C");
  assert.equal(drawGrade(0.34).grade, "D");
  assert.equal(drawGrade(0.64).grade, "E");
  assert.equal(drawGrade(0.99).grade, "F");
});

test("추첨: A는 경품 플래그, 나머지는 아님", () => {
  assert.equal(drawGrade(0).prize, true);
  assert.equal(drawGrade(0.5).prize, false);
});

test("추첨: 잘못된 난수는 안전하게 최하 등급으로 방어", () => {
  assert.equal(drawGrade(1.5).grade, "F");
  assert.equal(drawGrade(-1).grade, "F");
  assert.equal(drawGrade("x").grade, "F");
});

test("A 확률이 실제로 가장 낮다", () => {
  const a = GRADES.find((g) => g.grade === "A").prob;
  GRADES.filter((g) => g.grade !== "A").forEach((g) => assert.ok(g.prob > a));
});

test("돌림판 각도: 여러 바퀴 + 등급 섹터에서 멈춤", () => {
  const ang = angleForGrade("A", 5);
  assert.ok(ang >= 5 * 360, "최소 5바퀴");
  assert.ok(ang < 6 * 360, "6바퀴 미만");
  // 등급마다 각도가 다르다
  assert.notEqual(angleForGrade("A", 5), angleForGrade("F", 5));
});

// 몬테카를로: 큰 표본에서 A 비율이 대략 1%
test("추첨 분포: 대량 표본에서 A는 드물다 (~1%)", () => {
  let aCount = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    // 결정적 의사난수 (테스트 재현성)
    const r = ((i * 2654435761) % 1000000) / 1000000;
    if (drawGrade(r).grade === "A") aCount++;
  }
  const ratio = aCount / N;
  assert.ok(ratio < 0.03, "A 비율 " + ratio + " — 3% 미만이어야");
});
