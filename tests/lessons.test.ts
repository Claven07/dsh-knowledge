import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitAutomaticCandidates,
  MAX_CANDIDATES_PER_TURN,
  MAX_CANDIDATE_CONTENT_CHARS,
  MAX_EXTRACTION_EVENTS,
  MAX_EXTRACTION_EVENT_CHARS,
  MAX_EXTRACTION_TOTAL_CHARS,
  type ExtractionEventReference,
} from "../src/knowledge/extraction.js";
import { checkKnowledgeHealth } from "../src/knowledge/health.js";
import {
  extractLessonCandidates,
  type LessonExtractionEventReference,
  type LessonExtractionInput,
  type LessonReferenceSpan,
} from "../src/knowledge/lessons.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { retrieveRelevantKnowledge } from "../src/knowledge/retrieval.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

const timestamp = "2026-10-03T12:00:00.000Z";
const scope = { workspace: "workspace-a", project: "payments" };
const correction = "Don't call Gemini directly; use ResponseRouter.";
type Fixture = Readonly<{ text: string; spans?: readonly LessonReferenceSpan[] }>;
type Range = readonly [number, number];

// Assertions are manually declared coordinates, never inferred from the text or its casing.
function fixture(text: string, ranges?: readonly Range[]): Fixture {
  return { text, ...(ranges === undefined ? {} : { spans: ranges.map(([start, end]) => ({ start, end })) }) };
}
const assertedCorrection = fixture(correction, [[11, 17], [32, 46]]);

function event(value: string | Fixture, overrides: Partial<LessonExtractionEventReference> = {}): LessonExtractionEventReference {
  const source = typeof value === "string" ? fixture(value) : value;
  return {
    sequence: 17, timestamp, kind: "user_message", author: "human", text: source.text,
    ...(source.spans === undefined ? {} : { referenceSpans: source.spans }), ...overrides,
  };
}
function input(events: readonly LessonExtractionEventReference[]): LessonExtractionInput {
  return { sessionId: "session-m6-1", scope, events };
}
function detect(value: string | Fixture) {
  return extractLessonCandidates(input([event(value)]));
}

function expectRejected(value: string | Fixture, sensitiveCount = 0, overrides: Partial<LessonExtractionInput> = {}) {
  const detection = extractLessonCandidates({ ...input([event(value)]), ...overrides });
  expect(detection).toEqual({ candidates: [], sensitiveCount });
  const store = new KnowledgeStore(":memory:");
  try {
    const repository = new KnowledgeRepository(store);
    const create = vi.spyOn(repository, "create");
    expect(admitAutomaticCandidates(repository, scope, detection)).toEqual({
      created: [], skipped: { sensitive: sensitiveCount, duplicate: 0 },
    });
    expect(create).not.toHaveBeenCalled();
    expect(repository.list()).toEqual([]);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM knowledge").get()).toEqual({ count: 0 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence").get()).toEqual({ count: 0 });
    expect(JSON.stringify(detection)).not.toContain("referenceSpans");
  } finally { store.close(); }
}

function expectAccepted(value: Fixture) {
  const expectedContent = value.text.trim();
  const evidence = [{ type: "session", source: "session-m6-1", locator: "seq=17", timestamp }];
  const detection = detect(value);
  expect(detection).toEqual({ candidates: [{ type: "lesson", content: expectedContent, evidence }], sensitiveCount: 0 });
  const store = new KnowledgeStore(":memory:");
  try {
    const repository = new KnowledgeRepository(store);
    const create = vi.spyOn(repository, "create");
    const result = admitAutomaticCandidates(repository, scope, detection);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      type: "lesson", status: "candidate", creationOrigin: "automatic", content: expectedContent, scope, evidence,
    });
    expect(result.created[0]?.evidence).toHaveLength(1);
    expect(repository.getById(result.created[0]!.id)).toEqual(result.created[0]);
    expect(repository.list()).toEqual(result.created);
    const rows = store.database.prepare("SELECT * FROM knowledge").all();
    const evidenceRows = store.database.prepare("SELECT * FROM knowledge_evidence").all();
    expect(rows).toHaveLength(1);
    expect(evidenceRows).toHaveLength(1);
    for (const persisted of [create.mock.calls[0], result, rows, evidenceRows]) {
      expect(JSON.stringify(persisted)).not.toContain("referenceSpans");
      expect(JSON.stringify(persisted)).not.toContain('"start":');
      expect(JSON.stringify(persisted)).not.toContain('"end":');
    }
  } finally { store.close(); }
}

