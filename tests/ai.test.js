const test = require("node:test");
const assert = require("node:assert");
const { buildFoodRequest, parseAiReply, buildLabelRequest, parseLabelReply,
  buildGeminiRequest, parseGeminiText, detectProvider, foodPrompt, labelPrompt,
  symptomPrompt, parseSymptomReply, menuPrompt, parseMenuReply, MODEL }
  = require("../js/ai.js");

// ── 이상징후 문진 (진단 아님 — 3단계 안내) ─────────────────────
test("문진 프롬프트: 진단 금지·보수적 판정·식단·증상 포함", () => {
  const p = symptomPrompt("소변 색이 진해요", ["diabetes"], "7/11: 김치찌개 (당 5g)");
  assert.match(p, /진단하지 말/);
  assert.match(p, /안전한.*단계/);
  assert.match(p, /소변 색이 진해요/);
  assert.match(p, /김치찌개/);
  assert.match(p, /당뇨 환자/);
  assert.match(p, /emergency/);
  // 식단 없으면 없다고 명시
  assert.match(symptomPrompt("어지러워요", [], ""), /기록은 없습니다/);
});

test("문진 파싱: 3단계 유효, 이상한 level은 보수적으로 doctor", () => {
  const ok = parseSymptomReply(JSON.stringify({
    level: "watch", reason: "일시적일 수 있어요", advice: "물을 드세요", watch_for: "열이 나면"
  }));
  assert.equal(ok.level, "watch");
  assert.match(ok.advice, /물/);
  const weird = parseSymptomReply(JSON.stringify({ level: "maybe", reason: "설명" }));
  assert.equal(weird.level, "doctor"); // 애매하면 병원 권유
  assert.equal(parseSymptomReply("모름"), null);
});

// ── 오늘의 메뉴 추천 ───────────────────────────────────────────
test("메뉴 프롬프트: 남은 한도 수치와 끼니 포함", () => {
  const p = menuPrompt(["hypertension"], { sugarG: 20, sodiumMg: 500, kcal: 800 }, "저녁");
  assert.match(p, /20g/);
  assert.match(p, /500\s*mg|500mg/);
  assert.match(p, /800kcal|800\s*kcal/);
  assert.match(p, /저녁/);
  assert.match(p, /고혈압 환자/);
});

test("메뉴 파싱: 최대 3개, 이름 없는 항목 제외, 전무하면 null", () => {
  const r = parseMenuReply(JSON.stringify({ menus: [
    { name: "된장국과 현미밥", reason: "나트륨이 적어요" },
    { name: "", reason: "x" },
    { name: "두부조림" }, { name: "A" }, { name: "B" }
  ], tip: "국물은 남기세요" }));
  assert.equal(r.menus.length, 3);
  assert.equal(r.menus[0].name, "된장국과 현미밥");
  assert.equal(r.menus[1].reason, "");
  assert.match(r.tip, /국물/);
  assert.equal(parseMenuReply(JSON.stringify({ menus: [] })), null);
  assert.equal(parseMenuReply("없음"), null);
});

// ── 식당 메뉴판 골라주기 ───────────────────────────────────────
test("메뉴판 프롬프트: 남은 한도·오늘 식단·질환·JSON 지시 포함", () => {
  const { menuBoardPrompt } = require("../js/ai.js");
  const p = menuBoardPrompt(["diabetes"], { sugarG: 12, sodiumMg: 300, kcal: 900 },
    "07/11: 라면 (당 4g·나트륨 1790mg·500kcal)");
  assert.match(p, /메뉴판/);
  assert.match(p, /12g/);
  assert.match(p, /300\s*mg|300mg/);
  assert.match(p, /라면/);
  assert.match(p, /당뇨 환자/);
  assert.match(p, /best/);
  assert.match(p, /avoid/);
  // 오늘 기록 없으면 없다고 명시
  assert.match(menuBoardPrompt([], { sugarG: 1, sodiumMg: 1, kcal: 1 }, ""), /기록된 식사가 없습니다/);
});

