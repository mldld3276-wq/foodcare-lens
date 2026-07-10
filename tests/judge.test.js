const test = require("node:test");
const assert = require("node:assert");
const { judgeSugar, judgeSodium, judgePurine, judgeMeal } = require("../js/judge.js");

// ── 당류 (당뇨) 경계값 ─────────────────────────────────────────
test("당류: 5g 이하는 초록", () => {
  assert.equal(judgeSugar(0).color, "green");
  assert.equal(judgeSugar(5).color, "green");
});
test("당류: 5 초과 ~ 15 이하는 노랑", () => {
  assert.equal(judgeSugar(5.1).color, "yellow");
  assert.equal(judgeSugar(15).color, "yellow");
});
test("당류: 15 초과는 빨강", () => {
  assert.equal(judgeSugar(15.1).color, "red");
  assert.equal(judgeSugar(18).color, "red");
});
test("당류: 중등증은 기준 30% 하향 (3.5/10.5)", () => {
  assert.equal(judgeSugar(3.5, { severity: "moderate" }).color, "green");
  assert.equal(judgeSugar(3.6, { severity: "moderate" }).color, "yellow");
  assert.equal(judgeSugar(10.6, { severity: "moderate" }).color, "red");
});
test("당류: 음성 문구에 '1회분 기준' 명시", () => {
  assert.match(judgeSugar(18).speech, /1회분 기준/);
});
test("당류: 총 제공 횟수 있으면 봉지 전체 안내", () => {
  const r = judgeSugar(18, { servingsPerPack: 3 });
  assert.equal(r.totalSugarG, 54);
  assert.match(r.speech, /봉지 전체/);
});
test("당류: 잘못된 입력은 판정 불가", () => {
  assert.equal(judgeSugar(NaN).color, "unknown");
  assert.equal(judgeSugar(-1).color, "unknown");
});
test("당류: 당뇨 미선택 사용자에겐 '당뇨' 단정 문구를 쓰지 않음", () => {
  const r = judgeSugar(18, { hasDiabetes: false });
  assert.equal(r.color, "red");
  assert.doesNotMatch(r.speech, /당뇨/);
  assert.match(r.speech, /당류가 많은 편/);
  // 안심 문구도 일반화 — "안심하고 드셔도" 대신 당류 정보만
  assert.doesNotMatch(judgeSugar(2, { hasDiabetes: false }).speech, /안심하고 드셔도/);
  // 기본(당뇨 선택)은 기존 문구 유지
  assert.match(judgeSugar(18).speech, /당뇨에 위험/);
});

// ── 나트륨 (고혈압/신장) ───────────────────────────────────────
test("나트륨(고혈압): 500/1000 경계", () => {
  assert.equal(judgeSodium(500).color, "green");
  assert.equal(judgeSodium(501).color, "yellow");
  assert.equal(judgeSodium(1000).color, "yellow");
  assert.equal(judgeSodium(1001).color, "red");
});
test("나트륨(신장): 더 엄격한 400/800 경계", () => {
  assert.equal(judgeSodium(400, { disease: "kidney" }).color, "green");
  assert.equal(judgeSodium(401, { disease: "kidney" }).color, "yellow");
  assert.equal(judgeSodium(801, { disease: "kidney" }).color, "red");
});
test("나트륨: 중증도 하향 적용", () => {
  assert.equal(judgeSodium(300, { severity: "severe" }).color, "yellow"); // 한도 250
});
test("나트륨: 잘못된 입력은 판정 불가", () => {
  assert.equal(judgeSodium(NaN).color, "unknown");
});

// ── 퓨린 (통풍) ────────────────────────────────────────────────
test("퓨린: high 빨강 / medium 노랑 / low 초록", () => {
  assert.equal(judgePurine("high").color, "red");
  assert.equal(judgePurine("medium").color, "yellow");
  assert.equal(judgePurine("low").color, "green");
  assert.equal(judgePurine("?").color, "unknown");
});

// ── 한 끼 종합 판정 (다질환) ───────────────────────────────────
const MEAL = { sugar_g: 4, sodium_mg: 1200, protein_g: 20, purine_level: "low" };

