import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Configuration } from "../src/configuration.js";
import { EventBuilder } from "../src/eventBuilder.js";
import { findIn, mask, objects, withSql } from "../src/sqlStatement.js";

describe("sqlStatement.findIn", () => {
  it("reads .sql or .query off the error", () => {
    assert.equal(findIn(Object.assign(new Error("boom"), { sql: "SELECT 1" })), "SELECT 1");
    assert.equal(findIn(Object.assign(new Error("boom"), { query: "SELECT 2" })), "SELECT 2");
  });

  it("follows .cause and Sequelize's .parent/.original", () => {
    const inner = Object.assign(new Error("db"), { sql: "CALL refund_order(1)" });
    assert.equal(findIn(new Error("refund failed", { cause: inner })), "CALL refund_order(1)");
    assert.equal(findIn(Object.assign(new Error("seq"), { parent: inner })), "CALL refund_order(1)");
    assert.equal(findIn(Object.assign(new Error("seq"), { original: inner })), "CALL refund_order(1)");
  });

  it("ignores a non-string property and returns null without SQL", () => {
    assert.equal(findIn(Object.assign(new Error("x"), { query: { text: "SELECT 1" } })), null);
    assert.equal(findIn(new Error("nope")), null);
    assert.equal(findIn(null), null);
  });
});

describe("sqlStatement.mask", () => {
  it("replaces strings and numbers, leaving identifiers and placeholders", () => {
    assert.equal(
      mask("SELECT * FROM orders2 WHERE email = 'a@b.co' AND id = 42 AND x = $1"),
      "SELECT * FROM orders2 WHERE email = ? AND id = ? AND x = $1",
    );
    assert.equal(mask("SELECT price * 1.5 FROM t WHERE a IN (1,2,3)"), "SELECT price * ? FROM t WHERE a IN (?,?,?)");
  });

  it("handles an escaped quote, a cut-off string and a dollar-quoted body", () => {
    assert.equal(mask("EXEC sp_x @t = 'it''s'"), "EXEC sp_x @t = ?");
    assert.equal(mask("SELECT 1 WHERE n = 'oops"), "SELECT ? WHERE n = ?");
    assert.equal(mask("DO $b$ BEGIN PERFORM 1; END $b$"), "DO ?");
  });

  it("is idempotent and truncates", () => {
    const once = mask("SELECT * FROM t WHERE a = 'x' AND b = 9");
    assert.equal(mask(once), once);
    assert.equal(mask(`SELECT ${"a, ".repeat(3000)} b`).length, 4003);
  });

  it("returns null for a blank statement", () => {
    assert.equal(mask("  "), null);
    assert.equal(mask(undefined), null);
  });
});

// The server's own masking cases (app/services/sql_statement_masker.rb): [statement, db.system,
// what the server stores]. The masked statement here has to match it exactly.
const SERVER_CASES = [
  ["SELECT * FROM orders WHERE email = 'a@b.co' AND id = 42 LIMIT 10", null, "SELECT * FROM orders WHERE email = ? AND id = ? LIMIT ?"],
  ["EXEC sp_note @text = 'it''s broken'", null, "EXEC sp_note @text = ?"],
  ["SELECT 1 WHERE name = 'unterminated", null, "SELECT ? WHERE name = ?"],
  ["DO $body$ BEGIN PERFORM 1; END $body$", null, "DO ?"],
  ["SELECT \"user id\" FROM orders2 WHERE id = $1 AND v = sp_v2(?)", null, "SELECT \"user id\" FROM orders2 WHERE id = $1 AND v = sp_v2(?)"],
  ["SELECT price * 1.5 FROM t", null, "SELECT price * ? FROM t"],
  ["SELECT * FROM users WHERE name = E'o\\'brien' AND id = 1", null, "SELECT * FROM users WHERE name = ? AND id = ?"],
  ["SELECT * FROM users WHERE name = 'o\\'brien' AND id = 1", null, "SELECT * FROM users WHERE name = ? AND id = ?"],
  ["SELECT * FROM t WHERE b = X'DEADBEEF' AND s = N'uni' AND u = U&'d\\0061t' AND e = e'x'", null, "SELECT * FROM t WHERE b = ? AND s = ? AND u = ? AND e = ?"],
  ["SELECT * FROM t WHERE a LIKE'%secret%'", null, "SELECT * FROM t WHERE a LIKE?"],
  ["SELECT * FROM t WHERE f = 0x1F AND b = 0b101 AND n = 3e10 AND m = 1.5E-3 AND k = .5", null, "SELECT * FROM t WHERE f = ? AND b = ? AND n = ? AND m = ? AND k = ?"],
  ["SELECT e, t.col, 1e5e FROM t", null, "SELECT e, t.col, 1e5e FROM t"],
  ["SELECT \"user id\" FROM t WHERE token = \"abc123secret\"", "mysql", "SELECT ? FROM t WHERE token = ?"],
  ["SELECT \"user id\" FROM t WHERE token = \"abc123secret\"", "MariaDB", "SELECT ? FROM t WHERE token = ?"],
  ["SELECT \"user id\" FROM t WHERE token = \"abc123secret\"", "postgresql", "SELECT \"user id\" FROM t WHERE token = \"abc123secret\""],
  ["SELECT \"user id\" FROM t WHERE token = \"abc123secret\"", null, "SELECT \"user id\" FROM t WHERE token = \"abc123secret\""],
  ["SELECT * FROM t WHERE a = 'x' AND b = 9", null, "SELECT * FROM t WHERE a = ? AND b = ?"],
  ["SELECT * FROM t WHERE a = ? AND b = ?", null, "SELECT * FROM t WHERE a = ? AND b = ?"],
  ["SELECT * FROM t WHERE path = 'C:\\\\dir\\\\' AND n = 5", null, "SELECT * FROM t WHERE path = ? AND n = ?"],
  ["INSERT INTO t (a, b) VALUES (-5, +3.25e+2)", null, "INSERT INTO t (a, b) VALUES (-?, +?)"],
  ["SELECT * FROM t WHERE a = 'secret\\", null, "SELECT * FROM t WHERE a = ?"],
  ["SELECT * FROM t WHERE a = \"secret\\", "mysql", "SELECT * FROM t WHERE a = ?"],
];

