import fs from "node:fs";
import type { GradeJson, PassStatus, Severity } from "./types.ts";

export class Rubric {
  private lines: string[] = [];
  private notes: string[] = [];
  private p0Total = 0;
  private p0Pass = 0;
  private p1Total = 0;
  private p1Pass = 0;
  loadStatus: PassStatus = "skip";
  loadNote = "";
  behavioralStatus: PassStatus = "skip";
  behavioralNote = "";

  say(line: string): void {
    this.lines.push(line);
  }

  mark(severity: Severity, name: string, status: "pass" | "fail", note?: string): void {
    if (severity === "P0") {
      this.p0Total++;
      if (status === "pass") this.p0Pass++;
    } else {
      this.p1Total++;
      if (status === "pass") this.p1Pass++;
    }
    const box = status === "pass" ? "[x]" : "[ ]";
    const tag = severity === "P0" ? "**P0**" : "P1";
    this.lines.push(`- ${box} ${tag} ${name}${note ? ` — ${note}` : ""}`);
    if (status === "fail") {
      this.notes.push(`${severity} miss: ${name}${note ? ` (${note})` : ""}`);
    }
  }

  p0(name: string, status: "pass" | "fail", note?: string): void {
    this.mark("P0", name, status, note);
  }

  p1(name: string, status: "pass" | "fail", note?: string): void {
    this.mark("P1", name, status, note);
  }

  addNote(note: string): void {
    this.notes.push(note);
  }

  get totals() {
    return { p0Pass: this.p0Pass, p0Total: this.p0Total, p1Pass: this.p1Pass, p1Total: this.p1Total };
  }

  emitMarkdown(): string {
    const lines = this.lines.slice();
    lines.push("");
    lines.push("## Summary");
    lines.push(`- P0: ${this.p0Pass}/${this.p0Total}`);
    lines.push(`- P1: ${this.p1Pass}/${this.p1Total}`);
    lines.push(`- Load: ${this.loadStatus}${this.loadNote ? ` (${this.loadNote})` : ""}`);
    lines.push(`- Behavioral: ${this.behavioralStatus}${this.behavioralNote ? ` (${this.behavioralNote})` : ""}`);
    lines.push(`- Headline: ${this.headline()}`);
    return lines.join("\n") + "\n";
  }

  headline(): string {
    if (this.p0Total === 0) return "no checks run";
    const probesOk =
      (this.loadStatus === "pass" || this.loadStatus === "skip") &&
      (this.behavioralStatus === "pass" || this.behavioralStatus === "skip");
    if (this.p0Pass === this.p0Total && probesOk) return "full pass";
    if (this.p0Pass >= Math.floor((this.p0Total * 3) / 4)) return "mostly passing";
    return "major misses";
  }

  writeJson(
    path: string,
    meta: { model: string; task: string; skill: string; kind: GradeJson["kind"]; pattern?: string },
  ): GradeJson {
    const json: GradeJson = {
      model: meta.model,
      task: meta.task,
      skill: meta.skill,
      kind: meta.kind,
      pattern: meta.pattern,
      p0_passed: `${this.p0Pass}/${this.p0Total}`,
      p1_passed: `${this.p1Pass}/${this.p1Total}`,
      load: this.loadStatus,
      behavioral: this.behavioralStatus,
      headline: this.headline(),
      notes: this.notes,
    };
    fs.writeFileSync(path, JSON.stringify(json));
    return json;
  }
}