test("메뉴판 파싱: best→ok→avoid 정렬, 이상한 verdict은 ok, 최대 6개", () => {
  const { parseMenuBoardReply } = require("../js/ai.js");
  const r = parseMenuBoardReply(JSON.stringify({ is_menu: true, picks: [
    { name: "제육볶음", verdict: "avoid", reason: "나트륨이 높아요" },
    { name: "된장찌개", verdict: "best", reason: "남은 한도에 맞아요" },
    { name: "비빔밥", verdict: "???", reason: "" },
    { name: "", verdict: "ok" }
  ], tip: "국물은 남기세요" }));
  assert.equal(r.picks.length, 3);
  assert.equal(r.picks[0].verdict, "best");     // 정렬: best 먼저
  assert.equal(r.picks[0].name, "된장찌개");
  assert.equal(r.picks[1].verdict, "ok");        // ??? → ok
  assert.equal(r.picks[2].verdict, "avoid");
  assert.match(r.tip, /국물/);
});

test("메뉴판 파싱: is_menu false는 유효, picks 전무+is_menu true는 null", () => {
  const { parseMenuBoardReply } = require("../js/ai.js");
  const notMenu = parseMenuBoardReply(JSON.stringify({ is_menu: false }));
  assert.equal(notMenu.is_menu, false);
  assert.equal(notMenu.picks.length, 0);
  assert.equal(parseMenuBoardReply(JSON.stringify({ is_menu: true, picks: [] })), null);
  assert.equal(parseMenuBoardReply("응답 불가"), null);
});

// ── 대체 상품 제안 ─────────────────────────────────────────────
test("대체 프롬프트: 음식명·문제·질환 포함", () => {
  const { alternativePrompt } = require("../js/ai.js");
  const p = alternativePrompt("신라면", "고혈압 기준 위험 (나트륨 1790mg)", ["hypertension"]);
  assert.match(p, /신라면/);
  assert.match(p, /나트륨 1790mg/);
  assert.match(p, /고혈압 환자/);
  assert.match(p, /대체/);
  assert.match(p, /JSON/);
});

test("대체 파싱: 최대 3개, 이름 없는 항목 제외, 전무하면 null", () => {
  const { parseAlternativeReply } = require("../js/ai.js");
  const r = parseAlternativeReply(JSON.stringify({ alternatives: [
    { name: "저나트륨 라면", reason: "나트륨이 절반이에요" },
    { name: "" }, { name: "메밀국수" }, { name: "A" }, { name: "B" }
  ], tip: "국물은 남기세요" }));
  assert.equal(r.alternatives.length, 3);
  assert.equal(r.alternatives[0].name, "저나트륨 라면");
  assert.match(r.tip, /국물/);
  assert.equal(parseAlternativeReply(JSON.stringify({ alternatives: [] })), null);
  assert.equal(parseAlternativeReply("없음"), null);
});

// ── 맞춤 식단 (다이어트/증량) ──────────────────────────────────
test("식단 프롬프트: 목표·활동량·스타일·칼로리·몸 정보 포함", () => {
  const { dietPlanPrompt } = require("../js/ai.js");
  const p = dietPlanPrompt(["diabetes"], { height: 170, weight: 80, bmi: 27.7 },
    "diet", "가끔 걸어요", "한식 위주", 1500);
  assert.match(p, /다이어트/);
  assert.match(p, /가끔 걸어요/);
  assert.match(p, /한식 위주/);
  assert.match(p, /1500\s*kcal|1500kcal/);
  assert.match(p, /BMI 27.7/);
  assert.match(p, /당뇨 환자/);
  assert.match(p, /포만감/);          // 다이어트 특화 지시
  const g = dietPlanPrompt([], null, "gain", "운동을 해요", "고기를 좋아해요", 2300);
  assert.match(g, /단백질/);          // 증량 특화 지시
  assert.doesNotMatch(g, /BMI/);      // 몸 정보 없으면 생략
});

