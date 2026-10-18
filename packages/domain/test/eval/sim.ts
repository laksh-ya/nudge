/**
 * A small in-memory stand-in for the Convex runtime, so the eval can run the backend's real
 * functions (gateway, assistant, chain actions, vault mutations) without a deployment.
 *
 * - The database keeps tables in memory and supports what the backend uses: get, insert, patch,
 *   delete, normalizeId, and query().withIndex(eq/gte/lte...).order().take/first/unique/collect.
 * - runQuery / runMutation / runAction call the registered function's handler directly, looked up
 *   from the function reference (`internal.vault.onAgentResult` -> vault.ts export onAgentResult).
 * - The scheduler and the relayer workpool put jobs on a queue; `drain()` runs them in time order.
 *
 * Not modelled: transactions and retries (mutations apply directly), argument validation,
 * per-function limits. Everything runs in one process.
 */
type Doc = Record<string, any> & { _id: string; _creationTime: number };
type Fn = { _handler: (ctx: any, args: any) => Promise<any>; isAction?: boolean; isMutation?: boolean; isQuery?: boolean };

const FUNCTION_NAME = Symbol.for("functionName");
const modules = import.meta.glob("../../../backend/convex/**/*.ts");

/** "vault:onAgentResult" from a function reference built by Convex's anyApi. */
export function nameOf(ref: unknown): string {
  const name = (ref as Record<symbol, string>)[FUNCTION_NAME];
  if (typeof name !== "string") throw new Error("Not a Convex function reference");
  return name;
}

async function resolve(ref: unknown): Promise<{ name: string; fn: Fn }> {
  const name = nameOf(ref);
  const [path, exportName] = name.split(":") as [string, string];
  const load = modules[`../../../backend/convex/${path}.ts`];
  if (!load) throw new Error(`No module for ${name}`);
  const mod = (await load()) as Record<string, Fn>;
  const fn = mod[exportName ?? "default"];
  if (!fn?._handler) throw new Error(`No function ${name}`);
  return { name, fn };
}

export type Job = { at: number; ref: unknown; args: Record<string, unknown>; name: string };

export class Sim {
  tables: Record<string, Doc[]> = {};
  jobs: Job[] = [];
  /** Jobs that ran, in order, with their outcome. */
  ran: { name: string; error?: string }[] = [];
  identity: { tokenIdentifier: string } | null = null;
  /** Function names whose jobs are dropped instead of run (outbound messages, polling loops). */
  skip = new Set<string>(["telegram:send", "chain:syncVault"]);
  private seq = 0;

  constructor(seed: Record<string, (Record<string, any> & { _id: string })[]> = {}) {
    for (const [table, docs] of Object.entries(seed)) this.tables[table] = docs.map((d) => ({ _creationTime: Date.now(), ...d }));
  }

  private all() {
    return Object.values(this.tables).flat();
  }

