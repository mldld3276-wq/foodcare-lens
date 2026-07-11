const test = require("node:test");
const assert = require("node:assert");
const { offUrl, parseProduct } = require("../js/barcode.js");
const { parseBarcodeReply, buildBarcodeRequest, parseObjectReply, buildObjectRequest }
  = require("../js/ai.js");

test("바코드 URL: 코드가 인코딩되어 들어간다", () => {
  const u = offUrl("8801043014830");
  assert.match(u, /openfoodfacts\.org\/api\/v2\/product\/8801043014830\.json/);
  assert.match(u, /nutriments/);
});

test("상품 파싱: 1회 제공량 값이 있으면 serving 기준", () => {
  const json = { status: 1, product: {
    product_name: "Shin Ramyun", product_name_ko: "신라면", brands: "Nongshim",
    nutriments: {
      "energy-kcal_serving": 500, carbohydrates_serving: 79, sugars_serving: 4.2,
      sodium_serving: 1.79, proteins_serving: 10, fat_serving: 16,
      "energy-kcal_100g": 416
    }
  } };
  const p = parseProduct(json);
  assert.equal(p.food_name, "신라면");        // 한국어 이름 우선
  assert.equal(p.per, "serving");
  assert.equal(p.kcal, 500);
  assert.equal(p.sodium_mg, 1790);             // g → mg
  assert.equal(p.sugar_g, 4.2);
});

test("상품 파싱: serving 없어도 serving_quantity 있으면 환산 (converted)", () => {
  const json = { status: 1, product: {
    product_name: "Cola",
    serving_quantity: 500, // 500ml 한 병
    nutriments: {
      "energy-kcal_100g": 42, carbohydrates_100g: 10.6, sugars_100g: 10.6,
      salt_100g: 0.025, caffeine_100g: 0.01
    }
  } };
  const p = parseProduct(json);
  assert.equal(p.per, "converted");
  assert.equal(p.kcal, 210);          // 42 × 5
  assert.equal(p.sugar_g, 53);        // 10.6 × 5 — 한 병 실제 당류
  assert.equal(p.sodium_mg, 50);      // salt 0.025 × 5 ÷ 2.5 × 1000
  assert.equal(p.caffeine_mg, 50);    // 0.01 × 5 g → mg
});

test("상품 파싱: serving_quantity도 없으면 100g 기준 (판정 보류용)", () => {
  const json = { status: 1, product: {
    product_name: "Soy sauce",
    nutriments: { "energy-kcal_100g": 60, sodium_100g: 6 }
  } };
  const p = parseProduct(json);
  assert.equal(p.per, "100g");
  assert.equal(p.sodium_mg, 6000);
  assert.equal(p.protein_g, undefined); // 없는 값은 undefined (판정 불가)
});

test("상품 파싱: 없는 상품(status 0)·영양정보 전무 → null", () => {
  assert.equal(parseProduct({ status: 0 }), null);
  assert.equal(parseProduct(null), null);
  assert.equal(parseProduct({ status: 1, product: { product_name: "X", nutriments: {} } }), null);
});

test("상품 파싱: 음수·문자열 수치는 undefined로 방어", () => {
  const json = { status: 1, product: {
    product_name: "X",
    nutriments: { "energy-kcal_100g": 100, sugars_100g: -5, sodium_100g: "많음" }
  } };
  const p = parseProduct(json);
  assert.equal(p.kcal, 100);
  assert.equal(p.sugar_g, undefined);
  assert.equal(p.sodium_mg, undefined);
});

// ── AI 바코드 숫자 판독 (BarcodeDetector 미지원 기기 폴백) ─────
test("AI 바코드 요청: 프롬프트에 JSON 지시 포함", () => {
  const req = buildBarcodeRequest("B64");
  assert.equal(req.messages[0].content[0].type, "image");
  assert.match(req.messages[0].content[1].text, /barcode/);
  assert.match(req.messages[0].content[1].text, /JSON/);
});

test("AI 바코드 파싱: 숫자만 추출, 8~14자리 아니면 빈 문자열", () => {
  assert.equal(parseBarcodeReply('{"barcode":"8801043014830"}'), "8801043014830");
  assert.equal(parseBarcodeReply('{"barcode":"880 1043 014830"}'), "8801043014830"); // 공백 제거
  assert.equal(parseBarcodeReply('{"barcode":"123"}'), "");      // 너무 짧음
  assert.equal(parseBarcodeReply('{"barcode":""}'), "");
  assert.equal(parseBarcodeReply("읽을 수 없음"), "");
});

// ── 알레르기 매칭 ──────────────────────────────────────────────
test("알레르겐 매칭: OFF 태그 ↔ 한국어 동의어 (계란=달걀)", () => {
  const { matchAllergens } = require("../js/barcode.js");
  const tags = ["en:eggs", "en:milk", "en:gluten"];
  assert.deepEqual(matchAllergens(tags, ["달걀"]), ["달걀"]);   // eggs 동의어
  assert.deepEqual(matchAllergens(tags, ["계란"]), ["계란"]);
  assert.deepEqual(matchAllergens(tags, ["우유", "땅콩"]), ["우유"]); // 땅콩 없음
  assert.deepEqual(matchAllergens(tags, ["밀"]), ["밀"]);       // gluten → 밀
  assert.deepEqual(matchAllergens(tags, []), []);
  assert.deepEqual(matchAllergens([], ["계란"]), []);
});

test("상품 파싱: allergens+traces 태그 합산", () => {
  const json = { status: 1, product: {
    product_name: "과자",
    nutriments: { "energy-kcal_100g": 500 },
    allergens_tags: ["en:milk"], traces_tags: ["en:peanuts"]
  } };
  const p = parseProduct(json);
  assert.deepEqual(p.allergen_tags, ["en:milk", "en:peanuts"]);
  const { matchAllergens } = require("../js/barcode.js");
  assert.deepEqual(matchAllergens(p.allergen_tags, ["땅콩"]), ["땅콩"]); // 혼입 가능도 경고
});

// ── 물건 알아보기 ──────────────────────────────────────────────
test("물건 요청: 이미지 + JSON 지시 포함", () => {
  const req = buildObjectRequest("B64");
  assert.equal(req.messages[0].content[0].type, "image");
  assert.match(req.messages[0].content[1].text, /물건/);
  assert.match(req.messages[0].content[1].text, /JSON/);
});

test("물건 파싱: name·description 추출, 실패 시 null", () => {
  const r = parseObjectReply('{"name":"혈압계","description":"팔에 감아 혈압을 재는 기계예요."}');
  assert.equal(r.name, "혈압계");
  assert.match(r.description, /혈압/);
  assert.equal(parseObjectReply("모르겠어요"), null);
  assert.equal(parseObjectReply('{"name":""}').name, ""); // 인식 실패 신호는 호출부가 처리
});