test("식단 파싱: 세 끼 이상 유효해야 성공, 아니면 null", () => {
  const { parseDietPlanReply } = require("../js/ai.js");
  const ok = parseDietPlanReply(JSON.stringify({ meals: [
    { meal: "아침", menu: "현미밥과 두부국", note: "든든해요" },
    { meal: "점심", menu: "닭가슴살 샐러드" },
    { meal: "저녁", menu: "생선구이와 나물" },
    { meal: "간식", menu: "방울토마토" },
    { meal: "야식", menu: "라면" } // 유효하지 않은 끼니 — 제외
  ], exercise: "식후 30분 걷기", tip: "물을 자주 드세요" }));
  assert.equal(ok.meals.length, 4);
  assert.equal(ok.meals[0].meal, "아침");
  assert.match(ok.exercise, /걷기/);
  // 두 끼뿐이면 실패
  assert.equal(parseDietPlanReply(JSON.stringify({ meals: [
    { meal: "아침", menu: "밥" }, { meal: "점심", menu: "면" }
  ] })), null);
  assert.equal(parseDietPlanReply("불가"), null);
});

test("텍스트 전용 요청: 이미지 없이도 유효한 본문", () => {
  const gem = buildGeminiRequest(null, "질문");
  assert.equal(gem.contents[0].parts.length, 1);
  assert.equal(gem.contents[0].parts[0].text, "질문");
});

// ── 제공자 자동 감지 (sk-ant만 Claude, 나머지는 Gemini) ────────
test("제공자 감지: Claude는 sk-ant 접두사만, 나머지 Google 키 형식은 전부 Gemini", () => {
  assert.equal(detectProvider("sk-ant-api03-xyz"), "claude");
  assert.equal(detectProvider("AIzaSyABC123"), "gemini");        // 기존 Google 키 형식
  assert.equal(detectProvider("AQ.Ab8RN6LFSdR5hghBZ"), "gemini"); // 새 Google 키 형식
  assert.equal(detectProvider(null), "gemini");
});

// ── Gemini 요청·응답 ───────────────────────────────────────────
test("Gemini 요청: 이미지 inline_data + JSON 모드 + thinking off", () => {
  const req = buildGeminiRequest("B64", labelPrompt(["diabetes"]));
  const part0 = req.contents[0].parts[0];
  assert.equal(part0.inline_data.mime_type, "image/jpeg");
  assert.equal(part0.inline_data.data, "B64");
  assert.match(req.contents[0].parts[1].text, /1회 제공량/);
  assert.equal(req.generationConfig.responseMimeType, "application/json");
  assert.equal(req.generationConfig.thinkingConfig.thinkingBudget, 0);
});

test("Gemini 파싱: candidates→parts 텍스트 추출, 그 텍스트를 parseLabelReply가 처리", () => {
  const labelJson = JSON.stringify({
    is_label: true, food_name: "라면", confidence: "high", kcal: 500, carbs_g: 79,
    sugar_g: 4, sodium_mg: 1790, protein_g: 10, fat_g: 16, servings_per_pack: -1,
    purine_level: "medium", health_note: "", portion_advice: ""
  });
  const data = { candidates: [{ content: { parts: [{ text: labelJson }] } }] };
  const text = parseGeminiText(data);
  assert.equal(parseLabelReply(text).sodium_mg, 1790);
  // 방어: 빈 응답
  assert.equal(parseGeminiText({}), "");
  assert.equal(parseGeminiText(null), "");
});

test("AI 요청: 모델·이미지 블록·프롬프트 JSON 지시 포함 (구조화출력 미사용)", () => {
  const req = buildFoodRequest("BASE64DATA");
  assert.equal(req.model, MODEL);
  // 구조화 출력은 브라우저 직접 호출에서 400을 내므로 쓰지 않는다
  assert.equal(req.output_config, undefined);
  const content = req.messages[0].content;
  assert.equal(content[0].type, "image");
  assert.equal(content[0].source.media_type, "image/jpeg");
  assert.equal(content[0].source.data, "BASE64DATA");
  assert.equal(content[1].type, "text");
  // 프롬프트에 JSON 키가 명시돼야 모델이 형식을 맞춘다
  assert.match(content[1].text, /sugar_g/);
  assert.match(content[1].text, /purine_level/);
  assert.match(content[1].text, /portion_advice/);
  assert.match(content[1].text, /JSON/);
});

