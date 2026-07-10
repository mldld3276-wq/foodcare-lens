const test = require("node:test");
const assert = require("node:assert");
const { riskAdvice, INFO, nutrientWarnings, NUTRIENT_RISK } = require("../js/advice.js");

test("영양소 위험: 많이 든 영양소만 경고 + 병명", () => {
  const r = nutrientWarnings({ carbs_g: 90, sugar_g: 30, sodium_mg: 1200, fat_g: 5, protein_g: 10, caffeine_mg: 0 });
  const names = r.warnings.map((w) => w.name);
  assert.ok(names.includes("탄수화물"));  // 90 ≥ 75
  assert.ok(names.includes("당류"));      // 30 ≥ 15
  assert.ok(names.includes("나트륨"));    // 1200 ≥ 800
  assert.ok(!names.includes("지방"));     // 5 < 22
  assert.ok(!names.includes("단백질"));   // 10 < 40
  assert.match(r.warnings.find((w) => w.name === "당류").disease, /당뇨병/);
});

test("영양소 위험: 카페인 임계 이상이면 경고", () => {
  const r = nutrientWarnings({ caffeine_mg: 120 });
  const c = r.warnings.find((w) => w.name === "카페인");
  assert.ok(c);
  assert.match(c.disease, /잠이 안|두근/);
  assert.equal(r.caffeine, 120);
  // 임계 미만이면 경고 없음
  assert.equal(nutrientWarnings({ caffeine_mg: 20 }).warnings.some((w) => w.name === "카페인"), false);
});

test("영양소 위험: 고퓨린이면 통풍 경고", () => {
  const r = nutrientWarnings({ purine_level: "high" });
  assert.ok(r.warnings.some((w) => w.name === "퓨린" && /통풍/.test(w.disease)));
});

test("영양소 위험: 적정량이면 빈 목록", () => {
  const r = nutrientWarnings({ carbs_g: 30, sugar_g: 5, sodium_mg: 200, fat_g: 5, protein_g: 8, caffeine_mg: 0 });
  assert.equal(r.warnings.length, 0);
});

test("영양소 위험: 카페인 항목이 정의돼 있다", () => {
  assert.ok(NUTRIENT_RISK.some((n) => n.key === "caffeine_mg"));
});

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
