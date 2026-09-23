#!/usr/bin/env node
// Decide how scripts/prod-psql.sh may run a SQL file or probe against prod.
//
// The wrapper wants every guard to be TRANSACTION-scoped (SET LOCAL inside one
// transaction), because a transaction-scoped setting dies with the transaction
// on any pooler. Whether a session-level SET outlives the client on Supavisor's
// session pooler is unverified, so the wrapper does not rely on it. A file can
// only run inside one transaction if nothing in it forbids that, so this reads
// the file's top-level statements (skipping comments, quoted strings and
// dollar-quoted function bodies) and answers one of:
//
//   transaction           safe to wrap in one transaction with SET LOCAL
//   session <reason>      contains a statement Postgres refuses inside a
//                         transaction block (CREATE INDEX CONCURRENTLY, VACUUM,
//                         ...), or manages its own transactions in a way that
//                         would end ours partway; needs the session fallback
//   refuse <reason>       contains something the wrapper will not run at all
//                         (a psql meta-command such as \connect)
//
// With --probe, the input is read-only probe SQL, and anything that is not
// plain transactional SQL is refused: a COMMIT inside a probe would end the
// READ ONLY transaction and let the rest of the probe write.
//
// Usage:  node prod-psql-classify.mjs [--probe] FILE      (FILE "-" = stdin)
// Prints the verdict on stdout. Exit 0 = transaction, 3 = session, 4 = refuse.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Split SQL into top-level statements. Returns [{ text, meta }], where text is
 * the statement with comments removed and every string or quoted identifier
 * replaced by a placeholder, so keyword tests cannot match inside them.
 */
export function splitStatements(sql) {
  const out = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  let atLineStart = true;

  const push = () => {
    if (cur.trim()) out.push({ text: cur.trim(), meta: false });
    cur = "";
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // psql meta-command: a backslash that starts a line, outside any statement.
    if (c === "\\" && atLineStart && !cur.trim()) {
      const end = sql.indexOf("\n", i);
      const line = sql.slice(i, end === -1 ? n : end);
      out.push({ text: line.trim(), meta: true });
      i = end === -1 ? n : end + 1;
      continue;
    }

    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      // Postgres block comments nest.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      cur += " ";
      continue;
    }
    if (c === "'") {
      // E'...' strings allow backslash escapes; standard ones only ''.
      const escaped = /[eE]$/.test(cur) && !/[A-Za-z0-9_][eE]$/.test(cur);
      i++;
      while (i < n) {
        if (escaped && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      cur += "'s'";
      atLineStart = false;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      cur += '"i"';
      atLineStart = false;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      // A $ after an identifier character is part of the identifier ($1 is a
      // parameter), not the start of a dollar quote.
      if (m && !/[A-Za-z0-9_]$/.test(cur)) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        cur += "$body$";
        atLineStart = false;
        continue;
      }
    }
    if (c === ";") {
      // CREATE FUNCTION ... BEGIN ATOMIC ... END has semicolons in its body.
      if (/\bBEGIN\s+ATOMIC\b/i.test(cur) && !/\bEND\s*$/i.test(cur.trim())) {
        cur += c;
        i++;
        continue;
      }
      push();
      i++;
      atLineStart = false;
      continue;
    }

    cur += c;
    if (c === "\n") atLineStart = true;
    else if (!/\s/.test(c)) atLineStart = false;
    i++;
  }
  push();
  return out;
}

const words = (text) => text.toUpperCase().replace(/\s+/g, " ").trim();

