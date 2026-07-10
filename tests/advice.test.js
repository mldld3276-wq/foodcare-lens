const test = require("node:test");
const assert = require("node:assert");
const { riskAdvice, INFO } = require("../js/advice.js");

test("조언: 위험 질환만 골라 합병증·음식·운동을 준다", () => {
  const r = riskAdvice({ diabetes: "risk", hypertension: "good" });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].key, "diabetes");
  assert.match(r.items[0].risk, /합병증/);
  assert.ok(r.items[0].foods.length >= 3);
  assert.match(r.items[0].exercise, /걷기/);
  assert.equal(r.level, "risk");
});

test("조언: 여러 질환 위험이면 음식 목록을 합치고 중복 제거", () => {
  const r = riskAdvice({ diabetes: "risk", hypertension: "risk" });
  assert.equal(r.items.length, 2);
  assert.equal(r.exercises.length, 2);
  // 합쳐진 음식 목록에 중복 없음
  const set = new Set(r.allFoods);
  assert.equal(set.size, r.allFoods.length);
  assert.ok(r.allFoods.length >= 6);
});

test("조언: 기본은 risk만, minLevel caution이면 주의도 포함", () => {
  const only = riskAdvice({ diabetes: "caution" });
  assert.equal(only.items.length, 0); // 기본 risk 기준
  const withCaution = riskAdvice({ diabetes: "caution" }, "caution");
  assert.equal(withCaution.items.length, 1);
  assert.equal(withCaution.level, "caution");
});

test("조언: 위험 없으면 빈 목록", () => {
  const r = riskAdvice({ diabetes: "good", hypertension: "good" });
  assert.equal(r.items.length, 0);
  assert.equal(r.level, "good");
  assert.deepEqual(r.allFoods, []);
});

test("조언: 4개 질환 + 일반 모두 데이터가 있다", () => {
  ["diabetes", "hypertension", "kidney", "gout", "general"].forEach((k) => {
    assert.ok(INFO[k].name && INFO[k].risk && INFO[k].foods.length && INFO[k].exercise);
  });
});
