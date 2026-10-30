import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { versionProblem } from "../scripts/check-versions.js";
import { releaseNotes } from "../scripts/release-notes.js";

describe("the release scripts", () => {
  it("want the same version in package.json, jsr.json and the tag", () => {
    assert.equal(versionProblem({ npm: "0.1.0", jsr: "0.1.0", tag: "v0.1.0" }), null);
    assert.match(versionProblem({ npm: "0.1.0", jsr: "0.2.0" }) ?? "", /jsr\.json has 0\.2\.0/);
    assert.match(versionProblem({ npm: "0.1.0", jsr: "0.1.0", tag: "v0.1.1" }) ?? "", /the tag is v0\.1\.1/);
  });

  it("take a version's section of the CHANGELOG, and nothing for an empty one", () => {
    const changelog = "# Changelog\n\n## [0.2.0]\n\n- b\n\n## [0.1.0]\n\n- a\n\n## [0.0.1]\n";

    assert.equal(releaseNotes(changelog, "0.2.0"), "- b");
    assert.equal(releaseNotes(changelog, "0.1.0"), "- a");
    assert.equal(releaseNotes(changelog, "0.0.1"), null);
    assert.equal(releaseNotes(changelog, "0.3.0"), null);
  });
});
