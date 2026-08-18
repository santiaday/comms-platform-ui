// Turning machine keys into language a human can scan.
//
// The raw keys carry real structure that the UI was throwing away, printing the
// whole thing in every cell:
//
//   experiment  DemoDriver-2+Days-E1-Emerging
//   variant     DemoDriver-2+Days-E1-Emerging-D-GPT5     <- the experiment name,
//                                                           repeated, plus 5 chars
//                                                           of actual information
//
// Stripping the redundant prefix is most of the readability win: that variant is
// just "D · GPT5". The rest is decoding the segments into words.
//
// Everything here is a pure function over strings — no data access — so it is
// cheap to test and safe to get wrong loudly rather than quietly.

/** Program a key belongs to. Drives grouping in the UI. */
export type Program = "demo_driver_email" | "demo_driver_sms" | "mql_driver" | "hubspot_tofu" | "other";

export interface ExperimentName {
  /** Human title, e.g. "2+ days out · Touch 1 · Emerging". */
  title: string;
  /** Program bucket for grouping. */
  program: Program;
  /** Short program label for headings. */
  programLabel: string;
  /** Dimensions we could decode, for facet chips. */
  facets: string[];
}

const COHORT: Record<string, string> = {
  "2+Days": "2+ days out",
  NextDay: "Next day",
  SameDay: "Same day",
};
const TOUCH: Record<string, string> = {
  E1: "Touch 1",
  Middle: "Mid-sequence",
  MorningOf: "Morning of",
};
const SEGMENT: Record<string, string> = {
  SMB: "SMB",
  MM: "Mid-market",
  Emerging: "Emerging",
  E1: "Enterprise 1",
};
const MODEL: Record<string, string> = {
  GPT5: "GPT-5",
  "GPT5.1": "GPT-5.1",
  "GPT4.1": "GPT-4.1",
  Generic: "Generic",
};

const PROGRAM_LABEL: Record<Program, string> = {
  demo_driver_email: "Demo Driver — Email",
  demo_driver_sms: "Demo Driver — SMS",
  mql_driver: "MQL Driver",
  hubspot_tofu: "HubSpot — Top of Funnel",
  other: "Other",
};

export function programOf(objectiveKey: string, experimentKey: string | null): Program {
  if (objectiveKey === "demo_driver_morning_sms") return "demo_driver_sms";
  if (objectiveKey === "mql_driver_email") return "mql_driver";
  if (objectiveKey === "hubspot_tofu_email") return "hubspot_tofu";
  if (objectiveKey === "demo_driver_email") return "demo_driver_email";
  if ((experimentKey ?? "").startsWith("SLT-")) return "hubspot_tofu";
  return "other";
}

export const programLabel = (p: Program): string => PROGRAM_LABEL[p];

/**
 * Decode an experiment key into something readable.
 *
 * Unknown shapes fall through to the raw key rather than being mangled — a new
 * program should look unstyled, not mislabelled.
 */
export function experimentName(objectiveKey: string, experimentKey: string | null): ExperimentName {
  const program = programOf(objectiveKey, experimentKey);
  const key = experimentKey ?? "";
  const base = { program, programLabel: PROGRAM_LABEL[program] };

  // DemoDriver-{Cohort}-{Touch}-{Segment}
  if (key.startsWith("DemoDriver-") && !key.startsWith("DemoDriver-SMS")) {
    const [, cohort, touch, segment] = key.split("-");
    const parts = [
      COHORT[cohort ?? ""] ?? cohort,
      TOUCH[touch ?? ""] ?? touch,
      SEGMENT[segment ?? ""] ?? segment,
    ].filter(Boolean) as string[];
    if (parts.length) return { ...base, title: parts.join(" · "), facets: parts };
  }

  if (key.startsWith("DemoDriver-SMS")) {
    const touch = key.split("-")[2];
    const t = TOUCH[touch ?? ""] ?? touch ?? "";
    return { ...base, title: t ? `SMS · ${t}` : "SMS", facets: [t].filter(Boolean) as string[] };
  }

  // MQLDriver-Email-{n}-A
  const mql = /^MQLDriver-Email-(\d+)/.exec(key);
  if (mql) return { ...base, title: `Email ${mql[1]}`, facets: [`Email ${mql[1]}`] };

  // SLT-0n  (HubSpot top-of-funnel send-list tests)
  const slt = /^SLT-0*(\d+)$/.exec(key);
  if (slt) return { ...base, title: `Send test ${slt[1]}`, facets: [`Test ${slt[1]}`] };

  return { ...base, title: key || "—", facets: [] };
}

/**
 * Strip the experiment prefix from a variant key and format what's left.
 * "DemoDriver-2+Days-E1-Emerging-D-GPT5" + that experiment -> "D · GPT-5".
 */
export function shortVariant(variantKey: string | null, experimentKey: string | null): string {
  if (!variantKey) return "untagged";
  let rest = variantKey;
  if (experimentKey && rest.startsWith(experimentKey)) {
    rest = rest.slice(experimentKey.length).replace(/^-/, "");
  }
  if (!rest) return variantKey;
  // Remaining shapes: "D-GPT5", "E1-A-Generic", "GiftOfferEmail", "A", "Control"
  const segs = rest.split("-").filter(Boolean);
  const pretty = segs.map((s) => MODEL[s] ?? s);
  return pretty.join(" · ");
}

/** Sort experiments so related ones sit together and the busiest lead. */
export function experimentSortKey(name: ExperimentName): string {
  return `${name.program}::${name.title}`;
}
