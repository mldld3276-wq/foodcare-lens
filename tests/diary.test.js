const test = require("node:test");
const assert = require("node:assert");
const { sumNutrition, evaluateDiet, kcalToBowls, guessMealType, addDaysKey, weekSummary,
  bmi, dailyKcalTarget, bowlsGuide, kcalSummary, monthGrid, streakCount, monthStampCount }
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
test("합산·평가: 성분표에 없던 항목(null)은 0 합산 + 결측 카운트 → '양호' 대신 주의", () => {
  // 당류 미표기 라벨 3개를 기록한 당뇨 사용자 — '당류 0g 양호'가 나가면 안 됨
  const entries = [1, 2, 3].map(() => {
    const m = MEAL({}); delete m.sugar_g; return m;
  });
  const t = sumNutrition(entries);
  assert.equal(t.sugarUnknown, 3);
  assert.equal(t.sugar_g, 0);
  const r = evaluateDiet(t, P(["diabetes"]));
  assert.equal(r.level, "caution"); // good이면 안 됨
  assert.ok(r.reasons.some((x) => /당류 정보 없는 기록 3건/.test(x)));
  assert.match(r.speech, /정보가 없어/);
  // 나트륨 결측은 고혈압 선택 시에만 주의
  const e2 = [MEAL({ sodium_mg: null })];
  assert.equal(evaluateDiet(sumNutrition(e2), P(["diabetes"])).reasons
    .some((x) => /나트륨 정보 없는/.test(x)), false);
  assert.equal(evaluateDiet(sumNutrition(e2), P(["hypertension"])).level, "caution");
});

test("평가(일반): 중증도는 한도에 적용하지 않음", () => {
  const r = evaluateDiet(sumNutrition([MEAL({ sugar_g: 30 })]), P([], "severe"));
  assert.equal(r.limits.sugarG, 50); // 50×0.5=25가 아니어야 함
  assert.equal(r.level, "good");
});

// ── 개인 맞춤 (키·몸무게) ─────────────────────────────────────
test("BMI: 키·몸무게로 계산 + 아시아 기준 분류", () => {
  assert.equal(bmi({ height: 170, weight: 64 }).value, 22.1);
  assert.equal(bmi({ height: 170, weight: 64 }).category, "정상");
  assert.equal(bmi({ height: 170, weight: 80 }).category, "비만");
  assert.equal(bmi({ height: 160, weight: 45 }).category, "저체중");
  assert.equal(bmi({}), null);           // 정보 없으면 null
  assert.equal(bmi({ height: 170 }), null);
});
test("권장 열량: 키 기반 표준체중×30, 없으면 기본 2000", () => {
  assert.equal(dailyKcalTarget({}), 2000);
  const t = dailyKcalTarget({ height: 170 });
  assert.ok(t >= 1850 && t <= 2000);     // 표준체중 63.6kg×30 ≈ 1900
  assert.equal(t % 50, 0);               // 50 단위
});
test("하루 총 칼로리 요약: 소비/권장/퍼센트 + 초과 판정", () => {
  const s = kcalSummary(950, { height: 170 }); // 권장 1900 → 50%
  assert.equal(s.consumed, 950);
  assert.equal(s.target, 1900);
  assert.equal(s.pct, 50);
  assert.equal(s.over, false);
  assert.equal(s.barPct, 50);
  const over = kcalSummary(2500, { height: 170 });
  assert.equal(over.over, true);
  assert.equal(over.barPct, 100); // 막대는 100%에서 멈춤
  assert.ok(over.pct > 100);      // 숫자는 실제 퍼센트
});
test("밥공기 안내: 남은 공기 계산 + 초과 문구", () => {
  const g = bowlsGuide(900, { height: 170 }); // 권장 ~1900=약 6공기, 900=3공기
  assert.ok(g.remainingBowls > 0);
  assert.match(g.text, /더 드셔도 돼요/);
  const over = bowlsGuide(3000, { height: 170 });
  assert.ok(over.remainingBowls < 0);
  assert.match(over.text, /많이 드셨어요/);
});
test("평가: 개인 열량 초과 시 주의 + byDisease 제공", () => {
  const small = { height: 150 }; // 표준 49.5kg×30≈1500 권장
  const r = evaluateDiet(sumNutrition([MEAL({ kcal: 2000 })]), Object.assign({ diseases: [] }, small));
  assert.equal(r.limits.kcal < 2000, true);
  assert.ok(r.byDisease); // 질환별 위험도 맵
});
test("평가(당뇨): byDisease에 당뇨 위험 기록", () => {
  const r = evaluateDiet(sumNutrition([MEAL({ sugar_g: 40 })]), P(["diabetes"]));
  assert.equal(r.byDisease.diabetes, "risk");
});