test("AI 요청: 선택 질환이 프롬프트에 반영", () => {
  const req = buildFoodRequest("X", ["hypertension", "gout"]);
  assert.match(req.messages[0].content[1].text, /고혈압·통풍 환자/);
});

test("AI 요청: 질환 미지정 시 일반 사용자 문구", () => {
  const req = buildFoodRequest("X");
  assert.match(req.messages[0].content[1].text, /일반 사용자/);
  assert.doesNotMatch(req.messages[0].content[1].text, /환자/);
});

const GOOD = {
  food_name: "김치찌개", confidence: "high", kcal: 450, carbs_g: 20,
  sugar_g: 5, sodium_mg: 1500, protein_g: 25, fat_g: 28,
  purine_level: "medium", health_note: "나트륨 주의", portion_advice: "국물은 남기세요"
};

test("AI 파싱: 순수 JSON", () => {
  const r = parseAiReply(JSON.stringify(GOOD));
  assert.equal(r.food_name, "김치찌개");
  assert.equal(r.sugar_g, 5);
});

test("AI 요청·파싱: 알레르기 지시·allergy_hits 방어", () => {
  // 알레르기가 있으면 프롬프트에 목록+지시 포함
  const p = buildFoodRequest("X", ["diabetes"], ["계란", "땅콩"]).messages[0].content[1].text;
  assert.match(p, /알레르기: 계란, 땅콩/);
  assert.match(p, /allergy_hits/);
  // 없으면 알레르기 목록 지시문 없음 (JSON 스키마 키 설명은 항상 있음)
  const q = buildFoodRequest("X", ["diabetes"]).messages[0].content[1].text;
  assert.doesNotMatch(q, /알레르기: /);
  // 파싱: 정상 배열 통과, 이상값은 []
  const withHits = Object.assign({}, GOOD, { allergy_hits: ["계란", 3, "  ", "땅콩"] });
  assert.deepEqual(parseAiReply(JSON.stringify(withHits)).allergy_hits, ["계란", "땅콩"]);
  assert.deepEqual(parseAiReply(JSON.stringify(GOOD)).allergy_hits, []);
  const bad = Object.assign({}, GOOD, { allergy_hits: "계란" });
  assert.deepEqual(parseAiReply(JSON.stringify(bad)).allergy_hits, []);
  // 성분표·메뉴판 프롬프트에도 반영
  assert.match(buildLabelRequest("X", [], ["우유"]).messages[0].content[1].text, /알레르기: 우유/);
  const { menuBoardPrompt } = require("../js/ai.js");
  assert.match(menuBoardPrompt([], { sugarG: 1, sodiumMg: 1, kcal: 1 }, "", ["새우"]), /알레르기: 새우.*avoid/);
});

test("AI 요청·파싱: 카페인 포함", () => {
  assert.match(buildFoodRequest("X").messages[0].content[1].text, /caffeine_mg/);
  const r = parseAiReply(JSON.stringify(Object.assign({}, GOOD, { caffeine_mg: 95 })));
  assert.equal(r.caffeine_mg, 95);
  // 누락 시 0으로 방어
  assert.equal(parseAiReply(JSON.stringify(GOOD)).caffeine_mg, 0);
});

test("AI 파싱: 코드펜스로 감싼 JSON", () => {
  const r = parseAiReply("```json\n" + JSON.stringify(GOOD) + "\n```");
  assert.equal(r.food_name, "김치찌개");
});

test("AI 파싱: 앞뒤 잡담 섞인 JSON", () => {
  const r = parseAiReply("분석 결과입니다.\n" + JSON.stringify(GOOD) + "\n참고하세요.");
  assert.equal(r.sodium_mg, 1500);
});

test("AI 파싱: 음수·문자열 수치는 0으로 방어", () => {
  const bad = Object.assign({}, GOOD, { kcal: -10, sugar_g: "많음" });
  const r = parseAiReply(JSON.stringify(bad));
  assert.equal(r.kcal, 0);
  assert.equal(r.sugar_g, 0);
});

