#!/usr/bin/env node
// Fail the build if anything sensitive is about to live in this PUBLIC repo.
//
// Scans every git-tracked file as raw bytes. Deliberately does NOT shell out to
// grep: `file(1)` misreports UTF-8 sources containing em-dashes as binary, and
// some grep wrappers silently skip "binary" files — which is exactly how a
// committed production endpoint URL went unnoticed here until 2026-08-17.
//
// Run: node scripts/scan-secrets.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SKIP = new Set(["package-lock.json"]);

const RULES = [
  {
    name: "aws-infrastructure",
    // Endpoint hosts and ARNs are configuration, not source. They belong in env.
    re: /execute-api[a-z0-9.\-]*\.amazonaws\.com|arn:aws:[a-z0-9-]+:/gi,
    hint: "Move infrastructure addresses to an env var (no baked-in default).",
  },
  {
    name: "email-address",
    // Customer data must never be committed, including in test fixtures.
    // .invalid / .example are reserved for docs and tests (RFC 2606/6761).
    re: /[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)(?!.*\.invalid\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    hint: "Use an @example.com or .invalid address in fixtures.",
  },
  {
    name: "assigned-secret",
    re: /(?:bearer|secret|passwo?rd|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
    hint: "Read the value from process.env instead.",
  },
  {
    name: "private-key",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    hint: "Never commit private keys.",
  },
];

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !SKIP.has(f));

let failures = 0;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file).toString("utf8");
  } catch {
    continue;
  }
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      // Allow an explicit, reviewed exemption on the same line.
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      let lineEnd = text.indexOf("\n", m.index);
      if (lineEnd === -1) lineEnd = text.length;
      const line = text.slice(lineStart, lineEnd);
      if (line.includes("scan-secrets:allow")) continue;
      const lineNo = text.slice(0, m.index).split("\n").length;
      console.error(`${file}:${lineNo}  [${rule.name}]  ${m[0].slice(0, 80)}`);
      console.error(`    ${rule.hint}`);
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(`\n✗ ${failures} finding(s). This repo is public — nothing sensitive may land here.`);
  process.exit(1);
}
console.log(`✓ scanned ${files.length} tracked files, nothing sensitive found`);
