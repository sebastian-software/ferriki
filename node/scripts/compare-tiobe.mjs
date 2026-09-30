import process from "node:process";
import { compareReports, readReport } from "./tiobe-benchmark.mjs";
if (process.argv.length !== 4)
  throw new Error("Usage: node scripts/compare-tiobe.mjs baseline.json candidate.json");
const reports = process.argv.slice(2).map(readReport);
console.log(JSON.stringify(compareReports(...reports), null, 2));
