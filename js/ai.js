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

  function whoLine(diseases) {
    var dList = (diseases || []).map(function (d) { return DISEASE_KO[d]; }).filter(Boolean);
    return dList.length
      ? "사용자는 " + dList.join("·") + " 환자입니다. health_note와 portion_advice는 이 질환 관점에서 작성하세요."
      : "사용자는 특별한 질환이 없는 일반 사용자입니다. health_note와 portion_advice는 일반적인 건강 관리 관점에서 작성하세요.";
  }

  // 이미지 1장 + 텍스트 프롬프트로 된 표준 요청 본문.
  // 구조화 출력(output_config.format)은 브라우저 직접 호출에서 형식 불일치로 400을 내므로
  // 사용하지 않고, 프롬프트에서 JSON 형식을 지시한 뒤 파서가 방어적으로 추출한다.
  function visionRequest(base64Jpeg, prompt) {
    return {
      model: MODEL,
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Jpeg } },
          { type: "text", text: prompt }
        ]
      }]
    };
  }

  var LABEL_JSON_SPEC =
    "\n\n반드시 아래 JSON 형식 하나만 출력하세요. 설명·인사·코드펜스 없이 JSON만:\n" +
    "{\n" +
    "  \"is_label\": true 또는 false (사진에 영양성분표가 보이는가),\n" +
    "  \"food_name\": \"제품명(포장에서 읽고, 없으면 '포장 식품')\",\n" +
    "  \"confidence\": \"high\" | \"medium\" | \"low\",\n" +
    "  \"kcal\": 숫자(1회 제공량 기준 열량, 없으면 -1),\n" +
    "  \"carbs_g\": 숫자(탄수화물 g, 없으면 -1),\n" +
    "  \"sugar_g\": 숫자(당류 g, 없으면 -1),\n" +
    "  \"sodium_mg\": 숫자(나트륨 mg, 없으면 -1),\n" +
    "  \"protein_g\": 숫자(단백질 g, 없으면 -1),\n" +
    "  \"fat_g\": 숫자(지방 g, 없으면 -1),\n" +
    "  \"servings_per_pack\": 숫자(총 제공 횟수, 없으면 -1),\n" +
    "  \"purine_level\": \"low\" | \"medium\" | \"high\" | \"unknown\",\n" +
    "  \"health_note\": \"한 줄 조언(한국어, 60자 이내)\",\n" +
    "  \"portion_advice\": \"섭취량 조언(한국어, 40자 이내)\"\n" +
    "}";

  var FOOD_JSON_SPEC =
    "\n\n반드시 아래 JSON 형식 하나만 출력하세요. 설명·인사·코드펜스 없이 JSON만:\n" +
    "{\n" +
    "  \"food_name\": \"음식 이름(한국어)\",\n" +
    "  \"confidence\": \"high\" | \"medium\" | \"low\",\n" +
    "  \"kcal\": 숫자, \"carbs_g\": 숫자, \"sugar_g\": 숫자, \"sodium_mg\": 숫자,\n" +
    "  \"protein_g\": 숫자, \"fat_g\": 숫자,\n" +
    "  \"purine_level\": \"low\" | \"medium\" | \"high\",\n" +
    "  \"health_note\": \"한 줄 조언(한국어, 60자 이내)\",\n" +
    "  \"portion_advice\": \"섭취량 조언(한국어, 40자 이내)\"\n" +
    "}";

  /** 성분표 사진 판독 요청 (순수 함수) */
  function buildLabelRequest(base64Jpeg, diseases) {
    var prompt =
      "사진 속 영양성분표를 읽어 주세요. 수치는 반드시 1회 제공량 기준으로 환산해 주세요 " +
      "(표가 100g 기준 또는 총 내용량 기준이면 1회 제공량으로 환산하고, 1회 제공량 정보가 없으면 표에 적힌 값을 그대로). " +
      "표에 없는 항목은 -1로 하세요. 0으로 적지 마세요. " +
      "제품 종류를 보고 퓨린 등급도 추정하되, 무슨 제품인지 알 수 없으면 unknown으로 하세요. " +
      whoLine(diseases) + " " +
      "영양성분표가 보이지 않는 사진이면 is_label을 false로 하세요." + LABEL_JSON_SPEC;
    return visionRequest(base64Jpeg, prompt);
  }

  /** API 요청 본문 생성 (순수 함수). diseases: ["diabetes",...] — 조언 맞춤용 */
  function buildFoodRequest(base64Jpeg, diseases) {
    var prompt =
      "사진 속 음식이 무엇인지 알아보고, 사진에 보이는 양 기준 영양성분을 추정해 주세요. " +
      "모든 수치는 대략적인 추정치입니다. 음식이 여러 개면 전체 합으로 추정하세요. " +
      whoLine(diseases) + " " +
      "음식이 아니거나 알아볼 수 없으면 food_name을 \"알 수 없음\", confidence를 \"low\"로 하고 수치는 0으로 하세요." +
      FOOD_JSON_SPEC;
    return visionRequest(base64Jpeg, prompt);
  }

  function extractJson(text) {
    if (!text || typeof text !== "string") return null;
    var t = text.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "");
    var s = t.indexOf("{"), e = t.lastIndexOf("}");
    if (s === -1 || e === -1 || e <= s) return null;
    try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
  }

  /** 응답 텍스트 → 영양 객체 (순수 함수). 실패 시 null */
  function parseAiReply(text) {
    var obj = extractJson(text);
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

  /** 성분표 응답 텍스트 → 라벨 객체 (순수 함수). 표에 없는 항목은 null 유지. 실패 시 null */
  function parseLabelReply(text) {
    var obj = extractJson(text);
    if (!obj || typeof obj.food_name !== "string") return null;
    obj.is_label = obj.is_label === true;
    ["kcal", "carbs_g", "sugar_g", "sodium_mg", "protein_g", "fat_g", "servings_per_pack"]
      .forEach(function (k) {
        if (obj[k] === null || obj[k] === undefined) { obj[k] = null; return; }
        var v = Number(obj[k]);
        obj[k] = (isNaN(v) || v < 0) ? null : Math.round(v * 10) / 10;
      });
    if (["high", "medium", "low"].indexOf(obj.confidence) === -1) obj.confidence = "low";
    // 라벨 경로 퓨린은 항상 추측 — 모르면 low(통풍 🟢 안심)가 아니라 unknown(판정 불가)이어야 안전
    if (["high", "medium", "low", "unknown"].indexOf(obj.purine_level) === -1) obj.purine_level = "unknown";
    if (typeof obj.health_note !== "string") obj.health_note = "";
    if (typeof obj.portion_advice !== "string") obj.portion_advice = "";
    return obj;
  }

  var TIMEOUT_MS = 60000; // 노년층이 스피너에 갇히지 않게 상한

  /** 브라우저 전용: 요청 본문 → 응답 텍스트 (타임아웃·오류 코드 공통 처리) */
  function callClaude(reqBody, apiKey) {
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
      body: JSON.stringify(reqBody),
      signal: ctrl ? ctrl.signal : undefined
    }).catch(function (err) {
      if (err && err.name === "AbortError") throw new Error("TIMEOUT");
      throw err;
    }).then(function (resp) {
      if (timer) clearTimeout(timer);
      if (resp.ok) return resp.json();
      // 오류 응답 — API가 알려주는 실제 사유를 본문에서 뽑아 err.detail에 담는다
      return resp.text().then(function (body) {
        var detail = "";
        try { detail = (JSON.parse(body).error || {}).message || ""; } catch (e) { detail = ""; }
        if (!detail) detail = (body || "").slice(0, 200);
        var code = resp.status === 401 || resp.status === 403 ? "AUTH"
          : resp.status === 429 ? "RATE"
          : resp.status >= 500 ? "OVERLOADED"
          : "API_" + resp.status;
        var err = new Error(code);
        err.detail = detail;
        throw err;
      });
    }).then(function (data) {
      if (data.stop_reason === "refusal") throw new Error("REFUSED");
      var textBlock = (data.content || []).filter(function (b) { return b.type === "text"; })[0];
      return textBlock ? textBlock.text : "";
    });
  }

  /** 브라우저 전용: 음식 사진(base64 JPEG) → 영양 추정 */
  function analyzeFoodImage(base64Jpeg, apiKey, diseases) {
    return callClaude(buildFoodRequest(base64Jpeg, diseases), apiKey).then(function (text) {
      var parsed = parseAiReply(text);
      if (!parsed) throw new Error("PARSE");
      return parsed;
    });
  }

  /** 브라우저 전용: 성분표 사진(base64 JPEG) → 라벨 판독 */
  function analyzeLabelImage(base64Jpeg, apiKey, diseases) {
    return callClaude(buildLabelRequest(base64Jpeg, diseases), apiKey).then(function (text) {
      var parsed = parseLabelReply(text);
      if (!parsed) throw new Error("PARSE");
      return parsed;
    });
  }

  return { buildFoodRequest: buildFoodRequest, parseAiReply: parseAiReply,
    buildLabelRequest: buildLabelRequest, parseLabelReply: parseLabelReply,
    analyzeFoodImage: analyzeFoodImage, analyzeLabelImage: analyzeLabelImage, MODEL: MODEL };
});
