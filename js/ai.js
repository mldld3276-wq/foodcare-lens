/* AI 음식 분석 — Claude 비전 API로 음식 인식 + 전체 영양 추정 (다질환 맞춤).
   요청 생성(buildFoodRequest)과 응답 파싱(parseAiReply)은 순수 함수(node 테스트 가능).
   실제 네트워크 호출(analyzeFoodImage)만 브라우저 전용. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FoodAI = factory();
})(typeof self !== "undefined" ? self : this, function () {

  var API_URL = "https://api.anthropic.com/v1/messages";
  var MODEL = "claude-opus-4-8";

  var DISEASE_KO = { diabetes: "당뇨", hypertension: "고혈압", kidney: "신장질환", gout: "통풍" };

  // 구조화 출력 스키마 — 응답이 반드시 이 JSON 형태로 오도록 강제
  var FOOD_SCHEMA = {
    type: "object",
    properties: {
      food_name: { type: "string", description: "음식 이름 (한국어)" },
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "인식 확신도" },
      kcal: { type: "number", description: "사진 속 양 기준 열량 추정 (kcal)" },
      carbs_g: { type: "number", description: "탄수화물 g" },
      sugar_g: { type: "number", description: "당류 g" },
      sodium_mg: { type: "number", description: "나트륨 mg" },
      protein_g: { type: "number", description: "단백질 g" },
      fat_g: { type: "number", description: "지방 g" },
      purine_level: { type: "string", enum: ["low", "medium", "high"],
        description: "퓨린 함량 등급 (통풍 관점: 내장·등푸른생선·진한 육수는 high)" },
      health_note: { type: "string", description: "사용자 질환 관점 한 줄 조언 (한국어, 60자 이내)" },
      portion_advice: { type: "string",
        description: "얼마나 먹으면 좋을지 직관적 조언 (한국어, 40자 이내, 예: '절반만 드세요', '국물은 남기세요')" }
    },
    required: ["food_name", "confidence", "kcal", "carbs_g", "sugar_g", "sodium_mg",
      "protein_g", "fat_g", "purine_level", "health_note", "portion_advice"],
    additionalProperties: false
  };

  /** API 요청 본문 생성 (순수 함수). diseases: ["diabetes",...] — 조언 맞춤용 */
  function buildFoodRequest(base64Jpeg, diseases) {
    var dList = (diseases || []).map(function (d) { return DISEASE_KO[d]; }).filter(Boolean);
    var who = dList.length
      ? "사용자는 " + dList.join("·") + " 환자입니다. health_note와 portion_advice는 이 질환 관점에서 작성하세요."
      : "사용자는 특별한 질환이 없는 일반 사용자입니다. health_note와 portion_advice는 일반적인 건강 관리 관점에서 작성하세요.";
    var prompt =
      "사진 속 음식이 무엇인지 알아보고, 사진에 보이는 양 기준 영양성분을 추정해 주세요. " +
      "모든 수치는 대략적인 추정치입니다. 음식이 여러 개면 전체 합으로 추정하세요. " +
      who + " " +
      "음식이 아니거나 알아볼 수 없으면 food_name을 \"알 수 없음\", confidence를 \"low\"로 하고 수치는 0으로 하세요.";
    return {
      model: MODEL,
      max_tokens: 1500,
      output_config: { format: { type: "json_schema", schema: FOOD_SCHEMA } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Jpeg } },
          { type: "text", text: prompt }
        ]
      }]
    };
  }

  /** 응답 텍스트 → 영양 객체 (순수 함수). 실패 시 null */
  function parseAiReply(text) {
    if (!text || typeof text !== "string") return null;
    var t = text.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "");
    var s = t.indexOf("{"), e = t.lastIndexOf("}");
    if (s === -1 || e === -1 || e <= s) return null;
    var obj;
    try { obj = JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
    if (!obj || typeof obj.food_name !== "string") return null;
    ["kcal", "carbs_g", "sugar_g", "sodium_mg", "protein_g", "fat_g"].forEach(function (k) {
      var v = Number(obj[k]);
      obj[k] = (isNaN(v) || v < 0) ? 0 : Math.round(v * 10) / 10;
    });
    if (["high", "medium", "low"].indexOf(obj.confidence) === -1) obj.confidence = "low";
    if (["high", "medium", "low"].indexOf(obj.purine_level) === -1) obj.purine_level = "low";
    if (typeof obj.health_note !== "string") obj.health_note = "";
    if (typeof obj.portion_advice !== "string") obj.portion_advice = "";
    return obj;
  }

  var TIMEOUT_MS = 60000; // 노년층이 스피너에 갇히지 않게 상한

  /** 브라우저 전용: 사진(base64 JPEG) → Claude 비전 분석 */
  function analyzeFoodImage(base64Jpeg, apiKey, diseases) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    return fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(buildFoodRequest(base64Jpeg, diseases)),
      signal: ctrl ? ctrl.signal : undefined
    }).catch(function (err) {
      if (err && err.name === "AbortError") throw new Error("TIMEOUT");
      throw err;
    }).then(function (resp) {
      if (timer) clearTimeout(timer);
      if (resp.status === 401 || resp.status === 403) throw new Error("AUTH");
      if (resp.status === 429) throw new Error("RATE");
      if (resp.status >= 500) throw new Error("OVERLOADED"); // 500/503/529 — 서버 측 문제
      if (!resp.ok) throw new Error("API_" + resp.status);
      return resp.json();
    }).then(function (data) {
      if (data.stop_reason === "refusal") throw new Error("REFUSED");
      var textBlock = (data.content || []).filter(function (b) { return b.type === "text"; })[0];
      var parsed = parseAiReply(textBlock ? textBlock.text : "");
      if (!parsed) throw new Error("PARSE");
      return parsed;
    });
  }

  return { buildFoodRequest: buildFoodRequest, parseAiReply: parseAiReply,
    analyzeFoodImage: analyzeFoodImage, MODEL: MODEL };
});
