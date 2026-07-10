const test = require("node:test");
const assert = require("node:assert");
const { buildFoodRequest, parseAiReply, MODEL } = require("../js/ai.js");

test("AI 요청: 모델·구조화출력·이미지 블록 포함", () => {
  const req = buildFoodRequest("BASE64DATA");
  assert.equal(req.model, MODEL);
  assert.equal(req.output_config.format.type, "json_schema");
  assert.ok(req.output_config.format.schema.required.includes("sugar_g"));
  assert.ok(req.output_config.format.schema.required.includes("purine_level"));
  assert.ok(req.output_config.format.schema.required.includes("portion_advice"));
  const content = req.messages[0].content;
  assert.equal(content[0].type, "image");
  assert.equal(content[0].source.media_type, "image/jpeg");
  assert.equal(content[0].source.data, "BASE64DATA");
  assert.equal(content[1].type, "text");
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
