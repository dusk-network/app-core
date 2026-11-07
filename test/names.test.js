import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONFUSABLES, CONFUSABLES_VERSION } from "../src/confusables.js";
import { NAME_HIDES, lookAlikes, looksAlike, nameClash, nameHides, nameSkeleton, sameName } from "../src/names.js";

describe("names that look alike", () => {
  it("catches Marek's: Armenian, Cherokee and a small capital I, as Cyrillic before", () => {
    for (const [name, other] of [
      ["Bob", "Bօb"],
      ["Uma", "Սma"],
      ["Sam", "Ꮪam"],
      ["Tom", "Ꭲom"],
      ["Kim", "Kɪm"],
      ["Alice", "Аlice"],
      ["Leo", "Lеo"],
    ]) {
      assert.equal(looksAlike(name, other), true, `${name} ${other}`);
      assert.equal(sameName(name, other), false, `${name} ${other}`);
    }
  });

  it("catches Sofia's: other letters, and the same name in another case with a point", () => {
    assert.equal(looksAlike("Estudio Marta", "Estudio Mаrta"), true);
    assert.equal(sameName("Estudio Marta", "estudio marta."), true);
    assert.equal(looksAlike("Estudio Marta", "estudio marta."), true);
  });

  it("reads Greek ν as the v it looks like, as Unicode's table has it", () => {
    assert.equal(looksAlike("Niva", "Niνa"), true);
    assert.equal(looksAlike("Nina", "Niνa"), false);
  });

  it("reads a capital I as a small l, and what renders as nothing as nothing", () => {
    assert.equal(looksAlike("Ian", "lan"), true);
    assert.equal(looksAlike("Profile 2", "ProfiIe 2"), true);
    assert.equal(looksAlike("Alice", "Ali\u200bce"), true);
    // What can't be seen is left out before names are compared: they read as the same name.
    for (const hidden of ["Ali\u200bce", "\u2066Alice\u2069", "Ali\u00adce", "Alice\u0007", "Al\u3164ice"]) {
      assert.equal(sameName("Alice", hidden), true, JSON.stringify(hidden));
    }
    assert.equal(sameName("Amélie", "Amelie"), true);
    assert.equal(nameSkeleton("rn"), nameSkeleton("m"));
  });

  it("finds what a name holds that can't be seen, for it to be refused", () => {
    // Marek's: an override at the start reads as "Profile 2" and "Alice".
    for (const hidden of ["\u202e2 eliforP", "\u202eecilA", "Ali\u200bce", "Ali\u200dce", "Ali\u00adce", "Alice\u2069", "Ali\tce", "Ali\nce", "Ali\u2028ce", "Al\u3164ice", "\ufeffAlice", "Alice\u{e0041}", "Ali\ud800ce", "Mom \u{1f469}\u200d\u{1f467}"]) {
      assert.equal(nameHides(hidden), true, JSON.stringify(hidden));
    }
    // An emoji's own selector, accents and any script hide nothing.
    for (const plain of ["Alice", "Am\u00e9lie", "e\u0301", "Ilustraci\u00f3n Sol", "\u05e9\u05dc\u05d5\u05dd", "\u0639\u0644\u064a", "\u0939\u093f\u0928\u094d\u0926\u0940", "\u65e5\u672c", "Caf\u00e9 \u2764\ufe0f", "\u{1f600}", "Profile 2", "", "  "]) {
      assert.equal(nameHides(plain), false, JSON.stringify(plain));
    }
    assert.equal(nameHides(null), false);
    assert.match(NAME_HIDES, /hidden characters/);
  });

  it("tells names apart that read differently, and says nothing of names of no letters", () => {
    for (const [name, other] of [
      ["Bob", "Rob"],
      ["Anna", "Hanna"],
      ["Kim", "Tim"],
      ["Profile 1", "Profile 2"],
      ["ian", "lan"],
    ]) {
      assert.equal(looksAlike(name, other), false, `${name} ${other}`);
    }

    assert.equal(looksAlike("", ""), false);
    assert.equal(looksAlike("...", "..."), false);
    assert.equal(sameName(null, undefined), false);
  });

  it("is Unicode 18's table, kept in the package", () => {
    assert.equal(CONFUSABLES_VERSION, "18.0.0");
    assert.equal(CONFUSABLES.split(";").length, 6712);
  });
});

describe("a contact's name", () => {
  const profiles = [{ account: "p1", name: "Profile 1" }, { account: "p2", name: "Profile 2" }];
  const contacts = [
    { address: "q", id: "c1", name: "Estudio Marta" },
    { address: "x", id: "c2", name: "Bob" },
  ];

  it("takes a profile's name, as written or in other letters: refused, as Review would read it as that profile", () => {
    // Marek's.
    assert.deepEqual(nameClash("Profile 2", { contacts, profiles }), { entry: profiles[1], kind: "profile", same: true });
    assert.deepEqual(nameClash("profile  2", { contacts, profiles }), { entry: profiles[1], kind: "profile", same: true });
    assert.deepEqual(nameClash("ProfiIe 2", { contacts, profiles }), { entry: profiles[1], kind: "profile", same: false });
    // With what can't be seen in it, it reads as that name.
    assert.deepEqual(nameClash("Pro​file 2", { contacts, profiles }), { entry: profiles[1], kind: "profile", same: true });
    assert.deepEqual(nameClash("⁦Bob⁩", { contacts, profiles }), { entry: contacts[1], kind: "contact", same: true });
  });

  it("takes another contact's name, or looks like it, but not its own", () => {
    assert.deepEqual(nameClash("estudio marta.", { contacts, profiles }), { entry: contacts[0], kind: "contact", same: true });
    assert.deepEqual(nameClash("Bօb", { contacts, profiles }), { entry: contacts[1], kind: "contact", same: false });
    assert.equal(nameClash("Estudio Marta", { contacts, except: "c1", profiles }), null);
    assert.equal(nameClash("Carla", { contacts, profiles }), null);
    assert.equal(nameClash("", { contacts, profiles }), null);
  });

  it("marks the names in a list that look like another's of another address, for their addresses to show", () => {
    // Sofia's three, and a contact saved for one of the person's own profiles.
    const marta = { address: "qxwSid", name: "Estudio Marta" };
    const cyrillic = { address: "xyi8z9", name: "Estudio Mаrta" };
    const dotted = { address: "yUdHBN", name: "estudio marta." };
    const own = { address: "p2", name: "Profile 2" };
    const savedOwn = { address: "p2", name: "Profile 2" };
    const other = { address: "z", name: "Carla" };

    assert.deepEqual(lookAlikes([marta, cyrillic, dotted, own, savedOwn, other]), new Set([marta, cyrillic, dotted]));
    assert.deepEqual(lookAlikes([]), new Set());
  });
});
