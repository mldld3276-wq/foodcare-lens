/* 바코드 조회 — Open Food Facts 공개 DB (키 불필요·브라우저 직접 호출 가능).
   파싱(parseProduct)은 순수 함수(node 테스트 가능), 네트워크 호출(lookup)만 브라우저 전용.
   ※ 식약처 식품안전나라 DB는 브라우저 직접 호출(CORS)이 막혀 있어 서버(프록시) 도입 단계에서 연동. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FoodBarcode = factory();
})(typeof self !== "undefined" ? self : this, function () {

  function offUrl(code) {
    return "https://world.openfoodfacts.org/api/v2/product/" + encodeURIComponent(code) +
      ".json?fields=product_name,product_name_ko,brands,nutriments,serving_quantity,serving_size" +
      ",allergens_tags,traces_tags";
  }

  // OFF 알레르겐 태그(en:xxx) → 한국어 동의어들
  var ALLERGEN_KO = {
    "eggs": ["계란", "달걀"], "egg": ["계란", "달걀"],
    "milk": ["우유", "유제품", "유당"],
    "gluten": ["밀", "글루텐"], "wheat": ["밀"],
    "soybeans": ["대두", "콩"], "soy": ["대두", "콩"],
    "peanuts": ["땅콩"],
    "nuts": ["견과류", "견과", "호두", "아몬드"], "tree-nuts": ["견과류", "견과"],
    "crustaceans": ["갑각류", "새우", "게"], "shrimp": ["새우", "갑각류"],
    "fish": ["생선"],
    "molluscs": ["조개", "조개류", "굴", "홍합"],
    "sesame": ["참깨", "깨"], "sesame-seeds": ["참깨", "깨"],
    "buckwheat": ["메밀"],
    "celery": ["셀러리"], "mustard": ["겨자"],
    "sulphur-dioxide-and-sulphites": ["아황산류", "아황산"],
    "peach": ["복숭아"], "pork": ["돼지고기"], "tomato": ["토마토"]
  };

  /** OFF 태그 배열 → 한국어 동의어 묶음 배열 (순수) */
  function allergenSynonyms(tags) {
    return (tags || []).map(function (t) {
      var key = String(t).replace(/^[a-z]{2}:/, "").toLowerCase();
      return ALLERGEN_KO[key] || [key];
    });
  }

  /**
   * 상품 알레르겐 태그 vs 사용자 알레르기 목록 매칭 (순수 함수).
   * @returns {string[]} 걸린 항목 — 사용자가 등록한 표현 그대로
   */
  function matchAllergens(productTags, userAllergies) {
    var groups = allergenSynonyms(productTags);
    var hits = [];
    (userAllergies || []).forEach(function (ua) {
      var term = String(ua).trim();
      if (!term) return;
      var hit = groups.some(function (syns) {
        return syns.some(function (s) {
          return s.indexOf(term) !== -1 || term.indexOf(s) !== -1;
        });
      });
      if (hit && hits.indexOf(term) === -1) hits.push(term);
    });
    return hits;
  }

  function num(v) {
    var n = Number(v);
    return (v == null || isNaN(n) || n < 0) ? undefined : Math.round(n * 10) / 10;
  }

  /**
   * Open Food Facts 응답 → 음식 정보 (순수 함수).
   * 1회 제공량 값이 있으면 그것을, 없으면 100g 기준을 쓴다 (per로 구분).
   * 영양 정보가 아예 없으면 null (성분표 촬영으로 유도).
   * @returns {object|null} { food_name, brands, per: "serving"|"100g",
   *                          kcal, carbs_g, sugar_g, sodium_mg, protein_g, fat_g, caffeine_mg }
   */
  function parseProduct(json) {
    if (!json || json.status !== 1 || !json.product) return null;
    var p = json.product;
    var nut = p.nutriments || {};

    var hasServing = nut["energy-kcal_serving"] != null || nut.sugars_serving != null ||
      nut.sodium_serving != null || nut.carbohydrates_serving != null;
    // 1회 제공량 값이 없어도 제공량(g)이 있으면 100g 값에서 환산한다
    var sq = Number(p.serving_quantity);
    var canConvert = !hasServing && !isNaN(sq) && sq > 0;
    var sfx = hasServing ? "_serving" : "_100g";
    var factor = canConvert ? sq / 100 : 1;
    function scaled(key) {
      var v = nut[key + sfx];
      if (v == null || isNaN(Number(v))) return undefined;
      return Number(v) * factor;
    }

    // 나트륨: sodium(g)→mg, 없으면 salt(소금, g)÷2.5→나트륨 g→mg
    var sodium = scaled("sodium");
    if (sodium == null) {
      var salt = scaled("salt");
      if (salt != null) sodium = salt / 2.5;
    }
    var sodiumMg = (sodium == null || sodium < 0) ? undefined : Math.round(sodium * 1000);

    // 카페인(g)→mg
    var caff = scaled("caffeine");
    var caffeineMg = (caff == null || caff < 0) ? undefined : Math.round(caff * 1000);

    var out = {
      food_name: p.product_name_ko || p.product_name || "바코드 상품",
      brands: p.brands || "",
      // serving: 1회 제공량 그대로 / converted: 100g값×제공량으로 환산 / 100g: 환산 불가(판정 보류)
      per: hasServing ? "serving" : (canConvert ? "converted" : "100g"),
      kcal: num(scaled("energy-kcal")),
      carbs_g: num(scaled("carbohydrates")),
      sugar_g: num(scaled("sugars")),
      sodium_mg: sodiumMg,
      protein_g: num(scaled("proteins")),
      fat_g: num(scaled("fat")),
      caffeine_mg: caffeineMg,
      // 알레르겐: 함유(allergens) + 혼입 가능(traces) 태그를 모두 경고 대상으로
      allergen_tags: (p.allergens_tags || []).concat(p.traces_tags || [])
    };

    // 판정에 쓸 수 있는 값이 하나도 없으면 '없는 상품' 취급 (성분표 촬영으로 유도)
    var usable = ["kcal", "carbs_g", "sugar_g", "sodium_mg", "protein_g", "fat_g"]
      .some(function (k) { return out[k] !== undefined; });
    if (!usable) return null;
    return out;
  }

  var TIMEOUT_MS = 10000;

  /** 브라우저 전용: 바코드 → 상품 영양 정보. 없으면 Error("NOT_FOUND") */
  function lookup(code) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    return fetch(offUrl(code), { signal: ctrl ? ctrl.signal : undefined })
      .catch(function (err) {
        if (err && err.name === "AbortError") throw new Error("TIMEOUT");
        throw err;
      })
      .then(function (resp) {
        if (timer) clearTimeout(timer);
        if (resp.status === 404) throw new Error("NOT_FOUND");
        if (!resp.ok) throw new Error("API_" + resp.status);
        return resp.json();
      })
      .then(function (json) {
        var p = parseProduct(json);
        if (!p) throw new Error("NOT_FOUND");
        return p;
      });
  }

  /** 이 기기가 카메라 자동 바코드 인식(BarcodeDetector)을 지원하는지 */
  function scanSupported() {
    return typeof BarcodeDetector !== "undefined";
  }

  return { offUrl: offUrl, parseProduct: parseProduct, lookup: lookup,
    scanSupported: scanSupported, matchAllergens: matchAllergens };
});
