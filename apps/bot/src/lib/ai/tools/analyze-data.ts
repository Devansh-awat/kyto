import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { clipOutput } from '@/lib/sandbox/output-clip';
import { resolvePath, shellQuote } from './workspace-files';

const DEFAULT_ROWS = 200;
const MAX_ROWS = 2000;
const INSTALL_TIMEOUT_SECONDS = 300;
const ERROR_LINES = 3;

// Fixed Python, the model's path, SQL and row cap passed as JSON arguments:
// SQL (DuckDB) has no way to run a program, so this is not a shell, and the
// two shell controls bash carries don't apply. `data` is a VIEW over the file.
const SCRIPT = String.raw`
import json, sys, duckdb
path, sql, limit = json.loads(sys.argv[1]), json.loads(sys.argv[2]), int(sys.argv[3])
lower = path.lower()
con = duckdb.connect()
quoted = "'" + path.replace("'", "''") + "'"
if lower.endswith(('.xlsx', '.xls')):
    con.execute("INSTALL excel; LOAD excel")
    source = "read_xlsx(" + quoted + ")"
elif lower.endswith('.parquet'):
    source = "read_parquet(" + quoted + ")"
elif lower.endswith(('.json', '.jsonl', '.ndjson')):
    source = "read_json_auto(" + quoted + ")"
else:
    source = "read_csv_auto(" + quoted + ")"
con.execute("CREATE VIEW data AS SELECT * FROM " + source)
def show(query, cap):
    cur = con.execute(query)
    cols = [d[0] for d in cur.description]
    rows = cur.fetchmany(cap + 1)
    print("\t".join(cols))
    for row in rows[:cap]:
        print("\t".join("" if v is None else str(v) for v in row))
    if len(rows) > cap:
        print(f"(more rows than the {cap} shown: narrow the query or raise maxRows)")
if sql:
    show(sql, limit)
else:
    total = con.execute("SELECT count(*) FROM data").fetchone()[0]
    print(f"rows: {total}\n\n== columns and stats (SUMMARIZE data) ==")
    show("SUMMARIZE data", 500)
    print("\n== first 5 rows ==")
    show("SELECT * FROM data LIMIT 5", 5)
`;

export function analyzeDataTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      "Analyze a data file in the sandbox (CSV/TSV, Excel, Parquet, JSON lines) with SQL, using DuckDB: the file is the table `data`. Without `sql`: its row count, every column with type and stats (min, max, nulls, distinct, mean), and the first rows. With `sql`: that query's result, tab-separated. For counting, grouping, joining, filtering or averaging a file, prefer this over reading it or writing a script. An attachment is already in the sandbox (its path is in the message).",
    inputSchema: z.object({
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(MAX_ROWS)
        .optional()
        .describe(`Rows of the result to return (default ${DEFAULT_ROWS}).`),
      path: z.string().min(1),
      sql: z
        .string()
        .optional()
        .describe(
          'DuckDB SQL over the table `data`, e.g. `SELECT country, count(*) FROM data GROUP BY 1 ORDER BY 2 DESC`.'
        ),
    }),
    execute: async ({ maxRows = DEFAULT_ROWS, path, sql }, { abortSignal }) => {
      const context = getSandboxContext();
      const resolved = resolvePath(context, path);
      // Installed on first use; the sandbox keeps it for the thread.
      const ensure = `python3 -c 'import duckdb' 2>/dev/null || timeout ${INSTALL_TIMEOUT_SECONDS} python3 -m pip install --break-system-packages --quiet duckdb >/dev/null 2>&1`;
      const run = `python3 -c ${shellQuote(SCRIPT)} ${shellQuote(JSON.stringify(resolved))} ${shellQuote(JSON.stringify(sql ?? ''))} ${maxRows}`;
      const result = await context.session.run({
        abortSignal,
        command: `${ensure}; ${run}`,
        workingDirectory: context.sessionWorkDir,
      });
      if (result.exitCode !== 0) {
        return {
          // A Python traceback's last lines are DuckDB's own message.
          error:
            (result.stderr.trim() || result.stdout.trim())
              .split('\n')
              .slice(-ERROR_LINES)
              .join('\n') || `DuckDB exited with ${result.exitCode}.`,
          success: false,
        };
      }
      return { result: clipOutput(result.stdout).text, success: true };
    },
  });
}
