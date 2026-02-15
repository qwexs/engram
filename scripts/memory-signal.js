#!/usr/bin/env bun
// Детектор сигналов для real-time экстракции фактов из разговоров
// Использование: bun scripts/memory-signal.js --text "Я предпочитаю TypeScript"

const args = process.argv.slice(2);
const textIdx = args.indexOf("--text");
if (textIdx === -1 || !args[textIdx + 1]) {
  console.error("❌ Требуется --text \"сообщение\"");
  process.exit(1);
}
const text = args[textIdx + 1];

// Паттерны HIGH signal — немедленная экстракция
const HIGH_PATTERNS = {
  correction: [
    /на самом деле/i, /нет,?\s*я имел в виду/i, /я ошиб(ся|лась)/i,
    /actually/i, /correction/i, /I meant/i, /let me correct/i,
    /не так,?\s*(а|я)/i, /поправ(ка|лю)/i,
  ],
  preference: [
    /я предпочитаю/i, /мне нравится/i, /мне не нравится/i,
    /я люблю/i, /я не люблю/i, /мне больше подходит/i,
    /I prefer/i, /I like/i, /I don't like/i, /I dislike/i,
    /I love/i, /I hate/i, /my favorite/i, /мой любимый/i,
    /лучше использовать/i, /better to use/i,
  ],
  decision: [
    /я решил/i, /мы решили/i, /давай будем/i, /будем делать/i,
    /I decided/i, /we decided/i, /let's go with/i, /we'll use/i,
    /принято решение/i, /решение принято/i, /выбрал/i,
    /I've decided/i, /decision made/i,
  ],
  identity: [
    /я работаю/i, /меня зовут/i, /я по профессии/i, /мне \d+ (лет|год)/i,
    /I am a/i, /my name is/i, /I work (at|as|in)/i, /I'm a/i,
    /я живу в/i, /I live in/i, /я из /i, /I'm from/i,
  ],
  instruction: [
    /запомни/i, /remember\b/i, /всегда делай/i, /никогда не/i,
    /имей в виду/i, /учти,?\s*что/i, /важно,?\s*что/i,
    /always\b/i, /never\b/i, /keep in mind/i, /note that/i,
    /не забудь/i, /don't forget/i,
  ],
  milestone: [
    /мы запустили/i, /релиз/i, /задеплоили/i, /завершили/i,
    /deployed/i, /launched/i, /finished/i, /released/i,
    /shipped/i, /completed/i, /done with/i, /готово/i,
    /мы закончили/i, /проект готов/i,
  ],
};

// Паттерны LOW signal — записать в daily note
const LOW_PATTERNS = [
  // Упоминание людей/проектов
  /работа(ю|ем) над/i, /working on/i, /занимаюсь/i,
  /проект\b/i, /project\b/i, /задач[аи]/i, /task/i,
  // Обсуждение текущей работы
  /сделал/i, /сделаю/i, /делаю/i, /нужно/i,
  /I did/i, /I'll do/i, /I'm doing/i, /need to/i,
  /попробу[юем]/i, /let's try/i, /trying/i,
];

// Паттерны NONE — пропустить
const NONE_PATTERNS = [
  /^(ок|ok|да|yes|нет|no|ага|угу|ладно|хорошо|понял|sure|fine|great|cool|nice)[\s!.]*$/i,
  /^(привет|здравствуй|добр(ое|ый)|hi|hello|hey|good morning|good evening)[\s!.,]*$/i,
  /^(спасибо|благодарю|thanks|thank you|thx)[\s!.]*$/i,
  /^(пока|до свидания|bye|goodbye|see you)[\s!.]*$/i,
  /^\?+$/, // просто вопросительные знаки
  /^[👍👋🙏❤️😊😂🤣💪✅]+$/, // только эмодзи
];

// Извлечение ключевых слов (слова длиннее 3 символов, не стоп-слова)
const STOP_WORDS = new Set([
  "что", "как", "это", "для", "над", "при", "без", "все", "уже", "ещё", "еще",
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her",
  "was", "one", "our", "out", "with", "that", "this", "have", "from", "they",
  "been", "will", "into", "then", "than", "them", "some", "when", "what",
  "there", "which", "their", "would", "about", "could", "other",
  "очень", "тоже", "будет", "если", "нужно", "можно", "будем",
]);

function extractKeywords(text) {
  const words = text.replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/);
  return [...new Set(
    words.filter(w => w.length > 3 && !STOP_WORDS.has(w.toLowerCase()))
      .map(w => w)
  )].slice(0, 10);
}

// Основная логика
function detectSignal(text) {
  const trimmed = text.trim();

  // Проверить NONE сначала
  for (const p of NONE_PATTERNS) {
    if (p.test(trimmed)) {
      return { signal: "none", categories: [], keywords: [], confidence: 0.95 };
    }
  }

  // Проверить HIGH
  const matchedCategories = [];
  let maxConfidence = 0;
  for (const [category, patterns] of Object.entries(HIGH_PATTERNS)) {
    for (const p of patterns) {
      if (p.test(trimmed)) {
        if (!matchedCategories.includes(category)) matchedCategories.push(category);
        maxConfidence = Math.max(maxConfidence, 0.85);
        break;
      }
    }
  }

  if (matchedCategories.length > 0) {
    // Больше категорий = выше уверенность
    const confidence = Math.min(0.95, maxConfidence + matchedCategories.length * 0.03);
    return {
      signal: "high",
      categories: matchedCategories,
      keywords: extractKeywords(trimmed),
      confidence: parseFloat(confidence.toFixed(2)),
    };
  }

  // Проверить LOW
  for (const p of LOW_PATTERNS) {
    if (p.test(trimmed)) {
      return {
        signal: "low",
        categories: ["context"],
        keywords: extractKeywords(trimmed),
        confidence: 0.5,
      };
    }
  }

  // Вопросы без утверждений → none
  if (/^\s*(что|как|где|когда|зачем|почему|кто|what|how|where|when|why|who)\b/i.test(trimmed) && trimmed.endsWith("?")) {
    return { signal: "none", categories: [], keywords: [], confidence: 0.8 };
  }

  // По умолчанию — none
  return { signal: "none", categories: [], keywords: extractKeywords(trimmed), confidence: 0.3 };
}

const result = detectSignal(text);
console.log(JSON.stringify(result, null, 2));
