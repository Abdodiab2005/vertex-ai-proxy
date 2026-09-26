import { Injectable } from "@nestjs/common";

// Overridable so the e2e suite can pin "now" and assert calendar windows exactly.
@Injectable()
export class AnalyticsClock {
  now(): Date {
    return new Date();
  }
}