// Each template declares its own reference slots with fixed numeric starts.
// Length arithmetic only follows the supplied fixture reference; no token discovery occurs.
function referenceLessons(reference: string, assertTarget: boolean): Fixture[] {
  const length = reference.length;
  const target = (start: number): Range[] => assertTarget ? [[start, start + length]] : [];
  return [
    fixture(`Don't call LegacyProvider directly; use ${reference}.`, [[11, 25], ...target(40)]),
    fixture(`Don't call ${reference} directly; use ModernRouter.`, [...target(11), [26 + length, 38 + length]]),
    fixture(`This repository requires ${reference} before typechecking.`, target(25)),
    fixture(`Run generation before ${reference} in this project.`, target(22)),
    fixture(`${reference} fails when PrismaClient is omitted; include PrismaClient before building.`, [
      ...target(0), [length + 12, length + 24], [length + 45, length + 57],
    ]),
    fixture(`The build fails when ${reference} is omitted; include ${reference} before building.`, [
      ...target(21), ...target(42 + length),
    ]),
    fixture(`The build fails when PrismaClient is omitted; include PrismaClient before ${reference}.`, [
      [21, 33], [54, 66], ...target(74),
    ]),
  ];
}

function temporalLessons(qualifier: string): Fixture[] {
  return [
    fixture(`Don't call Gemini directly; use ResponseRouter ${qualifier}.`, [[11, 17], [32, 46]]),
    fixture(`Run X ${qualifier} before Y in this project.`, [[4, 5], [14 + qualifier.length, 15 + qualifier.length]]),
    fixture(`This repository requires generation before typechecking ${qualifier}.`, [[25, 35], [43, 55]]),
    fixture(`The build fails when X is omitted; include X before building ${qualifier}.`, [[21, 22], [43, 44], [52, 60]]),
  ];
}

const technicalNames = [
  "ResponseRouter", "Gemini", "PrismaClient", "TypeScript", "React", "runMigrations", "buildClient",
  "requiredConfig", "requiredConfiguration", "nextStepHandler", "nextStep", "stepRunner",
  "preparationConfig", "preparationScript", "continuingSession", "continuingHandler",
  "correctnessChecker", "correctResponse", "rightProvider", "rightProviderConfig",
  "runOnce", "OneTimeScheduler", "thisTimeConfig", "TomorrowJob", "NOWProvider",
  "CorrectHelper", "RequiredStep", "PreparationClient", "continueBuild", "SDK", "Function", "Work", "X", "Y",
];
const structuralNames = [
  "package.json", "once.ts", "now.css", "tomorrow.json", "run-once", "scripts/now", "API_CLIENT",
  "stepRunner.ts", "once-only.ts", "one-time.json", "scripts/this-time", "just-once.ts",
  "only-once.ts", "right-now.ts", "one-off.ts", "one-time-only.ts",
];
const genericNames = [
  "The Correct Helper", "The Right Helper", "The Required Step", "The Next Step",
  "Preparation", "Continuing", "The Correct Helper Function", "The Required Preparation Work",
  "Preparation Work", "The Helper Function", "The Correct Response Function", "The Helper FuNcTiOn",
  "The Appropriate Handler", "The Relevant Configuration",
];
function casings(value: string): string[] {
  return [...new Set([
    value.toLowerCase(), value, value.toUpperCase(),
    value.split("").map((character, index) => index % 2 === 0 ? character.toLowerCase() : character.toUpperCase()).join(""),
  ])];
}
const genericFixtures = genericNames.flatMap(casings).flatMap((reference) =>
  [...new Set([reference, reference.replace(/ /g, "  "), reference.replace(/ /g, "\t")])]
    .flatMap((spaced) => referenceLessons(spaced, false)));

const temporalFixtures = [
  ...["once", "now", "tomorrow", "today", "currently", "temporarily", "one-off"].flatMap(casings),
  "this time", "THIS TIME", "THIS  TIME", "This  Time", "this    time", "This\tTime", "This \t Time", "tHiS\tTiMe", "THIS\u00a0TIME",
  "one time", "ONE TIME", "One  Time", "oNe\tTiMe", "One \t Time",
  "once-only", "ONCE-ONLY", "oNcE-oNlY", "Once Only", "ONCE \t- \t ONLY",
  "one-time", "ONE - TIME", "this-time", "THIS - TIME", "ONLY-ONCE", "JUST-ONCE", "RIGHT-NOW", "for-now",
  "ONE OFF", "ONE \t- \t OFF", "ONE-TIME-ONLY", "THIS-TIME-ONLY", "FOR-NOW-ONLY",
  "for  this  task", "FOR\tTHE\tCURRENT\tSESSION",
].flatMap(temporalLessons);

