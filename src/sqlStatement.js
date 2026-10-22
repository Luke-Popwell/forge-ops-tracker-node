// Finds the SQL behind a database error and reduces it to something safe to send: the names of
// the stored procedures, tables and views it touched, and (only if configuration.
// captureSqlStatement is on) the statement itself with every string and number replaced by "?".
// Ported from gems/forge_ops_tracker's SqlStatement, which is itself ported from the server's own
// SqlStatementMasker/SqlObjectExtractor: same rules everywhere, and the server applies them again
// on arrival, so a difference here can only ever mean less is masked client-side, never that
// something unmasked gets stored.
//
// Deliberately a single pass over a few patterns, not a SQL parser. No regex lookbehind either:
// the same source is shared with the browser and React Native SDKs, where an older engine would
// fail to even parse one, so mask() checks the character before each match itself, and moves on
// one character when it doesn't count, exactly as the server's lookbehind would.

const MASK = "?";
const MAX_LENGTH = 4000;
const MAX_NAMES = 10;
const MAX_NAME_LENGTH = 200;
const MAX_CAUSE_DEPTH = 5;

// db.system values where "double quotes" are a string, not a name.
const DOUBLE_QUOTED_STRING_SYSTEMS = new Set(["mysql", "mariadb"]);

// A 'single quoted' string, '' and backslash escapes included, with its type prefix (E'', X'',
// N'', B'', U&''; group 1), or one cut off by truncation (masked to the end), even right after a
// backslash ('secret\ is still a string).
const STRING = String.raw`((?:[EeXxNnBb]|[Uu]&)?)'(?:[^'\\]|\\(?:[\s\S]|$)|'')*(?:'|$)`;
const DOUBLE_QUOTED_STRING = String.raw`"(?:[^"\\]|\\(?:[\s\S]|$)|"")*(?:"|$)`;
// A $tag$ dollar-quoted string (group 2 is the tag).
const DOLLAR_QUOTED = String.raw`(\$[A-Za-z_]*\$)[\s\S]*?(?:\2|$)`;
// Hex, binary, integer, decimal, leading-dot decimal, each with an optional exponent (group 3).
const NUMBER = String.raw`(0[xX][0-9A-Fa-f]+|0[bB][01]+|(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)(?!\w)`;
const LITERAL = new RegExp(`${STRING}|${DOLLAR_QUOTED}|${NUMBER}`, "g");
const LITERAL_WITH_DOUBLE_QUOTES = new RegExp(`${STRING}|${DOUBLE_QUOTED_STRING}|${DOLLAR_QUOTED}|${NUMBER}`, "g");
// What may not come right before a string's type prefix, or before a number: the end of a word,
// a $1 placeholder, or (for a number) a decimal point.
const WORD_END = /[\w$]/;
const NUMBER_PREFIX = /[\w$.]/;

