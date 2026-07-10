/* 성분표 파서 — OCR 원시 텍스트에서 "당류 = N g"을 짝짓는 순수 함수.
   이 프로젝트의 핵심 난관(레이아웃 파싱). 실패 시 found:false를 돌려주고
   앱은 수동 입력 경로로 안내한다. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FoodParser = factory();
})(typeof self !== "undefined" ? self : this, function () {

  // OCR 텍스트 정규화: 개행→공백, 전각→반각, 흔한 오인식 보정
  function normalize(text) {
    if (!text) return "";
    return String(text)
      .replace(/[０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
      .replace(/，/g, ",").replace(/．/g, ".")
      .replace(/㎎/g, "mg").replace(/㎏/g, "kg").replace(/㎉/g, "kcal")
      .replace(/([0-9]),(?=[0-9]{3})/g, "$1")   // 천단위 콤마: 1,790mg → 1790mg
      .replace(/\s+/g, " ")   // 개행 포함 모든 공백을 단일 공백으로
      .trim();
  }

  var NUM = "([0-9]+(?:\\.[0-9]+)?)";

  /**
   * 성분표 텍스트에서 당류/나트륨/1회 제공량/총 제공 횟수를 추출한다.
   * @returns {object} { found, sugarG, isLessThan, sodiumMg, servingSizeG, servingUnit, servingsPerPack }
   */
  function parseLabel(rawText) {
    var text = normalize(rawText);
    var out = { found: false, sugarG: null, isLessThan: false, sodiumMg: null,
      servingSizeG: null, servingUnit: null, servingsPerPack: null };
    if (!text) return out;

    // ── 당류: "당류" 라벨 뒤 가장 가까운 숫자+g를 짝짓기 ("당 류"도 허용)
    // [^0-9가-힣]{0,8}: 라벨-숫자 사이 잡음(콜론·괄호 등)은 허용하되 한글을 배제해
    // "무당류 탄수화물 25g"처럼 다른 성분명을 건너뛴 잘못된 짝짓기를 차단
    var sugarRe = new RegExp("당\\s*류[^0-9가-힣]{0,8}" + NUM + "\\s*g", "i");
    var m = sugarRe.exec(text);
    if (m) {
      out.found = true;
      out.sugarG = parseFloat(m[1]);
      // "1g 미만" 표기
      var after = text.slice(m.index, m.index + m[0].length + 6);
      if (/미만/.test(after)) out.isLessThan = true;
    } else if (/무\s*당\s*류|당\s*류[^0-9가-힣]{0,8}(없음|무)/.test(text)) {
      // "당류 없음" / "당류 무" / "무당류"
      out.found = true;
      out.sugarG = 0;
    }

    // ── 나트륨: "나트륨 200mg" / "나트륨 0.5g" (g는 mg로 환산)
    // 앞 경계 (?:^|[^가-힣]): "저나트륨"·"무나트륨" 마케팅 문구를 라벨로 오인하지 않게
    var naRe = new RegExp("(?:^|[^가-힣])나\\s*트\\s*륨[^0-9가-힣]{0,8}" + NUM + "\\s*(mg|g)", "i");
    var na = naRe.exec(text);
    if (na) {
      var naVal = parseFloat(na[1]);
      out.sodiumMg = /^g$/i.test(na[2]) ? Math.round(naVal * 1000) : naVal;
    }

    // ── 1회 제공량: "1회 제공량 30g" / "1회 제공량 200ml"
    var servRe = new RegExp("1\\s*회\\s*제공량[^0-9가-힣]{0,8}" + NUM + "\\s*(g|ml|㎖|mL|ML)", "i");
    var s = servRe.exec(text);
    if (s) {
      out.servingSizeG = parseFloat(s[1]);
      out.servingUnit = /g/i.test(s[2]) && !/ml/i.test(s[2]) ? "g" : "ml";
    }

    // ── 총 제공 횟수: "총 3회" / "총 3회 제공량"
    var cntRe = new RegExp("총\\s*" + NUM + "\\s*회");
    var c = cntRe.exec(text);
    if (c) out.servingsPerPack = parseFloat(c[1]);

    return out;
  }

  return { parseLabel: parseLabel, normalize: normalize };
});