const staticPositiveFixtures: Fixture[] = [
  assertedCorrection,
  fixture("Instead of using X, use Y.", [[17, 18], [24, 25]]),
  fixture("X is wrong here; use Y.", [[0, 1], [21, 22]]),
  fixture("Run X before Y in this project.", [[4, 5], [13, 14]]),
  fixture("The build fails when X is omitted; include X before building.", [[21, 22], [43, 44]]),
  fixture("Y breaks because X is missing; add X.", [[0, 1], [17, 18], [35, 36]]),
  fixture("Instead of using DirectProvider, use ResponseRouter.", [[17, 31], [37, 51]]),
  fixture("DirectProvider is wrong here; use ResponseRouter.", [[0, 14], [34, 48]]),
  fixture("This repository requires generation before typechecking."),
  fixture("Run schema generation before typechecking in this project."),
  fixture("The build fails when BuildConfig is omitted; include BuildConfig before building.", [[21, 32], [53, 64]]),
  fixture("Typecheck breaks because GeneratedTypes is missing; add GeneratedTypes.", [[25, 39], [56, 70]]),
  fixture("Correction: Don't call Gemini directly; use ResponseRouter.", [[23, 29], [44, 58]]),
  fixture("Actually, Don't call Gemini directly; use ResponseRouter.", [[21, 27], [42, 56]]),
  fixture("No, Don't call Gemini directly; use ResponseRouter.", [[15, 21], [36, 50]]),
  fixture("Use ResponseRouter instead of Gemini.", [[4, 18], [30, 36]]),
  fixture("Always call ResponseRouter rather than calling Gemini.", [[12, 26], [47, 53]]),
  fixture("Provider selection must route through ResponseRouter instead of Gemini.", [[38, 52], [64, 70]]),
  fixture("This project must use ResponseRouter rather than Gemini.", [[22, 36], [49, 55]]),
  fixture("This repository requires The Required PrismaClient before typechecking.", [[38, 50]]),
  fixture("Don't call Gemini directly; use The Correct ResponseRouter.", [[11, 17], [44, 58]]),
  fixture("The build fails when Preparation Work is omitted; include Preparation Work before building.", [[21, 37], [58, 74]]),
  fixture("Don't call Gemini directly; use The Helper FuNcTiOn.", [[11, 17], [32, 51]]),
];

describe("deterministic durable lesson detection", () => {
  it.each(staticPositiveFixtures)("accepts a preventive rule with declared reference intent: $text", (value) => {
    expectAccepted(value);
  });

  it.each(staticPositiveFixtures.filter(({ spans }) => spans !== undefined))(
    "rejects identical ambiguous alphabetic text without assertions: $text", ({ text }) => { expectRejected(text); },
  );

  it("preserves original wording, punctuation and internal whitespace while accounting for leading trimming", () => {
    expectAccepted(fixture(" \tDon't call Gemini directly;  use ResponseRouter!\n ", [[13, 19], [35, 49]]));
    expectAccepted(fixture("Don't call Gemini directly;\tuse ResponseRouter!", [[11, 17], [32, 46]]));
    expectAccepted(fixture("Run\trunMigrations before buildClient in this project.", [[4, 17], [25, 36]]));
    expectAccepted(fixture("The build fails when PrismaClient is omitted;  include PrismaClient before building.", [[21, 33], [55, 67]]));
  });

  it("creates only compact session evidence without transcript or assertion metadata", () => {
    const result = extractLessonCandidates(input([event(assertedCorrection, { sequence: 29, failed: true })]));
    expect(result.candidates[0]?.evidence).toEqual([{ type: "session", source: "session-m6-1", locator: "seq=29", timestamp }]);
    expect(JSON.stringify(result.candidates[0]?.evidence)).not.toContain(correction);
    expect(Object.keys(result.candidates[0]!).sort()).toEqual(["content", "evidence", "type"]);
  });

  it("is deterministic and does not mutate frozen input, event, spans, or span ordering", () => {
    const referenceSpans = Object.freeze([Object.freeze({ start: 32, end: 46 }), Object.freeze({ start: 11, end: 17 })]);
    const value: LessonExtractionInput = Object.freeze({
      sessionId: "session-m6-1", scope: Object.freeze({ ...scope }),
      events: Object.freeze([Object.freeze(event(correction, { referenceSpans }))]),
    });
    const before = JSON.stringify(value);
    const first = extractLessonCandidates(value);
    expect(first.candidates).toHaveLength(1);
    for (let count = 0; count < 100; count++) expect(extractLessonCandidates(value)).toEqual(first);
    expect(JSON.stringify(value)).toBe(before);
    expectAccepted({ text: correction, spans: referenceSpans });
  });

  it.each([
    "That approach is wrong.", "Try again.", "Use the repository helper.", "This failed.",
    "npm install failed once.", "The command timed out.", "I prefer ResponseRouter to Gemini.",
    "Don't do that; use the helper.", "Instead of using the old approach, use the repository helper.",
    "That approach is wrong here; use something better.", "This repository requires preparation before continuing.",
    "Run the required step before the next step in this project.",
    "The build fails when schema generation is omitted; add unrelated logging.",
    "The network failed because the registry was unavailable; retrying fixed the issue.",
    "The npm registry fails when the network is unavailable; use ResponseRouter.",
    "GitHub is unavailable; retry the request.", "The network request timed out; try again.",
    "NOW", "TOMORROW",
  ])("rejects statements outside the durable lesson grammar: %s", (text) => { expectRejected(text); });

  it.each([
    fixture("The build fails when BuildConfig is omitted; include OtherConfig before building.", [[21, 32], [53, 64]]),
    fixture("Typecheck breaks because GeneratedTypes is missing; add OtherTypes.", [[25, 39], [56, 66]]),
    fixture("Don't call Gemini directly; use Gemini.", [[11, 17], [32, 38]]),
    fixture("Run X before X in this project.", [[4, 5], [13, 14]]),
    fixture("The build does not fail when BuildConfig is omitted; include BuildConfig before building.", [[29, 40], [61, 72]]),
    fixture("The build fails when BuildConfig is omitted; do not include BuildConfig before building.", [[21, 32], [60, 71]]),
    fixture("The build failed; use ResponseRouter.", [[22, 36]]),
  ])("assertions do not change reference identity or causal/grammar requirements: $text", (value) => { expectRejected(value); });

  it.each([
    { author: "assistant" as const }, { author: "synthetic" as const }, { author: "tool" as const },
    { kind: "assistant_message" as const, author: "human" as const },
    { kind: "tool_result" as const, author: "human" as const },
    { author: "unknown" as ExtractionEventReference["author"] },
  ])("rejects unsupported source surfaces even with assertions: %j", (overrides) => {
    expectRejected(assertedCorrection, 0, { events: [event(assertedCorrection, overrides)] });
  });

  it("does not interpret failure flags or assistant success claims", () => {
    expectRejected(assertedCorrection, 0, { events: [
      event("This failed.", { failed: true }),
      event("All tests passed after switching to ResponseRouter.", { kind: "assistant_message", author: "assistant" }),
      event(assertedCorrection, { kind: "tool_result", author: "tool" }),
    ] });
  });

  it.each([
    fixture(`Error: ${correction}`, [[18, 24], [39, 53]]),
    fixture(`${correction}\n    at ResponseRouter.run (src/router.ts:12:3)`, [[11, 17], [32, 46]]),
    fixture(`${correction}\nTraceback (most recent call last):`, [[11, 17], [32, 46]]),
    fixture(`stdout: ${correction}`, [[19, 25], [40, 54]]),
    fixture(`\`\`\`text\n${correction}\n\`\`\``, [[19, 25], [40, 54]]),
  ])("rejects raw logs and fences despite assertions: $text", (value) => { expectRejected(value); });
});

