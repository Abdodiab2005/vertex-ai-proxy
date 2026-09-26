import { Injectable } from "@nestjs/common";
import { ApiEnv, loadApiEnv } from "./env.js";

@Injectable()
export class ConfigService {
  readonly env: ApiEnv;

  constructor() {
    this.env = loadApiEnv();
  }
}
