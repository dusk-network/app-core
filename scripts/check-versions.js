#!/usr/bin/env node
/**
 * npm (package.json) and JSR (jsr.json) publish the same version, and a
 * release tag names it.
 *
 *   node scripts/check-versions.js [tag]
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * What's wrong with the versions, or null.
 *
 * @param {{ npm: string, jsr: string, tag?: string }} versions
 * @returns {string | null}
 */
export function versionProblem({ npm, jsr, tag }) {
  if (npm !== jsr) return `package.json has ${npm}, jsr.json has ${jsr}`;
  if (tag !== undefined && tag !== `v${npm}`) return `the tag is ${tag}, the version ${npm}`;

  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  /** @param {string} file */
  const version = (file) =>
    JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).version;
  const npm = version("package.json");
  const tag = process.argv[2];
  const problem = versionProblem({ jsr: version("jsr.json"), npm, tag });

  if (problem) {
    console.error(problem);
    process.exitCode = 1;
  } else {
    console.log(`version ${npm}${tag ? `, tag ${tag}` : ""}`);
  }
}