describe("explicit reference intent and automatic structural subset", () => {
  it.each(technicalNames.flatMap((reference) => referenceLessons(reference, true)))(
    "supports declared alphabetic technical and ambiguous names in each reference slot: $text", (value) => { expectAccepted(value); },
  );
  it.each(technicalNames.flatMap((reference) => referenceLessons(reference, false)))(
    "does not infer reference intent from capitalization or internal capitals: $text", (value) => { expectRejected(value); },
  );
  it.each(structuralNames.flatMap((reference) => referenceLessons(reference, false)))(
    "retains automatic delimiter-bearing forms in each reference slot: $text", (value) => { expectAccepted(value); },
  );
  it.each(structuralNames.flatMap((reference) => referenceLessons(reference, true)))(
    "also accepts whole structural references with explicit assertions: $text", (value) => { expectAccepted(value); },
  );
  it.each([
    fixture("Don't call package.json directly; use run-once."),
    fixture("This repository requires once.ts before typechecking."),
    fixture("Run schema generation before typechecking in this project."),
    fixture("The build fails when package.json is omitted; include package.json before building."),
    fixture("Run API_CLIENT before typechecking in this project."),
    fixture("Don't call Gemini directly; use This\ttime.ts.", [[11, 17]]),
    fixture("Don't call Gemini directly; use Right\tNow.ts.", [[11, 17], [32, 44]]),
    fixture("Don't call Gemini directly; use Only\tonce.ts.", [[11, 17], [32, 44]]),
  ])("retains documented structural and closed workflow expressions: $text", (value) => { expectAccepted(value); });

  it.each([
    "Run the helper before typechecking in this project.",
    "This repository requires source code before typechecking.",
    "Run Preparation generation before typechecking in this project.",
    "Run FuNcTiOn build before typechecking in this project.",
  ])("surrounding vocabulary and workflow words cannot authorize arbitrary English: %s", (text) => { expectRejected(text); });

  it.each(genericFixtures)("rejects unasserted generic compounds across casing, whitespace, and all slots: $text", (value) => {
    expectRejected(value);
  });
  it.each([
    fixture("Don't call Gemini directly; use The Correct Helper THIS  TIME.", [[11, 17], [32, 50]]),
    fixture("Don't call Gemini directly; use The Correct Helper Function ONCE-ONLY.", [[11, 17], [32, 59]]),
    fixture("Run The Next Step ONE TIME before Y in this project.", [[4, 17], [34, 35]]),
    fixture("The build fails when Preparation Work is omitted; include Preparation Work before building ONE TIME.", [[21, 37], [58, 74]]),
  ])("asserted generic-looking names still cannot override temporal exclusions: $text", (value) => { expectRejected(value); });
  it.each(temporalFixtures)("preserves M61-03 case/whitespace/punctuation protections across grammars: $text", (value) => {
    expectRejected(value);
  });
  it("accepts temporal-test controls with every reference slot asserted", () => {
    expectAccepted(fixture("This repository requires generation before typechecking.", [[25, 35], [43, 55]]));
    expectAccepted(fixture("The build fails when X is omitted; include X before building.", [[21, 22], [43, 44], [52, 60]]));
  });
});

