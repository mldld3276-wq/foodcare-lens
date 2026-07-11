/* AI 음식 분석 — Claude 또는 Gemini 비전으로 음식 인식 + 전체 영양 추정 (다질환 맞춤).
   프롬프트 생성·응답 파싱은 순수 함수(node 테스트 가능). 실제 호출만 브라우저 전용.
   제공자는 API 키 접두사로 자동 감지 (sk-ant → Claude, AIza → Gemini). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FoodAI = factory();
})(typeof self !== "undefined" ? self : this, function () {

  var API_URL = "https://api.anthropic.com/v1/messages";
  var MODEL = "claude-opus-4-8";
  // 무료 등급에서 인기 모델은 자주 503("high demand")이 나므로 여러 모델을 순서대로 시도한다.
  // 앞쪽이 우선(정확도 높은 순), 붐비면 다음으로 폴백. 특정 버전 박기는 404 위험이 있어 지양.
  var GEMINI_MODELS = ["gemini-3-flash-preview", "gemini-flash-lite-latest", "gemini-flash-latest"];
  function geminiUrl(model) {
    return "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
  }

  /** API 키로 제공자 판별. Claude 키만 'sk-ant' 접두사가 고정이고,
      Google 키는 형식이 여러 가지(AIza, AQ. 등)라 sk-ant가 아니면 Gemini로 본다. */
  function detectProvider(apiKey) {
    return (apiKey || "").indexOf("sk-ant") === 0 ? "claude" : "gemini";
  }

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
    // base64Jpeg가 없으면 텍스트 전용 요청 (문진·메뉴 추천 등)
    var content = base64Jpeg
      ? [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Jpeg } },
          { type: "text", text: prompt }
        ]
      : prompt;
    return {
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: content }]
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
    "  \"caffeine_mg\": 숫자(카페인 mg, 커피·차·에너지드링크·초콜릿 등. 없으면 -1),\n" +
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
    "  \"caffeine_mg\": 숫자(카페인 mg, 커피·차·에너지드링크·초콜릿 등. 없으면 0),\n" +
    "  \"purine_level\": \"low\" | \"medium\" | \"high\",\n" +
    "  \"health_note\": \"한 줄 조언(한국어, 60자 이내)\",\n" +
    "  \"portion_advice\": \"섭취량 조언(한국어, 40자 이내)\"\n" +
    "}";

  /** 성분표 판독 프롬프트 (순수 함수) */
  function labelPrompt(diseases) {
    return "사진 속 영양성분표를 읽어 주세요. 수치는 반드시 1회 제공량 기준으로 환산해 주세요 " +
      "(표가 100g 기준 또는 총 내용량 기준이면 1회 제공량으로 환산하고, 1회 제공량 정보가 없으면 표에 적힌 값을 그대로). " +
      "표에 없는 항목은 -1로 하세요. 0으로 적지 마세요. " +
      "제품 종류를 보고 퓨린 등급도 추정하되, 무슨 제품인지 알 수 없으면 unknown으로 하세요. " +
      whoLine(diseases) + " " +
      "영양성분표가 보이지 않는 사진이면 is_label을 false로 하세요." + LABEL_JSON_SPEC;
  }

  /** 음식 추정 프롬프트 (순수 함수) */
  function foodPrompt(diseases) {
    return "사진 속 음식이 무엇인지 알아보고, 사진에 보이는 양 기준 영양성분을 추정해 주세요. " +
      "모든 수치는 대략적인 추정치입니다. 음식이 여러 개면 전체 합으로 추정하세요. " +
      whoLine(diseases) + " " +
      "음식이 아니거나 알아볼 수 없으면 food_name을 \"알 수 없음\", confidence를 \"low\"로 하고 수치는 0으로 하세요." +
      FOOD_JSON_SPEC;
  }

  /** Claude 성분표/음식 요청 본문 (순수 함수, 테스트용) */
  function buildLabelRequest(base64Jpeg, diseases) { return visionRequest(base64Jpeg, labelPrompt(diseases)); }
  function buildFoodRequest(base64Jpeg, diseases) { return visionRequest(base64Jpeg, foodPrompt(diseases)); }

  /** 바코드 숫자 판독 프롬프트 (순수 함수) — 자동 인식이 안 되는 기기의 AI 폴백 */
  function barcodePrompt() {
    return "사진 속 바코드의 숫자(보통 막대 아래 인쇄된 8~13자리)를 읽어 주세요. " +
      "숫자만 정확히 옮기고, 읽을 수 없으면 빈 문자열로 하세요." +
      "\n\n반드시 아래 JSON 형식 하나만 출력하세요. 설명·코드펜스 없이 JSON만:\n" +
      "{ \"barcode\": \"숫자만 (읽을 수 없으면 \\\"\\\")\" }";
  }
  function buildBarcodeRequest(base64Jpeg) { return visionRequest(base64Jpeg, barcodePrompt()); }

  /** 바코드 응답 → 숫자 문자열 (순수 함수). 8~14자리 아니면 "" */
  function parseBarcodeReply(text) {
    var obj = extractJson(text);
    if (!obj || typeof obj.barcode !== "string") return "";
    var digits = obj.barcode.replace(/\D/g, "");
    return (digits.length >= 8 && digits.length <= 14) ? digits : "";
  }

  /** 물건 알아보기 프롬프트 (순수 함수) — 사진 속 물건이 무엇인지 어르신에게 설명 */
  function objectPrompt() {
    return "사진 속 물건이 무엇인지 알아보고, 어르신께 말하듯 쉽게 설명해 주세요. " +
      "무엇에 쓰는 물건인지, 주의할 점이 있다면 함께요. 알아볼 수 없으면 name을 빈 문자열로 하세요." +
      "\n\n반드시 아래 JSON 형식 하나만 출력하세요. 설명·코드펜스 없이 JSON만:\n" +
      "{\n" +
      "  \"name\": \"물건 이름(한국어, 짧게. 모르면 \\\"\\\")\",\n" +
      "  \"description\": \"쉬운 설명(한국어, 2~3문장, 존댓말)\"\n" +
      "}";
  }
  function buildObjectRequest(base64Jpeg) { return visionRequest(base64Jpeg, objectPrompt()); }

  /** 물건 응답 → {name, description} (순수 함수). 실패 시 null */
  function parseObjectReply(text) {
    var obj = extractJson(text);
    if (!obj || typeof obj.name !== "string") return null;
    return {
      name: obj.name.trim(),
      description: typeof obj.description === "string" ? obj.description.trim() : ""
    };
  }

  /** 이상징후 문진 프롬프트 (순수 함수) — 진단 금지, 3단계 안내, 보수적 판정 */
  function symptomPrompt(symptom, diseases, dietSummary) {
    return "당신은 의료 안내 도우미입니다. 절대 병명을 진단하지 말고, " +
      "지금 병원에 가야 할 신호인지 3단계 중 하나로만 안내하세요: " +
      "emergency(즉시 응급실), doctor(1~2일 내 병원 진료 권함), watch(집에서 지켜보기). " +
      "판단이 애매하면 반드시 더 안전한(윗) 단계를 고르세요. " +
      whoLine(diseases) + " " +
      (dietSummary ? "최근 식단 기록:\n" + dietSummary + "\n" : "최근 식단 기록은 없습니다. ") +
      "사용자가 말한 증상: \"" + symptom + "\"" +
      "\n\n반드시 아래 JSON 형식 하나만 출력하세요. 설명·코드펜스 없이 JSON만:\n" +
      "{\n" +
      "  \"level\": \"emergency\" | \"doctor\" | \"watch\",\n" +
      "  \"reason\": \"증상과 식단의 연관 가능성 설명(한국어 1~2문장, '~일 수 있어요'처럼 단정 금지)\",\n" +
      "  \"advice\": \"지금 할 일(한국어 1~2문장, 쉬운 존댓말)\",\n" +
      "  \"watch_for\": \"이런 신호가 생기면 바로 병원(한국어 한 문장)\"\n" +
      "}";
  }

  /** 문진 응답 → {level, reason, advice, watch_for} (순수 함수).
      level이 이상하면 보수적으로 doctor. JSON 아니면 null */
  function parseSymptomReply(text) {
    var obj = extractJson(text);
    if (!obj || typeof obj.reason !== "string") return null;
    var level = ["emergency", "doctor", "watch"].indexOf(obj.level) !== -1
      ? obj.level : "doctor"; // 애매하면 병원 권유가 안전
    return {
      level: level,
      reason: obj.reason.trim(),
      advice: typeof obj.advice === "string" ? obj.advice.trim() : "",
      watch_for: typeof obj.watch_for === "string" ? obj.watch_for.trim() : ""
    };
  }

  /** 브라우저 전용: 증상 + 최근 식단 → 3단계 안내 */
  function analyzeSymptom(symptom, apiKey, diseases, dietSummary) {
    return callVision(null, symptomPrompt(symptom, diseases, dietSummary), apiKey)
      .then(function (text) {
        var parsed = parseSymptomReply(text);
        if (!parsed) throw new Error("PARSE");
        return parsed;
      });
  }

  /** 오늘의 메뉴 추천 프롬프트 (순수 함수) — 남은 한도 안에서 */
  function menuPrompt(diseases, remaining, mealName) {
    return whoLine(diseases) + " " +
      "오늘 남은 섭취 한도는 당류 " + remaining.sugarG + "g, 나트륨 " + remaining.sodiumMg +
      "mg, 열량 " + remaining.kcal + "kcal입니다. " +
      "이 한도 안에서 " + mealName + "(으)로 먹기 좋은 한국 가정식 메뉴 2가지를 추천하세요. " +
      "구하기 쉽고 만들기 쉬운 것으로요." +
      "\n\n반드시 아래 JSON 형식 하나만 출력하세요. 설명·코드펜스 없이 JSON만:\n" +
      "{\n" +
      "  \"menus\": [ { \"name\": \"메뉴 이름\", \"reason\": \"남은 한도와 연결한 이유(한 문장)\" } ],\n" +
      "  \"tip\": \"조리·섭취 팁 한 문장\"\n" +
      "}";
  }

  /** 메뉴 응답 → {menus:[{name,reason}], tip} (순수 함수). 유효 메뉴 없으면 null */
  function parseMenuReply(text) {
    var obj = extractJson(text);
    if (!obj || !Array.isArray(obj.menus)) return null;
    var menus = obj.menus.filter(function (m) {
      return m && typeof m.name === "string" && m.name.trim();
    }).slice(0, 3).map(function (m) {
      return { name: m.name.trim(),
        reason: typeof m.reason === "string" ? m.reason.trim() : "" };
    });
    if (!menus.length) return null;
    return { menus: menus, tip: typeof obj.tip === "string" ? obj.tip.trim() : "" };
  }

  /** 식당 메뉴판 골라주기 프롬프트 (순수 함수) — 남은 한도·오늘 식단 반영 */
  function menuBoardPrompt(diseases, remaining, todaySummary) {
    return "사진은 식당 메뉴판(또는 급식표)입니다. 메뉴판에 실제로 적힌 메뉴만 읽고, " +
      "사용자에게 맞는 선택을 골라 주세요. " + whoLine(diseases) + " " +
      "오늘 남은 섭취 한도: 당류 " + remaining.sugarG + "g, 나트륨 " + remaining.sodiumMg +
      "mg, 열량 " + remaining.kcal + "kcal. " +
      (todaySummary ? "오늘 이미 먹은 것:\n" + todaySummary + "\n" : "오늘은 아직 기록된 식사가 없습니다. ") +
      "가장 좋은 메뉴 1개(best), 괜찮은 메뉴 1~2개(ok), 피해야 할 메뉴 1~2개(avoid)를 고르고, " +
      "이유는 남은 한도나 질환과 연결해 한 문장으로 쓰세요. " +
      "메뉴판이 보이지 않는 사진이면 is_menu를 false로 하세요." +
      "\n\n반드시 아래 JSON 형식 하나만 출력하세요. 설명·코드펜스 없이 JSON만:\n" +
      "{\n" +
      "  \"is_menu\": true 또는 false,\n" +
      "  \"picks\": [ { \"name\": \"메뉴 이름(메뉴판에 있는 그대로)\",\n" +
      "               \"verdict\": \"best\" | \"ok\" | \"avoid\",\n" +
      "               \"reason\": \"이유 한 문장(한국어, 쉬운 존댓말)\" } ],\n" +
      "  \"tip\": \"주문할 때 팁 한 문장(예: 국물은 남기세요)\"\n" +
      "}";
  }

  /** 메뉴판 응답 → {is_menu, picks(best→ok→avoid 정렬), tip} (순수 함수). 실패 시 null */
  function parseMenuBoardReply(text) {
    var obj = extractJson(text);
    if (!obj || !Array.isArray(obj.picks)) {
      // is_menu:false만 온 경우도 유효한 응답으로 취급
      if (obj && obj.is_menu === false) return { is_menu: false, picks: [], tip: "" };
      return null;
    }
    var order = { best: 0, ok: 1, avoid: 2 };
    var picks = obj.picks.filter(function (p) {
      return p && typeof p.name === "string" && p.name.trim();
    }).map(function (p) {
      return {
        name: p.name.trim(),
        verdict: order[p.verdict] !== undefined ? p.verdict : "ok",
        reason: typeof p.reason === "string" ? p.reason.trim() : ""
      };
    }).sort(function (a, b) { return order[a.verdict] - order[b.verdict]; }).slice(0, 6);
    if (obj.is_menu !== false && !picks.length) return null;
    return { is_menu: obj.is_menu !== false, picks: picks,
      tip: typeof obj.tip === "string" ? obj.tip.trim() : "" };
  }

  /** 브라우저 전용: 메뉴판 사진 → 추천/회피 목록 */
  function analyzeMenuBoard(base64Jpeg, apiKey, diseases, remaining, todaySummary) {
    return callVision(base64Jpeg, menuBoardPrompt(diseases, remaining, todaySummary), apiKey)
      .then(function (text) {
        var parsed = parseMenuBoardReply(text);
        if (!parsed) throw new Error("PARSE");
        return parsed;
      });
  }

  /** 브라우저 전용: 남은 한도 → 메뉴 추천 */
  function suggestMenu(apiKey, diseases, remaining, mealName) {
    return callVision(null, menuPrompt(diseases, remaining, mealName), apiKey)
      .then(function (text) {
        var parsed = parseMenuReply(text);
        if (!parsed) throw new Error("PARSE");
        return parsed;
      });
  }

  /** Gemini 요청 본문 (순수 함수). thinkingBudget 0으로 추론 끄고 JSON만 받는다.
      base64Jpeg가 없으면 텍스트 전용 요청. */
  function buildGeminiRequest(base64Jpeg, prompt) {
    var parts = base64Jpeg
      ? [{ inline_data: { mime_type: "image/jpeg", data: base64Jpeg } }, { text: prompt }]
      : [{ text: prompt }];
    return {
      contents: [{ parts: parts }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 }
      }
    };
  }

  /** Gemini 응답 → 텍스트 추출 (순수 함수) */
  function parseGeminiText(data) {
    var cand = ((data || {}).candidates || [])[0];
    var parts = (cand && cand.content && cand.content.parts) || [];
    return parts.map(function (p) { return p.text || ""; }).join("");
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
    ["kcal", "carbs_g", "sugar_g", "sodium_mg", "protein_g", "fat_g", "caffeine_mg"].forEach(function (k) {
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
    ["kcal", "carbs_g", "sugar_g", "sodium_mg", "protein_g", "fat_g", "caffeine_mg", "servings_per_pack"]
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

  // fetch에 타임아웃(AbortController)을 걸어주는 헬퍼
  function fetchWithTimeout(url, opts) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (resp) {
      if (timer) clearTimeout(timer);
      return resp;
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === "AbortError") throw new Error("TIMEOUT");
      throw err;
    });
  }

  // HTTP 상태 → 공통 오류 코드 + 본문에서 실제 사유 추출
  function toError(resp, body) {
    var detail = "";
    try { detail = (JSON.parse(body).error || {}).message || ""; } catch (e) { detail = ""; }
    if (!detail) detail = (body || "").slice(0, 200);
    var code = resp.status === 401 || resp.status === 403 ? "AUTH"
      : resp.status === 400 && /API_KEY_INVALID|API key not valid/i.test(detail) ? "AUTH"
      : resp.status === 429 ? "RATE"
      : resp.status >= 500 ? "OVERLOADED"
      : "API_" + resp.status;
    var err = new Error(code);
    err.detail = detail;
    return err;
  }

  /** 브라우저 전용: Claude 비전 호출 → 응답 텍스트 */
  function callClaude(base64Jpeg, prompt, apiKey) {
    return fetchWithTimeout(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(visionRequest(base64Jpeg, prompt))
    }).then(function (resp) {
      if (resp.ok) return resp.json();
      return resp.text().then(function (body) { throw toError(resp, body); });
    }).then(function (data) {
      if (data.stop_reason === "refusal") throw new Error("REFUSED");
      var textBlock = (data.content || []).filter(function (b) { return b.type === "text"; })[0];
      return textBlock ? textBlock.text : "";
    });
  }

  /** 브라우저 전용: Gemini 비전 호출 → 응답 텍스트.
      모델이 붐비면(503/429) 목록의 다음 모델로 자동 폴백한다. */
  function callGemini(base64Jpeg, prompt, apiKey, idx) {
    idx = idx || 0;
    return fetchWithTimeout(geminiUrl(GEMINI_MODELS[idx]) + "?key=" + encodeURIComponent(apiKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildGeminiRequest(base64Jpeg, prompt))
    }).then(function (resp) {
      if (resp.ok) return resp.json();
      return resp.text().then(function (body) { throw toError(resp, body); });
    }).then(function (data) {
      if (data.promptFeedback && data.promptFeedback.blockReason) throw new Error("REFUSED");
      var cand = ((data.candidates) || [])[0];
      if (cand && cand.finishReason === "SAFETY") throw new Error("REFUSED");
      return parseGeminiText(data);
    }).catch(function (err) {
      // 과부하·한도 초과 같은 일시 오류면 다음 모델로 재시도
      var retriable = err && (err.message === "OVERLOADED" || err.message === "RATE");
      if (retriable && idx + 1 < GEMINI_MODELS.length) {
        return callGemini(base64Jpeg, prompt, apiKey, idx + 1);
      }
      throw err;
    });
  }

  /** 제공자 자동 감지 후 비전 호출 → 응답 텍스트 */
  function callVision(base64Jpeg, prompt, apiKey) {
    return detectProvider(apiKey) === "gemini"
      ? callGemini(base64Jpeg, prompt, apiKey)
      : callClaude(base64Jpeg, prompt, apiKey);
  }

  /** 브라우저 전용: 음식 사진(base64 JPEG) → 영양 추정 */
  function analyzeFoodImage(base64Jpeg, apiKey, diseases) {
    return callVision(base64Jpeg, foodPrompt(diseases), apiKey).then(function (text) {
      var parsed = parseAiReply(text);
      if (!parsed) throw new Error("PARSE");
      return parsed;
    });
  }

  /** 브라우저 전용: 성분표 사진(base64 JPEG) → 라벨 판독 */
  function analyzeLabelImage(base64Jpeg, apiKey, diseases) {
    return callVision(base64Jpeg, labelPrompt(diseases), apiKey).then(function (text) {
      var parsed = parseLabelReply(text);
      if (!parsed) throw new Error("PARSE");
      return parsed;
    });
  }

  /** 브라우저 전용: 바코드 사진(base64 JPEG) → 바코드 숫자 ("" = 판독 실패) */
  function analyzeBarcodeImage(base64Jpeg, apiKey) {
    return callVision(base64Jpeg, barcodePrompt(), apiKey).then(function (text) {
      return parseBarcodeReply(text);
    });
  }

  /** 브라우저 전용: 물건 사진(base64 JPEG) → {name, description} (null = 판독 실패) */
  function analyzeObjectImage(base64Jpeg, apiKey) {
    return callVision(base64Jpeg, objectPrompt(), apiKey).then(function (text) {
      return parseObjectReply(text);
    });
  }

  return { buildFoodRequest: buildFoodRequest, parseAiReply: parseAiReply,
    buildLabelRequest: buildLabelRequest, parseLabelReply: parseLabelReply,
    buildBarcodeRequest: buildBarcodeRequest, parseBarcodeReply: parseBarcodeReply,
    buildObjectRequest: buildObjectRequest, parseObjectReply: parseObjectReply,
    analyzeObjectImage: analyzeObjectImage,
    symptomPrompt: symptomPrompt, parseSymptomReply: parseSymptomReply, analyzeSymptom: analyzeSymptom,
    menuPrompt: menuPrompt, parseMenuReply: parseMenuReply, suggestMenu: suggestMenu,
    menuBoardPrompt: menuBoardPrompt, parseMenuBoardReply: parseMenuBoardReply,
    analyzeMenuBoard: analyzeMenuBoard,
    buildGeminiRequest: buildGeminiRequest, parseGeminiText: parseGeminiText,
    detectProvider: detectProvider, foodPrompt: foodPrompt, labelPrompt: labelPrompt,
    analyzeFoodImage: analyzeFoodImage, analyzeLabelImage: analyzeLabelImage,
    analyzeBarcodeImage: analyzeBarcodeImage,
    MODEL: MODEL, GEMINI_MODELS: GEMINI_MODELS };
});
