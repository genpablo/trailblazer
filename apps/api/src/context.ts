import type { Db } from "@traiblazer/db";
import type { AppConfig } from "./config.js";

export interface AppContext {
  db: Db;
  config: AppConfig;
}
