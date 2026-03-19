#!/usr/bin/env bun
// Схема и валидация спецификаций экспериментов Autoresearch

/**
 * Схема спецификации эксперимента
 * @typedef {Object} ExperimentSpec
 * @property {string} id - Идентификатор "EXP-YYYY-MM-DD-NNN"
 * @property {string} created_by - "rethink" (всегда)
 * @property {string} created_at - ISO timestamp
 * @property {string[]} source_observations - ID наблюдений, которые вызвали эксперимент
 * @property {string} hypothesis - Гипотеза для проверки
 * @property {"research"|"analysis"|"comparison"|"validation"} type - Тип эксперимента
 * @property {string[]} actions - Шаги для выполнения
 * @property {string} metric - Метрика для измерения
 * @property {string} baseline - Базовое значение для сравнения
 * @property {string} success_criteria - Критерии успеха
 * @property {Budget} budget - Оценка бюджета и ROI
 * @property {Output} output - Настройки выходных данных
 * @property {Delivery} delivery - Настройки доставки результатов
 * @property {"pending"|"running"|"completed"|"failed"|"skipped"} status - Статус
 * @property {string|null} result_summary - Краткое резюме результата
 * @property {string[]} follow_up_observations - ID наблюдений для последующих действий
 */

/**
 * @typedef {Object} Budget
 * @property {number} estimated_tokens - Примерное количество токенов
 * @property {number} estimated_cost_usd - Примерная стоимость в USD
 * @property {Value} value - Оценка ценности
 * @property {number} roi_estimate - Оценка ROI (value / cost)
 * @property {"auto"|"propose"|"skip"} decision - Решение о выполнении
 */

/**
 * @typedef {Object} Value
 * @property {boolean} blocker - Блокирует ли критическую задачу
 * @property {number|null} deadline_days - Дней до дедлайна
 * @property {number|null} manual_hours_saved - Сэкономленные часы ручной работы
 */

/**
 * @typedef {Object} Output
 * @property {string} path - Путь для сохранения отчета
 * @property {"outline"|"daily_note"|"none"} publish_to - Куда опубликовать
 * @property {string} [collection_id] - ID коллекции в Outline
 */

/**
 * @typedef {Object} Delivery
 * @property {boolean} report - Создать отчет
 * @property {boolean} daily_note - Добавить в дневную заметку
 * @property {OutlineDelivery} [outline] - Настройки Outline
 * @property {GroupNotify} [group_notify] - Настройки уведомления группы
 */

/**
 * @typedef {Object} OutlineDelivery
 * @property {boolean} enabled - Включена ли публикация
 * @property {string} collection_id - ID коллекции
 */

/**
 * @typedef {Object} GroupNotify
 * @property {boolean} enabled - Включено ли уведомление
 * @property {string} chat_id - ID чата
 * @property {string} condition - Условие для отправки
 * @property {string} format - Формат сообщения
 */

const VALID_TYPES = ["research", "analysis", "comparison", "validation"];
const VALID_STATUSES = ["pending", "running", "completed", "failed", "skipped"];
const VALID_PUBLISH_TO = ["outline", "daily_note", "none"];
const VALID_BUDGET_DECISIONS = ["auto", "propose", "skip"];

