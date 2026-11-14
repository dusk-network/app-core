import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONFUSABLES, CONFUSABLES_VERSION } from "../src/confusables.js";
import { NAME_HIDES, NAME_SAVE_YES, contactNameCheck, lookAlikes, looksAlike, nameClash, nameDuskNames, nameHides, nameSkeleton, nameStarts, profileNameCheck, profileNameClash, sameName } from "../src/names.js";
import { A, C } from "./fixtures/activity.js";

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
    // Marek's: a selector on what it can't make an emoji of does nothing to be seen, wherever it is.
    for (const hidden of ["Alice\ufe0f", "Ali\ufe0fce", "\ufe0eAlice", "Bob 1\ufe0f", "Kim\ufe00", "\u2764\ufe0f\ufe0f"]) {
      assert.equal(nameHides(hidden), true, JSON.stringify(hidden));
    }
    // An emoji's own selector, a keycap's, accents and any script hide nothing.
    for (const plain of ["Alice", "Am\u00e9lie", "e\u0301", "Ilustraci\u00f3n Sol", "\u05e9\u05dc\u05d5\u05dd", "\u0639\u0644\u064a", "\u0939\u093f\u0928\u094d\u0926\u0940", "\u65e5\u672c", "Caf\u00e9 \u2764\ufe0f", "Team \u0031\ufe0f\u20e3", "\u2122\ufe0e", "\u{1f600}", "Profile 2", "", "  "]) {
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

  it("catches Marek's multi-letter look-alikes, as written: two v's for a w, cl for a d, rn for an m", () => {
    for (const [name, other] of [
      ["Wendy", "VVendy"],
      ["Wendy", "vvendy"],
      ["WENDY", "VVENDY"],
      ["David", "Davicl"],
      ["Emma", "Ernma"],
      ["Emma", "Ernrna"],
      ["Edward", "Eclvvarcl"],
    ]) {
      assert.equal(looksAlike(name, other), true, `${name} ${other}`);
      assert.equal(sameName(name, other), false, `${name} ${other}`);
    }

    // A capital tells them apart: the pairs are read as written.
    for (const [name, other] of [["Clara", "Dara"], ["Diana", "Cliana"], ["Vince", "Wince"]]) assert.equal(looksAlike(name, other), false, `${name} ${other}`);
    // In lower case they look alike.
    assert.equal(looksAlike("clara", "dara"), true);

    // A contact named so is said with the other's address, a profile named so is refused, and a list marks both.
    const contacts = [{ address: "w", id: "c1", name: "Wendy" }, { address: "d", id: "c2", name: "David" }];

    assert.deepEqual(nameClash("VVendy", { contacts }), { entry: contacts[0], kind: "contact", name: "Wendy", same: false });
    assert.deepEqual(profileNameClash("Davicl", { contacts, self: "p2" }), { entry: contacts[1], kind: "contact", name: "David", same: false });
    const vv = { address: "x", name: "VVendy" };

    assert.deepEqual(lookAlikes([...contacts, vv]), new Set([contacts[0], vv]));
    assert.deepEqual(nameStarts("VVendy Design", { contacts }), { entry: contacts[0], kind: "contact", name: "Wendy" });
  });

  it("keeps reading a name as written beside its letter pairs: daIe, with a capital I, still looks like Dale", () => {
    // Astra's: with the pairs in place of the written skeleton, daIe's small d made a pair that Dale's capital D doesn't.
    const contacts = [{ address: "d", id: "c1", name: "Dale" }];
    const fake = { address: "x", name: "daIe" };

    assert.equal(looksAlike("Dale", "daIe"), true);
    assert.deepEqual(nameClash("daIe", { contacts }), { entry: contacts[0], kind: "contact", name: "Dale", same: false });
    assert.deepEqual(profileNameClash("daIe", { contacts, self: "p2" }), { entry: contacts[0], kind: "contact", name: "Dale", same: false });
    assert.deepEqual(lookAlikes([...contacts, fake]), new Set([contacts[0], fake]));
    assert.deepEqual(nameStarts("daIe Smith", { contacts }), { entry: contacts[0], kind: "contact", name: "Dale" });
    assert.deepEqual(profileNameCheck("daIe", { contacts, self: "p2" }), { dusk: false, entry: contacts[0], kind: "contact", name: "Dale", refused: true, words: "That looks like your contact Dale. Choose another name." });
  });

  it("catches Marek's digits for letters, a 1 for an i or an l, a 0 for an o and a 5 for an s, and a v for a y", () => {
    for (const [name, other] of [
      ["David", "Dav1d"],
      ["Alice", "A1ice"],
      ["John", "J0hn"],
      ["Rosa", "Ro5a"],
      ["Wendy", "Wendv"],
      ["Wendv", "Wendу"],
      ["DAVID", "DAV1D"],
      ["Lucas (petit-fils)", "Luca5 (petit-fils)"],
    ]) {
      assert.equal(looksAlike(name, other), true, `${name} ${other}`);
      assert.equal(sameName(name, other), false, `${name} ${other}`);
    }

    // A small i and l don't look alike, nor capital Y and V, nor digits that stand for no letter here.
    for (const [name, other] of [["ian", "lan"], ["Bill", "Biil"], ["Yan", "Van"], ["Profile 1", "Profile 2"], ["Room 3", "Room 8"]]) assert.equal(looksAlike(name, other), false, `${name} ${other}`);

    // Marek's Dav1d and Wendv beside David and Wendy: a contact so named is asked about, a profile refused, a list marks both.
    const contacts = [{ address: A, id: "c1", name: "David" }, { address: C, id: "c2", name: "Wendy" }];

    assert.deepEqual(contactNameCheck("Dav1d", { address: "sofia", contacts }), { dusk: false, entry: contacts[0], kind: "contact", name: "David", refused: false, words: "That looks like your contact David, at 26JfWK…B5NsNi. Is this someone else?" });
    assert.deepEqual(contactNameCheck("Wendv", { address: "new", contacts }), { dusk: false, entry: contacts[1], kind: "contact", name: "Wendy", refused: false, words: "That looks like your contact Wendy, at zFVXTQ…y4yEuL. Is this someone else?" });
    assert.deepEqual(profileNameCheck("Dav1d", { contacts, self: "p2" }), { dusk: false, entry: contacts[0], kind: "contact", name: "David", refused: true, words: "That looks like your contact David. Choose another name." });

    const fake = { address: "sofia", name: "Dav1d" };

    assert.deepEqual(lookAlikes([...contacts, fake]), new Set([contacts[0], fake]));
    assert.deepEqual(nameStarts("Wendv Design", { contacts }), { entry: contacts[1], kind: "contact", name: "Wendy" });
  });

  it("reads each 1 on its own as an i or an l: Astra's L11ian beside Lilian, a written i and l still apart", () => {
    // Both of Lilian's i and l written as 1: with every 1 read as one letter or the other, neither key matched.
    for (const other of ["L11ian", "Li1ian", "L1lian", "LI1ian"]) assert.equal(looksAlike("Lilian", other), true, other);
    for (const other of ["Liiian", "Llllan", "L11lan"]) assert.equal(looksAlike("Lilian", other), false, other);

    const contacts = [{ address: A, id: "c1", name: "Lilian" }];
    const fake = { address: "x", name: "L11ian" };

    assert.deepEqual(profileNameCheck("L11ian", { contacts, self: "p2" }), { dusk: false, entry: contacts[0], kind: "contact", name: "Lilian", refused: true, words: "That looks like your contact Lilian. Choose another name." });
    assert.deepEqual(contactNameCheck("L11ian", { address: "x", contacts })?.words, "That looks like your contact Lilian, at 26JfWK…B5NsNi. Is this someone else?");
    assert.deepEqual(lookAlikes([...contacts, fake]), new Set([contacts[0], fake]));
    assert.deepEqual(nameStarts("L11ian Design", { contacts }), { entry: contacts[0], kind: "contact", name: "Lilian" });
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
    assert.deepEqual(nameClash("Profile 2", { contacts, profiles }), { entry: profiles[1], kind: "profile", name: "Profile 2", same: true });
    assert.deepEqual(nameClash("profile  2", { contacts, profiles }), { entry: profiles[1], kind: "profile", name: "Profile 2", same: true });
    assert.deepEqual(nameClash("ProfiIe 2", { contacts, profiles }), { entry: profiles[1], kind: "profile", name: "Profile 2", same: false });
    // With what can't be seen in it, it reads as that name.
    assert.deepEqual(nameClash("Pro​file 2", { contacts, profiles }), { entry: profiles[1], kind: "profile", name: "Profile 2", same: true });
    assert.deepEqual(nameClash("⁦Bob⁩", { contacts, profiles }), { entry: contacts[1], kind: "contact", name: "Bob", same: true });
  });

  it("takes another contact's name, or looks like it, but not its own", () => {
    assert.deepEqual(nameClash("estudio marta.", { contacts, profiles }), { entry: contacts[0], kind: "contact", name: "Estudio Marta", same: true });
    assert.deepEqual(nameClash("Bօb", { contacts, profiles }), { entry: contacts[1], kind: "contact", name: "Bob", same: false });
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

describe("a profile's name", () => {
  const profiles = [{ account: "p1", address: "s1", name: "Profile 1" }, { account: "p2", address: "s2", name: "Profile 2" }];
  const contacts = [
    { address: "q", id: "c1", name: "Alice" },
    { address: "p2", id: "c2", name: "Lena Sparen" },
  ];

  it("takes the other profile's name, or a contact's, as written or in other letters: refused, as History would read one as the other", () => {
    // Marek's: Profile 2 named "Profile 1", then "Alice" beside his contact Alice.
    assert.deepEqual(profileNameClash("Profile 1", { contacts, profiles, self: "p2" }), { entry: profiles[0], kind: "profile", name: "Profile 1", same: true });
    assert.deepEqual(profileNameClash("ProfiIe 1", { contacts, profiles, self: "p2" }), { entry: profiles[0], kind: "profile", name: "Profile 1", same: false });
    assert.deepEqual(profileNameClash("alice", { contacts, profiles, self: "p2" }), { entry: contacts[0], kind: "contact", name: "Alice", same: true });
    assert.deepEqual(profileNameClash("\u0410lice", { contacts, profiles, self: "p2" }), { entry: contacts[0], kind: "contact", name: "Alice", same: false });
  });

  it("takes nothing from itself, or from a contact saved with its own address", () => {
    assert.equal(profileNameClash("Profile 2", { contacts, profiles, self: "p2" }), null);
    assert.equal(profileNameClash("Lena Sparen", { contacts, profiles, self: "p2" }), null);
    assert.equal(profileNameClash("Lena Sparen", { contacts, profiles, self: "s2" }), null);
    assert.deepEqual(profileNameClash("Lena Sparen", { contacts, profiles, self: "p1" }), { entry: contacts[1], kind: "contact", name: "Lena Sparen", same: true });
    assert.equal(profileNameClash("Carla", { contacts, profiles, self: "p2" }), null);
  });

  it("takes the other profile's .dusk name, or looks like it: refused, as History would read that profile's payments as the other's", () => {
    // Sofía's: Profile 2, which plays her client, named after Profile 1's own sofiadesign.dusk, and in Cyrillic.
    const named = [{ account: "p1", address: "s1", duskName: "sofiadesign.dusk", name: "Profile 1" }, { account: "p2", address: "s2", name: "Profile 2" }];
    const hers = { entry: named[0], kind: "profile", name: "sofiadesign.dusk" };

    assert.deepEqual(profileNameClash("sofiadesign.dusk", { contacts, profiles: named, self: "p2" }), { ...hers, same: true });
    assert.deepEqual(profileNameClash("SofiaDesign.DUSK", { contacts, profiles: named, self: "p2" }), { ...hers, same: true });
    assert.deepEqual(profileNameClash("sоfiadesign.dusk", { contacts, profiles: named, self: "p2" }), { ...hers, same: false });
    assert.deepEqual(profileNameClash("sofiadesign.dusk​", { contacts, profiles: named, self: "p2" }), { ...hers, same: true });
    // The name it was given here still counts.
    assert.deepEqual(profileNameClash("Profile 1", { contacts, profiles: named, self: "p2" }), { entry: named[0], kind: "profile", name: "Profile 1", same: true });
    // Its own .dusk name is its own to go by.
    assert.equal(profileNameClash("sofiadesign.dusk", { contacts, profiles: named, self: "p1" }), null);
    assert.equal(profileNameClash("sofiadesign.dusk", { contacts, profiles: named, self: "s1" }), null);
    // And a contact named like it reads as that profile on Review, as one named like the profile does.
    assert.deepEqual(nameClash("sоfiadesign.dusk", { contacts, profiles: named }), { ...hers, same: false });
  });
});

describe("a name that starts as another", () => {
  // Amélie's: her own profile named "Lucas" by a slip, then her grandson saved as "Lucas (petit-fils)", so
  // Send read "From Lucas … To Lucas (petit-fils)".
  const profiles = [{ account: "p1", address: "s1", name: "Lucas" }, { account: "p2", address: "s2", duskName: "mamie.dusk", name: "Profile 2" }];
  const contacts = [{ address: "q", id: "c1", name: "Lucas (petit-fils)" }, { address: "s1", id: "c2", name: "Lucas Martin" }, { address: "z", id: "c3", name: "Anna" }];

  it("says a contact's name starts with a profile's, word for word, as the look-alike rules read names: to ask, not to refuse", () => {
    const lucas = { entry: profiles[0], kind: "profile", name: "Lucas" };

    assert.equal(nameClash("Lucas (petit-fils)", { contacts, except: "c1", profiles }), null);
    assert.deepEqual(nameStarts("Lucas (petit-fils)", { profiles }), lucas);
    // Whatever its case, accents, spaces and punctuation, and in other letters.
    assert.deepEqual(nameStarts("lucas, petit-fils", { profiles }), lucas);
    assert.deepEqual(nameStarts("Lucаs (petit-fils)", { profiles }), lucas);
    assert.deepEqual(nameStarts("Lúcas Dupont", { profiles }), lucas);
    // The start of a profile's own .dusk name, too.
    assert.deepEqual(nameStarts("Mamie", { profiles }), { entry: profiles[1], kind: "profile", name: "mamie.dusk" });
  });

  it("says a profile's name is the start of a contact's, or starts with one, but not of a contact saved with its own address", () => {
    assert.equal(profileNameClash("Lucas", { contacts, profiles, self: "p1" }), null);
    assert.deepEqual(nameStarts("Lucas", { contacts, profiles, self: "p1" }), { entry: contacts[0], kind: "contact", name: "Lucas (petit-fils)" });
    assert.deepEqual(nameStarts("Lucas Martin Dupont", { contacts, self: "p2" }), { entry: contacts[1], kind: "contact", name: "Lucas Martin" });
    // Lucas Martin is saved with Profile 1's own shielded address: its name is its own.
    assert.equal(nameStarts("Lucas Martin Dupont", { contacts: contacts.slice(1), profiles, self: "p1" }), null);
  });

  it("tells apart names that share letters but not words, and leaves the same name to nameClash", () => {
    for (const [name, other] of [
      ["Ann", "Anna"],
      ["Profile 1", "Profile 12"],
      ["Lucas", "Lucas"],
      ["Lucas", "lucas."],
      ["Luc", "Lucas (petit-fils)"],
      ["", "Lucas"],
      ["...", "... Lucas"],
    ]) {
      assert.equal(nameStarts(name, { contacts: [{ address: "q", name: other }] }), null, `${name} ${other}`);
    }
  });
});

describe("a profile's name at Save", () => {
  // Marek's: his contact Wendy saved from alice.dusk, and his contact Alice; Sofía's: her Profile 1 is sofiadesign.dusk.
  const profiles = [
    { account: "p1", address: "s1", duskName: "sofiadesign.dusk", name: "Profile 1" },
    { account: "p2", address: "s2", name: "Profile 2" },
  ];
  const contacts = [
    { address: "a", duskName: "", id: "c1", name: "Alice" },
    { address: "w", duskName: "alice.dusk", id: "c2", name: "Wendy" },
    { address: "l", id: "c3", name: "Lucas (petit-fils)" },
    { address: "s2", duskName: "cliente.dusk", id: "c4", name: "Mi cliente" },
  ];
  const check = (/** @type {string} */ name, self = "p2") => profileNameCheck(name, { contacts, profiles, self });

  it("asks about a contact's .dusk name, naming the contact it is: Marek's Profile 2 named alice.dusk, Wendy's", () => {
    const wendy = { dusk: true, entry: contacts[1], kind: "contact", name: "alice.dusk", refused: false, words: "You have a contact called Wendy, at alice.dusk. Is this someone else?" };

    // Not Alice, whose name it starts as: alice.dusk is Wendy's.
    for (const name of ["alice.dusk", "Alice.dusk", "ALICE.DUSK", "alicedusk", "\u0430lice.dusk", "alice.dusk friend", "aIice.dusk"]) assert.deepEqual(check(name), wendy, name);
  });

  it("asks about a name that starts as the other profile's .dusk name, or is its start: Sofía's 'sofiadesign.dusk cliente'", () => {
    const hers = { dusk: true, entry: profiles[0], kind: "profile", name: "sofiadesign.dusk", refused: false, words: "Your other profile is called sofiadesign.dusk. Is this someone else?" };

    for (const name of ["sofiadesign.dusk cliente", "sofiadesign", "SofiaDesign", "s\u043efiadesign.dusk 2"]) assert.deepEqual(check(name), hers, name);
    // Its own .dusk name is its own.
    assert.equal(check("sofiadesign.dusk cliente", "p1"), null);
  });

  it("refuses what it takes of another profile or a contact, in the words both wallets show", () => {
    assert.deepEqual(check("sofiadesign.dusk"), { dusk: true, entry: profiles[0], kind: "profile", name: "sofiadesign.dusk", refused: true, words: "Your other profile is called sofiadesign.dusk. Choose another name." });
    assert.deepEqual(check("s\u043efiadesign.dusk"), { dusk: true, entry: profiles[0], kind: "profile", name: "sofiadesign.dusk", refused: true, words: "That looks like sofiadesign.dusk, one of your other profiles. Choose another name." });
    assert.deepEqual(check("Profile 1"), { dusk: false, entry: profiles[0], kind: "profile", name: "Profile 1", refused: true, words: "Your other profile is called Profile 1. Choose another name." });
    assert.deepEqual(check("ProfiIe 1"), { dusk: false, entry: profiles[0], kind: "profile", name: "Profile 1", refused: true, words: "That looks like Profile 1, one of your other profiles. Choose another name." });
    assert.deepEqual(check("alice"), { dusk: false, entry: contacts[0], kind: "contact", name: "Alice", refused: true, words: "You have a contact called Alice. Choose another name." });
    assert.deepEqual(check("VVendy"), { dusk: false, entry: contacts[1], kind: "contact", name: "Wendy", refused: true, words: "That looks like your contact Wendy. Choose another name." });
    assert.deepEqual(check("Ali\u200bce 2"), { dusk: false, entry: null, kind: "hides", name: "", refused: true, words: NAME_HIDES });
  });

  it("asks about a contact's name it starts as, as before, and says nothing of the rest", () => {
    assert.deepEqual(check("Lucas"), { dusk: false, entry: contacts[2], kind: "contact", name: "Lucas (petit-fils)", refused: false, words: "You have a contact called Lucas (petit-fils). Is this someone else?" });

    for (const name of ["Carla", "Ali", "Wen", "Profile 3", "", "dusk", ".dusk", "Dusk wallet", "x .dusk", "bob.dusky", "bob dusk"]) assert.equal(check(name), null, name);
    // A contact saved with the profile's own address takes nothing from its name, by its .dusk name or its own.
    assert.equal(check("cliente.dusk"), null);
    assert.equal(check("Mi cliente"), null);
    assert.deepEqual(check("cliente.dusk", "p1"), { dusk: true, entry: contacts[3], kind: "contact", name: "cliente.dusk", refused: false, words: "You have a contact called Mi cliente, at cliente.dusk. Is this someone else?" });
  });

  it("asks about any other .dusk name, not only the wallet's: Marek's Profile 2 named sofiadesign.dusk, whom he paid", () => {
    // Not one of his contacts, and no profile of his is verified as it: History then showed his own transfers and
    // his payment to Sofía under the same name.
    const his = [{ account: "p1", address: "s1", name: "Profile 1" }, { account: "p2", address: "s2", name: "Profile 2" }];
    const asked = (/** @type {string} */ dusk) => ({ dusk: true, entry: null, kind: "dusk", name: dusk, refused: false, words: `${dusk} is a .dusk name. Is it this profile's?` });
    const marek = (/** @type {string} */ name) => profileNameCheck(name, { contacts, profiles: his, self: "p2" });

    assert.deepEqual(marek("sofiadesign.dusk"), asked("sofiadesign.dusk"));
    // As it's written, in any case, in letters or a point that look like a .dusk name's, and among other words.
    for (const [name, dusk] of [
      ["SofiaDesign.DUSK", "SofiaDesign.DUSK"],
      ["\u0455ofiadesign.dusk", "\u0455ofiadesign.dusk"],
      ["sofiadesign\uff0edusk", "sofiadesign\uff0edusk"],
      ["sofiadesign.d\u057dsk", "sofiadesign.d\u057dsk"],
      ["sofiadesign.dusk 2", "sofiadesign.dusk"],
      ["Mi cliente (sofiadesign.dusk)", "sofiadesign.dusk"],
      ["bob.dusk", "bob.dusk"],
      ["my.dusk", "my.dusk"],
      // By every key the look-alike rules read a name by: mathematical bold capitals, which a skeleton gives as
      // capitals; marks over its letters, as one or as two characters; and the letter pairs, a d as cl.
      ["sofia.\u{1d403}\u{1d414}\u{1d412}\u{1d40a}", "sofia.\u{1d403}\u{1d414}\u{1d412}\u{1d40a}"],
      ["sofia.du\u0301sk", "sofia.du\u0301sk"],
      ["sofia.d\u00f9sk", "sofia.d\u00f9sk"],
      ["sofia.clusk", "sofia.clusk"],
      ["sofia.cIusk", "sofia.cIusk"],
    ]) {
      assert.deepEqual(marek(name), asked(dusk), name);
    }

    // Each of those reads as sofia.dusk, as looksAlike says; and Wendy's alice.dusk so written is named as hers.
    for (const name of ["sofia.\u{1d403}\u{1d414}\u{1d412}\u{1d40a}", "sofia.du\u0301sk", "sofia.d\u00f9sk", "sofia.clusk", "sofia.cIusk"]) assert.equal(looksAlike(name, "sofia.dusk"), true, name);
    assert.equal(marek("Para alice.\u{1d403}\u{1d414}\u{1d412}\u{1d40a}")?.words, "You have a contact called Wendy, at alice.dusk. Is this someone else?");
  });

  it("names whose .dusk name one is where the wallet knows, wherever it is in the name", () => {
    assert.deepEqual(check("Mi sofiadesign.dusk"), { dusk: true, entry: profiles[0], kind: "profile", name: "sofiadesign.dusk", refused: false, words: "Your other profile is called sofiadesign.dusk. Is this someone else?" });
    assert.deepEqual(check("Para alice.dusk"), { dusk: true, entry: contacts[1], kind: "contact", name: "alice.dusk", refused: false, words: "You have a contact called Wendy, at alice.dusk. Is this someone else?" });
  });

  it("asks about a .dusk name the profile's own is spelled in: a hyphen or a point more is another name", () => {
    const owner = [{ account: "p1", address: "s1", duskName: "alice.dusk", name: "Profile 1" }];
    const own = (/** @type {string} */ name) => profileNameCheck(name, { profiles: owner, self: "p1" });

    for (const name of ["ali-ce.dusk", "al.ice.dusk", "alice.dusk.dusk", "alice-.dusk"]) {
      assert.deepEqual(own(name), { dusk: true, entry: null, kind: "dusk", name, refused: false, words: `${name} is a .dusk name. Is it this profile's?` }, name);
    }

    // Its own, in any case or with a point after it, is its own.
    for (const name of ["alice.dusk", "Alice.DUSK", "alice.dusk.", "(alice.dusk)"]) assert.equal(own(name), null, name);
  });

  it("asks nothing of the profile's own verified .dusk name, in a name or as it", () => {
    for (const name of ["sofiadesign.dusk", "SofiaDesign.dusk", "sofiadesign.dusk (yo)"]) assert.equal(check(name, "p1"), null, name);
    // Another .dusk name beside its own still asks.
    assert.deepEqual(check("sofiadesign.dusk y bob.dusk", "p1"), { dusk: true, entry: null, kind: "dusk", name: "bob.dusk", refused: false, words: "bob.dusk is a .dusk name. Is it this profile's?" });
  });

  it("refuses a .dusk name the name service says is another account's: Marek's Profile 2 named sofiadesign.dusk, Sofía's", () => {
    // As Marek's wallet looks it up: sofiadesign.dusk resolves to Sofía's account, not to his Profile 2.
    const his = [{ account: "p1", address: "s1", name: "Profile 1" }, { account: "p2", address: "s2", name: "Profile 2" }];
    const sofia = { account: "sofia-account", address: "sofia-address" };
    const owners = new Map([["sofiadesign.dusk", sofia]]);
    const marek = (/** @type {string} */ name, /** @type {any} */ more = {}) => profileNameCheck(name, { contacts, owners, profiles: his, self: "p2", ...more });
    const taken = { dusk: true, entry: null, kind: "dusk", name: "sofiadesign.dusk", refused: true, words: "sofiadesign.dusk belongs to another account. Choose another name." };

    assert.deepEqual(nameDuskNames("sofiadesign.dusk"), ["sofiadesign.dusk"]);

    for (const name of ["sofiadesign.dusk", "SofiaDesign.DUSK", "sofiadesign.dusk 2", "Mi cliente (sofiadesign.dusk)"]) assert.deepEqual(marek(name), taken, name);

    // Written in letters or a point that look like its own, it reads as hers: refused too.
    for (const name of ["ѕofiadesign.dusk", "sofiadesign．dusk", "sofiadesign.clusk", "sofiadesign.\u{1d403}\u{1d414}\u{1d412}\u{1d40a}"]) {
      assert.ok(nameDuskNames(name).includes("sofiadesign.dusk"), name);
      assert.deepEqual(marek(name), { ...taken, words: "That looks like sofiadesign.dusk, which belongs to another account. Choose another name." }, name);
    }

    // As an object, the account alone, or a plain object of names: the same.
    assert.deepEqual(marek("sofiadesign.dusk", { owners: { "sofiadesign.dusk": "sofia-account" } }), taken);

    // Whose it is, where the wallet knows: a contact saved with that account, or another of the wallet's profiles.
    const saved = [...contacts, { address: "sofia-account", id: "c5", name: "Sofía" }];

    assert.deepEqual(marek("sofiadesign.dusk", { contacts: saved }), { dusk: true, entry: saved[4], kind: "contact", name: "sofiadesign.dusk", refused: true, words: "You have a contact called Sofía, at sofiadesign.dusk. Choose another name." });
    assert.deepEqual(marek("ѕofiadesign.dusk", { contacts: saved })?.words, "That looks like sofiadesign.dusk, your contact Sofía's. Choose another name.");
    assert.deepEqual(marek("sofiadesign.dusk", { owners: new Map([["sofiadesign.dusk", { address: "s1" }]]) }), { dusk: true, entry: his[0], kind: "profile", name: "sofiadesign.dusk", refused: true, words: "Your other profile is called sofiadesign.dusk. Choose another name." });

    // Registered to this profile, by its account or its shielded address: its own, asked nothing.
    assert.equal(marek("sofiadesign.dusk", { owners: new Map([["sofiadesign.dusk", { account: "p2" }]]) }), null);
    assert.equal(marek("sofiadesign.dusk (yo)", { owners: new Map([["sofiadesign.dusk", "s2"]]) }), null);
    // Not registered, or not looked up, or a lookup that failed: asked, as before.
    const asked = { dusk: true, entry: null, kind: "dusk", name: "sofiadesign.dusk", refused: false, words: "sofiadesign.dusk is a .dusk name. Is it this profile's?" };

    for (const unknown of [new Map([["sofiadesign.dusk", null]]), new Map(), undefined, new Map([["sofiadesign.dusk", {}]])]) assert.deepEqual(marek("sofiadesign.dusk", { owners: unknown }), asked);
  });

  it("gives the .dusk names a profile's name holds, to look up as the name service names them", () => {
    assert.deepEqual(nameDuskNames("Profile 2"), []);
    assert.deepEqual(nameDuskNames("sofiadesign.dusk y bob.dusk"), ["sofiadesign.dusk", "bob.dusk"]);
    // As written where the name service could register it, and as it reads in plain letters: a Cyrillic ѕ as an s,
    // a .dusk written with cl for its d or a 5 for its s.
    assert.deepEqual(nameDuskNames("ѕofia.dusk"), ["sofia.dusk"]);
    assert.deepEqual(nameDuskNames("sofia.clusk"), ["sofia.dusk"]);
    assert.deepEqual(nameDuskNames("sofia.du5k"), ["sofia.dusk"]);
    assert.deepEqual(nameDuskNames("s0fia.dusk"), ["s0fia.dusk"]);
    assert.deepEqual(nameDuskNames("Pay.SofiaDesign.dusk"), ["pay.sofiadesign.dusk"]);
    assert.deepEqual(nameDuskNames("sofia.dusk sofia.dusk"), ["sofia.dusk"]);
  });

  // Marek's, Profile 2 being named.
  const marekProfiles = [{ account: "p1", address: "s1", name: "Profile 1" }, { account: "p2", address: "s2", name: "Profile 2" }];
  const named = (/** @type {string} */ name, /** @type {any} */ owners) => profileNameCheck(name, { owners, profiles: marekProfiles, self: "p2" });

  it("looks up a .dusk name in styled letters as people read it: Astra's E𝐦𝐦a.dusk is emma.dusk, not Unicode's skeleton's ernrna.dusk", () => {
    // Mathematical bold and fullwidth letters read as their ordinary ones, not as Unicode's skeleton has an m, "rn".
    for (const name of ["E\u{1d426}\u{1d426}a.dusk", "\uff45\uff4d\uff4d\uff41.dusk", "\u{1d404}\u{1d426}\u{1d426}\u{1d41a}.dusk"]) {
      assert.deepEqual(nameDuskNames(name), ["emma.dusk"], name);
      assert.deepEqual(named(name, new Map([["emma.dusk", { account: "emma" }]])), { dusk: true, entry: null, kind: "dusk", name: "emma.dusk", refused: true, words: "That looks like emma.dusk, which belongs to another account. Choose another name." }, name);
    }
  });

  it("looks up each of several .dusk names a comma, a slash or a semicolon parts: Astra's alice.dusk,bob.dusk", () => {
    // As one word, neither could be registered, so neither was looked up, and another account's stayed a question.
    for (const name of ["alice.dusk,bob.dusk", "alice.dusk/bob.dusk", "alice.dusk; bob.dusk", "(alice.dusk|bob.dusk)"]) assert.deepEqual(nameDuskNames(name), ["alice.dusk", "bob.dusk"], name);
    assert.deepEqual(nameDuskNames("sofia.dusk\u2019s"), ["sofia.dusk"]);
    assert.deepEqual(named("alice.dusk,bob.dusk", new Map([["bob.dusk", { account: "bob" }]])), { dusk: true, entry: null, kind: "dusk", name: "bob.dusk", refused: true, words: "bob.dusk belongs to another account. Choose another name." });
    // The profile's own beside one not registered: that one is asked about.
    assert.deepEqual(named("alice.dusk,bob.dusk", new Map([["alice.dusk", "p2"], ["bob.dusk", null]]))?.words, "bob.dusk is a .dusk name. Is it this profile's?");
  });

  it("is answered, to be saved, in the words both wallets show", () => {
    assert.equal(NAME_SAVE_YES, "Yes, save it");
  });

  it("shows what can't be seen in a name kept from before as its codes", () => {
    const kept = [{ address: "r", duskName: "bob.dusk", name: "\u202eboB" }];

    assert.equal(profileNameCheck("bob.dusk", { contacts: kept, self: "p2" })?.words, "You have a contact called \\u202eboB, at bob.dusk. Is this someone else?");
  });
});

describe("a contact's name at Save", () => {
  // Amélie's: her grandson saved as "Lucas (petit-fils)"; the "new phone, new account" message asks her to save
  // another account as plain "Lucas". Sofía's Profile 1 is sofiadesign.dusk.
  const profiles = [
    { account: "p1", address: "s1", duskName: "sofiadesign.dusk", name: "Profile 1" },
    { account: "p2", address: "s2", name: "Mamie" },
  ];
  const contacts = [
    { address: A, id: "c1", name: "Lucas (petit-fils)" },
    { address: C, id: "c2", name: "Wendy" },
  ];
  const check = (/** @type {string} */ name, /** @type {{ except?: string, address?: string }} */ more = {}) => contactNameCheck(name, { address: "elsewhere", contacts, profiles, ...more });
  const lucas = { dusk: false, entry: contacts[0], kind: "contact", name: "Lucas (petit-fils)", refused: false };

  it("asks about a name another contact's starts as, or that starts as theirs, with their address: Amélie's 'Lucas'", () => {
    assert.deepEqual(check("Lucas"), { ...lucas, words: "You have a contact called Lucas (petit-fils), at 26JfWK…B5NsNi. Is this someone else?" });
    assert.deepEqual(check("Lucas (petit-fils) 2"), { ...lucas, words: "You have a contact called Lucas (petit-fils), at 26JfWK…B5NsNi. Is this someone else?" });
    assert.deepEqual(check("lucas"), check("Lucas"));
  });

  it("asks about another contact's name, or one like it, rather than saving it beside theirs", () => {
    assert.deepEqual(check("Lucas (petit-fils)"), { ...lucas, words: "You have a contact called Lucas (petit-fils), at 26JfWK…B5NsNi. Is this someone else?" });
    assert.deepEqual(check("Luc\u0430s (petit-fils)"), { ...lucas, words: "That looks like your contact Lucas (petit-fils), at 26JfWK…B5NsNi. Is this someone else?" });
    assert.deepEqual(check("VVendy"), { dusk: false, entry: contacts[1], kind: "contact", name: "Wendy", refused: false, words: "That looks like your contact Wendy, at zFVXTQ…y4yEuL. Is this someone else?" });
    // The contact changed takes nothing from itself.
    assert.equal(check("Lucas (petit-fils)", { except: "c1" }), null);
    assert.equal(check("Lucas", { except: "c1" }), null);
  });

  it("refuses a profile's name or .dusk name, or one like it, and asks about one a profile's starts as", () => {
    assert.deepEqual(check("Profile 1"), { dusk: false, entry: profiles[0], kind: "profile", name: "Profile 1", refused: true, words: "One of your profiles is called Profile 1. Choose another name." });
    assert.deepEqual(check("ProfiIe 1"), { dusk: false, entry: profiles[0], kind: "profile", name: "Profile 1", refused: true, words: "That looks like Profile 1, one of your profiles. Choose another name." });
    assert.deepEqual(check("sofiadesign.dusk"), { dusk: true, entry: profiles[0], kind: "profile", name: "sofiadesign.dusk", refused: true, words: "One of your profiles is called sofiadesign.dusk. Choose another name." });
    assert.deepEqual(check("Mamie Jeanne"), { dusk: false, entry: profiles[1], kind: "profile", name: "Mamie", refused: false, words: "One of your profiles is called Mamie. Is this someone else?" });
    // A contact saved with a profile's own account or shielded address takes nothing from that profile's name.
    assert.equal(check("Profile 1", { address: "p1" }), null);
    assert.equal(check("Mamie Jeanne", { address: "s2" }), null);
  });

  it("refuses what can't be seen, and says nothing of the rest", () => {
    assert.deepEqual(check("Luc\u200bas"), { dusk: false, entry: null, kind: "hides", name: "", refused: true, words: NAME_HIDES });

    for (const name of ["Carla", "Luc", "Wen", "Ann", "Profile 3", ""]) assert.equal(check(name), null, name);
  });
});
