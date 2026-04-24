export type Severity = "P0" | "P1";
export type PassStatus = "pass" | "fail" | "partial" | "skip";

export interface RubricEntry {
  severity: Severity;
  name: string;
  status: "pass" | "fail";
  note?: string;
}

export interface GradeJson {
  model: string;
  task: string;
  skill: string;
  kind: "assembly" | "composition" | "gap" | "unknown";
  pattern?: string;
  p0_passed: string;
  p1_passed: string;
  load: PassStatus;
  behavioral: PassStatus;
  headline: string;
  notes: string[];
}
