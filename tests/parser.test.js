const test = require("node:test");
const assert = require("node:assert");
const { parseLabel } = require("../js/parser.js");

// 실제 한국 식품 성분표에서 나올 법한 텍스트 16종 (설계 F: 15개 이상)
const CASES = [
  { name: "기본 표기", text: "영양정보 1회 제공량 30g 총 3회 제공량 열량 150kcal 탄수화물 20g 당류 18g 나트륨 120mg",
    expect: { sugarG: 18, servingSizeG: 30, servingsPerPack: 3 } },
  { name: "당류만", text: "당류 5g", expect: { sugarG: 5 } },
  { name: "경계값 15", text: "당류 15g", expect: { sugarG: 15 } },
  { name: "라벨 띄어쓰기", text: "당 류 7 g", expect: { sugarG: 7 } },
  { name: "붙여쓰기 0g", text: "당류0g", expect: { sugarG: 0 } },
  { name: "탄수화물과 혼동 방지", text: "탄수화물 30g 당류 12g 단백질 5g", expect: { sugarG: 12 } },
  { name: "1g 미만", text: "당류 1g 미만", expect: { sugarG: 1, isLessThan: true } },
  { name: "나트륨 mg 사이", text: "나트륨 200mg 당류 6g 지방 3g", expect: { sugarG: 6 } },
  { name: "소수점", text: "당류 3.5g", expect: { sugarG: 3.5 } },
  { name: "음료 ml", text: "1회 제공량 200ml 총 2회 당류 22g", expect: { sugarG: 22, servingSizeG: 200, servingsPerPack: 2 } },
  { name: "당류 없음 표기", text: "설탕 무첨가 당류 없음", expect: { sugarG: 0 } },
  { name: "넓은 공백", text: "당류   18   g", expect: { sugarG: 18 } },
  { name: "개행으로 분리", text: "당류\n18g", expect: { sugarG: 18 } },
  { name: "문장 속", text: "설탕 첨가 없음, 당류 2g 함유", expect: { sugarG: 2 } },
  { name: "퍼센트 병기", text: "당류 18g (18%)", expect: { sugarG: 18 } },
  { name: "콜론 구분", text: "당류: 9g", expect: { sugarG: 9 } },
];

for (const c of CASES) {
  test("파서: " + c.name, () => {
    const r = parseLabel(c.text);
    assert.equal(r.found, true, "found여야 함");
    assert.equal(r.sugarG, c.expect.sugarG, "당류 g");
    if (c.expect.servingSizeG !== undefined) assert.equal(r.servingSizeG, c.expect.servingSizeG, "1회 제공량");
    if (c.expect.servingsPerPack !== undefined) assert.equal(r.servingsPerPack, c.expect.servingsPerPack, "총 횟수");
    if (c.expect.isLessThan) assert.equal(r.isLessThan, true, "미만 플래그");
  });
}

test("파서: 나트륨 mg 추출", () => {
  const r = parseLabel("나트륨 620mg 당류 8g");
  assert.equal(r.sodiumMg, 620);
  assert.equal(r.sugarG, 8);
});

test("파서: 나트륨 g 표기는 mg로 환산", () => {
  const r = parseLabel("당류 3g 나트륨 1.2g");
  assert.equal(r.sodiumMg, 1200);
});

test("파서: 나트륨 없으면 null", () => {
  assert.equal(parseLabel("당류 5g").sodiumMg, null);
});

// ── 적대적 리뷰에서 확인된 오판 케이스 (회귀 방지) ──────────────
test("파서: 천단위 콤마 나트륨 (라면) — 1,790mg", () => {
  assert.equal(parseLabel("당류 3g 나트륨 1,790mg").sodiumMg, 1790);
});

test("파서: 단일 글리프 ㎎ 단위", () => {
  assert.equal(parseLabel("당류 2g 나트륨 300㎎").sodiumMg, 300);
});

test("파서: '저나트륨' 문구를 라벨로 오인하지 않음", () => {
  const r = parseLabel("당류 3g 저나트륨 지방 5g 나트륨 300mg");
  assert.equal(r.sodiumMg, 300); // 5000(지방 5g×1000)이 아니어야 함
});

test("파서: '무당류'는 당류 0 — 탄수화물을 당류로 오인하지 않음", () => {
  const r = parseLabel("무당류 탄수화물 25g 나트륨 100mg");
  assert.equal(r.found, true);
  assert.equal(r.sugarG, 0); // 25가 아니어야 함
});

test("파서: '당류 없음 탄수화물 20g'은 당류 0", () => {
  const r = parseLabel("당류 없음 탄수화물 20g");
  assert.equal(r.sugarG, 0); // 20이 아니어야 함
});

test("파서: 당류 수치 유실 시 다른 성분 수치를 짝짓지 않음", () => {
  const r = parseLabel("당류 g 단백질 15g");
  assert.equal(r.found, false); // 15를 당류로 읽으면 안 됨
});

test("파서: 나트륨만 읽힌 성분표 — found=false지만 sodiumMg는 보존", () => {
  const r = parseLabel("나트륨 1200mg 단백질 8g");
  assert.equal(r.found, false);
  assert.equal(r.sodiumMg, 1200);
});

test("파서: 당류 없는 텍스트는 found=false", () => {
  const r = parseLabel("열량 300kcal 단백질 10g 지방 12g");
  assert.equal(r.found, false);
});

test("파서: 빈 입력", () => {
  assert.equal(parseLabel("").found, false);
  assert.equal(parseLabel(null).found, false);
});