/**
 * Валидация спецификации эксперимента
 * @param {ExperimentSpec} spec
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateExperimentSpec(spec) {
  const errors = [];

  // Обязательные поля
  if (!spec.id || typeof spec.id !== "string") {
    errors.push("Поле 'id' обязательно и должно быть строкой");
  } else if (!/^EXP-\d{4}-\d{2}-\d{2}-\d{3}$/.test(spec.id)) {
    errors.push("Поле 'id' должно быть в формате 'EXP-YYYY-MM-DD-NNN'");
  }

  if (spec.created_by !== "rethink") {
    errors.push("Поле 'created_by' должно быть 'rethink'");
  }

  if (!spec.created_at || typeof spec.created_at !== "string") {
    errors.push("Поле 'created_at' обязательно и должно быть ISO timestamp");
  } else {
    const date = new Date(spec.created_at);
    if (isNaN(date.getTime())) {
      errors.push("Поле 'created_at' должно быть валидным ISO timestamp");
    }
  }

  if (!Array.isArray(spec.source_observations)) {
    errors.push("Поле 'source_observations' должно быть массивом");
  }

  if (!spec.hypothesis || typeof spec.hypothesis !== "string") {
    errors.push("Поле 'hypothesis' обязательно и должно быть строкой");
  }

  if (!VALID_TYPES.includes(spec.type)) {
    errors.push(`Поле 'type' должно быть одним из: ${VALID_TYPES.join(", ")}`);
  }

  if (!Array.isArray(spec.actions) || spec.actions.length === 0) {
    errors.push("Поле 'actions' должно быть непустым массивом");
  }

  if (!spec.metric || typeof spec.metric !== "string") {
    errors.push("Поле 'metric' обязательно и должно быть строкой");
  }

  if (!spec.baseline || typeof spec.baseline !== "string") {
    errors.push("Поле 'baseline' обязательно и должно быть строкой");
  }

  if (!spec.success_criteria || typeof spec.success_criteria !== "string") {
    errors.push("Поле 'success_criteria' обязательно и должно быть строкой");
  }

  // Валидация budget
  if (!spec.budget || typeof spec.budget !== "object") {
    errors.push("Поле 'budget' обязательно и должно быть объектом");
  } else {
    if (typeof spec.budget.estimated_tokens !== "number" || spec.budget.estimated_tokens < 0) {
      errors.push("Поле 'budget.estimated_tokens' должно быть неотрицательным числом");
    }
    if (typeof spec.budget.estimated_cost_usd !== "number" || spec.budget.estimated_cost_usd < 0) {
      errors.push("Поле 'budget.estimated_cost_usd' должно быть неотрицательным числом");
    }
    if (!spec.budget.value || typeof spec.budget.value !== "object") {
      errors.push("Поле 'budget.value' обязательно и должно быть объектом");
    } else {
      if (typeof spec.budget.value.blocker !== "boolean") {
        errors.push("Поле 'budget.value.blocker' должно быть boolean");
      }
      if (spec.budget.value.deadline_days !== null && typeof spec.budget.value.deadline_days !== "number") {
        errors.push("Поле 'budget.value.deadline_days' должно быть числом или null");
      }
      if (spec.budget.value.manual_hours_saved !== null && typeof spec.budget.value.manual_hours_saved !== "number") {
        errors.push("Поле 'budget.value.manual_hours_saved' должно быть числом или null");
      }
    }
    if (typeof spec.budget.roi_estimate !== "number") {
      errors.push("Поле 'budget.roi_estimate' должно быть числом");
    }
    if (!VALID_BUDGET_DECISIONS.includes(spec.budget.decision)) {
      errors.push(`Поле 'budget.decision' должно быть одним из: ${VALID_BUDGET_DECISIONS.join(", ")}`);
    }
  }

  // Валидация output
  if (!spec.output || typeof spec.output !== "object") {
    errors.push("Поле 'output' обязательно и должно быть объектом");
  } else {
    if (!spec.output.path || typeof spec.output.path !== "string") {
      errors.push("Поле 'output.path' обязательно и должно быть строкой");
    }
    if (!VALID_PUBLISH_TO.includes(spec.output.publish_to)) {
      errors.push(`Поле 'output.publish_to' должно быть одним из: ${VALID_PUBLISH_TO.join(", ")}`);
    }
    if (spec.output.publish_to === "outline" && !spec.output.collection_id) {
      errors.push("Поле 'output.collection_id' обязательно, если publish_to = 'outline'");
    }
  }

  // Валидация delivery
  if (!spec.delivery || typeof spec.delivery !== "object") {
    errors.push("Поле 'delivery' обязательно и должно быть объектом");
  } else {
    if (typeof spec.delivery.report !== "boolean") {
      errors.push("Поле 'delivery.report' должно быть boolean");
    }
    if (typeof spec.delivery.daily_note !== "boolean") {
      errors.push("Поле 'delivery.daily_note' должно быть boolean");
    }
    if (spec.delivery.outline) {
      if (typeof spec.delivery.outline.enabled !== "boolean") {
        errors.push("Поле 'delivery.outline.enabled' должно быть boolean");
      }
      if (spec.delivery.outline.enabled && !spec.delivery.outline.collection_id) {
        errors.push("Поле 'delivery.outline.collection_id' обязательно, если outline.enabled = true");
      }
    }
    if (spec.delivery.group_notify) {
      if (typeof spec.delivery.group_notify.enabled !== "boolean") {
        errors.push("Поле 'delivery.group_notify.enabled' должно быть boolean");
      }
      if (spec.delivery.group_notify.enabled) {
        if (!spec.delivery.group_notify.chat_id) {
          errors.push("Поле 'delivery.group_notify.chat_id' обязательно, если group_notify.enabled = true");
        }
        if (!spec.delivery.group_notify.condition) {
          errors.push("Поле 'delivery.group_notify.condition' обязательно, если group_notify.enabled = true");
        }
        if (!spec.delivery.group_notify.format) {
          errors.push("Поле 'delivery.group_notify.format' обязательно, если group_notify.enabled = true");
        }
      }
    }
  }

  if (!VALID_STATUSES.includes(spec.status)) {
    errors.push(`Поле 'status' должно быть одним из: ${VALID_STATUSES.join(", ")}`);
  }

  if (spec.result_summary !== null && typeof spec.result_summary !== "string") {
    errors.push("Поле 'result_summary' должно быть строкой или null");
  }

  if (!Array.isArray(spec.follow_up_observations)) {
    errors.push("Поле 'follow_up_observations' должно быть массивом");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Простой YAML парсер для базовых операций (объекты, массивы, строки)
 * @param {string} yamlText
 * @returns {Object}
 */
