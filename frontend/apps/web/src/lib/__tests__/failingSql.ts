import type { SqlDatabase } from '../derivedDb';

/**
 * The same connection, except that a statement matching `pattern` fails,
 * inside a transaction or outside one. A write that runs its statements in
 * one transaction leaves nothing behind; a write without one is caught
 * half-applied.
 */
export function failingAt(db: SqlDatabase, pattern: RegExp): SqlDatabase {
  const refuse = (sql: string): void => {
    if (pattern.test(sql)) throw new Error(`injected failure at: ${sql}`);
  };
  const wrap = (target: SqlDatabase): SqlDatabase => new Proxy(target, {
    get(inner, property, receiver) {
      if (property === 'exec') {
        return async (sql: string, bind?: Parameters<SqlDatabase['exec']>[1]) => { refuse(sql); return inner.exec(sql, bind); };
      }
      if (property === 'transaction') {
        return (work: (tx: SqlDatabase) => Promise<unknown>) => inner.transaction((tx) => work(wrap(tx as SqlDatabase)));
      }
      const value: unknown = Reflect.get(inner, property, receiver);
      return typeof value === 'function' ? value.bind(inner) : value;
    },
  });
  return wrap(db);
}
