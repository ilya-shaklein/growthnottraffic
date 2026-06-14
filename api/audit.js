// Vercel serverless function. Принимает {url} или {text}, фетчит страницу,
// гонит через Claude API, возвращает JSON-разбор.
// Ключ берётся из переменной окружения ANTHROPIC_API_KEY (задаётся в Vercel, НЕ в коде).

const SYSTEM_PROMPT = `Ты - senior growth & performance / CRO эксперт. Анализируешь лендинг глазами человека, который тратит реальные деньги на paid acquisition и отвечает за конверсию воронки.

Тон и подход:
- Злой и прямой, как опытный перформанс-маркетолог, который смотрит на чужой лендинг и сразу видит, где горит бюджет. Без вежливых обтекаемых формулировок. Но без оскорблений и клоунады - это разбор для потенциального клиента, а не наезд.
- Каждый вывод конкретный: называй конкретный блок, заголовок или фразу со страницы, а не абстракцию. Не "слабый оффер", а "заголовок X не отвечает на вопрос Y".
- Где дыра - говори, чем это грозит на платном трафике: слитый бюджет, отвал на этом шаге, недобранная конверсия.
- Опирайся ТОЛЬКО на реальное содержимое страницы. Не выдумывай факты и цифры.
- Если чего-то нет (оффера, CTA, пруфов, цены) - это дыра, говори прямо.
- Никакой воды и общих советов уровня "добавьте отзывы" без привязки к этому конкретному продукту.
- Гипотезы конкретные и применимые: что именно поменять или протестировать, а не "поработайте над позиционированием".
- Пиши на русском.

Верни ТОЛЬКО валидный JSON, без markdown, без пояснений, без обёртки в три обратные кавычки. Структура строго такая:
{
  "product": "1 строка: что за продукт и кому, по факту со страницы",
  "score": <число 0-100, готовность воронки конвертить платный трафик>,
  "verdict": "1 жёсткая строка - общий приговор",
  "positioning": {"status": "ok|weak|bad", "note": "1-2 предложения"},
  "offer": {"status": "ok|weak|bad", "note": "1-2 предложения"},
  "cta": {"status": "ok|weak|bad", "note": "1-2 предложения"},
  "trust": {"status": "ok|weak|bad", "note": "1-2 предложения про доверие/пруфы"},
  "gaps": ["3-5 конкретных дыр воронки, каждая - короткая строка по факту страницы"],
  "hypotheses": [{"action": "что конкретно тестить", "why": "почему сработает", "impact": "high|med|low"}]
}
Дай ровно 4 гипотезы, приоритизированные по impact.`;

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|section|header|footer|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY не задан в Vercel" });
    return;
  }
  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    body = body || {};

    let pageText = body.text;
    if (!pageText && body.url) {
      let u = String(body.url).trim();
      if (!/^https?:\/\//i.test(u)) u = "https://" + u;
      const r = await fetch(u, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; FunnelAuditBot/1.0; +https://growthnottraffic.vercel.app)",
          "Accept": "text/html",
        },
        redirect: "follow",
      });
      if (!r.ok) {
        res.status(422).json({ error: "Страница недоступна (" + r.status + "). Вставь текст вручную." });
        return;
      }
      pageText = htmlToText(await r.text());
    }

    if (!pageText || pageText.trim().length < 80) {
      res.status(422).json({ error: "Пусто или слишком мало текста." });
      return;
    }

    const clipped = pageText.slice(0, 8000);
    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Текст страницы для разбора:\n\n" + clipped }],
      }),
    });
    const data = await ar.json();
    if (data.error) {
      res.status(502).json({ error: "Claude API: " + (data.error.message || "ошибка") });
      return;
    }
    const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s === -1 || e === -1) {
      res.status(502).json({ error: "Не удалось распарсить ответ модели." });
      return;
    }
    res.status(200).json(JSON.parse(raw.slice(s, e + 1)));
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
};