// Statements Postgres refuses inside a transaction block, plus ALTER TYPE ...
// ADD VALUE, which is allowed there but whose new value cannot be used until
// the transaction commits. Applying such a file in one transaction would fail
// where the old autocommit path succeeded, so it keeps the old shape.
const NON_TRANSACTIONAL = [
  [/^CREATE (UNIQUE )?INDEX CONCURRENTLY\b/, "CREATE INDEX CONCURRENTLY"],
  [/^DROP INDEX CONCURRENTLY\b/, "DROP INDEX CONCURRENTLY"],
  [/^REINDEX\b.*\bCONCURRENTLY\b/, "REINDEX CONCURRENTLY"],
  [/^REINDEX (\(.*\) )?(SYSTEM|DATABASE)\b/, "REINDEX SYSTEM/DATABASE"],
  [/^VACUUM\b/, "VACUUM"],
  [/^(CREATE|DROP) DATABASE\b/, "CREATE/DROP DATABASE"],
  [/^(CREATE|DROP) TABLESPACE\b/, "CREATE/DROP TABLESPACE"],
  [/^ALTER SYSTEM\b/, "ALTER SYSTEM"],
  [/^(CREATE|ALTER|DROP) SUBSCRIPTION\b/, "SUBSCRIPTION DDL"],
  [/^ALTER TYPE\b.*\bADD VALUE\b/, "ALTER TYPE ... ADD VALUE"],
];

const TXN_OPEN = /^(BEGIN|START TRANSACTION)\b/;
const TXN_CLOSE = /^(COMMIT|END)\b(?! PREPARED)/;
// ROLLBACK TO [SAVEPOINT] is fine inside a transaction; a bare ROLLBACK is not.
const TXN_OTHER = /^(ROLLBACK(?! TO\b)|ABORT|PREPARE TRANSACTION|COMMIT PREPARED|ROLLBACK PREPARED)\b/;

/**
 * Classify SQL for the wrapper. Returns { verdict, reason } where verdict is
 * "transaction", "session" or "refuse".
 */
export function classify(sql, { probe = false } = {}) {
  const stmts = splitStatements(sql);
  if (stmts.length === 0) return { verdict: "refuse", reason: "no SQL statements found" };

  const meta = stmts.find((s) => s.meta);
  if (meta) {
    return {
      verdict: "refuse",
      reason: `psql meta-command ${JSON.stringify(meta.text.split(/\s/)[0])}: a \\connect or \\set there would silently undo the guards`,
    };
  }

  const heads = stmts.map((s) => words(s.text));
  const nonTxn = [];
  for (const h of heads) {
    for (const [re, label] of NON_TRANSACTIONAL) if (re.test(h)) nonTxn.push(label);
  }

  const opens = heads.map((h, i) => (TXN_OPEN.test(h) ? i : -1)).filter((i) => i >= 0);
  const closes = heads.map((h, i) => (TXN_CLOSE.test(h) ? i : -1)).filter((i) => i >= 0);
  const others = heads.filter((h) => TXN_OTHER.test(h));
  const hasTxnControl = opens.length + closes.length + others.length > 0;

  if (probe) {
    if (hasTxnControl) {
      return { verdict: "refuse", reason: "transaction control in a probe would end the READ ONLY transaction" };
    }
    if (nonTxn.length) return { verdict: "refuse", reason: `${nonTxn[0]} is not a read-only probe` };
    return { verdict: "transaction", reason: "" };
  }

  if (nonTxn.length) {
    return { verdict: "session", reason: `${[...new Set(nonTxn)].join(", ")} cannot run inside a transaction block` };
  }

  if (hasTxnControl) {
    // The one shape that still fits inside our transaction: the whole file is
    // a single BEGIN ... COMMIT. Its BEGIN only warns ("already a transaction in
    // progress") and its COMMIT is the last statement, so every statement runs
    // under our SET LOCAL. Anything else would commit our transaction partway
    // and run the rest under the role's default timeout.
    const wrapped =
      others.length === 0 &&
      opens.length === 1 &&
      closes.length === 1 &&
      opens[0] === 0 &&
      closes[0] === heads.length - 1;
    if (!wrapped) {
      return { verdict: "session", reason: "the file manages its own transactions (BEGIN/COMMIT/ROLLBACK mid-file)" };
    }
  }
  return { verdict: "transaction", reason: "" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const probe = args[0] === "--probe";
  const file = probe ? args[1] : args[0];
  if (!file) {
    console.error("usage: prod-psql-classify.mjs [--probe] FILE");
    process.exit(2);
  }
  const sql = readFileSync(file === "-" ? 0 : file, "utf8");
  const { verdict, reason } = classify(sql, { probe });
  console.log(reason ? `${verdict} ${reason}` : verdict);
  process.exit({ transaction: 0, session: 3, refuse: 4 }[verdict]);
}
