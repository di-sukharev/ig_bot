import { Database, type SQLQueryBindings } from "bun:sqlite";

export class SqliteD1 {
  private readonly db = new Database(":memory:");

  exec(sql: string) {
    this.db.exec(sql);
  }

  first<T>(sql: string, ...args: SQLQueryBindings[]): T | null {
    return this.db.query<T, SQLQueryBindings[]>(sql).get(...args);
  }

  run(sql: string, ...args: SQLQueryBindings[]) {
    return this.db.query(sql).run(...args);
  }

  prepare(sql: string) {
    const statement = this.db.prepare(sql);
    return {
      bind: (...args: SQLQueryBindings[]) => ({
        all: async () => ({ results: statement.all(...args) }),
        raw: async () => statement.values(...args),
        run: async () => {
          const result = statement.run(...args);
          return { meta: { changes: result.changes } };
        },
      }),
    };
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.db.exec("COMMIT;");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
}

export async function migratedD1(): Promise<D1Database> {
  const db = new SqliteD1();
  for (const path of Array.from(new Bun.Glob("migrations/*.sql").scanSync(".")).sort()) {
    db.exec(await Bun.file(path).text());
  }
  return db as unknown as D1Database;
}