const PART = '(?:[\\w$#@]+|"[^"]+"|\\[[^\\]]+\\]|`[^`]+`)';
const NAME = `${PART}(?:\\.${PART})*`;
const OPERATIONS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "WITH", "CALL", "EXEC", "EXECUTE", "CREATE", "ALTER", "DROP", "TRUNCATE"]);
const PROCEDURE_CALL = new RegExp(`\\b(?:CALL|EXEC(?:UTE)?|PERFORM)\\s+(?!IMMEDIATE\\b|FUNCTION\\b|PROCEDURE\\b)(${NAME})`, "gi");
const RELATION = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE|TABLE)\\s+(${NAME})(\\s*\\()?`, "gi");
const SELECT_FUNCTION = new RegExp(`^\\s*SELECT\\s+(${NAME})\\s*\\(`, "i");
const BUILTINS = new Set([
  "count", "sum", "min", "max", "avg", "now", "coalesce", "nullif", "lower", "upper", "length", "concat",
  "cast", "date_trunc", "current_timestamp", "current_date", "row_number", "rank", "json_build_object",
  "json_agg", "array_agg",
]);
const FROM_INSIDE_FUNCTION = /\b(?:EXTRACT|SUBSTRING|TRIM|OVERLAY)\s*\([^()]*\)/gi;
const KEYWORDS_NOT_NAMES = new Set(["select", "set", "values", "where", "lateral", "only", "unnest", "generate_series"]);
const FULL_NAME = new RegExp(`^${NAME}$`);
const FROM_WORD = /\bFROM\b/i;

// Properties that carry the statement on the errors Node database libraries raise: Sequelize and
// mysql2 use .sql (Sequelize also nests the driver's own error under .parent/.original), TypeORM's
// QueryFailedError uses .query. Only a string counts, never an object that happens to share the
// name (a Sequelize query builder, say).
const STATEMENT_PROPERTIES = ["sql", "query"];

/**
 * The raw statement off the error itself or, for an app that wraps a database error in its own
 * exception, off whatever it was raised from (.cause, or Sequelize's .parent/.original).
 * @param {unknown} error
 * @returns {string | null}
 */
export function findIn(error) {
  const seen = new Set();
  const queue = [error];
  let depth = 0;
  while (queue.length > 0 && depth < MAX_CAUSE_DEPTH * 3) {
    const current = queue.shift();
    depth += 1;
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const property of STATEMENT_PROPERTIES) {
      const value = current[property];
      if (typeof value === "string" && value.trim() !== "") {
        return value;
      }
    }
    queue.push(current.cause, current.parent, current.original);
  }
  return null;
}

/**
 * Every string and number replaced by "?". `system` is the db.system the statement ran against,
 * when known: for MySQL and MariaDB, "double quoted" text is a string there and masked too.
 *
 * @param {string | null | undefined} statement
 * @param {string | null} [system]
 * @returns {string | null}
 */
export function mask(statement, system = null) {
  if (typeof statement !== "string" || statement.trim() === "") {
    return null;
  }
  const pattern = new RegExp(DOUBLE_QUOTED_STRING_SYSTEMS.has(String(system ?? "").toLowerCase()) ? LITERAL_WITH_DOUBLE_QUOTES : LITERAL);
  let masked = "";
  let emitted = 0;
  let match;
  while ((match = pattern.exec(statement)) !== null) {
    const before = statement[match.index - 1] ?? "";
    const prefixed = match[1] !== undefined && match[1] !== "" && WORD_END.test(before);
    if (prefixed || (match[3] !== undefined && NUMBER_PREFIX.test(before))) {
      // Not a match where it starts: try again from the next character, the way a lookbehind
      // failing there would. A prefix that's the end of a word stays, and the quote after it
      // still starts a string (LIKE'%x%' masks to LIKE?).
      pattern.lastIndex = match.index + 1;
      continue;
    }
    masked += statement.slice(emitted, match.index) + MASK;
    emitted = pattern.lastIndex;
  }
  masked += statement.slice(emitted);
  return masked.length > MAX_LENGTH ? `${masked.slice(0, MAX_LENGTH)}...` : masked;
}

/**
 * Takes an already-masked statement (so a keyword inside a string value can't be mistaken for
 * SQL). Returns null when nothing recognizable was found.
 * @param {string | null} masked
 * @returns {{ operation?: string, procedures: string[], relations: string[] } | null}
 */
export function objects(masked) {
  if (typeof masked !== "string" || masked.trim() === "") {
    return null;
  }

  const sql = masked.replace(FROM_INSIDE_FUNCTION, " ");
  const procedures = [...sql.matchAll(PROCEDURE_CALL)].map((m) => m[1]);
  const relations = [];

  for (const [, keyword, name, paren] of sql.matchAll(RELATION)) {
    if (KEYWORDS_NOT_NAMES.has(name.toLowerCase())) {
      continue;
    }
    const functionCall = Boolean(paren) && ["FROM", "JOIN"].includes(keyword.toUpperCase());
    (functionCall ? procedures : relations).push(name);
  }

  const fn = SELECT_FUNCTION.exec(sql)?.[1];
  if (fn && !BUILTINS.has(fn.toLowerCase()) && !FROM_WORD.test(sql)) {
    procedures.push(fn);
  }

  const operation = (/^\s*(\w+)/.exec(sql)?.[1] ?? "").toUpperCase();
  const result = {};
  if (OPERATIONS.has(operation)) {
    result.operation = operation;
  }
  result.procedures = clean(procedures);
  result.relations = clean(relations);
  if (result.procedures.length === 0 && result.relations.length === 0 && !("operation" in result)) {
    return null;
  }
  return result;
}

function clean(names) {
  const cleaned = [];
  for (const raw of names) {
    const name = raw.trim().slice(0, MAX_NAME_LENGTH);
    if (FULL_NAME.test(name) && !cleaned.includes(name)) {
      cleaned.push(name);
    }
  }
  return cleaned.slice(0, MAX_NAMES);
}

/**
 * Attaches the SQL statement that caused `error` to it and returns the same error, so the code
 * that ran the query can hand it over where the reporter finds it with no extra call. Use it when
 * the database library's own errors don't carry the statement (node-postgres, better-sqlite3 and
 * Prisma don't):
 *
 *     try { await pool.query(sql, params); }
 *     catch (error) { throw withSql(error, sql); }
 *
 * Only the names of the stored procedure, table and view are sent by default, and the statement
 * itself only with `captureSqlStatement` on, with every string and number replaced by "?" first;
 * the raw statement never leaves the process. Non-enumerable, so it doesn't show up when the error
 * is logged or serialized.
 * @template {object} E
 * @param {E} error
 * @param {string} statement
 * @returns {E}
 */
export function withSql(error, statement) {
  Object.defineProperty(error, "sql", { value: statement, enumerable: false, configurable: true, writable: true });
  return error;
}