describe("reference span validation", () => {
  const invalidMetadata: readonly [string, unknown][] = [
    ["string start", [{ start: "11", end: 17 }, { start: 32, end: 46 }]],
    ["string end", [{ start: 11, end: "17" }, { start: 32, end: 46 }]],
    ["fraction", [{ start: 11.5, end: 17 }, { start: 32, end: 46 }]],
    ["NaN", [{ start: Number.NaN, end: 17 }, { start: 32, end: 46 }]],
    ["Infinity", [{ start: 11, end: Number.POSITIVE_INFINITY }, { start: 32, end: 46 }]],
    ["unsafe integer", [{ start: Number.MAX_SAFE_INTEGER + 1, end: Number.MAX_SAFE_INTEGER + 2 }]],
    ["negative", [{ start: -1, end: 17 }, { start: 32, end: 46 }]],
    ["reversed", [{ start: 17, end: 11 }, { start: 32, end: 46 }]],
    ["zero length", [{ start: 11, end: 11 }, { start: 32, end: 46 }]],
    ["out of bounds", [{ start: 11, end: 17 }, { start: 32, end: 48 }]],
    ["null metadata", null], ["non-array metadata", { start: 11, end: 17 }],
    ["null span", [null]], ["missing endpoint", [{ start: 11 }]],
    ["more than four spans", [{ start: 11, end: 17 }, { start: 32, end: 46 }, { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }]],
  ];
  it.each(invalidMetadata)("rejects malformed metadata without a diagnostic or persistence: %s", (_name, spans) => {
    const value = { text: correction, spans: spans as readonly LessonReferenceSpan[] };
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      expectRejected(value);
      // A missing assertion could mask the error on alphabetic names; this rule needs none.
      expectRejected({ text: "Don't call package.json directly; use run-once.", spans: value.spans });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it.each<readonly [string, readonly Range[]]>([
    ["duplicate", [[11, 17], [11, 17], [32, 46]]],
    ["nested", [[11, 26], [11, 17], [32, 46]]],
    ["intersecting", [[11, 20], [18, 26], [32, 46]]],
    ["adjacent but token splitting", [[11, 14], [14, 17], [32, 46]]],
    ["partial ResponseRouter", [[11, 17], [32, 40]]],
    ["split CamelCase start", [[11, 17], [40, 46]]],
    ["leading whitespace", [[11, 17], [31, 46]]],
    ["trailing punctuation", [[11, 17], [32, 47]]],
    ["whitespace only", [[17, 18], [32, 46]]],
    ["prefix outside capture", [[0, 5], [11, 17], [32, 46]]],
    ["grammar verb", [[6, 10], [11, 17], [32, 46]]],
    ["separator", [[11, 17], [26, 27], [32, 46]]],
    ["cross-capture", [[11, 46]]],
    ["two assertions in same capture", [[11, 17], [18, 26], [32, 46]]],
  ])("rejects invalid relationships, token alignment, or capture containment: %s", (_name, ranges) => {
    expectRejected(fixture(correction, ranges));
  });

  it.each([
    fixture("Don't call Gemini directly; use package.json.", [[11, 17], [32, 39]]),
    fixture("Don't call Gemini directly; use run-once.", [[11, 17], [36, 40]]),
    fixture("Don't call Gemini directly; use ResponseRouter directly.", [[11, 17], [32, 47]]),
    fixture("Correction: Don't call Gemini directly; use ResponseRouter.", [[0, 10], [23, 29], [44, 58]]),
    fixture("Run X before Y in this project.", [[4, 5], [13, 14], [23, 30]]),
    fixture("Run X before Y in this project.", [[4, 5], [13, 14], [6, 12]]),
    fixture("Don't call Gemini directly; use ResponseRouter. ", [[11, 17], [32, 46], [47, 48]]),
  ])("rejects unused, suffix, token-fragment, or outside assertions: $text", (value) => { expectRejected(value); });

  it("allows unordered non-overlapping spans in separate captures", () => {
    expectAccepted(fixture(correction, [[32, 46], [11, 17]]));
  });
  it("consumes exactly four assertions in the causal grammar", () => {
    expectAccepted(fixture("BuildTarget fails when PrismaClient is omitted; include PrismaClient before TypecheckTarget.",
      [[0, 11], [23, 35], [56, 68], [76, 91]]));
  });
  it("keeps the eight-atom reference surface bound for caller-declared names", () => {
    expectAccepted(fixture("Run A B C D E F G H before typechecking in this project.", [[4, 19]]));
    expectRejected(fixture("Run A B C D E F G H I before typechecking in this project.", [[4, 21]]));
    expectRejected(fixture("Run X and Y before typechecking in this project.", [[4, 11]]));
  });
  it.each([
    fixture("The build fails when PrismaClient is omitted; include PrismaClient before building.", [[21, 33]]),
    fixture("The build fails when PrismaClient is omitted; include PrismaClient before building.", [[54, 66]]),
    fixture("Y breaks because X is missing; add X.", [[0, 1], [17, 18]]),
    fixture("Y breaks because X is missing; add X.", [[0, 1], [35, 36]]),
  ])("one asserted occurrence cannot authorize another identical causal occurrence: $text", (value) => { expectRejected(value); });

  it.each([
    fixture("Don't call Gemini directly; use ResponseRouter."),
    fixture("Don't call Gemini directly; use ResponseRouter.", []),
    fixture("Don't call Gemini directly; use ResponseRouter.", [[11, 17]]),
    fixture("Don't call Gemini directly; use ResponseRouter.", [[32, 46]]),
  ])("requires assertions for each ambiguous reference expression: $text", (value) => { expectRejected(value); });

  it("malformed assertions reject an otherwise fully automatic structural rule", () => {
    expectAccepted(fixture("Don't call package.json directly; use run-once."));
    expectRejected(fixture("Don't call package.json directly; use run-once.", [[-1, 2]]));
  });

  it("directly rejects reference-span endpoints that split a UTF-16 surrogate pair", async () => {
    // Expose the real private validator in memory so grammar rejection cannot mask this guard.
    const source = readFileSync(new URL("../src/knowledge/lessons.ts", import.meta.url), "utf8");
    const { outputText } = transpileModule(`${source}\nexport { validateReferenceSpans };`, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    });
    const validators = {} as {
      validateReferenceSpans: (text: string, value: unknown) => readonly LessonReferenceSpan[] | null;
    };
    const extraction = await import("../src/knowledge/extraction.js");
    runInNewContext(outputText, {
      exports: validators,
      require: (specifier: string) => {
        expect(specifier).toBe("./extraction.js");
        return extraction;
      },
    });

    const text = "\u{1f600} Gemini";
    expect(text.length).toBe(9);
    expect(validators.validateReferenceSpans(text, [{ start: 3, end: 9 }])).toEqual([{ start: 3, end: 9 }]);
    expect(validators.validateReferenceSpans(text, [{ start: 0, end: 2 }])).toEqual([{ start: 0, end: 2 }]);
    expect(validators.validateReferenceSpans(text, [{ start: 1, end: 2 }])).toBeNull();
    expect(validators.validateReferenceSpans(text, [{ start: 0, end: 1 }])).toBeNull();
  });

  it.each([
    fixture("😀 Gemini", [[3, 9]]),
    fixture("😀 Gemini", [[1, 2]]),
    fixture("😀 Gemini", [[0, 1]]),
    fixture("Don't call 😀 directly; use ResponseRouter.", [[11, 13], [28, 42]]),
    fixture("Don't call 😀Gemini directly; use ResponseRouter.", [[11, 12], [34, 48]]),
    fixture("Don't call 😀Gemini directly; use ResponseRouter.", [[12, 19], [34, 48]]),
    fixture("Don't call Gémǐni directly; use ResponseRouter.", [[11, 17], [32, 46]]),
  ])("keeps Unicode reference text unsupported, including surrogate-splitting metadata: $text", (value) => {
    expectRejected(value);
  });
});

describe("privacy and overriding rejection boundaries", () => {
  const secrets = [
    "ghp_123456789012345678901234567890123456", "sk-proj-123456789012345678901234567890",
    "AIza123456789012345678901234567890123456789", "Bearer abcdefghijklmnopqrstuvwxyz012345",
    "eyJabcdefghijk.abcdefghijk.abcdefghijk", "password=hunter2", "client_secret: abcdefghijklmnop",
    "credential=supersecret", "postgres://app:supersecret@db.example.test/main", "-----BEGIN PRIVATE KEY-----",
  ];
  it.each(secrets)("retains canonical privacy accounting with valid and malformed annotations: %s", (secret) => {
    expectRejected(fixture(`${correction} ${secret}`, [[11, 17], [32, 46]]), 1);
    expectRejected(fixture(`${correction} ${secret}`, [[-1, 17]]), 1);
  });
  it("does not retain sensitive session IDs or log private rejected content", () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      expectRejected(assertedCorrection, 1, { sessionId: "password=hunter2" });
      expectRejected(fixture(`${correction} password=hunter2`, [[-1, 17]]), 1);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
  });
  it.each([
    "?", " for this task.", " temporarily.", " only once.", " possibly.", " until this issue is fixed.",
    " for this session.", " for the current task.", " in this task.",
    ". It might help.", ". Everything is fine.",
  ])("assertions cannot override weak-language or unsupported trailing clauses: %s", (suffix) => {
    expectRejected(fixture(`Don't call Gemini directly; use ResponseRouter${suffix}`, [[11, 17], [32, 46]]));
  });
  it("treats neutral descriptive words as syntax only when reference intent is asserted", () => {
    const text = "Don't call Gemini directly; use ResponseRouter incidentally.";
    expectRejected(text);
    expectAccepted(fixture(text, [[11, 17], [32, 46]]));
  });
});

