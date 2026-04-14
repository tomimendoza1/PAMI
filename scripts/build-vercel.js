const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const sourceDir = path.join(rootDir, "public");
const outputDir = path.join(rootDir, "dist", "vercel");
const apiBaseUrl = String(process.env.PAMI_API_BASE_URL || "").replace(/\/+$/, "");

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.cpSync(sourceDir, outputDir, { recursive: true });

const runtimeConfigPath = path.join(outputDir, "runtime-config.js");
const runtimeConfig = `window.__PAMI_RUNTIME_CONFIG__ = ${JSON.stringify(
  {
    apiBaseUrl
  },
  null,
  2
)};\n`;

fs.writeFileSync(runtimeConfigPath, runtimeConfig);
console.log(`Static frontend generated in ${outputDir}`);
