/**
 * config.js — loads API credentials + model choice for my-agent.
 * Zero dependencies: parses a .env file in this project's directory manually.
 * Keys (see .env.example):
 *   GLM_API_KEY   — API key (required)
 *   GLM_MODEL     — primary model for complex tasks (default: glm-5.3)
 *   GLM_BASE_URL  — OpenAI-compatible base URL (default: Zhipu endpoint)
 *   FAST_MODEL    — model used for simple tasks (Phase 16 routing)
 *   FAST_BASE_URL — optional different endpoint for the fast model
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Parses KEY=VALUE lines (ignores blanks and # comments) into an object. */
export function parseEnvFile(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) vars[key] = value;
  }
  return vars;
}

export function loadConfig() {
  const env = parseEnvFile(path.join(__dirname, '.env'));
  const get = (key) => env[key] ?? process.env[key] ?? null;
  return {
    apiKey: get('GLM_API_KEY'),
    model: get('GLM_MODEL') || 'glm-5.3',
    baseURL: get('GLM_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4',
    fastModel: get('FAST_MODEL') || 'nemotron-3.5-lightning',
    fastBaseURL: get('FAST_BASE_URL') || get('GLM_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4',
  };
}