  get db() {
    const self = this;
    return {
      get: async (id: string) => self.all().find((d) => d._id === id) ?? null,
      normalizeId: (table: string, id: string) => ((self.tables[table] ?? []).some((d) => d._id === id) ? id : null),
      insert: async (table: string, doc: Record<string, unknown>) => {
        // Seeded rows use hand-picked ids (payees_2, ...): never hand out one that's taken.
        const taken = new Set((self.tables[table] ?? []).map((d) => d._id));
        let id = `${table}_${++self.seq}`;
        while (taken.has(id)) id = `${table}_${++self.seq}`;
        (self.tables[table] ??= []).push({ ...doc, _id: id, _creationTime: Date.now() + self.seq / 1000 });
        return id;
      },
      patch: async (id: string, patch: Record<string, unknown>) => {
        const doc = self.all().find((d) => d._id === id);
        if (!doc) throw new Error(`patch: no document ${id}`);
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete doc[k];
          else doc[k] = v;
        }
      },
      replace: async (id: string, value: Record<string, unknown>) => {
        const doc = self.all().find((d) => d._id === id);
        if (!doc) throw new Error(`replace: no document ${id}`);
        for (const k of Object.keys(doc)) if (!k.startsWith("_")) delete doc[k];
        Object.assign(doc, value);
      },
      delete: async (id: string) => {
        for (const t of Object.values(self.tables)) {
          const i = t.findIndex((d) => d._id === id);
          if (i >= 0) t.splice(i, 1);
        }
      },
      query: (table: string) => {
        let rows = [...(self.tables[table] ?? [])];
        const range: Record<string, unknown> = {};
        const f = {
          eq: (k: string, v: unknown) => ((rows = rows.filter((d) => d[k] === v)), f),
          gte: (k: string, v: any) => ((rows = rows.filter((d) => d[k] >= v)), f),
          gt: (k: string, v: any) => ((rows = rows.filter((d) => d[k] > v)), f),
          lte: (k: string, v: any) => ((rows = rows.filter((d) => d[k] <= v)), f),
          lt: (k: string, v: any) => ((rows = rows.filter((d) => d[k] < v)), f),
        };
        void range;
        const q = {
          withIndex: (_name: string, cb?: (x: typeof f) => unknown) => (cb?.(f), q),
          order: (dir: "asc" | "desc") => ((rows = [...rows].sort((a, b) => a._creationTime - b._creationTime)), dir === "desc" && rows.reverse(), q),
          filter: () => q,
          take: async (n: number) => rows.slice(0, n),
          collect: async () => rows,
          first: async () => rows[0] ?? null,
          unique: async () => {
            if (rows.length > 1) throw new Error(`unique: ${rows.length} rows in ${table}`);
            return rows[0] ?? null;
          },
          // `for await (const row of ctx.db.query(...))`, as lib/overview.ts reads on main.
          [Symbol.asyncIterator]: async function* () {
            yield* rows;
          },
        };
        return q;
      },
    };
  }

  private scheduler() {
    return {
      runAfter: async (delay: number, ref: unknown, args: Record<string, unknown>) => this.enqueue(ref, args, Date.now() + delay),
      runAt: async (at: number, ref: unknown, args: Record<string, unknown>) => this.enqueue(ref, args, at),
      cancel: async () => {},
    };
  }

  enqueue(ref: unknown, args: Record<string, unknown>, at = Date.now()) {
    this.jobs.push({ at, ref, args, name: nameOf(ref) });
    return `job_${++this.seq}`;
  }

  /** A query or mutation context (mutations get a scheduler). */
  ctx() {
    const auth = { getUserIdentity: async () => this.identity };
    return { db: this.db, auth, scheduler: this.scheduler() };
  }

  /** An action context: everything goes back through this simulator. */
  actionCtx() {
    return {
      auth: { getUserIdentity: async () => this.identity },
      scheduler: this.scheduler(),
      runQuery: (ref: unknown, args: Record<string, unknown> = {}) => this.run(ref, args),
      runMutation: (ref: unknown, args: Record<string, unknown> = {}) => this.run(ref, args),
      runAction: (ref: unknown, args: Record<string, unknown> = {}) => this.run(ref, args),
    };
  }

  async run<T = any>(ref: unknown, args: Record<string, unknown> = {}): Promise<T> {
    const { fn } = await resolve(ref);
    return (await fn._handler(fn.isAction ? this.actionCtx() : this.ctx(), args)) as T;
  }

  /**
   * Run queued jobs in time order until none are left (or `max` have run). `beforeJob` lets the
   * caller move a chain's clock forward to the job's time; `serial` wraps jobs that send
   * transactions so concurrent simulators never share a nonce.
   */
  async drain(opts: { max?: number; beforeJob?: (job: Job) => Promise<void>; serial?: <T>(f: () => Promise<T>) => Promise<T>; only?: (job: Job) => boolean } = {}) {
    const max = opts.max ?? 200;
    let n = 0;
    while (this.jobs.length && n < max) {
      this.jobs.sort((a, b) => a.at - b.at);
      const i = opts.only ? this.jobs.findIndex(opts.only) : 0;
      if (i < 0) break;
      const [job] = this.jobs.splice(i, 1) as [Job];
      n++;
      if (this.skip.has(job.name)) continue;
      try {
        await opts.beforeJob?.(job);
        const exec = () => this.run(job.ref, job.args);
        await (job.name.startsWith("chain:") && opts.serial ? opts.serial(exec) : exec());
        this.ran.push({ name: job.name });
      } catch (e) {
        this.ran.push({ name: job.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return n;
  }
}

/** One at a time: the relayer's single-sender rule, across every simulator in the process. */
export function mutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(f: () => Promise<T>): Promise<T> => {
    const next = tail.then(f, f);
    tail = next.catch(() => {});
    return next;
  };
}
