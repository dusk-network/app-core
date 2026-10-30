#!/usr/bin/env node
/**
 * A version's section of CHANGELOG.md, for its GitHub release. It fails
 * when the CHANGELOG has none, so nothing is published without one.
 *
 *   node scripts/release-notes.js <version or tag> > notes.md
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The lines under `## [version]`, up to the next `## ` heading; null when
 * the section is missing or empty.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}
 */
export function releaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));

  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const notes = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();

  return notes || null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = String(process.argv[2] ?? "").replace(/^v/, "");
  const notes = version
    ? releaseNotes(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), version)
    : null;

  if (notes) {
    console.log(notes);
  } else {
    console.error(`CHANGELOG.md has no section for ${version || "(no version given)"}`);
    process.exitCode = 1;
  }
}
