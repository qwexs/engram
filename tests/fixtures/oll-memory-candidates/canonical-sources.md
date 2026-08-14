# Canonical source grammar fixtures

## Daily note

### 2026-08-14T10:15:00+03:00 — decision

- Использовать только подтверждённый источник.

### 2026-08-14T10:16:00+03:00 — learning

- Проверять digest перед восстановлением.

## Retrieval card

# Verified recovery

- **Type:** retrieval event card
- **Date:** 2026-08-14
- **Source:** `memory/agent-main/main/2026-08-14.md` — Decisions

## Summary

Проверять digest перед восстановлением.

## Domain decision — canonical-decisions-v1

### Стабильное восстановление

**Условие**: найден опубликованный compiler report
**Действие**: восстанавливать только из проверенного report
**Добавлено**: 2026-08-14

## Topic decision — canonical-decisions-v1

### 2026-08-14 — Стабильное восстановление

**Решение**: восстанавливать только из проверенного report
**Контекст**: nightly candidate compiler
**Участники**: Сергей

## Domain proposal — canonical-proposals-v1

## 2026-08-14 14:30 — PROPOSAL
**Proposal**: require report digest verification before recovery
**Reason**: mutable sources must not change a persisted batch

## KG assertion — kg-assertion-v3

**Entity**: `projects/engram-retention`
**Kind**: constraint
**Scope**: `project:engram`
**ObservedAt**: 2026-08-14T10:20:00+03:00
**Statement**: сохранять проверяемую историю восстановления
