const test = require("node:test");
const assert = require("node:assert");
const { buildFoodRequest, parseAiReply, buildLabelRequest, parseLabelReply, MODEL }
  = require("../js/ai.js");

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