describe("lesson extraction bounds and structural validation", () => {
  function boundedRule(length: number): Fixture {
    const text = `Don't call Provider${"a".repeat(length - 49)} directly; use ResponseRouter.`;
    return fixture(text, [[11, length - 30], [length - 15, length - 1]]);
  }
  it("accepts exactly 600 proposal characters and rejects overflow without truncation", () => {
    expect(MAX_CANDIDATE_CONTENT_CHARS).toBe(600);
    const exact = boundedRule(600);
    expect(exact.text).toHaveLength(600);
    expectAccepted(exact);
    expectRejected(boundedRule(601));
  });
  it("preserves per-event bounds and refuses to accept a truncated prefix", () => {
    expect(MAX_EXTRACTION_EVENT_CHARS).toBe(1_200);
    expectAccepted(fixture(correction.padEnd(1_200), [[11, 17], [32, 46]]));
    expectRejected(fixture(`${correction.padEnd(1_200)}x`, [[11, 17], [32, 46]]));
    expectRejected(fixture(`${correction.padEnd(1_200)} password=hunter2`, [[11, 17], [32, 46]]));
  });
  it("checks sensitive suffixes past proposal length using existing accounting", () => {
    expectRejected(fixture(`${correction}${" ".repeat(600)}password=hunter2`, [[11, 17], [32, 46]]), 1);
  });
  it("does not inspect beyond eight events, including reference metadata", () => {
    expect(MAX_EXTRACTION_EVENTS).toBe(8);
    const events = Array.from({ length: 8 }, (_, sequence) => event("Try again.", { sequence }));
    events.push(event(assertedCorrection, { sequence: 8 }));
    expectRejected(assertedCorrection, 0, { events });
  });
  it("accepts exactly 4,000 inspected characters and rejects the next character", () => {
    expect(MAX_EXTRACTION_TOTAL_CHARS).toBe(4_000);
    const rejected = Array.from({ length: 3 }, (_, sequence) => event("Try again.".padEnd(1_200), { sequence }));
    const exact = event(fixture(correction.padEnd(400), [[11, 17], [32, 46]]), { sequence: 3 });
    const result = extractLessonCandidates(input([...rejected, exact]));
    expect(result.candidates[0]?.content).toBe(correction);
    expectRejected(assertedCorrection, 0, { events: [...rejected, { ...exact, text: `${exact.text} ` }] });
  });
  it("returns only two proposals in input order", () => {
    expect(MAX_CANDIDATES_PER_TURN).toBe(2);
    const statements = [assertedCorrection, fixture("This repository requires generation before typechecking."), fixture("Run schema generation before typechecking in this project.")];
    const result = extractLessonCandidates(input(statements.map((value, sequence) => event(value, { sequence }))));
    expect(result.candidates.map(({ content }) => content)).toEqual(statements.slice(0, 2).map(({ text }) => text));
  });
  it("returns nothing for absent text or empty event lists", () => {
    expectRejected(assertedCorrection, 0, { events: [] });
    expectRejected(assertedCorrection, 0, { events: [event("", { text: undefined })] });
  });
  it("preserves the 128-character session bound and content-free errors", () => {
    const sessionId = "session-".padEnd(128, "x");
    expect(extractLessonCandidates({ ...input([event(assertedCorrection)]), sessionId }).candidates[0]?.evidence[0]?.source).toBe(sessionId);
    expect(() => extractLessonCandidates({ ...input([event(assertedCorrection)]), sessionId: `${sessionId}x` })).toThrowError(RangeError);
    try { extractLessonCandidates({ ...input([event(assertedCorrection)]), sessionId: `${sessionId}x` }); }
    catch (error) { expect((error as Error).message).not.toContain(sessionId); }
  });
  it.each([
    { sessionId: "" }, { scope: { workspace: "" } }, { scope: { workspace: "workspace-a", project: "" } },
    { events: [event(assertedCorrection, { sequence: -1 })] },
    { events: [event(assertedCorrection, { timestamp: "password=private" })] },
    { events: [event(assertedCorrection, { text: 42 as unknown as string })] },
  ])("preserves fixed input-validation errors without private content: %j", (overrides) => {
    const value = { ...input([event(assertedCorrection)]), ...overrides };
    expect(() => extractLessonCandidates(value)).toThrowError(TypeError);
    try { extractLessonCandidates(value); }
    catch (error) {
      expect((error as Error).message).not.toContain("password=private");
      expect((error as Error).message).not.toContain(correction);
    }
  });
});

