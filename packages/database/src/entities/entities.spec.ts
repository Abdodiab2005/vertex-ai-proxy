import "reflect-metadata";
import { DataSource } from "typeorm";
import { Alert, entities, KeyPreset, ModelAlias } from "./index";

describe("entities", () => {
  it("registers every entity, including model aliases", () => {
    expect(entities).toContain(ModelAlias);
    expect(entities).toContain(KeyPreset);
    expect(entities).toContain(Alert);
    expect(entities).toHaveLength(16);
  });

  it("builds a valid TypeORM DataSource without connecting", () => {
    const dataSource = new DataSource({
      type: "postgres",
      host: "localhost",
      port: 5432,
      username: "test",
      password: "test",
      database: "test",
      entities,
    });
    expect(dataSource.options.entities).toHaveLength(16);
  });
});
