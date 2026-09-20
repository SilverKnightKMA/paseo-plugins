#!/usr/bin/env node
// Tái tạo server/role-md.generated.ts từ roles/*.md
const fs = require("fs");
const dir = __dirname + "/../roles";
const out = {};
for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".md"))) out[f.replace(/.md$/, "")] = fs.readFileSync(dir + "/" + f, "utf8");
fs.writeFileSync(__dirname + "/../server/role-md.generated.ts", "// AUTO-GENERATED từ roles/*.md — chạy: node scripts/gen-role-md.js. Đừng sửa tay.
// Spec v5: role template cố định trong code (plugin là source of truth, không đọc filesystem runtime).
export const BUILTIN_ROLE_MD: Record<string, string> = " + JSON.stringify(out, null, 2) + ";
");
console.log("regenerated: " + Object.keys(out).join(", "));