test("종합: 질환 하나(당뇨)만 선택 시 결과 1개", () => {
  const r = judgeMeal(MEAL, { diseases: ["diabetes"], severity: "mild" });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].disease, "diabetes");
  assert.equal(r.overall, "green");
});
test("종합: 당뇨+고혈압 — 나트륨 높으면 전체 빨강", () => {
  const r = judgeMeal(MEAL, { diseases: ["diabetes", "hypertension"], severity: "mild" });
  assert.equal(r.results.length, 2);
  assert.equal(r.results[1].color, "red"); // 나트륨 1200 > 1000
  assert.equal(r.overall, "red");
});
test("종합: 신장 — 단백질 많으면 초록이라도 노랑으로", () => {
  const r = judgeMeal({ sugar_g: 2, sodium_mg: 300, protein_g: 40, purine_level: "low" },
    { diseases: ["kidney"], severity: "mild" });
  assert.equal(r.results[0].color, "yellow");
  assert.match(r.results[0].detail, /단백질 많음/);
});
test("종합: 통풍 — 고퓨린이면 빨강", () => {
  const r = judgeMeal({ sugar_g: 0, sodium_mg: 100, protein_g: 10, purine_level: "high" },
    { diseases: ["gout"] });
  assert.equal(r.overall, "red");
});
test("종합: 프로필 없으면 일반 건강 모드", () => {
  const r = judgeMeal(MEAL, null);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].disease, "general");
  assert.equal(r.results[0].name, "일반");
  assert.equal(r.overall, "yellow"); // 나트륨 1200 = 일반 기준 yellow 경계값
});

// ── 일반 건강 모드 (질환 미선택) ───────────────────────────────
test("일반 모드: 당류·나트륨 종합 — 낮으면 초록", () => {
  const r = judgeMeal({ sugar_g: 3, sodium_mg: 400, protein_g: 15, purine_level: "low" }, { diseases: [] });
  assert.equal(r.results.length, 1);
  assert.equal(r.overall, "green");
  assert.match(r.results[0].detail, /당류 3g/);
  assert.match(r.results[0].detail, /나트륨 400mg/);
});
test("일반 모드: 나트륨 1200 초과는 빨강 (일반 기준 600/1200)", () => {
  assert.equal(judgeMeal({ sugar_g: 2, sodium_mg: 1201, purine_level: "low" }, { diseases: [] }).overall, "red");
  assert.equal(judgeMeal({ sugar_g: 2, sodium_mg: 700, purine_level: "low" }, { diseases: [] }).overall, "yellow");
});
test("일반 모드: 당류 15 초과면 빨강", () => {
  assert.equal(judgeMeal({ sugar_g: 18, sodium_mg: 100, purine_level: "low" }, { diseases: [] }).overall, "red");
});
test("일반 모드: 중증도는 적용하지 않음", () => {
  // 당류 4g — 중증(×0.5)이라면 yellow(기준 2.5)가 되지만 일반 모드는 무시하고 green
  const r = judgeMeal({ sugar_g: 4, sodium_mg: 100, purine_level: "low" }, { diseases: [], severity: "severe" });
  assert.equal(r.overall, "green");
});
test("일반 모드: 나트륨 판정에 general 기준 직접 사용 가능", () => {
  assert.equal(judgeSodium(600, { disease: "general" }).color, "green");
  assert.equal(judgeSodium(601, { disease: "general" }).color, "yellow");
  assert.equal(judgeSodium(1201, { disease: "general" }).color, "red");
});
test("일반 모드: judgeSodium(general)은 중증도를 무시 — 모든 경로에서 판정 일치", () => {
  // 질환 해제 후 severity가 프로필에 남아 있어도 일반 기준(600/1200)이 흔들리면 안 됨
  assert.equal(judgeSodium(700, { disease: "general", severity: "severe" }).color, "yellow");
  assert.equal(judgeSodium(500, { disease: "general", severity: "severe" }).color, "green");
});
test("종합: 4개 질환 전부 선택 시 결과 4개 + 한국어 이름", () => {
  const r = judgeMeal(MEAL, { diseases: ["diabetes", "hypertension", "kidney", "gout"] });
  assert.equal(r.results.length, 4);
  assert.deepEqual(r.results.map((x) => x.name), ["당뇨", "고혈압", "신장질환", "통풍"]);
});