describe("sqlStatement.mask matches the server", () => {
  for (const [statement, system, expected] of SERVER_CASES) {
    it(`${JSON.stringify(statement)}${system ? ` (${system})` : ""}`, () => {
      assert.equal(mask(statement, system), expected);
      assert.equal(mask(expected, system), expected);
    });
  }

  it("masks backslash escapes, type prefixes, and every kind of number", () => {
    assert.equal(mask("SELECT 'a\\'b' || 'c'"), "SELECT ? || ?");
    assert.equal(mask("SELECT B'1010', b'1', n'x', u&'y'"), "SELECT ?, ?, ?, ?");
    assert.equal(mask("SELECT typeX'1', a1e+5"), "SELECT typeX?, a1e+?");
    assert.equal(mask("SELECT 0X1f, 0B11, 1E5, .25e-1 FROM t"), "SELECT ?, ?, ?, ? FROM t");
    assert.equal(mask("SELECT 'a'5"), "SELECT ??");
  });

  it("masks double quotes only for mysql and mariadb, whatever the case", () => {
    assert.equal(mask('SELECT "a\\"b"', "MySQL"), "SELECT ?");
    assert.equal(mask('SELECT "a""b"', "mariadb"), "SELECT ?");
    assert.equal(mask('SELECT "a"', "sqlite"), 'SELECT "a"');
    assert.equal(mask('SELECT "a"'), 'SELECT "a"');
  });
});

describe("sqlStatement.objects", () => {
  it("finds a stored procedure with its schema", () => {
    assert.deepEqual(objects("EXEC dbo.sp_refund_order @id = ?"), { operation: "EXEC", procedures: ["dbo.sp_refund_order"], relations: [] });
    assert.deepEqual(objects("CALL refund_order(?, ?)").procedures, ["refund_order"]);
    assert.deepEqual(objects("SELECT refund_order(?, ?)").procedures, ["refund_order"]);
  });

  it("finds views, joined tables and table functions", () => {
    assert.deepEqual(objects("SELECT * FROM v_totals t JOIN public.customers c ON c.id = t.id").relations, ["v_totals", "public.customers"]);
    assert.deepEqual(objects("SELECT * FROM get_open_orders(?) o").procedures, ["get_open_orders"]);
  });

  it("does not misread column lists or builtins, and returns null for garbage", () => {
    assert.deepEqual(objects("INSERT INTO audit_log (a) VALUES (?)").procedures, []);
    assert.deepEqual(objects("SELECT count(*) FROM orders").procedures, []);
    assert.equal(objects("garbage"), null);
  });
});

describe("EventBuilder SQL capture", () => {
  const error = Object.assign(new Error("boom"), { sql: "EXEC dbo.sp_refund_order @order_id = 8814, @note = 'a@b.co'" });
  const builder = (overrides = {}) => {
    const config = new Configuration();
    config.environment = "production";
    Object.assign(config, overrides);
    return new EventBuilder(config);
  };

  it("sends the procedure name but not the statement by default", () => {
    const payload = builder().build(error);
    assert.deepEqual(payload.sql_objects.procedures, ["dbo.sp_refund_order"]);
    assert.equal("sql_statement" in payload, false);
  });

  it("sends the masked statement when opted in", () => {
    assert.equal(builder({ captureSqlStatement: true }).build(error).sql_statement, "EXEC dbo.sp_refund_order @order_id = ?, @note = ?");
  });

  it("sends neither when both are off, and nothing for an error with no SQL", () => {
    const off = builder({ captureSqlObjects: false }).build(error);
    assert.equal("sql_objects" in off, false);
    assert.equal("sql_statement" in off, false);
    assert.equal("sql_objects" in builder().build(new Error("nope")), false);
  });
});

describe("withSql", () => {
  it("attaches the statement where findIn reads it, returns the same error, and stays non-enumerable", () => {
    const error = new Error("boom");
    assert.equal(withSql(error, "CALL refund_order(1)"), error);
    assert.equal(findIn(error), "CALL refund_order(1)");
    assert.equal(Object.keys(error).includes("sql"), false);
    assert.equal(JSON.stringify(error).includes("refund_order"), false);
  });
});
