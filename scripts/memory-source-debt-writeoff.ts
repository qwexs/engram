#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { writeOffSourceDebt } from '../src/memory-observation/source-debt-writeoff.ts';
const [flag, workspace, inputFlag, input, apply, ...extra] = process.argv.slice(2);
if (flag !== '--workspace' || inputFlag !== '--request' || !workspace || !input || (apply && apply !== '--apply') || extra.length)
  throw Error('usage: --workspace <absolute-owner-workspace> --request <exact-request.json> [--apply]');
console.log(JSON.stringify(writeOffSourceDebt(workspace, JSON.parse(readFileSync(input, 'utf8')), { apply: apply === '--apply' })));
