const test = require("node:test");
const assert = require("node:assert");
const { sumNutrition, evaluateDiet, kcalToBowls, guessMealType, addDaysKey, weekSummary }
  = require("../js/diary.js");

const MEAL = (over) => Object.assign({
  food_name: "테스트", kcal: 500, carbs_g: 60, sugar_g: 5,
  sodium_mg: 500, protein_g: 20, fat_g: 15, purine_level: "low"
}, over);
const P = (diseases, severity) => ({ diseases: diseases, severity: severity || "mild" });

// ── 합산 ──────────────────────────────────────────────────────
test("합산: 두 끼 합계 + 퓨린 카운트", () => {
  const t = sumNutrition([MEAL(), MEAL({ sugar_g: 10, purine_level: "high" })]);
  assert.equal(t.kcal, 1000);
  assert.equal(t.sugar_g, 15);
  assert.equal(t.count, 2);
  assert.equal(t.purineHigh, 1);
});
test("합산: 빈 배열", () => {
  assert.equal(sumNutrition([]).count, 0);
});

// ── 하루 평가 (질환별) ────────────────────────────────────────
test("평가: 기록 없으면 good", () => {
  const r = evaluateDiet(sumNutrition([]), P(["diabetes"]));
  assert.equal(r.level, "good");
});
test("평가(당뇨): 당류 25g 초과는 risk", () => {
  const r = evaluateDiet(sumNutrition([MEAL({ sugar_g: 30 })]), P(["diabetes"]));
  assert.equal(r.level, "risk");
  assert.ok(r.reasons.some((x) => /\[당뇨\].*초과/.test(x)));
});
test("평가(당뇨): 중증은 한도 12.5g", () => {
  const r = evaluateDiet(sumNutrition([MEAL({ sugar_g: 15 })]), P(["diabetes"], "severe"));
  assert.equal(r.level, "risk");
  assert.equal(r.limits.sugarG, 12.5);
});
test("평가(고혈압): 나트륨 2000mg 초과는 risk", () => {
  const r = evaluateDiet(sumNutrition([MEAL({ sodium_mg: 2500 })]), P(["hypertension"]));
  assert.equal(r.level, "risk");
  assert.ok(r.reasons.some((x) => /\[고혈압\]/.test(x)));
});
test("평가(고혈압): 당류만 높으면 무반응 — 질환별 독립", () => {
  const r = evaluateDiet(sumNutrition([MEAL({ sugar_g: 40, sodium_mg: 300 })]), P(["hypertension"]));
  assert.equal(r.level, "good"); // 당뇨 미선택 → 당류 무시
});
test("평가(신장): 나트륨 1800 초과 risk, 단백질 60g 초과 caution", () => {
  const r1 = evaluateDiet(sumNutrition([MEAL({ sodium_mg: 1900 })]), P(["kidney"]));
  assert.equal(r1.level, "risk");
  const r2 = evaluateDiet(sumNutrition([MEAL({ protein_g: 70, sodium_mg: 300 })]), P(["kidney"]));
  assert.equal(r2.level, "caution");
});
test("평가(통풍): 고퓨린 2회는 risk, 1회는 caution", () => {
  const two = [MEAL({ purine_level: "high" }), MEAL({ purine_level: "high" })];
  assert.equal(evaluateDiet(sumNutrition(two), P(["gout"])).level, "risk");
  const one = [MEAL({ purine_level: "high" })];
  assert.equal(evaluateDiet(sumNutrition(one), P(["gout"])).level, "caution");
});
test("평가(복합): 당뇨+고혈압 — 사유에 두 질환 모두", () => {
  const r = evaluateDiet(sumNutrition([MEAL({ sugar_g: 30, sodium_mg: 2500 })]),
    P(["diabetes", "hypertension"]));
  assert.equal(r.level, "risk");
  assert.ok(r.reasons.some((x) => /\[당뇨\]/.test(x)));
  assert.ok(r.reasons.some((x) => /\[고혈압\]/.test(x)));
});
test("평가: 음성에 추정치 명시", () => {
  assert.match(evaluateDiet(sumNutrition([MEAL()]), P(["diabetes"])).speech, /추정치/);
});
test("평가(일반): 질환 미선택 — WHO 일반 기준(당류 50g·나트륨 2000mg)으로 평가", () => {
  // 당뇨라면 risk(25g 초과)인 당류 30g이 일반 모드에선 good (50g의 70%=35g 미만)
  const r1 = evaluateDiet(sumNutrition([MEAL({ sugar_g: 30 })]), P([]));
  assert.equal(r1.level, "good");
  assert.ok(r1.reasons.some((x) => /\[일반\] 당류/.test(x)));
  assert.equal(r1.limits.sugarG, 50);
  // 당류 55g은 일반 기준으로도 risk
  assert.equal(evaluateDiet(sumNutrition([MEAL({ sugar_g: 55 })]), P([])).level, "risk");
  // 나트륨 2500은 일반 기준 risk
  const r2 = evaluateDiet(sumNutrition([MEAL({ sodium_mg: 2500 })]), P([]));
  assert.equal(r2.level, "risk");
  assert.ok(r2.reasons.some((x) => /\[일반\] 나트륨/.test(x)));
});
test("평가(일반): 중증도는 한도에 적용하지 않음", () => {
  const r = evaluateDiet(sumNutrition([MEAL({ sugar_g: 30 })]), P([], "severe"));
  assert.equal(r.limits.sugarG, 50); // 50×0.5=25가 아니어야 함
  assert.equal(r.level, "good");
});

// ── 밥공기 환산 ───────────────────────────────────────────────
test("밥공기: 300kcal = 1공기, 450kcal = 1.5공기", () => {
  assert.equal(kcalToBowls(300).bowls, 1);
  assert.equal(kcalToBowls(450).bowls, 1.5);
  assert.match(kcalToBowls(450).text, /1\.5공기/);
});
test("밥공기: 0.5 단위 반올림 + 아이콘", () => {
  assert.equal(kcalToBowls(600).icons, "🍚🍚");
  assert.equal(kcalToBowls(450).icons, "🍚🥄");
});
test("밥공기: 0 이하는 빈 값, 소량은 반 공기 이하", () => {
  assert.equal(kcalToBowls(0).bowls, 0);
  assert.match(kcalToBowls(100).text, /반 공기 이하/);
});

// ── 식사 구분 자동 추정 ───────────────────────────────────────
test("식사 구분: 시간대별 자동 추정", () => {
  assert.equal(guessMealType(7), "breakfast");
  assert.equal(guessMealType(12), "lunch");
  assert.equal(guessMealType(19), "dinner");
  assert.equal(guessMealType(23), "snack");
  assert.equal(guessMealType(3), "snack");
});

// ── 날짜·주간 요약 ────────────────────────────────────────────
test("날짜: addDaysKey 월 경계 처리", () => {
  assert.equal(addDaysKey("2026-07-01", -1), "2026-06-30");
  assert.equal(addDaysKey("2026-12-31", 1), "2027-01-01");
});
test("주간 요약: 7일, 기록 없는 날은 none", () => {
  const all = { "2026-07-10": [MEAL({ sugar_g: 30 })] };
  const week = weekSummary(all, "2026-07-10", P(["diabetes"]));
  assert.equal(week.length, 7);
  assert.equal(week[6].key, "2026-07-10");
  assert.equal(week[6].level, "risk");
  assert.equal(week[0].level, "none");
  assert.ok(["일","월","화","수","목","금","토"].includes(week[6].weekday));
});