test("AI 파싱: 이상한 confidence는 low로", () => {
  const bad = Object.assign({}, GOOD, { confidence: "maybe" });
  assert.equal(parseAiReply(JSON.stringify(bad)).confidence, "low");
});

test("AI 파싱: 이상한 purine_level은 low, 누락 portion_advice는 빈 문자열", () => {
  const bad = Object.assign({}, GOOD, { purine_level: "extreme" });
  delete bad.portion_advice;
  const r = parseAiReply(JSON.stringify(bad));
  assert.equal(r.purine_level, "low");
  assert.equal(r.portion_advice, "");
});

test("AI 파싱: JSON 아님 → null", () => {
  assert.equal(parseAiReply("죄송합니다, 분석할 수 없습니다."), null);
  assert.equal(parseAiReply(""), null);
  assert.equal(parseAiReply(null), null);
});

// ── 성분표 AI 판독 ─────────────────────────────────────────────
test("성분표 요청: 이미지·1회 제공량 환산·JSON 지시 포함 (구조화출력 미사용)", () => {
  const req = buildLabelRequest("B64", ["hypertension"]);
  assert.equal(req.model, MODEL);
  assert.equal(req.output_config, undefined); // 400 방지 — 프롬프트 기반 JSON
  assert.equal(req.messages[0].content[0].type, "image");
  const prompt = req.messages[0].content[1].text;
  assert.match(prompt, /1회 제공량 기준/);
  assert.match(prompt, /환산/);
  assert.match(prompt, /고혈압 환자/);
  // 프롬프트에 JSON 키와 sentinel(-1)이 명시돼야 한다
  assert.match(prompt, /is_label/);
  assert.match(prompt, /sodium_mg/);
  assert.match(prompt, /없으면 -1/);
});

const LABEL = {
  is_label: true, food_name: "신라면", confidence: "high",
  kcal: 500, carbs_g: 79, sugar_g: 4, sodium_mg: 1790, protein_g: 10, fat_g: 16,
  servings_per_pack: null, purine_level: "medium",
  health_note: "나트륨이 매우 높아요", portion_advice: "국물은 남기세요"
};

test("성분표 파싱: 정상 라벨", () => {
  const r = parseLabelReply(JSON.stringify(LABEL));
  assert.equal(r.is_label, true);
  assert.equal(r.sodium_mg, 1790);
  assert.equal(r.food_name, "신라면");
});

test("성분표 파싱: 표에 없는 항목은 null (sentinel -1과 literal null 모두, 0으로 바꾸면 안 됨)", () => {
  const bad = Object.assign({}, LABEL, { sugar_g: -1, protein_g: null });
  const r = parseLabelReply(JSON.stringify(bad));
  assert.equal(r.sugar_g, null);   // -1 sentinel → null
  assert.equal(r.protein_g, null); // literal null → null (방어)
  assert.equal(r.sodium_mg, 1790); // 있는 값은 유지
});

test("성분표 파싱: 음수·문자열 수치는 null로 방어", () => {
  const bad = Object.assign({}, LABEL, { sodium_mg: -5, kcal: "많음" });
  const r = parseLabelReply(JSON.stringify(bad));
  assert.equal(r.sodium_mg, null);
  assert.equal(r.kcal, null);
});

test("성분표 파싱: is_label false·코드펜스 처리", () => {
  const notLabel = Object.assign({}, LABEL, { is_label: false });
  assert.equal(parseLabelReply("```json\n" + JSON.stringify(notLabel) + "\n```").is_label, false);
  assert.equal(parseLabelReply("응답 불가"), null);
});

test("성분표 파싱: 퓨린은 모르면 unknown (low 안심으로 기본 처리하면 안 됨)", () => {
  const bad = Object.assign({}, LABEL, { purine_level: "???" });
  assert.equal(parseLabelReply(JSON.stringify(bad)).purine_level, "unknown");
  const un = Object.assign({}, LABEL, { purine_level: "unknown" });
  assert.equal(parseLabelReply(JSON.stringify(un)).purine_level, "unknown");
});