describe("lesson detector admission and retrieval isolation", () => {
  let store: KnowledgeStore;
  let repository: KnowledgeRepository;
  beforeEach(() => { store = new KnowledgeStore(":memory:"); repository = new KnowledgeRepository(store); });
  afterEach(() => { store.close(); });
  function admit(value: Fixture = assertedCorrection, sessionId = "session-m6-1") {
    return admitAutomaticCandidates(repository, scope, extractLessonCandidates({ ...input([event(value)]), sessionId }));
  }
  it("creates actual output without lifecycle mutation", () => {
    const update = vi.spyOn(repository, "update");
    const archive = vi.spyOn(repository, "archive");
    const supersede = vi.spyOn(repository, "supersede");
    const result = admit();
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ type: "lesson", status: "candidate", creationOrigin: "automatic", content: correction, scope });
    expect(repository.getById(result.created[0]!.id)).toEqual(result.created[0]);
    expect(update).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled(); expect(supersede).not.toHaveBeenCalled();
  });
  it("deduplicates detected lessons without merging evidence or timestamps", () => {
    const original = admit().created[0]!;
    expect(admit(assertedCorrection, "later-session")).toEqual({ created: [], skipped: { sensitive: 0, duplicate: 1 } });
    expect(repository.getById(original.id)).toEqual(original);
  });
  it("does not mutate matching verified lessons", () => {
    const existing = admit().created[0]!;
    repository.update(existing.id, { status: "verified" });
    const before = repository.getById(existing.id);
    expect(admit(assertedCorrection, "later-session")).toEqual({ created: [], skipped: { sensitive: 0, duplicate: 1 } });
    expect(repository.getById(existing.id)).toEqual(before);
  });
  it("keeps M2 eligibility, scores, contributions, ordering, scope preference and suppression unchanged", () => {
    const explicit = repository.create({ type: "fact", content: "ResponseRouter provider selection follows the local policy.", scope });
    const workspace = repository.create({ type: "fact", content: "ResponseRouter provider selection follows the workspace policy.", scope: { workspace: scope.workspace } });
    const verified = repository.create({ type: "lesson", content: "ResponseRouter provider selection follows the centralized routing policy for this repository.", scope });
    repository.update(verified.id, { status: "verified" });
    const duplicate = repository.create({ type: "lesson", content: "ResponseRouter provider selection follows the centralized routing policy for this repository locally.", scope });
    const excluded = repository.create({ type: "fact", content: "ResponseRouter provider selection follows the other project policy.", scope: { ...scope, project: "other" } });
    const options = { ...scope, limit: 100 };
    const before = retrieveRelevantKnowledge(repository, "ResponseRouter provider selection", options);
    expect(before.map(({ knowledge }) => knowledge.id)).toEqual([verified.id, explicit.id, workspace.id]);
    expect(before[0]?.explanation.suppressedSimilarIds).toContain(duplicate.id);
    expect(before.map(({ knowledge }) => knowledge.id)).not.toContain(excluded.id);
    const preserved = repository.list();
    const automatic = admit().created[0]!;
    const after = retrieveRelevantKnowledge(repository, "ResponseRouter provider selection", options);
    expect(after).toEqual(before);
    expect(after.map(({ knowledge }) => knowledge.id)).not.toContain(automatic.id);
    for (const item of preserved) expect(repository.getById(item.id)).toEqual(item);
    repository.update(automatic.id, { status: "verified" });
    expect(retrieveRelevantKnowledge(repository, "ResponseRouter", options).map(({ knowledge }) => knowledge.id)).toContain(automatic.id);
    expect(repository.getById(automatic.id)?.creationOrigin).toBe("automatic");
  });
  it("retains session-only health semantics without Git work or mutation", async () => {
    const automatic = admit().created[0]!;
    const runner = { run: vi.fn(async () => ({ exitCode: 0, stdout: "" })) };
    const health = await checkKnowledgeHealth(automatic, { workspaceDirectory: scope.workspace, runner });
    expect(health.status).toBe("unverifiable");
    expect(health.reasons).toEqual(["no_git_backed_file_evidence"]);
    expect(runner.run).not.toHaveBeenCalled();
    expect(repository.getById(automatic.id)).toEqual(automatic);
  });
});
