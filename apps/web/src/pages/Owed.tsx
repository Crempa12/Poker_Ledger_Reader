import { sessions, type SessionBalance } from "@plr/core";

import type { Ctx } from "../context.ts";
import { moneyCents } from "../format.ts";
import { href } from "../router.ts";

export function Owed({ ctx }: { ctx: Ctx }) {
  const { view, world } = ctx;
  const rows = sessions.sortedRows(world.balances, false);
  const bySheet = new Map<string, SessionBalance[]>();
  for (const r of rows) bySheet.set(r.sessionId, [...(bySheet.get(r.sessionId) ?? []), r]);

  return (
    <>
      <section className="card">
        <h2>Who still owes whom</h2>
        <p className="muted small">Everything still unpaid, added up across every saved sheet (menu 11 in the console app).</p>
        {view.owed.length === 0 ? (
          <p className="up">Nobody owes anything on a saved sheet.</p>
        ) : (
          <ul className="payments">
            {view.owed.map((d) => (
              <li key={`${d.fromNormalized}->${d.toNormalized}`}>
                <a href={href("player", d.fromNormalized)}>{d.fromDisplay}</a>
                <span className="arrow" aria-label="owes">→</span>
                <a href={href("player", d.toNormalized)}>{d.toDisplay}</a>
                <strong className="amount">{moneyCents(d.totalCents)}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Saved sheets</h2>
        {bySheet.size === 0 ? (
          <p className="muted">
            No saved sheets yet. In the console app, menu 7 saves a settlement sheet and menu 10 records payments against it.
          </p>
        ) : (
          [...bySheet.entries()].map(([id, list]) => {
            const open = list.reduce((s, b) => s + b.remainingCents, 0);
            return (
              <div key={id} className="sheet">
                <h3>
                  {id} <span className={open > 0 ? "down small" : "up small"}>{open > 0 ? `${moneyCents(open)} unpaid` : "all paid"}</span>
                </h3>
                <table>
                  <thead>
                    <tr>
                      <th>From</th>
                      <th>To</th>
                      <th className="num hide-xs">Amount</th>
                      <th className="num">Left</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((b) => (
                      <tr key={`${b.fromNormalized}->${b.toNormalized}`} className={b.status === "paid" ? "dim" : ""}>
                        <td>{b.fromDisplay}</td>
                        <td>{b.toDisplay}</td>
                        <td className="num hide-xs">{moneyCents(b.originalCents)}</td>
                        <td className="num">{moneyCents(b.remainingCents)}</td>
                        <td>
                          <span className={`tag ${b.status}`}>{b.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })
        )}
      </section>
    </>
  );
}
