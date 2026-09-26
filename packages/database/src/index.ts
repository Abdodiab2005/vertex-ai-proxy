export * from "./config";
export * from "./entities";

// AppDataSource (./data-source) is deliberately NOT re-exported here. It
// eagerly constructs a real DataSource — and therefore validates the full DB
// env — at import time, which is correct for the TypeORM CLI (which loads
// that file directly by path) but wrong for this barrel: anything importing
// @gateway/database for entities/config alone would be forced to have a
// valid DB_PASSWORD etc. just to load types. Import "./data-source" directly
// if you specifically need the shared singleton.