// ── BMI 목표 추천 + 목표별 칼로리 ─────────────────────────────
test("목표 추천: BMI 구간별 다이어트/증량/유지", () => {
  const { goalSuggestion } = require("../js/diary.js");
  assert.equal(goalSuggestion({ height: 170, weight: 80 }).goal, "diet");   // BMI 27.7
  assert.equal(goalSuggestion({ height: 170, weight: 68 }).goal, "diet");   // BMI 23.5 가벼운
  assert.match(goalSuggestion({ height: 170, weight: 68 }).text, /가벼운/);
  assert.equal(goalSuggestion({ height: 170, weight: 50 }).goal, "gain");   // BMI 17.3
  assert.equal(goalSuggestion({ height: 170, weight: 60 }).goal, "keep");   // BMI 20.8
  assert.equal(goalSuggestion({}), null); // 키·몸무게 없으면 null
});

test("목표별 칼로리: 다이어트 -400·증량 +400·최소 1200", () => {
  const { planKcalTarget, dailyKcalTarget } = require("../js/diary.js");
  const base = dailyKcalTarget({ height: 170 }); // 1900
  assert.equal(planKcalTarget({ height: 170 }, "diet"), base - 400);
  assert.equal(planKcalTarget({ height: 170 }, "gain"), base + 400);
  assert.equal(planKcalTarget({ height: 170 }, "keep"), base);
  // 아주 작은 체구여도 1200 아래로는 안 내려감
  assert.ok(planKcalTarget({ height: 140 }, "diet") >= 1200);
});

// ── 문진용 식단 요약 + 남은 한도 ──────────────────────────────
test("식단 요약: 최근 3일 음식명·합계 포함, 기록 없으면 빈 문자열", () => {
  const all = {
    "2026-07-11": [MEAL({ food_name: "김치찌개", sugar_g: 5, sodium_mg: 1500 })],
    "2026-07-10": [MEAL({ food_name: "비빔밥" }), MEAL({ food_name: "우유" })],
    "2026-07-05": [MEAL({ food_name: "옛날음식" })] // 3일 밖 — 제외
  };
  const s = require("../js/diary.js").recentDietSummary(all, "2026-07-11", 3);
  assert.match(s, /07\/11.*김치찌개/);
  assert.match(s, /비빔밥, 우유/);
  assert.match(s, /나트륨 1500mg/);
  assert.doesNotMatch(s, /옛날음식/);
  assert.equal(require("../js/diary.js").recentDietSummary({}, "2026-07-11", 3), "");
});

test("남은 한도: 한도-섭취, 음수는 0", () => {
  const t = sumNutrition([MEAL({ sugar_g: 10, sodium_mg: 1500, kcal: 800 })]);
  const r = require("../js/diary.js").remainingBudget(t, P(["diabetes"]));
  assert.equal(r.sugarG, 15);       // 25 - 10
  assert.equal(r.sodiumMg, 500);    // 2000 - 1500
  assert.ok(r.kcal > 0);
  // 초과 섭취 → 0
  const over = require("../js/diary.js").remainingBudget(
    sumNutrition([MEAL({ sugar_g: 40 })]), P(["diabetes"]));
  assert.equal(over.sugarG, 0);
});

// ── 출석 도장 달력 ────────────────────────────────────────────
test("월 달력: 앞 빈칸 + 기록 있는 날 has=true", () => {
  const all = { "2026-07-10": [MEAL()], "2026-07-15": [MEAL({ sugar_g: 40 })] };
  const cells = monthGrid(all, 2026, 7, P(["diabetes"]));
  const filled = cells.filter(Boolean);
  assert.equal(filled.length, 31);                 // 7월은 31일
  assert.equal(cells[0], null);                    // 2026-07-01은 수요일 → 앞에 빈칸 3개
  const d10 = filled.find((c) => c.day === 10);
  assert.equal(d10.has, true);
  const d15 = filled.find((c) => c.day === 15);
  assert.equal(d15.level, "risk");
  const d11 = filled.find((c) => c.day === 11);
  assert.equal(d11.has, false);
});
test("연속 기록: 끊기기 전까지 카운트", () => {
  const all = { "2026-07-08": [MEAL()], "2026-07-09": [MEAL()], "2026-07-10": [MEAL()] };
  assert.equal(streakCount(all, "2026-07-10"), 3);
  assert.equal(streakCount(all, "2026-07-11"), 0); // 오늘 기록 없으면 0
  const gap = { "2026-07-08": [MEAL()], "2026-07-10": [MEAL()] };
  assert.equal(streakCount(gap, "2026-07-10"), 1); // 09 비어서 1
});
test("이번 달 도장 수", () => {
  const all = { "2026-07-10": [MEAL()], "2026-07-15": [MEAL()], "2026-06-30": [MEAL()] };
  assert.equal(monthStampCount(all, 2026, 7), 2);
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