export function parseYAML(yamlText) {
  const lines = yamlText.split("\n");
  const result = {};
  const stack = [{ obj: result, indent: -1 }];
  let currentKey = null;
  let multilineValue = null;
  let multilineIndent = 0;

  for (let line of lines) {
    // Пропуск пустых строк и комментариев
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Обработка multiline (|)
    if (multilineValue !== null) {
      if (indent > multilineIndent) {
        multilineValue.push(line.slice(multilineIndent));
        continue;
      } else {
        // Завершение multiline
        const parent = stack[stack.length - 1];
        parent.obj[currentKey] = multilineValue.join("\n");
        multilineValue = null;
      }
    }

    // Выход из вложенных уровней
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    // Обработка массива
    if (trimmed.startsWith("- ")) {
      // Найти правильный родитель и ключ для массива
      let parent = stack[stack.length - 1];
      let arrayKey = currentKey;
      
      // Если текущий объект — пустой {} созданный для ключа-массива, откатиться
      if (typeof parent.obj === "object" && !Array.isArray(parent.obj) && Object.keys(parent.obj).length === 0 && stack.length > 1) {
        stack.pop();
        parent = stack[stack.length - 1];
        // arrayKey остаётся currentKey
      }
      
      if (!Array.isArray(parent.obj[arrayKey])) {
        parent.obj[arrayKey] = [];
      }
      const value = trimmed.slice(2).trim();
      parent.obj[arrayKey].push(parseValue(value));
      continue;
    }

    // Обработка ключ: значение
    const match = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      currentKey = key.trim();
      const parent = stack[stack.length - 1];

      if (value === "|") {
        // Начало multiline
        multilineValue = [];
        multilineIndent = indent + 2;
        continue;
      } else if (value === "") {
        // Вложенный объект
        parent.obj[currentKey] = {};
        stack.push({ obj: parent.obj[currentKey], indent });
      } else {
        // Простое значение
        parent.obj[currentKey] = parseValue(value);
      }
    }
  }

  // Завершение незакрытого multiline
  if (multilineValue !== null) {
    const parent = stack[stack.length - 1];
    parent.obj[currentKey] = multilineValue.join("\n");
  }

  return result;
}

/**
 * Парсинг значения (строка, число, boolean, null, массив)
 * @param {string} value
 * @returns {any}
 */
function parseValue(value) {
  value = value.trim();
  
  // null
  if (value === "null" || value === "~") return null;
  
  // boolean
  if (value === "true") return true;
  if (value === "false") return false;
  
  // число
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  
  // массив в одну строку [a, b, c]
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map(v => parseValue(v.trim()))
      .filter(v => v !== "");
  }
  
  // строка (убрать кавычки)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  
  return value;
}

/**
 * Простой YAML генератор
 * @param {Object} obj
 * @param {number} indent
 * @returns {string}
 */
export function generateYAML(obj, indent = 0) {
  const spaces = " ".repeat(indent);
  let result = "";

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      result += `${spaces}${key}:\n`;
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          result += `${spaces}- \n${generateYAML(item, indent + 2)}`;
        } else {
          result += `${spaces}- ${formatValue(item)}\n`;
        }
      }
    } else if (typeof value === "object" && value !== null) {
      result += `${spaces}${key}:\n${generateYAML(value, indent + 2)}`;
    } else {
      result += `${spaces}${key}: ${formatValue(value)}\n`;
    }
  }

  return result;
}

/**
 * Форматирование значения для YAML
 * @param {any} value
 * @returns {string}
 */
function formatValue(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value.toString();
  if (typeof value === "number") return value.toString();
  if (typeof value === "string" && (value.includes("\n") || value.includes(":"))) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}
