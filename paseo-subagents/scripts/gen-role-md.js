#!/usr/bin/env node
// Regenerate server/role-md.generated.ts from roles/*.md.
const fs = require("fs");
const dir = __dirname + "/../roles";
const out = {};
for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".md"))) out[f.replace(/.md$/, "")] = fs.readFileSync(dir + "/" + f, "utf8");
fs.writeFileSync(__dirname + "/../server/role-md.generated.ts", "// AUTO-GENERATED from roles/*.md — run: node scripts/gen-role-md.js. Do not edit manually.
// Spec v5: role templates are fixed in code (the plugin is the source of truth; no runtime filesystem reads).
export const BUILTIN_ROLE_MD: Record<string, string> = " + JSON.stringify(out, null, 2) + ";
");
console.log("regenerated: " + Object.keys(out).join(", "));
